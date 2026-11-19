import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type {
  AttachmentUploadGrantDto,
  CreateReceiptsResult,
  ReceiptDetailDto,
  ReceiptListResponse,
} from '@recat/shared';
import { z } from 'zod';
import { issueAttachmentUploadGrant } from '../services/attachments/grants.js';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from '../services/attachments/validation.js';
import { createReceipts } from '../services/receipts/intake.js';
import {
  attachMatchedReceipt,
  confirmReceiptMatch,
} from '../services/receipts/matching.js';
import {
  getReceiptDetail,
  listReceipts,
} from '../services/receipts/query.js';
import { ReceiptError } from '../services/receipts/types.js';
import {
  attachmentActorForPrincipal,
  attachmentOperationOutput,
  attachmentOutput,
  projectMcpAttachmentOperation,
  type McpAttachmentOperationProjection,
} from './attachmentTools.js';
import type { McpPrincipal } from './auth.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  toBoundedJsonSchema,
} from './schemaBounds.js';

export const RECEIPT_TOOL_NAMES = [
  'create_receipt_upload',
  'ingest_receipt',
  'list_receipts',
  'get_receipt',
  'list_receipt_matches',
  'confirm_receipt_match',
  'attach_receipt',
] as const;

interface ReceiptUploadInput {
  companyId: string;
  fileCount: number;
  maxEncodedRequestBytes: number;
}

interface ReceiptIngestInput {
  companyId: string;
  files: Array<{ uploadId: string; sourceExternalId?: string }>;
  idempotencyKey: string;
}

interface ReceiptListInput {
  companyId: string;
  statuses: ReceiptDetailDto['status'][];
  search: string;
  page: number;
  pageSize: number;
}

interface ReceiptIdInput {
  companyId: string;
  receiptId: string;
}

interface ReceiptMatchInput extends ReceiptIdInput {
  transactionId: string;
  expectedReceiptRevision: number;
  expectedTransactionRevision: number;
}

export interface McpReceiptOperations {
  createUpload(
    principal: McpPrincipal,
    input: ReceiptUploadInput,
  ): Promise<AttachmentUploadGrantDto>;
  ingest(
    principal: McpPrincipal,
    input: ReceiptIngestInput,
  ): Promise<CreateReceiptsResult>;
  list(
    principal: McpPrincipal,
    input: ReceiptListInput,
  ): Promise<ReceiptListResponse>;
  get(
    principal: McpPrincipal,
    input: ReceiptIdInput,
  ): Promise<{ receipt: ReceiptDetailDto }>;
  listMatches(
    principal: McpPrincipal,
    input: ReceiptIdInput,
  ): Promise<{
    receiptId: string;
    receiptRevision: number;
    candidates: ReceiptDetailDto['candidates'];
  }>;
  confirmMatch(
    principal: McpPrincipal,
    input: ReceiptMatchInput,
  ): Promise<{ receipt: ReceiptDetailDto }>;
  attachReceipt(
    principal: McpPrincipal,
    input: ReceiptMatchInput,
  ): Promise<McpAttachmentOperationProjection>;
}

export interface McpReceiptOperationDependencies {
  issueUpload?: typeof issueAttachmentUploadGrant;
  create?: typeof createReceipts;
  list?: typeof listReceipts;
  get?: typeof getReceiptDetail;
  confirm?: typeof confirmReceiptMatch;
  attach?: typeof attachMatchedReceipt;
}

function requireReceiptRead(principal: McpPrincipal, companyId: string): void {
  if (
    principal.isInstanceAdmin
    || principal.memberships.some((membership) =>
      membership.companyId === companyId
      && ['viewer', 'categorizer', 'admin'].includes(membership.role))
  ) return;
  throw new ReceiptError('RECEIPT_FORBIDDEN', 'Receipt access is not allowed.');
}

function boundedReceiptDetail(receipt: ReceiptDetailDto): ReceiptDetailDto {
  return {
    ...receipt,
    attempts: receipt.attempts.slice(0, 20),
    candidates: receipt.candidates.slice(0, 100),
    events: receipt.events.slice(0, 100).map((event) => ({
      ...event,
      before: null,
      after: null,
    })),
  };
}

export function createMcpReceiptOperations(
  dependencies: McpReceiptOperationDependencies = {},
): McpReceiptOperations {
  const issueUpload = dependencies.issueUpload ?? issueAttachmentUploadGrant;
  const create = dependencies.create ?? createReceipts;
  const list = dependencies.list ?? listReceipts;
  const get = dependencies.get ?? getReceiptDetail;
  const confirm = dependencies.confirm ?? confirmReceiptMatch;
  const attach = dependencies.attach ?? attachMatchedReceipt;
  return Object.freeze({
    createUpload: async (
      principal: McpPrincipal,
      input: ReceiptUploadInput,
    ) => issueUpload({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      maxFileCount: input.fileCount,
      maxEncodedRequestBytes: input.maxEncodedRequestBytes,
    }),
    ingest: (principal: McpPrincipal, input: ReceiptIngestInput) => create({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      files: input.files,
      sourceKind: 'MCP_UPLOAD',
      idempotencyKey: input.idempotencyKey,
    }),
    list: async (principal: McpPrincipal, input: ReceiptListInput) => {
      requireReceiptRead(principal, input.companyId);
      return list(input.companyId, {
        statuses: input.statuses,
        documentTypes: [],
        dateFrom: null,
        dateTo: null,
        sourceKinds: [],
        missingInfo: false,
        duplicate: false,
        matched: null,
        search: input.search,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: input.page,
        pageSize: input.pageSize,
      });
    },
    get: async (principal: McpPrincipal, input: ReceiptIdInput) => {
      requireReceiptRead(principal, input.companyId);
      return {
        receipt: boundedReceiptDetail(
          await get(input.companyId, input.receiptId),
        ),
      };
    },
    listMatches: async (principal: McpPrincipal, input: ReceiptIdInput) => {
      requireReceiptRead(principal, input.companyId);
      const receipt = await get(input.companyId, input.receiptId);
      return {
        receiptId: receipt.id,
        receiptRevision: receipt.revision,
        candidates: receipt.candidates.slice(0, 100),
      };
    },
    confirmMatch: async (
      principal: McpPrincipal,
      input: ReceiptMatchInput,
    ) => ({
      receipt: boundedReceiptDetail(await confirm({
        actor: attachmentActorForPrincipal(principal),
        companyId: input.companyId,
        documentId: input.receiptId,
        transactionId: input.transactionId,
        expectedReceiptRevision: input.expectedReceiptRevision,
        expectedTransactionRevision: input.expectedTransactionRevision,
      })),
    }),
    attachReceipt: async (
      principal: McpPrincipal,
      input: ReceiptMatchInput,
    ) => {
      requireReceiptRead(principal, input.companyId);
      const receipt = await get(input.companyId, input.receiptId);
      if (
        receipt.revision !== input.expectedReceiptRevision
        || receipt.matchedTransactionId !== input.transactionId
      ) {
        throw new ReceiptError(
          'RECEIPT_STALE',
          'Receipt match changed; refresh before retrying.',
        );
      }
      return projectMcpAttachmentOperation(await attach({
        actor: attachmentActorForPrincipal(principal),
        companyId: input.companyId,
        documentId: input.receiptId,
        expectedReceiptRevision: input.expectedReceiptRevision,
        expectedTransactionRevision: input.expectedTransactionRevision,
      }));
    },
  });
}

export const mcpReceiptOperations = createMcpReceiptOperations();

const MAX_EXPECTED_REVISION = 2_147_483_646;
const MAX_REVISION = 2_147_483_647;
const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const safeInteger = z.number().int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => value === value.normalize('NFC'));
const receiptStatus = z.enum([
  'RECEIVED',
  'QUEUED',
  'PROCESSING',
  'NEEDS_REVIEW',
  'READY',
  'MATCHED',
  'ATTACHING',
  'ATTACHED',
  'FAILED',
]);

const createReceiptUploadInput = z.strictObject({
  companyId: uuid,
  fileCount: z.number().int().min(1).max(20).default(1),
  maxEncodedRequestBytes: z.number().int()
    .min(1)
    .max(QBO_MAX_UPLOAD_REQUEST_BYTES)
    .default(QBO_MAX_UPLOAD_REQUEST_BYTES),
});
const uploadGrantOutput = z.strictObject({
  uploadUrl: z.string().min(1).max(500),
  grant: z.string().min(16).max(256),
  expiresAt: z.iso.datetime(),
  maxFileCount: z.number().int().min(1).max(20),
  maxEncodedRequestBytes: z.number().int()
    .min(1)
    .max(QBO_MAX_UPLOAD_REQUEST_BYTES),
});
const receiptUploadDescriptor = z.strictObject({
  uploadId: uuid,
  sourceExternalId: z.string().trim().min(1).max(200).optional(),
});
const ingestReceiptInput = z.strictObject({
  companyId: uuid,
  files: z.array(receiptUploadDescriptor).min(1).max(20)
    .refine((files) =>
      new Set(files.map((file) => file.uploadId)).size === files.length),
  idempotencyKey,
});
const listReceiptsInput = z.strictObject({
  companyId: uuid,
  statuses: z.array(receiptStatus).max(5).default([]),
  search: z.string().max(200).default(''),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});
const receiptIdInput = z.strictObject({ companyId: uuid, receiptId: uuid });
const receiptMatchInput = z.strictObject({
  companyId: uuid,
  receiptId: uuid,
  transactionId: uuid,
  expectedReceiptRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
  expectedTransactionRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
});

const decimal = z.string().max(100).regex(
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u,
);
const nullableDecimal = decimal.nullable();
const text = (max: number) => z.string().max(max);
const nullableText = (max: number) => text(max).nullable();
const receiptLineItem = z.strictObject({
  description: text(2_000),
  quantity: nullableDecimal,
  unitPrice: nullableDecimal,
});
const receiptTaxComponent = z.strictObject({
  label: text(200),
  rate: nullableDecimal,
  amount: nullableDecimal,
  confidence: z.number().min(0).max(1).nullable(),
});
const receiptExtraction = z.strictObject({
  id: uuid,
  generation: z.number().int().min(1).max(MAX_REVISION),
  status: z.enum(['running', 'succeeded', 'failed']),
  receiptDate: z.iso.date().nullable(),
  documentTitle: nullableText(500),
  vendorName: nullableText(500),
  vendorTaxId: nullableText(200),
  vendorReceiptId: nullableText(200),
  clientName: nullableText(500),
  clientTaxId: nullableText(200),
  description: nullableText(10_000),
  lineItems: z.array(receiptLineItem).max(1_000),
  subtotal: nullableDecimal,
  taxAmount: nullableDecimal,
  totalAmount: nullableDecimal,
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  convertedAmount: nullableDecimal,
  conversionRate: nullableDecimal,
  paymentMethod: nullableText(80),
  paymentIdentifier: nullableText(200),
  language: nullableText(16),
  additionalFields: z.array(z.strictObject({
    key: text(500),
    value: text(5_000),
  })).max(200),
  rawExtractedText: nullableText(200_000),
  documentType: nullableText(80),
  category: nullableText(500),
  extractionConfidence: z.number().min(0).max(1).nullable(),
  taxComponents: z.array(receiptTaxComponent).max(20),
  parseSalvaged: z.boolean(),
  warnings: z.array(text(500)).max(100),
  model: text(200),
  promptVersion: text(120),
  schemaVersion: text(120),
  tokensIn: z.number().int().min(0).max(MAX_REVISION),
  tokensOut: z.number().int().min(0).max(MAX_REVISION),
  costUsd: nullableDecimal,
  durationMs: z.number().int().min(0).max(MAX_REVISION).nullable(),
  errorCode: nullableText(64),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
const receipt = z.strictObject({
  id: uuid,
  filename: text(255),
  contentType: text(120),
  sizeBytes: z.string().regex(/^\d{1,18}$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceKind: z.enum(['WEB_UPLOAD', 'API_UPLOAD', 'MCP_UPLOAD']),
  status: receiptStatus,
  generation: z.number().int().min(1).max(MAX_REVISION),
  revision: z.number().int().min(0).max(MAX_REVISION),
  pageCount: z.number().int().min(1).max(50).nullable(),
  retentionPolicy: z.boolean(),
  retainedLocally: z.boolean(),
  approved: z.boolean(),
  userNotes: nullableText(20_000),
  manuallyEdited: z.boolean(),
  lastExportedAt: z.iso.datetime().nullable(),
  matchedTransactionId: nullableUuid,
  transactionAttachmentId: nullableUuid,
  currentExtraction: receiptExtraction.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const matchEvidence = z.strictObject({
  amountPoints: z.number().finite(),
  currencyPoints: z.number().finite(),
  datePoints: z.number().finite(),
  vendorPoints: z.number().finite(),
  paymentPoints: z.number().finite(),
  amountDifferenceCents: z.number().finite(),
  dateDifferenceDays: z.number().finite().nullable(),
  vendorSimilarity: z.number().finite().nullable(),
});
const matchCandidate = z.strictObject({
  transactionId: uuid,
  transactionRevision: z.number().int().min(0).max(MAX_REVISION),
  rank: z.number().int().min(1).max(100),
  score: z.number().finite(),
  state: z.enum(['proposed', 'rejected', 'confirmed', 'stale']),
  evidence: matchEvidence,
  transaction: z.strictObject({
    id: uuid,
    date: z.iso.datetime(),
    payee: text(2_048),
    memo: nullableText(2_048),
    amount: z.number().finite(),
    status: z.enum([
      'PENDING',
      'POSTING',
      'POSTED',
      'DRY_RUN',
      'ERROR',
      'SUPERSEDED',
      'REVERTED',
    ]),
    revision: z.number().int().min(0).max(MAX_REVISION),
  }),
});
const receiptDetail = receipt.extend({
  previousId: nullableUuid,
  nextId: nullableUuid,
  attempts: z.array(receiptExtraction).max(20),
  candidates: z.array(matchCandidate).max(100),
  events: z.array(z.strictObject({
    id: uuid,
    action: text(100),
    actorUserId: nullableUuid,
    before: z.null(),
    after: z.null(),
    createdAt: z.iso.datetime(),
  })).max(100),
  attachment: attachmentOutput.nullable(),
});
const ingestOutput = z.strictObject({ receipts: z.array(receipt).max(20) });
const listOutput = z.strictObject({
  receipts: z.array(receipt).max(100),
  total: safeInteger.nonnegative(),
  page: z.number().int().min(1).max(10_000),
  pageSize: z.number().int().min(1).max(100),
});
const detailOutput = z.strictObject({ receipt: receiptDetail });
const matchesOutput = z.strictObject({
  receiptId: uuid,
  receiptRevision: z.number().int().min(0).max(MAX_REVISION),
  candidates: z.array(matchCandidate).max(100),
});

export const receiptToolInputSchemas = Object.freeze({
  create_receipt_upload: createReceiptUploadInput,
  ingest_receipt: ingestReceiptInput,
  list_receipts: listReceiptsInput,
  get_receipt: receiptIdInput,
  list_receipt_matches: receiptIdInput,
  confirm_receipt_match: receiptMatchInput,
  attach_receipt: receiptMatchInput,
});

export interface McpReceiptToolDefinition {
  name: typeof RECEIPT_TOOL_NAMES[number];
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  invoke(
    operations: McpReceiptOperations,
    principal: McpPrincipal,
    input: unknown,
  ): Promise<unknown>;
}

const readAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const grantAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});
const ingestAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const qboWriteAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

export const receiptToolDefinitions: readonly McpReceiptToolDefinition[] = [
  {
    name: 'create_receipt_upload',
    description: 'Create a short-lived authenticated HTTP upload for receipt image or PDF bytes. Binary and base64 content are never accepted in MCP JSON.',
    inputSchema: createReceiptUploadInput,
    outputSchema: uploadGrantOutput,
    annotations: grantAnnotations,
    invoke: (operations, principal, input) => operations.createUpload(
      principal,
      input as ReceiptUploadInput,
    ),
  },
  {
    name: 'ingest_receipt',
    description: 'Ingest token-owned staged receipt uploads for extraction and matching.',
    inputSchema: ingestReceiptInput,
    outputSchema: ingestOutput,
    annotations: ingestAnnotations,
    invoke: (operations, principal, input) => operations.ingest(
      principal,
      input as ReceiptIngestInput,
    ),
  },
  {
    name: 'list_receipts',
    description: 'List bounded receipt metadata and current extraction results for one visible company.',
    inputSchema: listReceiptsInput,
    outputSchema: listOutput,
    annotations: readAnnotations,
    invoke: (operations, principal, input) => operations.list(
      principal,
      input as ReceiptListInput,
    ),
  },
  {
    name: 'get_receipt',
    description: 'Get one visible receipt with bounded extraction attempts and match candidates.',
    inputSchema: receiptIdInput,
    outputSchema: detailOutput,
    annotations: readAnnotations,
    invoke: (operations, principal, input) => operations.get(
      principal,
      input as ReceiptIdInput,
    ),
  },
  {
    name: 'list_receipt_matches',
    description: 'List bounded current transaction candidates for one visible receipt.',
    inputSchema: receiptIdInput,
    outputSchema: matchesOutput,
    annotations: readAnnotations,
    invoke: (operations, principal, input) => operations.listMatches(
      principal,
      input as ReceiptIdInput,
    ),
  },
  {
    name: 'confirm_receipt_match',
    description: 'Confirm a current receipt-to-transaction candidate using both optimistic revisions.',
    inputSchema: receiptMatchInput,
    outputSchema: detailOutput,
    annotations: ingestAnnotations,
    invoke: (operations, principal, input) => operations.confirmMatch(
      principal,
      input as ReceiptMatchInput,
    ),
  },
  {
    name: 'attach_receipt',
    description: 'Attach a confirmed receipt to QuickBooks using both current optimistic revisions.',
    inputSchema: receiptMatchInput,
    outputSchema: attachmentOperationOutput,
    annotations: qboWriteAnnotations,
    invoke: (operations, principal, input) => operations.attachReceipt(
      principal,
      input as ReceiptMatchInput,
    ),
  },
] as const;

for (const { inputSchema, outputSchema } of receiptToolDefinitions) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}
