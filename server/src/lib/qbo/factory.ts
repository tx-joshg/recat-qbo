// qboFactory — one factory that dispatches per company: MockQboClient when the
// company's realmId is one of the two built-in demo realms, RealQboClient
// otherwise. Demo vs real is a per-connection user choice (the connect flow's
// `mode`), never a boot-time env var. The factory also owns token persistence
// for connected companies.
//
// Cross-agent modules (lib/crypto, services/instanceSettings) are imported
// lazily so the demo seed can run before they exist.

import type { Company } from '@prisma/client';
import type { QboConnectionTestDto, QboPreflightDto } from '@recat/shared';
import type {
  QboClient,
  QboClientFactory,
  QboCompanyInfo,
  QboConnectMode,
  QboTokenSet,
} from './types.js';
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

/** Load the effective credentials now. Callers that need authoritative state
 * use this directly so a DB/decryption failure cannot fall back to stale cache. */
async function loadCurrentCreds(): Promise<IntuitCreds> {
  const { getInstanceSettings } = await import('../../services/instanceSettings.js');
  const settings = await getInstanceSettings();
  return {
    clientId: env.QBO_CLIENT_ID || settings.intuitClientId || '',
    clientSecret: env.QBO_CLIENT_SECRET || settings.intuitClientSecret || '',
  };
}

async function loadAndCacheCurrentCreds(): Promise<IntuitCreds> {
  cachedCreds = await loadCurrentCreds();
  return cachedCreds;
}

async function refreshCreds(): Promise<IntuitCreds> {
  try {
    await loadAndCacheCurrentCreds();
  } catch {
    // instance settings unavailable (first boot, DB down) — keep env values
  }
  return cachedCreds;
}

void refreshCreds();

/**
 * Revoke one captured encrypted refresh token without reloading the company.
 * Disconnect cleanup uses this so a concurrent reconnect can never cause the
 * newly issued token to be revoked by mistake.
 */
export async function revokeStoredQboRefreshToken(
  realmId: string,
  encryptedRefreshToken: string,
): Promise<void> {
  if (isMockRealmId(realmId)) return;
  try {
    const creds = await refreshCreds();
    const { decrypt } = await import('../crypto.js');
    await revokeIntuitToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      token: decrypt(encryptedRefreshToken),
    });
  } catch {
    // Revocation is best effort; local credential removal is the hard gate.
  }
}

/** Are Intuit app credentials configured (env vars or wizard-entered)? The
 * real connect flow requires them; demo connections never do. */
export async function hasIntuitCredentials(): Promise<boolean> {
  const creds = await loadAndCacheCurrentCreds();
  return creds.clientId !== '' && creds.clientSecret !== '';
}

export async function getIntuitCredentialPreflight(): Promise<QboPreflightDto> {
  const creds = await loadAndCacheCurrentCreds();
  const clientIdConfigured = creds.clientId !== '';
  const clientSecretConfigured = creds.clientSecret !== '';
  const selectedEnvironment = await prisma.appConfig.findUnique({
    where: { key: 'qboEnvDefault' },
  });
  const environment =
    selectedEnvironment?.value === 'sandbox' ||
    selectedEnvironment?.value === 'production'
      ? selectedEnvironment.value
      : env.QBO_ENVIRONMENT;
  return {
    ok: clientIdConfigured && clientSecretConfigured,
    clientIdConfigured,
    clientSecretConfigured,
    environment,
    redirectUri,
    requiresOAuth: true,
  };
}

async function loadCompany(companyId: string): Promise<Company> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);
  if (company.disconnectedAt) {
    throw new QboAuthError(
      `Company "${company.nickname}" is disconnected from QuickBooks`,
      'COMPANY_DISCONNECTED',
    );
  }
  return company;
}

function holdingIdsOf(company: { holdingAccountIds: unknown }): string[] {
  const v = company.holdingAccountIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function realClientForCompany(
  company: Company,
  creds: IntuitCreds,
): Promise<RealQboClient> {
  if (!company.accessToken || !company.refreshToken) {
    throw new QboAuthError(`Company "${company.nickname}" has no QuickBooks tokens — reconnect required`);
  }

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
    onTokensRefreshed: async (rotated) => {
      await prisma.company.update({
        where: { id: company.id },
        data: {
          accessToken: encrypt(rotated.accessToken),
          refreshToken: encrypt(rotated.refreshToken),
          tokenExpiresAt: new Date(rotated.expiresAt),
        },
      });
    },
  });
}

async function clientForCompany(company: Company): Promise<QboClient> {
  if (isMockRealmId(company.realmId)) {
    return new MockQboClient(company.realmId, holdingIdsOf(company));
  }

  return realClientForCompany(company, await refreshCreds());
}

export type StoredQboConnectionTest =
  | { kind: 'verified' }
  | { kind: 'demo' };

/**
 * Exercise the full stored Intuit connection for one company. Demo companies
 * are reported separately because an in-memory mock cannot verify Intuit
 * credentials. Credential loading is intentionally fail-closed.
 */
export async function testStoredQboConnection(
  companyId: string,
): Promise<StoredQboConnectionTest> {
  const company = await loadCompany(companyId);
  if (isMockRealmId(company.realmId)) return { kind: 'demo' };
  const client = await realClientForCompany(company, await loadCurrentCreds());
  await client.verifyConnection();
  return { kind: 'verified' };
}

export async function testCompanyConnection(companyId: string): Promise<QboConnectionTestDto> {
  const company = await loadCompany(companyId);
  const client = await clientForCompany(company);
  const info = await client.getCompanyInfo();
  return {
    ok: true,
    companyId: company.id,
    legalName: info.legalName,
    environment: company.env as QboConnectionTestDto['environment'],
    mode: isMockRealmId(company.realmId) ? 'demo' : 'quickbooks',
    checkedAt: new Date().toISOString(),
  };
}

export async function inspectAuthorizedConnection(args: {
  realmId: string;
  environment: QboEnvironment;
  mode: QboConnectMode;
  tokens: QboTokenSet;
}): Promise<{ info: QboCompanyInfo; tokens: QboTokenSet }> {
  if (args.mode === 'demo') {
    const client = new MockQboClient(args.realmId, []);
    return { info: await client.getCompanyInfo(), tokens: args.tokens };
  }

  const creds = await loadAndCacheCurrentCreds();
  let currentTokens = args.tokens;
  const client = new RealQboClient({
    realmId: args.realmId,
    environment: args.environment,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    holdingAccountQboIds: [],
    tokens: currentTokens,
    onTokensRefreshed: async (tokens) => {
      currentTokens = tokens;
    },
  });
  const info = await client.getCompanyInfo();
  return { info, tokens: currentTokens };
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
    const creds = await loadAndCacheCurrentCreds();
    return exchangeAuthCode({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri, code });
  },

  async forCompany(companyId: string): Promise<QboClient> {
    return clientForCompany(await loadCompany(companyId));
  },

  async revoke(companyId: string): Promise<void> {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company?.refreshToken) return;
    await revokeStoredQboRefreshToken(company.realmId, company.refreshToken);
  },
};
