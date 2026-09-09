import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { listRuleCandidates } from './ruleCandidates.js';

describe('rule candidate bounded reads', () => {
  it('caps evidence provenance and checks overlap with an existence query', async () => {
    const candidateFindMany = vi.fn(async (args: {
      include: { evidence: { take?: number } };
    }) => [{
      id: '22222222-2222-4222-8222-222222222222',
      companyId: 'company-1',
      conditionFingerprint: 'condition',
      schemaVersion: 'rule-candidate-v1',
      configVersion: 'verified-writeback-v1',
      matchField: 'payee',
      matchText: 'northwind market',
      state: 'ready',
      winningActionFingerprint: 'action',
      categoryQboId: 'account-1',
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      tagIds: [],
      evidenceCount: 60,
      conflictingEvidenceCount: 0,
      dismissedAt: null,
      dismissedByUserId: null,
      activatedAt: null,
      activatedByUserId: null,
      activationEvidenceCount: null,
      activationActionFingerprint: null,
      activatedRuleId: null,
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      updatedAt: new Date('2026-07-30T00:00:00.000Z'),
      evidence: Array.from({ length: args.include.evidence.take ?? 60 }, (_, index) => ({
        transactionId: `transaction-${index}`,
        source: 'user',
        observedAt: new Date('2026-07-30T00:00:00.000Z'),
      })),
    }]);
    const ruleFindMany = vi.fn(async () => []);
    const overlapQuery = vi.fn(async () => []);
    const repairTx = {
      $queryRawUnsafe: vi.fn(async () => [{ locked: 1 }]),
      $queryRaw: vi.fn(async () => []),
    };
    const db = {
      autopilotRuleCandidate: { findMany: candidateFindMany },
      autopilotRuleCandidateEvidence: {
        groupBy: vi.fn(async () => [{ source: 'user', _count: { _all: 60 } }]),
      },
      qboAccount: { findFirst: vi.fn(async () => ({ name: 'Office expense', classification: 'Expenses' })) },
      qboTaxCode: { findFirst: vi.fn(async () => null) },
      tag: { count: vi.fn(async () => 0) },
      agentCompanyConfig: { findUnique: vi.fn(async () => null) },
      company: {
        findUnique: vi.fn(async () => ({
          taxSupportStatus: 'needs_setup',
          taxUsingSalesTax: false,
          ruleRuntimeMode: 'legacy',
        })),
      },
      rule: {
        findMany: ruleFindMany,
      },
      $queryRaw: overlapQuery,
      $transaction: vi.fn(async (
        callback: (tx: typeof repairTx) => Promise<unknown>,
      ) => callback(repairTx)),
    } as unknown as PrismaClient;

    const result = await listRuleCandidates('company-1', {}, db);

    expect(result.candidates[0]?.evidence).toHaveLength(50);
    expect(result.candidates[0]?.provenance).toEqual({
      user: 60,
      autopilot: 0,
      mcp: 0,
    });
    expect(candidateFindMany.mock.calls[0]?.[0].include.evidence.take).toBe(50);
    expect(overlapQuery).toHaveBeenCalledTimes(1);
    expect(ruleFindMany).not.toHaveBeenCalled();
  });
});
