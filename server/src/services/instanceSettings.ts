// Instance-wide settings stored in the AppConfig key/value table.
// Secrets are encrypted at rest. ENV VARS ALWAYS WIN over DB values so
// infra-as-code deployments stay authoritative (see CLAUDE.md).

import type { InstanceSettingsDto, SuggestionProvider, SuggestionSetting } from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { env, redirectUri } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

const SETTING_KEYS = [
  'intuitClientId',
  'intuitClientSecret',
  'webhookVerifierToken',
  'suggestionSource',
  'suggestionProvider',
  'suggestionModel',
  'codexModel',
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

/** Plaintext settings — server-internal only, never serialized to a client. */
export interface InstanceSettings {
  intuitClientId: string;
  intuitClientSecret: string;
  webhookVerifierToken: string;
  suggestionSource: SuggestionSetting;
  suggestionProvider: SuggestionProvider;
  suggestionModel: string;
  codexModel: string;
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
  intuitClientId?: string;
  intuitClientSecret?: string;
  webhookVerifierToken?: string;
  suggestionSource?: SuggestionSetting;
  suggestionProvider?: SuggestionProvider;
  suggestionModel?: string;
  codexModel?: string;
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

async function readStored(): Promise<Partial<Record<SettingKey, string>>> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
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
  return v === 'openrouter' || v === 'codex' ? v : 'custom';
}

function normalizeSmtpPort(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 587;
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  const stored = await readStored();
  const suggestionProvider =
    env.SUGGESTION_PROVIDER !== undefined && env.SUGGESTION_PROVIDER !== ''
      ? normalizeSuggestionProvider(env.SUGGESTION_PROVIDER)
      : normalizeSuggestionProvider(stored.suggestionProvider);
  const configuredSuggestionModel =
    env.SUGGESTION_MODEL !== undefined && env.SUGGESTION_MODEL !== ''
      ? env.SUGGESTION_MODEL
      : (stored.suggestionModel || 'gpt-4o-mini');
  const suggestionModel =
    suggestionProvider === 'openrouter' && configuredSuggestionModel === 'gpt-4o-mini'
      ? 'openai/gpt-4o-mini'
      : configuredSuggestionModel;
  // SMTP is env-managed as a block: SMTP_HOST set → all five values come from
  // env (SMTP_PORT/SMTP_FROM carry zod defaults, so per-field precedence would
  // silently mix sources).
  const smtpFromEnv = env.SMTP_HOST !== '';
  return {
    // env vars take precedence over DB values
    intuitClientId: env.QBO_CLIENT_ID !== '' ? env.QBO_CLIENT_ID : (stored.intuitClientId ?? ''),
    intuitClientSecret: env.QBO_CLIENT_SECRET !== '' ? env.QBO_CLIENT_SECRET : (stored.intuitClientSecret ?? ''),
    webhookVerifierToken:
      env.QBO_WEBHOOK_VERIFIER_TOKEN !== '' ? env.QBO_WEBHOOK_VERIFIER_TOKEN : (stored.webhookVerifierToken ?? ''),
    suggestionSource: normalizeSuggestionSource(stored.suggestionSource),
    suggestionProvider,
    suggestionModel,
    codexModel: stored.codexModel || 'gpt-5.6-luna',
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
    intuitClientId: maskClientId(settings.intuitClientId),
    intuitClientSecretSet: settings.intuitClientSecret !== '',
    redirectUri,
    webhookVerifierTokenSet: settings.webhookVerifierToken !== '',
    suggestionSource: settings.suggestionSource,
    suggestionProvider: settings.suggestionProvider,
    suggestionModel: settings.suggestionModel,
    codexModel: settings.codexModel,
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
  await prisma.$transaction(async (tx) => {
    for (const key of SETTING_KEYS) {
      const rawValue = patch[key];
      if (rawValue === undefined) continue;
      const raw = String(rawValue); // smtpPort arrives as a number; AppConfig stores strings
      const shouldEncrypt = ENCRYPTED_KEYS.has(key) && raw !== '';
      const value = shouldEncrypt ? encrypt(raw) : raw;
      await tx.appConfig.upsert({
        where: { key },
        update: { value, encrypted: shouldEncrypt },
        create: { key, value, encrypted: shouldEncrypt },
      });
    }
    if (patch.codexModel !== undefined) {
      // Keep the durable requeue marker atomic with the model generation it
      // invalidates so a crash cannot leave old jobs as the only generation.
      await tx.company.updateMany({
        where: {
          autopilotMode: { in: ['shadow', 'live'] },
          disconnectedAt: null,
        },
        data: { agentReconcileToken: randomUUID() },
      });
    }
  });
}
