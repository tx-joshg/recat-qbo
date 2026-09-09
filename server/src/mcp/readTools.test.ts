import { createCompanyReadService, type CompanyReadDb } from '../services/companyReads.js';
import type { WriteSafetyReadOperations } from '../services/writeSafetyReads.js';
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
  type CompanySyncOperations,
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

function safetyReads(): WriteSafetyReadOperations {
  return {
    getWriteSafety: vi.fn().mockResolvedValue({
      transactionId: 'transaction-a',
      revision: 1,
      qboId: 'qbo-a',
      qboType: 'Purchase',
      qboSyncToken: '0',
      txnDate: '2026-01-01',
      bankAccountQboId: 'bank-a',
      bookCloseDate: null,
      cleared: false,
      reconciled: false,
      writable: true,
      blockCode: null,
    }),
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
  it.each([
    ['list_transactions', true],
    ['list_companies', true],
    ['list_companies', false],
    ['list_tax_codes', true],
  ] as const)('accepts actual %s service output with attachment retention %s', async (name, retainAttachmentFiles) => {
    const row = {
      id: 'company-a', realmId: 'realm-synthetic', legalName: 'Read contract fixture',
      nickname: 'Read fixture', env: 'sandbox', syncMode: 'polling', pollIntervalMin: 10,
      holdingAccountIds: [], dryRun: false, tagsRequired: false, retainAttachmentFiles,
      connectedAt: new Date('2026-01-04T00:00:00.000Z'), disconnectedAt: null,
      lastSyncedAt: null, memberships: [{ role: 'viewer' }],
    };
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-a', isInstanceAdmin: false }) },
      membership: { findUnique: vi.fn().mockResolvedValue({ role: 'viewer' }) },
      company: { findUnique: vi.fn().mockResolvedValue(row), findMany: vi.fn().mockResolvedValue([row]) },
      transaction: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      transactionActionability: { findMany: vi.fn().mockResolvedValue([]) },
      qboTaxCode: { findMany: vi.fn().mockResolvedValue([{
        qboId: 'tax-fixture', name: 'Synthetic tax', active: true, taxable: true,
        combinedPurchaseRate: 0.07, combinedSalesRate: 0.09,
      }]) },
    } as unknown as CompanyReadDb;
    const service = createCompanyReadService(db, 'synthetic-read-contract-cursor', {
      suggestForMany: async () => [], transferCandidates: async () => new Map(),
    });
    const operations = {
      ...reads(), listTransactions: service.listTransactions, listCompanies: service.listCompanies,
      listTaxCodes: service.listTaxCodes,
    };
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );
    const response = await legacy(handler, 'tools/call', {
      name, arguments: name !== 'list_companies' ? { companyId: 'company-a' } : {},
    });
    expect(response.result.isError).not.toBe(true);
    if (name === 'list_transactions') {
      expect(response.result.structuredContent).toMatchObject({
        pendingCount: 0, actionableCount: 0, blockedCount: 0, unknownCount: 0,
      });
    } else if (name === 'list_tax_codes') {
      expect(response.result.structuredContent.items[0]).toMatchObject({
        combinedPurchaseRate: 0.07, combinedSalesRate: 0.09,
      });
    } else {
      expect(response.result.structuredContent.items[0].retainAttachmentFiles).toBe(retainAttachmentFiles);
    }
  });

  it('refreshes one visible mirror transaction without starting a company sweep', async () => {
    const refreshTransaction = vi.fn().mockResolvedValue({
      transactionId: 'transaction-a',
      outcome: 'refreshed',
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: { ...principal, memberships: [{ companyId: 'company-a', role: 'categorizer' as const }] },
        era: 'legacy',
        reads: reads(),
        sync: {
          syncCompany: vi.fn(),
          refreshTransaction,
        },
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'refresh_transaction_mirror',
      arguments: { companyId: 'company-a', transactionId: 'transaction-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.refresh).toEqual({
      transactionId: 'transaction-a',
      outcome: 'refreshed',
    });
    expect(refreshTransaction).toHaveBeenCalledWith('company-a', 'transaction-a');
  });

  it('runs an authorized Recat mirror sync without writing QuickBooks', async () => {
    const syncCompany = vi.fn().mockResolvedValue({
      ok: true,
      message: 'Synced 1 transaction.',
      mirror: { created: 0, refreshed: 1, stale: 2, busy: 3, contended: 4 },
    });
    const sync: CompanySyncOperations = { syncCompany };
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: { ...principal, memberships: [{ companyId: 'company-a', role: 'categorizer' as const }] },
        era: 'legacy',
        reads: reads(),
        sync,
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'sync_company',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.sync).toEqual({
      companyId: 'company-a',
      ok: true,
      message: 'Synced 1 transaction.',
      mirror: { created: 0, refreshed: 1, stale: 2, busy: 3, contended: 4 },
    });
    expect(syncCompany).toHaveBeenCalledWith('company-a', 'manual');
  });

  it('allows an instance admin to sync a visible company without an explicit membership', async () => {
    const syncCompany = vi.fn().mockResolvedValue({ ok: true, message: 'Synced 1 transaction.' });
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: { ...principal, isInstanceAdmin: true, memberships: [] },
        era: 'legacy',
        reads: reads(),
        sync: { syncCompany },
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'sync_company',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(syncCompany).toHaveBeenCalledWith('company-a', 'manual');
  });

  it('requires categorizer access before a Recat mirror sync', async () => {
    const syncCompany = vi.fn();
    const sync: CompanySyncOperations = { syncCompany };
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: reads(),
        sync,
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'sync_company',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent.error.code).toBe('FORBIDDEN');
    expect(syncCompany).not.toHaveBeenCalled();
  });

  it.each(['get_write_safety', 'refresh_provider_actionability'])('rejects viewer provider-driving tool %s before reading QuickBooks', async (name) => {
    const operations = safetyReads();
    const refresh = vi.fn().mockResolvedValue({
      companyId: 'company-a', processed: 0, persisted: 0, failed: 0,
      nextCursor: null, partial: false, complete: true, items: [],
    });
    const handler = createMcpHandler(() => createRecatMcpServer({
      principal, era: 'legacy', reads: reads(), writeSafetyReads: operations,
      actionabilityRefresh: { refreshProviderActionability: refresh },
    }), { legacy: 'stateless' });
    const response = await legacy(handler, 'tools/call', {
      name, arguments: name === 'get_write_safety'
        ? { companyId: 'company-a', transactionId: 'transaction-a' }
        : { companyId: 'company-a', limit: 1 },
    });
    expect(response.result.structuredContent.error?.code).toBe('FORBIDDEN');
    expect(operations.getWriteSafety).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('routes the QuickBooks write-safety preflight with the fresh principal', async () => {
    const operations = safetyReads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: { ...principal, memberships: [{ companyId: 'company-a', role: 'categorizer' }] },
        era: 'legacy',
        reads: reads(),
        writeSafetyReads: operations,
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'get_write_safety',
      arguments: { companyId: 'company-a', transactionId: 'transaction-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.writeSafety).toMatchObject({
      transactionId: 'transaction-a',
      writable: true,
      blockCode: null,
    });
    expect(operations.getWriteSafety).toHaveBeenCalledWith(
      'user-a',
      'company-a',
      'transaction-a',
    );
  });


  it('returns exact source gross through the strict transaction output schema', async () => {
    const operations = reads();
    vi.mocked(operations.getTransaction).mockResolvedValue({
      ...sampleTransaction, amount: -10, sourceGrossCents: -1120,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );
    const body = await legacy(handler, 'tools/call', {
      name: 'get_transaction',
      arguments: { companyId: 'company-a', transactionId: 'transaction-a' },
    });
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.transaction).toMatchObject({ amount: -10, sourceGrossCents: -1120 });
  });

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
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations, log: vi.fn() }),
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

  it('registers thirteen core reads and twenty conservatively annotated action tools', async () => {
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
    expect(tools).toHaveLength(33);
    for (const tool of tools.slice(0, READ_TOOL_NAMES.length)) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: !['sync_company', 'refresh_transaction_mirror', 'get_write_safety', 'refresh_provider_actionability'].includes(tool.name),
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
