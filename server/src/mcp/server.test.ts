import { describe, expect, it, vi } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { CompanyReadOperations } from './readTools.js';
import {
  MUTATION_TOOL_NAMES,
  type McpMutationOperations,
} from './mutationTools.js';
import {
  contextFrom,
  createRecatMcpHandler,
  prepareBoundedToolCalls,
} from './server.js';
import { MCP_SCHEMA_BOUNDS } from './schemaBounds.js';

function auth(userId: string) {
  return {
    token: `token-${userId}`,
    clientId: `client-${userId}`,
    scopes: ['recat:mcp'],
    expiresAt: Date.now() / 1_000 + 60,
    extra: {
      principal: Object.freeze({
        tokenId: `token-${userId}`,
        tokenPrefix: `rct_${userId}`,
        userId,
        isInstanceAdmin: false,
        memberships: Object.freeze([]),
      }),
    },
  };
}

const MODERN_VERSION = '2026-07-28';
const SUPPORTED_LEGACY_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS.filter(
  (version) => version !== MODERN_VERSION,
);
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function modern(
  handler: ReturnType<typeof createRecatMcpHandler>,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    authInfo?: ReturnType<typeof auth>;
    headerMethod?: string;
    headerVersion?: string;
    headerName?: string;
    meta?: Record<string, unknown>;
    id?: string | number;
    extraHeaders?: Record<string, string>;
  } = {},
) {
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'mcp-method': options.headerMethod ?? method,
    'mcp-protocol-version': options.headerVersion ?? MODERN_VERSION,
  });
  if (method === 'tools/call' && typeof params.name === 'string') {
    headers.set('mcp-name', options.headerName ?? params.name);
  }
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: {
        ...params,
        _meta: options.meta ?? META,
      },
    }),
  }), { authInfo: options.authInfo ?? auth('one') });
  return {
    response,
    body: await response.json() as Record<string, any>,
  };
}

function mockReads(overrides: Partial<CompanyReadOperations> = {}): CompanyReadOperations {
  return {
    listCompanies: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTransactions: vi.fn().mockResolvedValue({ items: [], nextCursor: null, pendingCount: 0 }),
    getTransaction: vi.fn(),
    listCategories: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTaxCodes: vi.fn().mockResolvedValue({
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: null,
      items: [],
      nextCursor: null,
    }),
    listTags: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listRules: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTransferCandidates: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function mockMutations(
  overrides: Partial<McpMutationOperations> = {},
): McpMutationOperations {
  const operation = {
    operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    kind: 'categorization' as const,
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    transactionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceRevision: 2,
    preparedRevision: 3,
    expiresAt: '2026-07-29T20:15:00.000Z',
    state: 'prepared' as const,
    phase: 'awaiting_commit' as const,
    result: null,
    error: null,
    actions: {
      canCommit: true,
      canRetry: false,
      requiresReconciliation: false,
    },
  };
  return {
    prepareCategorization: vi.fn(),
    commitCategorization: vi.fn().mockResolvedValue(operation),
    getOperation: vi.fn().mockResolvedValue(operation),
    retryOperation: vi.fn().mockResolvedValue(operation),
    prepareUndo: vi.fn(),
    commitUndo: vi.fn().mockResolvedValue({
      ...operation,
      kind: 'undo',
    }),
    prepareTransfer: vi.fn(),
    commitTransfer: vi.fn().mockResolvedValue({
      operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      kind: 'transfer',
      expiresAt: operation.expiresAt,
      state: 'prepared',
      phase: 'awaiting_commit',
      result: {
        complete: false,
        firstLeg: { outcome: 'IN_PROGRESS' },
        secondLeg: { outcome: 'IN_PROGRESS' },
      },
      error: null,
      actions: {
        canCommit: true,
        canRetry: false,
        requiresReconciliation: false,
      },
    }),
    ...overrides,
  };
}

function expectSafeInvalidToolFailure(body: Record<string, any>, sentinel: string): void {
  expect(body.result).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: 'INVALID_INPUT',
        message: 'Check the tool arguments and try again.',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    },
  });
  expect(body.result.content[0].text).toBe(
    JSON.stringify(body.result.structuredContent),
  );
  expect(JSON.stringify(body)).not.toContain(sentinel);
}

async function legacyPayload(response: Response): Promise<Record<string, any>[]> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = JSON.parse(text) as Record<string, any> | Record<string, any>[];
    return Array.isArray(payload) ? payload : [payload];
  }
  return text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .flatMap((line) => {
      const payload = JSON.parse(line.slice(6)) as Record<string, any> | Record<string, any>[];
      return Array.isArray(payload) ? payload : [payload];
    });
}

describe('stateless MCP handler', () => {
  it('creates an isolated context from each authenticated request', () => {
    const first = contextFrom(auth('one'), 'modern');
    const second = contextFrom(auth('two'), 'legacy');

    expect(first).toMatchObject({ era: 'modern', principal: { userId: 'one' } });
    expect(second).toMatchObject({ era: 'legacy', principal: { userId: 'two' } });
    expect(first).not.toBe(second);
    expect(() => contextFrom(undefined, 'modern')).toThrow();
  });

  it('uses the SDK v2 stateless factory for modern and legacy traffic', async () => {
    const handler = createRecatMcpHandler();
    const legacyGet = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'GET',
    }), { authInfo: auth('one') });
    expect(legacyGet.status).toBe(405);

    const legacy = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    }), { authInfo: auth('one') });
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('mcp-session-id')).toBeNull();

    const legacyTool = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_identity', arguments: {} },
      }),
    }), { authInfo: auth('legacy-user') });
    const legacyText = await legacyTool.text();
    const legacyPayload = legacyTool.headers.get('content-type')?.includes('text/event-stream')
      ? legacyText.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      : legacyText;
    const legacyBody = JSON.parse(legacyPayload ?? '') as Record<string, any>;
    expect(legacyBody.result.structuredContent.identity.userId).toBe('legacy-user');
    expect(legacyTool.headers.get('mcp-session-id')).toBeNull();
  });

  it('discovers only non-changing tools with modern metadata and no extensions', async () => {
    const handler = createRecatMcpHandler();
    const { response, body } = await modern(handler, 'server/discover', {}, {
      meta: {
        ...META,
        'io.modelcontextprotocol/clientInfo': {
          name: 'wire-test',
          version: '1.0.0',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(body.result).toMatchObject({
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: { listChanged: false } },
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'recat-qbo',
          version: '0.1.0',
        },
      },
    });
    expect(body.result.capabilities).not.toHaveProperty('subscriptions');
    expect(body.result).not.toHaveProperty('extensions');

    const withoutClientInfo = await modern(handler, 'server/discover');
    expect(withoutClientInfo.response.status).toBe(200);
  });

  it('requires the modern envelope and client capabilities', async () => {
    const handler = createRecatMcpHandler();
    const missingMeta = await modern(handler, 'server/discover', {}, { meta: {} });
    expect(missingMeta.body.error.code).toBe(-32602);
    const missingCapabilities = await modern(handler, 'server/discover', {}, {
      meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION },
    });
    expect(missingCapabilities.body.error.code).toBe(-32602);

    const missingToolMeta = await modern(handler, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    }, { meta: {} });
    expect(missingToolMeta.response.status).toBe(400);
    expect(missingToolMeta.body.error.code).toBe(-32602);
    expect(missingToolMeta.body).not.toHaveProperty('result');
  });

  it('lets SDK v2 reject routing mismatches, unsupported versions, and unknown methods', async () => {
    const handler = createRecatMcpHandler();
    const mismatch = await modern(handler, 'server/discover', {}, {
      headerMethod: 'tools/list',
    });
    expect(mismatch.body.error.code).toBe(-32020);

    const unsupported = await modern(handler, 'server/discover', {}, {
      headerVersion: '2099-01-01',
      meta: {
        ...META,
        'io.modelcontextprotocol/protocolVersion': '2099-01-01',
      },
    });
    expect(unsupported.body.error.code).toBe(-32022);

    const unknown = await modern(handler, 'unknown/method');
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.error.code).toBe(-32601);
  });

  it.each(['GET', 'DELETE'])('rejects modern %s without creating a session', async (method) => {
    const handler = createRecatMcpHandler();
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method,
      headers: {
        'mcp-method': 'server/discover',
        'mcp-protocol-version': MODERN_VERSION,
      },
    }), { authInfo: auth('one') });

    expect(response.status).toBe(405);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('keeps concurrent modern principals isolated and returns no session IDs', async () => {
    const handler = createRecatMcpHandler();
    const [first, second] = await Promise.all([
      modern(handler, 'tools/call', {
        name: 'get_identity',
        arguments: {},
      }, { authInfo: auth('first') }),
      modern(handler, 'tools/call', {
        name: 'get_identity',
        arguments: {},
      }, { authInfo: auth('second') }),
    ]);

    expect(first.body.result.structuredContent.identity.userId).toBe('first');
    expect(second.body.result.structuredContent.identity.userId).toBe('second');
    expect(first.response.headers.get('mcp-session-id')).toBeNull();
    expect(second.response.headers.get('mcp-session-id')).toBeNull();
  });

  it('normalizes SDK input, unknown-tool, and output-validation failures without leaking sentinels', async () => {
    const outputSentinel = 'PRIVATE_OUTPUT_SENTINEL';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const reads = mockReads({
      listCompanies: vi.fn().mockResolvedValue({
        items: [{ unexpected: outputSentinel }],
        nextCursor: null,
      }),
    });
    const handler = createRecatMcpHandler(reads);

    const invalid = await modern(handler, 'tools/call', {
      name: 'list_companies',
      arguments: { PRIVATE_UNKNOWN_KEY_SENTINEL: true },
    }, { id: 'PRIVATE_CLIENT_ID_SENTINEL' });
    expectSafeInvalidToolFailure(
      invalid.body,
      'PRIVATE_UNKNOWN_KEY_SENTINEL',
    );
    expect(reads.listCompanies).not.toHaveBeenCalled();

    const unknown = await modern(handler, 'tools/call', {
      name: 'PRIVATE_UNKNOWN_TOOL_SENTINEL',
      arguments: {},
    }, { id: 'PRIVATE_CLIENT_ID_SENTINEL' });
    expectSafeInvalidToolFailure(unknown.body, 'PRIVATE_UNKNOWN_TOOL_SENTINEL');

    const invalidOutput = await modern(handler, 'tools/call', {
      name: 'list_companies',
      arguments: {},
    }, { id: 'PRIVATE_CLIENT_ID_SENTINEL' });
    expectSafeInvalidToolFailure(invalidOutput.body, outputSentinel);
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE_CLIENT_ID_SENTINEL');
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE_UNKNOWN_KEY_SENTINEL');
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE_UNKNOWN_TOOL_SENTINEL');
    expect(JSON.stringify(info.mock.calls)).not.toContain(outputSentinel);
    info.mockRestore();
  });

  it.each(SUPPORTED_LEGACY_VERSIONS)(
    'sanitizes scalar tool failures for supported legacy protocol header %s',
    async (protocolVersion) => {
      const handler = createRecatMcpHandler();
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': protocolVersion,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'legacy-header-invalid',
          method: 'tools/call',
          params: {
            name: 'list_companies',
            arguments: { PRIVATE_LEGACY_HEADER_INPUT_SENTINEL: true },
          },
        }),
      }), { authInfo: auth('legacy-header-user') });
      const [payload] = await legacyPayload(response);

      expectSafeInvalidToolFailure(
        payload!,
        'PRIVATE_LEGACY_HEADER_INPUT_SENTINEL',
      );
    },
  );

  it.each(SUPPORTED_LEGACY_VERSIONS)(
    'sanitizes every batch tool failure for supported legacy protocol header %s',
    async (protocolVersion) => {
      const outputSentinel = 'PRIVATE_LEGACY_HEADER_OUTPUT_SENTINEL';
      const operations = mockReads({
        listCompanies: vi.fn().mockResolvedValue({
          items: [{ unexpected: outputSentinel }],
          nextCursor: null,
        }),
      });
      const handler = createRecatMcpHandler(operations);
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': protocolVersion,
        },
        body: JSON.stringify([
          {
            jsonrpc: '2.0',
            id: 'legacy-header-invalid',
            method: 'tools/call',
            params: {
              name: 'list_tags',
              arguments: {
                PRIVATE_LEGACY_HEADER_BATCH_INPUT_SENTINEL: true,
              },
            },
          },
          {
            jsonrpc: '2.0',
            id: 'legacy-header-unknown',
            method: 'tools/call',
            params: {
              name: 'PRIVATE_LEGACY_HEADER_TOOL_SENTINEL',
              arguments: {},
            },
          },
          {
            jsonrpc: '2.0',
            id: 'legacy-header-output',
            method: 'tools/call',
            params: {
              name: 'list_companies',
              arguments: {},
            },
          },
        ]),
      }), { authInfo: auth('legacy-header-user') });
      const payloads = await legacyPayload(response);

      expect(payloads).toHaveLength(3);
      for (const payload of payloads) {
        expectSafeInvalidToolFailure(payload, 'PRIVATE_LEGACY_HEADER');
      }
      expect(JSON.stringify(payloads)).not.toContain(outputSentinel);
    },
  );

  it('normalizes every structurally valid legacy batch tool failure without leaking sentinels', async () => {
    const handler = createRecatMcpHandler();
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 'batch-invalid',
          method: 'tools/call',
          params: {
            name: 'list_companies',
            arguments: { PRIVATE_BATCH_KEY_SENTINEL: true },
          },
        },
        {
          jsonrpc: '2.0',
          id: 'batch-unknown',
          method: 'tools/call',
          params: {
            name: 'PRIVATE_BATCH_TOOL_SENTINEL',
            arguments: {},
          },
        },
      ]),
    }), { authInfo: auth('batch-user') });
    const payloads = await legacyPayload(response);

    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expectSafeInvalidToolFailure(payload, 'PRIVATE_BATCH');
    }
  });

  it('preserves malformed tools/call protocol errors instead of converting them to tool results', async () => {
    const handler = createRecatMcpHandler();
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'malformed-tool-call',
        method: 'tools/call',
        params: { arguments: {} },
      }),
    }), { authInfo: auth('one') });
    const [payload] = await legacyPayload(response);

    expect(payload).toMatchObject({
      jsonrpc: '2.0',
      id: 'malformed-tool-call',
      error: { code: -32602 },
    });
    expect(payload).not.toHaveProperty('result');
  });

  it.each([
    {
      name: 'depth',
      arguments: Array.from(
        { length: MCP_SCHEMA_BOUNDS.maxInputDepth + 1 },
      ).reduce<Record<string, unknown>>(
        (value) => ({ nested: value }),
        {},
      ),
    },
    {
      name: 'keys',
      arguments: Object.fromEntries(
        Array.from(
          { length: MCP_SCHEMA_BOUNDS.maxInputKeys + 1 },
          (_, index) => [`key-${index}`, true],
        ),
      ),
    },
    {
      name: 'bytes',
      arguments: { value: 'x'.repeat(MCP_SCHEMA_BOUNDS.maxInputBytes) },
    },
  ])('bounds scalar tool argument $name before SDK dispatch', ({ arguments: arguments_ }) => {
    const prepared = prepareBoundedToolCalls({
      jsonrpc: '2.0',
      id: 'bounded-scalar',
      method: 'tools/call',
      params: { name: 'get_identity', arguments: arguments_ },
    });

    expect(prepared.hadBoundedFailures).toBe(true);
    expect(
      (prepared.body as Record<string, any>).params.arguments,
    ).toBeNull();
  });

  it('bounds failing batch arguments without rewriting valid sibling calls', () => {
    const valid = {
      jsonrpc: '2.0',
      id: 'valid',
      method: 'tools/call',
      params: { name: 'get_identity', arguments: {} },
    };
    const prepared = prepareBoundedToolCalls([
      {
        jsonrpc: '2.0',
        id: 'bounded',
        method: 'tools/call',
        params: {
          name: 'get_identity',
          arguments: { value: 'x'.repeat(MCP_SCHEMA_BOUNDS.maxInputBytes) },
        },
      },
      valid,
    ]);

    expect(prepared.hadBoundedFailures).toBe(true);
    expect((prepared.body as Record<string, any>[])[0]?.params.arguments).toBeNull();
    expect((prepared.body as Record<string, any>[])[1]).toEqual(valid);
  });

  it('rejects an aggregate 600-call batch once without executing any call', async () => {
    const operations = mockReads();
    const handler = createRecatMcpHandler(operations);
    const batch = Array.from({ length: 600 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'list_companies' },
    }));
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(
      MCP_SCHEMA_BOUNDS.maxInputBytes,
    );

    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
    }), { authInfo: auth('aggregate-user') });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(Buffer.byteLength(text)).toBeLessThan(4_096);
    expect(JSON.parse(text)).toMatchObject({
      error: 'invalid_request',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(operations.listCompanies).not.toHaveBeenCalled();
  });

  it('fails closed on aggregate depth before classifying a malformed tool call', async () => {
    const deepArguments = Array.from(
      { length: MCP_SCHEMA_BOUNDS.maxInputDepth + 1 },
    ).reduce<Record<string, unknown>>(
      (value) => ({ PRIVATE_DEEP_MALFORMED_SENTINEL: value }),
      {},
    );
    const handler = createRecatMcpHandler();
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'deep-malformed',
        method: 'tools/call',
        params: { arguments: deepArguments },
      }),
    }), { authInfo: auth('one') });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: 'invalid_request' });
    expect(text).not.toContain('PRIVATE_DEEP_MALFORMED_SENTINEL');
  });

  it('rewrites legacy SSE incrementally without calling Response.text()', async () => {
    const handler = createRecatMcpHandler();
    const textSpy = vi.spyOn(Response.prototype, 'text');
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'streamed-invalid',
        method: 'tools/call',
        params: {
          name: 'list_companies',
          arguments: { PRIVATE_STREAM_SENTINEL: true },
        },
      }),
    }), { authInfo: auth('one') });

    expect(textSpy).not.toHaveBeenCalled();
    textSpy.mockRestore();
    const [payload] = await legacyPayload(response);
    expectSafeInvalidToolFailure(payload!, 'PRIVATE_STREAM_SENTINEL');
  });

  it.each([
    { era: 'legacy', mirroredOnly: false },
    { era: 'modern', mirroredOnly: false },
    { era: 'legacy', mirroredOnly: true },
    { era: 'modern', mirroredOnly: true },
  ])('bounds Unicode $era output (mirrored-only overflow: $mirroredOnly)', async ({ era, mirroredOnly }) => {
    const largeUnicodeText = '😀'.repeat(mirroredOnly ? 16 : 1_024);
    const largeRules = Array.from({ length: 100 }, (_, index) => ({
      id: `rule-${index}`,
      companyId: 'company-a',
      priority: index,
      matchField: 'payee' as const,
      matchText: largeUnicodeText,
      category: largeUnicodeText,
      categoryQboId: largeUnicodeText,
      taxCalculation: 'TaxExcluded' as const,
      taxCode: largeUnicodeText,
      taxCodeQboId: largeUnicodeText,
      tagIds: Array.from(
        { length: mirroredOnly ? 4 : 100 },
        (_, tagIndex) => `tag-${tagIndex}`.padEnd(128, 'x'),
      ),
      autoPost: false,
      createdAt: '2026-07-28T00:00:00.000Z',
      reviewRequiredAt: null,
      reviewReason: null,
      origin: null,
      valid: false,
      invalidReasons: Array.from(
        { length: 4 },
        () => largeUnicodeText,
      ),
    }));
    const value = { items: largeRules, nextCursor: null };
    if (mirroredOnly) {
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(256 * 1_024);
      const wireValue = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      expect(Buffer.byteLength(JSON.stringify(wireValue))).toBeGreaterThan(256 * 1_024);
    }
    const operations = mockReads({
      listRules: vi.fn().mockResolvedValue({
        items: largeRules,
        nextCursor: null,
      }),
    });
    const handler = createRecatMcpHandler(operations);
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(era === 'modern' ? {
          'mcp-protocol-version': MODERN_VERSION,
          'mcp-method': 'tools/call',
          'mcp-name': 'list_rules',
        } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'large-valid-output',
        method: 'tools/call',
        params: {
          ...(era === 'modern' ? { _meta: META } : {}),
          name: 'list_rules',
          arguments: { companyId: 'company-a' },
        },
      }),
    }), { authInfo: auth('one') });
    const text = await response.text();

    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1_024);
    expect(text.includes('\uFFFD')).toBe(false);
    const [payload] = await legacyPayload(
      new Response(text, { headers: response.headers }),
    );
    expect(payload?.id).toBe('large-valid-output');
    expect(payload?.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'RESPONSE_TOO_LARGE', message: expect.stringContaining('limit') } },
    });
    expect(text).not.toContain(largeUnicodeText);
  });

  it('returns a bounded explicit failure for a single oversized transaction', async () => {
    const transaction = {
      id: 'transaction-size', companyId: 'company-a', qboId: 'qbo-size', qboType: 'Purchase',
      date: '2001-01-01', payee: 'Example vendor', memo: null, amount: -100,
      bankAccount: 'Example bank', status: 'PENDING', revision: 0,
      category: null, categoryQboId: null, taxCalculation: null, taxCode: null, taxCodeQboId: null,
      splits: Array.from({ length: 100 }, () => ({ amount: 1, category: 'Example', tagIds: [], memo: 'x'.repeat(2048) })),
      tagIds: [], suggestion: null, error: null, postedAt: null, postedBy: null,
      activeCategorizationAttempt: null,
      verification: { status: 'unknown', outcome: null, summary: 'Not yet verified' },
    };
    const reads = mockReads({ getTransaction: vi.fn().mockResolvedValue(transaction) });
    const { body } = await modern(createRecatMcpHandler(reads), 'tools/call', {
      name: 'get_transaction', arguments: { companyId: 'company-a', transactionId: 'transaction-size' },
    });
    expect(body.result).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'RESPONSE_TOO_LARGE', message: expect.stringContaining('web app'),
    } } });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(16 * 1024);
    expect(reads.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects modern legacy-handshake methods and routing binding mismatches', async () => {
    const handler = createRecatMcpHandler();
    const initialize = await modern(handler, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy', version: '1' },
    });
    expect(initialize.response.status).toBe(404);
    expect(initialize.body.error.code).toBe(-32601);

    const initialized = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'mcp-method': 'notifications/initialized',
        'mcp-protocol-version': MODERN_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: { _meta: META },
      }),
    }), { authInfo: auth('one') });
    expect(initialized.status).toBe(405);
    expect(await initialized.text()).toBe('');
    expect(initialized.headers.get('mcp-session-id')).toBeNull();

    for (const invalid of [
      {
        headers: {
          'mcp-method': 'tools/list',
          'mcp-protocol-version': MODERN_VERSION,
        },
        params: { _meta: META },
        code: -32020,
      },
      {
        headers: {
          'mcp-method': 'notifications/initialized',
          'mcp-protocol-version': MODERN_VERSION,
        },
        params: { _meta: {} },
        code: -32602,
      },
    ]) {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...invalid.headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: invalid.params,
        }),
      }), { authInfo: auth('one') });
      expect(response.status, JSON.stringify(invalid)).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: invalid.code },
      });
      expect(response.headers.get('mcp-session-id')).toBeNull();
    }

    const versionMismatch = await modern(handler, 'server/discover', {}, {
      headerVersion: MODERN_VERSION,
      meta: {
        ...META,
        'io.modelcontextprotocol/protocolVersion': '2099-01-01',
      },
    });
    expect(versionMismatch.body.error.code).toBe(-32020);

    const nameMismatch = await modern(handler, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    }, { headerName: 'list_companies' });
    expect(nameMismatch.body.error.code).toBe(-32020);
  });

  it('stamps ordinary results and emits deterministic private zero-TTL tool listings', async () => {
    const handler = createRecatMcpHandler();
    const ordinary = await modern(handler, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    });
    expect(ordinary.body.result).toMatchObject({
      resultType: 'complete',
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'recat-qbo',
          version: '0.1.0',
        },
      },
    });

    const first = await modern(handler, 'tools/list');
    const second = await modern(handler, 'tools/list');
    expect(first.body.result).toEqual(second.body.result);
    expect(first.body.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
    });
  });

  it('rejects Last-Event-ID replay attempts on the stateless endpoint', async () => {
    const handler = createRecatMcpHandler();
    const replay = await modern(handler, 'tools/list', {}, {
      extraHeaders: { 'last-event-id': 'PRIVATE_REPLAY_SENTINEL' },
    });

    expect(replay.response.status).toBe(400);
    expect(JSON.stringify(replay.body)).not.toContain('PRIVATE_REPLAY_SENTINEL');
  });

  it('keeps concurrent legacy principals isolated', async () => {
    const handler = createRecatMcpHandler();
    const call = async (userId: string) => {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `PRIVATE_CLIENT_ID_${userId}`,
          method: 'tools/call',
          params: { name: 'get_identity', arguments: {} },
        }),
      }), { authInfo: auth(userId) });
      const responseText = await response.text();
      const data = responseText.split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      return JSON.parse(data ?? responseText) as Record<string, any>;
    };

    const [first, second] = await Promise.all([call('first'), call('second')]);
    expect(first.result.structuredContent.identity.userId).toBe('first');
    expect(second.result.structuredContent.identity.userId).toBe('second');
  });

  it('publishes and routes the same mutation tools for modern and legacy clients', async () => {
    const mutations = mockMutations();
    const handler = createRecatMcpHandler(mockReads(), mutations);
    const modernList = await modern(handler, 'tools/list', {}, {
      authInfo: auth('modern-user'),
    });
    const legacyListResponse = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'legacy-list',
        method: 'tools/list',
        params: {},
      }),
    }), { authInfo: auth('legacy-user') });
    const [legacyList] = await legacyPayload(legacyListResponse);
    const modernTools = modernList.body.result.tools as Array<Record<string, any>>;
    const legacyTools = legacyList!.result.tools as Array<Record<string, any>>;

    expect(
      modernTools.filter((tool) => MUTATION_TOOL_NAMES.includes(tool.name)),
    ).toEqual(
      legacyTools.filter((tool) => MUTATION_TOOL_NAMES.includes(tool.name)),
    );
    expect(
      modernTools.filter((tool) => MUTATION_TOOL_NAMES.includes(tool.name))
        .map((tool) => tool.name),
    ).toEqual(MUTATION_TOOL_NAMES);

    const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const modernCall = await modern(handler, 'tools/call', {
      name: 'get_operation',
      arguments: { operationId },
    }, { authInfo: auth('modern-user') });
    const legacyCallResponse = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'legacy-call',
        method: 'tools/call',
        params: {
          name: 'get_operation',
          arguments: { operationId },
        },
      }),
    }), { authInfo: auth('legacy-user') });
    const [legacyCall] = await legacyPayload(legacyCallResponse);

    expect(modernCall.body.result.structuredContent).toEqual(
      legacyCall!.result.structuredContent,
    );
    expect(mutations.getOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 'modern-user' }),
      { operationId },
    );
    expect(mutations.getOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 'legacy-user' }),
      { operationId },
    );
    expect(modernCall.response.headers.get('mcp-session-id')).toBeNull();
    expect(legacyCallResponse.headers.get('mcp-session-id')).toBeNull();
  });
});
