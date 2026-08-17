/**
 * READ-ONLY probe for issue #44: can this company express tax-inclusive entry?
 *
 * Answers the gating question before any write is attempted — a company that
 * cannot produce a TaxInclusive transaction cannot exercise the assumption the
 * issue is about, and finding that out after connecting an app and migrating a
 * database is the expensive way to learn it.
 *
 *   npm run probe-tax
 *
 * Goes through qboFactory, deliberately. An earlier version refreshed the OAuth
 * token itself and dropped the rotated refresh token Intuit returns, which can
 * strand the connection once the prior-token grace period lapses. The factory
 * persists the whole rotated set, resolves credentials whether they came from
 * env vars or the setup wizard, and talks to the environment the company was
 * actually connected against rather than a process-level default.
 */
import { MOCK_REALM_IDS } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { qboFactory } from '../lib/qbo/factory.js';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function main(): Promise<void> {
  const company = await prisma.company.findFirst({
    where: { realmId: { notIn: [...MOCK_REALM_IDS] }, disconnectedAt: null },
    orderBy: { connectedAt: 'desc' },
    select: { id: true, realmId: true, legalName: true, env: true },
  });
  if (!company) throw new Error('no connected real company — connect one first');

  const client = await qboFactory.forCompany(company.id);
  const [info, taxProfile, taxCodes] = await Promise.all([
    client.getCompanyInfo(),
    client.getTaxProfile(),
    client.listTaxCodes(),
  ]);

  console.log(`\ncompany: ${info.legalName} (${company.realmId})`);
  line('environment', company.env);

  console.log('\n--- company ---');
  line('country', info.country ?? '(not reported)');

  console.log('\n--- tax profile ---');
  line('usingSalesTax', taxProfile.usingSalesTax ?? '(not reported)');
  line('partnerTaxEnabled', taxProfile.partnerTaxEnabled ?? '(not reported)');

  // Every code, not a sample: the relevant purchase or custom code is often not
  // the first one QuickBooks returns, and a truncated list reads as though the
  // configuration is missing when it was fetched all along.
  console.log(`\n--- tax codes (${taxCodes.length}) ---`);
  if (taxCodes.length === 0) console.log('  (none)');
  for (const c of taxCodes) {
    // Purchase applicability comes from the purchase rate list. `taxable` is the
    // general flag and is true for sales-only codes too, so reporting it here
    // would misclassify exactly the codes this probe exists to inspect.
    const applies = c.purchaseRates.length > 0 ? 'purchase' : c.salesRates.length > 0 ? 'sales-only' : 'none';
    line(`${c.qboId} ${c.name}`, `active=${c.active} applies=${applies}`);
  }

  // The verdict, and the reason it is a verdict rather than a sample.
  //
  // GlobalTaxCalculation is stamped per transaction, so no number of
  // transactions read can prove a company will never carry it — absence in a
  // sample is not evidence of absence. Country can: Intuit documents the field
  // as valid only for non-US companies, and US companies use Automated Sales
  // Tax instead, which has no inclusive mode to select.
  console.log('\n--- verdict for #44 ---');
  const country = (info.country ?? '').toUpperCase();
  if (country === 'US') {
    console.log('  NOT TESTABLE — a US company cannot produce a TaxInclusive transaction.');
    console.log('  GlobalTaxCalculation is documented as non-US only, and US companies use');
    console.log('  Automated Sales Tax, which has no inclusive mode. Use a UK, AU or CA');
    console.log('  sandbox instead (choose the country when creating it).');
  } else if (country === '') {
    console.log('  UNKNOWN — QuickBooks did not report a country for this company.');
    console.log('  Check the locale in QuickBooks before spending setup effort on it.');
  } else {
    console.log(`  LIKELY TESTABLE — ${country} is a non-US locale, which is where`);
    console.log('  GlobalTaxCalculation applies. Confirm the company is set to tax-inclusive');
    console.log('  entry, then run the #44 test: categorize a deposit whose holding line is');
    console.log('  gross (e.g. 107.00) and check TotalAmt is unchanged and TotalTax is 7.00.');
  }
  console.log();
}

main()
  .catch((e: unknown) => {
    console.error('\nPROBE FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
