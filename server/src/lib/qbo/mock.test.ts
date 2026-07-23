// The mock client must mirror the real client's multi-line semantics (C1):
// reads expose only holding lines (amount = holding sum), writes replace only
// holding lines, and undo pulls back only the previously written category
// lines — the whole write-back/undo path is exercised against it in tests and
// demo mode, so its arithmetic has to match production.

import { beforeEach, describe, expect, it } from 'vitest';
import { getMockRealm, MockQboClient, MOCK_REALM_HARBOR, resetMockRealms } from './mock.js';
import type { RawPurchase } from './real.js';
import { canonicalHash, canonicalPurchaseAccountingState } from './purchaseTax.js';
import { verifyPurchaseRestore, verifyPurchaseResult } from '../../services/tax/verify.js';

const HOLDING_IDS = ['4', '5']; // Harbor: Ask My Accountant + Uncategorized Expense

function client(): MockQboClient {
  return new MockQboClient(MOCK_REALM_HARBOR, HOLDING_IDS);
}

/** Turn the SYSCO purchase (id 2, -486.12 in holding) into a two-line entity. */
function addCategorizedLine(): void {
  const realm = getMockRealm(MOCK_REALM_HARBOR);
  const entity = realm.txns.find((t) => t.qboId === '2' && t.qboType === 'Purchase');
  if (!entity) throw new Error('seed txn missing');
  entity.lines.push({ id: '2', amount: 50, accountQboId: '10' }); // Food purchases, already categorized
  entity.amount = -536.12;
}

beforeEach(() => {
  resetMockRealms();
});

describe('MockQboClient multi-line entity safety', () => {
  it('provides purchase tax reference fixtures', async () => {
    const c = client();
    const [profile, codes, rates] = await Promise.all([c.getTaxProfile(), c.listTaxCodes(), c.listTaxRates()]);
    expect(profile.usingSalesTax).toBe(true);
    expect(codes.find((code) => code.name === 'Out of Scope')).toMatchObject({
      active: true,
      taxable: false,
    });
    expect(codes.find((code) => code.qboId === 'tax-sales-only')?.purchaseTaxRateList).toEqual([]);
    expect(rates.find((rate) => rate.qboId === 'tax-rate-hst-13')?.rateValue).toBe(13);
  });

  it('provides a sales-tax-disabled demo company for needs_setup coverage', async () => {
    const bluebird = new MockQboClient('4471889011230002', ['3']);
    expect((await bluebird.getTaxProfile()).usingSalesTax).toBe(false);
  });

  it('fetchTxn exposes only holding lines with amount = holding sum', async () => {
    addCategorizedLine();
    const txn = await client().fetchTxn('Purchase', '2');
    expect(txn).not.toBeNull();
    expect(txn?.amount).toBe(-486.12); // NOT the -536.12 entity total
    expect(txn?.lines).toHaveLength(1);
    expect(txn?.lines[0]).toMatchObject({ accountQboId: '4', amount: 486.12 });
  });

  it('recategorize replaces only the holding line; the categorized line and total survive', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');

    await c.recategorize(txn, [
      { amount: -400, accountQboId: '10' },
      { amount: -86.12, accountQboId: '12' },
    ]);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // The pre-existing $50 categorized line survived verbatim.
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    // No holding lines remain; the splits are present.
    expect(entity.lines.some((l) => HOLDING_IDS.includes(l.accountQboId))).toBe(false);
    // Entity total unchanged: 50 + 400 + 86.12.
    const total = entity.lines.reduce((a, l) => a + l.amount, 0);
    expect(total).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount pulls back only the previously posted category lines (undo)', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await c.recategorize(txn, [{ amount: -486.12, accountQboId: '17' }]); // Meals & entertainment

    const posted = await c.fetchTxn('Purchase', '2');
    if (!posted) throw new Error('missing posted txn');
    await c.moveToAccount(posted, '4', ['17']);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // Back in holding at the original amount; the $50 categorized line intact.
    expect(entity.lines.filter((l) => l.accountQboId === '4' && l.amount === 486.12)).toHaveLength(1);
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    expect(entity.lines.some((l) => l.accountQboId === '17')).toBe(false);
    expect(entity.lines.reduce((a, l) => a + l.amount, 0)).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount fails loudly when no lines post to the given categories', async () => {
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await expect(c.moveToAccount(txn, '4', ['17'])).rejects.toThrow(/no lines posting/);
  });

  it('listTxnsInAccounts filters lines by the ids given (wizard candidate probing)', async () => {
    addCategorizedLine();
    const txns = await client().listTxnsInAccounts(['10']); // probe a non-holding account
    const sysco = txns.find((t) => t.qboId === '2');
    expect(sysco?.lines).toHaveLength(1);
    expect(sysco?.lines[0]?.accountQboId).toBe('10');
    expect(sysco?.amount).toBe(-50);
  });

  it('round-trips category and tax through a verified post and exact undo', async () => {
    const c = client();
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    const entity = realm.txns.find((txn) => txn.qboId === '2' && txn.qboType === 'Purchase');
    if (!entity) throw new Error('seed txn missing');
    entity.lines[0]!.taxCodeQboId = 'tax-out-of-scope';
    entity.taxCalculation = 'NotApplicable';
    entity.totalTax = 0;

    const original = await c.fetchTxn('Purchase', '2');
    if (!original) throw new Error('missing original');
    const originalRaw = structuredClone(original.raw as RawPurchase);
    const post = await c.prepareRecategorization(
      original,
      {
        qboType: 'Purchase',
        signedTransactionAmount: -486.12,
        taxCalculation: 'TaxInclusive',
        lines: [
          {
            grossAmount: -400,
            accountQboId: '10',
            tax: { taxCodeQboId: 'tax-gst-5', taxCodeName: 'GST 5%' },
          },
          {
            grossAmount: -86.12,
            accountQboId: '12',
            tax: { taxCodeQboId: 'tax-out-of-scope', taxCodeName: 'Out of Scope' },
          },
        ],
      },
      'post-request',
    );
    await c.executePreparedWrite(post);
    const posted = await c.fetchTxn('Purchase', '2');
    if (!posted || post.operation !== 'recategorize') throw new Error('missing post');
    expect(verifyPurchaseResult(post.expected, posted).ok).toBe(true);

    const undo = await c.preparePurchaseRestore(posted, originalRaw, 'undo-request');
    await c.executePreparedWrite(undo);
    const restored = await c.fetchTxn('Purchase', '2');
    if (!restored || undo.operation !== 'restore') throw new Error('missing restore');
    expect(verifyPurchaseRestore(undo.expected, restored).ok).toBe(true);
    expect(canonicalHash(canonicalPurchaseAccountingState(restored.raw as RawPurchase))).toBe(
      canonicalHash(canonicalPurchaseAccountingState(originalRaw)),
    );
  });
});
