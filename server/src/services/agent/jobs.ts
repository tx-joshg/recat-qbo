import { prisma } from '../../lib/prisma.js';
import type { AgentJobStatus } from '@recat/shared';
import { lockCompanyMutationScopes } from '../companyMutationScope.js';
import type { AgentModelErrorCode } from './core/model.js';

export type { AgentJobStatus } from '@recat/shared';

const LEASE_MS = 60_000;
const MAX_CLAIM_LIMIT = 4;
const MAX_ATTEMPTS = 3;
const CLAIM_CAPACITY_LOCK = 728_202_604;
const SAFE_ERROR_CODES = [
  'AGENT_MODEL_CONFIG_INVALID',
  'AGENT_MODEL_INPUT_INVALID',
  'AGENT_MODEL_NETWORK_ERROR',
  'AGENT_MODEL_HTTP_ERROR',
  'AGENT_MODEL_RESPONSE_TOO_LARGE',
  'AGENT_MODEL_RESPONSE_INVALID',
  'AGENT_MODEL_ABORTED',
  'AGENT_MODEL_EXHAUSTED',
] as const satisfies readonly AgentModelErrorCode[];

export type AgentJobErrorCode =
  | AgentModelErrorCode
  | 'AGENT_SUPERSEDED'
  | 'AGENT_JOB_EXHAUSTED'
  | 'LIVE_MUTATION_RETRY_EXHAUSTED';

export interface AgentJob {
  id: string;
  companyId: string;
  transactionId: string;
  revision: number;
  configVersion: string;
  schedulingGeneration: number;
  status: AgentJobStatus;
  dueAt: Date;
  lockOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  lastErrorCode: AgentJobErrorCode | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClaimedAgentJob = AgentJob;

interface ClaimCandidate {
  id: string;
  status: 'queued' | 'retry' | 'running';
  attemptCount: number;
}

export type FinishAgentJobResult =
  | { kind: 'completed' }
  | { kind: 'failed'; transient: boolean; errorCode: AgentModelErrorCode };

export interface AgentJobDb {
  $transaction<T>(callback: (tx: AgentJobDb) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface AgentJobDeps {
  db: AgentJobDb;
  /** Tests may supply a deterministic clock; production uses database time. */
  now?(tx: AgentJobDb): Promise<Date> | Date;
}

const defaultDeps: AgentJobDeps = {
  db: prisma as unknown as AgentJobDb,
};

export class AgentJobError extends Error {
  readonly code = 'AGENT_JOB_INVALID';

  constructor(message = 'Invalid shadow agent job operation.') {
    super(message);
    this.name = 'AgentJobError';
  }
}

/**
 * Enqueues each current pending transaction once for the company's immutable
 * configuration version and scheduling intent. The unique index makes repeated
 * schedulers and concurrent discovery calls idempotent. Generation zero retains
 * existing discovery; explicit new intent only schedules unstaged, unattempted
 * revisions and cannot override terminal work or an administrator's cancellation.
 */
export async function discoverShadowJobs(
  companyId: string,
  deps: AgentJobDeps = defaultDeps,
): Promise<AgentJob[]> {
  assertIdentifier(companyId);
  const now = await currentTime(deps.db, deps);
  return deps.db.$queryRawUnsafe<AgentJob[]>(
    `INSERT INTO "AgentJob" (
       "id", "companyId", "transactionId", "revision", "configVersion", "schedulingGeneration",
       "status", "dueAt", "createdAt", "updatedAt"
     )
     SELECT gen_random_uuid(), txn."companyId", txn."id", txn."revision", config."configVersion", config."schedulingGeneration",
       'queued', $1, $1, $1
     FROM "Transaction" AS txn
     JOIN "AgentCompanyConfig" AS config ON config."companyId" = txn."companyId"
     JOIN "Company" AS company ON company."id" = txn."companyId"
     WHERE txn."companyId" = $2
       AND txn."status" = 'PENDING'
       AND config."mode" = 'shadow'
       AND company."disconnectedAt" IS NULL
       AND (
         config."schedulingGeneration" = 0
         OR (
           txn."category" IS NULL AND txn."categoryQboId" IS NULL
           AND txn."taxCalculation" IS NULL AND txn."taxCode" IS NULL AND txn."taxCodeQboId" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "SplitLine" line WHERE line."txnId" = txn."id")
           AND NOT EXISTS (SELECT 1 FROM "TxnTag" tag WHERE tag."txnId" = txn."id")
           AND NOT EXISTS (
             SELECT 1 FROM "QboMutationAttempt" attempt
             WHERE attempt."transactionId" = txn."id" AND attempt."expectedRevision" >= txn."revision"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "AgentJob" previous
             WHERE previous."companyId" = txn."companyId" AND previous."transactionId" = txn."id"
               AND previous."revision" = txn."revision"
               AND (previous."status" = 'terminal' OR previous."lastErrorCode" = 'AGENT_CANCELLED_BY_ADMIN')
           )
         )
       )
     ON CONFLICT ("companyId", "transactionId", "revision", "configVersion", "schedulingGeneration") DO NOTHING
     RETURNING ${returningColumns()}`,
    now,
    companyId,
  );
}

/**
 * Atomically cancels obsolete jobs and leases valid due jobs within database-
 * global and per-company capacity. A transaction advisory lock serializes
 * capacity accounting across server processes; row locks with SKIP LOCKED
 * still fence the selected jobs from worker completion and other claimers.
 */
export async function claimShadowJobs(
  owner: string,
  limit: number,
  deps: AgentJobDeps = defaultDeps,
): Promise<ClaimedAgentJob[]> {
  assertIdentifier(owner);
  const boundedLimit = boundedClaimLimit(limit);
  if (boundedLimit === 0) return [];

  return deps.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT 1 AS "locked"
       FROM pg_advisory_xact_lock(${CLAIM_CAPACITY_LOCK})`,
    );
    const claimAt = await currentTime(tx, deps);
    const leaseExpiresAt = new Date(claimAt.getTime() + LEASE_MS);
    const activeCompanyRows = await tx.$queryRawUnsafe<{ companyId: string }[]>(
      `SELECT DISTINCT "companyId"
         FROM "AgentJob"
        WHERE "status" IN ('queued', 'retry', 'running')
        ORDER BY "companyId"`,
    );
    const activeCompanyIds = activeCompanyRows.map((row) => row.companyId);
    // The capacity lock is already held. Acquire every company scope that the
    // cancellation/claim queries can mutate before either query takes job-row
    // locks, preserving capacity -> sorted company -> job/live-fact ordering.
    await lockCompanyMutationScopes(
      tx,
      activeCompanyIds,
    );
    await tx.$queryRawUnsafe(
      `WITH cancelled AS MATERIALIZED (
         UPDATE "AgentJob" AS job
         SET "status" = 'cancelled',
             "dueAt" = $1,
             "lockOwner" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = 'AGENT_SUPERSEDED',
             "updatedAt" = $1
         FROM "Transaction" AS txn
         LEFT JOIN "AgentCompanyConfig" AS config ON config."companyId" = txn."companyId"
         JOIN "Company" AS company ON company."id" = txn."companyId"
         WHERE job."transactionId" = txn."id"
           AND job."companyId" = txn."companyId"
           AND job."status" IN ('queued', 'retry', 'running')
           AND job."companyId" = ANY($2::text[])
           AND (
             NOT (
               (
                 txn."status" = 'PENDING'
                 AND txn."revision" = job."revision"
               )
               OR (
                 txn."revision" = job."revision" + 1
                 AND EXISTS (
                   SELECT 1
                     FROM "QboMutationAttempt" recovery_attempt
                    WHERE recovery_attempt."transactionId" = job."transactionId"
                      AND recovery_attempt."requestId" = job."id"
                      AND recovery_attempt."expectedRevision" = txn."revision"
                      AND recovery_attempt."operation" = 'recategorize'
                      AND (
                        (
                          recovery_attempt."status" IN ('PREPARED', 'RETRYABLE', 'COMMITTING')
                          AND txn."status" = 'PENDING'
                        )
                        OR (
                          recovery_attempt."status" = 'UNCERTAIN'
                          AND txn."status" = 'ERROR'
                        )
                        OR (
                          recovery_attempt."status" = 'VERIFIED'
                          AND txn."status" = 'POSTED'
                        )
                      )
                 )
               )
             )
             OR (
               (
                 config."companyId" IS NULL
                 OR config."mode" <> 'shadow'
                 OR config."configVersion" <> job."configVersion"
                 OR config."schedulingGeneration" <> job."schedulingGeneration"
                 OR company."disconnectedAt" IS NOT NULL
               )
               AND NOT (
                 txn."revision" = job."revision" + 1
                 AND EXISTS (
                   SELECT 1
                     FROM "QboMutationAttempt" recovery_attempt
                    WHERE recovery_attempt."transactionId" = job."transactionId"
                      AND recovery_attempt."requestId" = job."id"
                      AND recovery_attempt."expectedRevision" = txn."revision"
                      AND recovery_attempt."operation" = 'recategorize'
                      AND (
                        (
                          recovery_attempt."status" IN ('PREPARED', 'RETRYABLE', 'COMMITTING')
                          AND txn."status" = 'PENDING'
                        )
                        OR (
                          recovery_attempt."status" = 'UNCERTAIN'
                          AND txn."status" = 'ERROR'
                        )
                        OR (
                          recovery_attempt."status" = 'VERIFIED'
                          AND txn."status" = 'POSTED'
                        )
                      )
                 )
               )
             )
           )
         RETURNING job."id", job."attemptCount"
       )
       UPDATE "AgentRun" AS run
       SET "status" = 'failed',
           "errorCode" = 'AGENT_SUPERSEDED',
           "completedAt" = $1
       FROM cancelled
       WHERE run."jobId" = cancelled."id"
         AND run."attemptCount" = cancelled."attemptCount"
         AND run."status" = 'running'`,
      claimAt,
      activeCompanyIds,
    );

    const candidates = await tx.$queryRawUnsafe<ClaimCandidate[]>(
      `WITH active_by_company AS MATERIALIZED (
         SELECT job."companyId", COUNT(*)::integer AS "activeCount"
         FROM "AgentJob" AS job
         WHERE job."status" = 'running'
           AND job."leaseExpiresAt" > $1
         GROUP BY job."companyId"
       ),
       global_capacity AS MATERIALIZED (
         SELECT GREATEST(
           0,
           ${MAX_CLAIM_LIMIT} - COALESCE(SUM(active."activeCount"), 0)::integer
         ) AS "slots"
         FROM active_by_company AS active
       ),
       ranked_ids AS MATERIALIZED (
         SELECT job."id", job."dueAt",
           ROW_NUMBER() OVER (
             PARTITION BY job."companyId"
             ORDER BY job."dueAt", job."id"
           ) AS "companyRank",
           GREATEST(
             0,
             LEAST(config."companyConcurrency", ${MAX_CLAIM_LIMIT})
               - COALESCE(active."activeCount", 0)
           ) AS "companySlots"
         FROM "AgentJob" AS job
         JOIN "Transaction" AS txn
           ON txn."id" = job."transactionId"
          AND txn."companyId" = job."companyId"
         JOIN "AgentCompanyConfig" AS config
           ON config."companyId" = job."companyId"
         JOIN "Company" AS company
           ON company."id" = job."companyId"
         LEFT JOIN active_by_company AS active
           ON active."companyId" = job."companyId"
         WHERE (
             (
               txn."status" = 'PENDING'
               AND txn."revision" = job."revision"
             )
             OR (
               txn."revision" = job."revision" + 1
               AND EXISTS (
                 SELECT 1
                   FROM "QboMutationAttempt" recovery_attempt
                  WHERE recovery_attempt."transactionId" = job."transactionId"
                    AND recovery_attempt."requestId" = job."id"
                    AND recovery_attempt."expectedRevision" = txn."revision"
                    AND recovery_attempt."operation" = 'recategorize'
                    AND (
                      (
                        recovery_attempt."status" IN ('PREPARED', 'RETRYABLE', 'COMMITTING')
                        AND txn."status" = 'PENDING'
                      )
                      OR (
                        recovery_attempt."status" = 'UNCERTAIN'
                        AND txn."status" = 'ERROR'
                      )
                      OR (
                        recovery_attempt."status" = 'VERIFIED'
                        AND txn."status" = 'POSTED'
                      )
                    )
               )
             )
           )
           AND (
             (
               config."mode" = 'shadow'
               AND config."configVersion" = job."configVersion"
               AND config."schedulingGeneration" = job."schedulingGeneration"
               AND company."disconnectedAt" IS NULL
             )
             OR txn."revision" = job."revision" + 1
           )
           AND (
             (
               job."status" IN ('queued', 'retry')
               AND job."attemptCount" < ${MAX_ATTEMPTS}
               AND job."dueAt" <= $1
             )
             OR (
               job."status" = 'running'
               AND job."leaseExpiresAt" <= $1
             )
           )
           AND job."companyId" = ANY($3::text[])
       )
       SELECT job."id", job."status", job."attemptCount"
       FROM "AgentJob" AS job
       JOIN ranked_ids AS ranked ON ranked."id" = job."id"
       CROSS JOIN global_capacity AS capacity
       WHERE ranked."companyRank" <= ranked."companySlots"
         AND (
           (
             job."status" IN ('queued', 'retry')
             AND job."attemptCount" < ${MAX_ATTEMPTS}
             AND job."dueAt" <= $1
           )
           OR (
             job."status" = 'running'
             AND job."leaseExpiresAt" <= $1
           )
         )
       ORDER BY ranked."dueAt", job."id"
       FOR UPDATE OF job SKIP LOCKED
       LIMIT (SELECT LEAST("slots", $2) FROM global_capacity)`,
      claimAt,
      boundedLimit,
      activeCompanyIds,
    );
    const expiredJobIds = candidates
      .filter((candidate) => candidate.status === 'running')
      .map((candidate) => candidate.id);
    if (expiredJobIds.length > 0) {
      const exhaustedMutationRows = await tx.$queryRawUnsafe<{ jobId: string }[]>(
        `UPDATE "QboMutationAttempt" AS attempt
         SET "status" = 'FAILED',
             "errorCode" = 'LIVE_MUTATION_RETRY_EXHAUSTED',
             "errorMessage" = 'The guarded live mutation exhausted its retry budget.',
             "updatedAt" = $1
         FROM "AgentJob" AS job
         JOIN "Transaction" AS txn
           ON txn."id" = job."transactionId"
          AND txn."companyId" = job."companyId"
         WHERE job."id" = ANY($2::text[])
           AND job."status" = 'running'
           AND job."attemptCount" >= ${MAX_ATTEMPTS}
           AND job."leaseExpiresAt" <= $1
           AND txn."status" = 'PENDING'
           AND txn."revision" = job."revision" + 1
           AND attempt."transactionId" = txn."id"
           AND attempt."requestId" = job."id"
           AND attempt."expectedRevision" = txn."revision"
           AND attempt."operation" = 'recategorize'
           AND attempt."status" IN ('PREPARED', 'RETRYABLE')
         RETURNING job."id" AS "jobId"`,
        claimAt,
        expiredJobIds,
      );
      const exhaustedMutationJobIds = exhaustedMutationRows.map((row) => row.jobId);
      await tx.$queryRawUnsafe(
        `UPDATE "AgentRun" AS run
         SET "status" = 'failed',
             "errorCode" = CASE
               WHEN run."jobId" = ANY($3::text[])
                 THEN 'LIVE_MUTATION_RETRY_EXHAUSTED'
               ELSE 'AGENT_RUN_ABANDONED'
             END,
             "completedAt" = $1
         FROM "AgentJob" AS job
         WHERE job."id" = ANY($2::text[])
           AND run."jobId" = job."id"
           AND run."attemptCount" = job."attemptCount"
           AND run."status" = 'running'`,
        claimAt,
        expiredJobIds,
        exhaustedMutationJobIds,
      );
      await tx.$queryRawUnsafe(
        `UPDATE "AgentJob"
         SET "status" = 'terminal',
             "dueAt" = $1,
             "lockOwner" = NULL,
             "leaseExpiresAt" = NULL,
             "lastErrorCode" = CASE
               WHEN "id" = ANY($3::text[])
                 THEN 'LIVE_MUTATION_RETRY_EXHAUSTED'
               ELSE 'AGENT_JOB_EXHAUSTED'
             END,
             "updatedAt" = $1
         WHERE "id" = ANY($2::text[])
           AND "status" = 'running'
           AND "attemptCount" >= ${MAX_ATTEMPTS}
           AND "leaseExpiresAt" <= $1`,
        claimAt,
        expiredJobIds,
        exhaustedMutationJobIds,
      );
    }

    const claimableIds = candidates
      .filter((candidate) => (
        candidate.status !== 'running'
        || candidate.attemptCount < MAX_ATTEMPTS
      ))
      .map((candidate) => candidate.id);
    if (claimableIds.length === 0) return [];

    return tx.$queryRawUnsafe<ClaimedAgentJob[]>(
      `UPDATE "AgentJob" AS claimed
       SET "status" = 'running',
           "lockOwner" = $1,
           "leaseExpiresAt" = $2,
           "attemptCount" = claimed."attemptCount" + 1,
           "updatedAt" = $3
       WHERE claimed."id" = ANY($4::text[])
       -- Task 3 reloads this revision/config binding immediately before inference;
       -- do not hold transaction/config locks across provider work here.
       RETURNING ${returningColumns('claimed')}`,
      owner,
      leaseExpiresAt,
      claimAt,
      claimableIds,
    );
  });
}

/**
 * Cancels only a still-owned claim whose transaction or configuration binding
 * has become obsolete. The job row is updated before any matching run so the
 * lock order remains consistent with worker completion and recovery.
 */
export async function cancelSupersededAgentJob(
  job: ClaimedAgentJob,
  owner: string,
  deps: AgentJobDeps = defaultDeps,
): Promise<boolean> {
  assertIdentifier(job.id);
  assertIdentifier(owner);
  assertAttemptCount(job.attemptCount);
  return deps.db.$transaction(async (tx) => {
    const cancelledAt = await currentTime(tx, deps);
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "AgentJob" AS job
       SET "status" = 'cancelled',
           "dueAt" = $1,
           "lockOwner" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = 'AGENT_SUPERSEDED',
           "updatedAt" = $1
       WHERE job."id" = $2
         AND job."status" = 'running'
         AND job."lockOwner" = $3
         AND job."attemptCount" = $4
         AND job."leaseExpiresAt" > $1
         AND EXISTS (
           SELECT 1
           FROM "Transaction" AS txn
           LEFT JOIN "AgentCompanyConfig" AS config
             ON config."companyId" = txn."companyId"
           JOIN "Company" AS company
             ON company."id" = txn."companyId"
           WHERE txn."id" = job."transactionId"
             AND txn."companyId" = job."companyId"
             AND (
               txn."status" <> 'PENDING'
               OR txn."revision" <> job."revision"
               OR config."companyId" IS NULL
               OR config."mode" <> 'shadow'
               OR config."configVersion" <> job."configVersion"
               OR config."schedulingGeneration" <> job."schedulingGeneration"
               OR company."disconnectedAt" IS NOT NULL
             )
         )
       RETURNING job."id"`,
      cancelledAt,
      job.id,
      owner,
      job.attemptCount,
    );
    if (rows.length !== 1) return false;
    await tx.$queryRawUnsafe(
      `UPDATE "AgentRun"
       SET "status" = 'failed',
           "errorCode" = 'AGENT_SUPERSEDED',
           "completedAt" = $1
       WHERE "jobId" = $2
         AND "attemptCount" = $3
         AND "status" = 'running'`,
      cancelledAt,
      job.id,
      job.attemptCount,
    );
    return true;
  });
}

/** Renew only a still-active lease owned by this worker. */
export async function renewJobLease(
  jobId: string,
  owner: string,
  expectedAttemptCount: number,
  deps: AgentJobDeps = defaultDeps,
): Promise<boolean> {
  assertIdentifier(jobId);
  assertIdentifier(owner);
  assertAttemptCount(expectedAttemptCount);
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT 1 AS "locked"
       FROM pg_advisory_xact_lock(${CLAIM_CAPACITY_LOCK})`,
    );
    const renewedAt = await currentTime(tx, deps);
    const requestedExpiry = new Date(renewedAt.getTime() + LEASE_MS);
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "AgentJob"
       SET "leaseExpiresAt" = GREATEST("leaseExpiresAt", $1), "updatedAt" = $2
       WHERE "id" = $3
         AND "status" = 'running'
         AND "lockOwner" = $4
         AND "attemptCount" = $5
         AND "leaseExpiresAt" > $2
       RETURNING "id"`,
      requestedExpiry,
      renewedAt,
      jobId,
      owner,
      expectedAttemptCount,
    );
    return rows.length === 1;
  });
}

/**
 * Finishes a job only while its owner still holds an active lease. A transient
 * result is the caller's provider-failure classification; this layer merely
 * applies the bounded retry policy and persists a safe error code.
 */
export async function finishAgentJob(
  jobId: string,
  owner: string,
  expectedAttemptCount: number,
  result: FinishAgentJobResult,
  deps: AgentJobDeps = defaultDeps,
): Promise<AgentJob | null> {
  assertIdentifier(jobId);
  assertIdentifier(owner);
  assertAttemptCount(expectedAttemptCount);
  validateFinishResult(result);
  return deps.db.$transaction(async (tx) => {
    const finishedAt = await currentTime(tx, deps);
    const firstRetryAt = new Date(finishedAt.getTime() + retryDelayMs(1));
    const secondRetryAt = new Date(finishedAt.getTime() + retryDelayMs(2));
    const failure = result.kind === 'failed';
    const transient = failure && result.transient;
    const errorCode = failure ? result.errorCode : null;
    const rows = await tx.$queryRawUnsafe<AgentJob[]>(
    `UPDATE "AgentJob"
     SET "status" = CASE
           WHEN $1 AND "attemptCount" < ${MAX_ATTEMPTS} THEN 'retry'
           WHEN $2 THEN 'completed'
           ELSE 'terminal'
         END,
         "dueAt" = CASE
           WHEN $1 AND "attemptCount" = 1 THEN $3
           WHEN $1 AND "attemptCount" = 2 THEN $4
           ELSE $5
         END,
         "lockOwner" = NULL,
         "leaseExpiresAt" = NULL,
         "lastErrorCode" = $6,
         "updatedAt" = $5
     WHERE "id" = $7
       AND "status" = 'running'
       AND "lockOwner" = $8
       AND "attemptCount" = $9
       AND "leaseExpiresAt" > $5
     RETURNING ${returningColumns()}`,
    transient,
    result.kind === 'completed',
    firstRetryAt,
    secondRetryAt,
    finishedAt,
    errorCode,
    jobId,
    owner,
    expectedAttemptCount,
    );
    return rows[0] ?? null;
  });
}

export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new AgentJobError();
  }
  return [30_000, 120_000, 600_000][attempt - 1]!;
}

function returningColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `${prefix}"id", ${prefix}"companyId", ${prefix}"transactionId", ${prefix}"revision",
    ${prefix}"configVersion", ${prefix}"schedulingGeneration", ${prefix}"status", ${prefix}"dueAt", ${prefix}"lockOwner",
    ${prefix}"leaseExpiresAt", ${prefix}"attemptCount", ${prefix}"lastErrorCode",
    ${prefix}"createdAt", ${prefix}"updatedAt"`;
}

function boundedClaimLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_CLAIM_LIMIT);
}

function validateFinishResult(result: FinishAgentJobResult): void {
  if (!result || (result.kind !== 'completed' && result.kind !== 'failed')) throw new AgentJobError();
  if (result.kind === 'failed') {
    if (typeof result.transient !== 'boolean' || !SAFE_ERROR_CODES.includes(result.errorCode as never)) {
      throw new AgentJobError();
    }
  }
}

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) throw new AgentJobError();
}

function assertAttemptCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS) throw new AgentJobError();
}

async function databaseNow(tx: AgentJobDb): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date | string }[]>(
    'SELECT clock_timestamp() AS "now"',
  );
  const value = rows[0]?.now;
  return checkedDate(value instanceof Date ? value : new Date(value ?? Number.NaN));
}

async function currentTime(tx: AgentJobDb, deps: AgentJobDeps): Promise<Date> {
  return checkedDate(await (deps.now ?? databaseNow)(tx));
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new AgentJobError();
  return value;
}
