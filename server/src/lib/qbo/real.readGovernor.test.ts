import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealQboClient } from './real.js';
import { safeToolFailure } from '../../mcp/result.js';

let realm = 0;
function client(environment: 'sandbox' | 'production' = 'sandbox', realmId = `read-governor-${++realm}`) {
  return new RealQboClient({
    realmId,
    environment,
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    tokens: {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: Date.now() + 3_600_000,
    },
    holdingAccountQboIds: [],
    onTokensRefreshed: async () => undefined,
  });
}
function profile() {
  return new Response(JSON.stringify({
    QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: true } }] },
  }));
}

describe('QuickBooks HTTP read governor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares read spacing across different clients for the same environment and realm', async () => {
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { starts.push(Date.now()); return profile(); }));
    const realmId = `shared-${++realm}`;
    await client('sandbox', realmId).getTaxProfile();
    const second = client('sandbox', realmId).getTaxProfile();
    await vi.advanceTimersByTimeAsync(499);
    expect(starts).toEqual([Date.parse('2026-08-30T00:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ usingSalesTax: true });
    expect(starts[1]! - starts[0]!).toBe(500);
  });

  it('keeps identical realm IDs in different environments independent', async () => {
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { starts.push(Date.now()); return profile(); }));
    const realmId = `environment-${++realm}`;
    await Promise.all([client('sandbox', realmId).getTaxProfile(), client('production', realmId).getTaxProfile()]);
    expect(starts).toEqual([Date.now(), Date.now()]);
  });

  it('returns a bounded safe retry hint after a 429 and delays the next read without replaying the rejected call', async () => {
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(Date.now());
      return starts.length === 1
        ? new Response('SYNTHETIC_PROVIDER_DETAIL', { status: 429, headers: { 'Retry-After': '2' } })
        : profile();
    }));
    const qbo = client();
    const error = await qbo.getTaxProfile().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'QBO_RATE_LIMITED', retryAfterSeconds: 2 });
    const failure = safeToolFailure(error, 'request-rate');
    expect(failure.structuredContent).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfterSeconds: 2 } });
    expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_PROVIDER_DETAIL');
    const next = qbo.getTaxProfile();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ usingSalesTax: true });
    expect(starts).toHaveLength(2);
  });

  it('cools down reads after a rejected POST without retrying that write', async () => {
    const calls: Array<{ method: string; at: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', at: Date.now() });
      return init?.method === 'POST'
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : profile();
    }));
    const qbo = client();
    await expect(qbo.createTransfer({ amount: 12, fromAccountQboId: 'bank-a', toAccountQboId: 'bank-b', date: '2026-08-01' }))
      .rejects.toMatchObject({ code: 'QBO_RATE_LIMITED', retryAfterSeconds: 2 });
    const reading = qbo.getTaxProfile();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.map((call) => call.method)).toEqual(['POST']);
    await vi.advanceTimersByTimeAsync(1);
    await reading;
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(calls[1]!.at - calls[0]!.at).toBe(2_000);
  });

  it('releases the current GET turn before refreshing a 401 and queues its retry without deadlock', async () => {
    const calls: Array<{ method: string; at: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', at: Date.now() });
      if (calls.length === 1) return new Response('', { status: 401 });
      if (init?.method === 'POST') return new Response(JSON.stringify({
        access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refreshed-refresh', expires_in: 3600,
      }));
      return profile();
    }));
    const reading = client().getTaxProfile();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(reading).resolves.toMatchObject({ usingSalesTax: true });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[2]!.at - calls[0]!.at).toBe(500);
  });

  it('extends an already waiting GET when a concurrent POST receives a new cooldown', async () => {
    const calls: Array<{ method: string; at: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', at: Date.now() });
      return init?.method === 'POST'
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : profile();
    }));
    const qbo = client();
    await qbo.getTaxProfile();
    const queued = qbo.getTaxProfile();
    await vi.advanceTimersByTimeAsync(100);
    await expect(qbo.createTransfer({ amount: 12, fromAccountQboId: 'bank-a', toAccountQboId: 'bank-b', date: '2026-08-01' }))
      .rejects.toMatchObject({ code: 'QBO_RATE_LIMITED' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toMatchObject({ usingSalesTax: true });
    expect(calls[2]!.at - calls[0]!.at).toBe(2_100);
  });
});
