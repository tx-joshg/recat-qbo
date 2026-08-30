import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { StagedCategorization } from '@recat/shared';
import {
  QboRequestTimeout,
  QboSyncTokenConflict,
  type QboClient,
  type QboDepositPreparedWrite,
  type QboDepositSnapshot,
  type QboPreparedWrite,
  type QboPurchaseSnapshot,
  type QboTxn,
} from '../lib/qbo/types.js';
import {
  bulkPost,
  commitStagedCategorization,
  hashPreparedWriteBinding,
  hashStagedCategorization,
  hashPreparedWriteBody,
  postTransaction,
  prepareCategorizationUndo,
  reconcileMutationAttempt,
  retryError,
  splitLineDtos,
  undoCategorization,
  undoPost,
  validateSplits,
  WritebackLifecycleError,
  type DurableWritebackDb,
  type DurableWritebackDeps,
  type WritebackDeps,
} from './writeback.js';

describe('validateSplits (split sum + per-line sign guard)', () => {
  it('accepts splits that sum to the signed txn amount', () => {
    expect(validateSplits(-486.12, [{ amount: -400 }, { amount: -86.12 }]).ok).toBe(true);
    expect(validateSplits(1842.5, [{ amount: 1000 }, { amount: 842.5 }]).ok).toBe(true);
  });

  it('tolerates half a cent of float noise', () => {
    expect(validateSplits(-0.3, [{ amount: -0.1 }, { amount: -0.2 }]).ok).toBe(true);
  });

  it('rejects splits that do not sum to the amount', () => {
    const result = validateSplits(-486.12, [{ amount: -400 }, { amount: -86.0 }]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/add up/);
  });

  it('rejects a split whose sign differs from the transaction', () => {
    const negTxn = validateSplits(-100, [{ amount: 100 }]);
    expect(negTxn.ok).toBe(false);
    expect(negTxn.message).toMatch(/negative/);

    // Mixed signs that happen to sum correctly must still be rejected — they
    // would silently reshape the QBO entity.
    const mixed = validateSplits(-100, [{ amount: -150 }, { amount: 50 }]);
    expect(mixed.ok).toBe(false);
    expect(mixed.message).toMatch(/negative/);

    const posTxn = validateSplits(100, [{ amount: 150 }, { amount: -50 }]);
    expect(posTxn.ok).toBe(false);
    expect(posTxn.message).toMatch(/positive/);
  });

  it('rejects zero-amount split lines', () => {
    const result = validateSplits(-100, [{ amount: -100 }, { amount: 0 }]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nonzero/);
  });
});

describe('splitLineDtos', () => {
  it('preserves staged memo and tax identity for queue reloads', () => {
    expect(splitLineDtos([{
      idx: 0,
      amount: -10.5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      memo: 'Generic line memo',
      tags: [{ tagId: '00000000-0000-4000-8000-000000000001' }],
    }])).toEqual([{
      amount: -10.5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      memo: 'Generic line memo',
      tagIds: ['00000000-0000-4000-8000-000000000001'],
    }]);
  });
});

describe('hashStagedCategorization', () => {
  it('is stable across unordered relation results for transaction and line tags', () => {
    const staged: StagedCategorization = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      taxCalculation: 'NotApplicable',
      totals: { subtotalCents: -100, taxCents: 0, totalCents: -100 },
      lines: [{
        idx: 0,
        subtotalCents: -100,
        taxCents: 0,
        totalCents: -100,
        categoryQboId: 'category',
        taxCodeQboId: null,
        memo: null,
        tagIds: ['tag-b', 'tag-a'],
      }],
      tagIds: ['tag-d', 'tag-c'],
    };
    expect(hashStagedCategorization(staged)).toBe(hashStagedCategorization({
      ...staged,
      lines: [{
        ...staged.lines[0]!,
        tagIds: ['tag-a', 'tag-b'],
      }],
      tagIds: ['tag-c', 'tag-d'],
    }));
    expect(hashStagedCategorization(staged)).toBe(hashStagedCategorization({
      ...staged,
      taxDisposition: 'set',
    }));
  });
});

// ---------------------------------------------------------------------------
// postTransaction with injected fakes
// ---------------------------------------------------------------------------

interface FakeTxnRow {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  date: Date;
  payee: string;
  memo: string | null;
  amount: number;
  bankAccount: string;
  status: string;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  splitLines: {
    idx: number;
    amount: number;
    category: string;
    categoryQboId: string | null;
    taxCodeQboId?: string | null;
    memo: string | null;
    tags: { tagId: string }[];
  }[];
  postedAt: Date | null;
  postedByUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  txnTags: { txnId: string; tagId: string }[];
  company: {
    id: string;
    dryRun: boolean;
    tagsRequired: boolean;
    holdingAccountIds: string[];
    taxSupportStatus?: string;
    taxUsingSalesTax?: boolean | null;
    taxSupportReason?: string | null;
    cachedSalesCodes?: {
      active: boolean;
      taxable: boolean | null;
      salesTaxRateList: unknown;
      combinedSalesRate: number | null;
    }[];
  };
}

function makeTxnRow(overrides: Partial<FakeTxnRow> = {}): FakeTxnRow {
  return {
    id: 'txn-1',
    companyId: 'co-1',
    qboId: '6',
    qboType: 'Purchase',
    qboSyncToken: '0',
    date: new Date('2026-07-05'),
    payee: 'WEBFLOW.COM',
    memo: null,
    amount: -29,
    bankAccount: 'Visa ·0392',
    status: 'PENDING',
    category: 'Software subscriptions',
    categoryQboId: '25',
    taxCalculation: null,
    taxCodeQboId: null,
    splitLines: [],
    postedAt: null,
    postedByUserId: null,
    errorCode: null,
    errorMessage: null,
    txnTags: [],
    company: { id: 'co-1', dryRun: false, tagsRequired: false, holdingAccountIds: ['4'] },
    ...overrides,
  };
}

function freshQboTxn(syncToken = '0', qboType: 'Purchase' | 'Deposit' = 'Purchase'): QboTxn {
  return {
    qboId: '6',
    qboType,
    syncToken,
    date: '2026-07-05',
    payee: 'WEBFLOW.COM',
    amount: -29,
    bankAccount: 'Visa ·0392',
    lines: [{ id: '1', amount: 29, accountQboId: '4', accountName: 'Ask My Accountant' }],
    raw: qboType === 'Purchase'
      ? { AccountRef: { value: 'payment-generic' } }
      : { DepositToAccountRef: { value: 'payment-generic' } },
  };
}

function makeFakeDb(row: FakeTxnRow) {
  const db = {
    transaction: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(row, args.data);
        return row;
      }),
    },
    qboAccount: {
      findFirst: vi.fn(async () => ({
        qboId: '25',
        name: 'Software subscriptions',
        fullName: 'Expenses · Software subscriptions',
      })),
    },
    qboMutationAttempt: {
      findFirst: vi.fn(async () => null),
    },
    qboTaxCode: {
      findMany: vi.fn(async () => row.company.cachedSalesCodes ?? []),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return db;
}

function makeDeps(
  row: FakeTxnRow,
  client: Partial<QboClient>,
  envDryRun = false,
): { deps: WritebackDeps; db: ReturnType<typeof makeFakeDb>; audit: ReturnType<typeof vi.fn> } {
  const db = makeFakeDb(row);
  const audit = vi.fn(async () => undefined);
  const safeClient: Partial<QboClient> = {
    fetchWriteSafety: async () => ({
      bookCloseDate: null,
      cleared: false,
      reconciled: false,
    }),
    ...client,
  };
  const deps: WritebackDeps = {
    db: db as unknown as PrismaClient,
    getClient: async () => safeClient as QboClient,
    audit,
    envDryRun,
  };
  return { deps, db, audit };
}

describe('postTransaction dry-run', () => {
  it('never calls recategorize and logs the payload', async () => {
    const row = makeTxnRow({ company: { id: 'co-1', dryRun: true, tagsRequired: false, holdingAccountIds: ['4'] } });
    const recategorize = vi.fn();
    const client: Partial<QboClient> = { fetchTxn: async () => freshQboTxn(), recategorize };
    const { deps, audit } = makeDeps(row, client);

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps);

    expect(result).toMatchObject({ ok: true, status: 'DRY_RUN' });
    expect(recategorize).not.toHaveBeenCalled();
    expect(row.status).toBe('DRY_RUN');
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]![1] as { action: string; payload: { splits: unknown[] } };
    expect(entry.action).toBe('dry-run');
    expect(entry.payload.splits).toEqual([{ amount: -29, accountQboId: '25', memo: undefined }]);
  });

  it('respects env-level DRY_RUN even when the company toggle is off', async () => {
    const row = makeTxnRow();
    const recategorize = vi.fn();
    const client: Partial<QboClient> = { fetchTxn: async () => freshQboTxn(), recategorize };
    const { deps } = makeDeps(row, client, true);

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps);

    expect(result.status).toBe('DRY_RUN');
    expect(recategorize).not.toHaveBeenCalled();
  });
});

describe('postTransaction SyncToken conflict handling', () => {
  it('re-fetches and retries exactly once, then errors', async () => {
    const row = makeTxnRow();
    const fetchTxn = vi.fn(async () => freshQboTxn('1'));
    const recategorize = vi.fn(async () => {
      throw new QboSyncTokenConflict();
    });
    const { deps, audit } = makeDeps(row, { fetchTxn, recategorize });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Josh M.' }, {}, deps);

    expect(recategorize).toHaveBeenCalledTimes(2); // original + one retry, no more
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('SYNC_TOKEN_CONFLICT');
    expect(row.status).toBe('ERROR');
    expect(row.errorMessage).toContain('SyncToken conflict');
    const entry = audit.mock.calls[0]![1] as { action: string };
    expect(entry.action).toBe('error');
  });

  it('succeeds when the retry after one conflict works', async () => {
    const row = makeTxnRow();
    const fetchTxn = vi.fn(async () => freshQboTxn('1'));
    const recategorize = vi
      .fn()
      .mockRejectedValueOnce(new QboSyncTokenConflict())
      .mockResolvedValueOnce({ ok: true, newSyncToken: '2' });
    const { deps, audit } = makeDeps(row, { fetchTxn, recategorize });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Josh M.' }, {}, deps);

    expect(recategorize).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(row.status).toBe('POSTED');
    expect(row.qboSyncToken).toBe('2');
    const entry = audit.mock.calls[0]![1] as { action: string };
    expect(entry.action).toBe('posted');
  });
});

describe('legacy write safety', () => {
  it.each(['Purchase', 'Deposit'] as const)(
    'blocks a locked %s before posting and preserves PENDING state',
    async (qboType) => {
      const row = makeTxnRow({ qboType });
      const recategorize = vi.fn();
      const fetchWriteSafety = vi.fn(async () => ({
        bookCloseDate: null,
        cleared: qboType === 'Purchase',
        reconciled: qboType === 'Deposit',
      }));
      const { deps } = makeDeps(row, {
        fetchTxn: async () => freshQboTxn('0', qboType),
        fetchWriteSafety,
        recategorize,
      });

      const result = await postTransaction(
        'txn-1',
        { id: 'u-1', label: 'Generic User' },
        {},
        deps,
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'PENDING',
        error: { code: 'QBO_TRANSACTION_LOCKED' },
      });
      expect(fetchWriteSafety).toHaveBeenCalledWith({
        qboType,
        qboId: '6',
        txnDate: '2026-07-05',
        bankAccountQboId: 'payment-generic',
      });
      expect(recategorize).not.toHaveBeenCalled();
      expect(row.status).toBe('PENDING');
    },
  );

  it('rechecks safety after a SyncToken conflict before retrying', async () => {
    const row = makeTxnRow();
    const recategorize = vi.fn().mockRejectedValueOnce(new QboSyncTokenConflict());
    const fetchWriteSafety = vi
      .fn()
      .mockResolvedValueOnce({ bookCloseDate: null, cleared: false, reconciled: false })
      .mockResolvedValueOnce({ bookCloseDate: null, cleared: true, reconciled: false });
    const { deps } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('1'),
      fetchWriteSafety,
      recategorize,
    });

    const result = await postTransaction(
      'txn-1',
      { id: 'u-1', label: 'Generic User' },
      {},
      deps,
    );

    expect(result).toMatchObject({ status: 'PENDING', error: { code: 'QBO_TRANSACTION_LOCKED' } });
    expect(fetchWriteSafety).toHaveBeenCalledTimes(2);
    expect(recategorize).toHaveBeenCalledTimes(1);
  });
});

describe('postTransaction dual-write honesty', () => {
  it('marks ERROR with a "verify in QuickBooks" message when the DB commit fails after a successful QBO write', async () => {
    const row = makeTxnRow();
    const recategorize = vi.fn(async () => ({ ok: true as const, newSyncToken: '1' }));
    const client: Partial<QboClient> = { fetchTxn: async () => freshQboTxn(), recategorize };
    const { deps, db, audit } = makeDeps(row, client);
    db.$transaction.mockRejectedValueOnce(new Error('connection reset'));

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps);

    expect(recategorize).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ERROR');
    expect(result.error?.message).toMatch(/may have succeeded/);
    expect(row.status).toBe('ERROR');
    expect(row.errorMessage).toMatch(/verify in QuickBooks/);
    // Best-effort audit trail of the ambiguous state.
    const actions = audit.mock.calls.map((c) => (c[1] as { action: string }).action);
    expect(actions).toContain('error');
  });
});

describe('undoPost', () => {
  const postedCompany = { id: 'co-1', dryRun: true, tagsRequired: false, holdingAccountIds: ['4'] };

  it.each(['Purchase', 'Deposit'] as const)(
    'blocks a locked %s before legacy undo and preserves POSTED state',
    async (qboType) => {
      const row = makeTxnRow({
        qboType,
        status: 'POSTED',
        postedAt: new Date(),
        company: postedCompany,
      });
      const moveToAccount = vi.fn();
      const { deps } = makeDeps(row, {
        fetchTxn: async () => freshQboTxn('4', qboType),
        fetchWriteSafety: async () => ({
          bookCloseDate: null,
          cleared: true,
          reconciled: false,
        }),
        moveToAccount,
      });

      await expect(
        undoPost('txn-1', { id: 'u-1', label: 'Generic User' }, deps),
      ).rejects.toMatchObject({ code: 'QBO_TRANSACTION_LOCKED' });
      expect(moveToAccount).not.toHaveBeenCalled();
      expect(row.status).toBe('POSTED');
    },
  );

  it('blocks a tax-ready Purchase before legacy undo status or QBO work', async () => {
    const row = makeTxnRow({
      payee: 'Generic supplier',
      status: 'PENDING',
      company: {
        id: 'company-generic',
        dryRun: false,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    const fetchTxn = vi.fn();
    const moveToAccount = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn, moveToAccount });

    await expect(
      undoPost('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'Tax-ready Purchases must use staged categorization.',
    });
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(moveToAccount).not.toHaveBeenCalled();
    expect(row.status).toBe('PENDING');
  });

  it('blocks a canonically sales-ready Deposit before legacy undo work', async () => {
    const row = makeTxnRow({
      qboType: 'Deposit',
      status: 'DRY_RUN',
      postedAt: new Date(),
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: true,
        taxSupportReason: null,
        cachedSalesCodes: [{
          active: true,
          taxable: true,
          salesTaxRateList: [{
            taxRateQboId: 'sales-rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          combinedSalesRate: 5,
        }],
      },
    });
    const fetchTxn = vi.fn();
    const moveToAccount = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn, moveToAccount });

    await expect(
      undoPost('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'Tax-ready Deposits must use staged categorization.',
    });
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(moveToAccount).not.toHaveBeenCalled();
  });

  it('keeps a staged Deposit out of legacy undo after sales-tax readiness is lost', async () => {
    const row = makeTxnRow({
      qboType: 'Deposit',
      status: 'DRY_RUN',
      postedAt: new Date(),
      taxCalculation: 'TaxInclusive',
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: false,
        taxSupportReason: 'References unavailable',
        cachedSalesCodes: [],
      },
    });
    const fetchTxn = vi.fn();
    const moveToAccount = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn, moveToAccount });

    await expect(
      undoPost('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(moveToAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported readiness', 'Purchase', 'unsupported', true],
    ['setup-incomplete readiness', 'Purchase', 'needs_setup', true],
    ['unavailable readiness', 'Purchase', undefined, undefined],
    ['sales-tax-disabled Deposit', 'Deposit', 'ready', false],
  ] as const)('preserves legacy undo behavior for %s', async (
    _case,
    qboType,
    taxSupportStatus,
    taxUsingSalesTax,
  ) => {
    const row = makeTxnRow({
      payee: 'Generic supplier',
      qboType,
      status: 'DRY_RUN',
      postedAt: new Date(),
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus,
        taxUsingSalesTax,
      },
    });
    const fetchTxn = vi.fn();
    const moveToAccount = vi.fn();
    const { deps } = makeDeps(row, { fetchTxn, moveToAccount });

    await expect(
      undoPost('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, deps),
    ).resolves.toMatchObject({ ok: true, status: 'PENDING' });
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(moveToAccount).not.toHaveBeenCalled();
  });

  it('always reverses a POSTED txn in QBO, even when dry-run is enabled NOW', async () => {
    const row = makeTxnRow({ status: 'POSTED', postedAt: new Date(), company: postedCompany });
    const moveToAccount = vi.fn(async (_txn: unknown, _accountQboId: string, _fromIds: string[]) => ({
      ok: true as const,
      newSyncToken: '5',
    }));
    const client: Partial<QboClient> = { fetchTxn: async () => freshQboTxn('4'), moveToAccount };
    const { deps } = makeDeps(row, client, true); // env DRY_RUN also on

    const result = await undoPost('txn-1', { id: 'u-1', label: 'Maria K.' }, deps);

    expect(moveToAccount).toHaveBeenCalledTimes(1);
    // Pulls back exactly the category lines the post wrote.
    expect(moveToAccount.mock.calls[0]?.[1]).toBe('4');
    expect(moveToAccount.mock.calls[0]?.[2]).toEqual(['25']);
    expect(result).toMatchObject({ ok: true, status: 'PENDING' });
    expect(row.status).toBe('PENDING');
    expect(row.qboSyncToken).toBe('5');
  });

  it('never writes to QBO when undoing a DRY_RUN post', async () => {
    const row = makeTxnRow({ status: 'DRY_RUN', postedAt: new Date(), company: postedCompany });
    const moveToAccount = vi.fn();
    const fetchTxn = vi.fn();
    const { deps } = makeDeps(row, { fetchTxn, moveToAccount });

    const result = await undoPost('txn-1', { id: 'u-1', label: 'Maria K.' }, deps);

    expect(moveToAccount).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, status: 'PENDING' });
  });

  it('throws (instead of silently re-queuing) when a POSTED txn no longer exists in QuickBooks', async () => {
    const row = makeTxnRow({ status: 'POSTED', postedAt: new Date() });
    const moveToAccount = vi.fn();
    const { deps } = makeDeps(row, { fetchTxn: async () => null, moveToAccount });

    await expect(undoPost('txn-1', { id: 'u-1', label: 'Maria K.' }, deps)).rejects.toThrow(/no longer exists/);
    expect(moveToAccount).not.toHaveBeenCalled();
    expect(row.status).toBe('POSTED');
  });
});

describe('postTransaction guards', () => {
  it('blocks a tax-ready Purchase before legacy status or QBO work', async () => {
    const row = makeTxnRow({
      payee: 'Generic supplier',
      status: 'POSTED',
      company: {
        id: 'company-generic',
        dryRun: false,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    const fetchTxn = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn });

    await expect(
      postTransaction('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, {}, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'Tax-ready Purchases must use staged categorization.',
    });
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(row.status).toBe('POSTED');
  });

  it('blocks a canonically sales-ready Deposit before legacy post work', async () => {
    const row = makeTxnRow({
      qboType: 'Deposit',
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: true,
        taxSupportReason: null,
        cachedSalesCodes: [{
          active: true,
          taxable: true,
          salesTaxRateList: [{
            taxRateQboId: 'sales-rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          combinedSalesRate: 5,
        }],
      },
    });
    const fetchTxn = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn });

    await expect(
      postTransaction('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, {}, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
      message: 'Tax-ready Deposits must use staged categorization.',
    });
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
  });

  it('keeps a staged Deposit out of legacy post after sales-tax readiness is lost', async () => {
    const row = makeTxnRow({
      qboType: 'Deposit',
      taxCalculation: 'TaxInclusive',
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: false,
        taxSupportReason: 'References unavailable',
        cachedSalesCodes: [],
      },
    });
    const fetchTxn = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn });

    await expect(
      postTransaction('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, {}, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
  });

  it('keeps a transaction with a durable categorization attempt out of legacy post', async () => {
    const row = makeTxnRow({
      qboType: 'Deposit',
      taxCalculation: null,
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: false,
        cachedSalesCodes: [],
      },
    });
    const fetchTxn = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn });
    db.qboMutationAttempt.findFirst.mockResolvedValueOnce({ id: 'attempt-generic' });

    await expect(
      postTransaction('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, {}, deps),
    ).rejects.toMatchObject<WritebackLifecycleError>({
      code: 'TAX_AWARE_STAGING_REQUIRED',
    });
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
  });

  it('applies the tax-ready Purchase guard to every bulk item', async () => {
    const row = makeTxnRow({
      payee: 'Generic supplier',
      company: {
        id: 'company-generic',
        dryRun: false,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    const fetchTxn = vi.fn();
    const { deps, db } = makeDeps(row, { fetchTxn });

    const [result] = await bulkPost(
      ['transaction-generic'],
      { id: 'actor-generic', label: 'Generic actor' },
      deps,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'TAX_AWARE_STAGING_REQUIRED',
        message: 'Tax-ready Purchases must use staged categorization.',
      },
    });
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(fetchTxn).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported readiness', 'Purchase', 'unsupported', true],
    ['setup-incomplete readiness', 'Purchase', 'needs_setup', true],
    ['unavailable readiness', 'Purchase', undefined, undefined],
    ['sales-tax-disabled Deposit', 'Deposit', 'ready', false],
  ] as const)('preserves legacy behavior for %s', async (
    _case,
    qboType,
    taxSupportStatus,
    taxUsingSalesTax,
  ) => {
    const row = makeTxnRow({
      payee: 'Generic supplier',
      qboType,
      company: {
        id: 'company-generic',
        dryRun: true,
        tagsRequired: false,
        holdingAccountIds: ['4'],
        taxSupportStatus,
        taxUsingSalesTax,
      },
    });
    const fetchTxn = vi.fn(async () => ({ ...freshQboTxn(), qboType }));
    const { deps } = makeDeps(row, { fetchTxn });

    await expect(
      postTransaction('transaction-generic', { id: 'actor-generic', label: 'Generic actor' }, {}, deps),
    ).resolves.toMatchObject({ ok: true, status: 'DRY_RUN' });
    expect(fetchTxn).toHaveBeenCalledTimes(1);
  });

  it('rejects split lines that do not sum to the amount', async () => {
    const row = makeTxnRow({
      category: null,
      categoryQboId: null,
      splitLines: [
        { idx: 0, amount: -10, category: 'Office supplies', categoryQboId: null, memo: null, tags: [] },
        { idx: 1, amount: -10, category: 'Bank fees', categoryQboId: null, memo: null, tags: [] },
      ],
    });
    const { deps } = makeDeps(row, {});
    await expect(postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps)).rejects.toThrow(/add up/);
    expect(row.status).toBe('PENDING'); // guard fails before POSTING
  });

  it('rejects posting without a category or splits', async () => {
    const row = makeTxnRow({ category: null, categoryQboId: null });
    const { deps } = makeDeps(row, {});
    await expect(postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps)).rejects.toThrow(/category/i);
  });

  it('enforces tagsRequired', async () => {
    const row = makeTxnRow({ company: { id: 'co-1', dryRun: true, tagsRequired: true, holdingAccountIds: ['4'] } });
    const { deps } = makeDeps(row, { fetchTxn: async () => freshQboTxn() });
    await expect(postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps)).rejects.toThrow(/tag/);
  });

  it('enforces tagsRequired on EVERY split line (SplitLineTag rows)', async () => {
    const row = makeTxnRow({
      category: null,
      categoryQboId: null,
      splitLines: [
        { idx: 0, amount: -20, category: 'Office supplies', categoryQboId: null, memo: null, tags: [{ tagId: 'tag-x' }] },
        { idx: 1, amount: -9, category: 'Bank fees', categoryQboId: null, memo: null, tags: [] },
      ],
      company: { id: 'co-1', dryRun: true, tagsRequired: true, holdingAccountIds: ['4'] },
    });
    const { deps } = makeDeps(row, { fetchTxn: async () => freshQboTxn() });
    await expect(postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps)).rejects.toThrow(
      /tag on every split/,
    );
  });
});

// ---------------------------------------------------------------------------
// Durable prepared-write lifecycle
// ---------------------------------------------------------------------------

const DURABLE_COMPANY_ID = '00000000-0000-4000-8000-000000000110';
const DURABLE_TRANSACTION_ID = '00000000-0000-4000-8000-000000000120';
const DURABLE_ACTOR_ID = '00000000-0000-4000-8000-000000000130';
const DURABLE_TAG_ID = '00000000-0000-4000-8000-000000000140';

const beforePurchase: QboPurchaseSnapshot = {
  qboId: 'purchase-generic',
  syncToken: '7',
  totalCents: -1050,
  accountQboId: 'payment-generic',
  date: '2026-07-28',
  direction: 'purchase',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: 0,
  lines: [{
    id: 'line-holding',
    amountCents: -1050,
    description: null,
    accountQboId: 'holding-generic',
    customerQboId: null,
    classQboId: null,
    taxCodeQboId: null,
    taxAmountCents: null,
    taxInclusiveCents: null,
  }],
};

const expectedPurchase = {
  qboId: 'purchase-generic',
  totalCents: -1050,
  accountQboId: 'payment-generic',
  date: '2026-07-28',
  direction: 'purchase' as const,
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  targetLines: [{
    id: null,
    amountCents: -1000,
    description: 'Prepared purchase',
    accountQboId: 'expense-generic',
    customerQboId: null,
    classQboId: null,
    taxCodeQboId: 'tax-generic',
    taxAmountCents: -50,
    taxInclusiveCents: -1050,
  }],
  untouchedLineHashes: [],
};

const verifiedPurchase: QboPurchaseSnapshot = {
  ...beforePurchase,
  syncToken: '8',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  lines: [{ ...expectedPurchase.targetLines[0]!, id: 'line-posted' }],
};

const stagedPurchase: StagedCategorization = {
  transactionId: DURABLE_TRANSACTION_ID,
  revision: 1,
  taxCalculation: 'TaxInclusive',
  totals: { subtotalCents: -1000, taxCents: -50, totalCents: -1050 },
  lines: [{
    idx: 0,
    subtotalCents: -1000,
    taxCents: -50,
    totalCents: -1050,
    categoryQboId: 'expense-generic',
    taxCodeQboId: 'tax-generic',
    memo: 'Prepared purchase',
  }],
  tagIds: [],
};

const beforeDeposit: QboDepositSnapshot = {
  qboId: 'deposit-generic',
  syncToken: '7',
  totalCents: 1050,
  depositToAccountQboId: 'payment-generic',
  date: '2026-07-28',
  globalTaxCalculation: null,
  totalTaxCents: null,
  preservedHash: 'deposit-preserved',
  lines: [{
    id: 'line-holding',
    amountCents: 1050,
    description: null,
    accountQboId: 'holding-generic',
    entityQboId: 'entity-generic',
    paymentMethodQboId: null,
    classQboId: null,
    taxCodeQboId: null,
    taxApplicableOn: null,
    rawHash: 'holding-raw',
    targetHash: 'holding-target',
  }],
};

const expectedDeposit = {
  qboId: 'deposit-generic',
  totalCents: 1050,
  depositToAccountQboId: 'payment-generic',
  date: '2026-07-28',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: 50,
  preservedHash: 'deposit-preserved',
  targetLines: [{
    id: null,
    amountCents: 1050,
    description: 'Prepared deposit',
    accountQboId: 'income-generic',
    entityQboId: 'entity-generic',
    paymentMethodQboId: null,
    classQboId: null,
    taxCodeQboId: 'tax-generic',
    taxApplicableOn: 'Sales',
    rawHash: 'target-raw-before-id',
    targetHash: 'target-hash',
  }],
  untouchedLineHashes: [],
};

const verifiedDeposit: QboDepositSnapshot = {
  ...beforeDeposit,
  syncToken: '8',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: 50,
  lines: [{
    ...expectedDeposit.targetLines[0]!,
    id: 'line-posted',
    rawHash: 'target-raw-after-id',
  }],
};

const stagedDeposit: StagedCategorization = {
  transactionId: DURABLE_TRANSACTION_ID,
  revision: 1,
  taxCalculation: 'TaxInclusive',
  totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
  lines: [{
    idx: 0,
    subtotalCents: 1000,
    taxCents: 50,
    totalCents: 1050,
    categoryQboId: 'income-generic',
    taxCodeQboId: 'tax-generic',
    memo: 'Prepared deposit',
    tagIds: [],
  }],
  tagIds: [],
};

type PreparedEntity = 'Purchase' | 'Deposit';

function preparedWrite(
  requestId = 'request-generic',
  qboType: PreparedEntity = 'Purchase',
): QboPreparedWrite {
  if (qboType === 'Deposit') {
    const body: QboDepositPreparedWrite['body'] = {
      Id: 'deposit-generic',
      SyncToken: '7',
      TxnDate: '2026-07-28',
      TotalAmt: 10.5,
      DepositToAccountRef: { value: 'payment-generic' },
      GlobalTaxCalculation: 'TaxInclusive',
      Line: [{
        Amount: 10.5,
        Description: 'Prepared deposit',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'income-generic' },
          Entity: { value: 'entity-generic' },
          TaxCodeRef: { value: 'tax-generic' },
          TaxApplicableOn: 'Sales',
        },
      }],
    };
    return {
      operation: 'recategorize',
      qboType: 'Deposit',
      qboId: 'deposit-generic',
      requestId,
      requestHash: hashPreparedWriteBody(body),
      body,
      before: structuredClone(beforeDeposit),
      expected: structuredClone(expectedDeposit),
    };
  }
  const body = {
    Id: 'purchase-generic',
    SyncToken: '7',
    TxnDate: '2026-07-28',
    TotalAmt: 10.5,
    AccountRef: { value: 'payment-generic' },
    GlobalTaxCalculation: 'TaxInclusive',
    Line: [{
      Amount: 10,
      Description: 'Prepared purchase',
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'expense-generic' },
        TaxCodeRef: { value: 'tax-generic' },
        TaxAmount: 0.5,
        TaxInclusiveAmt: 10.5,
      },
    }],
  };
  return {
    operation: 'recategorize',
    qboType: 'Purchase',
    qboId: 'purchase-generic',
    requestId,
    requestHash: hashPreparedWriteBody(body),
    body,
    before: structuredClone(beforePurchase),
    expected: structuredClone(expectedPurchase),
  };
}

function restoredWrite(
  original: QboPreparedWrite,
  requestId: string,
): QboPreparedWrite {
  if (original.qboType === 'Deposit') {
    const body: QboDepositPreparedWrite['body'] = {
      Id: original.qboId,
      SyncToken: '8',
      TxnDate: '2026-07-28',
      TotalAmt: 10.5,
      DepositToAccountRef: { value: 'payment-generic' },
      Line: [{
        Id: 'line-holding',
        Amount: 10.5,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'holding-generic' },
          Entity: { value: 'entity-generic' },
        },
      }],
    };
    return {
      operation: 'restore',
      qboType: 'Deposit',
      qboId: original.qboId,
      requestId,
      requestHash: hashPreparedWriteBody(body),
      body,
      before: structuredClone(verifiedDeposit),
      expected: {
        qboId: original.before.qboId,
        totalCents: original.before.totalCents,
        depositToAccountQboId: original.before.depositToAccountQboId,
        date: original.before.date,
        globalTaxCalculation: original.before.globalTaxCalculation,
        totalTaxCents: original.before.totalTaxCents,
        preservedHash: original.before.preservedHash,
        targetLines: structuredClone(original.before.lines),
        untouchedLineHashes: [],
      },
    };
  }
  const prepared = preparedWrite(requestId);
  const body = { ...prepared.body, SyncToken: '8' };
  return {
    ...prepared,
    operation: 'restore',
    requestHash: hashPreparedWriteBody(body),
    body,
    before: structuredClone(verifiedPurchase),
    expected: {
      ...original.expected,
      globalTaxCalculation: original.before.globalTaxCalculation,
      totalTaxCents: original.before.totalTaxCents,
      targetLines: original.before.lines,
      untouchedLineHashes: [],
    },
  } as QboPreparedWrite;
}

interface DurableAttemptRow {
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
  createdAt: Date;
  updatedAt: Date;
}

function durableTransaction(qboType: PreparedEntity = 'Purchase') {
  const deposit = qboType === 'Deposit';
  return {
    id: DURABLE_TRANSACTION_ID,
    companyId: DURABLE_COMPANY_ID,
    qboId: deposit ? 'deposit-generic' : 'purchase-generic',
    qboType,
    qboSyncToken: '7',
    revision: 1,
    status: 'PENDING',
    amount: deposit ? 10.5 : -10.5,
    payee: deposit ? 'Generic Customer' : 'Generic Supplier',
    postedAt: null as Date | null,
    postedByUserId: null as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    taxCalculation: 'TaxInclusive',
    company: {
      id: DURABLE_COMPANY_ID,
      disconnectedAt: null as Date | null,
      dryRun: false,
      holdingAccountIds: ['holding-generic'],
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
      taxSupportReason: null,
    },
    splitLines: [{
      idx: 0,
      amount: deposit ? 10.5 : -10.5,
      category: deposit ? 'Prepared deposit' : 'Prepared purchase',
      categoryQboId: deposit ? 'income-generic' : 'expense-generic',
      taxCode: 'Generic tax',
      taxCodeQboId: 'tax-generic',
      memo: deposit ? 'Prepared deposit' : 'Prepared purchase',
      tags: deposit ? [] : [{ tagId: DURABLE_TAG_ID }],
    }],
    txnTags: deposit ? [] : [{ tagId: DURABLE_TAG_ID }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeDurableDb {
  transactionRow;
  attempts: DurableAttemptRow[] = [];
  failVerifiedCommitOnce = false;
  failUncertainTransactionOnce = false;
  failUncertainFallbackAndReadOnce = false;
  failCommittingOnce = false;
  failRetryableOnce = false;
  raceAttemptOnCreate = false;
  raceDifferentActiveAttemptOnCreate = false;
  raceAttemptHashOverride: string | null = null;
  private sequence = 0;
  private failNextAttemptRead = false;

  $queryRawUnsafe = vi.fn(async () => [{ locked: 1 }]);

  agentCompanyConfig = {
    findUnique: vi.fn(async () => ({ configVersion: 'verified-writeback-v1' })),
  };

  constructor(qboType: PreparedEntity = 'Purchase') {
    this.transactionRow = durableTransaction(qboType);
  }

  transaction = {
    findUnique: vi.fn(async () => this.transactionRow),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(this.transactionRow, data);
      return this.transactionRow;
    }),
    updateMany: vi.fn(async ({ where, data }: {
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
    }) => {
      const row = this.transactionRow;
      if (
        row.id !== where.id
        || row.companyId !== where.companyId
        || row.qboType !== where.qboType
        || row.qboId !== where.qboId
        || row.qboSyncToken !== where.qboSyncToken
        || row.revision !== where.revision
        || row.status !== where.status
      ) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };

  qboMutationAttempt = {
    findUnique: vi.fn(async ({ where }: { where: { requestId?: string; id?: string } }) => {
      if (this.failNextAttemptRead) {
        this.failNextAttemptRead = false;
        throw new Error('database unavailable during final uncertainty reread');
      }
      return this.attempts.find((row) =>
        where.requestId !== undefined ? row.requestId === where.requestId : row.id === where.id,
      ) ?? null;
    }),
    findFirst: vi.fn(async ({ where }: {
      where: {
        transactionId?: string;
        operation?: string;
        status?: string | { in: string[] };
      };
    }) => {
      const rows = this.attempts.filter((row) => {
        if (where.transactionId !== undefined && row.transactionId !== where.transactionId) return false;
        if (where.operation !== undefined && row.operation !== where.operation) return false;
        if (typeof where.status === 'string' && row.status !== where.status) return false;
        if (where.status && typeof where.status === 'object' && !where.status.in.includes(row.status)) return false;
        return true;
      });
      return rows.at(-1) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<DurableAttemptRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      if (this.raceDifferentActiveAttemptOnCreate) {
        this.raceDifferentActiveAttemptOnCreate = false;
        const now = new Date('2026-07-28T12:00:00.000Z');
        this.attempts.push({
          ...structuredClone(data),
          id: `attempt-${++this.sequence}`,
          requestId: 'request-concurrent-other',
          requestHash: 'concurrent-other-hash',
          requestPayload: { kind: 'concurrent-other-request' },
          status: 'PREPARED',
          createdAt: now,
          updatedAt: now,
        });
        const error = new Error('active transaction attempt unique');
        Object.assign(error, { code: 'P2002' });
        throw error;
      }
      if (this.attempts.some((row) => row.requestId === data.requestId)) {
        const error = new Error('unique');
        Object.assign(error, { code: 'P2002' });
        throw error;
      }
      const now = new Date('2026-07-28T12:00:00.000Z');
      const row: DurableAttemptRow = {
        ...structuredClone(data),
        id: `attempt-${++this.sequence}`,
        createdAt: now,
        updatedAt: now,
      };
      if (this.raceAttemptHashOverride !== null) {
        row.requestHash = this.raceAttemptHashOverride;
        if (row.requestPayload && typeof row.requestPayload === 'object') {
          Object.assign(row.requestPayload, { requestHash: this.raceAttemptHashOverride });
        }
      }
      this.attempts.push(row);
      if (this.raceAttemptOnCreate) {
        this.raceAttemptOnCreate = false;
        this.raceAttemptHashOverride = null;
        const error = new Error('concurrent unique request ID');
        Object.assign(error, { code: 'P2002' });
        throw error;
      }
      return row;
    }),
    update: vi.fn(async ({ where, data }: {
      where: { id: string };
      data: Partial<DurableAttemptRow>;
    }) => {
      if (data.status === 'VERIFIED' && this.failVerifiedCommitOnce) {
        this.failVerifiedCommitOnce = false;
        throw new Error('database commit failed');
      }
      if (data.status === 'COMMITTING' && this.failCommittingOnce) {
        this.failCommittingOnce = false;
        throw new Error('database failed before committing boundary');
      }
      if (data.status === 'RETRYABLE' && this.failRetryableOnce) {
        this.failRetryableOnce = false;
        throw new Error('database failed while marking retryable');
      }
      const row = this.attempts.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('attempt missing');
      Object.assign(row, structuredClone(data));
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: {
      where: { id: string; status: string | { in: string[] } };
      data: Partial<DurableAttemptRow>;
    }) => {
      if (data.status === 'VERIFIED' && this.failVerifiedCommitOnce) {
        this.failVerifiedCommitOnce = false;
        throw new Error('database commit failed');
      }
      if (data.status === 'UNCERTAIN' && this.failUncertainFallbackAndReadOnce) {
        this.failUncertainFallbackAndReadOnce = false;
        this.failNextAttemptRead = true;
        throw new Error('database unavailable during uncertainty fallback');
      }
      if (data.status === 'COMMITTING' && this.failCommittingOnce) {
        this.failCommittingOnce = false;
        throw new Error('database failed before committing boundary');
      }
      if (data.status === 'RETRYABLE' && this.failRetryableOnce) {
        this.failRetryableOnce = false;
        throw new Error('database failed while marking retryable');
      }
      const row = this.attempts.find((candidate) => {
        if (candidate.id !== where.id) return false;
        return typeof where.status === 'string'
          ? candidate.status === where.status
          : where.status.in.includes(candidate.status);
      });
      if (!row) return { count: 0 };
      Object.assign(row, structuredClone(data));
      return { count: 1 };
    }),
  };

  qboAccount = {
    findMany: vi.fn(async ({ where }: { where: { qboId: { in: string[] } } }) =>
      where.qboId.in.includes('expense-generic')
        ? [{ qboId: 'expense-generic', active: true }]
        : where.qboId.in.includes('income-generic')
          ? [{ qboId: 'income-generic', active: true }]
        : []),
  };

  qboTaxCode = {
    findMany: vi.fn(async () => [{
      qboId: 'tax-generic',
      name: 'Generic tax',
      active: true,
      taxable: true,
      purchaseTaxRateList: [{
        taxRateQboId: 'rate-generic',
        taxTypeApplicable: 'TaxOnAmount',
      }],
      salesTaxRateList: [{
        taxRateQboId: 'rate-generic',
        taxTypeApplicable: 'TaxOnAmount',
      }],
      combinedSalesRate: 5,
    }]),
  };

  qboTaxRate = {
    findMany: vi.fn(async () => [{
      qboId: 'rate-generic',
      name: 'Generic rate',
      active: true,
      rateValue: 5,
    }]),
  };

  async $transaction<T>(callback: (tx: FakeDurableDb) => Promise<T>): Promise<T> {
    if (
      this.failUncertainTransactionOnce &&
      this.attempts.some((attempt) => attempt.status === 'COMMITTING')
    ) {
      this.failUncertainTransactionOnce = false;
      throw new Error('database unavailable while persisting uncertainty');
    }
    const transactionBefore = structuredClone(this.transactionRow);
    const attemptsBefore = structuredClone(this.attempts);
    try {
      return await callback(this);
    } catch (error) {
      const concurrentAttempts = (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'P2002'
      ) ? this.attempts : null;
      this.transactionRow = transactionBefore;
      this.attempts = concurrentAttempts ?? attemptsBefore;
      throw error;
    }
  }
}

function currentQboTxn(
  syncToken = '7',
  qboType: PreparedEntity = 'Purchase',
): QboTxn {
  const deposit = qboType === 'Deposit';
  return {
    qboId: deposit ? 'deposit-generic' : 'purchase-generic',
    qboType,
    syncToken,
    date: '2026-07-28',
    payee: deposit ? 'Generic Customer' : 'Generic Supplier',
    amount: deposit ? 10.5 : -10.5,
    bankAccount: 'Generic payment account',
    lines: [{
      id: 'line-holding',
      amount: 10.5,
      accountQboId: 'holding-generic',
      accountName: 'Holding',
    }],
    raw: {},
  };
}

function durableDeps(
  db = new FakeDurableDb(),
  overrides: Partial<DurableWritebackDeps> = {},
) {
  const qboType = db.transactionRow.qboType as PreparedEntity;
  const beforeSnapshot =
    qboType === 'Deposit' ? beforeDeposit : beforePurchase;
  const verifiedSnapshot =
    qboType === 'Deposit' ? verifiedDeposit : verifiedPurchase;
  const audit = vi.fn(async () => undefined);
  const prepareRecategorization = vi.fn(async (
    _txn: QboTxn,
    _staged: StagedCategorization,
    before: QboPurchaseSnapshot | QboDepositSnapshot,
    requestId: string,
  ) => {
    const prepared = preparedWrite(requestId, qboType);
    const body = { ...prepared.body, SyncToken: before.syncToken };
    return {
      ...prepared,
      requestHash: hashPreparedWriteBody(body),
      body,
      before: structuredClone(before),
    } as QboPreparedWrite;
  });
  const prepareRestore = vi.fn(async (
    _txn: QboTxn,
    original: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPreparedWrite> => restoredWrite(original, requestId));
  const sendPreparedWrite = vi.fn(async (prepared: QboPreparedWrite) => ({
    ok: true as const,
    newSyncToken: prepared.operation === 'restore' ? '9' : '8',
  }));
  const fetchPreparedSnapshot = vi
    .fn<() => Promise<QboPurchaseSnapshot | QboDepositSnapshot | null>>()
    .mockResolvedValueOnce(structuredClone(beforeSnapshot))
    .mockResolvedValue(structuredClone(verifiedSnapshot));
  const fetchWriteSafety = vi.fn(async () => ({
    bookCloseDate: null,
    cleared: false,
    reconciled: false,
  }));
  const client: Partial<QboClient> = {
    fetchTxn: vi.fn(async () => currentQboTxn('7', qboType)),
    fetchPreparedSnapshot,
    fetchWriteSafety,
    prepareRecategorization,
    prepareRestore,
    sendPreparedWrite,
  };
  Object.assign(client, {
    fetchPurchaseSnapshot: fetchPreparedSnapshot,
    preparePurchaseRecategorization: prepareRecategorization,
    preparePurchaseRestore: prepareRestore,
  });
  const getClient = vi.fn(async () => client as QboClient);
  const authorize = vi.fn(async () => true);
  const renewLease = vi.fn(async () => undefined);
  const leaseOwners: string[] = [];
  let invocationSequence = 0;
  const invocationId = vi.fn(() => `invocation-${++invocationSequence}`);
  const onVerifiedCategorizationOutcome = vi.fn(async () => undefined);
  const deps: DurableWritebackDeps = {
    db: db as unknown as DurableWritebackDb,
    getClient,
    audit,
    authorize,
    envDryRun: false,
    lease: async (_key, owner, callback) => {
      leaseOwners.push(owner);
      return callback();
    },
    renewLease,
    invocationId,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    onVerifiedCategorizationOutcome,
    ...overrides,
  };
  return {
    db,
    deps,
    audit,
    authorize,
    renewLease,
    invocationId,
    onVerifiedCategorizationOutcome,
    leaseOwners,
    client,
    getClient,
    preparePurchaseRecategorization: prepareRecategorization,
    preparePurchaseRestore: prepareRestore,
    prepareRecategorization,
    prepareRestore,
    sendPreparedWrite,
    fetchPurchaseSnapshot: fetchPreparedSnapshot,
    fetchPreparedSnapshot,
    fetchWriteSafety,
  };
}

function commitInput(requestId = 'request-generic') {
  return {
    transactionId: DURABLE_TRANSACTION_ID,
    companyId: DURABLE_COMPANY_ID,
    expectedRevision: 1,
    requestId,
    actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
  };
}

function seedAttempt(
  db: FakeDurableDb,
  status: string,
  requestId = 'request-existing',
  operation = 'recategorize',
): DurableAttemptRow {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const qboType = db.transactionRow.qboType as PreparedEntity;
  const beforeSnapshot =
    qboType === 'Deposit' ? beforeDeposit : beforePurchase;
  const verifiedSnapshot =
    qboType === 'Deposit' ? verifiedDeposit : verifiedPurchase;
  const recategorization = preparedWrite(requestId, qboType);
  const persisted = operation === 'restore'
    ? restoredWrite(recategorization, requestId)
    : recategorization;
  const row: DurableAttemptRow = {
    id: `seed-${db.attempts.length + 1}`,
    transactionId: DURABLE_TRANSACTION_ID,
    requestId,
    operation,
    status,
    expectedRevision: 1,
    expectedSyncToken: operation === 'restore' ? '8' : '7',
    requestHash: persisted.requestHash,
    requestPayload: persisted,
    beforeSnapshot: structuredClone(
      operation === 'restore' ? verifiedSnapshot : beforeSnapshot,
    ),
    responseSnapshot:
      status === 'VERIFIED'
        ? structuredClone(
            operation === 'restore'
              ? { ...beforeSnapshot, syncToken: '9' }
              : verifiedSnapshot,
          )
        : null,
    verification:
      status === 'VERIFIED'
        ? {
            outcome: 'VERIFIED',
            status: operation === 'restore' ? 'REVERTED' : 'POSTED',
            newSyncToken: operation === 'restore' ? '9' : '8',
          }
        : null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
  db.attempts.push(row);
  return row;
}

function withPreparedQboId(
  prepared: QboPreparedWrite,
  qboId: string,
): QboPreparedWrite {
  const changed = structuredClone(prepared);
  changed.qboId = qboId;
  changed.body.Id = qboId;
  changed.before.qboId = qboId;
  changed.expected.qboId = qboId;
  return changed;
}

function withPreparedBeforeTotal(
  prepared: QboPreparedWrite,
  totalCents: number,
): QboPreparedWrite {
  const changed = structuredClone(prepared);
  changed.before.totalCents = totalCents;
  return changed;
}

function pauseCommittingTransitions(db: FakeDurableDb, expectedArrivals: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let resolveArrivals!: () => void;
  const arrivals = new Promise<void>((resolve) => {
    resolveArrivals = resolve;
  });
  const pause = async (): Promise<void> => {
    arrived += 1;
    if (arrived === expectedArrivals) resolveArrivals();
    await gate;
  };
  const update = db.qboMutationAttempt.update.getMockImplementation()!;
  db.qboMutationAttempt.update.mockImplementation(async (args) => {
    if (args.data.status === 'COMMITTING') await pause();
    return update(args);
  });
  const updateMany = db.qboMutationAttempt.updateMany.getMockImplementation()!;
  db.qboMutationAttempt.updateMany.mockImplementation(async (args) => {
    if (args.data.status === 'COMMITTING') await pause();
    return updateMany(args);
  });
  return { arrivals, release };
}

describe('commitStagedCategorization durable lifecycle', () => {
  it('keeps null actors forbidden on the public durable write path', async () => {
    const fixture = durableDeps();
    fixture.authorize.mockImplementation(async (actorId) => actorId !== null);

    await expect(commitStagedCategorization({
      ...commitInput(),
      actor: { id: null, label: 'Untrusted system input' },
    }, fixture.deps)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['Purchase', { bookCloseDate: '2026-07-28', cleared: false, reconciled: false }, 'QBO_PERIOD_CLOSED'],
    ['Deposit', { bookCloseDate: null, cleared: false, reconciled: true }, 'QBO_TRANSACTION_LOCKED'],
  ] as const)(
    'blocks a safety-locked %s before COMMITTING or sending',
    async (qboType, evidence, code) => {
      const fixture = durableDeps(new FakeDurableDb(qboType));
      fixture.fetchWriteSafety.mockResolvedValueOnce(evidence);

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code });

      expect(fixture.fetchWriteSafety).toHaveBeenCalledWith({
        qboType,
        qboId: qboType === 'Purchase' ? 'purchase-generic' : 'deposit-generic',
        txnDate: '2026-07-28',
        bankAccountQboId: 'payment-generic',
      });
      expect(fixture.db.attempts).toHaveLength(0);
      expect(fixture.prepareRecategorization).not.toHaveBeenCalled();
      expect(fixture.db.qboMutationAttempt.updateMany.mock.calls).not.toContainEqual([
        expect.objectContaining({ data: { status: 'COMMITTING' } }),
      ]);
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();

      const retry = durableDeps(fixture.db);
      await expect(
        commitStagedCategorization(commitInput(), retry.deps),
      ).resolves.toMatchObject({ ok: true, outcome: 'VERIFIED' });
    },
  );

  it('loads only active tax rates so inactive legacy null rows cannot break a live commit', async () => {
    const fixture = durableDeps();
    fixture.db.qboTaxRate.findMany.mockImplementation(async (args) => {
      if (args?.where?.active !== true) {
        const error = new Error('legacy nullable tax rate');
        Object.assign(error, { code: 'P2032' });
        throw error;
      }
      return [{
        qboId: 'rate-generic',
        name: 'Generic rate',
        active: true,
        rateValue: 5,
      }];
    });

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ ok: true, outcome: 'VERIFIED', status: 'POSTED' });
    expect(fixture.db.qboTaxRate.findMany).toHaveBeenCalledWith({
      where: {
        companyId: DURABLE_COMPANY_ID,
        active: true,
        rateValue: { not: null },
      },
    });
  });

  it('rejects a mismatched expected stage hash before QBO access on a fresh commit', async () => {
    const fixture = durableDeps();

    await expect(
      commitStagedCategorization({
        ...commitInput(),
        expectedStageHash: 'not-the-current-stage-hash',
        authorization: {
          kind: 'mcp',
          tokenId: 'token-generic',
          tokenPrefix: 'mcp_generic',
        },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'STALE_STAGE' });

    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRecategorization).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('reconstructs and durably replays an exact preserve-current Purchase stage', async () => {
    const fixture = durableDeps();
    fixture.db.transactionRow.taxCalculation = 'NotApplicable';
    fixture.db.transactionRow.splitLines = [{
      idx: 0,
      amount: -10.5,
      category: 'Bank Charges',
      categoryQboId: 'expense-generic',
      taxCode: 'Non-taxable',
      taxCodeQboId: 'NON',
      memo: null,
      tags: [],
    }];
    fixture.db.transactionRow.txnTags = [];
    const preserved: StagedCategorization = {
      transactionId: DURABLE_TRANSACTION_ID,
      revision: 1,
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      totals: { subtotalCents: -1050, taxCents: 0, totalCents: -1050 },
      lines: [{
        idx: 0,
        subtotalCents: -1050,
        taxCents: 0,
        totalCents: -1050,
        categoryQboId: 'expense-generic',
        taxCodeQboId: 'NON',
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    };
    const input = {
      ...commitInput('request-preserve-current'),
      expectedTaxDisposition: 'preserve_current' as const,
      expectedStageHash: hashStagedCategorization(preserved),
    };

    const first = await commitStagedCategorization(input, fixture.deps);
    const persistedBody = structuredClone(fixture.db.attempts[0]!.requestPayload);
    const replay = await commitStagedCategorization(input, fixture.deps);

    expect(first).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(replay).toEqual(first);
    expect(fixture.prepareRecategorization).toHaveBeenCalledWith(
      expect.anything(),
      preserved,
      expect.anything(),
      'request-preserve-current',
    );
    expect(fixture.db.attempts[0]!.requestPayload).toEqual(persistedBody);
    expect(fixture.prepareRecategorization).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched expected stage hash before QBO access on PREPARED resume', async () => {
    const fixture = durableDeps();
    seedAttempt(fixture.db, 'PREPARED', 'request-generic');

    await expect(
      commitStagedCategorization({
        ...commitInput(),
        expectedStageHash: 'not-the-current-stage-hash',
        authorization: {
          kind: 'mcp',
          tokenId: 'token-generic',
          tokenPrefix: 'mcp_generic',
        },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'STALE_STAGE' });

    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('emits the canonical staged categorization only after the verified state is durable', async () => {
    const fixture = durableDeps();
    fixture.onVerifiedCategorizationOutcome.mockImplementationOnce(async (outcome) => {
      expect(fixture.db.attempts[0]?.status).toBe('VERIFIED');
      expect(fixture.db.transactionRow.status).toBe('POSTED');
      expect(outcome).toEqual({
        companyId: DURABLE_COMPANY_ID,
        transactionId: DURABLE_TRANSACTION_ID,
        inputRevision: 1,
        requestId: 'request-generic',
        operation: 'posted',
        proposal: {
          taxCalculation: 'TaxInclusive',
          lines: [{
            idx: 0,
            subtotalCents: -1000,
            taxCents: -50,
            totalCents: -1050,
            categoryQboId: 'expense-generic',
            taxCodeQboId: 'tax-generic',
            memo: 'Prepared purchase',
            tagIds: [DURABLE_TAG_ID],
          }],
          tagIds: [DURABLE_TAG_ID],
        },
        candidateContext: {
          schemaVersion: 'rule-candidate-v1',
          matchField: 'payee',
          matchText: 'generic supplier',
          conditionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          configVersion: 'verified-writeback-v1',
          source: 'user',
        },
      });
    });

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(fixture.onVerifiedCategorizationOutcome).toHaveBeenCalledTimes(1);
  });

  it('keeps a verified write verified when evidence evaluation fails and retries the hook on replay', async () => {
    const fixture = durableDeps();
    fixture.onVerifiedCategorizationOutcome.mockRejectedValue(new Error('evaluation unavailable'));

    const first = await commitStagedCategorization(commitInput(), fixture.deps);
    const replay = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(first).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(replay).toEqual(first);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.onVerifiedCategorizationOutcome).toHaveBeenCalledTimes(2);
  });

  it('does not emit evidence outcomes for dry runs or uncertain writes', async () => {
    const dryRun = durableDeps();
    dryRun.db.transactionRow.company.dryRun = true;
    await commitStagedCategorization(commitInput(), dryRun.deps);
    expect(dryRun.onVerifiedCategorizationOutcome).not.toHaveBeenCalled();

    const uncertain = durableDeps();
    uncertain.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(beforePurchase))
      .mockResolvedValueOnce({ ...structuredClone(verifiedPurchase), totalCents: -999 });
    await commitStagedCategorization(commitInput(), uncertain.deps);
    expect(uncertain.onVerifiedCategorizationOutcome).not.toHaveBeenCalled();
  });

  it('does not replay an old posted outcome over a newer revision post', async () => {
    const fixture = durableDeps();
    await commitStagedCategorization(commitInput(), fixture.deps);
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({ ...structuredClone(beforePurchase), syncToken: '9' });
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockResolvedValue(currentQboTxn('8'));

    await undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps);

    fixture.db.transactionRow.status = 'PENDING';
    fixture.db.transactionRow.revision = 2;
    fixture.db.transactionRow.qboSyncToken = '9';
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce({ ...structuredClone(beforePurchase), syncToken: '9' })
      .mockResolvedValueOnce({ ...structuredClone(verifiedPurchase), syncToken: '10' });
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockResolvedValue(currentQboTxn('9'));
    await commitStagedCategorization({
      ...commitInput('request-new-revision'),
      expectedRevision: 2,
    }, fixture.deps);

    await commitStagedCategorization(commitInput(), fixture.deps);

    expect(fixture.onVerifiedCategorizationOutcome.mock.calls.map(([outcome]) => [
      outcome.operation,
      outcome.requestId,
    ])).toEqual([
      ['posted', 'request-generic'],
      ['reverted', 'request-undo'],
      ['posted', 'request-new-revision'],
    ]);
  });

  it('threads MCP authorization through the initial and final pre-send checks', async () => {
    const fixture = durableDeps();
    const authorization = {
      kind: 'mcp' as const,
      tokenId: 'token-generic',
      tokenPrefix: 'mcp_generic',
    };

    await commitStagedCategorization({
      ...commitInput(),
      authorization,
    }, fixture.deps);

    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.authorize).toHaveBeenNthCalledWith(
      1,
      DURABLE_ACTOR_ID,
      DURABLE_COMPANY_ID,
      authorization,
    );
    expect(fixture.authorize).toHaveBeenNthCalledWith(
      2,
      DURABLE_ACTOR_ID,
      DURABLE_COMPANY_ID,
      authorization,
    );
  });

  it('renews the entity lease before preparation and again immediately before send', async () => {
    const fixture = durableDeps();

    await commitStagedCategorization(commitInput(), fixture.deps);

    expect(fixture.renewLease).toHaveBeenCalledTimes(2);
    expect(fixture.renewLease).toHaveBeenNthCalledWith(1, {
      companyId: DURABLE_COMPANY_ID,
      qboType: 'Purchase',
      qboId: 'purchase-generic',
    }, 'invocation-1');
  });

  it('reloads the authorized revision after a blocked final lease renewal and never enters COMMITTING when it changed', async () => {
    const fixture = durableDeps();
    let finalRenewStarted!: () => void;
    const atFinalRenew = new Promise<void>((resolve) => {
      finalRenewStarted = resolve;
    });
    let releaseFinalRenew!: () => void;
    const finalRenewGate = new Promise<void>((resolve) => {
      releaseFinalRenew = resolve;
    });
    fixture.renewLease
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        finalRenewStarted();
        await finalRenewGate;
      });

    const committing = commitStagedCategorization(commitInput(), fixture.deps);
    await atFinalRenew;
    fixture.db.transactionRow.revision = 2;
    releaseFinalRenew();

    await expect(committing).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(fixture.db.attempts).toHaveLength(1);
    expect(fixture.db.attempts[0]?.status).toBe('RETRYABLE');
    expect(fixture.db.qboMutationAttempt.updateMany.mock.calls).not.toContainEqual([
      expect.objectContaining({ data: { status: 'COMMITTING' } }),
    ]);
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['QBO type', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboType = 'Bill';
    }],
    ['QBO id', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboId = 'different-purchase';
    }],
    ['QBO SyncToken', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboSyncToken = 'different-sync';
    }],
  ] as const)(
    'rejects same-revision %s tampering before QBO client construction',
    async (_label, tamper) => {
      const fixture = durableDeps();
      tamper(fixture);

      await expect(
        commitStagedCategorization({
          ...commitInput(),
          expectedQboBinding: {
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            qboSyncToken: '7',
          },
        }, fixture.deps),
      ).rejects.toMatchObject({ code: 'STALE_QBO_BINDING' });

      expect(fixture.getClient).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['QBO type', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboType = 'Bill';
    }],
    ['QBO id', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboId = 'different-purchase';
    }],
    ['QBO SyncToken', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.qboSyncToken = 'different-sync';
    }],
  ] as const)(
    'rejects same-revision %s tampering at the final gate before send',
    async (_label, tamper) => {
      const fixture = durableDeps();
      fixture.renewLease.mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          tamper(fixture);
        });

      await expect(
        commitStagedCategorization({
          ...commitInput(),
          expectedQboBinding: {
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            qboSyncToken: '7',
          },
        }, fixture.deps),
      ).rejects.toMatchObject({ code: 'STALE_QBO_BINDING' });

      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
      expect(fixture.db.attempts[0]?.status).toBe('RETRYABLE');
    },
  );

  it('persists the exact prepared request before one send and returns the recorded result idempotently', async () => {
    const fixture = durableDeps();
    fixture.sendPreparedWrite.mockImplementationOnce(async (prepared) => {
      expect(fixture.db.attempts[0]).toMatchObject({
        requestId: 'request-generic',
        status: 'COMMITTING',
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash: prepared.requestHash,
        beforeSnapshot: beforePurchase,
        requestPayload: prepared,
      });
      return { ok: true, newSyncToken: '8' };
    });

    const first = await commitStagedCategorization(commitInput(), fixture.deps);
    const second = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(first).toMatchObject({ ok: true, status: 'POSTED', outcome: 'VERIFIED' });
    expect(second).toEqual(first);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.db.attempts).toHaveLength(1);
    expect(fixture.db.attempts[0]?.status).toBe('VERIFIED');
    expect(fixture.db.transactionRow).toMatchObject({
      status: 'POSTED',
      qboSyncToken: '8',
      errorCode: null,
    });
  });

  it('replays a recorded verified commit after disconnect without another QBO client or send', async () => {
    const fixture = durableDeps();
    const first = await commitStagedCategorization(commitInput(), fixture.deps);
    fixture.db.transactionRow.company.disconnectedAt = new Date();

    const duplicate = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(duplicate).toEqual(first);
    expect(fixture.getClient).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.authorize).toHaveBeenCalledTimes(3);
  });

  it('rejects a persisted FAILED replay as fixed non-retryable exhaustion', async () => {
    const fixture = durableDeps();
    const attempt = seedAttempt(fixture.db, 'FAILED', 'request-generic');
    attempt.errorCode = 'LIVE_MUTATION_RETRY_EXHAUSTED';
    attempt.errorMessage = 'The guarded live mutation exhausted its retry budget.';

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({
      code: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      message: 'The guarded live mutation exhausted its retry budget.',
    });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rechecks authorization before returning a recorded verified commit result', async () => {
    const fixture = durableDeps();
    await commitStagedCategorization(commitInput(), fixture.deps);
    fixture.authorize.mockResolvedValue(false);

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed recorded before/response snapshots with stable ATTEMPT_CORRUPT', async () => {
    const fixture = durableDeps();
    const attempt = seedAttempt(fixture.db, 'VERIFIED', 'request-generic');
    fixture.db.transactionRow.status = 'POSTED';
    attempt.beforeSnapshot = { ...structuredClone(beforePurchase), lines: [{}] };

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['missing response', null],
    ['wrong response SyncToken', { ...structuredClone(verifiedPurchase), syncToken: '999' }],
    ['unverified response contents', { ...structuredClone(verifiedPurchase), totalCents: -999 }],
  ])('rejects VERIFIED terminal evidence with %s', async (_label, responseSnapshot) => {
    const fixture = durableDeps();
    const attempt = seedAttempt(fixture.db, 'VERIFIED', 'request-generic');
    fixture.db.transactionRow.status = 'POSTED';
    attempt.responseSnapshot = responseSnapshot;

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rejects a valid-looking prepared body whose persisted request hash was not recomputed', async () => {
    const fixture = durableDeps();
    const attempt = seedAttempt(fixture.db, 'PREPARED', 'request-generic');
    const payload = structuredClone(attempt.requestPayload) as QboPreparedWrite;
    payload.body.Line[0]!.Description = 'coordinated payload change';
    attempt.requestPayload = payload;

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rejects UNCHANGED evidence unless its response exactly equals the before-image', async () => {
    const fixture = durableDeps();
    const attempt = seedAttempt(fixture.db, 'VERIFIED', 'request-generic');
    fixture.db.transactionRow.status = 'PENDING';
    attempt.status = 'UNCHANGED';
    attempt.responseSnapshot = { ...structuredClone(beforePurchase), totalCents: -999 };
    attempt.verification = { outcome: 'UNCHANGED', status: 'PENDING' };

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rejects reuse of a request ID at a different expected revision', async () => {
    const fixture = durableDeps();
    seedAttempt(fixture.db, 'VERIFIED', 'request-generic');
    fixture.db.transactionRow.revision = 2;
    fixture.db.transactionRow.status = 'POSTED';

    await expect(
      commitStagedCategorization({
        ...commitInput(),
        expectedRevision: 2,
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('maps a concurrent attempt-create uniqueness race to a recorded resumable result without sending', async () => {
    const fixture = durableDeps();
    fixture.db.raceAttemptOnCreate = true;

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      outcome: 'IN_PROGRESS',
      error: { code: 'MUTATION_IN_PROGRESS' },
    });
    expect(fixture.db.attempts).toHaveLength(1);
    expect(fixture.db.attempts[0]?.status).toBe('PREPARED');
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('maps a concurrent request-ID race with a different prepared hash to REQUEST_ID_CONFLICT', async () => {
    const fixture = durableDeps();
    fixture.db.raceAttemptOnCreate = true;
    fixture.db.raceAttemptHashOverride = 'different-prepared-hash';

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('fails closed when a different active request wins the attempt persistence race', async () => {
    const fixture = durableDeps();
    fixture.db.raceDifferentActiveAttemptOnCreate = true;

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });

    expect(fixture.db.attempts).toHaveLength(1);
    expect(fixture.db.attempts[0]).toMatchObject({
      transactionId: DURABLE_TRANSACTION_ID,
      requestId: 'request-concurrent-other',
      status: 'PREPARED',
    });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('safely resumes the same PREPARED request after restart without re-preparing', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    const restarted = durableDeps(db);

    const result = await commitStagedCategorization(commitInput(), restarted.deps);

    expect(result).toMatchObject({ ok: true, outcome: 'VERIFIED', status: 'POSTED' });
    expect(restarted.preparePurchaseRecategorization).not.toHaveBeenCalled();
    expect(restarted.authorize).toHaveBeenCalledTimes(2);
    expect(restarted.renewLease).toHaveBeenCalledTimes(1);
    expect(restarted.leaseOwners).toHaveLength(1);
    expect(restarted.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('rechecks closed-period safety when resuming a persisted PREPARED request', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    const restarted = durableDeps(db);
    restarted.fetchWriteSafety.mockResolvedValueOnce({
      bookCloseDate: '2026-07-28',
      cleared: false,
      reconciled: false,
    });

    await expect(
      commitStagedCategorization(commitInput(), restarted.deps),
    ).rejects.toMatchObject({ code: 'QBO_PERIOD_CLOSED' });

    expect(restarted.preparePurchaseRecategorization).not.toHaveBeenCalled();
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
    expect(db.attempts[0]).toMatchObject({
      status: 'RETRYABLE',
      errorCode: 'QBO_PERIOD_CLOSED',
    });
  });

  it('resumes a persisted PREPARED request when current account and tax references are unavailable', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    db.transactionRow.company.taxSupportStatus = 'needs_setup';
    db.transactionRow.company.taxUsingSalesTax = false;
    db.qboAccount.findMany.mockResolvedValue([]);
    db.qboTaxCode.findMany.mockResolvedValue([]);
    db.qboTaxRate.findMany.mockResolvedValue([]);
    const restarted = durableDeps(db);

    const result = await commitStagedCategorization(commitInput(), restarted.deps);

    expect(result).toMatchObject({ ok: true, outcome: 'VERIFIED', status: 'POSTED' });
    expect(db.qboAccount.findMany).not.toHaveBeenCalled();
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(db.qboTaxRate.findMany).not.toHaveBeenCalled();
    expect(restarted.preparePurchaseRecategorization).not.toHaveBeenCalled();
    expect(restarted.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong entity ID', (attempt: DurableAttemptRow) => {
      attempt.requestPayload = withPreparedQboId(
        attempt.requestPayload as QboPreparedWrite,
        'purchase-other',
      );
    }],
    ['wrong entity type', (attempt: DurableAttemptRow) => {
      attempt.requestPayload = preparedWrite(attempt.requestId, 'Deposit');
      attempt.beforeSnapshot = structuredClone(beforeDeposit);
    }],
    ['wrong request ID', (attempt: DurableAttemptRow) => {
      (attempt.requestPayload as QboPreparedWrite).requestId = 'request-other';
    }],
    ['wrong operation', (attempt: DurableAttemptRow) => {
      (attempt.requestPayload as QboPreparedWrite).operation = 'restore';
    }],
    ['before snapshot mismatch', (attempt: DurableAttemptRow) => {
      attempt.beforeSnapshot = {
        ...structuredClone(beforePurchase),
        totalCents: -999,
      };
    }],
  ] as const)(
    'rejects a PREPARED resume bound to the %s before QBO access',
    async (_label, mutate) => {
      const fixture = durableDeps();
      const attempt = seedAttempt(fixture.db, 'PREPARED', 'request-generic');
      mutate(attempt);

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
      expect(fixture.getClient).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['wrong operation', (prepared: QboPreparedWrite) => {
      prepared.operation = 'restore';
      return prepared;
    }],
    ['wrong request ID', (prepared: QboPreparedWrite) => {
      prepared.requestId = 'request-other';
      return prepared;
    }],
    ['wrong entity type', () => preparedWrite('request-generic', 'Deposit')],
    ['wrong entity ID', (prepared: QboPreparedWrite) =>
      withPreparedQboId(prepared, 'purchase-other')],
    ['wrong before snapshot', (prepared: QboPreparedWrite) =>
      withPreparedBeforeTotal(prepared, -999)],
  ] as const)(
    'rejects a freshly prepared recategorization with %s before persistence or send',
    async (_label, mutate) => {
      const fixture = durableDeps();
      fixture.prepareRecategorization.mockResolvedValueOnce(
        mutate(preparedWrite('request-generic')),
      );

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });
      expect(fixture.db.attempts).toHaveLength(0);
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['authorization', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.authorize.mockResolvedValue(false);
    }, 'FORBIDDEN'],
    ['revision', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.revision = 2;
    }, 'STALE_REVISION'],
    ['QuickBooks drift', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.fetchPurchaseSnapshot.mockReset().mockResolvedValue({
        ...structuredClone(beforePurchase),
        totalCents: -999,
      });
    }, 'QBO_STATE_DRIFT'],
  ] as const)(
    'rechecks %s before sending a resumed PREPARED recategorization',
    async (_label, mutate, code) => {
      const fixture = durableDeps();
      seedAttempt(fixture.db, 'PREPARED', 'request-generic');
      mutate(fixture);

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code });

      expect(fixture.leaseOwners).toHaveLength(1);
      expect(fixture.preparePurchaseRecategorization).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it('rejects a disconnected PREPARED commit resume before QBO access', async () => {
    const fixture = durableDeps();
    seedAttempt(fixture.db, 'PREPARED', 'request-generic');
    fixture.db.transactionRow.company.disconnectedAt = new Date();

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('allows exactly one COMMITTING winner and one send for concurrent same-request PREPARED commit resumes', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    const fixture = durableDeps(db);
    const barrier = pauseCommittingTransitions(db, 2);
    let qboSnapshot = structuredClone(beforePurchase);
    fixture.fetchPurchaseSnapshot.mockImplementation(async () => structuredClone(qboSnapshot));
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => currentQboTxn(qboSnapshot.syncToken),
    );
    fixture.sendPreparedWrite.mockImplementation(async () => {
      qboSnapshot = structuredClone(verifiedPurchase);
      return { ok: true, newSyncToken: '8' };
    });

    const callerA = commitStagedCategorization(commitInput(), fixture.deps);
    const callerB = commitStagedCategorization(commitInput(), fixture.deps);
    await barrier.arrivals;
    barrier.release();
    const results = await Promise.all([callerA, callerB]);

    expect(fixture.leaseOwners).toHaveLength(2);
    expect(new Set(fixture.leaseOwners).size).toBe(2);
    expect(fixture.leaseOwners).not.toContain('request-generic');
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.outcome === 'VERIFIED')).toBe(true);
    expect(results.every((result) =>
      result.outcome === 'VERIFIED' || result.outcome === 'IN_PROGRESS')).toBe(true);
    expect(db.attempts[0]?.status).toBe('VERIFIED');
    expect(db.transactionRow.status).toBe('POSTED');
  });

  it('does not let a stale pre-send catch regress a concurrently VERIFIED attempt to RETRYABLE', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    const fixture = durableDeps(db);
    let releaseCallerA!: () => void;
    const callerAGate = new Promise<void>((resolve) => {
      releaseCallerA = resolve;
    });
    let callerAStarted!: () => void;
    const callerAAtProof = new Promise<void>((resolve) => {
      callerAStarted = resolve;
    });
    let qboSnapshot = structuredClone(beforePurchase);
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockImplementationOnce(async () => {
        callerAStarted();
        await callerAGate;
        throw new Error('stale pre-send read failed');
      })
      .mockImplementation(async () => structuredClone(qboSnapshot));
    fixture.sendPreparedWrite.mockImplementation(async () => {
      qboSnapshot = structuredClone(verifiedPurchase);
      return { ok: true, newSyncToken: '8' };
    });

    const staleCaller = commitStagedCategorization(commitInput(), fixture.deps);
    await callerAAtProof;
    const winner = await commitStagedCategorization(commitInput(), fixture.deps);
    releaseCallerA();
    const staleResult = await staleCaller;

    expect(winner).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(staleResult).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(db.attempts[0]?.status).toBe('VERIFIED');
    expect(db.transactionRow.status).toBe('POSTED');
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale possible-write catch regress a reconciled VERIFIED attempt to UNCERTAIN', async () => {
    const db = new FakeDurableDb();
    seedAttempt(db, 'PREPARED', 'request-generic');
    const fixture = durableDeps(db);
    let qboSnapshot = structuredClone(beforePurchase);
    fixture.fetchPurchaseSnapshot.mockImplementation(async () => structuredClone(qboSnapshot));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const atSend = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    fixture.sendPreparedWrite.mockImplementation(async () => {
      qboSnapshot = structuredClone(verifiedPurchase);
      sendStarted();
      await sendGate;
      throw new QboRequestTimeout();
    });

    const staleCaller = commitStagedCategorization(commitInput(), fixture.deps);
    await atSend;
    const reconciled = await reconcileMutationAttempt({
      requestId: 'request-generic',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps);
    releaseSend();
    const staleResult = await staleCaller;

    expect(reconciled).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(staleResult).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(db.attempts[0]?.status).toBe('VERIFIED');
    expect(db.transactionRow.status).toBe('POSTED');
  });

  it.each([
    ['empty object line', (body: QboPreparedWrite['body']) => {
      body.Line = [{}];
    }],
    ['empty line array', (body: QboPreparedWrite['body']) => {
      body.Line = [];
    }],
    ['missing top-level account reference', (body: QboPreparedWrite['body']) => {
      delete body.AccountRef;
    }],
  ] as const)('rejects PREPARED resume with malformed body: %s', async (_label, mutate) => {
    const db = new FakeDurableDb();
    const attempt = seedAttempt(db, 'PREPARED', 'request-generic');
    const payload = structuredClone(attempt.requestPayload) as QboPreparedWrite;
    mutate(payload.body);
    attempt.requestPayload = payload;
    const fixture = durableDeps(db);

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('recovers a PREPARED attempt when COMMITTING and RETRYABLE persistence both fail pre-send', async () => {
    const db = new FakeDurableDb();
    db.failCommittingOnce = true;
    db.failRetryableOnce = true;
    const firstProcess = durableDeps(db);

    await expect(
      commitStagedCategorization(commitInput(), firstProcess.deps),
    ).rejects.toMatchObject({ code: 'PREWRITE_PERSISTENCE_FAILED' });
    expect(firstProcess.sendPreparedWrite).not.toHaveBeenCalled();
    expect(db.attempts[0]?.status).toBe('PREPARED');

    const restarted = durableDeps(db);
    const recovered = await commitStagedCategorization(commitInput(), restarted.deps);
    expect(recovered).toMatchObject({ ok: true, outcome: 'VERIFIED', status: 'POSTED' });
    expect(restarted.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it.each(['PREPARED', 'COMMITTING', 'UNCERTAIN'])(
    'blocks a different request while a %s attempt exists',
    async (status) => {
      const fixture = durableDeps();
      seedAttempt(fixture.db, status);

      await expect(
        commitStagedCategorization(commitInput('request-other'), fixture.deps),
      ).rejects.toMatchObject<WritebackLifecycleError>({ code: 'MUTATION_BLOCKED' });
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it('never resends the same uncertain request', async () => {
    const fixture = durableDeps();
    seedAttempt(fixture.db, 'UNCERTAIN', 'request-generic');

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 'ERROR', outcome: 'UNCERTAIN' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['role', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.authorize.mockResolvedValue(false);
    }, 'FORBIDDEN'],
    ['revision', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.revision = 2;
    }, 'STALE_REVISION'],
    ['reference', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.qboTaxCode.findMany.mockResolvedValue([]);
    }, 'TAX_CODE_UNAVAILABLE'],
    ['connection', (fixture: ReturnType<typeof durableDeps>) => {
      fixture.db.transactionRow.company.disconnectedAt = new Date();
    }, 'COMPANY_DISCONNECTED'],
  ] as const)(
    'rechecks %s before preparing or sending',
    async (_name, mutate, code) => {
      const fixture = durableDeps();
      mutate(fixture);

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code });
      expect(fixture.preparePurchaseRecategorization).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
      expect(fixture.db.transactionRow.status).toBe('PENDING');
    },
  );

  it('rechecks authorization immediately before send and leaves a retryable staged result', async () => {
    const fixture = durableDeps();
    fixture.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(fixture.preparePurchaseRecategorization).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts[0]?.status).toBe('RETRYABLE');
    expect(fixture.db.transactionRow.status).toBe('PENDING');
  });

  it('keeps a known preparation failure staged and retryable', async () => {
    const fixture = durableDeps();
    fixture.preparePurchaseRecategorization.mockRejectedValueOnce(
      Object.assign(new Error('Purchase reference changed.'), { code: 'QBO_REFERENCE_MISSING' }),
    );

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'QBO_REFERENCE_MISSING' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.transactionRow.status).toBe('PENDING');
    expect(fixture.db.attempts).toHaveLength(0);
  });

  it.each([
    ['timeout', new QboRequestTimeout()],
    ['disconnect', new Error('connection reset after request bytes were written')],
  ])('persists an uncertain result after a possible-write %s', async (_label, error) => {
    const fixture = durableDeps();
    fixture.sendPreparedWrite.mockRejectedValueOnce(error);

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 'ERROR', outcome: 'UNCERTAIN' });
    expect(result.error?.message).toMatch(/verify in QuickBooks/i);
    expect(fixture.db.attempts[0]).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: expect.any(String),
    });
    expect(fixture.db.transactionRow).toMatchObject({
      status: 'ERROR',
      errorMessage: expect.stringMatching(/verify in QuickBooks/i),
    });
  });

  it('persists the live uncertainty hook in the same attempt and transaction transition', async () => {
    const onUncertainMutation = vi.fn(async () => undefined);
    const fixture = durableDeps(undefined, { onUncertainMutation });
    fixture.sendPreparedWrite.mockRejectedValueOnce(new QboRequestTimeout());

    await commitStagedCategorization(commitInput(), fixture.deps);

    expect(onUncertainMutation).toHaveBeenCalledOnce();
    expect(onUncertainMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorCode: 'QBO_WRITE_UNCERTAIN',
        attempt: expect.objectContaining({ requestId: 'request-generic' }),
        transaction: expect.objectContaining({ id: DURABLE_TRANSACTION_ID }),
      }),
    );
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(fixture.db.transactionRow.status).toBe('ERROR');
  });

  it('marks readback mismatch uncertain and never posted', async () => {
    const fixture = durableDeps();
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(beforePurchase))
      .mockResolvedValueOnce({
        ...structuredClone(verifiedPurchase),
        totalCents: -999,
      });

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 'ERROR', outcome: 'UNCERTAIN' });
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(fixture.db.transactionRow.status).toBe('ERROR');
  });

  it('durably records uncertainty when the local verified commit fails after the write', async () => {
    const fixture = durableDeps();
    fixture.db.failVerifiedCommitOnce = true;

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 'ERROR', outcome: 'UNCERTAIN' });
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(fixture.db.transactionRow.status).toBe('ERROR');
  });

  it('returns safe uncertainty and makes best-effort updates when its atomic uncertainty commit fails', async () => {
    const fixture = durableDeps();
    fixture.sendPreparedWrite.mockRejectedValueOnce(new QboRequestTimeout());
    fixture.db.failUncertainTransactionOnce = true;

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_WRITE_UNCERTAIN' },
    });
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(fixture.db.transactionRow.status).toBe('ERROR');
  });

  it('returns safe uncertainty when atomic persistence, fallback transition, and final reread all fail', async () => {
    const fixture = durableDeps();
    fixture.sendPreparedWrite.mockRejectedValueOnce(new QboRequestTimeout());
    fixture.db.failUncertainTransactionOnce = true;
    fixture.db.failUncertainFallbackAndReadOnce = true;

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: expect.stringMatching(/verify in QuickBooks/i),
      },
    });
    expect(fixture.db.attempts[0]?.status).toBe('COMMITTING');
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('records a truthful dry-run without constructing or calling a QBO client', async () => {
    const fixture = durableDeps();
    fixture.db.transactionRow.company.dryRun = true;

    const result = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(result).toMatchObject({ ok: true, status: 'DRY_RUN', outcome: 'DRY_RUN' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts[0]).toMatchObject({
      status: 'DRY_RUN',
      requestId: 'request-generic',
    });
    const auditPayload = (fixture.audit.mock.calls[0]?.[1] as { mutation: unknown }).mutation;
    expect(auditPayload).toMatchObject({
      requestId: 'request-generic',
      outcome: 'DRY_RUN',
    });
    expect(JSON.stringify(auditPayload)).not.toMatch(/SyncToken|body|snapshot|secret/i);
  });

  it.each(['Purchase', 'Deposit'] as const)(
    'replays an idempotent %s DRY_RUN commit without QBO access',
    async (qboType) => {
      const fixture = durableDeps(new FakeDurableDb(qboType));
      fixture.db.transactionRow.company.dryRun = true;
      const input = commitInput(`request-${qboType.toLowerCase()}-dry-run`);

      const first = await commitStagedCategorization(input, fixture.deps);
      const replay = await commitStagedCategorization(input, fixture.deps);

      expect(replay).toEqual(first);
      expect(replay).toMatchObject({
        ok: true,
        status: 'DRY_RUN',
        outcome: 'DRY_RUN',
      });
      expect(fixture.db.attempts).toHaveLength(1);
      expect(fixture.getClient).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['summary identity', (attempt: DurableAttemptRow) => {
      attempt.requestPayload = {
        ...(attempt.requestPayload as Record<string, unknown>),
        qboId: 'purchase-other',
      };
    }],
    ['before sentinel', (attempt: DurableAttemptRow) => {
      attempt.beforeSnapshot = { outcome: 'PREPARED' };
    }],
    ['verification sentinel', (attempt: DurableAttemptRow) => {
      attempt.verification = { outcome: 'DRY_RUN', status: 'POSTED' };
    }],
    ['unexpected response', (attempt: DurableAttemptRow) => {
      attempt.responseSnapshot = { outcome: 'DRY_RUN' };
    }],
  ] as const)(
    'rejects a malformed DRY_RUN %s instead of broadly bypassing validation',
    async (_label, mutate) => {
      const fixture = durableDeps();
      fixture.db.transactionRow.company.dryRun = true;
      await commitStagedCategorization(
        commitInput('request-malformed-dry-run'),
        fixture.deps,
      );
      mutate(fixture.db.attempts[0]!);

      await expect(
        commitStagedCategorization(
          commitInput('request-malformed-dry-run'),
          fixture.deps,
        ),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
      expect(fixture.getClient).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );
});

describe('legacy retryError with durable attempts', () => {
  it('never resets an uncertain prepared write to PENDING', async () => {
    const row = makeTxnRow({ status: 'ERROR' });
    const fetchTxn = vi.fn(async () => freshQboTxn());
    const { deps, db } = makeDeps(row, { fetchTxn });
    db.qboMutationAttempt.findFirst.mockResolvedValueOnce({ id: 'attempt-uncertain' });

    await expect(retryError('txn-1', deps)).rejects.toMatchObject({
      code: 'MUTATION_BLOCKED',
    });
    expect(fetchTxn).not.toHaveBeenCalled();
    expect(row.status).toBe('ERROR');
  });
});

describe('reconcileMutationAttempt', () => {
  it('does not finalize when reconciliation is cancelled immediately after readback', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    seedAttempt(db, 'UNCERTAIN');
    const controller = new AbortController();
    const restarted = durableDeps(db, {
      reconciliationSignal: controller.signal,
    });
    restarted.fetchPurchaseSnapshot.mockReset().mockImplementation(async () => {
      controller.abort();
      return structuredClone(verifiedPurchase);
    });

    await expect(reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps)).rejects.toMatchObject({ name: 'AbortError' });

    expect(db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(db.transactionRow.status).toBe('ERROR');
  });

  it('rechecks cancellation inside the locked finalization transaction', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    seedAttempt(db, 'UNCERTAIN');
    const controller = new AbortController();
    const restarted = durableDeps(db, {
      reconciliationSignal: controller.signal,
    });
    restarted.fetchPurchaseSnapshot.mockReset().mockResolvedValue(
      structuredClone(verifiedPurchase),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    const transact = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(async (callback) => {
      entered.resolve();
      await release.promise;
      return transact(callback);
    });

    const reconciling = reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps);
    await entered.promise;
    controller.abort();
    release.resolve();

    await expect(reconciling).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(db.transactionRow.status).toBe('ERROR');
  });

  it('rolls back finalization when the exact transaction CAS loses', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    seedAttempt(db, 'UNCERTAIN');
    const restarted = durableDeps(db);
    restarted.fetchPurchaseSnapshot.mockReset().mockResolvedValue(
      structuredClone(verifiedPurchase),
    );
    db.transaction.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps)).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });

    expect(db.attempts[0]?.status).toBe('UNCERTAIN');
    expect(db.transactionRow.status).toBe('ERROR');
  });

  it('rechecks the exact MCP authorization after lease renewal and before QBO readback', async () => {
    const fixture = durableDeps();
    fixture.db.transactionRow.status = 'ERROR';
    seedAttempt(fixture.db, 'UNCERTAIN');
    fixture.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const authorization = {
      kind: 'mcp' as const,
      tokenId: 'token-generic',
      tokenPrefix: 'mcp_generic',
    };

    await expect(reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      authorization,
    }, fixture.deps)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(fixture.authorize).toHaveBeenNthCalledWith(
      2,
      DURABLE_ACTOR_ID,
      DURABLE_COMPANY_ID,
      authorization,
    );
    expect(fixture.getClient).not.toHaveBeenCalled();
  });

  it('returns the recorded DRY_RUN outcome without validating it as a prepared QBO payload', async () => {
    const fixture = durableDeps();
    fixture.db.transactionRow.company.dryRun = true;
    await commitStagedCategorization(commitInput('request-dry-run'), fixture.deps);

    const result = await reconcileMutationAttempt({
      requestId: 'request-dry-run',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps);

    expect(result).toMatchObject({ outcome: 'DRY_RUN', status: 'DRY_RUN' });
    expect(fixture.getClient).not.toHaveBeenCalled();
  });

  it.each([
    ['expected', verifiedPurchase, 'VERIFIED', 'POSTED'],
    ['unchanged before', beforePurchase, 'UNCHANGED', 'PENDING'],
    ['neither', { ...verifiedPurchase, totalCents: -999 }, 'UNCERTAIN', 'ERROR'],
  ] as const)('proves %s from persisted state after restart', async (_label, snapshot, outcome, status) => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    seedAttempt(db, 'UNCERTAIN');
    const restarted = durableDeps(db);
    restarted.fetchPurchaseSnapshot.mockReset().mockResolvedValue(structuredClone(snapshot));

    const result = await reconcileMutationAttempt(
      {
        requestId: 'request-existing',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      },
      restarted.deps,
    );

    expect(result).toMatchObject({ outcome, status });
    expect(restarted.preparePurchaseRecategorization).not.toHaveBeenCalled();
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
    expect(db.transactionRow.status).toBe(status);
    if (_label === 'neither') {
      expect(db.attempts[0]).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: 'QBO_READBACK_MISMATCH',
      });
    }
  });

  it('durably classifies a missing reconciliation snapshot as a readback mismatch', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    seedAttempt(db, 'UNCERTAIN');
    const restarted = durableDeps(db);
    restarted.fetchPurchaseSnapshot.mockReset().mockResolvedValue(null);

    const first = await reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps);

    expect(first).toMatchObject({
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_READBACK_MISMATCH' },
    });
    expect(restarted.fetchPurchaseSnapshot).toHaveBeenCalledOnce();
  });

  it('reconciles an uncertain write after sync supersedes the moved-out queue row', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'SUPERSEDED';
    seedAttempt(db, 'UNCERTAIN');
    const restarted = durableDeps(db);
    restarted.fetchPurchaseSnapshot.mockReset()
      .mockResolvedValue(structuredClone(verifiedPurchase));

    const result = await reconcileMutationAttempt({
      requestId: 'request-existing',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps);

    expect(result).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
    expect(db.transactionRow.status).toBe('POSTED');
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('keeps a posted transaction POSTED when an uncertain restore proves unchanged after restart', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    db.transactionRow.qboSyncToken = '8';
    seedAttempt(db, 'VERIFIED', 'request-post');
    seedAttempt(db, 'UNCERTAIN', 'request-restore', 'restore');
    const restarted = durableDeps(db);
    restarted.fetchPurchaseSnapshot.mockReset().mockResolvedValue(structuredClone(verifiedPurchase));

    const first = await reconcileMutationAttempt({
      requestId: 'request-restore',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps);
    const recorded = await reconcileMutationAttempt({
      requestId: 'request-restore',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, restarted.deps);

    expect(first).toMatchObject({ outcome: 'UNCHANGED', status: 'POSTED' });
    expect(recorded).toMatchObject({ outcome: 'UNCHANGED', status: 'POSTED' });
    expect(db.transactionRow.status).toBe('POSTED');
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rechecks the current actor before returning a recorded terminal reconciliation', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'POSTED';
    seedAttempt(db, 'VERIFIED', 'request-existing');
    const restarted = durableDeps(db);
    restarted.authorize.mockImplementation(async (actorId) => actorId === DURABLE_ACTOR_ID);

    await expect(
      reconcileMutationAttempt({
        requestId: 'request-existing',
        actor: { id: 'unrelated-actor', label: 'Unrelated User' },
      }, restarted.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(restarted.getClient).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted nested proof with stable ATTEMPT_CORRUPT', async () => {
    const db = new FakeDurableDb();
    db.transactionRow.status = 'ERROR';
    const attempt = seedAttempt(db, 'UNCERTAIN');
    attempt.requestPayload = {
      ...preparedWrite('request-existing'),
      expected: {},
    };
    const restarted = durableDeps(db);

    await expect(
      reconcileMutationAttempt({
        requestId: 'request-existing',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, restarted.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong entity ID', (attempt: DurableAttemptRow) => {
      attempt.requestPayload = withPreparedQboId(
        attempt.requestPayload as QboPreparedWrite,
        'purchase-other',
      );
    }],
    ['before snapshot mismatch', (attempt: DurableAttemptRow) => {
      attempt.beforeSnapshot = {
        ...structuredClone(beforePurchase),
        totalCents: -999,
      };
    }],
  ] as const)(
    'rejects reconciliation state bound to the %s before QBO access',
    async (_label, mutate) => {
      const db = new FakeDurableDb();
      db.transactionRow.status = 'ERROR';
      const attempt = seedAttempt(db, 'UNCERTAIN');
      mutate(attempt);
      const restarted = durableDeps(db);

      await expect(
        reconcileMutationAttempt({
          requestId: 'request-existing',
          actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
        }, restarted.deps),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
      expect(restarted.getClient).not.toHaveBeenCalled();
      expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );
});

describe('prepareCategorizationUndo', () => {
  function postedFixture() {
    const fixture = durableDeps();
    fixture.db.transactionRow.status = 'POSTED';
    fixture.db.transactionRow.qboSyncToken = '8';
    fixture.db.transactionRow.postedAt = new Date('2026-07-28T12:00:00.000Z');
    const source = seedAttempt(fixture.db, 'VERIFIED', 'source-operation');
    fixture.fetchPurchaseSnapshot.mockReset()
      .mockResolvedValue(structuredClone(verifiedPurchase));
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>)
      .mockResolvedValue(currentQboTxn('8'));
    return { ...fixture, source };
  }

  function input(sourceRequestId = 'source-operation') {
    return {
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      sourceRequestId,
      expectedRevision: 1,
      expectedSourceSyncToken: '7',
      expectedQboBinding: {
        qboType: 'Purchase',
        qboId: 'purchase-generic',
      },
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp' as const,
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
    };
  }

  it('authoritatively prepares a proof-bound redacted restore under lease with zero attempt and zero send', async () => {
    const fixture = postedFixture();
    const attemptCount = fixture.db.attempts.length;

    const result = await prepareCategorizationUndo(input(), fixture.deps);

    expect(result).toMatchObject({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      revision: 1,
      qboType: 'Purchase',
      qboId: 'purchase-generic',
      qboSyncToken: '8',
      preview: {
        action: 'restore_purchase_categorization',
        resultingStatus: 'REVERTED',
        direction: 'purchase',
        totalCents: -1050,
        totalTaxCents: 0,
        lineCount: 1,
      },
    });
    expect(result.sourcePreparedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.currentPostHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.restoreHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.preview.restorationDigest).toBe(result.restoreHash);
    expect(fixture.authorize).toHaveBeenCalledWith(
      DURABLE_ACTOR_ID,
      DURABLE_COMPANY_ID,
      input().authorization,
    );
    expect(fixture.leaseOwners).toHaveLength(1);
    expect(fixture.preparePurchaseRestore).toHaveBeenCalledOnce();
    expect(fixture.db.qboMutationAttempt.create).not.toHaveBeenCalled();
    expect(fixture.db.attempts).toHaveLength(attemptCount);
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it('prepares undo from the exact verified preserve-current stage binding', async () => {
    const fixture = postedFixture();
    fixture.db.transactionRow.taxCalculation = 'NotApplicable';
    fixture.db.transactionRow.splitLines = [{
      idx: 0,
      amount: -10.5,
      category: 'Bank Charges',
      categoryQboId: 'expense-generic',
      taxCode: 'Non-taxable',
      taxCodeQboId: 'NON',
      memo: null,
      tags: [],
    }];
    fixture.db.transactionRow.txnTags = [];
    const sourcePrepared = fixture.source.requestPayload as QboPurchasePreparedWrite;
    sourcePrepared.body.GlobalTaxCalculation = 'NotApplicable';
    sourcePrepared.body.Line![0]!.AccountBasedExpenseLineDetail = {
      AccountRef: { value: 'expense-generic' },
      TaxCodeRef: { value: 'NON' },
    };
    sourcePrepared.expected = {
      ...sourcePrepared.expected,
      taxDisposition: 'preserve_current',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      preservedHash: 'preserved-source',
      targetLines: [{
        id: 'line-holding',
        amountCents: -1050,
        description: null,
        accountQboId: 'expense-generic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: 'NON',
        taxAmountCents: null,
        taxInclusiveCents: null,
        rawHash: 'preserved-target',
        categoryOnlyHash: 'preserved-category-only',
      }],
      untouchedLineHashes: [],
    };
    sourcePrepared.requestHash = hashPreparedWriteBody(sourcePrepared.body);
    fixture.source.requestHash = sourcePrepared.requestHash;
    const preservedResponse: QboPurchaseSnapshot = {
      ...verifiedPurchase,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      preservedHash: 'preserved-source',
      lines: [structuredClone(sourcePrepared.expected.targetLines[0]!)],
    };
    fixture.source.responseSnapshot = structuredClone(preservedResponse);
    fixture.fetchPurchaseSnapshot.mockResolvedValue(structuredClone(preservedResponse));

    await expect(prepareCategorizationUndo(input(), fixture.deps))
      .resolves.toMatchObject({ preview: { action: 'restore_purchase_categorization' } });
    expect(fixture.preparePurchaseRestore).toHaveBeenCalledOnce();
  });

  it('hashes the complete source and restore bindings while excluding only the throwaway request ID', async () => {
    expect(hashPreparedWriteBinding(preparedWrite('request-a')))
      .toBe(hashPreparedWriteBinding(preparedWrite('request-b')));
    const changedExpected = preparedWrite('request-a');
    changedExpected.expected = {
      ...changedExpected.expected,
      totalTaxCents: -51,
    };
    expect(hashPreparedWriteBinding(changedExpected))
      .not.toBe(hashPreparedWriteBinding(preparedWrite('request-a')));

    const fixture = postedFixture();
    const first = await prepareCategorizationUndo(input(), fixture.deps);
    const second = await prepareCategorizationUndo(input(), fixture.deps);
    expect(first.sourcePreparedHash).toBe(second.sourcePreparedHash);
    expect(first.currentPostHash).toBe(second.currentPostHash);
    expect(first.restoreHash).toBe(second.restoreHash);
  });

  it.each([
    ['DRY_RUN', 'recategorize'],
    ['UNCERTAIN', 'recategorize'],
    ['VERIFIED', 'restore'],
  ])('rejects an exact non-eligible source attempt: %s %s', async (status, operation) => {
    const fixture = postedFixture();
    fixture.source.status = status;
    fixture.source.operation = operation;

    await expect(
      prepareCategorizationUndo(input(), fixture.deps),
    ).rejects.toMatchObject({ code: 'VERIFIED_POST_REQUIRED' });
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
    expect(fixture.db.qboMutationAttempt.create).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('selects the source by exact request ID instead of a newer UI or transfer attempt', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'VERIFIED', 'newer-ui-attempt');

    await prepareCategorizationUndo(input('source-operation'), fixture.deps);

    expect(fixture.db.qboMutationAttempt.findUnique)
      .toHaveBeenCalledWith({ where: { requestId: 'source-operation' } });
    expect(fixture.preparePurchaseRestore.mock.calls[0]?.[1].requestId)
      .toBe('source-operation');
  });

  it('rejects a source attempt outside the source MCP operation sync-token binding before QBO access', async () => {
    const fixture = postedFixture();

    await expect(
      prepareCategorizationUndo({
        ...input(),
        expectedSourceSyncToken: 'different-source-sync',
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'VERIFIED_POST_REQUIRED' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
  });

  it('rechecks current MCP authorization after lease renewal before QBO access', async () => {
    const fixture = postedFixture();
    fixture.authorize
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      prepareCategorizationUndo(input(), fixture.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
  });

  it('rechecks the source MCP operation sync-token binding after lease renewal before QBO access', async () => {
    const fixture = postedFixture();
    fixture.renewLease.mockImplementationOnce(async () => {
      fixture.source.expectedSyncToken = 'different-source-sync';
    });

    await expect(
      prepareCategorizationUndo(input(), fixture.deps),
    ).rejects.toMatchObject({ code: 'VERIFIED_POST_REQUIRED' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
  });

  it('rechecks the exact verified source after lease renewal before QBO access', async () => {
    const fixture = postedFixture();
    fixture.renewLease.mockImplementationOnce(async () => {
      fixture.source.status = 'UNCERTAIN';
    });

    await expect(
      prepareCategorizationUndo(input(), fixture.deps),
    ).rejects.toMatchObject({ code: 'VERIFIED_POST_REQUIRED' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
  });
});

describe('undoCategorization', () => {
  function postedFixture() {
    const fixture = durableDeps();
    fixture.db.transactionRow.status = 'POSTED';
    fixture.db.transactionRow.qboSyncToken = '8';
    fixture.db.transactionRow.postedAt = new Date('2026-07-28T12:00:00.000Z');
    seedAttempt(fixture.db, 'VERIFIED');
    fixture.fetchPurchaseSnapshot.mockReset().mockResolvedValue(structuredClone(verifiedPurchase));
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockResolvedValue(currentQboTxn('8'));
    return fixture;
  }

  async function prepareMcpProof(
    fixture: ReturnType<typeof postedFixture>,
  ) {
    const prepared = await prepareCategorizationUndo({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      sourceRequestId: 'request-existing',
      expectedRevision: 1,
      expectedSourceSyncToken: '7',
      expectedQboBinding: {
        qboType: 'Purchase',
        qboId: 'purchase-generic',
      },
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
    }, fixture.deps);
    return {
      sourceRequestId: 'request-existing',
      expectedRevision: 1,
      expectedQboBinding: {
        qboType: 'Purchase',
        qboId: 'purchase-generic',
        qboSyncToken: prepared.qboSyncToken,
      },
      sourcePreparedHash: prepared.sourcePreparedHash,
      currentPostHash: prepared.currentPostHash,
      restoreHash: prepared.restoreHash,
    };
  }

  function resetForVerifiedRestore(
    fixture: ReturnType<typeof postedFixture>,
  ): void {
    fixture.authorize.mockClear();
    fixture.getClient.mockClear();
    fixture.preparePurchaseRestore.mockClear();
    fixture.sendPreparedWrite.mockClear();
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({
        ...structuredClone(beforePurchase),
        syncToken: '9',
      });
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue(currentQboTxn('8'));
  }

  it('uses the undo operation ID for one real proof-bound MCP restore even when dry-run is enabled', async () => {
    const fixture = postedFixture();
    const proof = await prepareMcpProof(fixture);
    resetForVerifiedRestore(fixture);
    fixture.db.transactionRow.company.dryRun = true;
    fixture.deps.envDryRun = true;

    const result = await undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'undo-operation',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
      proof,
      auditAttribution: {
        sourceOperationId: 'request-existing',
        operationId: 'undo-operation',
        tokenPrefix: 'rct_example1',
      },
    }, fixture.deps);

    expect(result).toMatchObject({
      requestId: 'undo-operation',
      outcome: 'VERIFIED',
      status: 'REVERTED',
    });
    expect(fixture.db.qboMutationAttempt.findUnique)
      .toHaveBeenCalledWith({ where: { requestId: 'request-existing' } });
    expect(fixture.preparePurchaseRestore).toHaveBeenCalledOnce();
    expect(fixture.preparePurchaseRestore.mock.calls[0]?.[2]).toBe('undo-operation');
    expect(fixture.sendPreparedWrite).toHaveBeenCalledOnce();
    expect(fixture.db.attempts.at(-1)).toMatchObject({
      requestId: 'undo-operation',
      operation: 'restore',
      status: 'VERIFIED',
    });
    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: DURABLE_ACTOR_ID,
        actorLabel: 'Generic User (MCP rct_example1)',
        mutation: expect.objectContaining({
          mcp: {
            sourceOperationId: 'request-existing',
            operationId: 'undo-operation',
            tokenPrefix: 'rct_example1',
          },
        }),
      }),
    );
  });

  it.each([
    'sourcePreparedHash',
    'currentPostHash',
    'restoreHash',
  ] as const)('rejects a changed %s without a QBO send', async (field) => {
    const fixture = postedFixture();
    const proof = await prepareMcpProof(fixture);
    resetForVerifiedRestore(fixture);

    await expect(undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: `undo-tampered-${field}`,
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
      proof: { ...proof, [field]: 'f'.repeat(64) },
    }, fixture.deps)).rejects.toMatchObject({ code: 'UNDO_PROOF_MISMATCH' });

    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts).toHaveLength(1);
  });

  it('rechecks MCP authorization after preparing the durable restore and before send', async () => {
    const fixture = postedFixture();
    const proof = await prepareMcpProof(fixture);
    resetForVerifiedRestore(fixture);
    fixture.authorize
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'undo-revoked',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp',
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
      proof,
    }, fixture.deps)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts.at(-1)).toMatchObject({
      requestId: 'undo-revoked',
      operation: 'restore',
      status: 'RETRYABLE',
    });
  });

  it('validates terminal replay restore and current-post evidence against the immutable proof', async () => {
    const fixture = postedFixture();
    const proof = await prepareMcpProof(fixture);
    resetForVerifiedRestore(fixture);
    const input = {
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'undo-terminal-proof',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User (MCP rct_example1)' },
      authorization: {
        kind: 'mcp' as const,
        tokenId: 'token-generic',
        tokenPrefix: 'rct_example1',
      },
      proof,
    };
    await undoCategorization(input, fixture.deps);
    fixture.sendPreparedWrite.mockClear();

    await expect(undoCategorization({
      ...input,
      proof: { ...proof, restoreHash: 'f'.repeat(64) },
    }, fixture.deps)).rejects.toMatchObject({ code: 'UNDO_PROOF_MISMATCH' });

    const attempt = fixture.db.attempts.find(
      (candidate) => candidate.requestId === input.requestId,
    )!;
    attempt.beforeSnapshot = {
      ...structuredClone(verifiedPurchase),
      totalCents: -999,
    };
    await expect(
      undoCategorization(input, fixture.deps),
    ).rejects.toMatchObject({ code: 'UNDO_PROOF_MISMATCH' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rejects current SyncToken or snapshot drift before preparing a restore', async () => {
    const fixture = postedFixture();
    fixture.fetchPurchaseSnapshot.mockResolvedValueOnce({
      ...structuredClone(verifiedPurchase),
      syncToken: '9',
      totalCents: -999,
    });

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-undo',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.transactionRow.status).toBe('POSTED');
  });

  it('persists and sends one exact restore, verifies readback, then marks REVERTED', async () => {
    const fixture = postedFixture();
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({
        ...structuredClone(beforePurchase),
        syncToken: '9',
      });

    const result = await undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps);

    expect(result).toMatchObject({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' });
    expect(fixture.preparePurchaseRestore).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite.mock.calls[0]?.[0]).toMatchObject({
      operation: 'restore',
      requestId: 'request-undo',
    });
    expect(fixture.db.attempts.at(-1)).toMatchObject({
      operation: 'restore',
      status: 'VERIFIED',
    });
    expect(fixture.db.transactionRow.status).toBe('REVERTED');
  });

  it('blocks a reconciled transaction before a prepared undo can enter COMMITTING', async () => {
    const fixture = postedFixture();
    fixture.fetchWriteSafety.mockResolvedValueOnce({
      bookCloseDate: null,
      cleared: true,
      reconciled: false,
    });

    await expect(undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo-locked',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps)).rejects.toMatchObject({ code: 'QBO_TRANSACTION_LOCKED' });

    expect(fixture.db.attempts).toHaveLength(1);
    expect(fixture.prepareRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('prepares and verifies undo from persisted proof when current references are unavailable', async () => {
    const fixture = postedFixture();
    fixture.db.transactionRow.company.taxSupportStatus = 'needs_setup';
    fixture.db.transactionRow.company.taxUsingSalesTax = false;
    fixture.db.qboAccount.findMany.mockResolvedValue([]);
    fixture.db.qboTaxCode.findMany.mockResolvedValue([]);
    fixture.db.qboTaxRate.findMany.mockResolvedValue([]);
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({
        ...structuredClone(beforePurchase),
        syncToken: '9',
      });

    const result = await undoCategorization({
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    }, fixture.deps);

    expect(result).toMatchObject({ ok: true, status: 'REVERTED', outcome: 'VERIFIED' });
    expect(fixture.db.qboAccount.findMany).not.toHaveBeenCalled();
    expect(fixture.db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(fixture.db.qboTaxRate.findMany).not.toHaveBeenCalled();
    expect(fixture.preparePurchaseRestore).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong operation', (prepared: QboPreparedWrite) => {
      prepared.operation = 'recategorize';
      return prepared;
    }],
    ['wrong request ID', (prepared: QboPreparedWrite) => {
      prepared.requestId = 'request-other';
      return prepared;
    }],
    ['wrong entity type', () => preparedWrite('request-undo', 'Deposit')],
    ['wrong entity ID', (prepared: QboPreparedWrite) =>
      withPreparedQboId(prepared, 'purchase-other')],
    ['wrong before snapshot', (prepared: QboPreparedWrite) =>
      withPreparedBeforeTotal(prepared, -999)],
  ] as const)(
    'rejects a freshly prepared restore with %s before persistence or send',
    async (_label, mutate) => {
      const fixture = postedFixture();
      fixture.prepareRestore.mockResolvedValueOnce(
        mutate(restoredWrite(
          preparedWrite('request-existing'),
          'request-undo',
        )),
      );

      await expect(
        undoCategorization({
          transactionId: DURABLE_TRANSACTION_ID,
          companyId: DURABLE_COMPANY_ID,
          requestId: 'request-undo',
          actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
        }, fixture.deps),
      ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });
      expect(fixture.db.attempts).toHaveLength(1);
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    },
  );

  it('replays a recorded verified undo after disconnect without another QBO client or send', async () => {
    const fixture = postedFixture();
    const input = {
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    };
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({
        ...structuredClone(beforePurchase),
        syncToken: '9',
      });
    const first = await undoCategorization(input, fixture.deps);
    fixture.db.transactionRow.company.disconnectedAt = new Date();

    const duplicate = await undoCategorization(input, fixture.deps);

    expect(duplicate).toEqual(first);
    expect(fixture.getClient).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects a disconnected PREPARED undo resume before QBO access', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'PREPARED', 'request-undo', 'restore');
    fixture.db.transactionRow.company.disconnectedAt = new Date();

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-undo',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rechecks QuickBooks drift before sending a resumed PREPARED restore', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'PREPARED', 'request-undo', 'restore');
    fixture.fetchPurchaseSnapshot.mockResolvedValue({
      ...structuredClone(verifiedPurchase),
      totalCents: -999,
    });

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-undo',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });

    expect(fixture.renewLease).toHaveBeenCalledTimes(1);
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts.at(-1)?.status).toBe('RETRYABLE');
  });

  it('allows exactly one COMMITTING winner and one send for concurrent same-request PREPARED undo resumes', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'PREPARED', 'request-undo', 'restore');
    const barrier = pauseCommittingTransitions(fixture.db, 2);
    let qboSnapshot = structuredClone(verifiedPurchase);
    fixture.fetchPurchaseSnapshot.mockImplementation(async () => structuredClone(qboSnapshot));
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => currentQboTxn(qboSnapshot.syncToken),
    );
    fixture.sendPreparedWrite.mockImplementation(async () => {
      qboSnapshot = { ...structuredClone(beforePurchase), syncToken: '9' };
      return { ok: true, newSyncToken: '9' };
    });
    const input = {
      transactionId: DURABLE_TRANSACTION_ID,
      companyId: DURABLE_COMPANY_ID,
      requestId: 'request-undo',
      actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
    };

    const callerA = undoCategorization(input, fixture.deps);
    const callerB = undoCategorization(input, fixture.deps);
    await barrier.arrivals;
    barrier.release();
    const results = await Promise.all([callerA, callerB]);

    expect(fixture.leaseOwners).toHaveLength(2);
    expect(new Set(fixture.leaseOwners).size).toBe(2);
    expect(fixture.leaseOwners).not.toContain('request-undo');
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.outcome === 'VERIFIED')).toBe(true);
    expect(results.every((result) =>
      result.outcome === 'VERIFIED' || result.outcome === 'IN_PROGRESS')).toBe(true);
    expect(fixture.db.attempts.at(-1)?.status).toBe('VERIFIED');
    expect(fixture.db.transactionRow.status).toBe('REVERTED');
  });

  it('rejects reuse of a recategorization request ID for undo', async () => {
    const fixture = postedFixture();

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-existing',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('blocks a different UUID while a PREPARED restore is waiting to resume', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'PREPARED', 'request-undo', 'restore');

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-other',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });

    expect(fixture.preparePurchaseRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('rechecks authorization before returning a recorded verified undo result', async () => {
    const fixture = postedFixture();
    seedAttempt(fixture.db, 'VERIFIED', 'request-undo', 'restore');
    fixture.db.transactionRow.status = 'REVERTED';
    fixture.authorize.mockResolvedValue(false);

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-undo',
        actor: { id: 'unrelated-actor', label: 'Unrelated User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('marks restore RETRYABLE without sending when QBO drifts after preparation', async () => {
    const fixture = postedFixture();
    fixture.fetchPurchaseSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(verifiedPurchase))
      .mockResolvedValueOnce({
        ...structuredClone(verifiedPurchase),
        syncToken: '9',
        totalCents: -999,
      });
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(currentQboTxn('8'))
      .mockResolvedValueOnce(currentQboTxn('9'));

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-undo',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });

    expect(fixture.preparePurchaseRestore).toHaveBeenCalledTimes(1);
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.attempts.at(-1)?.status).toBe('RETRYABLE');
    expect(fixture.db.transactionRow.status).toBe('POSTED');
  });
});

function depositDurableFixture() {
  const db = new FakeDurableDb('Deposit');
  // Purchase readiness is deliberately not ready. Deposit readiness must come
  // from the cached sales-code fields instead.
  db.transactionRow.company.taxSupportStatus = 'needs_setup';
  return durableDeps(db);
}

it('filters legacy null tax rates before a durable Deposit commit', async () => {
  const fixture = depositDurableFixture();
  fixture.db.qboTaxRate.findMany.mockImplementation(async (args) => {
    expect(args).toEqual({
      where: {
        companyId: DURABLE_COMPANY_ID,
        active: true,
        rateValue: { not: null },
      },
    });
    return [{
      qboId: 'rate-generic',
      name: 'Generic rate',
      active: true,
      rateValue: 5,
    }];
  });

  await expect(commitStagedCategorization(commitInput(), fixture.deps)).resolves.toMatchObject({
    ok: true,
    outcome: 'VERIFIED',
  });
});

describe.each(['Purchase', 'Deposit'] as const)(
  '%s tax-exclusive staged reconstruction',
  (qboType) => {
    it('jointly inverts exact two-line 5% totals with grouped cent allocation', async () => {
      const db = new FakeDurableDb(qboType);
      const deposit = qboType === 'Deposit';
      db.transactionRow.amount = 210.11;
      db.transactionRow.taxCalculation = 'TaxExcluded';
      db.transactionRow.splitLines = [
        {
          idx: 0,
          amount: 105.01,
          category: deposit ? 'Prepared deposit A' : 'Prepared purchase A',
          categoryQboId: deposit ? 'income-generic-a' : 'expense-generic-a',
          taxCode: 'Generic tax A',
          taxCodeQboId: 'tax-generic-a',
          memo: 'Prepared A',
        },
        {
          idx: 1,
          amount: 105.1,
          category: deposit ? 'Prepared deposit B' : 'Prepared purchase B',
          categoryQboId: deposit ? 'income-generic-b' : 'expense-generic-b',
          taxCode: 'Generic tax B',
          taxCodeQboId: 'tax-generic-b',
          memo: 'Prepared B',
        },
      ];
      const fixture = durableDeps(db);
      fixture.db.qboAccount.findMany.mockResolvedValue([
        { qboId: deposit ? 'income-generic-a' : 'expense-generic-a', active: true },
        { qboId: deposit ? 'income-generic-b' : 'expense-generic-b', active: true },
      ]);
      fixture.db.qboTaxCode.findMany.mockResolvedValue([
        {
          qboId: 'tax-generic-a',
          name: 'Generic tax A',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          salesTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          combinedSalesRate: 5,
        },
        {
          qboId: 'tax-generic-b',
          name: 'Generic tax B',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          salesTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          combinedSalesRate: 5,
        },
      ]);

      await commitStagedCategorization(commitInput(), fixture.deps);

      expect(fixture.prepareRecategorization).toHaveBeenCalledWith(
        expect.objectContaining({ qboType }),
        expect.objectContaining({
          taxCalculation: 'TaxExcluded',
          totals: {
            subtotalCents: 20_010,
            taxCents: 1_001,
            totalCents: 21_011,
          },
          lines: [
            expect.objectContaining({
              subtotalCents: 10_001,
              taxCents: 500,
              totalCents: 10_501,
            }),
            expect.objectContaining({
              subtotalCents: 10_009,
              taxCents: 501,
              totalCents: 10_510,
            }),
          ],
        }),
        qboType === 'Deposit' ? beforeDeposit : beforePurchase,
        'request-generic',
      );
    });

    it('fails closed when no exact tax-exclusive inverse exists', async () => {
      const db = new FakeDurableDb(qboType);
      db.transactionRow.amount = 0.01;
      db.transactionRow.taxCalculation = 'TaxExcluded';
      db.transactionRow.splitLines[0]!.amount = 0.01;
      const fixture = durableDeps(db);
      fixture.db.qboTaxRate.findMany.mockResolvedValue([{
        qboId: 'rate-generic',
        name: 'Generic rate',
        active: true,
        rateValue: 100,
      }]);

      await expect(
        commitStagedCategorization(commitInput(), fixture.deps),
      ).rejects.toMatchObject({ code: 'TAX_AMOUNT_INVALID' });
      expect(fixture.prepareRecategorization).not.toHaveBeenCalled();
      expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: '12 equal 10001-cent subtotals',
        subtotals: Array<number>(12).fill(10_001),
        taxes: [501, ...Array<number>(11).fill(500)],
      },
      {
        label: '20-line supported largest-remainder shape',
        subtotals: Array<number>(20).fill(10_010),
        taxes: [
          ...Array<number>(10).fill(501),
          ...Array<number>(10).fill(500),
        ],
      },
    ])('reconstructs the valid max-shape case: $label', async ({
      subtotals,
      taxes,
    }) => {
      const db = new FakeDurableDb(qboType);
      const deposit = qboType === 'Deposit';
      const totals = subtotals.map((subtotal, index) => subtotal + taxes[index]!);
      db.transactionRow.amount =
        totals.reduce((sum, total) => sum + total, 0) / 100;
      db.transactionRow.taxCalculation = 'TaxExcluded';
      db.transactionRow.splitLines = totals.map((total, index) => ({
        idx: index,
        amount: total / 100,
        category: `Prepared ${qboType} ${index}`,
        categoryQboId: `${deposit ? 'income' : 'expense'}-max-${index}`,
        taxCode: `Generic tax ${index}`,
        taxCodeQboId: `tax-max-${index}`,
        memo: `Prepared ${index}`,
      }));
      const fixture = durableDeps(db);
      fixture.db.qboAccount.findMany.mockResolvedValue(
        totals.map((_total, index) => ({
          qboId: `${deposit ? 'income' : 'expense'}-max-${index}`,
          active: true,
        })),
      );
      fixture.db.qboTaxCode.findMany.mockResolvedValue(
        totals.map((_total, index) => ({
          qboId: `tax-max-${index}`,
          name: `Generic tax ${index}`,
          active: true,
          taxable: true,
          purchaseTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          salesTaxRateList: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          combinedSalesRate: 5,
        })),
      );

      await commitStagedCategorization(commitInput(), fixture.deps);

      expect(fixture.prepareRecategorization).toHaveBeenCalledWith(
        expect.objectContaining({ qboType }),
        expect.objectContaining({
          taxCalculation: 'TaxExcluded',
          totals: {
            subtotalCents: subtotals.reduce((sum, value) => sum + value, 0),
            taxCents: taxes.reduce((sum, value) => sum + value, 0),
            totalCents: totals.reduce((sum, value) => sum + value, 0),
          },
          lines: subtotals.map((subtotalCents, index) =>
            expect.objectContaining({
              idx: index,
              subtotalCents,
              taxCents: taxes[index],
              totalCents: totals[index],
            })),
        }),
        qboType === 'Deposit' ? beforeDeposit : beforePurchase,
        'request-generic',
      );
    });
  },
);

describe('Deposit durable lifecycle matrix', () => {
  it('persists the Deposit union member before send and fences the Deposit entity', async () => {
    const fixture = depositDurableFixture();
    fixture.sendPreparedWrite.mockImplementationOnce(async (prepared) => {
      expect(fixture.db.attempts[0]).toMatchObject({
        status: 'COMMITTING',
        expectedSyncToken: '7',
        requestHash: prepared.requestHash,
        beforeSnapshot: beforeDeposit,
        requestPayload: {
          qboType: 'Deposit',
          qboId: 'deposit-generic',
          body: { DepositToAccountRef: { value: 'payment-generic' } },
        },
      });
      expect(fixture.db.transactionRow.status).toBe('PENDING');
      return { ok: true, newSyncToken: '8' };
    });

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).resolves.toMatchObject({
      ok: true,
      status: 'POSTED',
      outcome: 'VERIFIED',
    });
    expect(fixture.client.fetchTxn).toHaveBeenCalledWith(
      'Deposit',
      'deposit-generic',
    );
    expect(fixture.fetchPreparedSnapshot).toHaveBeenCalledWith(
      'Deposit',
      'deposit-generic',
    );
    expect(fixture.prepareRecategorization).toHaveBeenCalledWith(
      expect.objectContaining({ qboType: 'Deposit' }),
      stagedDeposit,
      beforeDeposit,
      'request-generic',
    );
    expect(fixture.renewLease).toHaveBeenNthCalledWith(1, {
      companyId: DURABLE_COMPANY_ID,
      qboType: 'Deposit',
      qboId: 'deposit-generic',
    }, 'invocation-1');
  });

  it('returns a verified Deposit request replay without a second send', async () => {
    const fixture = depositDurableFixture();

    const first = await commitStagedCategorization(commitInput(), fixture.deps);
    const replay = await commitStagedCategorization(commitInput(), fixture.deps);

    expect(replay).toEqual(first);
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.db.attempts).toHaveLength(1);
  });

  it.each([
    ['entity fingerprint', (payload: QboDepositPreparedWrite) => {
      (payload.expected as { preservedHash?: string }).preservedHash = '';
    }],
    ['untouched-line fingerprint', (payload: QboDepositPreparedWrite) => {
      payload.before.lines[0]!.rawHash = '';
    }],
    ['target-line fingerprint', (payload: QboDepositPreparedWrite) => {
      payload.expected.targetLines[0]!.targetHash = '';
    }],
  ])('fails closed on a persisted Deposit with a missing %s', async (_label, mutate) => {
    const fixture = depositDurableFixture();
    const attempt = seedAttempt(
      fixture.db,
      'PREPARED',
      'request-generic',
    );
    mutate(attempt.requestPayload as QboDepositPreparedWrite);

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).rejects.toMatchObject({ code: 'ATTEMPT_CORRUPT' });
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
  });

  it('reconstructs exact tax-exclusive Deposit staged cents from persisted totals', async () => {
    const fixture = depositDurableFixture();
    fixture.db.transactionRow.taxCalculation = 'TaxExcluded';

    await commitStagedCategorization(commitInput(), fixture.deps);

    expect(fixture.prepareRecategorization).toHaveBeenCalledWith(
      expect.objectContaining({ qboType: 'Deposit' }),
      {
        ...stagedDeposit,
        taxCalculation: 'TaxExcluded',
        totals: { subtotalCents: 1000, taxCents: 50, totalCents: 1050 },
        lines: [{
          ...stagedDeposit.lines[0]!,
          subtotalCents: 1000,
          taxCents: 50,
          totalCents: 1050,
        }],
      },
      beforeDeposit,
      'request-generic',
    );
  });

  it('keeps an ambiguous Deposit timeout uncertain until restart reconciliation', async () => {
    const fixture = depositDurableFixture();
    fixture.sendPreparedWrite.mockRejectedValueOnce(new QboRequestTimeout());

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).resolves.toMatchObject({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
    });
    expect(fixture.db.transactionRow.status).toBe('ERROR');
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');

    const restarted = durableDeps(fixture.db);
    restarted.fetchPreparedSnapshot
      .mockReset()
      .mockResolvedValue(structuredClone(verifiedDeposit));
    await expect(
      reconcileMutationAttempt({
        requestId: 'request-generic',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, restarted.deps),
    ).resolves.toMatchObject({
      ok: true,
      status: 'POSTED',
      outcome: 'VERIFIED',
    });
    expect(restarted.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.transactionRow.qboSyncToken).toBe('8');
  });

  it('does not finalize a Deposit after send without exact readback', async () => {
    const fixture = depositDurableFixture();
    fixture.fetchPreparedSnapshot
      .mockReset()
      .mockResolvedValueOnce(structuredClone(beforeDeposit))
      .mockResolvedValueOnce({
        ...structuredClone(verifiedDeposit),
        totalCents: 999,
      });

    await expect(
      commitStagedCategorization(commitInput(), fixture.deps),
    ).resolves.toMatchObject({
      ok: false,
      status: 'ERROR',
      outcome: 'UNCERTAIN',
    });
    expect(fixture.sendPreparedWrite).toHaveBeenCalledTimes(1);
    expect(fixture.db.transactionRow.status).toBe('ERROR');
    expect(fixture.db.attempts[0]?.status).toBe('UNCERTAIN');
  });

  it('restores a verified Deposit exactly through the prepared lifecycle', async () => {
    const fixture = depositDurableFixture();
    let qboSnapshot: QboDepositSnapshot = structuredClone(beforeDeposit);
    fixture.fetchPreparedSnapshot.mockImplementation(
      async () => structuredClone(qboSnapshot),
    );
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => currentQboTxn(qboSnapshot.syncToken, 'Deposit'),
    );
    fixture.sendPreparedWrite.mockImplementation(async (prepared) => {
      qboSnapshot = prepared.operation === 'restore'
        ? { ...structuredClone(beforeDeposit), syncToken: '9' }
        : structuredClone(verifiedDeposit);
      return {
        ok: true,
        newSyncToken: qboSnapshot.syncToken,
      };
    });

    await commitStagedCategorization(commitInput(), fixture.deps);
    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-deposit-restore',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).resolves.toMatchObject({
      ok: true,
      status: 'REVERTED',
      outcome: 'VERIFIED',
    });
    expect(fixture.prepareRestore).toHaveBeenCalledWith(
      expect.objectContaining({ qboType: 'Deposit', syncToken: '8' }),
      expect.objectContaining({ qboType: 'Deposit', operation: 'recategorize' }),
      'request-deposit-restore',
    );
    expect(fixture.db.attempts.at(-1)?.requestPayload).toMatchObject({
      qboType: 'Deposit',
      operation: 'restore',
      expected: {
        globalTaxCalculation: null,
        totalTaxCents: null,
        targetLines: beforeDeposit.lines,
      },
    });
    expect(qboSnapshot).toEqual({ ...beforeDeposit, syncToken: '9' });
  });

  it('rejects Deposit drift before preparing restore', async () => {
    const fixture = depositDurableFixture();
    seedAttempt(fixture.db, 'VERIFIED');
    fixture.db.transactionRow.status = 'POSTED';
    fixture.db.transactionRow.qboSyncToken = '8';
    fixture.fetchPreparedSnapshot
      .mockReset()
      .mockResolvedValue({
        ...structuredClone(verifiedDeposit),
        totalCents: 999,
      });
    (fixture.client.fetchTxn as ReturnType<typeof vi.fn>)
      .mockResolvedValue(currentQboTxn('8', 'Deposit'));

    await expect(
      undoCategorization({
        transactionId: DURABLE_TRANSACTION_ID,
        companyId: DURABLE_COMPANY_ID,
        requestId: 'request-deposit-restore',
        actor: { id: DURABLE_ACTOR_ID, label: 'Generic User' },
      }, fixture.deps),
    ).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });
    expect(fixture.prepareRestore).not.toHaveBeenCalled();
    expect(fixture.sendPreparedWrite).not.toHaveBeenCalled();
    expect(fixture.db.transactionRow.status).toBe('POSTED');
  });

  it('records a Deposit dry-run without creating a QBO client', async () => {
    const fixture = depositDurableFixture();
    fixture.db.transactionRow.company.dryRun = true;

    await expect(
      commitStagedCategorization(commitInput('request-deposit-dry-run'), fixture.deps),
    ).resolves.toMatchObject({
      ok: true,
      status: 'DRY_RUN',
      outcome: 'DRY_RUN',
    });
    expect(fixture.getClient).not.toHaveBeenCalled();
    expect(fixture.db.attempts[0]?.requestPayload).toMatchObject({
      qboType: 'Deposit',
      qboId: 'deposit-generic',
    });
  });
});
