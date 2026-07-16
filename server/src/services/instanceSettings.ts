// Instance-wide settings stored in the AppConfig key/value table.
// Secrets are encrypted at rest. ENV VARS ALWAYS WIN over DB values so
// infra-as-code deployments stay authoritative (see CLAUDE.md).

import type { InstanceSettingsDto, SuggestionSetting } from '@recat/shared';
import { env, redirectUri } from '../env.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

const SETTING_KEYS = [
  'intuitClientId',
  'intuitClientSecret',
  'webhookVerifierToken',
  'suggestionSource',
  'aiEndpoint',
  'aiApiKey',
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
  'smtpPass',
]);

/** Plaintext settings — server-internal only, never serialized to a client. */
export interface InstanceSettings {
  intuitClientId: string;
  intuitClientSecret: string;
  webhookVerifierToken: string;
  suggestionSource: SuggestionSetting;
  aiEndpoint: string;
  aiApiKey: string;
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
  aiEndpoint?: string;
  aiApiKey?: string;
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

function normalizeSmtpPort(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 587;
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  const stored = await readStored();
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
    aiEndpoint: stored.aiEndpoint ?? '',
    aiApiKey: stored.aiApiKey ?? '',
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
    aiEndpoint: settings.aiEndpoint !== '' ? settings.aiEndpoint : null,
    aiKeySet: settings.aiApiKey !== '',
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
  for (const key of SETTING_KEYS) {
    const rawValue = patch[key];
    if (rawValue === undefined) continue;
    const raw = String(rawValue); // smtpPort arrives as a number; AppConfig stores strings
    const shouldEncrypt = ENCRYPTED_KEYS.has(key) && raw !== '';
    const value = shouldEncrypt ? encrypt(raw) : raw;
    await prisma.appConfig.upsert({
      where: { key },
      update: { value, encrypted: shouldEncrypt },
      create: { key, value, encrypted: shouldEncrypt },
    });
  }
}
