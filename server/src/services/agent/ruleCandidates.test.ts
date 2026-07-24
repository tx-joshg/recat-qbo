import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  activateRuleCandidate,
  normalizeCandidatePayee,
  refreshRuleCandidate,
} from './ruleCandidates.js';

const decision = {
  kind: 'categorize',
  taxCalculation: 'TaxInclusive',
  lines: [{ grossAmount: -29, categoryQboId: 'software', taxCodeQboId: 'gst' }],
  rationale: 'Recurring software.',
  evidence: ['history'],
  confidence: 0.98,
};
const validation = {
  ok: true,
  resolvedLines: [
    {
      grossAmount: -29,
      category: 'Expenses · Software',
      categoryQboId: 'software',
      taxCode: 'GST',
      taxCodeQboId: 'gst',
    },
  ],
};
const verifier = { verdict: 'agree', rationale: 'Consistent evidence.' };

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: 'co-1',
    completedAt: new Date('2026-07-23T10:00:00Z'),
    errorCode: null,
    decision,
    validation,
    verifier,
    transactionSnapshot: {
      payee: 'WEBFLOW * 1234',
      qboType: 'Purchase',
      amount: -29,
    },
    transaction: {
      id: `txn-${id}`,
    },
    ...overrides,
  };
}

function activeReferenceTables() {
  return {
    company: {
      findUnique: vi.fn(async () => ({ holdingAccountIds: ['holding-1'] })),
    },
    qboAccount: {
      findFirst: vi.fn(async () => ({
        qboId: 'software',
        name: 'Expenses · Software',
        active: true,
        classification: 'Expense',
        accountType: 'Expense',
      })),
    },
    qboTaxCode: {
      findMany: vi.fn(async () => [
        {
          qboId: 'gst',
          name: 'GST',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{ taxRateQboId: 'rate-1' }],
        },
      ]),
    },
  };
}

describe('rule candidates', () => {
  it('normalizes changing merchant suffixes conservatively', () => {
    expect(normalizeCandidatePayee('  WEBFLOW * 1234 ')).toBe('webflow');
    expect(normalizeCandidatePayee('7-ELEVEN')).toBe('7 eleven');
  });

  it('creates one idempotent candidate after three identical verifier-agreed runs', async () => {
    const upsert = vi.fn(async () => ({ id: 'candidate-1' }));
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => run('1')),
        findMany: vi.fn(async () => [run('1'), run('2'), run('3')]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      rule: { findMany: vi.fn(async () => []) },
      ruleCandidate: {
        findMany: vi.fn(async () => []),
        upsert,
      },
    } as unknown as PrismaClient;

    await expect(refreshRuleCandidate('1', db)).resolves.toEqual({ id: 'candidate-1' });
    expect(vi.mocked(db.agentRun.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          candidatePayee: 'webflow',
        }),
      }),
    );
    expect(vi.mocked(db.auditEntry.count)).toHaveBeenCalledWith({
      where: {
        companyId: 'co-1',
        txnId: { in: ['txn-1', 'txn-2', 'txn-3'] },
        action: { in: ['reverted', 'superseded'] },
      },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          evidenceCount: 3,
          matchText: 'webflow',
          categoryQboId: 'software',
          taxCodeQboId: 'gst',
        }),
        update: expect.objectContaining({ evidenceCount: 3 }),
      }),
    );
  });

  it('does not count repeated runs of one transaction as separate evidence', async () => {
    const sameTransaction = { id: 'txn-one' };
    const upsert = vi.fn(async () => ({ id: 'candidate-1' }));
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => run('1', { transaction: sameTransaction })),
        findMany: vi.fn(async () => [
          run('1', { transaction: sameTransaction }),
          run('2', { transaction: sameTransaction }),
          run('3', { transaction: sameTransaction }),
        ]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      rule: { findMany: vi.fn(async () => []) },
      ruleCandidate: {
        findMany: vi.fn(async () => []),
        upsert,
      },
    } as unknown as PrismaClient;

    await expect(refreshRuleCandidate('1', db)).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refreshes an established candidate when a new conflicting decision arrives', async () => {
    const conflict = run('4', {
      decision: {
        ...decision,
        lines: [{ grossAmount: -29, categoryQboId: 'meals', taxCodeQboId: 'gst' }],
      },
      validation: {
        ...validation,
        resolvedLines: [
          {
            ...validation.resolvedLines[0],
            category: 'Expenses · Meals',
            categoryQboId: 'meals',
          },
        ],
      },
    });
    const update = vi.fn(async () => ({ id: 'candidate-1' }));
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => conflict),
        findMany: vi.fn(async () => [run('1'), run('2'), run('3'), conflict]),
      },
      rule: { findMany: vi.fn(async () => []) },
      ruleCandidate: {
        findMany: vi.fn(async () => [
          {
            id: 'candidate-1',
            matchText: 'webflow',
            categoryQboId: 'software',
            taxCalculation: 'TaxInclusive',
            taxCodeQboId: 'gst',
          },
        ]),
        update,
        upsert: vi.fn(),
      },
    } as unknown as PrismaClient;

    await expect(refreshRuleCandidate('4', db)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'candidate-1' },
      data: {
        conflicts: [
          expect.objectContaining({
            runId: '4',
            categoryQboId: 'meals',
          }),
        ],
      },
    });
  });

  it('does not promote conflicting verified results', async () => {
    const conflict = run('4', {
      decision: {
        ...decision,
        lines: [{ grossAmount: -29, categoryQboId: 'meals', taxCodeQboId: 'gst' }],
      },
      validation: {
        ...validation,
        resolvedLines: [
          {
            ...validation.resolvedLines[0],
            category: 'Expenses · Meals',
            categoryQboId: 'meals',
          },
        ],
      },
    });
    const upsert = vi.fn(async () => ({ id: 'candidate-1' }));
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => run('1')),
        findMany: vi.fn(async () => [run('1'), run('2'), run('3'), conflict]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      rule: { findMany: vi.fn(async () => []) },
      ruleCandidate: { upsert },
    } as unknown as PrismaClient;

    await refreshRuleCandidate('1', db);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conflicts: [expect.objectContaining({ runId: '4', categoryQboId: 'meals' })],
        }),
      }),
    );
  });

  it('records an existing substring rule that would shadow the candidate', async () => {
    const upsert = vi.fn(async () => ({ id: 'candidate-1' }));
    const db = {
      agentRun: {
        findUnique: vi.fn(async () =>
          run('1', {
            transactionSnapshot: {
              payee: 'AMAZON WEB SERVICES 1234',
              qboType: 'Purchase',
              amount: -29,
            },
          }),
        ),
        findMany: vi.fn(async () =>
          ['1', '2', '3'].map((id) =>
            run(id, {
              transactionSnapshot: {
                payee: 'AMAZON WEB SERVICES 1234',
                qboType: 'Purchase',
                amount: -29,
              },
            }),
          ),
        ),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      rule: {
        findMany: vi.fn(async () => [
          {
            id: 'rule-amazon',
            matchText: 'amazon',
            categoryQboId: 'software',
            taxCalculation: 'TaxInclusive',
            taxCodeQboId: 'gst',
            priority: 0,
          },
        ]),
      },
      ruleCandidate: { upsert },
    } as unknown as PrismaClient;

    await refreshRuleCandidate('1', db);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conflicts: [
            expect.objectContaining({ ruleId: 'rule-amazon', matchText: 'amazon' }),
          ],
        }),
      }),
    );
  });

  it('uses the immutable run snapshot instead of a transaction payee edited later', async () => {
    const upsert = vi.fn(async () => ({ id: 'candidate-1' }));
    const editedTransaction = { id: 'txn-1', payee: 'UNRELATED NEW PAYEE' };
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => run('1', { transaction: editedTransaction })),
        findMany: vi.fn(async () => [
          run('1', { transaction: editedTransaction }),
          run('2'),
          run('3'),
        ]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      rule: { findMany: vi.fn(async () => []) },
      ruleCandidate: { upsert },
    } as unknown as PrismaClient;

    await refreshRuleCandidate('1', db);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          normalizedPayee: 'webflow',
          matchText: 'webflow',
        }),
      }),
    );
  });

  it('rejects legacy evidence that has no run-time transaction snapshot', async () => {
    const upsert = vi.fn();
    const db = {
      agentRun: {
        findUnique: vi.fn(async () => run('1', { transactionSnapshot: null })),
      },
      ruleCandidate: { upsert },
    } as unknown as PrismaClient;

    await expect(refreshRuleCandidate('1', db)).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('activates at the bottom of rule priority with auto-post disabled', async () => {
    const create = vi.fn(async () => ({ id: 'rule-2' }));
    const update = vi.fn(async () => ({}));
    const companyUpdate = vi.fn(async () => ({}));
    const tx = {
      ...activeReferenceTables(),
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      ruleCandidate: {
        findFirst: vi.fn(async () => ({
          id: 'candidate-1',
          companyId: 'co-1',
          status: 'pending',
          conflicts: [{ ruleId: 'deleted-rule', matchText: 'webflow', priority: 0 }],
          evidenceCount: 3,
          evidenceRunIds: ['run-1', 'run-2', 'run-3'],
          normalizedPayee: 'webflow',
          matchText: 'webflow',
          category: 'Expenses · Software',
          categoryQboId: 'software',
          taxCalculation: 'TaxInclusive',
          taxCode: 'GST',
          taxCodeQboId: 'gst',
        })),
        update,
      },
      rule: {
        findMany: vi.fn(async () => [{ id: 'rule-1', matchText: 'Adobe', priority: 7 }]),
        create,
      },
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { transactionId: 'txn-1' },
            { transactionId: 'txn-2' },
            { transactionId: 'txn-3' },
          ])
          .mockResolvedValueOnce([run('1'), run('2'), run('3')]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
      company: {
        ...activeReferenceTables().company,
        update: companyUpdate,
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(activateRuleCandidate('co-1', 'candidate-1', 'user-1', db)).resolves.toEqual({
      candidateId: 'candidate-1',
      ruleId: 'rule-2',
    });
    expect(tx.agentRun.findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          candidatePayee: 'webflow',
        }),
      }),
    );
    expect(tx.auditEntry.count).toHaveBeenCalledWith({
      where: {
        companyId: 'co-1',
        txnId: { in: ['txn-1', 'txn-2', 'txn-3'] },
        action: { in: ['reverted', 'superseded'] },
      },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priority: 8,
        matchText: 'webflow',
        autoPost: false,
        createdById: 'user-1',
      }),
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'candidate-1' },
      data: { status: 'activated', createdRuleId: 'rule-2' },
    });
    expect(companyUpdate).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { agentReconcileToken: expect.any(String) },
    });
  });

  it('rejects activation when stored runs cover fewer than three transactions', async () => {
    const tx = {
      ...activeReferenceTables(),
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      ruleCandidate: {
        findFirst: vi.fn(async () => ({
          id: 'candidate-1',
          companyId: 'co-1',
          status: 'pending',
          conflicts: [],
          evidenceCount: 3,
          evidenceRunIds: ['run-1', 'run-2', 'run-3'],
        })),
      },
      agentRun: {
        findMany: vi.fn(async () => [
          { transactionId: 'txn-1' },
          { transactionId: 'txn-1' },
          { transactionId: 'txn-1' },
        ]),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      activateRuleCandidate('co-1', 'candidate-1', 'user-1', db),
    ).rejects.toThrow('distinct transactions');
  });

  it('rejects activation when an earlier substring rule would always win', async () => {
    const tx = {
      ...activeReferenceTables(),
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      ruleCandidate: {
        findFirst: vi.fn(async () => ({
          id: 'candidate-1',
          companyId: 'co-1',
          status: 'pending',
          conflicts: [],
          evidenceCount: 3,
          evidenceRunIds: ['run-1', 'run-2', 'run-3'],
          normalizedPayee: 'amazon web services',
          matchText: 'amazon web services',
          category: 'Expenses · Software',
          categoryQboId: 'software',
          taxCalculation: 'TaxInclusive',
          taxCode: 'GST',
          taxCodeQboId: 'gst',
        })),
      },
      rule: {
        findMany: vi.fn(async () => [
          { id: 'rule-amazon', matchText: 'amazon', priority: 0 },
        ]),
      },
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { transactionId: 'txn-1' },
            { transactionId: 'txn-2' },
            { transactionId: 'txn-3' },
          ])
          .mockResolvedValueOnce([
            run('1', {
              transactionSnapshot: {
                payee: 'AMAZON WEB SERVICES',
                qboType: 'Purchase',
                amount: -29,
              },
            }),
            run('2', {
              transactionSnapshot: {
                payee: 'AMAZON WEB SERVICES',
                qboType: 'Purchase',
                amount: -29,
              },
            }),
            run('3', {
              transactionSnapshot: {
                payee: 'AMAZON WEB SERVICES',
                qboType: 'Purchase',
                amount: -29,
              },
            }),
          ]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      activateRuleCandidate('co-1', 'candidate-1', 'user-1', db),
    ).rejects.toThrow('higher-priority rule');
  });

  it('rejects activation when the category account was deactivated', async () => {
    const refs = activeReferenceTables();
    refs.qboAccount.findFirst.mockResolvedValue(null as never);
    const tx = {
      ...refs,
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      ruleCandidate: {
        findFirst: vi.fn(async () => ({
          id: 'candidate-1',
          companyId: 'co-1',
          status: 'pending',
          conflicts: [],
          evidenceCount: 3,
          evidenceRunIds: ['run-1', 'run-2', 'run-3'],
          normalizedPayee: 'webflow',
          matchText: 'webflow',
          category: 'Expenses · Software',
          categoryQboId: 'software',
          taxCalculation: 'TaxInclusive',
          taxCode: 'GST',
          taxCodeQboId: 'gst',
        })),
      },
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { transactionId: 'txn-1' },
            { transactionId: 'txn-2' },
            { transactionId: 'txn-3' },
          ])
          .mockResolvedValueOnce([run('1'), run('2'), run('3')]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      activateRuleCandidate('co-1', 'candidate-1', 'user-1', db),
    ).rejects.toThrow('category account is no longer active');
  });

  it('rejects activation when the purchase TaxCode was deactivated', async () => {
    const refs = activeReferenceTables();
    refs.qboTaxCode.findMany.mockResolvedValue([
      {
        qboId: 'gst',
        name: 'GST',
        active: false,
        taxable: true,
        purchaseTaxRateList: [{ taxRateQboId: 'rate-1' }],
      },
    ]);
    const tx = {
      ...refs,
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      ruleCandidate: {
        findFirst: vi.fn(async () => ({
          id: 'candidate-1',
          companyId: 'co-1',
          status: 'pending',
          conflicts: [],
          evidenceCount: 3,
          evidenceRunIds: ['run-1', 'run-2', 'run-3'],
          normalizedPayee: 'webflow',
          matchText: 'webflow',
          category: 'Expenses · Software',
          categoryQboId: 'software',
          taxCalculation: 'TaxInclusive',
          taxCode: 'GST',
          taxCodeQboId: 'gst',
        })),
      },
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { transactionId: 'txn-1' },
            { transactionId: 'txn-2' },
            { transactionId: 'txn-3' },
          ])
          .mockResolvedValueOnce([run('1'), run('2'), run('3')]),
      },
      auditEntry: { count: vi.fn(async () => 0) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      activateRuleCandidate('co-1', 'candidate-1', 'user-1', db),
    ).rejects.toThrow('purchase TaxCode is no longer active');
  });
});
