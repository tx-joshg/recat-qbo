import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StagedCategorization } from '@recat/shared';
import { preparePurchaseRecategorization } from '../../lib/qbo/purchaseTax.js';
import type { QboPurchaseSnapshot, RawPurchase } from '../../lib/qbo/types.js';
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
  CLASSIFICATION_ENVELOPE_VERSION,
  classificationEnvelopeHashForPreparedWrite,
  classificationEvidenceBindingForPreparedWrite,
} from '../categorizationEvidence.js';
import {
  activateRuleCandidate,
  dismissRuleCandidate,
  getRuleCandidate,
} from '../ruleCandidates.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import {
  hashClassificationPreparedWrite,
  validateDurableAttemptPersistence,
} from '../writeback.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-30T12:00:00.000Z');

async function createVerifiedBoundPurchaseAttempt(input: {
  db: PrismaClient;
  transaction: { id: string; qboId: string };
  requestId: string;
  expectedRevision: number;
  beforeSyncToken: string;
  responseSyncToken: string;
  preparedCategoryQboId: string;
  persistedProposal: VerifiedCategorizationProposal;
  candidateContext: NonNullable<VerifiedCategorizationOutcome['candidateContext']>;
}) {
  const before: QboPurchaseSnapshot = {
    qboId: input.transaction.qboId,
    syncToken: input.beforeSyncToken,
    totalCents: -1000,
    accountQboId: 'payment-bound-fixture',
    date: '2026-07-30',
    direction: 'purchase',
    globalTaxCalculation: 'NotApplicable',
    totalTaxCents: 0,
    lines: [{
      id: 'line-holding',
      amountCents: -1000,
      description: null,
      accountQboId: 'holding-bound-fixture',
      customerQboId: null,
      classQboId: null,
      taxCodeQboId: null,
      taxAmountCents: null,
      taxInclusiveCents: null,
    }],
  };
  const raw: RawPurchase = {
    Id: input.transaction.qboId,
    SyncToken: input.beforeSyncToken,
    TxnDate: '2026-07-30',
    TotalAmt: 10,
    AccountRef: { value: 'payment-bound-fixture' },
    GlobalTaxCalculation: 'NotApplicable',
    Line: [{
      Id: 'line-holding',
      Amount: 10,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'holding-bound-fixture' },
      },
    }],
  };
  const staged: StagedCategorization = {
    transactionId: input.transaction.id,
    revision: input.expectedRevision,
    taxCalculation: 'NotApplicable',
    totals: { subtotalCents: -1000, taxCents: 0, totalCents: -1000 },
    lines: [{
      idx: 0,
      subtotalCents: -1000,
      taxCents: 0,
      totalCents: -1000,
      categoryQboId: input.preparedCategoryQboId,
      taxCodeQboId: null,
      memo: null,
    }],
    tagIds: [],
  };
  const prepared = preparePurchaseRecategorization({
    current: raw,
    holdingAccountQboIds: ['holding-bound-fixture'],
    staged,
    before,
    requestId: input.requestId,
  });
  const preparedBefore = prepared.before as QboPurchaseSnapshot;
  const response: QboPurchaseSnapshot = {
    ...preparedBefore,
    syncToken: input.responseSyncToken,
    globalTaxCalculation: prepared.expected.globalTaxCalculation,
    totalTaxCents: prepared.expected.totalTaxCents,
    lines: prepared.expected.targetLines.map((line) => ({
      ...line,
      id: 'line-posted',
    })),
  };
  const preparedWriteHash = hashClassificationPreparedWrite(prepared);
  const binding = classificationEvidenceBindingForPreparedWrite(
    input.persistedProposal,
    input.candidateContext,
    preparedWriteHash,
  );
  const attempt = await input.db.qboMutationAttempt.create({
    data: {
      transactionId: input.transaction.id,
      requestId: input.requestId,
      operation: 'recategorize',
      status: 'VERIFIED',
      expectedRevision: input.expectedRevision,
      expectedSyncToken: input.beforeSyncToken,
      requestHash: prepared.requestHash,
      classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
      classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
        preparedWriteHash,
        null,
        binding,
      ),
      requestPayload: {
        ...prepared,
        ruleCandidateFold: { version: CLASSIFICATION_ENVELOPE_VERSION },
        classificationEvidenceBinding: binding,
        categorizationEvidence: { version: 1, proposal: input.persistedProposal },
        ruleCandidateEvidence: { version: 1, ...input.candidateContext },
      } as unknown as Prisma.InputJsonValue,
      beforeSnapshot: prepared.before as unknown as Prisma.InputJsonValue,
      responseSnapshot: response as unknown as Prisma.InputJsonValue,
      verification: {
        outcome: 'VERIFIED',
        status: 'POSTED',
        newSyncToken: input.responseSyncToken,
      },
    },
  });
  return { attempt, prepared, binding };
}

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

  it('rejects an observation without a verified write and leaves candidate state untouched', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `observation-no-promotion-${suffix}`,
        legalName: 'Observation no promotion fixture',
        nickname: `observation-${suffix.slice(0, 8)}`,
      },
    });
    try {
      const transaction = await db.transaction.create({
        data: {
          companyId: company.id, qboId: `observation-purchase-${suffix}`, qboType: 'Purchase',
          qboSyncToken: '1', date: NOW, payee: 'Observation-only vendor',
          amount: '-10.00', bankAccount: 'Fixture bank', status: 'POSTED', revision: 1,
        },
      });
      await db.historicalClassificationObservation.create({
        data: {
          companyId: company.id, sourceTransactionId: transaction.id, sourceQboType: 'Purchase',
          sourceQboId: transaction.qboId, sourceTransactionRevision: 1, sourceQboSyncToken: '1',
          sourceStatus: 'POSTED', sourceUpdatedAt: NOW, transactionDate: NOW,
          payee: 'Observation-only vendor', memo: null, amountCents: -1000n, currency: 'CAD',
          sourceAccountName: 'Fixture bank', categoryName: 'Fixture category',
          categoryQboId: 'fixture-category', taxCalculation: 'NotApplicable',
          taxCodeName: null, taxCodeQboId: null, tagNames: [],
        },
      });
      const counts = async () => Promise.all([
        db.classificationCase.count({ where: { companyId: company.id } }),
        db.autopilotRuleCandidate.count({ where: { companyId: company.id } }),
        db.autopilotRuleCandidateEvidence.count({ where: { companyId: company.id } }),
        db.autopilotRuleCandidateFold.count({ where: { companyId: company.id } }),
        db.rule.count({ where: { companyId: company.id } }),
        db.ruleRevision.count({ where: { companyId: company.id } }),
        db.qboMutationAttempt.count({ where: { transactionId: transaction.id } }),
        db.historicalClassificationObservation.count({ where: { companyId: company.id } }),
      ]);
      const before = await counts();
      const sourceBefore = await db.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        select: { revision: true, status: true, qboSyncToken: true, payee: true },
      });

      await expect(recordVerifiedRuleCandidateOutcome({
        companyId: company.id, transactionId: transaction.id, inputRevision: 1,
        requestId: randomUUID(), operation: 'posted', proposal: null, candidateContext: null,
      }, { db, now: () => NOW })).rejects.toThrow('not backed by one durable attempt');

      await expect(counts()).resolves.toEqual(before);
      await expect(db.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        select: { revision: true, status: true, qboSyncToken: true, payee: true },
      })).resolves.toEqual(sourceBefore);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });

  it('terminally rejects a durable but semantically mismatched no-decision attempt before activation', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `candidate-bound-repair-${suffix}`,
        legalName: 'Bound candidate repair fixture',
        nickname: `bound-${suffix.slice(0, 8)}`,
      },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-${suffix}`,
        name: 'Verified category',
        fullName: 'Expenses · Verified category',
        classification: 'Expenses',
      },
    });
    const transactions = await Promise.all([0, 1, 2].map((index) => db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${index}-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: NOW,
        payee: 'Bound Repair Vendor',
        amount: '-10.00',
        bankAccount: 'Fixture bank',
        status: 'POSTED',
        revision: 1,
      },
    })));
    const candidateContext = candidateContextFor(
      'Bound Repair Vendor',
      `config-${suffix}`,
      'user',
    );
    if (candidateContext === null) throw new Error('Fixture candidate context is invalid.');
    const proposal: VerifiedCategorizationProposal = {
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0,
        subtotalCents: -1000,
        taxCents: 0,
        totalCents: -1000,
        categoryQboId: account.qboId,
        taxCodeQboId: null,
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    };
    const outcome = (index: number, requestId = randomUUID()): VerifiedCategorizationOutcome => ({
      companyId: company.id,
      transactionId: transactions[index]!.id,
      inputRevision: 1,
      requestId,
      operation: 'posted',
      proposal,
      candidateContext,
    });

    try {
      for (const index of [0, 1]) {
        const current = outcome(index);
        await db.qboMutationAttempt.create({
          data: {
            transactionId: current.transactionId,
            requestId: current.requestId,
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 1,
            expectedSyncToken: '0',
            requestHash: `legacy-${current.requestId}`,
            requestPayload: { ruleCandidateFold: { version: 1 } },
            beforeSnapshot: {},
          },
        });
        await recordVerifiedRuleCandidateOutcome(current, { db, now: () => NOW });
      }
      const candidate = await db.autopilotRuleCandidate.findFirstOrThrow({
        where: { companyId: company.id },
      });
      expect(candidate).toMatchObject({ state: 'gathering', evidenceCount: 2 });

      const third = outcome(2);
      const {
        attempt: thirdAttempt,
        prepared,
        binding,
      } = await createVerifiedBoundPurchaseAttempt({
        db,
        transaction: transactions[2]!,
        requestId: third.requestId,
        expectedRevision: 1,
        beforeSyncToken: '0',
        responseSyncToken: '1',
        preparedCategoryQboId: `different-provider-action-${suffix}`,
        persistedProposal: proposal,
        candidateContext,
      });
      expect(validateDurableAttemptPersistence(thirdAttempt)).toMatchObject({
        operation: 'recategorize',
        qboType: 'Purchase',
        qboId: transactions[2]!.qboId,
        requestId: third.requestId,
        requestHash: prepared.requestHash,
        expectedSyncToken: '0',
      });
      expect(prepared.expected.targetLines[0]?.accountQboId).not.toBe(
        proposal.lines[0]?.categoryQboId,
      );
      expect(thirdAttempt.classificationEnvelopeHash).toBe(
        classificationEnvelopeHashForPreparedWrite(
          hashClassificationPreparedWrite(prepared),
          null,
          binding,
        ),
      );

      await expect(activateRuleCandidate(
        company.id,
        candidate.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      )).rejects.toMatchObject({ code: 'CANDIDATE_NOT_READY' });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
      })).resolves.toMatchObject({ state: 'gathering', evidenceCount: 2 });
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { candidateId: candidate.id, active: true },
      })).resolves.toBe(2);
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { requestId: third.requestId },
      })).resolves.toBe(0);
      await expect(db.classificationCase.count({
        where: { companyId: company.id },
      })).resolves.toBe(0);
      await expect(db.autopilotRuleCandidateFold.count({
        where: { requestId: third.requestId },
      })).resolves.toBe(1);
      await expect(db.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: third.requestId },
        select: { ruleCandidateFoldedAt: true },
      })).resolves.toEqual({ ruleCandidateFoldedAt: expect.any(Date) });
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });

  it('folds a pending cross-config correction before activating its old candidate', async () => {
    const suffix = randomUUID();
    const oldConfigVersion = `old-config-${suffix}`;
    const newConfigVersion = `new-config-${suffix}`;
    const company = await db.company.create({
      data: {
        realmId: `candidate-cross-config-${suffix}`,
        legalName: 'Cross-config candidate fixture',
        nickname: `cross-${suffix.slice(0, 8)}`,
      },
    });
    const accountA = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-a-${suffix}`,
        name: 'Original category',
        fullName: 'Expenses · Original category',
        classification: 'Expenses',
      },
    });
    const accountB = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-b-${suffix}`,
        name: 'Corrected category',
        fullName: 'Expenses · Corrected category',
        classification: 'Expenses',
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
        configVersion: oldConfigVersion,
      },
    });
    const transactions = await Promise.all([0, 1, 2, 3].map((index) => db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `cross-config-purchase-${index}-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: NOW,
        payee: 'Cross Config Vendor',
        amount: '-10.00',
        bankAccount: 'Fixture bank',
        status: 'POSTED',
        revision: 1,
      },
    })));
    const oldContext = candidateContextFor('Cross Config Vendor', oldConfigVersion, 'user');
    const newContext = candidateContextFor('Cross Config Vendor', newConfigVersion, 'user');
    if (oldContext === null || newContext === null) {
      throw new Error('Fixture candidate context is invalid.');
    }
    const proposal = (categoryQboId: string): VerifiedCategorizationProposal => ({
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0,
        subtotalCents: -1000,
        taxCents: 0,
        totalCents: -1000,
        categoryQboId,
        taxCodeQboId: null,
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    });

    try {
      for (const transaction of transactions) {
        const requestId = randomUUID();
        const outcome: VerifiedCategorizationOutcome = {
          companyId: company.id,
          transactionId: transaction.id,
          inputRevision: 1,
          requestId,
          operation: 'posted',
          proposal: proposal(accountA.qboId),
          candidateContext: oldContext,
        };
        await db.qboMutationAttempt.create({
          data: {
            transactionId: transaction.id,
            requestId,
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 1,
            expectedSyncToken: '0',
            requestHash: `legacy-${requestId}`,
            requestPayload: { ruleCandidateFold: { version: 1 } },
            beforeSnapshot: {},
          },
        });
        await recordVerifiedRuleCandidateOutcome(outcome, { db, now: () => NOW });
      }
      const oldCandidate = await db.autopilotRuleCandidate.findFirstOrThrow({
        where: { companyId: company.id, configVersion: oldConfigVersion },
      });
      expect(oldCandidate).toMatchObject({
        state: 'ready',
        evidenceCount: 4,
        conflictingEvidenceCount: 0,
      });

      const corrected = transactions[0]!;
      const correctionRequestId = randomUUID();
      await createVerifiedBoundPurchaseAttempt({
        db,
        transaction: corrected,
        requestId: correctionRequestId,
        expectedRevision: 2,
        beforeSyncToken: '1',
        responseSyncToken: '2',
        preparedCategoryQboId: accountB.qboId,
        persistedProposal: proposal(accountB.qboId),
        candidateContext: newContext,
      });
      await db.transaction.update({
        where: { id: corrected.id },
        data: { revision: 2, qboSyncToken: '2' },
      });

      await expect(activateRuleCandidate(
        company.id,
        oldCandidate.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      )).rejects.toMatchObject({ code: 'CANDIDATE_NOT_READY' });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: oldCandidate.id },
      })).resolves.toMatchObject({
        state: 'conflict',
        evidenceCount: 3,
        conflictingEvidenceCount: 1,
      });
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: {
          candidateId: oldCandidate.id,
          requestId: correctionRequestId,
          polarity: 'negative',
          active: true,
        },
      })).resolves.toBe(1);
      await expect(db.autopilotRuleCandidate.findFirstOrThrow({
        where: { companyId: company.id, configVersion: newConfigVersion },
      })).resolves.toMatchObject({ state: 'gathering', evidenceCount: 1 });
      await expect(db.autopilotRuleCandidateFold.count({
        where: { requestId: correctionRequestId },
      })).resolves.toBe(1);
      await expect(db.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: correctionRequestId },
        select: { ruleCandidateFoldedAt: true },
      })).resolves.toEqual({ ruleCandidateFoldedAt: expect.any(Date) });
      await expect(db.rule.count({ where: { companyId: company.id } })).resolves.toBe(0);
      await expect(db.classificationCase.count({
        where: { companyId: company.id },
      })).resolves.toBe(0);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });

  it('replays idempotently and preserves threshold-breaking correction and undo counterevidence', async () => {
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
      const agreeing = [first, outcome(1), outcome(2), outcome(3)];
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
              ruleCandidateFold: { version: 1 },
              categorizationEvidence: { version: 1, proposal: current.proposal },
              ruleCandidateEvidence: {
                version: 1,
                ...current.candidateContext,
              },
            },
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
        evidenceCount: 4,
        conflictingEvidenceCount: 0,
      });
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { candidateId: ready.id, active: true },
      })).resolves.toBe(4);

      const firstEvidence = await db.autopilotRuleCandidateEvidence.findFirstOrThrow({
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
      await expect(db.autopilotRuleCandidateEvidence.findFirstOrThrow({
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
        evidenceCount: 4,
        conflictingEvidenceCount: 0,
      });
      await expect(db.classificationCase.count({
        where: { companyId: company.id },
      })).resolves.toBe(0);

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
          },
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
        data: { status: 'PENDING' },
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
        state: 'conflict',
        evidenceCount: 3,
        conflictingEvidenceCount: 1,
      });

      await db.transaction.update({
        where: { id: transactions[3]!.id },
        data: { status: 'POSTED' },
      });
      const replacement = outcome(3, accountA.qboId);
      await db.qboMutationAttempt.create({
        data: {
          transactionId: replacement.transactionId,
          requestId: replacement.requestId,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '1',
          requestHash: `hash-${replacement.requestId}`,
          requestPayload: {
            ruleCandidateFold: { version: 1 },
            categorizationEvidence: { version: 1, proposal: replacement.proposal },
            ruleCandidateEvidence: {
              version: 1,
              ...replacement.candidateContext,
            },
          },
          beforeSnapshot: {},
        },
      });
      await recordVerifiedRuleCandidateOutcome(replacement, { db, now: () => NOW });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      })).resolves.toMatchObject({
        state: 'ready',
        evidenceCount: 4,
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
      await db.rule.update({
        where: { id: overlapping.id },
        data: { enabled: false, retiredAt: NOW },
      });

      const activationActor = { id: randomUUID(), label: 'Fixture reviewer' };
      const activated = await activateRuleCandidate(
        company.id,
        ready.id,
        activationActor,
        db,
      );
      expect(activated).toMatchObject({
        state: 'activated',
        canActivate: false,
        evidenceCount: 4,
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
        revision: 0,
        originIntent: 'auto_candidate',
        sourceCandidateId: ready.id,
        updatedById: activationActor.id,
        reviewRequiredAt: null,
      });
      expect(rule.ruleTags.map((row) => row.tagId)).toEqual([tag.id]);
      await expect(db.ruleRevision.findMany({
        where: { companyId: company.id, ruleId: rule.id },
        orderBy: { revision: 'asc' },
      })).resolves.toEqual([
        expect.objectContaining({
          revision: 0,
          state: 'enabled',
          sourceCandidateId: ready.id,
          changedBy: activationActor.id,
          autoPost: false,
          tagIds: [tag.id],
        }),
      ]);
      const activationSnapshot = await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      });
      expect(activationSnapshot).toMatchObject({
        activationEvidenceCount: 4,
        activationActionFingerprint: ready.winningActionFingerprint,
      });

      await db.rule.update({
        where: { id: rule.id },
        data: {
          autoPost: true,
          revision: 1,
          updatedById: 'fixture-manual-enabler',
        },
      });
      await db.ruleRevision.create({
        data: {
          ruleId: rule.id,
          companyId: company.id,
          revision: 1,
          state: 'enabled',
          matchField: rule.matchField,
          matchText: rule.matchText,
          category: rule.category,
          categoryQboId: rule.categoryQboId,
          taxCalculation: rule.taxCalculation,
          taxCode: rule.taxCode,
          taxCodeQboId: rule.taxCodeQboId,
          tagIds: [tag.id],
          priority: rule.priority,
          autoPost: true,
          originIntent: 'auto_candidate',
          sourceCandidateId: ready.id,
          changedBy: 'fixture-manual-enabler',
        },
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
          },
          beforeSnapshot: {},
        },
      });
      await recordVerifiedRuleCandidateOutcome(counterexample, { db, now: () => NOW });
      await expect(db.rule.findUniqueOrThrow({
        where: { id: rule.id },
      })).resolves.toMatchObject({
        enabled: false,
        autoPost: false,
        revision: 2,
        updatedById: 'system:rule-candidate-evidence',
        reviewRequiredAt: NOW,
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
      });
      await expect(db.ruleRevision.findUniqueOrThrow({
        where: {
          companyId_ruleId_revision: {
            companyId: company.id,
            ruleId: rule.id,
            revision: 2,
          },
        },
      })).resolves.toMatchObject({
        state: 'disabled',
        autoPost: false,
        sourceCandidateId: ready.id,
        changedBy: 'system:rule-candidate-evidence',
        tagIds: [tag.id],
      });
      await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.id },
      })).resolves.toMatchObject({
        activationEvidenceCount: 4,
        activationActionFingerprint: ready.winningActionFingerprint,
      });
      await expect(db.auditEntry.count({
        where: { companyId: company.id, action: 'rule-candidate-activated' },
      })).resolves.toBe(1);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  }, 30_000);

  it('keeps a legacy taxed candidate inert until the normal rule executor can reproduce tax writes', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `candidate-tax-${suffix}`,
        legalName: 'Tax candidate fixture',
        nickname: `candidate-tax-${suffix.slice(0, 8)}`,
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `account-${suffix}`,
        name: 'Taxed category',
        fullName: 'Expenses · Taxed category',
        classification: 'Expenses',
      },
    });
    const taxCode = await db.qboTaxCode.create({
      data: {
        companyId: company.id,
        qboId: `tax-${suffix}`,
        name: 'Synthetic tax',
        active: true,
        taxable: true,
        purchaseTaxRateList: [{
          taxRateQboId: `rate-${suffix}`,
          taxTypeApplicable: 'TaxOnAmount',
        }],
        salesTaxRateList: [],
        combinedPurchaseRate: null,
      },
    });
    await db.qboTaxRate.create({
      data: {
        companyId: company.id,
        qboId: `rate-${suffix}`,
        name: 'Synthetic rate',
        active: true,
        rateValue: '5',
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
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: company.id,
        conditionFingerprint: `condition-${suffix}`,
        schemaVersion: 'rule-candidate-v1',
        configVersion: `config-${suffix}`,
        matchText: 'synthetic taxed vendor',
        state: 'ready',
        winningActionFingerprint: `action-${suffix}`,
        categoryQboId: account.qboId,
        taxCalculation: 'TaxInclusive',
        taxCodeQboId: taxCode.qboId,
        tagIds: [],
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        const transaction = await db.transaction.create({
          data: {
            companyId: company.id,
            qboId: `purchase-${index}-${suffix}`,
            qboType: 'Purchase',
            qboSyncToken: '1',
            date: NOW,
            payee: 'Synthetic taxed vendor',
            amount: '-10.50',
            bankAccount: 'Fixture bank',
            status: 'POSTED',
            revision: 1,
          },
        });
        const requestId = randomUUID();
        await db.qboMutationAttempt.create({
          data: {
            transactionId: transaction.id,
            requestId,
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 1,
            expectedSyncToken: '0',
            requestHash: `hash-${requestId}`,
            requestPayload: {},
            beforeSnapshot: {},
          },
        });
        await db.autopilotRuleCandidateEvidence.create({
          data: {
            companyId: company.id,
            candidateId: candidate.id,
            transactionId: transaction.id,
            inputRevision: 1,
            requestId,
            source: 'user',
            actionFingerprint: `action-${suffix}`,
            pattern: {},
            active: true,
            observedAt: NOW,
          },
        });
      }

      await expect(getRuleCandidate(company.id, candidate.id, db)).resolves.toMatchObject({
        canActivate: false,
        staleReasons: [
          'Taxed candidates cannot activate until normal rules reproduce the same QBO tax write.',
        ],
      });
      await expect(activateRuleCandidate(
        company.id,
        candidate.id,
        { id: randomUUID(), label: 'Fixture reviewer' },
        db,
      )).rejects.toMatchObject({ code: 'CANDIDATE_STALE' });
      await expect(db.rule.count({ where: { companyId: company.id } })).resolves.toBe(0);
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });
});
