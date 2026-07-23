// Write-back service (specs §5) — the only path that writes to QuickBooks.
//
// Invariants (CLAUDE.md):
//   * Never write without a fresh read: fetchTxn → verify still in holding →
//     recategorize with the fresh SyncToken; on conflict re-fetch + retry ONCE.
//   * Every QBO write gets an AuditEntry in the SAME prisma transaction as the
//     status change. No exceptions — including dry-run.
//   * DRY_RUN (env or per-company) never calls recategorize; it logs the exact
//     payload it would have sent and marks the txn DRY_RUN.
//
// Dependencies on other agents' modules (audit, qbo factory) are imported
// lazily and injectable, so unit tests can exercise this file with fakes.

import type { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuditAction, SplitDto, TaxCalculation, TxnStatus } from '@recat/shared';
import { QboSyncTokenConflict, type QboClient, type QboTxn, type QboWriteResult } from '../lib/qbo/types.js';
import {
  canonicalHash,
  type QboPreparedWrite,
  type QboPurchaseExpectedState,
  type QboPurchaseRestoreExpected,
} from '../lib/qbo/purchaseTax.js';
import type { RawPurchase } from '../lib/qbo/real.js';
import type { QboRecategorizationPlan } from './tax/model.js';
import type { RefreshedTaxReference } from './tax/reference.js';
import {
  completeSourcePurchaseTaxDefault,
  sourcePurchaseTaxSelection,
} from './tax/sourceDefault.js';
import { verifyPurchaseRestore, verifyPurchaseResult } from './tax/verify.js';

export interface Actor {
  /** userId, or null for 'system' */
  id: string | null;
  /** display name shown in the audit log */
  label: string;
}

export interface PostResult {
  id: string;
  ok: boolean;
  status: TxnStatus;
  error?: { code: string; message: string };
}

interface AuditEntryInput {
  companyId: string;
  actorId?: string | null;
  actorLabel: string;
  txnId?: string;
  payee: string;
  amount: number;
  action: AuditAction;
  before: string;
  after: string;
  payload?: unknown;
}

type AuditFn = (txOrPrisma: Prisma.TransactionClient | PrismaClient, entry: AuditEntryInput) => Promise<unknown>;

export interface WritebackDeps {
  db: PrismaClient;
  getClient: (companyId: string) => Promise<QboClient>;
  audit: AuditFn;
  envDryRun: boolean;
  refreshTaxReference?: (companyId: string) => Promise<RefreshedTaxReference>;
}

async function defaultDeps(): Promise<WritebackDeps> {
  const [{ prisma }, { qboFactory }, { writeAudit }, { env }, { refreshTaxReference }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
    import('./tax/reference.js'),
  ]);
  return {
    db: prisma,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: writeAudit,
    envDryRun: env.DRY_RUN,
    refreshTaxReference: (companyId) => refreshTaxReference(companyId),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface SplitValidation {
  ok: boolean;
  message?: string;
}

/**
 * Splits must each be nonzero, share the transaction's sign (the client sends
 * signed amounts matching the txn), and sum to the signed transaction amount
 * within half a cent. A mixed-sign or zero line would silently reshape the
 * QBO entity, so each failure carries its own message.
 */
export function validateSplits(txnAmount: number, splits: { amount: number }[]): SplitValidation {
  const sign = Math.sign(txnAmount);
  for (const s of splits) {
    if (Math.abs(s.amount) < 0.005) {
      return { ok: false, message: 'Every split needs a nonzero amount.' };
    }
    if (sign !== 0 && Math.sign(s.amount) !== sign) {
      return {
        ok: false,
        message:
          sign < 0
            ? 'Every split must match the transaction: this is money out, so all split amounts must be negative.'
            : 'Every split must match the transaction: this is money in, so all split amounts must be positive.',
      };
    }
  }
  const sum = splits.reduce((acc, s) => acc + s.amount, 0);
  if (Math.abs(sum - txnAmount) > 0.005) {
    return { ok: false, message: 'Split amounts must add up to the transaction amount.' };
  }
  return { ok: true };
}

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Structural shape of a SplitLine row with its tags loaded (Prisma or fake). */
export interface SplitLineLike {
  idx: number;
  /** Prisma Decimal or plain number — Number() handles both */
  amount: number | { toString(): string };
  category: string;
  categoryQboId: string | null;
  memo: string | null;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  tags: { tagId: string }[];
}

/**
 * SplitLine rows → the wire/API SplitDto shape (ordered by idx). Returns null
 * for an empty set — the API contract uses `splits: null` for "not split".
 */
export function splitLineDtos(lines: SplitLineLike[]): SplitDto[] | null {
  if (lines.length === 0) return null;
  return [...lines]
    .sort((a, b) => a.idx - b.idx)
    .map((l) => ({
      amount: Number(l.amount),
      category: l.category,
      ...(l.categoryQboId !== null ? { categoryQboId: l.categoryQboId } : {}),
      tagIds: l.tags.map((t) => t.tagId),
      ...(l.memo !== null ? { memo: l.memo } : {}),
      ...(l.taxCode !== null && l.taxCode !== undefined ? { taxCode: l.taxCode } : {}),
      ...(l.taxCodeQboId !== null && l.taxCodeQboId !== undefined ? { taxCodeQboId: l.taxCodeQboId } : {}),
    }));
}

// ---------------------------------------------------------------------------

interface WriteSplit {
  amount: number;
  accountQboId: string;
  memo?: string;
  taxCodeQboId?: string;
  taxCodeName?: string | null;
}

interface ResolvedAccount {
  qboId: string;
  name: string;
  fullName: string;
}

interface ResolvedTaxCode {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
}

async function resolveCategoryAccount(
  db: PrismaClient,
  companyId: string,
  categoryQboId: string | null | undefined,
  categoryName: string,
): Promise<ResolvedAccount | null> {
  const row = categoryQboId
    ? await db.qboAccount.findFirst({ where: { companyId, qboId: categoryQboId } })
    : await db.qboAccount.findFirst({ where: { companyId, name: categoryName, active: true } });
  if (!row) return null;
  return { qboId: row.qboId, name: row.name, fullName: row.fullName };
}

async function resolveTaxCode(
  db: PrismaClient,
  companyId: string,
  taxCodeQboId: string | null | undefined,
): Promise<ResolvedTaxCode | null> {
  if (!taxCodeQboId) return null;
  return db.qboTaxCode.findFirst({
    where: { companyId, qboId: taxCodeQboId },
    select: {
      qboId: true,
      name: true,
      active: true,
      taxable: true,
      purchaseTaxRateList: true,
    },
  });
}

async function holdingAccountName(db: PrismaClient, companyId: string, holdingIds: string[]): Promise<string> {
  const first = holdingIds[0];
  if (!first) return 'Holding account';
  const row = await db.qboAccount.findFirst({ where: { companyId, qboId: first } });
  return row?.name ?? 'Holding account';
}

function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof QboSyncTokenConflict) return { code: err.code, message: err.message };
  if (err instanceof Error) {
    const code = 'code' in err && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'QBO_ERROR';
    return { code, message: err.message };
  }
  return { code: 'QBO_ERROR', message: String(err) };
}

async function markSuperseded(
  d: WritebackDeps,
  txn: { id: string; companyId: string; payee: string; amount: number },
  before: string,
): Promise<PostResult> {
  const unresolvedRestore = await d.db.$transaction(async (tx) => {
    const restore = await tx.qboMutationAttempt.findFirst({
      where: {
        transactionId: txn.id,
        operation: 'restore',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      select: { id: true },
    });
    if (restore) {
      await tx.transaction.update({
        where: { id: txn.id },
        data: { status: 'ERROR' },
      });
      return true;
    }
    await tx.qboMutationAttempt.updateMany({
      where: {
        transactionId: txn.id,
        operation: 'recategorize',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      data: { status: 'RECONCILED' },
    });
    await tx.transaction.update({
      where: { id: txn.id },
      data: { status: 'SUPERSEDED', errorCode: null, errorMessage: null },
    });
    await d.audit(tx, {
      companyId: txn.companyId,
      actorId: null,
      actorLabel: 'system',
      txnId: txn.id,
      payee: txn.payee,
      amount: txn.amount,
      action: 'superseded',
      before,
      after: 'fixed inside QuickBooks',
    });
    return false;
  });
  if (unresolvedRestore) {
    return {
      id: txn.id,
      ok: false,
      status: 'ERROR',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message:
          'This Purchase has an unresolved QuickBooks undo. Use Retry to verify it before posting again.',
      },
    };
  }
  return {
    id: txn.id,
    ok: false,
    status: 'SUPERSEDED',
    error: { code: 'SUPERSEDED', message: 'This transaction was already categorized inside QuickBooks.' },
  };
}

// ---------------------------------------------------------------------------
// postTransaction
// ---------------------------------------------------------------------------

export async function postTransaction(
  txnId: string,
  actor: Actor,
  opts: {
    auto?: boolean;
    expectedUpdatedAt?: Date;
    canWrite?: () => boolean | Promise<boolean>;
  } = {},
  deps?: WritebackDeps,
): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({
    where: { id: txnId },
    include: {
      company: true,
      txnTags: true,
      splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } },
    },
  });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
    throw new Error(`Cannot post a transaction in status ${txn.status}`);
  }
  if (
    opts.expectedUpdatedAt &&
    txn.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()
  ) {
    throw new Error('Transaction changed after staging. Refresh and try again.');
  }

  const company = txn.company;
  const amount = Number(txn.amount);
  const splits = splitLineDtos(txn.splitLines);
  const hasSplits = splits !== null && splits.length > 0;

  // ---- guards (handoff §2) — checked before we touch status or QBO ----
  if (!hasSplits && !txn.category) throw new Error('Pick a category (or splits) before posting.');
  if (hasSplits) {
    const splitCheck = validateSplits(amount, splits);
    if (!splitCheck.ok) throw new Error(splitCheck.message ?? 'Split amounts must add up to the transaction amount.');
  }
  if (company.tagsRequired) {
    const tagged = hasSplits ? splits.every((s) => (s.tagIds ?? []).length > 0) : txn.txnTags.length > 0;
    if (!tagged) {
      throw new Error(
        hasSplits
          ? 'This company requires at least one tag on every split before posting.'
          : 'This company requires at least one tag before posting.',
      );
    }
  }

  const claimed = await d.db.transaction.updateMany({
    where: {
      id: txnId,
      status: txn.status,
      updatedAt: txn.updatedAt,
    },
    data: { status: 'POSTING' },
  });
  if (claimed.count !== 1) {
    throw new Error('Transaction changed before posting began. Refresh and try again.');
  }

  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const baseTxn = { id: txn.id, companyId: txn.companyId, payee: txn.payee, amount };

  try {
    const client = await d.getClient(company.id);

    // ---- fresh read: never trust a cached SyncToken across user think-time ----
    const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
    const holdingLine = fresh?.lines.find((l) => holdingIds.includes(l.accountQboId));
    if (!fresh || !holdingLine) {
      // Someone already fixed it inside QuickBooks (or deleted it).
      const before = await holdingAccountName(d.db, company.id, holdingIds);
      return await markSuperseded(d, baseTxn, before);
    }
    const before = holdingLine.accountName;

    // ---- build the write payload ----
    const writeSplits: WriteSplit[] = [];
    let afterLabel: string;
    if (hasSplits) {
      for (const s of splits) {
        const acct = await resolveCategoryAccount(d.db, company.id, s.categoryQboId, s.category);
        if (!acct) throw new Error(`Unknown category "${s.category}" — re-sync the chart of accounts.`);
        writeSplits.push({
          amount: s.amount,
          accountQboId: acct.qboId,
          memo: s.memo,
          ...(s.taxCodeQboId ? { taxCodeQboId: s.taxCodeQboId, taxCodeName: s.taxCode ?? null } : {}),
        });
      }
      afterLabel = `Split · ${splits.map((s) => s.category).join(' / ')}`;
    } else {
      const categoryName = txn.category ?? '';
      const acct = await resolveCategoryAccount(d.db, company.id, txn.categoryQboId, categoryName);
      if (!acct) throw new Error(`Unknown category "${categoryName}" — re-sync the chart of accounts.`);
      writeSplits.push({
        amount,
        accountQboId: acct.qboId,
        memo: txn.memo ?? undefined,
        ...(txn.taxCodeQboId
          ? { taxCodeQboId: txn.taxCodeQboId, taxCodeName: txn.taxCode ?? null }
          : {}),
      });
      afterLabel = acct.fullName || categoryName;
    }

    const now = new Date();
    const successAction: AuditAction = opts.auto ? 'auto-posted' : 'posted';
    let payload: Record<string, unknown> = {
      qboType: txn.qboType,
      qboId: txn.qboId,
      syncToken: fresh.syncToken,
      splits: writeSplits,
    };
    const taxCalculation = txn.taxCalculation as TaxCalculation | null;
    let prepared: QboPreparedWrite | null = null;
    let attemptId: string | null = null;

    if (taxCalculation !== null) {
      if (txn.qboType !== 'Purchase') {
        throw Object.assign(new Error('Tax treatment is currently supported only for Purchase transactions.'), {
          code: 'TAX_MODE_UNSUPPORTED',
        });
      }
      const resolvedCodes: ResolvedTaxCode[] = [];
      for (const split of writeSplits) {
        const code = await resolveTaxCode(d.db, company.id, split.taxCodeQboId);
        if (!code) {
          throw Object.assign(new Error('Every Purchase line needs a valid company tax code.'), {
            code: 'TAX_CODE_REQUIRED',
          });
        }
        if (!code.active) {
          throw Object.assign(new Error(`QuickBooks TaxCode ${code.name} is inactive.`), {
            code: 'TAX_CODE_INACTIVE',
          });
        }
        const purchaseRates = Array.isArray(code.purchaseTaxRateList) ? code.purchaseTaxRateList : [];
        if (code.taxable !== false && purchaseRates.length === 0) {
          throw Object.assign(new Error(`QuickBooks TaxCode ${code.name} is not purchase-applicable.`), {
            code: 'TAX_CODE_NOT_PURCHASE',
          });
        }
        resolvedCodes.push(code);
      }
      const firstOutOfScope =
        taxCalculation === 'NotApplicable'
          ? resolvedCodes.find((code) => code.taxable === false)?.qboId ?? null
          : null;
      const plan: QboRecategorizationPlan = {
        qboType: 'Purchase',
        signedTransactionAmount: amount,
        taxCalculation,
        outOfScopeTaxCodeQboId: firstOutOfScope,
        lines: writeSplits.map((split, index) => ({
          grossAmount: split.amount,
          accountQboId: split.accountQboId,
          ...(split.memo !== undefined ? { memo: split.memo } : {}),
          tax: {
            taxCodeQboId: split.taxCodeQboId ?? null,
            taxCodeName: resolvedCodes[index]?.name ?? split.taxCodeName ?? null,
          },
        })),
      };
      const requestId = randomUUID();
      const decisionHash = canonicalHash(plan);
      const attempt = await d.db.qboMutationAttempt.create({
        data: {
          transactionId: txnId,
          operation: 'recategorize',
          requestId,
          decisionHash,
          status: 'PREPARING',
        },
      });
      attemptId = attempt.id;

      try {
        // Ensure the local cache is fresh for validation/UI. The client builder
        // still reads QBO reference data directly, so a stale cache cannot
        // shape a write.
        if (d.refreshTaxReference) await d.refreshTaxReference(company.id);
        prepared = await client.prepareRecategorization(fresh, plan, requestId);
        await d.db.qboMutationAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'PREPARED',
            requestPath: prepared.path,
            requestBody: prepared.body as unknown as Prisma.InputJsonValue,
            before: prepared.before as unknown as Prisma.InputJsonValue,
            expected: prepared.expected as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        await d.db.qboMutationAttempt
          .update({
            where: { id: attempt.id },
            data: {
              status: 'FAILED',
              verification: { ok: false, error: errorInfo(err) },
            },
          })
          .catch(() => undefined);
        throw err;
      }
      payload = {
        decision: plan,
        qbo: { path: prepared.path, requestId: prepared.requestId, body: prepared.body },
        before: prepared.before,
        expected: prepared.expected,
      };
    }

    // ---- dry-run: log the exact payload, write NOTHING to QBO ----
    if (company.dryRun || d.envDryRun) {
      await d.db.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txnId },
          data: {
            status: 'DRY_RUN',
            postedAt: now,
            postedByUserId: actor.id,
            qboSyncToken: fresh.syncToken,
            errorCode: null,
            errorMessage: null,
          },
        });
        await d.audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: 'dry-run',
          before,
          after: afterLabel,
          payload,
        });
        if (attemptId !== null) {
          await tx.qboMutationAttempt.update({ where: { id: attemptId }, data: { status: 'DRY_RUN' } });
        }
      });
      return { id: txnId, ok: true, status: 'DRY_RUN' };
    }

    // ---- real write, with one SyncToken-conflict retry ----
    let result: QboWriteResult | null = null;
    let recoveredReadBack: QboTxn | null = null;
    const assertWriteLease = async (): Promise<void> => {
      if (opts.canWrite && !(await opts.canWrite())) {
        throw Object.assign(
          new Error('The accounting write lease was lost before the QuickBooks mutation.'),
          { code: 'ACCOUNTING_WRITE_LEASE_LOST' },
        );
      }
    };
    try {
      try {
        await assertWriteLease();
        result =
          prepared !== null
            ? await client.executePreparedWrite(prepared)
            : await client.recategorize(fresh, writeSplits);
      } catch (err) {
        if (!(err instanceof QboSyncTokenConflict)) throw err;
        // Someone edited the entity between our read and write: re-fetch and
        // retry exactly once.
        const refetched = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
        const stillHolding = refetched?.lines.some((l) => holdingIds.includes(l.accountQboId));
        if (!refetched || !stillHolding) return await markSuperseded(d, baseTxn, before);
        payload.syncToken = refetched.syncToken;
        if (prepared !== null) {
          const plan = payload.decision as QboRecategorizationPlan;
          prepared = await client.prepareRecategorization(refetched, plan, prepared.requestId);
          if (attemptId !== null) {
            await d.db.qboMutationAttempt.update({
              where: { id: attemptId },
              data: {
                requestBody: prepared.body as unknown as Prisma.InputJsonValue,
                before: prepared.before as unknown as Prisma.InputJsonValue,
                expected: prepared.expected as unknown as Prisma.InputJsonValue,
              },
            });
          }
          payload = {
            ...payload,
            qbo: { path: prepared.path, requestId: prepared.requestId, body: prepared.body },
            before: prepared.before,
            expected: prepared.expected,
          };
          await assertWriteLease();
          result = await client.executePreparedWrite(prepared);
        } else {
          await assertWriteLease();
          result = await client.recategorize(refetched, writeSplits);
        }
      }
    } catch (err) {
      let info = errorInfo(err);
      if (prepared?.operation === 'recategorize' && attemptId !== null) {
        // A transport error does not prove that QBO rejected the request: the
        // response can be lost after QBO committed it. Resolve the outcome
        // from a fresh read before allowing any retry.
        const readBack = await client.fetchTxn('Purchase', txn.qboId).catch(() => null);
        const verification = readBack ? verifyPurchaseResult(prepared.expected, readBack) : null;
        if (readBack && verification?.ok) {
          recoveredReadBack = readBack;
          result = {
            ok: true,
            newSyncToken: readBack.syncToken,
            rawResponse: { recoveredByReadBack: true },
          };
          payload = {
            ...payload,
            transportError: info,
            readBack: readBack.raw,
            verification,
          };
        } else {
          const requestSyncToken = String(prepared.body.SyncToken);
          const sourceUnchanged =
            readBack?.syncToken === requestSyncToken &&
            readBack.lines.some((line) => holdingIds.includes(line.accountQboId));
          if (!sourceUnchanged) {
            info = {
              code: 'QBO_WRITE_UNCERTAIN',
              message:
                'QuickBooks may have accepted the write, but Recat could not verify the result. Verify it in QuickBooks before retrying.',
            };
          }
          await d.db.qboMutationAttempt
            .update({
              where: { id: attemptId },
              data: {
                status: sourceUnchanged ? 'FAILED' : 'UNCERTAIN',
                verification: {
                  ok: false,
                  ...info,
                  sourceUnchanged,
                  ...(verification ? { readBackVerification: verification } : {}),
                } as unknown as Prisma.InputJsonValue,
              },
            })
            .catch(() => undefined);
        }
      }
      if (recoveredReadBack !== null) {
        // Continue through the normal verification and atomic local commit.
      } else {
        await d.db.$transaction(async (tx) => {
          await tx.transaction.update({
            where: { id: txnId },
            data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message },
          });
          await d.audit(tx, {
            companyId: company.id,
            actorId: actor.id,
            actorLabel: actor.label,
            txnId,
            payee: txn.payee,
            amount,
            action: 'error',
            before,
            after: afterLabel,
            payload: { ...payload, error: info },
          });
        });
        return { id: txnId, ok: false, status: 'ERROR', error: info };
      }
    }

    if (result === null) throw new Error('Internal error: QuickBooks write produced no result.');

    if (attemptId !== null) {
      await d.db.qboMutationAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'WRITTEN',
          response:
            result.rawResponse === undefined
              ? undefined
              : (result.rawResponse as Prisma.InputJsonValue),
        },
      });
    }

    // A tax-aware write is not successful until an immediate fresh read proves
    // the accounting invariants. Never blind-retry an uncertain outcome.
    if (prepared !== null && attemptId !== null) {
      if (prepared.operation !== 'recategorize') {
        throw new Error('Internal error: expected a recategorization mutation.');
      }
      let readBack: QboTxn | null = recoveredReadBack;
      if (!readBack) {
        try {
          readBack = await client.fetchTxn('Purchase', txn.qboId);
        } catch {
          readBack = null;
        }
      }
      if (!readBack) {
        const info = {
          code: 'QBO_WRITE_UNCERTAIN',
          message: 'QuickBooks accepted the write, but Recat could not verify the result. Verify it in QuickBooks before retrying.',
        };
        await d.db.$transaction(async (tx) => {
          await tx.qboMutationAttempt.update({
            where: { id: attemptId! },
            data: { status: 'UNCERTAIN', verification: { ok: false, ...info } },
          });
          await tx.transaction.update({
            where: { id: txnId },
            data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message },
          });
          await d.audit(tx, {
            companyId: company.id,
            actorId: actor.id,
            actorLabel: actor.label,
            txnId,
            payee: txn.payee,
            amount,
            action: 'error',
            before,
            after: afterLabel,
            payload: { ...payload, response: result!.rawResponse, verification: { ok: false, ...info } },
          });
        });
        return { id: txnId, ok: false, status: 'ERROR', error: info };
      }

      const verification = verifyPurchaseResult(prepared.expected, readBack);
      payload = {
        ...payload,
        response: result.rawResponse,
        readBack: readBack.raw,
        verification,
      };
      await d.db.qboMutationAttempt.update({
        where: { id: attemptId },
        data: {
          status: verification.ok ? 'VERIFIED' : 'MISMATCH',
          response:
            result.rawResponse === undefined
              ? undefined
              : (result.rawResponse as Prisma.InputJsonValue),
          verification: verification as unknown as Prisma.InputJsonValue,
        },
      });
      if (!verification.ok) {
        const info = {
          code: verification.code ?? 'QBO_STATE_DRIFT',
          message: verification.message ?? 'QuickBooks returned an unexpected Purchase state.',
        };
        await d.db.$transaction(async (tx) => {
          await tx.transaction.update({
            where: { id: txnId },
            data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message },
          });
          await d.audit(tx, {
            companyId: company.id,
            actorId: actor.id,
            actorLabel: actor.label,
            txnId,
            payee: txn.payee,
            amount,
            action: 'error',
            before,
            after: afterLabel,
            payload,
          });
        });
        return { id: txnId, ok: false, status: 'ERROR', error: info };
      }
      result = { ...result, newSyncToken: readBack.syncToken };
    }

    // ---- success: status + audit, atomically ----
    try {
      await d.db.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txnId },
          data: {
            status: 'POSTED',
            postedAt: now,
            postedByUserId: actor.id,
            qboSyncToken: result.newSyncToken,
            errorCode: null,
            errorMessage: null,
          },
        });
        await d.audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: successAction,
          before,
          after: afterLabel,
          payload,
        });
      });
    } catch (commitErr) {
      // Dual-write honesty: QuickBooks accepted the recategorize but our own
      // commit failed. Never pretend the write didn't happen — mark ERROR with
      // an explicit "go verify" message and leave a best-effort audit trail.
      const message = 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';
      const info = { code: 'DB_COMMIT_FAILED', message };
      console.error(`[writeback] DB commit failed after a successful QBO write for txn ${txnId}:`, commitErr);
      await d.db.transaction
        .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
        .catch(() => undefined);
      await Promise.resolve(
        d.audit(d.db, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId,
          payee: txn.payee,
          amount,
          action: 'error',
          before,
          after: afterLabel,
          payload: { ...payload, error: info },
        }),
      ).catch(() => undefined);
      return { id: txnId, ok: false, status: 'ERROR', error: info };
    }
    return { id: txnId, ok: true, status: 'POSTED' };
  } catch (err) {
    // Unexpected failure after POSTING was set: fail loudly but never leave the
    // txn stuck in POSTING.
    const info = errorInfo(err);
    await d.db.transaction
      .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
      .catch(() => undefined);
    return { id: txnId, ok: false, status: 'ERROR', error: info };
  }
}

// ---------------------------------------------------------------------------
// undoPost — POSTED/DRY_RUN → (REVERTED) → PENDING, within 30 days
// ---------------------------------------------------------------------------

const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function undoPost(
  txnId: string,
  actor: Actor,
  deps?: WritebackDeps,
  canWrite: () => boolean | Promise<boolean> = () => true,
): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());
  const assertWriteLease = async (): Promise<void> => {
    if (!(await canWrite())) {
      throw Object.assign(
        new Error('The accounting write lease was lost before the QuickBooks undo.'),
        { code: 'ACCOUNTING_WRITE_LEASE_LOST' },
      );
    }
  };

  const txn = await d.db.transaction.findUnique({
    where: { id: txnId },
    include: { company: true, splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } } },
  });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  if (txn.status !== 'POSTED' && txn.status !== 'DRY_RUN') {
    throw new Error(`Only posted transactions can be undone (status is ${txn.status})`);
  }
  if (!txn.postedAt || Date.now() - txn.postedAt.getTime() > UNDO_WINDOW_MS) {
    throw new Error('The 30-day undo window for this transaction has passed.');
  }

  const company = txn.company;
  const amount = Number(txn.amount);
  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const holdingId = holdingIds[0];
  if (!holdingId) throw new Error('No holding account configured for this company.');
  const holdingName = await holdingAccountName(d.db, company.id, holdingIds);
  const sourceTaxSelection =
    txn.status === 'DRY_RUN' &&
    txn.taxCalculation === null &&
    txn.taxCodeQboId === null
      ? sourcePurchaseTaxSelection(txn.qboType, txn.rawData, holdingIds)
      : null;
  const sourceTaxCode = sourceTaxSelection
    ? await resolveTaxCode(d.db, company.id, sourceTaxSelection.taxCodeQboId)
    : null;
  const sourceTaxDefault = completeSourcePurchaseTaxDefault(
    sourceTaxSelection,
    sourceTaxCode ? [sourceTaxCode] : [],
  );

  const splits = splitLineDtos(txn.splitLines);
  const beforeLabel =
    splits && splits.length > 0 ? `Split · ${splits.map((s) => s.category).join(' / ')}` : txn.category ?? '—';
  const markUndoUnresolved = async (
    attemptId: string,
    status: 'UNCERTAIN' | 'MISMATCH',
    error: { code: string; message: string },
    verification: Prisma.InputJsonValue,
    after: string,
    payload: unknown,
  ): Promise<void> => {
    await d.db.$transaction(async (tx) => {
      await tx.qboMutationAttempt.update({
        where: { id: attemptId },
        data: { status, verification },
      });
      await tx.transaction.update({
        where: { id: txnId },
        data: {
          status: 'ERROR',
          errorCode: error.code,
          errorMessage: error.message,
        },
      });
      await d.audit(tx, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId,
        payee: txn.payee,
        amount,
        action: 'error',
        before: beforeLabel,
        after,
        payload,
      });
    });
  };

  // Undo in QBO based on HOW the txn was posted: DRY_RUN wrote nothing, so
  // there is nothing to undo there; POSTED always wrote, so it must always be
  // reversed — regardless of what the dry-run config says NOW.
  let newSyncToken = txn.qboSyncToken;
  let qboWrote = false;
  let undoAuditPayload: unknown;
  if (txn.status === 'POSTED') {
    const client = await d.getClient(company.id);
    const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
    if (!fresh) {
      // Re-queuing a txn whose QBO entity is gone would strand a phantom in
      // the queue — fail loudly instead.
      throw new Error('This transaction no longer exists in QuickBooks.');
    }
    if (txn.taxCalculation !== null) {
      const postedAttempt = await d.db.qboMutationAttempt.findFirst({
        where: { transactionId: txnId, operation: 'recategorize', status: 'VERIFIED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!postedAttempt?.before || !postedAttempt.expected) {
        throw new Error('Cannot undo tax state because the verified before snapshot is missing.');
      }
      const postedExpected = postedAttempt.expected as unknown as QboPurchaseExpectedState;
      const original = postedAttempt.before as unknown as RawPurchase;
      const currentVerification = verifyPurchaseResult(postedExpected, fresh);
      if (!currentVerification.ok) {
        throw Object.assign(
          new Error('This Purchase changed in QuickBooks after Recat posted it. Undo was not attempted.'),
          { code: 'QBO_STATE_DRIFT' },
        );
      }

      const requestId = randomUUID();
      const undoAttempt = await d.db.qboMutationAttempt.create({
        data: {
          transactionId: txnId,
          operation: 'restore',
          requestId,
          decisionHash: canonicalHash(original),
          status: 'PREPARING',
        },
      });
      let preparedUndo: QboPreparedWrite;
      try {
        preparedUndo = await client.preparePurchaseRestore(fresh, original, requestId);
        await d.db.qboMutationAttempt.update({
          where: { id: undoAttempt.id },
          data: {
            status: 'PREPARED',
            requestPath: preparedUndo.path,
            requestBody: preparedUndo.body as unknown as Prisma.InputJsonValue,
            before: preparedUndo.before as unknown as Prisma.InputJsonValue,
            expected: preparedUndo.expected as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        await d.db.qboMutationAttempt
          .update({
            where: { id: undoAttempt.id },
            data: {
              status: 'FAILED',
              verification: { ok: false, error: errorInfo(err) },
            },
          })
          .catch(() => undefined);
        throw err;
      }

      let undoResult: QboWriteResult | null = null;
      let recoveredRestore: QboTxn | null = null;
      try {
        try {
          await assertWriteLease();
          undoResult = await client.executePreparedWrite(preparedUndo);
        } catch (err) {
          if (!(err instanceof QboSyncTokenConflict)) throw err;
          const refetched = await client.fetchTxn('Purchase', txn.qboId);
          if (!refetched || !verifyPurchaseResult(postedExpected, refetched).ok) {
            throw Object.assign(
              new Error('This Purchase changed in QuickBooks during undo. Nothing was retried.'),
              { code: 'QBO_STATE_DRIFT' },
            );
          }
          preparedUndo = await client.preparePurchaseRestore(refetched, original, requestId);
          await d.db.qboMutationAttempt.update({
            where: { id: undoAttempt.id },
            data: {
              requestBody: preparedUndo.body as unknown as Prisma.InputJsonValue,
              before: preparedUndo.before as unknown as Prisma.InputJsonValue,
              expected: preparedUndo.expected as unknown as Prisma.InputJsonValue,
            },
          });
          await assertWriteLease();
          undoResult = await client.executePreparedWrite(preparedUndo);
        }
      } catch (err) {
        const originalError = errorInfo(err);
        const readBack = await client.fetchTxn('Purchase', txn.qboId).catch(() => null);
        const restoreVerification = readBack
          ? verifyPurchaseRestore(preparedUndo.expected as QboPurchaseRestoreExpected, readBack)
          : null;
        if (readBack && restoreVerification?.ok) {
          recoveredRestore = readBack;
          undoResult = {
            ok: true,
            newSyncToken: readBack.syncToken,
            rawResponse: { recoveredByReadBack: true },
          };
        } else {
          const requestSyncToken = String(preparedUndo.body.SyncToken);
          const sourceUnchanged =
            readBack?.syncToken === requestSyncToken &&
            verifyPurchaseResult(postedExpected, readBack).ok;
          const info = sourceUnchanged
            ? originalError
            : {
                code: 'QBO_WRITE_UNCERTAIN',
                message:
                  'QuickBooks may have accepted the undo, but Recat could not verify the result. Verify it in QuickBooks before retrying.',
              };
          const storedVerification = {
            ok: false,
            ...info,
            sourceUnchanged,
            ...(restoreVerification ? { readBackVerification: restoreVerification } : {}),
          } as unknown as Prisma.InputJsonValue;
          if (sourceUnchanged) {
            await d.db.qboMutationAttempt.update({
              where: { id: undoAttempt.id },
              data: { status: 'FAILED', verification: storedVerification },
            });
          } else {
            await markUndoUnresolved(
              undoAttempt.id,
              'UNCERTAIN',
              info,
              storedVerification,
              `${holdingName} (undo uncertain)`,
              {
                qbo: { path: preparedUndo.path, requestId: preparedUndo.requestId, body: preparedUndo.body },
                error: originalError,
                verification: { ok: false, ...info },
              },
            );
          }
          throw Object.assign(new Error(info.message), { code: info.code });
        }
      }
      if (undoResult === null) throw new Error('Internal error: QuickBooks undo produced no result.');
      await d.db.qboMutationAttempt.update({
        where: { id: undoAttempt.id },
        data: {
          status: 'WRITTEN',
          response:
            undoResult.rawResponse === undefined
              ? undefined
              : (undoResult.rawResponse as Prisma.InputJsonValue),
        },
      });
      const restored =
        recoveredRestore ?? (await client.fetchTxn('Purchase', txn.qboId).catch(() => null));
      if (!restored || preparedUndo.operation !== 'restore') {
        const info = {
          code: 'QBO_WRITE_UNCERTAIN',
          message: 'QuickBooks accepted the undo, but Recat could not verify it. Verify the Purchase in QuickBooks.',
        };
        const uncertainty = { ok: false, ...info } as Prisma.InputJsonValue;
        await markUndoUnresolved(
          undoAttempt.id,
          'UNCERTAIN',
          info,
          uncertainty,
          `${holdingName} (undo uncertain)`,
          {
            qbo: { path: preparedUndo.path, requestId: preparedUndo.requestId, body: preparedUndo.body },
            verification: uncertainty,
          },
        );
        throw Object.assign(new Error(info.message), { code: info.code });
      }
      const restoreVerification = verifyPurchaseRestore(preparedUndo.expected, restored);
      if (!restoreVerification.ok) {
        const info = {
          code: restoreVerification.code ?? 'QBO_STATE_DRIFT',
          message:
            restoreVerification.message ??
            'QuickBooks did not restore the original Purchase state.',
        };
        await markUndoUnresolved(
          undoAttempt.id,
          'MISMATCH',
          info,
          restoreVerification as unknown as Prisma.InputJsonValue,
          `${holdingName} (undo mismatch)`,
          {
            qbo: { path: preparedUndo.path, requestId: preparedUndo.requestId, body: preparedUndo.body },
            restored: restored.raw,
            verification: restoreVerification,
          },
        );
        throw Object.assign(new Error(info.message), { code: info.code });
      }
      await d.db.qboMutationAttempt.update({
        where: { id: undoAttempt.id },
        data: {
          status: 'VERIFIED',
          verification: restoreVerification as unknown as Prisma.InputJsonValue,
        },
      });
      newSyncToken = restored.syncToken;
      qboWrote = true;
      undoAuditPayload = {
        qbo: {
          path: preparedUndo.path,
          requestId: preparedUndo.requestId,
          body: preparedUndo.body,
        },
        restored: restored.raw,
        verification: restoreVerification,
      };
    } else {
      // Legacy category-only undo remains account-based.
      const fromIds: string[] = [];
      if (splits && splits.length > 0) {
        for (const s of splits) {
          const acct = await resolveCategoryAccount(d.db, company.id, s.categoryQboId, s.category);
          if (acct) fromIds.push(acct.qboId);
        }
      } else {
        const acct = await resolveCategoryAccount(d.db, company.id, txn.categoryQboId, txn.category ?? '');
        if (acct) fromIds.push(acct.qboId);
      }
      if (fromIds.length === 0) {
        throw new Error('Cannot undo — the posted category could not be resolved. Re-sync the chart of accounts.');
      }
      await assertWriteLease();
      const result = await client.moveToAccount(fresh, holdingId, fromIds);
      newSyncToken = result.newSyncToken;
      qboWrote = true;
    }
  }

  // REVERTED is a transition, not a resting state (handoff §2): the txn lands
  // back in the queue as PENDING with its staged category kept for re-posting.
  try {
    await d.db.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: txnId },
        data: {
          status: 'PENDING',
          postedAt: null,
          postedByUserId: null,
          qboSyncToken: newSyncToken,
          errorCode: null,
          errorMessage: null,
          ...(sourceTaxDefault ?? {}),
        },
      });
      await d.audit(tx, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId,
        payee: txn.payee,
        amount,
        action: 'reverted',
        before: beforeLabel,
        after: `${holdingName} (re-queued)`,
        payload: undoAuditPayload,
      });
    });
  } catch (commitErr) {
    if (!qboWrote) throw commitErr;
    // Dual-write honesty: the QBO undo went through but our commit failed.
    const message = 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';
    const info = { code: 'DB_COMMIT_FAILED', message };
    console.error(`[writeback] DB commit failed after a successful QBO undo for txn ${txnId}:`, commitErr);
    await d.db.transaction
      .update({ where: { id: txnId }, data: { status: 'ERROR', errorCode: info.code, errorMessage: info.message } })
      .catch(() => undefined);
    await Promise.resolve(
      d.audit(d.db, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId,
        payee: txn.payee,
        amount,
        action: 'error',
        before: beforeLabel,
        after: `${holdingName} (undo)`,
        payload: { error: info },
      }),
    ).catch(() => undefined);
    return { id: txnId, ok: false, status: 'ERROR', error: info };
  }
  return { id: txnId, ok: true, status: 'PENDING' };
}

// ---------------------------------------------------------------------------
// retryError — ERROR → PENDING with a fresh SyncToken
// ---------------------------------------------------------------------------

export async function retryError(txnId: string, deps?: WritebackDeps): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({ where: { id: txnId }, include: { company: true } });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  if (txn.status !== 'ERROR') throw new Error(`Only errored transactions can be retried (status is ${txn.status})`);

  const holdingIds = jsonStringArray(txn.company.holdingAccountIds);
  const client = await d.getClient(txn.companyId);
  const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
  const unresolvedAttempt =
    txn.qboType === 'Purchase'
      ? await d.db.qboMutationAttempt.findFirst({
          where: {
            transactionId: txnId,
            status: { in: ['UNCERTAIN', 'MISMATCH'] },
          },
          orderBy: { createdAt: 'desc' },
        })
      : null;
  if (unresolvedAttempt) {
    if (!fresh || !unresolvedAttempt.expected) {
      throw Object.assign(
        new Error('The previous QuickBooks write is unresolved. Inspect the Purchase in QuickBooks before retrying.'),
        { code: 'QBO_WRITE_UNCERTAIN' },
      );
    }
    if (unresolvedAttempt.operation === 'restore') {
      const verification = verifyPurchaseRestore(
        unresolvedAttempt.expected as unknown as QboPurchaseRestoreExpected,
        fresh,
      );
      const requestBody = unresolvedAttempt.requestBody as { SyncToken?: unknown } | null;
      const sourceUnchanged = fresh.syncToken === String(requestBody?.SyncToken ?? '');
      const holdingName = await holdingAccountName(d.db, txn.companyId, holdingIds);
      if (verification.ok) {
        await d.db.$transaction(async (tx) => {
          await tx.qboMutationAttempt.update({
            where: { id: unresolvedAttempt.id },
            data: {
              status: 'VERIFIED',
              verification: {
                ...verification,
                reconciledByRetry: true,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          await tx.transaction.update({
            where: { id: txnId },
            data: {
              status: 'PENDING',
              postedAt: null,
              postedByUserId: null,
              qboSyncToken: fresh.syncToken,
              errorCode: null,
              errorMessage: null,
            },
          });
          await d.audit(tx, {
            companyId: txn.companyId,
            actorId: null,
            actorLabel: 'system',
            txnId,
            payee: txn.payee,
            amount: Number(txn.amount),
            action: 'reverted',
            before: 'uncertain QuickBooks undo',
            after: `${holdingName} (re-queued)`,
            payload: {
              requestId: unresolvedAttempt.requestId,
              verification: { ...verification, reconciledByRetry: true },
            },
          });
        });
        return { id: txnId, ok: true, status: 'PENDING' };
      }
      if (sourceUnchanged) {
        await d.db.$transaction(async (tx) => {
          await tx.qboMutationAttempt.update({
            where: { id: unresolvedAttempt.id },
            data: {
              status: 'FAILED',
              verification: {
                ...verification,
                sourceUnchanged: true,
                reconciledByRetry: true,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          await tx.transaction.update({
            where: { id: txnId },
            data: {
              status: 'POSTED',
              qboSyncToken: fresh.syncToken,
              errorCode: null,
              errorMessage: null,
            },
          });
          await d.audit(tx, {
            companyId: txn.companyId,
            actorId: null,
            actorLabel: 'system',
            txnId,
            payee: txn.payee,
            amount: Number(txn.amount),
            action: 'error',
            before: 'uncertain QuickBooks undo',
            after: 'verified not applied; undo may be attempted again',
            payload: {
              requestId: unresolvedAttempt.requestId,
              verification: {
                ...verification,
                sourceUnchanged: true,
                reconciledByRetry: true,
              },
            },
          });
        });
        return { id: txnId, ok: true, status: 'POSTED' };
      }
      await d.db.qboMutationAttempt.update({
        where: { id: unresolvedAttempt.id },
        data: {
          status: 'MISMATCH',
          verification: {
            ...verification,
            sourceUnchanged: false,
            reconciledByRetry: false,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      throw Object.assign(
        new Error('The Purchase changed after an uncertain undo. Inspect it in QuickBooks before retrying.'),
        { code: 'QBO_STATE_DRIFT' },
      );
    }
    const verification = verifyPurchaseResult(
      unresolvedAttempt.expected as unknown as QboPurchaseExpectedState,
      fresh,
    );
    if (verification.ok) {
      await d.db.$transaction(async (tx) => {
        await tx.qboMutationAttempt.update({
          where: { id: unresolvedAttempt.id },
          data: {
            status: 'VERIFIED',
            verification: {
              ...verification,
              reconciledByRetry: true,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.transaction.update({
          where: { id: txnId },
          data: {
            status: 'POSTED',
            postedAt: txn.postedAt ?? new Date(),
            qboSyncToken: fresh.syncToken,
            errorCode: null,
            errorMessage: null,
          },
        });
        await d.audit(tx, {
          companyId: txn.companyId,
          actorId: null,
          actorLabel: 'system',
          txnId,
          payee: txn.payee,
          amount: Number(txn.amount),
          action: 'posted',
          before: 'uncertain QuickBooks write',
          after: txn.category ?? 'verified Purchase categorization',
          payload: {
            requestId: unresolvedAttempt.requestId,
            verification: { ...verification, reconciledByRetry: true },
          },
        });
      });
      return { id: txnId, ok: true, status: 'POSTED' };
    }

    const requestBody = unresolvedAttempt.requestBody as { SyncToken?: unknown } | null;
    const sourceUnchanged =
      fresh.syncToken === String(requestBody?.SyncToken ?? '') &&
      fresh.lines.some((line) => holdingIds.includes(line.accountQboId));
    if (!sourceUnchanged) {
      await d.db.qboMutationAttempt.update({
        where: { id: unresolvedAttempt.id },
        data: {
          status: 'MISMATCH',
          verification: {
            ...verification,
            reconciledByRetry: false,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      throw Object.assign(
        new Error('The Purchase changed after an uncertain write. Inspect it in QuickBooks before retrying.'),
        { code: 'QBO_STATE_DRIFT' },
      );
    }
    await d.db.qboMutationAttempt.update({
      where: { id: unresolvedAttempt.id },
      data: {
        status: 'FAILED',
        verification: {
          ...verification,
          sourceUnchanged: true,
          reconciledByRetry: true,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }
  const stillHolding = fresh?.lines.some((l) => holdingIds.includes(l.accountQboId));
  if (!fresh || !stillHolding) {
    const before = await holdingAccountName(d.db, txn.companyId, holdingIds);
    return markSuperseded(d, { id: txn.id, companyId: txn.companyId, payee: txn.payee, amount: Number(txn.amount) }, before);
  }

  await d.db.transaction.update({
    where: { id: txnId },
    data: { status: 'PENDING', qboSyncToken: fresh.syncToken, errorCode: null, errorMessage: null },
  });
  return { id: txnId, ok: true, status: 'PENDING' };
}

// ---------------------------------------------------------------------------
// bulkPost — sequential, per-id results (QBO rate limits are generous but a
// self-hosted install should still write one at a time)
// ---------------------------------------------------------------------------

export async function bulkPost(
  txnIds: string[],
  actor: Actor,
  deps?: WritebackDeps,
  canContinue: () => boolean = () => true,
): Promise<PostResult[]> {
  const d = deps ?? (await defaultDeps());
  const results: PostResult[] = [];
  for (let index = 0; index < txnIds.length; index += 1) {
    const id = txnIds[index]!;
    if (!canContinue()) {
      for (const remainingId of txnIds.slice(index)) {
        results.push({
          id: remainingId,
          ok: false,
          status: 'PENDING',
          error: {
            code: 'ACCOUNTING_WRITE_LEASE_LOST',
            message: 'The accounting write lease was lost before this transaction was posted.',
          },
        });
      }
      break;
    }
    try {
      results.push(await postTransaction(id, actor, { canWrite: canContinue }, d));
    } catch (err) {
      const info = errorInfo(err);
      results.push({ id, ok: false, status: 'PENDING', error: info });
    }
  }
  return results;
}
