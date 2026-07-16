// qboFactory — picks the real Intuit client or the in-memory mock based on
// env.QBO_MOCK, and owns token persistence for connected companies.
//
// Cross-agent modules (lib/crypto, services/instanceSettings) are imported
// lazily so mock mode (and the demo seed) can run before they exist.

import type { QboClient, QboClientFactory, QboTokenSet } from './types.js';
import { env, redirectUri } from '../../env.js';
import { prisma } from '../prisma.js';
import { QboAuthError } from './types.js';
import {
  RealQboClient,
  exchangeAuthCode,
  intuitAuthorizeUrl,
  revokeIntuitToken,
  type QboEnvironment,
} from './real.js';
import { MockQboClient, mockAuthorizeUrl, mockTokenSet } from './mock.js';

interface IntuitCreds {
  clientId: string;
  clientSecret: string;
}

// authorizeUrl() is synchronous (per QboClientFactory) but wizard-entered
// credentials live in the DB. We keep a cache seeded from env vars (which take
// precedence anyway) and refresh it in the background on module load and on
// every factory call that can await.
let cachedCreds: IntuitCreds = { clientId: env.QBO_CLIENT_ID, clientSecret: env.QBO_CLIENT_SECRET };

async function refreshCreds(): Promise<IntuitCreds> {
  try {
    const { getInstanceSettings } = await import('../../services/instanceSettings.js');
    const s = await getInstanceSettings();
    cachedCreds = {
      clientId: env.QBO_CLIENT_ID || s.intuitClientId || '',
      clientSecret: env.QBO_CLIENT_SECRET || s.intuitClientSecret || '',
    };
  } catch {
    // instance settings unavailable (first boot, DB down) — keep env values
  }
  return cachedCreds;
}

if (!env.QBO_MOCK) void refreshCreds();

async function loadCompany(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);
  if (company.disconnectedAt) throw new QboAuthError(`Company "${company.nickname}" is disconnected from QuickBooks`);
  return company;
}

function holdingIdsOf(company: { holdingAccountIds: unknown }): string[] {
  const v = company.holdingAccountIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ---------------------------------------------------------------------------

const realFactory: QboClientFactory = {
  authorizeUrl(state: string): string {
    // Kick a background refresh so the *next* call sees wizard-entered creds;
    // env-configured deployments are always correct on the first call.
    void refreshCreds();
    return intuitAuthorizeUrl({ clientId: cachedCreds.clientId, redirectUri, state });
  },

  async exchangeCode(code: string): Promise<QboTokenSet> {
    const creds = await refreshCreds();
    return exchangeAuthCode({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri, code });
  },

  async forCompany(companyId: string): Promise<QboClient> {
    const company = await loadCompany(companyId);
    if (!company.accessToken || !company.refreshToken) {
      throw new QboAuthError(`Company "${company.nickname}" has no QuickBooks tokens — reconnect required`);
    }
    const creds = await refreshCreds();
    const { decrypt, encrypt } = await import('../crypto.js');
    const tokens: QboTokenSet = {
      accessToken: decrypt(company.accessToken),
      refreshToken: decrypt(company.refreshToken),
      expiresAt: company.tokenExpiresAt?.getTime() ?? 0,
    };
    return new RealQboClient({
      realmId: company.realmId,
      environment: company.env as QboEnvironment,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      holdingAccountQboIds: holdingIdsOf(company),
      tokens,
      // Refresh tokens rotate on use — persist the new set immediately.
      onTokensRefreshed: async (t) => {
        await prisma.company.update({
          where: { id: company.id },
          data: {
            accessToken: encrypt(t.accessToken),
            refreshToken: encrypt(t.refreshToken),
            tokenExpiresAt: new Date(t.expiresAt),
          },
        });
      },
    });
  },

  async revoke(companyId: string): Promise<void> {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company?.refreshToken) return;
    try {
      const creds = await refreshCreds();
      const { decrypt } = await import('../crypto.js');
      await revokeIntuitToken({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token: decrypt(company.refreshToken),
      });
    } catch {
      // best effort
    }
  },
};

// ---------------------------------------------------------------------------

const mockFactory: QboClientFactory = {
  authorizeUrl(state: string): string {
    return mockAuthorizeUrl(state);
  },

  async exchangeCode(): Promise<QboTokenSet> {
    // The mock ignores tokens entirely; the routes layer picks the realm via
    // resolveMockRealmId() from mock.ts.
    return mockTokenSet();
  },

  async forCompany(companyId: string): Promise<QboClient> {
    const company = await loadCompany(companyId);
    return new MockQboClient(company.realmId, holdingIdsOf(company));
  },

  async revoke(): Promise<void> {
    // nothing to revoke in mock mode
  },
};

export const qboFactory: QboClientFactory = env.QBO_MOCK ? mockFactory : realFactory;
