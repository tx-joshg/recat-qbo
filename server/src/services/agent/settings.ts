import { createHash } from 'node:crypto';
import {
  DEFAULT_AGENT_LIMITS,
  type AgentLimits,
} from './core/runner.js';
import { prisma } from '../../lib/prisma.js';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import {
  getInstanceSettings,
  type InstanceSettingsDb,
} from '../instanceSettings.js';
import type {
  AgentCompanySettingsDto,
  AgentLimitsDto,
  AgentMode,
  SuggestionProvider,
} from '@recat/shared';
import { z } from 'zod';

const DEFAULT_SCHEDULE_MINUTES = 10;
const DEFAULT_COMPANY_CONCURRENCY = 1;
const DEFAULT_EVIDENCE_THRESHOLD = 50;
// Deliberately low out of the box. The cap exists to bound damage before
// anyone has evidence the model is right on *this* company's books, and 25
// mistakes is a recoverable afternoon where 100 is not. Operators raise it
// once live writes have held up under spot-checking.
const DEFAULT_DAILY_LIVE_WRITE_LIMIT = 25;
const MAX_SCHEDULE_MINUTES = 24 * 60;
const MAX_COMPANY_CONCURRENCY = 4;
const MAX_DAILY_LIVE_WRITE_LIMIT = 10_000;
const MODEL_MAX_LENGTH = 200;

export interface AgentCompanyConfigRow {
  companyId: string;
  mode: string;
  provider: string;
  decisionModel: string;
  verifierModel: string;
  scheduleMinutes: number;
  companyConcurrency: number;
  evidenceThreshold: number;
  dailyLiveWriteLimit: number;
  limits: unknown;
  configVersion: string;
  schedulingGeneration: number;
  liveRequested?: boolean;
  liveAcceptedPolicyVersion?: string | null;
  liveAcceptedConfigVersion?: string | null;
  liveAcceptedProviderBinding?: string | null;
  livePausedAt?: Date | null;
  livePauseCode?: string | null;
  livePauseMessage?: string | null;
}

type AgentCompanyConfigData = Omit<AgentCompanyConfigRow, 'companyId'> & { companyId: string };

export interface AgentSettingsDb {
  agentCompanyConfig: {
    findUnique(args: { where: { companyId: string } }): Promise<AgentCompanyConfigRow | null>;
    upsert(args: {
      where: { companyId: string };
      create: AgentCompanyConfigData;
      update: Omit<AgentCompanyConfigData, 'companyId'> & Partial<Pick<AgentCompanyConfigRow,
        'liveAcceptedPolicyVersion' | 'liveAcceptedConfigVersion' | 'liveAcceptedProviderBinding' | 'livePausedAt' | 'livePauseCode' | 'livePauseMessage'>>;
    }): Promise<AgentCompanyConfigRow>;
  };
}

export interface ConfiguredAgentProviderSettings {
  suggestionProvider: SuggestionProvider;
  agentDecisionModel: string;
  agentVerifierModel: string;
  aiEndpoint: string;
  aiApiKey: string;
  openrouterApiKey: string;
}

export interface AgentSettingsReadDeps {
  db: AgentSettingsDb;
  getInstanceSettings(db?: InstanceSettingsDb): Promise<ConfiguredAgentProviderSettings>;
}

export interface AgentSettingsDeps extends AgentSettingsReadDeps {
  withSerializableTransaction<T>(
    callback: (db: AgentSettingsDb) => Promise<T>,
  ): Promise<T>;
}

const defaultDeps: AgentSettingsDeps = {
  db: prisma as unknown as AgentSettingsDb,
  getInstanceSettings,
  withSerializableTransaction: (callback) => runSerializableTransaction(
    prisma,
    (transaction) => callback(transaction as unknown as AgentSettingsDb),
  ),
};

export class AgentSettingError extends Error {
  readonly code = 'AGENT_SETTING_INVALID';

  constructor(message = 'Invalid shadow agent settings.') {
    super(message);
    this.name = 'AgentSettingError';
  }
}

const limitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(DEFAULT_AGENT_LIMITS.maxToolCalls).optional(),
  maxTurns: z.number().int().min(1).max(DEFAULT_AGENT_LIMITS.maxTurns).optional(),
  maxContextBytes: z.number().int().min(1).max(DEFAULT_AGENT_LIMITS.maxContextBytes).optional(),
  maxResponseBytes: z.number().int().min(1).max(DEFAULT_AGENT_LIMITS.maxResponseBytes).optional(),
  timeoutMs: z.number().int().min(1).max(DEFAULT_AGENT_LIMITS.timeoutMs).optional(),
}).strict();

const patchSchema = z.object({
  mode: z.enum(['off', 'shadow']).optional(),
  provider: z.enum(['custom', 'openrouter']).optional(),
  decisionModel: z.string().trim().min(1).max(MODEL_MAX_LENGTH).optional(),
  verifierModel: z.string().trim().min(1).max(MODEL_MAX_LENGTH).optional(),
  scheduleMinutes: z.number().int().min(1).max(MAX_SCHEDULE_MINUTES).optional(),
  companyConcurrency: z.number().int().min(1).max(MAX_COMPANY_CONCURRENCY).optional(),
  evidenceThreshold: z.number().int().min(25).max(1000).optional(),
  dailyLiveWriteLimit: z.number().int().min(1).max(MAX_DAILY_LIVE_WRITE_LIMIT).optional(),
  limits: limitsSchema.optional(),
}).strict();

export type UpdateShadowSettingsPatch = z.input<typeof patchSchema>;

/**
 * Reads one company configuration without creating a row. New companies inherit
 * the current instance provider/model aliases, but never receive provider secrets.
 */
export async function getAgentSettings(
  companyId: string,
  deps: AgentSettingsReadDeps = defaultDeps,
): Promise<AgentCompanySettingsDto> {
  assertCompanyId(companyId);
  const row = await deps.db.agentCompanyConfig.findUnique({ where: { companyId } });
  if (row !== null) return toDto(row);

  const instance = await deps.getInstanceSettings();
  return defaultsFrom(instance);
}

export async function updateShadowSettings(
  companyId: string,
  patch: UpdateShadowSettingsPatch,
  deps: AgentSettingsDeps = defaultDeps,
): Promise<AgentCompanySettingsDto> {
  assertCompanyId(companyId);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => issue.message).join(' '));

  return deps.withSerializableTransaction(async (db) => {
    const row = await db.agentCompanyConfig.findUnique({ where: { companyId } });
    const instance = await deps.getInstanceSettings(db as unknown as InstanceSettingsDb);
    const current = row === null ? defaultsFrom(instance) : toDto(row);
    const next = {
      ...current,
      ...parsed.data,
      limits: { ...current.limits, ...parsed.data.limits },
    };
    validateConfiguredModels(next, instance);

    const configVersion = versionFor(next);
    const data: AgentCompanyConfigData = {
      ...next, companyId, configVersion,
      schedulingGeneration: (row?.schedulingGeneration ?? 0)
        + (current.mode !== 'shadow' && next.mode === 'shadow' ? 1 : 0),
    };
    const invalidateLiveAcceptance = row?.liveRequested === true && row.configVersion !== configVersion;
    const stored = await db.agentCompanyConfig.upsert({
      where: { companyId },
      create: data,
      update: {
        ...omitCompanyId(data),
        ...(invalidateLiveAcceptance
          ? {
              liveAcceptedPolicyVersion: null,
              liveAcceptedConfigVersion: null,
              liveAcceptedProviderBinding: null,
              livePausedAt: new Date(),
              livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
              livePauseMessage: 'Live mode is paused: The current live policy must be accepted.',
            }
          : {}),
      },
    });
    return toDto(stored);
  });
}

function defaultsFrom(instance: ConfiguredAgentProviderSettings): AgentCompanySettingsDto {
  const settings = {
    mode: 'off' as AgentMode,
    provider: provider(instance.suggestionProvider),
    decisionModel: validModel(instance.agentDecisionModel),
    verifierModel: validModel(instance.agentVerifierModel),
    scheduleMinutes: DEFAULT_SCHEDULE_MINUTES,
    companyConcurrency: DEFAULT_COMPANY_CONCURRENCY,
    evidenceThreshold: DEFAULT_EVIDENCE_THRESHOLD,
    dailyLiveWriteLimit: DEFAULT_DAILY_LIVE_WRITE_LIMIT,
    limits: defaultLimits(),
  };
  return { ...settings, configVersion: versionFor(settings) };
}

function toDto(row: AgentCompanyConfigRow): AgentCompanySettingsDto {
  const parsed = patchSchema.safeParse({
    mode: row.mode,
    provider: row.provider,
    decisionModel: row.decisionModel,
    verifierModel: row.verifierModel,
    scheduleMinutes: row.scheduleMinutes,
    companyConcurrency: row.companyConcurrency,
    evidenceThreshold: row.evidenceThreshold,
    dailyLiveWriteLimit: row.dailyLiveWriteLimit,
    limits: row.limits,
  });
  if (!parsed.success) throw invalid('Stored shadow agent settings are invalid.');
  const settings = {
    mode: parsed.data.mode!,
    provider: parsed.data.provider!,
    decisionModel: parsed.data.decisionModel!,
    verifierModel: parsed.data.verifierModel!,
    scheduleMinutes: parsed.data.scheduleMinutes!,
    companyConcurrency: parsed.data.companyConcurrency!,
    evidenceThreshold: parsed.data.evidenceThreshold!,
    dailyLiveWriteLimit: parsed.data.dailyLiveWriteLimit!,
    limits: resolveLimits(parsed.data.limits),
  };
  return { ...settings, configVersion: row.configVersion };
}

function validateConfiguredModels(
  settings: Omit<AgentCompanySettingsDto, 'configVersion'>,
  instance: ConfiguredAgentProviderSettings,
): void {
  validModel(settings.decisionModel);
  validModel(settings.verifierModel);
  provider(settings.provider);
  resolveLimits(settings.limits);
  if (settings.mode !== 'shadow') return;

  const configured = settings.provider === 'openrouter'
    ? instance.openrouterApiKey !== ''
    : instance.aiEndpoint !== '';
  if (!configured) {
    throw invalid('The selected provider is not configured in instance settings.');
  }
}

function defaultLimits(): AgentLimitsDto {
  return { ...DEFAULT_AGENT_LIMITS };
}

function resolveLimits(limits: Partial<AgentLimits> | undefined): AgentLimitsDto {
  const parsed = limitsSchema.safeParse(limits ?? {});
  if (!parsed.success) throw invalid('Invalid shadow agent limits.');
  return {
    maxToolCalls: parsed.data.maxToolCalls ?? DEFAULT_AGENT_LIMITS.maxToolCalls,
    maxTurns: parsed.data.maxTurns ?? DEFAULT_AGENT_LIMITS.maxTurns,
    maxContextBytes: parsed.data.maxContextBytes ?? DEFAULT_AGENT_LIMITS.maxContextBytes,
    maxResponseBytes: parsed.data.maxResponseBytes ?? DEFAULT_AGENT_LIMITS.maxResponseBytes,
    timeoutMs: parsed.data.timeoutMs ?? DEFAULT_AGENT_LIMITS.timeoutMs,
  };
}

function versionFor(settings: Omit<AgentCompanySettingsDto, 'configVersion'>): string {
  const canonical = JSON.stringify({
    version: 1,
    mode: settings.mode,
    provider: settings.provider,
    decisionModel: settings.decisionModel,
    verifierModel: settings.verifierModel,
    scheduleMinutes: settings.scheduleMinutes,
    companyConcurrency: settings.companyConcurrency,
    evidenceThreshold: settings.evidenceThreshold,
    // Mutation volume is re-read at permit issuance and does not alter model authority.
    limits: settings.limits,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function provider(value: string): SuggestionProvider {
  if (value === 'custom' || value === 'openrouter') return value;
  throw invalid('Invalid agent provider.');
}

function validModel(value: string): string {
  const parsed = z.string().trim().min(1).max(MODEL_MAX_LENGTH).safeParse(value);
  if (!parsed.success) throw invalid('Agent model aliases must be configured.');
  return parsed.data;
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== 'string' || companyId.trim() === '' || companyId.length > 200) {
    throw invalid('Invalid company id.');
  }
}

function omitCompanyId(data: AgentCompanyConfigData): Omit<AgentCompanyConfigData, 'companyId'> {
  const { companyId: _companyId, ...rest } = data;
  return rest;
}

function invalid(message?: string): AgentSettingError {
  return new AgentSettingError(message);
}
