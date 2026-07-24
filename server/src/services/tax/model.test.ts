import { describe, expect, it } from 'vitest';
import {
  TaxPlanError,
  validateRecategorizationPlan,
  type QboRecategorizationPlan,
} from './model.js';

function plan(overrides: Partial<QboRecategorizationPlan> = {}): QboRecategorizationPlan {
  return {
    qboType: 'Purchase',
    signedTransactionAmount: -113,
    taxCalculation: 'TaxInclusive',
    lines: [
      {
        grossAmount: -113,
        accountQboId: 'expense-1',
        tax: { taxCodeQboId: 'gst-13', taxCodeName: 'HST ON' },
      },
    ],
    ...overrides,
  };
}

describe('validateRecategorizationPlan', () => {
  it.each(['TaxInclusive', 'TaxExcluded', 'NotApplicable'] as const)('accepts %s', (taxCalculation) => {
    const outOfScopeTaxCodeQboId = taxCalculation === 'NotApplicable' ? 'out-of-scope' : null;
    expect(() =>
      validateRecategorizationPlan(
        plan({
          taxCalculation,
          outOfScopeTaxCodeQboId,
          lines: [
            {
              grossAmount: -113,
              accountQboId: 'expense-1',
              tax: {
                taxCodeQboId: taxCalculation === 'NotApplicable' ? 'out-of-scope' : 'gst-13',
                taxCodeName: taxCalculation === 'NotApplicable' ? 'Out of Scope' : 'HST ON',
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('requires a tax code on every taxable line', () => {
    expect(() =>
      validateRecategorizationPlan(
        plan({ lines: [{ grossAmount: -113, accountQboId: 'expense-1', tax: { taxCodeQboId: null, taxCodeName: null } }] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TAX_CODE_REQUIRED' }));
  });

  it('accepts NotApplicable only through the configured out-of-scope representation', () => {
    expect(() =>
      validateRecategorizationPlan(
        plan({
          taxCalculation: 'NotApplicable',
          outOfScopeTaxCodeQboId: 'out-of-scope',
          lines: [
            {
              grossAmount: -113,
              accountQboId: 'expense-1',
              tax: { taxCodeQboId: 'gst-13', taxCodeName: 'HST ON' },
            },
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TAX_OUT_OF_SCOPE_REQUIRED' }));
  });

  it('uses cents when checking signed split totals', () => {
    expect(() =>
      validateRecategorizationPlan(
        plan({
          signedTransactionAmount: -100,
          lines: [
            { grossAmount: -55.55, accountQboId: 'a', tax: { taxCodeQboId: 'gst', taxCodeName: 'GST' } },
            { grossAmount: -44.45, accountQboId: 'b', tax: { taxCodeQboId: 'gst', taxCodeName: 'GST' } },
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateRecategorizationPlan(plan({ signedTransactionAmount: -100.01 })),
    ).toThrowError(expect.objectContaining({ code: 'TAX_AMOUNT_MISMATCH' }));
  });

  it.each(['Deposit', 'JournalEntry'] as const)('rejects tax treatment on %s', (qboType) => {
    expect(() => validateRecategorizationPlan(plan({ qboType }))).toThrowError(
      expect.objectContaining({ code: 'TAX_MODE_UNSUPPORTED' }),
    );
  });

  it('exposes typed tax errors', () => {
    const error = new TaxPlanError('TAX_LINES_REQUIRED', 'missing');
    expect(error).toMatchObject({ name: 'TaxPlanError', code: 'TAX_LINES_REQUIRED' });
  });
});
