import { describe, expect, it } from 'vitest';
import {
  QboPurchasePreparationError,
  PurchaseTaxError,
  calculatePurchaseLine,
  calculatePurchaseTransaction as calculatePurchaseTransactionRaw,
  calculateSalesTransaction as calculateSalesTransactionRaw,
  mapPurchaseTaxSnapshot,
  preparePurchaseRecategorization,
  preparePurchaseRestore,
  purchaseTargetLineMatches,
} from './purchaseTax.js';
import { QboSyncTokenConflict, type QboPurchaseSnapshot, type RawPurchase } from './types.js';
import type { StagedCategorization } from '@recat/shared';

const reference = {
  codes: [
    {
      qboId: 'GST5',
      name: 'GST 5%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'OOS',
      name: 'Out of scope',
      description: null,
      active: true,
      taxable: false,
      purchaseRates: [],
    },
    {
      qboId: 'OLD',
      name: 'Old GST',
      description: null,
      active: false,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'COMPOUND',
      name: 'GST and PST',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [
        { taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' },
        { taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' },
      ],
    },
    {
      qboId: 'SALES_ONLY',
      name: 'Sales only',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [],
    },
    {
      qboId: 'FULL',
      name: 'Full rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE100', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'FRACTIONAL',
      name: 'Fractional rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5_123456', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'HIGH',
      name: 'High rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE200', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'PST7',
      name: 'PST 7%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'VAT20',
      name: 'VAT 20%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE20', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'ZERO_CODE',
      name: 'Zero rate',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'ZERO', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'UNKNOWN_TAXABLE',
      name: 'Unknown taxable semantics',
      description: null,
      active: true,
      taxable: null,
      purchaseRates: [],
    },
    {
      qboId: 'CONTRADICTORY',
      name: 'Contradictory',
      description: null,
      active: true,
      taxable: false,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    },
    {
      qboId: 'WRONG_COMPONENT',
      name: 'Wrong component',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnTax' }],
    },
  ],
  rates: [
    { qboId: 'RATE5', name: 'GST 5%', description: null, active: true, rateValue: 5 },
    { qboId: 'RATE7', name: 'PST 7%', description: null, active: true, rateValue: 7 },
    { qboId: 'RATE20', name: 'VAT 20%', description: null, active: true, rateValue: 20 },
    { qboId: 'ZERO', name: 'Zero', description: null, active: true, rateValue: 0 },
    { qboId: 'RATE100', name: 'Full', description: null, active: true, rateValue: 100 },
    { qboId: 'RATE5_123456', name: 'Fractional', description: null, active: true, rateValue: 5.123456 },
    { qboId: 'RATE200', name: 'High', description: null, active: true, rateValue: 200 },
    { qboId: 'OLD_RATE', name: 'Old', description: null, active: false, rateValue: 5 },
  ],
};

describe('calculatePurchaseLine', () => {
  it.each([
    ['TaxExcluded', -10_00, -10_00, -50],
    ['TaxInclusive', -10_50, -10_00, -50],
    ['NotApplicable', -10_00, -10_00, 0],
  ] as const)('%s preserves signed gross accounting', (taxCalculation, grossCents, netCents, taxCents) => {
    expect(
      calculatePurchaseLine(
        {
          grossCents,
          taxCalculation,
          taxCodeQboId: taxCalculation === 'NotApplicable' ? 'OOS' : 'GST5',
        },
        reference,
      ),
    ).toEqual({ grossCents, netCents, taxCents });
  });

  it.each([
    [10, 1],
    [-10, -1],
  ])('rounds signed half-cent tax ties away from zero for %s cents', (grossCents, taxCents) => {
    expect(
      calculatePurchaseLine(
        { grossCents, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        reference,
      ),
    ).toEqual({ grossCents, netCents: grossCents, taxCents });
  });

  it.each([
    [1, 1, 0],
    [-1, -1, 0],
  ])('keeps inclusive small amounts balanced for signed gross %s', (grossCents, netCents, taxCents) => {
    const result = calculatePurchaseLine(
      { grossCents, taxCalculation: 'TaxInclusive', taxCodeQboId: 'FULL' },
      reference,
    );

    expect(result).toEqual({ grossCents, netCents, taxCents });
    expect(result.netCents + result.taxCents).toBe(result.grossCents);
  });

  it('preserves six-decimal tax-rate precision', () => {
    expect(
      calculatePurchaseLine(
        { grossCents: 1_000_000, taxCalculation: 'TaxExcluded', taxCodeQboId: 'FRACTIONAL' },
        reference,
      ),
    ).toEqual({ grossCents: 1_000_000, netCents: 1_000_000, taxCents: 51_235 });
  });

  it('supports an active zero rate', () => {
    const zeroRateReference = {
      ...reference,
      codes: [{ ...reference.codes[0], qboId: 'ZERO_CODE', purchaseRates: [{ taxRateQboId: 'ZERO', taxTypeApplicable: 'TaxOnAmount' }] }],
    };

    expect(
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxInclusive', taxCodeQboId: 'ZERO_CODE' },
        zeroRateReference,
      ),
    ).toEqual({ grossCents: -10_00, netCents: -10_00, taxCents: 0 });
  });

  it.each([
    ['missing code', 'MISSING', 'TaxExcluded', 'TAX_CODE_UNAVAILABLE'],
    ['inactive code', 'OLD', 'TaxExcluded', 'TAX_CODE_UNAVAILABLE'],
    ['compound rate', 'COMPOUND', 'TaxExcluded', 'TAX_RATE_UNSUPPORTED'],
    ['sales-only code', 'SALES_ONLY', 'TaxExcluded', 'TAX_RATE_UNSUPPORTED'],
    ['sales-only code marked not applicable', 'SALES_ONLY', 'NotApplicable', 'TAX_RATE_UNSUPPORTED'],
  ] as const)('fails closed for %s', (_name, taxCodeQboId, taxCalculation, code) => {
    expect(() =>
      calculatePurchaseLine({ grossCents: -10_00, taxCalculation, taxCodeQboId }, reference),
    ).toThrowError(new PurchaseTaxError(code));
  });

  it('fails closed for a missing or inactive rate', () => {
    expect(() =>
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        { ...reference, rates: [] },
      ),
    ).toThrowError(new PurchaseTaxError('TAX_RATE_UNAVAILABLE'));

    expect(() =>
      calculatePurchaseLine(
        { grossCents: -10_00, taxCalculation: 'TaxExcluded', taxCodeQboId: 'GST5' },
        { ...reference, rates: [{ qboId: 'RATE5', name: 'Old', description: null, active: false, rateValue: 5 }] },
      ),
    ).toThrowError(new PurchaseTaxError('TAX_RATE_UNAVAILABLE'));
  });

  it('rejects calculated cents outside the safe integer range', () => {
    expect(() =>
      calculatePurchaseLine(
        { grossCents: Number.MAX_SAFE_INTEGER, taxCalculation: 'TaxExcluded', taxCodeQboId: 'HIGH' },
        reference,
      ),
    ).toThrowError(new PurchaseTaxError('TAX_AMOUNT_INVALID'));
  });
});

describe('calculatePurchaseTransaction', () => {
  const companyId = 'company-1';
  const calculatePurchaseTransaction = (
    input: Omit<Parameters<typeof calculatePurchaseTransactionRaw>[0], 'companyId'>,
    scopedReference = reference,
  ) =>
    calculatePurchaseTransactionRaw(
      { ...input, companyId } as Parameters<typeof calculatePurchaseTransactionRaw>[0],
      { ...scopedReference, companyId } as Parameters<typeof calculatePurchaseTransactionRaw>[1],
    );

  it.each([
    ['purchase', -1, [-1, 0]],
    ['refund', 1, [1, 0]],
  ] as const)('rounds two excluded 5%% lines once for a %s', (_direction, taxCents, lineTaxes) => {
    const sign = taxCents < 0 ? -1 : 1;

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: sign * 10, taxCodeQboId: 'GST5' },
            { grossCents: sign * 10, taxCodeQboId: 'GST5' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      grossCents: sign * 20,
      netCents: sign * 20,
      taxCents,
      lines: [
        { taxCents: lineTaxes[0], treatment: 'standard' },
        { taxCents: lineTaxes[1], treatment: 'standard' },
      ],
    });
  });

  it('aggregates excluded lines independently for each supported rate component', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
            { grossCents: -2_000, taxCodeQboId: 'PST7' },
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: -240,
      lines: [{ taxCents: -50 }, { taxCents: -140 }, { taxCents: -50 }],
    });
  });

  it('back-calculates and balances inclusive tax per line', () => {
    const result = calculatePurchaseTransaction(
      {
        taxCalculation: 'TaxInclusive',
        lines: Array.from({ length: 5 }, () => ({ grossCents: -400, taxCodeQboId: 'VAT20' })),
      },
      reference,
    );

    expect(result).toMatchObject({
      eligible: true,
      grossCents: -2_000,
      netCents: -1_665,
      taxCents: -335,
      lines: Array.from({ length: 5 }, () => ({
        grossCents: -400,
        netCents: -333,
        taxCents: -67,
      })),
    });
    if (result.eligible) {
      expect(result.lines.every((line) => line.grossCents === line.netCents + line.taxCents)).toBe(true);
    }
  });

  it('distinguishes a proven zero rate from explicit exempt and out-of-scope input', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'ZERO_CODE' }],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: 0,
      lines: [{ treatment: 'zero_rated' }],
    });

    for (const nonTaxTreatment of ['exempt', 'out_of_scope'] as const) {
      expect(
        calculatePurchaseTransaction(
          {
            taxCalculation: 'NotApplicable',
            lines: [{ grossCents: -1_000, taxCodeQboId: 'OOS', nonTaxTreatment }],
          },
          reference,
        ),
      ).toMatchObject({
        eligible: true,
        taxCents: 0,
        lines: [{ treatment: nonTaxTreatment }],
      });
    }
  });

  it('supports explicitly exempt lines alongside taxable lines in an excluded transaction', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [
            { grossCents: -1_000, taxCodeQboId: 'GST5' },
            { grossCents: -2_000, taxCodeQboId: 'OOS', nonTaxTreatment: 'exempt' },
          ],
        },
        reference,
      ),
    ).toMatchObject({
      eligible: true,
      taxCents: -50,
      lines: [
        { treatment: 'standard', taxCents: -50 },
        { treatment: 'exempt', taxCents: 0 },
      ],
    });
  });

  it.each([
    ['ambiguous non-tax treatment', 'OOS', 'NotApplicable', undefined, 'TAX_TREATMENT_AMBIGUOUS'],
    ['unknown code', 'MISSING', 'TaxExcluded', undefined, 'TAX_CODE_UNAVAILABLE'],
    ['inactive code', 'OLD', 'TaxExcluded', undefined, 'TAX_CODE_INACTIVE'],
    ['sales-only code', 'SALES_ONLY', 'TaxExcluded', undefined, 'TAX_CODE_SALES_ONLY'],
    ['compound code', 'COMPOUND', 'TaxExcluded', undefined, 'TAX_RATE_UNSUPPORTED'],
    ['unknown taxable semantics', 'UNKNOWN_TAXABLE', 'TaxExcluded', undefined, 'TAX_CODE_MALFORMED'],
    ['contradictory semantics', 'CONTRADICTORY', 'TaxExcluded', undefined, 'TAX_CODE_MALFORMED'],
    ['unsupported component', 'WRONG_COMPONENT', 'TaxExcluded', undefined, 'TAX_RATE_UNSUPPORTED'],
  ] as const)(
    'returns structured ineligibility for %s',
    (_case, taxCodeQboId, taxCalculation, nonTaxTreatment, reason) => {
      expect(
        calculatePurchaseTransaction(
          {
            taxCalculation,
            lines: [{ grossCents: -1_000, taxCodeQboId, nonTaxTreatment }],
          },
          reference,
        ),
      ).toEqual({ eligible: false, reason, lineIndex: 0 });
    },
  );

  it('returns structured ineligibility for malformed and incompatible rates', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], rateValue: Number.NaN }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], active: false }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_INACTIVE', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        { ...reference, rates: [{ ...reference.rates[0], rateValue: 1_000 }] },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });
  });

  it('does not throw when a normalized reference object is malformed at runtime', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'BROKEN' }],
        },
        {
          codes: [
            {
              qboId: 'BROKEN',
              name: 'Broken',
              description: null,
              active: true,
              taxable: true,
            } as never,
          ],
          rates: reference.rates,
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_CODE_MALFORMED', lineIndex: 0 });
  });

  it('rejects empty runtime component and rate identities instead of skipping their tax', () => {
    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        {
          codes: [{
            ...reference.codes[0],
            purchaseRates: [{ taxRateQboId: '', taxTypeApplicable: 'TaxOnAmount' }],
          }],
          rates: [{ ...reference.rates[0], qboId: '' }],
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });

    expect(
      calculatePurchaseTransaction(
        {
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        },
        {
          codes: [reference.codes[0]],
          rates: [{ ...reference.rates[0], qboId: '' }],
        },
      ),
    ).toEqual({ eligible: false, reason: 'TAX_RATE_MALFORMED', lineIndex: 0 });
  });

  it.each([
    ['foreign reference', 'company-1', 'company-2'],
    ['empty request company', '', 'company-1'],
    ['empty reference company', 'company-1', ' '],
  ])('rejects %s before using tax metadata', (_case, requestCompanyId, referenceCompanyId) => {
    expect(
      calculatePurchaseTransactionRaw(
        {
          companyId: requestCompanyId,
          taxCalculation: 'TaxExcluded',
          lines: [{ grossCents: -1_000, taxCodeQboId: 'GST5' }],
        } as never,
        { ...reference, companyId: referenceCompanyId } as never,
      ),
    ).toEqual({ eligible: false, reason: 'TAX_COMPANY_MISMATCH' });
  });
});

describe('calculateSalesTransaction', () => {
  const companyId = 'company-1';
  const referenceWithPurchaseFiveAndSalesSeven = {
    ...reference,
    codes: [
      {
        ...reference.codes[0]!,
        qboId: 'STANDARD',
        purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
        salesRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
      },
      {
        ...reference.codes[4]!,
        qboId: 'SALES_COMPONENT_ONLY',
        purchaseRates: [],
        salesRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
      },
      {
        ...reference.codes[0]!,
        qboId: 'PURCHASE_COMPONENT_ONLY',
        purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
        salesRates: [],
      },
    ],
  };
  const calculateSalesTransaction = (
    input: Omit<Parameters<typeof calculateSalesTransactionRaw>[0], 'companyId'>,
  ) => calculateSalesTransactionRaw(
    { ...input, companyId },
    { ...referenceWithPurchaseFiveAndSalesSeven, companyId },
  );

  it('uses the sales rate while Purchase continues using the purchase rate', () => {
    const input = {
      taxCalculation: 'TaxInclusive' as const,
      lines: [{ grossCents: 10_700, taxCodeQboId: 'STANDARD' }],
    };

    expect(calculateSalesTransaction(input)).toMatchObject({
      eligible: true,
      grossCents: 10_700,
      netCents: 10_000,
      taxCents: 700,
    });
    expect(calculatePurchaseTransactionRaw(
      { ...input, companyId },
      { ...referenceWithPurchaseFiveAndSalesSeven, companyId },
    )).toMatchObject({
      eligible: true,
      grossCents: 10_700,
      netCents: 10_190,
      taxCents: 510,
    });
  });

  it('rejects tax codes that have no component in the requested direction', () => {
    expect(calculatePurchaseTransactionRaw(
      {
        companyId,
        taxCalculation: 'TaxInclusive',
        lines: [{ grossCents: 10_700, taxCodeQboId: 'SALES_COMPONENT_ONLY' }],
      },
      { ...referenceWithPurchaseFiveAndSalesSeven, companyId },
    )).toEqual({ eligible: false, reason: 'TAX_CODE_SALES_ONLY', lineIndex: 0 });
    expect(calculateSalesTransaction({
      taxCalculation: 'TaxInclusive',
      lines: [{ grossCents: 10_700, taxCodeQboId: 'PURCHASE_COMPONENT_ONLY' }],
    })).toEqual({ eligible: false, reason: 'TAX_CODE_PURCHASE_ONLY', lineIndex: 0 });
  });

  it('allocates positive exclusive rounding across sales lines', () => {
    expect(calculateSalesTransaction({
      taxCalculation: 'TaxExcluded',
      lines: [
        { grossCents: 10, taxCodeQboId: 'STANDARD' },
        { grossCents: 10, taxCodeQboId: 'STANDARD' },
      ],
    })).toMatchObject({
      eligible: true,
      grossCents: 20,
      netCents: 20,
      taxCents: 1,
      lines: [{ taxCents: 1 }, { taxCents: 0 }],
    });
  });

  it('keeps positive inclusive sales rounding exactly balanced per line', () => {
    expect(calculateSalesTransaction({
      taxCalculation: 'TaxInclusive',
      lines: [
        { grossCents: 1, taxCodeQboId: 'STANDARD' },
        { grossCents: 1, taxCodeQboId: 'STANDARD' },
      ],
    })).toMatchObject({
      eligible: true,
      grossCents: 2,
      netCents: 2,
      taxCents: 0,
      lines: [
        { grossCents: 1, netCents: 1, taxCents: 0 },
        { grossCents: 1, netCents: 1, taxCents: 0 },
      ],
    });
  });
});

const TAX_CODE_STANDARD = 'TAX_CODE_STANDARD';
const HOLDING_ACCOUNT = 'ACCOUNT_HOLDING';

function completePurchase(overrides: Partial<RawPurchase> = {}): RawPurchase {
  return {
    Id: 'PURCHASE_GENERIC',
    SyncToken: '7',
    TxnDate: '2026-07-01',
    TotalAmt: 15,
    PaymentType: 'CreditCard',
    DocNumber: 'DOC_GENERIC',
    PrivateNote: 'private generic note',
    EntityRef: { value: 'ENTITY_GENERIC', name: 'Generic Entity' },
    AccountRef: { value: 'ACCOUNT_PAYMENT', name: 'Generic Payment Account' },
    CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
    ExchangeRate: 1.25,
    GlobalTaxCalculation: 'TaxInclusive',
    TxnTaxDetail: { TotalTax: 0.75, TaxLine: [{ Amount: 0.75 }] },
    status: 'Active',
    MetaData: { CreateTime: '2026-07-01T00:00:00Z' },
    Line: [
      {
        Id: 'LINE_HOLDING',
        Amount: 10,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'holding line',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: HOLDING_ACCOUNT, name: 'Generic Holding' },
          CustomerRef: { value: 'CUSTOMER_OLD', name: 'Generic Customer' },
          ClassRef: { value: 'CLASS_OLD', name: 'Generic Class' },
          TaxCodeRef: { value: 'TAX_CODE_OLD' },
          TaxAmount: 0.5,
          TaxInclusiveAmt: 10,
        },
      },
      {
        Id: 'LINE_UNTOUCHED',
        Amount: 5,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'untouched line',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'ACCOUNT_UNTOUCHED', name: 'Generic Untouched' },
          CustomerRef: { value: 'CUSTOMER_UNTOUCHED', name: 'Generic Customer' },
          ClassRef: { value: 'CLASS_UNTOUCHED', name: 'Generic Class' },
          TaxCodeRef: { value: TAX_CODE_STANDARD },
          TaxAmount: 0.25,
        },
        CustomField: [{ Name: 'Generic field', StringValue: 'preserve me' }],
      },
    ],
    ...overrides,
  };
}

function snapshotFor(raw = completePurchase()): QboPurchaseSnapshot {
  const sign = raw.Credit === true ? 1 : -1;
  return {
    qboId: raw.Id,
    syncToken: raw.SyncToken,
    totalCents: sign * 1_500,
    accountQboId: 'ACCOUNT_PAYMENT',
    date: '2026-07-01',
    direction: sign === 1 ? 'refund' : 'purchase',
    globalTaxCalculation: 'TaxInclusive',
    totalTaxCents: sign * 75,
    lines: [
      {
        id: 'LINE_HOLDING',
        amountCents: sign * 1_000,
        description: 'holding line',
        accountQboId: HOLDING_ACCOUNT,
        customerQboId: 'CUSTOMER_OLD',
        classQboId: 'CLASS_OLD',
        taxCodeQboId: 'TAX_CODE_OLD',
        taxAmountCents: sign * 50,
        taxInclusiveCents: sign * 1_000,
      },
      {
        id: 'LINE_UNTOUCHED',
        amountCents: sign * 500,
        description: 'untouched line',
        accountQboId: 'ACCOUNT_UNTOUCHED',
        customerQboId: 'CUSTOMER_UNTOUCHED',
        classQboId: 'CLASS_UNTOUCHED',
        taxCodeQboId: TAX_CODE_STANDARD,
        taxAmountCents: sign * 25,
        taxInclusiveCents: null,
      },
    ],
  };
}

function staged(
  taxCalculation: StagedCategorization['taxCalculation'] = 'TaxInclusive',
): StagedCategorization {
  return {
    transactionId: '00000000-0000-4000-8000-000000000001',
    revision: 2,
    taxCalculation,
    totals: { subtotalCents: -952, taxCents: -48, totalCents: -1_000 },
    lines: [
      {
        idx: 0,
        subtotalCents: -952,
        taxCents: -48,
        totalCents: -1_000,
        categoryQboId: 'ACCOUNT_CATEGORY',
        taxCodeQboId: taxCalculation === 'NotApplicable' ? null : TAX_CODE_STANDARD,
        memo: 'generic memo',
      },
    ],
    tagIds: [],
  };
}

function prepare(
  raw = completePurchase(),
  categorization = staged(),
  before = snapshotFor(raw),
) {
  return preparePurchaseRecategorization({
    current: raw,
    holdingAccountQboIds: [HOLDING_ACCOUNT],
    staged: categorization,
    before,
    requestId: 'REQUEST_GENERIC',
  });
}

function changedPaths(
  left: unknown,
  right: unknown,
  path = '',
): string[] {
  if (Object.is(left, right)) return [];
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)
  ) {
    return [path];
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      paths.push(...changedPaths(left[index], right[index], `${path}[${index}]`));
    }
    return paths;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
    .sort()
    .flatMap((key) => changedPaths(
      leftRecord[key],
      rightRecord[key],
      path === '' ? key : `${path}.${key}`,
    ));
}

function preserveCurrentFixture(): {
  raw: RawPurchase;
  before: QboPurchaseSnapshot;
  preserved: StagedCategorization;
} {
  const raw: RawPurchase = {
      Id: '6477',
      SyncToken: '0',
      TxnDate: '2025-01-21',
      TotalAmt: 750,
      PaymentType: 'CreditCard',
      PrivateNote: 'keep private note',
      EntityRef: { value: '033', name: '033. Delicious M' },
      AccountRef: { value: '74', name: 'SinoPac TWD' },
      CurrencyRef: { value: 'TWD', name: 'New Taiwan Dollar' },
      ExchangeRate: 1,
      GlobalTaxCalculation: 'NotApplicable',
      TxnTaxDetail: { TotalTax: 0, TaxLine: [] },
      MetaData: { CreateTime: '2025-01-21T00:00:00Z' },
      Line: [{
        Id: '1',
        Amount: 750,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'bank charge',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: '2', name: 'Uncategorized Expense' },
          CustomerRef: { value: 'customer-1', name: 'Customer One' },
          ClassRef: { value: 'class-1', name: 'Class One' },
          TaxCodeRef: { value: 'NON', name: 'Non-taxable' },
          BillableStatus: 'NotBillable',
        },
        CustomField: [{ Name: 'source', StringValue: 'preserve me' }],
      }],
    };
  return {
    raw,
    before: mapPurchaseTaxSnapshot(raw),
    preserved: {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      taxDisposition: 'preserve_current',
      taxCalculation: 'NotApplicable',
      totals: { subtotalCents: -75_000, taxCents: 0, totalCents: -75_000 },
      lines: [{
        idx: 0,
        subtotalCents: -75_000,
        taxCents: 0,
        totalCents: -75_000,
        categoryQboId: '42',
        taxCodeQboId: 'NON',
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    },
  };
}

describe('preparePurchaseRecategorization', () => {
  it('changes only the category reference on a 6477-shaped preserve-current Purchase', () => {
    const { raw, before, preserved } = preserveCurrentFixture();

    const prepared = preparePurchaseRecategorization({
      current: raw,
      holdingAccountQboIds: ['2'],
      staged: preserved,
      before,
      requestId: 'REQUEST_6477',
    });

    expect(changedPaths(prepared.body, raw)).toEqual([
      'Line[0].AccountBasedExpenseLineDetail.AccountRef.value',
    ]);
    expect(prepared.body.Line![0]).toEqual({
      ...raw.Line![0],
      AccountBasedExpenseLineDetail: {
        ...raw.Line![0]!.AccountBasedExpenseLineDetail,
        AccountRef: {
          ...raw.Line![0]!.AccountBasedExpenseLineDetail!.AccountRef,
          value: '42',
        },
      },
    });
    const normalizedReadback = structuredClone(prepared.body);
    normalizedReadback.Line![0]!.AccountBasedExpenseLineDetail!.AccountRef!.name = 'Bank Charges';
    const actual = mapPurchaseTaxSnapshot(normalizedReadback);
    expect(purchaseTargetLineMatches(
      prepared.expected.globalTaxCalculation,
      prepared.expected.totalTaxCents,
      actual.totalTaxCents,
      prepared.expected.targetLines[0]!,
      actual.lines[0]!,
      'preserve_current',
    )).toBe(true);
    expect(prepared.expected).toMatchObject({
      qboId: '6477',
      totalCents: -75_000,
      accountQboId: '74',
      date: '2025-01-21',
      direction: 'purchase',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      targetLines: [{
        id: '1',
        amountCents: -75_000,
        description: 'bank charge',
        accountQboId: '42',
        customerQboId: 'customer-1',
        classQboId: 'class-1',
        taxCodeQboId: 'NON',
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    });
  });

  it.each([
    ['a different source tax code', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.Line![0]!.AccountBasedExpenseLineDetail!.TaxCodeRef = { value: 'ALT' };
      fixture.before.lines[0]!.taxCodeQboId = 'ALT';
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
    ['a different global tax mode', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.GlobalTaxCalculation = 'TaxInclusive';
      fixture.before.globalTaxCalculation = 'TaxInclusive';
      return { ...fixture, code: 'QBO_PURCHASE_UNSUPPORTED' };
    }],
    ['multiple holding lines', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.Line!.push({
        ...structuredClone(fixture.raw.Line![0]!),
        Id: '2',
        Amount: 0,
      });
      fixture.before = mapPurchaseTaxSnapshot(fixture.raw);
      return { ...fixture, code: 'QBO_PURCHASE_UNSUPPORTED' };
    }],
    ['a changed line identity', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.Line![0]!.Id = 'changed';
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
    ['an amount mismatch', () => {
      const fixture = preserveCurrentFixture();
      fixture.preserved.lines[0]!.subtotalCents = -74_000;
      fixture.preserved.lines[0]!.totalCents = -74_000;
      fixture.preserved.totals = {
        subtotalCents: -74_000,
        taxCents: 0,
        totalCents: -74_000,
      };
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
    ['a missing source tax code', () => {
      const fixture = preserveCurrentFixture();
      delete fixture.raw.Line![0]!.AccountBasedExpenseLineDetail!.TaxCodeRef;
      fixture.before.lines[0]!.taxCodeQboId = null;
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
    ['the target category already applied', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.Line![0]!.AccountBasedExpenseLineDetail!.AccountRef = { value: '42' };
      fixture.before.lines[0]!.accountQboId = '42';
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
    ['source-body drift from the stored before snapshot', () => {
      const fixture = preserveCurrentFixture();
      fixture.raw.Line![0]!.Description = 'drifted description';
      return { ...fixture, code: 'QBO_STATE_DRIFT' };
    }],
  ])('rejects preserve-current when fresh QBO has %s', (_name, makeFixture) => {
    const { raw, before, preserved, code } = makeFixture();

    expect(() => preparePurchaseRecategorization({
      current: raw,
      holdingAccountQboIds: ['2'],
      staged: preserved,
      before,
      requestId: 'REQUEST_6477_MISMATCH',
    })).toThrowError(expect.objectContaining<QboPurchasePreparationError>({ code }));
  });

  it('prepares an exact tax-inclusive full Purchase body and expected snapshot', () => {
    const raw = completePurchase();
    const prepared = prepare(raw);
    const {
      TxnTaxDetail: _staleTax,
      status: _cdcStatus,
      ...writeable
    } = raw;

    expect(prepared).toMatchObject({
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_GENERIC',
      before: snapshotFor(raw),
      expected: {
        qboId: 'PURCHASE_GENERIC',
        totalCents: -1_500,
        accountQboId: 'ACCOUNT_PAYMENT',
        date: '2026-07-01',
        direction: 'purchase',
        globalTaxCalculation: 'TaxInclusive',
        totalTaxCents: -73,
        targetLines: [{
          id: null,
          amountCents: -952,
          description: 'generic memo',
          accountQboId: 'ACCOUNT_CATEGORY',
          customerQboId: null,
          classQboId: null,
          taxCodeQboId: TAX_CODE_STANDARD,
          taxAmountCents: -48,
          taxInclusiveCents: -1_000,
        }],
      },
    });
    expect(prepared.body).toEqual({
      ...writeable,
      SyncToken: '7',
      GlobalTaxCalculation: 'TaxInclusive',
      Line: [
        raw.Line![1],
        {
          Amount: 9.52,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic memo',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'ACCOUNT_CATEGORY' },
            TaxCodeRef: { value: TAX_CODE_STANDARD },
            TaxAmount: 0.48,
            TaxInclusiveAmt: 10,
          },
        },
      ],
    });
    expect(prepared.body.EntityRef).toEqual(raw.EntityRef);
    expect(prepared.body.AccountRef).toEqual(raw.AccountRef);
    expect(prepared.body.DocNumber).toBe(raw.DocNumber);
    expect(prepared.body.PrivateNote).toBe(raw.PrivateNote);
    expect(prepared.body.PaymentType).toBe(raw.PaymentType);
    expect(prepared.body.CurrencyRef).toEqual(raw.CurrencyRef);
    expect(prepared.body.ExchangeRate).toBe(raw.ExchangeRate);
    expect(prepared.body.Line![0]).toEqual(raw.Line![1]);
    expect(prepared.body).not.toHaveProperty('TxnTaxDetail');
    expect(prepared.body).not.toHaveProperty('status');
    expect(prepared.body.Line!.some((line) =>
      line.AccountBasedExpenseLineDetail?.AccountRef?.value === HOLDING_ACCOUNT,
    )).toBe(false);
    expect(prepared.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.body)).toBe(true);
  });

  it('canonicalizes negative raw Purchase money without reversing its direction', () => {
    const source = completePurchase();
    const raw = completePurchase({
      TotalAmt: -15,
      TxnTaxDetail: { TotalTax: -0.75 },
      Line: source.Line!.map((line) => ({
        ...line,
        Amount: -(line.Amount ?? 0),
        AccountBasedExpenseLineDetail: line.AccountBasedExpenseLineDetail === undefined
          ? undefined
          : {
              ...line.AccountBasedExpenseLineDetail,
              TaxAmount:
                line.AccountBasedExpenseLineDetail.TaxAmount === undefined
                  ? undefined
                  : -line.AccountBasedExpenseLineDetail.TaxAmount,
              TaxInclusiveAmt:
                line.AccountBasedExpenseLineDetail.TaxInclusiveAmt === undefined
                  ? undefined
                  : -line.AccountBasedExpenseLineDetail.TaxInclusiveAmt,
            },
      })),
    });

    expect(() => prepare(raw, staged(), snapshotFor(raw))).not.toThrow();
  });

  it.each([
    ['TaxExcluded', undefined],
    ['TaxInclusive', 10],
  ] as const)('emits exact %s tax fields', (taxCalculation, inclusiveAmount) => {
    const raw = completePurchase({ GlobalTaxCalculation: taxCalculation });
    const prepared = prepare(raw, staged(taxCalculation), {
      ...snapshotFor(raw),
      globalTaxCalculation: taxCalculation,
    });
    const detail = prepared.body.Line![1]!.AccountBasedExpenseLineDetail;
    expect(detail).toEqual({
      AccountRef: { value: 'ACCOUNT_CATEGORY' },
      TaxCodeRef: { value: TAX_CODE_STANDARD },
      TaxAmount: 0.48,
      ...(inclusiveAmount === undefined ? {} : { TaxInclusiveAmt: inclusiveAmount }),
    });
    expect(prepared.body.GlobalTaxCalculation).toBe(taxCalculation);
  });

  it('proves preserved tax from the aggregate and rejects unprovable or mode-changing shapes', () => {
    const aggregateBacked = completePurchase({
      Line: [
        completePurchase().Line![0]!,
        {
          ...completePurchase().Line![1]!,
          AccountBasedExpenseLineDetail: {
            ...completePurchase().Line![1]!.AccountBasedExpenseLineDetail,
            TaxAmount: undefined,
          },
        },
      ],
    });
    const aggregateBefore: QboPurchaseSnapshot = {
      ...snapshotFor(aggregateBacked),
      lines: [
        snapshotFor(aggregateBacked).lines[0]!,
        { ...snapshotFor(aggregateBacked).lines[1]!, taxAmountCents: null },
      ],
    };

    expect(prepare(aggregateBacked, staged(), aggregateBefore).expected.totalTaxCents).toBe(-73);

    const unprovable = {
      ...aggregateBacked,
      Line: [
        {
          ...aggregateBacked.Line![0]!,
          AccountBasedExpenseLineDetail: {
            ...aggregateBacked.Line![0]!.AccountBasedExpenseLineDetail,
            TaxAmount: undefined,
            TaxInclusiveAmt: undefined,
          },
        },
        aggregateBacked.Line![1]!,
      ],
    };
    const unprovableBefore: QboPurchaseSnapshot = {
      ...aggregateBefore,
      lines: [
        {
          ...aggregateBefore.lines[0]!,
          taxAmountCents: null,
          taxInclusiveCents: null,
        },
        aggregateBefore.lines[1]!,
      ],
    };
    expect(() => prepare(unprovable, staged(), unprovableBefore)).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({
        code: 'QBO_PURCHASE_UNSUPPORTED',
      }),
    );

    expect(() => prepare(completePurchase(), staged('TaxExcluded'))).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({
        code: 'QBO_PURCHASE_UNSUPPORTED',
      }),
    );

    const inconsistentAggregate = completePurchase({
      TxnTaxDetail: { TotalTax: 0.8 },
    });
    expect(() => prepare(
      inconsistentAggregate,
      staged(),
      {
        ...snapshotFor(inconsistentAggregate),
        totalTaxCents: -80,
      },
    )).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({
        code: 'QBO_PURCHASE_UNSUPPORTED',
      }),
    );
  });

  it('prepares split cents exactly and preserves signed refunds', () => {
    const raw = completePurchase({ Credit: true });
    const before = snapshotFor(raw);
    const splitStage: StagedCategorization = {
      ...staged(),
      totals: { subtotalCents: 952, taxCents: 48, totalCents: 1_000 },
      lines: [
        {
          idx: 0,
          subtotalCents: 571,
          taxCents: 29,
          totalCents: 600,
          categoryQboId: 'ACCOUNT_CATEGORY_A',
          taxCodeQboId: TAX_CODE_STANDARD,
          memo: null,
        },
        {
          idx: 1,
          subtotalCents: 381,
          taxCents: 19,
          totalCents: 400,
          categoryQboId: 'ACCOUNT_CATEGORY_B',
          taxCodeQboId: TAX_CODE_STANDARD,
          memo: 'generic second memo',
        },
      ],
    };

    const prepared = prepare(raw, splitStage, before);

    expect(prepared.body.Line!.slice(1)).toEqual([
      {
        Amount: 5.71,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'ACCOUNT_CATEGORY_A' },
          TaxCodeRef: { value: TAX_CODE_STANDARD },
          TaxAmount: 0.29,
          TaxInclusiveAmt: 6,
        },
      },
      {
        Amount: 3.81,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'generic second memo',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'ACCOUNT_CATEGORY_B' },
          TaxCodeRef: { value: TAX_CODE_STANDARD },
          TaxAmount: 0.19,
          TaxInclusiveAmt: 4,
        },
      },
    ]);
    expect(prepared.expected).toMatchObject({
      direction: 'refund',
      totalTaxCents: 73,
      targetLines: [
        { amountCents: 571, taxAmountCents: 29, taxInclusiveCents: 600 },
        { amountCents: 381, taxAmountCents: 19, taxInclusiveCents: 400 },
      ],
    });
  });

  it('hashes the normalized body deterministically despite object insertion order', () => {
    const raw = completePurchase();
    const reordered = {
      Line: raw.Line,
      MetaData: raw.MetaData,
      TxnTaxDetail: raw.TxnTaxDetail,
      GlobalTaxCalculation: raw.GlobalTaxCalculation,
      ExchangeRate: raw.ExchangeRate,
      CurrencyRef: raw.CurrencyRef,
      AccountRef: raw.AccountRef,
      EntityRef: raw.EntityRef,
      PrivateNote: raw.PrivateNote,
      DocNumber: raw.DocNumber,
      PaymentType: raw.PaymentType,
      TotalAmt: raw.TotalAmt,
      TxnDate: raw.TxnDate,
      SyncToken: raw.SyncToken,
      Id: raw.Id,
    } as RawPurchase;

    expect(prepare(raw).requestHash).toBe(prepare(reordered).requestHash);
  });

  it('rejects unsupported shapes, drift, missing references, unsafe cents, and stale tokens', () => {
    expect(() => prepare(completePurchase({ Line: undefined }))).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_PURCHASE_UNSUPPORTED' }),
    );
    expect(() => prepare(completePurchase({ TotalAmt: 16 }))).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_STATE_DRIFT' }),
    );
    expect(() => prepare(completePurchase(), {
      ...staged(),
      lines: [{ ...staged().lines[0]!, categoryQboId: '' }],
    })).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
    );
    const missingPaymentAccount = completePurchase({ AccountRef: undefined });
    expect(() => prepare(
      missingPaymentAccount,
      staged(),
      { ...snapshotFor(missingPaymentAccount), accountQboId: null },
    )).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_REFERENCE_MISSING' }),
    );
    expect(() => prepare(completePurchase(), {
      ...staged(),
      lines: [{ ...staged().lines[0]!, subtotalCents: Number.MAX_SAFE_INTEGER }],
    })).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_AMOUNT_UNSAFE' }),
    );
    expect(() => prepare(
      completePurchase({ SyncToken: '8' }),
      staged(),
      snapshotFor(completePurchase()),
    )).toThrowError(QboSyncTokenConflict);
  });

  it('rejects contradictory staged tax signs and NotApplicable tax cents', () => {
    for (const invalid of [
      {
        ...staged(),
        totals: { subtotalCents: -1_100, taxCents: 100, totalCents: -1_000 },
        lines: [{
          ...staged().lines[0]!,
          subtotalCents: -1_100,
          taxCents: 100,
          totalCents: -1_000,
        }],
      },
      {
        ...staged('NotApplicable'),
        totals: { subtotalCents: -900, taxCents: -100, totalCents: -1_000 },
        lines: [{
          ...staged('NotApplicable').lines[0]!,
          subtotalCents: -900,
          taxCents: -100,
          totalCents: -1_000,
        }],
      },
    ] satisfies StagedCategorization[]) {
      expect(() => prepare(completePurchase(), invalid)).toThrowError(
        expect.objectContaining<QboPurchasePreparationError>({
          code: 'QBO_PURCHASE_UNSUPPORTED',
        }),
      );
    }

    const refund = completePurchase({ Credit: true });
    expect(() => prepare(refund, {
      ...staged(),
      totals: { subtotalCents: 1_100, taxCents: -100, totalCents: 1_000 },
      lines: [{
        ...staged().lines[0]!,
        subtotalCents: 1_100,
        taxCents: -100,
        totalCents: 1_000,
      }],
    }, snapshotFor(refund))).toThrowError(
      expect.objectContaining<QboPurchasePreparationError>({
        code: 'QBO_PURCHASE_UNSUPPORTED',
      }),
    );
  });
});

describe('preparePurchaseRestore', () => {
  it('undoes preserve-current by changing only the category reference on the fresh raw line', () => {
    const { raw, before, preserved } = preserveCurrentFixture();
    const original = preparePurchaseRecategorization({
      current: raw,
      holdingAccountQboIds: ['2'],
      staged: preserved,
      before,
      requestId: 'REQUEST_6477_FORWARD',
    });
    const current: RawPurchase = {
      ...structuredClone(original.body),
      SyncToken: '1',
    };

    const restore = preparePurchaseRestore({
      current,
      prepared: original,
      requestId: 'REQUEST_6477_UNDO',
    });

    expect(changedPaths(restore.body, current)).toEqual([
      'Line[0].AccountBasedExpenseLineDetail.AccountRef.value',
    ]);
    expect(restore.body.Line![0]!.CustomField).toEqual(raw.Line![0]!.CustomField);
    expect(restore.body.Line![0]!.AccountBasedExpenseLineDetail!.BillableStatus)
      .toBe('NotBillable');
    expect(restore.body.Line![0]!.AccountBasedExpenseLineDetail!.AccountRef)
      .toEqual({ value: '2', name: 'Uncategorized Expense' });
    const normalizedReadback = structuredClone(restore.body);
    normalizedReadback.Line![0]!.AccountBasedExpenseLineDetail!.AccountRef!.name =
      'Uncategorized Expense (normalized)';
    const actual = mapPurchaseTaxSnapshot(normalizedReadback);
    expect(purchaseTargetLineMatches(
      restore.expected.globalTaxCalculation,
      restore.expected.totalTaxCents,
      actual.totalTaxCents,
      restore.expected.targetLines[0]!,
      actual.lines[0]!,
      'preserve_current',
    )).toBe(true);
  });

  it('prepares restore after QBO normalizes a non-taxable write to null/default fields', () => {
    const originalRaw = completePurchase({
      TotalAmt: 10,
      TxnTaxDetail: { TotalTax: 0.5 },
      Line: [completePurchase().Line![0]!],
    });
    const before = {
      ...snapshotFor(originalRaw),
      totalCents: -1_000,
      totalTaxCents: -50,
      lines: [snapshotFor(originalRaw).lines[0]!],
    };
    const nonTaxableStage: StagedCategorization = {
      ...staged('NotApplicable'),
      totals: { subtotalCents: -1_000, taxCents: 0, totalCents: -1_000 },
      lines: [{
        ...staged('NotApplicable').lines[0]!,
        subtotalCents: -1_000,
        taxCents: 0,
        totalCents: -1_000,
      }],
    };
    const original = prepare(originalRaw, nonTaxableStage, before);
    const current: RawPurchase = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: undefined,
      Line: [{
        ...original.body.Line![0]!,
        Id: 'PROVIDER_ASSIGNED_TARGET',
        AccountBasedExpenseLineDetail: {
          ...original.body.Line![0]!.AccountBasedExpenseLineDetail,
          TaxCodeRef: { value: 'PROVIDER_DEFAULT_NON_TAX' },
        },
      }],
    };

    const restore = preparePurchaseRestore({
      current,
      prepared: original,
      requestId: 'REQUEST_RESTORE_NORMALIZED_NON_TAX',
    });

    expect(restore.body.Line).toEqual([
      expect.objectContaining({
        Id: 'LINE_HOLDING',
        AccountBasedExpenseLineDetail: expect.objectContaining({
          AccountRef: { value: HOLDING_ACCOUNT },
        }),
      }),
    ]);
    expect(() => preparePurchaseRestore({
      current: { ...current, TxnTaxDetail: { TotalTax: 0.01 } },
      prepared: original,
      requestId: 'REQUEST_RESTORE_TAX_DRIFT',
    })).toThrowError(expect.objectContaining<QboPurchasePreparationError>({
      code: 'QBO_STATE_DRIFT',
    }));
    expect(() => preparePurchaseRestore({
      current: { ...current, TxnTaxDetail: { TotalTax: 0.01 } },
      prepared: {
        ...original,
        expected: {
          ...original.expected,
          totalTaxCents: -1,
        },
      },
      requestId: 'REQUEST_RESTORE_EQUAL_TAX_DRIFT',
    })).toThrowError(expect.objectContaining<QboPurchasePreparationError>({
      code: 'QBO_STATE_DRIFT',
    }));
  });

  it('restores the exact before snapshot target with the current SyncToken', () => {
    const original = prepare();
    const current: RawPurchase = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 0.73 },
      Line: [
        original.body.Line![0]!,
        {
          Id: 'LINE_QBO_ASSIGNED',
          ...original.body.Line![1]!,
        },
      ],
    };

    const restore = preparePurchaseRestore({
      current,
      prepared: original,
      requestId: 'REQUEST_RESTORE_GENERIC',
    });

    expect(restore).toMatchObject({
      operation: 'restore',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
      requestId: 'REQUEST_RESTORE_GENERIC',
      before: {
        qboId: original.expected.qboId,
        syncToken: '8',
        totalCents: original.expected.totalCents,
        accountQboId: original.expected.accountQboId,
        date: original.expected.date,
        direction: original.expected.direction,
        globalTaxCalculation: original.expected.globalTaxCalculation,
        totalTaxCents: -73,
        lines: [
          original.before.lines[1],
          { ...original.expected.targetLines[0], id: 'LINE_QBO_ASSIGNED' },
        ],
      },
      expected: {
        globalTaxCalculation: 'TaxInclusive',
        totalTaxCents: -75,
        targetLines: [{
          id: 'LINE_HOLDING',
          amountCents: -1_000,
          accountQboId: HOLDING_ACCOUNT,
          customerQboId: 'CUSTOMER_OLD',
          classQboId: 'CLASS_OLD',
          taxCodeQboId: 'TAX_CODE_OLD',
          taxAmountCents: -50,
          taxInclusiveCents: -1_000,
        }],
      },
    });
    expect(restore.body.SyncToken).toBe('8');
    expect(restore.body.Line).toEqual([
      {
        Id: 'LINE_HOLDING',
        Amount: 10,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'holding line',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: HOLDING_ACCOUNT },
          CustomerRef: { value: 'CUSTOMER_OLD' },
          ClassRef: { value: 'CLASS_OLD' },
          TaxCodeRef: { value: 'TAX_CODE_OLD' },
          TaxAmount: 0.5,
          TaxInclusiveAmt: 10,
        },
      },
      current.Line![0],
    ]);
  });

  it('restores when QBO omits redundant inclusive tax fields that remain exactly derivable', () => {
    const original = prepare();
    const target = structuredClone(original.body.Line![1]!);
    delete target.AccountBasedExpenseLineDetail!.TaxAmount;
    const current: RawPurchase = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: undefined,
      Line: [
        original.body.Line![0]!,
        { Id: 'LINE_QBO_ASSIGNED', ...target },
      ],
    };

    const restore = preparePurchaseRestore({
      current,
      prepared: original,
      requestId: 'REQUEST_RESTORE_GENERIC',
    });

    expect(restore).toMatchObject({
      operation: 'restore',
      qboType: 'Purchase',
      qboId: 'PURCHASE_GENERIC',
    });
  });

  it('rejects current Purchase drift and unsupported restore shapes', () => {
    const original = prepare();
    expect(() => preparePurchaseRestore({
      current: { ...original.body, SyncToken: '8', TotalAmt: 16 },
      prepared: original,
      requestId: 'REQUEST_RESTORE_GENERIC',
    })).toThrowError(expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_STATE_DRIFT' }));
    expect(() => preparePurchaseRestore({
      current: { ...original.body, SyncToken: '8', Line: undefined },
      prepared: original,
      requestId: 'REQUEST_RESTORE_GENERIC',
    })).toThrowError(expect.objectContaining<QboPurchasePreparationError>({ code: 'QBO_PURCHASE_UNSUPPORTED' }));
  });

  it('reserves untouched line identities before matching colliding restore targets', () => {
    const raw = completePurchase({
      TotalAmt: 19.52,
      TxnTaxDetail: { TotalTax: 0.98 },
      Line: [
        completePurchase().Line![0]!,
        {
          Id: 'LINE_UNTOUCHED',
          Amount: 9.52,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic memo',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'ACCOUNT_CATEGORY' },
            TaxCodeRef: { value: TAX_CODE_STANDARD },
            TaxAmount: 0.48,
            TaxInclusiveAmt: 10,
          },
        },
      ],
    });
    const before: QboPurchaseSnapshot = {
      ...snapshotFor(raw),
      totalCents: -1_952,
      totalTaxCents: -98,
      lines: [
        snapshotFor(raw).lines[0]!,
        {
          id: 'LINE_UNTOUCHED',
          amountCents: -952,
          description: 'generic memo',
          accountQboId: 'ACCOUNT_CATEGORY',
          customerQboId: null,
          classQboId: null,
          taxCodeQboId: TAX_CODE_STANDARD,
          taxAmountCents: -48,
          taxInclusiveCents: -1_000,
        },
      ],
    };
    const original = prepare(raw, staged(), before);
    const current: RawPurchase = {
      ...original.body,
      SyncToken: '8',
      TxnTaxDetail: { TotalTax: 0.96 },
      Line: [
        original.body.Line![0]!,
        { Id: 'LINE_TARGET_ASSIGNED', ...original.body.Line![1]! },
      ],
    };

    expect(() => preparePurchaseRestore({
      current,
      prepared: original,
      requestId: 'REQUEST_RESTORE_COLLISION',
    })).not.toThrow();
  });
});
