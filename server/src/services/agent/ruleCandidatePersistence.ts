import { Prisma, type PrismaClient } from '../../lib/db.js';
import { prisma } from '../../lib/prisma.js';
import {
  persistedEvidenceProposal,
  persistedRuleCandidateContext,
} from '../categorizationEvidence.js';
import { runCompanyMutationTransaction } from '../companyMutationScope.js';
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
): Promise<void> {
  const candidate = await tx.autopilotRuleCandidate.findUnique({
    where: { id: candidateId },
  });
  if (candidate === null) return;
  const groups = await tx.$queryRaw<{
    actionFingerprint: string;
    evidenceCount: bigint;
    conflictingEvidenceCount: bigint;
  }[]>(
    Prisma.sql`
      WITH action_counts AS (
        SELECT
          "actionFingerprint",
          COUNT(DISTINCT "transactionId")::bigint AS evidence_count
        FROM "AutopilotRuleCandidateEvidence"
        WHERE "candidateId" = ${candidateId} AND "active" = true
        GROUP BY "actionFingerprint"
      )
      SELECT
        winner."actionFingerprint",
        winner.evidence_count AS "evidenceCount",
        COALESCE((
          SELECT SUM(other.evidence_count)
          FROM action_counts other
          WHERE other."actionFingerprint" <> winner."actionFingerprint"
        ), 0)::bigint AS "conflictingEvidenceCount"
      FROM action_counts winner
      ORDER BY winner.evidence_count DESC, winner."actionFingerprint" ASC
      LIMIT 1
    `,
  );
  const winner = groups[0];
  const patternRow = winner === undefined
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
    candidate.state === 'activated'
    && candidate.activatedRuleId !== null
    && (
      state !== 'ready'
      || pattern?.actionFingerprint !== candidate.activationActionFingerprint
    )
  ) {
    await tx.rule.update({
      where: { id: candidate.activatedRuleId },
      data: {
        autoPost: false,
        reviewRequiredAt: now,
        reviewReason: state === 'conflict'
          ? 'Verified outcomes now conflict with this learned rule.'
          : 'This learned rule no longer has enough current verified evidence.',
      },
    });
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
    if (transaction === null) return;
    const affected = new Set<string>();
    await foldOutcome(tx, outcome, transaction, now, affected);
    for (const candidateId of affected) {
      await recomputeCandidate(tx, candidateId, now);
    }
  });
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
): Promise<void> {
  const folded = await tx.autopilotRuleCandidateFold.findUnique({
    where: { requestId: outcome.requestId },
    select: { requestId: true },
  });
  if (folded !== null) {
    await markAttemptFolded(tx, outcome, now);
    return;
  }

  const expectedStatus = outcome.operation === 'posted' ? 'POSTED' : 'REVERTED';
  const current =
    transaction.id === outcome.transactionId
    && transaction.companyId === outcome.companyId
    && transaction.revision === outcome.inputRevision
    && transaction.status === expectedStatus;
  const existingEvidence = await tx.autopilotRuleCandidateEvidence.findUnique({
    where: { requestId: outcome.requestId },
    select: { candidateId: true },
  });

  if (current && existingEvidence === null) {
    const activeRows = await tx.autopilotRuleCandidateEvidence.findMany({
      where: { transactionId: outcome.transactionId, active: true },
      select: { candidateId: true },
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
            candidateId: candidate.id,
            transactionId: outcome.transactionId,
            inputRevision: outcome.inputRevision,
            requestId: outcome.requestId,
            source: outcome.candidateContext.source,
            actionFingerprint: pattern.actionFingerprint,
            pattern: pattern as unknown as Prisma.InputJsonValue,
            active: true,
            observedAt: now,
          },
        });
        affected.add(candidate.id);
      }
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
  const marked = await markAttemptFolded(tx, outcome, now);
  if (marked !== 1) {
    throw new Error('Verified rule-candidate outcome is not backed by one durable attempt.');
  }
}

async function markAttemptFolded(
  tx: CandidateTransaction,
  outcome: VerifiedCategorizationOutcome,
  now: Date,
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
        AND "requestPayload"->'ruleCandidateFold'->>'version' = '1'
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
    }, now, affected);
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
        AND attempt."requestPayload"->'ruleCandidateFold'->>'version' = '1'
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
