import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  persistedEvidenceProposal,
  persistedRuleCandidateContext,
} from '../categorizationEvidence.js';
import { runCompanyMutationTransaction } from '../companyMutationScope.js';
import { disableRuleForSafetyInTransaction } from '../ruleSafetyTransition.js';
import type { VerifiedCategorizationOutcome } from './evaluation.js';
import {
  candidatePatternFor,
  parseStoredCandidatePattern,
  RULE_CANDIDATE_EVIDENCE_THRESHOLD,
  RULE_CANDIDATE_SCHEMA_VERSION,
} from './ruleCandidates.js';

type CandidateTransaction = Prisma.TransactionClient;

export interface RuleCandidatePersistenceDeps {
  db: PrismaClient;
  now?: () => Date;
}

const defaultDeps: RuleCandidatePersistenceDeps = {
  db: prisma,
};

const RULE_CANDIDATE_REPAIR_BATCH_SIZE = 25;
const RULE_CANDIDATE_ACTIVATION_REPAIR_LIMIT = 100;
const RULE_CANDIDATE_EVIDENCE_ACTOR = 'system:rule-candidate-evidence';

interface RepairRow {
  requestId: string;
  transactionId: string;
  operation: string;
  expectedRevision: number;
  requestPayload: Prisma.JsonValue;
  companyId: string;
  revision: number;
  status: string;
  payee: string;
}

async function recomputeCandidate(
  tx: CandidateTransaction,
  candidateId: string,
  now: Date,
  markActivatedRule = true,
): Promise<void> {
  const candidate = await tx.autopilotRuleCandidate.findUnique({
    where: { id: candidateId },
  });
  if (candidate === null) return;
  const groups = await tx.$queryRaw<{
    actionFingerprint: string | null;
    evidenceCount: bigint;
    conflictingEvidenceCount: bigint;
  }[]>(
    Prisma.sql`
      WITH action_counts AS (
        SELECT
          "actionFingerprint",
          COUNT(DISTINCT "transactionId")::bigint AS evidence_count
        FROM "AutopilotRuleCandidateEvidence"
        WHERE "candidateId" = ${candidateId}
          AND "active" = true
          AND "polarity" = 'positive'
        GROUP BY "actionFingerprint"
      ),
      winner AS (
        SELECT "actionFingerprint", evidence_count
        FROM action_counts
        ORDER BY evidence_count DESC, "actionFingerprint" ASC
        LIMIT 1
      )
      SELECT
        winner."actionFingerprint",
        COALESCE(winner.evidence_count, 0)::bigint AS "evidenceCount",
        (COALESCE((
          SELECT SUM(other.evidence_count)
          FROM action_counts other
          WHERE other."actionFingerprint" <> winner."actionFingerprint"
        ), 0) + (
          SELECT COUNT(DISTINCT negative."transactionId")
          FROM "AutopilotRuleCandidateEvidence" negative
          WHERE negative."candidateId" = ${candidateId}
            AND negative."active" = true
            AND negative."polarity" = 'negative'
        ))::bigint AS "conflictingEvidenceCount"
      FROM (SELECT 1) seed
      LEFT JOIN winner ON true
    `,
  );
  const winner = groups[0];
  const patternRow = winner === undefined || winner.actionFingerprint === null
    ? null
    : await tx.autopilotRuleCandidateEvidence.findFirst({
        where: {
          candidateId,
          active: true,
          actionFingerprint: winner.actionFingerprint,
        },
        select: { pattern: true },
        orderBy: { transactionId: 'asc' },
      });
  const parsed = patternRow === null
    ? null
    : parseStoredCandidatePattern(patternRow.pattern);
  const pattern =
    parsed !== null
    && parsed.conditionFingerprint === candidate.conditionFingerprint
    && parsed.schemaVersion === candidate.schemaVersion
    && parsed.actionFingerprint === winner?.actionFingerprint
      ? parsed
      : null;
  const evidenceCount = winner === undefined ? 0 : Number(winner.evidenceCount);
  const conflictingEvidenceCount =
    winner === undefined ? 0 : Number(winner.conflictingEvidenceCount);
  const state =
    conflictingEvidenceCount > 0
      ? 'conflict'
      : evidenceCount >= RULE_CANDIDATE_EVIDENCE_THRESHOLD && pattern !== null
        ? 'ready'
        : 'gathering';
  const terminal = candidate.state === 'dismissed' || candidate.state === 'activated';
  await tx.autopilotRuleCandidate.update({
    where: { id: candidateId },
    data: {
      ...(terminal ? {} : { state }),
      winningActionFingerprint: pattern?.actionFingerprint ?? null,
      categoryQboId: pattern?.categoryQboId ?? null,
      taxCalculation: pattern?.taxCalculation ?? null,
      taxCodeQboId: pattern?.taxCodeQboId ?? null,
      tagIds: pattern?.tagIds ?? [],
      evidenceCount,
      conflictingEvidenceCount,
    },
  });
  if (
    markActivatedRule
    && candidate.state === 'activated'
    && candidate.activatedRuleId !== null
    && (
      state !== 'ready'
      || pattern?.actionFingerprint !== candidate.activationActionFingerprint
    )
  ) {
    const rule = await tx.rule.findFirst({
      where: { id: candidate.activatedRuleId, companyId: candidate.companyId },
      select: { revision: true },
    });
    if (rule !== null) {
      await disableRuleForSafetyInTransaction(tx, {
        companyId: candidate.companyId,
        ruleId: candidate.activatedRuleId,
        expectedRevision: rule.revision,
        reason: state === 'conflict'
          ? 'Verified outcomes now conflict with this learned rule.'
          : 'This learned rule no longer has enough current verified evidence.',
        actor: RULE_CANDIDATE_EVIDENCE_ACTOR,
        occurredAt: now,
      });
    }
  }
}

/**
 * Idempotently folds one durable VERIFIED post/revert into candidate evidence.
 * QBO has already been read back before this hook runs; this function performs
 * local database work only and can safely be replayed.
 */
export async function recordVerifiedRuleCandidateOutcome(
  outcome: VerifiedCategorizationOutcome,
  deps: RuleCandidatePersistenceDeps = defaultDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await runCompanyMutationTransaction(deps.db, outcome.companyId, async (tx) => {
    await foldVerifiedRuleCandidateOutcomeInTransaction(tx, outcome, now, {
      attemptFormat: 'legacy',
    });
  });
}

/**
 * Caller-owned transaction variant used by the classification outcome
 * recorder. It deliberately never starts a nested transaction; the caller is
 * responsible for taking the company mutation fence before invoking it.
 */
export async function foldVerifiedRuleCandidateOutcomeInTransaction(
  tx: CandidateTransaction,
  outcome: VerifiedCategorizationOutcome,
  now: Date,
  options: {
    markAffectedRules?: boolean;
    attemptFormat?: 'bound' | 'legacy';
  } = {},
): Promise<{ processed: boolean; affectedCandidateIds: string[] }> {
  const transaction = await tx.transaction.findUnique({
    where: { id: outcome.transactionId },
    select: {
      id: true,
      companyId: true,
      revision: true,
      status: true,
      payee: true,
    },
  });
  if (transaction === null) return { processed: false, affectedCandidateIds: [] };
  const affected = new Set<string>();
  const processed = await foldOutcome(
    tx,
    outcome,
    transaction,
    now,
    affected,
    options.attemptFormat ?? 'legacy',
  );
  for (const candidateId of affected) {
    await recomputeCandidate(
      tx,
      candidateId,
      now,
      options.markAffectedRules !== false,
    );
  }
  return { processed, affectedCandidateIds: [...affected] };
}

async function foldOutcome(
  tx: CandidateTransaction,
  outcome: VerifiedCategorizationOutcome,
  transaction: {
    id: string;
    companyId: string;
    revision: number;
    status: string;
    payee: string;
  },
  now: Date,
  affected: Set<string>,
  attemptFormat: 'bound' | 'legacy',
): Promise<boolean> {
  const folded = await tx.autopilotRuleCandidateFold.findUnique({
    where: { requestId: outcome.requestId },
    select: { requestId: true },
  });
  if (folded !== null) {
    await markAttemptFolded(tx, outcome, now, attemptFormat);
    return false;
  }

  const expectedStatus = outcome.operation === 'posted' ? 'POSTED' : 'PENDING';
  const current =
    transaction.id === outcome.transactionId
    && transaction.companyId === outcome.companyId
    && transaction.revision === outcome.inputRevision
    && transaction.status === expectedStatus;
  const existingEvidence = await tx.autopilotRuleCandidateEvidence.findFirst({
    where: { requestId: outcome.requestId },
    select: { candidateId: true },
  });

  if (current && existingEvidence === null) {
    const activeRows = await tx.autopilotRuleCandidateEvidence.findMany({
      where: { transactionId: outcome.transactionId, active: true },
      select: {
        candidateId: true,
        actionFingerprint: true,
        pattern: true,
        source: true,
      },
    });
    for (const row of activeRows) affected.add(row.candidateId);
    await tx.autopilotRuleCandidateEvidence.updateMany({
      where: { transactionId: outcome.transactionId, active: true },
      data: {
        active: false,
        invalidatedAt: now,
        invalidationReason: outcome.operation === 'reverted' ? 'reverted' : 'corrected',
      },
    });

    let positiveCandidateId: string | null = null;
    if (
      outcome.operation === 'posted'
      && outcome.proposal !== null
      && outcome.candidateContext !== null
    ) {
      const pattern = candidatePatternFor(
        outcome.candidateContext.matchText,
        outcome.proposal,
      );
      if (
        pattern !== null
        && pattern.schemaVersion === outcome.candidateContext.schemaVersion
        && pattern.conditionFingerprint === outcome.candidateContext.conditionFingerprint
      ) {
        const candidate = await tx.autopilotRuleCandidate.upsert({
          where: {
            companyId_conditionFingerprint_schemaVersion_configVersion: {
              companyId: outcome.companyId,
              conditionFingerprint: pattern.conditionFingerprint,
              schemaVersion: RULE_CANDIDATE_SCHEMA_VERSION,
              configVersion: outcome.candidateContext.configVersion,
            },
          },
          create: {
            companyId: outcome.companyId,
            conditionFingerprint: pattern.conditionFingerprint,
            schemaVersion: RULE_CANDIDATE_SCHEMA_VERSION,
            configVersion: outcome.candidateContext.configVersion,
            matchField: pattern.matchField,
            matchText: pattern.matchText,
            tagIds: [],
          },
          update: {},
        });
        await tx.autopilotRuleCandidateEvidence.create({
          data: {
            companyId: outcome.companyId,
            candidateId: candidate.id,
            transactionId: outcome.transactionId,
            inputRevision: outcome.inputRevision,
            requestId: outcome.requestId,
            source: outcome.candidateContext.source,
            polarity: 'positive',
            actionFingerprint: pattern.actionFingerprint,
            pattern: pattern as unknown as Prisma.InputJsonValue,
            active: true,
            observedAt: now,
          },
        });
        positiveCandidateId = candidate.id;
        affected.add(candidate.id);
      }
    }
    const counterexamples = new Map(activeRows.map((row) => [row.candidateId, row]));
    for (const row of counterexamples.values()) {
      if (row.candidateId === positiveCandidateId) continue;
      await tx.autopilotRuleCandidateEvidence.create({
        data: {
          companyId: outcome.companyId,
          candidateId: row.candidateId,
          transactionId: outcome.transactionId,
          inputRevision: outcome.inputRevision,
          requestId: outcome.requestId,
          source: outcome.candidateContext?.source ?? row.source,
          polarity: 'negative',
          actionFingerprint: row.actionFingerprint,
          pattern: row.pattern as Prisma.InputJsonValue,
          active: true,
          observedAt: now,
        },
      });
      affected.add(row.candidateId);
    }
  }

  await tx.autopilotRuleCandidateFold.create({
    data: {
      requestId: outcome.requestId,
      companyId: outcome.companyId,
      transactionId: outcome.transactionId,
      operation: outcome.operation,
      processedAt: now,
    },
  });
  const marked = await markAttemptFolded(tx, outcome, now, attemptFormat);
  if (marked !== 1) {
    throw new Error('Verified rule-candidate outcome is not backed by one durable attempt.');
  }
  return true;
}

async function markAttemptFolded(
  tx: CandidateTransaction,
  outcome: VerifiedCategorizationOutcome,
  now: Date,
  attemptFormat: 'bound' | 'legacy',
): Promise<number> {
  const durableOperation = outcome.operation === 'posted' ? 'recategorize' : 'restore';
  // Prisma's normal update path also advances @updatedAt. Other agent evidence
  // treats QboMutationAttempt.updatedAt as verification recency, so this
  // advisory fold stamp must be an exact column-only CAS.
  return tx.$executeRaw(
    Prisma.sql`
      UPDATE "QboMutationAttempt"
      SET "ruleCandidateFoldedAt" = ${now}
      WHERE "requestId" = ${outcome.requestId}
        AND "transactionId" = ${outcome.transactionId}
        AND "operation" = ${durableOperation}
        AND "status" = 'VERIFIED'
        AND "expectedRevision" = ${outcome.inputRevision}
        AND "ruleCandidateFoldedAt" IS NULL
        AND ${attemptFormat === 'bound'
          ? Prisma.sql`
              "classificationEnvelopeVersion" = 2
              AND "requestPayload"->'ruleCandidateFold'->>'version' = '2'
            `
          : Prisma.sql`
              "classificationEnvelopeVersion" IS NULL
              AND "classificationEnvelopeHash" IS NULL
              AND "requestPayload"->'ruleCandidateFold'->>'version' = '1'
              AND "requestPayload"->'classificationEvidenceBinding' IS NULL
            `}
    `,
  );
}

async function repairRows(
  tx: CandidateTransaction,
  rows: readonly RepairRow[],
  now: Date,
): Promise<void> {
  const affected = new Set<string>();
  for (const row of rows) {
    const operation = row.operation === 'restore' ? 'reverted' : 'posted';
    await foldOutcome(tx, {
      companyId: row.companyId,
      transactionId: row.transactionId,
      inputRevision: row.expectedRevision,
      requestId: row.requestId,
      operation,
      proposal: operation === 'posted'
        ? persistedEvidenceProposal(row.requestPayload)
        : null,
      candidateContext: operation === 'posted'
        ? persistedRuleCandidateContext(row.requestPayload)
        : null,
    }, {
      id: row.transactionId,
      companyId: row.companyId,
      revision: row.revision,
      status: row.status,
      payee: row.payee,
    }, now, affected, 'legacy');
  }
  for (const candidateId of affected) {
    await recomputeCandidate(tx, candidateId, now);
  }
}

function missingRepairRows(
  tx: CandidateTransaction,
  companyId: string,
  limit: number,
  extraPredicate: Prisma.Sql = Prisma.empty,
): Promise<RepairRow[]> {
  return tx.$queryRaw<RepairRow[]>(
    Prisma.sql`
      SELECT
        attempt."requestId",
        attempt."transactionId",
        attempt."operation",
        attempt."expectedRevision",
        attempt."requestPayload",
        transaction."companyId",
        transaction."revision",
        transaction."status"::text,
        transaction."payee"
      FROM "QboMutationAttempt" attempt
      JOIN "Transaction" transaction ON transaction."id" = attempt."transactionId"
      WHERE transaction."companyId" = ${companyId}
        AND attempt."status" = 'VERIFIED'
        AND attempt."operation" IN ('recategorize', 'restore')
        AND attempt."ruleCandidateFoldedAt" IS NULL
        AND attempt."classificationEnvelopeVersion" IS NULL
        AND attempt."classificationEnvelopeHash" IS NULL
        AND attempt."requestPayload"->'ruleCandidateFold'->>'version' = '1'
        AND attempt."requestPayload"->'classificationEvidenceBinding' IS NULL
        -- A v1 attempt predates bound case recording. Its optional decision
        -- envelope must never create a case, but its historically supported
        -- VERIFIED candidate fold remains repairable here.
        ${extraPredicate}
      ORDER BY attempt."createdAt" DESC, attempt."id" DESC
      LIMIT ${limit}
    `,
  );
}

/**
 * Replays current durable VERIFIED writes that predate the candidate tables or
 * whose advisory callback was interrupted. Normal writes use the event hook;
 * this bounded rebuild is an idempotent repair path and never contacts QBO.
 */
export async function rebuildRuleCandidates(
  companyId: string,
  deps: RuleCandidatePersistenceDeps = defaultDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await runCompanyMutationTransaction(deps.db, companyId, async (tx) => {
    const rows = await missingRepairRows(
      tx,
      companyId,
      RULE_CANDIDATE_REPAIR_BATCH_SIZE,
    );
    await repairRows(tx, rows, now);
  });
}

export async function reconcileRuleCandidateBeforeActivation(
  tx: CandidateTransaction,
  candidate: {
    id: string;
    companyId: string;
    conditionFingerprint: string;
    configVersion: string;
  },
  now = new Date(),
): Promise<{ saturated: boolean }> {
  const { reconcileBoundClassificationOutcomesBeforeActivation } = await import(
    '../classification/outcomeRecorder.js'
  );
  const bound = await reconcileBoundClassificationOutcomesBeforeActivation(
    tx,
    candidate,
    now,
  );
  if (bound.saturated) return bound;
  const rows = await missingRepairRows(
    tx,
    candidate.companyId,
    RULE_CANDIDATE_ACTIVATION_REPAIR_LIMIT + 1,
    Prisma.sql`
      AND (
        (
          attempt."operation" = 'recategorize'
          AND attempt."requestPayload"->'ruleCandidateEvidence'->>'conditionFingerprint'
            = ${candidate.conditionFingerprint}
          AND attempt."requestPayload"->'ruleCandidateEvidence'->>'configVersion'
            = ${candidate.configVersion}
        )
        OR (
          attempt."operation" = 'restore'
          AND EXISTS (
            SELECT 1
            FROM "AutopilotRuleCandidateEvidence" evidence
            WHERE evidence."candidateId" = ${candidate.id}
              AND evidence."transactionId" = attempt."transactionId"
              AND evidence."active" = true
          )
        )
      )
    `,
  );
  if (rows.length > RULE_CANDIDATE_ACTIVATION_REPAIR_LIMIT) {
    return { saturated: true };
  }
  await repairRows(tx, rows, now);
  return { saturated: false };
}
