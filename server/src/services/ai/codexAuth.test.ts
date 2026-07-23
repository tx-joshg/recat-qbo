import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, sha256Hex } from '../../lib/crypto.js';
import {
  OPENAI_CODEX_DEVICE_URL,
  createCodexAuth,
  createPrismaCodexStore,
  decodeJwtClaims,
  extractChatGptAccount,
  type CodexDeviceFlowRecord,
  type CodexStore,
} from './codexAuth.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accessToken({
  accountId = 'acct_123',
  email = 'owner@example.com',
  expiresIn = 3600,
}: { accountId?: string; email?: string; expiresIn?: number } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expiresIn,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      'https://api.openai.com/profile': { email },
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

class MemoryStore implements CodexStore {
  readonly flows = new Map<string, CodexDeviceFlowRecord>();
  credential: string | null = null;
  credentialLockCalls = 0;
  private nextId = 1;
  private lock: Promise<void> = Promise.resolve();

  async createFlow(flow: Omit<CodexDeviceFlowRecord, 'id' | 'updatedAt'>): Promise<CodexDeviceFlowRecord> {
    for (const current of this.flows.values()) {
      if (
        current.adminUserId === flow.adminUserId &&
        current.sessionHash === flow.sessionHash &&
        ['pending', 'polling', 'authorized'].includes(current.state)
      ) {
        current.state = 'cancelled';
      }
    }
    const record: CodexDeviceFlowRecord = {
      ...flow,
      id: `flow-${this.nextId++}`,
      updatedAt: flow.createdAt,
    };
    this.flows.set(record.id, record);
    return { ...record };
  }

  async claimFlow({
    id,
    adminUserId,
    sessionHash,
    now,
    staleBefore,
  }: {
    id: string;
    adminUserId: string;
    sessionHash: string;
    now: number;
    staleBefore: number;
  }) {
    const flow = this.flows.get(id);
    if (!flow || flow.adminUserId !== adminUserId || flow.sessionHash !== sessionHash) {
      return { kind: 'not_found' as const };
    }
    if (['pending', 'polling', 'authorized'].includes(flow.state) && flow.expiresAt <= now) {
      Object.assign(flow, {
        state: 'expired' as const,
        deviceAuthIdEnc: null,
        userCodeEnc: null,
        authorizationCodeEnc: null,
        codeVerifierEnc: null,
        updatedAt: now,
      });
    }
    if (['completed', 'cancelled', 'expired', 'failed'].includes(flow.state)) {
      return { kind: 'terminal' as const, state: flow.state, failureCode: flow.failureCode };
    }
    if (flow.state === 'pending' && flow.nextPollAt > now) {
      return { kind: 'waiting' as const, retryAfterMs: flow.nextPollAt - now };
    }
    if (flow.state === 'polling' && flow.updatedAt > staleBefore) {
      return { kind: 'waiting' as const, retryAfterMs: 1000 };
    }
    flow.state = 'polling';
    flow.updatedAt = now;
    return { kind: 'claimed' as const, flow: { ...flow } };
  }

  async releaseFlow({
    id,
    state,
    intervalMs,
    nextPollAt,
    failureCode,
    clearSecrets = false,
  }: {
    id: string;
    state: CodexDeviceFlowRecord['state'];
    intervalMs?: number;
    nextPollAt?: number;
    failureCode?: string | null;
    clearSecrets?: boolean;
  }): Promise<void> {
    const flow = this.flows.get(id);
    if (!flow || !['polling', 'authorized'].includes(flow.state)) return;
    flow.state = state;
    if (intervalMs !== undefined) flow.intervalMs = intervalMs;
    if (nextPollAt !== undefined) flow.nextPollAt = nextPollAt;
    if (failureCode !== undefined) flow.failureCode = failureCode;
    if (clearSecrets) {
      flow.deviceAuthIdEnc = null;
      flow.userCodeEnc = null;
      flow.authorizationCodeEnc = null;
      flow.codeVerifierEnc = null;
    }
    flow.updatedAt = Date.now();
  }

  async authorizeFlow({
    id,
    authorizationCodeEnc,
    codeVerifierEnc,
  }: {
    id: string;
    authorizationCodeEnc: string;
    codeVerifierEnc: string;
  }): Promise<boolean> {
    const flow = this.flows.get(id);
    if (!flow || flow.state !== 'polling') return false;
    Object.assign(flow, { authorizationCodeEnc, codeVerifierEnc, state: 'authorized' as const });
    return true;
  }

  async completeFlow({ id, encryptedCredential }: { id: string; encryptedCredential: string }): Promise<boolean> {
    const flow = this.flows.get(id);
    if (!flow || !['polling', 'authorized'].includes(flow.state)) return false;
    this.credential = encryptedCredential;
    Object.assign(flow, {
      state: 'completed' as const,
      deviceAuthIdEnc: null,
      userCodeEnc: null,
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
      completedAt: Date.now(),
    });
    return true;
  }

  async cancelFlow({
    id,
    adminUserId,
    sessionHash,
  }: {
    id: string;
    adminUserId: string;
    sessionHash: string;
  }): Promise<boolean> {
    const flow = this.flows.get(id);
    if (
      !flow ||
      flow.adminUserId !== adminUserId ||
      flow.sessionHash !== sessionHash ||
      !['pending', 'polling', 'authorized'].includes(flow.state)
    ) {
      return false;
    }
    Object.assign(flow, {
      state: 'cancelled' as const,
      deviceAuthIdEnc: null,
      userCodeEnc: null,
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
    });
    return true;
  }

  async latestOwnedFlow({ adminUserId, sessionHash }: { adminUserId: string; sessionHash: string }) {
    return (
      [...this.flows.values()]
        .reverse()
        .find((flow) => flow.adminUserId === adminUserId && flow.sessionHash === sessionHash) ?? null
    );
  }

  async getCredential(): Promise<string | null> {
    return this.credential;
  }

  async disconnect(): Promise<void> {
    this.credential = null;
    for (const flow of this.flows.values()) {
      if (['pending', 'polling', 'authorized'].includes(flow.state)) flow.state = 'cancelled';
    }
  }

  async withCredentialLock<T>(
    callback: (locked: {
      encryptedCredential: string | null;
      save: (value: string) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    this.credentialLockCalls += 1;
    const previous = this.lock;
    let release = (): void => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback({
        encryptedCredential: this.credential,
        save: async (value) => {
          this.credential = value;
        },
      });
    } finally {
      release();
    }
  }
}

const owner = { adminUserId: 'admin-1', sessionHash: sha256Hex('session-secret') };

function service({
  store = new MemoryStore(),
  fetchFn = vi.fn<typeof fetch>(),
  now = () => Date.now(),
}: { store?: MemoryStore; fetchFn?: ReturnType<typeof vi.fn<typeof fetch>>; now?: () => number } = {}) {
  return { auth: createCodexAuth({ store, fetchFn, now }), store, fetchFn };
}

function seedCredential(store: MemoryStore, overrides: Record<string, unknown> = {}): void {
  store.credential = encrypt(
    JSON.stringify({
      state: 'connected',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct_old',
      accountLabel: 'o***@example.com',
      failureCode: null,
      ...overrides,
    }),
  );
}

function readCredential(store: MemoryStore): Record<string, unknown> {
  if (!store.credential) throw new Error('missing credential');
  return JSON.parse(decrypt(store.credential)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JWT identity helpers', () => {
  it('extracts the namespaced ChatGPT account and profile email', () => {
    expect(extractChatGptAccount(decodeJwtClaims(accessToken()))).toEqual({
      accountId: 'acct_123',
      email: 'owner@example.com',
    });
  });

  it.each(['', 'not-a-jwt', 'a.invalid-json.c', 'a.e30.c'])(
    'handles malformed or account-less token %j safely',
    (token) => expect(() => extractChatGptAccount(decodeJwtClaims(token))).toThrow(/account/i),
  );
});

describe('device authorization', () => {
  it('uses the exact public client and persists only encrypted codes plus the supplied session hash', async () => {
    const { auth, store, fetchFn } = service({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'device-secret', usercode: 'ABCD-EFGH', interval: '2' }),
      ),
    });

    await expect(auth.startDeviceFlow(owner)).resolves.toMatchObject({
      flowId: 'flow-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: OPENAI_CODEX_DEVICE_URL,
      intervalMs: 2000,
      status: 'pending',
    });
    const stored = store.flows.get('flow-1');
    expect(stored?.sessionHash).toBe(owner.sessionHash);
    expect(stored?.sessionHash).not.toContain('session-secret');
    expect(decrypt(stored?.deviceAuthIdEnc ?? '')).toBe('device-secret');
    expect(decrypt(stored?.userCodeEnc ?? '')).toBe('ABCD-EFGH');
    expect(JSON.stringify(stored)).not.toMatch(/device-secret|ABCD-EFGH/);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      originator: 'recat-qbo',
      'User-Agent': 'Recat QBO',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
  });

  it('rejects malformed starts without reflecting raw upstream data', async () => {
    const { auth } = service({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ device_auth_id: 'secret-only' })),
    });
    const error = await auth.startDeviceFlow(owner).catch((cause: unknown) => cause as Error);
    expect(error.message).toMatch(/invalid device code/i);
    expect(error.message).not.toContain('secret-only');
  });

  it('accepts usercode when user_code is present but empty', async () => {
    const { auth } = service({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          device_auth_id: 'device-secret',
          user_code: '',
          usercode: 'FALLBACK-CODE',
          interval: 1,
        }),
      ),
    });

    await expect(auth.startDeviceFlow(owner)).resolves.toMatchObject({
      userCode: 'FALLBACK-CODE',
      status: 'pending',
    });
  });

  it.each([
    new Response(null, { status: 404 }),
    jsonResponse({ error: { code: 'deviceauth_authorization_pending' } }, 400),
  ])('keeps pending responses restart-safe', async (pendingResponse) => {
    const store = new MemoryStore();
    const starter = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      ),
    });
    const started = await starter.startDeviceFlow(owner);
    const flow = store.flows.get(started.flowId);
    if (flow) flow.nextPollAt = 0;

    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(pendingResponse);
    const restarted = createCodexAuth({ store, fetchFn });
    await expect(restarted.pollDeviceFlow({ flowId: started.flowId, ...owner })).resolves.toEqual({
      status: 'pending',
      retryAfterMs: 1000,
    });
    expect(store.flows.get(started.flowId)?.state).toBe('pending');
  });

  it('persists slow_down interval increases capped at sixty seconds', async () => {
    const store = new MemoryStore();
    const starter = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 58 }),
      ),
    });
    const { flowId } = await starter.startDeviceFlow(owner);
    const flow = store.flows.get(flowId);
    if (flow) flow.nextPollAt = 0;
    const auth = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'slow_down' }, 400)),
    });

    await expect(auth.pollDeviceFlow({ flowId, ...owner })).resolves.toEqual({
      status: 'pending',
      retryAfterMs: 60_000,
    });
    expect(store.flows.get(flowId)?.intervalMs).toBe(60_000);
  });

  it('prevents wrong sessions from polling or cancelling and makes completion one-time', async () => {
    const { auth, store, fetchFn } = service({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      ),
    });
    const { flowId } = await auth.startDeviceFlow(owner);
    const flow = store.flows.get(flowId);
    if (flow) flow.nextPollAt = 0;
    fetchFn.mockClear();
    const intruder = { adminUserId: owner.adminUserId, sessionHash: sha256Hex('wrong-session') };

    await expect(auth.pollDeviceFlow({ flowId, ...intruder })).rejects.toMatchObject({ status: 404 });
    await expect(auth.cancelDeviceFlow({ flowId, ...intruder })).rejects.toMatchObject({ status: 404 });
    expect(fetchFn).not.toHaveBeenCalled();

    if (flow) flow.state = 'completed';
    await expect(auth.pollDeviceFlow({ flowId, ...owner })).resolves.toEqual({ status: 'connected' });
    await expect(auth.cancelDeviceFlow({ flowId, ...owner })).rejects.toMatchObject({ status: 404 });
  });

  it('cancels and expires flows without making another upstream request', async () => {
    let now = 1000;
    const store = new MemoryStore();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      );
    const auth = createCodexAuth({ store, fetchFn, now: () => now });
    const cancelled = await auth.startDeviceFlow(owner);
    const expiredOwner = { adminUserId: owner.adminUserId, sessionHash: sha256Hex('other-session') };
    const expired = await auth.startDeviceFlow(expiredOwner);
    fetchFn.mockClear();

    await expect(auth.cancelDeviceFlow({ flowId: cancelled.flowId, ...owner })).resolves.toEqual({
      status: 'cancelled',
    });
    now += 15 * 60_000 + 1;
    await expect(auth.pollDeviceFlow({ flowId: expired.flowId, ...expiredOwner })).resolves.toEqual({
      status: 'expired',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('exchanges authorization once, atomically stores encrypted credentials, masks status, and clears codes', async () => {
    const store = new MemoryStore();
    const starter = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      ),
    });
    const { flowId } = await starter.startDeviceFlow(owner);
    const flow = store.flows.get(flowId);
    if (flow) flow.nextPollAt = 0;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: accessToken(), refresh_token: 'refresh-secret', expires_in: 3600 }),
      );
    const auth = createCodexAuth({ store, fetchFn });

    await expect(auth.pollDeviceFlow({ flowId, ...owner })).resolves.toEqual({ status: 'connected' });
    const [, exchange] = fetchFn.mock.calls[1] as [string, RequestInit];
    const exchangeBody = exchange.body as URLSearchParams;
    expect(exchangeBody.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(exchangeBody.get('code_verifier')).toBe('verifier');
    expect(store.credential).not.toContain('refresh-secret');
    expect(readCredential(store)).toMatchObject({
      state: 'connected',
      accountId: 'acct_123',
      accountLabel: 'o***@example.com',
    });
    expect(JSON.stringify(store.flows.get(flowId))).not.toMatch(/auth-code|verifier|refresh-secret/);

    const status = await auth.getStatus(owner);
    expect(status).toMatchObject({ connected: true, state: 'connected', accountLabel: 'o***@example.com' });
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken|acct_123|device_auth/i);
    fetchFn.mockClear();
    await expect(auth.pollDeviceFlow({ flowId, ...owner })).resolves.toEqual({ status: 'connected' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('preserves an authorized exchange across a transient failure and restart', async () => {
    const store = new MemoryStore();
    const starter = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      ),
    });
    const { flowId } = await starter.startDeviceFlow(owner);
    const flow = store.flows.get(flowId);
    if (flow) flow.nextPollAt = 0;
    const first = createCodexAuth({
      store,
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, 503)),
    });
    await expect(first.pollDeviceFlow({ flowId, ...owner })).rejects.toMatchObject({ transient: true });
    expect(store.flows.get(flowId)?.state).toBe('authorized');

    const retryFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ access_token: accessToken(), refresh_token: 'refresh', expires_in: 3600 }),
    );
    await expect(
      createCodexAuth({ store, fetchFn: retryFetch }).pollDeviceFlow({ flowId, ...owner }),
    ).resolves.toEqual({ status: 'connected' });
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });
});

describe('credential refresh and database locking', () => {
  it('refreshes 60 seconds before expiry and atomically stores a rotated refresh token', async () => {
    const now = Date.now();
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: now + 30_000 });
    const nextAccess = accessToken({ accountId: 'acct_new', email: 'new@example.com' });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ access_token: nextAccess, refresh_token: 'rotated-refresh', expires_in: 7200 }),
    );
    const auth = createCodexAuth({ store, fetchFn, now: () => now });

    await expect(auth.getAccess()).resolves.toEqual({ accessToken: nextAccess, accountId: 'acct_new' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(readCredential(store)).toMatchObject({
      refreshToken: 'rotated-refresh',
      accountId: 'acct_new',
      accountLabel: 'n***@example.com',
      expiresAt: now + 7_200_000,
    });
  });

  it('single-flights concurrent refreshes and rechecks under the shared row lock', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: 0 });
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchFn = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const one = createCodexAuth({ store, fetchFn });
    const sameInstance = [one.getAccess(), one.getAccess(), one.getAccess()];
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const nextAccess = accessToken({ accountId: 'acct_single' });
    resolveFetch(jsonResponse({ access_token: nextAccess, refresh_token: 'rotated', expires_in: 3600 }));
    await expect(Promise.all(sameInstance)).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.credentialLockCalls).toBe(1);

    seedCredential(store, { expiresAt: 0 });
    fetchFn.mockResolvedValue(
      jsonResponse({ access_token: nextAccess, refresh_token: 'rotated-again', expires_in: 3600 }),
    );
    const two = createCodexAuth({ store, fetchFn });
    const three = createCodexAuth({ store, fetchFn });
    await expect(Promise.all([two.getAccess(), three.getAccess()])).resolves.toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not rotate twice when separate processes force-refresh the same failed token', async () => {
    const store = new MemoryStore();
    seedCredential(store);
    const refreshedAccess = accessToken({ accountId: 'acct_refreshed' });
    const redundantAccess = accessToken({ accountId: 'acct_redundant' });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: refreshedAccess, refresh_token: 'refresh-one', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: redundantAccess, refresh_token: 'refresh-two', expires_in: 3600 }),
      );
    const processOne = createCodexAuth({ store, fetchFn });
    const processTwo = createCodexAuth({ store, fetchFn });

    await expect(
      Promise.all([
        processOne.getAccess({ forceRefresh: { failedAccessToken: 'old-access' } }),
        processTwo.getAccess({ forceRefresh: { failedAccessToken: 'old-access' } }),
      ]),
    ).resolves.toEqual([
      { accessToken: refreshedAccess, accountId: 'acct_refreshed' },
      { accessToken: refreshedAccess, accountId: 'acct_refreshed' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(readCredential(store)).toMatchObject({
      state: 'connected',
      accessToken: refreshedAccess,
      refreshToken: 'refresh-one',
    });
  });

  it('ignores a stale second-401 mark after another process refreshes the retried token', async () => {
    const store = new MemoryStore();
    seedCredential(store);
    const retryAccess = accessToken({ accountId: 'acct_retry' });
    const newestAccess = accessToken({ accountId: 'acct_newest' });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: retryAccess, refresh_token: 'refresh-retry', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: newestAccess, refresh_token: 'refresh-newest', expires_in: 3600 }),
      );
    const staleProcess = createCodexAuth({ store, fetchFn });
    const newerProcess = createCodexAuth({ store, fetchFn });

    const retried = await staleProcess.getAccess({
      forceRefresh: { failedAccessToken: 'old-access' },
    });
    await newerProcess.getAccess({
      forceRefresh: { failedAccessToken: retried.accessToken },
    });
    await staleProcess.markReconnectRequired({
      failedAccessToken: retried.accessToken,
      failureCode: 'inference_unauthorized',
    });

    expect(readCredential(store)).toMatchObject({
      state: 'connected',
      accessToken: newestAccess,
      refreshToken: 'refresh-newest',
      failureCode: null,
    });
  });

  it('quarantines terminal refresh failures but preserves credentials on transient failures', async () => {
    const terminalStore = new MemoryStore();
    seedCredential(terminalStore, { expiresAt: 0 });
    const terminalFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: 'invalid_grant' }, 400),
    );
    const terminal = createCodexAuth({ store: terminalStore, fetchFn: terminalFetch });
    await expect(terminal.getAccess()).rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
    expect(readCredential(terminalStore)).toMatchObject({
      state: 'reconnect_required',
      accessToken: null,
      refreshToken: null,
      failureCode: 'invalid_grant',
    });
    await expect(terminal.getAccess()).rejects.toMatchObject({ status: 401 });
    expect(terminalFetch).toHaveBeenCalledTimes(1);

    const transientStore = new MemoryStore();
    seedCredential(transientStore, { expiresAt: 0 });
    const before = transientStore.credential;
    const transient = createCodexAuth({
      store: transientStore,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'server_error' }, 503)),
    });
    await expect(transient.getAccess()).rejects.toMatchObject({ transient: true });
    expect(transientStore.credential).toBe(before);
  });

  it('marks credentials reconnect-required explicitly and disconnects credentials plus active flows', async () => {
    const store = new MemoryStore();
    seedCredential(store);
    const auth = createCodexAuth({
      store,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }),
      ),
    });
    const { flowId } = await auth.startDeviceFlow(owner);

    await auth.markReconnectRequired({
      failedAccessToken: 'old-access',
      failureCode: 'inference_unauthorized',
    });
    expect(readCredential(store)).toMatchObject({
      state: 'reconnect_required',
      accessToken: null,
      refreshToken: null,
      failureCode: 'inference_unauthorized',
    });
    await expect(auth.disconnect()).resolves.toEqual({ status: 'disconnected' });
    expect(store.credential).toBeNull();
    expect(store.flows.get(flowId)?.state).toBe('cancelled');
  });

  it('uses SELECT FOR UPDATE for device claims and credential refresh locks', async () => {
    const queries: string[] = [];
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        queries.push(sql);
        return 0;
      }),
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      $queryRawUnsafe: tx.$queryRawUnsafe,
      $executeRawUnsafe: tx.$executeRawUnsafe,
    };
    const store = createPrismaCodexStore(db);

    await store.claimFlow({
      id: 'flow',
      ...owner,
      now: 1000,
      staleBefore: 0,
    });
    await store.withCredentialLock(async () => undefined);

    expect(queries.some((sql) => /ai_codex_device_flows[\s\S]*FOR UPDATE/i.test(sql))).toBe(true);
    expect(queries.some((sql) => /ai_codex_credentials[\s\S]*FOR UPDATE/i.test(sql))).toBe(true);
  });
});
