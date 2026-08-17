import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTransactions: vi.fn(),
  txnFindMany: vi.fn(),
  logTagFindMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    transaction: { findMany: mocks.txnFindMany },
    logTag: { findMany: mocks.logTagFindMany },
  },
}));

vi.mock('../lib/qbo/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/qbo/factory.js')>();
  return {
    ...actual,
    qboFactory: {
      ...actual.qboFactory,
      forCompany: async () => ({ listTransactions: mocks.listTransactions }),
    },
  };
});

const { transactionLog } = await import('./reports.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txnFindMany.mockResolvedValue([]);
  mocks.logTagFindMany.mockResolvedValue([]);
});

/** Distinct rows, each without an entity id, so each gets a fallback key. */
function rowsWithoutIds(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    date: '2024-03-14',
    txnType: 'Expense',
    docNum: String(i),
    payee: `PAYEE ${i}`,
    memo: '',
    account: 'Checking',
    category: 'Uncategorized',
    amount: -1 - i,
  }));
}

// Postgres caps bind parameters per statement. "All time" on a large real book
// is exactly where an unbounded IN list stops being theoretical, and the whole
// transaction log request fails rather than degrading.
describe('transactionLog — bounded IN queries', () => {
  it('splits log-tag lookups into batches instead of one huge IN list', async () => {
    mocks.listTransactions.mockResolvedValue(rowsWithoutIds(2_500));

    await transactionLog('co-1', { start: '2020-01-01', end: '2024-12-31' });

    expect(mocks.logTagFindMany).toHaveBeenCalled();
    for (const call of mocks.logTagFindMany.mock.calls) {
      const keys = (call[0] as { where: { qboKey: { in: string[] } } }).where.qboKey.in;
      expect(keys.length).toBeLessThanOrEqual(1_000);
    }
    const queried = mocks.logTagFindMany.mock.calls.flatMap(
      (c) => (c[0] as { where: { qboKey: { in: string[] } } }).where.qboKey.in,
    );
    expect(queried).toHaveLength(2_500); // every key still looked up
  });

  it('deduplicates keys, so repeated identical rows cost one parameter', async () => {
    const identical = Array.from({ length: 300 }, () => rowsWithoutIds(1)[0]!);
    mocks.listTransactions.mockResolvedValue(identical);

    await transactionLog('co-1', { start: '2020-01-01', end: '2024-12-31' });

    const queried = mocks.logTagFindMany.mock.calls.flatMap(
      (c) => (c[0] as { where: { qboKey: { in: string[] } } }).where.qboKey.in,
    );
    expect(queried).toHaveLength(1);
  });

  it('batches entity-id lookups the same way', async () => {
    mocks.listTransactions.mockResolvedValue(
      Array.from({ length: 1_800 }, (_, i) => ({ ...rowsWithoutIds(1)[0]!, qboId: `id-${i}` })),
    );

    await transactionLog('co-1', { start: '2020-01-01', end: '2024-12-31' });

    for (const call of mocks.txnFindMany.mock.calls) {
      const ids = (call[0] as { where: { qboId: { in: string[] } } }).where.qboId.in;
      expect(ids.length).toBeLessThanOrEqual(1_000);
    }
  });

  it('makes no query at all when there is nothing to look up', async () => {
    mocks.listTransactions.mockResolvedValue([]);

    await transactionLog('co-1', { start: '2020-01-01', end: '2024-12-31' });

    expect(mocks.logTagFindMany).not.toHaveBeenCalled();
    expect(mocks.txnFindMany).not.toHaveBeenCalled();
  });
});
