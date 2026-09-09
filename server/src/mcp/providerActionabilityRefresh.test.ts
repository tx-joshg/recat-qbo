import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { QboRateLimitError } from '../lib/qbo/types.js';
import { createRecatMcpServer, type CompanyReadOperations } from './readTools.js';

const principal = Object.freeze({
  tokenId: 'token-a',
  tokenPrefix: 'rct_SAFE',
  userId: 'user-a',
  isInstanceAdmin: false,
  memberships: Object.freeze([{ companyId: 'company-a', role: 'categorizer' as const }]),
});

function reads(): CompanyReadOperations {
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
  };
}

async function call(handler: ReturnType<typeof createMcpHandler>, arguments_: object) {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'refresh_provider_actionability', arguments: arguments_ },
    }),
  }));
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : body;
  return JSON.parse(payload ?? '') as Record<string, any>;
}

describe('MCP provider actionability refresh', () => {
  it('routes a bounded authorized refresh and returns its checkpoint', async () => {
    const refresh = vi.fn().mockResolvedValue({
      companyId: 'company-a',
      processed: 1,
      persisted: 1,
      failed: 0,
      nextCursor: 'txn-a',
      partial: true,
      complete: false,
      items: [{
        transactionId: 'txn-a',
        persisted: true,
        disposition: 'WRITABLE',
        errorCode: null,
      }],
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: reads(),
        actionabilityRefresh: { refreshProviderActionability: refresh },
      }),
      { legacy: 'stateless' },
    );

    const response = await call(handler, {
      companyId: 'company-a',
      limit: 1,
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.refresh).toMatchObject({
      companyId: 'company-a',
      processed: 1,
      nextCursor: 'txn-a',
    });
    expect(refresh).toHaveBeenCalledWith(
      'user-a',
      'company-a',
      { cursor: null, limit: 1 },
    );
  });

  it('rejects a limit over one before invoking the refresh operation', async () => {
    const refresh = vi.fn();
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: reads(),
        actionabilityRefresh: { refreshProviderActionability: refresh },
      }),
      { legacy: 'stateless' },
    );

    const response = await call(handler, { companyId: 'company-a', limit: 2 });
    expect(response.result.isError).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns a sanitized rate-limit error and bounded retry hint', async () => {
    const refresh = vi.fn().mockRejectedValue(
      new QboRateLimitError(999, 'private provider rate detail'),
    );
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: reads(),
        actionabilityRefresh: { refreshProviderActionability: refresh },
      }),
      { legacy: 'stateless' },
    );

    const response = await call(handler, { companyId: 'company-a', limit: 1 });
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'RATE_LIMITED',
          retryAfterSeconds: 60,
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('private provider rate detail');
  });
});
