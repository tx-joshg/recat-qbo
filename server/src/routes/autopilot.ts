import { Buffer } from 'node:buffer';
import { Router } from 'express';
import { z } from 'zod';
import type {
  AgentCompanySettingsDto,
  AgentRunStatus,
  AutopilotRunOutcome,
  CategorizationMutationResult,
  LiveReadinessDto,
} from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  agentDecisionSchemaVersion,
  parseAgentDecision,
} from '../services/agent/core/decision.js';
import { AGENT_MODEL_PROMPT_VERSION } from '../services/agent/core/model.js';
import {
  getShadowEvidenceSummaryInTransaction,
  type EvaluationQueryDb,
} from '../services/agent/evaluation.js';
import {
  AgentSettingError,
  getAgentSettings,
  type AgentSettingsDb,
  updateShadowSettings,
} from '../services/agent/settings.js';
import {
  getInstanceSettings,
  type InstanceSettingsDb,
} from '../services/instanceSettings.js';
import {
  LIVE_POLICY_VERSION,
  LiveGateError,
  enableLiveModeForAdmin,
  evaluateLiveGates,
} from '../services/agent/liveGates.js';
import {
  ManualLivePauseAuthorizationError,
  pauseLiveModeManually,
} from '../services/agent/circuitBreaker.js';
import {
  LiveReconciliationAuthorizationError,
  LiveReconciliationError,
  loadLiveReconciliationOperation,
  reconcileLiveMutation,
} from '../services/agent/liveReconciliation.js';
import { isCanonicalLiveCheckpoint } from '../services/agent/liveCheckpoint.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_SAFE_CODE_LENGTH = 120;
const MAX_ALIAS_LENGTH = 200;
const LIVE_ACTION_CANDIDATE_LIMIT = 20;

const limitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(8).optional(),
  maxTurns: z.number().int().min(1).max(4).optional(),
  maxContextBytes: z.number().int().min(1).max(65_536).optional(),
  maxResponseBytes: z.number().int().min(1).max(32_768).optional(),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

const settingsPatchSchema = z.object({
  mode: z.enum(['off', 'shadow']).optional(),
  provider: z.enum(['custom', 'openrouter']).optional(),
  decisionModel: z.string().trim().min(1).max(MAX_ALIAS_LENGTH).optional(),
  verifierModel: z.string().trim().min(1).max(MAX_ALIAS_LENGTH).optional(),
  scheduleMinutes: z.number().int().min(1).max(1_440).optional(),
  companyConcurrency: z.number().int().min(1).max(4).optional(),
  evidenceThreshold: z.number().int().min(25).max(1_000).optional(),
  dailyLiveWriteLimit: z.number().int().min(1).max(10_000).optional(),
  limits: limitsSchema.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'At least one setting is required.',
});

const listQuerySchema = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
    .refine((value) => value <= MAX_PAGE_SIZE, `Must be at most ${MAX_PAGE_SIZE}.`)
    .optional(),
}).strict();

const runIdSchema = z.string().uuid();
const emptyBodySchema = z.object({}).strict();
const enableLiveSchema = z.object({
  confirmation: z.string().min(1).max(200),
  acceptedPolicyVersion: z.literal(LIVE_POLICY_VERSION),
}).strict();

type RunRow = {
  id: string;
  jobId: string;
  transactionId: string;
  revision: number;
  configVersion: string;
  attemptCount: number;
  status: string;
  decision: unknown;
  verification: unknown;
  decisionModel: string;
  verifierModel: string;
  promptVersion: string;
  schemaVersion: string;
  durationMs: number | null;
  usage: unknown;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

type MutationProofRow = {
  requestId: string;
  transactionId: string;
  operation: string;
  status: string;
  responseSnapshot: unknown;
  verification: unknown;
  expectedRevision: number;
  createdAt: Date;
  updatedAt: Date;
};

interface RunMutationProof {
  readonly original: MutationProofRow | null;
  readonly restore: MutationProofRow | null;
}

export interface AutopilotSafeRunDto {
  id: string;
  status: AgentRunStatus | 'unavailable';
  outcome: AutopilotRunOutcome;
  operationId: string | null;
  attemptCount: number;
  configVersion: string;
  proposal:
    | {
        kind: 'proposal';
        taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
        confidence: number;
        lineCount: number;
        evidenceKinds: ('category' | 'rule' | 'similar_transaction' | 'tax_code')[];
      }
    | {
        kind: 'abstain';
        reasonCode:
          | 'INSUFFICIENT_CONTEXT'
          | 'CONFLICTING_EVIDENCE'
          | 'UNSUPPORTED_TRANSACTION'
          | 'INVALID_TAX_STATE'
          | 'PROVIDER_FAILURE';
      }
    | null;
  verification: {
    diagnosticCode: string | null;
    verifierKind: 'deterministic' | 'same_model' | 'distinct_model' | 'unavailable';
    evidence: {
      state: 'eligible' | 'invalidated';
      agreement?: boolean;
      invalidationReason?: 'corrected' | 'reverted';
    } | null;
  };
  models: {
    decision: string;
    verifier: string;
    promptVersion: string;
    schemaVersion: string;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  timing: {
    durationMs: number | null;
    createdAt: string;
    completedAt: string | null;
  };
  errorCode: string | null;
}

interface PageCursor {
  createdAt: Date;
  id: string;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= MAX_SAFE_CODE_LENGTH
    && /^AGENT_[A-Z0-9_]+$/.test(value)
    ? value
    : null;
}

function safeAlias(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ALIAS_LENGTH
    ? trimmed
    : 'unavailable';
}

function safeConfigVersion(value: string): string {
  return /^[0-9a-f]{64}$/.test(value) ? value : 'unavailable';
}

function safePromptVersion(value: string): string {
  return value === AGENT_MODEL_PROMPT_VERSION ? value : 'unavailable';
}

function safeSchemaVersion(value: string): string {
  return value === String(agentDecisionSchemaVersion) ? value : 'unavailable';
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function projectProposal(value: unknown): AutopilotSafeRunDto['proposal'] {
  try {
    const decision = parseAgentDecision({ decision: value });
    if (decision.kind === 'abstain') {
      return { kind: 'abstain', reasonCode: decision.reasonCode };
    }
    return {
      kind: 'proposal',
      taxCalculation: decision.taxCalculation,
      confidence: decision.confidence,
      lineCount: decision.lines.length,
      evidenceKinds: [...new Set(decision.evidence.map((entry) => entry.kind))].sort(),
    };
  } catch {
    return null;
  }
}

function projectEvidence(value: unknown): AutopilotSafeRunDto['verification']['evidence'] {
  const evidence = runtimeRecord(runtimeRecord(value)?.evidenceEvaluation);
  if (evidence?.state === 'eligible' && typeof evidence.agreement === 'boolean') {
    return { state: 'eligible', agreement: evidence.agreement };
  }
  if (
    evidence?.state === 'invalidated'
    && (evidence.invalidationReason === 'corrected' || evidence.invalidationReason === 'reverted')
  ) {
    return {
      state: 'invalidated',
      invalidationReason: evidence.invalidationReason,
    };
  }
  return null;
}

function verifierKind(value: unknown): AutopilotSafeRunDto['verification']['verifierKind'] {
  return value === 'same_model' || value === 'distinct_model' || value === 'deterministic'
    ? value
    : 'unavailable';
}

function runStatus(value: string): AgentRunStatus | 'unavailable' {
  return value === 'running'
    || value === 'verified'
    || value === 'abstain'
    || value === 'failed'
    || value === 'posted_verified'
    || value === 'dry_run'
    || value === 'unchanged'
    || value === 'uncertain'
    || value === 'retryable'
    ? value
    : 'unavailable';
}

function exactMutationProof(
  run: RunRow,
  proofs: RunMutationProof,
): proofs is RunMutationProof & { original: MutationProofRow } {
  const proof = proofs.original;
  return proof !== null
    && Number.isSafeInteger(run.revision)
    && run.revision >= 0
    && Number.isSafeInteger(run.revision + 1)
    && proof.expectedRevision === run.revision + 1
    && proof.requestId === run.jobId
    && proof.transactionId === run.transactionId
    && proof.operation === 'recategorize';
}

function canonicalPostedProof(
  run: RunRow,
  proofs: RunMutationProof,
): boolean {
  if (!exactMutationProof(run, proofs)) return false;
  const proof = proofs.original;
  const durableVerification = runtimeRecord(proof.verification);
  return proof.status === 'VERIFIED'
    && runtimeRecord(proof.responseSnapshot) !== null
    && durableVerification?.outcome === 'VERIFIED'
    && durableVerification.status === 'POSTED';
}

function canonicalLiveAttempt(
  run: RunRow,
  proofs: RunMutationProof,
  status: 'DRY_RUN' | 'UNCHANGED' | 'UNCERTAIN' | 'RETRYABLE',
): boolean {
  if (!exactMutationProof(run, proofs)) return false;
  const proof = proofs.original;
  const durableVerification = runtimeRecord(proof.verification);
  if (status === 'DRY_RUN') {
    return proof.status === 'DRY_RUN'
      && durableVerification?.outcome === 'DRY_RUN'
      && durableVerification.status === 'DRY_RUN';
  }
  if (status === 'UNCHANGED') {
    return proof.status === 'UNCHANGED'
      && runtimeRecord(proof.responseSnapshot) !== null
      && durableVerification?.outcome === 'UNCHANGED'
      && durableVerification.status === 'PENDING';
  }
  if (status === 'UNCERTAIN') {
    return proof.status === 'COMMITTING' || proof.status === 'UNCERTAIN';
  }
  return proof.status === 'RETRYABLE';
}

function canonicalRevertedProof(
  run: RunRow,
  proofs: RunMutationProof,
): boolean {
  if (!canonicalPostedProof(run, proofs)) return false;
  const original = proofs.original;
  const restore = proofs.restore;
  const invalidation = revertedInvalidation(run);
  if (original === null || restore === null || invalidation === null) return false;
  const durableVerification = runtimeRecord(restore.verification);
  return restore.requestId === invalidation.outcomeRequestId
    && restore.requestId !== original.requestId
    && restore.transactionId === original.transactionId
    && restore.operation === 'restore'
    && restore.expectedRevision === original.expectedRevision
    && invalidation.inputRevision === original.expectedRevision
    && restore.createdAt instanceof Date
    && original.createdAt instanceof Date
    && restore.createdAt.getTime() > original.createdAt.getTime()
    && restore.updatedAt instanceof Date
    && restore.updatedAt.getTime() >= restore.createdAt.getTime()
    && restore.status === 'VERIFIED'
    && runtimeRecord(restore.responseSnapshot) !== null
    && durableVerification?.outcome === 'VERIFIED'
    && durableVerification.status === 'REVERTED';
}

function revertedInvalidation(run: RunRow): {
  readonly outcomeRequestId: string;
  readonly inputRevision: number;
} | null {
  const evidence = runtimeRecord(runtimeRecord(run.verification)?.evidenceEvaluation);
  return evidence?.state === 'invalidated'
    && evidence.invalidationReason === 'reverted'
    && typeof evidence.outcomeRequestId === 'string'
    && evidence.outcomeRequestId.trim() !== ''
    && Number.isSafeInteger(evidence.inputRevision)
    && Number(evidence.inputRevision) >= 1
    ? {
        outcomeRequestId: evidence.outcomeRequestId,
        inputRevision: Number(evidence.inputRevision),
      }
    : null;
}

function safeOutcome(
  run: RunRow,
  proofs: RunMutationProof = { original: null, restore: null },
): AutopilotRunOutcome {
  const status = runStatus(run.status);
  const verification = runtimeRecord(run.verification);
  const mutation = runtimeRecord(verification?.mutation);
  const liveOutcome = verification?.liveOutcome;
  if (status === 'running') return 'in_progress';
  if (status === 'verified') {
    return verification?.diagnosticCode === 'AGENT_RUN_VERIFIED'
      && (
        verification.verificationMode === 'distinct_model'
        || verification.verificationMode === 'deterministic'
      )
      ? 'shadow_verified'
      : 'shadow_proposed';
  }
  if (status === 'abstain') return 'abstained';
  if (status === 'failed') return 'failed_before_write';
  if (status === 'posted_verified' && revertedInvalidation(run) !== null) {
    return verification?.verificationMode === 'distinct_model'
      && canonicalRevertedProof(run, proofs)
      ? 'reverted'
      : 'unavailable';
  }
  if (status === 'posted_verified') {
    if (
      mutation?.outcome !== 'VERIFIED'
      || mutation.status !== 'POSTED'
      || mutation.requestId !== run.jobId
      || verification?.verificationMode !== 'distinct_model'
      || !canonicalPostedProof(run, proofs)
    ) return 'unavailable';
    return liveOutcome === 'reconciled_posted'
      ? 'reconciled_posted'
      : liveOutcome === 'posted_verified'
        ? 'posted_verified'
        : 'unavailable';
  }
  if (
    status === 'dry_run'
    && liveOutcome === 'dry_run'
    && mutation?.outcome === 'DRY_RUN'
    && mutation.status === 'DRY_RUN'
    && mutation.requestId === run.jobId
    && canonicalLiveAttempt(run, proofs, 'DRY_RUN')
  ) return 'dry_run';
  if (status === 'unchanged') {
    return liveOutcome === 'reconciled_unchanged'
      && mutation?.outcome === 'UNCHANGED'
      && mutation.requestId === run.jobId
      && canonicalLiveAttempt(run, proofs, 'UNCHANGED')
      ? 'reconciled_unchanged'
      : 'unavailable';
  }
  if (status === 'uncertain') {
    if (
      mutation?.outcome !== 'UNCERTAIN'
      || mutation.requestId !== run.jobId
      || !canonicalLiveAttempt(run, proofs, 'UNCERTAIN')
    ) return 'unavailable';
    return run.errorCode === 'QBO_READBACK_MISMATCH'
      || liveOutcome === 'readback_mismatch'
      ? 'readback_mismatch'
      : 'possible_write_uncertain';
  }
  if (
    status === 'retryable'
    && mutation?.outcome === 'RETRYABLE'
    && mutation.requestId === run.jobId
    && canonicalLiveAttempt(run, proofs, 'RETRYABLE')
  ) return 'retrying';
  return 'unavailable';
}

function reconciliationOperationId(
  run: RunRow,
  proofs: RunMutationProof,
): string | null {
  const verification = runtimeRecord(run.verification);
  const mutation = runtimeRecord(verification?.mutation);
  const operationId = runIdSchema.safeParse(run.id);
  return run.status === 'uncertain'
    && operationId.success
    && mutation?.outcome === 'UNCERTAIN'
    && mutation.requestId === run.jobId
    && canonicalLiveAttempt(run, proofs, 'UNCERTAIN')
    && (
      run.errorCode === 'LIVE_RECONCILIATION_REQUIRED'
      || run.errorCode === 'QBO_READBACK_MISMATCH'
    )
    && isCanonicalLiveCheckpoint(
      verification?.liveCheckpoint,
      {
        snapshotRevision: run.revision,
        decisionModel: run.decisionModel,
        verifierModel: run.verifierModel,
      },
    )
    ? operationId.data
    : null;
}

function projectUsage(value: unknown): AutopilotSafeRunDto['usage'] {
  const usage = runtimeRecord(value);
  if (usage === null) return null;
  const inputTokens = safeNonnegativeInteger(usage.inputTokens);
  const outputTokens = safeNonnegativeInteger(usage.outputTokens);
  const totalTokens = safeNonnegativeInteger(usage.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function toAutopilotSafeRunDto(
  run: RunRow,
  proofs: RunMutationProof = { original: null, restore: null },
): AutopilotSafeRunDto {
  const verification = runtimeRecord(run.verification);
  const durationMs = safeNonnegativeInteger(run.durationMs);
  return {
    id: run.id,
    status: runStatus(run.status),
    outcome: safeOutcome(run, proofs),
    operationId: reconciliationOperationId(run, proofs),
    attemptCount: safeNonnegativeInteger(run.attemptCount) ?? 0,
    configVersion: safeConfigVersion(run.configVersion),
    proposal: projectProposal(run.decision),
    verification: {
      diagnosticCode: safeCode(verification?.diagnosticCode),
      verifierKind: verifierKind(verification?.verificationMode),
      evidence: projectEvidence(run.verification),
    },
    models: {
      decision: safeAlias(run.decisionModel),
      verifier: safeAlias(run.verifierModel),
      promptVersion: safePromptVersion(run.promptVersion),
      schemaVersion: safeSchemaVersion(run.schemaVersion),
    },
    usage: projectUsage(run.usage),
    timing: {
      durationMs: durationMs ?? null,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    },
    errorCode: safeCode(run.errorCode),
  };
}

function encodeCursor(row: Pick<RunRow, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id]), 'utf8')
    .toString('base64url');
}

function decodeCursor(value: string): PageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== 'string'
      || typeof decoded[1] !== 'string'
      || decoded[1].length < 1
      || decoded[1].length > 200
    ) {
      throw new Error('invalid');
    }
    const createdAt = new Date(decoded[0]);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== decoded[0]) {
      throw new Error('invalid');
    }
    return { createdAt, id: decoded[1] };
  } catch {
    throw new HttpError(400, 'Invalid request: malformed cursor', 'VALIDATION');
  }
}

function runSelect() {
  return {
    id: true,
    jobId: true,
    transactionId: true,
    revision: true,
    configVersion: true,
    attemptCount: true,
    status: true,
    decision: true,
    verification: true,
    decisionModel: true,
    verifierModel: true,
    promptVersion: true,
    schemaVersion: true,
    durationMs: true,
    usage: true,
    errorCode: true,
    createdAt: true,
    completedAt: true,
  } as const;
}

async function mutationProofs(
  runs: readonly RunRow[],
): Promise<Map<string, RunMutationProof>> {
  if (runs.length === 0) return new Map();
  const restoreRequestIds = runs.flatMap((run) => {
    const invalidation = revertedInvalidation(run);
    return invalidation === null ? [] : [invalidation.outcomeRequestId];
  });
  const rows = await prisma.qboMutationAttempt.findMany({
    where: {
      requestId: {
        in: [...new Set([
          ...runs.map((run) => run.jobId),
          ...restoreRequestIds,
        ])],
      },
      transactionId: { in: [...new Set(runs.map((run) => run.transactionId))] },
    },
    select: {
      requestId: true,
      transactionId: true,
      operation: true,
      status: true,
      responseSnapshot: true,
      verification: true,
      expectedRevision: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const byRequest = new Map(rows.map((row) => [row.requestId, row]));
  return new Map(runs.map((run) => {
    const invalidation = revertedInvalidation(run);
    const original = byRequest.get(run.jobId);
    const restore = invalidation === null
      ? undefined
      : byRequest.get(invalidation.outcomeRequestId);
    return [run.jobId, {
      original:
        original?.transactionId === run.transactionId ? original : null,
      restore:
        restore?.transactionId === run.transactionId ? restore : null,
    }] as const;
  }));
}

function isActualLiveAction(
  run: RunRow,
  proofs: RunMutationProof,
  outcome: AutopilotRunOutcome,
): boolean {
  const verification = runtimeRecord(run.verification);
  const mutation = runtimeRecord(verification?.mutation);
  if (
    !isCanonicalLiveCheckpoint(
      verification?.liveCheckpoint,
      {
        snapshotRevision: run.revision,
        decisionModel: run.decisionModel,
        verifierModel: run.verifierModel,
      },
    )
    || mutation?.requestId !== run.jobId
    || !exactMutationProof(run, proofs)
  ) return false;
  if (outcome === 'posted_verified' || outcome === 'reconciled_posted') {
    return canonicalPostedProof(run, proofs);
  }
  if (outcome === 'reverted') return canonicalRevertedProof(run, proofs);
  const proof = proofs.original;
  if (proof === null) return false;
  if (outcome === 'dry_run') return proof.status === 'DRY_RUN';
  if (outcome === 'reconciled_unchanged') return proof.status === 'UNCHANGED';
  if (outcome === 'possible_write_uncertain' || outcome === 'readback_mismatch') {
    return proof.status === 'COMMITTING' || proof.status === 'UNCERTAIN';
  }
  if (outcome === 'retrying') return proof.status === 'RETRYABLE';
  return false;
}

interface QueueDb {
  agentJob: Pick<typeof prisma.agentJob, 'count' | 'findFirst'>;
}

interface LiveWriteUsageDb {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
}

async function liveWriteUsage(companyId: string, limit: number, db: LiveWriteUsageDb) {
  // resetsInMs is computed here, in the same statement and off the same
  // database clock as the day itself. It is deliberately *relative*: the cap
  // resets on PostgreSQL's UTC day, and a browser is not an authority on that.
  // Any scheme comparing the two absolute clocks fails under skew — suppressing
  // a live cap for a whole day one way, refreshing late by the full offset the
  // other. Elapsed time measured locally is reliable; agreement on wall-clock
  // is not. See #32.
  const rows = await db.$queryRawUnsafe<{
    utcDay: string;
    used: bigint;
    resetsInMs: bigint;
  }[]>(
    `SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "utcDay",
            COUNT(permit.*)::bigint AS "used",
            GREATEST(
              0,
              CEIL(EXTRACT(EPOCH FROM (
                ((clock_timestamp() AT TIME ZONE 'UTC')::date + INTERVAL '1 day')
                  - (clock_timestamp() AT TIME ZONE 'UTC')
              )) * 1000)
            )::bigint AS "resetsInMs"
       FROM "LiveWritePermit" permit
      WHERE permit."companyId" = $1
        AND permit."utcDay" = (clock_timestamp() AT TIME ZONE 'UTC')::date`,
    companyId,
  );
  return {
    utcDay: rows[0]?.utcDay ?? new Date().toISOString().slice(0, 10),
    used: Number(rows[0]?.used ?? 0n),
    limit,
    // A day is the ceiling: a nonsensical value must not schedule a refresh
    // years out, and the floor lives on the client so a bad one cannot loop.
    resetsInMs: Math.min(Number(rows[0]?.resetsInMs ?? 86_400_000n), 86_400_000),
  };
}

async function queueHealth(companyId: string, db: QueueDb) {
  const [queued, running, retrying, terminal, cancelled, oldest, nextLease] = await Promise.all([
    db.agentJob.count({ where: { companyId, status: 'queued' } }),
    db.agentJob.count({ where: { companyId, status: 'running' } }),
    db.agentJob.count({ where: { companyId, status: 'retry' } }),
    db.agentJob.count({ where: { companyId, status: 'terminal' } }),
    db.agentJob.count({ where: { companyId, status: 'cancelled' } }),
    db.agentJob.findFirst({
      where: { companyId, status: { in: ['queued', 'retry'] } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { dueAt: true },
    }),
    db.agentJob.findFirst({
      where: { companyId, status: 'running' },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
      select: { leaseExpiresAt: true },
    }),
  ]);
  return {
    queued,
    running,
    retrying,
    terminal,
    cancelled,
    earliestDueAt: oldest?.dueAt.toISOString() ?? null,
    earliestLeaseExpiryAt: nextLease?.leaseExpiresAt?.toISOString() ?? null,
  };
}

async function overview(companyId: string) {
  return prisma.$transaction(async (tx) => {
    const [settings, evidence, queue] = await Promise.all([
      getAgentSettings(companyId, {
        db: tx as unknown as AgentSettingsDb,
        getInstanceSettings: () =>
          getInstanceSettings(tx as unknown as InstanceSettingsDb),
      }),
      getShadowEvidenceSummaryInTransaction(
        companyId,
        tx as unknown as EvaluationQueryDb,
      ),
      queueHealth(companyId, tx as unknown as QueueDb),
    ]);
    const liveWrites = await liveWriteUsage(
      companyId,
      settings.dailyLiveWriteLimit,
      tx as unknown as LiveWriteUsageDb,
    );
    return { settings, liveWrites, queue, evidence };
  }, { isolationLevel: 'RepeatableRead' });
}

function companyId(req: { company?: { id: string } }): string {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company.id;
}

function requireConnectedCompany(req: {
  company?: { disconnectedAt: Date | null };
}): void {
  if (req.company?.disconnectedAt !== null) {
    throw new HttpError(
      409,
      'Live controls are unavailable for a disconnected company.',
      'COMPANY_DISCONNECTED',
    );
  }
}

function authenticatedUser(req: {
  user?: { id: string; name: string | null; email: string };
}): { id: string; label: string } {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return {
    id: req.user.id,
    label: req.user.name?.trim() || req.user.email,
  };
}

async function currentLiveReadiness(id: string): Promise<LiveReadinessDto> {
  const readiness = await evaluateLiveGates(id);
  if (readiness.lastAction !== null) return readiness;
  const [recentRows, restoreLinkedRows] = await Promise.all([
    prisma.agentRun.findMany({
      where: {
        companyId: id,
        status: {
          in: [
            'posted_verified',
            'dry_run',
            'unchanged',
            'uncertain',
            'retryable',
          ],
        },
        completedAt: { not: null },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: LIVE_ACTION_CANDIDATE_LIMIT,
      select: runSelect(),
    }),
    prisma.$queryRawUnsafe<RunRow[]>(
      `SELECT run."id",
              run."jobId",
              run."transactionId",
              run."revision",
              run."configVersion",
              run."attemptCount",
              run."status",
              run."decision",
              run."verification",
              run."decisionModel",
              run."verifierModel",
              run."promptVersion",
              run."schemaVersion",
              run."durationMs",
              run."usage",
              run."errorCode",
              run."createdAt",
              run."completedAt"
         FROM "AgentRun" run
         JOIN "Transaction" txn
           ON txn."id" = run."transactionId"
          AND txn."companyId" = run."companyId"
         JOIN "QboMutationAttempt" original
           ON original."requestId" = run."jobId"
          AND original."transactionId" = run."transactionId"
          AND original."operation" = 'recategorize'
          AND original."status" = 'VERIFIED'
          AND original."expectedRevision" = run."revision" + 1
          AND jsonb_typeof(original."responseSnapshot") = 'object'
          AND original."verification" ->> 'outcome' = 'VERIFIED'
          AND original."verification" ->> 'status' = 'POSTED'
         JOIN "QboMutationAttempt" restore
           ON restore."requestId" =
                run."verification" #>> '{evidenceEvaluation,outcomeRequestId}'
          AND restore."requestId" <> original."requestId"
          AND restore."transactionId" = original."transactionId"
          AND restore."operation" = 'restore'
          AND restore."expectedRevision" = original."expectedRevision"
          AND restore."createdAt" > original."createdAt"
          AND restore."updatedAt" >= restore."createdAt"
          AND restore."status" = 'VERIFIED'
          AND jsonb_typeof(restore."responseSnapshot") = 'object'
          AND restore."verification" ->> 'outcome' = 'VERIFIED'
          AND restore."verification" ->> 'status' = 'REVERTED'
        WHERE run."companyId" = $1
          AND run."status" = 'posted_verified'
          AND run."completedAt" IS NOT NULL
          AND run."revision" >= 0
          AND run."revision" < 2147483647
          AND run."verification" ->> 'verificationMode' = 'distinct_model'
          AND run."verification" -> 'mutation' ->> 'requestId' = run."jobId"
          AND run."verification" -> 'mutation' ->> 'outcome' = 'VERIFIED'
          AND run."verification" -> 'mutation' ->> 'status' = 'POSTED'
          AND run."verification" #>> '{evidenceEvaluation,state}' = 'invalidated'
          AND run."verification" #>> '{evidenceEvaluation,invalidationReason}' = 'reverted'
          AND jsonb_typeof(
                run."verification" #> '{evidenceEvaluation,inputRevision}'
              ) = 'number'
          AND run."verification" #> '{evidenceEvaluation,inputRevision}' =
                to_jsonb(original."expectedRevision")
        ORDER BY restore."updatedAt" DESC, restore."id" DESC
        LIMIT 20`,
      id,
    ),
  ]);
  const rows = [...new Map(
    [...recentRows, ...restoreLinkedRows].map((row) => [row.id, row] as const),
  ).values()];
  const proofs = await mutationProofs(rows);
  const action = rows
    .flatMap((row) => {
      const proof = proofs.get(row.jobId) ?? { original: null, restore: null };
      const outcome = safeOutcome(row, proof);
      return isActualLiveAction(row, proof, outcome)
        ? [{
            row,
            outcome,
            at:
              outcome === 'reverted' && proof.restore !== null
                ? proof.restore.updatedAt
                : row.completedAt ?? row.createdAt,
          }]
        : [];
    })
    .sort((left, right) =>
      right.at.getTime() - left.at.getTime()
      || right.row.id.localeCompare(left.row.id))[0];
  if (action === undefined) return readiness;
  return {
    ...readiness,
    lastAction: {
      outcome: action.outcome,
      at: action.at.toISOString(),
    },
  };
}

function safeReconciliationResult(
  result: CategorizationMutationResult,
): Omit<CategorizationMutationResult, 'transactionId' | 'requestId'> {
  const base = {
    ok: result.ok,
    status: result.status,
    outcome: result.outcome,
  };
  if (result.outcome === 'IN_PROGRESS') {
    return {
      ...base,
      error: {
        code: 'MUTATION_IN_PROGRESS',
        message: 'Reconciliation is already in progress.',
      },
    };
  }
  if (result.outcome === 'UNCERTAIN') {
    return {
      ...base,
      error: {
        code: result.error?.code === 'QBO_READBACK_MISMATCH'
          ? 'QBO_READBACK_MISMATCH'
          : 'LIVE_RECONCILIATION_REQUIRED',
        message: result.error?.code === 'QBO_READBACK_MISMATCH'
          ? 'QuickBooks readback did not match durable intent.'
          : 'Outcome uncertain — verify in QuickBooks.',
      },
    };
  }
  return base;
}

function mapLiveControlError(error: unknown): never {
  if (
    error instanceof LiveReconciliationAuthorizationError
    || error instanceof ManualLivePauseAuthorizationError
    || (error instanceof LiveGateError && error.code === 'LIVE_ADMIN_REQUIRED')
    || (
      error instanceof Error
      && error.name === 'WritebackLifecycleError'
      && 'code' in error
      && error.code === 'FORBIDDEN'
    )
  ) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
  if (error instanceof LiveReconciliationError) {
    throw new HttpError(
      409,
      'This live operation is no longer bound to current durable state.',
      error.code,
    );
  }
  if (error instanceof LiveGateError) {
    const status = error.code === 'LIVE_CONFIRMATION_MISMATCH' ? 409 : 400;
    throw new HttpError(
      status,
      error.code === 'LIVE_CONFIRMATION_MISMATCH'
        ? 'Typed company confirmation does not match.'
        : 'Live mode is unavailable.',
      error.code,
    );
  }
  throw error;
}

export const autopilotRouter = Router({ mergeParams: true });
autopilotRouter.use(requireUser, withCompany({ allowDisconnected: true }));

autopilotRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await overview(companyId(req)));
  }),
);

autopilotRouter.patch(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(settingsPatchSchema)(req.body);
    if (req.company?.disconnectedAt != null && body.mode === 'shadow') {
      throw new HttpError(
        409,
        'Shadow autopilot cannot be enabled for a disconnected company.',
        'COMPANY_DISCONNECTED',
      );
    }
    try {
      const updated = await updateShadowSettings(companyId(req), body);
      res.json(updated satisfies AgentCompanySettingsDto);
    } catch (error) {
      if (error instanceof AgentSettingError) {
        throw new HttpError(400, 'Invalid shadow agent settings.', error.code);
      }
      throw error;
    }
  }),
);

autopilotRouter.get(
  '/runs',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const query = validate(listQuerySchema)(req.query);
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await prisma.agentRun.findMany({
      where: {
        companyId: companyId(req),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: runSelect(),
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const proofs = await mutationProofs(page);
    res.json({
      runs: page.map((row) =>
        toAutopilotSafeRunDto(
          row,
          proofs.get(row.jobId) ?? { original: null, restore: null },
        )),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    });
  }),
);

autopilotRouter.get(
  '/runs/:id',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const id = runIdSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, 'Invalid request: malformed run id', 'VALIDATION');
    const run = await prisma.agentRun.findFirst({
      where: { id: id.data, companyId: companyId(req) },
      select: runSelect(),
    });
    if (run === null) throw new HttpError(404, 'Autopilot run not found', 'AGENT_RUN_NOT_FOUND');
    const proofs = await mutationProofs([run]);
    res.json(toAutopilotSafeRunDto(
      run,
      proofs.get(run.jobId) ?? { original: null, restore: null },
    ));
  }),
);

autopilotRouter.get(
  '/live-readiness',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await currentLiveReadiness(companyId(req)));
  }),
);

autopilotRouter.post(
  '/enable-live',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    requireConnectedCompany(req);
    const body = validate(enableLiveSchema)(req.body);
    if (body.confirmation !== req.company?.legalName) {
      throw new HttpError(
        409,
        'Typed company confirmation does not match.',
        'LIVE_CONFIRMATION_MISMATCH',
      );
    }
    try {
      const user = authenticatedUser(req);
      res.json(await enableLiveModeForAdmin(
        companyId(req),
        body.confirmation,
        user.id,
      ));
    } catch (error) {
      mapLiveControlError(error);
    }
  }),
);

autopilotRouter.post(
  '/pause-live',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    requireConnectedCompany(req);
    validate(emptyBodySchema)(req.body);
    try {
      const user = authenticatedUser(req);
      res.json(await pauseLiveModeManually(companyId(req), user.id));
    } catch (error) {
      mapLiveControlError(error);
    }
  }),
);

autopilotRouter.post(
  '/reconcile/:operationId',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    requireConnectedCompany(req);
    validate(emptyBodySchema)(req.body);
    const parsed = runIdSchema.safeParse(req.params.operationId);
    if (!parsed.success) {
      throw new HttpError(400, 'Invalid request: malformed operation id', 'VALIDATION');
    }
    try {
      const id = companyId(req);
      const binding = await loadLiveReconciliationOperation(parsed.data, id);
      if (binding === null) {
        throw new HttpError(
          409,
          'This live operation is no longer bound to current durable state.',
          'LIVE_RECONCILIATION_BINDING_MISMATCH',
        );
      }
      const user = authenticatedUser(req);
      const result = await reconcileLiveMutation(binding, {
        actor: { id: user.id, label: user.label },
      });
      res.status(result.outcome === 'IN_PROGRESS' ? 202 : 200)
        .json(safeReconciliationResult(result));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      mapLiveControlError(error);
    }
  }),
);

autopilotRouter.post(
  '/cancel-queued',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await prisma.agentJob.updateMany({
      where: {
        companyId: companyId(req),
        status: { in: ['queued', 'retry'] },
      },
      data: {
        status: 'cancelled',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_CANCELLED_BY_ADMIN',
      },
    });
    res.json({ cancelled: result.count });
  }),
);
