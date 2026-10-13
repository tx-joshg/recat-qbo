import type { TransactionDto } from '@recat/shared';

/** Must not exceed the server's per-request id cap. */
export const TXN_REFRESH_BATCH = 200;

/**
 * Applies a refresh of `requestedIds` to the loaded rows: refreshed rows are
 * replaced in place, and requested rows the server no longer returns (for
 * example, superseded by a sync) are dropped. Other rows are left as they are.
 */
export function mergeRefreshedRows(
  prev: readonly TransactionDto[],
  fresh: readonly TransactionDto[],
  requestedIds: readonly string[],
): TransactionDto[] {
  const requested = new Set(requestedIds);
  const byId = new Map(fresh.filter((row) => requested.has(row.id)).map((row) => [row.id, row]));
  return prev.flatMap((row) => {
    if (!requested.has(row.id)) return [row];
    const next = byId.get(row.id);
    return next ? [next] : [];
  });
}
