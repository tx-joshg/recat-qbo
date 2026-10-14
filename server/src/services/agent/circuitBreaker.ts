import type { LivePauseStateDto } from '@recat/shared';
import type { Prisma } from '../../lib/db.js';
import { prisma } from '../../lib/prisma.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import { TAX_REFERENCE_TTL_MS } from '../tax/reference.js';
import {
  getShadowEvidenceSummaryInTransaction,
  liveEvidenceWindow,
  type EvaluationQueryDb,
} from './evaluation.js';
import {
  getLiveProviderBinding,
  LIVE_POLICY_VERSION,
  probeConfiguredLiveProviderHealth,
} from './liveGates.js';
import {
  liveAdminAuthority,
  type LiveAdminAuthorityDeps,
  type LiveAdminAuthorityDb,
} from './liveAdminAuthority.js';
import {
  LIVE_PAUSE_PRIORITY,
  canonicalLivePauseMessage,
  persistStrongestLivePause,
  type LivePauseCode,
} from './livePause.js';

const MIN_SHADOW_AGREEMENT_RATE = 0.98;
const MAX_SHADOW_ABSTENTION_RATE = 0.25;
const MAX_ERROR_RATE = 0.05;

export type { LivePauseCode };

export interface LiveBreakerEvidence {
  readonly version: 1;
  readonly companyId: string;
  readonly configVersion: string;
  readonly acceptedConfigVersion: string | null;
  readonly acceptedProviderBinding: string | null;
  readonly currentProviderBinding: string;
  readonly policyAccepted: boolean;
  readonly completedSince: Date;
  readonly completedThrough: Date;
  readonly eligibleRuns: number;
  readonly agreements: number;
  readonly disagreements: number;
  readonly abstentions: number;
  readonly providerErrors: number;
  readonly qboErrors: number;
  readonly unclassifiedErrors: number;
  readonly uncertainMutations: number;
  readonly readbackMismatches: number;
  readonly taxReferenceStatus: string;
  readonly taxReferenceRefreshedAt: Date | null;
  readonly leaseHealthy: boolean;
  readonly identityProof: {
    readonly version: 1;
    readonly providerBinding: string;
    readonly decisionIdentity: string;
    readonly verifierIdentity: string;
  } | null;
}

export interface CircuitBreakerDeps {
  readonly now: () => Date;
  readonly loadEvidence: (
    companyId: string,
    now: Date,
  ) => Promise<LiveBreakerEvidence | null>;
  readonly pause: (
    companyId: string,
    code: LivePauseCode,
    message: string,
  ) => Promise<void | LivePauseStateDto>;
  readonly withCompanyScope?: <T>(
    companyId: string,
    callback: (deps: CircuitBreakerDeps) => Promise<T>,
  ) => Promise<T>;
}

export interface CircuitBreakerResult {
  readonly paused: boolean;
  readonly code: LivePauseCode | null;
}

export interface ManualLivePauseDeps extends LiveAdminAuthorityDeps {
  readonly pause: (
    companyId: string,
    code: LivePauseCode,
    message: string,
  ) => Promise<LivePauseStateDto>;
  readonly withCompanyScope?: <T>(
    companyId: string,
    callback: (deps: ManualLivePauseDeps) => Promise<T>,
  ) => Promise<T>;
}

export class ManualLivePauseAuthorizationError extends Error {
  readonly code = 'FORBIDDEN';

  constructor() {
    super('Administrative authority is required to pause live mode.');
    this.name = 'ManualLivePauseAuthorizationError';
  }
}

const manualLivePauseDeps: ManualLivePauseDeps = {
  authorizeAdmin: liveAdminAuthority.authorizeAdmin,
  pause: (companyId, code, message) =>
    pauseLiveCompany(companyId, code, message),
  withCompanyScope: (companyId, callback) =>
    prisma.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      return callback({
        authorizeAdmin: (userId, id) =>
          liveAdminAuthority.authorizeAdminInTransaction!(
            tx as unknown as LiveAdminAuthorityDb,
            userId,
            id,
          ),
        pause: (id, code, message) =>
          pauseLiveCompanyInTransaction(
            tx,
            id,
            code,
            message,
            new Date(),
          ),
      });
    }),
};

/** Authenticated manual kill capability; authority is reloaded server-side. */
export async function pauseLiveModeManually(
  companyId: string,
  userId: string,
  deps: ManualLivePauseDeps = manualLivePauseDeps,
): Promise<LivePauseStateDto> {
  const checked = checkedCompanyId(companyId);
  if (deps.withCompanyScope !== undefined) {
    return deps.withCompanyScope(
      checked,
      (scoped) => pauseLiveModeManually(checked, userId, scoped),
    );
  }
  if (!await deps.authorizeAdmin(userId, checked)) {
    throw new ManualLivePauseAuthorizationError();
  }
  return deps.pause(
    checked,
    'MANUAL_PAUSE',
    canonicalLivePauseMessage('MANUAL_PAUSE'),
  );
}

interface CircuitBreakerDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  agentCompanyConfig: Prisma.TransactionClient['agentCompanyConfig'];
  agentRun: Prisma.TransactionClient['agentRun'];
  qboMutationAttempt: Prisma.TransactionClient['qboMutationAttempt'];
  agentJob: Prisma.TransactionClient['agentJob'];
  company: Prisma.TransactionClient['company'];
  appConfig: Prisma.TransactionClient['appConfig'];
}

const defaultDeps: CircuitBreakerDeps = {
  now: () => new Date(),
  loadEvidence: (companyId, now) =>
    loadLiveBreakerEvidence(companyId, now, prisma as unknown as CircuitBreakerDb),
  pause: (companyId, code, message) =>
    pauseLiveCompany(companyId, code, message),
  withCompanyScope: async (companyId, callback) => {
    const providerHealth = await probeConfiguredLiveProviderHealth(
      companyId,
      undefined,
      { bypassSuccessCache: true },
    );
    return prisma.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      return callback({
        now: () => new Date(),
        loadEvidence: async (id, now) => {
          const evidence = await loadLiveBreakerEvidence(
            id,
            now,
            tx as unknown as CircuitBreakerDb,
          );
          if (evidence === null) return null;
          const identityProof =
            providerHealth.binding === evidence.currentProviderBinding
            && providerHealth.decisionModel
            && providerHealth.verifierModel
            && providerHealth.decisionIdentity !== null
            && providerHealth.verifierIdentity !== null
              ? {
                  version: 1 as const,
                  providerBinding: providerHealth.binding,
                  decisionIdentity: providerHealth.decisionIdentity,
                  verifierIdentity: providerHealth.verifierIdentity,
                }
              : null;
          return { ...evidence, identityProof };
        },
        pause: (id, code, message) =>
          pauseLiveCompanyInTransaction(tx, id, code, message, new Date()),
      });
    }, { isolationLevel: 'RepeatableRead' });
  },
};

export async function evaluateCircuitBreakers(
  companyId: string,
  deps: CircuitBreakerDeps = defaultDeps,
): Promise<CircuitBreakerResult> {
  if (deps.withCompanyScope !== undefined) {
    return deps.withCompanyScope(
      checkedCompanyId(companyId),
      (scoped) => evaluateCircuitBreakers(companyId, scoped),
    );
  }
  const now = checkedDate(deps.now());
  const evidence = await deps.loadEvidence(checkedCompanyId(companyId), now);
  const code = selectBreaker(evidence, companyId, now);
  if (code === null) return { paused: false, code: null };
  await deps.pause(
    companyId,
    code,
    canonicalLivePauseMessage(code),
  );
  return { paused: true, code };
}

export async function pauseLiveCompany(
  companyId: string,
  code: LivePauseCode,
  message: string,
  now = new Date(),
): Promise<LivePauseStateDto> {
  return prisma.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, checkedCompanyId(companyId));
    return pauseLiveCompanyInTransaction(
      tx,
      companyId,
      code,
      message,
      checkedDate(now),
    );
  });
}

export async function pauseLiveCompanyInTransaction(
  db: Pick<Prisma.TransactionClient, 'agentCompanyConfig'>,
  companyId: string,
  code: LivePauseCode,
  message: string,
  now: Date,
): Promise<LivePauseStateDto> {
  void message;
  const checked = checkedCompanyId(companyId);
  return persistStrongestLivePause({
    getConfig: (id) => db.agentCompanyConfig.findUnique({ where: { companyId: id } }),
    updateConfig: (id, update) => db.agentCompanyConfig.update({
      where: { companyId: id },
      data: update,
    }),
  }, checked, code, checkedDate(now));
}

export async function loadLiveBreakerEvidence(
  companyId: string,
  now: Date,
  db: CircuitBreakerDb = prisma as unknown as CircuitBreakerDb,
): Promise<LiveBreakerEvidence | null> {
  checkedCompanyId(companyId);
  checkedDate(now);
  const window = liveEvidenceWindow(now);
  const config = await db.agentCompanyConfig.findUnique({ where: { companyId } });
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      taxSupportStatus: true,
      taxReferenceRefreshedAt: true,
    },
  });
  if (config === null || company === null) return null;

  const [summary, abstentions, failures, uncertainMutations, readbackMismatches, expiredLiveJobs, latestCheckpoint, currentProviderBinding] =
    await Promise.all([
      getShadowEvidenceSummaryInTransaction(
        companyId,
        db as unknown as EvaluationQueryDb,
        window,
      ),
      db.agentRun.count({
        where: {
          companyId,
          configVersion: config.configVersion,
          status: 'abstain',
          completedAt: { gte: window.completedSince, lte: window.completedThrough },
        },
      }),
      db.agentRun.findMany({
        where: {
          companyId,
          configVersion: config.configVersion,
          status: 'failed',
          completedAt: { gte: window.completedSince, lte: window.completedThrough },
        },
        select: { errorCode: true },
      }),
      db.qboMutationAttempt.count({
        where: {
          transaction: { companyId },
          status: 'UNCERTAIN',
        },
      }),
      db.qboMutationAttempt.count({
        where: {
          transaction: { companyId },
          errorCode: 'QBO_READBACK_MISMATCH',
        },
      }),
      db.agentJob.count({
        where: {
          companyId,
          configVersion: config.configVersion,
          status: 'running',
          leaseExpiresAt: { lte: now },
        },
      }),
      db.agentRun.findFirst({
        where: {
          companyId,
          configVersion: config.configVersion,
          completedAt: { gte: window.completedSince, lte: window.completedThrough },
        },
        orderBy: { completedAt: 'desc' },
        select: { verification: true },
      }),
      getLiveProviderBinding(
        companyId,
        db as unknown as Pick<Prisma.TransactionClient, 'agentCompanyConfig' | 'appConfig'>,
      ),
    ]);

  const providerErrors = failures.filter((run) =>
    typeof run.errorCode === 'string'
    && (
      run.errorCode.startsWith('AGENT_MODEL_')
      || run.errorCode.startsWith('LIVE_VERIFIER_')
      || run.errorCode === 'MODEL_HEALTH_UNAVAILABLE'
    )).length;
  const qboErrors = failures.filter((run) =>
    typeof run.errorCode === 'string'
    && (
      run.errorCode.startsWith('QBO_')
      || run.errorCode === 'FRESHNESS_REQUIRED'
      || run.errorCode === 'TAX_REFERENCE_CHANGED'
    )).length;
  const unclassifiedErrors = failures.length - providerErrors - qboErrors;
  return {
    version: 1,
    companyId,
    configVersion: config.configVersion,
    acceptedConfigVersion: config.liveAcceptedConfigVersion,
    acceptedProviderBinding: config.liveAcceptedProviderBinding,
    currentProviderBinding,
    policyAccepted: config.liveAcceptedPolicyVersion === LIVE_POLICY_VERSION,
    completedSince: window.completedSince,
    completedThrough: window.completedThrough,
    eligibleRuns: summary.eligibleRuns,
    agreements: summary.agreements,
    disagreements: summary.disagreements,
    abstentions,
    providerErrors,
    qboErrors,
    unclassifiedErrors,
    uncertainMutations,
    readbackMismatches,
    taxReferenceStatus: company.taxSupportStatus,
    taxReferenceRefreshedAt: company.taxReferenceRefreshedAt,
    leaseHealthy: expiredLiveJobs === 0,
    identityProof: storedIdentityProof(latestCheckpoint?.verification),
  };
}

function selectBreaker(
  evidence: LiveBreakerEvidence | null,
  companyId: string,
  now: Date,
): LivePauseCode | null {
  if (!validEvidence(evidence, companyId, now)) return 'BREAKER_EVIDENCE_INVALID';
  const totalRuns = evidence.eligibleRuns
    + evidence.abstentions
    + evidence.providerErrors
    + evidence.qboErrors
    + evidence.unclassifiedErrors;
  const totalErrors = evidence.providerErrors
    + evidence.qboErrors
    + evidence.unclassifiedErrors;
  const failed = new Set<LivePauseCode>();
  if (evidence.uncertainMutations > 0) failed.add('UNCERTAIN_MUTATION');
  if (evidence.readbackMismatches > 0) failed.add('READBACK_MISMATCH');
  if (evidence.unclassifiedErrors > 0) {
    failed.add('BREAKER_EVIDENCE_INVALID');
  }
  if (
    evidence.unclassifiedErrors === 0
    && rate(totalErrors, totalRuns) > MAX_ERROR_RATE
  ) {
    failed.add(
      evidence.qboErrors >= evidence.providerErrors
        ? 'QBO_ERROR_BURST'
        : 'PROVIDER_ERROR_BURST',
    );
  }
  if (!taxReadyAndFresh(evidence, now)) failed.add('TAX_REFERENCE_STALE');
  if (!evidence.leaseHealthy) failed.add('LEASE_HEALTH_FAILED');
  if (
    evidence.identityProof !== null
    && evidence.identityProof.decisionIdentity === evidence.identityProof.verifierIdentity
  ) failed.add('VERIFIER_NOT_DISTINCT');
  if (
    !evidence.policyAccepted
    || evidence.acceptedConfigVersion !== evidence.configVersion
    || evidence.acceptedProviderBinding !== evidence.currentProviderBinding
  ) failed.add('POLICY_CONFIG_CHANGED');
  if (rate(evidence.agreements, evidence.eligibleRuns) < MIN_SHADOW_AGREEMENT_RATE) {
    failed.add('SHADOW_DISAGREEMENT_DEGRADED');
  }
  if (rate(evidence.abstentions, totalRuns) > MAX_SHADOW_ABSTENTION_RATE) {
    failed.add('SHADOW_ABSTENTION_DEGRADED');
  }
  return LIVE_PAUSE_PRIORITY.find((code) => failed.has(code)) ?? null;
}

function validEvidence(
  value: LiveBreakerEvidence | null,
  companyId: string,
  now: Date,
): value is LiveBreakerEvidence {
  if (
    value === null
    || value.version !== 1
    || value.companyId !== companyId
    || value.configVersion.trim() === ''
    || value.currentProviderBinding.trim() === ''
    || !validIdentityProof(value.identityProof, value.currentProviderBinding)
    || !validDate(value.completedSince)
    || !validDate(value.completedThrough)
    || value.completedSince.getTime() > value.completedThrough.getTime()
    || value.completedThrough.getTime() !== now.getTime()
  ) return false;
  return [
    value.eligibleRuns,
    value.agreements,
    value.disagreements,
    value.abstentions,
    value.providerErrors,
    value.qboErrors,
    value.unclassifiedErrors,
    value.uncertainMutations,
    value.readbackMismatches,
  ].every(safeCount)
    && value.agreements + value.disagreements === value.eligibleRuns;
}

function storedIdentityProof(value: unknown): LiveBreakerEvidence['identityProof'] {
  const record = runtimeRecord(value);
  const checkpoint = runtimeRecord(record?.liveCheckpoint);
  const verification = runtimeRecord(checkpoint?.verification);
  const proof = runtimeRecord(verification?.liveIdentityProof);
  if (
    proof?.version !== 1
    || typeof proof.providerBinding !== 'string'
    || typeof proof.decisionIdentity !== 'string'
    || typeof proof.verifierIdentity !== 'string'
  ) return null;
  return {
    version: 1,
    providerBinding: proof.providerBinding,
    decisionIdentity: proof.decisionIdentity,
    verifierIdentity: proof.verifierIdentity,
  };
}

function validIdentityProof(
  proof: LiveBreakerEvidence['identityProof'],
  currentProviderBinding: string,
): proof is NonNullable<LiveBreakerEvidence['identityProof']> {
  return proof !== null
    && proof.version === 1
    && proof.providerBinding === currentProviderBinding
    && proof.decisionIdentity.trim() !== ''
    && proof.verifierIdentity.trim() !== '';
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function taxReadyAndFresh(evidence: LiveBreakerEvidence, now: Date): boolean {
  if (
    evidence.taxReferenceStatus !== 'ready'
    || evidence.taxReferenceRefreshedAt === null
    || !validDate(evidence.taxReferenceRefreshedAt)
  ) return false;
  const age = now.getTime() - evidence.taxReferenceRefreshedAt.getTime();
  return age >= 0 && age < TAX_REFERENCE_TTL_MS;
}

function rate(numerator: number, denominator: number): number {
  if (!safeCount(numerator) || !safeCount(denominator) || denominator === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function checkedDate(value: Date): Date {
  if (!validDate(value)) throw new Error('Invalid live breaker clock.');
  return value;
}

function checkedCompanyId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new Error('Invalid live breaker company.');
  }
  return value;
}
