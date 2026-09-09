import { createHash } from 'node:crypto';
import type {
  LiveGateCode,
  LiveGateResult,
  LiveReadinessDto,
  TaxReadinessDto,
} from '@recat/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../env.js';
import { decrypt } from '../../lib/crypto.js';
import {
  runSerializableTransaction,
  type SerializableTransactionRunner,
} from '../../lib/serializableTransaction.js';
import {
  getShadowEvidenceSummary,
  getShadowEvidenceSummaryInTransaction,
  liveEvidenceWindow,
  type EvaluationQueryDb,
  type LiveEvidenceWindow,
  type ShadowEvidenceSummary,
} from './evaluation.js';
import {
  getInstanceSettings,
  type InstanceSettings,
  type InstanceSettingsDb,
} from '../instanceSettings.js';
import {
  TAX_REFERENCE_TTL_MS,
  getTaxReadiness,
  getTaxReadinessInTransaction,
  type TaxReadinessQueryDb,
} from '../tax/reference.js';
import {
  OpenAiCompatibleAgentModel,
  type OpenAiCompatibleAgentModelConfig,
} from './openAiCompatibleModel.js';
import {
  modelIdentity,
  probeAgentModel,
  type LiveAgentModel,
} from './liveVerifier.js';
import { getLiveWorkerHealth } from './liveWorkerHealth.js';
import {
  liveAdminAuthority,
  type LiveAdminAuthorityDeps,
} from './liveAdminAuthority.js';
import {
  persistStrongestLivePause,
  safeLivePauseState,
} from './livePause.js';

export const LIVE_POLICY_VERSION = 'recat-live-purchase-v1';

export type { LiveGateCode, LiveGateResult, LiveReadinessDto };

export interface LiveGateConfig {
  companyId: string;
  mode: string;
  provider: string;
  decisionModel: string;
  verifierModel: string;
  evidenceThreshold: number;
  configVersion: string;
  schedulingGeneration: number;
  liveRequested: boolean;
  liveAcceptedPolicyVersion: string | null;
  liveAcceptedConfigVersion: string | null;
  liveAcceptedProviderBinding: string | null;
  liveEnabledAt: Date | null;
  liveEnabledByUserId: string | null;
  livePausedAt: Date | null;
  livePauseCode: string | null;
  livePauseMessage: string | null;
}

export interface LiveGateCompany {
  legalName: string;
  disconnectedAt: Date | null;
  dryRun: boolean;
  qboClientCredentialsReady: boolean;
  qboTokensReady: boolean;
}

export interface LiveProviderHealth {
  binding: string;
  decisionModel: boolean;
  verifierModel: boolean;
  decisionIdentity: string | null;
  verifierIdentity: string | null;
}

export interface LiveWriteBlockers {
  unresolvedMutations: number;
}

export interface LiveWorkerHealth {
  healthy: boolean;
}

export interface LiveShadowMetrics {
  abstentions: number;
  errors: number;
}

export interface LiveGateDeps {
  now(): Date;
  getConfig(companyId: string): Promise<LiveGateConfig | null>;
  getCompany(companyId: string, now: Date): Promise<LiveGateCompany | null>;
  getEvidence(companyId: string, window: LiveEvidenceWindow): Promise<ShadowEvidenceSummary>;
  getShadowMetrics(companyId: string, window: LiveEvidenceWindow): Promise<LiveShadowMetrics>;
  getTaxReadiness(companyId: string): Promise<Pick<TaxReadinessDto, 'status' | 'refreshedAt'>>;
  getWriteBlockers(companyId: string): Promise<LiveWriteBlockers>;
  getProviderBinding(companyId: string): Promise<string>;
  getProviderHealth(
    companyId: string,
    options?: LiveProviderHealthProbeOptions,
  ): Promise<LiveProviderHealth>;
  getWorkerHealth(companyId: string): Promise<LiveWorkerHealth>;
  authorizeAdmin(userId: string, companyId: string): Promise<boolean>;
  updateConfig(
    companyId: string,
    update: Partial<Omit<LiveGateConfig, 'companyId' | 'mode' | 'decisionModel' | 'verifierModel' | 'evidenceThreshold' | 'configVersion'>>,
  ): Promise<LiveGateConfig>;
  withTransaction<T>(callback: (tx: LiveGateDeps) => Promise<T>): Promise<T>;
}

export interface LiveModeActor {
  userId: string;
  isAdmin: boolean;
}

export class LiveGateError extends Error {
  constructor(
    readonly code: 'LIVE_CONFIRMATION_MISMATCH' | 'LIVE_ADMIN_REQUIRED' | 'LIVE_GATE_INVALID' | 'LIVE_CONFIG_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'LiveGateError';
  }
}

const MAX_COMPANY_ID_LENGTH = 200;
const MAX_USER_ID_LENGTH = 200;
const MIN_SHADOW_AGREEMENT_RATE = 0.98;
const MAX_SHADOW_ABSTENTION_RATE = 0.25;
const MAX_SHADOW_ERROR_RATE = 0.05;
const MINIMUM_LIVE_CONFIDENCE = 0.9;

const safeMessages: Record<LiveGateCode, string> = {
  SHADOW_MODE_UNHEALTHY: 'Shadow mode must be healthy before live mode can be enabled.',
  EVIDENCE_INSUFFICIENT: 'Eligible shadow evidence is below the configured threshold.',
  SHADOW_AGREEMENT_INSUFFICIENT: 'Shadow agreement is below the live policy minimum.',
  SHADOW_ABSTENTION_EXCESSIVE: 'Shadow abstention is above the live policy maximum.',
  SHADOW_ERROR_RATE_EXCESSIVE: 'Shadow error rate is above the live policy maximum.',
  VERIFIER_NOT_DISTINCT: 'Decision and verification models must be distinct.',
  PROVIDER_UNHEALTHY: 'Configured model health checks have not passed.',
  TAX_REFERENCE_STALE: 'Tax references are not ready or are stale.',
  QBO_DISCONNECTED: 'QuickBooks is disconnected.',
  WRITEBACK_DISABLED: 'QuickBooks writeback is disabled.',
  UNRESOLVED_MUTATION: 'Unresolved QuickBooks mutations must be reconciled.',
  WORKER_UNHEALTHY: 'Autopilot worker health is not ready.',
  LIVE_POLICY_NOT_ACCEPTED: 'The current live policy must be accepted.',
};

/** Stable fail-closed evidence used when a credential-backed probe cannot pass. */
export async function failClosedLiveProviderHealthProbe(
  binding: string,
): Promise<LiveProviderHealth> {
  return {
    binding,
    decisionModel: false,
    verifierModel: false,
    decisionIdentity: null,
    verifierIdentity: null,
  };
}

/** Task 4 replaces this typed seam with a positive worker heartbeat authority. */
export async function failClosedLiveWorkerHealthProbe(
  _companyId: string,
): Promise<LiveWorkerHealth> {
  return { healthy: false };
}

/**
 * Establishes the final live-enable authority snapshot. The table locks keep
 * covered safety state from mutating after its final read and before commit;
 * serializable retries resolve overlapping settings writers from a fresh view.
 */
export async function runLiveAuthorityTransaction<T>(
  db: SerializableTransactionRunner<Prisma.TransactionClient>,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runSerializableTransaction(db, async (transaction) => {
    await transaction.$executeRawUnsafe(
      `LOCK TABLE
         "AppConfig",
         "AgentCompanyConfig",
         "Company",
         "AgentJob",
         "AgentRun",
         "QboMutationAttempt",
         "QboTaxCode",
         "Transaction"
       IN SHARE MODE`,
    );
    return callback(transaction);
  });
}

const defaultDeps: LiveGateDeps = {
  now: () => new Date(),
  getConfig: async (companyId) => prisma.agentCompanyConfig.findUnique({ where: { companyId } }) as Promise<LiveGateConfig | null>,
  getCompany: (companyId, now) => liveGateCompany(companyId, now, prisma),
  getEvidence: (companyId, window) =>
    getShadowEvidenceSummary(companyId, undefined, window),
  getShadowMetrics: (companyId, window) =>
    getRecentLiveShadowMetrics(companyId, window, prisma),
  getTaxReadiness: async (companyId) => getTaxReadiness(companyId),
  getWriteBlockers: async (companyId) => ({
    unresolvedMutations: await prisma.qboMutationAttempt.count({
      where: {
        transaction: { companyId },
        status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
      },
    }),
  }),
  getProviderBinding: (companyId) => getLiveProviderBinding(companyId, prisma),
  getProviderHealth: (companyId, options) =>
    probeConfiguredLiveProviderHealth(companyId, undefined, options),
  getWorkerHealth: async (companyId) => getLiveWorkerHealth(companyId),
  authorizeAdmin: liveAdminAuthority.authorizeAdmin,
  updateConfig: async (companyId, update) => prisma.agentCompanyConfig.update({
    where: { companyId },
    data: update,
  }) as Promise<LiveGateConfig>,
  withTransaction: async (callback) => runLiveAuthorityTransaction(
    prisma,
    (transaction) => callback(transactionDeps(transaction)),
  ),
};

function transactionDeps(db: Prisma.TransactionClient): LiveGateDeps {
  return {
    ...defaultDeps,
    getConfig: async (companyId) => db.agentCompanyConfig.findUnique({ where: { companyId } }) as Promise<LiveGateConfig | null>,
    getCompany: (companyId, now) => liveGateCompany(companyId, now, db),
    getEvidence: (companyId, window) => getShadowEvidenceSummaryInTransaction(
      companyId,
      db as unknown as EvaluationQueryDb,
      window,
    ),
    getShadowMetrics: (companyId, window) =>
      getRecentLiveShadowMetrics(companyId, window, db),
    getTaxReadiness: (companyId) => getTaxReadinessInTransaction(
      companyId,
      db as unknown as TaxReadinessQueryDb,
    ),
    getWriteBlockers: async (companyId) => ({
      unresolvedMutations: await db.qboMutationAttempt.count({
        where: {
          transaction: { companyId },
          status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
        },
      }),
    }),
    getProviderBinding: (companyId) => getLiveProviderBinding(companyId, db),
    getProviderHealth: (companyId, options) => probeConfiguredLiveProviderHealth(
      companyId,
      providerHealthDeps(db),
      options,
    ),
    getWorkerHealth: async (companyId) => getLiveWorkerHealth(companyId),
    authorizeAdmin: (userId, companyId) =>
      liveAdminAuthority.authorizeAdminInTransaction!(
        db,
        userId,
        companyId,
      ),
    updateConfig: async (companyId, update) => db.agentCompanyConfig.update({
      where: { companyId },
      data: update,
    }) as Promise<LiveGateConfig>,
    withTransaction: async (callback) => callback(transactionDeps(db)),
  };
}

export async function getRecentLiveShadowMetrics(
  companyId: string,
  window: LiveEvidenceWindow,
  db: Pick<Prisma.TransactionClient, 'agentRun' | 'agentCompanyConfig'>,
): Promise<LiveShadowMetrics> {
  const config = await db.agentCompanyConfig.findUnique({ where: { companyId } });
  if (config === null) return { abstentions: Number.POSITIVE_INFINITY, errors: Number.POSITIVE_INFINITY };
  const [abstentions, errors] = await Promise.all([
    db.agentRun.count({
      where: {
        companyId,
        configVersion: config.configVersion,
        status: 'abstain',
        completedAt: {
          gte: window.completedSince,
          lte: window.completedThrough,
        },
      },
    }),
    db.agentRun.count({
      where: {
        companyId,
        configVersion: config.configVersion,
        status: 'failed',
        completedAt: {
          gte: window.completedSince,
          lte: window.completedThrough,
        },
      },
    }),
  ]);
  return { abstentions, errors };
}

async function liveGateCompany(
  companyId: string,
  now: Date,
  db: Pick<Prisma.TransactionClient, 'company' | 'appConfig'>,
): Promise<LiveGateCompany | null> {
  const [company, settings] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: {
        legalName: true,
        disconnectedAt: true,
        dryRun: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiresAt: true,
      },
    }),
    getInstanceSettings(db as unknown as InstanceSettingsDb),
  ]);
  if (company === null) return null;
  return {
    legalName: company.legalName,
    disconnectedAt: company.disconnectedAt,
    dryRun: company.dryRun,
    qboClientCredentialsReady:
      settings.intuitClientId.trim() !== '' && settings.intuitClientSecret.trim() !== '',
    qboTokensReady: hasCurrentQboTokenState(company, now),
  };
}

export function hasCurrentQboTokenState(
  state: {
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
  },
  now: Date,
): boolean {
  if (
    !(now instanceof Date)
    || Number.isNaN(now.getTime())
    || !(state.tokenExpiresAt instanceof Date)
    || Number.isNaN(state.tokenExpiresAt.getTime())
    || state.tokenExpiresAt.getTime() <= now.getTime()
    || state.accessToken === null
    || state.refreshToken === null
  ) {
    return false;
  }
  try {
    return decrypt(state.accessToken).trim() !== ''
      && decrypt(state.refreshToken).trim() !== '';
  } catch {
    return false;
  }
}

export async function getLiveProviderBinding(
  companyId: string,
  db: Pick<Prisma.TransactionClient, 'agentCompanyConfig' | 'appConfig'>,
): Promise<string> {
  const authority = await loadLiveProviderAuthority(companyId, db);
  return authority?.binding ?? 'missing';
}

interface LiveProviderAuthority {
  readonly binding: string;
  readonly config: {
    readonly provider: string;
    readonly decisionModel: string;
    readonly verifierModel: string;
  };
  readonly settings: InstanceSettings;
}

export interface LiveProviderHealthDeps {
  readonly getAuthority: (companyId: string) => Promise<LiveProviderAuthority | null>;
  readonly createModel: (config: OpenAiCompatibleAgentModelConfig) => LiveAgentModel;
}

export interface LiveProviderHealthProbeOptions {
  readonly bypassSuccessCache?: boolean;
}

export async function probeConfiguredLiveProviderHealth(
  companyId: string,
  deps: LiveProviderHealthDeps = providerHealthDeps(prisma),
  options: LiveProviderHealthProbeOptions = {},
): Promise<LiveProviderHealth> {
  assertCompanyId(companyId);
  let authority: LiveProviderAuthority | null;
  try {
    authority = await deps.getAuthority(companyId);
  } catch {
    return failClosedLiveProviderHealthProbe('missing');
  }
  if (authority === null) return failClosedLiveProviderHealthProbe('missing');
  try {
    const modelConfig = (model: string): OpenAiCompatibleAgentModelConfig => {
      if (authority.config.provider === 'openrouter') {
        if (authority.settings.openrouterApiKey.trim() === '') throw new Error('unavailable');
        return {
          provider: 'openrouter',
          model,
          apiKey: authority.settings.openrouterApiKey,
          referer: authority.settings.openrouterReferer,
          title: authority.settings.openrouterTitle,
        };
      }
      if (
        authority.config.provider !== 'custom'
        || authority.settings.aiEndpoint.trim() === ''
        || authority.settings.aiApiKey.trim() === ''
      ) {
        throw new Error('unavailable');
      }
      return {
        provider: 'custom',
        model,
        baseUrl: authority.settings.aiEndpoint,
        apiKey: authority.settings.aiApiKey,
      };
    };
    const decisionModel = deps.createModel(modelConfig(authority.config.decisionModel));
    const verifierModel = deps.createModel(modelConfig(authority.config.verifierModel));
    const [decisionProbe, verifierProbe] = await Promise.all([
      probeAgentModel(decisionModel, {
        authorityContext: authority.binding,
        bypassSuccessCache: options.bypassSuccessCache,
      }),
      probeAgentModel(verifierModel, {
        authorityContext: authority.binding,
        bypassSuccessCache: options.bypassSuccessCache,
      }),
    ]);
    return {
      binding: authority.binding,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: modelIdentity({ identity: decisionProbe.identity }),
      verifierIdentity: modelIdentity({ identity: verifierProbe.identity }),
    };
  } catch {
    return failClosedLiveProviderHealthProbe(authority.binding);
  }
}

function providerHealthDeps(
  db: Pick<Prisma.TransactionClient, 'agentCompanyConfig' | 'appConfig'>,
): LiveProviderHealthDeps {
  return {
    getAuthority: (companyId) => loadLiveProviderAuthority(companyId, db),
    createModel: (config) => new OpenAiCompatibleAgentModel(config),
  };
}

async function loadLiveProviderAuthority(
  companyId: string,
  db: Pick<Prisma.TransactionClient, 'agentCompanyConfig' | 'appConfig'>,
): Promise<LiveProviderAuthority | null> {
  const [config, settings] = await Promise.all([
    db.agentCompanyConfig.findUnique({ where: { companyId } }),
    getInstanceSettings(db as unknown as InstanceSettingsDb),
  ]);
  if (config === null) return null;
  const canonical = JSON.stringify({
    version: 1,
    configVersion: config.configVersion,
    provider: config.provider,
    decisionModel: config.decisionModel,
    verifierModel: config.verifierModel,
    instanceProviderSettings: {
      suggestionProvider: settings.suggestionProvider,
      suggestionModel: settings.suggestionModel,
      agentDecisionModel: settings.agentDecisionModel,
      agentVerifierModel: settings.agentVerifierModel,
      aiEndpoint: settings.aiEndpoint,
      aiApiKey: settings.aiApiKey,
      openrouterApiKey: settings.openrouterApiKey,
      openrouterReferer: settings.openrouterReferer,
      openrouterTitle: settings.openrouterTitle,
    },
  });
  return {
    binding: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    config,
    settings,
  };
}

export async function evaluateLiveGates(
  companyId: string,
  deps: LiveGateDeps = defaultDeps,
): Promise<LiveReadinessDto> {
  assertCompanyId(companyId);
  const now = checkedDate(deps.now());
  const evidenceWindow = liveEvidenceWindow(now);
  const [config, company, evidence, metrics, tax, blockers, providerBinding, providerHealth, workerHealth] = await Promise.all([
    deps.getConfig(companyId),
    deps.getCompany(companyId, now),
    deps.getEvidence(companyId, evidenceWindow),
    deps.getShadowMetrics(companyId, evidenceWindow),
    deps.getTaxReadiness(companyId),
    deps.getWriteBlockers(companyId),
    deps.getProviderBinding(companyId),
    deps.getProviderHealth(companyId, { bypassSuccessCache: true }),
    deps.getWorkerHealth(companyId),
  ]);
  const policyAccepted = config?.liveAcceptedPolicyVersion === LIVE_POLICY_VERSION;
  const configurationAccepted =
    config !== null
    && config !== undefined
    && config.liveAcceptedConfigVersion === config.configVersion;
  const modelBindingAccepted =
    config?.liveAcceptedProviderBinding === providerBinding;
  const currentProviderHealthy =
    healthyCurrentProviderHealth(providerHealth, providerBinding);
  const gates = [
    gate('SHADOW_MODE_UNHEALTHY', config?.mode === 'shadow'),
    gate('EVIDENCE_INSUFFICIENT', evidence.thresholdMet),
    gate('SHADOW_AGREEMENT_INSUFFICIENT', rate(evidence.agreements, evidence.eligibleRuns) >= MIN_SHADOW_AGREEMENT_RATE),
    gate('SHADOW_ABSTENTION_EXCESSIVE', rate(metrics.abstentions, evidence.eligibleRuns + metrics.abstentions + metrics.errors) <= MAX_SHADOW_ABSTENTION_RATE),
    gate('SHADOW_ERROR_RATE_EXCESSIVE', rate(metrics.errors, evidence.eligibleRuns + metrics.abstentions + metrics.errors) <= MAX_SHADOW_ERROR_RATE),
    gate(
      'VERIFIER_NOT_DISTINCT',
      !currentProviderHealthy || distinctResolvedModels(providerHealth),
    ),
    gate('PROVIDER_UNHEALTHY', currentProviderHealthy),
    gate('TAX_REFERENCE_STALE', taxReadyAndFresh(tax, now)),
    gate(
      'QBO_DISCONNECTED',
      company !== null
        && company.disconnectedAt === null
        && company.qboClientCredentialsReady
        && company.qboTokensReady,
    ),
    gate('WRITEBACK_DISABLED', company !== null && !company.dryRun && !env.DRY_RUN),
    gate('UNRESOLVED_MUTATION', safeCount(blockers.unresolvedMutations) === 0),
    gate('WORKER_UNHEALTHY', workerHealth.healthy === true),
    gate(
      'LIVE_POLICY_NOT_ACCEPTED',
      policyAccepted && configurationAccepted && modelBindingAccepted,
    ),
  ];
  const pause = safeLivePauseState(config);
  return {
    policyVersion: LIVE_POLICY_VERSION,
    gates,
    evidence: {
      completedSince: evidenceWindow.completedSince.toISOString(),
      completedThrough: evidenceWindow.completedThrough.toISOString(),
      eligibleRuns: boundedCount(evidence.eligibleRuns),
      threshold: boundedCount(evidence.threshold),
      minimumAgreement: MIN_SHADOW_AGREEMENT_RATE,
      maximumAbstentionRate: MAX_SHADOW_ABSTENTION_RATE,
      maximumErrorRate: MAX_SHADOW_ERROR_RATE,
    },
    models: {
      provider: safeAlias(config?.provider),
      decisionAlias: safeAlias(config?.decisionModel),
      verifierAlias: safeAlias(config?.verifierModel),
      decisionIdentity: currentProviderHealthy
        ? safeIdentity(providerHealth.decisionIdentity)
        : null,
      verifierIdentity: currentProviderHealthy
        ? safeIdentity(providerHealth.verifierIdentity)
        : null,
    },
    policy: {
      supportedEntities: ['Purchase'],
      minimumConfidence: MINIMUM_LIVE_CONFIDENCE,
      policyAccepted,
      configurationAccepted,
      modelBindingAccepted,
    },
    state: {
      ...pause,
      enabled:
        pause.enabled
        && gates.every((result) => result.ok),
    },
    lastAction: null,
  };
}

export async function enableLiveMode(
  companyId: string,
  confirmation: string,
  actor: LiveModeActor,
  deps: LiveGateDeps = defaultDeps,
): Promise<LiveReadinessDto> {
  assertCompanyId(companyId);
  assertActor(actor);
  if (!actor.isAdmin) throw new LiveGateError('LIVE_ADMIN_REQUIRED', 'A company administrator is required.');
  const providerHealth = await deps.getProviderHealth(
    companyId,
    { bypassSuccessCache: true },
  );
  return deps.withTransaction((tx) =>
    enableLiveModeInTransaction(
      companyId,
      confirmation,
      actor,
      providerHealth,
      tx,
    ));
}

/** Authenticated interactive capability; never trusts a caller-supplied role. */
export async function enableLiveModeForAdmin(
  companyId: string,
  confirmation: string,
  userId: string,
  authority: LiveAdminAuthorityDeps | undefined = undefined,
  deps: LiveGateDeps = defaultDeps,
): Promise<LiveReadinessDto> {
  assertCompanyId(companyId);
  const providerHealth = await deps.getProviderHealth(
    companyId,
    { bypassSuccessCache: true },
  );
  return deps.withTransaction(async (tx) => {
    const authorizeAdmin = authority?.authorizeAdmin ?? tx.authorizeAdmin;
    if (!await authorizeAdmin(userId, companyId)) {
      throw new LiveGateError(
        'LIVE_ADMIN_REQUIRED',
        'A company administrator is required.',
      );
    }
    if (await tx.getProviderBinding(companyId) !== providerHealth.binding) {
      throw new LiveGateError(
        'LIVE_GATE_INVALID',
        'Provider authority changed while live mode was being enabled.',
      );
    }
    return enableLiveModeInTransaction(
      companyId,
      confirmation,
      { userId, isAdmin: true },
      providerHealth,
      tx,
    );
  });
}

async function enableLiveModeInTransaction(
  companyId: string,
  confirmation: string,
  actor: LiveModeActor,
  providerHealth: LiveProviderHealth,
  tx: LiveGateDeps,
): Promise<LiveReadinessDto> {
  const freshDeps: LiveGateDeps = {
    ...tx,
    getProviderHealth: async () => providerHealth,
  };
  const company = await tx.getCompany(companyId, checkedDate(tx.now()));
  if (company === null) throw new LiveGateError('LIVE_CONFIG_MISSING', 'Live mode is unavailable.');
  if (confirmation !== company.legalName) {
    throw new LiveGateError('LIVE_CONFIRMATION_MISMATCH', 'Typed company confirmation does not match.');
  }
  const existing = await tx.getConfig(companyId);
  if (existing === null) {
    throw new LiveGateError('LIVE_CONFIG_MISSING', 'Live mode is unavailable.');
  }
  const newSchedulingIntent = !existing.liveRequested
    || existing.liveEnabledAt === null
    || existing.livePausedAt !== null
    || existing.liveAcceptedPolicyVersion !== LIVE_POLICY_VERSION
    || existing.liveAcceptedConfigVersion !== existing.configVersion
    || existing.liveAcceptedProviderBinding !== providerHealth.binding;
  await tx.updateConfig(companyId, {
    liveRequested: true,
    liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
    liveAcceptedConfigVersion: existing.configVersion,
    liveAcceptedProviderBinding: providerHealth.binding,
  });
  const readiness = await evaluateLiveGates(companyId, freshDeps);
  if (isReady(readiness)) {
    await tx.updateConfig(companyId, {
      schedulingGeneration: existing.schedulingGeneration + (newSchedulingIntent ? 1 : 0),
      liveEnabledAt: checkedDate(tx.now()),
      liveEnabledByUserId: actor.userId,
      livePausedAt: null,
      livePauseCode: null,
      livePauseMessage: null,
    });
    return {
      ...readiness,
      state: {
        ...readiness.state,
        liveRequested: true,
        enabled: true,
        paused: false,
        pauseCode: null,
        pauseMessage: null,
      },
    };
  }
  await pauseFromReadiness(companyId, readiness, tx);
  return evaluateLiveGates(companyId, freshDeps);
}

export async function pauseLiveMode(
  companyId: string,
  deps: LiveGateDeps = defaultDeps,
): Promise<LiveReadinessDto> {
  assertCompanyId(companyId);
  const providerHealth = await deps.getProviderHealth(
    companyId,
    { bypassSuccessCache: true },
  );
  return deps.withTransaction(async (tx) => {
    const readiness = await evaluateLiveGates(companyId, { ...tx, getProviderHealth: async () => providerHealth });
    const config = await tx.getConfig(companyId);
    if (config?.liveRequested === true && !isReady(readiness)) {
      await pauseFromReadiness(companyId, readiness, tx);
      return evaluateLiveGates(companyId, {
        ...tx,
        getProviderHealth: async () => providerHealth,
      });
    }
    return readiness;
  });
}

function gate(code: LiveGateCode, ok: boolean): LiveGateResult {
  return { code, ok, message: ok ? 'Ready.' : safeMessages[code] };
}

function distinctResolvedModels(health: LiveProviderHealth): boolean {
  return health.decisionModel
    && health.verifierModel
    && typeof health.decisionIdentity === 'string'
    && typeof health.verifierIdentity === 'string'
    && health.decisionIdentity !== ''
    && health.verifierIdentity !== ''
    && health.decisionIdentity !== health.verifierIdentity;
}

function healthyCurrentProviderHealth(
  health: LiveProviderHealth,
  binding: string,
): boolean {
  return health.binding === binding
    && health.decisionModel
    && health.verifierModel
    && typeof health.decisionIdentity === 'string'
    && typeof health.verifierIdentity === 'string'
    && health.decisionIdentity !== ''
    && health.verifierIdentity !== '';
}

function taxReadyAndFresh(
  tax: Pick<TaxReadinessDto, 'status' | 'refreshedAt'>,
  now: Date,
): boolean {
  if (tax.status !== 'ready' || tax.refreshedAt === null) return false;
  const refreshedAt = new Date(tax.refreshedAt);
  return !Number.isNaN(refreshedAt.getTime())
    && refreshedAt.getTime() <= now.getTime()
    && now.getTime() - refreshedAt.getTime() < TAX_REFERENCE_TTL_MS;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeAlias(value: string | undefined): string {
  if (typeof value !== 'string') return 'unavailable';
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= 200 ? trimmed : 'unavailable';
}

function safeIdentity(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= 200 ? trimmed : null;
}

function rate(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}

function isReady(readiness: LiveReadinessDto): boolean {
  return readiness.gates.every((result) => result.ok);
}

async function pauseFromReadiness(
  companyId: string,
  readiness: LiveReadinessDto,
  deps: LiveGateDeps,
): Promise<void> {
  const failure = readiness.gates.find((result) => !result.ok);
  if (failure === undefined) return;
  await persistStrongestLivePause(
    {
      getConfig: deps.getConfig,
      updateConfig: (id, update) => deps.updateConfig(id, update),
    },
    companyId,
    failure.code,
    checkedDate(deps.now()),
  );
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== 'string' || companyId.trim() === '' || companyId.length > MAX_COMPANY_ID_LENGTH) {
    throw new LiveGateError('LIVE_GATE_INVALID', 'Invalid live mode request.');
  }
}

function assertActor(actor: LiveModeActor): void {
  if (
    typeof actor !== 'object'
    || actor === null
    || typeof actor.userId !== 'string'
    || actor.userId.trim() === ''
    || actor.userId.length > MAX_USER_ID_LENGTH
    || typeof actor.isAdmin !== 'boolean'
  ) {
    throw new LiveGateError('LIVE_GATE_INVALID', 'Invalid live mode request.');
  }
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new LiveGateError('LIVE_GATE_INVALID', 'Invalid live mode request.');
  }
  return value;
}
