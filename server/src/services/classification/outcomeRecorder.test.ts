import { describe, expect, it } from 'vitest';
import { caseAction } from './outcomeRecorder.js';

describe('caseAction', () => {
  it('normalizes a verified single-line NotApplicable NON sentinel for the reusable action contract', () => {
    expect(caseAction({
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0,
        subtotalCents: -1_000,
        taxCents: 0,
        totalCents: -1_000,
        categoryQboId: 'expense-generic',
        taxCodeQboId: 'NON',
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
    })).toEqual({
      categoryQboId: 'expense-generic',
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      tagIds: [],
      memo: null,
    });
  });

  it('keeps multi-line verified evidence out of the reusable action contract', () => {
    const line = {
      idx: 0,
      subtotalCents: -1_000,
      taxCents: 0,
      totalCents: -1_000,
      categoryQboId: 'expense-generic',
      taxCodeQboId: 'NON',
      memo: null,
      tagIds: [],
    };
    expect(caseAction({
      taxCalculation: 'NotApplicable',
      lines: [line, { ...line, idx: 1, categoryQboId: 'expense-second' }],
      tagIds: [],
    })).toBeNull();
  });
});
