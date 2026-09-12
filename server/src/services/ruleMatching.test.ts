import { describe, expect, it } from 'vitest';
import {
  compareRuleWinner,
  normalizeRuleMatchText,
  prepareRuleMatchRule,
  prepareRuleMatchTransaction,
  preparedRuleMatches,
  ruleMatches,
  transactionDirection,
} from './ruleMatching.js';

describe('normalizeRuleMatchText', () => {
  it('normalizes canonically equivalent text to NFC', () => {
    expect(normalizeRuleMatchText('Cafe\u0301')).toBe('café');
    expect(normalizeRuleMatchText('Cafe\u0301')).toBe(normalizeRuleMatchText('Café'));
  });

  it('trims and collapses tabs, newlines, and repeated spaces', () => {
    expect(normalizeRuleMatchText('  North\t\n  Shore   Cafe  ')).toBe('north shore cafe');
  });

  it('case-folds text for matching', () => {
    expect(normalizeRuleMatchText('MiXeD CaSe')).toBe('mixed case');
  });

  it('case-folds sigma consistently in word-final context', () => {
    expect(normalizeRuleMatchText('ΟΣ')).toBe(normalizeRuleMatchText('οσ'));
  });

  it('expands sharp-s consistently for caseless matching', () => {
    expect(normalizeRuleMatchText('Straße')).toBe(normalizeRuleMatchText('STRASSE'));
  });

  it('folds capital sharp-s idempotently', () => {
    const folded = normalizeRuleMatchText('ẞ');

    expect(folded).toBe('ss');
    expect(normalizeRuleMatchText(folded)).toBe(folded);
  });

  it('does not apply the Turkic fold that merges dotless-i with I', () => {
    expect(normalizeRuleMatchText('ı')).toBe('ı');
    expect(normalizeRuleMatchText('I')).toBe('i');
    expect(normalizeRuleMatchText('ı')).not.toBe(normalizeRuleMatchText('I'));
  });

  it('expands multi-character ligature mappings', () => {
    expect(normalizeRuleMatchText('ﬃ')).toBe('ffi');
  });

  it.each(['\ud800', '\udfff'])('rejects lone UTF-16 surrogate %j', (value) => {
    expect(() => normalizeRuleMatchText(value)).toThrow(TypeError);
  });

  it('preserves punctuation literally', () => {
    expect(normalizeRuleMatchText('Acme, Inc.')).toBe('acme, inc.');
  });

});

describe('transactionDirection', () => {
  it('maps supported QuickBooks transaction types to rule directions', () => {
    expect(transactionDirection('Purchase')).toBe('Purchase');
    expect(transactionDirection('Deposit')).toBe('Deposit');
  });

  it.each(['JournalEntry', 'RefundReceipt', 'purchase', ''])('rejects unsupported type %j', (type) => {
    expect(transactionDirection(type)).toBeNull();
  });
});

describe('ruleMatches', () => {
  it.each(['Purchase', 'Deposit'] as const)(
    'matches normalized description substrings for %s transactions',
    (direction) => {
      expect(ruleMatches(
        { matchText: 'CAFÉ\tNORTH', direction },
        { description: 'Card payment at Cafe\u0301\n  North #42', type: direction },
      )).toBe(true);
    },
  );

  it('treats punctuation literally', () => {
    const transaction = { description: 'Payment to ACME INC.', type: 'Purchase' };

    expect(ruleMatches({ matchText: 'Acme Inc.', direction: 'Purchase' }, transaction)).toBe(true);
    expect(ruleMatches({ matchText: 'Acme, Inc.', direction: 'Purchase' }, transaction)).toBe(false);
  });

  it.each([
    { matchText: 'οσ', description: 'Market ΟΣ receipt' },
    { matchText: 'STRASSE', description: 'Berliner Straße cafe' },
  ])('matches $matchText caselessly within $description', ({ matchText, description }) => {
    expect(ruleMatches(
      { matchText, direction: 'Purchase' },
      { description, type: 'Purchase' },
    )).toBe(true);
  });

  it('does not let an empty normalized match select every transaction', () => {
    expect(ruleMatches(
      { matchText: ' \t\n ', direction: 'Purchase' },
      { description: 'Any vendor', type: 'Purchase' },
    )).toBe(false);
  });

  it('rejects a rule without a canonical direction', () => {
    expect(ruleMatches(
      { matchText: 'vendor', direction: null },
      { description: 'Vendor payment', type: 'Purchase' },
    )).toBe(false);
  });

  it.each([
    ['Purchase', 'Deposit'],
    ['Deposit', 'Purchase'],
  ] as const)('rejects a %s rule for a %s transaction', (ruleDirection, type) => {
    expect(ruleMatches(
      { matchText: 'vendor', direction: ruleDirection },
      { description: 'Vendor payment', type },
    )).toBe(false);
  });

  it.each(['JournalEntry', 'Unknown'])('rejects unsupported transaction type %s', (type) => {
    expect(ruleMatches(
      { matchText: 'vendor', direction: 'Purchase' },
      { description: 'Vendor payment', type },
    )).toBe(false);
  });
});

describe('prepared rule matching', () => {
  it.each([
    {
      name: 'Purchase direction',
      rule: { matchText: 'vendor', direction: 'Purchase' as const },
      transaction: { description: 'Vendor payment', type: 'Purchase' },
      expected: true,
    },
    {
      name: 'Deposit direction',
      rule: { matchText: 'customer', direction: 'Deposit' as const },
      transaction: { description: 'Customer receipt', type: 'Deposit' },
      expected: true,
    },
    {
      name: 'direction mismatch',
      rule: { matchText: 'vendor', direction: 'Purchase' as const },
      transaction: { description: 'Vendor receipt', type: 'Deposit' },
      expected: false,
    },
    {
      name: 'Unicode full fold',
      rule: { matchText: 'STRASSE οσ', direction: 'Purchase' as const },
      transaction: { description: 'Berliner Straße ΟΣ receipt', type: 'Purchase' },
      expected: true,
    },
    {
      name: 'empty match key',
      rule: { matchText: '  \t ', direction: 'Purchase' as const },
      transaction: { description: 'Vendor payment', type: 'Purchase' },
      expected: false,
    },
    {
      name: 'JournalEntry rejection',
      rule: { matchText: 'vendor', direction: 'Purchase' as const },
      transaction: { description: 'Vendor journal', type: 'JournalEntry' },
      expected: false,
    },
  ])('agrees with the one-off wrapper for $name', ({ rule, transaction, expected }) => {
    const preparedRule = prepareRuleMatchRule(rule);
    const preparedTransaction = prepareRuleMatchTransaction(transaction);

    expect(preparedRuleMatches(preparedRule, preparedTransaction)).toBe(expected);
    expect(ruleMatches(rule, transaction)).toBe(expected);
  });

  it('reuses one prepared transaction across already-normalized rule keys', () => {
    const preparedTransaction = prepareRuleMatchTransaction({
      description: 'Card payment at Berliner Straße',
      type: 'Purchase',
    });
    const matchingKeys = [
      { matchText: 'coffee', direction: 'Purchase' as const },
      { matchText: 'STRASSE', direction: 'Purchase' as const },
      { matchText: 'strasse', direction: 'Deposit' as const },
    ]
      .map(prepareRuleMatchRule)
      .filter((rule) => preparedRuleMatches(rule, preparedTransaction))
      .map(({ matchKey }) => matchKey);

    expect(matchingKeys).toEqual(['strasse']);
  });
});

describe('compareRuleWinner', () => {
  const older = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T00:00:00.000Z');

  it('orders by priority ascending, createdAt descending, then id ascending', () => {
    const rules = [
      { id: 'z', priority: 1, createdAt: newer },
      { id: 'b', priority: 1, createdAt: newer },
      { id: 'a', priority: 1, createdAt: newer },
      { id: 'newer', priority: 1, createdAt: newer },
      { id: 'older', priority: 1, createdAt: older },
      { id: 'lowest-priority-number', priority: 0, createdAt: older },
    ];

    expect([...rules].sort(compareRuleWinner).map(({ id }) => id)).toEqual([
      'lowest-priority-number',
      'a',
      'b',
      'newer',
      'z',
      'older',
    ]);
  });

  it('returns zero when all ordering fields are equal', () => {
    const rule = { id: 'same', priority: 1, createdAt: newer };

    expect(compareRuleWinner(rule, { ...rule })).toBe(0);
  });
});
