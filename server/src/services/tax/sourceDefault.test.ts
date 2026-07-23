import { describe, expect, it } from 'vitest';
import {
  completeSourcePurchaseTaxDefault,
  sourcePurchaseTaxSelection,
} from './sourceDefault.js';

const raw = {
  GlobalTaxCalculation: 'TaxInclusive',
  Line: [
    {
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: 'holding' },
        TaxCodeRef: { value: '5' },
      },
    },
  ],
};

describe('source Purchase tax defaults', () => {
  it('preserves the QuickBooks tax mode and code from holding-account lines', () => {
    const selection = sourcePurchaseTaxSelection('Purchase', raw, ['holding']);
    expect(selection).toEqual({
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: '5',
    });
    expect(
      completeSourcePurchaseTaxDefault(selection, [
        {
          qboId: '5',
          name: 'Out of Scope',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{ taxRateQboId: '21' }],
        },
      ]),
    ).toEqual({
      taxCalculation: 'TaxInclusive',
      taxCode: 'Out of Scope',
      taxCodeQboId: '5',
    });
  });

  it('fails closed when holding lines disagree or omit tax', () => {
    const conflicting = {
      ...raw,
      Line: [
        ...raw.Line,
        {
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'holding' },
            TaxCodeRef: { value: '3' },
          },
        },
      ],
    };
    expect(sourcePurchaseTaxSelection('Purchase', conflicting, ['holding'])).toBeNull();
    expect(
      sourcePurchaseTaxSelection(
        'Purchase',
        {
          ...raw,
          Line: [
            {
              AccountBasedExpenseLineDetail: {
                AccountRef: { value: 'holding' },
              },
            },
          ],
        },
        ['holding'],
      ),
    ).toBeNull();
  });

  it('ignores non-Purchases and unsupported code shapes', () => {
    expect(sourcePurchaseTaxSelection('Deposit', raw, ['holding'])).toBeNull();
    const selection = sourcePurchaseTaxSelection('Purchase', raw, ['holding']);
    expect(
      completeSourcePurchaseTaxDefault(selection, [
        {
          qboId: '5',
          name: 'Composite',
          active: true,
          taxable: true,
          purchaseTaxRateList: [{ taxRateQboId: '1' }, { taxRateQboId: '2' }],
        },
      ]),
    ).toBeNull();
  });
});
