import { describe, expect, it } from 'vitest';
import { historySuggestion, normalizePayee, pickSuggestion, ruleSuggestion, type HistoryTxnLike, type RuleLike } from './suggestions.js';

function rule(overrides: Partial<RuleLike> & { matchText: string; category: string }): RuleLike {
  return {
    id: overrides.id ?? 'r1',
    matchText: overrides.matchText,
    category: overrides.category,
    categoryQboId: overrides.categoryQboId ?? null,
    priority: overrides.priority ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-01-01'),
  };
}

describe('normalizePayee', () => {
  it('strips store numbers and #/* markers', () => {
    expect(normalizePayee('SYSCO FOODS #212')).toBe('SYSCO FOODS');
    expect(normalizePayee('SHELL OIL 5742')).toBe('SHELL OIL');
    expect(normalizePayee('AMZN MKTP US*2K4')).toBe('AMZN MKTP US');
    expect(normalizePayee('SQ *SQUARE INC')).toBe('SQ SQUARE INC');
    expect(normalizePayee('TST* THE LOCAL TAP')).toBe('TST THE LOCAL TAP');
  });

  it('uppercases so matching is case-insensitive', () => {
    expect(normalizePayee('sysco foods #99')).toBe('SYSCO FOODS');
    expect(normalizePayee('Sysco Foods #212')).toBe(normalizePayee('SYSCO FOODS #8'));
  });
});

describe('ruleSuggestion', () => {
  it('matches payee-contains, case-insensitively', () => {
    const r = rule({ matchText: 'sysco', category: 'Food purchases' });
    expect(ruleSuggestion('SYSCO FOODS #212', [r])).toMatchObject({ category: 'Food purchases', source: 'rule', ruleId: 'r1' });
    expect(ruleSuggestion('COMCAST BUSINESS', [r])).toBeNull();
  });

  it('prefers the matching rule with the lowest priority number', () => {
    const second = rule({ id: 'lo', matchText: 'SQ', category: 'Sales — food', priority: 1 });
    const top = rule({ id: 'hi', matchText: 'SQUARE', category: 'Sales — beverage', priority: 0 });
    const got = ruleSuggestion('SQ *SQUARE INC', [second, top]);
    expect(got).toMatchObject({ category: 'Sales — beverage', ruleId: 'hi' });
  });

  it('reordering (swapping priorities) flips the winner', () => {
    const a = rule({ id: 'a', matchText: 'SQ', category: 'Sales — food', priority: 0 });
    const b = rule({ id: 'b', matchText: 'SQUARE', category: 'Sales — beverage', priority: 1 });
    expect(ruleSuggestion('SQ *SQUARE INC', [a, b])).toMatchObject({ ruleId: 'a', category: 'Sales — food' });
    const aDown = { ...a, priority: 1 };
    const bUp = { ...b, priority: 0 };
    expect(ruleSuggestion('SQ *SQUARE INC', [aDown, bUp])).toMatchObject({ ruleId: 'b', category: 'Sales — beverage' });
  });

  it('reports matchedRules and winnerMatchText for multi-rule overlaps', () => {
    const top = rule({ id: 'hi', matchText: 'SYSCO', category: 'Food purchases', priority: 0 });
    const second = rule({ id: 'lo', matchText: 'SY', category: 'Beverage purchases', priority: 1 });
    const miss = rule({ id: 'no', matchText: 'COMCAST', category: 'Utilities', priority: 2 });
    const got = ruleSuggestion('SYSCO FOODS #212', [second, miss, top]);
    expect(got).toMatchObject({
      ruleId: 'hi',
      category: 'Food purchases',
      matchedRules: 2,
      winnerMatchText: 'SYSCO',
    });
  });

  it('reports matchedRules 1 for a single-rule match', () => {
    const r = rule({ matchText: 'sysco', category: 'Food purchases' });
    expect(ruleSuggestion('SYSCO FOODS #212', [r])).toMatchObject({
      matchedRules: 1,
      winnerMatchText: 'sysco',
    });
  });

  it('breaks priority ties by newest createdAt', () => {
    const older = rule({ id: 'old', matchText: 'SQ', category: 'Sales — food', priority: 0, createdAt: new Date('2026-01-01') });
    const newer = rule({ id: 'new', matchText: 'SQUARE', category: 'Sales — beverage', priority: 0, createdAt: new Date('2026-06-01') });
    const got = ruleSuggestion('SQ *SQUARE INC', [older, newer]);
    expect(got).toMatchObject({ category: 'Sales — beverage', ruleId: 'new' });
  });
});

describe('historySuggestion', () => {
  const history: HistoryTxnLike[] = [
    { payee: 'ULINE SHIP SUPPLIES', category: 'Packaging & supplies', categoryQboId: '12' },
    { payee: 'ULINE SHIP SUPPLIES #2', category: 'Packaging & supplies', categoryQboId: '12' },
    { payee: 'ULINE SHIP SUPPLIES', category: 'Office supplies', categoryQboId: '19' },
    { payee: 'COMCAST BUSINESS', category: 'Utilities', categoryQboId: '26' },
  ];

  it('returns the most frequent category for the normalized payee', () => {
    const got = historySuggestion('ULINE SHIP SUPPLIES 881', history);
    expect(got).toMatchObject({ category: 'Packaging & supplies', source: 'history', categoryQboId: '12' });
  });

  it('returns null with no matching history', () => {
    expect(historySuggestion('GUSTO PAYROLL', history)).toBeNull();
  });
});

describe('pickSuggestion precedence', () => {
  const rules = [rule({ id: 'r-sysco', matchText: 'SYSCO', category: 'Food purchases', categoryQboId: '10' })];
  const history: HistoryTxnLike[] = [
    { payee: 'SYSCO FOODS #212', category: 'Beverage purchases', categoryQboId: '11' },
    { payee: 'SYSCO FOODS #212', category: 'Beverage purchases', categoryQboId: '11' },
  ];

  it('rule beats history even when history disagrees', () => {
    const got = pickSuggestion('SYSCO FOODS #212', rules, history, true);
    expect(got).toMatchObject({ category: 'Food purchases', source: 'rule', ruleId: 'r-sysco' });
  });

  it('falls back to history when no rule matches', () => {
    const got = pickSuggestion('SYSCO FOODS #212', [], history, true);
    expect(got).toMatchObject({ category: 'Beverage purchases', source: 'history' });
  });

  it('returns null when history is disabled and no rule matches', () => {
    expect(pickSuggestion('SYSCO FOODS #212', [], history, false)).toBeNull();
  });
});
