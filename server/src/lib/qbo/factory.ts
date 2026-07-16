// qboFactory — one factory that dispatches per company: MockQboClient when the
// company's realmId is one of the two built-in demo realms, RealQboClient
// otherwise. Demo vs real is a per-connection user choice (the connect flow's
// `mode`), never a boot-time env var. The factory also owns token persistence
// for connected companies.
//
// Cross-agent modules (lib/crypto, services/instanceSettings) are imported
// lazily so the demo seed can run before they exist.

import type { QboClient, QboClientFactory, QboConnectMode, QboTokenSet } from './types.js';
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
import {
  MOCK_REALM_BLUEBIRD,
  MOCK_REALM_HARBOR,
  MockQboClient,
  mockAuthorizeUrl,
  mockTokenSet,
} from './mock.js';

/** Is this realm one of the built-in demo companies? */
export function isMockRealmId(realmId: string): boolean {
  return realmId === MOCK_REALM_HARBOR || realmId === MOCK_REALM_BLUEBIRD;
}

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

void refreshCreds();

/** Are Intuit app credentials configured (env vars or wizard-entered)? The
 * real connect flow requires them; demo connections never do. */
export async function hasIntuitCredentials(): Promise<boolean> {
  const creds = await refreshCreds();
  return creds.clientId !== '' && creds.clientSecret !== '';
}

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

export const qboFactory: QboClientFactory = {
  authorizeUrl(state: string, mode: QboConnectMode): string {
    if (mode === 'demo') return mockAuthorizeUrl(state);
    // Kick a background refresh so the *next* call sees wizard-entered creds;
    // env-configured deployments are always correct on the first call.
    void refreshCreds();
    return intuitAuthorizeUrl({ clientId: cachedCreds.clientId, redirectUri, state });
  },

  async exchangeCode(code: string, _realmId: string, mode: QboConnectMode): Promise<QboTokenSet> {
    if (mode === 'demo') {
      // The mock ignores tokens entirely; the routes layer picks the realm via
      // resolveMockRealmId() from mock.ts.
      return mockTokenSet();
    }
    const creds = await refreshCreds();
    return exchangeAuthCode({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri, code });
  },

  async forCompany(companyId: string): Promise<QboClient> {
    const company = await loadCompany(companyId);

    // Per-company dispatch: demo companies (mock realms) get the in-memory
    // fake QuickBooks; everything else talks to Intuit. Demo and real
    // companies coexist on the same instance.
    if (isMockRealmId(company.realmId)) {
      return new MockQboClient(company.realmId, holdingIdsOf(company));
    }

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
    if (isMockRealmId(company.realmId)) return; // nothing to revoke for demo companies
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
