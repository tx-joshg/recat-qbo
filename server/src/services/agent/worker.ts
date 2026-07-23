import { Prisma, type AgentJob, type PrismaClient } from '@prisma/client';
import type { CategorizeBody } from '@recat/shared';
import { env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import {
  getCodexAccountGeneration,
  getCodexStatus,
} from '../ai/codexAuth.js';
import {
  rollbackAutopilotStaging,
  stageCategorization,
  StagingError,
} from '../categorization.js';
import { getInstanceSettings } from '../instanceSettings.js';
import { postTransaction, type PostResult } from '../writeback.js';
import { CodexAgentModel } from './codexModel.js';
import { loadAgentToolContext, type AgentToolContext } from './context.js';
import {
  AGENT_RUN_PROMPT_VERSION,
  AGENT_TOOL_SCHEMA_VERSION,
  acquireCompanyWriteLease,
  cancelClaimedJob,
  claimNextJob,
  completeJob,
  countValidatedShadowRuns,
  currentAgentInputHash,
  failJob,
  hasCurrentDeterministicRule,
  isCurrentAgentTransactionEligible,
  MIN_LIVE_SHADOW_RUNS,
  renewJobLease,
  releaseCompanyWriteLease,
  retryDelayMs,
  retryJob,
} from './jobs.js';
import type { AgentModel } from './model.js';
import { runAgent, type AgentRunnerResult } from './runner.js';
import { createAgentToolRegistry } from './tools.js';
import {
  validateAgentDecision,
  type DecisionValidationReport,
} from './decision.js';
import { AgentError, asAgentError } from './errors.js';
import { normalizeCandidatePayee, refreshRuleCandidate } from './ruleCandidates.js';
import {
  runVerifier,
  VERIFIER_JSON_SCHEMA,
  type VerifierResult,
} from './verifier.js';

const LEASE_RENEW_MS = 30_000;
const MAX_JOB_ATTEMPTS = 5;

type WorkerDb = PrismaClient;

export interface AgentWorkerDeps {
  db: WorkerDb;
  claim(workerId: string): Promise<AgentJob | null>;
  renew(jobId: string, workerId: string): Promise<boolean>;
  complete(jobId: string, workerId: string, inputHash: string): Promise<boolean>;
  completeShadow(
    job: Pick<AgentJob, 'id' | 'companyId' | 'inputHash'>,
    workerId: string,
    runId: string,
    values: RunFinishValues,
  ): Promise<boolean>;
  retry(
    jobId: string,
    workerId: string,
    inputHash: string,
    error: { code: string; message: string },
    nextAttemptAt: Date,
  ): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    inputHash: string,
    error: { code: string; message: string },
  ): Promise<boolean>;
  cancel(
    jobId: string,
    workerId: string,
    inputHash: string,
    reason: { code: string; message: string },
  ): Promise<boolean>;
  currentHash(
    transactionId: string,
    identity?: { provider: string; model: string },
  ): Promise<string | null>;
  hasRuleMatch(transactionId: string): Promise<boolean>;
  isEligible(transactionId: string, companyId: string): Promise<boolean>;
  loadContext(companyId: string, transactionId: string): Promise<AgentToolContext>;
  model(): Promise<AgentModel>;
  verifierModel(decisionModel: AgentModel): Promise<AgentModel>;
  run(
    model: AgentModel,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<AgentRunnerResult>;
  validate(
    context: AgentToolContext,
    result: AgentRunnerResult,
  ): Promise<DecisionValidationReport>;
  verifyDecision(
    model: AgentModel,
    context: AgentToolContext,
    result: AgentRunnerResult,
    validation: DecisionValidationReport,
    signal: AbortSignal,
  ): Promise<VerifierResult>;
  refreshCandidate(runId: string): Promise<unknown>;
  acquireWriteLease(companyId: string, owner: string): Promise<boolean>;
  releaseWriteLease(companyId: string, owner: string): Promise<void>;
  stage(
    transactionId: string,
    body: CategorizeBody,
    expectedUpdatedAt: Date,
  ): Promise<{ id: string; updatedAt: Date }>;
  rollbackStage(transactionId: string, stagedUpdatedAt: Date): Promise<boolean>;
  post(
    transactionId: string,
    expectedUpdatedAt: Date,
    canWrite: () => boolean | Promise<boolean>,
  ): Promise<PostResult>;
  writeVerification(transactionId: string, post: PostResult): Promise<unknown>;
  deploymentWritesEnabled(): boolean;
  countUnresolvedWrites(companyId: string): Promise<number>;
  countValidatedShadowRuns(
    companyId: string,
    identity: { provider: string; model: string },
  ): Promise<number>;
  providerState(): Promise<{ connected: boolean; generation: string | null }>;
  now(): Date;
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function codexProviderState(
  deps: {
    status: typeof getCodexStatus;
    generation: typeof getCodexAccountGeneration;
  } = { status: getCodexStatus, generation: getCodexAccountGeneration },
): Promise<{ connected: boolean; generation: string | null }> {
  try {
    const status = await deps.status();
    if (!status.connected) return { connected: false, generation: null };
    const generation = await deps.generation();
    return { connected: generation !== null, generation };
  } catch {
    return { connected: false, generation: null };
  }
}

const defaultDeps: AgentWorkerDeps = {
  db: prisma,
  claim: (workerId) => claimNextJob(workerId),
  renew: (jobId, workerId) => renewJobLease(jobId, workerId),
  complete: (jobId, workerId, inputHash) => completeJob(jobId, workerId, inputHash),
  retry: (jobId, workerId, inputHash, error, nextAttemptAt) =>
    retryJob(jobId, workerId, inputHash, error, nextAttemptAt),
  fail: (jobId, workerId, inputHash, error) =>
    failJob(jobId, workerId, inputHash, error),
  cancel: (jobId, workerId, inputHash, reason) =>
    cancelClaimedJob(jobId, workerId, inputHash, reason),
  currentHash: (transactionId, identity) =>
    currentAgentInputHash(transactionId, prisma, identity),
  hasRuleMatch: (transactionId) => hasCurrentDeterministicRule(transactionId),
  isEligible: (transactionId, companyId) =>
    isCurrentAgentTransactionEligible(transactionId, companyId),
  loadContext: (companyId, transactionId) =>
    loadAgentToolContext(prisma, companyId, transactionId),
  model: async () => {
    const settings = await getInstanceSettings();
    return new CodexAgentModel(settings.codexModel);
  },
  verifierModel: async (decisionModel) => {
    return new CodexAgentModel(decisionModel.model, undefined, {
      name: 'recat_agent_verifier',
      schema: VERIFIER_JSON_SCHEMA,
    });
  },
  run: (model, context, signal) =>
    runAgent(model, createAgentToolRegistry(prisma, context), context, { signal }),
  validate: (context, result) => validateAgentDecision(prisma, context, result.decision),
  verifyDecision: (model, context, result, validation, signal) =>
    runVerifier(model, context, result.decision, validation, signal),
  refreshCandidate: (runId) => refreshRuleCandidate(runId, prisma),
  acquireWriteLease: (companyId, owner) => acquireCompanyWriteLease(companyId, owner),
  releaseWriteLease: (companyId, owner) => releaseCompanyWriteLease(companyId, owner),
  stage: (transactionId, body, expectedUpdatedAt) =>
    stageCategorization(prisma, transactionId, body, {
      actor: { id: null, label: 'autopilot' },
      source: 'autopilot',
      expectedUpdatedAt,
      requireNoMatchingRule: true,
    }),
  rollbackStage: (transactionId, stagedUpdatedAt) =>
    rollbackAutopilotStaging(prisma, transactionId, stagedUpdatedAt),
  post: (transactionId, expectedUpdatedAt, canWrite) =>
    postTransaction(
      transactionId,
      { id: null, label: 'autopilot' },
      { auto: true, expectedUpdatedAt, canWrite },
    ),
  writeVerification: async (transactionId, post) => {
    const attempt = await prisma.qboMutationAttempt.findFirst({
      where: { transactionId, operation: 'recategorize' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { requestId: true, status: true, verification: true },
    });
    return {
      applied: post.ok && post.status === 'POSTED',
      post,
      mutation: attempt,
    };
  },
  deploymentWritesEnabled: () => !env.DRY_RUN,
  countUnresolvedWrites: (companyId) =>
    prisma.qboMutationAttempt.count({
      where: {
        transaction: { companyId, status: 'ERROR' },
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
    }),
  countValidatedShadowRuns: (companyId, identity) =>
    countValidatedShadowRuns(companyId, identity),
  providerState: () => codexProviderState(),
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  completeShadow: (job, workerId, runId, values) =>
    completeShadowJob(job, workerId, runId, values),
};

interface RunFinishValues {
  result?: AgentRunnerResult;
  validation?: DecisionValidationReport;
  verification?: unknown;
  verifier?: VerifierResult;
  error?: AgentError;
}

function finishRunData(
  values: RunFinishValues,
  completedAt = new Date(),
): Prisma.AgentRunUpdateManyMutationInput {
  return {
      completedAt,
      ...(values.result
        ? {
            decision: json(values.result.decision),
            toolTrace: json(values.result.toolTrace),
            turnCount: values.result.turnCount,
            toolCallCount: values.result.toolCallCount,
          }
        : {}),
      ...(values.validation ? { validation: json(values.validation) } : {}),
      ...(values.verification !== undefined ? { verification: json(values.verification) } : {}),
      ...(values.verifier !== undefined ? { verifier: json(values.verifier) } : {}),
      ...(values.error
        ? {
            errorCode: values.error.code,
            errorMessage: values.error.message.slice(0, 500),
          }
        : {}),
  };
}

export async function completeShadowJob(
  job: Pick<AgentJob, 'id' | 'companyId' | 'inputHash'>,
  workerId: string,
  runId: string,
  values: RunFinishValues,
  db: WorkerDb = prisma,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const now = new Date();
    const completed = await tx.agentJob.updateMany({
      where: {
        id: job.id,
        companyId: job.companyId,
        inputHash: job.inputHash,
        status: 'running',
        lockOwner: workerId,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: 'completed',
        lockedAt: null,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (completed.count !== 1) return false;
    const finished = await tx.agentRun.updateMany({
      where: { id: runId, jobId: job.id, completedAt: null },
      data: finishRunData(values, now),
    });
    if (finished.count !== 1) {
      throw new Error(`Agent run ${runId} could not be finalized atomically.`);
    }
    return true;
  });
}

async function finishRun(
  db: WorkerDb,
  runId: string,
  values: RunFinishValues,
): Promise<void> {
  await db.agentRun.updateMany({
    where: { id: runId, completedAt: null },
    data: finishRunData(values),
  });
}

function categorizeBody(
  result: AgentRunnerResult,
  validation: DecisionValidationReport,
): CategorizeBody | null {
  if (result.decision.kind !== 'categorize' || !validation.resolvedLines) return null;
  if (validation.resolvedLines.length === 1) {
    const line = validation.resolvedLines[0]!;
    return {
      category: line.category,
      categoryQboId: line.categoryQboId,
      tagIds: [],
      taxCalculation: result.decision.taxCalculation,
      taxCode: line.taxCode,
      taxCodeQboId: line.taxCodeQboId,
    };
  }
  return {
    category: null,
    tagIds: [],
    taxCalculation: result.decision.taxCalculation,
    splits: validation.resolvedLines.map((line) => ({
      amount: line.grossAmount,
      category: line.category,
      categoryQboId: line.categoryQboId,
      tagIds: [],
      ...(line.memo !== undefined ? { memo: line.memo } : {}),
      taxCode: line.taxCode,
      taxCodeQboId: line.taxCodeQboId,
    })),
  };
}

async function cancelStaleJob(
  deps: AgentWorkerDeps,
  job: AgentJob,
  workerId: string,
  code: string,
  message: string,
): Promise<void> {
  await deps.cancel(job.id, workerId, job.inputHash, { code, message });
}

/**
 * Claim and execute one durable job. Shadow mode records evidence only:
 * transaction staging and QuickBooks mutation are deliberately absent here.
 */
export async function runOneAgentJob(
  workerId: string,
  overrides: Partial<AgentWorkerDeps> = {},
): Promise<boolean> {
  const deps = { ...defaultDeps, ...overrides };
  const job = await deps.claim(workerId);
  if (!job) return false;

  const controller = new AbortController();
  let leaseLost = false;
  let renewalInFlight: Promise<void> | null = null;
  let activeWriteLeaseOwner: string | null = null;
  let runId: string | null = null;
  const renewWriteBoundary = async (): Promise<boolean> => {
    if (leaseLost || activeWriteLeaseOwner === null) return false;
    try {
      const jobRenewed = await deps.renew(job.id, workerId);
      if (!jobRenewed) {
        leaseLost = true;
        controller.abort(new Error('agent job lease lost'));
        return false;
      }
      const writeLeaseRenewed = await deps.acquireWriteLease(
        job.companyId,
        activeWriteLeaseOwner,
      );
      if (!writeLeaseRenewed) {
        leaseLost = true;
        controller.abort(new Error('agent company write lease lost'));
        return false;
      }
      return true;
    } catch {
      leaseLost = true;
      controller.abort(new Error('agent write lease renewal failed'));
      return false;
    }
  };
  const timer = deps.setInterval(() => {
    if (renewalInFlight || controller.signal.aborted) return;
    const renewal = Promise.all([
      deps.renew(job.id, workerId),
      activeWriteLeaseOwner
        ? deps.acquireWriteLease(job.companyId, activeWriteLeaseOwner)
        : Promise.resolve(true),
    ])
      .then(([jobRenewed, writeLeaseRenewed]) => {
        if (!jobRenewed || !writeLeaseRenewed) {
          leaseLost = true;
          controller.abort(new Error('agent lease lost'));
        }
      })
      .catch(() => {
        leaseLost = true;
        controller.abort(new Error('agent job lease renewal failed'));
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
    void renewal;
  }, LEASE_RENEW_MS);
  timer.unref?.();

  try {
    const company = await deps.db.company.findUnique({
      where: { id: job.companyId },
      select: {
        autopilotMode: true,
        disconnectedAt: true,
        taxSupportStatus: true,
        dryRun: true,
        tagsRequired: true,
      },
    });
    if (
      !company ||
      company.autopilotMode === 'off' ||
      company.disconnectedAt !== null ||
      company.taxSupportStatus !== 'ready'
    ) {
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_DISABLED',
        message: 'Autopilot was disabled or the company disconnected before the run began.',
      });
      return true;
    }
    if (company.autopilotMode === 'live') {
      const unresolvedWrites = await deps.countUnresolvedWrites(job.companyId);
      if (
        !deps.deploymentWritesEnabled() ||
        company.dryRun ||
        company.tagsRequired ||
        unresolvedWrites > 0
      ) {
        const gate = new AgentError(
          'AGENT_LIVE_NOT_READY',
          'Live write readiness is currently blocked. No model inference was attempted.',
          true,
        );
        // Readiness blockers are operator-controlled state, not a failed
        // accounting decision. Keep the job durably retryable at the capped
        // backoff so clearing the blocker cannot strand eligible work.
        await deps.retry(
          job.id,
          workerId,
          job.inputHash,
          gate,
          new Date(deps.now().getTime() + retryDelayMs(job.attempt)),
        );
        return true;
      }
    }
    const model = await deps.model();
    const beforeHash = await deps.currentHash(job.transactionId, model);
    if (beforeHash !== job.inputHash) {
      await cancelStaleJob(
        deps,
        job,
        workerId,
        'AGENT_STALE_INPUT',
        'Decision-relevant transaction or agent identity changed before the run.',
      );
      return true;
    }
    if (await deps.hasRuleMatch(job.transactionId)) {
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_RULE_COVERED',
        message: 'A current deterministic rule covers this transaction.',
      });
      return true;
    }
    if (!(await deps.isEligible(job.transactionId, job.companyId))) {
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_INELIGIBLE',
        message: 'The transaction was staged, posted, or otherwise became ineligible before inference.',
      });
      return true;
    }

    const context = await deps.loadContext(job.companyId, job.transactionId);
    if (
      company.autopilotMode === 'live' &&
      (await deps.countValidatedShadowRuns(job.companyId, model)) < MIN_LIVE_SHADOW_RUNS
    ) {
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_LIVE_EVIDENCE_REQUIRED',
        message:
          'The active model, prompt, and tool schema do not have enough validated shadow evidence.',
      });
      return true;
    }
    const providerAtInference =
      company.autopilotMode === 'live' ? await deps.providerState() : null;
    if (
      providerAtInference &&
      (!providerAtInference.connected || providerAtInference.generation === null)
    ) {
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_PROVIDER_CHANGED',
        message: 'ChatGPT disconnected before inference began.',
      });
      return true;
    }
    const run = await deps.db.agentRun.create({
      data: {
        jobId: job.id,
        transactionId: job.transactionId,
        companyId: job.companyId,
        provider: model.provider,
        model: model.model,
        promptVersion: AGENT_RUN_PROMPT_VERSION,
        toolSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
        inputHash: job.inputHash,
        candidatePayee: normalizeCandidatePayee(context.transaction.payee),
        mode: company.autopilotMode,
        transactionSnapshot: json({
          qboType: context.transaction.qboType,
          payee: context.transaction.payee,
          amount: context.transaction.amount,
        }),
      },
    });
    runId = run.id;

    const result = await deps.run(model, context, controller.signal);
    const afterHash = await deps.currentHash(job.transactionId, model);
    if (afterHash !== job.inputHash) {
      const validation: DecisionValidationReport = {
        ok: false,
        code: 'AGENT_STALE_INPUT',
        message: 'Decision-relevant input changed while the agent was running.',
        checkedAt: deps.now().toISOString(),
      };
      await finishRun(deps.db, run.id, { result, validation });
      await cancelStaleJob(deps, job, workerId, validation.code, validation.message);
      return true;
    }
    const validation = await deps.validate(context, result);
    if (!validation.ok) {
      await finishRun(deps.db, run.id, { result, validation });
      if (validation.code === 'AGENT_STALE_INPUT') {
        await cancelStaleJob(
          deps,
          job,
          workerId,
          validation.code,
          validation.message,
        );
      } else {
        await deps.fail(job.id, workerId, job.inputHash, {
          code: validation.code,
          message: validation.message,
        });
      }
      return true;
    }
    const validatedHash = await deps.currentHash(job.transactionId, model);
    if (validatedHash !== job.inputHash) {
      const stale: DecisionValidationReport = {
        ok: false,
        code: 'AGENT_STALE_INPUT',
        message: 'Decision-relevant input changed during deterministic validation.',
        checkedAt: deps.now().toISOString(),
      };
      await finishRun(deps.db, run.id, { result, validation: stale });
      await cancelStaleJob(deps, job, workerId, stale.code, stale.message);
      return true;
    }
    const verifierModel = await deps.verifierModel(model);
    const verifier = await deps.verifyDecision(
      verifierModel,
      context,
      result,
      validation,
      controller.signal,
    );
    const providerAtDecision =
      company.autopilotMode === 'live' ? await deps.providerState() : null;
    if (
      providerAtDecision &&
      (!providerAtInference ||
        !providerAtDecision.connected ||
        providerAtDecision.generation === null ||
        providerAtDecision.generation !== providerAtInference.generation)
    ) {
      await finishRun(deps.db, run.id, {
        result,
        validation,
        verifier,
        verification: { applied: false, status: 'cancelled', reason: 'provider_changed' },
      });
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_PROVIDER_CHANGED',
        message: 'ChatGPT disconnected before the autonomous write began.',
      });
      return true;
    }
    if (await deps.hasRuleMatch(job.transactionId)) {
      await finishRun(deps.db, run.id, {
        result,
        validation,
        verifier,
        verification: { applied: false, status: 'cancelled', reason: 'deterministic_rule' },
      });
      await deps.cancel(job.id, workerId, job.inputHash, {
        code: 'AGENT_RULE_COVERED',
        message: 'A deterministic rule was added while the agent was running.',
      });
      return true;
    }
    if (company.autopilotMode === 'shadow') {
      if (
        !(await deps.completeShadow(job, workerId, run.id, {
          result,
          validation,
          verifier,
        }))
      ) {
        throw new AgentError('AGENT_CANCELLED', 'The job lease was lost before completion.', false);
      }
      await deps.refreshCandidate(run.id).catch((error) => {
        console.error(`[agent] rule candidate refresh failed for run ${run.id}:`, error);
      });
      return true;
    }

    const body = categorizeBody(result, validation);
    if (!body || verifier.verdict !== 'agree') {
      const verification = {
        applied: false,
        status: 'requires_review',
        reason:
          verifier.verdict !== 'agree'
            ? `verifier_${verifier.verdict}`
            : result.decision.kind === 'transfer'
            ? 'Transfer decisions require review in live v1.'
            : 'The agent intentionally skipped this transaction.',
      };
      await finishRun(deps.db, run.id, { result, validation, verification, verifier });
      await deps.complete(job.id, workerId, job.inputHash);
      return true;
    }

    const writeOwner = `${workerId}:${job.id}`;
    if (!(await deps.acquireWriteLease(job.companyId, writeOwner))) {
      const busy = new AgentError(
        'AGENT_COMPANY_BUSY',
        'Another autopilot write is active for this company.',
        true,
      );
      await finishRun(deps.db, run.id, {
        result,
        validation,
        verifier,
        verification: { applied: false, status: 'deferred', reason: busy.code },
        error: busy,
      });
      await deps.retry(
        job.id,
        workerId,
        job.inputHash,
        busy,
        new Date(deps.now().getTime() + retryDelayMs(job.attempt)),
      );
      return true;
    }
    activeWriteLeaseOwner = writeOwner;

    try {
      const freshCompany = await deps.db.company.findUnique({
        where: { id: job.companyId },
        select: {
          autopilotMode: true,
          disconnectedAt: true,
          taxSupportStatus: true,
          dryRun: true,
          tagsRequired: true,
        },
      });
      if (
        !freshCompany ||
        freshCompany.autopilotMode !== 'live' ||
        freshCompany.disconnectedAt !== null
      ) {
        await finishRun(deps.db, run.id, {
          result,
          validation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'mode_or_connection_changed' },
        });
        await deps.cancel(job.id, workerId, job.inputHash, {
          code: 'AGENT_DISABLED',
          message: 'Live autopilot was disabled before the write lease began.',
        });
        return true;
      }
      if (
        freshCompany.taxSupportStatus !== 'ready' ||
        freshCompany.dryRun ||
        freshCompany.tagsRequired
      ) {
        const gate = new AgentError(
          'AGENT_LIVE_NOT_READY',
          'Live readiness changed before the write began.',
          true,
        );
        await finishRun(deps.db, run.id, {
          result,
          validation,
          verifier,
          verification: { applied: false, status: 'blocked', reason: 'readiness_changed' },
          error: gate,
        });
        await deps.retry(
          job.id,
          workerId,
          job.inputHash,
          gate,
          new Date(deps.now().getTime() + retryDelayMs(job.attempt)),
        );
        return true;
      }
      const currentProvider = await deps.providerState();
      if (
        !providerAtDecision ||
        !currentProvider.connected ||
        currentProvider.generation === null ||
        currentProvider.generation !== providerAtDecision.generation
      ) {
        await finishRun(deps.db, run.id, {
          result,
          validation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'provider_changed' },
        });
        await deps.cancel(job.id, workerId, job.inputHash, {
          code: 'AGENT_PROVIDER_CHANGED',
          message: 'ChatGPT credentials changed before the autonomous write began.',
        });
        return true;
      }
      if (await deps.hasRuleMatch(job.transactionId)) {
        await finishRun(deps.db, run.id, {
          result,
          validation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'deterministic_rule' },
        });
        await deps.cancel(job.id, workerId, job.inputHash, {
          code: 'AGENT_RULE_COVERED',
          message: 'A deterministic rule was added before the write began.',
        });
        return true;
      }
      const writeHash = await deps.currentHash(job.transactionId, model);
      if (writeHash !== job.inputHash) {
        await finishRun(deps.db, run.id, {
          result,
          validation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'stale_before_write' },
        });
        await cancelStaleJob(
          deps,
          job,
          workerId,
          'AGENT_STALE_INPUT',
          'Decision-relevant input changed before the write lease began.',
        );
        return true;
      }
      const finalValidation = await deps.validate(context, result);
      if (!finalValidation.ok) {
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: finalValidation.code },
        });
        await deps.cancel(job.id, workerId, job.inputHash, {
          code: finalValidation.code,
          message: finalValidation.message,
        });
        return true;
      }
      const finalValidatedHash = await deps.currentHash(job.transactionId, model);
      if (finalValidatedHash !== job.inputHash) {
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: {
            applied: false,
            status: 'cancelled',
            reason: 'stale_after_final_validation',
          },
        });
        await cancelStaleJob(
          deps,
          job,
          workerId,
          'AGENT_STALE_INPUT',
          'Decision-relevant input changed during final validation.',
        );
        return true;
      }

      const unresolvedWrites = await deps.countUnresolvedWrites(job.companyId);
      if (!deps.deploymentWritesEnabled() || unresolvedWrites > 0) {
        const gate = new AgentError(
          'AGENT_LIVE_NOT_READY',
          'Deployment write readiness changed before staging.',
          true,
        );
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: { applied: false, status: 'blocked', reason: 'write_readiness_changed' },
          error: gate,
        });
        await deps.retry(
          job.id,
          workerId,
          job.inputHash,
          gate,
          new Date(deps.now().getTime() + retryDelayMs(job.attempt)),
        );
        return true;
      }

      // Heartbeats can fail or stall independently of inference. Renew both
      // ownership records synchronously at the mutation boundary so no local
      // accounting state changes under a stale worker claim.
      if (!(await renewWriteBoundary())) {
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'write_lease_lost' },
        });
        return true;
      }

      // The model setting is instance-wide and can change while inference or
      // verification is running. Bind the autonomous write to the exact model
      // whose shadow evidence was checked and whose decision was verified.
      const currentModel = await deps.model();
      if (currentModel.provider !== model.provider || currentModel.model !== model.model) {
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: { applied: false, status: 'cancelled', reason: 'model_changed' },
        });
        await deps.cancel(job.id, workerId, job.inputHash, {
          // The model is part of the job input hash. Use the existing stale
          // generation state so the periodic recovery sweep cannot strand a
          // job if the model-change reconciliation passed it while running.
          code: 'AGENT_STALE_INPUT',
          message: 'The configured agent model changed before the autonomous write began.',
        });
        return true;
      }

      // Once staging begins, the accounting mutation owns recovery. A mode
      // switch may stop future claims but cannot abandon an in-flight write.
      if (!finalValidation.transactionUpdatedAt) {
        throw new AgentError(
          'AGENT_WRITE_FAILED',
          'Final validation did not bind a transaction version.',
          false,
        );
      }
      let staged: { id: string; updatedAt: Date };
      try {
        staged = await deps.stage(
          job.transactionId,
          body,
          new Date(finalValidation.transactionUpdatedAt),
        );
      } catch (error) {
        if (error instanceof StagingError && error.code === 'DETERMINISTIC_RULE') {
          await finishRun(deps.db, run.id, {
            result,
            validation: finalValidation,
            verifier,
            verification: {
              applied: false,
              status: 'cancelled',
              reason: 'deterministic_rule_at_staging',
            },
          });
          await deps.cancel(job.id, workerId, job.inputHash, {
            code: 'AGENT_RULE_COVERED',
            message: error.message,
          });
          return true;
        }
        if (error instanceof StagingError && error.code === 'STALE_TRANSACTION') {
          await finishRun(deps.db, run.id, {
            result,
            validation: finalValidation,
            verifier,
            verification: {
              applied: false,
              status: 'cancelled',
              reason: 'stale_at_staging',
            },
          });
          await cancelStaleJob(
            deps,
            job,
            workerId,
            'AGENT_STALE_INPUT',
            error.message,
          );
          return true;
        }
        throw error;
      }
      // Staging is local and recoverable; the QBO mutation is not. Reassert
      // both leases after staging and immediately before the external write.
      if (!(await renewWriteBoundary())) {
        const rolledBack = await deps.rollbackStage(job.transactionId, staged.updatedAt);
        await finishRun(deps.db, run.id, {
          result,
          validation: finalValidation,
          verifier,
          verification: {
            applied: false,
            status: 'cancelled',
            reason: rolledBack
              ? 'write_lease_lost_after_staging_recovered'
              : 'write_lease_lost_after_staging_superseded',
          },
        });
        return true;
      }
      const post = await deps.post(job.transactionId, staged.updatedAt, renewWriteBoundary);
      const verification = await deps.writeVerification(job.transactionId, post);
      await finishRun(deps.db, run.id, {
        result,
        validation: finalValidation,
        verification,
        verifier,
      });
      if (post.ok && post.status === 'POSTED') {
        await deps.complete(job.id, workerId, job.inputHash);
        await deps.refreshCandidate(run.id).catch((error) => {
          console.error(`[agent] rule candidate refresh failed for run ${run.id}:`, error);
        });
      } else if (post.status === 'SUPERSEDED') {
        await deps.cancel(
          job.id,
          workerId,
          job.inputHash,
          post.error ?? { code: 'SUPERSEDED', message: 'QuickBooks changed.' },
        );
      } else {
        await deps.fail(
          job.id,
          workerId,
          job.inputHash,
          post.error ?? { code: 'AGENT_WRITE_FAILED', message: `Write ended in ${post.status}.` },
        );
      }
      return true;
    } finally {
      activeWriteLeaseOwner = null;
      deps.clearInterval(timer);
      await renewalInFlight;
      await deps.releaseWriteLease(job.companyId, writeOwner);
    }
  } catch (rawError) {
    const error = leaseLost
      ? new AgentError('AGENT_CANCELLED', 'The job lease was lost while the agent was running.', false)
      : asAgentError(rawError);
    if (runId !== null) await finishRun(deps.db, runId, { error });
    if (error.retryable && job.attempt < MAX_JOB_ATTEMPTS) {
      await deps.retry(
        job.id,
        workerId,
        job.inputHash,
        error,
        new Date(deps.now().getTime() + retryDelayMs(job.attempt)),
      );
    } else {
      await deps.fail(job.id, workerId, job.inputHash, error);
    }
    return true;
  } finally {
    deps.clearInterval(timer);
    await renewalInFlight;
  }
}

export async function runAgentWorkerBatch(
  workerId: string,
  maxJobs = 2,
  overrides: Partial<AgentWorkerDeps> = {},
): Promise<number> {
  let processed = 0;
  while (processed < maxJobs && (await runOneAgentJob(workerId, overrides))) {
    processed += 1;
  }
  return processed;
}
