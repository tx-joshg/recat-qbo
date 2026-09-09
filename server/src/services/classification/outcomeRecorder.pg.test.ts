import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StagedCategorization } from '@recat/shared';
import { preparePurchaseRecategorization } from '../../lib/qbo/purchaseTax.js';
import type { QboPurchaseSnapshot, RawPurchase } from '../../lib/qbo/types.js';
import {
  CLASSIFICATION_ENVELOPE_VERSION,
  classificationEnvelopeHashForPreparedWrite,
  classificationDecisionForPreparedWrite,
  classificationEvidenceBindingForPreparedWrite,
  normalizeCategorizationDecisionContext,
} from '../categorizationEvidence.js';
import { candidateContextFor } from '../agent/ruleCandidates.js';
import {
  foldVerifiedRuleCandidateOutcomeInTransaction,
  rebuildRuleCandidates,
} from '../agent/ruleCandidatePersistence.js';
import {
  hashClassificationPreparedWrite,
  hashPreparedWriteBody,
} from '../writeback.js';
import {
  reconcileVerifiedClassificationOutcomes,
  recordVerifiedClassificationOutcome,
} from './outcomeRecorder.js';
import { recordVerifiedClassificationCase } from './cases.js';
import { createClassificationOutcomeRecoveryWorker } from './recovery.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-08-30T20:00:00.000Z');

describePostgres('verified classification outcome recorder on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture(options: {
    status?: string;
    categoryQboId?: string;
    taxCalculation?: 'NotApplicable' | 'TaxInclusive';
  } = {}) {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `outcome-recorder-${suffix}`,
        legalName: 'Synthetic outcome recorder company',
        nickname: `outcome-${suffix.slice(0, 8)}`,
      },
    });
    companyIds.add(company.id);
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-08-30T00:00:00.000Z'),
        payee: 'Synthetic Supply House',
        memo: 'Provider details must not be copied',
        amount: '-10.50',
        bankAccount: 'Synthetic operating account',
        rawData: { providerPrivate: 'must-not-leak' },
        status: 'POSTED',
        revision: 1,
      },
    });
    const categoryQboId = options.categoryQboId ?? `expense-${suffix}`;
    const taxCalculation = options.taxCalculation ?? 'NotApplicable';
    const taxCodeQboId = taxCalculation === 'NotApplicable' ? null : `tax-${suffix}`;
    const subtotalCents = taxCalculation === 'NotApplicable' ? -1050 : -1000;
    const taxCents = taxCalculation === 'NotApplicable' ? 0 : -50;
    const before: QboPurchaseSnapshot = {
      qboId: transaction.qboId,
      syncToken: '0',
      totalCents: -1050,
      accountQboId: 'payment-synthetic',
      date: '2026-08-30',
      direction: 'purchase',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      lines: [{
        id: 'line-holding',
        amountCents: -1050,
        description: null,
        accountQboId: 'holding-synthetic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: null,
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    };
    const raw: RawPurchase = {
      Id: transaction.qboId,
      SyncToken: '0',
      TxnDate: '2026-08-30',
      TotalAmt: 10.5,
      AccountRef: { value: 'payment-synthetic' },
      GlobalTaxCalculation: 'NotApplicable',
      Line: [{
        Id: 'line-holding',
        Amount: 10.5,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'holding-synthetic' },
        },
      }],
    };
    const staged: StagedCategorization = {
      transactionId: transaction.id,
      revision: 1,
      taxCalculation,
      totals: { subtotalCents, taxCents, totalCents: -1050 },
      lines: [{
        idx: 0,
        subtotalCents,
        taxCents,
        totalCents: -1050,
        categoryQboId,
        taxCodeQboId,
        memo: null,
      }],
      tagIds: [],
    };
    const requestId = `request-${suffix}`;
    const prepared = preparePurchaseRecategorization({
      current: raw,
      holdingAccountQboIds: ['holding-synthetic'],
      staged,
      before,
      requestId,
    });
    const preparedBefore = prepared.before as QboPurchaseSnapshot;
    const response: QboPurchaseSnapshot = {
      ...preparedBefore,
      syncToken: '1',
      globalTaxCalculation: prepared.expected.globalTaxCalculation,
      totalTaxCents: prepared.expected.totalTaxCents,
      lines: prepared.expected.targetLines.map((line) => ({ ...line, id: 'line-posted' })),
    };
    const decisionContext = normalizeCategorizationDecisionContext({
      vendorIdentityHint: {
        displayName: ' Synthetic Supply House ',
        qboVendorId: `vendor-${suffix}`,
      },
      rationale: 'Approved from synthetic supporting evidence.',
      requiredEvidence: ['Synthetic receipt'],
      examples: ['Synthetic business purchase'],
      counterexamples: ['Synthetic personal purchase'],
      citations: [],
      reviewer: {
        userId: `reviewer-${suffix}`,
        configVersion: `classification-${suffix}`,
        decision: 'approved',
      },
      originIntent: 'apply_once',
      jurisdiction: 'CA-BC',
      currency: 'CAD',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic operating account',
        businessPurpose: 'Synthetic supplies',
      },
    });
    const candidateContext = candidateContextFor(
      transaction.payee,
      `config-${suffix}`,
      'user',
    );
    if (candidateContext === null) throw new Error('Synthetic candidate context is invalid.');
    const proposal = {
      taxCalculation,
      lines: [{
        idx: 0,
        subtotalCents,
        taxCents,
        totalCents: -1050,
        categoryQboId,
        taxCodeQboId,
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    };
    const preparedWriteHash = hashClassificationPreparedWrite(prepared);
    const classificationDecision = classificationDecisionForPreparedWrite(
      decisionContext,
      preparedWriteHash,
    );
    const classificationEvidenceBinding = classificationEvidenceBindingForPreparedWrite(
      proposal,
      candidateContext,
      preparedWriteHash,
    );
    const attempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId,
        operation: 'recategorize',
        status: options.status ?? 'VERIFIED',
        expectedRevision: 1,
        expectedSyncToken: '0',
        requestHash: prepared.requestHash,
        classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          preparedWriteHash,
          classificationDecision,
          classificationEvidenceBinding,
        ),
        requestPayload: {
          ...prepared,
          classificationDecision,
          ruleCandidateFold: { version: CLASSIFICATION_ENVELOPE_VERSION },
          classificationEvidenceBinding,
          categorizationEvidence: { version: 1, proposal },
          ruleCandidateEvidence: { version: 1, ...candidateContext },
        } as unknown as Prisma.InputJsonValue,
        beforeSnapshot: prepared.before as unknown as Prisma.InputJsonValue,
        responseSnapshot: response as unknown as Prisma.InputJsonValue,
        verification: {
          outcome: 'VERIFIED',
          status: 'POSTED',
          newSyncToken: '1',
        },
      },
    });
    const outcome = {
      companyId: company.id,
      transactionId: transaction.id,
      inputRevision: 1,
      requestId,
      operation: 'posted' as const,
      proposal,
      candidateContext,
      decisionContext,
    };
    return { company, transaction, attempt, outcome, categoryQboId, taxCalculation };
  }

  it('discovers an unfolded verified write after restart and repairs its case exactly once', async () => {
    const value = await fixture();
    await expect(db.classificationCase.count({ where: { companyId: value.company.id } })).resolves.toBe(0);
    const worker = () => createClassificationOutcomeRecoveryWorker({
      db, reconcile: (companyId) => reconcileVerifiedClassificationOutcomes(companyId, { db, now: () => NOW }),
    });
    await worker()();
    await worker()();
    await expect(db.classificationCase.count({ where: { companyId: value.company.id } })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id }, select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
  });

  it('atomically records one case and active candidate evidence from an exact VERIFIED outcome', async () => {
    const value = await fixture();

    await recordVerifiedClassificationOutcome(value.outcome, { db, now: () => NOW });
    await recordVerifiedClassificationOutcome(value.outcome, { db, now: () => NOW });

    await expect(db.classificationCase.findUniqueOrThrow({
      where: { qboMutationAttemptId: value.attempt.id },
      include: { invalidation: true, vendorIdentity: true },
    })).resolves.toMatchObject({
      companyId: value.company.id,
      transactionId: value.transaction.id,
      action: {
        categoryQboId: value.categoryQboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [],
        memo: null,
      },
      originIntent: 'apply_once',
      rationale: 'Approved from synthetic supporting evidence.',
      jurisdiction: 'CA-BC',
      currency: 'CAD',
      invalidation: null,
      vendorIdentity: {
        displayName: 'Synthetic Supply House',
        normalizedName: 'synthetic supply house',
      },
    });
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: {
        companyId: value.company.id,
        transactionId: value.transaction.id,
        active: true,
      },
    })).resolves.toBe(1);
    await expect(db.autopilotRuleCandidateFold.count({
      where: { requestId: value.attempt.requestId },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: NOW });
    expect(JSON.stringify(await db.classificationCase.findFirstOrThrow({
      where: { companyId: value.company.id },
    }))).not.toContain('must-not-leak');
  });

  it('folds a bound no-decision VERIFIED attempt without inventing a case', async () => {
    const value = await fixture();
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    delete payload.classificationDecision;
    const prepared = payload as unknown as ReturnType<typeof preparePurchaseRecategorization>;
    const evidenceBinding = payload.classificationEvidenceBinding as ReturnType<
      typeof classificationEvidenceBindingForPreparedWrite
    >;
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: {
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          hashClassificationPreparedWrite(prepared),
          null,
          evidenceBinding,
        ),
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    await recordVerifiedClassificationOutcome({
      ...value.outcome,
      decisionContext: undefined,
    }, { db, now: () => NOW });

    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { requestId: value.attempt.requestId, polarity: 'positive' },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
  });

  it('terminalizes rehashed no-decision proposal tampering during modern reconciliation', async () => {
    const value = await fixture();
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    const tamperedProposal = {
      ...value.outcome.proposal!,
      lines: [{
        ...value.outcome.proposal!.lines[0]!,
        categoryQboId: `unverified-rebuild-${randomUUID()}`,
      }],
    };
    delete payload.classificationDecision;
    payload.categorizationEvidence = { version: 1, proposal: tamperedProposal };
    const prepared = payload as unknown as ReturnType<typeof preparePurchaseRecategorization>;
    const tamperedBinding = classificationEvidenceBindingForPreparedWrite(
      tamperedProposal,
      value.outcome.candidateContext,
      hashClassificationPreparedWrite(prepared),
    );
    payload.classificationEvidenceBinding = tamperedBinding;
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: {
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          hashClassificationPreparedWrite(prepared),
          null,
          tamperedBinding,
        ),
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    await expect(reconcileVerifiedClassificationOutcomes(
      value.company.id,
      { db, now: () => NOW },
    )).resolves.toBe(0);

    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateFold.count({
      where: { requestId: value.attempt.requestId },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
  });

  it('rejects a self-consistent rehashed proposal that mismatches the prepared action', async () => {
    const value = await fixture();
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    const tamperedProposal = {
      ...value.outcome.proposal!,
      lines: [{
        ...value.outcome.proposal!.lines[0]!,
        categoryQboId: `unverified-${randomUUID()}`,
      }],
    };
    payload.categorizationEvidence = {
      version: 1,
      proposal: tamperedProposal,
    };
    const prepared = payload as unknown as ReturnType<typeof preparePurchaseRecategorization>;
    const tamperedBinding = classificationEvidenceBindingForPreparedWrite(
      tamperedProposal,
      value.outcome.candidateContext,
      hashClassificationPreparedWrite(prepared),
    );
    payload.classificationEvidenceBinding = tamperedBinding;
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: {
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          hashClassificationPreparedWrite(prepared),
          payload.classificationDecision as ReturnType<typeof classificationDecisionForPreparedWrite>,
          tamperedBinding,
        ),
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    await recordVerifiedClassificationOutcome({
      ...value.outcome,
      proposal: tamperedProposal,
    }, { db, now: () => NOW });

    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateFold.count({
      where: { requestId: value.attempt.requestId },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: NOW });
  });

  it('rejects a rehashed evidence binding when the durable envelope anchor is unchanged', async () => {
    const value = await fixture();
    const tamperedContext = candidateContextFor(
      value.transaction.payee,
      `unverified-config-${randomUUID()}`,
      'mcp',
    );
    if (tamperedContext === null) throw new Error('Tampered fixture context is invalid.');
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    payload.ruleCandidateEvidence = {
      version: 1,
      ...tamperedContext,
    };
    const prepared = payload as unknown as ReturnType<typeof preparePurchaseRecategorization>;
    const tamperedBinding = classificationEvidenceBindingForPreparedWrite(
      value.outcome.proposal!,
      tamperedContext,
      hashClassificationPreparedWrite(prepared),
    );
    payload.classificationEvidenceBinding = tamperedBinding;
    expect(value.attempt.classificationEnvelopeHash).not.toBe(
      classificationEnvelopeHashForPreparedWrite(
        hashClassificationPreparedWrite(prepared),
        payload.classificationDecision as ReturnType<typeof classificationDecisionForPreparedWrite>,
        tamperedBinding,
      ),
    );
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: { requestPayload: payload as Prisma.InputJsonValue },
    });

    await recordVerifiedClassificationOutcome({
      ...value.outcome,
      candidateContext: tamperedContext,
    }, { db, now: () => NOW });

    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateFold.count({
      where: { requestId: value.attempt.requestId },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: NOW });
  });

  it('keeps a bound no-decision attempt out of the unvalidated legacy rebuild path', async () => {
    const value = await fixture();
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    const tamperedProposal = {
      ...value.outcome.proposal!,
      lines: [{
        ...value.outcome.proposal!.lines[0]!,
        categoryQboId: `unverified-rebuild-${randomUUID()}`,
      }],
    };
    const prepared = payload as unknown as ReturnType<typeof preparePurchaseRecategorization>;
    const tamperedBinding = classificationEvidenceBindingForPreparedWrite(
      tamperedProposal,
      value.outcome.candidateContext,
      hashClassificationPreparedWrite(prepared),
    );
    delete payload.classificationDecision;
    payload.ruleCandidateFold = { version: 1 };
    payload.classificationEvidenceBinding = tamperedBinding;
    payload.categorizationEvidence = { version: 1, proposal: tamperedProposal };
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: {
        classificationEnvelopeVersion: null,
        classificationEnvelopeHash: null,
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    await expect(rebuildRuleCandidates(
      value.company.id,
      { db, now: () => NOW },
    )).resolves.toBeUndefined();

    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: null });
  });

  it('leaves a valid pre-fix VERIFIED decision attempt for candidate-only legacy repair', async () => {
    const value = await fixture();
    const payload = structuredClone(
      value.attempt.requestPayload,
    ) as unknown as Record<string, unknown>;
    payload.ruleCandidateFold = { version: 1 };
    delete payload.classificationEvidenceBinding;
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: {
        classificationEnvelopeVersion: null,
        classificationEnvelopeHash: null,
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    await expect(reconcileVerifiedClassificationOutcomes(
      value.company.id,
      { db, now: () => NOW },
    )).resolves.toBe(0);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: null });

    await rebuildRuleCandidates(value.company.id, { db, now: () => NOW });
    await rebuildRuleCandidates(value.company.id, { db, now: () => NOW });

    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { requestId: value.attempt.requestId, polarity: 'positive' },
    })).resolves.toBe(1);
    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
  });

  it('returns the same non-disclosing result for foreign-company and unknown request identities', async () => {
    const owned = await fixture();
    const foreign = await fixture();

    const foreignResult = await recordVerifiedClassificationOutcome({
      ...owned.outcome,
      companyId: foreign.company.id,
    }, { db, now: () => NOW });
    const unknownResult = await recordVerifiedClassificationOutcome({
      ...owned.outcome,
      companyId: foreign.company.id,
      requestId: `unknown-${randomUUID()}`,
    }, { db, now: () => NOW });

    expect(foreignResult).toBe(false);
    expect(unknownResult).toBe(false);
    await expect(db.classificationCase.count({
      where: { companyId: { in: [owned.company.id, foreign.company.id] } },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: { in: [owned.company.id, foreign.company.id] } },
    })).resolves.toBe(0);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: owned.attempt.id },
      select: { ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ ruleCandidateFoldedAt: null });
  });

  it('keeps non-VERIFIED and mismatched outcomes out of all positive evidence', async () => {
    const negatives = await Promise.all([
      'PREPARED',
      'COMMITTING',
      'RETRYABLE',
      'FAILED',
      'DRY_RUN',
      'UNCHANGED',
      'UNCERTAIN',
    ].map((status) => fixture({ status })));
    const callbackMismatch = await fixture();
    const readbackMismatch = await fixture();
    await db.qboMutationAttempt.update({
      where: { id: readbackMismatch.attempt.id },
      data: {
        responseSnapshot: {
          ...(readbackMismatch.attempt.responseSnapshot as unknown as Record<string, unknown>),
          totalCents: -999,
        },
      },
    });
    const stale = await fixture();
    await db.transaction.update({
      where: { id: stale.transaction.id },
      data: { revision: 2 },
    });

    for (const negative of negatives) {
      await recordVerifiedClassificationOutcome(negative.outcome, { db, now: () => NOW });
    }
    await recordVerifiedClassificationOutcome({
      ...callbackMismatch.outcome,
      inputRevision: callbackMismatch.outcome.inputRevision + 1,
    }, { db, now: () => NOW });
    await recordVerifiedClassificationOutcome(readbackMismatch.outcome, { db, now: () => NOW });
    await recordVerifiedClassificationOutcome(stale.outcome, { db, now: () => NOW });

    await expect(db.classificationCase.count({
      where: {
        companyId: {
          in: [
            ...negatives.map((negative) => negative.company.id),
            callbackMismatch.company.id,
            readbackMismatch.company.id,
            stale.company.id,
          ],
        },
      },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: { in: [...companyIds] } },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateFold.findMany({
      where: { companyId: { in: [...companyIds] } },
      select: { requestId: true },
      orderBy: { requestId: 'asc' },
    })).resolves.toEqual([
      { requestId: readbackMismatch.attempt.requestId },
      { requestId: stale.attempt.requestId },
    ].sort((left, right) => left.requestId.localeCompare(right.requestId)));
  });

  it('reconciles an interrupted VERIFIED fold idempotently and concurrently', async () => {
    const value = await fixture();
    const second = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      const counts = await Promise.all([
        reconcileVerifiedClassificationOutcomes(value.company.id, { db, now: () => NOW }),
        reconcileVerifiedClassificationOutcomes(value.company.id, { db: second, now: () => NOW }),
      ]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
      await expect(db.classificationCase.count({
        where: { qboMutationAttemptId: value.attempt.id },
      })).resolves.toBe(1);
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { requestId: value.attempt.requestId },
      })).resolves.toBe(1);
      await expect(db.autopilotRuleCandidateFold.count({
        where: { requestId: value.attempt.requestId },
      })).resolves.toBe(1);
    } finally {
      await second.$disconnect();
    }
  });

  it('recovers through the root client after a completed competing fold aborts its caller-owned transaction', async () => {
    const value = await fixture();
    const second = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    let releaseCompeting!: () => void;
    let signalCompetingReady!: () => void;
    const competingCanCommit = new Promise<void>((resolve) => {
      releaseCompeting = resolve;
    });
    const competingReady = new Promise<void>((resolve) => {
      signalCompetingReady = resolve;
    });
    const decision = value.outcome.decisionContext!;
    const proposal = value.outcome.proposal!;
    const line = proposal.lines[0]!;
    const competing = second.$transaction(async (tx) => {
      await recordVerifiedClassificationCase({
        companyId: value.company.id,
        transactionId: value.transaction.id,
        qboMutationAttemptId: value.attempt.id,
        vendorIdentityId: null,
        action: {
          categoryQboId: line.categoryQboId,
          taxCalculation: proposal.taxCalculation,
          taxCodeQboId: line.taxCodeQboId,
          tagIds: [...new Set([...proposal.tagIds, ...line.tagIds])].sort(),
          memo: line.memo,
        },
        originIntent: decision.originIntent,
        rationale: decision.rationale,
        requiredEvidence: decision.requiredEvidence,
        examples: decision.examples,
        counterexamples: decision.counterexamples,
        citations: decision.citations,
        reviewer: decision.reviewer,
        jurisdiction: decision.jurisdiction,
        currency: decision.currency,
        context: decision.context,
        provenance: {
          source: 'qbo_verified',
          sourceId: value.attempt.id,
          actorId: decision.reviewer.userId,
          recordedAt: value.attempt.updatedAt.toISOString(),
        },
      }, tx);
      await foldVerifiedRuleCandidateOutcomeInTransaction(
        tx,
        value.outcome,
        NOW,
        { markAffectedRules: false, attemptFormat: 'bound' },
      );
      signalCompetingReady();
      await competingCanCommit;
    });
    await competingReady;

    const raced = recordVerifiedClassificationOutcome(
      value.outcome,
      { db, now: () => NOW },
    );
    let blockedOnUniqueOwner = false;
    try {
      for (let poll = 0; poll < 100; poll += 1) {
        const [state] = await db.$queryRaw<{ blocked: boolean }[]>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%ClassificationCase%'
          ) AS blocked
        `);
        if (state?.blocked === true) {
          blockedOnUniqueOwner = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseCompeting();
    }
    await competing;
    expect(blockedOnUniqueOwner).toBe(true);
    await expect(raced).resolves.toBe(false);
    await expect(db.classificationCase.count({
      where: { qboMutationAttemptId: value.attempt.id },
    })).resolves.toBe(1);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { requestId: value.attempt.requestId, polarity: 'positive' },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
    await second.$disconnect();
  });

  it('makes bounded reconciliation progress past more than 25 permanently ineligible attempts', async () => {
    const repairable = await fixture();
    const oldCreatedAt = new Date('2026-08-29T00:00:00.000Z');
    const staleRequestIds = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
      const requestId = `stale-${index}-${randomUUID()}`;
      await db.qboMutationAttempt.create({
        data: {
          transactionId: repairable.transaction.id,
          requestId,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: 1,
          expectedSyncToken: '0',
          requestHash: `corrupt-${requestId}`,
          classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
          classificationEnvelopeHash: '0'.repeat(64),
          requestPayload: {
            ruleCandidateFold: {
              version: index === 0 ? 1 : CLASSIFICATION_ENVELOPE_VERSION,
            },
          },
          beforeSnapshot: {},
          responseSnapshot: {},
          verification: { outcome: 'VERIFIED', status: 'POSTED', newSyncToken: '1' },
          createdAt: new Date(oldCreatedAt.getTime() + index),
        },
      });
      return requestId;
    }));

    await reconcileVerifiedClassificationOutcomes(
      repairable.company.id,
      { db, now: () => NOW },
    );
    await reconcileVerifiedClassificationOutcomes(
      repairable.company.id,
      { db, now: () => NOW },
    );

    await expect(db.classificationCase.count({
      where: { qboMutationAttemptId: repairable.attempt.id },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.count({
      where: {
        requestId: { in: staleRequestIds },
        ruleCandidateFoldedAt: { not: null },
      },
    })).resolves.toBe(26);
  });

  it('repairs a verified attempt marker when its exact fold receipt already exists', async () => {
    const value = await fixture();
    await db.autopilotRuleCandidateFold.create({
      data: {
        requestId: value.attempt.requestId,
        companyId: value.company.id,
        transactionId: value.transaction.id,
        operation: 'posted',
        processedAt: NOW,
      },
    });

    await reconcileVerifiedClassificationOutcomes(
      value.company.id,
      { db, now: () => NOW },
    );

    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: value.attempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: NOW });
  });

  it('rolls back case, vendor, candidate, and request fold together before reconciliation retries', async () => {
    const value = await fixture();
    const constraint = `outcome_fold_${randomUUID().replaceAll('-', '')}`;
    await db.$executeRawUnsafe(
      `ALTER TABLE "QboMutationAttempt" ADD CONSTRAINT "${constraint}" CHECK ("requestId" <> '${value.attempt.requestId}' OR "ruleCandidateFoldedAt" IS NULL)`,
    );
    try {
      await expect(recordVerifiedClassificationOutcome(
        value.outcome,
        { db, now: () => NOW },
      )).rejects.toThrow();
      await expect(db.classificationCase.count({
        where: { companyId: value.company.id },
      })).resolves.toBe(0);
      await expect(db.vendorIdentity.count({
        where: { companyId: value.company.id },
      })).resolves.toBe(0);
      await expect(db.autopilotRuleCandidateEvidence.count({
        where: { companyId: value.company.id },
      })).resolves.toBe(0);
      await expect(db.autopilotRuleCandidateFold.count({
        where: { companyId: value.company.id },
      })).resolves.toBe(0);
      await expect(db.qboMutationAttempt.findUniqueOrThrow({
        where: { id: value.attempt.id },
        select: { status: true, ruleCandidateFoldedAt: true },
      })).resolves.toEqual({ status: 'VERIFIED', ruleCandidateFoldedAt: null });
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "QboMutationAttempt" DROP CONSTRAINT "${constraint}"`,
      );
    }

    await expect(reconcileVerifiedClassificationOutcomes(
      value.company.id,
      { db, now: () => NOW },
    )).resolves.toBe(1);
    await expect(db.classificationCase.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(1);
  });

  it('keeps taxed cases searchable but outside the executable rule-candidate threshold', async () => {
    const value = await fixture({ taxCalculation: 'TaxInclusive' });

    await recordVerifiedClassificationOutcome(value.outcome, { db, now: () => NOW });

    await expect(db.classificationCase.findUniqueOrThrow({
      where: { qboMutationAttemptId: value.attempt.id },
    })).resolves.toMatchObject({
      action: {
        categoryQboId: value.categoryQboId,
        taxCalculation: 'TaxInclusive',
      },
    });
    await expect(db.autopilotRuleCandidate.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
    await expect(db.autopilotRuleCandidateEvidence.count({
      where: { companyId: value.company.id },
    })).resolves.toBe(0);
  });

  it('appends correction and undo history, invalidates prior evidence, and marks affected rules for review', async () => {
    const first = await fixture();
    await recordVerifiedClassificationOutcome(first.outcome, { db, now: () => NOW });
    const firstCase = await db.classificationCase.findUniqueOrThrow({
      where: { qboMutationAttemptId: first.attempt.id },
    });
    const candidate = await db.autopilotRuleCandidate.findFirstOrThrow({
      where: { companyId: first.company.id },
    });
    const rule = await db.rule.create({
      data: {
        companyId: first.company.id,
        matchText: 'synthetic supply house',
        category: 'Synthetic first category',
        categoryQboId: first.categoryQboId,
        autoPost: true,
        originIntent: 'apply_once',
        sourceCaseId: firstCase.id,
        sourceCandidateId: candidate.id,
      },
    });

    const firstPayload = first.attempt.requestPayload as unknown as Record<string, unknown>;
    const firstPrepared = firstPayload as unknown as {
      body: RawPurchase;
      before: QboPurchaseSnapshot;
      expected: {
        qboId: string;
        totalCents: number;
        accountQboId: string;
        date: string;
        direction: 'purchase' | 'refund';
        globalTaxCalculation: string | null;
        totalTaxCents: number | null;
        targetLines: QboPurchaseSnapshot['lines'];
        untouchedLineHashes: string[];
      };
    };
    const firstResponse = first.attempt.responseSnapshot as unknown as QboPurchaseSnapshot;
    const correctedCategory = `corrected-${randomUUID()}`;
    const correctionRequestId = `correction-${randomUUID()}`;
    const correctedLine = {
      ...firstPrepared.expected.targetLines[0]!,
      id: null,
      accountQboId: correctedCategory,
    };
    const correctionBody: RawPurchase = {
      ...firstPrepared.body,
      SyncToken: '1',
      Line: [{
        ...firstPrepared.body.Line![0]!,
        AccountBasedExpenseLineDetail: {
          ...firstPrepared.body.Line![0]!.AccountBasedExpenseLineDetail,
          AccountRef: { value: correctedCategory },
        },
      }],
    };
    const correctionPrepared = {
      operation: 'recategorize' as const,
      qboType: 'Purchase' as const,
      qboId: first.transaction.qboId,
      requestId: correctionRequestId,
      requestHash: hashPreparedWriteBody(correctionBody),
      body: correctionBody,
      before: firstResponse,
      expected: {
        ...firstPrepared.expected,
        targetLines: [correctedLine],
      },
    };
    const correctionResponse: QboPurchaseSnapshot = {
      ...firstResponse,
      syncToken: '2',
      lines: [{ ...correctedLine, id: 'line-corrected' }],
    };
    const correctionDecision = normalizeCategorizationDecisionContext({
      ...first.outcome.decisionContext,
      rationale: 'A later approved correction.',
      originIntent: 'make_recurring',
    });
    const correctionProposal = {
      ...first.outcome.proposal!,
      lines: [{
        ...first.outcome.proposal!.lines[0]!,
        categoryQboId: correctedCategory,
      }],
    };
    const correctionPreparedHash = hashClassificationPreparedWrite(correctionPrepared);
    const correctionDecisionEnvelope = classificationDecisionForPreparedWrite(
      correctionDecision,
      correctionPreparedHash,
    );
    const correctionEvidenceBinding = classificationEvidenceBindingForPreparedWrite(
      correctionProposal,
      first.outcome.candidateContext,
      correctionPreparedHash,
    );
    await db.transaction.update({
      where: { id: first.transaction.id },
      data: { revision: 2, qboSyncToken: '2', status: 'POSTED' },
    });
    const correctionAttempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: first.transaction.id,
        requestId: correctionRequestId,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 2,
        expectedSyncToken: '1',
        requestHash: correctionPrepared.requestHash,
        classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          correctionPreparedHash,
          correctionDecisionEnvelope,
          correctionEvidenceBinding,
        ),
        requestPayload: {
          ...correctionPrepared,
          classificationDecision: correctionDecisionEnvelope,
          ruleCandidateFold: { version: CLASSIFICATION_ENVELOPE_VERSION },
          classificationEvidenceBinding: correctionEvidenceBinding,
          categorizationEvidence: { version: 1, proposal: correctionProposal },
          ruleCandidateEvidence: { version: 1, ...first.outcome.candidateContext! },
        } as unknown as Prisma.InputJsonValue,
        beforeSnapshot: firstResponse as unknown as Prisma.InputJsonValue,
        responseSnapshot: correctionResponse as unknown as Prisma.InputJsonValue,
        verification: { outcome: 'VERIFIED', status: 'POSTED', newSyncToken: '2' },
      },
    });
    await recordVerifiedClassificationOutcome({
      ...first.outcome,
      inputRevision: 2,
      requestId: correctionRequestId,
      proposal: correctionProposal,
      decisionContext: correctionDecision,
    }, { db, now: () => new Date(NOW.getTime() + 60_000) });

    const correctedCase = await db.classificationCase.findUniqueOrThrow({
      where: { qboMutationAttemptId: correctionAttempt.id },
    });
    await expect(db.classificationCase.findUniqueOrThrow({
      where: { id: firstCase.id },
      include: { invalidation: true },
    })).resolves.toMatchObject({
      id: firstCase.id,
      invalidation: { reason: 'Corrected by a later verified QBO outcome.' },
    });
    await expect(db.autopilotRuleCandidateEvidence.findFirstOrThrow({
      where: { requestId: first.attempt.requestId },
    })).resolves.toMatchObject({ active: false, invalidationReason: 'corrected' });
    await expect(db.rule.findUniqueOrThrow({ where: { id: rule.id } })).resolves.toMatchObject({
      sourceCaseId: firstCase.id,
      sourceCandidateId: candidate.id,
      enabled: false,
      autoPost: false,
      revision: 1,
      reviewRequiredAt: new Date(NOW.getTime() + 60_000),
    });

    const undoRequestId = `undo-${randomUUID()}`;
    const originalBefore = first.attempt.beforeSnapshot as unknown as QboPurchaseSnapshot;
    const undoBody: RawPurchase = {
      ...firstPrepared.body,
      SyncToken: '2',
      GlobalTaxCalculation: originalBefore.globalTaxCalculation ?? undefined,
      Line: [{
        Id: 'line-holding-restored',
        Amount: 10.5,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'holding-synthetic' },
        },
      }],
    };
    const undoPrepared = {
      operation: 'restore' as const,
      qboType: 'Purchase' as const,
      qboId: first.transaction.qboId,
      requestId: undoRequestId,
      requestHash: hashPreparedWriteBody(undoBody),
      body: undoBody,
      before: correctionResponse,
      expected: {
        qboId: originalBefore.qboId,
        totalCents: originalBefore.totalCents,
        accountQboId: originalBefore.accountQboId,
        date: originalBefore.date,
        direction: originalBefore.direction,
        globalTaxCalculation: originalBefore.globalTaxCalculation,
        totalTaxCents: originalBefore.totalTaxCents,
        targetLines: originalBefore.lines,
        untouchedLineHashes: [],
      },
    };
    const undoResponse: QboPurchaseSnapshot = { ...originalBefore, syncToken: '3' };
    const undoPreparedHash = hashClassificationPreparedWrite(undoPrepared);
    await db.transaction.update({
      where: { id: first.transaction.id },
      data: { revision: 3, qboSyncToken: '3', status: 'PENDING' },
    });
    const undoAttempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: first.transaction.id,
        requestId: undoRequestId,
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 3,
        expectedSyncToken: '2',
        requestHash: undoPrepared.requestHash,
        classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
        classificationEnvelopeHash: classificationEnvelopeHashForPreparedWrite(
          undoPreparedHash,
          null,
          null,
        ),
        requestPayload: {
          ...undoPrepared,
          ruleCandidateFold: { version: CLASSIFICATION_ENVELOPE_VERSION },
        } as unknown as Prisma.InputJsonValue,
        beforeSnapshot: correctionResponse as unknown as Prisma.InputJsonValue,
        responseSnapshot: undoResponse as unknown as Prisma.InputJsonValue,
        verification: { outcome: 'VERIFIED', status: 'REVERTED', newSyncToken: '3' },
      },
    });
    await recordVerifiedClassificationOutcome({
      companyId: first.company.id,
      transactionId: first.transaction.id,
      inputRevision: 3,
      requestId: undoRequestId,
      operation: 'reverted',
      proposal: null,
      candidateContext: null,
    }, { db, now: () => new Date(NOW.getTime() + 120_000) });

    await expect(db.classificationCase.findUniqueOrThrow({
      where: { id: correctedCase.id },
      include: { invalidation: true },
    })).resolves.toMatchObject({
      invalidation: { reason: 'Undone by a later verified QBO outcome.' },
    });
    await expect(db.classificationCase.count({
      where: { companyId: first.company.id },
    })).resolves.toBe(2);
    await expect(db.autopilotRuleCandidateEvidence.findFirstOrThrow({
      where: { companyId: first.company.id, active: true },
    })).resolves.toMatchObject({
      requestId: undoAttempt.requestId,
      candidateId: candidate.id,
      polarity: 'negative',
    });
    await expect(db.autopilotRuleCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    })).resolves.toMatchObject({
      state: 'conflict',
      evidenceCount: 0,
      conflictingEvidenceCount: 1,
    });
    await expect(db.autopilotRuleCandidateFold.count({
      where: { companyId: first.company.id },
    })).resolves.toBe(3);
    await expect(db.rule.findUniqueOrThrow({ where: { id: rule.id } })).resolves.toMatchObject({
      sourceCaseId: firstCase.id,
      sourceCandidateId: candidate.id,
      enabled: false,
      autoPost: false,
      revision: 2,
      reviewRequiredAt: new Date(NOW.getTime() + 120_000),
      reviewReason: 'The verified classification supporting this rule was undone.',
    });
    await expect(db.ruleRevision.count({
      where: { companyId: first.company.id, ruleId: rule.id },
    })).resolves.toBe(3);
    await expect(db.qboMutationAttempt.findUniqueOrThrow({
      where: { id: undoAttempt.id },
      select: { status: true, ruleCandidateFoldedAt: true },
    })).resolves.toEqual({
      status: 'VERIFIED',
      ruleCandidateFoldedAt: new Date(NOW.getTime() + 120_000),
    });
  });
});
