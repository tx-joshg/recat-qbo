import { randomUUID } from 'node:crypto';
import { Prisma, type RulePreparationRetry } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { EntityLeaseError } from './entityLease.js';
import { RuleSuggestionApplicationError } from './ruleSuggestionApplication.js';
import type { PrepareRuleAutoPostInput } from './ruleAutoPost.js';

export interface DeferredRuleCandidate {
  companyId: string;
  transactionId: string;
  sourceRevision: number;
  ruleId: string;
  ruleRevision: number;
}

export interface RulePreparationRetryClaim {
  id: string;
  token: string;
  sourceRevision: number;
}

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 25;

/** Discovery filter, rechecked under the authority fence inside actual staging. */
async function eligible(db: Prisma.TransactionClient, input: DeferredRuleCandidate): Promise<boolean> {
  const [company, transaction, attempts, jobs, preparations] = await Promise.all([
    db.company.findUnique({ where: { id: input.companyId }, select: { ruleRuntimeMode: true, disconnectedAt: true } }),
    db.transaction.findFirst({ where: { id: input.transactionId, companyId: input.companyId },
      include: { _count: { select: { splitLines: true, txnTags: true } } } }),
    db.qboMutationAttempt.count({ where: { transactionId: input.transactionId, expectedRevision: { gte: input.sourceRevision } } }),
    db.agentJob.count({ where: { companyId: input.companyId, transactionId: input.transactionId,
      revision: { gte: input.sourceRevision }, OR: [{ attemptCount: { gt: 0 } }, { status: { notIn: ['queued', 'retry'] } }] } }),
    db.ruleAutoPostPreparation.count({ where: { companyId: input.companyId, transactionId: input.transactionId,
      sourceRevision: { gte: input.sourceRevision } } }),
  ]);
  return company?.ruleRuntimeMode === 'canonical' && company.disconnectedAt === null
    && transaction !== null && transaction.revision === input.sourceRevision && transaction.status === 'PENDING'
    && transaction.category === null && transaction.categoryQboId === null
    && transaction.taxCalculation === null && transaction.taxCode === null && transaction.taxCodeQboId === null
    && transaction._count.splitLines === 0 && transaction._count.txnTags === 0
    && attempts === 0 && jobs === 0 && preparations === 0;
}

/** Repeated contention never renews a completed, cancelled, or exhausted budget. */
export async function rememberBusyRulePreparation(input: DeferredRuleCandidate): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // This is discovery, not write authority: do not wait for the advisory
    // fence that caused contention. The Company row lock serializes insertion
    // with disconnect/runtime cancellation; staging revalidates every fact.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Company" WHERE "id" = ${input.companyId} FOR SHARE`);
    if (!await eligible(tx, input)) return;
    await tx.rulePreparationRetry.createMany({ data: [{ ...input, dueAt: new Date(Date.now() + 30_000) }], skipDuplicates: true });
  }, { maxWait: 5_000, timeout: 5_000 });
}

/** Runs inside the actual staging transaction, after its company authority fence. */
export async function verifyRulePreparationRetryClaim(
  db: Prisma.TransactionClient,
  input: PrepareRuleAutoPostInput,
): Promise<boolean> {
  const claim = input.deferredRetry;
  if (claim === undefined) return true;
  const rows = await db.$queryRaw<RulePreparationRetry[]>(Prisma.sql`
    SELECT * FROM "RulePreparationRetry" WHERE "id" = ${claim.id} FOR UPDATE
  `);
  const row = rows[0];
  if (row === undefined || row.state !== 'PENDING' || row.claimToken !== claim.token
    || row.companyId !== input.companyId || row.transactionId !== input.transactionId
    || row.ruleId !== input.ruleId || row.ruleRevision !== input.ruleRevision
    || row.sourceRevision !== claim.sourceRevision) return false;
  return eligible(db, row);
}

async function claimDue(): Promise<RulePreparationRetry[]> {
  const token = randomUUID();
  // The next due time is also the crash-recovery lease. Advancing the finite
  // budget before execution prevents repeated process death from resetting it.
  return prisma.$queryRaw<RulePreparationRetry[]>(Prisma.sql`
    WITH due AS (
      SELECT "id" FROM "RulePreparationRetry"
      WHERE "state" = 'PENDING' AND "dueAt" <= CURRENT_TIMESTAMP
      ORDER BY "dueAt", "id" FOR UPDATE SKIP LOCKED LIMIT ${BATCH_SIZE}
    )
    UPDATE "RulePreparationRetry" r SET
      "state" = CASE WHEN r."attemptCount" >= ${MAX_ATTEMPTS} THEN 'EXHAUSTED' ELSE 'PENDING' END,
      "attemptCount" = LEAST(r."attemptCount" + 1, ${MAX_ATTEMPTS}),
      "claimToken" = CASE WHEN r."attemptCount" >= ${MAX_ATTEMPTS} THEN NULL ELSE ${token} END,
      "dueAt" = CURRENT_TIMESTAMP + CASE WHEN r."attemptCount" = 0 THEN INTERVAL '2 minutes' ELSE INTERVAL '10 minutes' END
    FROM due WHERE r."id" = due."id" RETURNING r.*
  `);
}

/** Retain current binding tombstones: deleting those would renew a spent budget. */
async function pruneObsoleteRetries(): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "RulePreparationRetry" WHERE "id" IN (
      SELECT r."id" FROM "RulePreparationRetry" r
      WHERE r."state" <> 'PENDING' AND (
        NOT EXISTS (SELECT 1 FROM "Transaction" t WHERE t."companyId" = r."companyId"
          AND t."id" = r."transactionId" AND t."revision" = r."sourceRevision")
        OR NOT EXISTS (SELECT 1 FROM "Rule" rule WHERE rule."companyId" = r."companyId"
          AND rule."id" = r."ruleId" AND rule."revision" = r."ruleRevision")
      ) ORDER BY r."createdAt", r."id" FOR UPDATE OF r SKIP LOCKED LIMIT ${BATCH_SIZE}
    )
  `);
}

export async function recoverRulePreparationRetries(dependencies: {
  prepare?: (input: PrepareRuleAutoPostInput) => Promise<{ preparationId: string }>;
} = {}): Promise<{ examined: number; prepared: number }> {
  await pruneObsoleteRetries();
  const rows = await claimDue();
  let prepared = 0;
  const prepare = dependencies.prepare ?? (await import('./ruleAutoPost.js')).prepareRuleAutoPost;
  for (const row of rows) {
    if (row.state !== 'PENDING') continue;
    let state = 'CANCELLED';
    try {
      await prepare({ companyId: row.companyId, transactionId: row.transactionId,
        ruleId: row.ruleId, ruleRevision: row.ruleRevision,
        deferredRetry: { id: row.id, token: row.claimToken!, sourceRevision: row.sourceRevision } });
      state = 'DONE';
      prepared += 1;
    } catch (error) {
      if ((error instanceof EntityLeaseError && error.code === 'ENTITY_BUSY')
        || (error instanceof RuleSuggestionApplicationError && error.code === 'RULE_SUGGESTION_BUSY')) {
        state = row.attemptCount >= MAX_ATTEMPTS ? 'EXHAUSTED' : 'PENDING';
      }
    }
    await prisma.rulePreparationRetry.updateMany({
      where: { id: row.id, state: 'PENDING', claimToken: row.claimToken },
      data: { state, claimToken: null },
    });
  }
  return { examined: rows.length, prepared };
}
