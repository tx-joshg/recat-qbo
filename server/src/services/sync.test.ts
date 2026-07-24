import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { supersedeTxn } from './sync.js';

function fixture(unresolvedRestore: boolean) {
  const tx = {
    qboMutationAttempt: {
      findFirst: vi.fn(async () => (unresolvedRestore ? { id: 'restore-1' } : null)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    transaction: {
      update: vi.fn(async () => ({ id: 'txn-1' })),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const audit = vi.fn(async () => undefined);
  return { tx, db, audit };
}

const transaction = {
  id: 'txn-1',
  companyId: 'co-1',
  payee: 'Vendor',
  amount: { toString: () => '-42.00' },
} as never;

describe('sync supersede recovery boundary', () => {
  it('preserves an unresolved restore for explicit read-back reconciliation', async () => {
    const value = fixture(true);

    await expect(
      supersedeTxn(transaction, 'Ask My Accountant', {
        db: value.db,
        audit: value.audit,
      }),
    ).resolves.toBe(false);

    expect(value.tx.qboMutationAttempt.findFirst).toHaveBeenCalledWith({
      where: {
        transactionId: 'txn-1',
        operation: 'restore',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      select: { id: true },
    });
    expect(value.tx.qboMutationAttempt.updateMany).not.toHaveBeenCalled();
    expect(value.tx.transaction.update).not.toHaveBeenCalled();
    expect(value.audit).not.toHaveBeenCalled();
  });

  it('reconciles only recategorization attempts before superseding', async () => {
    const value = fixture(false);

    await expect(
      supersedeTxn(transaction, 'Ask My Accountant', {
        db: value.db,
        audit: value.audit,
      }),
    ).resolves.toBe(true);

    expect(value.tx.qboMutationAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        transactionId: 'txn-1',
        operation: 'recategorize',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      data: { status: 'RECONCILED' },
    });
    expect(value.tx.transaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { status: 'SUPERSEDED' },
    });
    expect(value.audit).toHaveBeenCalledOnce();
  });
});
