import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_POLICY_VERSION,
  LiveGateError,
  enableLiveMode,
  enableLiveModeForAdmin,
  evaluateLiveGates,
  failClosedLiveProviderHealthProbe,
  failClosedLiveWorkerHealthProbe,
  getLiveProviderBinding,
  getRecentLiveShadowMetrics,
  hasCurrentQboTokenState,
  pauseLiveMode,
  probeConfiguredLiveProviderHealth,
  type LiveGateDeps,
  type LiveGateConfig,
  type LiveProviderHealthDeps,
} from './liveGates.js';
import type { LiveAgentModel } from './liveVerifier.js';
import { getTaxReadinessInTransaction } from '../tax/reference.js';
import { encrypt } from '../../lib/crypto.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function config(overrides: Partial<LiveGateConfig> = {}): LiveGateConfig {
  return {
    companyId: 'company-1',
    mode: 'shadow',
    provider: 'custom',
    decisionModel: 'decision-model',
    verifierModel: 'verifier-model',
    evidenceThreshold: 50,
    configVersion: 'a'.repeat(64),
    liveRequested: false,
    liveAcceptedPolicyVersion: null,
    liveAcceptedConfigVersion: null,
    liveAcceptedProviderBinding: null,
    liveEnabledAt: null,
    liveEnabledByUserId: null,
    livePausedAt: null,
    livePauseCode: null,
    livePauseMessage: null,
    ...overrides,
  };
}

function createDeps(overrides: Partial<LiveGateDeps> = {}): LiveGateDeps & { config: LiveGateConfig } {
  const state = {
    config: config(),
  };
  const deps: LiveGateDeps = {
    now: () => NOW,
    getConfig: async () => state.config,
    getCompany: async () => ({
      legalName: 'Acme Books',
      disconnectedAt: null,
      dryRun: false,
      qboClientCredentialsReady: true,
      qboTokensReady: true,
    }),
    getEvidence: async () => ({
      eligibleRuns: 50,
      agreements: 50,
      disagreements: 0,
      threshold: 50,
      thresholdMet: true,
    }),
    getShadowMetrics: async () => ({ abstentions: 0, errors: 0 }),
    getTaxReadiness: async () => ({
      status: 'ready',
      refreshedAt: NOW.toISOString(),
    }),
    getWriteBlockers: async () => ({ unresolvedMutations: 0 }),
    getProviderBinding: async () => `binding:${state.config.configVersion}`,
    getProviderHealth: async () => ({
      binding: `binding:${state.config.configVersion}`,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/decision',
      verifierIdentity: 'custom:resolved/verifier',
    }),
    getWorkerHealth: async () => ({ healthy: true }),
    authorizeAdmin: async () => true,
    updateConfig: async (_companyId, update) => {
      state.config = { ...state.config, ...update };
      return state.config;
    },
    withTransaction: async (callback) => callback(deps),
  };
  Object.assign(deps, overrides);
  Object.defineProperty(deps, 'config', {
    get: () => state.config,
    set: (value: LiveGateConfig) => { state.config = value; },
  });
  return deps as LiveGateDeps & { config: LiveGateConfig };
}

function providerHealthDeps(options: {
  binding?: string;
  apiKey?: string;
  resolved?: (requested: string) => { provider: 'custom' | 'openrouter'; model: string };
  probe?: LiveAgentModel['probe'];
} = {}): LiveProviderHealthDeps {
  return {
    getAuthority: async () => ({
      binding: options.binding ?? 'opaque-binding-current',
      config: {
        provider: 'custom',
        decisionModel: 'decision-alias',
        verifierModel: 'verifier-alias',
      },
      settings: {
        intuitClientId: '',
        intuitClientSecret: '',
        webhookVerifierToken: '',
        suggestionSource: 'off',
        suggestionProvider: 'custom',
        suggestionModel: 'suggestion-model',
        agentDecisionModel: 'decision-alias',
        agentVerifierModel: 'verifier-alias',
        aiEndpoint: 'https://models.invalid/v1',
        aiApiKey: options.apiKey ?? 'synthetic-provider-key',
        openrouterApiKey: '',
        openrouterReferer: '',
        openrouterTitle: '',
        smtpHost: '',
        smtpPort: 587,
        smtpUser: '',
        smtpPass: '',
        smtpFrom: 'noreply@example.invalid',
        smtpFromEnv: false,
      },
    }),
    createModel: (modelConfig) => {
      const identity = {
        provider: modelConfig.provider,
        model: modelConfig.model,
      };
      return {
        identity,
        healthAuthority: `opaque:${modelConfig.provider}:${modelConfig.model}:${options.binding ?? 'current'}`,
        nextTurn: vi.fn(),
        probe: options.probe ?? vi.fn(async () => ({
          identity: options.resolved?.(modelConfig.model) ?? {
            provider: modelConfig.provider,
            model: `resolved/${modelConfig.model}`,
          },
        })),
        reviewLiveDecision: vi.fn(),
      };
    },
  };
}

describe('guarded live autopilot gates', () => {
  let deps: LiveGateDeps & { config: LiveGateConfig };

  beforeEach(() => {
    deps = createDeps();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports every failed gate instead of stopping at the first', async () => {
    deps = createDeps({
      getEvidence: async () => ({
        eligibleRuns: 12,
        agreements: 6,
        disagreements: 6,
        threshold: 50,
        thresholdMet: false,
      }),
      getTaxReadiness: async () => ({ status: 'ready', refreshedAt: '2026-07-27T11:59:59.999Z' }),
      getCompany: async () => ({
        legalName: 'Acme Books',
        disconnectedAt: NOW,
        dryRun: false,
        qboClientCredentialsReady: false,
        qboTokensReady: false,
      }),
    });
    deps.config.verifierModel = deps.config.decisionModel;
    deps.getProviderHealth = async () => ({
      binding: `binding:${deps.config.configVersion}`,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/shared',
      verifierIdentity: 'custom:resolved/shared',
    });

    const readiness = await evaluateLiveGates('company-1', deps);

    expect(readiness.gates.filter((gate) => !gate.ok).map((gate) => gate.code)).toEqual([
      'EVIDENCE_INSUFFICIENT',
      'SHADOW_AGREEMENT_INSUFFICIENT',
      'VERIFIER_NOT_DISTINCT',
      'TAX_REFERENCE_STALE',
      'QBO_DISCONNECTED',
      'LIVE_POLICY_NOT_ACCEPTED',
    ]);
    expect(JSON.stringify(readiness)).not.toContain('Acme Books');
  });

  it('fails invalid evidence closed while keeping the public DTO finite and serializable', async () => {
    deps = createDeps({
      getEvidence: async () => ({
        eligibleRuns: Number.NaN,
        agreements: Number.POSITIVE_INFINITY,
        disagreements: -1,
        threshold: Number.POSITIVE_INFINITY,
        thresholdMet: false,
      }),
      getShadowMetrics: async () => ({
        abstentions: Number.POSITIVE_INFINITY,
        errors: Number.NaN,
      }),
      getWriteBlockers: async () => ({
        unresolvedMutations: Number.POSITIVE_INFINITY,
      }),
    });

    const readiness = await evaluateLiveGates('company-1', deps);

    expect(readiness.evidence.eligibleRuns).toBe(0);
    expect(readiness.evidence.threshold).toBe(0);
    expect(readiness.gates.find((result) => result.code === 'EVIDENCE_INSUFFICIENT'))
      .toMatchObject({ ok: false });
    expect(readiness.gates.find((result) => result.code === 'UNRESOLVED_MUTATION'))
      .toMatchObject({ ok: false });
    expect(JSON.parse(JSON.stringify(readiness))).toEqual(readiness);
    expect(JSON.stringify(readiness)).not.toMatch(/Infinity|NaN/);
  });

  it('uses exact provider-returned identities instead of caller aliases for distinctness', async () => {
    deps.getProviderHealth = async () => ({
      binding: `binding:${deps.config.configVersion}`,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/shared',
      verifierIdentity: 'custom:resolved/shared',
    });

    const readiness = await evaluateLiveGates('company-1', deps);

    expect(readiness.gates.find((gate) => gate.code === 'VERIFIER_NOT_DISTINCT'))
      .toMatchObject({ ok: false });
  });

  it('requires exact company-name confirmation', async () => {
    await expect(enableLiveMode(
      'company-1',
      'wrong name',
      { userId: 'admin-1', isAdmin: true },
      deps,
    )).rejects.toMatchObject({ code: 'LIVE_CONFIRMATION_MISMATCH' });
  });

  it('binds delayed provider health to the exact configuration accepted by enable', async () => {
    let releaseProbe: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      deps.getProviderHealth = async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseProbe = release;
        });
        return {
          binding: `binding:${'a'.repeat(64)}`,
          decisionModel: true,
          verifierModel: true,
          decisionIdentity: 'custom:resolved/decision',
          verifierIdentity: 'custom:resolved/verifier',
        };
      };
    });

    const enabling = enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    );
    await probeStarted;
    deps.config = config({ configVersion: 'b'.repeat(64) });
    releaseProbe?.();

    const readiness = await enabling;

    expect(readiness.gates.find((gate) => gate.code === 'PROVIDER_UNHEALTHY'))
      .toMatchObject({ ok: false });
    expect(deps.config).toMatchObject({
      liveRequested: true,
      liveAcceptedConfigVersion: 'b'.repeat(64),
      liveEnabledAt: null,
      livePauseCode: 'PROVIDER_UNHEALTHY',
    });
  });

  it('requires readiness and enable to bypass cached provider success identities', async () => {
    const getProviderHealth = vi.fn(async () => ({
      binding: `binding:${deps.config.configVersion}`,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/decision',
      verifierIdentity: 'custom:resolved/verifier',
    }));
    deps.getProviderHealth = getProviderHealth;

    await evaluateLiveGates('company-1', deps);
    await enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    );

    expect(getProviderHealth).toHaveBeenNthCalledWith(
      1,
      'company-1',
      { bypassSuccessCache: true },
    );
    expect(getProviderHealth).toHaveBeenNthCalledWith(
      2,
      'company-1',
      { bypassSuccessCache: true },
    );
  });

  it('keeps the production provider authority fail closed without making a catalog request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(failClosedLiveProviderHealthProbe('binding-current')).resolves.toEqual({
      binding: 'binding-current',
      decisionModel: false,
      verifierModel: false,
      decisionIdentity: null,
      verifierIdentity: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('binds health evidence to exact instance provider endpoint and credential settings', async () => {
    const bindingFor = (
      endpoint: string,
      apiKey: string,
      instanceDecisionModel = 'decision-model',
    ) => getLiveProviderBinding('company-1', {
      agentCompanyConfig: {
        findUnique: async () => ({
          configVersion: 'config-current',
          provider: 'custom',
          decisionModel: 'decision-model',
          verifierModel: 'verifier-model',
        }),
      },
      appConfig: {
        findMany: async () => [
          { key: 'aiEndpoint', value: endpoint, encrypted: false },
          { key: 'aiApiKey', value: apiKey, encrypted: false },
          { key: 'agentDecisionModel', value: instanceDecisionModel, encrypted: false },
        ],
      },
    });

    const first = await bindingFor('https://models.example/v1', 'credential-a');
    const endpointChanged = await bindingFor('https://models.example/v2', 'credential-a');
    const credentialChanged = await bindingFor('https://models.example/v1', 'credential-b');
    const instanceModelChanged = await bindingFor(
      'https://models.example/v1',
      'credential-a',
      'decision-model-v2',
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(endpointChanged).not.toBe(first);
    expect(credentialChanged).not.toBe(first);
    expect(instanceModelChanged).not.toBe(first);
    expect(first).not.toMatch(/models|credential/i);
  });

  it('returns canonical credential-backed health bound to the exact authority', async () => {
    await expect(probeConfiguredLiveProviderHealth(
      'company-1',
      providerHealthDeps({ binding: 'opaque-binding-a' }),
    )).resolves.toEqual({
      binding: 'opaque-binding-a',
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/decision-alias',
      verifierIdentity: 'custom:resolved/verifier-alias',
    });
  });

  it('fails provider health closed before transport when credentials are missing', async () => {
    const deps = providerHealthDeps({ apiKey: '' });
    const createModel = vi.spyOn(deps, 'createModel');

    await expect(probeConfiguredLiveProviderHealth('company-1', deps)).resolves.toEqual({
      binding: 'opaque-binding-current',
      decisionModel: false,
      verifierModel: false,
      decisionIdentity: null,
      verifierIdentity: null,
    });
    expect(createModel).not.toHaveBeenCalled();
  });

  it('fails provider health closed without returning authority lookup errors', async () => {
    const providerProse = 'provider-authority-private-sentinel';
    const health = await probeConfiguredLiveProviderHealth('company-1', {
      getAuthority: async () => {
        throw new Error(providerProse);
      },
      createModel: vi.fn(),
    });

    expect(health).toEqual({
      binding: 'missing',
      decisionModel: false,
      verifierModel: false,
      decisionIdentity: null,
      verifierIdentity: null,
    });
    expect(JSON.stringify(health)).not.toContain(providerProse);
  });

  it('fails provider health closed on returned provider mismatch or invalid identity', async () => {
    const mismatch = providerHealthDeps({
      binding: 'opaque-binding-provider-mismatch',
      resolved: (requested) => ({ provider: 'openrouter', model: `resolved/${requested}` }),
    });
    const invalid = providerHealthDeps({
      binding: 'opaque-binding-invalid-schema',
      resolved: () => ({ provider: 'custom', model: '' }),
    });

    await expect(probeConfiguredLiveProviderHealth('company-1', mismatch))
      .resolves.toMatchObject({ decisionModel: false, verifierModel: false });
    await expect(probeConfiguredLiveProviderHealth('company-1', invalid))
      .resolves.toMatchObject({ decisionModel: false, verifierModel: false });
  });

  it('fails provider health closed when a credential-backed probe times out', async () => {
    vi.useFakeTimers();
    try {
      const health = probeConfiguredLiveProviderHealth(
        'company-1',
        providerHealthDeps({
          binding: 'opaque-binding-timeout',
          probe: vi.fn(async () => new Promise<never>(() => undefined)),
        }),
      );
      const result = expect(health).resolves.toMatchObject({
        binding: 'opaque-binding-timeout',
        decisionModel: false,
        verifierModel: false,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the production worker authority fail closed until a heartbeat is implemented', async () => {
    await expect(failClosedLiveWorkerHealthProbe('company-1')).resolves.toEqual({
      healthy: false,
    });
  });

  it('requires positive QuickBooks client credentials and company tokens', async () => {
    deps.getCompany = async () => ({
      legalName: 'Acme Books',
      disconnectedAt: null,
      dryRun: false,
      qboClientCredentialsReady: false,
      qboTokensReady: false,
    });

    const readiness = await evaluateLiveGates('company-1', deps);

    expect(readiness.gates.find((gate) => gate.code === 'QBO_DISCONNECTED'))
      .toMatchObject({ ok: false });
    expect(JSON.stringify(readiness)).not.toMatch(/access|refresh|token|credential-secret/i);
  });

  it('requires authenticated, non-expired QuickBooks token state without exposing token values', () => {
    const accessToken = encrypt('access-token-sentinel');
    const refreshToken = encrypt('refresh-token-sentinel');

    expect(hasCurrentQboTokenState({
      accessToken,
      refreshToken,
      tokenExpiresAt: new Date('2026-07-29T13:00:00.000Z'),
    }, NOW)).toBe(true);
    expect(hasCurrentQboTokenState({
      accessToken: 'malformed-token-ciphertext',
      refreshToken,
      tokenExpiresAt: new Date('2026-07-29T13:00:00.000Z'),
    }, NOW)).toBe(false);
    expect(hasCurrentQboTokenState({
      accessToken,
      refreshToken,
      tokenExpiresAt: new Date('2026-07-29T11:59:59.999Z'),
    }, NOW)).toBe(false);
  });

  it('excludes old abstentions and errors from the rolling live-readiness rates', async () => {
    const cutoff = new Date('2026-06-29T12:00:00.000Z');
    const runs = [
      { status: 'abstain', completedAt: new Date('2026-06-29T11:59:59.999Z') },
      { status: 'failed', completedAt: new Date('2026-06-29T11:59:59.999Z') },
      { status: 'abstain', completedAt: new Date('2026-07-29T12:00:00.001Z') },
      { status: 'failed', completedAt: new Date('2026-07-29T12:00:00.001Z') },
    ];
    const count = vi.fn(async ({ where }: {
      where: {
        companyId: string;
        configVersion: string;
        status: string;
        completedAt: { gte: Date; lte: Date };
      };
    }) => runs.filter((run) =>
      run.status === where.status
      && run.completedAt >= where.completedAt.gte
      && run.completedAt <= where.completedAt.lte).length);

    await expect(getRecentLiveShadowMetrics('company-1', {
      completedSince: cutoff,
      completedThrough: NOW,
    }, {
      agentCompanyConfig: {
        findUnique: async () => ({ configVersion: 'config-current' }),
      },
      agentRun: { count },
    })).resolves.toEqual({ abstentions: 0, errors: 0 });
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('uses one captured closed evidence window for evidence, abstentions, and errors', async () => {
    const windows: unknown[] = [];
    deps.getEvidence = async (_companyId, window) => {
      windows.push(window);
      return {
        eligibleRuns: 50,
        agreements: 50,
        disagreements: 0,
        threshold: 50,
        thresholdMet: true,
      };
    };
    deps.getShadowMetrics = async (_companyId, window) => {
      windows.push(window);
      return { abstentions: 0, errors: 0 };
    };

    await evaluateLiveGates('company-1', deps);

    expect(windows).toHaveLength(2);
    expect(windows[0]).toBe(windows[1]);
    expect(windows[0]).toEqual({
      completedSince: new Date('2026-06-29T12:00:00.000Z'),
      completedThrough: NOW,
    });
  });

  it('requires an administrator before recording live acceptance', async () => {
    await expect(enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'member-1', isAdmin: false },
      deps,
    )).rejects.toMatchObject({ code: 'LIVE_ADMIN_REQUIRED' });
    expect(deps.config.liveRequested).toBe(false);
  });

  it('checks durable company-admin authority before the public enable capability', async () => {
    const authorizeAdmin = vi.fn(async () => false);

    await expect(enableLiveModeForAdmin(
      'company-1',
      'Acme Books',
      'categorizer-1',
      { authorizeAdmin },
      deps,
    )).rejects.toMatchObject({ code: 'LIVE_ADMIN_REQUIRED' });
    expect(authorizeAdmin).toHaveBeenCalledWith('categorizer-1', 'company-1');
    expect(deps.config.liveRequested).toBe(false);
  });

  it('checks durable administrator authority inside the enable mutation transaction', async () => {
    const order: string[] = [];
    deps.withTransaction = async (callback) => {
      order.push('company-fence');
      return callback(deps);
    };
    const authorizeAdmin = vi.fn(async () => {
      order.push('authorize');
      return false;
    });

    await expect(enableLiveModeForAdmin(
      'company-1',
      'Acme Books',
      'revoked-admin',
      { authorizeAdmin },
      deps,
    )).rejects.toMatchObject({ code: 'LIVE_ADMIN_REQUIRED' });

    expect(order).toEqual(['company-fence', 'authorize']);
    expect(deps.config.liveRequested).toBe(false);
  });

  it('completes the fresh provider probe before entering the enable database transaction', async () => {
    const order: string[] = [];
    deps.getProviderHealth = vi.fn(async () => {
      order.push('provider-probe');
      return {
        binding: `binding:${deps.config.configVersion}`,
        decisionModel: true,
        verifierModel: true,
        decisionIdentity: 'custom:resolved/decision',
        verifierIdentity: 'custom:resolved/verifier',
      };
    });
    deps.withTransaction = async (callback) => {
      order.push('company-fence');
      return callback(deps);
    };
    const authorizeAdmin = vi.fn(async () => {
      order.push('authorize');
      return true;
    });

    await enableLiveModeForAdmin(
      'company-1',
      'Acme Books',
      'admin-1',
      { authorizeAdmin },
      deps,
    );

    expect(order.slice(0, 3)).toEqual([
      'provider-probe',
      'company-fence',
      'authorize',
    ]);
  });

  it('records policy acceptance, actor, and enabled state only when all gates pass', async () => {
    const readiness = await enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    );

    expect(readiness.gates.every((gate) => gate.ok)).toBe(true);
    expect(deps.config).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
      liveAcceptedConfigVersion: 'a'.repeat(64),
      liveEnabledAt: NOW,
      liveEnabledByUserId: 'admin-1',
      livePausedAt: null,
      livePauseCode: null,
      livePauseMessage: null,
    });
  });

  it('keeps a stronger durable pause when enable is blocked and returns the final persisted state', async () => {
    deps.config = config({
      liveRequested: true,
      liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
      liveAcceptedConfigVersion: 'a'.repeat(64),
      liveAcceptedProviderBinding: `binding:${'a'.repeat(64)}`,
      liveEnabledAt: NOW,
      liveEnabledByUserId: 'admin-1',
      livePausedAt: new Date(NOW.getTime() - 1_000),
      livePauseCode: 'READBACK_MISMATCH',
      livePauseMessage: 'Live mode is paused: A live mutation readback did not match durable intent.',
    });
    const providerProbe = vi.fn(async () => ({
      binding: `binding:${deps.config.configVersion}`,
      decisionModel: false,
      verifierModel: false,
      decisionIdentity: null,
      verifierIdentity: null,
    }));
    deps.getProviderHealth = providerProbe;

    const readiness = await enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    );

    expect(providerProbe).toHaveBeenCalledOnce();
    expect(deps.config).toMatchObject({
      liveRequested: true,
      livePauseCode: 'READBACK_MISMATCH',
      livePauseMessage: 'Live mode is paused: A live mutation readback did not match durable intent.',
    });
    expect(readiness.state).toEqual({
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'READBACK_MISMATCH',
      pauseMessage: 'Live mode is paused: A live mutation readback did not match durable intent.',
    });
  });

  it('automatically pauses unsafe new work without erasing requested intent', async () => {
    deps.config = config({
      liveRequested: true,
      liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
      liveEnabledAt: NOW,
      liveEnabledByUserId: 'admin-1',
    });
    deps.getProviderHealth = async () => ({ decisionModel: false, verifierModel: true });

    const readiness = await pauseLiveMode('company-1', deps);

    expect(readiness.gates.find((gate) => gate.code === 'PROVIDER_UNHEALTHY')).toMatchObject({ ok: false });
    expect(deps.config).toMatchObject({
      liveRequested: true,
      livePausedAt: NOW,
      livePauseCode: 'PROVIDER_UNHEALTHY',
    });
    expect(deps.config.livePauseMessage).toMatch(/^Live mode is paused:/);
    expect(deps.config.livePauseMessage).not.toContain('decision-model');
  });

  it('requires acceptance again after the live configuration changes', async () => {
    deps.config = config({
      liveRequested: true,
      liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
      liveAcceptedConfigVersion: 'old-config-version',
    });

    const readiness = await pauseLiveMode('company-1', deps);

    expect(readiness.gates.find((gate) => gate.code === 'LIVE_POLICY_NOT_ACCEPTED')).toMatchObject({ ok: false });
    expect(deps.config.liveRequested).toBe(true);
    expect(deps.config.livePauseCode).toBe('LIVE_POLICY_NOT_ACCEPTED');
  });

  it('requires acceptance again when the effective provider binding changes across a restart', async () => {
    const acceptedBinding = `binding:${deps.config.configVersion}`;
    await enableLiveMode(
      'company-1',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    );
    expect(deps.config.liveAcceptedProviderBinding).toBe(acceptedBinding);

    const restartedBinding = 'binding:environment-authority-changed';
    deps.getProviderBinding = async () => restartedBinding;
    deps.getProviderHealth = async () => ({
      binding: restartedBinding,
      decisionModel: true,
      verifierModel: true,
      decisionIdentity: 'custom:resolved/decision',
      verifierIdentity: 'custom:resolved/verifier',
    });

    const readiness = await pauseLiveMode('company-1', deps);

    expect(readiness.gates.find((gate) => gate.code === 'LIVE_POLICY_NOT_ACCEPTED')).toMatchObject({ ok: false });
    expect(deps.config.liveRequested).toBe(true);
    expect(deps.config.livePauseCode).toBe('LIVE_POLICY_NOT_ACCEPTED');
  });

  it('rejects malformed activation arguments with a stable safe error', async () => {
    await expect(enableLiveMode(
      '',
      'Acme Books',
      { userId: 'admin-1', isAdmin: true },
      deps,
    )).rejects.toBeInstanceOf(LiveGateError);
  });

  it('reads tax readiness with an interactive transaction that cannot nest transactions', async () => {
    const readiness = await getTaxReadinessInTransaction('company-1', {
      company: {
        findUniqueOrThrow: async () => ({
          id: 'company-1',
          taxReferenceRefreshedAt: NOW,
          taxUsingSalesTax: true,
          taxSupportStatus: 'ready',
          taxSupportReason: null,
        }),
      },
      qboTaxRate: { findMany: async () => [] },
      qboTaxCode: {
        findMany: async () => [],
      },
    });

    expect(readiness).toMatchObject({ status: 'ready', refreshedAt: NOW.toISOString() });
  });
});
