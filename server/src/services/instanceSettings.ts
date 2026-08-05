// Instance-wide settings stored in the AppConfig key/value table.
// Secrets are encrypted at rest. ENV VARS ALWAYS WIN over DB values so
// infra-as-code deployments stay authoritative (see CLAUDE.md).

import type { InstanceSettingsDto, SuggestionProvider, SuggestionSetting } from '@recat/shared';
import { appUrlEnvManaged, env } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { runSerializableTransaction } from '../lib/serializableTransaction.js';

const SETTING_KEYS = [
  'appUrl',
  'previousAppUrl',
  'intuitClientId',
  'intuitClientSecret',
  'webhookVerifierToken',
  'suggestionSource',
  'suggestionProvider',
  'suggestionModel',
  'agentDecisionModel',
  'agentVerifierModel',
  'aiEndpoint',
  'aiApiKey',
  'openrouterApiKey',
  'openrouterReferer',
  'openrouterTitle',
  'smtpHost',
  'smtpPort',
  'smtpUser',
  'smtpPass',
  'smtpFrom',
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

const ENCRYPTED_KEYS: ReadonlySet<SettingKey> = new Set([
  'intuitClientSecret',
  'webhookVerifierToken',
  'aiApiKey',
  'openrouterApiKey',
  'smtpPass',
]);

const LIVE_AUTHORITY_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  'intuitClientId',
  'intuitClientSecret',
  'suggestionProvider',
  'suggestionModel',
  'agentDecisionModel',
  'agentVerifierModel',
  'aiEndpoint',
  'aiApiKey',
  'openrouterApiKey',
  'openrouterReferer',
  'openrouterTitle',
]);

export interface InstanceSettingsDb {
  appConfig: {
    findMany(args: {
      where: { key: { in: readonly SettingKey[] } };
    }): Promise<{ key: string; value: string; encrypted: boolean }[]>;
  };
}

/** Plaintext settings — server-internal only, never serialized to a client. */
export interface InstanceSettings {
  /** Public address users reach this deployment at; base for OAuth and links. */
  appUrl: string;
  /** The address before the last change, still accepted for origin checks. */
  previousAppUrl: string;
  intuitClientId: string;
  intuitClientSecret: string;
  webhookVerifierToken: string;
  suggestionSource: SuggestionSetting;
  suggestionProvider: SuggestionProvider;
  suggestionModel: string;
  agentDecisionModel: string;
  agentVerifierModel: string;
  aiEndpoint: string;
  aiApiKey: string;
  openrouterApiKey: string;
  openrouterReferer: string;
  openrouterTitle: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  /** true when the SMTP block comes from env vars (SMTP_HOST set) — DB values ignored. */
  smtpFromEnv: boolean;
}

export interface InstanceSettingsPatch {
  appUrl?: string;
  previousAppUrl?: string;
  intuitClientId?: string;
  intuitClientSecret?: string;
  webhookVerifierToken?: string;
  suggestionSource?: SuggestionSetting;
  suggestionProvider?: SuggestionProvider;
  suggestionModel?: string;
  agentDecisionModel?: string;
  agentVerifierModel?: string;
  aiEndpoint?: string;
  aiApiKey?: string;
  openrouterApiKey?: string;
  openrouterReferer?: string;
  openrouterTitle?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

async function readStored(
  db: InstanceSettingsDb = prisma as unknown as InstanceSettingsDb,
): Promise<Partial<Record<SettingKey, string>>> {
  const rows = await db.appConfig.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of rows) {
    const key = row.key as SettingKey;
    try {
      out[key] = row.encrypted ? decrypt(row.value) : row.value;
    } catch {
      // An undecryptable value (e.g. rotated ENCRYPTION_KEY) is treated as unset
      // rather than crashing every settings read; the admin re-enters it.
      console.error(`[instanceSettings] could not decrypt AppConfig key "${row.key}" — treating as unset`);
    }
  }
  return out;
}

function normalizeSuggestionSource(v: string | undefined): SuggestionSetting {
  return v === 'ai' || v === 'off' ? v : 'builtin';
}

function normalizeSuggestionProvider(v: string | undefined): SuggestionProvider {
  return v === 'openrouter' ? 'openrouter' : 'custom';
}

function normalizeSmtpPort(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 587;
}

export async function getInstanceSettings(
  db: InstanceSettingsDb = prisma as unknown as InstanceSettingsDb,
): Promise<InstanceSettings> {
  const stored = await readStored(db);
  // SMTP is env-managed as a block: SMTP_HOST set → all five values come from
  // env (SMTP_PORT/SMTP_FROM carry zod defaults, so per-field precedence would
  // silently mix sources).
  const smtpFromEnv = env.SMTP_HOST !== '';
  const suggestionModel =
    env.SUGGESTION_MODEL !== undefined && env.SUGGESTION_MODEL !== ''
      ? env.SUGGESTION_MODEL
      : (stored.suggestionModel || 'gpt-4o-mini');
  return {
    // env vars take precedence over DB values
    // APP_URL unset → the stored value wins, falling back to env's own default.
    // Normalized here so the displayed redirect URI and the one sent to
    // Intuit cannot differ by a trailing slash.
    appUrl: (appUrlEnvManaged ? env.APP_URL : (stored.appUrl || env.APP_URL)).replace(/\/+$/, ''),  // stored wins unless APP_URL_LOCKED
    previousAppUrl: (stored.previousAppUrl ?? '').replace(/\/+$/, ''),
    intuitClientId: env.QBO_CLIENT_ID !== '' ? env.QBO_CLIENT_ID : (stored.intuitClientId ?? ''),
    intuitClientSecret: env.QBO_CLIENT_SECRET !== '' ? env.QBO_CLIENT_SECRET : (stored.intuitClientSecret ?? ''),
    webhookVerifierToken:
      env.QBO_WEBHOOK_VERIFIER_TOKEN !== '' ? env.QBO_WEBHOOK_VERIFIER_TOKEN : (stored.webhookVerifierToken ?? ''),
    suggestionSource: normalizeSuggestionSource(stored.suggestionSource),
    suggestionProvider:
      env.SUGGESTION_PROVIDER !== undefined && env.SUGGESTION_PROVIDER !== ''
        ? normalizeSuggestionProvider(env.SUGGESTION_PROVIDER)
        : normalizeSuggestionProvider(stored.suggestionProvider),
    suggestionModel,
    agentDecisionModel: stored.agentDecisionModel || suggestionModel,
    agentVerifierModel: stored.agentVerifierModel || suggestionModel,
    aiEndpoint: stored.aiEndpoint ?? '',
    aiApiKey: stored.aiApiKey ?? '',
    openrouterApiKey:
      env.OPENROUTER_API_KEY !== undefined && env.OPENROUTER_API_KEY !== ''
        ? env.OPENROUTER_API_KEY
        : (stored.openrouterApiKey ?? ''),
    openrouterReferer:
      env.OPENROUTER_REFERER !== undefined && env.OPENROUTER_REFERER !== ''
        ? env.OPENROUTER_REFERER
        : (stored.openrouterReferer ?? ''),
    openrouterTitle:
      env.OPENROUTER_TITLE !== undefined && env.OPENROUTER_TITLE !== ''
        ? env.OPENROUTER_TITLE
        : (stored.openrouterTitle ?? ''),
    smtpHost: smtpFromEnv ? env.SMTP_HOST : (stored.smtpHost ?? ''),
    smtpPort: smtpFromEnv ? env.SMTP_PORT : normalizeSmtpPort(stored.smtpPort),
    smtpUser: smtpFromEnv ? env.SMTP_USER : (stored.smtpUser ?? ''),
    smtpPass: smtpFromEnv ? env.SMTP_PASS : (stored.smtpPass ?? ''),
    // A blank stored From falls back to the env default so mail always has a sender.
    smtpFrom: smtpFromEnv || (stored.smtpFrom ?? '') === '' ? env.SMTP_FROM : (stored.smtpFrom as string),
    smtpFromEnv,
  };
}

/** e.g. "ABkr34…9fQ" — enough to recognize the key without exposing it. */
export function maskClientId(id: string): string {
  if (id === '') return '';
  if (id.length <= 10) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 6)}…${id.slice(-3)}`;
}

/** Masked view safe to send to the (admin) client. */
export async function getInstanceSettingsDto(): Promise<InstanceSettingsDto> {
  const settings = await getInstanceSettings();
  const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
  return {
    appUrl: settings.appUrl,
    appUrlEnvManaged,
    intuitClientId: maskClientId(settings.intuitClientId),
    intuitClientSecretSet: settings.intuitClientSecret !== '',
    redirectUri: `${settings.appUrl}/auth/qbo/callback`,
    webhookUrl: `${settings.appUrl}/webhooks/qbo`,
    webhookVerifierTokenSet: settings.webhookVerifierToken !== '',
    suggestionSource: settings.suggestionSource,
    suggestionProvider: settings.suggestionProvider,
    suggestionModel: settings.suggestionModel,
    agentDecisionModel: settings.agentDecisionModel,
    agentVerifierModel: settings.agentVerifierModel,
    aiEndpoint: settings.aiEndpoint !== '' ? settings.aiEndpoint : null,
    aiKeySet: settings.aiApiKey !== '',
    openrouterKeySet: settings.openrouterApiKey !== '',
    openrouterReferer: settings.openrouterReferer,
    openrouterTitle: settings.openrouterTitle,
    needsSetup: adminCount === 0,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpUser: settings.smtpUser,
    smtpFrom: settings.smtpFrom,
    smtpPassSet: settings.smtpPass !== '',
    smtpConfigured: settings.smtpHost !== '',
    smtpFromEnv: settings.smtpFromEnv,
  };
}

export async function updateInstanceSettings(patch: InstanceSettingsPatch): Promise<void> {
  await runSerializableTransaction(prisma, async (transaction) => {
    let invalidatesLiveAuthority = false;
    for (const key of SETTING_KEYS) {
      const rawValue = patch[key];
      if (rawValue === undefined) continue;
      const raw = String(rawValue); // smtpPort arrives as a number; AppConfig stores strings
      const shouldEncrypt = ENCRYPTED_KEYS.has(key) && raw !== '';
      const value = shouldEncrypt ? encrypt(raw) : raw;
      await transaction.appConfig.upsert({
        where: { key },
        update: { value, encrypted: shouldEncrypt },
        create: { key, value, encrypted: shouldEncrypt },
      });
      invalidatesLiveAuthority ||= LIVE_AUTHORITY_SETTING_KEYS.has(key);
    }
    if (invalidatesLiveAuthority) {
      await transaction.agentCompanyConfig.updateMany({
        where: { liveRequested: true },
        data: {
          liveAcceptedPolicyVersion: null,
          liveAcceptedConfigVersion: null,
          liveAcceptedProviderBinding: null,
          livePausedAt: new Date(),
          livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
          livePauseMessage: 'Live mode is paused: The current live policy must be accepted.',
        },
      });
    }
  });
}
