import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseLocalAdminConfig } from './services/localAdminConfig.js';
import { ATTACHMENT_POLICY_BOUNDS } from './services/attachments/policy.js';

// Load the repo-root .env (Node ≥20.12 built-in; no dotenv dependency).
// Values already present in the environment win — .env only fills gaps.
for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '..', '.env')]) {
  if (existsSync(candidate)) {
    try {
      const before = { ...process.env };
      process.loadEnvFile(candidate);
      for (const [k, v] of Object.entries(before)) {
        if (v !== undefined) process.env[k] = v;
      }
    } catch {
      // unreadable .env — fall through to process env / defaults
    }
    break;
  }
}

// Blank values (e.g. `SESSION_SECRET=` left unfilled) behave as unset so zod
// defaults apply instead of failing validation on ''.
for (const k of Object.keys(process.env)) {
  if (process.env[k] === '') delete process.env[k];
}

export const attachmentPolicyEnvManaged = Object.freeze({
  companyQuotaBytes: process.env.ATTACHMENT_COMPANY_QUOTA_BYTES !== undefined,
  instanceQuotaBytes: process.env.ATTACHMENT_INSTANCE_QUOTA_BYTES !== undefined,
  retentionDays: process.env.ATTACHMENT_RETENTION_DAYS !== undefined,
});

/**
 * Whether the public URL is pinned to the environment and cannot be edited.
 *
 * Deliberately NOT "APP_URL is set". The shipped compose files both supply an
 * APP_URL — a default for the deployment shape, not an operator decision — so
 * keying on its presence would make the field read-only for every Docker and
 * Umbrel install, which are precisely the ones that need to change it. APP_URL
 * is the fallback; a stored value wins. Set APP_URL_LOCKED=true for
 * infrastructure-as-code deployments that want the environment to be
 * authoritative.
 */
export const appUrlEnvManaged = process.env.APP_URL_LOCKED === 'true';

const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me';
const DEV_ENCRYPTION_KEY = '0'.repeat(64);

function byteLimit(defaultValue: bigint, minimum: bigint, maximum: bigint) {
  return z.string()
    .regex(/^\d+$/, 'attachment byte limits must be positive integers')
    .default(defaultValue.toString())
    .transform((value) => BigInt(value))
    .refine(
      (value) => value >= minimum && value <= maximum,
      'attachment byte limit is outside the supported range',
    );
}

const schema = z.object({
  APP_URL: z.string().url().default('http://localhost:5173'),
  APP_URL_LOCKED: z.enum(['true', 'false']).optional(),
  PORT: z.coerce.number().default(3001),
  SESSION_SECRET: z.string().min(16).default(DEV_SESSION_SECRET),
  // 32-byte key as 64 hex chars; dev fallback is deterministic so local restarts keep working.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .default(DEV_ENCRYPTION_KEY),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/recat'),
  QBO_CLIENT_ID: z.string().optional().default(''),
  QBO_CLIENT_SECRET: z.string().optional().default(''),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  QBO_WEBHOOK_VERIFIER_TOKEN: z.string().optional().default(''),
  SUGGESTION_MODEL: z.string().optional(),
  SUGGESTION_PROVIDER: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_REFERER: z.string().optional(),
  OPENROUTER_TITLE: z.string().optional(),
  RECEIPT_EXTRACTOR_URL: z
    .string()
    .url()
    .default('http://receipt-extractor:8485'),
  RECEIPT_EXTRACTOR_TOKEN: z.string().min(32).optional().default(
    'dev-only-receipt-extractor-token',
  ),
  QBO_MOCK: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('Recat <noreply@example.com>'),
  SLACK_WEBHOOK_URL: z.string().optional().default(''),
  DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  ATTACHMENT_COMPANY_QUOTA_BYTES: byteLimit(
    1_073_741_824n,
    ATTACHMENT_POLICY_BOUNDS.companyQuotaMinBytes,
    ATTACHMENT_POLICY_BOUNDS.companyQuotaMaxBytes,
  ),
  ATTACHMENT_INSTANCE_QUOTA_BYTES: byteLimit(
    10_737_418_240n,
    ATTACHMENT_POLICY_BOUNDS.instanceQuotaMinBytes,
    ATTACHMENT_POLICY_BOUNDS.instanceQuotaMaxBytes,
  ),
  ATTACHMENT_RETENTION_DAYS: z.coerce.number().int()
    .min(ATTACHMENT_POLICY_BOUNDS.retentionMinDays)
    .max(ATTACHMENT_POLICY_BOUNDS.retentionMaxDays)
    .default(365),
  // DANGER: forces magic-link URLs into API responses even when real books
  // are connected — anyone with the link IS that user. Normally unneeded:
  // devLink is auto-allowed while the instance has no real company connected
  // and auto-locked the moment one is (services/devLogin.ts).
  ALLOW_DEV_LOGIN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  LOCAL_ADMIN_EMAIL: z.string().optional().default(''),
  LOCAL_ADMIN_PASSWORD: z.string().optional().default(''),
  TRUSTED_PROXY_IPS: z.string().optional().default(''),
  // Trust the immediate peer as a reverse proxy when it is on a private
  // network. For deployments whose app port is not published and whose only
  // route in is a container-network proxy — the Umbrel package. Without it,
  // every caller behind that proxy shares one req.ip and rate limiting is
  // deployment-wide (#57).
  TRUSTED_PROXY_HOP: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  DIGEST_HOUR: z.coerce.number().min(0).max(23).default(8),
  NODE_ENV: z.string().default('development'),
});

const parsedEnv = schema.parse(process.env);

if (parsedEnv.ATTACHMENT_INSTANCE_QUOTA_BYTES < parsedEnv.ATTACHMENT_COMPANY_QUOTA_BYTES) {
  throw new Error(
    'ATTACHMENT_INSTANCE_QUOTA_BYTES must be greater than or equal to ATTACHMENT_COMPANY_QUOTA_BYTES.',
  );
}

export const localAdminConfig = parseLocalAdminConfig(
  parsedEnv.LOCAL_ADMIN_EMAIL,
  parsedEnv.LOCAL_ADMIN_PASSWORD,
);
export const env = parsedEnv;

export const isProd = env.NODE_ENV === 'production';

// Refuse to boot a production deployment on the well-known dev secrets:
// a predictable SESSION_SECRET lets anyone forge sessions, and the all-zero
// ENCRYPTION_KEY makes the "encrypted" QBO tokens readable by anyone with a
// DB dump. Enforced regardless of QBO_MOCK — any production instance can
// connect real books at any time (demo is a per-connection choice now), so
// real secrets are always required.
if (isProd) {
  if (env.SESSION_SECRET === DEV_SESSION_SECRET) {
    throw new Error(
      'Refusing to start: SESSION_SECRET is the dev default. Set a random 32+ character SESSION_SECRET before running in production.',
    );
  }
  if (env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
    throw new Error(
      'Refusing to start: ENCRYPTION_KEY is the dev default. Set a random 32-byte (64 hex chars) ENCRYPTION_KEY before running in production.',
    );
  }
  if (env.RECEIPT_EXTRACTOR_TOKEN === 'dev-only-receipt-extractor-token') {
    throw new Error(
      'Refusing to start: RECEIPT_EXTRACTOR_TOKEN is the dev default. Set a random 32+ character token before running in production.',
    );
  }
}

// devLink policy lives in services/devLogin.ts (async — it depends on whether
// a real company is connected, not on env alone).

// The OAuth callback and webhook URLs used to be constants derived from
// APP_URL at import. They are now resolved at call time from the configurable
// public address — see services/publicUrl.ts — because a packaged deployment
// cannot know at build time what address its users will reach it on.
