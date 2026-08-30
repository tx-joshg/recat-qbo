import type {
  CategorizationProposal,
  StageCategorizationInput,
} from '@recat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CategorizationError,
  stageCategorization,
  stageCategorizationWithWorkflow,
  type CategorizationDb,
  type CategorizationDeps,
} from './categorization.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000020';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000030';
const TAG_ID = '00000000-0000-4000-8000-000000000001';
const LINE_TAG_ID = '00000000-0000-4000-8000-000000000002';

const standardProposal: CategorizationProposal = {
  taxCalculation: 'TaxInclusive',
  lines: [{
    grossCents: -1050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCodeQboId: 'TAX_CODE_STANDARD',
    memo: 'Prepared purchase',
    tagIds: [LINE_TAG_ID],
  } as CategorizationProposal['lines'][number]],
  tagIds: ['00000000-0000-4000-8000-000000000001'],
};

const preserveCurrentProposal: CategorizationProposal = {
  taxDisposition: 'preserve_current',
  taxCalculation: 'NotApplicable',
  lines: [{
    grossCents: -75_000,
    categoryQboId: '42',
    taxCodeQboId: 'NON',
    tagIds: [],
  }],
  tagIds: [],
};

interface TransactionRow {
  id: string;
  companyId: string;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  amount: number;
  status: string;
  revision: number;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  rawData: unknown;
}

interface SplitRow {
  id: string;
  txnId: string;
  idx: number;
  amount: number;
  category: string;
  categoryQboId: string | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  memo: string | null;
}

interface FakeState {
  transactions: TransactionRow[];
  accounts: { companyId: string; qboId: string; name: string; fullName: string; active: boolean }[];
  tags: { companyId: string; id: string }[];
  taxCodes: {
    companyId: string;
    qboId: string;
    name: string;
    active: boolean;
    taxable: boolean | null;
    purchaseTaxRateList: unknown;
    salesTaxRateList: unknown;
    combinedSalesRate: number | string | null;
  }[];
  taxRates: {
    companyId: string;
    qboId: string;
    name: string;
    active: boolean;
    rateValue: number | null;
  }[];
  companies: {
    id: string;
    taxSupportStatus: string;
    taxSupportReason: string | null;
    taxUsingSalesTax: boolean | null;
    taxReferenceRefreshedAt: Date | null;
  }[];
  splits: SplitRow[];
  splitTags: { splitLineId: string; tagId: string }[];
  txnTags: { txnId: string; tagId: string }[];
  attempts: { transactionId: string; status: string }[];
}

function matchesScalar<T>(actual: T, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && 'in' in expected) {
    return (expected as { in: T[] }).in.includes(actual);
  }
  return actual === expected;
}

class FakeCategorizationDb implements CategorizationDb {
  transactionCalls = 0;
  lastUpdateMany: unknown = null;
  private splitSequence = 0;

  constructor(public state: FakeState) {}

  transaction: CategorizationDb['transaction'] = {
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
    findUniqueOrThrow: async () => {
      throw new Error('not initialized');
    },
  };

  company: CategorizationDb['company'] = {
    findUnique: async () => null,
  };

  qboAccount: CategorizationDb['qboAccount'] = {
    findMany: async () => [],
  };

  tag: CategorizationDb['tag'] = {
    findMany: async () => [],
  };

  qboTaxCode: CategorizationDb['qboTaxCode'] = {
    findMany: async () => [],
  };

  qboTaxRate: CategorizationDb['qboTaxRate'] = {
    findMany: async () => [],
  };

  qboMutationAttempt = {
    findFirst: async (_args: {
      where: { transactionId: string; status: { in: string[] } };
      select: { id: true };
    }) => null as { id: string } | null,
  };

  splitLine: CategorizationDb['splitLine'] = {
    deleteMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
    findMany: async () => [],
  };

  splitLineTag: CategorizationDb['splitLineTag'] = {
    createMany: async (_args: {
      data: { splitLineId: string; tagId: string }[];
    }) => ({ count: 0 }),
  };

  txnTag: CategorizationDb['txnTag'] = {
    deleteMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
  };

  initialize(): this {
    this.transaction.findFirst = async ({ where }) =>
      this.state.transactions.find(
        (row) => matchesScalar(row.id, where.id) && matchesScalar(row.companyId, where.companyId),
      ) ?? null;
    this.transaction.updateMany = async (args) => {
      this.lastUpdateMany = structuredClone(args);
      const row = this.state.transactions.find(
        (candidate) =>
          matchesScalar(candidate.id, args.where.id) &&
          matchesScalar(candidate.companyId, args.where.companyId) &&
          matchesScalar(candidate.revision, args.where.revision) &&
          matchesScalar(candidate.status, args.where.status),
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    };
    this.transaction.findUniqueOrThrow = async ({ where }) => {
      const row = this.state.transactions.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('missing transaction');
      return {
        ...row,
        splitLines: this.state.splits
          .filter((split) => split.txnId === row.id)
          .sort((left, right) => left.idx - right.idx)
          .map((split) => ({
            ...split,
            tags: this.state.splitTags
              .filter((tag) => tag.splitLineId === split.id)
              .map((tag) => ({ tagId: tag.tagId })),
          })),
        txnTags: this.state.txnTags.filter((tag) => tag.txnId === row.id),
      };
    };
    this.company.findUnique = async ({ where }) =>
      this.state.companies.find((row) => row.id === where.id) ?? null;
    this.qboAccount.findMany = async ({ where }) =>
      this.state.accounts.filter(
        (row) =>
          row.companyId === where.companyId &&
          matchesScalar(row.qboId, where.qboId) &&
          (where.active === undefined || row.active === where.active),
      );
    this.tag.findMany = async ({ where }) =>
      this.state.tags.filter(
        (row) => row.companyId === where.companyId && matchesScalar(row.id, where.id),
      );
    this.qboTaxCode.findMany = async ({ where }) =>
      this.state.taxCodes.filter(
        (row) =>
          row.companyId === where.companyId &&
          (where.qboId === undefined || matchesScalar(row.qboId, where.qboId)),
      );
    this.qboTaxRate.findMany = async ({ where }) => {
      const rows = this.state.taxRates.filter(
        (row) =>
          row.companyId === where.companyId
          && (where.active === undefined || row.active === where.active),
      );
      if (rows.some((row) => row.rateValue === null) && where.rateValue?.not !== null) {
        throw new Error('Prisma cannot decode a legacy null tax rate through a non-null model field.');
      }
      return rows.filter((row) => where.rateValue?.not !== null || row.rateValue !== null);
    };
    this.qboMutationAttempt.findFirst = async ({ where }) => {
      const attempt = this.state.attempts.find(
        (row) =>
          row.transactionId === where.transactionId &&
          where.status.in.includes(row.status),
      );
      return attempt ? { id: 'active-attempt' } : null;
    };
    this.splitLine.deleteMany = async ({ where }) => {
      const deletedIds = new Set(
        this.state.splits
          .filter((row) => row.txnId === where.txnId)
          .map((row) => row.id),
      );
      const before = this.state.splits.length;
      this.state.splits = this.state.splits.filter((row) => row.txnId !== where.txnId);
      this.state.splitTags = this.state.splitTags.filter((row) => !deletedIds.has(row.splitLineId));
      return { count: before - this.state.splits.length };
    };
    this.splitLine.createMany = async ({ data }) => {
      for (const row of data) {
        this.state.splits.push({
          id: `split-${++this.splitSequence}`,
          ...row,
        });
      }
      return { count: data.length };
    };
    this.splitLine.findMany = async ({ where }) =>
      this.state.splits
        .filter((row) => row.txnId === where.txnId)
        .sort((left, right) => left.idx - right.idx)
        .map((row) => ({ id: row.id, idx: row.idx }));
    this.splitLineTag.createMany = async ({ data }) => {
      this.state.splitTags.push(...data);
      return { count: data.length };
    };
    this.txnTag.deleteMany = async ({ where }) => {
      const before = this.state.txnTags.length;
      this.state.txnTags = this.state.txnTags.filter((row) => row.txnId !== where.txnId);
      return { count: before - this.state.txnTags.length };
    };
    this.txnTag.createMany = async ({ data }) => {
      this.state.txnTags.push(...data);
      return { count: data.length };
    };
    return this;
  }

  async $transaction<T>(callback: (tx: CategorizationDb) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const snapshot = structuredClone(this.state);
    try {
      return await callback(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }
}

function initialState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    transactions: [{
      id: TRANSACTION_ID,
      companyId: COMPANY_ID,
      qboType: 'Purchase',
      qboId: 'QBO_PURCHASE_30',
      qboSyncToken: '7',
      amount: -10.5,
      status: 'PENDING',
      revision: 0,
      category: 'Old category',
      categoryQboId: 'OLD_ACCOUNT',
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      rawData: null,
    }],
    accounts: [{
      companyId: COMPANY_ID,
      qboId: 'EXPENSE_ACCOUNT',
      name: 'Prepared purchases',
      fullName: 'Expenses · Prepared purchases',
      active: true,
    }],
    tags: [
      { companyId: COMPANY_ID, id: TAG_ID },
      { companyId: COMPANY_ID, id: LINE_TAG_ID },
    ],
    taxCodes: [{
      companyId: COMPANY_ID,
      qboId: 'TAX_CODE_STANDARD',
      name: 'Standard tax',
      active: true,
      taxable: true,
      purchaseTaxRateList: [{
        taxRateQboId: 'TAX_RATE_STANDARD',
        taxTypeApplicable: 'TaxOnAmount',
      }],
      salesTaxRateList: [{
        taxRateQboId: 'TAX_RATE_SALES',
        taxTypeApplicable: 'TaxOnAmount',
      }],
      combinedSalesRate: 7,
    }],
    taxRates: [{
      companyId: COMPANY_ID,
      qboId: 'TAX_RATE_STANDARD',
      name: 'Standard purchase rate',
      active: true,
      rateValue: 5,
    }, {
      companyId: COMPANY_ID,
      qboId: 'TAX_RATE_SALES',
      name: 'Standard sales rate',
      active: true,
      rateValue: 7,
    }],
    companies: [{
      id: COMPANY_ID,
      taxSupportStatus: 'ready',
      taxSupportReason: null,
      taxUsingSalesTax: true,
      taxReferenceRefreshedAt: new Date('2026-07-27T00:00:00.000Z'),
    }],
    splits: [{
      id: 'old-split',
      txnId: TRANSACTION_ID,
      idx: 0,
      amount: -10.5,
      category: 'Old category',
      categoryQboId: 'OLD_ACCOUNT',
      taxCode: null,
      taxCodeQboId: null,
      memo: null,
    }],
    splitTags: [{
      splitLineId: 'old-split',
      tagId: '00000000-0000-4000-8000-000000000098',
    }],
    txnTags: [{ txnId: TRANSACTION_ID, tagId: '00000000-0000-4000-8000-000000000099' }],
    attempts: [],
    ...overrides,
  };
}

function configureValidPreserveSource(db: FakeCategorizationDb): void {
  db.state.splits = [];
  db.state.splitTags = [];
  db.state.txnTags = [];
  Object.assign(db.state.transactions[0]!, {
    amount: -750,
    categoryQboId: 'STALE_LOCAL_CATEGORY',
    taxCalculation: 'NotApplicable',
    taxCode: 'Stale local tax',
    taxCodeQboId: 'STALE_LOCAL_TAX',
    rawData: {
      Id: 'QBO_PURCHASE_30',
      SyncToken: '7',
      TotalAmt: 750,
      GlobalTaxCalculation: 'NotApplicable',
      Line: [{
        Id: '1',
        Amount: 750,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: '2' },
          TaxCodeRef: { value: 'NON' },
        },
      }],
    },
  });
  db.state.accounts.push(
    {
      companyId: COMPANY_ID,
      qboId: '42',
      name: 'Bank Charges',
      fullName: 'Expenses · Bank Charges',
      active: true,
    },
    {
      companyId: COMPANY_ID,
      qboId: '2',
      name: 'Uncategorized Expense',
      fullName: 'Expenses · Uncategorized Expense',
      active: true,
    },
  );
  db.state.taxCodes.push({
    companyId: COMPANY_ID,
    qboId: 'NON',
    name: 'Non-taxable',
    active: true,
    taxable: false,
    purchaseTaxRateList: [],
    salesTaxRateList: [],
    combinedSalesRate: null,
  });
}

function input(proposal: CategorizationProposal = standardProposal): StageCategorizationInput {
  return {
    transactionId: TRANSACTION_ID,
    companyId: COMPANY_ID,
    expectedRevision: 0,
    proposal,
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: CategorizationError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'CategorizationError', code });
}

function testDeps(
  db: CategorizationDb,
  overrides: Partial<CategorizationDeps> = {},
): CategorizationDeps {
  return {
    db,
    lease: async (_key, _owner, callback) => callback(),
    fence: async () => undefined,
    invocationId: () => 'test-stage-invocation',
    ...overrides,
  } as unknown as CategorizationDeps;
}

describe('stageCategorization', () => {
  let db: FakeCategorizationDb;

  beforeEach(() => {
    db = new FakeCategorizationDb(initialState()).initialize();
  });

  it('participates in the common entity lease for the full staging transaction', async () => {
    let leaseHeld = false;
    const originalTransaction = db.$transaction.bind(db);
    db.$transaction = async (callback) => {
      expect(leaseHeld).toBe(true);
      return originalTransaction(callback);
    };
    const lease = vi.fn(async (
      _key: unknown,
      _owner: string,
      callback: () => Promise<unknown>,
    ) => {
      leaseHeld = true;
      try {
        return await callback();
      } finally {
        leaseHeld = false;
      }
    });

    await stageCategorization(input(), {
      ...testDeps(db),
      lease,
      invocationId: () => 'stage-invocation',
    });

    expect(lease).toHaveBeenCalledWith(
      {
        companyId: COMPANY_ID,
        qboType: 'Purchase',
        qboId: 'QBO_PURCHASE_30',
      },
      'stage-invocation',
      expect.any(Function),
    );
    expect(leaseHeld).toBe(false);
  });

  it('does not open a staging transaction or write when common lease acquisition loses', async () => {
    const before = structuredClone(db.state);
    const lease = vi.fn(async () => {
      throw Object.assign(new Error('entity busy'), {
        name: 'EntityLeaseError',
        code: 'ENTITY_BUSY',
      });
    });

    await expect(stageCategorization(input(), {
      db,
      lease,
      invocationId: () => 'losing-stage',
    } as unknown as CategorizationDeps)).rejects.toMatchObject({
      name: 'EntityLeaseError',
      code: 'ENTITY_BUSY',
    });

    expect(lease).toHaveBeenCalledOnce();
    expect(db.transactionCalls).toBe(0);
    expect(db.lastUpdateMany).toBeNull();
    expect(db.state).toEqual(before);
  });

  it('fences the acquired owner before any mutable reload or active-attempt check', async () => {
    const events: string[] = [];
    const originalFindFirst = db.transaction.findFirst;
    let locatorRead = true;
    db.transaction.findFirst = async (args) => {
      events.push(locatorRead ? 'locator' : 'mutable-reload');
      locatorRead = false;
      return originalFindFirst(args);
    };
    const originalAttemptFindFirst = db.qboMutationAttempt.findFirst;
    db.qboMutationAttempt.findFirst = async (args) => {
      events.push('active-attempt');
      return originalAttemptFindFirst(args);
    };

    await stageCategorization(input(), testDeps(db, {
      fence: async () => {
        events.push('fence');
      },
    } as Partial<CategorizationDeps>));

    expect(events).toEqual([
      'locator',
      'fence',
      'mutable-reload',
      'active-attempt',
    ]);
  });

  it('rolls back cleanly with ENTITY_BUSY when ownership is missing before the fence', async () => {
    const before = structuredClone(db.state);
    const fence = vi.fn(async () => {
      throw Object.assign(new Error('entity busy'), {
        name: 'EntityLeaseError',
        code: 'ENTITY_BUSY',
      });
    });

    await expect(stageCategorization(
      input(),
      testDeps(db, { fence } as Partial<CategorizationDeps>),
    )).rejects.toMatchObject({
      name: 'EntityLeaseError',
      code: 'ENTITY_BUSY',
    });

    expect(fence).toHaveBeenCalledWith(
      {
        companyId: COMPANY_ID,
        qboType: 'Purchase',
        qboId: 'QBO_PURCHASE_30',
      },
      'test-stage-invocation',
      db,
    );
    expect(db.transactionCalls).toBe(1);
    expect(db.lastUpdateMany).toBeNull();
    expect(db.state).toEqual(before);
  });

  it('runs the optional concurrency hook after revision CAS and before row replacement', async () => {
    const afterRevisionCas = vi.fn(async () => {
      expect(db.state.transactions[0]!.revision).toBe(1);
      expect(db.state.splits).toEqual([expect.objectContaining({ id: 'old-split' })]);
    });

    await stageCategorization(
      input(),
      testDeps(db, { afterRevisionCas } as Partial<CategorizationDeps>),
    );

    expect(afterRevisionCas).toHaveBeenCalledOnce();
  });

  it('lets a fenced workflow return before mutable validation or revision CAS', async () => {
    const before = structuredClone(db.state);
    const events: string[] = [];

    const result = await stageCategorizationWithWorkflow(
      input(),
      {
        beforeValidation: async (transaction, normalizedInput) => {
          expect(transaction).toBe(db);
          expect(normalizedInput).toEqual(input({
            ...standardProposal,
            taxDisposition: 'set',
          }));
          events.push('before-validation');
          return { kind: 'return', value: 'exact-replay' };
        },
        afterStage: async () => {
          throw new Error('afterStage must not run for a replay');
        },
      },
      testDeps(db, {
        fence: async () => {
          events.push('fence');
        },
      } as Partial<CategorizationDeps>),
    );

    expect(result).toBe('exact-replay');
    expect(events).toEqual(['fence', 'before-validation']);
    expect(db.lastUpdateMany).toBeNull();
    expect(db.state).toEqual(before);
  });

  it('passes the normalized staging receipt inside the transaction and rolls back on receipt failure', async () => {
    const before = structuredClone(db.state);
    const receiptError = new Error('receipt persistence failed');

    await expect(stageCategorizationWithWorkflow(
      input(),
      {
        beforeValidation: async () => ({ kind: 'continue' }),
        afterStage: async (transaction, receipt) => {
          expect(transaction).toBe(db);
          expect(receipt).toMatchObject({
            normalizedProposal: standardProposal,
            sourceRevision: 0,
            preparedRevision: 1,
            qboType: 'Purchase',
            qboId: 'QBO_PURCHASE_30',
            qboSyncToken: '7',
            staged: {
              transactionId: TRANSACTION_ID,
              revision: 1,
            },
          });
          throw receiptError;
        },
      },
      testDeps(db),
    )).rejects.toBe(receiptError);

    expect(db.state).toEqual(before);
  });

  it.each([
    ['revision', () => { db.state.transactions[0]!.revision = 1; }, 'STALE_REVISION'],
    ['status', () => { db.state.transactions[0]!.status = 'ERROR'; }, 'STALE_REVISION'],
    ['active attempt', () => {
      db.state.attempts.push({ transactionId: TRANSACTION_ID, status: 'PREPARED' });
    }, 'MUTATION_BLOCKED'],
  ] as const)(
    'reloads %s after acquiring the lease and rejects without partial staging writes',
    async (_field, mutateAfterLease, code) => {
      const beforeSplits = structuredClone(db.state.splits);
      const beforeSplitTags = structuredClone(db.state.splitTags);
      const beforeTxnTags = structuredClone(db.state.txnTags);
      const deps = testDeps(db, {
        lease: async (_key, _owner, callback) => {
          mutateAfterLease();
          return callback();
        },
      });

      await expectCode(stageCategorization(input(), deps), code);

      expect(db.state.splits).toEqual(beforeSplits);
      expect(db.state.splitTags).toEqual(beforeSplitTags);
      expect(db.state.txnTags).toEqual(beforeTxnTags);
      expect(db.state.transactions[0]!.category).toBe('Old category');
      expect(db.state.transactions[0]!.taxCalculation).toBeNull();
    },
  );

  it('atomically stages server-calculated inclusive tax at revision 0 → 1', async () => {
    const getClient = vi.fn(() => {
      throw new Error('staging must not construct a QBO client');
    });

    const staged = await stageCategorization(
      input(),
      { ...testDeps(db), getClient } as unknown as CategorizationDeps,
    );

    expect(staged).toEqual({
      transactionId: TRANSACTION_ID,
      revision: 1,
      taxDisposition: 'set',
      taxCalculation: 'TaxInclusive',
      totals: { subtotalCents: -1000, taxCents: -50, totalCents: -1050 },
      lines: [{
        idx: 0,
        subtotalCents: -1000,
        taxCents: -50,
        totalCents: -1050,
        categoryQboId: 'EXPENSE_ACCOUNT',
        taxCodeQboId: 'TAX_CODE_STANDARD',
        memo: 'Prepared purchase',
        tagIds: [LINE_TAG_ID],
      }],
      tagIds: [TAG_ID],
    });
    expect(db.lastUpdateMany).toMatchObject({
      where: {
        id: TRANSACTION_ID,
        companyId: COMPANY_ID,
        revision: 0,
        status: 'PENDING',
      },
      data: { revision: 1 },
    });
    expect(db.state.transactions[0]).toMatchObject({
      revision: 1,
      category: null,
      categoryQboId: null,
      taxCalculation: 'TaxInclusive',
      taxCode: 'Standard tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
    });
    expect(db.state.splits).toEqual([expect.objectContaining({
      txnId: TRANSACTION_ID,
      idx: 0,
      amount: -10.5,
      category: 'Expenses · Prepared purchases',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      memo: 'Prepared purchase',
    })]);
    expect(db.state.txnTags).toEqual([{ txnId: TRANSACTION_ID, tagId: TAG_ID }]);
    expect(db.state.splitTags).toEqual([
      { splitLineId: db.state.splits[0]!.id, tagId: LINE_TAG_ID },
    ]);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('loads only active tax rates so inactive nullable legacy rows are never decoded', async () => {
    const findMany = vi.fn(async (
      args: { where: { companyId: string; active?: boolean } },
    ) => {
      if (args.where.active !== true) {
        throw Object.assign(
          new Error('inactive legacy rate contains a nullable value'),
          { code: 'P2032' },
        );
      }
      return db.state.taxRates.filter(
        (row) => row.companyId === args.where.companyId && row.active,
      );
    });
    db.qboTaxRate.findMany =
      findMany as unknown as CategorizationDb['qboTaxRate']['findMany'];

    await expect(stageCategorization(input(), testDeps(db))).resolves.toMatchObject({
      transactionId: TRANSACTION_ID,
      revision: 1,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        active: true,
        rateValue: { not: null },
      },
    });
  });

  it('persists owned line tags in request order without confusing shared references for missing tags', async () => {
    const staged = await stageCategorization(input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        tagIds: [LINE_TAG_ID, TAG_ID],
      } as CategorizationProposal['lines'][number]],
      tagIds: [TAG_ID],
    }), testDeps(db));

    expect(staged.lines[0]).toMatchObject({ tagIds: [LINE_TAG_ID, TAG_ID] });
    expect(staged.tagIds).toEqual([TAG_ID]);
    expect(db.state.splitTags).toEqual([
      { splitLineId: db.state.splits[0]!.id, tagId: LINE_TAG_ID },
      { splitLineId: db.state.splits[0]!.id, tagId: TAG_ID },
    ]);
  });

  it('rejects a stale revision without changing transaction, split, or tag rows', async () => {
    db.state.transactions[0]!.revision = 1;
    const before = structuredClone(db.state);

    await expectCode(stageCategorization(input(), testDeps(db)), 'STALE_REVISION');

    expect(db.state.transactions).toEqual(before.transactions);
    expect(db.state.splits).toEqual(before.splits);
    expect(db.state.splitTags).toEqual(before.splitTags);
    expect(db.state.txnTags).toEqual(before.txnTags);
  });

  it.each(['PREPARED', 'COMMITTING', 'UNCERTAIN'])(
    'rejects staging while a %s write is active without changing revision, tax, splits, or tags',
    async (status) => {
      db.state.attempts.push({ transactionId: TRANSACTION_ID, status });
      const before = structuredClone(db.state);

      await expect(
        stageCategorization(input(), testDeps(db)),
      ).rejects.toMatchObject({
        name: 'CategorizationError',
        code: 'MUTATION_BLOCKED',
        message: expect.stringMatching(/write.*resume|write.*verif/i),
      });

      expect(db.transactionCalls).toBe(1);
      expect(db.lastUpdateMany).toBeNull();
      expect(db.state.transactions).toEqual(before.transactions);
      expect(db.state.splits).toEqual(before.splits);
      expect(db.state.splitTags).toEqual(before.splitTags);
      expect(db.state.txnTags).toEqual(before.txnTags);
    },
  );

  it('rejects an attempt that wins the atomic revision CAS race before any row replacement', async () => {
    db.qboMutationAttempt.findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'raced-attempt' });
    db.transaction.updateMany = vi.fn(async (args) => {
      db.lastUpdateMany = structuredClone(args);
      return { count: 0 };
    });
    const before = structuredClone(db.state);

    await expectCode(stageCategorization(input(), testDeps(db)), 'MUTATION_BLOCKED');

    expect(db.lastUpdateMany).toMatchObject({
      where: {
        qboMutationAttempts: {
          none: { status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] } },
        },
      },
    });
    expect(db.state).toEqual(before);
  });

  it('stages balanced signed splits and per-line totals', async () => {
    db.state.transactions[0]!.amount = -21;
    const staged = await stageCategorization(input({
      ...standardProposal,
      lines: [
        { ...standardProposal.lines[0]!, grossCents: -1050, memo: 'First' },
        { ...standardProposal.lines[0]!, grossCents: -1050, memo: 'Second' },
      ],
    }), testDeps(db));

    expect(staged.totals).toEqual({
      subtotalCents: -2000,
      taxCents: -100,
      totalCents: -2100,
    });
    expect(staged.lines).toEqual([
      expect.objectContaining({ idx: 0, subtotalCents: -1000, taxCents: -50, totalCents: -1050 }),
      expect.objectContaining({ idx: 1, subtotalCents: -1000, taxCents: -50, totalCents: -1050 }),
    ]);
    expect(db.state.splits.map((line) => line.amount)).toEqual([-10.5, -10.5]);
  });

  it('reconstructs TaxExcluded Purchase totals from the fixed client line total', async () => {
    const staged = await stageCategorization(input({
      ...standardProposal,
      taxCalculation: 'TaxExcluded',
      lines: [{ ...standardProposal.lines[0]!, grossCents: -1050 }],
    }), testDeps(db));

    expect(staged.totals).toEqual({
      subtotalCents: -1000,
      taxCents: -50,
      totalCents: -1050,
    });
    expect(staged.lines[0]).toMatchObject({
      subtotalCents: -1000,
      taxCents: -50,
      totalCents: -1050,
    });
    expect(db.state.splits[0]!.amount).toBe(-10.5);
  });

  it('rolls back the revision, splits, and tags when replacement fails after the CAS', async () => {
    const before = structuredClone(db.state);
    db.splitLine.createMany = async () => {
      throw new Error('injected split replacement failure');
    };

    await expect(stageCategorization(input(), testDeps(db)))
      .rejects.toThrow('injected split replacement failure');

    expect(db.transactionCalls).toBe(1);
    expect(db.state.transactions).toEqual(before.transactions);
    expect(db.state.splits).toEqual(before.splits);
    expect(db.state.splitTags).toEqual(before.splitTags);
    expect(db.state.txnTags).toEqual(before.txnTags);
  });

  it('rolls back revision, lines, and every tag relation when line-tag replacement fails', async () => {
    const before = structuredClone(db.state);
    db.splitLineTag.createMany = async () => {
      throw new Error('injected line tag replacement failure');
    };

    await expect(stageCategorization(input(), testDeps(db)))
      .rejects.toThrow('injected line tag replacement failure');

    expect(db.state).toEqual(before);
  });

  it.each([
    ['account', () => { db.state.accounts[0]!.companyId = OTHER_COMPANY_ID; }, 'INVALID_ACCOUNT'],
    ['tag', () => { db.state.tags[0]!.companyId = OTHER_COMPANY_ID; }, 'INVALID_TAG'],
    ['tax code', () => { db.state.taxCodes[0]!.companyId = OTHER_COMPANY_ID; }, 'TAX_CODE_UNAVAILABLE'],
  ] as const)('rejects a cross-company %s reference inside the fenced transaction', async (_kind, mutate, code) => {
    mutate();
    await expectCode(stageCategorization(input(), testDeps(db)), code);
    expect(db.transactionCalls).toBe(1);
  });

  it('rejects a cross-company line tag inside the fenced transaction', async () => {
    db.state.tags.find((tag) => tag.id === LINE_TAG_ID)!.companyId = OTHER_COMPANY_ID;

    await expectCode(stageCategorization(input(), testDeps(db)), 'INVALID_TAG');

    expect(db.transactionCalls).toBe(1);
  });

  it.each([
    ['inactive', () => { db.state.taxCodes[0]!.active = false; }, 'TAX_CODE_INACTIVE'],
    ['unsupported', () => {
      db.state.taxCodes[0]!.purchaseTaxRateList = [
        { taxRateQboId: 'TAX_RATE_STANDARD', taxTypeApplicable: 'TaxOnAmount' },
        { taxRateQboId: 'TAX_RATE_SECONDARY', taxTypeApplicable: 'TaxOnAmount' },
      ];
    }, 'TAX_RATE_UNSUPPORTED'],
  ] as const)('rejects an %s tax code', async (_kind, mutate, code) => {
    mutate();
    await expectCode(stageCategorization(input(), testDeps(db)), code);
    expect(db.transactionCalls).toBe(1);
  });

  it('rejects an explicit non-tax code in taxed mode without inventing its treatment', async () => {
    db.state.taxCodes[0]!.taxable = false;
    db.state.taxCodes[0]!.purchaseTaxRateList = [];

    await expectCode(
      stageCategorization(input(), testDeps(db)),
      'TAX_TREATMENT_AMBIGUOUS',
    );

    expect(db.transactionCalls).toBe(1);
  });

  it('preserves the non-tax workflow for NotApplicable', async () => {
    const staged = await stageCategorization(input({
      taxCalculation: 'NotApplicable',
      lines: [{
        grossCents: -1050,
        categoryQboId: 'EXPENSE_ACCOUNT',
        memo: 'Prepared purchase',
        tagIds: [LINE_TAG_ID],
      } as CategorizationProposal['lines'][number]],
      tagIds: [TAG_ID],
    }), testDeps(db));

    expect(staged.totals).toEqual({
      subtotalCents: -1050,
      taxCents: 0,
      totalCents: -1050,
    });
    expect(db.state.transactions[0]).toMatchObject({
      taxCalculation: 'NotApplicable',
      taxCode: null,
      taxCodeQboId: null,
    });
    expect(db.state.splits[0]).toMatchObject({ taxCode: null, taxCodeQboId: null });
  });

  it('stages one Purchase category change with its literal current tax code intact', async () => {
    configureValidPreserveSource(db);

    const staged = await stageCategorization(
      input(preserveCurrentProposal),
      testDeps(db),
    );

    expect(staged).toMatchObject({
      transactionId: TRANSACTION_ID,
      revision: 1,
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      totals: {
        subtotalCents: -75_000,
        taxCents: 0,
        totalCents: -75_000,
      },
      lines: [{
        idx: 0,
        subtotalCents: -75_000,
        taxCents: 0,
        totalCents: -75_000,
        categoryQboId: '42',
        taxCodeQboId: 'NON',
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    });
    expect(db.state.transactions[0]).toMatchObject({
      revision: 1,
      taxCalculation: 'NotApplicable',
      taxCode: 'Non-taxable',
      taxCodeQboId: 'NON',
    });
    expect(db.state.splits[0]).toMatchObject({
      amount: -750,
      categoryQboId: '42',
      taxCodeQboId: 'NON',
    });
  });

  it('preserves the authoritative NON sentinel when QBO omits it from tax-code inventory', async () => {
    configureValidPreserveSource(db);
    db.state.taxCodes = [];

    const staged = await stageCategorization(
      input(preserveCurrentProposal),
      testDeps(db),
    );

    expect(staged).toMatchObject({
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      lines: [{
        totalCents: -75_000,
        categoryQboId: '42',
        taxCodeQboId: 'NON',
      }],
    });
    expect(db.state.transactions[0]).toMatchObject({
      taxCode: 'NON',
      taxCodeQboId: 'NON',
    });
    expect(db.state.splits[0]).toMatchObject({
      taxCode: 'NON',
      taxCodeQboId: 'NON',
    });
  });

  it('still rejects an unlisted preserved tax code other than NON', async () => {
    configureValidPreserveSource(db);
    db.state.taxCodes = [];
    const raw = db.state.transactions[0]!.rawData as {
      Line: Array<{
        AccountBasedExpenseLineDetail: { TaxCodeRef: { value: string } };
      }>;
    };
    raw.Line[0]!.AccountBasedExpenseLineDetail.TaxCodeRef.value = 'UNLISTED';
    const proposal = {
      ...preserveCurrentProposal,
      lines: [{
        ...preserveCurrentProposal.lines[0]!,
        taxCodeQboId: 'UNLISTED',
      }],
    };

    await expectCode(
      stageCategorization(input(proposal), testDeps(db)),
      'INVALID_TAX_CODE',
    );
  });

  it('does not bypass an existing inactive NON inventory row', async () => {
    configureValidPreserveSource(db);
    const non = db.state.taxCodes.find((code) => code.qboId === 'NON')!;
    non.active = false;

    await expectCode(
      stageCategorization(input(preserveCurrentProposal), testDeps(db)),
      'INVALID_TAX_CODE',
    );
  });

  it('rejects preserve-current before mutation when existing Recat tags would be lost', async () => {
    configureValidPreserveSource(db);
    db.state.txnTags.push({ txnId: TRANSACTION_ID, tagId: TAG_ID });
    const before = structuredClone(db.state);

    await expectCode(
      stageCategorization(input(preserveCurrentProposal), testDeps(db)),
      'INVALID_INPUT',
    );

    expect(db.state).toEqual(before);
  });

  it.each([
    ['a non-Purchase transaction', () => {
      db.state.transactions[0]!.qboType = 'Deposit';
      db.state.transactions[0]!.amount = 750;
      return {
        ...preserveCurrentProposal,
        lines: [{ ...preserveCurrentProposal.lines[0]!, grossCents: 75_000 }],
      };
    }],
    ['an unchanged target category', () => {
      db.state.transactions[0]!.categoryQboId = '42';
      return preserveCurrentProposal;
    }],
    ['a split proposal', () => ({
      ...preserveCurrentProposal,
      lines: [
        { ...preserveCurrentProposal.lines[0]!, grossCents: -37_500 },
        { ...preserveCurrentProposal.lines[0]!, grossCents: -37_500 },
      ],
    })],
    ['a memo edit', () => ({
      ...preserveCurrentProposal,
      lines: [{ ...preserveCurrentProposal.lines[0]!, memo: 'changed' }],
    })],
    ['a transaction tag edit', () => ({
      ...preserveCurrentProposal,
      tagIds: [TAG_ID],
    })],
    ['a line tag edit', () => ({
      ...preserveCurrentProposal,
      lines: [{ ...preserveCurrentProposal.lines[0]!, tagIds: [LINE_TAG_ID] }],
    })],
  ])('rejects preserve-current with %s before replacing staged rows', async (_name, proposal) => {
    db.state.transactions[0]!.amount = -750;
    db.state.accounts.push({
      companyId: COMPANY_ID,
      qboId: '42',
      name: 'Bank Charges',
      fullName: 'Expenses · Bank Charges',
      active: true,
    });
    const proposed = proposal();
    const before = structuredClone(db.state);

    await expectCode(
      stageCategorization(input(proposed), testDeps(db)),
      'INVALID_INPUT',
    );

    expect(db.state).toEqual(before);
  });

  it('stages positive Deposit sales tax from sales rate references', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.companies[0]!.taxSupportStatus = 'needs_setup';
    db.state.taxCodes[0]!.name = 'Generic sales tax';

    const staged = await stageCategorization(input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        grossCents: 10_700,
        memo: 'Generic deposit line',
      }],
    }), testDeps(db));

    expect(staged.totals).toEqual({
      subtotalCents: 10_000,
      taxCents: 700,
      totalCents: 10_700,
    });
    expect(staged.lines[0]).toMatchObject({
      subtotalCents: 10_000,
      taxCents: 700,
      totalCents: 10_700,
      taxCodeQboId: 'TAX_CODE_STANDARD',
    });
    expect(db.state.splits[0]).toMatchObject({
      amount: 107,
      taxCode: 'Generic sales tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
    });
  });

  it('ignores an inactive legacy tax-rate row with a null value when staging a Deposit', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.companies[0]!.taxSupportStatus = 'needs_setup';
    db.state.taxRates.push({
      companyId: COMPANY_ID,
      qboId: 'LEGACY_NULL_RATE',
      name: 'Legacy inactive rate',
      active: false,
      rateValue: null,
    });

    await expect(stageCategorization(input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        grossCents: 10_700,
      }],
    }), testDeps(db))).resolves.toMatchObject({
      totals: {
        subtotalCents: 10_000,
        taxCents: 700,
        totalCents: 10_700,
      },
    });
  });

  it('rejects a negative Deposit amount even when every line has the same negative sign', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    const before = structuredClone(db.state);

    await expectCode(stageCategorization(input(), testDeps(db)), 'UNBALANCED_TOTAL');

    expect(db.state).toEqual(before);
  });

  it('rejects JournalEntry tax selection', async () => {
    db.state.transactions[0]!.qboType = 'JournalEntry';

    await expectCode(stageCategorization(input(), testDeps(db)), 'TAX_REQUIRES_PURCHASE');

    expect(db.transactionCalls).toBe(1);
  });

  it('requires sales tax readiness for a Deposit', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.companies[0]!.taxSupportStatus = 'ready';
    db.state.taxCodes[0]!.salesTaxRateList = [];

    await expectCode(stageCategorization(input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, grossCents: 10_700 }],
    }), testDeps(db)), 'TAX_NOT_READY');
  });

  it.each([
    ['missing', null],
    ['malformed', 'not-a-rate'],
  ] as const)('rejects a Deposit when cached combined sales rate is %s', async (_case, combinedSalesRate) => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.taxCodes[0]!.combinedSalesRate = combinedSalesRate;

    await expectCode(stageCategorization(input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, grossCents: 10_700 }],
    }), testDeps(db)), 'TAX_NOT_READY');
  });

  it('rejects cached Deposit tax references after a recorded refresh failure', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.companies[0]!.taxSupportReason = 'Tax reference refresh failed.';

    await expectCode(stageCategorization(input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, grossCents: 10_700 }],
    }), testDeps(db)), 'TAX_NOT_READY');
  });

  it('rejects a purchase-only tax code for a Deposit', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;
    db.state.taxCodes[0]!.salesTaxRateList = [];
    db.state.taxCodes.push({
      ...db.state.taxCodes[0]!,
      qboId: 'TAX_CODE_SALES_READY',
      purchaseTaxRateList: [],
      salesTaxRateList: [{
        taxRateQboId: 'TAX_RATE_SALES',
        taxTypeApplicable: 'TaxOnAmount',
      }],
    });

    await expectCode(stageCategorization(input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, grossCents: 10_700 }],
    }), testDeps(db)), 'TAX_CODE_PURCHASE_ONLY');
  });

  it('reconstructs exact TaxExcluded Deposit splits from fixed client line totals', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 0.21;

    const staged = await stageCategorization(input({
      ...standardProposal,
      taxCalculation: 'TaxExcluded',
      lines: [
        { ...standardProposal.lines[0]!, grossCents: 11 },
        { ...standardProposal.lines[0]!, grossCents: 10 },
      ],
    }), testDeps(db));

    expect(staged.totals).toEqual({
      subtotalCents: 20,
      taxCents: 1,
      totalCents: 21,
    });
    expect(staged.lines).toEqual([
      expect.objectContaining({ subtotalCents: 10, taxCents: 1, totalCents: 11 }),
      expect.objectContaining({ subtotalCents: 10, taxCents: 0, totalCents: 10 }),
    ]);
    expect(db.state.splits.map((line) => line.amount)).toEqual([0.11, 0.1]);
  });

  it('rejects a TaxExcluded Deposit whose fixed line total has no unique exact reconstruction', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 0.08;
    const before = structuredClone(db.state);

    await expectCode(stageCategorization(input({
      ...standardProposal,
      taxCalculation: 'TaxExcluded',
      lines: [{ ...standardProposal.lines[0]!, grossCents: 8 }],
    }), testDeps(db)), 'TAX_AMOUNT_INVALID');

    expect(db.state).toEqual(before);
  });

  it('preserves NotApplicable Deposit staging', async () => {
    db.state.transactions[0]!.qboType = 'Deposit';
    db.state.transactions[0]!.amount = 107;

    const staged = await stageCategorization(input({
      taxCalculation: 'NotApplicable',
      lines: [{
        grossCents: 10_700,
        categoryQboId: 'EXPENSE_ACCOUNT',
        memo: 'Generic deposit line',
        tagIds: [LINE_TAG_ID],
      } as CategorizationProposal['lines'][number]],
      tagIds: [TAG_ID],
    }), testDeps(db));

    expect(staged.totals).toEqual({ subtotalCents: 10_700, taxCents: 0, totalCents: 10_700 });
  });

  it.each([
    ['memo longer than 500 characters', () => input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, memo: 'x'.repeat(501) }],
    })],
    ['more than 20 lines', () => input({
      ...standardProposal,
      lines: Array.from({ length: 21 }, () => standardProposal.lines[0]!),
    })],
    ['unsafe line cents', () => input({
      ...standardProposal,
      lines: [{ ...standardProposal.lines[0]!, grossCents: Number.MAX_SAFE_INTEGER + 1 }],
    })],
    ['a revision outside the Prisma Int range', () => ({
      ...input(),
      expectedRevision: 2_147_483_647,
    })],
    ['a tax code combined with NotApplicable', () => input({
      ...standardProposal,
      taxCalculation: 'NotApplicable',
    })],
    ['an unknown input field', () => ({
      ...input(),
      clientTotalCents: -1050,
    })],
    ['an unknown proposal field', () => input({
      ...standardProposal,
      clientTaxCents: -50,
    } as CategorizationProposal)],
    ['an unknown line field', () => input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        clientSubtotalCents: -1000,
      } as CategorizationProposal['lines'][number]],
    })],
    ['duplicate line tags', () => input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        tagIds: [LINE_TAG_ID, LINE_TAG_ID],
      } as CategorizationProposal['lines'][number]],
    })],
    ['more than 50 line tags', () => input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        tagIds: Array.from(
          { length: 51 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
      } as CategorizationProposal['lines'][number]],
    })],
    ['an unknown field beside line tags', () => input({
      ...standardProposal,
      lines: [{
        ...standardProposal.lines[0]!,
        tagIds: [LINE_TAG_ID],
        serverTaxCents: -50,
      } as CategorizationProposal['lines'][number]],
    })],
  ])('rejects %s before opening the DB transaction', async (_name, makeInput) => {
    await expectCode(
      stageCategorization(makeInput() as StageCategorizationInput, testDeps(db)),
      'INVALID_INPUT',
    );
    expect(db.transactionCalls).toBe(0);
  });

  it.each([
    ['unbalanced cents', -10.49, standardProposal],
    ['mixed split signs', -10, {
      ...standardProposal,
      lines: [
        { ...standardProposal.lines[0]!, grossCents: -1050 },
        { ...standardProposal.lines[0]!, grossCents: 50 },
      ],
    }],
  ] as const)('rejects %s inside the fenced DB transaction', async (_name, amount, proposal) => {
    db.state.transactions[0]!.amount = amount;
    await expectCode(
      stageCategorization(input(proposal as CategorizationProposal), testDeps(db)),
      'UNBALANCED_TOTAL',
    );
    expect(db.transactionCalls).toBe(1);
  });
});
