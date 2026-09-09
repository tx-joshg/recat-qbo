import { describe, expect, it, vi } from 'vitest';
import type { CompanyReadTransactionDto } from './companyReads.js';
import { createWriteSafetyReadOperations } from './writeSafetyReads.js';
import type { QboClient, QboTxn } from '../lib/qbo/types.js';
import { QboWriteSafetyError } from '../lib/qbo/writeSafety.js';

const recat: CompanyReadTransactionDto = {
  id: 'transaction-a',
  companyId: 'company-a',
  qboId: 'purchase-a',
  qboType: 'Purchase',
  date: '2026-01-02T00:00:00.000Z',
  payee: 'Vendor',
  memo: null,
  amount: -10,
  bankAccount: 'Checking',
  status: 'PENDING',
  revision: 3,
  category: null,
  categoryQboId: null,
  taxCalculation: null,
  taxCode: null,
  taxCodeQboId: null,
  splits: null,
  tagIds: [],
  suggestion: null,
  error: null,
  postedAt: null,
  postedBy: null,
  activeCategorizationAttempt: null,
  verification: { status: 'unknown', outcome: null, summary: 'Not posted.' },
};

function qbo(overrides: Partial<QboTxn> = {}): QboTxn {
  return {
    qboId: 'purchase-a',
    qboType: 'Purchase',
    syncToken: '7',
    date: '2026-01-02',
    payee: 'Vendor',
    amount: -10,
    bankAccount: 'Checking',
    lines: [],
    raw: { AccountRef: { value: 'bank-9' } },
    ...overrides,
  };
}

function service(
  txn: CompanyReadTransactionDto = recat,
  current: QboTxn | null = qbo(),
  evidence = { bookCloseDate: null as string | null, cleared: false, reconciled: false },
) {
  const client = {
    fetchTxn: vi.fn().mockResolvedValue(current),
    fetchWriteSafety: vi.fn().mockResolvedValue(evidence),
  } as unknown as QboClient;
  const getTransaction = vi.fn().mockResolvedValue(txn);
  return {
    operations: createWriteSafetyReadOperations({
      getTransaction,
      qboForCompany: vi.fn().mockResolvedValue(client),
    }),
    client,
    getTransaction,
  };
}

describe('write-safety reads', () => {
  it('returns a revision-bound writable result for a current purchase', async () => {
    const fixture = service();

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .resolves.toEqual({
        transactionId: 'transaction-a',
        revision: 3,
        qboId: 'purchase-a',
        qboType: 'Purchase',
        qboSyncToken: '7',
        txnDate: '2026-01-02',
        bankAccountQboId: 'bank-9',
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
        writable: true,
        blockCode: null,
      });
    expect(fixture.getTransaction).toHaveBeenCalledWith('user-a', 'company-a', 'transaction-a');
    expect(fixture.client.fetchWriteSafety).toHaveBeenCalledWith({
      qboType: 'Purchase',
      qboId: 'purchase-a',
      txnDate: '2026-01-02',
      bankAccountQboId: 'bank-9',
    });
  });

  it('persists the exact read as a bounded actionability observation', async () => {
    const persistActionability = vi.fn().mockResolvedValue(true);
    const client = {
      fetchTxn: vi.fn().mockResolvedValue(qbo()),
      fetchWriteSafety: vi.fn().mockResolvedValue({
        bookCloseDate: '2026-02-01',
        cleared: false,
        reconciled: false,
      }),
    } as unknown as QboClient;
    const operations = createWriteSafetyReadOperations({
      getTransaction: vi.fn().mockResolvedValue(recat),
      qboForCompany: vi.fn().mockResolvedValue(client),
      persistActionability,
    });

    await operations.getWriteSafety('user-a', 'company-a', 'transaction-a');

    expect(persistActionability).toHaveBeenCalledWith(expect.objectContaining({
      id: 'transaction-a',
      companyId: 'company-a',
      revision: 3,
      qboSyncToken: '7',
      qboType: 'Purchase',
      qboId: 'purchase-a',
      date: '2026-01-02',
      bankAccountQboId: 'bank-9',
      evidence: {
        bookCloseDate: '2026-02-01',
        cleared: false,
        reconciled: false,
      },
    }));
  });

  it.each([
    { bookCloseDate: null, cleared: true, reconciled: false },
    { bookCloseDate: null, cleared: false, reconciled: true },
  ] as const)('reports bank status without using it as a write lock', async (evidence) => {
    const fixture = service(recat, qbo(), evidence);

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .resolves.toMatchObject({ writable: true, blockCode: null, ...evidence });
  });

  it('returns a non-writable result for a closed accounting period', async () => {
    const evidence = { bookCloseDate: '2026-01-02', cleared: false, reconciled: false } as const;
    const fixture = service(recat, qbo(), evidence);

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .resolves.toMatchObject({ writable: false, blockCode: 'QBO_PERIOD_CLOSED', ...evidence });
  });

  it('extracts DepositToAccountRef for deposits', async () => {
    const depositRecat = { ...recat, qboId: 'deposit-a', qboType: 'Deposit' as const, amount: 10 };
    const fixture = service(depositRecat, qbo({
      qboId: 'deposit-a',
      qboType: 'Deposit',
      amount: 10,
      raw: { DepositToAccountRef: { value: 'bank-10' } },
    }));

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .resolves.toMatchObject({ qboType: 'Deposit', bankAccountQboId: 'bank-10', writable: true });
  });

  it.each([
    ['missing current entity', recat, null],
    ['changed date', recat, qbo({ date: '2026-01-03' })],
    ['changed amount', recat, qbo({ amount: -11 })],
    ['changed type', recat, qbo({ qboType: 'Deposit', raw: { DepositToAccountRef: { value: 'bank-9' } } })],
    ['missing payment account', recat, qbo({ raw: {} })],
  ])('fails closed when %s', async (_label, transaction, current) => {
    const fixture = service(transaction, current);

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .rejects.toMatchObject({ code: 'QBO_WRITE_SAFETY_UNAVAILABLE' });
  });

  it('fails closed for journal entries without calling QBO', async () => {
    const fixture = service({ ...recat, qboType: 'JournalEntry' });

    await expect(fixture.operations.getWriteSafety('user-a', 'company-a', 'transaction-a'))
      .rejects.toBeInstanceOf(QboWriteSafetyError);
    expect(fixture.client.fetchTxn).not.toHaveBeenCalled();
  });
});
