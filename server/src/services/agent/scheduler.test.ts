import type { AgentCompanySettingsDto } from '@recat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from './core/model.js';
import type { ClaimedAgentJob } from './jobs.js';
import {
  getLiveWorkerHealth,
  markLiveWorkerStopped,
} from './liveWorkerHealth.js';
import {
  buildAgentModels,
  createAgentScheduler,
  guardScheduledLiveCompany,
  listScheduledShadowCompanies,
  reconcileScheduledLiveMutations,
  runScheduledShadowJob,
  type AgentSchedulerDeps,
  type AgentSchedulerModelConfig,
} from './scheduler.js';

const NOW = new Date('2026-07-29T08:20:00.000Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function job(id: string, companyId: string): ClaimedAgentJob {
  return {
    id,
    companyId,
    transactionId: `transaction-${id}`,
    revision: 0,
    configVersion: 'config-v1',
    schedulingGeneration: 0,
    status: 'running',
    dueAt: NOW,
    lockOwner: 'opaque-worker',
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function schedulerDeps(
  overrides: Partial<AgentSchedulerDeps> = {},
): AgentSchedulerDeps {
  return {
    workerId: 'opaque-worker',
    globalConcurrency: 4,
    now: () => NOW,
    listShadowCompanies: async () => [],
    discoverJobs: async () => undefined,
    claimJobs: async () => [],
    runJob: async () => undefined,
    ...overrides,
  };
}

function companySettings(
  overrides: Partial<AgentCompanySettingsDto> = {},
): AgentCompanySettingsDto {
  return {
    mode: 'shadow',
    provider: 'openrouter',
    decisionModel: 'decision-alias',
    verifierModel: 'review-alias',
    scheduleMinutes: 10,
    companyConcurrency: 1,
    evidenceThreshold: 50,
    limits: {
      maxToolCalls: 7,
      maxTurns: 3,
      maxContextBytes: 12_345,
      maxResponseBytes: 6_789,
      timeoutMs: 9_876,
    },
    configVersion: 'config-v1',
    ...overrides,
  };
}

function model(provider: 'openrouter' | 'custom', name: string): AgentModel {
  return {
    identity: { provider, model: name },
    nextTurn: vi.fn(),
  };
}

describe('shadow agent scheduler', () => {
  it('keeps shadow evidence when live authorization is absent even if a request exists', async () => {
    const claimed = job('job-shadow-fallback', 'company-generic');
    const runClaimedJob = vi.fn(async () => undefined);
    const runClaimedLiveJob = vi.fn(async () => undefined);

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings(),
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: 'opaque-key',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel: (config) => model(config.provider, config.model),
      isLiveAuthorized: vi.fn(async () => false),
      runClaimedLiveJob,
      runClaimedJob,
      terminalize: vi.fn(),
      supersede: vi.fn(),
    });

    expect(runClaimedLiveJob).not.toHaveBeenCalled();
    expect(runClaimedJob).toHaveBeenCalledOnce();
  });

  it('dispatches live only after current persisted authority and worker health pass', async () => {
    const claimed = job('job-live', 'company-generic');
    const runClaimedJob = vi.fn(async () => undefined);
    const runClaimedLiveJob = vi.fn(async () => undefined);

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings(),
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: 'opaque-key',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel: (config) => model(config.provider, config.model),
      isLiveAuthorized: vi.fn(async () => true),
      runClaimedLiveJob,
      runClaimedJob,
      terminalize: vi.fn(),
      supersede: vi.fn(),
    });

    expect(runClaimedLiveJob).toHaveBeenCalledOnce();
    expect(runClaimedJob).not.toHaveBeenCalled();
  });

  it('reports healthy only after a running scheduler completes a claim cycle and expires stale heartbeats', async () => {
    markLiveWorkerStopped('opaque-worker');
    let now = NOW;
    const scheduler = createAgentScheduler(schedulerDeps({
      now: () => now,
      claimJobs: async () => [],
    }));

    expect(getLiveWorkerHealth('company-generic', now)).toEqual({ healthy: false });
    scheduler.start();
    expect(getLiveWorkerHealth('company-generic', now)).toEqual({ healthy: false });
    await scheduler.tick();
    expect(getLiveWorkerHealth('company-generic', now)).toEqual({ healthy: true });

    now = new Date(NOW.getTime() + 120_001);
    expect(getLiveWorkerHealth('company-generic', now)).toEqual({ healthy: false });
    scheduler.stop();
    expect(getLiveWorkerHealth('company-generic', NOW)).toEqual({ healthy: false });
  });

  it('lists only connected companies for production shadow scheduling', async () => {
    const findMany = vi.fn(async () => []);

    await listScheduledShadowCompanies({
      agentCompanyConfig: { findMany },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        mode: 'shadow',
        company: { disconnectedAt: null },
      },
      select: { companyId: true, scheduleMinutes: true, liveRequested: true },
      orderBy: { companyId: 'asc' },
    });
  });

  it('does not overlap ticks in one process', async () => {
    const discovery = deferred<void>();
    const listShadowCompanies = vi.fn(async () => [
      { companyId: 'company-1', scheduleMinutes: 10, liveRequested: false },
    ]);
    const discoverJobs = vi.fn(async () => discovery.promise);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs,
    }));

    const firstTick = scheduler.tick();
    await vi.waitFor(() => expect(discoverJobs).toHaveBeenCalledTimes(1));
    await scheduler.tick();
    expect(listShadowCompanies).toHaveBeenCalledTimes(1);

    discovery.resolve();
    await firstTick;
  });

  it('resets the overlap guard after a rejected tick', async () => {
    const listShadowCompanies = vi.fn()
      .mockRejectedValueOnce(new Error('sensitive failure'))
      .mockResolvedValueOnce([]);
    const scheduler = createAgentScheduler(schedulerDeps({ listShadowCompanies }));

    await expect(scheduler.tick()).rejects.toThrow('sensitive failure');
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(listShadowCompanies).toHaveBeenCalledTimes(2);
  });

  it('discovers only deterministic due companies and remains restart-safe', async () => {
    const listShadowCompanies = vi.fn(async () => [
      { companyId: 'due-10', scheduleMinutes: 10, liveRequested: false },
      { companyId: 'not-due-7', scheduleMinutes: 7, liveRequested: false },
      { companyId: 'due-4', scheduleMinutes: 4, liveRequested: false },
    ]);
    const firstDiscover = vi.fn(async () => undefined);
    const secondDiscover = vi.fn(async () => undefined);

    await createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs: firstDiscover,
    })).tick();
    await createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs: secondDiscover,
    })).tick();

    expect(firstDiscover.mock.calls.map(([companyId]) => companyId)).toEqual(['due-10', 'due-4']);
    expect(secondDiscover.mock.calls).toEqual(firstDiscover.mock.calls);
  });

  it('guards every company each cycle and isolates one unhealthy company', async () => {
    const guardCompany = vi.fn(async (company: { companyId: string }) => {
      if (company.companyId === 'company-unhealthy') throw new Error('bounded failure');
    });
    const discoverJobs = vi.fn(async () => undefined);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies: async () => [
        { companyId: 'company-unhealthy', scheduleMinutes: 10, liveRequested: true },
        { companyId: 'company-healthy', scheduleMinutes: 10, liveRequested: true },
      ],
      guardCompany,
      discoverJobs,
    }));

    await scheduler.tick();
    await scheduler.tick();

    expect(guardCompany.mock.calls).toEqual([
      [expect.objectContaining({ companyId: 'company-unhealthy' })],
      [expect.objectContaining({ companyId: 'company-healthy' })],
      [expect.objectContaining({ companyId: 'company-unhealthy' })],
      [expect.objectContaining({ companyId: 'company-healthy' })],
    ]);
    expect(discoverJobs).toHaveBeenCalledTimes(4);
  });

  it('isolates one company discovery failure from every other due company', async () => {
    const discoverJobs = vi.fn(async (companyId: string) => {
      if (companyId === 'company-unhealthy') throw new Error('bounded failure');
    });
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies: async () => [
        { companyId: 'company-unhealthy', scheduleMinutes: 10, liveRequested: false },
        { companyId: 'company-healthy', scheduleMinutes: 10, liveRequested: false },
      ],
      discoverJobs,
    }));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(discoverJobs).toHaveBeenCalledTimes(2);
  });

  it('bounds company discovery concurrency to the configured global capacity', async () => {
    const release = deferred<void>();
    let active = 0;
    let maximum = 0;
    const discoverJobs = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await release.promise;
      active -= 1;
    });
    const scheduler = createAgentScheduler(schedulerDeps({
      globalConcurrency: 3,
      listShadowCompanies: async () =>
        Array.from({ length: 8 }, (_, index) => ({
          companyId: `company-${index}`,
          scheduleMinutes: 10,
          liveRequested: false,
        })),
      discoverJobs,
    }));

    const ticking = scheduler.tick();
    await vi.waitFor(() => expect(discoverJobs).toHaveBeenCalledTimes(3));
    expect(maximum).toBe(3);
    release.resolve();
    await ticking;
    expect(discoverJobs).toHaveBeenCalledTimes(8);
  });

  it('reaches durable live recovery even when mutable company mode removes ordinary scheduling', async () => {
    const recoverLiveMutations = vi.fn(async () => undefined);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies: async () => [],
      recoverLiveMutations,
    }));

    await scheduler.tick();

    expect(recoverLiveMutations).toHaveBeenCalledOnce();
  });

  it('skips credential-backed breaker probes without live intent', async () => {
    const evaluate = vi.fn(async () => undefined);

    await guardScheduledLiveCompany({
      companyId: 'company-generic',
      scheduleMinutes: 10,
      liveRequested: false,
    }, {
      evaluate,
    });

    expect(evaluate).not.toHaveBeenCalled();
  });

  it('evaluates breakers for requested live companies even when already paused', async () => {
    const evaluate = vi.fn(async () => undefined);
    await guardScheduledLiveCompany({
      companyId: 'company-generic',
      scheduleMinutes: 10,
      liveRequested: true,
    }, {
      evaluate,
    });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith('company-generic');
  });

  it('reconciles globally enumerated durable mutations without evaluating provider health', async () => {
    const candidate = {
      companyId: 'company-generic',
      transactionId: 'transaction-generic',
      qboType: 'Purchase' as const,
      qboId: 'purchase-generic',
      requestId: 'request-generic',
      operation: 'recategorize' as const,
      expectedRevision: 1,
      configVersion: 'config-v1',
      requestHash: 'a'.repeat(64),
      checkpointHash: 'b'.repeat(64),
    };
    const reconcile = vi.fn(async () => ({
      transactionId: 'transaction-generic',
      requestId: 'request-generic',
      ok: false,
      status: 'ERROR' as const,
      outcome: 'IN_PROGRESS' as const,
    }));

    await reconcileScheduledLiveMutations({
      listCandidates: vi.fn(async () => [candidate]),
      reconcile,
    });

    expect(reconcile).toHaveBeenCalledWith(
      candidate,
      expect.any(AbortSignal),
    );
  });

  it('aborts a hung recovery and durably defers only that exact operation', async () => {
    vi.useFakeTimers();
    try {
      const candidate = {
        companyId: 'company-generic',
        transactionId: 'transaction-generic',
        qboType: 'Purchase' as const,
        qboId: 'purchase-generic',
        requestId: 'request-generic',
        operation: 'recategorize' as const,
        expectedRevision: 1,
        configVersion: 'config-v1',
        requestHash: 'a'.repeat(64),
        checkpointHash: 'b'.repeat(64),
      };
      const defer = vi.fn(async () => undefined);
      const reconciling = reconcileScheduledLiveMutations({
        listCandidates: vi.fn(async () => [candidate]),
        reconcile: vi.fn(async (_input, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })),
        defer,
        timeoutMs: 1_000,
        concurrency: 1,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await reconciling;

      expect(defer).toHaveBeenCalledWith(candidate);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues its bounded page when stale-binding backoff itself fails', async () => {
    const candidates = ['first', 'second'].map((suffix) => ({
      companyId: `company-${suffix}`,
      transactionId: `transaction-${suffix}`,
      qboType: 'Purchase' as const,
      qboId: `purchase-${suffix}`,
      requestId: `request-${suffix}`,
      operation: 'recategorize' as const,
      expectedRevision: 1,
      configVersion: 'config-v1',
      requestHash: 'a'.repeat(64),
      checkpointHash: 'b'.repeat(64),
    }));
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('bounded read failure'))
      .mockResolvedValueOnce({
        transactionId: 'transaction-second',
        requestId: 'request-second',
        ok: true,
        status: 'POSTED',
        outcome: 'VERIFIED',
      });

    await reconcileScheduledLiveMutations({
      listCandidates: vi.fn(async () => candidates),
      reconcile,
      defer: vi.fn(async () => {
        throw new Error('stale exact binding');
      }),
      concurrency: 1,
    });

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not let a pre-stop tick claim when restarted before discovery resolves', async () => {
    const discovery = deferred<void>();
    const discoverJobs = vi.fn(async () => discovery.promise);
    const claimJobs = vi.fn(async () => []);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies: async () => [{
        companyId: 'company-1',
        scheduleMinutes: 10,
        liveRequested: false,
      }],
      discoverJobs,
      claimJobs,
    }));

    const tick = scheduler.tick();
    await vi.waitFor(() => expect(discoverJobs).toHaveBeenCalledOnce());
    scheduler.stop();
    scheduler.start();
    discovery.resolve();
    await tick;
    expect(claimJobs).not.toHaveBeenCalled();

    await scheduler.tick();
    expect(claimJobs).toHaveBeenCalledOnce();
  });

  it('does not let a pre-stop tick launch when restarted before claim resolves', async () => {
    const firstClaim = deferred<readonly ClaimedAgentJob[]>();
    const claimJobs = vi.fn()
      .mockImplementationOnce(async () => firstClaim.promise)
      .mockResolvedValueOnce([job('job-2', 'company-1')]);
    const runJob = vi.fn(async () => undefined);
    const scheduler = createAgentScheduler(schedulerDeps({
      claimJobs,
      runJob,
    }));

    const tick = scheduler.tick();
    await vi.waitFor(() => expect(claimJobs).toHaveBeenCalledOnce());
    scheduler.stop();
    scheduler.start();
    firstClaim.resolve([job('job-1', 'company-1')]);
    await tick;

    expect(runJob).not.toHaveBeenCalled();

    await scheduler.tick();
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-2' }));
  });

  it('isolates one claimed job failure from the other claimed jobs', async () => {
    const jobs = [job('job-1', 'company-1'), job('job-2', 'company-2')];
    const runJob = vi.fn(async (claimed: ClaimedAgentJob) => {
      if (claimed.id === 'job-1') throw new Error('sensitive job failure');
    });
    const scheduler = createAgentScheduler(schedulerDeps({
      claimJobs: async () => jobs,
      runJob,
    }));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(runJob.mock.calls.map(([claimed]) => claimed.id)).toEqual(['job-1', 'job-2']);
  });

  it('builds provider-specific decision and review models with all bounded limits', () => {
    const created: AgentSchedulerModelConfig[] = [];
    const settings = companySettings();
    const built = buildAgentModels(settings, {
      aiEndpoint: 'https://custom.invalid/v1',
      aiApiKey: 'custom-secret',
      openrouterApiKey: 'openrouter-secret',
      openrouterReferer: 'https://recat.invalid',
      openrouterTitle: 'Recat',
    }, (config) => {
      created.push(config);
      return model(config.provider, config.model);
    });

    expect(created).toEqual([
      {
        provider: 'openrouter',
        model: 'decision-alias',
        apiKey: 'openrouter-secret',
        referer: 'https://recat.invalid',
        title: 'Recat',
      },
      {
        provider: 'openrouter',
        model: 'review-alias',
        apiKey: 'openrouter-secret',
        referer: 'https://recat.invalid',
        title: 'Recat',
      },
    ]);
    expect(built).toMatchObject({
      decisionModel: { identity: { provider: 'openrouter', model: 'decision-alias' } },
      reviewModel: { identity: { provider: 'openrouter', model: 'review-alias' } },
      limits: settings.limits,
    });
    expect(JSON.stringify(built)).not.toContain('openrouter-secret');
  });

  it('passes custom endpoint credentials only to model construction', () => {
    const created: AgentSchedulerModelConfig[] = [];
    const built = buildAgentModels(companySettings({
      provider: 'custom',
    }), {
      aiEndpoint: 'https://custom.invalid/v1',
      aiApiKey: 'custom-secret',
      openrouterApiKey: 'openrouter-secret',
      openrouterReferer: '',
      openrouterTitle: '',
    }, (config) => {
      created.push(config);
      return model(config.provider, config.model);
    });

    expect(created).toEqual([
      {
        provider: 'custom',
        model: 'decision-alias',
        baseUrl: 'https://custom.invalid/v1',
        apiKey: 'custom-secret',
      },
      {
        provider: 'custom',
        model: 'review-alias',
        baseUrl: 'https://custom.invalid/v1',
        apiKey: 'custom-secret',
      },
    ]);
    expect(JSON.stringify(built)).not.toContain('custom-secret');
  });

  it('fenced-terminalizes a claim when provider configuration is unavailable', async () => {
    const claimed = job('job-1', 'company-1');
    const runClaimedJob = vi.fn();
    const terminalize = vi.fn(async () => undefined);
    const createModel = vi.fn();

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings(),
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: '',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel,
      runClaimedJob,
      terminalize,
      supersede: vi.fn(),
    });

    expect(createModel).not.toHaveBeenCalled();
    expect(runClaimedJob).not.toHaveBeenCalled();
    expect(terminalize).toHaveBeenCalledWith(
      claimed,
      'opaque-worker',
      'AGENT_MODEL_CONFIG_INVALID',
    );
  });

  it('resumes an exact live recovery before loading unusable current model settings', async () => {
    const claimed = job('job-recovery', 'company-generic');
    const runClaimedLiveRecovery = vi.fn(async () => true);
    const terminalize = vi.fn();

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => {
        throw new Error('current settings must not gate exact recovery');
      },
      getProviderSettings: async () => {
        throw new Error('current provider settings must not gate exact recovery');
      },
      createModel: vi.fn(),
      runClaimedJob: vi.fn(),
      runClaimedLiveRecovery,
      terminalize,
      supersede: vi.fn(),
    });

    expect(runClaimedLiveRecovery).toHaveBeenCalledWith(claimed, 'opaque-worker');
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('does not terminalize a valid claim for an infrastructure settings read failure', async () => {
    const claimed = job('job-1', 'company-1');
    const terminalize = vi.fn(async () => undefined);

    await expect(runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => {
        throw new Error('sensitive database failure');
      },
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: '',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel: vi.fn(),
      runClaimedJob: vi.fn(),
      terminalize,
      supersede: vi.fn(),
    })).rejects.toThrow('sensitive database failure');

    expect(terminalize).not.toHaveBeenCalled();
  });

  it('fenced-supersedes a claim disabled after claim without constructing a model', async () => {
    const claimed = job('job-1', 'company-1');
    const createModel = vi.fn();
    const runClaimedJob = vi.fn();
    const terminalize = vi.fn(async () => undefined);
    const supersede = vi.fn(async () => true);

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings({
        mode: 'off',
        configVersion: 'config-v2',
      }),
      getProviderSettings: async () => {
        throw new Error('provider settings must not load for stale config');
      },
      createModel,
      runClaimedJob,
      terminalize,
      supersede,
    });

    expect(supersede).toHaveBeenCalledWith(claimed, 'opaque-worker');
    expect(createModel).not.toHaveBeenCalled();
    expect(runClaimedJob).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('uses the existing jobs timer for start, tick, and stop integration', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const sweepQboTokenRevocations = vi.fn(async () => undefined);
    const startAgentScheduler = vi.fn();
    const stopAgentScheduler = vi.fn();
    const runAgentTick = vi.fn(async () => undefined);
    const runAttachmentCleanup = vi.fn(async () => ({
      grants: 0,
      staging: 0,
      blobs: 0,
    }));
    const recoverStuckAttachmentOperations = vi.fn(async () => ({
      inspected: 0,
      recovered: 0,
    }));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.doMock('../../lib/prisma.js', () => ({
      prisma: {
        transaction: { findMany: vi.fn(async () => []) },
        company: { findMany: vi.fn(async () => []) },
      },
    }));
    vi.doMock('../qboTokenRevocation.js', () => ({ sweepQboTokenRevocations }));
    vi.doMock('../audit.js', () => ({ writeAudit: vi.fn() }));
    vi.doMock('../sync.js', () => ({ syncCompany: vi.fn(async () => undefined) }));
    vi.doMock('../../lib/mailer.js', () => ({
      isSmtpConfigured: vi.fn(async () => false),
      sendMail: vi.fn(),
    }));
    vi.doMock('./scheduler.js', () => ({
      startAgentScheduler,
      stopAgentScheduler,
      runAgentTick,
    }));
    vi.doMock('../attachments/cleanup.js', () => ({ runAttachmentCleanup }));
    vi.doMock('../attachments/operations.js', () => ({
      recoverStuckAttachmentOperations,
    }));

    const jobsScheduler = await import('../../jobs/scheduler.js');
    jobsScheduler.startJobs();
    expect(vi.getTimerCount()).toBe(1);
    expect(startAgentScheduler).toHaveBeenCalledOnce();
    expect(sweepQboTokenRevocations).toHaveBeenCalledOnce();
    expect(runAgentTick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAgentTick).toHaveBeenCalledTimes(2);
    expect(sweepQboTokenRevocations).toHaveBeenCalledTimes(2);
    expect(runAttachmentCleanup).toHaveBeenCalledTimes(2);
    expect(recoverStuckAttachmentOperations).toHaveBeenCalledTimes(2);

    jobsScheduler.stopJobs();
    expect(stopAgentScheduler).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    consoleLog.mockRestore();
    vi.useRealTimers();
    vi.doUnmock('../../lib/prisma.js');
    vi.doUnmock('../qboTokenRevocation.js');
    vi.doUnmock('../audit.js');
    vi.doUnmock('../sync.js');
    vi.doUnmock('../../lib/mailer.js');
    vi.doUnmock('./scheduler.js');
    vi.doUnmock('../attachments/cleanup.js');
  });
});
