import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { McpPrincipal } from './auth.js';
import {
  RECEIPT_TOOL_NAMES,
  createMcpReceiptOperations,
  receiptToolDefinitions,
  type McpReceiptOperations,
} from './receiptTools.js';

const companyId = '30000000-0000-4000-8000-000000000003';
const receiptId = '40000000-0000-4000-8000-000000000004';
const transactionId = '50000000-0000-4000-8000-000000000005';

const principal: McpPrincipal = {
  tokenId: '10000000-0000-4000-8000-000000000001',
  tokenPrefix: 'rct_receipt1',
  userId: '20000000-0000-4000-8000-000000000002',
  isInstanceAdmin: false,
  memberships: [{ companyId, role: 'categorizer' }],
};

function tool(name: typeof RECEIPT_TOOL_NAMES[number]) {
  return receiptToolDefinitions.find((definition) => definition.name === name)!;
}

describe('MCP receipt tools', () => {
  it('publishes the exact seven-tool contract with conservative annotations', () => {
    expect(receiptToolDefinitions.map((definition) => definition.name)).toEqual(
      RECEIPT_TOOL_NAMES,
    );
    expect(RECEIPT_TOOL_NAMES).toEqual([
      'create_receipt_upload',
      'ingest_receipt',
      'list_receipts',
      'get_receipt',
      'list_receipt_matches',
      'confirm_receipt_match',
      'attach_receipt',
    ]);
    expect(tool('list_receipts').annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool('attach_receipt').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('keeps binary data out of MCP JSON and applies defaults and hard caps', () => {
    const upload = tool('create_receipt_upload').inputSchema;
    const list = tool('list_receipts').inputSchema;
    expect(upload.parse({ companyId })).toEqual({
      companyId,
      fileCount: 1,
      maxEncodedRequestBytes: 100_000_000,
    });
    expect(upload.safeParse({ companyId, base64: 'JVBERi0=' }).success).toBe(false);
    expect(upload.safeParse({ companyId, fileCount: 21 }).success).toBe(false);
    expect(list.parse({ companyId })).toEqual({
      companyId,
      statuses: [],
      search: '',
      page: 1,
      pageSize: 20,
    });
    expect(list.safeParse({ companyId, pageSize: 101 }).success).toBe(false);
    expect(list.safeParse({ companyId, search: 'x'.repeat(201) }).success).toBe(false);
  });

  it('accepts persisted high-precision receipt decimals without allowing unbounded text', () => {
    const receiptSchema = tool('get_receipt').outputSchema.shape.receipt as z.ZodObject;
    const extractionSchema = receiptSchema.shape.currentExtraction as z.ZodNullable<z.ZodObject>;
    const extraction = extractionSchema.unwrap().shape;
    const lineItem = (extraction.lineItems as z.ZodArray<z.ZodObject>).element.shape;
    const taxComponent = (extraction.taxComponents as z.ZodArray<z.ZodObject>).element.shape;

    expect(extraction.costUsd.safeParse('0.00000001').success).toBe(true);
    expect(extraction.conversionRate.safeParse('1.12345678').success).toBe(true);
    expect(lineItem.quantity.safeParse('0.000000001').success).toBe(true);
    expect(taxComponent.rate.safeParse('0.000001').success).toBe(true);
    expect(extraction.costUsd.safeParse('1'.repeat(101)).success).toBe(false);
    expect(extraction.costUsd.safeParse('not-a-decimal').success).toBe(false);
  });

  it('rejects unknown ingest fields, duplicate uploads, and stale revision ranges', () => {
    const ingest = tool('ingest_receipt').inputSchema;
    const confirm = tool('confirm_receipt_match').inputSchema;
    const uploadId = '60000000-0000-4000-8000-000000000006';
    const base = {
      companyId,
      files: [{ uploadId }],
      idempotencyKey: 'receipt-ingest-1',
    };
    expect(ingest.safeParse({ ...base, bytes: 'AAAA' }).success).toBe(false);
    expect(ingest.safeParse({
      ...base,
      files: [{ uploadId }, { uploadId }],
    }).success).toBe(false);
    expect(confirm.safeParse({
      companyId,
      receiptId,
      transactionId,
      expectedReceiptRevision: 2_147_483_647,
      expectedTransactionRevision: 0,
    }).success).toBe(false);
  });

  it('binds ingestion to the authenticated principal and MCP source kind', async () => {
    const ingest = vi.fn().mockResolvedValue({ receipts: [] });
    const operations = { ingest } as unknown as McpReceiptOperations;
    const input = {
      companyId,
      files: [{
        uploadId: '60000000-0000-4000-8000-000000000006',
        sourceExternalId: 'mailbox-item-1',
      }],
      idempotencyKey: 'receipt-ingest-1',
    };

    await tool('ingest_receipt').invoke(operations, principal, input);

    expect(ingest).toHaveBeenCalledWith(principal, input);
  });

  it('passes both current revisions through confirm and attach', async () => {
    const confirmMatch = vi.fn().mockResolvedValue({ receipt: null });
    const attachReceipt = vi.fn().mockResolvedValue({
      operationId: '70000000-0000-4000-8000-000000000007',
      kind: 'attachment',
      state: 'committed',
      phase: 'verified',
      result: {
        fileCount: 1,
        attachedCount: 1,
        failedCount: 0,
        uncertainCount: 0,
      },
      error: null,
      actions: {
        canCommit: false,
        canRetry: false,
        requiresReconciliation: false,
      },
    });
    const operations = {
      confirmMatch,
      attachReceipt,
    } as unknown as McpReceiptOperations;
    const input = {
      companyId,
      receiptId,
      transactionId,
      expectedReceiptRevision: 7,
      expectedTransactionRevision: 9,
    };

    await tool('confirm_receipt_match').invoke(operations, principal, input);
    await tool('attach_receipt').invoke(operations, principal, input);

    expect(confirmMatch).toHaveBeenCalledWith(principal, input);
    expect(attachReceipt).toHaveBeenCalledWith(principal, input);
  });

  it('binds real adapters to the token actor and rejects unreadable companies', async () => {
    const create = vi.fn().mockResolvedValue({ receipts: [] });
    const list = vi.fn().mockResolvedValue({
      receipts: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const operations = createMcpReceiptOperations({
      create: create as never,
      list: list as never,
    });
    const ingestInput = {
      companyId,
      files: [{ uploadId: '60000000-0000-4000-8000-000000000006' }],
      idempotencyKey: 'actor-binding-1',
    };

    await operations.ingest(principal, ingestInput);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({
        kind: 'mcp',
        actorKey: `mcp:${principal.tokenId}`,
        userId: principal.userId,
      }),
      companyId,
      sourceKind: 'MCP_UPLOAD',
    }));
    await expect(operations.list(principal, {
      companyId: '80000000-0000-4000-8000-000000000008',
      statuses: [],
      search: '',
      page: 1,
      pageSize: 20,
    })).rejects.toMatchObject({ code: 'RECEIPT_FORBIDDEN' });
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses to attach when the named transaction is no longer the persisted match', async () => {
    const get = vi.fn().mockResolvedValue({
      revision: 7,
      matchedTransactionId: '90000000-0000-4000-8000-000000000009',
    });
    const attach = vi.fn();
    const operations = createMcpReceiptOperations({
      get: get as never,
      attach: attach as never,
    });

    await expect(operations.attachReceipt(principal, {
      companyId,
      receiptId,
      transactionId,
      expectedReceiptRevision: 7,
      expectedTransactionRevision: 9,
    })).rejects.toMatchObject({ code: 'RECEIPT_STALE' });
    expect(get).toHaveBeenCalledWith(companyId, receiptId);
    expect(attach).not.toHaveBeenCalled();
  });
});
