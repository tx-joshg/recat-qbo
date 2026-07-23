// qboFactory dispatch tests — the factory must pick MockQboClient for demo
// companies (mock realm ids) and RealQboClient for everything else, per
// company and independent of any env var. Connect-flow helpers must honor the
// per-request mode the same way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    APP_URL: 'https://recat.example',
    ENCRYPTION_KEY: '0'.repeat(64),
    QBO_CLIENT_ID: 'configured-client-id',
    QBO_CLIENT_SECRET: 'configured-client-secret',
    QBO_ENVIRONMENT: 'production' as 'sandbox' | 'production',
    QBO_WEBHOOK_VERIFIER_TOKEN: '',
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: 'Recat <noreply@example.com>',
  },
  company: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  appConfig: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock('../prisma.js', () => ({
  prisma: {
    company: mocks.company,
    appConfig: mocks.appConfig,
  },
}));

vi.mock('../../env.js', () => ({
  env: mocks.env,
  redirectUri: 'https://recat.example/auth/qbo/callback',
}));

import {
  getIntuitCredentialPreflight,
  inspectAuthorizedConnection,
  isMockRealmId,
  qboFactory,
  testCompanyConnection,
  testStoredQboConnection,
} from './factory.js';
import { MockQboClient, MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from './mock.js';
import { RealQboClient } from './real.js';
import { decrypt, encrypt } from '../crypto.js';
import { QboAuthError } from './types.js';

const REAL_REALM = '1234567890';

function companyRow(realmId: string) {
  return {
    id: 'c1',
    realmId,
    legalName: 'Test Co',
    nickname: 'Test',
    env: 'sandbox',
    holdingAccountIds: ['4'],
    disconnectedAt: null,
    accessToken: encrypt('access'),
    refreshToken: encrypt('refresh'),
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.QBO_CLIENT_ID = 'configured-client-id';
  mocks.env.QBO_CLIENT_SECRET = 'configured-client-secret';
  mocks.env.QBO_ENVIRONMENT = 'production';
  mocks.appConfig.findMany.mockResolvedValue([]);
  mocks.appConfig.findUnique.mockResolvedValue(null);
  mocks.company.update.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isMockRealmId', () => {
  it('recognizes both demo realms and nothing else', () => {
    expect(isMockRealmId(MOCK_REALM_HARBOR)).toBe(true);
    expect(isMockRealmId(MOCK_REALM_BLUEBIRD)).toBe(true);
    expect(isMockRealmId(REAL_REALM)).toBe(false);
    expect(isMockRealmId('')).toBe(false);
  });
});

describe('qboFactory.forCompany dispatch', () => {
  it('returns MockQboClient for a demo-realm company', async () => {
    mocks.company.findUnique.mockResolvedValue(companyRow(MOCK_REALM_HARBOR));
    const client = await qboFactory.forCompany('c1');
    expect(client).toBeInstanceOf(MockQboClient);
    expect(client.realmId).toBe(MOCK_REALM_HARBOR);
  });

  it('returns RealQboClient for a non-demo realm', async () => {
    mocks.company.findUnique.mockResolvedValue(companyRow(REAL_REALM));
    const client = await qboFactory.forCompany('c1');
    expect(client).toBeInstanceOf(RealQboClient);
    expect(client.realmId).toBe(REAL_REALM);
  });

  it('demo companies need no tokens; real companies without tokens fail loudly', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(MOCK_REALM_BLUEBIRD),
      accessToken: null,
      refreshToken: null,
    });
    await expect(qboFactory.forCompany('c1')).resolves.toBeInstanceOf(MockQboClient);

    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(REAL_REALM),
      accessToken: null,
      refreshToken: null,
    });
    await expect(qboFactory.forCompany('c1')).rejects.toThrow(/reconnect required/);
  });
});

describe('testStoredQboConnection', () => {
  it('distinguishes demos instead of treating the mock as Intuit verification', async () => {
    mocks.company.findUnique.mockResolvedValue(companyRow(MOCK_REALM_HARBOR));

    await expect(testStoredQboConnection('c1')).resolves.toEqual({ kind: 'demo' });
  });

  it('forces full credential verification for a real company', async () => {
    mocks.company.findUnique.mockResolvedValue(companyRow(REAL_REALM));
    const verify = vi
      .spyOn(RealQboClient.prototype, 'verifyConnection')
      .mockResolvedValue({ realmId: REAL_REALM, legalName: 'Test Co' });

    await expect(testStoredQboConnection('c1')).resolves.toEqual({ kind: 'verified' });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('fails closed when current credentials cannot be loaded', async () => {
    mocks.company.findUnique.mockResolvedValue(companyRow(REAL_REALM));
    mocks.appConfig.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    const verify = vi.spyOn(RealQboClient.prototype, 'verifyConnection');

    await expect(testStoredQboConnection('c1')).rejects.toThrow('database unavailable');
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('qboFactory connect helpers honor the per-request mode', () => {
  it('authorizeUrl(demo) is the fake consent page; authorizeUrl(real) is Intuit', () => {
    const demoUrl = qboFactory.authorizeUrl('state123', 'demo');
    expect(demoUrl).toBe('/auth/qbo/mock-consent?state=state123');

    const realUrl = qboFactory.authorizeUrl('state123', 'real');
    expect(realUrl).toContain('appcenter.intuit.com');
    expect(realUrl).toContain('state=state123');
  });

  it('exchangeCode(demo) returns the mock token set without any HTTP', async () => {
    const tokens = await qboFactory.exchangeCode('mock-harbor', MOCK_REALM_HARBOR, 'demo');
    expect(tokens.accessToken).toBe('mock-access-token');
    expect(tokens.refreshToken).toBe('mock-refresh-token');
  });
});

describe('getIntuitCredentialPreflight', () => {
  it('reports only credential presence and local OAuth configuration', async () => {
    const result = await getIntuitCredentialPreflight();

    expect(result).toEqual({
      ok: true,
      clientIdConfigured: true,
      clientSecretConfigured: true,
      environment: 'production',
      redirectUri: 'https://recat.example/auth/qbo/callback',
      requiresOAuth: true,
    });
    expect(JSON.stringify(result)).not.toContain('configured-client-id');
    expect(JSON.stringify(result)).not.toContain('configured-client-secret');
  });

  it('reports the valid environment selected in instance configuration', async () => {
    mocks.appConfig.findUnique.mockResolvedValue({
      key: 'qboEnvDefault',
      value: 'sandbox',
      encrypted: false,
    });

    await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({
      environment: 'sandbox',
    });
  });

  it.each([
    ['missing', null],
    [
      'invalid',
      {
        key: 'qboEnvDefault',
        value: 'not-a-qbo-environment',
        encrypted: false,
      },
    ],
  ])('falls back to the environment setting when AppConfig is %s', async (_case, row) => {
    mocks.appConfig.findUnique.mockResolvedValue(row);

    await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({
      environment: 'production',
    });
  });

  it('recognizes credentials stored in instance settings without exposing them', async () => {
    mocks.env.QBO_CLIENT_ID = '';
    mocks.env.QBO_CLIENT_SECRET = '';
    mocks.appConfig.findMany.mockResolvedValue([
      {
        key: 'intuitClientId',
        value: 'DB_CLIENT_ID_SENTINEL',
        encrypted: false,
      },
      {
        key: 'intuitClientSecret',
        value: encrypt('DB_CLIENT_SECRET_SENTINEL'),
        encrypted: true,
      },
    ]);

    const result = await getIntuitCredentialPreflight();

    expect(result).toMatchObject({
      ok: true,
      clientIdConfigured: true,
      clientSecretConfigured: true,
    });
    expect(JSON.stringify(result)).not.toContain('DB_CLIENT_ID_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('DB_CLIENT_SECRET_SENTINEL');
  });

  it('reports completely missing credentials without claiming readiness', async () => {
    mocks.env.QBO_CLIENT_ID = '';
    mocks.env.QBO_CLIENT_SECRET = '';

    await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({
      ok: false,
      clientIdConfigured: false,
      clientSecretConfigured: false,
    });
  });

  it('fails closed instead of reporting stale credential state when settings cannot load', async () => {
    mocks.appConfig.findMany.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(getIntuitCredentialPreflight()).rejects.toThrow('database unavailable');
  });

  it.each([
    {
      rows: [{ key: 'intuitClientId', value: 'only-id', encrypted: false }],
      clientIdConfigured: true,
      clientSecretConfigured: false,
    },
    {
      rows: [
        {
          key: 'intuitClientSecret',
          value: encrypt('only-secret'),
          encrypted: true,
        },
      ],
      clientIdConfigured: false,
      clientSecretConfigured: true,
    },
  ])(
    'reports partial credentials without claiming readiness',
    async ({ rows, clientIdConfigured, clientSecretConfigured }) => {
      mocks.env.QBO_CLIENT_ID = '';
      mocks.env.QBO_CLIENT_SECRET = '';
      mocks.appConfig.findMany.mockResolvedValue(rows);

      await expect(getIntuitCredentialPreflight()).resolves.toMatchObject({
        ok: false,
        clientIdConfigured,
        clientSecretConfigured,
      });
    },
  );
});

describe('testCompanyConnection', () => {
  it('uses a fresh token for one CompanyInfo call without a persistence write', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(REAL_REALM),
      id: 'company-1',
      env: 'production',
    });
    const getCompanyInfo = vi.spyOn(RealQboClient.prototype, 'getCompanyInfo');
    const listAccounts = vi.spyOn(RealQboClient.prototype, 'listAccounts');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          CompanyInfo: { LegalName: 'Example Books LLC' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await testCompanyConnection('company-1');

    expect(result).toMatchObject({
      ok: true,
      companyId: 'company-1',
      legalName: 'Example Books LLC',
      environment: 'production',
      mode: 'quickbooks',
    });
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
    expect(getCompanyInfo).toHaveBeenCalledTimes(1);
    expect(listAccounts).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/companyinfo/');
    expect(mocks.company.update).not.toHaveBeenCalled();
  });

  it('persists rotated tokens when an expired token refreshes before CompanyInfo', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(REAL_REALM),
      id: 'company-1',
      env: 'production',
      tokenExpiresAt: new Date(Date.now() - 1),
    });
    const getCompanyInfo = vi.spyOn(RealQboClient.prototype, 'getCompanyInfo');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            CompanyInfo: { LegalName: 'Example Books LLC' },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await testCompanyConnection('company-1');

    expect(getCompanyInfo).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/tokens/bearer');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/companyinfo/');
    expect(mocks.company.update).toHaveBeenCalledTimes(1);
    const data = mocks.company.update.mock.calls[0]?.[0].data;
    expect(decrypt(data.accessToken)).toBe('rotated-access');
    expect(decrypt(data.refreshToken)).toBe('rotated-refresh');
  });

  it('persists rotated tokens when CompanyInfo gets a 401 and retries', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(REAL_REALM),
      id: 'company-1',
      env: 'production',
    });
    const getCompanyInfo = vi.spyOn(RealQboClient.prototype, 'getCompanyInfo');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'retry-access',
            refresh_token: 'retry-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            CompanyInfo: { LegalName: 'Example Books LLC' },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await testCompanyConnection('company-1');

    expect(getCompanyInfo).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.company.update).toHaveBeenCalledTimes(1);
    const data = mocks.company.update.mock.calls[0]?.[0].data;
    expect(decrypt(data.accessToken)).toBe('retry-access');
    expect(decrypt(data.refreshToken)).toBe('retry-refresh');
  });

  it('keeps demo companies on the existing mock-client path', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(MOCK_REALM_HARBOR),
      id: 'company-1',
      accessToken: null,
      refreshToken: null,
    });

    await expect(testCompanyConnection('company-1')).resolves.toMatchObject({
      ok: true,
      companyId: 'company-1',
      mode: 'demo',
    });
  });

  it('rejects disconnected companies with a stable diagnostic reason', async () => {
    mocks.company.findUnique.mockResolvedValue({
      ...companyRow(REAL_REALM),
      id: 'company-1',
      disconnectedAt: new Date(),
    });

    await expect(testCompanyConnection('company-1')).rejects.toMatchObject<QboAuthError>({
      reason: 'COMPANY_DISCONNECTED',
    });
  });
});

describe('inspectAuthorizedConnection', () => {
  it('captures a rotated token locally while calling CompanyInfo once', async () => {
    const getCompanyInfo = vi.spyOn(RealQboClient.prototype, 'getCompanyInfo');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'inspection-access',
            refresh_token: 'inspection-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            CompanyInfo: { LegalName: 'Inspected Books LLC' },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await inspectAuthorizedConnection({
      realmId: REAL_REALM,
      environment: 'production',
      mode: 'real',
      tokens: {
        accessToken: 'exchanged-access',
        refreshToken: 'exchanged-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });

    expect(getCompanyInfo).toHaveBeenCalledTimes(1);
    expect(result.info.legalName).toBe('Inspected Books LLC');
    expect(result.tokens).toMatchObject({
      accessToken: 'inspection-access',
      refreshToken: 'inspection-refresh',
    });
    expect(mocks.company.update).not.toHaveBeenCalled();
  });
});
