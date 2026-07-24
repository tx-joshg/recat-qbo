import { randomUUID } from 'node:crypto';
import { RealQboClient } from '../src/lib/qbo/real.js';
import { verifyPurchaseRestore, verifyPurchaseResult } from '../src/services/tax/verify.js';
import type { TaxCalculation } from '@recat/shared';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.env.QBO_TAX_SANDBOX_TEST !== 'true') {
  throw new Error('Refusing to run: QBO_TAX_SANDBOX_TEST must equal true.');
}
if (process.env.QBO_ENVIRONMENT !== 'sandbox') {
  throw new Error('Refusing to run: QBO_ENVIRONMENT must equal sandbox.');
}

const realmId = required('QBO_TAX_SANDBOX_REALM_ID');
const allowlist = new Set(
  required('QBO_TAX_SANDBOX_REALM_ALLOWLIST')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
if (!allowlist.has(realmId)) {
  throw new Error(`Refusing to run: realm ${realmId} is not in QBO_TAX_SANDBOX_REALM_ALLOWLIST.`);
}

const fixtureId = required('QBO_TAX_SANDBOX_PURCHASE_ID');
const holdingAccountQboId = required('QBO_TAX_SANDBOX_HOLDING_ACCOUNT_ID');
const categoryAccountQboId = required('QBO_TAX_SANDBOX_CATEGORY_ACCOUNT_ID');
const taxCodeQboId = required('QBO_TAX_SANDBOX_TAX_CODE_ID');
const taxCalculation = required('QBO_TAX_SANDBOX_TAX_CALCULATION') as TaxCalculation;
if (!['TaxInclusive', 'TaxExcluded', 'NotApplicable'].includes(taxCalculation)) {
  throw new Error('QBO_TAX_SANDBOX_TAX_CALCULATION is invalid.');
}

const client = new RealQboClient({
  realmId,
  environment: 'sandbox',
  clientId: required('QBO_CLIENT_ID'),
  clientSecret: required('QBO_CLIENT_SECRET'),
  tokens: {
    accessToken: required('QBO_TAX_SANDBOX_ACCESS_TOKEN'),
    refreshToken: required('QBO_TAX_SANDBOX_REFRESH_TOKEN'),
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
  holdingAccountQboIds: [holdingAccountQboId],
  // This harness is intentionally ephemeral. If Intuit rotates the token,
  // capture it in a secure operator workflow; never print or commit it here.
  onTokensRefreshed: async () => undefined,
});

const original = await client.fetchTxn('Purchase', fixtureId);
if (!original) throw new Error(`Sandbox fixture Purchase ${fixtureId} was not found.`);
const raw = original.raw as { PrivateNote?: string };
if (!raw.PrivateNote?.startsWith('[RECAT TAX SANDBOX]')) {
  throw new Error('Refusing to mutate: fixture PrivateNote must start with [RECAT TAX SANDBOX].');
}
if (!original.lines.some((line) => line.accountQboId === holdingAccountQboId)) {
  throw new Error('Refusing to mutate: fixture no longer posts to the allowlisted holding account.');
}

const postRequestId = randomUUID();
const post = await client.prepareRecategorization(
  original,
  {
    qboType: 'Purchase',
    signedTransactionAmount: original.amount,
    taxCalculation,
    outOfScopeTaxCodeQboId: taxCalculation === 'NotApplicable' ? taxCodeQboId : null,
    lines: [
      {
        grossAmount: original.amount,
        accountQboId: categoryAccountQboId,
        tax: { taxCodeQboId, taxCodeName: null },
      },
    ],
  },
  postRequestId,
);

let posted = false;
try {
  await client.executePreparedWrite(post);
  posted = true;
  const readBack = await client.fetchTxn('Purchase', fixtureId);
  if (!readBack || post.operation !== 'recategorize') throw new Error('Post read-back unavailable.');
  const verification = verifyPurchaseResult(post.expected, readBack);
  if (!verification.ok) throw new Error(`${verification.code}: ${verification.message}`);

  const undo = await client.preparePurchaseRestore(readBack, post.before, randomUUID());
  await client.executePreparedWrite(undo);
  posted = false;
  const restored = await client.fetchTxn('Purchase', fixtureId);
  if (!restored || undo.operation !== 'restore') throw new Error('Undo read-back unavailable.');
  const restoreVerification = verifyPurchaseRestore(undo.expected, restored);
  if (!restoreVerification.ok) {
    throw new Error(`${restoreVerification.code}: ${restoreVerification.message}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      realmId,
      fixtureId,
      taxCalculation,
      postVerified: true,
      undoVerified: true,
    })}\n`,
  );
} finally {
  if (posted) {
    process.stderr.write(
      `Sandbox fixture ${fixtureId} may still contain the test write; restore it from the dedicated fixture backup before reuse.\n`,
    );
  }
}
