import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAgentSettings,
  updateShadowSettings,
  type AgentCompanyConfigRow,
  type AgentSettingsDeps,
} from './settings.js';

const configuredProvider = {
  suggestionProvider: 'openrouter' as const,
  agentDecisionModel: 'openai/gpt-4.1-mini',
  agentVerifierModel: 'openai/gpt-4.1-mini',
  aiEndpoint: '',
  aiApiKey: '',
  openrouterApiKey: 'instance-only-secret',
};

function createDeps(): AgentSettingsDeps & { rows: Map<string, AgentCompanyConfigRow> } {
  const rows = new Map<string, AgentCompanyConfigRow>();
  const db: AgentSettingsDeps['db'] = {
    agentCompanyConfig: {
      findUnique: async ({ where }) => rows.get(where.companyId) ?? null,
      upsert: async ({ where, create, update }) => {
        const row = rows.get(where.companyId);
        const next = row ? { ...row, ...update } : create;
        rows.set(where.companyId, next);
        return next;
      },
    },
  };
  return {
    rows,
    db,
    withSerializableTransaction: async (callback) => callback(db),
    getInstanceSettings: async () => configuredProvider,
  };
}

describe('shadow agent company settings', () => {
  let deps: AgentSettingsDeps & { rows: Map<string, AgentCompanyConfigRow> };

  beforeEach(() => {
    deps = createDeps();
  });

  it('creates a new scheduling generation only when moving from off into shadow', async () => {
    await updateShadowSettings('company-1', { mode: 'off' }, deps);
    expect(deps.rows.get('company-1')!.schedulingGeneration).toBe(0);
    const first = await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    expect(deps.rows.get('company-1')!.schedulingGeneration).toBe(1);
    await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    expect(deps.rows.get('company-1')!.schedulingGeneration).toBe(1);
    await updateShadowSettings('company-1', { mode: 'off' }, deps);
    expect(deps.rows.get('company-1')!.schedulingGeneration).toBe(1);
    const restored = await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    expect(deps.rows.get('company-1')!.schedulingGeneration).toBe(2);
    expect(restored.configVersion).toBe(first.configVersion);
    expect(restored).not.toHaveProperty('schedulingGeneration');
  });

  it.each([24, 1001])('rejects evidence threshold %i', async (evidenceThreshold) => {
    await expect(updateShadowSettings('company-1', { evidenceThreshold }, deps))
      .rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
  });

  it.each([0, 10_001, 1.5])('rejects daily live-write limit %s', async (dailyLiveWriteLimit) => {
    await expect(updateShadowSettings('company-1', { dailyLiveWriteLimit }, deps))
      .rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
  });

  it('defaults new company settings to off and threshold 50', async () => {
    await expect(getAgentSettings('company-1', deps)).resolves.toMatchObject({
      mode: 'off',
      provider: 'openrouter',
      evidenceThreshold: 50,
      companyConcurrency: 1,
      dailyLiveWriteLimit: 25,
      decisionModel: configuredProvider.agentDecisionModel,
      verifierModel: configuredProvider.agentVerifierModel,
    });
    expect(deps.rows).toHaveLength(0);
  });

  it.each([1, 10_000])('accepts daily live-write boundary %i', async (dailyLiveWriteLimit) => {
    await expect(updateShadowSettings('company-1', { dailyLiveWriteLimit }, deps))
      .resolves.toMatchObject({ dailyLiveWriteLimit });
  });

  it('changes the daily write cap without changing decision authority', async () => {
    await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    const previous = deps.rows.get('company-1')!;
    deps.rows.set('company-1', {
      ...previous,
      liveRequested: true,
      liveAcceptedPolicyVersion: 'recat-live-purchase-v1',
      liveAcceptedConfigVersion: previous.configVersion,
      liveAcceptedProviderBinding: 'accepted-provider-binding',
      livePausedAt: null,
      livePauseCode: null,
      livePauseMessage: null,
    });

    const updated = await updateShadowSettings('company-1', { dailyLiveWriteLimit: 250 }, deps);

    expect(updated.configVersion).toBe(previous.configVersion);
    expect(updated.dailyLiveWriteLimit).toBe(250);
    expect(deps.rows.get('company-1')).toMatchObject({
      liveAcceptedPolicyVersion: 'recat-live-purchase-v1',
      liveAcceptedConfigVersion: previous.configVersion,
      liveAcceptedProviderBinding: 'accepted-provider-binding',
      livePausedAt: null,
    });
  });

  it('changes config version only when a validated setting changes', async () => {
    const initial = await getAgentSettings('company-1', deps);
    const unchanged = await updateShadowSettings('company-1', { mode: 'off' }, deps);
    const changed = await updateShadowSettings('company-1', { mode: 'shadow', evidenceThreshold: 51 }, deps);

    expect(unchanged.configVersion).toBe(initial.configVersion);
    expect(changed.configVersion).not.toBe(initial.configVersion);
    expect(deps.rows.get('company-1')).toMatchObject({ mode: 'shadow', evidenceThreshold: 51 });
  });

  it('pauses requested live mode and invalidates acceptance when configuration changes', async () => {
    await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    const previous = deps.rows.get('company-1')!;
    deps.rows.set('company-1', {
      ...previous,
      liveRequested: true,
      liveAcceptedPolicyVersion: 'recat-live-purchase-v1',
      liveAcceptedConfigVersion: previous.configVersion,
      liveAcceptedProviderBinding: 'accepted-provider-binding',
      livePausedAt: null,
      livePauseCode: null,
      livePauseMessage: null,
    });

    await updateShadowSettings('company-1', { evidenceThreshold: 51 }, deps);

    expect(deps.rows.get('company-1')).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: null,
      liveAcceptedConfigVersion: null,
      liveAcceptedProviderBinding: null,
      livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
    });
  });

  it('performs the settings read and invalidating write in one authority transaction', async () => {
    await updateShadowSettings('company-1', { mode: 'shadow' }, deps);
    const previous = deps.rows.get('company-1')!;
    deps.rows.set('company-1', {
      ...previous,
      liveRequested: true,
      liveAcceptedPolicyVersion: 'recat-live-purchase-v1',
      liveAcceptedConfigVersion: previous.configVersion,
      liveAcceptedProviderBinding: 'accepted-provider-binding',
    });
    let transactionCalls = 0;
    const transactionOnly: AgentSettingsDeps = {
      ...deps,
      db: {
        agentCompanyConfig: {
          findUnique: async () => {
            throw new Error('settings read escaped authority transaction');
          },
          upsert: async () => {
            throw new Error('settings write escaped authority transaction');
          },
        },
      },
      withSerializableTransaction: async (callback) => {
        transactionCalls += 1;
        return callback(deps.db);
      },
    };

    await updateShadowSettings('company-1', { evidenceThreshold: 51 }, transactionOnly);

    expect(transactionCalls).toBe(1);
    expect(deps.rows.get('company-1')).toMatchObject({
      liveRequested: true,
      liveAcceptedPolicyVersion: null,
      liveAcceptedConfigVersion: null,
      liveAcceptedProviderBinding: null,
      livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
    });
  });

  it('uses one instance settings snapshot for first-time defaults and provider availability', async () => {
    const first = {
      ...configuredProvider,
      agentDecisionModel: 'first-decision-model',
      agentVerifierModel: 'first-verifier-model',
    };
    const second = {
      ...configuredProvider,
      suggestionProvider: 'custom' as const,
      agentDecisionModel: 'second-decision-model',
      agentVerifierModel: 'second-verifier-model',
      aiEndpoint: '',
    };
    let reads = 0;
    const sequential: AgentSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => {
        reads += 1;
        return reads === 1 ? first : second;
      },
    };

    await expect(updateShadowSettings('company-1', { mode: 'shadow' }, sequential))
      .resolves.toMatchObject({
        provider: 'openrouter',
        decisionModel: 'first-decision-model',
        verifierModel: 'first-verifier-model',
      });
    expect(reads).toBe(1);
  });

  it('keeps provider secrets in instance settings and rejects unavailable provider configuration', async () => {
    const unavailable: AgentSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => ({
        ...configuredProvider,
        openrouterApiKey: '',
      }),
    };

    await expect(updateShadowSettings('company-1', { mode: 'shadow' }, unavailable))
      .rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
    expect(deps.rows.get('company-1')).toBeUndefined();
  });

  it('isolates stored settings by company', async () => {
    await updateShadowSettings('company-1', { scheduleMinutes: 60 }, deps);
    await updateShadowSettings('company-2', { evidenceThreshold: 75 }, deps);

    await expect(getAgentSettings('company-1', deps)).resolves.toMatchObject({
      scheduleMinutes: 60,
      evidenceThreshold: 50,
    });
    await expect(getAgentSettings('company-2', deps)).resolves.toMatchObject({
      scheduleMinutes: 10,
      evidenceThreshold: 75,
    });
  });

  it('rejects limits that exceed the shadow runner safety caps', async () => {
    await expect(updateShadowSettings('company-1', {
      limits: { maxTurns: 9 },
    }, deps)).rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
  });
});
