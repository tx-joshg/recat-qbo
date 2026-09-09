import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseHistoricalRuleRevisionState,
  parseRuleCurrentState,
  parseCanonicalSuggestionDto,
  type CanonicalSuggestionDto,
  type CategoryHintSuggestionDto,
  type HistoricalRuleRevisionState,
  parseRuleActionV2,
  type RuleActionV2,
  type RuleCurrentState,
  type RuleLifecycleFilter,
  type RuleLifecycleState,
  type RuleRevisionState,
  type RuleSuggestionDto,
  type SuggestionDto,
} from './index.js';

describe('rule state contracts', () => {
  it('limits current rules to enabled and disabled', () => {
    expect(parseRuleCurrentState('enabled')).toBe('enabled');
    expect(parseRuleCurrentState('disabled')).toBe('disabled');
    expect(() => parseRuleCurrentState('retired')).toThrow(/current rule state/i);

    expectTypeOf<RuleCurrentState>().toEqualTypeOf<'enabled' | 'disabled'>();
    expectTypeOf<RuleLifecycleState>().toEqualTypeOf<RuleCurrentState>();
  });

  it('keeps retired out of the current lifecycle filter', () => {
    expectTypeOf<RuleLifecycleFilter>().toEqualTypeOf<
      'enabled' | 'disabled' | 'all'
    >();
  });

  it('keeps retired readable in immutable revision history', () => {
    expect(parseHistoricalRuleRevisionState('retired')).toBe('retired');

    expectTypeOf<HistoricalRuleRevisionState>().toEqualTypeOf<
      'enabled' | 'disabled' | 'retired'
    >();
    expectTypeOf<RuleRevisionState>().toEqualTypeOf<HistoricalRuleRevisionState>();
  });
});

describe('suggestion contracts', () => {
  const action: RuleActionV2 = {
    version: 2,
    direction: 'Purchase',
    category: 'Software',
    categoryQboId: '42',
    taxCalculation: 'TaxExcluded',
    taxCodeQboId: 'GST',
    tagIds: ['operations'],
  };

  const ruleSuggestion: RuleSuggestionDto = {
    source: 'rule',
    version: 2,
    ruleId: 'rule-1',
    ruleRevision: 7,
    action,
    autoPost: false,
  };

  it('requires a versioned, revision-bound complete action for rule suggestions', () => {
    expect(parseCanonicalSuggestionDto(ruleSuggestion)).toEqual(ruleSuggestion);

    const noTaxDeposit: RuleSuggestionDto = {
      ...ruleSuggestion,
      action: {
        ...action,
        direction: 'Deposit',
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
      },
    };
    expect(parseCanonicalSuggestionDto(noTaxDeposit)).toEqual(noTaxDeposit);
  });

  it('rejects transitional legacy rule suggestion JSON', () => {
    expect(() => parseCanonicalSuggestionDto({
      source: 'rule',
      category: 'Software',
      categoryQboId: '42',
      ruleId: 'rule-1',
      matchedRules: 2,
      winnerMatchText: 'SOFTWARE.EXAMPLE',
    })).toThrow(/rule suggestion/i);
  });

  it.each([
    ['unknown suggestion field', { ...ruleSuggestion, unexpected: true }],
    ['wrong suggestion version', { ...ruleSuggestion, version: 1 }],
    ['wrong rule id type', { ...ruleSuggestion, ruleId: 42 }],
    ['wrong revision type', { ...ruleSuggestion, ruleRevision: '7' }],
    ['wrong auto-post type', { ...ruleSuggestion, autoPost: 'false' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCanonicalSuggestionDto(value)).toThrow(/rule suggestion/i);
  });

  it.each([
    ['unknown action field', { ...action, unexpected: true }],
    ['wrong action version', { ...action, version: 1 }],
    ['wrong direction', { ...action, direction: 'JournalEntry' }],
    ['wrong category type', { ...action, category: 42 }],
    ['wrong category id type', { ...action, categoryQboId: null }],
    ['wrong tax calculation', { ...action, taxCalculation: 'Unknown' }],
    ['wrong tax code id type', { ...action, taxCodeQboId: 42 }],
    ['wrong tag id type', { ...action, tagIds: ['operations', 42] }],
    ['wrong tag collection type', { ...action, tagIds: 'operations' }],
  ])('rejects %s', (_label, invalidAction) => {
    expect(() => parseRuleActionV2(invalidAction)).toThrow(/rule action/i);
    expect(() => parseCanonicalSuggestionDto({
      ...ruleSuggestion,
      action: invalidAction,
    })).toThrow(/rule suggestion/i);
  });

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe or non-positive rule revision %s',
    (ruleRevision) => {
      expect(() => parseCanonicalSuggestionDto({
        ...ruleSuggestion,
        ruleRevision,
      })).toThrow(/rule suggestion/i);
    },
  );

  it('rejects NotApplicable actions with a tax code', () => {
    const invalidAction = {
      ...action,
      taxCalculation: 'NotApplicable',
      taxCodeQboId: 'NON',
    };

    expect(() => parseRuleActionV2(invalidAction)).toThrow(/rule action/i);
    expect(() => parseCanonicalSuggestionDto({
      ...ruleSuggestion,
      action: invalidAction,
    })).toThrow(/rule suggestion/i);
  });

  it.each(['TaxInclusive', 'TaxExcluded'] as const)(
    'rejects %s actions without a tax code',
    (taxCalculation) => {
      const invalidAction = { ...action, taxCalculation, taxCodeQboId: null };

      expect(() => parseRuleActionV2(invalidAction)).toThrow(/rule action/i);
      expect(() => parseCanonicalSuggestionDto({
        ...ruleSuggestion,
        action: invalidAction,
      })).toThrow(/rule suggestion/i);
    },
  );

  it('rejects duplicate or blank action identifiers', () => {
    for (const invalidAction of [
      { ...action, category: '' },
      { ...action, category: '   ' },
      { ...action, categoryQboId: '' },
      { ...action, categoryQboId: '   ' },
      { ...action, taxCodeQboId: '' },
      { ...action, taxCodeQboId: '   ' },
      { ...action, tagIds: ['operations', 'operations'] },
      { ...action, tagIds: [''] },
      { ...action, tagIds: ['   '] },
    ]) {
      expect(() => parseRuleActionV2(invalidAction)).toThrow(/rule action/i);
      expect(() => parseCanonicalSuggestionDto({
        ...ruleSuggestion,
        action: invalidAction,
      })).toThrow(/rule suggestion/i);
    }
  });

  it.each(['', '   '])('rejects blank rule id %j', (ruleId) => {
    expect(() => parseCanonicalSuggestionDto({
      ...ruleSuggestion,
      ruleId,
    })).toThrow(/rule suggestion/i);
  });

  it.each(['history', 'ai'] as const)('accepts category-only %s hints', (source) => {
    const hint: CategoryHintSuggestionDto = {
      source,
      category: 'Software',
      categoryQboId: '42',
    };

    expect(parseCanonicalSuggestionDto(hint)).toEqual(hint);
    expect(parseCanonicalSuggestionDto({ source, category: 'Software' })).toEqual({
      source,
      category: 'Software',
    });
  });

  it.each(['history', 'ai'] as const)('strictly validates %s hints', (source) => {
    for (const invalidHint of [
      { source, category: 'Software', version: 2 },
      { source, category: 'Software', ruleId: 'rule-1' },
      { source, category: 'Software', categoryQboId: null },
      { source, categoryQboId: '42' },
      { source, category: 42 },
      { source, category: '' },
      { source, category: '   ' },
      { source, category: 'Software', categoryQboId: '' },
      { source, category: 'Software', categoryQboId: '   ' },
    ]) {
      expect(() => parseCanonicalSuggestionDto(invalidHint)).toThrow(/category hint/i);
    }
  });

  it('keeps the legacy suggestion DTO available during the bridge release', () => {
    const suggestion: SuggestionDto = {
      source: 'rule',
      category: 'Software',
      categoryQboId: '42',
      ruleId: 'rule-1',
      matchedRules: 2,
      winnerMatchText: 'SOFTWARE.EXAMPLE',
    };

    expect(suggestion.category).toBe('Software');
  });

  it('names the strict v2 union independently from the legacy bridge DTO', () => {
    expectTypeOf<CanonicalSuggestionDto>().toEqualTypeOf<
      RuleSuggestionDto | CategoryHintSuggestionDto
    >();
  });
});
