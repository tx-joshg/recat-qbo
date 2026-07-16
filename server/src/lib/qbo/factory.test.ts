// qboFactory dispatch tests — the factory must pick MockQboClient for demo
// companies (mock realm ids) and RealQboClient for everything else, per
// company and independent of any env var. Connect-flow helpers must honor the
// per-request mode the same way.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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

import { isMockRealmId, qboFactory } from './factory.js';
import { MockQboClient, MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from './mock.js';
import { RealQboClient } from './real.js';
import { encrypt } from '../crypto.js';

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
  mocks.appConfig.findMany.mockResolvedValue([]);
  mocks.appConfig.findUnique.mockResolvedValue(null);
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
