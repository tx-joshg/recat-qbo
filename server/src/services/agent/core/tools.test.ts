import { describe, expect, it, vi } from 'vitest';
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

function conflictingCandidate(conflictingEvidenceCount: number) {
  return {
    id: 'rule_candidate:candidate-1', sourceId: 'candidate-1', kind: 'rule_candidate' as const,
    companyId: 'company-a', companyName: 'Company A', companyRelation: 'current' as const,
    executable: false, advisory: true, matchedIn: ['candidate' as const], score: 0.5,
    vendorIdentityId: null, vendorName: 'Example merchant',
    action: {
      categoryQboId: 'category-01', taxCalculation: 'NotApplicable' as const,
      taxCodeQboId: null, tagIds: [],
    },
    actionSummary: {
      categoryName: 'Expense 01', taxCalculation: 'NotApplicable' as const,
      taxCodeName: null, tagNames: [],
    },
    originIntent: 'auto_candidate' as const, evidenceCount: 5, conflictingEvidenceCount,
    conflicts: [{
      id: 'conflict-1', companyId: 'company-a', sourceId: 'evidence-1', kind: 'case' as const,
      reason: 'A bounded returned contradiction.', action: null, actionSummary: null, evidenceCount: 1,
    }],
    provenance: {
      source: 'candidate' as const, sourceId: 'candidate-1', actorId: null,
      recordedAt: '2026-08-31T00:00:00.000Z',
    },
    rationale: null, examples: [], counterexamples: [], jurisdiction: null, currency: null,
    verifiedAt: null, ruleRevision: null, observation: null,
  };
}

describe('createSnapshotTools', () => {
  it('publishes strict OpenAI-compatible function definitions', () => {
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()));

    expect(tools.definitions.map((definition) => definition.function.name)).toEqual([
      'search_categories',
      'list_tax_codes',
      'list_rules',
      'find_similar_transactions',
      'search_classification_knowledge',
    ]);

    for (const definition of tools.definitions) {
      expectStrictFunctionDefinition(definition);
    }
  });

  it('routes both similarity names through canonical evidence search with bounded transaction context', async () => {
    const snapshot = buildAgentSnapshot(sourceWithTaxCodes());
    const classificationSearch = vi.fn(async (request) => ({
      query: request.query,
      companyId: 'company-a',
      scope: 'current_company' as const,
      mode: request.mode === 'auto' ? 'lexical' as const : request.mode,
      requestedMode: request.mode,
      degraded: request.mode === 'auto',
      degradedReason: request.mode === 'auto' ? 'embedding_not_configured' as const : null,
      status: 'no_match' as const,
      noMatch: true,
      hits: [],
      total: 0,
    }));
    const tools = createSnapshotTools(snapshot, { classificationSearch });

    const legacy = await tools.call('find_similar_transactions', { query: 'Coffee', limit: 5 });
    const explicit = await tools.call('search_classification_knowledge', {
      query: 'Coffee', mode: 'lexical', limit: 5,
    });

    expect(legacy).toMatchObject({
      items: [],
      search: {
        requestedMode: 'auto', mode: 'lexical', degraded: true, noMatch: true,
        context: {
          transactionDirection: 'out', qboType: null, sourceAccountName: null,
          currency: 'CAD', transactionPeriod: '2026-07', jurisdiction: null, taxStatus: 'ready',
        },
      },
    });
    expect(explicit).toMatchObject({
      items: [],
      search: { requestedMode: 'lexical', mode: 'lexical', degraded: false, noMatch: true },
    });
    expect(classificationSearch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      query: 'Coffee', mode: 'auto', limit: 5,
      transaction: {
        transactionId: TRANSACTION_ID,
        date: '2026-07-20',
        signedAmountCents: -10000,
        currency: 'CAD',
        sourceAccountName: null,
        payee: 'Example merchant',
        memo: 'Generic fixture',
        transactionDirection: 'out',
        qboType: null,
        transactionPeriod: '2026-07',
        jurisdiction: null,
        taxStatus: 'ready',
      },
    }));
  });

  it('rejects schema-invalid canonical search output without exposing its contents', async () => {
    const secret = 'PRIVATE_CANONICAL_OUTPUT_SENTINEL';
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => ({ secret }) as never,
    });

    const error = await tools.call('search_classification_knowledge', {
      query: 'Coffee', mode: 'lexical', limit: 5,
    }).catch((failure: unknown) => failure);

    expectSafeToolError(error, 'AGENT_TOOL_INVALID_OUTPUT', secret);
  });

  it('accepts aggregate conflict counts above bounded returned conflicts and rejects undercounts', async () => {
    const result = (conflictingEvidenceCount: number) => ({
      query: 'merchant', companyId: 'company-a', scope: 'current_company' as const,
      mode: 'lexical' as const, requestedMode: 'lexical' as const,
      degraded: false, degradedReason: null, status: 'matched' as const, noMatch: false,
      hits: [conflictingCandidate(conflictingEvidenceCount)], total: 1,
    });
    const accepted = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => result(3),
    });
    await expect(accepted.call('search_classification_knowledge', {
      query: 'merchant', mode: 'lexical', limit: 5,
    })).resolves.toMatchObject({
      items: [{ conflictingEvidenceCount: 3, conflicts: [expect.any(Object)] }],
    });

    const rejected = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => result(0),
    });
    await expect(rejected.call('search_classification_knowledge', {
      query: 'merchant', mode: 'lexical', limit: 5,
    })).rejects.toMatchObject({ code: 'AGENT_TOOL_INVALID_OUTPUT' });
  });

  it('returns display-only historical observations and rejects executable observation data', async () => {
    const observation = {
      ...conflictingCandidate(0),
      id: 'historical_observation:observation-1', sourceId: 'observation-1',
      kind: 'historical_observation' as const, matchedIn: ['observation'] as const,
      action: null, originIntent: null, evidenceCount: 0, conflicts: [],
      provenance: {
        source: 'historical_observation' as const, sourceId: 'observation-1', actorId: null,
        recordedAt: '2026-08-31T00:00:00.000Z',
      },
      observation: {
        sourceTransactionId: TRANSACTION_ID, sourceQboType: 'Purchase' as const, sourceQboId: 'purchase-1',
        sourceTransactionRevision: 1, sourceQboSyncToken: '1', sourceStatus: 'POSTED' as const,
        sourceUpdatedAt: '2026-08-31T00:00:00.000Z', observedAt: '2026-08-31T00:00:00.000Z',
      },
    };
    const result = (item: typeof observation) => ({
      query: 'merchant', companyId: 'company-a', scope: 'current_company' as const,
      mode: 'lexical' as const, requestedMode: 'lexical' as const,
      degraded: false, degradedReason: null, status: 'matched' as const, noMatch: false,
      hits: [item], total: 1,
    });
    const accepted = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => result(observation),
    });
    await expect(accepted.call('find_similar_transactions', {
      query: 'merchant', limit: 5,
    })).resolves.toMatchObject({ items: [{ kind: 'historical_observation', executable: false, action: null }] });
    await expect(accepted.call('search_classification_knowledge', {
      query: 'merchant', mode: 'lexical', limit: 5,
    })).resolves.toMatchObject({ items: [{ kind: 'historical_observation', executable: false, action: null }] });

    const rejected = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => result({
        ...observation,
        action: { categoryQboId: 'category-01', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      }),
    });
    await expect(rejected.call('search_classification_knowledge', {
      query: 'merchant', mode: 'lexical', limit: 5,
    })).rejects.toMatchObject({ code: 'AGENT_TOOL_INVALID_OUTPUT' });
  });

  it('reports an unavailable canonical search dependency without relabelling it invalid output', async () => {
    const secret = 'PRIVATE_CANONICAL_FAILURE_SENTINEL';
    const tools = createSnapshotTools(buildAgentSnapshot(sourceWithManyItems()), {
      classificationSearch: async () => { throw new Error(secret); },
    });

    const error = await tools.call('search_classification_knowledge', {
      query: 'Coffee', mode: 'semantic', limit: 5,
    }).catch((failure: unknown) => failure);

    expectSafeToolError(error, 'AGENT_TOOL_UNAVAILABLE', secret);
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
