import { describe, expect, it } from 'vitest';
import { cachedTaxCodeSupport, cachedTaxRates } from './cache.js';

describe('cached tax reference validation', () => {
  const validRates = [
    { qboId: 'GST', name: 'GST', description: null, active: true, rateValue: '5', sourceUpdatedAt: null },
    { qboId: 'PST', name: 'PST', description: null, active: true, rateValue: '7', sourceUpdatedAt: null },
  ];

  it('derives a legacy composite rate from its current component rows', () => {
    expect(cachedTaxCodeSupport({
      active: true,
      taxable: true,
      purchaseTaxRateList: [
        { taxRateQboId: 'GST', taxTypeApplicable: 'TaxOnAmount' },
        { taxRateQboId: 'PST', taxTypeApplicable: 'TaxOnAmount' },
      ],
    }, cachedTaxRates(validRates), 'purchase')).toEqual({
      supported: true,
      combinedRate: 12,
      componentCount: 2,
    });
  });

  it('fails closed when a cached component list contains JSON null', () => {
    expect(cachedTaxCodeSupport({
      active: true,
      taxable: true,
      purchaseTaxRateList: [null],
    }, cachedTaxRates(validRates), 'purchase')).toEqual({
      supported: false,
      combinedRate: null,
      componentCount: 0,
    });
  });

  it('drops null rate values instead of coercing them to zero', () => {
    expect(cachedTaxRates([{ ...validRates[0], rateValue: null }])).toEqual([]);
  });
});
