import type {
  CategorizationProposal,
  StageCategorizationInput,
  StagedCategorization,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import {
  calculatePurchaseTransaction,
  type PurchaseTaxTransactionResult,
} from '../../lib/qbo/purchaseTax.js';
import type {
  QboClient,
  QboPurchaseSnapshot,
  QboTaxCodeInfo,
  QboTaxRateInfo,
} from '../../lib/qbo/types.js';
import {
  renewEntityLease,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseKey,
} from '../entityLease.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import {
  stageGuardedLiveCategorization,
} from '../categorization.js';
import type {
  CommitStagedCategorizationInput,
  DurableMutationResult,
} from '../writeback.js';
import {
  commitGuardedLiveCategorization,
} from '../writeback.js';
import type { AgentDecision } from './core/decision.js';
import type {
  AgentLimits,
  AgentRunResult,
} from './core/runner.js';
import { runShadowDecision } from './core/runner.js';
import { buildAgentSnapshot } from './core/snapshot.js';
import type {
  AgentTransactionSnapshot,
} from './core/snapshot.js';
import type { AgentVerification } from './core/verifier.js';
import type { ClaimedAgentJob } from './jobs.js';
import {
  renewJobLease,
  retryDelayMs,
} from './jobs.js';
import {
  evaluateLiveGates,
  LIVE_POLICY_VERSION,
} from './liveGates.js';
import {
  type LiveCoordinationState,
  type LiveEligibilityInput,
  type LiveEligibilityResult,
  type LivePolicyConfig,
  type LiveTransactionState,
} from './livePolicy.js';
import { evaluateLiveEligibility } from './livePolicy.js';
import {
  getLiveProviderBinding,
} from './liveGates.js';
import {
  type LiveAgentModel,
  verifyLiveDecision,
} from './liveVerifier.js';
import {
  loadAgentSnapshotSourceInTransaction,
  type AgentSnapshotQueryDb,
} from './snapshotLoader.js';
import {
  beginClaimedLiveRun,
  type ShadowWorkerDeps,
} from './worker.js';
import {
  liveTaxAuthorityDigest,
  type LiveMutationContext,
  type LiveMutationProof,
} from './liveMutationAuthority.js';
import { pauseLiveCompanyInTransaction } from './circuitBreaker.js';
import { isCanonicalLiveCheckpoint } from './liveCheckpoint.js';

const MAX_RECONCILIATION_PASSES = 32;

export interface LiveTaxReference {
  readonly companyId: string;
  readonly status: string;
  readonly usingSalesTax: boolean | null;
  readonly refreshedAt: string | null;
  readonly codes: readonly QboTaxCodeInfo[];
  readonly rates: readonly QboTaxRateInfo[];
}

export interface FreshLiveInput {
  readonly snapshot: AgentTransactionSnapshot;
  readonly qboSnapshot: QboPurchaseSnapshot | null;
  readonly entityKey: EntityLeaseKey;
  readonly transaction: LiveTransactionState;
  readonly config: LivePolicyConfig;
  readonly coordination: LiveCoordinationState;
  readonly warnings: readonly string[];
  readonly taxReference: LiveTaxReference;
  readonly providerBinding: string;
}

export type LiveRunCompletion =
  | {
      readonly status: 'posted_verified';
      readonly errorCode: null;
      readonly result: AgentRunResult;
      readonly verification: AgentVerification;
      readonly mutation: DurableMutationResult;
    }
  | {
      readonly status: 'dry_run' | 'unchanged' | 'uncertain' | 'retryable';
      readonly errorCode: string;
      readonly result: AgentRunResult;
      readonly verification: AgentVerification;
      readonly mutation: DurableMutationResult;
    }
  | {
      readonly status: 'abstain' | 'failed';
      readonly errorCode: string;
      readonly result?: AgentRunResult;
      readonly verification?: AgentVerification;
    };

export interface LiveWorkerDeps {
  readonly workerId: string;
  readonly beginRun: (
    job: ClaimedAgentJob,
  ) => Promise<{ readonly runId: string } | null>;
  readonly assertLiveAuthority: (
    job: ClaimedAgentJob,
  ) => Promise<boolean>;
  readonly locateEntity: (
    job: ClaimedAgentJob,
  ) => Promise<EntityLeaseKey | null>;
  readonly withCompanyLease: <Value>(
    companyId: string,
    owner: string,
    callback: () => Promise<Value>,
  ) => Promise<Value>;
  readonly withEntityLease: <Value>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<Value>,
  ) => Promise<Value>;
  readonly renewAuthority: (
    job: ClaimedAgentJob,
    owner: string,
    entityKey: EntityLeaseKey,
  ) => Promise<boolean>;
  readonly renewalIntervalMs?: number;
  readonly loadFreshInput: (
    job: ClaimedAgentJob,
  ) => Promise<FreshLiveInput | null>;
  readonly runDecision: (
    snapshot: AgentTransactionSnapshot,
  ) => Promise<AgentRunResult>;
  readonly verifyDecision: (
    snapshot: AgentTransactionSnapshot,
    decision: AgentDecision,
  ) => Promise<AgentVerification>;
  readonly evaluateEligibility: (
    input: LiveEligibilityInput,
  ) => LiveEligibilityResult;
  readonly checkpoint: (
    job: ClaimedAgentJob,
    runId: string,
    result: AgentRunResult,
    verification: AgentVerification,
    proof: LiveMutationProof,
  ) => Promise<void>;
  readonly stage: (
    input: StageCategorizationInput,
    owner: string,
    proof: LiveMutationProof,
    entityKey: EntityLeaseKey,
  ) => Promise<StagedCategorization>;
  readonly commit: (
    input: Omit<CommitStagedCategorizationInput, 'actor'>,
    owner: string,
    proof: LiveMutationProof,
    entityKey: EntityLeaseKey,
  ) => Promise<DurableMutationResult>;
  readonly finish: (
    job: ClaimedAgentJob,
    runId: string,
    completion: LiveRunCompletion,
  ) => Promise<void>;
}

export class LiveWorkerError extends Error {
  constructor(readonly code: string) {
    super('Guarded live execution stopped safely.');
    this.name = 'LiveWorkerError';
  }
}

/**
 * Executes only the outer guarded live orchestration. Provider, QBO, and
 * persistence adapters are explicit so this module never opens a database
 * transaction across an awaited network boundary.
 */
export async function runClaimedLiveJob(
  job: ClaimedAgentJob,
  deps: LiveWorkerDeps,
): Promise<void> {
  validateInvocation(job, deps);
  const started = await deps.beginRun(job);
  if (started === null) return;
  const owner = liveOwner(job);
  let finished = false;
  const finish = async (completion: LiveRunCompletion): Promise<void> => {
    if (finished) return;
    await deps.finish(job, started.runId, completion);
    finished = true;
  };

  try {
    if (!await deps.assertLiveAuthority(job)) {
      await finish({ status: 'abstain', errorCode: 'LIVE_AUTHORITY_DENIED' });
      return;
    }
    const located = await deps.locateEntity(job);
    if (located === null) {
      await finish({ status: 'abstain', errorCode: 'AGENT_STALE_INPUT' });
      return;
    }

    await deps.withCompanyLease(job.companyId, owner, async () => {
      const execute = async (entityKey: EntityLeaseKey): Promise<void> =>
        withAuthorityHeartbeat(job, owner, entityKey, deps, async () => {
        const initialAuthorityError = await renewAndAssert(job, owner, entityKey, deps);
        if (initialAuthorityError !== null) {
          await finish({ status: 'abstain', errorCode: initialAuthorityError });
          return;
        }
        const before = await deps.loadFreshInput(job);
        if (before === null || !sameEntity(before.entityKey, entityKey)) {
          await finish({ status: 'abstain', errorCode: 'AGENT_STALE_INPUT' });
          return;
        }
        const preflight = preflightDenial(before);
        if (preflight !== null) {
          await finish({ status: 'abstain', errorCode: preflight });
          return;
        }

        const result = await deps.runDecision(before.snapshot);
        if (result.providerFailure !== undefined) {
          await finish({
            status: 'failed',
            errorCode: result.providerFailure.code,
            result,
          });
          return;
        }
        if (result.status !== 'verified' || result.decision.kind !== 'proposal') {
          await finish({
            status: 'abstain',
            errorCode: safeDiagnostic(result.diagnosticCode),
            result,
          });
          return;
        }
        const decision = result.decision as AgentDecision;
        const verification = await deps.verifyDecision(before.snapshot, decision);
        if (!verification.ok) {
          await finish({
            status: 'abstain',
            errorCode: safeDiagnostic(verification.code),
            result,
            verification,
          });
          return;
        }

        const postInferenceAuthorityError = await renewAndAssert(job, owner, entityKey, deps);
        if (postInferenceAuthorityError !== null) {
          await finish({
            status: 'abstain',
            errorCode: postInferenceAuthorityError,
            result,
            verification,
          });
          return;
        }
        const after = await deps.loadFreshInput(job);
        if (
          after === null
          || !sameEntity(after.entityKey, entityKey)
          || before.qboSnapshot === null
          || after.qboSnapshot === null
          || !sameQboSnapshot(before.qboSnapshot, after.qboSnapshot)
        ) {
          await finish({
            status: 'abstain',
            errorCode: 'QBO_STATE_DRIFT',
            result,
            verification,
          });
          return;
        }
        if (!sameLiveConfig(before.config, after.config)) {
          await finish({
            status: 'abstain',
            errorCode: 'FRESHNESS_REQUIRED',
            result,
            verification,
          });
          return;
        }
        if (!sameTaxReference(before.taxReference, after.taxReference)) {
          await finish({
            status: 'abstain',
            errorCode: 'TAX_REFERENCE_CHANGED',
            result,
            verification,
          });
          return;
        }
        const eligibility = deps.evaluateEligibility({
          snapshot: after.snapshot,
          transaction: after.transaction,
          config: after.config,
          reviewedRun: {
            transactionId: job.transactionId,
            configVersion: job.configVersion,
            verifierModel: after.config.verifierModel,
            result,
            verification,
          },
          coordination: after.coordination,
          warnings: after.warnings,
        });
        if (!eligibility.eligible) {
          await finish({
            status: 'abstain',
            errorCode: eligibility.code,
            result,
            verification,
          });
          return;
        }

        const stagingProposal = reconcileLiveProposalForStaging(
          job.companyId,
          decision as Extract<AgentDecision, { kind: 'proposal' }>,
          after.taxReference,
        );
        // The immediately-pre-stage fence is after every inference/QBO await.
        const preStageAuthorityError = await renewAndAssert(job, owner, entityKey, deps);
        if (preStageAuthorityError !== null) {
          await finish({
            status: 'abstain',
            errorCode: preStageAuthorityError,
            result,
            verification,
          });
          return;
        }
        const mutationProof = liveMutationProof(after);
        await deps.checkpoint(job, started.runId, result, verification, mutationProof);
        const staged = await deps.stage({
          transactionId: job.transactionId,
          companyId: job.companyId,
          expectedRevision: job.revision,
          proposal: stagingProposal,
        }, owner, mutationProof, entityKey);
        assertStagedRoundTrip(staged, decision as Extract<AgentDecision, { kind: 'proposal' }>);

        const preCommitAuthorityError = await renewAndAssert(job, owner, entityKey, deps);
        if (preCommitAuthorityError !== null) {
          await finish({
            status: 'abstain',
            errorCode: preCommitAuthorityError,
            result,
            verification,
          });
          return;
        }
        const mutation = await deps.commit({
          transactionId: job.transactionId,
          companyId: job.companyId,
          expectedRevision: staged.revision,
          requestId: job.id,
        }, owner, mutationProof, entityKey);
        await finish(mutationCompletion(result, verification, mutation));
        });

      await deps.withEntityLease(located, owner, () => execute(located));
    });
  } catch (error) {
    await finish({
      status: isRetryableError(error) || isVerifierFailure(error) || isLiveMutationFailure(error)
        ? 'failed'
        : 'abstain',
      errorCode: safeErrorCode(error),
    });
  }
}

async function withAuthorityHeartbeat<T>(
  job: ClaimedAgentJob,
  owner: string,
  entityKey: EntityLeaseKey,
  deps: Pick<LiveWorkerDeps, 'renewAuthority' | 'renewalIntervalMs'>,
  callback: () => Promise<T>,
): Promise<T> {
  const requestedInterval = deps.renewalIntervalMs ?? 10_000;
  const intervalMs = Number.isFinite(requestedInterval)
    ? Math.max(100, Math.min(Math.trunc(requestedInterval), 10_000))
    : 10_000;
  let renewalTail = Promise.resolve();
  let renewalFailure: unknown;
  const timer = setInterval(() => {
    renewalTail = renewalTail
      .then(async () => {
        if (renewalFailure !== undefined) return;
        if (!await deps.renewAuthority(job, owner, entityKey)) {
          throw new LiveWorkerError('AGENT_RUN_LEASE_LOST');
        }
      })
      .catch((error: unknown) => {
        renewalFailure = error;
      });
  }, intervalMs);
  timer.unref();
  try {
    const value = await callback();
    await renewalTail;
    if (renewalFailure !== undefined) throw renewalFailure;
    return value;
  } finally {
    clearInterval(timer);
  }
}

async function renewAndAssert(
  job: ClaimedAgentJob,
  owner: string,
  entityKey: EntityLeaseKey,
  deps: LiveWorkerDeps,
): Promise<'AGENT_RUN_LEASE_LOST' | 'LIVE_AUTHORITY_DENIED' | null> {
  if (!await deps.renewAuthority(job, owner, entityKey)) return 'AGENT_RUN_LEASE_LOST';
  if (!await deps.assertLiveAuthority(job)) return 'LIVE_AUTHORITY_DENIED';
  return null;
}

function preflightDenial(input: FreshLiveInput): string | null {
  if (input.transaction.qboType !== 'Purchase') return 'ENTITY_UNSUPPORTED';
  if (input.transaction.amountCents >= 0) return 'REFUND_REVIEW_REQUIRED';
  if (input.warnings.length > 0) return input.warnings[0]!;
  if (input.transaction.qboState !== 'current') return 'QBO_STATE_DRIFT';
  if (
    input.qboSnapshot === null
    || input.qboSnapshot.direction !== 'purchase'
    || input.qboSnapshot.totalCents !== input.transaction.amountCents
    || input.qboSnapshot.totalCents !== input.snapshot.signedAmountCents
  ) return 'QBO_AMOUNT_DRIFT';
  if (
    input.transaction.status !== 'PENDING'
    || input.snapshot.transaction.id !== input.transaction.id
    || input.snapshot.transaction.revision !== input.transaction.revision
    || input.snapshot.configurationVersion !== input.config.configVersion
  ) return 'FRESHNESS_REQUIRED';
  if (input.coordination.humanStagingPresent) return 'HUMAN_STAGING_PRESENT';
  if (input.snapshot.rules.length > 0 || input.coordination.activeRuleCount > 0) {
    return 'ACTIVE_RULE_PRESENT';
  }
  if (input.coordination.ruleConflict) return 'RULE_CONFLICT';
  if (input.coordination.writeLeaseConflict) return 'WRITE_LEASE_CONFLICT';
  return null;
}

function mutationCompletion(
  result: AgentRunResult,
  verification: AgentVerification,
  mutation: DurableMutationResult,
): LiveRunCompletion {
  if (mutation.outcome === 'VERIFIED' && mutation.status === 'POSTED' && mutation.ok) {
    return {
      status: 'posted_verified',
      errorCode: null,
      result,
      verification,
      mutation,
    };
  }
  const status = mutation.outcome === 'DRY_RUN'
    ? 'dry_run'
    : mutation.outcome === 'UNCHANGED'
      ? 'unchanged'
      : mutation.outcome === 'UNCERTAIN'
        ? 'uncertain'
        : 'retryable';
  return {
    status,
    errorCode: mutation.error?.code ?? `LIVE_${mutation.outcome}`,
    result,
    verification,
    mutation,
  };
}

/**
 * Converts final agent allocations into the exact input semantics expected by
 * the shared staging calculator, then proves an exact line-by-line round trip.
 */
export function reconcileLiveProposalForStaging(
  companyId: string,
  decision: Extract<AgentDecision, { kind: 'proposal' }>,
  reference: LiveTaxReference,
): CategorizationProposal {
  const proposal = detachedProposal(decision);
  if (proposal.taxCalculation === 'NotApplicable') return proposal;
  if (reference.companyId !== companyId) {
    throw new LiveWorkerError('TAX_COMPANY_MISMATCH');
  }
  if (proposal.taxCalculation === 'TaxInclusive') {
    const result = calculate(proposal, companyId, reference);
    assertFinalTotals(result, decision);
    return proposal;
  }

  const inclusiveSeed: CategorizationProposal = {
    ...proposal,
    taxCalculation: 'TaxInclusive',
  };
  const inclusive = calculate(inclusiveSeed, companyId, reference);
  let bases = inclusive.lines.map((line) => line.netCents);
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
    const candidate = withGrossCents(proposal, bases);
    let calculated: PurchaseTaxTransactionResult & { eligible: true };
    try {
      calculated = calculate(candidate, companyId, reference);
    } catch {
      throw new LiveWorkerError('TAX_ROUNDING_AMBIGUOUS');
    }
    const differences = calculated.lines.map(
      (line, index) => decision.lines[index]!.grossCents - (line.netCents + line.taxCents),
    );
    if (differences.every((difference) => difference === 0)) {
      assertFinalTotals(calculated, decision);
      return candidate;
    }
    bases = bases.map((base, index) => safeAdd(base, differences[index]!));
  }
  throw new LiveWorkerError('TAX_ROUNDING_AMBIGUOUS');
}

function calculate(
  proposal: CategorizationProposal,
  companyId: string,
  reference: LiveTaxReference,
): PurchaseTaxTransactionResult & { eligible: true } {
  const result = calculatePurchaseTransaction({
    companyId,
    taxCalculation: proposal.taxCalculation,
    lines: proposal.lines.map((line) => ({
      grossCents: line.grossCents,
      taxCodeQboId: line.taxCodeQboId ?? '',
    })),
  }, {
    companyId: reference.companyId,
    codes: [...reference.codes],
    rates: [...reference.rates],
  });
  if (!result.eligible) throw new LiveWorkerError(result.reason);
  return result;
}

function assertFinalTotals(
  calculated: PurchaseTaxTransactionResult & { eligible: true },
  decision: Extract<AgentDecision, { kind: 'proposal' }>,
): void {
  if (calculated.lines.length !== decision.lines.length) {
    throw new LiveWorkerError('TAX_ROUNDING_AMBIGUOUS');
  }
  let actualTotal = 0;
  let expectedTotal = 0;
  for (const [index, line] of calculated.lines.entries()) {
    const total = safeAdd(line.netCents, line.taxCents);
    if (total !== decision.lines[index]!.grossCents) {
      throw new LiveWorkerError('TAX_ROUNDING_AMBIGUOUS');
    }
    actualTotal = safeAdd(actualTotal, total);
    expectedTotal = safeAdd(expectedTotal, decision.lines[index]!.grossCents);
  }
  if (actualTotal !== expectedTotal) throw new LiveWorkerError('TAX_ROUNDING_AMBIGUOUS');
}

function assertStagedRoundTrip(
  staged: StagedCategorization,
  decision: Extract<AgentDecision, { kind: 'proposal' }>,
): void {
  if (
    staged.taxCalculation !== decision.taxCalculation
    || staged.lines.length !== decision.lines.length
  ) throw new LiveWorkerError('STAGED_TOTAL_MISMATCH');
  let total = 0;
  let expected = 0;
  for (const [index, line] of staged.lines.entries()) {
    if (line.totalCents !== decision.lines[index]!.grossCents) {
      throw new LiveWorkerError('STAGED_TOTAL_MISMATCH');
    }
    total = safeAdd(total, line.totalCents);
    expected = safeAdd(expected, decision.lines[index]!.grossCents);
  }
  if (total !== expected || staged.totals.totalCents !== expected) {
    throw new LiveWorkerError('STAGED_TOTAL_MISMATCH');
  }
}

function detachedProposal(
  decision: Extract<AgentDecision, { kind: 'proposal' }>,
): CategorizationProposal {
  return {
    taxCalculation: decision.taxCalculation,
    lines: decision.lines.map((line) => ({
      grossCents: line.grossCents,
      categoryQboId: line.categoryQboId,
      taxCodeQboId: line.taxCodeQboId,
      ...(line.memo === null ? {} : { memo: line.memo }),
      tagIds: [...line.tagIds],
    })),
    tagIds: [...decision.tagIds],
  };
}

function withGrossCents(
  proposal: CategorizationProposal,
  grossCents: readonly number[],
): CategorizationProposal {
  return {
    ...proposal,
    lines: proposal.lines.map((line, index) => ({
      ...line,
      grossCents: grossCents[index]!,
    })),
  };
}

function sameEntity(left: EntityLeaseKey, right: EntityLeaseKey): boolean {
  return left.companyId === right.companyId
    && left.qboType === right.qboType
    && left.qboId === right.qboId;
}

function sameQboSnapshot(left: QboPurchaseSnapshot, right: QboPurchaseSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameLiveConfig(left: LivePolicyConfig, right: LivePolicyConfig): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameTaxReference(left: LiveTaxReference, right: LiveTaxReference): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function liveMutationProof(input: FreshLiveInput): LiveMutationProof {
  return Object.freeze({
    providerBinding: input.providerBinding,
    taxAuthorityDigest: liveTaxAuthorityDigest({
      companyId: input.taxReference.companyId,
      status: input.taxReference.status,
      usingSalesTax: input.taxReference.usingSalesTax,
      refreshedAt: input.taxReference.refreshedAt,
      codes: input.taxReference.codes,
      rates: input.taxReference.rates,
    }),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new LiveWorkerError('TAX_AMOUNT_INVALID');
  return value;
}

function liveOwner(job: ClaimedAgentJob): string {
  return `agent:${job.id}:${job.attemptCount}`;
}

function safeDiagnostic(value: string): string {
  return /^AGENT_[A-Z0-9_]+$/.test(value) ? value : 'AGENT_LIVE_FAILED';
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]+$/.test(error.code)
  ) return error.code;
  return 'AGENT_LIVE_FAILED';
}

function isRetryableError(error: unknown): boolean {
  const code = safeErrorCode(error);
  return code === 'AGENT_MODEL_NETWORK_ERROR'
    || code === 'AGENT_MODEL_HTTP_ERROR'
    || code === 'AGENT_RUN_LEASE_LOST'
    || code === 'MODEL_HEALTH_UNAVAILABLE'
    || code === 'LIVE_VERIFIER_TIMEOUT'
    || code === 'LIVE_VERIFIER_UNAVAILABLE';
}

function isLiveMutationFailure(error: unknown): boolean {
  const code = safeErrorCode(error);
  return code === 'LIVE_AUTHORITY_DENIED'
    || code === 'COMPANY_DISCONNECTED'
    || code === 'LIVE_MUTATION_RETRY_EXHAUSTED';
}

function isVerifierFailure(error: unknown): boolean {
  const code = safeErrorCode(error);
  return code === 'MODEL_HEALTH_UNAVAILABLE'
    || code === 'VERIFIER_NOT_DISTINCT'
    || code === 'LIVE_VERIFIER_TIMEOUT'
    || code === 'LIVE_VERIFICATION_INPUT_INVALID'
    || code === 'LIVE_VERIFIER_RESPONSE_INVALID'
    || code === 'LIVE_VERIFIER_IDENTITY_MISMATCH'
    || code === 'LIVE_VERIFIER_UNAVAILABLE';
}

function validateInvocation(job: ClaimedAgentJob, deps: LiveWorkerDeps): void {
  if (
    job === null
    || typeof job !== 'object'
    || job.status !== 'running'
    || job.lockOwner !== deps.workerId
    || !Number.isInteger(job.attemptCount)
    || job.attemptCount < 1
    || typeof deps.workerId !== 'string'
    || deps.workerId.trim() === ''
  ) throw new LiveWorkerError('AGENT_WORKER_INVALID');
}

export interface ProductionLiveWorkerModels {
  readonly decisionModel: LiveAgentModel;
  readonly reviewModel: LiveAgentModel;
  readonly limits: AgentLimits;
}

interface LocalLiveRow {
  readonly id: string;
  readonly companyId: string;
  readonly qboType: string;
  readonly qboId: string;
  readonly qboSyncToken: string;
  readonly revision: number;
  readonly status: string;
  readonly categoryQboId: string | null;
  readonly taxCalculation: string | null;
  readonly splitCount: number;
  readonly tagCount: number;
  readonly mutationCount: number;
  readonly rawData: unknown;
  readonly provider: string;
  readonly decisionModel: string;
  readonly verifierModel: string;
  readonly configVersion: string;
  readonly taxSupportStatus: string;
  readonly taxUsingSalesTax: boolean | null;
  readonly taxReferenceRefreshedAt: Date | null;
}

interface LocalTaxCodeRow {
  readonly qboId: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly taxable: boolean | null;
  readonly purchaseTaxRateList: unknown;
  readonly salesTaxRateList: unknown;
  readonly sourceUpdatedAt: Date | null;
}

interface LocalTaxRateRow {
  readonly qboId: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly rateValue: string | number | { toString(): string };
  readonly sourceUpdatedAt: Date | null;
}

interface ProductionFreshLocal {
  readonly input: Omit<FreshLiveInput, 'qboSnapshot'>;
  readonly shouldRefreshQbo: boolean;
}

interface LiveRecoveryRow {
  readonly attemptStatus: string;
  readonly transactionStatus: string;
  readonly qboType: string;
  readonly qboId: string;
  readonly checkpoint: unknown;
  readonly decisionModel: string;
  readonly verifierModel: string;
}

interface LiveRecovery {
  readonly runId: string;
  readonly attemptStatus: 'PREPARED' | 'RETRYABLE' | 'COMMITTING' | 'UNCERTAIN' | 'VERIFIED';
  readonly transactionStatus: string;
  readonly entityKey: EntityLeaseKey;
  readonly result: AgentRunResult;
  readonly verification: AgentVerification;
  readonly proof: LiveMutationProof;
}

/** Current persisted authority used by scheduler dispatch and every live fence. */
export async function isClaimedLiveJobAuthorized(
  job: ClaimedAgentJob,
): Promise<boolean> {
  const recovery = await claimedRecoveryStatus(job);
  if (recovery !== null) return true;
  const config = await prisma.agentCompanyConfig.findUnique({
    where: { companyId: job.companyId },
  });
  if (
    config === null
    || config.mode !== 'shadow'
    || config.configVersion !== job.configVersion
    || config.liveRequested !== true
    || config.liveEnabledAt === null
    || config.livePausedAt !== null
    || config.liveAcceptedPolicyVersion !== LIVE_POLICY_VERSION
    || config.liveAcceptedConfigVersion !== job.configVersion
  ) return false;
  if (job.schedulingGeneration !== config.schedulingGeneration) return false;
  const readiness = await evaluateLiveGates(job.companyId);
  const failed = readiness.gates.filter((gate) => !gate.ok);
  if (failed.length === 0) return true;
  if (failed.length !== 1 || failed[0]?.code !== 'UNRESOLVED_MUTATION') return false;
  const rows = await prisma.$queryRawUnsafe<{ requestId: string }[]>(
    `SELECT own_attempt."requestId"
       FROM "AgentJob" claimed
       JOIN "Transaction" txn
         ON txn."id" = claimed."transactionId"
        AND txn."companyId" = claimed."companyId"
       JOIN "QboMutationAttempt" own_attempt
         ON own_attempt."transactionId" = txn."id"
        AND own_attempt."requestId" = claimed."id"
      WHERE claimed."id" = $1
        AND claimed."companyId" = $2
        AND claimed."transactionId" = $3
        AND claimed."revision" = $4
        AND claimed."configVersion" = $5
        AND claimed."status" = 'running'
        AND claimed."lockOwner" = $6
        AND claimed."attemptCount" = $7
        AND claimed."leaseExpiresAt" > clock_timestamp()
        AND txn."revision" = claimed."revision" + 1
        AND txn."status" = 'PENDING'
        AND own_attempt."expectedRevision" = txn."revision"
        AND own_attempt."status" = 'PREPARED'
        AND NOT EXISTS (
          SELECT 1
            FROM "QboMutationAttempt" blocker
            JOIN "Transaction" blocked_txn ON blocked_txn."id" = blocker."transactionId"
           WHERE blocked_txn."companyId" = claimed."companyId"
             AND blocker."status" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN')
             AND blocker."requestId" <> own_attempt."requestId"
        )`,
    job.id,
    job.companyId,
    job.transactionId,
    job.revision,
    job.configVersion,
    job.lockOwner,
    job.attemptCount,
  );
  return rows.length === 1 && rows[0]?.requestId === job.id;
}

async function claimedRecoveryStatus(job: ClaimedAgentJob): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
    `SELECT attempt."status"
       FROM "AgentJob" claimed
       JOIN "Transaction" txn
         ON txn."id" = claimed."transactionId"
        AND txn."companyId" = claimed."companyId"
       JOIN "QboMutationAttempt" attempt
         ON attempt."transactionId" = txn."id"
        AND attempt."requestId" = claimed."id"
        AND attempt."expectedRevision" = txn."revision"
      WHERE claimed."id" = $1
        AND claimed."companyId" = $2
        AND claimed."transactionId" = $3
        AND claimed."revision" = $4
        AND claimed."configVersion" = $5
        AND claimed."status" = 'running'
        AND claimed."lockOwner" = $6
        AND claimed."attemptCount" = $7
        AND claimed."leaseExpiresAt" > clock_timestamp()
        AND txn."revision" = claimed."revision" + 1
        AND attempt."operation" = 'recategorize'
        AND (
          (
            attempt."status" IN ('PREPARED', 'RETRYABLE', 'COMMITTING')
            AND txn."status" = 'PENDING'
          )
          OR (
            attempt."status" = 'UNCERTAIN'
            AND txn."status" = 'ERROR'
          )
          OR (
            attempt."status" = 'VERIFIED'
            AND txn."status" = 'POSTED'
          )
        )
      LIMIT 1`,
    job.id,
    job.companyId,
    job.transactionId,
    job.revision,
    job.configVersion,
    job.lockOwner,
    job.attemptCount,
  );
  return rows[0]?.status ?? null;
}

/** Production scheduler entry. All adapters are built in memory for one claim. */
export async function runProductionClaimedLiveJob(
  job: ClaimedAgentJob,
  workerId: string,
  models: ProductionLiveWorkerModels,
): Promise<void> {
  if (await runProductionClaimedLiveRecovery(job, workerId)) return;
  const deps = productionLiveWorkerDeps(job, workerId, models);
  await runClaimedLiveJob(job, deps);
}

export async function runProductionClaimedLiveRecovery(
  job: ClaimedAgentJob,
  workerId: string,
): Promise<boolean> {
  const recovery = await beginProductionLiveRecovery(job, workerId);
  if (recovery === null) return false;
  await resumeProductionLiveRecovery(
    job,
    recovery,
    productionLiveRecoveryDeps(job, workerId),
  );
  return true;
}

async function resumeProductionLiveRecovery(
  job: ClaimedAgentJob,
  recovery: LiveRecovery,
  deps: Pick<
    LiveWorkerDeps,
    'withCompanyLease' | 'withEntityLease' | 'renewAuthority' | 'commit' | 'finish'
  >,
): Promise<void> {
  const owner = liveOwner(job);
  let finished = false;
  const finish = async (completion: LiveRunCompletion): Promise<void> => {
    if (finished) return;
    await deps.finish(job, recovery.runId, completion);
    finished = true;
  };
  try {
    if (recovery.attemptStatus === 'COMMITTING' || recovery.attemptStatus === 'UNCERTAIN') {
      await finish({
        status: 'uncertain',
        errorCode: 'LIVE_RECONCILIATION_REQUIRED',
        result: recovery.result,
        verification: recovery.verification,
        mutation: {
          transactionId: job.transactionId,
          requestId: job.id,
          ok: false,
          status: recovery.transactionStatus === 'ERROR' ? 'ERROR' : 'PENDING',
          outcome: 'UNCERTAIN',
          error: {
            code: 'LIVE_RECONCILIATION_REQUIRED',
            message: 'The durable live write intent requires reconciliation.',
          },
        },
      });
      return;
    }
    if (recovery.attemptStatus === 'VERIFIED') {
      await finish({
        status: 'posted_verified',
        errorCode: null,
        result: recovery.result,
        verification: recovery.verification,
        mutation: {
          transactionId: job.transactionId,
          requestId: job.id,
          ok: true,
          status: 'POSTED',
          outcome: 'VERIFIED',
        },
      });
      return;
    }
    await deps.withCompanyLease(job.companyId, owner, async () =>
      deps.withEntityLease(recovery.entityKey, owner, async () =>
        withAuthorityHeartbeat(job, owner, recovery.entityKey, deps, async () => {
          if (!await deps.renewAuthority(job, owner, recovery.entityKey)) {
            await finish({ status: 'failed', errorCode: 'AGENT_RUN_LEASE_LOST' });
            return;
          }
          const mutation = await deps.commit({
            transactionId: job.transactionId,
            companyId: job.companyId,
            expectedRevision: job.revision + 1,
            requestId: job.id,
          }, owner, recovery.proof, recovery.entityKey);
          await finish(mutationCompletion(recovery.result, recovery.verification, mutation));
        }),
      ),
    );
  } catch (error) {
    await finish({
      status: isRetryableError(error) || isVerifierFailure(error) || isLiveMutationFailure(error)
        ? 'failed'
        : 'abstain',
      errorCode: safeErrorCode(error),
    });
  }
}

async function beginProductionLiveRecovery(
  job: ClaimedAgentJob,
  workerId: string,
): Promise<LiveRecovery | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<LiveRecoveryRow[]>(
      `SELECT attempt."status" AS "attemptStatus",
              txn."status" AS "transactionStatus",
              txn."qboType", txn."qboId",
              previous."verification" AS "checkpoint",
              previous."decisionModel", previous."verifierModel"
         FROM "AgentJob" job
         JOIN "Transaction" txn
           ON txn."id" = job."transactionId"
          AND txn."companyId" = job."companyId"
         JOIN "QboMutationAttempt" attempt
           ON attempt."transactionId" = txn."id"
          AND attempt."requestId" = job."id"
          AND attempt."expectedRevision" = txn."revision"
         JOIN LATERAL (
           SELECT run."verification", run."decisionModel", run."verifierModel"
             FROM "AgentRun" run
            WHERE run."jobId" = job."id"
              AND run."attemptCount" < job."attemptCount"
              AND run."verification" ? 'liveCheckpoint'
            ORDER BY run."attemptCount" DESC
            LIMIT 1
         ) previous ON TRUE
        WHERE job."id" = $1
          AND job."companyId" = $2
          AND job."transactionId" = $3
          AND job."revision" = $4
          AND job."configVersion" = $5
          AND job."status" = 'running'
          AND job."lockOwner" = $6
          AND job."attemptCount" = $7
          AND job."leaseExpiresAt" > clock_timestamp()
          AND txn."revision" = job."revision" + 1
          AND attempt."operation" = 'recategorize'
          AND (
            (
              attempt."status" IN ('PREPARED', 'RETRYABLE', 'COMMITTING')
              AND txn."status" = 'PENDING'
            )
            OR (
              attempt."status" = 'UNCERTAIN'
              AND txn."status" = 'ERROR'
            )
            OR (
              attempt."status" = 'VERIFIED'
              AND txn."status" = 'POSTED'
            )
          )
        FOR UPDATE OF job, txn, attempt`,
      job.id,
      job.companyId,
      job.transactionId,
      job.revision,
      job.configVersion,
      workerId,
      job.attemptCount,
    );
    const row = rows[0];
    if (row === undefined) return null;
    const checkpoint = parseLiveRecoveryCheckpoint(row.checkpoint, job, row);
    const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "AgentRun" (
         "id", "jobId", "companyId", "transactionId", "revision",
         "configVersion", "attemptCount", "status", "snapshot",
         "decision", "verification", "decisionModel", "verifierModel",
         "verifierKind", "promptVersion", "schemaVersion", "durationMs",
         "usage", "createdAt"
       )
       SELECT gen_random_uuid(), job."id", job."companyId", job."transactionId",
         job."revision", job."configVersion", job."attemptCount", 'running',
         previous."snapshot", $1::jsonb, $2::jsonb,
         previous."decisionModel", previous."verifierModel", 'distinct_model',
         previous."promptVersion", previous."schemaVersion", $3, $4::jsonb,
         clock_timestamp()
       FROM "AgentJob" job
       JOIN LATERAL (
         SELECT run.*
           FROM "AgentRun" run
          WHERE run."jobId" = job."id"
            AND run."attemptCount" < job."attemptCount"
            AND run."verification" ? 'liveCheckpoint'
          ORDER BY run."attemptCount" DESC
          LIMIT 1
       ) previous ON TRUE
       WHERE job."id" = $5
       ON CONFLICT ("jobId", "attemptCount") DO NOTHING
       RETURNING "id"`,
      JSON.stringify(checkpoint.result.decision),
      JSON.stringify({ liveCheckpoint: checkpoint }),
      checkpoint.result.durationMs,
      checkpoint.result.usage === undefined ? null : JSON.stringify(checkpoint.result.usage),
      job.id,
    );
    const runId = inserted[0]?.id;
    if (runId === undefined) return null;
    if (!isRecoveryAttemptStatus(row.attemptStatus)) {
      throw new LiveWorkerError('AGENT_RECOVERY_INVALID');
    }
    return {
      runId,
      attemptStatus: row.attemptStatus,
      transactionStatus: row.transactionStatus,
      entityKey: {
        companyId: job.companyId,
        qboType: row.qboType,
        qboId: row.qboId,
      },
      result: checkpoint.result,
      verification: checkpoint.verification,
      proof: checkpoint.proof,
    };
  }, { isolationLevel: 'RepeatableRead' });
}

function parseLiveRecoveryCheckpoint(
  value: unknown,
  job: ClaimedAgentJob,
  row: Pick<LiveRecoveryRow, 'decisionModel' | 'verifierModel'>,
): {
  readonly version: 1;
  readonly result: AgentRunResult;
  readonly verification: AgentVerification;
  readonly proof: LiveMutationProof;
} {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !('liveCheckpoint' in value)
    || typeof value.liveCheckpoint !== 'object'
    || value.liveCheckpoint === null
    || Array.isArray(value.liveCheckpoint)
  ) throw new LiveWorkerError('AGENT_RECOVERY_INVALID');
  const checkpoint = value.liveCheckpoint as Record<string, unknown>;
  const result = checkpoint.result as AgentRunResult | undefined;
  const verification = checkpoint.verification as AgentVerification | undefined;
  const proof = checkpoint.proof as LiveMutationProof | undefined;
  if (
    !isCanonicalLiveCheckpoint(checkpoint, {
      snapshotRevision: job.revision,
      decisionModel: row.decisionModel,
      verifierModel: row.verifierModel,
    })
    || checkpoint.version !== 1
    || result?.status !== 'verified'
    || result.decision?.kind !== 'proposal'
    || result.snapshotRevision !== job.revision
    || typeof result.decisionProvider !== 'string'
    || result.decisionProvider.trim() === ''
    || result.decisionModel !== row.decisionModel
    || row.verifierModel.trim() === ''
    || verification?.ok !== true
    || proof === undefined
    || typeof proof.providerBinding !== 'string'
    || proof.providerBinding.trim() === ''
    || typeof proof.taxAuthorityDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(proof.taxAuthorityDigest)
  ) throw new LiveWorkerError('AGENT_RECOVERY_INVALID');
  return {
    version: 1,
    result,
    verification,
    proof,
  };
}

function isRecoveryAttemptStatus(
  value: string,
): value is LiveRecovery['attemptStatus'] {
  return value === 'PREPARED'
    || value === 'RETRYABLE'
    || value === 'COMMITTING'
    || value === 'UNCERTAIN'
    || value === 'VERIFIED';
}

function productionLiveWorkerDeps(
  job: ClaimedAgentJob,
  workerId: string,
  models: ProductionLiveWorkerModels,
): LiveWorkerDeps {
  const shadowDeps: ShadowWorkerDeps = {
    db: prisma as unknown as ShadowWorkerDeps['db'],
    workerId,
    decisionModel: models.decisionModel,
    reviewModel: models.reviewModel,
    limits: models.limits,
  };
  return {
    workerId,
    beginRun: (claimed) => beginClaimedLiveRun(claimed, shadowDeps),
    assertLiveAuthority: isClaimedLiveJobAuthorized,
    locateEntity: locateProductionEntity,
    withCompanyLease: (companyId, leaseOwner, callback) =>
      withEntityLease(companyLeaseKey(companyId), leaseOwner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    withEntityLease: (key, leaseOwner, callback) =>
      withEntityLease(key, leaseOwner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    renewAuthority: async (claimed, leaseOwner, entityKey) => {
      const [jobHeld] = await Promise.all([
        renewJobLease(claimed.id, workerId, claimed.attemptCount),
        renewEntityLease(companyLeaseKey(claimed.companyId), leaseOwner, {
          db: prisma as unknown as EntityLeaseDb,
        }),
        renewEntityLease(entityKey, leaseOwner, {
          db: prisma as unknown as EntityLeaseDb,
        }),
      ]);
      return jobHeld;
    },
    loadFreshInput: loadProductionFreshInput,
    runDecision: (snapshot) => runShadowDecision(snapshot, {
      model: models.decisionModel,
      reviewModel: models.reviewModel,
      limits: models.limits,
    }),
    verifyDecision: async (snapshot, decision) => verifyLiveDecision(
      { snapshot, decision },
      {
        decisionModel: models.decisionModel,
        verifierModel: models.reviewModel,
        authorityContext: await getLiveProviderBinding(job.companyId, prisma),
      },
    ),
    evaluateEligibility: evaluateLiveEligibility,
    checkpoint: checkpointProductionLiveRun,
    stage: (input, leaseOwner, proof, entityKey) =>
      stageGuardedLiveCategorization(
        input,
        liveMutationContext(job, workerId, leaseOwner, entityKey),
        proof,
      ),
    commit: (input, leaseOwner, proof, entityKey) =>
      commitGuardedLiveCategorization(
        input,
        liveMutationContext(job, workerId, leaseOwner, entityKey),
        proof,
      ),
    finish: finishProductionLiveRun,
  };
}

function productionLiveRecoveryDeps(
  job: ClaimedAgentJob,
  workerId: string,
): Pick<
  LiveWorkerDeps,
  'withCompanyLease' | 'withEntityLease' | 'renewAuthority' | 'commit' | 'finish'
> {
  return {
    withCompanyLease: (companyId, leaseOwner, callback) =>
      withEntityLease(companyLeaseKey(companyId), leaseOwner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    withEntityLease: (key, leaseOwner, callback) =>
      withEntityLease(key, leaseOwner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    renewAuthority: async (claimed, leaseOwner, entityKey) => {
      const [jobHeld] = await Promise.all([
        renewJobLease(claimed.id, workerId, claimed.attemptCount),
        renewEntityLease(companyLeaseKey(claimed.companyId), leaseOwner, {
          db: prisma as unknown as EntityLeaseDb,
        }),
        renewEntityLease(entityKey, leaseOwner, {
          db: prisma as unknown as EntityLeaseDb,
        }),
      ]);
      return jobHeld;
    },
    commit: (input, leaseOwner, proof, entityKey) =>
      commitGuardedLiveCategorization(
        input,
        liveMutationContext(job, workerId, leaseOwner, entityKey),
        proof,
      ),
    finish: finishProductionLiveRun,
  };
}

function liveMutationContext(
  job: ClaimedAgentJob,
  workerId: string,
  owner: string,
  entityKey: EntityLeaseKey,
): LiveMutationContext {
  return Object.freeze({
    jobId: job.id,
    companyId: job.companyId,
    transactionId: job.transactionId,
    originalRevision: job.revision,
    configVersion: job.configVersion,
    attemptCount: job.attemptCount,
    workerId,
    owner,
    entityKey: Object.freeze({ ...entityKey }),
  });
}

async function locateProductionEntity(
  job: ClaimedAgentJob,
): Promise<EntityLeaseKey | null> {
  const transaction = await prisma.transaction.findFirst({
    where: { id: job.transactionId, companyId: job.companyId },
    select: { companyId: true, qboType: true, qboId: true },
  });
  return transaction === null
    ? null
    : {
        companyId: transaction.companyId,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
      };
}

async function loadProductionFreshInput(
  job: ClaimedAgentJob,
): Promise<FreshLiveInput | null> {
  const local = await loadProductionFreshLocal(job);
  if (local === null) return null;
  if (!local.shouldRefreshQbo) return { ...local.input, qboSnapshot: null };

  const client = await qboFactory.forCompany(job.companyId);
  return refreshQboInput(local.input, client);
}

async function loadProductionFreshLocal(
  job: ClaimedAgentJob,
): Promise<ProductionFreshLocal | null> {
  return prisma.$transaction(async (tx) => {
    const source = await loadAgentSnapshotSourceInTransaction(
      job.companyId,
      job.transactionId,
      tx as unknown as AgentSnapshotQueryDb,
    );
    const snapshot = buildAgentSnapshot(source);
    const rows = await tx.$queryRawUnsafe<LocalLiveRow[]>(
      `SELECT txn."id", txn."companyId", txn."qboType", txn."qboId",
         txn."qboSyncToken", txn."revision", txn."status",
         txn."categoryQboId", txn."taxCalculation", txn."rawData",
         config."provider", config."decisionModel", config."verifierModel",
         config."configVersion", company."taxSupportStatus",
         company."taxUsingSalesTax", company."taxReferenceRefreshedAt",
         (SELECT COUNT(*)::integer FROM "SplitLine" line
           WHERE line."txnId" = txn."id") AS "splitCount",
         (SELECT COUNT(*)::integer FROM "TxnTag" tag
           WHERE tag."txnId" = txn."id") AS "tagCount",
         (SELECT COUNT(*)::integer FROM "QboMutationAttempt" attempt
           WHERE attempt."transactionId" = txn."id"
             AND attempt."status" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN'))
           AS "mutationCount"
       FROM "Transaction" txn
       JOIN "AgentCompanyConfig" config ON config."companyId" = txn."companyId"
       JOIN "Company" company ON company."id" = txn."companyId"
       WHERE txn."id" = $1 AND txn."companyId" = $2
       LIMIT 1`,
      job.transactionId,
      job.companyId,
    );
    const row = rows[0];
    if (
      row === undefined
      || row.revision !== job.revision
      || row.configVersion !== job.configVersion
    ) return null;
    const [codes, rates, providerBinding] = await Promise.all([
      tx.$queryRawUnsafe<LocalTaxCodeRow[]>(
        `SELECT "qboId", "name", "description", "active", "taxable",
           "purchaseTaxRateList", "salesTaxRateList", "sourceUpdatedAt"
         FROM "QboTaxCode"
         WHERE "companyId" = $1
         ORDER BY "qboId"`,
        job.companyId,
      ),
      tx.$queryRawUnsafe<LocalTaxRateRow[]>(
        `SELECT "qboId", "name", "description", "active",
           "rateValue"::text AS "rateValue", "sourceUpdatedAt"
         FROM "QboTaxRate"
         WHERE "companyId" = $1
         ORDER BY "qboId"`,
        job.companyId,
      ),
      getLiveProviderBinding(job.companyId, tx),
    ]);
    const humanStagingPresent = row.categoryQboId !== null
      || row.taxCalculation !== null
      || row.splitCount > 0
      || row.tagCount > 0;
    const warnings = homeCurrencyAuthorityWarnings(row.rawData, snapshot.currency);
    const qboCurrent = row.status === 'PENDING'
      && row.qboType === 'Purchase'
      && snapshot.signedAmountCents < 0
      && !humanStagingPresent
      && snapshot.rules.length === 0
      && row.mutationCount === 0
      && warnings.length === 0;
    const provider = row.provider === 'custom' || row.provider === 'openrouter'
      ? row.provider
      : 'fake';
    return {
      shouldRefreshQbo: qboCurrent,
      input: {
        snapshot,
        entityKey: {
          companyId: row.companyId,
          qboType: row.qboType,
          qboId: row.qboId,
        },
        transaction: {
          id: row.id,
          qboType: row.qboType,
          expectedQboId: row.qboId,
          currentQboId: row.qboId,
          expectedSyncToken: row.qboSyncToken,
          currentSyncToken: row.qboSyncToken,
          revision: row.revision,
          status: row.status,
          amountCents: snapshot.signedAmountCents,
          currency: snapshot.currency,
          qboState: 'current',
        },
        config: {
          companyCurrency: snapshot.currency,
          minimumConfidence: 0.9,
          configVersion: row.configVersion,
          provider,
          decisionModel: row.decisionModel,
          verifierModel: row.verifierModel,
        },
        coordination: {
          humanStagingPresent,
          activeRuleCount: snapshot.rules.length,
          ruleConflict: false,
          writeLeaseConflict: row.mutationCount > 0,
        },
        warnings,
        providerBinding,
        taxReference: {
          companyId: row.companyId,
          status: row.taxSupportStatus,
          usingSalesTax: row.taxUsingSalesTax,
          refreshedAt: row.taxReferenceRefreshedAt?.toISOString() ?? null,
          codes: codes.map((code) => ({
            qboId: code.qboId,
            name: code.name,
            description: code.description,
            active: code.active,
            taxable: code.taxable,
            purchaseRates: purchaseRates(code.purchaseTaxRateList),
            salesRates: purchaseRates(code.salesTaxRateList),
            sourceUpdatedAt: code.sourceUpdatedAt?.toISOString() ?? null,
          })),
          rates: rates.map((rate) => ({
            qboId: rate.qboId,
            name: rate.name,
            description: rate.description,
            active: rate.active,
            rateValue: Number(rate.rateValue),
            sourceUpdatedAt: rate.sourceUpdatedAt?.toISOString() ?? null,
          })),
        },
      },
    };
  }, { isolationLevel: 'RepeatableRead' });
}

async function refreshQboInput(
  input: Omit<FreshLiveInput, 'qboSnapshot'>,
  client: QboClient,
): Promise<FreshLiveInput> {
  const [transaction, qboSnapshot] = await Promise.all([
    client.fetchTxn('Purchase', input.entityKey.qboId),
    client.fetchPurchaseSnapshot(input.entityKey.qboId),
  ]);
  const current = transaction !== null
    && qboSnapshot !== null
    && transaction.qboId === input.transaction.expectedQboId
    && qboSnapshot.qboId === input.transaction.expectedQboId
    && transaction.syncToken === input.transaction.expectedSyncToken
    && qboSnapshot.syncToken === input.transaction.expectedSyncToken
    && exactProviderCents(transaction.amount) === input.transaction.amountCents
    && qboSnapshot.totalCents === input.transaction.amountCents;
  const warnings = transaction === null
    ? ['CURRENCY_AUTHORITY_UNAVAILABLE']
    : homeCurrencyAuthorityWarnings(transaction.raw, input.snapshot.currency);
  return {
    ...input,
    qboSnapshot,
    warnings,
    transaction: {
      ...input.transaction,
      currentQboId: transaction?.qboId ?? input.transaction.expectedQboId,
      currentSyncToken: transaction?.syncToken ?? input.transaction.expectedSyncToken,
      qboState: current && warnings.length === 0 ? 'current' : 'drifted',
    },
  };
}

/** @internal Persist a fenced production-live completion for the claimed run. */
export async function finishProductionLiveRun(
  job: ClaimedAgentJob,
  runId: string,
  completion: LiveRunCompletion,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, job.companyId);
    const nowRows = await tx.$queryRawUnsafe<{ now: Date | string }[]>(
      'SELECT clock_timestamp() AS "now"',
    );
    const now = checkedProductionDate(nowRows[0]?.now);
    if (completion.status === 'uncertain') {
      await pauseLiveCompanyInTransaction(
        tx,
        job.companyId,
        'UNCERTAIN_MUTATION',
        'Live mode is paused: A live mutation requires reconciliation.',
        now,
      );
    }
    const classifiedProviderRetry = completion.result?.providerFailure?.classification === 'retryable'
      && completion.result.providerFailure.code === completion.errorCode;
    const transientVerifierFailure = completion.errorCode === 'MODEL_HEALTH_UNAVAILABLE'
      || completion.errorCode === 'LIVE_VERIFIER_TIMEOUT'
      || completion.errorCode === 'LIVE_VERIFIER_UNAVAILABLE';
    const transientAuthorityLoss = completion.errorCode === 'LIVE_AUTHORITY_DENIED'
      || completion.errorCode === 'COMPANY_DISCONNECTED';
    const transient = job.attemptCount < 3
      && (
        completion.status === 'retryable'
        || (
          completion.status === 'failed'
          && (classifiedProviderRetry || transientVerifierFailure || transientAuthorityLoss)
        )
      );
    const run = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "AgentRun" run
       SET "status" = $1,
           "decision" = $2::jsonb,
           "verification" = CASE
             WHEN run."verification" ? 'liveCheckpoint'
             THEN $3::jsonb || jsonb_build_object(
               'liveCheckpoint',
               run."verification" -> 'liveCheckpoint'
             )
             ELSE $3::jsonb
           END,
           "durationMs" = $4,
           "usage" = $5::jsonb,
           "errorCode" = $6,
           "completedAt" = $7
       WHERE run."id" = $8
         AND run."jobId" = $9
         AND run."attemptCount" = $10
         AND run."status" = 'running'
         AND EXISTS (
           SELECT 1 FROM "AgentJob" job
           WHERE job."id" = run."jobId"
             AND job."status" = 'running'
             AND job."lockOwner" = $11
             AND job."attemptCount" = $10
             AND job."leaseExpiresAt" > $7
         )
       RETURNING run."id"`,
      completion.status,
      completion.result === undefined ? null : JSON.stringify(completion.result.decision),
      JSON.stringify(liveVerificationRecord(completion)),
      completion.result?.durationMs ?? null,
      completion.result?.usage === undefined ? null : JSON.stringify(completion.result.usage),
      completion.errorCode,
      now,
      runId,
      job.id,
      job.attemptCount,
      job.lockOwner,
    );
    if (run.length !== 1) throw new LiveWorkerError('AGENT_RUN_LEASE_LOST');
    const jobStatus = transient
      ? 'retry'
      : completion.status === 'uncertain'
          || completion.status === 'retryable'
          || completion.status === 'failed'
        ? 'terminal'
        : 'completed';
    const dueAt = transient
      ? new Date(now.getTime() + retryDelayMs(job.attemptCount))
      : now;
    const updated = await tx.$queryRawUnsafe<{ id: string }[]>(
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
      jobStatus,
      dueAt,
      completion.errorCode,
      now,
      job.id,
      job.lockOwner,
      job.attemptCount,
    );
    if (updated.length !== 1) throw new LiveWorkerError('AGENT_RUN_LEASE_LOST');
  });
}

async function checkpointProductionLiveRun(
  job: ClaimedAgentJob,
  runId: string,
  result: AgentRunResult,
  verification: AgentVerification,
  proof: LiveMutationProof,
): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "AgentRun" run
        SET "decision" = $1::jsonb,
            "verification" = $2::jsonb,
            "durationMs" = $3,
            "usage" = $4::jsonb
      WHERE run."id" = $5
        AND run."jobId" = $6
        AND run."attemptCount" = $7
        AND run."status" = 'running'
        AND EXISTS (
          SELECT 1
            FROM "AgentJob" job
           WHERE job."id" = run."jobId"
             AND job."status" = 'running'
             AND job."lockOwner" = $8
             AND job."attemptCount" = $7
             AND job."leaseExpiresAt" > clock_timestamp()
        )
      RETURNING run."id"`,
    JSON.stringify(result.decision),
    JSON.stringify({
      liveCheckpoint: {
        version: 1,
        result,
        verification,
        proof,
      },
    }),
    result.durationMs,
    result.usage === undefined ? null : JSON.stringify(result.usage),
    runId,
    job.id,
    job.attemptCount,
    job.lockOwner,
  );
  if (rows.length !== 1) throw new LiveWorkerError('AGENT_RUN_LEASE_LOST');
}

function liveVerificationRecord(completion: LiveRunCompletion): Record<string, unknown> {
  return {
    liveOutcome: completion.status,
    diagnosticCode: completion.result?.diagnosticCode ?? null,
    verificationMode: completion.result?.verificationMode ?? null,
    mutation: 'mutation' in completion
      ? {
          requestId: completion.mutation.requestId,
          outcome: completion.mutation.outcome,
          status: completion.mutation.status,
          errorCode: completion.mutation.error?.code ?? null,
        }
      : null,
  };
}

function companyLeaseKey(companyId: string): EntityLeaseKey {
  return { companyId, qboType: 'Company', qboId: companyId };
}

function purchaseRates(value: unknown): QboTaxCodeInfo['purchaseRates'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      typeof entry !== 'object'
      || entry === null
      || !('taxRateQboId' in entry)
      || !('taxTypeApplicable' in entry)
      || typeof entry.taxRateQboId !== 'string'
      || typeof entry.taxTypeApplicable !== 'string'
    ) return [];
    return [{
      taxRateQboId: entry.taxRateQboId,
      taxTypeApplicable: entry.taxTypeApplicable,
    }];
  });
}

export function homeCurrencyAuthorityWarnings(
  rawData: unknown,
  expectedCurrency: string,
): readonly string[] {
  if (
    typeof rawData !== 'object'
    || rawData === null
    || Array.isArray(rawData)
    || typeof expectedCurrency !== 'string'
    || expectedCurrency.trim() === ''
  ) {
    return ['CURRENCY_AUTHORITY_UNAVAILABLE'];
  }
  const record = rawData as Record<string, unknown>;
  const currencyRef = record.CurrencyRef;
  if (
    typeof currencyRef !== 'object'
    || currencyRef === null
    || Array.isArray(currencyRef)
    || !('value' in currencyRef)
    || typeof currencyRef.value !== 'string'
    || currencyRef.value.trim() === ''
  ) return ['CURRENCY_AUTHORITY_UNAVAILABLE'];
  if (Object.prototype.hasOwnProperty.call(record, 'ExchangeRate')) {
    return ['MULTI_CURRENCY_REVIEW_REQUIRED'];
  }
  return currencyRef.value === expectedCurrency
    ? []
    : ['MULTI_CURRENCY_REVIEW_REQUIRED'];
}

function exactProviderCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  return Number.isSafeInteger(cents) && Math.abs(scaled - cents) < 1e-7
    ? cents
    : null;
}

function checkedProductionDate(value: unknown): Date {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'string' ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) throw new LiveWorkerError('AGENT_WORKER_INVALID');
  return date;
}
