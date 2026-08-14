/**
 * READ-ONLY probe for issue #44: is this company's sales tax inclusive?
 *
 * Answers the gating question before any write is attempted — a TaxExclusive
 * company simply cannot exercise the assumption the issue is about. Makes only
 * GET requests; nothing here mutates QuickBooks.
 *
 *   npm run probe-tax
 *
 * Reads the most recently connected non-demo company and its stored tokens, so
 * the app must already have that company connected.
 */
import { MOCK_REALM_IDS } from '@recat/shared';
import { env } from '../env.js';
import { decrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

const BASE =
  env.QBO_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const basic = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function get<T>(realmId: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}/v3/company/${realmId}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const q = (s: string) => `/query?query=${encodeURIComponent(s)}`;

async function main(): Promise<void> {
  const company = await prisma.company.findFirst({
    where: { realmId: { notIn: [...MOCK_REALM_IDS] }, disconnectedAt: null },
    orderBy: { connectedAt: 'desc' },
  });
  if (!company?.refreshToken) throw new Error('no connected real company with tokens');

  const token = await refreshAccessToken(decrypt(company.refreshToken));
  const realmId = company.realmId;
  console.log(`company : ${company.legalName} (${realmId})`);
  console.log(`env     : ${env.QBO_ENVIRONMENT}\n`);

  const info = await get<{ CompanyInfo?: Record<string, unknown> }>(
    realmId,
    token,
    `/companyinfo/${realmId}`,
  );
  const ci = info.CompanyInfo ?? {};
  console.log('--- CompanyInfo ---');
  console.log('country            :', ci.Country ?? '(none)');
  console.log('legal name         :', ci.LegalName ?? ci.CompanyName);

  const prefs = await get<{ Preferences?: { TaxPrefs?: Record<string, unknown> } }>(
    realmId,
    token,
    '/preferences',
  );
  const tax = prefs.Preferences?.TaxPrefs ?? {};
  console.log('\n--- Preferences.TaxPrefs ---');
  console.log(JSON.stringify(tax, null, 2));

  // GlobalTaxCalculation is per transaction, so read what this company actually
  // stamps on its own records rather than inferring it from locale.
  for (const type of ['Deposit', 'Purchase']) {
    const rows = await get<{ QueryResponse?: Record<string, Array<Record<string, unknown>>> }>(
      realmId,
      token,
      q(`select * from ${type} maxresults 10`),
    );
    const list = rows.QueryResponse?.[type] ?? [];
    const seen = new Map<string, number>();
    for (const r of list) {
      const g = String(r.GlobalTaxCalculation ?? '(absent)');
      seen.set(g, (seen.get(g) ?? 0) + 1);
    }
    console.log(`\n--- ${type}: GlobalTaxCalculation across ${list.length} record(s) ---`);
    console.log(seen.size === 0 ? '  (no records)' : [...seen].map(([k, v]) => `  ${k}: ${v}`).join('\n'));
  }

  const codes = await get<{ QueryResponse?: { TaxCode?: Array<Record<string, unknown>> } }>(
    realmId,
    token,
    q('select * from TaxCode maxresults 20'),
  );
  const list = codes.QueryResponse?.TaxCode ?? [];
  console.log(`\n--- TaxCodes (${list.length}) ---`);
  for (const c of list.slice(0, 10)) {
    console.log(`  ${String(c.Id).padEnd(6)} ${String(c.Name).padEnd(28)} active=${c.Active} purchase=${c.Taxable}`);
  }
}

main()
  .catch((e: unknown) => {
    console.error('\nPROBE FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
