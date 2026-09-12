import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  company: { findUnique: vi.fn(), updateMany: vi.fn() },
  appConfig: { findMany: vi.fn(), findUnique: vi.fn() },
}));
const credentialEnv = vi.hoisted(() => ({ clientId: '', clientSecret: '' }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../env.js')>();
  return { ...actual, env: { ...actual.env,
    get QBO_CLIENT_ID() { return credentialEnv.clientId; },
    get QBO_CLIENT_SECRET() { return credentialEnv.clientSecret; },
  } };
});

import { encrypt, decrypt } from '../crypto.js';
import { getIntuitCredentialPreflight, hasIntuitCredentials, testStoredQboConnection } from './factory.js';
import { MOCK_REALM_HARBOR } from './mock.js';
import { resetQboGetGatesForTest } from './real.js';
import { getInstanceSettings } from '../../services/instanceSettings.js';

const sourceCompany = () => ({
  id: 'diagnostic-company', realmId: 'synthetic-diagnostic-realm', env: 'sandbox',
  disconnectedAt: null, holdingAccountIds: [],
  accessToken: encrypt('synthetic-original-access'),
  refreshToken: encrypt('synthetic-original-refresh'),
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
});
const settingsRows = () => [
  { key: 'intuitClientId', value: 'synthetic-current-client', encrypted: false },
  { key: 'intuitClientSecret', value: encrypt('synthetic-current-secret'), encrypted: true },
];
const grant = () => new Response(JSON.stringify({
  access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', expires_in: 3600,
}), { status: 200 });
const info = () => new Response(JSON.stringify({ CompanyInfo: { LegalName: 'Synthetic diagnostic books' } }), { status: 200 });

beforeEach(() => {
  vi.resetAllMocks();
  credentialEnv.clientId = '';
  credentialEnv.clientSecret = '';
  resetQboGetGatesForTest();
  db.company.findUnique.mockResolvedValue(sourceCompany());
  db.company.updateMany.mockResolvedValue({ count: 1 });
  db.appConfig.findMany.mockResolvedValue(settingsRows());
  db.appConfig.findUnique.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('stored QuickBooks credential diagnostic', () => {
  it('refreshes unexpired access using current stored credentials and persists rotation before the read', async () => {
    const company = sourceCompany();
    db.company.findUnique.mockResolvedValue(company);
    let persisted = false;
    db.company.updateMany.mockImplementation(async ({ where, data }) => {
      expect(where).toEqual({ id: company.id, disconnectedAt: null,
        accessToken: company.accessToken, refreshToken: company.refreshToken });
      expect(decrypt(data.accessToken)).toBe('synthetic-rotated-access');
      expect(decrypt(data.refreshToken)).toBe('synthetic-rotated-refresh');
      persisted = true;
      return { count: 1 };
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/tokens/bearer')) {
        expect(init?.method).toBe('POST');
        expect(init?.body?.toString()).toContain('refresh_token=synthetic-original-refresh');
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          `Basic ${Buffer.from('synthetic-current-client:synthetic-current-secret').toString('base64')}`,
        );
        return grant();
      }
      expect(persisted).toBe(true);
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-rotated-access');
      return info();
    });
    vi.stubGlobal('fetch', fetch);
    await expect(testStoredQboConnection(company.id)).resolves.toEqual({ kind: 'verified' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/tokens/bearer');
    expect(String(fetch.mock.calls[1]?.[0])).toContain('/companyinfo/');
  });

  it.each(['database', 'decryption'] as const)('fails closed after a successful cache fill when current settings fail: %s', async (failure) => {
    await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({ ok: true });
    if (failure === 'database') db.appConfig.findMany.mockRejectedValue(new Error('synthetic-settings-failure'));
    else db.appConfig.findMany.mockResolvedValue([
      { key: 'intuitClientSecret', value: 'not-valid-ciphertext', encrypted: true },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(getIntuitCredentialPreflight()).rejects.toThrow();
    await expect(hasIntuitCredentials()).rejects.toThrow();
    await expect(testStoredQboConnection('diagnostic-company')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(db.company.updateMany).not.toHaveBeenCalled();
  });

  it('keeps ordinary settings readable so an administrator can replace an undecryptable secret', async () => {
    db.appConfig.findMany.mockResolvedValue([
      { key: 'intuitClientSecret', value: 'not-valid-ciphertext', encrypted: true },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(getInstanceSettings()).resolves.toMatchObject({ intuitClientSecret: '' });
    await expect(getIntuitCredentialPreflight()).rejects.toThrow('could not be decrypted');
  });

  it.each(['both', 'client ID', 'secret'] as const)('verifies the effective credential source when %s is environment-managed', async (managed) => {
    credentialEnv.clientId = managed === 'secret' ? '' : 'synthetic-env-client';
    credentialEnv.clientSecret = managed === 'client ID' ? '' : 'synthetic-env-secret';
    db.appConfig.findMany.mockResolvedValue(settingsRows().map((row) =>
      (row.key === 'intuitClientId' && credentialEnv.clientId !== '')
        || (row.key === 'intuitClientSecret' && credentialEnv.clientSecret !== '')
        ? { ...row, encrypted: true, value: 'obsolete-undecryptable-value' } : row));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/tokens/bearer')) {
        const expected = managed === 'both' ? 'synthetic-env-client:synthetic-env-secret'
          : managed === 'client ID' ? 'synthetic-env-client:synthetic-current-secret'
            : 'synthetic-current-client:synthetic-env-secret';
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from(expected).toString('base64')}`);
        return grant();
      }
      return info();
    });
    vi.stubGlobal('fetch', fetch);
    await expect(hasIntuitCredentials()).resolves.toBe(true);
    await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({ ok: true });
    await expect(testStoredQboConnection('diagnostic-company')).resolves.toEqual({ kind: 'verified' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['client ID', 'secret'] as const)('fails closed when the selected stored %s cannot decrypt even if the other field is environment-managed', async (stored) => {
    credentialEnv.clientId = stored === 'secret' ? 'synthetic-env-client' : '';
    credentialEnv.clientSecret = stored === 'client ID' ? 'synthetic-env-secret' : '';
    db.appConfig.findMany.mockResolvedValue([
      { key: stored === 'client ID' ? 'intuitClientId' : 'intuitClientSecret', encrypted: true, value: 'invalid-selected-ciphertext' },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(getIntuitCredentialPreflight()).rejects.toThrow('could not be decrypted');
    await expect(testStoredQboConnection('diagnostic-company')).rejects.toThrow('could not be decrypted');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('waits for token persistence to finish before using the rotated access token', async () => {
    let finish!: (result: { count: number }) => void;
    db.company.updateMany.mockReturnValue(new Promise<{ count: number }>((resolve) => { finish = resolve; }));
    const fetch = vi.fn().mockImplementation(async (url) => String(url).includes('/tokens/bearer') ? grant() : info());
    vi.stubGlobal('fetch', fetch);
    const checking = testStoredQboConnection('diagnostic-company');
    await vi.waitFor(() => expect(db.company.updateMany).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    finish({ count: 1 });
    await expect(checking).resolves.toEqual({ kind: 'verified' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['lost generation', 'persistence error'] as const)('does not read Company Info after %s', async (failure) => {
    if (failure === 'lost generation') db.company.updateMany.mockResolvedValue({ count: 0 });
    else db.company.updateMany.mockRejectedValue(new Error('synthetic-persistence-failure'));
    const fetch = vi.fn().mockImplementation(async () => grant());
    vi.stubGlobal('fetch', fetch);
    await expect(testStoredQboConnection('diagnostic-company')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/tokens/bearer');
  });

  it.each(['disconnect', 'reconnect'] as const)('cannot install its rotation after a concurrent %s with an identical plaintext token', async (transition) => {
    const current = sourceCompany();
    db.company.findUnique.mockImplementation(async () => ({ ...current }));
    db.company.updateMany.mockImplementation(async ({ where, data }) => {
      if (current.disconnectedAt !== null || current.accessToken !== where.accessToken
        || current.refreshToken !== where.refreshToken) return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    });
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const checking = testStoredQboConnection(current.id);
    const rejected = expect(checking).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (transition === 'disconnect') Object.assign(current, { disconnectedAt: new Date(), accessToken: null, refreshToken: null });
    else Object.assign(current, {
      accessToken: encrypt('synthetic-original-access'), refreshToken: encrypt('synthetic-original-refresh'),
    });
    const replacement = current.refreshToken;
    release(grant());
    await rejected;
    expect(current.refreshToken).toBe(replacement);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not represent a demo as verified Intuit credentials', async () => {
    db.company.findUnique.mockResolvedValue({ ...sourceCompany(), realmId: MOCK_REALM_HARBOR });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(testStoredQboConnection('diagnostic-company')).resolves.toEqual({ kind: 'demo' });
    expect(fetch).not.toHaveBeenCalled();
    expect(db.company.updateMany).not.toHaveBeenCalled();
  });

  it('stops before refresh when the company is disconnected', async () => {
    db.company.findUnique.mockResolvedValue({ ...sourceCompany(), disconnectedAt: new Date() });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(testStoredQboConnection('diagnostic-company')).rejects.toMatchObject({ reason: 'COMPANY_DISCONNECTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to Company Info after a rejected refresh', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_client', error_description: 'synthetic-sensitive-provider-detail',
    }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    await expect(testStoredQboConnection('diagnostic-company')).rejects.toMatchObject({ reason: 'INVALID_CLIENT_CREDENTIALS' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.company.updateMany).not.toHaveBeenCalled();
  });
});
