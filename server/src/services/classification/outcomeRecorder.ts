import { Prisma, type PrismaClient } from '@prisma/client';
import type { ClassificationAction } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import type { QboPreparedWrite } from '../../lib/qbo/types.js';
import {
  CLASSIFICATION_ENVELOPE_VERSION,
  classificationEnvelopeHashForPreparedWrite,
  persistedClassificationDecision,
  persistedClassificationEvidenceBinding,
  persistedEvidenceProposal,
  persistedRuleCandidateContext,
  type NormalizedCategorizationDecisionContext,
} from '../categorizationEvidence.js';
import { runCompanyMutationTransaction } from '../companyMutationScope.js';
import { disableRuleForSafetyInTransaction } from '../ruleSafetyTransition.js';
import type { VerifiedCategorizationOutcome } from '../agent/evaluation.js';
import { foldVerifiedRuleCandidateOutcomeInTransaction } from '../agent/ruleCandidatePersistence.js';
import { candidateContextFor } from '../agent/ruleCandidates.js';
import {
  hashClassificationPreparedWrite,
  validateDurableAttemptPersistence,
} from '../writeback.js';
import {
  recordVerifiedClassificationCase,
  type ClassificationCaseDb,
} from './cases.js';
import { ensureVendorIdentity, type VendorIdentityDb } from './vendorIdentity.js';

type OutcomeTransaction = Prisma.TransactionClient;

export interface ClassificationOutcomeRecorderDeps {
  /** A root client is required so PostgreSQL conflict recovery never reuses a failed TransactionClient. */
  db: PrismaClient;
  now?: () => Date;
}

const defaultDeps: ClassificationOutcomeRecorderDeps = { db: prisma };
const REPAIR_BATCH_SIZE = 25;
const ACTIVATION_REPAIR_LIMIT = 100;
const RULE_REVIEW_ACTOR = 'system:classification-outcome';

interface ExpectedOutcomeIdentity {
  companyId: string;
  requestId: string;
  transactionId?: string;
  inputRevision?: number;
  operation?: 'posted' | 'reverted';
  proposal?: VerifiedCategorizationOutcome['proposal'];
  candidateContext?: VerifiedCategorizationOutcome['candidateContext'];
  decisionContext?: NormalizedCategorizationDecisionContext;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function caseAction(
  proposal: NonNullable<VerifiedCategorizationOutcome['proposal']>,
): ClassificationAction | null {
  const line = proposal.lines[0];
  if (proposal.lines.length !== 1 || line === undefined) return null;
  return {
    categoryQboId: line.categoryQboId,
    taxCalculation: proposal.taxCalculation,
    taxCodeQboId: proposal.taxCalculation === 'NotApplicable'
      ? null
      : line.taxCodeQboId,
    tagIds: [...new Set([...proposal.tagIds, ...line.tagIds])].sort(),
    memo: line.memo,
  };
}

function proposalMatchesPrepared(
  proposal: NonNullable<VerifiedCategorizationOutcome['proposal']>,
  prepared: QboPreparedWrite,
): boolean {
  const expectedTaxCalculation = prepared.expected.globalTaxCalculation ?? 'NotApplicable';
  if (
    proposal.taxCalculation !== expectedTaxCalculation
    || proposal.lines.length !== prepared.expected.targetLines.length
  ) return false;
  return proposal.lines.every((line, index) => {
    const target = prepared.expected.targetLines[index];
    if (
      target === undefined
      || line.idx !== index
      || line.subtotalCents !== target.amountCents
      || line.categoryQboId !== target.accountQboId
      || line.taxCodeQboId !== target.taxCodeQboId
      || line.memo !== target.description
    ) return false;
    if (prepared.qboType === 'Purchase') {
      const purchaseTarget = prepared.expected.targetLines[index];
      if (purchaseTarget === undefined) return false;
      return (
        line.taxCents === (purchaseTarget.taxAmountCents ?? 0)
        && line.totalCents === (
          proposal.taxCalculation === 'TaxInclusive'
            ? purchaseTarget.taxInclusiveCents
            : line.subtotalCents + line.taxCents
        )
      );
    }
    return line.totalCents === line.subtotalCents + line.taxCents;
  });
}

async function markAffectedRulesReviewRequired(
  tx: OutcomeTransaction,
  companyId: string,
  caseIds: readonly string[],
  candidateIds: readonly string[],
  operation: 'posted' | 'reverted',
  now: Date,
): Promise<void> {
  if (caseIds.length === 0 && candidateIds.length === 0) return;
  const rules = await tx.rule.findMany({
    where: {
      companyId,
      retiredAt: null,
      OR: [
        ...(caseIds.length === 0 ? [] : [{ sourceCaseId: { in: [...caseIds] } }]),
        ...(candidateIds.length === 0 ? [] : [{ sourceCandidateId: { in: [...candidateIds] } }]),
      ],
    },
    include: { ruleTags: true },
  });
  for (const rule of rules) {
    const reason = operation === 'reverted'
      ? 'The verified classification supporting this rule was undone.'
      : 'A later verified classification corrected evidence supporting this rule.';
    await disableRuleForSafetyInTransaction(tx, {
      companyId,
      ruleId: rule.id,
      expectedRevision: rule.revision,
      reason,
      actor: RULE_REVIEW_ACTOR,
      occurredAt: now,
    });
  }
}

async function completedReceiptExists(
  db: PrismaClient,
  identity: ExpectedOutcomeIdentity,
): Promise<boolean> {
  const attempt = await db.qboMutationAttempt.findFirst({
    where: {
      requestId: identity.requestId,
      transaction: { companyId: identity.companyId },
    },
    select: {
      transactionId: true,
      operation: true,
      status: true,
      expectedRevision: true,
      classificationEnvelopeVersion: true,
      ruleCandidateFoldedAt: true,
    },
  });
  if (
    attempt === null
    || attempt.status !== 'VERIFIED'
    || attempt.classificationEnvelopeVersion !== CLASSIFICATION_ENVELOPE_VERSION
    || attempt.ruleCandidateFoldedAt === null
    || (attempt.operation !== 'recategorize' && attempt.operation !== 'restore')
    || (identity.transactionId !== undefined && identity.transactionId !== attempt.transactionId)
    || (identity.inputRevision !== undefined && identity.inputRevision !== attempt.expectedRevision)
  ) return false;
  const operation = attempt.operation === 'restore' ? 'reverted' : 'posted';
  if (identity.operation !== undefined && identity.operation !== operation) return false;
  const receipt = await db.autopilotRuleCandidateFold.findUnique({
    where: { requestId: identity.requestId },
    select: { companyId: true, transactionId: true, operation: true },
  });
  return receipt !== null
    && receipt.companyId === identity.companyId
    && receipt.transactionId === attempt.transactionId
    && receipt.operation === operation;
}

async function stampAttemptFolded(
  tx: OutcomeTransaction,
  attempt: {
    requestId: string;
    transactionId: string;
    operation: string;
    expectedRevision: number;
  },
  now: Date,
): Promise<number> {
  return tx.$executeRaw(
    Prisma.sql`
      UPDATE "QboMutationAttempt"
      SET "ruleCandidateFoldedAt" = ${now}
      WHERE "requestId" = ${attempt.requestId}
        AND "transactionId" = ${attempt.transactionId}
        AND "operation" = ${attempt.operation}
        AND "status" = 'VERIFIED'
        AND "expectedRevision" = ${attempt.expectedRevision}
        AND "ruleCandidateFoldedAt" IS NULL
        AND "classificationEnvelopeVersion" = ${CLASSIFICATION_ENVELOPE_VERSION}
    `,
  );
}

async function repairExistingFoldMarker(
  tx: OutcomeTransaction,
  attempt: {
    requestId: string;
    transactionId: string;
    operation: string;
    expectedRevision: number;
    ruleCandidateFoldedAt: Date | null;
  },
  companyId: string,
  operation: 'posted' | 'reverted',
  now: Date,
): Promise<boolean | null> {
  const receipt = await tx.autopilotRuleCandidateFold.findUnique({
    where: { requestId: attempt.requestId },
  });
  if (receipt === null) return null;
  if (
    receipt.companyId !== companyId
    || receipt.transactionId !== attempt.transactionId
    || receipt.operation !== operation
  ) return false;
  if (
    attempt.ruleCandidateFoldedAt === null
    && await stampAttemptFolded(tx, attempt, now) !== 1
  ) {
    throw new Error('Existing classification fold receipt could not stamp its VERIFIED attempt.');
  }
  return false;
}

async function recordTerminalFoldDisposition(
  tx: OutcomeTransaction,
  attempt: {
    requestId: string;
    transactionId: string;
    operation: string;
    expectedRevision: number;
  },
  companyId: string,
  operation: 'posted' | 'reverted',
  now: Date,
): Promise<void> {
  await tx.autopilotRuleCandidateFold.create({
    data: {
      requestId: attempt.requestId,
      companyId,
      transactionId: attempt.transactionId,
      operation,
      processedAt: now,
    },
  });
  if (await stampAttemptFolded(tx, attempt, now) !== 1) {
    throw new Error('Terminal classification fold disposition could not stamp its VERIFIED attempt.');
  }
}

async function recordInTransaction(
  tx: OutcomeTransaction,
  expected: ExpectedOutcomeIdentity,
  now: Date,
): Promise<boolean> {
  const attempt = await tx.qboMutationAttempt.findUnique({
    where: { requestId: expected.requestId },
    include: {
      transaction: true,
    },
  });
  if (
    attempt === null
    || attempt.transaction.companyId !== expected.companyId
    || attempt.status !== 'VERIFIED'
    || (attempt.operation !== 'recategorize' && attempt.operation !== 'restore')
  ) return false;

  const operation = attempt.operation === 'restore' ? 'reverted' : 'posted';
  if (
    (expected.transactionId !== undefined && expected.transactionId !== attempt.transactionId)
    || (expected.inputRevision !== undefined && expected.inputRevision !== attempt.expectedRevision)
    || (expected.operation !== undefined && expected.operation !== operation)
  ) return false;

  const payload = runtimeRecord(attempt.requestPayload);
  const foldVersion = runtimeRecord(payload?.ruleCandidateFold)?.version;
  const legacyFormat =
    attempt.classificationEnvelopeVersion === null
    && attempt.classificationEnvelopeHash === null
    && foldVersion === 1
    && payload?.classificationEvidenceBinding === undefined;
  if (legacyFormat) return false;
  const declaredBoundFormat =
    attempt.classificationEnvelopeVersion === CLASSIFICATION_ENVELOPE_VERSION
    && typeof attempt.classificationEnvelopeHash === 'string';
  if (!declaredBoundFormat) return false;
  if (foldVersion !== CLASSIFICATION_ENVELOPE_VERSION) {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }

  const repairedExistingFold = await repairExistingFoldMarker(
    tx,
    attempt,
    expected.companyId,
    operation,
    now,
  );
  if (repairedExistingFold !== null) return repairedExistingFold;

  const durableStatus = operation === 'posted' ? 'POSTED' : 'PENDING';
  const response = runtimeRecord(attempt.responseSnapshot);
  if (
    attempt.transaction.revision !== attempt.expectedRevision
    || attempt.transaction.status !== durableStatus
    || response === null
    || response.syncToken !== attempt.transaction.qboSyncToken
  ) {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }

  let proof: ReturnType<typeof validateDurableAttemptPersistence>;
  let prepared: QboPreparedWrite;
  try {
    proof = validateDurableAttemptPersistence(attempt);
    prepared = attempt.requestPayload as unknown as QboPreparedWrite;
  } catch {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }
  if (
    proof.qboId !== attempt.transaction.qboId
    || proof.qboType !== attempt.transaction.qboType
    || proof.operation !== attempt.operation
  ) {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }

  if (payload === null) return false;
  const proposal = operation === 'posted'
    ? persistedEvidenceProposal(attempt.requestPayload)
    : null;
  const candidateContext = operation === 'posted'
    ? persistedRuleCandidateContext(attempt.requestPayload)
    : null;
  if (operation === 'posted' && proposal === null) {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }

  const hasDecisionEnvelope = payload.classificationDecision !== undefined;
  const decision = persistedClassificationDecision(
    attempt.requestPayload,
    hashClassificationPreparedWrite(prepared),
  );
  const expectedCandidateContext = candidateContext === null
    ? null
    : candidateContextFor(
        attempt.transaction.payee,
        candidateContext.configVersion,
        candidateContext.source,
      );
  const evidenceBinding = operation === 'posted'
    ? persistedClassificationEvidenceBinding(
        attempt.requestPayload,
        proposal!,
        candidateContext,
        hashClassificationPreparedWrite(prepared),
      )
    : null;
  if (
    hasDecisionEnvelope && decision === null
    || operation === 'posted' && !proposalMatchesPrepared(proposal!, prepared)
    || !exactJson(candidateContext, expectedCandidateContext)
    || operation === 'posted' && evidenceBinding === null
    || attempt.classificationEnvelopeHash !== classificationEnvelopeHashForPreparedWrite(
      hashClassificationPreparedWrite(prepared),
      decision,
      evidenceBinding,
    )
  ) {
    await recordTerminalFoldDisposition(tx, attempt, expected.companyId, operation, now);
    return false;
  }
  if (
    (expected.proposal !== undefined && !exactJson(expected.proposal, proposal))
    || (expected.candidateContext !== undefined && !exactJson(expected.candidateContext, candidateContext))
    || (expected.decisionContext !== undefined && !exactJson(expected.decisionContext, decision?.context))
  ) return false;

  const priorCases = await tx.classificationCase.findMany({
    where: {
      companyId: expected.companyId,
      transactionId: attempt.transactionId,
      qboMutationAttemptId: { not: attempt.id },
      invalidation: null,
    },
    select: { id: true },
  });
  const priorCandidateRows = await tx.autopilotRuleCandidateEvidence.findMany({
    where: {
      companyId: expected.companyId,
      transactionId: attempt.transactionId,
      active: true,
    },
    select: { candidateId: true },
  });
  const invalidationReason = operation === 'reverted'
    ? 'Undone by a later verified QBO outcome.'
    : 'Corrected by a later verified QBO outcome.';
  if (priorCases.length > 0) {
    await tx.classificationCaseInvalidation.createMany({
      data: priorCases.map((classificationCase) => ({
        companyId: expected.companyId,
        classificationCaseId: classificationCase.id,
        invalidatedAt: now,
        reason: invalidationReason,
      })),
      skipDuplicates: true,
    });
  }

  if (operation === 'posted' && proposal !== null && decision !== null) {
    const action = caseAction(proposal);
    if (action !== null) {
      const hint = decision.context.vendorIdentityHint;
      const vendorIdentity = hint === null
        ? null
        : await ensureVendorIdentity({
            companyId: expected.companyId,
            displayName: hint.displayName,
            qboVendorId: hint.qboVendorId,
          }, tx as unknown as VendorIdentityDb);
      await recordVerifiedClassificationCase({
        companyId: expected.companyId,
        transactionId: attempt.transactionId,
        qboMutationAttemptId: attempt.id,
        vendorIdentityId: vendorIdentity?.id ?? null,
        action,
        originIntent: decision.context.originIntent,
        rationale: decision.context.rationale,
        requiredEvidence: decision.context.requiredEvidence,
        examples: decision.context.examples,
        counterexamples: decision.context.counterexamples,
        citations: decision.context.citations,
        reviewer: decision.context.reviewer,
        jurisdiction: decision.context.jurisdiction,
        currency: decision.context.currency,
        context: decision.context.context,
        provenance: {
          source: 'qbo_verified',
          sourceId: attempt.id,
          actorId: decision.context.reviewer.userId,
          recordedAt: attempt.updatedAt.toISOString(),
        },
      }, tx as unknown as ClassificationCaseDb);
    }
  }

  const durableOutcome: VerifiedCategorizationOutcome = {
    companyId: expected.companyId,
    transactionId: attempt.transactionId,
    inputRevision: attempt.expectedRevision,
    requestId: attempt.requestId,
    operation,
    proposal,
    candidateContext,
    ...(decision === null ? {} : { decisionContext: decision.context }),
  };
  const folded = await foldVerifiedRuleCandidateOutcomeInTransaction(
    tx,
    durableOutcome,
    now,
    { markAffectedRules: false, attemptFormat: 'bound' },
  );
  if (!folded.processed) return false;
  await markAffectedRulesReviewRequired(
    tx,
    expected.companyId,
    priorCases.map((classificationCase) => classificationCase.id),
    [...new Set([
      ...priorCandidateRows.map((row) => row.candidateId),
      ...folded.affectedCandidateIds,
    ])],
    operation,
    now,
  );
  return true;
}

async function recordExpectedOutcome(
  expected: ExpectedOutcomeIdentity,
  deps: ClassificationOutcomeRecorderDeps,
): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  try {
    return await runCompanyMutationTransaction(
      deps.db,
      expected.companyId,
      (tx) => recordInTransaction(tx, expected, now),
    );
  } catch (error) {
    // A unique violation aborts PostgreSQL's caller-owned transaction. Recover
    // only with the root client after rollback; never query through `tx`.
    if (isUniqueViolation(error) && await completedReceiptExists(deps.db, expected)) {
      return false;
    }
    throw error;
  }
}

/** Records one exact callback emitted after independent QBO readback. */
export function recordVerifiedClassificationOutcome(
  outcome: VerifiedCategorizationOutcome,
  deps: ClassificationOutcomeRecorderDeps = defaultDeps,
): Promise<boolean> {
  return recordExpectedOutcome(outcome, deps);
}

/**
 * Folds bound VERIFIED attempts relevant to one candidate before activation.
 * The caller already owns the company mutation transaction, so this path must
 * use the same transaction and the full modern recorder validation rather than
 * opening a nested fence or falling back to legacy candidate-only repair.
 */
export async function reconcileBoundClassificationOutcomesBeforeActivation(
  tx: OutcomeTransaction,
  candidate: {
    id: string;
    companyId: string;
    conditionFingerprint: string;
    configVersion: string;
  },
  now = new Date(),
): Promise<{ saturated: boolean }> {
  const rows = await tx.$queryRaw<{ requestId: string }[]>(
    Prisma.sql`
      SELECT attempt."requestId"
      FROM "QboMutationAttempt" attempt
      JOIN "Transaction" transaction ON transaction."id" = attempt."transactionId"
      WHERE transaction."companyId" = ${candidate.companyId}
        AND attempt."status" = 'VERIFIED'
        AND attempt."operation" IN ('recategorize', 'restore')
        AND attempt."ruleCandidateFoldedAt" IS NULL
        AND attempt."classificationEnvelopeVersion" = ${CLASSIFICATION_ENVELOPE_VERSION}
        AND (
          (
            attempt."operation" = 'recategorize'
            AND attempt."requestPayload"->'ruleCandidateEvidence'->>'conditionFingerprint'
              = ${candidate.conditionFingerprint}
            AND attempt."requestPayload"->'ruleCandidateEvidence'->>'configVersion'
              = ${candidate.configVersion}
          )
          OR EXISTS (
            -- A correction can use a new config while invalidating evidence
            -- that still supports the candidate being activated.
            SELECT 1
            FROM "AutopilotRuleCandidateEvidence" evidence
            WHERE evidence."candidateId" = ${candidate.id}
              AND evidence."transactionId" = attempt."transactionId"
              AND evidence."active" = true
          )
        )
      ORDER BY attempt."createdAt" DESC, attempt."id" DESC
      LIMIT ${ACTIVATION_REPAIR_LIMIT + 1}
    `,
  );
  if (rows.length > ACTIVATION_REPAIR_LIMIT) return { saturated: true };
  for (const row of rows) {
    await recordInTransaction(
      tx,
      { companyId: candidate.companyId, requestId: row.requestId },
      now,
    );
  }
  return { saturated: false };
}

/**
 * Bounded local-only repair for VERIFIED attempts whose durable fold marker is
 * still absent. It is safe to race across workers because every fold is
 * company-fenced and request-key idempotent.
 */
export async function reconcileVerifiedClassificationOutcomes(
  companyId: string,
  deps: ClassificationOutcomeRecorderDeps = defaultDeps,
): Promise<number> {
  const rows = await deps.db.qboMutationAttempt.findMany({
    where: {
      status: 'VERIFIED',
      operation: { in: ['recategorize', 'restore'] },
      ruleCandidateFoldedAt: null,
      transaction: { companyId },
      classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
    },
    select: { requestId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REPAIR_BATCH_SIZE,
  });
  let recorded = 0;
  for (const row of rows) {
    if (await recordExpectedOutcome({ companyId, requestId: row.requestId }, deps)) {
      recorded += 1;
    }
  }
  return recorded;
}
