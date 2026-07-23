import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  rollbackAutopilotStaging,
  stageCategorization,
  validatePurchaseTaxDecision,
} from './categorization.js';

const rows = [
  {
    companyId: 'co-1',
    qboId: 'gst',
    name: 'GST 5%',
    active: true,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r5' }],
  },
  {
    companyId: 'co-1',
    qboId: 'oos',
    name: 'Out of Scope',
    active: true,
    taxable: false,
    purchaseTaxRateList: [],
  },
  {
    companyId: 'co-1',
    qboId: 'sales-only',
    name: 'Sales only',
    active: true,
    taxable: true,
    purchaseTaxRateList: [],
  },
  {
    companyId: 'co-1',
    qboId: 'inactive',
    name: 'Old GST',
    active: false,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r5' }],
  },
];

function db() {
  return {
    qboTaxCode: {
      findMany: vi.fn(async (args: { where: { companyId: string; qboId: { in: string[] } } }) =>
        rows.filter(
          (row) =>
            row.companyId === args.where.companyId &&
            args.where.qboId.in.includes(row.qboId),
        ),
      ),
    },
  } as unknown as Pick<PrismaClient, 'qboTaxCode'>;
}

describe('validatePurchaseTaxDecision', () => {
  it('accepts active company-scoped purchase codes and preserves split order', async () => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', 'TaxInclusive', ['gst', 'oos']),
    ).resolves.toEqual([
      { qboId: 'gst', name: 'GST 5%', taxable: true },
      { qboId: 'oos', name: 'Out of Scope', taxable: false },
    ]);
  });

  it('rejects a code from another company', async () => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-2', 'Purchase', 'TaxInclusive', ['gst']),
    ).rejects.toMatchObject({ code: 'TAX_CODE_INVALID' });
  });

  it.each([
    ['inactive', 'TAX_CODE_INACTIVE'],
    ['sales-only', 'TAX_CODE_NOT_PURCHASE'],
  ])('rejects %s codes', async (qboId, code) => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', 'TaxInclusive', [qboId]),
    ).rejects.toMatchObject({ code });
  });

  it.each(['Deposit', 'JournalEntry'])('rejects tax on %s', async (qboType) => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', qboType, 'TaxInclusive', ['gst']),
    ).rejects.toMatchObject({ code: 'TAX_MODE_UNSUPPORTED' });
  });

  it('requires one tax code per line', async () => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', 'TaxInclusive', ['gst', null]),
    ).rejects.toMatchObject({ code: 'TAX_CODE_REQUIRED' });
  });

  it('requires an out-of-scope code for NotApplicable', async () => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', 'NotApplicable', ['gst']),
    ).rejects.toMatchObject({ code: 'TAX_OUT_OF_SCOPE_REQUIRED' });
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', 'NotApplicable', ['oos']),
    ).resolves.toHaveLength(1);
  });

  it('keeps category-only legacy decisions source-compatible', async () => {
    await expect(
      validatePurchaseTaxDecision(db(), 'co-1', 'Purchase', null, [null]),
    ).resolves.toEqual([]);
  });
});

function stageDb(options: { rules?: unknown[]; claimCount?: number } = {}) {
  const updatedAt = new Date('2026-07-23T12:00:00.000Z');
  const txn = {
    id: 'txn-1',
    companyId: 'co-1',
    qboType: 'Purchase',
    status: 'PENDING',
    amount: -29,
    payee: 'WEBFLOW',
    taxCalculation: null,
    updatedAt,
    splitLines: [],
  };
  const transactionUpdate = vi.fn(async () => ({
    id: txn.id,
    updatedAt: new Date('2026-07-23T12:01:00.000Z'),
  }));
  const txnTagUpsert = vi.fn(async () => undefined);
  const companyUpdate = vi.fn(async () => ({}));
  const queryRaw = vi.fn(async () => [{ id: 'co-1' }]);
  const tx = {
    $queryRaw: queryRaw,
    transaction: {
      findUnique: vi.fn(async () => txn),
      updateMany: vi.fn(async () => ({ count: options.claimCount ?? 1 })),
      update: transactionUpdate,
    },
    qboAccount: {
      findFirst: vi.fn(async ({ where }: { where: { qboId?: string; name?: string } }) => ({
        qboId: where.qboId ?? 'acct-1',
      })),
    },
    qboTaxCode: {
      findMany: vi.fn(async () => rows.filter((row) => row.qboId === 'gst')),
    },
    tag: {
      count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length),
    },
    rule: {
      findMany: vi.fn(async () => options.rules ?? []),
    },
    txnTag: { upsert: txnTagUpsert },
    company: { update: companyUpdate },
  };
  const client = {
    ...tx,
    $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return {
    client,
    txn,
    transactionUpdate,
    txnTagUpsert,
    companyUpdate,
    queryRaw,
    updatedAt,
  };
}

describe('stageCategorization', () => {
  it('atomically replaces splits with a company-scoped single category', async () => {
    const { client, transactionUpdate, companyUpdate, queryRaw } = stageDb();

    await stageCategorization(
      client,
      'txn-1',
      { category: 'Software', categoryQboId: 'acct-1' },
      { actor: { id: 'user-1', label: 'Maria' }, source: 'human' },
    );

    expect(transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'Software',
          categoryQboId: 'acct-1',
          splitLines: { deleteMany: {} },
        }),
      }),
    );
    expect(companyUpdate).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { agentReconcileToken: expect.any(String) },
    });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transactionUpdate.mock.invocationCallOrder[0]!,
    );
  });

  it('stores ordered tax-aware split lines and replaces the single category', async () => {
    const { client, transactionUpdate } = stageDb();

    await stageCategorization(
      client,
      'txn-1',
      {
        taxCalculation: 'TaxInclusive',
        splits: [
          {
            amount: -20,
            category: 'Software',
            categoryQboId: 'acct-1',
            tagIds: ['tag-1'],
            taxCodeQboId: 'gst',
          },
          {
            amount: -9,
            category: 'Fees',
            categoryQboId: 'acct-2',
            tagIds: [],
            taxCodeQboId: 'gst',
          },
        ],
      },
      { actor: { id: null, label: 'autopilot' }, source: 'autopilot' },
    );

    const data = transactionUpdate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      category: null,
      categoryQboId: null,
      taxCalculation: 'TaxInclusive',
    });
    expect(data.splitLines.create).toEqual([
      expect.objectContaining({ idx: 0, amount: -20, categoryQboId: 'acct-1', taxCodeQboId: 'gst' }),
      expect.objectContaining({ idx: 1, amount: -9, categoryQboId: 'acct-2', taxCodeQboId: 'gst' }),
    ]);
  });

  it('rejects a stale expectedUpdatedAt before any staged mutation', async () => {
    const { client, transactionUpdate } = stageDb();

    await expect(
      stageCategorization(
        client,
        'txn-1',
        { category: 'Software', categoryQboId: 'acct-1' },
        {
          actor: { id: null, label: 'autopilot' },
          source: 'autopilot',
          expectedUpdatedAt: '2026-07-23T11:59:00.000Z',
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('rejects a concurrent staging change at the atomic claim boundary', async () => {
    const { client, transactionUpdate } = stageDb({ claimCount: 0 });

    await expect(
      stageCategorization(
        client,
        'txn-1',
        { category: 'Software', categoryQboId: 'acct-1' },
        {
          actor: { id: null, label: 'autopilot' },
          source: 'autopilot',
          expectedUpdatedAt: '2026-07-23T12:00:00.000Z',
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('merges matching rule tags inside the same staging transaction', async () => {
    const rule = {
      id: 'rule-1',
      companyId: 'co-1',
      matchText: 'webflow',
      category: 'Software',
      categoryQboId: 'acct-1',
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      priority: 1,
      createdAt: new Date('2026-01-01'),
      ruleTags: [{ tagId: 'tag-rule' }],
    };
    const { client, txnTagUpsert } = stageDb({ rules: [rule] });

    await stageCategorization(
      client,
      'txn-1',
      { category: 'Software', categoryQboId: 'acct-1' },
      {
        actor: { id: 'user-1', label: 'Maria' },
        source: 'human',
        applyMatchingRuleTags: true,
      },
    );

    expect(txnTagUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { txnId_tagId: { txnId: 'txn-1', tagId: 'tag-rule' } },
      }),
    );
  });

  it('locks the company rule boundary and rejects an autopilot-covered transaction', async () => {
    const rule = {
      id: 'rule-1',
      companyId: 'co-1',
      matchText: 'webflow',
      category: 'Software',
      priority: 0,
      createdAt: new Date('2026-01-01'),
      ruleTags: [],
    };
    const { client, queryRaw, transactionUpdate } = stageDb({ rules: [rule] });

    await expect(
      stageCategorization(
        client,
        'txn-1',
        { category: 'Software', categoryQboId: 'acct-1' },
        {
          actor: { id: null, label: 'autopilot' },
          source: 'autopilot',
          expectedUpdatedAt: '2026-07-23T12:00:00.000Z',
          requireNoMatchingRule: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'DETERMINISTIC_RULE' });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});

describe('rollbackAutopilotStaging', () => {
  it('clears only the exact still-pending staging generation', async () => {
    const stagedUpdatedAt = new Date('2026-07-23T12:01:00.000Z');
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const update = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      transaction: {
        findUnique: vi.fn(async () => ({
          companyId: 'co-1',
          status: 'PENDING',
          updatedAt: stagedUpdatedAt,
        })),
        updateMany,
        update,
      },
    };
    const client = {
      $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;

    await expect(
      rollbackAutopilotStaging(client, 'txn-1', stagedUpdatedAt),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'txn-1',
          status: 'PENDING',
          updatedAt: stagedUpdatedAt,
        },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: null,
          categoryQboId: null,
          taxCalculation: null,
          taxCode: null,
          taxCodeQboId: null,
          splitLines: { deleteMany: {} },
          txnTags: { deleteMany: {} },
        }),
      }),
    );
  });

  it('preserves a newer human edit when the staging generation changed', async () => {
    const stagedUpdatedAt = new Date('2026-07-23T12:01:00.000Z');
    const update = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      transaction: {
        findUnique: vi.fn(async () => ({
          companyId: 'co-1',
          status: 'PENDING',
          updatedAt: new Date('2026-07-23T12:02:00.000Z'),
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        update,
      },
    };
    const client = {
      $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;

    await expect(
      rollbackAutopilotStaging(client, 'txn-1', stagedUpdatedAt),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
