import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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

const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me';
const DEV_ENCRYPTION_KEY = '0'.repeat(64);

const schema = z.object({
  APP_URL: z.string().url().default('http://localhost:5173'),
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
  // DANGER: exposes magic-link URLs in API responses to anyone who can reach
  // the login form — anyone with the link IS that user. Only ever set this on
  // a private dev instance; never on a deployment holding real books.
  ALLOW_DEV_LOGIN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  DIGEST_HOUR: z.coerce.number().min(0).max(23).default(8),
  NODE_ENV: z.string().default('development'),
});

export const env = schema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';

// Refuse to boot a real production deployment on the well-known dev secrets:
// a predictable SESSION_SECRET lets anyone forge sessions, and the all-zero
// ENCRYPTION_KEY makes the "encrypted" QBO tokens readable by anyone with a
// DB dump.
if (isProd && !env.QBO_MOCK) {
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
}

/**
 * Whether magic links may be returned in API responses (devLink). Demo/mock
 * mode is safe by construction; otherwise the deployer must opt in explicitly
 * with ALLOW_DEV_LOGIN=true — NODE_ENV alone is not enough of a signal.
 */
export const devLoginAllowed = env.QBO_MOCK || env.ALLOW_DEV_LOGIN;

/** OAuth callback registered with Intuit — the wizard shows this exact URL. */
export const redirectUri = `${env.APP_URL}/auth/qbo/callback`;
