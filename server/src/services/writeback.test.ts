import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { QboSyncTokenConflict, type QboClient, type QboTxn } from '../lib/qbo/types.js';
import { postTransaction, undoPost, validateSplits, type WritebackDeps } from './writeback.js';

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
  date: Date;
  payee: string;
  memo: string | null;
  amount: number;
  bankAccount: string;
  status: string;
  category: string | null;
  categoryQboId: string | null;
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
    date: new Date('2026-07-05'),
    payee: 'WEBFLOW.COM',
    memo: null,
    amount: -29,
    bankAccount: 'Visa ·0392',
    status: 'PENDING',
    category: 'Software subscriptions',
    categoryQboId: '25',
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
