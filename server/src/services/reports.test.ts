import { describe, expect, it } from 'vitest';
import type { SavedReportConfig } from '@recat/shared';
import { computeCustomReport, fallbackLogKey, type ReportTagInput, type ReportTxnInput } from './reports.js';

// ---------------------------------------------------------------------------
// computeCustomReport — per-line split attribution
// ---------------------------------------------------------------------------

const TAG_X: ReportTagInput = { id: 'tag-x', name: 'Location A', color: '#f97316' };
const TAG_Y: ReportTagInput = { id: 'tag-y', name: 'Location B', color: '#0ea5e9' };
const TAGS = [TAG_X, TAG_Y];

function cfg(overrides: Partial<SavedReportConfig> = {}): SavedReportConfig {
  return { range: 'all', flow: 'both', account: 'all', groupBy: 'cat', tagIds: [], ...overrides };
}

function txn(overrides: Partial<ReportTxnInput> = {}): ReportTxnInput {
  return {
    id: 't-1',
    date: new Date('2026-07-03'),
    amount: -150,
    bankAccount: 'Checking ·1234',
    category: null,
    tagIds: [],
    splits: [],
    ...overrides,
  };
}

/** The scenario from the migration spec: −150 split into −125 'Advertising &
 * marketing' (tag X) and −25 'Retail products' (untagged). */
function splitTxn(): ReportTxnInput {
  return txn({
    id: 't-split',
    splits: [
      { amount: -125, category: 'Advertising & marketing', tagIds: [TAG_X.id] },
      { amount: -25, category: 'Retail products', tagIds: [] },
    ],
  });
}

describe('computeCustomReport — category grouping with splits', () => {
  it('attributes each split line to its own category (no Split bucket)', () => {
    const report = computeCustomReport(cfg({ groupBy: 'cat' }), [splitTxn()], TAGS);
    expect(report.rows).toEqual([
      { name: 'Advertising & marketing', color: null, count: 1, total: -125 },
      { name: 'Retail products', color: null, count: 1, total: -25 },
    ]);
    // Footer counts distinct transactions and sums txn amounts.
    expect(report.count).toBe(1);
    expect(report.total).toBe(-150);
  });

  it('merges split lines and single-category txns under the same category row', () => {
    const single = txn({ id: 't-2', amount: -40, category: 'Retail products' });
    const report = computeCustomReport(cfg({ groupBy: 'cat' }), [splitTxn(), single], TAGS);
    const retail = report.rows.find((r) => r.name === 'Retail products');
    expect(retail).toEqual({ name: 'Retail products', color: null, count: 2, total: -65 });
    expect(report.count).toBe(2);
    expect(report.total).toBe(-190);
  });
});

describe('computeCustomReport — tag grouping with splits', () => {
  it('counts a split line toward a tag group with only that line’s amount', () => {
    const report = computeCustomReport(cfg({ groupBy: 'tag' }), [splitTxn()], TAGS);
    expect(report.rows).toEqual([
      { name: 'Location A', color: TAG_X.color, count: 1, total: -125 },
      { name: 'Untagged', color: null, count: 1, total: -25 },
    ]);
    expect(report.count).toBe(1);
    expect(report.total).toBe(-150);
  });

  it('puts untagged single-category txns and untagged split lines in the same Untagged row', () => {
    const single = txn({ id: 't-2', amount: -10, category: 'Bank fees' });
    const report = computeCustomReport(cfg({ groupBy: 'tag' }), [splitTxn(), single], TAGS);
    const untagged = report.rows.find((r) => r.name === 'Untagged');
    expect(untagged).toEqual({ name: 'Untagged', color: null, count: 2, total: -35 });
  });

  it('ignores stray txn-level tags on a split txn — the split lines win', () => {
    const stray = { ...splitTxn(), tagIds: [TAG_Y.id] }; // shouldn't exist per model
    const report = computeCustomReport(cfg({ groupBy: 'tag' }), [stray], TAGS);
    expect(report.rows.find((r) => r.name === 'Location B')).toBeUndefined();
    expect(report.rows).toEqual([
      { name: 'Location A', color: TAG_X.color, count: 1, total: -125 },
      { name: 'Untagged', color: null, count: 1, total: -25 },
    ]);
  });
});

describe('computeCustomReport — tag filter with splits', () => {
  it('qualifies a txn when ANY split-line tag matches, but attribution stays per line', () => {
    const other = txn({ id: 't-2', amount: -99, category: 'Bank fees' }); // no matching tag → excluded
    const report = computeCustomReport(cfg({ groupBy: 'cat', tagIds: [TAG_X.id] }), [splitTxn(), other], TAGS);
    // The whole split txn qualifies (one line carries tag X)…
    expect(report.count).toBe(1);
    expect(report.total).toBe(-150);
    // …and both its lines still land under their own categories.
    expect(report.rows).toEqual([
      { name: 'Advertising & marketing', color: null, count: 1, total: -125 },
      { name: 'Retail products', color: null, count: 1, total: -25 },
    ]);
  });

  it('qualifies a single-category txn via its txn-level tags', () => {
    const tagged = txn({ id: 't-2', amount: -60, category: 'Bank fees', tagIds: [TAG_X.id] });
    const untagged = txn({ id: 't-3', amount: -70, category: 'Bank fees' });
    const report = computeCustomReport(cfg({ groupBy: 'cat', tagIds: [TAG_X.id] }), [tagged, untagged], TAGS);
    expect(report.count).toBe(1);
    expect(report.total).toBe(-60);
  });
});

describe('computeCustomReport — txn-level filters still apply to split txns as a whole', () => {
  it('flow filter uses the txn sign', () => {
    const moneyIn = txn({ id: 't-in', amount: 500, category: 'Sales' });
    const report = computeCustomReport(cfg({ groupBy: 'cat', flow: 'out' }), [splitTxn(), moneyIn], TAGS);
    expect(report.count).toBe(1);
    expect(report.rows.map((r) => r.name)).toEqual(['Advertising & marketing', 'Retail products']);
  });

  it('account filter keeps or drops the whole split txn', () => {
    const report = computeCustomReport(cfg({ groupBy: 'cat', account: 'Visa ·0392' }), [splitTxn()], TAGS);
    expect(report.count).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it('range filter applies at the txn level', () => {
    const report = computeCustomReport(cfg({ groupBy: 'cat', range: '2026-06' }), [splitTxn()], TAGS);
    expect(report.count).toBe(0);
  });
});

describe('computeCustomReport — account grouping and uncategorized', () => {
  it('groups split pieces under the txn bank account (count = pieces)', () => {
    const report = computeCustomReport(cfg({ groupBy: 'acct' }), [splitTxn()], TAGS);
    expect(report.rows).toEqual([{ name: 'Checking ·1234', color: null, count: 2, total: -150 }]);
  });

  it('labels txns with no category and no splits as Uncategorized', () => {
    const report = computeCustomReport(cfg({ groupBy: 'cat' }), [txn({ amount: -12 })], TAGS);
    expect(report.rows).toEqual([{ name: 'Uncategorized', color: null, count: 1, total: -12 }]);
  });
});

describe('fallbackLogKey — tag keys for report rows QBO returned without an id', () => {
  const row = { date: '2024-03-14', txnType: 'Expense', docNum: '42', payee: 'ACME CO', amount: -19.5 };

  it('is stable for identical row content', () => {
    expect(fallbackLogKey(row)).toBe(fallbackLogKey({ ...row }));
  });

  it('differs when any identity field differs', () => {
    const base = fallbackLogKey(row);
    expect(fallbackLogKey({ ...row, date: '2024-03-15' })).not.toBe(base);
    expect(fallbackLogKey({ ...row, txnType: 'Deposit' })).not.toBe(base);
    expect(fallbackLogKey({ ...row, docNum: '43' })).not.toBe(base);
    expect(fallbackLogKey({ ...row, payee: 'ACME LLC' })).not.toBe(base);
    expect(fallbackLogKey({ ...row, amount: -19.51 })).not.toBe(base);
  });

  it('treats a missing docNum the same as an empty one', () => {
    const { docNum: _d, ...noDoc } = row;
    expect(fallbackLogKey(noDoc)).toBe(fallbackLogKey({ ...row, docNum: '' }));
  });

  it('never collides with a real entity key and fits the API limit', () => {
    const key = fallbackLogKey(row);
    expect(key).toMatch(/^row:[0-9a-f]{40}$/);
    expect(key.length).toBeLessThanOrEqual(120);
  });
});
