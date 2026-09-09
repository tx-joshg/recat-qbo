import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstanceSettings: vi.fn(),
  fetch: vi.fn(),
  company: { findUnique: vi.fn() },
  qboAccount: { findMany: vi.fn() },
  rule: { findMany: vi.fn() },
  transaction: { findMany: vi.fn(), update: vi.fn() },
}));

vi.mock('./instanceSettings.js', () => ({ getInstanceSettings: mocks.getInstanceSettings }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: mocks.company,
    qboAccount: mocks.qboAccount,
    rule: mocks.rule,
    transaction: mocks.transaction,
  },
}));

import {
  historySuggestion,
  normalizePayee,
  pickSuggestion,
  ruleSuggestion,
  refreshSuggestions,
  suggestFor,
  type HistoryTxnLike,
  type RuleLike,
} from './suggestions.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.getInstanceSettings.mockResolvedValue({
    suggestionSource: 'ai',
    aiEndpoint: 'https://models.example/v1',
    aiApiKey: 'test-key',
    suggestionModel: 'gpt-4o-mini',
  });
  mocks.company.findUnique.mockResolvedValue({ holdingAccountIds: [] });
  mocks.qboAccount.findMany.mockResolvedValue([
    { qboId: '1', name: 'Office supplies' },
  ]);
  mocks.rule.findMany.mockResolvedValue([]);
  mocks.transaction.findMany.mockResolvedValue([]);
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Office supplies' } }] }),
  });
});

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

describe('AI suggestion model', () => {
  it('sends the configured model in the existing chat completion request', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionSource: 'ai',
      aiEndpoint: 'https://models.example/v1',
      aiApiKey: 'test-key',
      suggestionModel: 'local-category-model',
    });

    await expect(suggestFor('company-1', { payee: 'MODEL TEST CONFIGURED', amount: -12.34 })).resolves.toMatchObject({
      category: 'Office supplies',
      source: 'ai',
    });

    expect(JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ model: 'local-category-model' });
  });

  it('sends gpt-4o-mini when the merged setting is at its default', async () => {
    await expect(suggestFor('company-1', { payee: 'MODEL TEST DEFAULT', amount: -56.78 })).resolves.toMatchObject({
      category: 'Office supplies',
      source: 'ai',
    });

    expect(JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ model: 'gpt-4o-mini' });
  });

  it('uses the pinned OpenRouter endpoint and passes a vendor-qualified model through', async () => {
    mocks.getInstanceSettings.mockResolvedValue({
      suggestionSource: 'ai',
      suggestionProvider: 'openrouter',
      aiEndpoint: 'https://custom.example/v1',
      aiApiKey: 'custom-key',
      openrouterApiKey: 'openrouter-key',
      openrouterReferer: 'https://recat.example',
      openrouterTitle: 'Recat QBO',
      suggestionModel: 'openai/gpt-4o-mini',
    });

    await expect(suggestFor('company-1', { payee: 'OPENROUTER DISPATCH', amount: -12.34 })).resolves.toMatchObject({
      category: 'Office supplies',
      source: 'ai',
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer openrouter-key',
          'HTTP-Referer': 'https://recat.example',
          'X-Title': 'Recat QBO',
        }),
        body: expect.stringContaining('openai/gpt-4o-mini'),
      }),
    );
  });

  it('caches a valid blank model answer as no suggestion', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    });

    await expect(suggestFor('company-1', { payee: 'BLANK MODEL ANSWER', amount: -12.34 })).resolves.toBeNull();
    await expect(suggestFor('company-1', { payee: 'BLANK MODEL ANSWER', amount: -12.34 })).resolves.toBeNull();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('AI cache binding', () => {
  const txn = { payee: 'Example supplier', amount: -25 };
  const supplies = { qboId: '1', name: 'Office supplies' };
  const freight = { qboId: '2', name: 'Freight' };

  beforeEach(() => {
    mocks.qboAccount.findMany.mockResolvedValue([supplies, freight]);
  });

  function answer(category: string) {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: category } }] }),
    });
  }

  it.each([
    ['model', { suggestionModel: 'replacement-model' }],
    ['endpoint', { aiEndpoint: 'https://replacement.example/v1' }],
    ['provider', { suggestionProvider: 'openrouter' }],
  ])('recomputes a cached suggestion when the effective %s changes', async (name, patch) => {
    const companyId = `cache-settings-${name}`;
    const settings = await mocks.getInstanceSettings();
    expect(await suggestFor(companyId, txn)).toMatchObject({ categoryQboId: '1' });

    mocks.getInstanceSettings.mockResolvedValue({ ...settings, ...patch });
    answer('Freight');

    expect(await suggestFor(companyId, txn)).toMatchObject({ categoryQboId: '2' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['removed', 'holding', 'renamed', 'replaced'])('does not reuse a category that was %s', async (change) => {
    const companyId = `cache-categories-${change}`;
    expect(await suggestFor(companyId, txn)).toMatchObject({ categoryQboId: '1' });
    if (change === 'holding') mocks.company.findUnique.mockResolvedValue({ holdingAccountIds: ['1'] });
    else if (change === 'renamed') mocks.qboAccount.findMany.mockResolvedValue([{ ...supplies, name: 'Stationery' }, freight]);
    else if (change === 'replaced') mocks.qboAccount.findMany.mockResolvedValue([{ ...supplies, qboId: '3' }, freight]);
    else mocks.qboAccount.findMany.mockResolvedValue([freight]);
    answer(change === 'replaced' ? 'Office supplies' : 'Freight');

    expect(await suggestFor(companyId, txn)).toMatchObject({ categoryQboId: change === 'replaced' ? '3' : '2' });
  });

  it('invalidates a cached no-suggestion answer when a category becomes available', async () => {
    const companyId = 'cache-new-category';
    mocks.qboAccount.findMany.mockResolvedValue([supplies]);
    answer('Freight');
    expect(await suggestFor(companyId, txn)).toBeNull();
    mocks.qboAccount.findMany.mockResolvedValue([supplies, freight]);
    expect(await suggestFor(companyId, txn)).toMatchObject({ categoryQboId: '2' });
  });

  it('keeps reusable cache entries company-scoped and independent of category query order', async () => {
    expect(await suggestFor('cache-reuse-a', txn)).toMatchObject({ categoryQboId: '1' });
    mocks.qboAccount.findMany.mockResolvedValue([freight, supplies]);
    answer('Freight');
    expect(await suggestFor('cache-reuse-a', txn)).toMatchObject({ categoryQboId: '1' });
    expect(await suggestFor('cache-reuse-b', txn)).toMatchObject({ categoryQboId: '2' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the same settings snapshot for cache identity and the provider request', async () => {
    const settings = await mocks.getInstanceSettings();
    mocks.getInstanceSettings
      .mockResolvedValueOnce({ ...settings, suggestionModel: 'first-model' })
      .mockResolvedValue({ ...settings, suggestionModel: 'second-model' });
    await suggestFor('cache-settings-race', txn);
    expect(JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ model: 'first-model' });
    answer('Freight');
    expect(await suggestFor('cache-settings-race', txn)).toMatchObject({ categoryQboId: '2' });
    expect(JSON.parse(mocks.fetch.mock.calls[1]?.[1]?.body as string)).toMatchObject({ model: 'second-model' });
  });

  it('replaces an obsolete binding instead of retaining every model version for a payee', async () => {
    const settings = await mocks.getInstanceSettings();
    await suggestFor('cache-replaced-binding', txn);
    mocks.getInstanceSettings.mockResolvedValue({ ...settings, suggestionModel: 'temporary-model' });
    answer('Freight');
    await suggestFor('cache-replaced-binding', txn);
    mocks.getInstanceSettings.mockResolvedValue(settings);

    expect(await suggestFor('cache-replaced-binding', txn)).toMatchObject({ categoryQboId: '2' });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('loads one category snapshot for all AI suggestions in a sync refresh', async () => {
    const companyId = 'cache-batch-categories';
    const rows = [
      { id: 'txn-a', payee: 'Example supplier alpha', memo: null, amount: -25, suggestion: null },
      { id: 'txn-b', payee: 'Example supplier beta', memo: null, amount: -30, suggestion: null },
    ];
    mocks.transaction.findMany.mockImplementation(async (args: { where: { status: unknown } }) => (
      args.where.status === 'PENDING' ? rows : []
    ));
    const written: unknown[] = [];
    mocks.transaction.update.mockImplementation(async (args: { data: { suggestion: unknown } }) => {
      written.push(args.data.suggestion);
    });

    await refreshSuggestions(companyId);

    expect(written).toEqual([
      { category: 'Office supplies', categoryQboId: '1', source: 'ai' },
      { category: 'Office supplies', categoryQboId: '1', source: 'ai' },
    ]);
    expect(mocks.company.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.qboAccount.findMany).toHaveBeenCalledTimes(1);
  });
});
