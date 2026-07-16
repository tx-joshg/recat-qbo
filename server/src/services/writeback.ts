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
import type { AuditAction, SplitDto, TxnStatus } from '@recat/shared';
import { QboSyncTokenConflict, type QboClient, type QboTxn, type QboWriteResult } from '../lib/qbo/types.js';

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
  if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
    throw new Error(`Cannot post a transaction in status ${txn.status}`);
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
        result = await client.recategorize(fresh, writeSplits);
      } catch (err) {
        if (!(err instanceof QboSyncTokenConflict)) throw err;
        // Someone edited the entity between our read and write: re-fetch and
        // retry exactly once.
        const refetched = await client.fetchTxn(txn.qboType as QboTxn['qboType'], txn.qboId);
        const stillHolding = refetched?.lines.some((l) => holdingIds.includes(l.accountQboId));
        if (!refetched || !stillHolding) return await markSuperseded(d, baseTxn, before);
        payload.syncToken = refetched.syncToken;
        result = await client.recategorize(refetched, writeSplits);
      }
    } catch (err) {
      const info = errorInfo(err);
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
