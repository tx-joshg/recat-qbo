import { describe, expect, it } from 'vitest';
import { buildAgentSnapshot, type AgentSnapshotSource } from './snapshot.js';
import {
  AgentToolError,
  createSnapshotTools,
  type AgentToolDefinition,
} from './tools.js';

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sourceWithManyItems(): AgentSnapshotSource {
  const categories = Array.from({ length: 25 }, (_, index) => ({
    qboId: `category-${String(index + 1).padStart(2, '0')}`,
    name: `Expense ${String(index + 1).padStart(2, '0')}`,
  }));

  return {
    transaction: { id: TRANSACTION_ID, revision: 3 },
    date: '2026-07-20',
    signedAmountCents: -10000,
    currency: 'CAD',
    sourceAccount: { displayName: 'Operating account', type: 'BANK' },
    payee: 'Example merchant',
    memo: 'Generic fixture',
    candidateCategories: categories,
    tax: {
      status: 'needs_setup',
      supportedCalculationModes: [],
      eligibleReferences: [],
    },
    tags: [{ id: TAG_ID, name: 'Project' }],
    rules: categories.map((category, index) => ({
      id: uuid(index + 1),
      ruleRevision: 1,
      priority: index + 1,
      matchField: 'payee' as const,
      matchText: `Merchant ${String(index + 1).padStart(2, '0')}`,
      action: {
        version: 2 as const,
        direction: 'Purchase' as const,
        category: category.name,
        categoryQboId: category.qboId,
        taxCalculation: 'NotApplicable' as const,
        taxCodeQboId: null,
        tagIds: [TAG_ID],
      },
      autoPost: false,
    })),
    similarVerifiedTransactions: categories.map((_category, index) => ({
      transactionId: uuid(index + 31),
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      signedAmountCents: -10000,
      currency: 'CAD',
      payee: `Merchant ${String(index + 1).padStart(2, '0')}`,
      memo: `Expense history ${String(index + 1).padStart(2, '0')}`,
      taxCalculation: 'NotApplicable' as const,
      lines: [{
        signedGrossCents: -10000,
        categoryQboId: categories[index % 20]!.qboId,
        taxCodeQboId: null,
        tagIds: [TAG_ID],
      }],
      tagIds: [TAG_ID],
      verifiedAt: `2026-06-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
    })),
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config.1',
  };
}

function sourceWithTaxCodes(): AgentSnapshotSource {
  const source = sourceWithManyItems();
  return {
    ...source,
    candidateCategories: source.candidateCategories.slice(0, 2),
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxExcluded'],
      eligibleReferences: [
        { qboId: 'tax-02', label: 'Secondary tax' },
        { qboId: 'tax-01', label: 'Primary tax' },
      ],
    },
    rules: source.rules.slice(0, 2).map((rule) => ({
      ...rule,
      action: {
        ...rule.action,
        taxCalculation: 'TaxExcluded',
        taxCodeQboId: 'tax-01',
      },
    })),
    similarVerifiedTransactions: source.similarVerifiedTransactions.slice(0, 2).map((transaction) => ({
      ...transaction,
      taxCalculation: 'TaxExcluded',
      lines: transaction.lines.map((line) => ({ ...line, taxCodeQboId: 'tax-01' })),
    })),
  };
}

function expectSafeToolError(error: unknown, code: AgentToolError['code'], secret?: string): void {
  expect(error).toBeInstanceOf(AgentToolError);
  expect(error).toMatchObject({ code });
  if (secret !== undefined) expect((error as Error).message).not.toContain(secret);
}

describe('createSnapshotTools', () => {
  it('publishes strict OpenAI-compatible function definitions', () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));

    expect(tools.definitions.map((definition) => definition.function.name)).toEqual([
      'search_categories',
      'list_tax_codes',
      'list_rules',
      'find_similar_transactions',
    ]);

    for (const definition of tools.definitions) {
      expectStrictFunctionDefinition(definition);
    }
  });

  it('searches categories case-insensitively and caps a caller-requested limit above twenty', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));

    const result = await tools.call('search_categories', { query: 'eXpEnSe', limit: 100 });

    expect(result.items).toHaveLength(20);
    expect(result.items.map((item) => (item as { name: string }).name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Expense ${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('lists every eligible tax code in deterministic order', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithTaxCodes()));

    const result = await tools.call('list_tax_codes', {});

    expect(result.items).toEqual([
      { qboId: 'tax-01', label: 'Primary tax' },
      { qboId: 'tax-02', label: 'Secondary tax' },
    ]);
  });

  it('lists only retained rules in priority order', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));

    const result = await tools.call('list_rules', {});

    expect(result.items).toHaveLength(20);
    expect(result.items.map((item) => (item as { priority: number }).priority)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('finds similar transactions by payee or memo and caps results above twenty', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));

    const byPayee = await tools.call('find_similar_transactions', { query: 'merchant', limit: 100 });
    const byMemo = await tools.call('find_similar_transactions', { query: 'history 20', limit: 100 });

    expect(byPayee.items).toHaveLength(20);
    expect(byPayee.items.map((item) => (item as { verifiedAt: string }).verifiedAt)).toEqual(
      [...byPayee.items]
        .map((item) => (item as { verifiedAt: string }).verifiedAt)
        .sort()
        .reverse(),
    );
    expect(byMemo.items).toHaveLength(1);
    expect(byMemo.items[0]).toMatchObject({ payee: 'Merchant 20' });
  });

  it('rejects unknown tools, unknown arguments, and malformed nonliteral inputs safely', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));
    const secret = 'private-fixture-value';
    const getterInput = Object.defineProperty({}, 'query', {
      enumerable: true,
      get: () => secret,
    });
    const cases: Array<{
      action: () => Promise<unknown>;
      code: AgentToolError['code'];
    }> = [
      { action: () => tools.call(secret, {}), code: 'AGENT_TOOL_UNKNOWN' },
      {
        action: () => tools.call('search_categories', { query: secret, limit: 2, unexpected: secret }),
        code: 'AGENT_TOOL_INVALID_INPUT',
      },
      {
        action: () => tools.call('search_categories', { query: secret, limit: '2' }),
        code: 'AGENT_TOOL_INVALID_INPUT',
      },
      {
        action: () => tools.call('search_categories', JSON.stringify({ query: secret, limit: 2 })),
        code: 'AGENT_TOOL_INVALID_INPUT',
      },
      {
        action: () => tools.call('search_categories', getterInput),
        code: 'AGENT_TOOL_INVALID_INPUT',
      },
      {
        action: () => tools.call('list_rules', []),
        code: 'AGENT_TOOL_INVALID_INPUT',
      },
    ];

    for (const testCase of cases) {
      try {
        await testCase.action();
        throw new Error('Expected tool call to fail.');
      } catch (error) {
        expectSafeToolError(error, testCase.code, secret);
      }
    }
  });

  it('sanitizes hostile descriptors, non-enumerable keys, and inherited pollution before validation', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));
    const secret = 'sensitive-proxy-detail';
    const hostileProxy = new Proxy(
      { query: 'expense', limit: 1 },
      {
        get(target, property, receiver) {
          if (property === 'query') throw new Error(secret);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const hostileReflection = new Proxy(
      { query: 'expense', limit: 1 },
      {
        ownKeys() {
          throw new Error(secret);
        },
      },
    );
    const nonEnumerableExtra = { query: 'expense', limit: 1 };
    Object.defineProperty(nonEnumerableExtra, 'hidden', {
      configurable: true,
      enumerable: false,
      value: secret,
    });

    await expect(tools.call('search_categories', hostileProxy)).resolves.toMatchObject({
      items: [{ name: 'Expense 01' }],
    });

    for (const input of [hostileReflection, nonEnumerableExtra]) {
      try {
        await tools.call('search_categories', input);
        throw new Error('Expected tool call to fail.');
      } catch (error) {
        expectSafeToolError(error, 'AGENT_TOOL_INVALID_INPUT', secret);
      }
    }

    Object.defineProperties(Object.prototype, {
      query: { configurable: true, enumerable: false, value: 'expense' },
      limit: { configurable: true, enumerable: false, value: 1 },
    });
    try {
      await expect(tools.call('search_categories', {})).rejects.toMatchObject({
        code: 'AGENT_TOOL_INVALID_INPUT',
      });
    } finally {
      delete (Object.prototype as Record<string, unknown>).query;
      delete (Object.prototype as Record<string, unknown>).limit;
    }
  });

  it('matches provider maxLength semantics for ASCII and astral Unicode query strings', async () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));
    const searchDefinition = tools.definitions.find(
      (definition) => definition.function.name === 'search_categories',
    );

    expect(searchDefinition?.function.parameters.properties.query).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 160,
    });
    await expect(tools.call('search_categories', { query: 'a'.repeat(160), limit: 1 }))
      .resolves.toEqual({ items: [] });
    await expect(tools.call('search_categories', { query: 'a'.repeat(161), limit: 1 }))
      .rejects.toMatchObject({ code: 'AGENT_TOOL_INVALID_INPUT' });
    await expect(tools.call('search_categories', { query: '\u{1F642}'.repeat(160), limit: 1 }))
      .resolves.toEqual({ items: [] });
    await expect(tools.call('search_categories', { query: '\u{1F642}'.repeat(161), limit: 1 }))
      .rejects.toMatchObject({ code: 'AGENT_TOOL_INVALID_INPUT' });
  });

  it('keeps registries isolated to their supplied snapshots', async () => {
    const firstSource = sourceWithManyItems();
    const secondSource = sourceWithManyItems();
    secondSource.candidateCategories = [{ qboId: 'separate', name: 'Separate category' }];
    secondSource.rules = [];
    secondSource.similarVerifiedTransactions = [];

    const firstTools = createSnapshotTools(buildAgentSnapshot(firstSource));
    const secondTools = createSnapshotTools(buildAgentSnapshot(secondSource));

    expect((await firstTools.call('search_categories', { query: 'Separate', limit: 100 })).items).toEqual([]);
    expect((await secondTools.call('search_categories', { query: 'Separate', limit: 100 })).items).toEqual([
      { qboId: 'separate', name: 'Separate category' },
    ]);
  });

  it('returns detached deeply frozen results without mutating the snapshot', async () => {
    const snapshot = buildAgentSnapshot(sourceWithManyItems());
    const before = JSON.stringify(snapshot);
    const tools = createSnapshotTools(snapshot);
    const result = await tools.call('find_similar_transactions', { query: 'merchant', limit: 1 });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen((result.items[0] as { lines: unknown[] }).lines[0])).toBe(true);
    expect(() => (result.items as unknown[]).push('mutation')).toThrow(TypeError);
    expect(() => {
      (result.items[0] as { payee: string }).payee = 'mutation';
    }).toThrow(TypeError);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect((await tools.call('find_similar_transactions', { query: 'merchant', limit: 1 })).items[0])
      .toMatchObject({ payee: 'Merchant 25' });
  });
});

function expectStrictFunctionDefinition(definition: AgentToolDefinition): void {
  expect(definition).toMatchObject({
    type: 'function',
    function: {
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
      },
    },
  });

  const parameters = definition.function.parameters;
  expect(parameters.required).toEqual(Object.keys(parameters.properties));
  expect(JSON.stringify(parameters)).not.toMatch(
    /uniqueItems|oneOf|allOf|\$schema|\$id|default|format|patternProperties/,
  );
}
