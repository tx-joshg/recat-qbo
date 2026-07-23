import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  companyUpdate: vi.fn(),
  queryRaw: vi.fn(),
  txnTagDeleteMany: vi.fn(),
  txnTagCreateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    transaction: { findUnique: mocks.findUnique },
    $transaction: mocks.transaction,
  },
}));

import { setTransactionLogTags } from './reports.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ id: 'txn-1' });
  mocks.transactionUpdate.mockResolvedValue({ id: 'txn-1' });
  mocks.txnTagDeleteMany.mockResolvedValue({ count: 1 });
  mocks.txnTagCreateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(
    async (
      callback: (tx: {
        $queryRaw: typeof mocks.queryRaw;
        transaction: { update: typeof mocks.transactionUpdate };
        company: { update: typeof mocks.companyUpdate };
        txnTag: {
          deleteMany: typeof mocks.txnTagDeleteMany;
          createMany: typeof mocks.txnTagCreateMany;
        };
      }) => unknown,
    ) =>
      callback({
        $queryRaw: mocks.queryRaw,
        transaction: { update: mocks.transactionUpdate },
        company: { update: mocks.companyUpdate },
        txnTag: {
          deleteMany: mocks.txnTagDeleteMany,
          createMany: mocks.txnTagCreateMany,
        },
      }),
  );
});

describe('setTransactionLogTags', () => {
  it('bumps the parent transaction version before replacing local queue tags', async () => {
    await setTransactionLogTags('co-1', 'Purchase:qbo-1', ['tag-1']);

    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { updatedAt: expect.any(Date) },
      select: { id: true },
    });
    expect(mocks.txnTagDeleteMany).toHaveBeenCalledWith({ where: { txnId: 'txn-1' } });
    expect(mocks.txnTagCreateMany).toHaveBeenCalledWith({
      data: [{ txnId: 'txn-1', tagId: 'tag-1' }],
    });
    expect(mocks.companyUpdate).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { agentReconcileToken: expect.any(String) },
      select: { id: true },
    });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transactionUpdate.mock.invocationCallOrder[0]!,
    );
    expect(mocks.transactionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txnTagDeleteMany.mock.invocationCallOrder[0]!,
    );
  });
});
