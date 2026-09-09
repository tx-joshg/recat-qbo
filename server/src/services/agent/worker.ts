import { agentDecisionSchemaVersion } from './core/decision.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  type AgentModel,
  type AgentModelErrorCode,
} from './core/model.js';
import {
  runShadowDecision,
  type AgentLimits,
  type AgentRunResult,
} from './core/runner.js';
import {
  AgentSnapshotError,
  buildAgentSnapshot,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import {
  type ClaimedAgentJob,
  retryDelayMs,
} from './jobs.js';
import {
  AgentSnapshotSourceError,
  loadAgentSnapshotSourceInTransaction,
  type AgentSnapshotQueryDb,
} from './snapshotLoader.js';

const MAX_ATTEMPTS = 3;
const TRANSIENT_PROVIDER_CODES = new Set<AgentModelErrorCode>([
  'AGENT_MODEL_NETWORK_ERROR',
  'AGENT_MODEL_HTTP_ERROR',
]);

type WorkerTransactionDb = AgentSnapshotQueryDb;

export interface ShadowWorkerDb {
  $transaction<T>(
    callback: (tx: WorkerTransactionDb) => Promise<T>,
    options?: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

export interface ShadowWorkerDeps {
  readonly db: ShadowWorkerDb;
  readonly workerId: string;
  readonly decisionModel: AgentModel;
  readonly reviewModel: AgentModel;
  readonly limits: Partial<AgentLimits>;
  readonly now?: (tx: WorkerTransactionDb) => Promise<Date> | Date;
  /** Deterministic crash/race seams used by the durable PostgreSQL tests. */
  readonly afterStarted?: () => Promise<void> | void;
  readonly beforeComplete?: () => Promise<void> | void;
}

interface LockedJobRow {
  id: unknown;
  companyId: unknown;
  transactionId: unknown;
  revision: unknown;
  configVersion: unknown;
  status: unknown;
  lockOwner: unknown;
  leaseExpiresAt: unknown;
  attemptCount: unknown;
  transactionStatus: unknown;
  transactionRevision: unknown;
  disconnectedAt: unknown;
  mode: unknown;
  currentConfigVersion: unknown;
  schedulingGeneration: unknown;
  currentSchedulingGeneration: unknown;
  provider: unknown;
  decisionModel: unknown;
  verifierModel: unknown;
  limits: unknown;
}

interface StartedRunRow {
  id: string;
}

type PreparedRun =
  | { kind: 'ready'; runId: string; snapshot: AgentTransactionSnapshot }
  | { kind: 'skip' };

export class ShadowWorkerError extends Error {
  readonly code = 'AGENT_WORKER_INVALID';

  constructor() {
    super('Invalid shadow worker operation.');
    this.name = 'ShadowWorkerError';
  }
}

export async function runClaimedShadowJob(
  job: ClaimedAgentJob,
  deps: ShadowWorkerDeps,
): Promise<void> {
  validateInvocation(job, deps);
  const prepared = await prepareRun(job, deps);
  if (prepared.kind === 'skip') return;

  await deps.afterStarted?.();
  if (!await confirmInferenceFence(job, prepared.runId, deps)) return;

  const result = await runShadowDecision(prepared.snapshot, {
    model: deps.decisionModel,
    reviewModel: deps.reviewModel,
    limits: deps.limits,
  });
  await deps.beforeComplete?.();
  await completeRunAndJob(job, prepared.runId, result, deps);
}

/**
 * Reuses the durable claimed-job/run start fence for the outer live worker.
 * Live orchestration refreshes QBO and rechecks authority only after this
 * bounded database transaction has committed.
 */
export async function beginClaimedLiveRun(
  job: ClaimedAgentJob,
  deps: ShadowWorkerDeps,
): Promise<{ readonly runId: string } | null> {
  validateInvocation(job, deps);
  const prepared = await prepareRun(job, deps);
  return prepared.kind === 'ready' ? { runId: prepared.runId } : null;
}

async function prepareRun(
  job: ClaimedAgentJob,
  deps: ShadowWorkerDeps,
): Promise<PreparedRun> {
  return deps.db.$transaction(async (tx) => {
    const now = await currentTime(tx, deps);
    const locked = await lockJob(job.id, tx);
    if (locked === undefined || !holdsLease(locked, job, deps.workerId, now)) {
      return { kind: 'skip' };
    }
    if (!isFresh(locked, job)) {
      await cancelSuperseded(job, deps.workerId, now, tx);
      return { kind: 'skip' };
    }
    if (!configurationMatches(locked, deps)) {
      await terminalizeBeforeRun(
        job,
        deps.workerId,
        now,
        'AGENT_MODEL_CONFIG_INVALID',
        tx,
      );
      return { kind: 'skip' };
    }

    let snapshot: AgentTransactionSnapshot;
    try {
      const source = await loadAgentSnapshotSourceInTransaction(
        job.companyId,
        job.transactionId,
        tx,
      );
      if (
        source.transaction.revision !== job.revision
        || source.configurationVersion !== job.configVersion
      ) {
        await cancelSuperseded(job, deps.workerId, now, tx);
        return { kind: 'skip' };
      }
      snapshot = buildAgentSnapshot(source);
    } catch (error) {
      if (error instanceof AgentSnapshotSourceError || error instanceof AgentSnapshotError) {
        await terminalizeBeforeRun(
          job,
          deps.workerId,
          now,
          'AGENT_MODEL_INPUT_INVALID',
          tx,
        );
        return { kind: 'skip' };
      }
      throw error;
    }

    await tx.$queryRawUnsafe(
      `UPDATE "AgentRun"
       SET "status" = 'failed',
           "errorCode" = 'AGENT_RUN_ABANDONED',
           "completedAt" = $1
       WHERE "jobId" = $2
         AND "attemptCount" < $3
         AND "status" = 'running'`,
      now,
      job.id,
      job.attemptCount,
    );

    const verifierKind = deps.decisionModel.identity.provider === deps.reviewModel.identity.provider
      && deps.decisionModel.identity.model === deps.reviewModel.identity.model
      ? 'same_model'
      : 'distinct_model';
    const inserted = await tx.$queryRawUnsafe<StartedRunRow[]>(
      `INSERT INTO "AgentRun" (
         "id", "jobId", "companyId", "transactionId", "revision",
         "configVersion", "attemptCount", "status", "snapshot",
         "decisionModel", "verifierModel", "verifierKind",
         "promptVersion", "schemaVersion", "createdAt"
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'running', $7::jsonb,
         $8, $9, $10, $11, $12, $13
       )
       ON CONFLICT ("jobId", "attemptCount") DO NOTHING
       RETURNING "id"`,
      job.id,
      job.companyId,
      job.transactionId,
      job.revision,
      job.configVersion,
      job.attemptCount,
      JSON.stringify(snapshot),
      deps.decisionModel.identity.model,
      deps.reviewModel.identity.model,
      verifierKind,
      AGENT_MODEL_PROMPT_VERSION,
      String(agentDecisionSchemaVersion),
      now,
    );
    const runId = inserted[0]?.id;
    return runId === undefined
      ? { kind: 'skip' }
      : { kind: 'ready', runId, snapshot };
  }, { isolationLevel: 'RepeatableRead' });
}

async function confirmInferenceFence(
  job: ClaimedAgentJob,
  runId: string,
  deps: ShadowWorkerDeps,
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    const now = await currentTime(tx, deps);
    const locked = await lockJob(job.id, tx);
    if (locked === undefined || !holdsLease(locked, job, deps.workerId, now)) {
      await closeLostRun(runId, job, now, tx);
      return false;
    }
    if (!isFresh(locked, job)) {
      const cancelled = await cancelSuperseded(job, deps.workerId, now, tx);
      if (cancelled) {
        await closeRun(runId, job, 'AGENT_SUPERSEDED', now, tx);
      }
      return false;
    }
    return true;
  }, { isolationLevel: 'RepeatableRead' });
}

async function completeRunAndJob(
  job: ClaimedAgentJob,
  runId: string,
  result: AgentRunResult,
  deps: ShadowWorkerDeps,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const now = await currentTime(tx, deps);
    const locked = await lockJob(job.id, tx);
    if (locked === undefined || !holdsLease(locked, job, deps.workerId, now)) {
      await closeLostRun(runId, job, now, tx);
      return;
    }
    if (!isFresh(locked, job)) {
      const cancelled = await cancelSuperseded(job, deps.workerId, now, tx);
      if (!cancelled) throw new ShadowWorkerError();
      await closeRun(runId, job, 'AGENT_SUPERSEDED', now, tx);
      return;
    }

    const providerFailure = result.providerFailure;
    const retryableProvider = providerFailure !== undefined
      && providerFailure.classification === 'retryable'
      && TRANSIENT_PROVIDER_CODES.has(providerFailure.code);
    const runStatus = providerFailure !== undefined
      ? 'failed'
      : result.status === 'verified'
        ? 'verified'
        : 'abstain';
    const runErrorCode = providerFailure?.code
      ?? (
        result.status === 'verified' || result.diagnosticCode === 'AGENT_RUN_MODEL_ABSTAIN'
          ? null
          : result.diagnosticCode
      );
    const verification = {
      diagnosticCode: result.diagnosticCode,
      verificationMode: result.verificationMode,
      turns: result.turns,
      toolCalls: result.toolCalls,
      ...(providerFailure === undefined ? {} : { providerFailure }),
    };
    const completedRun = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "AgentRun"
       SET "status" = $1,
           "decision" = $2::jsonb,
           "verification" = $3::jsonb,
           "durationMs" = $4,
           "usage" = $5::jsonb,
           "errorCode" = $6,
           "completedAt" = $7
       WHERE "id" = $8
         AND "jobId" = $9
         AND "attemptCount" = $10
         AND "status" = 'running'
       RETURNING "id"`,
      runStatus,
      JSON.stringify(result.decision),
      JSON.stringify(verification),
      result.durationMs,
      result.usage === undefined ? null : JSON.stringify(result.usage),
      runErrorCode,
      now,
      runId,
      job.id,
      job.attemptCount,
    );
    if (completedRun.length !== 1) throw new ShadowWorkerError();

    const retry = retryableProvider && job.attemptCount < MAX_ATTEMPTS;
    const status = providerFailure === undefined
      ? 'completed'
      : retry
        ? 'retry'
        : 'terminal';
    const dueAt = retry
      ? new Date(now.getTime() + retryDelayMs(job.attemptCount))
      : now;
    const completedJob = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "AgentJob"
       SET "status" = $1,
           "dueAt" = $2,
           "lockOwner" = NULL,
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = $3,
           "updatedAt" = $4
       WHERE "id" = $5
         AND "status" = 'running'
         AND "lockOwner" = $6
         AND "attemptCount" = $7
         AND "leaseExpiresAt" > $4
       RETURNING "id"`,
      status,
      dueAt,
      providerFailure?.code ?? null,
      now,
      job.id,
      deps.workerId,
      job.attemptCount,
    );
    if (completedJob.length !== 1) throw new ShadowWorkerError();
  }, { isolationLevel: 'RepeatableRead' });
}

async function lockJob(
  jobId: string,
  tx: WorkerTransactionDb,
): Promise<LockedJobRow | undefined> {
  const rows = await tx.$queryRawUnsafe<LockedJobRow[]>(
    `WITH locked_job AS MATERIALIZED (
       SELECT *
       FROM "AgentJob"
       WHERE "id" = $1
       FOR UPDATE
     ),
     locked_transaction AS MATERIALIZED (
       SELECT txn."status", txn."revision"
       FROM "Transaction" AS txn
       JOIN locked_job AS job
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       FOR SHARE OF txn
     ),
     locked_config AS MATERIALIZED (
       SELECT config.*
       FROM "AgentCompanyConfig" AS config
       JOIN locked_job AS job ON config."companyId" = job."companyId"
       FOR SHARE OF config
     ),
     locked_company AS MATERIALIZED (
       SELECT company."disconnectedAt"
       FROM "Company" AS company
       JOIN locked_job AS job ON company."id" = job."companyId"
       FOR SHARE OF company
     )
     SELECT job."id", job."companyId", job."transactionId", job."revision",
       job."configVersion", job."schedulingGeneration", job."status", job."lockOwner",
       job."leaseExpiresAt", job."attemptCount",
       txn."status" AS "transactionStatus",
       txn."revision" AS "transactionRevision",
       company."disconnectedAt",
       config."mode", config."configVersion" AS "currentConfigVersion",
       config."schedulingGeneration" AS "currentSchedulingGeneration",
       config."provider", config."decisionModel", config."verifierModel",
       config."limits"
     FROM locked_job AS job
     LEFT JOIN locked_transaction AS txn ON TRUE
     LEFT JOIN locked_config AS config ON TRUE
     LEFT JOIN locked_company AS company ON TRUE`,
    jobId,
  );
  return rows[0];
}

function holdsLease(
  row: LockedJobRow | undefined,
  job: ClaimedAgentJob,
  owner: string,
  now: Date,
): boolean {
  return row !== undefined
    && row.id === job.id
    && row.companyId === job.companyId
    && row.transactionId === job.transactionId
    && row.status === 'running'
    && row.lockOwner === owner
    && row.attemptCount === job.attemptCount
    && checkedDateOrNull(row.leaseExpiresAt)?.getTime()! > now.getTime();
}

function isFresh(row: LockedJobRow, job: ClaimedAgentJob): boolean {
  return row.revision === job.revision
    && row.configVersion === job.configVersion
    && row.transactionStatus === 'PENDING'
    && row.transactionRevision === job.revision
    && row.disconnectedAt === null
    && row.mode === 'shadow'
    && row.currentConfigVersion === job.configVersion
    && row.schedulingGeneration === row.currentSchedulingGeneration;
}

function configurationMatches(row: LockedJobRow, deps: ShadowWorkerDeps): boolean {
  return row.provider === deps.decisionModel.identity.provider
    && row.decisionModel === deps.decisionModel.identity.model
    && row.provider === deps.reviewModel.identity.provider
    && row.verifierModel === deps.reviewModel.identity.model
    && limitsMatch(row.limits, deps.limits);
}

function limitsMatch(stored: unknown, injected: Partial<AgentLimits>): boolean {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  return (Object.keys(injected) as (keyof AgentLimits)[]).length === 5
    && (['maxToolCalls', 'maxTurns', 'maxContextBytes', 'maxResponseBytes', 'timeoutMs'] as const)
      .every((key) => record[key] === injected[key]);
}

async function cancelSuperseded(
  job: ClaimedAgentJob,
  owner: string,
  now: Date,
  tx: WorkerTransactionDb,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentJob"
     SET "status" = 'cancelled',
         "dueAt" = $1,
         "lockOwner" = NULL,
         "leaseExpiresAt" = NULL,
         "lastErrorCode" = 'AGENT_SUPERSEDED',
         "updatedAt" = $1
     WHERE "id" = $2
       AND "status" = 'running'
       AND "lockOwner" = $3
       AND "attemptCount" = $4
       AND "leaseExpiresAt" > $1
     RETURNING "id"`,
    now,
    job.id,
    owner,
    job.attemptCount,
  );
  return rows.length === 1;
}

async function terminalizeBeforeRun(
  job: ClaimedAgentJob,
  owner: string,
  now: Date,
  errorCode: 'AGENT_MODEL_CONFIG_INVALID' | 'AGENT_MODEL_INPUT_INVALID',
  tx: WorkerTransactionDb,
): Promise<void> {
  await tx.$queryRawUnsafe(
    `UPDATE "AgentJob"
     SET "status" = 'terminal',
         "dueAt" = $1,
         "lockOwner" = NULL,
         "leaseExpiresAt" = NULL,
         "lastErrorCode" = $2,
         "updatedAt" = $1
     WHERE "id" = $3
       AND "status" = 'running'
       AND "lockOwner" = $4
       AND "attemptCount" = $5
       AND "leaseExpiresAt" > $1`,
    now,
    errorCode,
    job.id,
    owner,
    job.attemptCount,
  );
}

async function closeLostRun(
  runId: string,
  job: ClaimedAgentJob,
  now: Date,
  tx: WorkerTransactionDb,
): Promise<void> {
  await closeRun(runId, job, 'AGENT_RUN_LEASE_LOST', now, tx);
}

async function closeRun(
  runId: string,
  job: ClaimedAgentJob,
  errorCode: 'AGENT_RUN_LEASE_LOST' | 'AGENT_SUPERSEDED',
  now: Date,
  tx: WorkerTransactionDb,
): Promise<void> {
  await tx.$queryRawUnsafe(
    `UPDATE "AgentRun"
     SET "status" = 'failed',
         "errorCode" = $1,
         "completedAt" = $2
     WHERE "id" = $3
       AND "jobId" = $4
       AND "attemptCount" = $5
       AND "status" = 'running'`,
    errorCode,
    now,
    runId,
    job.id,
    job.attemptCount,
  );
}

async function currentTime(
  tx: WorkerTransactionDb,
  deps: ShadowWorkerDeps,
): Promise<Date> {
  if (deps.now !== undefined) return checkedDate(await deps.now(tx));
  const rows = await tx.$queryRawUnsafe<{ now: Date | string }[]>(
    'SELECT CURRENT_TIMESTAMP AS "now"',
  );
  return checkedDate(rows[0]?.now);
}

function checkedDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) throw new ShadowWorkerError();
  return date;
}

function checkedDateOrNull(value: unknown): Date | null {
  try {
    return checkedDate(value);
  } catch {
    return null;
  }
}

function validateInvocation(job: ClaimedAgentJob, deps: ShadowWorkerDeps): void {
  if (
    job === null
    || typeof job !== 'object'
    || typeof job.id !== 'string'
    || typeof job.companyId !== 'string'
    || typeof job.transactionId !== 'string'
    || job.status !== 'running'
    || job.lockOwner !== deps.workerId
    || !Number.isInteger(job.attemptCount)
    || job.attemptCount < 1
    || job.attemptCount > MAX_ATTEMPTS
    || typeof deps.workerId !== 'string'
    || deps.workerId.trim() === ''
  ) throw new ShadowWorkerError();
}
