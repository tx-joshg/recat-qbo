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

import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type {
  AuditAction,
  SplitDto,
  StagedCategorization,
  TaxDisposition,
  TxnStatus,
} from '@recat/shared';
import {
  QboSyncTokenConflict,
  type QboClient,
  type QboDepositPreparedWrite,
  type QboDepositSnapshot,
  type QboPreparedWrite,
  type QboPurchasePreparedWrite,
  type QboPurchaseSnapshot,
  type QboTxn,
  type QboWriteResult,
} from '../lib/qbo/types.js';
import {
  calculatePurchaseTransaction,
  calculateSalesTransaction,
  reconstructPurchaseTaxExcludedTransaction,
  reconstructSalesTaxExcludedTransaction,
} from '../lib/qbo/purchaseTax.js';
import { verifyPreparedResult } from './tax/verify.js';
import { cachedSalesTaxReadiness } from './tax/reference.js';
import { lockCompanyMutationScope } from './companyMutationScope.js';
import {
  acquireEntityLease,
  renewEntityLease,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseKey,
} from './entityLease.js';
import type { MutationAuditInput } from './audit.js';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from './agent/evaluation.js';
import {
  assertLiveCommitAuthority,
  assertLiveRetryAuthority,
  type AutopilotWritebackAuthorityInput,
  type LiveMutationContext,
  type LiveMutationProof,
} from './agent/liveMutationAuthority.js';
import { pauseLiveCompanyInTransaction } from './agent/circuitBreaker.js';
import { isCanonicalLiveCheckpoint } from './agent/liveCheckpoint.js';
import { candidateContextFor } from './agent/ruleCandidates.js';
import {
  persistedEvidenceProposal,
  persistedRuleCandidateContext,
} from './categorizationEvidence.js';
import {
  assertQboWriteAllowed,
  QboWriteSafetyError,
  type QboWriteSafetyTarget,
} from '../lib/qbo/writeSafety.js';

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
  mutation?: MutationAuditInput;
}

type AuditFn = (txOrPrisma: Prisma.TransactionClient | PrismaClient, entry: AuditEntryInput) => Promise<unknown>;

export interface WritebackDeps {
  db: PrismaClient;
  getClient: (companyId: string) => Promise<QboClient>;
  audit: AuditFn;
  envDryRun: boolean;
}

async function defaultDeps(): Promise<WritebackDeps> {
  const [{ prisma }, { qboFactory }, { writeAudit }, { env }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
  ]);
  return {
    db: prisma,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: writeAudit,
    envDryRun: env.DRY_RUN,
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
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  memo: string | null;
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
      taxCode: l.taxCode ?? null,
      taxCodeQboId: l.taxCodeQboId ?? null,
      tagIds: l.tags.map((t) => t.tagId),
      ...(l.memo !== null ? { memo: l.memo } : {}),
    }));
}

// ---------------------------------------------------------------------------

interface WriteSplit {
  amount: number;
  accountQboId: string;
  memo?: string;
}

interface ResolvedAccount {
  qboId: string;
  name: string;
  fullName: string;
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
  await d.db.$transaction(async (tx) => {
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
  });
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

async function legacyNeedsStaging(
  db: PrismaClient,
  txn: {
    id: string;
    qboType: string;
    companyId: string;
    taxCalculation: string | null;
    taxCodeQboId: string | null;
    splitLines: { taxCodeQboId?: string | null }[];
    company: {
      taxSupportStatus: string;
      taxUsingSalesTax: boolean | null;
      taxSupportReason: string | null;
    };
  },
): Promise<boolean> {
  if (
    txn.taxCalculation !== null ||
    txn.taxCodeQboId !== null ||
    txn.splitLines.some((line) => line.taxCodeQboId != null)
  ) {
    return true;
  }
  const durableAttempt = await db.qboMutationAttempt.findFirst({
    where: { transactionId: txn.id },
    select: { id: true },
  });
  if (durableAttempt) return true;
  if (txn.qboType === 'Purchase') {
    return txn.company.taxSupportStatus === 'ready';
  }
  if (txn.qboType !== 'Deposit') return false;
  const cachedCodes = await db.qboTaxCode.findMany({
    where: { companyId: txn.companyId },
    select: {
      active: true,
      taxable: true,
      salesTaxRateList: true,
      combinedSalesRate: true,
    },
  });
  return cachedSalesTaxReadiness(
    txn.company.taxUsingSalesTax,
    cachedCodes,
    txn.company.taxSupportReason,
  ).status === 'ready';
}

export async function postTransaction(
  txnId: string,
  actor: Actor,
  opts: { auto?: boolean } = {},
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
  const company = txn.company;
  if (await legacyNeedsStaging(d.db, txn)) {
    throw new WritebackLifecycleError(
      'TAX_AWARE_STAGING_REQUIRED',
      `Tax-ready ${txn.qboType}s must use staged categorization.`,
    );
  }
  if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
    throw new Error(`Cannot post a transaction in status ${txn.status}`);
  }

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

  await d.db.transaction.update({ where: { id: txnId }, data: { status: 'POSTING' } });

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
        writeSplits.push({ amount: s.amount, accountQboId: acct.qboId, memo: s.memo });
      }
      afterLabel = `Split · ${splits.map((s) => s.category).join(' / ')}`;
    } else {
      const categoryName = txn.category ?? '';
      const acct = await resolveCategoryAccount(d.db, company.id, txn.categoryQboId, categoryName);
      if (!acct) throw new Error(`Unknown category "${categoryName}" — re-sync the chart of accounts.`);
      writeSplits.push({ amount, accountQboId: acct.qboId, memo: txn.memo ?? undefined });
      afterLabel = acct.fullName || categoryName;
    }

    const now = new Date();
    const successAction: AuditAction = opts.auto ? 'auto-posted' : 'posted';
    const payload = {
      qboType: txn.qboType,
      qboId: txn.qboId,
      syncToken: fresh.syncToken,
      splits: writeSplits,
    };

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
      });
      return { id: txnId, ok: true, status: 'DRY_RUN' };
    }

    // ---- real write, with one SyncToken-conflict retry ----
    let result: QboWriteResult;
    try {
      try {
        await assertTxnWriteSafety(client, fresh);
        result = await client.recategorize(fresh, writeSplits);
      } catch (err) {
        if (!(err instanceof QboSyncTokenConflict)) throw err;
        // Someone edited the entity between our read and write: re-fetch and
        // retry exactly once.
        const refetched = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
        const stillHolding = refetched?.lines.some((l) => holdingIds.includes(l.accountQboId));
        if (!refetched || !stillHolding) return await markSuperseded(d, baseTxn, before);
        payload.syncToken = refetched.syncToken;
        await assertTxnWriteSafety(client, refetched);
        result = await client.recategorize(refetched, writeSplits);
      }
    } catch (err) {
      const info = errorInfo(err);
      if (err instanceof QboWriteSafetyError) {
        await d.db.transaction.update({
          where: { id: txnId },
          data: { status: 'PENDING', errorCode: null, errorMessage: null },
        });
        return { id: txnId, ok: false, status: 'PENDING', error: info };
      }
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

export async function undoPost(txnId: string, actor: Actor, deps?: WritebackDeps): Promise<PostResult> {
  const d = deps ?? (await defaultDeps());

  const txn = await d.db.transaction.findUnique({
    where: { id: txnId },
    include: { company: true, splitLines: { include: { tags: true }, orderBy: { idx: 'asc' } } },
  });
  if (!txn) throw new Error(`Transaction ${txnId} not found`);
  const company = txn.company;
  if (await legacyNeedsStaging(d.db, txn)) {
    throw new WritebackLifecycleError(
      'TAX_AWARE_STAGING_REQUIRED',
      `Tax-ready ${txn.qboType}s must use staged categorization.`,
    );
  }
  if (txn.status !== 'POSTED' && txn.status !== 'DRY_RUN') {
    throw new Error(`Only posted transactions can be undone (status is ${txn.status})`);
  }
  if (!txn.postedAt || Date.now() - txn.postedAt.getTime() > UNDO_WINDOW_MS) {
    throw new Error('The 30-day undo window for this transaction has passed.');
  }

  const amount = Number(txn.amount);
  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const holdingId = holdingIds[0];
  if (!holdingId) throw new Error('No holding account configured for this company.');
  const holdingName = await holdingAccountName(d.db, company.id, holdingIds);

  const splits = splitLineDtos(txn.splitLines);
  const beforeLabel =
    splits && splits.length > 0 ? `Split · ${splits.map((s) => s.category).join(' / ')}` : txn.category ?? '—';

  // Undo in QBO based on HOW the txn was posted: DRY_RUN wrote nothing, so
  // there is nothing to undo there; POSTED always wrote, so it must always be
  // reversed — regardless of what the dry-run config says NOW.
  let newSyncToken = txn.qboSyncToken;
  let qboWrote = false;
  if (txn.status === 'POSTED') {
    const client = await d.getClient(company.id);
    const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
    if (!fresh) {
      // Re-queuing a txn whose QBO entity is gone would strand a phantom in
      // the queue — fail loudly instead.
      throw new Error('This transaction no longer exists in QuickBooks.');
    }
    // Pull back exactly the category lines the post wrote; any other lines on
    // the entity are preserved verbatim by moveToAccount.
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
    await assertTxnWriteSafety(client, fresh);
    const result = await client.moveToAccount(fresh, holdingId, fromIds);
    newSyncToken = result.newSyncToken;
    qboWrote = true;
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
  const unresolvedPreparedWrite = await d.db.qboMutationAttempt.findFirst({
    where: {
      transactionId: txnId,
      status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
    },
  });
  if (unresolvedPreparedWrite) {
    throw new WritebackLifecycleError(
      'MUTATION_BLOCKED',
      'This write must be reconciled before the transaction can be retried.',
    );
  }

  const holdingIds = jsonStringArray(txn.company.holdingAccountIds);
  const client = await d.getClient(txn.companyId);
  const fresh = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
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

export async function bulkPost(txnIds: string[], actor: Actor, deps?: WritebackDeps): Promise<PostResult[]> {
  const d = deps ?? (await defaultDeps());
  const results: PostResult[] = [];
  for (const id of txnIds) {
    try {
      results.push(await postTransaction(id, actor, {}, d));
    } catch (err) {
      const info = errorInfo(err);
      results.push({ id, ok: false, status: 'PENDING', error: info });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tax-aware durable prepared-write lifecycle
// ---------------------------------------------------------------------------

type AttemptStatus =
  | 'PREPARED'
  | 'COMMITTING'
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'RETRYABLE'
  | 'UNCHANGED'
  | 'DRY_RUN'
  | 'FAILED';

export interface DurableAttempt {
  id: string;
  transactionId: string;
  requestId: string;
  operation: string;
  status: string;
  expectedRevision: number;
  expectedSyncToken: string;
  requestHash: string;
  requestPayload: unknown;
  beforeSnapshot: unknown;
  responseSnapshot: unknown;
  verification: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

interface DurableTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: number | string | { toString(): string };
  payee: string;
  postedAt: Date | null;
  postedByUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  taxCalculation: string | null;
  company: {
    id: string;
    disconnectedAt: Date | null;
    dryRun: boolean;
    holdingAccountIds: unknown;
    taxSupportStatus: string;
    taxUsingSalesTax: boolean | null;
    taxSupportReason: string | null;
  };
  splitLines: {
    idx: number;
    amount: number | string | { toString(): string };
    category: string;
    categoryQboId: string | null;
    taxCode: string | null;
    taxCodeQboId: string | null;
    memo: string | null;
    tags?: { tagId: string }[];
  }[];
  txnTags: { tagId: string }[];
}

interface DurableTaxCode {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
  salesTaxRateList: unknown;
  combinedSalesRate: number | string | { toString(): string } | null;
}

interface DurableTaxRate {
  qboId: string;
  name: string;
  active: boolean;
  rateValue: number | string | { toString(): string } | null;
}

export interface DurableWritebackDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  transaction: {
    findUnique(args: {
      where: { id: string };
      include: {
        company: true;
        splitLines: {
          orderBy: { idx: 'asc' };
          include?: { tags: true };
        };
        txnTags: true;
      };
    }): Promise<DurableTransaction | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    updateMany(args: {
      where: {
        id: string;
        companyId: string;
        qboType: string;
        qboId: string;
        qboSyncToken: string;
        revision: number;
        status: string;
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  qboMutationAttempt: {
    findUnique(args: {
      where: { requestId: string };
    }): Promise<DurableAttempt | null>;
    findFirst(args: {
      where: {
        transactionId: string;
        operation?: string;
        status?: string | { in: string[] };
      };
      orderBy?: { createdAt: 'desc' };
    }): Promise<DurableAttempt | null>;
    create(args: {
      data: {
        transactionId: string;
        requestId: string;
        operation: string;
        status: AttemptStatus;
        expectedRevision: number;
        expectedSyncToken: string;
        requestHash: string;
        requestPayload: unknown;
        beforeSnapshot: unknown;
        responseSnapshot?: unknown;
        verification?: unknown;
        errorCode?: string | null;
        errorMessage?: string | null;
      };
    }): Promise<DurableAttempt>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<DurableAttempt>;
    updateMany(args: {
      where: { id: string; status: string | { in: string[] } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  agentCompanyConfig: {
    findUnique(args: {
      where: { companyId: string };
      select: { configVersion: true };
    }): Promise<{ configVersion: string } | null>;
  };
  qboAccount: {
    findMany(args: {
      where: { companyId: string; qboId: { in: string[] }; active: true };
    }): Promise<{ qboId: string; active: boolean }[]>;
  };
  qboTaxCode: {
    findMany(args: {
      where: { companyId: string; qboId: { in: string[] } };
    }): Promise<DurableTaxCode[]>;
  };
  qboTaxRate: {
    findMany(args: {
      where: { companyId: string; active: true; rateValue: { not: null } };
    }): Promise<DurableTaxRate[]>;
  };
  $transaction<T>(callback: (tx: DurableWritebackDb) => Promise<T>): Promise<T>;
}

export interface DurableWritebackDeps {
  db: DurableWritebackDb;
  getClient: (companyId: string) => Promise<QboClient>;
  audit: AuditFn;
  authorize: (
    actorId: string | null,
    companyId: string,
    authorization: DurableMutationAuthorization,
  ) => Promise<boolean>;
  envDryRun: boolean;
  lease: <T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ) => Promise<T>;
  renewLease: (key: EntityLeaseKey, owner: string) => Promise<void>;
  invocationId: () => string;
  now: () => Date;
  reconciliationSignal?: AbortSignal;
  authorizeReconciliationInTransaction?: (
    tx: DurableWritebackDb,
    actorId: string,
    companyId: string,
  ) => Promise<boolean>;
  onVerifiedCategorizationOutcome?: (
    outcome: VerifiedCategorizationOutcome,
  ) => Promise<void>;
  onReconciledMutation?: (
    tx: DurableWritebackDb,
    outcome: {
      attempt: DurableAttempt;
      transaction: DurableTransaction;
      status: 'VERIFIED' | 'UNCHANGED';
    },
  ) => Promise<void>;
  onUncertainMutation?: (
    tx: DurableWritebackDb,
    outcome: {
      attempt: DurableAttempt;
      transaction: DurableTransaction;
      errorCode: 'QBO_WRITE_UNCERTAIN' | 'QBO_READBACK_MISMATCH';
    },
  ) => Promise<void>;
}

export type DurableMutationAuthorization =
  | { kind: 'user' }
  | { kind: 'mcp'; tokenId: string; tokenPrefix: string };

export interface ExpectedQboBinding {
  qboType: string;
  qboId: string;
  qboSyncToken: string;
}

export interface CommitStagedCategorizationInput {
  transactionId: string;
  companyId: string;
  expectedRevision: number;
  requestId: string;
  actor: Actor;
  expectedStageHash?: string;
  expectedTaxDisposition?: TaxDisposition;
  expectedQboBinding?: ExpectedQboBinding;
  authorization?: DurableMutationAuthorization;
}

export interface ReconcileMutationAttemptInput {
  requestId: string;
  actor: Actor;
  authorization?: DurableMutationAuthorization;
  expectedStageHash?: string;
  expectedTaxDisposition?: TaxDisposition;
  expectedQboBinding?: ExpectedQboBinding;
  auditAttribution?: McpMutationAuditAttribution;
}

export interface GuardedLiveReconciliationInput {
  readonly companyId: string;
  readonly transactionId: string;
  readonly qboType: 'Purchase';
  readonly qboId: string;
  readonly requestId: string;
  readonly operation: 'recategorize';
  readonly expectedRevision: number;
  readonly configVersion: string;
  readonly requestHash: string;
  readonly checkpointHash: string;
}

export interface UndoCategorizationInput {
  transactionId: string;
  companyId: string;
  requestId: string;
  actor: Actor;
  authorization?: DurableMutationAuthorization;
  proof?: CategorizationUndoProof;
  auditAttribution?: McpMutationAuditAttribution;
}

export interface CategorizationUndoProof {
  sourceRequestId: string;
  expectedRevision: number;
  expectedQboBinding: ExpectedQboBinding;
  sourcePreparedHash: string;
  currentPostHash: string;
  restoreHash: string;
}

export interface McpMutationAuditAttribution {
  sourceOperationId: string;
  operationId: string;
  tokenPrefix: string;
}

export interface PrepareCategorizationUndoInput {
  transactionId: string;
  companyId: string;
  sourceRequestId: string;
  expectedRevision: number;
  expectedSourceSyncToken: string;
  expectedQboBinding: Pick<ExpectedQboBinding, 'qboType' | 'qboId'>;
  actor: Actor;
  authorization: DurableMutationAuthorization;
}

export interface PreparedCategorizationUndo {
  transactionId: string;
  companyId: string;
  revision: number;
  qboType: 'Purchase';
  qboId: string;
  qboSyncToken: string;
  sourcePreparedHash: string;
  currentPostHash: string;
  restoreHash: string;
  preview: {
    action: 'restore_purchase_categorization';
    resultingStatus: 'REVERTED';
    direction: 'purchase' | 'refund';
    totalCents: number;
    totalTaxCents: number | null;
    lineCount: number;
    restorationDigest: string;
  };
}

export type DurableMutationOutcome =
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'IN_PROGRESS'
  | 'UNCHANGED'
  | 'DRY_RUN'
  | 'RETRYABLE';

export interface DurableMutationResult {
  transactionId: string;
  requestId: string;
  ok: boolean;
  status: TxnStatus;
  outcome: DurableMutationOutcome;
  error?: { code: string; message: string };
}

export class WritebackLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WritebackLifecycleError';
  }
}

const ACTIVE_ATTEMPT_STATUSES = ['PREPARED', 'COMMITTING', 'UNCERTAIN'];
const POSSIBLE_WRITE_GUIDANCE =
  'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.';
const LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE =
  'The guarded live mutation exhausted its retry budget.';
const AUTOPILOT_ACTOR: Actor = Object.freeze({
  id: null,
  label: 'Recat autopilot',
});

async function defaultDurableDeps(): Promise<DurableWritebackDeps> {
  const [{ prisma }, { qboFactory }, { writeAudit }, { env }] = await Promise.all([
    import('../lib/prisma.js'),
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
  ]);
  return {
    db: prisma as unknown as DurableWritebackDb,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: writeAudit,
    authorize: async (actorId, companyId, authorization) => {
      if (actorId === null) return false;
      if (authorization.kind === 'mcp') {
        const token = await prisma.mcpToken.findFirst({
          where: {
            id: authorization.tokenId,
            userId: actorId,
            prefix: authorization.tokenPrefix,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (token === null) return false;
      }
      const user = await prisma.user.findUnique({
        where: { id: actorId },
        select: { isInstanceAdmin: true },
      });
      if (user?.isInstanceAdmin) return true;
      const membership = await prisma.membership.findUnique({
        where: { userId_companyId: { userId: actorId, companyId } },
        select: { role: true },
      });
      return membership?.role === 'admin' || membership?.role === 'categorizer';
    },
    envDryRun: env.DRY_RUN,
    lease: (key, owner, callback) =>
      withEntityLease(key, owner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    renewLease: (key, owner) =>
      renewEntityLease(key, owner, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    invocationId: randomUUID,
    now: () => new Date(),
    onVerifiedCategorizationOutcome: async (outcome) => {
      const [
        { evaluateShadowRunAgainstOutcome },
        { recordVerifiedRuleCandidateOutcome },
      ] = await Promise.all([
        import('./agent/evaluation.js'),
        import('./agent/ruleCandidatePersistence.js'),
      ]);
      const results = await Promise.allSettled([
        evaluateShadowRunAgainstOutcome(outcome),
        recordVerifiedRuleCandidateOutcome(outcome),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}

function lifecycleError(code: string, message: string): never {
  throw new WritebackLifecycleError(code, message);
}

function exactMoneyCents(value: DurableTransaction['amount']): number {
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return lifecycleError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is not exact cents.');
  const sign = match[1] === '-' ? -1n : 1n;
  const cents =
    sign *
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return lifecycleError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is outside the safe cents range.');
  }
  return Number(cents);
}

function uniqueStrings(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value.trim() !== ''))];
}

function asPurchaseRates(value: unknown): {
  taxRateQboId: string;
  taxTypeApplicable: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('taxRateQboId' in candidate) ||
      !('taxTypeApplicable' in candidate) ||
      typeof candidate.taxRateQboId !== 'string' ||
      typeof candidate.taxTypeApplicable !== 'string'
    ) {
      return [];
    }
    return [{
      taxRateQboId: candidate.taxRateQboId,
      taxTypeApplicable: candidate.taxTypeApplicable,
    }];
  });
}

async function loadAuthorizedTransactionState(
  transactionId: string,
  companyId: string,
  expectedRevision: number,
  actorId: string | null,
  d: DurableWritebackDeps,
  allowedStatuses: string[],
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedQboBinding?: ExpectedQboBinding,
  allowDisconnected = false,
): Promise<DurableTransaction> {
  const [txn, authorized] = await Promise.all([
    d.db.transaction.findUnique({
      where: { id: transactionId },
      include: {
        company: true,
        splitLines: {
          orderBy: { idx: 'asc' },
          include: { tags: true },
        },
        txnTags: true,
      },
    }),
    d.authorize(actorId, companyId, authorization),
  ]);
  if (!authorized) lifecycleError('FORBIDDEN', 'You do not have permission to write this transaction.');
  if (!txn || txn.companyId !== companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  if (!allowDisconnected && txn.company.disconnectedAt !== null) {
    lifecycleError('COMPANY_DISCONNECTED', 'This company is disconnected from QuickBooks.');
  }
  if (txn.revision !== expectedRevision) {
    lifecycleError('STALE_REVISION', 'The staged transaction changed. Reload before writing.');
  }
  if (
    expectedQboBinding !== undefined
    && (
      txn.qboType !== expectedQboBinding.qboType
      || txn.qboId !== expectedQboBinding.qboId
      || txn.qboSyncToken !== expectedQboBinding.qboSyncToken
    )
  ) {
    lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
  }
  if (!allowedStatuses.includes(txn.status)) {
    lifecycleError('INVALID_STATUS', `Transaction cannot be written from status ${txn.status}.`);
  }
  if (txn.qboType !== 'Purchase' && txn.qboType !== 'Deposit') {
    lifecycleError(
      'QBO_ENTITY_UNSUPPORTED',
      'Tax-aware durable writes support Purchase and Deposit transactions only.',
    );
  }
  return txn;
}

async function loadAuthorizedStage(
  transactionId: string,
  companyId: string,
  expectedRevision: number,
  actorId: string | null,
  d: DurableWritebackDeps,
  allowedStatuses: string[],
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
  expectedTaxDisposition: TaxDisposition = 'set',
): Promise<{ txn: DurableTransaction; staged: StagedCategorization }> {
  if (expectedTaxDisposition === 'preserve_current' && expectedStageHash === undefined) {
    lifecycleError(
      'INVALID_STAGE',
      'Preserved Purchase tax requires an immutable expected stage hash.',
    );
  }
  const txn = await loadAuthorizedTransactionState(
    transactionId,
    companyId,
    expectedRevision,
    actorId,
    d,
    allowedStatuses,
    authorization,
    expectedQboBinding,
  );
  if (txn.splitLines.length === 0) {
    lifecycleError('INVALID_STAGE', `The staged ${txn.qboType} has no prepared lines.`);
  }

  const accountIds = uniqueStrings(txn.splitLines.map((line) => line.categoryQboId));
  if (accountIds.length !== txn.splitLines.length) {
    lifecycleError('INVALID_ACCOUNT', 'Every prepared line requires a category account.');
  }
  const accounts = await d.db.qboAccount.findMany({
    where: { companyId, qboId: { in: accountIds }, active: true },
  });
  if (accounts.length !== accountIds.length) {
    lifecycleError('INVALID_ACCOUNT', 'A prepared category account is no longer available.');
  }

  const taxCalculation = txn.taxCalculation;
  if (
    taxCalculation !== 'TaxInclusive' &&
    taxCalculation !== 'TaxExcluded' &&
    taxCalculation !== 'NotApplicable'
  ) {
    lifecycleError('INVALID_STAGE', `The staged ${txn.qboType} tax calculation is invalid.`);
  }

  const grossCents = txn.splitLines.map((line) => exactMoneyCents(line.amount));
  let calculatedLines: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  }[];
  if (taxCalculation === 'NotApplicable') {
    if (expectedTaxDisposition === 'preserve_current') {
      if (
        txn.qboType !== 'Purchase'
        || txn.splitLines.length !== 1
        || txn.splitLines[0]!.taxCodeQboId === null
        || txn.splitLines[0]!.taxCodeQboId!.trim() === ''
        || txn.splitLines[0]!.memo !== null
        || (txn.splitLines[0]!.tags?.length ?? 0) !== 0
        || txn.txnTags.length !== 0
      ) {
        lifecycleError(
          'INVALID_STAGE',
          'Preserved Purchase tax requires one untagged, memo-free line with an explicit tax code.',
        );
      }
    } else if (txn.splitLines.some((line) => line.taxCodeQboId !== null)) {
      lifecycleError('INVALID_STAGE', 'NotApplicable lines cannot retain tax references.');
    }
    calculatedLines = grossCents.map((totalCents) => ({
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
    }));
  } else {
    const taxCodeIds = uniqueStrings(txn.splitLines.map((line) => line.taxCodeQboId));
    if (taxCodeIds.length !== txn.splitLines.length) {
      lifecycleError('TAX_CODE_UNAVAILABLE', 'Every taxed line requires an available tax code.');
    }
    const [taxCodes, taxRates] = await Promise.all([
      d.db.qboTaxCode.findMany({
        where: { companyId, qboId: { in: taxCodeIds } },
      }),
      d.db.qboTaxRate.findMany({
        where: { companyId, active: true, rateValue: { not: null } },
      }),
    ]);
    if (
      taxCodes.length !== taxCodeIds.length ||
      taxCodes.some((code) => !code.active)
    ) {
      lifecycleError('TAX_CODE_UNAVAILABLE', 'A prepared tax code is no longer available.');
    }
    const taxReady =
      txn.qboType === 'Deposit'
        ? cachedSalesTaxReadiness(
            txn.company.taxUsingSalesTax,
            taxCodes,
            txn.company.taxSupportReason,
          ).status === 'ready'
        : txn.company.taxSupportStatus === 'ready' &&
          txn.company.taxUsingSalesTax === true;
    if (!taxReady) {
      lifecycleError('TAX_NOT_READY', `${txn.qboType} tax references are not ready.`);
    }
    const calculateTransaction =
      txn.qboType === 'Deposit'
        ? calculateSalesTransaction
        : calculatePurchaseTransaction;
    const taxReference = {
      companyId,
      codes: taxCodes.map((code) => ({
        qboId: code.qboId,
        name: code.name,
        description: null,
        active: code.active,
        taxable: code.taxable,
        purchaseRates: asPurchaseRates(code.purchaseTaxRateList),
        salesRates: asPurchaseRates(code.salesTaxRateList),
        sourceUpdatedAt: null,
      })),
      rates: taxRates.filter((rate) => rate.rateValue !== null).map((rate) => ({
        qboId: rate.qboId,
        name: rate.name,
        description: null,
        active: rate.active,
        rateValue: Number(rate.rateValue),
        sourceUpdatedAt: null,
      })),
    };
    const calculate = (
      mode: 'TaxInclusive' | 'TaxExcluded',
      lineCents: readonly number[],
    ) => calculateTransaction(
      {
        companyId,
        taxCalculation: mode,
        lines: txn.splitLines.map((line, index) => ({
          grossCents: lineCents[index]!,
          taxCodeQboId: line.taxCodeQboId!,
        })),
      },
      taxReference,
    );
    const initialCalculation = calculate(
      taxCalculation === 'TaxExcluded' ? 'TaxInclusive' : taxCalculation,
      grossCents,
    );
    if (!initialCalculation.eligible) {
      lifecycleError(
        initialCalculation.reason,
        `Prepared ${txn.qboType} tax references no longer calculate exactly.`,
      );
    }
    const reconstructTaxExcluded =
      txn.qboType === 'Deposit'
        ? reconstructSalesTaxExcludedTransaction
        : reconstructPurchaseTaxExcludedTransaction;
    const calculation =
      taxCalculation === 'TaxExcluded'
        ? reconstructTaxExcluded(
            {
              companyId,
              lines: txn.splitLines.map((line, index) => ({
                grossCents: grossCents[index]!,
                taxCodeQboId: line.taxCodeQboId!,
              })),
            },
            taxReference,
          )
        : initialCalculation;
    if (calculation === null) {
      lifecycleError(
        'TAX_AMOUNT_INVALID',
        `Prepared ${txn.qboType} tax-exclusive totals cannot be reconstructed uniquely.`,
      );
    }
    if (!calculation.eligible) {
      lifecycleError(
        calculation.reason,
        `Prepared ${txn.qboType} tax references no longer calculate exactly.`,
      );
    }
    calculatedLines = calculation.lines.map((line) => ({
      subtotalCents: line.netCents,
      taxCents: line.taxCents,
      totalCents: line.netCents + line.taxCents,
    }));
  }

  const totals = calculatedLines.reduce(
    (sum, line) => ({
      subtotalCents: sum.subtotalCents + line.subtotalCents,
      taxCents: sum.taxCents + line.taxCents,
      totalCents: sum.totalCents + line.totalCents,
    }),
    { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  );
  if (totals.totalCents !== exactMoneyCents(txn.amount)) {
    lifecycleError(
      'STALE_REVISION',
      `The staged ${txn.qboType} total no longer matches the transaction.`,
    );
  }
  const staged: StagedCategorization = {
      transactionId: txn.id,
      revision: txn.revision,
      ...(expectedTaxDisposition === 'preserve_current'
        ? { taxDisposition: expectedTaxDisposition }
        : {}),
      taxCalculation,
      totals,
      lines: txn.splitLines.map((line, index) => ({
        idx: line.idx,
        ...calculatedLines[index]!,
        categoryQboId: line.categoryQboId!,
        taxCodeQboId: line.taxCodeQboId,
        memo: line.memo,
        tagIds: (line.tags?.map((tag) => tag.tagId) ?? []).sort(),
      })),
      tagIds: txn.txnTags.map((tag) => tag.tagId).sort(),
  };
  if (
    expectedStageHash !== undefined
    && hashStagedCategorization(staged) !== expectedStageHash
  ) {
    lifecycleError('STALE_STAGE', 'The staged categorization no longer matches this operation.');
  }
  return { txn, staged };
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceProposal(staged: StagedCategorization): VerifiedCategorizationProposal {
  return {
    taxCalculation: staged.taxCalculation,
    lines: staged.lines.map((line) => ({
      idx: line.idx,
      subtotalCents: line.subtotalCents,
      taxCents: line.taxCents,
      totalCents: line.totalCents,
      categoryQboId: line.categoryQboId,
      taxCodeQboId: line.taxCodeQboId,
      memo: line.memo,
      tagIds: [...(line.tagIds ?? [])],
    })),
    tagIds: [...staged.tagIds],
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isPurchaseSnapshotLine(value: unknown): boolean {
  if (!isRuntimeRecord(value)) return false;
  return (
    isNullableString(value.id) &&
    typeof value.amountCents === 'number' &&
    Number.isSafeInteger(value.amountCents) &&
    isNullableString(value.description) &&
    isNullableString(value.accountQboId) &&
    isNullableString(value.customerQboId) &&
    isNullableString(value.classQboId) &&
    isNullableString(value.taxCodeQboId) &&
    isNullableSafeInteger(value.taxAmountCents) &&
    isNullableSafeInteger(value.taxInclusiveCents)
  );
}

function isPurchaseSnapshot(value: unknown): value is QboPurchaseSnapshot {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.syncToken === 'string' &&
    value.syncToken.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.accountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    (value.direction === 'purchase' || value.direction === 'refund') &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    Array.isArray(value.lines) &&
    value.lines.every(isPurchaseSnapshotLine)
  );
}

function isExpectedPurchase(value: unknown): value is QboPurchasePreparedWrite['expected'] {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.accountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    (value.direction === 'purchase' || value.direction === 'refund') &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    Array.isArray(value.targetLines) &&
    value.targetLines.every(isPurchaseSnapshotLine) &&
    Array.isArray(value.untouchedLineHashes) &&
    value.untouchedLineHashes.every((hash) => typeof hash === 'string')
  );
}

function isQboReference(value: unknown): boolean {
  return (
    isRuntimeRecord(value) &&
    typeof value.value === 'string' &&
    value.value.trim() !== '' &&
    (value.name === undefined || typeof value.name === 'string')
  );
}

function isOptionalQboReference(value: unknown): boolean {
  return value === undefined || isQboReference(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isPreparedPurchaseBody(value: unknown): value is QboPurchasePreparedWrite['body'] {
  if (!isRuntimeRecord(value)) return false;
  if (
    typeof value.Id !== 'string' ||
    value.Id.trim() === '' ||
    typeof value.SyncToken !== 'string' ||
    value.SyncToken.trim() === '' ||
    typeof value.TxnDate !== 'string' ||
    value.TxnDate.trim() === '' ||
    typeof value.TotalAmt !== 'number' ||
    !Number.isFinite(value.TotalAmt) ||
    !isQboReference(value.AccountRef) ||
    !isOptionalQboReference(value.EntityRef) ||
    !isOptionalQboReference(value.CurrencyRef) ||
    !isOptionalFiniteNumber(value.ExchangeRate) ||
    (value.PaymentType !== undefined &&
      (typeof value.PaymentType !== 'string' || value.PaymentType.trim() === '')) ||
    (value.GlobalTaxCalculation !== undefined &&
      (typeof value.GlobalTaxCalculation !== 'string' ||
        value.GlobalTaxCalculation.trim() === '')) ||
    !Array.isArray(value.Line) ||
    value.Line.length === 0
  ) {
    return false;
  }
  return value.Line.every((line) => {
    if (!isRuntimeRecord(line)) return false;
    if (line.Id !== undefined && (typeof line.Id !== 'string' || line.Id.trim() === '')) return false;
    if (typeof line.Amount !== 'number' || !Number.isFinite(line.Amount)) {
      return false;
    }
    if (line.Description !== undefined && typeof line.Description !== 'string') return false;
    if (line.DetailType !== 'AccountBasedExpenseLineDetail') return false;
    const detail = line.AccountBasedExpenseLineDetail;
    if (!isRuntimeRecord(detail)) return false;
    return (
      isQboReference(detail.AccountRef) &&
      isOptionalQboReference(detail.CustomerRef) &&
      isOptionalQboReference(detail.ClassRef) &&
      isOptionalQboReference(detail.TaxCodeRef) &&
      isOptionalFiniteNumber(detail.TaxAmount) &&
      isOptionalFiniteNumber(detail.TaxInclusiveAmt)
    );
  });
}

function isDepositSnapshotLine(value: unknown): boolean {
  if (!isRuntimeRecord(value)) return false;
  return (
    isNullableString(value.id) &&
    typeof value.amountCents === 'number' &&
    Number.isSafeInteger(value.amountCents) &&
    isNullableString(value.description) &&
    isNullableString(value.accountQboId) &&
    isNullableString(value.entityQboId) &&
    isNullableString(value.paymentMethodQboId) &&
    isNullableString(value.classQboId) &&
    isNullableString(value.taxCodeQboId) &&
    isNullableString(value.taxApplicableOn) &&
    typeof value.rawHash === 'string' &&
    value.rawHash.trim() !== '' &&
    typeof value.targetHash === 'string' &&
    value.targetHash.trim() !== ''
  );
}

function isDepositSnapshot(value: unknown): value is QboDepositSnapshot {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.syncToken === 'string' &&
    value.syncToken.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.depositToAccountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    typeof value.preservedHash === 'string' &&
    value.preservedHash.trim() !== '' &&
    Array.isArray(value.lines) &&
    value.lines.every(isDepositSnapshotLine)
  );
}

function isExpectedDeposit(
  value: unknown,
): value is QboDepositPreparedWrite['expected'] {
  if (!isRuntimeRecord(value)) return false;
  return (
    typeof value.qboId === 'string' &&
    value.qboId.trim() !== '' &&
    typeof value.totalCents === 'number' &&
    Number.isSafeInteger(value.totalCents) &&
    isNullableString(value.depositToAccountQboId) &&
    typeof value.date === 'string' &&
    value.date.trim() !== '' &&
    isNullableString(value.globalTaxCalculation) &&
    isNullableSafeInteger(value.totalTaxCents) &&
    typeof value.preservedHash === 'string' &&
    value.preservedHash.trim() !== '' &&
    Array.isArray(value.targetLines) &&
    value.targetLines.every(isDepositSnapshotLine) &&
    Array.isArray(value.untouchedLineHashes) &&
    value.untouchedLineHashes.every(
      (hash) => typeof hash === 'string' && hash.trim() !== '',
    )
  );
}

function isPreparedDepositBody(
  value: unknown,
): value is QboDepositPreparedWrite['body'] {
  if (!isRuntimeRecord(value)) return false;
  if (
    typeof value.Id !== 'string' ||
    value.Id.trim() === '' ||
    typeof value.SyncToken !== 'string' ||
    value.SyncToken.trim() === '' ||
    typeof value.TxnDate !== 'string' ||
    value.TxnDate.trim() === '' ||
    typeof value.TotalAmt !== 'number' ||
    !Number.isFinite(value.TotalAmt) ||
    !isQboReference(value.DepositToAccountRef) ||
    !isOptionalQboReference(value.CurrencyRef) ||
    !isOptionalFiniteNumber(value.ExchangeRate) ||
    (value.GlobalTaxCalculation !== undefined &&
      (typeof value.GlobalTaxCalculation !== 'string' ||
        value.GlobalTaxCalculation.trim() === '')) ||
    !Array.isArray(value.Line) ||
    value.Line.length === 0
  ) {
    return false;
  }
  return value.Line.every((line) => {
    if (!isRuntimeRecord(line)) return false;
    if (line.Id !== undefined && (typeof line.Id !== 'string' || line.Id.trim() === '')) {
      return false;
    }
    if (typeof line.Amount !== 'number' || !Number.isFinite(line.Amount)) {
      return false;
    }
    if (line.Description !== undefined && typeof line.Description !== 'string') {
      return false;
    }
    if (line.DetailType !== 'DepositLineDetail') return false;
    const detail = line.DepositLineDetail;
    if (!isRuntimeRecord(detail)) return false;
    return (
      isQboReference(detail.AccountRef) &&
      isOptionalQboReference(detail.Entity) &&
      isOptionalQboReference(detail.PaymentMethodRef) &&
      isOptionalQboReference(detail.ClassRef) &&
      isOptionalQboReference(detail.TaxCodeRef) &&
      (detail.TaxApplicableOn === undefined ||
        (typeof detail.TaxApplicableOn === 'string' &&
          detail.TaxApplicableOn.trim() !== ''))
    );
  });
}

function persistedPrepared(value: unknown): QboPreparedWrite {
  if (
    !isRuntimeRecord(value) ||
    (value.operation !== 'recategorize' && value.operation !== 'restore') ||
    (value.qboType !== 'Purchase' && value.qboType !== 'Deposit') ||
    typeof value.qboId !== 'string' ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim() === '' ||
    typeof value.requestHash !== 'string' ||
    value.requestHash.trim() === '' ||
    !isRuntimeRecord(value.body) ||
    !isRuntimeRecord(value.before) ||
    !isRuntimeRecord(value.expected)
  ) {
    return lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt is incomplete.');
  }
  const commonIdentity =
    value.body.Id === value.qboId &&
    value.before.qboId === value.qboId &&
    value.expected.qboId === value.qboId;
  const taxModeMatches =
    value.expected.globalTaxCalculation === null ||
    value.body.GlobalTaxCalculation === value.expected.globalTaxCalculation;
  const recategorizationHasTaxMode =
    value.operation !== 'recategorize' ||
    (typeof value.body.GlobalTaxCalculation === 'string' &&
      value.body.GlobalTaxCalculation.trim() !== '');
  const entityPayloadValid =
    value.qboType === 'Purchase'
      ? isPreparedPurchaseBody(value.body) &&
        isPurchaseSnapshot(value.before) &&
        isExpectedPurchase(value.expected)
      : isPreparedDepositBody(value.body) &&
        isDepositSnapshot(value.before) &&
        isExpectedDeposit(value.expected);
  if (
    !commonIdentity ||
    !taxModeMatches ||
    !recategorizationHasTaxMode ||
    !entityPayloadValid
  ) {
    return lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt is incomplete.');
  }
  return value as unknown as QboPreparedWrite;
}

type QboPreparedSnapshot = QboPurchaseSnapshot | QboDepositSnapshot;

function persistedSnapshot(
  value: unknown,
  qboType: QboPreparedWrite['qboType'],
): QboPreparedSnapshot {
  if (
    (qboType === 'Purchase' && !isPurchaseSnapshot(value)) ||
    (qboType === 'Deposit' && !isDepositSnapshot(value))
  ) {
    return lifecycleError(
      'ATTEMPT_CORRUPT',
      `Stored ${qboType} snapshot is incomplete.`,
    );
  }
  return value as QboPreparedSnapshot;
}

function preparedForAttempt(attempt: DurableAttempt): QboPreparedWrite {
  const prepared = persistedPrepared(attempt.requestPayload);
  if (
    prepared.operation !== attempt.operation ||
    prepared.requestId !== attempt.requestId ||
    prepared.requestHash !== attempt.requestHash ||
    hashPreparedWriteBody(prepared.body) !== attempt.requestHash ||
    prepared.body.SyncToken !== attempt.expectedSyncToken
  ) {
    lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt identity is inconsistent.');
  }
  return prepared;
}

function validateAttemptPersistence(attempt: DurableAttempt): QboPreparedWrite {
  const prepared = preparedForAttempt(attempt);
  const before = persistedSnapshot(attempt.beforeSnapshot, prepared.qboType);
  if (
    (prepared.operation === 'recategorize' && !snapshotEquals(before, prepared.before))
    || (
      prepared.operation === 'restore'
      && (
        before.qboId !== prepared.qboId
        || before.syncToken !== prepared.body.SyncToken
      )
    )
  ) {
    lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt before-image is inconsistent.');
  }
  if (attempt.responseSnapshot !== null) {
    const response = persistedSnapshot(attempt.responseSnapshot, prepared.qboType);
    if (response.qboId !== prepared.qboId) {
      lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation attempt response identity is inconsistent.');
    }
  }
  if (attempt.status === 'VERIFIED') {
    const response = persistedSnapshot(attempt.responseSnapshot, prepared.qboType);
    const verification = isRuntimeRecord(attempt.verification)
      ? attempt.verification
      : lifecycleError('ATTEMPT_CORRUPT', 'Verified mutation evidence is incomplete.');
    const expectedStatus = prepared.operation === 'restore' ? 'REVERTED' : 'POSTED';
    if (
      verification.outcome !== 'VERIFIED'
      || verification.status !== expectedStatus
      || typeof verification.newSyncToken !== 'string'
      || verification.newSyncToken !== response.syncToken
      || !verifyPreparedResult(prepared, response).ok
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Verified mutation evidence is inconsistent.');
    }
  }
  if (attempt.status === 'UNCHANGED') {
    const response = persistedSnapshot(attempt.responseSnapshot, prepared.qboType);
    const verification = isRuntimeRecord(attempt.verification)
      ? attempt.verification
      : lifecycleError('ATTEMPT_CORRUPT', 'Unchanged mutation evidence is incomplete.');
    const expectedStatus = prepared.operation === 'restore' ? 'POSTED' : 'PENDING';
    if (
      verification.outcome !== 'UNCHANGED'
      || verification.status !== expectedStatus
      || !snapshotEquals(response, before)
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Unchanged mutation evidence is inconsistent.');
    }
  }
  return prepared;
}

function validatePreparedBinding(
  attempt: DurableAttempt,
  txn: DurableTransaction,
): QboPreparedWrite {
  const prepared = validateAttemptPersistence(attempt);
  const before = persistedSnapshot(attempt.beforeSnapshot, prepared.qboType);
  const response = attempt.responseSnapshot === null
    ? null
    : persistedSnapshot(attempt.responseSnapshot, prepared.qboType);
  if (
    attempt.transactionId !== txn.id ||
    prepared.qboType !== txn.qboType ||
    prepared.qboId !== txn.qboId ||
    prepared.body.SyncToken !== before.syncToken ||
    !snapshotEquals(prepared.before, before) ||
    (response !== null && response.qboId !== txn.qboId)
  ) {
    lifecycleError(
      'ATTEMPT_CORRUPT',
      'Stored mutation attempt is not bound to its transaction and before snapshot.',
    );
  }
  return prepared;
}

function validateFreshPrepared(
  value: QboPreparedWrite,
  expected: {
    operation: 'recategorize' | 'restore';
    requestId: string;
    txn: DurableTransaction;
    before: QboPreparedSnapshot;
  },
): QboPreparedWrite {
  let prepared: QboPreparedWrite;
  try {
    prepared = persistedPrepared(value);
  } catch {
    lifecycleError('QBO_STATE_DRIFT', 'QuickBooks returned an invalid prepared write.');
  }
  if (
    prepared.operation !== expected.operation ||
    prepared.requestId !== expected.requestId ||
    prepared.qboType !== expected.txn.qboType ||
    prepared.qboId !== expected.txn.qboId ||
    prepared.body.SyncToken !== expected.before.syncToken ||
    !snapshotEquals(prepared.before, expected.before)
  ) {
    lifecycleError(
      'QBO_STATE_DRIFT',
      'QuickBooks prepared a write for a different request, entity, or before snapshot.',
    );
  }
  return prepared;
}

function validateDryRunBinding(
  attempt: DurableAttempt,
  txn: DurableTransaction,
): void {
  const expectedPayload = {
    operation: 'recategorize',
    qboType: txn.qboType,
    qboId: txn.qboId,
    requestId: attempt.requestId,
    references: {
      accountQboIds: uniqueStrings(txn.splitLines.map((line) => line.categoryQboId)),
      taxCodeQboIds: uniqueStrings(txn.splitLines.map((line) => line.taxCodeQboId)),
    },
    outcome: 'DRY_RUN',
  };
  if (
    attempt.status !== 'DRY_RUN' ||
    attempt.transactionId !== txn.id ||
    attempt.operation !== 'recategorize' ||
    attempt.expectedRevision !== txn.revision ||
    attempt.expectedSyncToken !== txn.qboSyncToken ||
    attempt.requestHash !== `dry-run:${attempt.requestId}` ||
    txn.status !== 'DRY_RUN' ||
    canonicalJson(attempt.requestPayload) !== canonicalJson(expectedPayload) ||
    canonicalJson(attempt.beforeSnapshot) !== canonicalJson({ outcome: 'DRY_RUN' }) ||
    attempt.responseSnapshot !== null ||
    canonicalJson(attempt.verification) !== canonicalJson({ outcome: 'DRY_RUN', status: 'DRY_RUN' }) ||
    attempt.errorCode !== null ||
    attempt.errorMessage !== null
  ) {
    lifecycleError(
      'ATTEMPT_CORRUPT',
      'Stored dry-run attempt is not bound to its transaction and summary.',
    );
  }
}

function validateRecordedAttemptBinding(
  attempt: DurableAttempt,
  txn: DurableTransaction,
): void {
  if (attempt.status === 'DRY_RUN') {
    validateDryRunBinding(attempt, txn);
    return;
  }
  validatePreparedBinding(attempt, txn);
}

export interface DurableAttemptPersistenceProof {
  operation: string;
  qboType: string;
  qboId: string;
  requestId: string;
  requestHash: string;
  expectedSyncToken: string;
  preparedBindingHash?: string;
  beforeSnapshotHash?: string;
}

export function validateDurableAttemptPersistence(
  attempt: DurableAttempt,
): DurableAttemptPersistenceProof {
  const prepared = validateAttemptPersistence(attempt);
  return {
    operation: prepared.operation,
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    requestId: prepared.requestId,
    requestHash: prepared.requestHash,
    expectedSyncToken: prepared.body.SyncToken,
    preparedBindingHash: hashPreparedWriteBinding(prepared),
    beforeSnapshotHash: hashPurchaseSnapshot(
      persistedSnapshot(attempt.beforeSnapshot, prepared.qboType),
    ),
  };
}

function mutationMetadata(
  prepared: Pick<QboPreparedWrite, 'requestId' | 'operation' | 'qboType' | 'qboId' | 'expected'>,
  outcome: MutationAuditInput['outcome'],
  mcp?: McpMutationAuditAttribution,
): MutationAuditInput {
  return {
    requestId: prepared.requestId,
    outcome,
    references: {
      operation: prepared.operation,
      qboType: prepared.qboType,
      qboId: prepared.qboId,
      accountQboIds: uniqueStrings(
        prepared.expected.targetLines.map((line) => line.accountQboId),
      ),
      taxCodeQboIds: uniqueStrings(
        prepared.expected.targetLines.map((line) => line.taxCodeQboId),
      ),
    },
    ...(mcp === undefined ? {} : { mcp }),
  };
}

function auditLabels(txn: DurableTransaction): {
  before: string;
  after: string;
} {
  return {
    before: `QuickBooks ${txn.qboType}`,
    after: txn.splitLines.map((line) => line.category).join(' / '),
  };
}

async function writeMutationAudit(
  d: DurableWritebackDeps,
  tx: DurableWritebackDb,
  txn: DurableTransaction,
  actor: Actor,
  action: AuditAction,
  mutation: MutationAuditInput,
): Promise<void> {
  const labels = auditLabels(txn);
  await d.audit(tx as unknown as Prisma.TransactionClient, {
    companyId: txn.companyId,
    actorId: actor.id,
    actorLabel: actor.label,
    txnId: txn.id,
    payee: txn.payee,
    amount: Number(txn.amount),
    action,
    before: labels.before,
    after: labels.after,
    mutation,
  });
}

function recordedAttemptResult(
  attempt: DurableAttempt,
  transactionStatus: string,
): DurableMutationResult {
  if (attempt.status === 'VERIFIED') {
    const status = attempt.operation === 'restore' ? 'REVERTED' : 'POSTED';
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status,
      outcome: 'VERIFIED',
    };
  }
  if (attempt.status === 'DRY_RUN') {
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status: 'DRY_RUN',
      outcome: 'DRY_RUN',
    };
  }
  if (attempt.status === 'UNCHANGED') {
    const status = attempt.operation === 'restore' ? 'POSTED' : 'PENDING';
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: true,
      status,
      outcome: 'UNCHANGED',
    };
  }
  if (attempt.status === 'RETRYABLE') {
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: false,
      status: transactionStatus as TxnStatus,
      outcome: 'RETRYABLE',
      error: { code: 'RETRYABLE', message: 'The prepared write was not sent. Create a new request to retry.' },
    };
  }
  if (attempt.status === 'FAILED') {
    lifecycleError(
      'LIVE_MUTATION_RETRY_EXHAUSTED',
      LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
    );
  }
  if (attempt.status === 'UNCERTAIN') {
    const mismatch = attempt.errorCode === 'QBO_READBACK_MISMATCH';
    return {
      transactionId: attempt.transactionId,
      requestId: attempt.requestId,
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: mismatch ? 'QBO_READBACK_MISMATCH' : 'QBO_WRITE_UNCERTAIN',
        message: mismatch
          ? 'QuickBooks readback did not match the prepared intent or original snapshot.'
          : POSSIBLE_WRITE_GUIDANCE,
      },
    };
  }
  return {
    transactionId: attempt.transactionId,
    requestId: attempt.requestId,
    ok: false,
    status: transactionStatus as TxnStatus,
    outcome: 'IN_PROGRESS',
    error: {
      code: 'MUTATION_IN_PROGRESS',
      message: 'This prepared write is already in progress and will not be sent again.',
    },
  };
}

async function emitVerifiedCategorizationOutcome(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  verifiedStatus?: 'POSTED' | 'REVERTED',
): Promise<void> {
  if (attempt.status !== 'VERIFIED' || d.onVerifiedCategorizationOutcome === undefined) return;
  const operation = attempt.operation === 'restore' ? 'reverted' : 'posted';
  const effectiveStatus = verifiedStatus ?? txn.status;
  if (
    txn.revision !== attempt.expectedRevision
    || (operation === 'posted' && effectiveStatus !== 'POSTED')
    || (operation === 'reverted' && effectiveStatus !== 'REVERTED')
  ) {
    return;
  }
  const proposal = operation === 'posted'
    ? persistedEvidenceProposal(attempt.requestPayload)
    : null;
  const candidateContext = operation === 'posted'
    ? persistedRuleCandidateContext(attempt.requestPayload)
    : null;
  // Legacy or corrupt recategorization attempts cannot prove the exact staged
  // proposal, so they are deliberately excluded instead of guessed from QBO.
  if (operation === 'posted' && (proposal === null || candidateContext === null)) return;
  try {
    await d.onVerifiedCategorizationOutcome({
      companyId: txn.companyId,
      transactionId: txn.id,
      inputRevision: attempt.expectedRevision,
      requestId: attempt.requestId,
      operation,
      proposal,
      candidateContext,
    });
  } catch {
    // The QuickBooks readback and local VERIFIED state are already durable.
    // Evidence is advisory and can be retried by an idempotent VERIFIED replay.
  }
}

async function recordedAttemptResultWithOutcome(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
): Promise<DurableMutationResult> {
  validateRecordedAttemptBinding(attempt, txn);
  await emitVerifiedCategorizationOutcome(d, attempt, txn);
  return recordedAttemptResult(attempt, txn.status);
}

interface RequestIntent {
  transactionId: string;
  operation: 'recategorize' | 'restore';
  expectedRevision: number;
  requestHash?: string;
}

function assertRequestIdentity(attempt: DurableAttempt, intent: RequestIntent): void {
  if (
    attempt.transactionId !== intent.transactionId ||
    attempt.operation !== intent.operation ||
    attempt.expectedRevision !== intent.expectedRevision ||
    (intent.requestHash !== undefined && attempt.requestHash !== intent.requestHash)
  ) {
    lifecycleError('REQUEST_ID_CONFLICT', 'This request ID represents a different mutation.');
  }
  if (attempt.status !== 'DRY_RUN') {
    validateAttemptPersistence(attempt);
  }
}

async function findRequestOrConflict(
  d: DurableWritebackDeps,
  requestId: string,
  intent: RequestIntent,
): Promise<DurableAttempt | null> {
  const same = await d.db.qboMutationAttempt.findUnique({ where: { requestId } });
  if (same) {
    assertRequestIdentity(same, intent);
    return same;
  }
  const active = await d.db.qboMutationAttempt.findFirst({
    where: {
      transactionId: intent.transactionId,
      status: { in: ACTIVE_ATTEMPT_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (active) {
    lifecycleError(
      'MUTATION_BLOCKED',
      'A write for this QuickBooks entity is already active or needs reconciliation.',
    );
  }
  return null;
}

async function markRetryable(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  companyId: string,
  error: unknown,
  exhausted = false,
): Promise<
  | { won: true; attempt: DurableAttempt }
  | { won: false; attempt: DurableAttempt }
> {
  const info = errorInfo(error);
  try {
    const updated = await d.db.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      return tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'PREPARED' },
        data: {
          status: exhausted ? 'FAILED' : 'RETRYABLE',
          errorCode: exhausted ? 'LIVE_MUTATION_RETRY_EXHAUSTED' : info.code,
          errorMessage: exhausted
            ? LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE
            : info.message.slice(0, 500),
        },
      });
    });
    if (updated.count === 1) {
      return {
        won: true,
        attempt: {
          ...attempt,
          status: exhausted ? 'FAILED' : 'RETRYABLE',
          errorCode: exhausted ? 'LIVE_MUTATION_RETRY_EXHAUSTED' : info.code,
          errorMessage: exhausted
            ? LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE
            : info.message.slice(0, 500),
        },
      };
    }
  } catch {
    // PREPARED remains safely resumable if the best-effort transition fails.
  }
  try {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    return { won: false, attempt: latest ?? attempt };
  } catch {
    return { won: false, attempt };
  }
}

async function markUncertain(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  mismatch = false,
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  const attemptData = {
    status: 'UNCERTAIN',
    errorCode: mismatch ? 'QBO_READBACK_MISMATCH' : 'QBO_WRITE_UNCERTAIN',
    errorMessage: mismatch
      ? 'QuickBooks readback did not match the prepared intent or original snapshot.'
      : POSSIBLE_WRITE_GUIDANCE,
  };
  const transactionData = {
    status: 'ERROR',
    errorCode: attemptData.errorCode,
    errorMessage: attemptData.errorMessage,
  };
  const safeUncertainResult = (): DurableMutationResult =>
    recordedAttemptResult({ ...attempt, ...attemptData }, 'ERROR');
  let transitioned = false;
  try {
    await d.db.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, txn.companyId);
      await assertReconciliationAdminInTransaction(d, tx, actor, txn.companyId);
      await assertCurrentReconciliationState(tx, attempt, txn);
      throwIfReconciliationAborted(d.reconciliationSignal);
      const guarded = await tx.qboMutationAttempt.updateMany({
        where: {
          id: attempt.id,
          status: mismatch
            ? { in: ['COMMITTING', 'UNCERTAIN'] }
            : 'COMMITTING',
        },
        data: attemptData,
      });
      if (guarded.count !== 1) return;
      transitioned = true;
      await updateCurrentReconciliationTransaction(
        tx,
        attempt,
        txn,
        transactionData,
      );
      await d.onUncertainMutation?.(tx, {
        attempt,
        transaction: txn,
        errorCode: attemptData.errorCode as
          | 'QBO_WRITE_UNCERTAIN'
          | 'QBO_READBACK_MISMATCH',
      });
      await writeMutationAudit(
        d,
        tx,
        txn,
        actor,
        'error',
        mutationMetadata(prepared, 'UNCERTAIN', auditAttribution),
      );
    });
  } catch (error) {
    rethrowReconciliationFence(error);
    // The exact prepared request is already durable as COMMITTING, so it is
    // still a non-resend barrier. Retry the complete transition atomically and
    // always return safe uncertainty even if the database remains degraded.
    transitioned = false;
    try {
      const guarded = await d.db.$transaction(async (tx) => {
        await lockCompanyMutationScope(tx, txn.companyId);
        await assertReconciliationAdminInTransaction(d, tx, actor, txn.companyId);
        await assertCurrentReconciliationState(tx, attempt, txn);
        throwIfReconciliationAborted(d.reconciliationSignal);
        const updated = await tx.qboMutationAttempt.updateMany({
          where: {
            id: attempt.id,
            status: mismatch
              ? { in: ['COMMITTING', 'UNCERTAIN'] }
              : 'COMMITTING',
          },
          data: attemptData,
        });
        if (updated.count !== 1) return updated;
        await updateCurrentReconciliationTransaction(
          tx,
          attempt,
          txn,
          transactionData,
        );
        await d.onUncertainMutation?.(tx, {
          attempt,
          transaction: txn,
          errorCode: attemptData.errorCode as
            | 'QBO_WRITE_UNCERTAIN'
            | 'QBO_READBACK_MISMATCH',
        });
        await writeMutationAudit(
          d,
          tx,
          txn,
          actor,
          'error',
          mutationMetadata(prepared, 'UNCERTAIN', auditAttribution),
        );
        return updated;
      });
      if (guarded.count === 1) {
        transitioned = true;
      }
    } catch (error) {
      rethrowReconciliationFence(error);
      // The durable COMMITTING record remains a reconciliation-only barrier.
    }
  }
  if (transitioned) {
    return safeUncertainResult();
  }
  try {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (
      !latest ||
      (latest.status !== 'VERIFIED' &&
        latest.status !== 'UNCHANGED' &&
        latest.status !== 'UNCERTAIN')
    ) {
      return safeUncertainResult();
    }
    assertRequestIdentity(latest, {
      transactionId: attempt.transactionId,
      operation: prepared.operation,
      expectedRevision: attempt.expectedRevision,
      requestHash: attempt.requestHash,
    });
    return recordedAttemptResultWithOutcome(d, latest, txn);
  } catch {
    return safeUncertainResult();
  }
}

async function finalizeVerified(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  response: QboPreparedSnapshot,
  newSyncToken: string,
  status: 'POSTED' | 'REVERTED',
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, txn.companyId);
    await assertReconciliationAdminInTransaction(d, tx, actor, txn.companyId);
    await assertCurrentReconciliationState(tx, attempt, txn);
    throwIfReconciliationAborted(d.reconciliationSignal);
    const guarded = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['COMMITTING', 'UNCERTAIN'] } },
      data: {
        status: 'VERIFIED',
        responseSnapshot: response,
        verification: {
          outcome: 'VERIFIED',
          status,
          newSyncToken,
        },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (guarded.count !== 1) return;
    transitioned = true;
    await updateCurrentReconciliationTransaction(
      tx,
      attempt,
      txn,
      {
        status,
        qboSyncToken: newSyncToken,
        postedAt: status === 'POSTED' ? d.now() : txn.postedAt,
        postedByUserId: status === 'POSTED' ? actor.id : txn.postedByUserId,
        errorCode: null,
        errorMessage: null,
      },
    );
    await d.onReconciledMutation?.(tx, {
      attempt,
      transaction: txn,
      status: 'VERIFIED',
    });
    await writeMutationAudit(
      d,
      tx,
      txn,
      actor,
      status === 'POSTED' ? 'posted' : 'reverted',
      mutationMetadata(prepared, 'VERIFIED', auditAttribution),
    );
  });
  if (!transitioned) {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared during finalization.');
    await emitVerifiedCategorizationOutcome(d, latest, txn, status);
    return recordedAttemptResult(latest, txn.status);
  }
  await emitVerifiedCategorizationOutcome(
    d,
    { ...attempt, status: 'VERIFIED' },
    txn,
    status,
  );
  return {
    transactionId: txn.id,
    requestId: attempt.requestId,
    ok: true,
    status,
    outcome: 'VERIFIED',
  };
}

async function assertCurrentReconciliationState(
  tx: DurableWritebackDb,
  attempt: DurableAttempt,
  expected: DurableTransaction,
): Promise<void> {
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id"
       FROM "Transaction"
      WHERE "id" = $1
      FOR UPDATE`,
    expected.id,
  );
  if (locked.length !== 1) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
  const current = await tx.transaction.findUnique({
    where: { id: expected.id },
    include: {
      company: true,
      splitLines: {
        orderBy: { idx: 'asc' },
        include: { tags: true },
      },
      txnTags: true,
    },
  });
  if (
    current === null
    || current.companyId !== expected.companyId
    || current.qboType !== expected.qboType
    || current.qboId !== expected.qboId
    || current.qboSyncToken !== expected.qboSyncToken
    || current.revision !== attempt.expectedRevision
    || current.status !== expected.status
  ) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
}

async function updateCurrentReconciliationTransaction(
  tx: DurableWritebackDb,
  attempt: DurableAttempt,
  expected: DurableTransaction,
  data: Record<string, unknown>,
): Promise<void> {
  const updated = await tx.transaction.updateMany({
    where: {
      id: expected.id,
      companyId: expected.companyId,
      qboType: expected.qboType,
      qboId: expected.qboId,
      qboSyncToken: expected.qboSyncToken,
      revision: attempt.expectedRevision,
      status: expected.status,
    },
    data,
  });
  if (updated.count !== 1) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
}

function throwIfReconciliationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('QuickBooks reconciliation was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function rethrowReconciliationFence(error: unknown): void {
  if (
    (error instanceof Error && error.name === 'AbortError')
    || (
      error instanceof WritebackLifecycleError
      && (
        error.code === 'LIVE_RECONCILIATION_BINDING_MISMATCH'
        || error.code === 'FORBIDDEN'
      )
    )
  ) throw error;
}

async function assertReconciliationAdminInTransaction(
  d: DurableWritebackDeps,
  tx: DurableWritebackDb,
  actor: Actor,
  companyId: string,
): Promise<void> {
  if (d.authorizeReconciliationInTransaction === undefined) return;
  if (
    actor.id === null
    || !await d.authorizeReconciliationInTransaction(
      tx,
      actor.id,
      companyId,
    )
  ) {
    lifecycleError('FORBIDDEN', 'You do not have permission to reconcile this transaction.');
  }
}

async function persistPrepared(
  d: DurableWritebackDeps,
  companyId: string,
  transactionId: string,
  expectedRevision: number,
  prepared: QboPreparedWrite,
  beforeSnapshot: QboPreparedSnapshot,
  staged?: StagedCategorization,
  candidateInput?: {
    payee: string;
    source: 'user' | 'autopilot' | 'mcp';
  },
): Promise<{ attempt: DurableAttempt; created: boolean }> {
  try {
    const attempt = await d.db.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      const config = candidateInput === undefined
        ? null
        : await tx.agentCompanyConfig.findUnique({
            where: { companyId },
            select: { configVersion: true },
          });
      const candidateContext = candidateInput === undefined
        ? null
        : candidateContextFor(
            candidateInput.payee,
            config?.configVersion ?? 'verified-writeback-v1',
            candidateInput.source,
          );
      return tx.qboMutationAttempt.create({
        data: {
          transactionId,
          requestId: prepared.requestId,
          operation: prepared.operation,
          status: 'PREPARED',
          expectedRevision,
          expectedSyncToken: prepared.body.SyncToken,
          requestHash: prepared.requestHash,
          requestPayload: {
            ...prepared,
            ruleCandidateFold: { version: 1 },
            ...(staged === undefined
              ? {}
              : {
                categorizationEvidence: {
                  version: 1,
                  proposal: evidenceProposal(staged),
                },
                ...(candidateContext === null
                  ? {}
                  : {
                      ruleCandidateEvidence: {
                        version: 1,
                        ...candidateContext,
                      },
                    }),
                }),
          },
          beforeSnapshot,
          responseSnapshot: null,
          verification: null,
          errorCode: null,
          errorMessage: null,
        },
      });
    });
    return { attempt, created: true };
  } catch (error) {
    if (
      !isRuntimeRecord(error) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }
    const raced = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: prepared.requestId },
    });
    if (!raced) {
      const active = await d.db.qboMutationAttempt.findFirst({
        where: {
          transactionId,
          status: { in: ACTIVE_ATTEMPT_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (active) {
        lifecycleError(
          'MUTATION_BLOCKED',
          'A different write for this QuickBooks entity won the persistence race.',
        );
      }
      lifecycleError('REQUEST_ID_CONFLICT', 'Concurrent request identity could not be resolved.');
    }
    assertRequestIdentity(raced, {
      transactionId,
      operation: prepared.operation,
      expectedRevision,
      requestHash: prepared.requestHash,
    });
    return { attempt: raced, created: false };
  }
}

async function preliminaryTransaction(
  d: DurableWritebackDeps,
  transactionId: string,
): Promise<DurableTransaction> {
  const txn = await d.db.transaction.findUnique({
    where: { id: transactionId },
    include: {
      company: true,
      splitLines: {
        orderBy: { idx: 'asc' },
        include: { tags: true },
      },
      txnTags: true,
    },
  });
  if (!txn) lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found.');
  return txn;
}

function leaseKey(txn: DurableTransaction): EntityLeaseKey {
  return {
    companyId: txn.companyId,
    qboType: txn.qboType,
    qboId: txn.qboId,
  };
}

function allowedStatusesForAttempt(attempt: DurableAttempt): string[] {
  if (attempt.status === 'VERIFIED') {
    return [attempt.operation === 'restore' ? 'REVERTED' : 'POSTED'];
  }
  if (attempt.status === 'DRY_RUN') return ['DRY_RUN'];
  if (attempt.status === 'UNCHANGED') {
    return [attempt.operation === 'restore' ? 'POSTED' : 'PENDING'];
  }
  if (attempt.status === 'PREPARED' || attempt.status === 'RETRYABLE') {
    return [attempt.operation === 'restore' ? 'POSTED' : 'PENDING'];
  }
  return attempt.operation === 'restore'
    ? ['POSTED', 'ERROR', 'SUPERSEDED']
    : ['PENDING', 'POSTING', 'ERROR', 'SUPERSEDED'];
}

async function loadAuthorizedAttempt(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  companyId: string,
  actorId: string | null,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
  expectedTaxDisposition: TaxDisposition = 'set',
): Promise<{ txn: DurableTransaction }> {
  if (expectedStageHash === undefined) {
    const txn = await loadAuthorizedTransactionState(
      attempt.transactionId,
      companyId,
      attempt.expectedRevision,
      actorId,
      d,
      allowedStatusesForAttempt(attempt),
      authorization,
      expectedQboBinding,
    );
    return { txn };
  }
  return loadAuthorizedStage(
    attempt.transactionId,
    companyId,
    attempt.expectedRevision,
    actorId,
    d,
    allowedStatusesForAttempt(attempt),
    authorization,
    expectedStageHash,
    expectedQboBinding,
    expectedTaxDisposition,
  );
}

async function loadAuthorizedRecordedAttempt(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  companyId: string,
  actorId: string | null,
  authorization: DurableMutationAuthorization = { kind: 'user' },
): Promise<DurableTransaction> {
  const [txn, authorized] = await Promise.all([
    preliminaryTransaction(d, attempt.transactionId),
    d.authorize(actorId, companyId, authorization),
  ]);
  if (!authorized) {
    lifecycleError('FORBIDDEN', 'You do not have permission to write this transaction.');
  }
  if (txn.companyId !== companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return txn;
}

async function enterCommitting(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  owner: string,
  allowedStatuses: string[],
  authorization: DurableMutationAuthorization = { kind: 'user' },
  expectedStageHash?: string,
  expectedQboBinding?: ExpectedQboBinding,
  finalQboProof?: (currentTxn: DurableTransaction) => Promise<void>,
  liveAuthority?: {
    readonly context: LiveMutationContext;
    readonly proof: LiveMutationProof;
    readonly input: AutopilotWritebackAuthorityInput;
  },
  expectedTaxDisposition: TaxDisposition = 'set',
): Promise<
  | { won: true; attempt: DurableAttempt }
  | { won: false; attempt: DurableAttempt }
> {
  const exhausted = (liveAuthority?.context.attemptCount ?? 0) >= 3;
  try {
    // Reacquisition may block behind a fenced staging transaction. Reload
    // every mutable authorization fact only after it returns so a stage that
    // committed while we waited cannot authorize this prepared revision.
    await d.renewLease(leaseKey(txn), owner);
    const { txn: currentTxn } = await loadAuthorizedAttempt(
      d,
      attempt,
      txn.companyId,
      actor.id,
      authorization,
      expectedStageHash,
      expectedQboBinding,
      expectedTaxDisposition,
    );
    validatePreparedBinding(attempt, currentTxn);
    if (finalQboProof) await finalQboProof(currentTxn);
  } catch (error) {
    const retryable = await markRetryable(
      d,
      attempt,
      txn.companyId,
      error,
      exhausted,
    );
    if (retryable.attempt.status === 'FAILED') {
      lifecycleError(
        'LIVE_MUTATION_RETRY_EXHAUSTED',
        LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
      );
    }
    if (!retryable.won && retryable.attempt.status !== 'PREPARED') {
      return { won: false, attempt: retryable.attempt };
    }
    throw error;
  }
  try {
    const transition = async (tx: DurableWritebackDb): Promise<{ count: number }> => {
      await lockCompanyMutationScope(tx, txn.companyId);
      if (liveAuthority !== undefined) {
        await assertLiveCommitAuthority(
          tx as unknown as Prisma.TransactionClient,
          liveAuthority.context,
          liveAuthority.proof,
          liveAuthority.input,
        );
        await loadAuthorizedStage(
          txn.id,
          txn.companyId,
          attempt.expectedRevision,
          actor.id,
          { ...d, db: tx },
          allowedStatuses,
          authorization,
          expectedStageHash,
          expectedQboBinding,
        );
      }
      return tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'PREPARED' },
        data: { status: 'COMMITTING' },
      });
    };
    const guarded = await d.db.$transaction(transition);
    if (guarded.count === 1) {
      return { won: true, attempt: { ...attempt, status: 'COMMITTING' } };
    }
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared before committing.');
    return { won: false, attempt: latest };
  } catch (error) {
    if (
      liveAuthority !== undefined
      && typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'LIVE_DAILY_LIMIT_REACHED'
    ) {
      await d.db.$transaction(async (tx) => {
        await lockCompanyMutationScope(tx, txn.companyId);
        await tx.qboMutationAttempt.updateMany({
          where: { id: attempt.id, status: 'PREPARED' },
          data: {
            status: 'FAILED',
            errorCode: 'LIVE_DAILY_LIMIT_REACHED',
            errorMessage: 'Daily live-write limit reached.',
          },
        });
      });
      throw error;
    }
    if (
      liveAuthority !== undefined
      && typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'LIVE_AUTHORITY_DENIED'
    ) {
      const retryable = await markRetryable(
        d,
        attempt,
        txn.companyId,
        error,
        exhausted,
      );
      if (retryable.attempt.status === 'FAILED') {
        lifecycleError(
          'LIVE_MUTATION_RETRY_EXHAUSTED',
          LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
        );
      }
      throw error;
    }
    const persistenceError = new WritebackLifecycleError(
      'PREWRITE_PERSISTENCE_FAILED',
      'The prepared write was not sent because its committing state could not be stored.',
    );
    const retryable = await markRetryable(
      d,
      attempt,
      txn.companyId,
      persistenceError,
      exhausted,
    );
    if (retryable.attempt.status === 'FAILED') {
      lifecycleError(
        'LIVE_MUTATION_RETRY_EXHAUSTED',
        LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
      );
    }
    if (!retryable.won && retryable.attempt.status !== 'PREPARED') {
      return { won: false, attempt: retryable.attempt };
    }
    throw persistenceError;
  }
}

function preparedWriteSafetyTarget(
  prepared: QboPreparedWrite,
): QboWriteSafetyTarget {
  const txnDate = prepared.before.date;
  const bankAccountQboId = prepared.qboType === 'Purchase'
    ? prepared.before.accountQboId
    : prepared.before.depositToAccountQboId;
  if (!bankAccountQboId) {
    throw new QboWriteSafetyError(
      'QBO_WRITE_SAFETY_UNAVAILABLE',
      'QuickBooks payment-account identity is unavailable for the final safety check.',
    );
  }
  return {
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    txnDate,
    bankAccountQboId,
  };
}

async function assertPreparedWriteSafety(
  client: QboClient,
  prepared: QboPreparedWrite,
): Promise<void> {
  const target = preparedWriteSafetyTarget(prepared);
  const evidence = await client.fetchWriteSafety(target);
  assertQboWriteAllowed(target, evidence);
}

function txnWriteSafetyTarget(txn: QboTxn): QboWriteSafetyTarget | null {
  if (txn.qboType === 'JournalEntry') return null;
  const raw = txn.raw;
  const accountRef = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>)[txn.qboType === 'Purchase' ? 'AccountRef' : 'DepositToAccountRef']
    : undefined;
  const bankAccountQboId = accountRef && typeof accountRef === 'object'
    ? (accountRef as Record<string, unknown>).value
    : undefined;
  if (typeof bankAccountQboId !== 'string' || bankAccountQboId.length === 0) {
    throw new QboWriteSafetyError(
      'QBO_WRITE_SAFETY_UNAVAILABLE',
      'QuickBooks payment-account identity is unavailable for the safety check.',
    );
  }
  return {
    qboType: txn.qboType,
    qboId: txn.qboId,
    txnDate: txn.date,
    bankAccountQboId,
  };
}

async function assertTxnWriteSafety(client: QboClient, txn: QboTxn): Promise<void> {
  const target = txnWriteSafetyTarget(txn);
  if (!target) return;
  const evidence = await client.fetchWriteSafety(target);
  assertQboWriteAllowed(target, evidence);
}

async function assertSnapshotWriteSafety(
  client: QboClient,
  qboType: 'Purchase' | 'Deposit',
  qboId: string,
  snapshot: QboPurchaseSnapshot | QboDepositSnapshot,
): Promise<void> {
  const bankAccountQboId = qboType === 'Purchase'
    ? (snapshot as QboPurchaseSnapshot).accountQboId
    : (snapshot as QboDepositSnapshot).depositToAccountQboId;
  if (!bankAccountQboId) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  const target: QboWriteSafetyTarget = {
    qboType,
    qboId,
    txnDate: snapshot.date,
    bankAccountQboId,
  };
  const evidence = await client.fetchWriteSafety(target);
  assertQboWriteAllowed(target, evidence);
}

async function sendAndVerifyPrepared(
  d: DurableWritebackDeps,
  client: QboClient,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  status: 'POSTED' | 'REVERTED',
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  // Possible-write boundary: COMMITTING is durable before this function runs.
  try {
    await client.sendPreparedWrite(prepared);
    const response = await client.fetchPreparedSnapshot(
      prepared.qboType,
      txn.qboId,
    );
    if (!response) {
      throw new Error(`Prepared ${prepared.qboType} readback was missing.`);
    }
    const verification = verifyPreparedResult(prepared, response);
    if (!verification.ok) throw new Error(verification.message);
    return await finalizeVerified(
      d,
      attempt,
      txn,
      actor,
      prepared,
      response,
      response.syncToken,
      status,
      auditAttribution,
    );
  } catch {
    // A failed readback cannot prove whether QBO accepted the exact body.
    // Do not compound that uncertainty with an automatic restore write.
    return markUncertain(
      d,
      attempt,
      txn,
      actor,
      prepared,
      false,
      auditAttribution,
    );
  }
}

async function recordDryRun(
  input: CommitStagedCategorizationInput,
  txn: DurableTransaction,
  staged: StagedCategorization,
  d: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const accountQboIds = uniqueStrings(staged.lines.map((line) => line.categoryQboId));
  const taxCodeQboIds = uniqueStrings(staged.lines.map((line) => line.taxCodeQboId));
  const requestPayload = {
    operation: 'recategorize',
    qboType: txn.qboType,
    qboId: txn.qboId,
    requestId: input.requestId,
    references: { accountQboIds, taxCodeQboIds },
    outcome: 'DRY_RUN',
  };
  const mutation: MutationAuditInput = {
    requestId: input.requestId,
    outcome: 'DRY_RUN',
    references: {
      operation: 'recategorize',
      qboType: txn.qboType,
      qboId: txn.qboId,
      accountQboIds,
      taxCodeQboIds,
    },
  };
  await d.db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, txn.companyId);
    await tx.qboMutationAttempt.create({
      data: {
        transactionId: txn.id,
        requestId: input.requestId,
        operation: 'recategorize',
        status: 'DRY_RUN',
        expectedRevision: input.expectedRevision,
        expectedSyncToken: txn.qboSyncToken,
        requestHash: `dry-run:${input.requestId}`,
        requestPayload,
        beforeSnapshot: { outcome: 'DRY_RUN' },
        responseSnapshot: null,
        verification: { outcome: 'DRY_RUN', status: 'DRY_RUN' },
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.transaction.update({
      where: { id: txn.id },
      data: {
        status: 'DRY_RUN',
        postedAt: d.now(),
        postedByUserId: input.actor.id,
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeMutationAudit(d, tx, txn, input.actor, 'dry-run', mutation);
  });
  return {
    transactionId: txn.id,
    requestId: input.requestId,
    ok: true,
    status: 'DRY_RUN',
    outcome: 'DRY_RUN',
  };
}

export async function commitStagedCategorization(
  input: CommitStagedCategorizationInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  return commitStagedCategorizationInternal(input, deps);
}

/**
 * The only null-actor write entry point. It accepts no caller-supplied
 * authorization function: exact authority is hard-wired to persisted
 * job/config/lease/reference state and fenced with PREPARED→COMMITTING.
 */
export async function commitGuardedLiveCategorization(
  input: Omit<CommitStagedCategorizationInput, 'actor'>,
  context: LiveMutationContext,
  proof: LiveMutationProof,
): Promise<DurableMutationResult> {
  return commitStagedCategorizationInternal(
    { ...input, actor: AUTOPILOT_ACTOR },
    await defaultDurableDeps(),
    { context, proof },
  );
}

async function commitStagedCategorizationInternal(
  input: CommitStagedCategorizationInput,
  deps?: DurableWritebackDeps,
  autopilot?: {
    readonly context: LiveMutationContext;
    readonly proof: LiveMutationProof;
  },
): Promise<DurableMutationResult> {
  const base = deps ?? (await defaultDurableDeps());
  let d = base;
  const authorityInput: AutopilotWritebackAuthorityInput | undefined = autopilot === undefined
    ? undefined
    : {
        companyId: input.companyId,
        transactionId: input.transactionId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        owner: autopilot.context.owner,
      };
  if (autopilot !== undefined) {
    if (
      typeof autopilot.context.owner !== 'string'
      || autopilot.context.owner.trim() === ''
      || input.actor !== AUTOPILOT_ACTOR
    ) {
      lifecycleError('LIVE_AUTHORITY_DENIED', 'Guarded live authority is unavailable.');
    }
    d = {
      ...base,
      invocationId: () => autopilot.context.owner,
      authorize: async (actorId, companyId) => {
        if (
          actorId !== null
          || companyId !== input.companyId
        ) {
          lifecycleError('LIVE_AUTHORITY_DENIED', 'Guarded live authority is unavailable.');
        }
        return true;
      },
      onUncertainMutation: async (tx, outcome) => {
        await pauseLiveCompanyInTransaction(
          tx as unknown as Prisma.TransactionClient,
          outcome.transaction.companyId,
          outcome.errorCode === 'QBO_READBACK_MISMATCH'
            ? 'READBACK_MISMATCH'
            : 'UNCERTAIN_MUTATION',
          outcome.errorCode === 'QBO_READBACK_MISMATCH'
            ? 'Live mode is paused: A live mutation readback did not match durable intent.'
            : 'Live mode is paused: A live mutation requires reconciliation.',
          base.now(),
        );
      },
    };
  }
  const authorization = input.authorization ?? { kind: 'user' };
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const intent: RequestIntent = {
      transactionId: input.transactionId,
      operation: 'recategorize',
      expectedRevision: input.expectedRevision,
    };
    let existing = await findRequestOrConflict(d, input.requestId, intent);
    if (
      existing?.status === 'RETRYABLE'
      && autopilot !== undefined
      && authorityInput !== undefined
    ) {
      if (autopilot.context.attemptCount >= 3) {
        await d.db.$transaction(async (tx) => {
          await lockCompanyMutationScope(tx, input.companyId);
          const exhausted = await tx.qboMutationAttempt.updateMany({
            where: { id: existing!.id, status: 'RETRYABLE' },
            data: {
              status: 'FAILED',
              errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
              errorMessage: LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
            },
          });
          if (exhausted.count !== 1) {
            lifecycleError('LIVE_AUTHORITY_DENIED', 'Guarded live retry authority was lost.');
          }
        });
        lifecycleError(
          'LIVE_MUTATION_RETRY_EXHAUSTED',
          LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
        );
      }
      existing = await d.db.$transaction(async (tx) => {
        await assertLiveRetryAuthority(
          tx as unknown as Prisma.TransactionClient,
          autopilot.context,
          autopilot.proof,
          authorityInput,
        );
        const rearmed = await tx.qboMutationAttempt.updateMany({
          where: { id: existing!.id, status: 'RETRYABLE' },
          data: {
            status: 'PREPARED',
            errorCode: null,
            errorMessage: null,
          },
        });
        if (rearmed.count !== 1) {
          lifecycleError('LIVE_AUTHORITY_DENIED', 'Guarded live retry authority was lost.');
        }
        return { ...existing!, status: 'PREPARED', errorCode: null, errorMessage: null };
      });
    }
    if (existing) {
      if (existing.status !== 'PREPARED') {
        const txn = await loadAuthorizedRecordedAttempt(
          d,
          existing,
          input.companyId,
          input.actor.id,
          authorization,
        );
        return recordedAttemptResultWithOutcome(d, existing, txn);
      }
      let txn: DurableTransaction;
      let client: QboClient;
      try {
        ({ txn } = await loadAuthorizedAttempt(
          d,
          existing,
          input.companyId,
          input.actor.id,
          authorization,
          input.expectedStageHash,
          input.expectedQboBinding,
          input.expectedTaxDisposition,
        ));
        client = await d.getClient(input.companyId);
      } catch (error) {
        const retryable = await markRetryable(
          d,
          existing,
          input.companyId,
          error,
          (autopilot?.context.attemptCount ?? 0) >= 3,
        );
        if (retryable.attempt.status === 'FAILED') {
          lifecycleError(
            'LIVE_MUTATION_RETRY_EXHAUSTED',
            LIVE_MUTATION_RETRY_EXHAUSTED_MESSAGE,
          );
        }
        throw error;
      }
      const prepared = validatePreparedBinding(existing, txn);
      const before = persistedSnapshot(existing.beforeSnapshot, prepared.qboType);
      const entered = await enterCommitting(
        d,
        existing,
        txn,
        input.actor,
        invocationOwner,
        ['PENDING'],
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
        async (currentTxn) => {
          const [freshTxn, current] = await Promise.all([
            client.fetchTxn(prepared.qboType, currentTxn.qboId),
            client.fetchPreparedSnapshot(prepared.qboType, currentTxn.qboId),
          ]);
          if (
            !freshTxn ||
            !current ||
            freshTxn.syncToken !== existing.expectedSyncToken ||
            current.syncToken !== existing.expectedSyncToken ||
            currentTxn.qboSyncToken !== existing.expectedSyncToken ||
            !snapshotEquals(current, before)
          ) {
            lifecycleError(
              'QBO_STATE_DRIFT',
              `${prepared.qboType} changed before the prepared write could resume.`,
            );
          }
          await assertPreparedWriteSafety(client, prepared);
        },
        autopilot === undefined
          ? undefined
          : {
              context: autopilot.context,
              proof: autopilot.proof,
              input: authorityInput!,
            },
        input.expectedTaxDisposition,
      );
      if (!entered.won) {
        const { txn: latestTxn } = await loadAuthorizedAttempt(
          d,
          entered.attempt,
          input.companyId,
          input.actor.id,
          authorization,
          input.expectedStageHash,
          input.expectedQboBinding,
          input.expectedTaxDisposition,
        );
        return recordedAttemptResultWithOutcome(d, entered.attempt, latestTxn);
      }
      return sendAndVerifyPrepared(
        d,
        client,
        existing,
        txn,
        input.actor,
        prepared,
        'POSTED',
      );
    }

    const { txn, staged } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['PENDING'],
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
      input.expectedTaxDisposition,
    );
    if (txn.company.dryRun || d.envDryRun) {
      return recordDryRun(input, txn, staged, d);
    }

    await d.renewLease(leaseKey(txn), invocationOwner);
    const client = await d.getClient(input.companyId);
    const qboType = txn.qboType as 'Purchase' | 'Deposit';
    const [freshTxn, before] = await Promise.all([
      client.fetchTxn(qboType, txn.qboId),
      client.fetchPreparedSnapshot(qboType, txn.qboId),
    ]);
    if (!freshTxn || !before) {
      lifecycleError('QBO_STATE_DRIFT', `${qboType} no longer exists in QuickBooks.`);
    }
    if (
      freshTxn.syncToken !== before.syncToken ||
      freshTxn.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError(
        'QBO_STATE_DRIFT',
        `${qboType} SyncToken changed before preparation.`,
      );
    }

    await assertSnapshotWriteSafety(client, qboType, txn.qboId, before);

    const prepared = validateFreshPrepared(
      await client.prepareRecategorization(
        freshTxn,
        staged,
        before,
        input.requestId,
      ),
      {
        operation: 'recategorize',
        requestId: input.requestId,
        txn,
        before,
      },
    );
    const persisted = await persistPrepared(
      d,
      txn.companyId,
      txn.id,
      input.expectedRevision,
      prepared,
      before,
      staged,
      {
        payee: freshTxn.payee,
        source: autopilot === undefined ? 'user' : 'autopilot',
      },
    );
    if (!persisted.created) {
      const { txn: racedTxn } = await loadAuthorizedAttempt(
        d,
        persisted.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
        input.expectedTaxDisposition,
      );
      return recordedAttemptResultWithOutcome(d, persisted.attempt, racedTxn);
    }
    const entered = await enterCommitting(
      d,
      persisted.attempt,
      txn,
      input.actor,
      invocationOwner,
      ['PENDING'],
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
      async (currentTxn) => {
        if (autopilot !== undefined) {
            const [finalTxn, finalSnapshot] = await Promise.all([
              client.fetchTxn(prepared.qboType, currentTxn.qboId),
              client.fetchPreparedSnapshot(prepared.qboType, currentTxn.qboId),
            ]);
            if (
              !finalTxn
              || !finalSnapshot
              || finalTxn.syncToken !== persisted.attempt.expectedSyncToken
              || finalSnapshot.syncToken !== persisted.attempt.expectedSyncToken
              || currentTxn.qboSyncToken !== persisted.attempt.expectedSyncToken
              || !snapshotEquals(finalSnapshot, before)
            ) {
              lifecycleError(
                'QBO_STATE_DRIFT',
                `${prepared.qboType} changed immediately before the guarded live write.`,
              );
            }
            await d.renewLease(leaseKey(currentTxn), invocationOwner);
            await loadAuthorizedStage(
              currentTxn.id,
              currentTxn.companyId,
              persisted.attempt.expectedRevision,
              input.actor.id,
              d,
              ['PENDING'],
              authorization,
              input.expectedStageHash,
              input.expectedQboBinding,
              input.expectedTaxDisposition,
            );
        }
        await assertPreparedWriteSafety(client, prepared);
      },
      autopilot === undefined
        ? undefined
        : {
            context: autopilot.context,
            proof: autopilot.proof,
            input: authorityInput!,
          },
      input.expectedTaxDisposition,
    );
    if (!entered.won) {
      const { txn: latestTxn } = await loadAuthorizedAttempt(
        d,
        entered.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
        input.expectedTaxDisposition,
      );
      return recordedAttemptResultWithOutcome(d, entered.attempt, latestTxn);
    }
    return sendAndVerifyPrepared(
      d,
      client,
      persisted.attempt,
      txn,
      input.actor,
      prepared,
      'POSTED',
    );
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function hashPreparedWriteBody(body: QboPreparedWrite['body']): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function hashPreparedWriteBinding(prepared: QboPreparedWrite): string {
  const { requestId: _throwawayRequestId, ...binding } = prepared;
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

function hashPurchaseSnapshot(snapshot: QboPreparedSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export function hashStagedCategorization(staged: StagedCategorization): string {
  const normalized: StagedCategorization = {
    ...staged,
    taxDisposition: staged.taxDisposition ?? 'set',
    lines: [...staged.lines]
      .sort((left, right) => left.idx - right.idx)
      .map((line) => ({
        ...line,
        ...(line.tagIds === undefined
          ? {}
          : { tagIds: [...line.tagIds].sort() }),
      })),
    tagIds: [...staged.tagIds].sort(),
  };
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

function snapshotEquals(left: QboPreparedSnapshot, right: QboPreparedSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function finalizeUnchanged(
  d: DurableWritebackDeps,
  attempt: DurableAttempt,
  txn: DurableTransaction,
  actor: Actor,
  prepared: QboPreparedWrite,
  actual: QboPreparedSnapshot,
  auditAttribution?: McpMutationAuditAttribution,
): Promise<DurableMutationResult> {
  const unchangedStatus = prepared.operation === 'restore' ? 'POSTED' : 'PENDING';
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, txn.companyId);
    await assertReconciliationAdminInTransaction(d, tx, actor, txn.companyId);
    await assertCurrentReconciliationState(tx, attempt, txn);
    throwIfReconciliationAborted(d.reconciliationSignal);
    const guarded = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['COMMITTING', 'UNCERTAIN'] } },
      data: {
        status: 'UNCHANGED',
        responseSnapshot: actual,
        verification: { outcome: 'UNCHANGED', status: unchangedStatus },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (guarded.count !== 1) return;
    transitioned = true;
    await updateCurrentReconciliationTransaction(
      tx,
      attempt,
      txn,
      {
        status: unchangedStatus,
        errorCode: null,
        errorMessage: null,
      },
    );
    await d.onReconciledMutation?.(tx, {
      attempt,
      transaction: txn,
      status: 'UNCHANGED',
    });
    await writeMutationAudit(
      d,
      tx,
      txn,
      actor,
      'error',
      mutationMetadata(prepared, 'UNCHANGED', auditAttribution),
    );
  });
  if (!transitioned) {
    const latest = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: attempt.requestId },
    });
    if (!latest) lifecycleError('ATTEMPT_CORRUPT', 'Mutation attempt disappeared during reconciliation.');
    return recordedAttemptResultWithOutcome(d, latest, txn);
  }
  return {
    transactionId: txn.id,
    requestId: attempt.requestId,
    ok: true,
    status: unchangedStatus,
    outcome: 'UNCHANGED',
  };
}

export async function reconcileMutationAttempt(
  input: ReconcileMutationAttemptInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const d = deps ?? (await defaultDurableDeps());
  return reconcileMutationAttemptInternal(input, d);
}

/**
 * The only null-actor reconciliation path. It delegates the one fresh QBO read
 * to the canonical durable reconciler and atomically updates the owning live
 * run/job only after the exact persisted checkpoint remains bound.
 */
export async function reconcileGuardedLiveCategorization(
  input: GuardedLiveReconciliationInput,
  options: {
    readonly signal?: AbortSignal;
    readonly actor?: Actor;
    readonly authorizeInTransaction?: (
      db: Pick<DurableWritebackDb, '$queryRawUnsafe'>,
    ) => Promise<boolean>;
  } = {},
): Promise<DurableMutationResult> {
  const base = await defaultDurableDeps();
  const actor = options.actor ?? AUTOPILOT_ACTOR;
  const d: DurableWritebackDeps = {
    ...base,
    reconciliationSignal: options.signal,
    authorizeReconciliationInTransaction:
      options.authorizeInTransaction === undefined || actor.id === null
        ? undefined
        : async (tx, actorId, companyId) =>
            actorId === actor.id
            && companyId === input.companyId
            && await options.authorizeInTransaction!(tx),
    authorize: async (actorId, companyId) =>
      companyId === input.companyId
      && (
        actorId === null
          ? actor === AUTOPILOT_ACTOR
          : actorId === actor.id
            && authorizeLiveReconciliationAdmin(actorId, companyId)
      ),
    onUncertainMutation: async (tx, outcome) => {
      if (outcome.errorCode === 'QBO_READBACK_MISMATCH') {
        await finalizeGuardedLiveMismatch(tx, input, outcome);
      }
      await pauseLiveCompanyInTransaction(
        tx as unknown as Prisma.TransactionClient,
        outcome.transaction.companyId,
        outcome.errorCode === 'QBO_READBACK_MISMATCH'
          ? 'READBACK_MISMATCH'
          : 'UNCERTAIN_MUTATION',
        outcome.errorCode === 'QBO_READBACK_MISMATCH'
          ? 'Live mode is paused: A live mutation readback did not match durable intent.'
          : 'Live mode is paused: A live mutation requires reconciliation.',
        base.now(),
      );
    },
    onReconciledMutation: (tx, outcome) =>
      finalizeGuardedLiveReconciliation(tx, input, outcome),
  };
  return reconcileMutationAttemptInternal(
    { requestId: input.requestId, actor },
    d,
  );
}

async function authorizeLiveReconciliationAdmin(
  actorId: string,
  companyId: string,
): Promise<boolean> {
  const { prisma } = await import('../lib/prisma.js');
  const user = await prisma.user.findUnique({
    where: { id: actorId },
    select: { isInstanceAdmin: true },
  });
  if (user?.isInstanceAdmin === true) return true;
  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId: actorId, companyId } },
    select: { role: true },
  });
  return membership?.role === 'admin';
}

async function reconcileMutationAttemptInternal(
  input: ReconcileMutationAttemptInput,
  d: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const authorization = input.authorization ?? { kind: 'user' };
  const invocationOwner = d.invocationId();
  const preliminaryAttempt = await d.db.qboMutationAttempt.findUnique({
    where: { requestId: input.requestId },
  });
  if (!preliminaryAttempt) {
    lifecycleError('ATTEMPT_NOT_FOUND', 'Mutation attempt was not found.');
  }
  const preliminary = await preliminaryTransaction(d, preliminaryAttempt.transactionId);
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const attempt = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.requestId },
    });
    if (!attempt) lifecycleError('ATTEMPT_NOT_FOUND', 'Mutation attempt was not found.');
    if (attempt.status === 'DRY_RUN') {
      const { txn } = await loadAuthorizedAttempt(
        d,
        attempt,
        preliminary.companyId,
        input.actor.id,
        authorization,
        input.expectedStageHash,
        input.expectedQboBinding,
        input.expectedTaxDisposition,
      );
      return recordedAttemptResultWithOutcome(d, attempt, txn);
    }
    if (
      attempt.status !== 'VERIFIED' &&
      attempt.status !== 'UNCHANGED' &&
      attempt.status !== 'UNCERTAIN' &&
      attempt.status !== 'COMMITTING'
    ) {
      await loadAuthorizedAttempt(
        d,
        attempt,
        preliminary.companyId,
        input.actor.id,
        authorization,
      );
      lifecycleError('RECONCILE_NOT_ALLOWED', 'Only uncertain writes can be reconciled.');
    }
    const { txn } = await loadAuthorizedAttempt(
      d,
      attempt,
      preliminary.companyId,
      input.actor.id,
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
      input.expectedTaxDisposition,
    );
    const prepared = validatePreparedBinding(attempt, txn);
    if (attempt.status === 'VERIFIED' || attempt.status === 'UNCHANGED') {
      return recordedAttemptResultWithOutcome(d, attempt, txn);
    }
    const before = persistedSnapshot(attempt.beforeSnapshot, prepared.qboType);
    await d.renewLease(leaseKey(txn), invocationOwner);
    await loadAuthorizedAttempt(
      d,
      attempt,
      preliminary.companyId,
      input.actor.id,
      authorization,
      input.expectedStageHash,
      input.expectedQboBinding,
      input.expectedTaxDisposition,
    );
    const client = await d.getClient(txn.companyId);
    const actual = await client.fetchPreparedSnapshot(
      prepared.qboType,
      txn.qboId,
      d.reconciliationSignal,
    );
    throwIfReconciliationAborted(d.reconciliationSignal);
    if (!actual) {
      return markUncertain(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        true,
        input.auditAttribution,
      );
    }

    const expectedVerification = verifyPreparedResult(prepared, actual);
    if (expectedVerification.ok) {
      return finalizeVerified(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        actual,
        actual.syncToken,
        prepared.operation === 'restore' ? 'REVERTED' : 'POSTED',
        input.auditAttribution,
      );
    }
    if (snapshotEquals(actual, before)) {
      return finalizeUnchanged(
        d,
        attempt,
        txn,
        input.actor,
        prepared,
        actual,
        input.auditAttribution,
      );
    }
    return markUncertain(
      d,
      attempt,
      txn,
      input.actor,
      prepared,
      true,
      input.auditAttribution,
    );
  });
}

export async function prepareCategorizationUndo(
  input: PrepareCategorizationUndoInput,
  deps?: DurableWritebackDeps,
): Promise<PreparedCategorizationUndo> {
  const d = deps ?? (await defaultDurableDeps());
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const source = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.sourceRequestId },
    });
    if (
      source === null
      || source.transactionId !== input.transactionId
      || source.operation !== 'recategorize'
      || source.status !== 'VERIFIED'
      || source.expectedRevision !== input.expectedRevision
      || source.expectedSyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires the exact verified MCP categorization write.');
    }
    const sourcePrepared = validateAttemptPersistence(source);
    if (
      sourcePrepared.qboType !== 'Purchase'
      || sourcePrepared.qboType !== input.expectedQboBinding.qboType
      || sourcePrepared.qboId !== input.expectedQboBinding.qboId
      || sourcePrepared.body.SyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'The verified source write does not match this operation.');
    }
    const sourceTaxDisposition = sourcePrepared.expected.taxDisposition ?? 'set';
    let sourceStageHash: string | undefined;
    if (sourceTaxDisposition === 'preserve_current') {
      const target = sourcePrepared.expected.targetLines[0];
      if (
        sourcePrepared.expected.targetLines.length !== 1
        || target === undefined
        || target.accountQboId === null
        || target.taxCodeQboId === null
      ) {
        lifecycleError('ATTEMPT_CORRUPT', 'Verified preserved Purchase source is incomplete.');
      }
      const totalCents = target.amountCents;
      sourceStageHash = hashStagedCategorization({
        transactionId: input.transactionId,
        revision: input.expectedRevision,
        taxDisposition: 'preserve_current',
        taxCalculation: 'NotApplicable',
        totals: { subtotalCents: totalCents, taxCents: 0, totalCents },
        lines: [{
          idx: 0,
          subtotalCents: totalCents,
          taxCents: 0,
          totalCents,
          categoryQboId: target.accountQboId,
          taxCodeQboId: target.taxCodeQboId,
          memo: null,
          tagIds: [],
        }],
        tagIds: [],
      });
    }

    const { txn: initialTxn } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['POSTED'],
      input.authorization,
      sourceStageHash,
      undefined,
      sourceTaxDisposition,
    );
    if (
      initialTxn.qboType !== input.expectedQboBinding.qboType
      || initialTxn.qboId !== input.expectedQboBinding.qboId
    ) {
      lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
    }

    await d.renewLease(leaseKey(initialTxn), invocationOwner);
    const finalSource = await d.db.qboMutationAttempt.findUnique({
      where: { requestId: input.sourceRequestId },
    });
    if (
      finalSource === null
      || finalSource.transactionId !== input.transactionId
      || finalSource.operation !== 'recategorize'
      || finalSource.status !== 'VERIFIED'
      || finalSource.expectedRevision !== input.expectedRevision
      || finalSource.expectedSyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires the exact verified MCP categorization write.');
    }
    const finalSourcePrepared = validateAttemptPersistence(finalSource);
    if (
      hashPreparedWriteBinding(finalSourcePrepared)
        !== hashPreparedWriteBinding(sourcePrepared)
      || finalSourcePrepared.qboType !== input.expectedQboBinding.qboType
      || finalSourcePrepared.qboId !== input.expectedQboBinding.qboId
      || finalSourcePrepared.body.SyncToken !== input.expectedSourceSyncToken
    ) {
      lifecycleError('VERIFIED_POST_REQUIRED', 'The verified source write changed while preparing undo.');
    }
    const { txn } = await loadAuthorizedStage(
      input.transactionId,
      input.companyId,
      input.expectedRevision,
      input.actor.id,
      d,
      ['POSTED'],
      input.authorization,
      sourceStageHash,
      undefined,
      sourceTaxDisposition,
    );
    if (
      txn.qboType !== input.expectedQboBinding.qboType
      || txn.qboId !== input.expectedQboBinding.qboId
    ) {
      lifecycleError('STALE_QBO_BINDING', 'The QuickBooks transaction binding changed.');
    }
    const client = await d.getClient(input.companyId);
    const [freshTxn, current] = await Promise.all([
      client.fetchTxn('Purchase', txn.qboId),
      client.fetchPurchaseSnapshot(txn.qboId),
    ]);
    if (
      freshTxn === null
      || current === null
      || freshTxn.qboId !== txn.qboId
      || current.qboId !== txn.qboId
      || freshTxn.syncToken !== current.syncToken
      || current.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError('QBO_STATE_DRIFT', 'Purchase changed after the verified categorization.');
    }
    const currentVerification = verifyPreparedResult(sourcePrepared, current);
    if (!currentVerification.ok) {
      lifecycleError('QBO_STATE_DRIFT', currentVerification.message);
    }

    const restore = persistedPrepared(await client.preparePurchaseRestore(
      freshTxn,
      sourcePrepared,
      input.sourceRequestId,
    ));
    if (
      restore.operation !== 'restore'
      || restore.qboType !== 'Purchase'
      || restore.qboId !== txn.qboId
      || restore.body.SyncToken !== current.syncToken
      || restore.requestHash !== hashPreparedWriteBody(restore.body)
    ) {
      lifecycleError('ATTEMPT_CORRUPT', 'Prepared restore identity is inconsistent.');
    }
    const restoreHash = hashPreparedWriteBinding(restore);
    return {
      transactionId: txn.id,
      companyId: txn.companyId,
      revision: txn.revision,
      qboType: 'Purchase',
      qboId: txn.qboId,
      qboSyncToken: current.syncToken,
      sourcePreparedHash: hashPreparedWriteBinding(sourcePrepared),
      currentPostHash: hashPurchaseSnapshot(current),
      restoreHash,
      preview: {
        action: 'restore_purchase_categorization',
        resultingStatus: 'REVERTED',
        direction: restore.expected.direction,
        totalCents: restore.expected.totalCents,
        totalTaxCents: restore.expected.totalTaxCents,
        lineCount: restore.expected.targetLines.length,
        restorationDigest: restoreHash,
      },
    };
  });
}

async function finalizeGuardedLiveReconciliation(
  tx: DurableWritebackDb,
  input: GuardedLiveReconciliationInput,
  outcome: {
    attempt: DurableAttempt;
    transaction: DurableTransaction;
    status: 'VERIFIED' | 'UNCHANGED';
  },
): Promise<void> {
  if (
    outcome.attempt.requestId !== input.requestId
    || outcome.attempt.transactionId !== input.transactionId
    || outcome.attempt.operation !== input.operation
    || outcome.attempt.expectedRevision !== input.expectedRevision
    || outcome.attempt.requestHash !== input.requestHash
    || outcome.transaction.companyId !== input.companyId
    || outcome.transaction.qboType !== input.qboType
    || outcome.transaction.qboId !== input.qboId
  ) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
  const rows = await tx.$queryRawUnsafe<{
    runId: string;
    checkpoint: unknown;
    snapshotRevision: number;
    decisionModel: string;
    verifierModel: string;
  }[]>(
    `SELECT run."id" AS "runId",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel"
       FROM "AgentJob" job
       JOIN "QboMutationAttempt" attempt
         ON attempt."requestId" = job."id"
        AND attempt."transactionId" = job."transactionId"
       JOIN "AgentRun" run
         ON run."jobId" = job."id"
        AND run."companyId" = job."companyId"
        AND run."transactionId" = job."transactionId"
        AND run."revision" = job."revision"
        AND run."configVersion" = job."configVersion"
        AND run."status" = 'uncertain'
        AND run."errorCode" IN (
          'LIVE_RECONCILIATION_REQUIRED',
          'QBO_READBACK_MISMATCH'
        )
        AND run."verification" ? 'liveCheckpoint'
      WHERE job."id" = $1
        AND job."companyId" = $2
        AND job."transactionId" = $3
        AND job."configVersion" = $4
        AND job."revision" + 1 = $5
        AND job."status" = 'terminal'
        AND attempt."operation" = 'recategorize'
        AND attempt."expectedRevision" = $5
        AND attempt."requestHash" = $6
        AND attempt."status" IN ('VERIFIED', 'UNCHANGED')
        AND NOT EXISTS (
          SELECT 1
            FROM "QboMutationAttempt" newer
           WHERE newer."transactionId" = attempt."transactionId"
             AND newer."id" <> attempt."id"
             AND (
               newer."expectedRevision" > attempt."expectedRevision"
               OR (
                 newer."expectedRevision" = attempt."expectedRevision"
                 AND (
                   newer."createdAt" > attempt."createdAt"
                   OR (
                     newer."createdAt" = attempt."createdAt"
                     AND newer."id" > attempt."id"
                   )
                 )
               )
             )
        )
      ORDER BY run."attemptCount" DESC
      LIMIT 1
      FOR UPDATE OF job, run, attempt`,
    input.requestId,
    input.companyId,
    input.transactionId,
    input.configVersion,
    input.expectedRevision,
    input.requestHash,
  );
  const row = rows[0];
  if (
    row === undefined
    || !isCanonicalLiveCheckpoint(row.checkpoint, row)
    || createHash('sha256')
      .update(canonicalJson(row.checkpoint), 'utf8')
      .digest('hex') !== input.checkpointHash
  ) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
  const runStatus = outcome.status === 'VERIFIED' ? 'posted_verified' : 'unchanged';
  const liveOutcome = outcome.status === 'VERIFIED'
    ? 'reconciled_posted'
    : 'reconciled_unchanged';
  const run = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentRun"
        SET "status" = $1,
            "verification" = "verification" || jsonb_build_object(
              'liveOutcome', $2::text,
              'mutation', jsonb_build_object(
                'requestId', $3::text,
                'outcome', $4::text,
                'status', $5::text,
                'errorCode', NULL
              )
            ),
            "errorCode" = NULL
      WHERE "id" = $6
        AND "status" = 'uncertain'
        AND "errorCode" IN (
          'LIVE_RECONCILIATION_REQUIRED',
          'QBO_READBACK_MISMATCH'
        )
      RETURNING "id"`,
    runStatus,
    liveOutcome,
    input.requestId,
    outcome.status,
    outcome.status === 'VERIFIED' ? 'POSTED' : 'PENDING',
    row.runId,
  );
  const job = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentJob"
        SET "status" = 'completed',
            "lastErrorCode" = NULL,
            "updatedAt" = clock_timestamp()
      WHERE "id" = $1
        AND "companyId" = $2
        AND "transactionId" = $3
        AND "configVersion" = $4
        AND "status" = 'terminal'
      RETURNING "id"`,
    input.requestId,
    input.companyId,
    input.transactionId,
    input.configVersion,
  );
  if (run.length !== 1 || job.length !== 1) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
}

async function finalizeGuardedLiveMismatch(
  tx: DurableWritebackDb,
  input: GuardedLiveReconciliationInput,
  outcome: {
    attempt: DurableAttempt;
    transaction: DurableTransaction;
    errorCode: 'QBO_WRITE_UNCERTAIN' | 'QBO_READBACK_MISMATCH';
  },
): Promise<void> {
  if (
    outcome.errorCode !== 'QBO_READBACK_MISMATCH'
    || outcome.attempt.requestId !== input.requestId
    || outcome.attempt.transactionId !== input.transactionId
    || outcome.attempt.operation !== input.operation
    || outcome.attempt.expectedRevision !== input.expectedRevision
    || outcome.attempt.requestHash !== input.requestHash
    || outcome.transaction.companyId !== input.companyId
    || outcome.transaction.qboType !== input.qboType
    || outcome.transaction.qboId !== input.qboId
  ) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
  const rows = await tx.$queryRawUnsafe<{
    runId: string;
    checkpoint: unknown;
    snapshotRevision: number;
    decisionModel: string;
    verifierModel: string;
  }[]>(
    `SELECT run."id" AS "runId",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel"
       FROM "AgentJob" job
       JOIN "QboMutationAttempt" attempt
         ON attempt."requestId" = job."id"
        AND attempt."transactionId" = job."transactionId"
       JOIN "AgentRun" run
         ON run."jobId" = job."id"
        AND run."companyId" = job."companyId"
        AND run."transactionId" = job."transactionId"
        AND run."revision" = job."revision"
        AND run."configVersion" = job."configVersion"
        AND run."status" = 'uncertain'
        AND run."errorCode" IN (
          'LIVE_RECONCILIATION_REQUIRED',
          'QBO_READBACK_MISMATCH'
        )
        AND run."verification" ? 'liveCheckpoint'
      WHERE job."id" = $1
        AND job."companyId" = $2
        AND job."transactionId" = $3
        AND job."configVersion" = $4
        AND job."revision" + 1 = $5
        AND job."status" = 'terminal'
        AND attempt."operation" = 'recategorize'
        AND attempt."expectedRevision" = $5
        AND attempt."requestHash" = $6
        AND attempt."status" = 'UNCERTAIN'
        AND attempt."errorCode" = 'QBO_READBACK_MISMATCH'
        AND NOT EXISTS (
          SELECT 1
            FROM "QboMutationAttempt" newer
           WHERE newer."transactionId" = attempt."transactionId"
             AND newer."id" <> attempt."id"
             AND (
               newer."expectedRevision" > attempt."expectedRevision"
               OR (
                 newer."expectedRevision" = attempt."expectedRevision"
                 AND (
                   newer."createdAt" > attempt."createdAt"
                   OR (
                     newer."createdAt" = attempt."createdAt"
                     AND newer."id" > attempt."id"
                   )
                 )
               )
             )
        )
      ORDER BY run."attemptCount" DESC
      LIMIT 1
      FOR UPDATE OF job, run, attempt`,
    input.requestId,
    input.companyId,
    input.transactionId,
    input.configVersion,
    input.expectedRevision,
    input.requestHash,
  );
  const row = rows[0];
  if (
    row === undefined
    || !isCanonicalLiveCheckpoint(row.checkpoint, row)
    || createHash('sha256')
      .update(canonicalJson(row.checkpoint), 'utf8')
      .digest('hex') !== input.checkpointHash
  ) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
  const run = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentRun"
        SET "verification" = "verification" || jsonb_build_object(
              'liveOutcome', 'readback_mismatch',
              'mutation', jsonb_build_object(
                'requestId', $1::text,
                'outcome', 'UNCERTAIN',
                'status', 'ERROR',
                'errorCode', 'QBO_READBACK_MISMATCH'
              )
            ),
            "errorCode" = 'QBO_READBACK_MISMATCH'
      WHERE "id" = $2
        AND "status" = 'uncertain'
        AND "errorCode" IN (
          'LIVE_RECONCILIATION_REQUIRED',
          'QBO_READBACK_MISMATCH'
        )
      RETURNING "id"`,
    input.requestId,
    row.runId,
  );
  const job = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentJob"
        SET "lastErrorCode" = 'QBO_READBACK_MISMATCH',
            "updatedAt" = clock_timestamp()
      WHERE "id" = $1
        AND "companyId" = $2
        AND "transactionId" = $3
        AND "configVersion" = $4
        AND "status" = 'terminal'
      RETURNING "id"`,
    input.requestId,
    input.companyId,
    input.transactionId,
    input.configVersion,
  );
  if (run.length !== 1 || job.length !== 1) {
    lifecycleError(
      'LIVE_RECONCILIATION_BINDING_MISMATCH',
      'Live reconciliation binding is unavailable.',
    );
  }
}

export async function undoCategorization(
  input: UndoCategorizationInput,
  deps?: DurableWritebackDeps,
): Promise<DurableMutationResult> {
  const d = deps ?? (await defaultDurableDeps());
  const authorization = input.authorization ?? { kind: 'user' };
  if (authorization.kind === 'mcp' && input.proof === undefined) {
    lifecycleError('UNDO_PROOF_REQUIRED', 'MCP undo requires an exact preparation proof.');
  }
  const invocationOwner = d.invocationId();
  const preliminary = await preliminaryTransaction(d, input.transactionId);
  if (preliminary.companyId !== input.companyId) {
    lifecycleError('TRANSACTION_NOT_FOUND', 'Transaction was not found for this company.');
  }
  return d.lease(leaseKey(preliminary), invocationOwner, async () => {
    const loadVerifiedSource = async (): Promise<{
      attempt: DurableAttempt;
      prepared: QboPreparedWrite;
    }> => {
      const source = input.proof === undefined
        ? await d.db.qboMutationAttempt.findFirst({
            where: {
              transactionId: input.transactionId,
              operation: 'recategorize',
              status: 'VERIFIED',
            },
            orderBy: { createdAt: 'desc' },
          })
        : await d.db.qboMutationAttempt.findUnique({
            where: { requestId: input.proof.sourceRequestId },
          });
      if (
        source === null
        || source.transactionId !== input.transactionId
        || source.operation !== 'recategorize'
        || source.status !== 'VERIFIED'
      ) {
        lifecycleError('VERIFIED_POST_REQUIRED', 'Undo requires a verified prepared write.');
      }
      const prepared = validateAttemptPersistence(source);
      if (
        input.proof !== undefined
        && (
          source.requestId !== input.proof.sourceRequestId
          || source.expectedRevision !== input.proof.expectedRevision
          || prepared.qboType !== input.proof.expectedQboBinding.qboType
          || prepared.qboId !== input.proof.expectedQboBinding.qboId
          || hashPreparedWriteBinding(prepared) !== input.proof.sourcePreparedHash
        )
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source no longer matches the prepared undo.');
      }
      return { attempt: source, prepared };
    };
    const assertCurrentProof = (
      txn: DurableTransaction,
      current: QboPreparedSnapshot,
    ): void => {
      if (
        input.proof !== undefined
        && (
          txn.qboType !== input.proof.expectedQboBinding.qboType
          || txn.qboId !== input.proof.expectedQboBinding.qboId
          || txn.qboSyncToken !== input.proof.expectedQboBinding.qboSyncToken
          || current.syncToken !== input.proof.expectedQboBinding.qboSyncToken
          || hashPurchaseSnapshot(current) !== input.proof.currentPostHash
        )
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The current transaction no longer matches the prepared undo.');
      }
    };
    const assertRestoreProof = (restore: QboPreparedWrite): void => {
      if (
        input.proof !== undefined
        && hashPreparedWriteBinding(restore) !== input.proof.restoreHash
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The prepared restore no longer matches the prepared undo.');
      }
    };
    const persistedRestoreForProof = (
      attempt: DurableAttempt,
    ): QboPreparedWrite => {
      const restore = validateAttemptPersistence(attempt);
      assertRestoreProof(restore);
      if (
        input.proof !== undefined
        && hashPurchaseSnapshot(
          persistedSnapshot(attempt.beforeSnapshot, restore.qboType),
        )
          !== input.proof.currentPostHash
      ) {
        lifecycleError('UNDO_PROOF_MISMATCH', 'The stored current Purchase no longer matches the prepared undo.');
      }
      return restore;
    };

    const source = await loadVerifiedSource();
    const original = source.attempt;
    const originalPrepared = source.prepared;
    const intent: RequestIntent = {
      transactionId: input.transactionId,
      operation: 'restore',
      expectedRevision: original.expectedRevision,
    };
    const sameRequest = await findRequestOrConflict(d, input.requestId, intent);
    if (sameRequest) {
      const restore = persistedRestoreForProof(sameRequest);
      if (sameRequest.status !== 'PREPARED') {
        const txn = await loadAuthorizedRecordedAttempt(
          d,
          sameRequest,
          input.companyId,
          input.actor.id,
          authorization,
        );
        return recordedAttemptResultWithOutcome(d, sameRequest, txn);
      }
      const { txn } = await loadAuthorizedAttempt(
        d,
        sameRequest,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      const client = await d.getClient(input.companyId);
      const entered = await enterCommitting(
        d,
        sameRequest,
        txn,
        input.actor,
        invocationOwner,
        ['POSTED'],
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
        async (currentTxn) => {
          const finalSource = await loadVerifiedSource();
          if (
            hashPreparedWriteBinding(finalSource.prepared)
              !== hashPreparedWriteBinding(originalPrepared)
          ) {
            lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source changed before restore send.');
          }
          const [freshTxn, current] = await Promise.all([
            client.fetchTxn(restore.qboType, currentTxn.qboId),
            client.fetchPreparedSnapshot(restore.qboType, currentTxn.qboId),
          ]);
          const verification = current
            ? verifyPreparedResult(originalPrepared, current)
            : { ok: false as const };
          if (
            !freshTxn ||
            !current ||
            freshTxn.syncToken !== sameRequest.expectedSyncToken ||
            current.syncToken !== sameRequest.expectedSyncToken ||
            currentTxn.qboSyncToken !== sameRequest.expectedSyncToken ||
            !verification.ok
          ) {
            lifecycleError(
              'QBO_STATE_DRIFT',
              `${restore.qboType} changed before the prepared restore could resume.`,
            );
          }
          assertCurrentProof(txn, current);
          await assertPreparedWriteSafety(client, restore);
        },
      );
      if (!entered.won) {
        const { txn: latestTxn } = await loadAuthorizedAttempt(
          d,
          entered.attempt,
          input.companyId,
          input.actor.id,
          authorization,
          undefined,
          input.proof?.expectedQboBinding,
        );
        return recordedAttemptResultWithOutcome(d, entered.attempt, latestTxn);
      }
      return sendAndVerifyPrepared(
        d,
        client,
        sameRequest,
        txn,
        input.actor,
        restore,
        'REVERTED',
        input.auditAttribution,
      );
    }

    let { txn } = await loadAuthorizedAttempt(
      d,
      original,
      input.companyId,
      input.actor.id,
      authorization,
      undefined,
      input.proof?.expectedQboBinding,
    );
    if (originalPrepared.qboType !== txn.qboType) {
      lifecycleError('ATTEMPT_CORRUPT', 'Stored mutation entity type is inconsistent.');
    }
    validatePreparedBinding(original, txn);
    await d.renewLease(leaseKey(txn), invocationOwner);
    const client = await d.getClient(input.companyId);
    const [freshTxn, current] = await Promise.all([
      client.fetchTxn(originalPrepared.qboType, txn.qboId),
      client.fetchPreparedSnapshot(originalPrepared.qboType, txn.qboId),
    ]);
    if (!freshTxn || !current) {
      lifecycleError(
        'QBO_STATE_DRIFT',
        `${originalPrepared.qboType} no longer exists in QuickBooks.`,
      );
    }
    if (
      freshTxn.syncToken !== current.syncToken ||
      current.syncToken !== txn.qboSyncToken
    ) {
      lifecycleError(
        'QBO_STATE_DRIFT',
        `${originalPrepared.qboType} SyncToken changed after the verified post.`,
      );
    }
    const currentVerification = verifyPreparedResult(originalPrepared, current);
    if (!currentVerification.ok) {
      lifecycleError('QBO_STATE_DRIFT', currentVerification.message);
    }
    assertCurrentProof(txn, current);
    await assertSnapshotWriteSafety(
      client,
      originalPrepared.qboType,
      txn.qboId,
      current,
    );

    const restore = validateFreshPrepared(
      await client.prepareRestore(
        freshTxn,
        originalPrepared,
        input.requestId,
      ),
      {
        operation: 'restore',
        requestId: input.requestId,
        txn,
        before: current,
      },
    );
    assertRestoreProof(restore);
    const persisted = await persistPrepared(
      d,
      txn.companyId,
      txn.id,
      original.expectedRevision,
      restore,
      current,
    );
    if (!persisted.created) {
      persistedRestoreForProof(persisted.attempt);
      const { txn: racedTxn } = await loadAuthorizedAttempt(
        d,
        persisted.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      return recordedAttemptResultWithOutcome(d, persisted.attempt, racedTxn);
    }
    const entered = await enterCommitting(
      d,
      persisted.attempt,
      txn,
      input.actor,
      invocationOwner,
      ['POSTED'],
      authorization,
      undefined,
      input.proof?.expectedQboBinding,
      async (currentTxn) => {
        const finalSource = await loadVerifiedSource();
        if (
          hashPreparedWriteBinding(finalSource.prepared)
            !== hashPreparedWriteBinding(originalPrepared)
        ) {
          lifecycleError('UNDO_PROOF_MISMATCH', 'The verified source changed before restore send.');
        }
        const [lastTxn, lastSnapshot] = await Promise.all([
          client.fetchTxn(originalPrepared.qboType, currentTxn.qboId),
          client.fetchPreparedSnapshot(originalPrepared.qboType, currentTxn.qboId),
        ]);
        const verification = lastSnapshot
          ? verifyPreparedResult(originalPrepared, lastSnapshot)
          : { ok: false as const };
        if (
          !lastTxn ||
          !lastSnapshot ||
          lastTxn.syncToken !== persisted.attempt.expectedSyncToken ||
          lastSnapshot.syncToken !== persisted.attempt.expectedSyncToken ||
          currentTxn.qboSyncToken !== persisted.attempt.expectedSyncToken ||
          !verification.ok
        ) {
          lifecycleError(
            'QBO_STATE_DRIFT',
            `${originalPrepared.qboType} changed before the prepared restore send.`,
          );
        }
        assertCurrentProof(txn, lastSnapshot);
        await assertPreparedWriteSafety(client, restore);
      },
    );
    if (!entered.won) {
      persistedRestoreForProof(entered.attempt);
      const { txn: latestTxn } = await loadAuthorizedAttempt(
        d,
        entered.attempt,
        input.companyId,
        input.actor.id,
        authorization,
        undefined,
        input.proof?.expectedQboBinding,
      );
      return recordedAttemptResultWithOutcome(d, entered.attempt, latestTxn);
    }
    return sendAndVerifyPrepared(
      d,
      client,
      persisted.attempt,
      txn,
      input.actor,
      restore,
      'REVERTED',
      input.auditAttribution,
    );
  });
}
