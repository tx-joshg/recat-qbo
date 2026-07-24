import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { QboSyncTokenConflict, type QboClient, type QboTxn } from '../lib/qbo/types.js';
import { buildPurchaseRestore } from '../lib/qbo/purchaseTax.js';
import type { RawPurchase } from '../lib/qbo/real.js';
import {
  bulkPost,
  postTransaction,
  retryError,
  undoPost,
  validateSplits,
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

// ---------------------------------------------------------------------------
// postTransaction with injected fakes
// ---------------------------------------------------------------------------

interface FakeTxnRow {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  updatedAt: Date;
  date: Date;
  payee: string;
  memo: string | null;
  amount: number;
  bankAccount: string;
  status: string;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation?: string | null;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  splitLines: {
    idx: number;
    amount: number;
    category: string;
    categoryQboId: string | null;
    memo: string | null;
    tags: { tagId: string }[];
  }[];
  postedAt: Date | null;
  postedByUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  rawData?: unknown;
  txnTags: { txnId: string; tagId: string }[];
  company: {
    id: string;
    dryRun: boolean;
    tagsRequired: boolean;
    holdingAccountIds: string[];
  };
}

function makeTxnRow(overrides: Partial<FakeTxnRow> = {}): FakeTxnRow {
  return {
    id: 'txn-1',
    companyId: 'co-1',
    qboId: '6',
    qboType: 'Purchase',
    qboSyncToken: '0',
    updatedAt: new Date('2026-07-23T12:00:00.000Z'),
    date: new Date('2026-07-05'),
    payee: 'WEBFLOW.COM',
    memo: null,
    amount: -29,
    bankAccount: 'Visa ·0392',
    status: 'PENDING',
    category: 'Software subscriptions',
    categoryQboId: '25',
    taxCalculation: null,
    taxCode: null,
    taxCodeQboId: null,
    splitLines: [],
    postedAt: null,
    postedByUserId: null,
    errorCode: null,
    errorMessage: null,
    rawData: undefined,
    txnTags: [],
    company: { id: 'co-1', dryRun: false, tagsRequired: false, holdingAccountIds: ['4'] },
    ...overrides,
  };
}

function freshQboTxn(syncToken = '0'): QboTxn {
  return {
    qboId: '6',
    qboType: 'Purchase',
    syncToken,
    date: '2026-07-05',
    payee: 'WEBFLOW.COM',
    amount: -29,
    bankAccount: 'Visa ·0392',
    lines: [{ id: '1', amount: 29, accountQboId: '4', accountName: 'Ask My Accountant' }],
    raw: {},
  };
}

function makeFakeDb(row: FakeTxnRow) {
  let attemptNumber = 0;
  const db = {
    transaction: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(row, args.data);
        return { count: 1 };
      }),
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
    qboTaxCode: {
      findFirst: vi.fn(async () => ({
        qboId: 'tax-gst',
        name: 'GST 5%',
        active: true,
        taxable: true,
        purchaseTaxRateList: [{ taxRateQboId: 'rate-gst' }],
      })),
    },
    qboMutationAttempt: {
      create: vi.fn(async () => ({ id: `attempt-${++attemptNumber}` })),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
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
  const deps: WritebackDeps = {
    db: db as unknown as PrismaClient,
    getClient: async () => client as QboClient,
    audit,
    envDryRun,
  };
  return { deps, db, audit };
}

describe('postTransaction dry-run', () => {
  it('keeps an unresolved restore in ERROR when the holding line is absent', async () => {
    const row = makeTxnRow({ status: 'ERROR' });
    const client: Partial<QboClient> = {
      fetchTxn: vi.fn(async () => ({
        ...freshQboTxn(),
        lines: [
          {
            id: '1',
            amount: 29,
            accountQboId: '25',
            accountName: 'Software subscriptions',
          },
        ],
      })),
    };
    const { deps, db } = makeDeps(row, client);
    db.qboMutationAttempt.findFirst.mockResolvedValueOnce({ id: 'restore-1' });

    await expect(
      postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps),
    ).resolves.toMatchObject({
      ok: false,
      status: 'ERROR',
      error: { code: 'QBO_WRITE_UNCERTAIN' },
    });

    expect(row.status).toBe('ERROR');
    expect(db.qboMutationAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to claim staging newer than the version supplied by its caller', async () => {
    const row = makeTxnRow({
      updatedAt: new Date('2026-07-23T12:00:01.000Z'),
    });
    const client: Partial<QboClient> = { fetchTxn: vi.fn() };
    const { deps, db } = makeDeps(row, client);

    await expect(
      postTransaction(
        'txn-1',
        { id: null, label: 'autopilot' },
        { auto: true, expectedUpdatedAt: new Date('2026-07-23T12:00:00.000Z') },
        deps,
      ),
    ).rejects.toThrow('changed after staging');
    expect(db.transaction.updateMany).not.toHaveBeenCalled();
    expect(client.fetchTxn).not.toHaveBeenCalled();
  });

  it('allows only one caller to atomically claim a transaction for posting', async () => {
    const row = makeTxnRow();
    const client: Partial<QboClient> = { fetchTxn: vi.fn() };
    const { deps, db } = makeDeps(row, client);
    db.transaction.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      postTransaction('txn-1', { id: 'u-1', label: 'Maria K.' }, {}, deps),
    ).rejects.toThrow('changed before posting');
    expect(client.fetchTxn).not.toHaveBeenCalled();
  });

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

describe('postTransaction prepared tax mutations', () => {
  function prepared(syncToken: string, requestId: string) {
    return {
      qboType: 'Purchase' as const,
      operation: 'recategorize' as const,
      path: '/purchase' as const,
      requestId,
      body: {
        Id: '6',
        SyncToken: syncToken,
        TotalAmt: 29,
        GlobalTaxCalculation: 'TaxInclusive' as const,
        Line: [
          {
            Amount: 27.62,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '25' },
              TaxCodeRef: { value: 'tax-gst' },
              TaxInclusiveAmt: 29,
            },
          },
        ],
      },
      before: { Id: '6', SyncToken: syncToken, TotalAmt: 29, Line: [] },
      expected: {
        qboId: '6',
        totalAmtCents: 2900,
        fundingAccountQboId: null,
        currencyQboId: null,
        txnDate: null,
        credit: false,
        taxCalculation: 'TaxInclusive' as const,
        targetLines: [
          {
            accountQboId: '25',
            taxCodeQboId: 'tax-gst',
            grossCents: 2900,
            netCents: 2762,
            taxCents: 138,
          },
        ],
        untouchedLineHashes: [],
      },
    };
  }

  function verifiedAfter(syncToken: string, mutation: ReturnType<typeof prepared>): QboTxn {
    return {
      qboId: '6',
      qboType: 'Purchase',
      syncToken,
      date: '',
      payee: 'WEBFLOW.COM',
      amount: 0,
      bankAccount: '',
      lines: [],
      raw: {
        ...mutation.body,
        SyncToken: syncToken,
        TxnTaxDetail: { TotalTax: 1.38 },
      },
    };
  }

  function taxRow(dryRun: boolean): FakeTxnRow {
    return makeTxnRow({
      taxCalculation: 'TaxInclusive',
      taxCode: 'GST 5%',
      taxCodeQboId: 'tax-gst',
      company: { id: 'co-1', dryRun, tagsRequired: false, holdingAccountIds: ['4'] },
    });
  }

  it('audits a DRY_RUN body deeply equal to the equivalent live prepared body', async () => {
    const dryRow = taxRow(true);
    const prepareDry = vi.fn(async (txn: QboTxn, _plan: unknown, requestId: string) =>
      prepared(txn.syncToken, requestId),
    );
    const executeDry = vi.fn();
    const dry = makeDeps(dryRow, {
      fetchTxn: async () => freshQboTxn(),
      prepareRecategorization: prepareDry,
      executePreparedWrite: executeDry,
    });
    await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, dry.deps);
    const dryPayload = (dry.audit.mock.calls[0]![1] as { payload: { qbo: { body: unknown; path: string } } }).payload;
    expect(executeDry).not.toHaveBeenCalled();

    const liveRow = taxRow(false);
    const prepareLive = vi.fn(async (txn: QboTxn, _plan: unknown, requestId: string) =>
      prepared(txn.syncToken, requestId),
    );
    const executeLive = vi.fn(async (mutation: ReturnType<typeof prepared>) => ({
      ok: true as const,
      newSyncToken: '1',
      rawResponse: { Purchase: { ...mutation.body, SyncToken: '1' } },
    }));
    let livePrepared: ReturnType<typeof prepared> | null = null;
    const liveFetch = vi.fn(async () =>
      livePrepared === null ? freshQboTxn() : verifiedAfter('1', livePrepared),
    );
    const live = makeDeps(liveRow, {
      fetchTxn: liveFetch,
      prepareRecategorization: prepareLive,
      executePreparedWrite: async (mutation) => {
        livePrepared = mutation;
        return executeLive(mutation);
      },
    });
    await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, live.deps);
    const executed = executeLive.mock.calls[0]![0];

    expect(dryPayload.qbo.path).toBe('/purchase');
    expect(dryPayload.qbo.body).toEqual(executed.body);
  });

  it('reuses one stable request ID across a stale-token rebuild', async () => {
    const row = taxRow(false);
    const prepare = vi.fn(async (txn: QboTxn, _plan: unknown, requestId: string) =>
      prepared(txn.syncToken, requestId),
    );
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new QboSyncTokenConflict())
      .mockResolvedValueOnce({ ok: true, newSyncToken: '2', rawResponse: {} });
    let lastPrepared: ReturnType<typeof prepared> | null = null;
    const fetchTxn = vi
      .fn()
      .mockResolvedValueOnce(freshQboTxn('1'))
      .mockResolvedValueOnce(freshQboTxn('2'))
      .mockImplementationOnce(async () => {
        if (!lastPrepared) throw new Error('prepared mutation missing');
        return verifiedAfter('3', lastPrepared);
      });
    const { deps } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: prepare,
      executePreparedWrite: async (mutation) => {
        lastPrepared = mutation;
        return execute(mutation);
      },
    });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);
    expect(result.ok).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![2]).toBe(prepare.mock.calls[1]![2]);
    expect(execute.mock.calls[0]![0].requestId).toBe(execute.mock.calls[1]![0].requestId);
  });

  it('marks a successful write uncertain when read-back is unavailable', async () => {
    const row = taxRow(false);
    const prepare = vi.fn(async (txn: QboTxn, _plan: unknown, requestId: string) =>
      prepared(txn.syncToken, requestId),
    );
    const fetchTxn = vi.fn().mockResolvedValueOnce(freshQboTxn()).mockResolvedValueOnce(null);
    const { deps } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: prepare,
      executePreparedWrite: async () => ({ ok: true, newSyncToken: '1', rawResponse: {} }),
    });
    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);
    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      error: { code: 'QBO_WRITE_UNCERTAIN' },
    });
    expect(row.errorMessage).toMatch(/verify/i);
  });

  it('recovers a lost write response when fresh read-back proves the prepared state', async () => {
    const row = taxRow(false);
    let mutation: ReturnType<typeof prepared> | null = null;
    const fetchTxn = vi.fn(async () =>
      mutation === null ? freshQboTxn() : verifiedAfter('1', mutation),
    );
    const { deps, db } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: async (txn, _plan, requestId) => prepared(txn.syncToken, requestId),
      executePreparedWrite: async (preparedMutation) => {
        mutation = preparedMutation;
        throw new Error('socket closed before the response arrived');
      },
    });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(row.status).toBe('POSTED');
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) }),
    );
  });

  it('marks a rejected write failed when read-back proves the source is unchanged', async () => {
    const row = taxRow(false);
    const fetchTxn = vi.fn().mockResolvedValueOnce(freshQboTxn('0')).mockResolvedValueOnce(freshQboTxn('0'));
    const { deps, db } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: async (txn, _plan, requestId) => prepared(txn.syncToken, requestId),
      executePreparedWrite: async () => {
        throw new Error('QuickBooks rejected the request');
      },
    });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);

    expect(result).toMatchObject({ ok: false, status: 'ERROR', error: { code: 'QBO_ERROR' } });
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('marks a lost write response uncertain when read-back has a different state', async () => {
    const row = taxRow(false);
    const drifted = freshQboTxn('2');
    const fetchTxn = vi.fn().mockResolvedValueOnce(freshQboTxn('0')).mockResolvedValueOnce(drifted);
    const { deps, db } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: async (txn, _plan, requestId) => prepared(txn.syncToken, requestId),
      executePreparedWrite: async () => {
        throw new Error('socket closed before the response arrived');
      },
    });

    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);

    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      error: { code: 'QBO_WRITE_UNCERTAIN' },
    });
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UNCERTAIN' }) }),
    );
  });

  it('does not mark POSTED when QBO read-back differs from the prepared state', async () => {
    const row = taxRow(false);
    let mutation: ReturnType<typeof prepared> | null = null;
    const fetchTxn = vi.fn(async () => {
      if (!mutation) return freshQboTxn();
      const drifted = verifiedAfter('1', mutation);
      const raw = drifted.raw as { Line: { AccountBasedExpenseLineDetail?: { TaxCodeRef?: unknown } }[] };
      raw.Line[0]!.AccountBasedExpenseLineDetail!.TaxCodeRef = undefined;
      return drifted;
    });
    const { deps } = makeDeps(row, {
      fetchTxn,
      prepareRecategorization: async (txn, _plan, requestId) => prepared(txn.syncToken, requestId),
      executePreparedWrite: async (preparedMutation) => {
        mutation = preparedMutation;
        return { ok: true, newSyncToken: '1', rawResponse: {} };
      },
    });
    const result = await postTransaction('txn-1', { id: 'u-1', label: 'Maria' }, {}, deps);
    expect(result).toMatchObject({ ok: false, status: 'ERROR', error: { code: 'QBO_STATE_DRIFT' } });
    expect(row.status).toBe('ERROR');
  });

  it('reconciles an uncertain attempt as POSTED instead of sending another write', async () => {
    const row = taxRow(false);
    row.status = 'ERROR';
    const mutation = prepared('0', 'request-1');
    const { deps, db } = makeDeps(row, {
      fetchTxn: async () => verifiedAfter('1', mutation),
    });
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      id: 'attempt-1',
      requestId: mutation.requestId,
      requestBody: mutation.body,
      expected: mutation.expected,
    });

    const result = await retryError('txn-1', deps);

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(row.status).toBe('POSTED');
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) }),
    );
  });

  it('permits a retry only after read-back proves an uncertain write never landed', async () => {
    const row = taxRow(false);
    row.status = 'ERROR';
    const mutation = prepared('0', 'request-1');
    const { deps, db } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('0'),
    });
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      id: 'attempt-1',
      requestId: mutation.requestId,
      requestBody: mutation.body,
      expected: mutation.expected,
    });

    const result = await retryError('txn-1', deps);

    expect(result).toMatchObject({ ok: true, status: 'PENDING' });
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('blocks retry when an uncertain Purchase has drifted', async () => {
    const row = taxRow(false);
    row.status = 'ERROR';
    const mutation = prepared('0', 'request-1');
    const { deps, db } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('2'),
    });
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      id: 'attempt-1',
      requestId: mutation.requestId,
      requestBody: mutation.body,
      expected: mutation.expected,
    });

    await expect(retryError('txn-1', deps)).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });
    expect(row.status).toBe('ERROR');
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'MISMATCH' }) }),
    );
  });
});

describe('tax-aware undo', () => {
  it.each([
    { caseName: 'normal response', loseResponse: false },
    { caseName: 'lost response recovered by read-back', loseResponse: true },
  ])('uses the verified before snapshot and verifies exact restore ($caseName)', async ({ loseResponse }) => {
    const row = makeTxnRow({
      status: 'POSTED',
      postedAt: new Date(),
      qboSyncToken: '1',
      taxCalculation: 'TaxInclusive',
      taxCode: 'GST 5%',
      taxCodeQboId: 'tax-gst',
    });
    const { deps, db, audit } = makeDeps(row, {});
    const original: RawPurchase = {
      Id: '6',
      SyncToken: '0',
      TotalAmt: 29,
      AccountRef: { value: 'bank-1' },
      GlobalTaxCalculation: 'NotApplicable',
      TxnTaxDetail: { TotalTax: 0 },
      Line: [
        {
          Id: 'holding-line',
          Amount: 29,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '4' },
            TaxCodeRef: { value: 'tax-oos' },
          },
        },
      ],
    };
    const postedMutation = {
      qboType: 'Purchase' as const,
      operation: 'recategorize' as const,
      path: '/purchase' as const,
      requestId: 'post-request',
      body: {
        Id: '6',
        SyncToken: '0',
        TotalAmt: 29,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive' as const,
        Line: [
          {
            Amount: 27.62,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '25' },
              TaxCodeRef: { value: 'tax-gst' },
              TaxInclusiveAmt: 29,
            },
          },
        ],
      },
      before: original,
      expected: {
        qboId: '6',
        totalAmtCents: 2900,
        fundingAccountQboId: 'bank-1',
        currencyQboId: null,
        txnDate: null,
        credit: false,
        taxCalculation: 'TaxInclusive' as const,
        targetLines: [
          {
            accountQboId: '25',
            taxCodeQboId: 'tax-gst',
            grossCents: 2900,
            netCents: 2762,
            taxCents: 138,
          },
        ],
        untouchedLineHashes: [],
      },
    };
    const posted: QboTxn = {
      qboId: '6',
      qboType: 'Purchase',
      syncToken: '1',
      date: '',
      payee: 'WEBFLOW.COM',
      amount: 0,
      bankAccount: 'Visa',
      lines: [],
      raw: {
        ...postedMutation.body,
        SyncToken: '1',
        TxnTaxDetail: { TotalTax: 1.38 },
      },
    };
    const restore = buildPurchaseRestore(posted, original, 'undo-request');
    const restored: QboTxn = {
      ...posted,
      syncToken: '2',
      raw: {
        ...restore.body,
        SyncToken: '2',
        TxnTaxDetail: { TotalTax: 0 },
      },
    };
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      before: original,
      expected: postedMutation.expected,
    });
    let wrote = false;
    deps.getClient = async () =>
      ({
        fetchTxn: vi.fn(async () => (wrote ? restored : posted)),
        preparePurchaseRestore: vi.fn(async () => restore),
        executePreparedWrite: vi.fn(async () => {
          wrote = true;
          if (loseResponse) throw new Error('socket closed before the response arrived');
          return { ok: true, newSyncToken: '2', rawResponse: { Purchase: restored.raw } };
        }),
      }) as unknown as QboClient;

    const result = await undoPost('txn-1', { id: 'u-1', label: 'Maria' }, deps);
    expect(result).toMatchObject({ ok: true, status: 'PENDING' });
    expect(row.status).toBe('PENDING');
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'reverted',
        payload: expect.objectContaining({
          qbo: expect.objectContaining({ requestId: 'undo-request' }),
          verification: expect.objectContaining({ ok: true }),
        }),
      }),
    );
  });

  it('moves an unverified restore into ERROR so live writes remain blocked', async () => {
    const row = makeTxnRow({
      status: 'POSTED',
      postedAt: new Date(),
      qboSyncToken: '1',
      taxCalculation: 'TaxInclusive',
      taxCode: 'GST 5%',
      taxCodeQboId: 'tax-gst',
    });
    const original: RawPurchase = {
      Id: '6',
      SyncToken: '0',
      TotalAmt: 29,
      AccountRef: { value: 'bank-1' },
      GlobalTaxCalculation: 'NotApplicable',
      TxnTaxDetail: { TotalTax: 0 },
      Line: [
        {
          Id: 'holding-line',
          Amount: 29,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '4' },
            TaxCodeRef: { value: 'tax-oos' },
          },
        },
      ],
    };
    const posted = {
      qboId: '6',
      qboType: 'Purchase' as const,
      syncToken: '1',
      date: '',
      payee: 'WEBFLOW.COM',
      amount: 0,
      bankAccount: 'Visa',
      lines: [],
      raw: {
        Id: '6',
        SyncToken: '1',
        TotalAmt: 29,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TxnTaxDetail: { TotalTax: 1.38 },
        Line: [
          {
            Amount: 27.62,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '25' },
              TaxCodeRef: { value: 'tax-gst' },
              TaxInclusiveAmt: 29,
            },
          },
        ],
      },
    } satisfies QboTxn;
    const restore = buildPurchaseRestore(posted, original, 'undo-request');
    const { deps, db } = makeDeps(row, {});
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      before: original,
      expected: {
        qboId: '6',
        totalAmtCents: 2900,
        fundingAccountQboId: 'bank-1',
        currencyQboId: null,
        txnDate: null,
        credit: false,
        taxCalculation: 'TaxInclusive',
        targetLines: [
          {
            accountQboId: '25',
            taxCodeQboId: 'tax-gst',
            grossCents: 2900,
            netCents: 2762,
            taxCents: 138,
          },
        ],
        untouchedLineHashes: [],
      },
    });
    let readCount = 0;
    deps.getClient = async () =>
      ({
        fetchTxn: vi.fn(async () => {
          readCount += 1;
          return readCount === 1 ? posted : null;
        }),
        preparePurchaseRestore: vi.fn(async () => restore),
        executePreparedWrite: vi.fn(async () => ({
          ok: true,
          newSyncToken: '2',
          rawResponse: {},
        })),
      }) as unknown as QboClient;

    await expect(
      undoPost('txn-1', { id: 'u-1', label: 'Maria' }, deps),
    ).rejects.toMatchObject({ code: 'QBO_WRITE_UNCERTAIN' });

    expect(row.status).toBe('ERROR');
    expect(row.errorCode).toBe('QBO_WRITE_UNCERTAIN');
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UNCERTAIN' }) }),
    );
  });

  it('reconciles an uncertain restore on retry without issuing another write', async () => {
    const row = makeTxnRow({
      status: 'ERROR',
      postedAt: new Date(),
      qboSyncToken: '1',
      taxCalculation: 'TaxInclusive',
    });
    const original: RawPurchase = {
      Id: '6',
      SyncToken: '0',
      TotalAmt: 29,
      AccountRef: { value: 'bank-1' },
      GlobalTaxCalculation: 'NotApplicable',
      TxnTaxDetail: { TotalTax: 0 },
      Line: [
        {
          Id: 'holding-line',
          Amount: 29,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '4' },
            TaxCodeRef: { value: 'tax-oos' },
          },
        },
      ],
    };
    const posted = {
      qboId: '6',
      qboType: 'Purchase' as const,
      syncToken: '1',
      date: '',
      payee: 'WEBFLOW.COM',
      amount: 0,
      bankAccount: 'Visa',
      lines: [],
      raw: {
        Id: '6',
        SyncToken: '1',
        TotalAmt: 29,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TxnTaxDetail: { TotalTax: 1.38 },
        Line: [
          {
            Amount: 27.62,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '25' },
              TaxCodeRef: { value: 'tax-gst' },
              TaxInclusiveAmt: 29,
            },
          },
        ],
      },
    } satisfies QboTxn;
    const restore = buildPurchaseRestore(posted, original, 'undo-request');
    const restored = {
      ...posted,
      syncToken: '2',
      raw: {
        ...restore.body,
        SyncToken: '2',
        TxnTaxDetail: { TotalTax: 0 },
      },
    } satisfies QboTxn;
    const { deps, db } = makeDeps(row, { fetchTxn: async () => restored });
    vi.mocked(db.qboMutationAttempt.findFirst).mockResolvedValueOnce({
      id: 'undo-attempt',
      operation: 'restore',
      requestId: restore.requestId,
      requestBody: restore.body,
      expected: restore.expected,
    });

    await expect(retryError('txn-1', deps)).resolves.toMatchObject({
      ok: true,
      status: 'PENDING',
    });
    expect(row.status).toBe('PENDING');
    expect(row.postedAt).toBeNull();
    expect(db.qboMutationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) }),
    );
  });
});

describe('postTransaction SyncToken conflict handling', () => {
  it('checks the accounting-write lease immediately before the first QBO mutation', async () => {
    const row = makeTxnRow();
    const recategorize = vi.fn(async () => ({ ok: true as const, newSyncToken: '2' }));
    const { deps } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('1'),
      recategorize,
    });

    const result = await postTransaction(
      'txn-1',
      { id: 'u-1', label: 'Josh M.' },
      { canWrite: async () => false },
      deps,
    );

    expect(recategorize).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      error: { code: 'ACCOUNTING_WRITE_LEASE_LOST' },
    });
  });

  it('checks the accounting-write lease again before a SyncToken-conflict retry', async () => {
    const row = makeTxnRow();
    const recategorize = vi.fn(async () => {
      throw new QboSyncTokenConflict();
    });
    const { deps } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('1'),
      recategorize,
    });
    const canWrite = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await postTransaction(
      'txn-1',
      { id: 'u-1', label: 'Josh M.' },
      { canWrite },
      deps,
    );

    expect(recategorize).toHaveBeenCalledOnce();
    expect(canWrite).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      status: 'ERROR',
      error: { code: 'ACCOUNTING_WRITE_LEASE_LOST' },
    });
  });

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

describe('bulkPost accounting-write lease guard', () => {
  it('stops before the next QBO write after its lease is lost', async () => {
    const row = makeTxnRow({
      company: { id: 'co-1', dryRun: false, tagsRequired: false, holdingAccountIds: ['4'] },
    });
    const recategorize = vi.fn(async () => ({ ok: true as const, newSyncToken: '2' }));
    const client: Partial<QboClient> = {
      fetchTxn: async () => freshQboTxn(),
      recategorize,
    };
    const { deps } = makeDeps(row, client);
    const canContinue = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const results = await bulkPost(
      ['txn-1', 'txn-2', 'txn-3'],
      { id: 'u-1', label: 'Maria K.' },
      deps,
      canContinue,
    );

    expect(recategorize).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      expect.objectContaining({ id: 'txn-1', ok: true }),
      expect.objectContaining({
        id: 'txn-2',
        ok: false,
        error: expect.objectContaining({ code: 'ACCOUNTING_WRITE_LEASE_LOST' }),
      }),
      expect.objectContaining({
        id: 'txn-3',
        ok: false,
        error: expect.objectContaining({ code: 'ACCOUNTING_WRITE_LEASE_LOST' }),
      }),
    ]);
  });
});

describe('undoPost', () => {
  const postedCompany = { id: 'co-1', dryRun: true, tagsRequired: false, holdingAccountIds: ['4'] };

  it('checks the accounting-write lease immediately before a legacy QBO undo', async () => {
    const row = makeTxnRow({ status: 'POSTED', postedAt: new Date(), company: postedCompany });
    const moveToAccount = vi.fn(async () => ({ ok: true as const, newSyncToken: '5' }));
    const { deps } = makeDeps(row, {
      fetchTxn: async () => freshQboTxn('4'),
      moveToAccount,
    });

    await expect(
      undoPost(
        'txn-1',
        { id: 'u-1', label: 'Maria K.' },
        deps,
        async () => false,
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_WRITE_LEASE_LOST' });

    expect(moveToAccount).not.toHaveBeenCalled();
    expect(row.status).toBe('POSTED');
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

  it('restores the original QuickBooks Purchase tax default when reopening a legacy dry run', async () => {
    const row = makeTxnRow({
      status: 'DRY_RUN',
      postedAt: new Date(),
      company: postedCompany,
      rawData: {
        GlobalTaxCalculation: 'TaxInclusive',
        Line: [
          {
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '4' },
              TaxCodeRef: { value: '5' },
            },
          },
        ],
      },
    });
    const { deps, db } = makeDeps(row, {});
    db.qboTaxCode.findFirst.mockResolvedValueOnce({
      qboId: '5',
      name: 'Out of Scope',
      active: true,
      taxable: true,
      purchaseTaxRateList: [{ taxRateQboId: '21' }],
    });

    await expect(
      undoPost('txn-1', { id: 'u-1', label: 'Maria K.' }, deps),
    ).resolves.toMatchObject({ ok: true, status: 'PENDING' });

    expect(row).toMatchObject({
      status: 'PENDING',
      taxCalculation: 'TaxInclusive',
      taxCode: 'Out of Scope',
      taxCodeQboId: '5',
    });
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
