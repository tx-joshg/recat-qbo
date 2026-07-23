// Behavioral reference: pi-mono's MIT-licensed OpenAI Codex OAuth adapter
// (packages/ai/src/auth/oauth/openai-codex.ts). Bounded response handling and
// restart-safe state transitions retain the hardening from Mailflow PR #275.

import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import { createRequestSignal, parseJson, readLimited, sanitizeText } from './aiHttp.js';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

const AUTH_BASE_URL = 'https://auth.openai.com';
const DEVICE_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60_000;
const SLOW_DOWN_MS = 5000;
const POLL_CLAIM_STALE_MS = 30_000;
const REFRESH_SKEW_MS = 60_000;
const JSON_BODY_LIMIT_BYTES = 256 * 1024;
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

export type CodexDeviceFlowState =
  | 'pending'
  | 'polling'
  | 'authorized'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface CodexOwner {
  adminUserId: string;
  sessionHash: string;
}

export interface CodexDeviceFlowRecord extends CodexOwner {
  id: string;
  deviceAuthIdEnc: string | null;
  userCodeEnc: string | null;
  authorizationCodeEnc: string | null;
  codeVerifierEnc: string | null;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  state: CodexDeviceFlowState;
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

type ClaimResult =
  | { kind: 'not_found' }
  | { kind: 'terminal'; state: CodexDeviceFlowState; failureCode?: string | null }
  | { kind: 'waiting'; retryAfterMs: number }
  | { kind: 'claimed'; flow: CodexDeviceFlowRecord };

export interface CodexStore {
  createFlow(
    flow: Omit<CodexDeviceFlowRecord, 'id' | 'updatedAt'>,
  ): Promise<CodexDeviceFlowRecord>;
  claimFlow(
    input: CodexOwner & { id: string; now: number; staleBefore: number },
  ): Promise<ClaimResult>;
  releaseFlow(input: {
    id: string;
    state: CodexDeviceFlowState;
    intervalMs?: number;
    nextPollAt?: number;
    failureCode?: string | null;
    clearSecrets?: boolean;
  }): Promise<void>;
  authorizeFlow(input: {
    id: string;
    authorizationCodeEnc: string;
    codeVerifierEnc: string;
  }): Promise<boolean>;
  completeFlow(input: { id: string; encryptedCredential: string }): Promise<boolean>;
  cancelFlow(input: CodexOwner & { id: string }): Promise<boolean>;
  latestOwnedFlow(owner: CodexOwner): Promise<CodexDeviceFlowRecord | null>;
  getCredential(): Promise<string | null>;
  disconnect(): Promise<void>;
  withCredentialLock<T>(
    callback: (locked: {
      encryptedCredential: string | null;
      save: (value: string) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

export class CodexAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly transient: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; transient?: boolean } = {},
  ) {
    super(message);
    this.name = 'CodexAuthError';
    this.status = options.status ?? 400;
    this.code = options.code;
    this.transient = options.transient ?? false;
  }
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface CodexDatabase extends RawClient {
  $transaction<T>(
    callback: (client: RawClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

interface CodexFlowRow {
  id: string;
  admin_user_id: string;
  session_hash: string;
  device_auth_id_enc: string | null;
  user_code_enc: string | null;
  authorization_code_enc: string | null;
  code_verifier_enc: string | null;
  interval_ms: number;
  expires_at: Date | string;
  next_poll_at: Date | string;
  state: CodexDeviceFlowState;
  failure_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface CodexCredentialRow {
  encrypted_payload: string;
}

function milliseconds(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function rowToFlow(row: CodexFlowRow | undefined): CodexDeviceFlowRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    sessionHash: row.session_hash,
    deviceAuthIdEnc: row.device_auth_id_enc,
    userCodeEnc: row.user_code_enc,
    authorizationCodeEnc: row.authorization_code_enc,
    codeVerifierEnc: row.code_verifier_enc,
    intervalMs: row.interval_ms,
    expiresAt: milliseconds(row.expires_at),
    nextPollAt: milliseconds(row.next_poll_at),
    state: row.state,
    failureCode: row.failure_code,
    createdAt: milliseconds(row.created_at),
    updatedAt: milliseconds(row.updated_at),
    completedAt: row.completed_at === null ? null : milliseconds(row.completed_at),
  };
}

export function createPrismaCodexStore(
  database: CodexDatabase = prisma as unknown as CodexDatabase,
): CodexStore {
  return {
    async createFlow(flow) {
      return database.$transaction(async (client) => {
        const id = randomUUID();
        await client.$queryRawUnsafe(
          'SELECT id FROM "User" WHERE id = $1 FOR UPDATE',
          flow.adminUserId,
        );
        await client.$executeRawUnsafe(
          `UPDATE ai_codex_device_flows
           SET state = 'cancelled', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
           WHERE admin_user_id = $1 AND session_hash = $2
             AND state IN ('pending', 'polling', 'authorized')`,
          flow.adminUserId,
          flow.sessionHash,
        );
        await client.$executeRawUnsafe(
          `DELETE FROM ai_codex_device_flows
           WHERE expires_at < NOW() - INTERVAL '1 day'`,
        );
        const rows = await client.$queryRawUnsafe<CodexFlowRow[]>(
          `INSERT INTO ai_codex_device_flows
             (id, admin_user_id, session_hash, device_auth_id_enc, user_code_enc,
              interval_ms, expires_at, next_poll_at, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $9)
           RETURNING *`,
          id,
          flow.adminUserId,
          flow.sessionHash,
          flow.deviceAuthIdEnc,
          flow.userCodeEnc,
          flow.intervalMs,
          new Date(flow.expiresAt),
          new Date(flow.nextPollAt),
          new Date(flow.createdAt),
        );
        const created = rowToFlow(rows[0]);
        if (!created) throw new CodexAuthError('Could not persist ChatGPT authorization', { status: 503 });
        return created;
      });
    },

    async claimFlow({ id, adminUserId, sessionHash, now, staleBefore }) {
      return database.$transaction(async (client) => {
        const rows = await client.$queryRawUnsafe<CodexFlowRow[]>(
          `SELECT * FROM ai_codex_device_flows
           WHERE id = $1 AND admin_user_id = $2 AND session_hash = $3
           FOR UPDATE`,
          id,
          adminUserId,
          sessionHash,
        );
        const flow = rowToFlow(rows[0]);
        if (!flow) return { kind: 'not_found' as const };
        if (
          ['pending', 'polling', 'authorized'].includes(flow.state) &&
          flow.expiresAt <= now
        ) {
          await client.$executeRawUnsafe(
            `UPDATE ai_codex_device_flows
             SET state = 'expired', device_auth_id_enc = NULL, user_code_enc = NULL,
                 authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = $2
             WHERE id = $1`,
            id,
            new Date(now),
          );
          return { kind: 'terminal' as const, state: 'expired' as const };
        }
        if (['completed', 'cancelled', 'expired', 'failed'].includes(flow.state)) {
          return {
            kind: 'terminal' as const,
            state: flow.state,
            failureCode: flow.failureCode,
          };
        }
        if (flow.state === 'pending' && flow.nextPollAt > now) {
          return { kind: 'waiting' as const, retryAfterMs: flow.nextPollAt - now };
        }
        if (flow.state === 'polling' && flow.updatedAt > staleBefore) {
          return { kind: 'waiting' as const, retryAfterMs: MIN_INTERVAL_MS };
        }
        await client.$executeRawUnsafe(
          `UPDATE ai_codex_device_flows SET state = 'polling', updated_at = $2 WHERE id = $1`,
          id,
          new Date(now),
        );
        return {
          kind: 'claimed' as const,
          flow: { ...flow, state: 'polling' as const, updatedAt: now },
        };
      });
    },

    async releaseFlow({
      id,
      state,
      intervalMs,
      nextPollAt,
      failureCode,
      clearSecrets = false,
    }) {
      await database.$executeRawUnsafe(
        `UPDATE ai_codex_device_flows
         SET state = $2,
             interval_ms = COALESCE($3, interval_ms),
             next_poll_at = COALESCE($4, next_poll_at),
             failure_code = $5,
             device_auth_id_enc = CASE WHEN $6 THEN NULL ELSE device_auth_id_enc END,
             user_code_enc = CASE WHEN $6 THEN NULL ELSE user_code_enc END,
             authorization_code_enc = CASE WHEN $6 THEN NULL ELSE authorization_code_enc END,
             code_verifier_enc = CASE WHEN $6 THEN NULL ELSE code_verifier_enc END,
             updated_at = NOW()
         WHERE id = $1 AND state IN ('polling', 'authorized')`,
        id,
        state,
        intervalMs ?? null,
        nextPollAt === undefined ? null : new Date(nextPollAt),
        failureCode ?? null,
        clearSecrets,
      );
    },

    async authorizeFlow({ id, authorizationCodeEnc, codeVerifierEnc }) {
      const count = await database.$executeRawUnsafe(
        `UPDATE ai_codex_device_flows
         SET state = 'authorized', authorization_code_enc = $2, code_verifier_enc = $3,
             updated_at = NOW()
         WHERE id = $1 AND state = 'polling'`,
        id,
        authorizationCodeEnc,
        codeVerifierEnc,
      );
      return count > 0;
    },

    async completeFlow({ id, encryptedCredential }) {
      return database.$transaction(async (client) => {
        const lock = await client.$queryRawUnsafe<Array<{ state: CodexDeviceFlowState }>>(
          'SELECT state FROM ai_codex_device_flows WHERE id = $1 FOR UPDATE',
          id,
        );
        if (!['polling', 'authorized'].includes(lock[0]?.state ?? 'failed')) return false;
        await client.$executeRawUnsafe(
          `INSERT INTO ai_codex_credentials (singleton, encrypted_payload, updated_at)
           VALUES (TRUE, $1, NOW())
           ON CONFLICT (singleton)
           DO UPDATE SET encrypted_payload = $1, updated_at = NOW()`,
          encryptedCredential,
        );
        await client.$executeRawUnsafe(
          `UPDATE ai_codex_device_flows
           SET state = 'completed', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL,
               completed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          id,
        );
        return true;
      });
    },

    async cancelFlow({ id, adminUserId, sessionHash }) {
      const rows = await database.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE ai_codex_device_flows
         SET state = 'cancelled', device_auth_id_enc = NULL, user_code_enc = NULL,
             authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
         WHERE id = $1 AND admin_user_id = $2 AND session_hash = $3
           AND state IN ('pending', 'polling', 'authorized')
         RETURNING id`,
        id,
        adminUserId,
        sessionHash,
      );
      return rows.length > 0;
    },

    async latestOwnedFlow({ adminUserId, sessionHash }) {
      const rows = await database.$queryRawUnsafe<CodexFlowRow[]>(
        `SELECT * FROM ai_codex_device_flows
         WHERE admin_user_id = $1 AND session_hash = $2
         ORDER BY created_at DESC LIMIT 1`,
        adminUserId,
        sessionHash,
      );
      return rowToFlow(rows[0]);
    },

    async getCredential() {
      const rows = await database.$queryRawUnsafe<CodexCredentialRow[]>(
        'SELECT encrypted_payload FROM ai_codex_credentials WHERE singleton = TRUE',
      );
      return rows[0]?.encrypted_payload ?? null;
    },

    async disconnect() {
      await database.$transaction(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE ai_codex_device_flows
           SET state = 'cancelled', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
           WHERE state IN ('pending', 'polling', 'authorized')`,
        );
        await client.$executeRawUnsafe(
          'DELETE FROM ai_codex_credentials WHERE singleton = TRUE',
        );
      });
    },

    async withCredentialLock(callback) {
      return database.$transaction(
        async (client) => {
          const rows = await client.$queryRawUnsafe<CodexCredentialRow[]>(
            `SELECT encrypted_payload FROM ai_codex_credentials
             WHERE singleton = TRUE FOR UPDATE`,
          );
          return callback({
            encryptedCredential: rows[0]?.encrypted_payload ?? null,
            save: async (value) => {
              await client.$executeRawUnsafe(
                `INSERT INTO ai_codex_credentials (singleton, encrypted_payload, updated_at)
                 VALUES (TRUE, $1, NOW())
                 ON CONFLICT (singleton)
                 DO UPDATE SET encrypted_payload = $1, updated_at = NOW()`,
                value,
              );
            },
          });
        },
        { maxWait: 5000, timeout: REQUEST_TIMEOUT_MS + 5000 },
      );
    },
  };
}

export function decodeJwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractChatGptAccount(
  claims: Record<string, unknown> | null,
): { accountId: string; email: string } {
  if (!claims) throw new CodexAuthError('ChatGPT token has no account information');
  const auth = objectValue(claims['https://api.openai.com/auth']);
  const profile = objectValue(claims['https://api.openai.com/profile']);
  const accountId =
    typeof auth?.chatgpt_account_id === 'string'
      ? auth.chatgpt_account_id
      : typeof claims.chatgpt_account_id === 'string'
        ? claims.chatgpt_account_id
        : '';
  if (!accountId) throw new CodexAuthError('ChatGPT token has no account ID');
  const email =
    typeof profile?.email === 'string'
      ? profile.email
      : typeof claims.email === 'string'
        ? claims.email
        : typeof auth?.email === 'string'
          ? auth.email
          : '';
  return { accountId, email };
}

function maskAccountLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  return value.length <= 4 ? '••••' : `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function responseErrorCode(body: Record<string, unknown> | null): string {
  const error = body?.error;
  if (typeof error === 'string') return error;
  const nested = objectValue(error);
  return typeof nested?.code === 'string' ? nested.code : '';
}

function authHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    originator: 'recat-qbo',
    'User-Agent': 'Recat QBO',
  };
}

async function fetchAuthResponse(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; text: string }> {
  const requestSignal = createRequestSignal(undefined, timeoutMs, 'request timeout');
  try {
    const response = await fetchFn(url, { ...init, signal: requestSignal.signal });
    const text = await readLimited(
      response,
      response.ok ? JSON_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES,
    );
    return { response, text };
  } catch (error) {
    if (requestSignal.timedOut()) {
      throw new CodexAuthError('ChatGPT authorization request timed out', { transient: true });
    }
    const message = error instanceof Error ? error.message : '';
    throw new CodexAuthError(
      `ChatGPT authorization network error: ${sanitizeText(message, 300) || 'request failed'}`,
      { transient: true },
    );
  } finally {
    requestSignal.cleanup();
  }
}

function intervalMilliseconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INTERVAL_MS;
  const seconds = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(seconds * 1000)));
}

function encryptedJson(value: unknown, encryptFn: (value: string) => string): string {
  return encryptFn(JSON.stringify(value));
}

interface CodexCredential {
  state: 'connected' | 'reconnect_required';
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  accountId: string;
  accountLabel: string;
  failureCode: string | null;
}

interface CodexForcedRefresh {
  failedAccessToken: string;
}

interface CodexReconnectMark {
  failedAccessToken: string;
  failureCode?: string;
}

function decryptedCredential(
  value: string,
  decryptFn: (value: string) => string,
): CodexCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptFn(value));
  } catch {
    throw new CodexAuthError('Stored ChatGPT authorization is corrupted', { status: 503 });
  }
  const credential = objectValue(parsed);
  if (!credential) {
    throw new CodexAuthError('Stored ChatGPT authorization is unavailable', { status: 503 });
  }
  return credential as unknown as CodexCredential;
}

function terminalPollResult(
  state: CodexDeviceFlowState,
  failureCode?: string | null,
): Record<string, unknown> {
  if (state === 'completed') return { status: 'connected' };
  if (state === 'failed') {
    return {
      status: 'failed',
      reconnectRequired: true,
      reason: failureCode || 'authorization_failed',
    };
  }
  return { status: state };
}

function credentialExpiry(
  tokenBody: Record<string, unknown>,
  claims: Record<string, unknown> | null,
  now: number,
): number {
  const raw = tokenBody.expires_in;
  const seconds = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return now + seconds * 1000;
  }
  if (typeof claims?.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > 0) {
    return claims.exp * 1000;
  }
  throw new CodexAuthError('ChatGPT token response has no valid expiry');
}

export function createCodexAuth({
  store = createPrismaCodexStore(),
  fetchFn = fetch,
  now = () => Date.now(),
  encryptFn = encrypt,
  decryptFn = decrypt,
}: {
  store?: CodexStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  encryptFn?: (value: string) => string;
  decryptFn?: (value: string) => string;
} = {}) {
  let refreshInFlight: Promise<unknown> | null = null;

  const accessResult = (credential: CodexCredential): { accessToken: string; accountId: string } => {
    if (
      credential.state !== 'connected' ||
      !credential.accessToken ||
      !credential.accountId
    ) {
      throw new CodexAuthError('ChatGPT authorization requires reconnection', { status: 401 });
    }
    return { accessToken: credential.accessToken, accountId: credential.accountId };
  };

  async function refreshUnderLock(forceRefresh: CodexForcedRefresh | undefined) {
    return store.withCredentialLock(async ({ encryptedCredential, save }) => {
      if (!encryptedCredential) {
        throw new CodexAuthError('ChatGPT is not connected', { status: 503 });
      }
      const credential = decryptedCredential(encryptedCredential, decryptFn);
      if (credential.state !== 'connected') {
        return {
          error: new CodexAuthError('ChatGPT authorization requires reconnection', {
            status: 401,
            ...(credential.failureCode ? { code: credential.failureCode } : {}),
          }),
        };
      }
      if (forceRefresh && credential.accessToken !== forceRefresh.failedAccessToken) {
        return accessResult(credential);
      }
      if (!forceRefresh && credential.expiresAt > now() + REFRESH_SKEW_MS) {
        return accessResult(credential);
      }
      if (!credential.refreshToken) {
        const failureCode = 'missing_refresh_token';
        await save(
          encryptedJson(
            {
              ...credential,
              state: 'reconnect_required',
              accessToken: null,
              refreshToken: null,
              failureCode,
            },
            encryptFn,
          ),
        );
        return {
          error: new CodexAuthError('ChatGPT authorization requires reconnection', {
            status: 401,
            code: failureCode,
          }),
        };
      }

      const { response, text } = await fetchAuthResponse(fetchFn, TOKEN_URL, {
        method: 'POST',
        headers: authHeaders('application/x-www-form-urlencoded'),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: OPENAI_CODEX_CLIENT_ID,
          refresh_token: credential.refreshToken,
        }),
      });
      const body = parseJson(text);

      if (!response.ok) {
        const upstreamCode = sanitizeText(responseErrorCode(body), 100);
        if (TERMINAL_REFRESH_ERRORS.has(upstreamCode)) {
          await save(
            encryptedJson(
              {
                ...credential,
                state: 'reconnect_required',
                accessToken: null,
                refreshToken: null,
                failureCode: upstreamCode,
              },
              encryptFn,
            ),
          );
          return {
            error: new CodexAuthError('ChatGPT authorization expired; reconnect required', {
              status: 401,
              code: upstreamCode,
            }),
          };
        }
        throw new CodexAuthError(`ChatGPT token refresh failed (${response.status})`, {
          status: 502,
          ...(upstreamCode ? { code: upstreamCode } : {}),
          transient: true,
        });
      }

      if (typeof body?.access_token !== 'string' || !body.access_token) {
        throw new CodexAuthError('Invalid ChatGPT token refresh response', {
          status: 502,
          transient: true,
        });
      }
      const nextRefreshToken =
        typeof body.refresh_token === 'string' && body.refresh_token
          ? body.refresh_token
          : credential.refreshToken;
      let claims: Record<string, unknown> | null;
      let account: { accountId: string; email: string };
      let expiresAt: number;
      try {
        claims = decodeJwtClaims(body.access_token);
        account = extractChatGptAccount(claims);
        expiresAt = credentialExpiry(body, claims, now());
      } catch {
        throw new CodexAuthError('Invalid ChatGPT token refresh identity or expiry', {
          status: 502,
          transient: true,
        });
      }
      const refreshed: CodexCredential = {
        state: 'connected',
        accessToken: body.access_token,
        refreshToken: nextRefreshToken,
        expiresAt,
        accountId: account.accountId,
        accountLabel: maskAccountLabel(account.email || credential.accountLabel || account.accountId),
        failureCode: null,
      };
      await save(encryptedJson(refreshed, encryptFn));
      return accessResult(refreshed);
    });
  }

  async function getAccess(
    { forceRefresh }: { forceRefresh?: CodexForcedRefresh } = {},
  ) {
    const encryptedCredential = await store.getCredential();
    if (!encryptedCredential) {
      throw new CodexAuthError('ChatGPT is not connected', { status: 503 });
    }
    const credential = decryptedCredential(encryptedCredential, decryptFn);
    if (credential.state !== 'connected') {
      throw new CodexAuthError('ChatGPT authorization requires reconnection', {
        status: 401,
        ...(credential.failureCode ? { code: credential.failureCode } : {}),
      });
    }
    if (forceRefresh && credential.accessToken !== forceRefresh.failedAccessToken) {
      return accessResult(credential);
    }
    if (!forceRefresh && credential.expiresAt > now() + REFRESH_SKEW_MS) {
      return accessResult(credential);
    }

    if (!refreshInFlight) {
      refreshInFlight = refreshUnderLock(forceRefresh).finally(() => {
        refreshInFlight = null;
      });
    }
    const result = (await refreshInFlight) as
      | { accessToken: string; accountId: string }
      | { error: CodexAuthError };
    if ('error' in result) throw result.error;
    return result;
  }

  async function startDeviceFlow(owner: CodexOwner) {
    const { response, text } = await fetchAuthResponse(fetchFn, DEVICE_CODE_URL, {
      method: 'POST',
      headers: authHeaders('application/json'),
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    });
    if (!response.ok) {
      throw new CodexAuthError(`ChatGPT device code request failed (${response.status})`, {
        status: 502,
        transient: response.status >= 500,
      });
    }
    const body = parseJson(text);
    const intervalMs = intervalMilliseconds(body?.interval);
    const deviceAuthId = body?.device_auth_id;
    const userCode = body?.user_code || body?.usercode;
    if (
      typeof deviceAuthId !== 'string' ||
      !deviceAuthId ||
      typeof userCode !== 'string' ||
      !userCode ||
      intervalMs === null
    ) {
      throw new CodexAuthError('Invalid device code response', { status: 502 });
    }
    const startedAt = now();
    const flow = await store.createFlow({
      ...owner,
      deviceAuthIdEnc: encryptFn(deviceAuthId),
      userCodeEnc: encryptFn(userCode),
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
      intervalMs,
      expiresAt: startedAt + DEVICE_TIMEOUT_MS,
      nextPollAt: startedAt + intervalMs,
      state: 'pending',
      failureCode: null,
      createdAt: startedAt,
    });
    return {
      flowId: flow.id,
      userCode,
      verificationUrl: OPENAI_CODEX_DEVICE_URL,
      intervalMs,
      expiresAt: flow.expiresAt,
      status: 'pending' as const,
    };
  }

  async function releaseFailed(
    flowId: string,
    error: CodexAuthError,
    state: CodexDeviceFlowState = 'failed',
  ): Promise<void> {
    await store.releaseFlow({
      id: flowId,
      state,
      failureCode: error.code || (error.transient ? 'transient_error' : 'authorization_failed'),
      clearSecrets: state === 'failed',
    });
  }

  async function exchangeAuthorizedFlow(flow: CodexDeviceFlowRecord) {
    if (!flow.authorizationCodeEnc || !flow.codeVerifierEnc) {
      throw new CodexAuthError('Stored ChatGPT exchange code is unavailable');
    }
    const authorizationCode = decryptFn(flow.authorizationCodeEnc);
    const codeVerifier = decryptFn(flow.codeVerifierEnc);
    if (!authorizationCode || !codeVerifier) {
      throw new CodexAuthError('Stored ChatGPT exchange code is unavailable');
    }
    const { response, text } = await fetchAuthResponse(fetchFn, TOKEN_URL, {
      method: 'POST',
      headers: authHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
    });
    if (!response.ok) {
      const code = responseErrorCode(parseJson(text));
      throw new CodexAuthError(`ChatGPT token exchange failed (${response.status})`, {
        status: 502,
        ...(code ? { code: sanitizeText(code, 100) } : {}),
        transient: response.status >= 500,
      });
    }
    const body = parseJson(text);
    if (
      typeof body?.access_token !== 'string' ||
      !body.access_token ||
      typeof body.refresh_token !== 'string' ||
      !body.refresh_token
    ) {
      throw new CodexAuthError('Invalid ChatGPT token exchange response', { status: 502 });
    }
    const claims = decodeJwtClaims(body.access_token);
    const account = extractChatGptAccount(claims);
    const payload: CodexCredential = {
      state: 'connected',
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: credentialExpiry(body, claims, now()),
      accountId: account.accountId,
      accountLabel: maskAccountLabel(account.email || account.accountId),
      failureCode: null,
    };
    const completed = await store.completeFlow({
      id: flow.id,
      encryptedCredential: encryptedJson(payload, encryptFn),
    });
    return completed ? { status: 'connected' as const } : { status: 'cancelled' as const };
  }

  async function pollDeviceFlow({ flowId, ...owner }: CodexOwner & { flowId: string }) {
    const time = now();
    const claim = await store.claimFlow({
      id: flowId,
      ...owner,
      now: time,
      staleBefore: time - POLL_CLAIM_STALE_MS,
    });
    if (claim.kind === 'not_found') {
      throw new CodexAuthError('Device authorization not found', { status: 404 });
    }
    if (claim.kind === 'terminal') {
      return terminalPollResult(claim.state, claim.failureCode);
    }
    if (claim.kind === 'waiting') {
      return { status: 'pending' as const, retryAfterMs: Math.max(MIN_INTERVAL_MS, claim.retryAfterMs) };
    }

    let flow = claim.flow;
    if (!flow.authorizationCodeEnc || !flow.codeVerifierEnc) {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await fetchAuthResponse(fetchFn, DEVICE_TOKEN_URL, {
          method: 'POST',
          headers: authHeaders('application/json'),
          body: JSON.stringify({
            device_auth_id: flow.deviceAuthIdEnc ? decryptFn(flow.deviceAuthIdEnc) : '',
            user_code: flow.userCodeEnc ? decryptFn(flow.userCodeEnc) : '',
          }),
        }));
      } catch (error) {
        const authError =
          error instanceof CodexAuthError
            ? error
            : new CodexAuthError('ChatGPT authorization failed', { transient: true });
        await releaseFailed(flow.id, authError, 'pending');
        throw authError;
      }
      const body = parseJson(text);
      if (!response.ok) {
        const code = responseErrorCode(body);
        if (
          response.status === 403 ||
          response.status === 404 ||
          code === 'deviceauth_authorization_pending'
        ) {
          const nextPollAt = now() + flow.intervalMs;
          await store.releaseFlow({
            id: flow.id,
            state: 'pending',
            nextPollAt,
            failureCode: null,
          });
          return { status: 'pending' as const, retryAfterMs: flow.intervalMs };
        }
        if (code === 'slow_down') {
          const intervalMs = Math.min(MAX_INTERVAL_MS, flow.intervalMs + SLOW_DOWN_MS);
          await store.releaseFlow({
            id: flow.id,
            state: 'pending',
            intervalMs,
            nextPollAt: now() + intervalMs,
            failureCode: null,
          });
          return { status: 'pending' as const, retryAfterMs: intervalMs };
        }
        const error = new CodexAuthError(
          `ChatGPT device authorization failed (${response.status})`,
          {
            status: 502,
            ...(code ? { code: sanitizeText(code, 100) } : {}),
            transient: response.status >= 500,
          },
        );
        await releaseFailed(flow.id, error, error.transient ? 'pending' : 'failed');
        throw error;
      }
      if (
        typeof body?.authorization_code !== 'string' ||
        !body.authorization_code ||
        typeof body.code_verifier !== 'string' ||
        !body.code_verifier
      ) {
        const error = new CodexAuthError('Invalid ChatGPT device authorization response', {
          status: 502,
        });
        await releaseFailed(flow.id, error);
        throw error;
      }
      const authorizationCodeEnc = encryptFn(body.authorization_code);
      const codeVerifierEnc = encryptFn(body.code_verifier);
      const authorized = await store.authorizeFlow({
        id: flow.id,
        authorizationCodeEnc,
        codeVerifierEnc,
      });
      if (!authorized) return { status: 'cancelled' as const };
      flow = {
        ...flow,
        authorizationCodeEnc,
        codeVerifierEnc,
        state: 'authorized',
      };
    }

    try {
      return await exchangeAuthorizedFlow(flow);
    } catch (error) {
      const authError =
        error instanceof CodexAuthError
          ? error
          : new CodexAuthError('ChatGPT authorization failed');
      await releaseFailed(flow.id, authError, authError.transient ? 'authorized' : 'failed');
      throw authError;
    }
  }

  async function cancelDeviceFlow({ flowId, ...owner }: CodexOwner & { flowId: string }) {
    const cancelled = await store.cancelFlow({ id: flowId, ...owner });
    if (!cancelled) {
      throw new CodexAuthError('Device authorization not found', { status: 404 });
    }
    return { status: 'cancelled' as const };
  }

  async function getStatus(owner?: CodexOwner) {
    let credentialStatus: Record<string, unknown> | null = null;
    const encryptedCredential = await store.getCredential();
    if (encryptedCredential) {
      try {
        const credential = decryptedCredential(encryptedCredential, decryptFn);
        if (credential.state === 'connected') {
          return {
            connected: true as const,
            state: 'connected' as const,
            expiresAt: credential.expiresAt,
            accountLabel: maskAccountLabel(credential.accountLabel),
          };
        }
        credentialStatus = {
          connected: false,
          state: credential.state || 'reconnect_required',
          reconnectRequired: true,
          reason: credential.failureCode || 'authorization_expired',
        };
      } catch {
        credentialStatus = {
          connected: false,
          state: 'reconnect_required',
          reconnectRequired: true,
          reason: 'credential_unavailable',
        };
      }
    }
    if (owner) {
      const flow = await store.latestOwnedFlow(owner);
      if (
        flow &&
        ['pending', 'polling', 'authorized'].includes(flow.state) &&
        flow.expiresAt > now()
      ) {
        return {
          connected: false as const,
          state: 'pending' as const,
          device: {
            flowId: flow.id,
            userCode: flow.userCodeEnc ? decryptFn(flow.userCodeEnc) : '',
            verificationUrl: OPENAI_CODEX_DEVICE_URL,
            expiresAt: flow.expiresAt,
            intervalMs: flow.intervalMs,
          },
        };
      }
    }
    return (
      credentialStatus ?? {
        connected: false as const,
        state: 'disconnected' as const,
        reconnectRequired: false,
      }
    );
  }

  async function markReconnectRequired({
    failedAccessToken,
    failureCode = 'inference_unauthorized',
  }: CodexReconnectMark): Promise<void> {
    await store.withCredentialLock(async ({ encryptedCredential, save }) => {
      if (!encryptedCredential) return;
      const credential = decryptedCredential(encryptedCredential, decryptFn);
      if (
        credential.state !== 'connected' ||
        credential.accessToken !== failedAccessToken
      ) {
        return;
      }
      await save(
        encryptedJson(
          {
            ...credential,
            state: 'reconnect_required',
            accessToken: null,
            refreshToken: null,
            failureCode: sanitizeText(failureCode, 100) || 'inference_unauthorized',
          },
          encryptFn,
        ),
      );
    });
  }

  async function disconnect() {
    await store.disconnect();
    return { status: 'disconnected' as const };
  }

  return {
    startDeviceFlow,
    pollDeviceFlow,
    cancelDeviceFlow,
    getStatus,
    getAccess,
    markReconnectRequired,
    disconnect,
  };
}

const defaultService = createCodexAuth();

export const startCodexDeviceFlow = defaultService.startDeviceFlow;
export const pollCodexDeviceFlow = defaultService.pollDeviceFlow;
export const cancelCodexDeviceFlow = defaultService.cancelDeviceFlow;
export const getCodexStatus = defaultService.getStatus;
export const getCodexAccess = defaultService.getAccess;
export const markCodexReconnectRequired = defaultService.markReconnectRequired;
export const disconnectCodex = defaultService.disconnect;
