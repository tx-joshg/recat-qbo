import { describe, expect, it } from 'vitest';
import {
  planCanonicalRule,
  rankLegacyRules,
  type LegacyRulePlanningInput,
} from './ruleCanonicalBackfill.js';

function legacyRule(
  overrides: Partial<LegacyRulePlanningInput> = {},
): LegacyRulePlanningInput {
  return {
    id: 'rule-a',
    priority: 10,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    enabled: true,
    autoPost: true,
    retiredAt: null,
    reviewRequiredAt: null,
    matchText: '  ACME\tWidgets  ',
    category: 'Meals',
    categoryQboId: 'expense-1',
    taxCalculation: 'NotApplicable',
    taxCode: null,
    taxCodeQboId: null,
    account: {
      qboId: 'expense-1',
      name: 'Meals',
      active: true,
      classification: 'Expenses',
      holding: false,
    },
    taxCodeReference: null,
    tagIds: ['tag-1'],
    validTagIds: ['tag-1'],
    journalEntryCount: 0,
    ...overrides,
  };
}

describe('canonical rule backfill planning', () => {
  it('canonicalizes a valid enabled Purchase without changing its permission', () => {
    expect(planCanonicalRule(legacyRule(), 0)).toMatchObject({
      priority: 0,
      matchText: 'acme widgets',
      direction: 'Purchase',
      enabled: true,
      autoPost: true,
      repairReason: null,
      affectedJournalEntryCount: 0,
    });
  });

  it('uses sales readiness for Deposit and accepts a complete taxed action', () => {
    expect(planCanonicalRule(legacyRule({
      category: 'Sales',
      categoryQboId: 'income-1',
      account: {
        qboId: 'income-1', name: 'Sales', active: true, classification: 'Income', holding: false,
      },
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'gst-sales',
      taxCodeReference: {
        qboId: 'gst-sales', name: 'GST sales', active: true, usablePurchase: false, usableSales: true,
      },
      taxCode: 'GST sales',
    }), 1)).toMatchObject({
      direction: 'Deposit',
      enabled: true,
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'gst-sales',
      repairReason: null,
    });
  });

  it('never enables an existing disabled rule and turns its auto-post off', () => {
    expect(planCanonicalRule(legacyRule({ enabled: false }), 2)).toMatchObject({
      enabled: false,
      autoPost: false,
      direction: 'Purchase',
    });
  });

  it('retains retirement as a disabled, null-direction review projection', () => {
    expect(planCanonicalRule(legacyRule({
      retiredAt: new Date('2026-02-01T00:00:00.000Z'),
    }), 3)).toMatchObject({
      enabled: false,
      autoPost: false,
      direction: null,
      repairReason: expect.stringMatching(/reactivation/i),
    });
  });

  it.each([
    ['unknown direction', { account: null }, /direction/i],
    ['inactive category', { account: { qboId: 'expense-1', name: 'Meals', active: false, classification: 'Expenses', holding: false } }, /category/i],
    ['holding category', { account: { qboId: 'expense-1', name: 'Meals', active: true, classification: 'Expenses', holding: true } }, /category/i],
    ['incompatible category', { account: { qboId: 'expense-1', name: 'Meals', active: true, classification: 'Asset', holding: false } }, /category/i],
    ['mismatched category name', { category: 'Old meals name' }, /category/i],
    ['invalid no-tax tuple', { taxCodeQboId: 'unexpected' }, /tax/i],
    ['wrong-direction tax rate', {
      taxCalculation: 'TaxExcluded', taxCodeQboId: 'sales-only',
      taxCode: 'Sales only',
      taxCodeReference: { qboId: 'sales-only', name: 'Sales only', active: true, usablePurchase: false, usableSales: true },
    }, /tax/i],
    ['missing tag', { tagIds: ['tag-1', 'missing'], validTagIds: ['tag-1'] }, /tag/i],
    ['review hold', { reviewRequiredAt: new Date('2026-03-01T00:00:00.000Z') }, /review/i],
    ['Journal Entry exposure', { journalEntryCount: 2 }, /journal/i],
  ] as const)('fails closed for %s', (_label, overrides, reason) => {
    expect(planCanonicalRule(legacyRule(overrides), 4)).toMatchObject({
      enabled: false,
      autoPost: false,
      repairReason: expect.stringMatching(reason),
    });
  });

  it('preserves invalid stored tax fields while disabling the rule for repair', () => {
    expect(planCanonicalRule(legacyRule({
      taxCalculation: 'LegacyTaxMode',
      taxCode: 'Legacy tax label',
      taxCodeQboId: 'legacy-tax-id',
    }), 4)).toMatchObject({
      enabled: false,
      autoPost: false,
      taxCalculation: 'LegacyTaxMode',
      taxCodeQboId: 'legacy-tax-id',
      repairReason: expect.stringMatching(/tax/i),
    });
    expect(planCanonicalRule(legacyRule({
      taxCalculation: 'NotApplicable',
      taxCode: 'Unexpected tax label',
      taxCodeQboId: 'unexpected-tax-id',
    }), 4)).toMatchObject({
      enabled: false,
      taxCalculation: 'NotApplicable',
      taxCodeQboId: 'unexpected-tax-id',
    });
  });

  it('records multiple defects in one bounded deterministic repair reason', () => {
    const result = planCanonicalRule(legacyRule({
      account: null,
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: null,
      tagIds: ['missing'],
      validTagIds: [],
      reviewRequiredAt: new Date('2026-03-01T00:00:00.000Z'),
      journalEntryCount: 3,
    }), 5);
    expect(result.enabled).toBe(false);
    expect(result.autoPost).toBe(false);
    expect(result.direction).toBeNull();
    expect(result.repairReason).toMatch(/direction/i);
    expect(result.repairReason).toMatch(/tax/i);
    expect(result.repairReason).toMatch(/tag/i);
    expect(result.repairReason).toMatch(/review/i);
    expect(result.repairReason).toMatch(/journal/i);
    expect(result.repairReason!.length).toBeLessThanOrEqual(500);
  });

  it('ranks exact ties by priority, createdAt descending, then rule ID', () => {
    const createdAt = new Date('2026-04-01T00:00:00.000Z');
    const ranked = rankLegacyRules([
      legacyRule({ id: 'b', priority: 5, createdAt }),
      legacyRule({ id: 'a', priority: 5, createdAt }),
      legacyRule({ id: 'older', priority: 5, createdAt: new Date('2026-03-01T00:00:00.000Z') }),
      legacyRule({ id: 'first', priority: 1, createdAt }),
    ]);
    expect(ranked.map(({ rule, priority }) => [rule.id, priority])).toEqual([
      ['first', 0], ['a', 1], ['b', 2], ['older', 3],
    ]);
  });
});
