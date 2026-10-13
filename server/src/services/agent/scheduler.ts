import { randomUUID } from 'node:crypto';
import type { AgentCompanySettingsDto } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { getInstanceSettings } from '../instanceSettings.js';
import type { AgentModel } from './core/model.js';
import type { AgentLimits } from './core/runner.js';
import {
  cancelSupersededAgentJob,
  claimShadowJobs,
  discoverShadowJobs,
  finishAgentJob,
  type ClaimedAgentJob,
} from './jobs.js';
import {
  OpenAiCompatibleAgentModel,
  type OpenAiCompatibleAgentModelConfig,
} from './openAiCompatibleModel.js';
import { AgentSettingError, getAgentSettings } from './settings.js';
import { runClaimedShadowJob } from './worker.js';
import {
  markLiveWorkerClaimCycle,
  markLiveWorkerStarted,
  markLiveWorkerStopped,
} from './liveWorkerHealth.js';
import {
  isClaimedLiveJobAuthorized,
  runProductionClaimedLiveJob,
  runProductionClaimedLiveRecovery,
  type ProductionLiveWorkerModels,
} from './liveWorker.js';
import { evaluateCircuitBreakers } from './circuitBreaker.js';
import {
  deferLiveReconciliation,
  listAllLiveReconciliationCandidates,
  reconcileScheduledLiveMutation,
} from './liveReconciliation.js';

const GLOBAL_CONCURRENCY = 4;
const LIVE_RECOVERY_CONCURRENCY = 4;
const LIVE_RECOVERY_TIMEOUT_MS = 10_000;
/**
 * Ticks run about once a minute; a tick that starts a little early must not
 * push a company's discovery back by a whole extra tick.
 */
const DISCOVERY_SLACK_MS = 30_000;

export type AgentSchedulerModelConfig = OpenAiCompatibleAgentModelConfig;

export interface AgentProviderSettings {
  readonly aiEndpoint: string;
  readonly aiApiKey: string;
  readonly openrouterApiKey: string;
  readonly openrouterReferer: string;
  readonly openrouterTitle: string;
}

export interface AgentWorkerModels {
  readonly decisionModel: AgentModel;
  readonly reviewModel: AgentModel;
  readonly limits: AgentLimits;
}

export interface ScheduledShadowCompany {
  readonly companyId: string;
  readonly scheduleMinutes: number;
  readonly liveRequested: boolean;
  /** Absent or null means discovery has never completed: run now. */
  readonly lastDiscoveredAt?: Date | null;
}

interface ScheduledCompanyDb {
  agentCompanyConfig: {
    findMany(args: {
      where: { mode: 'shadow'; company: { disconnectedAt: null } };
      select: {
        companyId: true;
        scheduleMinutes: true;
        liveRequested: true;
        lastDiscoveredAt: true;
      };
      orderBy: { companyId: 'asc' };
    }): Promise<ScheduledShadowCompany[]>;
  };
}

interface DiscoveryMarkDb {
  agentCompanyConfig: {
    updateMany(args: {
      where: { companyId: string; mode: 'shadow' };
      data: { lastDiscoveredAt: Date };
    }): Promise<unknown>;
  };
}

export interface AgentSchedulerDeps {
  readonly workerId: string;
  readonly globalConcurrency: number;
  readonly now: () => Date;
  readonly listShadowCompanies: () => Promise<readonly ScheduledShadowCompany[]>;
  readonly guardCompany?: (company: ScheduledShadowCompany) => Promise<void>;
  readonly recoverLiveMutations?: () => Promise<void>;
  readonly discoverJobs: (companyId: string) => Promise<unknown>;
  /** Records a completed discovery so the next one is measured from it. */
  readonly markDiscovered?: (companyId: string, at: Date) => Promise<unknown>;
  readonly claimJobs: (
    workerId: string,
    limit: number,
  ) => Promise<readonly ClaimedAgentJob[]>;
  readonly runJob: (job: ClaimedAgentJob) => Promise<void>;
}

export interface ScheduledShadowJobDeps {
  readonly getCompanySettings: (
    companyId: string,
  ) => Promise<AgentCompanySettingsDto>;
  readonly getProviderSettings: () => Promise<AgentProviderSettings>;
  readonly createModel: (config: AgentSchedulerModelConfig) => AgentModel;
  readonly runClaimedJob: (
    job: ClaimedAgentJob,
    workerId: string,
    models: AgentWorkerModels,
  ) => Promise<void>;
  readonly isLiveAuthorized?: (
    job: ClaimedAgentJob,
    models: AgentWorkerModels,
  ) => Promise<boolean>;
  readonly runClaimedLiveJob?: (
    job: ClaimedAgentJob,
    workerId: string,
    models: AgentWorkerModels,
  ) => Promise<void>;
  readonly runClaimedLiveRecovery?: (
    job: ClaimedAgentJob,
    workerId: string,
  ) => Promise<boolean>;
  readonly terminalize: (
    job: ClaimedAgentJob,
    workerId: string,
    errorCode: 'AGENT_MODEL_CONFIG_INVALID',
  ) => Promise<unknown>;
  readonly supersede: (
    job: ClaimedAgentJob,
    workerId: string,
  ) => Promise<boolean>;
}

export interface AgentScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

/**
 * Builds both adapters from the current company aliases and the decrypted
 * instance settings. Credentials are passed directly into the in-memory
 * adapters and are not copied into jobs, runs, or diagnostics.
 */
export function buildAgentModels(
  settings: AgentCompanySettingsDto,
  providerSettings: AgentProviderSettings,
  createModel: (config: AgentSchedulerModelConfig) => AgentModel =
    (config) => new OpenAiCompatibleAgentModel(config),
): AgentWorkerModels {
  if (settings.mode !== 'shadow') throw new Error('Agent model configuration is unavailable.');

  const forModel = (model: string): AgentSchedulerModelConfig => {
    if (settings.provider === 'openrouter') {
      if (providerSettings.openrouterApiKey === '') {
        throw new Error('Agent model configuration is unavailable.');
      }
      return {
        provider: 'openrouter',
        model,
        apiKey: providerSettings.openrouterApiKey,
        referer: providerSettings.openrouterReferer,
        title: providerSettings.openrouterTitle,
      };
    }
    if (settings.provider === 'custom' && providerSettings.aiEndpoint !== '') {
      return {
        provider: 'custom',
        model,
        baseUrl: providerSettings.aiEndpoint,
        apiKey: providerSettings.aiApiKey,
      };
    }
    throw new Error('Agent model configuration is unavailable.');
  };

  return {
    decisionModel: createModel(forModel(settings.decisionModel)),
    reviewModel: createModel(forModel(settings.verifierModel)),
    limits: { ...settings.limits },
  };
}

/**
 * Reloads mutable configuration after claim. If an enabled provider or model
 * can no longer be constructed, the owner/attempt-fenced terminal update
 * prevents the claim from silently waiting for lease expiry.
 */
export async function runScheduledShadowJob(
  job: ClaimedAgentJob,
  workerId: string,
  deps: ScheduledShadowJobDeps,
): Promise<void> {
  if (await deps.runClaimedLiveRecovery?.(job, workerId)) return;

  let settings: AgentCompanySettingsDto;
  try {
    settings = await deps.getCompanySettings(job.companyId);
  } catch (error) {
    if (!(error instanceof AgentSettingError)) throw error;
    await deps.terminalize(job, workerId, 'AGENT_MODEL_CONFIG_INVALID');
    return;
  }

  if (settings.mode !== 'shadow' || settings.configVersion !== job.configVersion) {
    if (!await deps.supersede(job, workerId)) {
      throw new Error('Agent job configuration changed during supersession.');
    }
    return;
  }

  const providerSettings = await deps.getProviderSettings();
  let models: AgentWorkerModels;
  try {
    models = buildAgentModels(settings, providerSettings, deps.createModel);
  } catch {
    await deps.terminalize(job, workerId, 'AGENT_MODEL_CONFIG_INVALID');
    return;
  }
  let liveAuthorized = false;
  if (deps.isLiveAuthorized !== undefined && deps.runClaimedLiveJob !== undefined) {
    try {
      liveAuthorized = await deps.isLiveAuthorized(job, models);
    } catch {
      liveAuthorized = false;
    }
  }
  if (liveAuthorized) {
    await deps.runClaimedLiveJob!(job, workerId, models);
    return;
  }
  await deps.runClaimedJob(job, workerId, models);
}

export function createAgentScheduler(deps: AgentSchedulerDeps): AgentScheduler {
  let acceptingClaims = true;
  let lifecycleGeneration = 0;
  let running = false;

  return {
    start(): void {
      acceptingClaims = true;
      markLiveWorkerStarted(deps.workerId);
    },
    stop(): void {
      acceptingClaims = false;
      lifecycleGeneration += 1;
      markLiveWorkerStopped(deps.workerId);
    },
    async tick(): Promise<void> {
      if (!acceptingClaims || running) return;
      const tickGeneration = lifecycleGeneration;
      const isCurrentLifecycle = () => (
        acceptingClaims && lifecycleGeneration === tickGeneration
      );
      running = true;
      try {
        const now = checkedDate(deps.now());
        if (deps.recoverLiveMutations !== undefined) {
          await Promise.allSettled([deps.recoverLiveMutations()]);
          if (!isCurrentLifecycle()) return;
        }
        const companies = await deps.listShadowCompanies();
        if (!isCurrentLifecycle()) return;
        if (deps.guardCompany !== undefined) {
          await Promise.allSettled(
            companies.map((company) => deps.guardCompany!(company)),
          );
          if (!isCurrentLifecycle()) return;
        }
        await runBoundedSettled(
          companies.filter((company) => isDue(now, company)),
          deps.globalConcurrency,
          async (company) => {
            await deps.discoverJobs(company.companyId);
            await deps.markDiscovered?.(company.companyId, now);
          },
        );
        if (!isCurrentLifecycle()) return;

        const jobs = await deps.claimJobs(deps.workerId, deps.globalConcurrency);
        if (!isCurrentLifecycle()) return;
        markLiveWorkerClaimCycle(deps.workerId, checkedDate(deps.now()));
        await Promise.allSettled(jobs.map((job) => deps.runJob(job)));
        if (!isCurrentLifecycle()) return;
      } finally {
        running = false;
      }
    },
  };
}

/**
 * Due when a full schedule period has passed since the last completed
 * discovery. Measuring from a stored time (rather than matching wall-clock
 * minutes) means a skipped, overlapping, or failed tick is caught up on the
 * next one instead of silently waiting another whole period.
 */
function isDue(now: Date, company: ScheduledShadowCompany): boolean {
  const { scheduleMinutes, lastDiscoveredAt } = company;
  if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 1) return false;
  if (lastDiscoveredAt === undefined || lastDiscoveredAt === null) return true;
  const last = lastDiscoveredAt.getTime();
  // A clock that moved backwards must not stall discovery indefinitely.
  if (Number.isNaN(last) || last > now.getTime()) return true;
  return now.getTime() - last >= scheduleMinutes * 60_000 - DISCOVERY_SLACK_MS;
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('Invalid agent scheduler clock.');
  }
  return value;
}

const processWorkerId = randomUUID();

const productionJobDeps: ScheduledShadowJobDeps = {
  getCompanySettings: getAgentSettings,
  getProviderSettings: getInstanceSettings,
  createModel: (config) => new OpenAiCompatibleAgentModel(config),
  runClaimedLiveRecovery: runProductionClaimedLiveRecovery,
  runClaimedJob: async (job, workerId, models) => {
    await runClaimedShadowJob(job, {
      db: prisma,
      workerId,
      decisionModel: models.decisionModel,
      reviewModel: models.reviewModel,
      limits: models.limits,
    });
  },
  isLiveAuthorized: async (job, models) => (
    asProductionLiveModels(models) !== null
    && isClaimedLiveJobAuthorized(job)
  ),
  runClaimedLiveJob: async (job, workerId, models) => {
    const liveModels = asProductionLiveModels(models);
    if (liveModels === null) throw new Error('Agent live model capability is unavailable.');
    await runProductionClaimedLiveJob(job, workerId, liveModels);
  },
  terminalize: async (job, workerId, errorCode) => {
    await finishAgentJob(job.id, workerId, job.attemptCount, {
      kind: 'failed',
      transient: false,
      errorCode,
    });
  },
  supersede: async (job, workerId) => cancelSupersededAgentJob(job, workerId),
};

function asProductionLiveModels(
  models: AgentWorkerModels,
): ProductionLiveWorkerModels | null {
  const decision = models.decisionModel as Partial<ProductionLiveWorkerModels['decisionModel']>;
  const review = models.reviewModel as Partial<ProductionLiveWorkerModels['reviewModel']>;
  if (
    typeof decision.probe !== 'function'
    || typeof decision.reviewLiveDecision !== 'function'
    || typeof decision.healthAuthority !== 'string'
    || typeof review.probe !== 'function'
    || typeof review.reviewLiveDecision !== 'function'
    || typeof review.healthAuthority !== 'string'
  ) return null;
  return {
    decisionModel: decision as ProductionLiveWorkerModels['decisionModel'],
    reviewModel: review as ProductionLiveWorkerModels['reviewModel'],
    limits: models.limits,
  };
}

export async function listScheduledShadowCompanies(
  db: ScheduledCompanyDb = prisma as unknown as ScheduledCompanyDb,
): Promise<ScheduledShadowCompany[]> {
  return db.agentCompanyConfig.findMany({
    where: {
      mode: 'shadow',
      company: { disconnectedAt: null },
    },
    select: {
      companyId: true,
      scheduleMinutes: true,
      liveRequested: true,
      lastDiscoveredAt: true,
    },
    orderBy: { companyId: 'asc' },
  });
}

export async function markShadowDiscovery(
  companyId: string,
  at: Date,
  db: DiscoveryMarkDb = prisma as unknown as DiscoveryMarkDb,
): Promise<void> {
  await db.agentCompanyConfig.updateMany({
    where: { companyId, mode: 'shadow' },
    data: { lastDiscoveredAt: at },
  });
}

export interface ScheduledLiveSafetyDeps {
  readonly evaluate: (companyId: string) => Promise<unknown>;
}

const productionLiveSafetyDeps: ScheduledLiveSafetyDeps = {
  evaluate: evaluateCircuitBreakers,
};

export async function guardScheduledLiveCompany(
  company: ScheduledShadowCompany,
  deps: ScheduledLiveSafetyDeps = productionLiveSafetyDeps,
): Promise<void> {
  if (company.liveRequested) await deps.evaluate(company.companyId);
}

export interface ScheduledLiveRecoveryDeps {
  readonly listCandidates: typeof listAllLiveReconciliationCandidates;
  readonly reconcile: (
    candidate: Awaited<ReturnType<typeof listAllLiveReconciliationCandidates>>[number],
    signal?: AbortSignal,
  ) => ReturnType<typeof reconcileScheduledLiveMutation>;
  readonly defer?: typeof deferLiveReconciliation;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

const productionLiveRecoveryDeps: ScheduledLiveRecoveryDeps = {
  listCandidates: listAllLiveReconciliationCandidates,
  reconcile: (candidate, signal) =>
    reconcileScheduledLiveMutation(candidate, undefined, { signal }),
  defer: deferLiveReconciliation,
};

export async function reconcileScheduledLiveMutations(
  deps: ScheduledLiveRecoveryDeps = productionLiveRecoveryDeps,
): Promise<void> {
  const candidates = await deps.listCandidates();
  const timeoutMs = deps.timeoutMs ?? LIVE_RECOVERY_TIMEOUT_MS;
  const concurrency = deps.concurrency ?? LIVE_RECOVERY_CONCURRENCY;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
  ) throw new Error('Invalid live recovery scheduler configuration.');
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await deps.reconcile(candidate, controller.signal);
      } catch {
        try {
          await deps.defer?.(candidate);
        } catch {
          // A stale exact binding needs no backoff; continue the bounded page.
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  };
  await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, candidates.length) },
      () => worker(),
    ),
  );
}

async function runBoundedSettled<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<unknown>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Invalid scheduler concurrency.');
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await operation(item);
      } catch {
        // Isolation is deliberate; other companies/items must keep progressing.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
}

const productionScheduler = createAgentScheduler({
  workerId: processWorkerId,
  globalConcurrency: GLOBAL_CONCURRENCY,
  now: () => new Date(),
  listShadowCompanies: listScheduledShadowCompanies,
  guardCompany: guardScheduledLiveCompany,
  recoverLiveMutations: reconcileScheduledLiveMutations,
  discoverJobs: discoverShadowJobs,
  markDiscovered: markShadowDiscovery,
  claimJobs: claimShadowJobs,
  runJob: async (job) => runScheduledShadowJob(job, processWorkerId, productionJobDeps),
});

export function startAgentScheduler(): void {
  productionScheduler.start();
}

export function stopAgentScheduler(): void {
  productionScheduler.stop();
}

export async function runAgentTick(): Promise<void> {
  await productionScheduler.tick();
}
