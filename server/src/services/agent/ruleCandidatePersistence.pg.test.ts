import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from './evaluation.js';
import {
  rebuildRuleCandidates,
  recordVerifiedRuleCandidateOutcome,
} from './ruleCandidatePersistence.js';
import { candidateContextFor } from './ruleCandidates.js';
import {
  activateRuleCandidate,
  dismissRuleCandidate,
} from '../ruleCandidates.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-30T12:00:00.000Z');

describePostgres('rule candidate PostgreSQL persistence', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('dismisses an already-dismissed candidate idempotently', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `candidate-dismiss-${suffix}`,
        legalName: 'Rule candidate fixture',
        nickname: `candidate-dismiss-${suffix.slice(0, 8)}`,
      },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: company.id,
        conditionFingerprint: `condition-${suffix}`,
        schemaVersion: 'rule-candidate-v1',
        configVersion: 'verified-writeback-v1',
        matchText: 'neutral fixture',
        state: 'ready',
        tagIds: [],
      },
    });
    const actor = { id: randomUUID(), label: 'Fixture reviewer' };

    try {
      await dismissRuleCandidate(company.id, candidate.id, actor, db);
      const firstDismissal = await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
      });

      await dismissRuleCandidate(company.id, candidate.id, actor, db);
      const secondDismissal = await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
      });

      expect(secondDismissal.dismissedAt).toEqual(firstDismissal.dismissedAt);
      await expect(db.auditEntry.count({
        where: {
          companyId: company.id,
          action: 'rule-candidate-dismissed',
        },
      })).resolves.toBe(1);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });

  it('replays idempotently, conflicts on correction, and removes reverted evidence', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `candidate-${suffix}`,
        legalName: 'Rule candidate fixture',
        nickname: `candidate-${suffix.slice(0, 8)}`,
      },
    });
    const accountA = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-a-${suffix}`,
        name: 'Category A',
        fullName: 'Expenses · Category A',
        classification: 'Expenses',
      },
    });
    const accountB = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-b-${suffix}`,
        name: 'Category B',
        fullName: 'Expenses · Category B',
        classification: 'Expenses',
      },
    });
    const tag = await db.tag.create({
      data: {
        companyId: company.id,
        name: 'Reviewed',
        color: '#64748b',
      },
    });
    await db.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'custom',
        decisionModel: 'decision-model',
        verifierModel: 'verifier-model',
        limits: {},
        configVersion: `config-${suffix}`,
      },
    });
    const transactions = await Promise.all(
      [1, 2, 3, 4].map((index) => db.transaction.create({
        data: {
          companyId: company.id,
          qboId: `purchase-${index}-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '1',
          date: NOW,
          payee: 'Northwind Market',
          amount: `-${index}.00`,
          bankAccount: 'Fixture bank',
          status: 'POSTED',
          revision: 1,
        },
      })),
    );
    const proposal = (categoryQboId: string): VerifiedCategorizationProposal => ({
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0,
        subtotalCents: -100,
        taxCents: 0,
        totalCents: -100,
        categoryQboId,
        taxCodeQboId: null,
        memo: null,
        tagIds: [],
      }],
      tagIds: [tag.id],
    });
    const outcome = (
      index: number,
      categoryQboId = accountA.qboId,
      requestId = randomUUID(),
    ): VerifiedCategorizationOutcome => {
      const candidateContext = candidateContextFor(
        'Northwind Market',
        `config-${suffix}`,
        'user',
      );
      if (candidateContext === null) throw new Error('Fixture candidate context is invalid.');
      return {
        companyId: company.id,
        transactionId: transactions[index]!.id,
        inputRevision: 1,
        requestId,
        operation: 'posted',
        proposal: proposal(categoryQboId),
        candidateContext,
      };
    };

    try {
      await db.qboMutationAttempt.createMany({
        data: Array.from({ length: 5_000 }, () => {
          const requestId = randomUUID();
          return {
            transactionId: transactions[0]!.id,
            requestId,
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 0,
            expectedSyncToken: '0',
            requestHash: `stale-${requestId}`,
            requestPayload: {},
            beforeSnapshot: {},
          };
        }),
      });
      const firstRequest = randomUUID();
      const first = outcome(0, accountA.qboId, firstRequest);
      const agreeing = [first, outcome(1), outcome(2)];
      let firstAttemptUpdatedAt: Date | null = null;
      for (const current of agreeing) {
        const attempt = await db.qboMutationAttempt.create({
          data: {
            transactionId: current.transactionId,
            requestId: current.requestId,
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 1,
            expectedSyncToken: '0',
            requestHash: `hash-${current.requestId}`,
            requestPayload: {
              // Prisma Json columns take InputJsonValue.
              ruleCandidateFold: { version: 1 },
              categorizationEvidence: { version: 1, proposal: current.proposal },
              ruleCandidateEvidence: {
                version: 1,
                ...current.candidateContext,
              },
            } as unknown as Prisma.InputJsonValue,
            beforeSnapshot: {},
          },
        });
        if (current.requestId === firstRequest) {
          firstAttemptUpdatedAt = attempt.updatedAt;
        }
        await recordVerifiedRuleCandidateOutcome(current, { db, now: () => NOW });
      }
      await expect(db.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: firstRequest },
        select: { updatedAt: true, ruleCandidateFoldedAt: true },
      })).resolves.toEqual({
        updatedAt: firstAttemptUpdatedAt,
        ruleCandidateFoldedAt: NOW,
      });
      await recordVerifiedRuleCandidateOutcome(first, { db, now: () => NOW });

      let ready = await db.autopilotRuleCandidate.findFirstOrThrow({
        where: { companyId: company.id },
      });
      expect(ready).toMatchObject({
        state: 'ready',
        matchText: 'northwind market',
        categoryQboId: accountA.qboId,
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      });
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { candidateId: ready.id, active: true },
      })).resolves.toBe(3);

      const firstEvidence = await db.autopilotRuleCandidateEvidence.findUniqueOrThrow({
        where: { requestId: firstRequest },
      });
      await db.transaction.update({
        where: { id: transactions[0]!.id },
        data: { payee: 'Changed fixture payee' },
      });
      await db.agentCompanyConfig.update({
        where: { companyId: company.id },
        data: { configVersion: `changed-${suffix}` },
      });
      await recordVerifiedRuleCandidateOutcome(first, {
        db,
        now: () => new Date(NOW.getTime() + 60_000),
      });
      await expect(db.autopilotRuleCandidate.count({
        where: { companyId: company.id },
      })).resolves.toBe(1);
      await expect(db.autopilotRuleCandidateEvidence.findUniqueOrThrow({
        where: { requestId: firstRequest },
      })).resolves.toMatchObject({
        candidateId: firstEvidence.candidateId,
        observedAt: firstEvidence.observedAt,
        active: true,
      });
      await db.transaction.update({
        where: { id: transactions[0]!.id },
        data: { payee: 'Northwind Market' },
      });
      await db.agentCompanyConfig.update({
        where: { companyId: company.id },
        data: { configVersion: `config-${suffix}` },
      });

      await db.autopilotRuleCandidateFold.deleteMany({ where: { companyId: company.id } });
      await db.autopilotRuleCandidate.deleteMany({ where: { companyId: company.id } });
      await db.qboMutationAttempt.updateMany({
        where: { requestId: { in: agreeing.map((row) => row.requestId) } },
        data: { ruleCandidateFoldedAt: null },
      });
      const repairTimestamp = (await db.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: firstRequest },
        select: { updatedAt: true },
      })).updatedAt;
      await rebuildRuleCandidates(company.id, { db, now: () => NOW });
      await expect(db.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: firstRequest },
        select: { updatedAt: true, ruleCandidateFoldedAt: true },
      })).resolves.toEqual({
        updatedAt: repairTimestamp,
        ruleCandidateFoldedAt: NOW,
      });
      ready = await db.autopilotRuleCandidate.findFirstOrThrow({
        where: { companyId: company.id },
      });
      expect(ready).toMatchObject({
        state: 'ready',
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      });

      const conflicting = outcome(3, accountB.qboId);
      await db.qboMutationAttempt.create({
        data: {
          transactionId: conflicting.transactionId,
          requestId: conflicting.requestId,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '0',
          requestHash: `hash-${conflicting.requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
            categorizationEvidence: { version: 1, proposal: conflicting.proposal },
            ruleCandidateEvidence: {
              version: 1,
              ...conflicting.candidateContext,
            },
          } as unknown as Prisma.InputJsonValue,
          beforeSnapshot: {},
        },
      });
      await expect(activateRuleCandidate(
        company.id,
        ready.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      )).rejects.toMatchObject({
        code: 'CANDIDATE_NOT_READY',
      });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      })).resolves.toMatchObject({
        state: 'conflict',
        evidenceCount: 3,
        conflictingEvidenceCount: 1,
      });

      await db.transaction.update({
        where: { id: transactions[3]!.id },
        data: { status: 'REVERTED' },
      });
      const reverted = {
        ...conflicting,
        requestId: randomUUID(),
        operation: 'reverted',
        proposal: null,
        candidateContext: null,
      } satisfies VerifiedCategorizationOutcome;
      await db.qboMutationAttempt.create({
        data: {
          transactionId: reverted.transactionId,
          requestId: reverted.requestId,
          operation: 'restore',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '1',
          requestHash: `hash-${reverted.requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
          },
          beforeSnapshot: {},
        },
      });
      await recordVerifiedRuleCandidateOutcome(reverted, { db, now: () => NOW });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      })).resolves.toMatchObject({
        state: 'ready',
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      });

      let releaseRuleMutation!: () => void;
      let signalRuleLock!: () => void;
      const ruleMutationCanFinish = new Promise<void>((resolve) => {
        releaseRuleMutation = resolve;
      });
      const ruleLockAcquired = new Promise<void>((resolve) => {
        signalRuleLock = resolve;
      });
      const overlappingRule = db.$transaction(async (tx) => {
        await lockCompanyMutationScope(tx, company.id);
        signalRuleLock();
        await ruleMutationCanFinish;
        return tx.rule.create({
          data: {
            companyId: company.id,
            priority: -100,
            matchField: 'payee',
            matchText: 'northwind',
            category: accountA.name,
            categoryQboId: accountA.qboId,
            autoPost: false,
          },
        });
      });
      await ruleLockAcquired;
      const racedActivation = activateRuleCandidate(
        company.id,
        ready.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseRuleMutation();
      const overlapping = await overlappingRule;
      await expect(racedActivation).rejects.toMatchObject({
        code: 'CANDIDATE_STALE',
      });
      await db.rule.delete({ where: { id: overlapping.id } });

      const activated = await activateRuleCandidate(
        company.id,
        ready.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      );
      expect(activated).toMatchObject({
        state: 'activated',
        canActivate: false,
        evidenceCount: 3,
        category: 'Category A',
      });
      const rule = await db.rule.findUniqueOrThrow({
        where: { id: activated.activatedRuleId! },
        include: { ruleTags: true },
      });
      expect(rule).toMatchObject({
        matchText: 'northwind market',
        categoryQboId: accountA.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        autoPost: false,
        reviewRequiredAt: null,
      });
      expect(rule.ruleTags.map((row) => row.tagId)).toEqual([tag.id]);
      const activationSnapshot = await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      });
      expect(activationSnapshot).toMatchObject({
        activationEvidenceCount: 3,
        activationActionFingerprint: ready.winningActionFingerprint,
      });

      await db.transaction.update({
        where: { id: transactions[3]!.id },
        data: { status: 'POSTED' },
      });
      const counterexample = outcome(3, accountB.qboId);
      await db.qboMutationAttempt.create({
        data: {
          transactionId: counterexample.transactionId,
          requestId: counterexample.requestId,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '1',
          requestHash: `hash-${counterexample.requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
            categorizationEvidence: { version: 1, proposal: counterexample.proposal },
            ruleCandidateEvidence: {
              version: 1,
              ...counterexample.candidateContext,
            },
          } as unknown as Prisma.InputJsonValue,
          beforeSnapshot: {},
        },
      });
      await recordVerifiedRuleCandidateOutcome(counterexample, { db, now: () => NOW });
      await expect(db.rule.findUniqueOrThrow({
        where: { id: rule.id },
      })).resolves.toMatchObject({
        autoPost: false,
        reviewRequiredAt: NOW,
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
      });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      })).resolves.toMatchObject({
        activationEvidenceCount: 3,
        activationActionFingerprint: ready.winningActionFingerprint,
      });
      await expect(db.auditEntry.count({
        where: { companyId: company.id, action: 'rule-candidate-activated' },
      })).resolves.toBe(1);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  }, 30_000);
});
