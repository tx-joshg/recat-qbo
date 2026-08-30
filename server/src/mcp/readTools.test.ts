import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  SpanStatusCode,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http.js';
import {
  READ_TOOL_NAMES,
  createRecatMcpServer,
  type CompanyReadOperations,
} from './readTools.js';

const principal = Object.freeze({
  tokenId: 'token-a',
  tokenPrefix: 'rct_SAFE',
  userId: 'user-a',
  isInstanceAdmin: false,
  memberships: Object.freeze([{ companyId: 'company-a', role: 'viewer' }]),
});

const sampleTransaction = {
  id: 'transaction-a',
  companyId: 'company-a',
  qboId: 'qbo-a',
  qboType: 'Purchase' as const,
  date: '2026-01-01T00:00:00.000Z',
  payee: 'Vendor',
  memo: null,
  amount: -10,
  bankAccount: 'Checking',
  status: 'POSTED' as const,
  revision: 1,
  category: null,
  categoryQboId: null,
  taxCalculation: null,
  taxCode: null,
  taxCodeQboId: null,
  splits: null,
  tagIds: [],
  suggestion: null,
  error: null,
  postedAt: null,
  postedBy: null,
  activeCategorizationAttempt: null,
  transferCandidateId: null,
  verification: {
    status: 'verified' as const,
    outcome: 'VERIFIED' as const,
    summary: 'Verified.',
  },
};

function reads(): CompanyReadOperations {
  return {
    listCompanies: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTransactions: vi.fn().mockResolvedValue({ items: [], nextCursor: null, pendingCount: 0 }),
    getTransaction: vi.fn().mockResolvedValue(sampleTransaction),
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
  };
}

async function legacy(handler: ReturnType<typeof createMcpHandler>, method: string, params: object) {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : text;
  return JSON.parse(payload ?? '') as Record<string, any>;
}

describe('Recat MCP read tools', () => {
  it('returns the complete tax-code DTO instead of rejecting its sales rate', async () => {
    const operations = reads();
    vi.mocked(operations.listTaxCodes).mockResolvedValue({
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-08-30T20:00:00.000Z',
      items: [
        {
          qboId: 'NON',
          name: 'Non-taxable',
          active: true,
          taxable: false,
          combinedPurchaseRate: null,
          combinedSalesRate: null,
        },
        {
          qboId: 'SALES7',
          name: 'Sales tax 7%',
          active: true,
          taxable: true,
          combinedPurchaseRate: null,
          combinedSalesRate: 7,
        },
      ],
      nextCursor: null,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'list_tax_codes',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.items).toEqual([
      {
        qboId: 'NON',
        name: 'Non-taxable',
        active: true,
        taxable: false,
        combinedPurchaseRate: null,
        combinedSalesRate: null,
      },
      {
        qboId: 'SALES7',
        name: 'Sales tax 7%',
        active: true,
        taxable: true,
        combinedPurchaseRate: null,
        combinedSalesRate: 7,
      },
    ]);
  });

  it('does not rerun static schema deadline checks for concurrent fresh servers', async () => {
    let simulatedNow = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 100;
      return simulatedNow;
    });

    try {
      const payloads = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          await Promise.resolve();
          const handler = createMcpHandler(
            () => createRecatMcpServer({
              principal: {
                ...principal,
                userId: `concurrent-${index}`,
              },
              era: 'legacy',
              reads: reads(),
              log: vi.fn(),
            }),
            { legacy: 'stateless' },
          );
          return legacy(handler, 'tools/call', {
            name: 'get_identity',
            arguments: {},
          });
        }),
      );

      expect(payloads.map((payload) =>
        payload.result.structuredContent.identity.userId,
      )).toEqual(
        Array.from({ length: 16 }, (_, index) => `concurrent-${index}`),
      );
    } finally {
      now.mockRestore();
    }
  });

  it('registers exactly nine core reads and twenty conservatively annotated action tools', async () => {
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: reads() }),
      { legacy: 'stateless' },
    );
    const body = await legacy(handler, 'tools/list', {});
    const tools = body.result.tools as Array<Record<string, any>>;

    expect(tools.map((tool) => tool.name)).toEqual([
      ...READ_TOOL_NAMES,
      'prepare_categorization',
      'commit_categorization',
      'get_operation',
      'retry_operation',
      'prepare_undo',
      'commit_undo',
      'prepare_transfer',
      'commit_transfer',
      'create_attachment_upload',
      'attach_transaction_files',
      'list_transaction_attachments',
      'get_attachment_download',
      'delete_transaction_attachment',
      'create_receipt_upload',
      'ingest_receipt',
      'list_receipts',
      'get_receipt',
      'list_receipt_matches',
      'confirm_receipt_match',
      'attach_receipt',
    ]);
    expect(tools).toHaveLength(29);
    for (const tool of tools.slice(0, READ_TOOL_NAMES.length)) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.slice(READ_TOOL_NAMES.length).map((tool) => ({
      name: tool.name,
      annotations: tool.annotations,
    }))).toEqual([
      {
        name: 'prepare_categorization',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'commit_categorization',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_operation',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'retry_operation',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'prepare_undo',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'commit_undo',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'prepare_transfer',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'commit_transfer',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'create_attachment_upload',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'attach_transaction_files',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'list_transaction_attachments',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_attachment_download',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'delete_transaction_attachment',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'create_receipt_upload',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'ingest_receipt',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      ...['list_receipts', 'get_receipt', 'list_receipt_matches'].map((name) => ({
        name,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      })),
      {
        name: 'confirm_receipt_match',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'attach_receipt',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
    const listTransactions = tools.find((tool) => tool.name === 'list_transactions')!;
    expect(listTransactions.inputSchema.properties.limit.maximum).toBe(100);
    expect(listTransactions.inputSchema.properties.cursor.maxLength).toBe(2048);
    expect(listTransactions.outputSchema.additionalProperties).toBe(false);
    expect(tools.every((tool) => tool.outputSchema.additionalProperties === false)).toBe(true);
  });

  it('routes reads with the fresh principal and rejects unknown fields', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const ok = await legacy(handler, 'tools/call', {
      name: 'list_companies',
      arguments: { limit: 2 },
    });
    expect(operations.listCompanies).toHaveBeenCalledWith('user-a', { limit: 2 });
    expect(ok.result.isError).not.toBe(true);

    const invalid = await legacy(handler, 'tools/call', {
      name: 'list_companies',
      arguments: { limit: 2, extra: true },
    });
    expect(invalid.result.isError).toBe(true);
    expect(operations.listCompanies).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ startDate: '2025-02-29' }, 'real date'],
    [{ endDate: '2026-02-30' }, 'real date'],
    [{ startDate: '2025-01-01', endDate: '2026-01-03' }, '366 days'],
  ])('rejects invalid transaction date bounds before calling services: %s', async (dates) => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'list_transactions',
      arguments: { companyId: 'company-a', ...dates },
    });

    expect(response.result.isError).toBe(true);
    expect(operations.listTransactions).not.toHaveBeenCalled();
  });

  it('returns a deterministic maximum of 100 memberships with total and truncation metadata', async () => {
    const memberships = Array.from({ length: 105 }, (_, index) => ({
      companyId: `company-${String(104 - index).padStart(3, '0')}`,
      role: 'viewer',
    }));
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: Object.freeze({ ...principal, memberships: Object.freeze(memberships) }),
        era: 'legacy',
        reads: reads(),
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    });
    const identity = response.result.structuredContent.identity;

    expect(identity.memberships).toHaveLength(100);
    expect(identity.memberships[0].companyId).toBe('company-000');
    expect(identity.memberships[99].companyId).toBe('company-099');
    expect(identity).toMatchObject({
      totalMemberships: 105,
      membershipsTruncated: true,
    });
  });

  it('routes every company read tool, forwards pagination, and safely reports authorization failures', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations, log: vi.fn() }),
      { legacy: 'stateless' },
    );
    const calls = [
      ['list_companies', { limit: 1, cursor: 'cursor-a' }],
      ['list_transactions', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['get_transaction', { companyId: 'company-a', transactionId: 'transaction-a' }],
      ['list_categories', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_tax_codes', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_tags', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_rules', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_transfer_candidates', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
    ] as const;

    for (const [name, arguments_] of calls) {
      const response = await legacy(handler, 'tools/call', { name, arguments: arguments_ });
      expect(response.result.isError, name).not.toBe(true);
    }
    expect(operations.listCompanies).toHaveBeenCalledWith(
      'user-a',
      { limit: 1, cursor: 'cursor-a' },
    );
    expect(operations.listTransactions).toHaveBeenCalledWith(
      'user-a',
      'company-a',
      { limit: 1, cursor: 'cursor-a' },
    );

    vi.mocked(operations.listRules).mockRejectedValueOnce(
      new HttpError(403, 'PRIVATE_ROLE_SENTINEL', 'FORBIDDEN'),
    );
    const denied = await legacy(handler, 'tools/call', {
      name: 'list_rules',
      arguments: { companyId: 'company-a' },
    });
    expect(denied.result.structuredContent.error).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(denied.result.structuredContent.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(denied.result.structuredContent.error.requestId).not.toBe('1');
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_ROLE_SENTINEL');

    const oversized = await legacy(handler, 'tools/call', {
      name: 'list_tags',
      arguments: { companyId: 'company-a', limit: 101 },
    });
    expect(oversized.result.isError).toBe(true);
  });

  it('returns non-empty rule review state and activation provenance', async () => {
    const operations = reads();
    vi.mocked(operations.listRules).mockResolvedValueOnce({
      items: [{
        id: 'rule-a',
        companyId: 'company-a',
        priority: 0,
        matchField: 'payee',
        matchText: 'Coffee',
        category: 'Meals',
        categoryQboId: 'account-a',
        taxCalculation: null,
        taxCode: null,
        taxCodeQboId: null,
        tagIds: [],
        autoPost: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        reviewRequiredAt: '2026-01-02T00:00:00.000Z',
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
        origin: {
          candidateId: 'candidate-a',
          evidenceCount: 3,
          schemaVersion: 'schema-v1',
          configVersion: 'config-v2',
        },
        valid: true,
        invalidReasons: [],
      }],
      nextCursor: null,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'list_rules',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.items).toEqual([
      expect.objectContaining({
        reviewRequiredAt: '2026-01-02T00:00:00.000Z',
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
        origin: {
          candidateId: 'candidate-a',
          evidenceCount: 3,
          schemaVersion: 'schema-v1',
          configVersion: 'config-v2',
        },
      }),
    ]);
  });

  it('replaces a large invalid service output with one small safe failure', async () => {
    const outputSentinel = 'PRIVATE_LARGE_OUTPUT_SENTINEL';
    const operations = reads();
    vi.mocked(operations.listCompanies).mockResolvedValueOnce({
      items: [{
        unexpected: outputSentinel.repeat(100_000),
      }] as never,
      nextCursor: null,
    });
    const log = vi.fn();
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = {
      startSpan: vi.fn(() => span),
    } as unknown as Tracer;
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: operations,
        requestId: 'safe-request-id',
        log,
        tracer,
      }),
      { legacy: 'stateless' },
    );
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'large-invalid-output',
        method: 'tools/call',
        params: {
          name: 'list_companies',
          arguments: {},
        },
      }),
    }));
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      : text;
    const payload = JSON.parse(data ?? '') as Record<string, any>;

    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1_024);
    expect(text).not.toContain(outputSentinel);
    expect(payload.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INVALID_INPUT',
          requestId: 'safe-request-id',
        },
      },
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'list_companies',
      count: 0,
      outcome: 'error',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(outputSentinel);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
