import type { ProviderActionabilityRefreshItem, ProviderActionabilityRefreshResult } from '@recat/shared';
export type { ProviderActionabilityRefreshItem, ProviderActionabilityRefreshResult } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { QboRateLimitError } from '../lib/qbo/types.js';
import {
  persistProviderActionability,
  type PersistProviderActionabilityInput,
} from './providerActionability.js';
import {
  writeSafetyReads,
  type WriteSafetyReadResult,
} from './writeSafetyReads.js';

/** A refresh deliberately processes a small page. Callers resume with the
 * returned cursor instead of holding a request open over the whole queue. */
// A single safety read can issue several QBO requests, each with the normal
// 30-second provider timeout. Keep one transaction per request so a refresh
// cannot accumulate an unbounded series of provider timeouts.
export const DEFAULT_ACTIONABILITY_REFRESH_LIMIT = 1;
export const MAX_ACTIONABILITY_REFRESH_LIMIT = 1;

export interface ActionabilityRefreshTransaction {
  id: string;
  companyId: string;
  revision: number;
  qboSyncToken: string;
  qboType: string;
  qboId: string;
  date: Date | string;
}

export interface ProviderActionabilityRefreshDeps {
  /** Must enforce the caller's company scope before returning rows. */
  listTransactions(
    userId: string,
    companyId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ActionabilityRefreshTransaction[]>;
  readSafety(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<WriteSafetyReadResult>;
  persist(input: PersistProviderActionabilityInput): Promise<boolean>;
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_ACTIONABILITY_REFRESH_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIONABILITY_REFRESH_LIMIT) {
    throw new Error(`Actionability refresh limit must be between 1 and ${MAX_ACTIONABILITY_REFRESH_LIMIT}.`);
  }
  return value;
}

function boundedCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (cursor.length > 128) throw new Error('Actionability refresh cursor is too long.');
  return cursor;
}

function unavailableCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code;
  }
  return 'QBO_WRITE_SAFETY_UNAVAILABLE';
}

function isRateLimited(error: unknown): boolean {
  if (error instanceof QboRateLimitError) return true;
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: unknown }).status === 429;
}

function retryAfterHint(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('retryAfterSeconds' in error)) {
    return undefined;
  }
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Keep the provider's retry hint while replacing an arbitrary HTTP 429 with
 * the typed error that the MCP result layer sanitizes. QboRateLimitError's
 * constructor clamps the value to the safe one-to-sixty-second range.
 */
function normalizedRateLimitError(error: unknown): QboRateLimitError {
  if (error instanceof QboRateLimitError) return error;
  return new QboRateLimitError(retryAfterHint(error));
}

function dispositionFromSafety(result: WriteSafetyReadResult): ProviderActionabilityRefreshItem['disposition'] {
  if (result.blockCode === 'QBO_PERIOD_CLOSED') return 'BLOCKED_PERIOD_CLOSED';
  // Compatibility with pre-policy-change read results: cleared/reconciled
  // observations remain useful evidence but do not make a transaction unsafe.
  if (result.blockCode === 'QBO_TRANSACTION_LOCKED') return 'WRITABLE';
  return result.writable ? 'WRITABLE' : 'UNAVAILABLE';
}

function resultInput(
  companyId: string,
  result: WriteSafetyReadResult,
): PersistProviderActionabilityInput {
  return {
    id: result.transactionId,
    companyId,
    revision: result.revision,
    qboSyncToken: result.qboSyncToken,
    qboType: result.qboType,
    qboId: result.qboId,
    date: result.txnDate,
    checkedAt: new Date(),
    bankAccountQboId: result.bankAccountQboId,
    evidence: {
      bookCloseDate: result.bookCloseDate,
      cleared: result.cleared,
      reconciled: result.reconciled,
    },
  };
}

function unavailableInput(
  txn: ActionabilityRefreshTransaction,
  error: unknown,
): PersistProviderActionabilityInput {
  return {
    ...txn,
    disposition: 'UNAVAILABLE',
    checkedAt: new Date(),
    bankAccountQboId: null,
    unavailableCode: unavailableCode(error),
    unavailableReason: null,
  };
}

const defaultDeps: ProviderActionabilityRefreshDeps = {
  async listTransactions(userId, companyId, afterId, limit) {
    // The scoped company lookup is intentionally separate from the transaction
    // query: a guessed company ID must not become a cross-tenant cursor.
    const { getCompany } = await import('./companyReads.js');
    await getCompany(userId, companyId);
    return prisma.transaction.findMany({
      where: {
        companyId,
        status: { in: ['PENDING', 'ERROR'] },
        qboType: { in: ['Purchase', 'Deposit'] },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        companyId: true,
        revision: true,
        qboSyncToken: true,
        qboType: true,
        qboId: true,
        date: true,
      },
    }) as Promise<ActionabilityRefreshTransaction[]>;
  },
  readSafety: (userId, companyId, transactionId) =>
    writeSafetyReads.getWriteSafety(userId, companyId, transactionId, { persist: false }),
  persist: persistProviderActionability,
};

/**
 * Read and persist at most one bounded page of provider safety observations.
 * Every QBO read goes through the same authorized get-write-safety operation
 * used by the MCP surface; this function itself never mutates QBO.
 */
export async function refreshProviderActionability(
  userId: string,
  companyId: string,
  options: { cursor?: string | null; limit?: number } = {},
  deps: ProviderActionabilityRefreshDeps = defaultDeps,
): Promise<ProviderActionabilityRefreshResult> {
  const limit = boundedLimit(options.limit);
  const cursor = boundedCursor(options.cursor);
  let rows: ActionabilityRefreshTransaction[];
  try {
    rows = await deps.listTransactions(userId, companyId, cursor, limit);
  } catch (error) {
    if (isRateLimited(error)) throw normalizedRateLimitError(error);
    throw error;
  }
  const items: ProviderActionabilityRefreshItem[] = [];
  let persisted = 0;
  let failed = 0;

  for (const txn of rows) {
    let item: ProviderActionabilityRefreshItem;
    try {
      const safety = await deps.readSafety(userId, companyId, txn.id);
      const didPersist = await deps.persist(resultInput(companyId, safety));
      if (didPersist) persisted += 1;
      item = {
        transactionId: txn.id,
        persisted: didPersist,
        disposition: dispositionFromSafety(safety),
        errorCode: null,
      };
    } catch (error) {
      // A rate-limit response means the provider did not give us an
      // authoritative observation. Do not turn it into UNAVAILABLE and move
      // the cursor past this transaction: retrying the same cursor is the
      // only safe continuation. The MCP result layer turns this typed error
      // into a sanitized RATE_LIMITED response with its bounded hint.
      if (isRateLimited(error)) throw normalizedRateLimitError(error);
      failed += 1;
      let didPersist = false;
      try {
        didPersist = await deps.persist(unavailableInput(txn, error));
        if (didPersist) persisted += 1;
      } catch (persistError) {
        if (isRateLimited(persistError)) throw normalizedRateLimitError(persistError);
        // Keep the cursor moving even when the local index is unavailable.
      }
      item = {
        transactionId: txn.id,
        persisted: didPersist,
        disposition: 'UNAVAILABLE',
        errorCode: unavailableCode(error),
      };
    }
    items.push(item);
  }

  const nextCursor = rows.at(-1)?.id ?? null;
  const partial = rows.length === limit;
  return {
    companyId,
    processed: rows.length,
    persisted,
    failed,
    nextCursor: partial ? nextCursor : null,
    partial,
    complete: !partial,
    items,
  };
}

export function createProviderActionabilityRefresh(
  deps: Partial<ProviderActionabilityRefreshDeps> = {},
): (userId: string, companyId: string, options?: { cursor?: string | null; limit?: number }) => Promise<ProviderActionabilityRefreshResult> {
  const merged = { ...defaultDeps, ...deps };
  return (userId, companyId, options) => refreshProviderActionability(userId, companyId, options, merged);
}
