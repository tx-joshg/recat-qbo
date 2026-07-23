import { describe, expect, it } from 'vitest';
import type { QboTaxCodeInfo, QboTaxRateInfo, QboTxn } from './types.js';
import type { RawPurchase } from './real.js';
import {
  buildPurchaseRecategorization,
  calculatePurchaseLine,
  canonicalHash,
  type QboPurchaseTaxReference,
} from './purchaseTax.js';
import type { QboRecategorizationPlan } from '../../services/tax/model.js';

const codes: QboTaxCodeInfo[] = [
  {
    qboId: 'gst',
    name: 'GST 5%',
    active: true,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r5', taxTypeApplicable: 'TaxOnAmount' }],
    salesTaxRateList: [],
    raw: {},
  },
  {
    qboId: 'hst',
    name: 'HST 13%',
    active: true,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r13' }],
    salesTaxRateList: [],
    raw: {},
  },
  {
    qboId: 'oos',
    name: 'Out of Scope',
    active: true,
    taxable: false,
    purchaseTaxRateList: [],
    salesTaxRateList: [],
    raw: {},
  },
  {
    qboId: 'sales',
    name: 'Sales only',
    active: true,
    taxable: true,
    purchaseTaxRateList: [],
    salesTaxRateList: [{ taxRateQboId: 'r5' }],
    raw: {},
  },
  {
    qboId: 'compound',
    name: 'Compound',
    active: true,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r5' }, { taxRateQboId: 'r13', taxOnTaxOrder: 1 }],
    salesTaxRateList: [],
    raw: {},
  },
  {
    qboId: 'inactive',
    name: 'Inactive',
    active: false,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'r5' }],
    salesTaxRateList: [],
    raw: {},
  },
];
const rates: QboTaxRateInfo[] = [
  { qboId: 'r5', name: 'GST 5%', active: true, rateValue: 5, raw: {} },
  { qboId: 'r13', name: 'HST 13%', active: true, rateValue: 13, raw: {} },
];
const reference: QboPurchaseTaxReference = { taxCodes: codes, taxRates: rates };

function freshPurchase(credit = false): QboTxn {
  const raw: RawPurchase = {
    Id: 'purchase-1',
    SyncToken: '7',
    TxnDate: '2026-07-23',
    TotalAmt: 150,
    Credit: credit,
    AccountRef: { value: 'bank-1', name: 'Visa' },
    CurrencyRef: { value: 'CAD' },
    EntityRef: { value: 'vendor-1', name: 'Vendor' },
    PrivateNote: 'preserve me',
    GlobalTaxCalculation: 'TaxExcluded',
    TxnTaxDetail: { TotalTax: 2.38 },
    Line: [
      {
        Id: 'holding-line',
        Amount: 100,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding' }, TaxCodeRef: { value: 'oos' } },
      },
      {
        Id: 'unrelated',
        Amount: 50,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'do not touch',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'existing' },
          TaxCodeRef: { value: 'gst' },
          TaxInclusiveAmt: 50,
          BillableStatus: 'Billable',
          CustomerRef: { value: 'customer-1' },
        },
      },
    ],
  };
  return {
    qboId: raw.Id,
    qboType: 'Purchase',
    syncToken: raw.SyncToken,
    date: raw.TxnDate!,
    payee: 'Vendor',
    amount: credit ? 100 : -100,
    bankAccount: 'Visa',
    lines: [{ id: 'holding-line', amount: 100, accountQboId: 'holding', accountName: 'Holding' }],
    raw,
  };
}

function plan(
  taxCodeQboId = 'gst',
  taxCalculation: QboRecategorizationPlan['taxCalculation'] = 'TaxInclusive',
): QboRecategorizationPlan {
  return {
    qboType: 'Purchase',
    signedTransactionAmount: -100,
    taxCalculation,
    outOfScopeTaxCodeQboId: 'oos',
    lines: [{ grossAmount: -100, accountQboId: 'expense', tax: { taxCodeQboId, taxCodeName: null } }],
  };
}

describe('calculatePurchaseLine', () => {
  it.each([
    [100, 'gst', 9524, 476],
    [105, 'gst', 10000, 500],
    [113, 'hst', 10000, 1300],
  ] as const)('reconciles gross %s for %s in integer cents', (gross, code, netCents, taxCents) => {
    expect(calculatePurchaseLine(gross, 'TaxInclusive', code, reference)).toEqual({
      grossCents: gross * 100,
      netCents,
      taxCents,
    });
  });

  it('supports out-of-scope lines and credits without changing minor units', () => {
    expect(calculatePurchaseLine(-25.12, 'TaxInclusive', 'oos', reference)).toEqual({
      grossCents: 2512,
      netCents: 2512,
      taxCents: 0,
    });
  });

  it.each([
    ['sales', 'TAX_CODE_NOT_PURCHASE'],
    ['inactive', 'TAX_CODE_INACTIVE'],
    ['compound', 'TAX_RATE_UNSUPPORTED'],
  ])('fails closed for %s', (code, errorCode) => {
    expect(() => calculatePurchaseLine(100, 'TaxInclusive', code, reference)).toThrowError(
      expect.objectContaining({ code: errorCode }),
    );
  });

  it('fails when a referenced TaxRate is missing', () => {
    expect(() =>
      calculatePurchaseLine(100, 'TaxInclusive', 'gst', { taxCodes: codes, taxRates: [] }),
    ).toThrowError(expect.objectContaining({ code: 'TAX_RATE_UNKNOWN' }));
  });
});

describe('buildPurchaseRecategorization', () => {
  it('builds one literal payload while preserving unrelated lines and headers', () => {
    const fresh = freshPurchase();
    const raw = fresh.raw as RawPurchase;
    const untouched = raw.Line![1]!;
    const built = buildPurchaseRecategorization(fresh, new Set(['holding']), plan(), reference, 'request-1');

    expect(built).toMatchObject({ path: '/purchase', requestId: 'request-1' });
    expect(built.body.AccountRef).toEqual(raw.AccountRef);
    expect(built.body.EntityRef).toEqual(raw.EntityRef);
    expect(built.body.CurrencyRef).toEqual(raw.CurrencyRef);
    expect(built.body.TxnDate).toBe(raw.TxnDate);
    expect(built.body.PrivateNote).toBe(raw.PrivateNote);
    expect(built.body.GlobalTaxCalculation).toBe('TaxInclusive');
    expect(built.body.TxnTaxDetail).toBeUndefined();
    expect(canonicalHash(built.body.Line![0])).toBe(canonicalHash(untouched));
    expect(built.body.Line![1]).toMatchObject({
      Amount: 95.24,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'expense' },
        TaxCodeRef: { value: 'gst' },
        TaxInclusiveAmt: 100,
      },
    });
    expect(built.expected).toMatchObject({
      totalAmtCents: 15000,
      fundingAccountQboId: 'bank-1',
      currencyQboId: 'CAD',
      targetLines: [{ grossCents: 10000, netCents: 9524, taxCents: 476 }],
    });
  });

  it('handles same-rate and mixed out-of-scope splits with deterministic per-line rounding', () => {
    const splitPlan: QboRecategorizationPlan = {
      qboType: 'Purchase',
      signedTransactionAmount: -100,
      taxCalculation: 'TaxInclusive',
      outOfScopeTaxCodeQboId: 'oos',
      lines: [
        { grossAmount: -33.33, accountQboId: 'a', tax: { taxCodeQboId: 'gst', taxCodeName: null } },
        { grossAmount: -33.33, accountQboId: 'b', tax: { taxCodeQboId: 'gst', taxCodeName: null } },
        { grossAmount: -33.34, accountQboId: 'c', tax: { taxCodeQboId: 'oos', taxCodeName: null } },
      ],
    };
    const built = buildPurchaseRecategorization(
      freshPurchase(),
      new Set(['holding']),
      splitPlan,
      reference,
      'request-split',
    );
    expect(built.expected.targetLines.map((line) => line.grossCents)).toEqual([3333, 3333, 3334]);
    expect(built.expected.targetLines.reduce((sum, line) => sum + line.grossCents, 0)).toBe(10000);
    expect(built.expected.targetLines[2]).toMatchObject({ netCents: 3334, taxCents: 0 });
  });

  it('keeps refund direction in expected state', () => {
    const creditPlan = plan();
    creditPlan.signedTransactionAmount = 100;
    creditPlan.lines[0]!.grossAmount = 100;
    const built = buildPurchaseRecategorization(
      freshPurchase(true),
      new Set(['holding']),
      creditPlan,
      reference,
      'request-credit',
    );
    expect(built.expected.credit).toBe(true);
    expect(built.expected.totalAmtCents).toBe(15000);
  });
});
