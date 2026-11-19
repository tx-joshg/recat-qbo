import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type {
  AttachmentDto,
  AttachmentOperationDto,
  AttachmentSourceInput,
  AttachmentUploadGrantDto,
} from '@recat/shared';
import { z } from 'zod';
import {
  attachTransactionFiles,
  deleteTransactionAttachment,
  refreshTransactionAttachments,
  type AttachmentActor,
} from '../services/attachments/operations.js';
import {
  issueAttachmentDownloadGrant,
  issueAttachmentUploadGrant,
  type AttachmentDownloadGrantDto,
} from '../services/attachments/grants.js';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from '../services/attachments/validation.js';
import type { McpPrincipal } from './auth.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  toBoundedJsonSchema,
} from './schemaBounds.js';

export const ATTACHMENT_TOOL_NAMES = [
  'create_attachment_upload',
  'attach_transaction_files',
  'list_transaction_attachments',
  'get_attachment_download',
  'delete_transaction_attachment',
] as const;

export interface McpAttachmentOperationProjection {
  operationId: string;
  kind: 'attachment';
  state:
    | 'prepared'
    | 'committed'
    | 'retryable'
    | 'reconciliation_required';
  phase:
    | 'write_prepared'
    | 'write_committing'
    | 'write_uncertain'
    | 'write_retryable'
    | 'verified';
  result: {
    fileCount: number;
    attachedCount: number;
    failedCount: number;
    uncertainCount: number;
  };
  error: { code: string; message: string } | null;
  actions: {
    canCommit: false;
    canRetry: boolean;
    requiresReconciliation: boolean;
  };
}

export interface McpAttachmentOperations {
  createUpload(
    principal: McpPrincipal,
    input: {
      companyId: string;
      fileCount: number;
      maxEncodedRequestBytes: number;
    },
  ): Promise<AttachmentUploadGrantDto>;
  attachFiles(
    principal: McpPrincipal,
    input: {
      companyId: string;
      transactionId: string;
      idempotencyKey: string;
      sources: AttachmentSourceInput[];
    },
  ): Promise<McpAttachmentOperationProjection>;
  listAttachments(
    principal: McpPrincipal,
    input: { companyId: string; transactionId: string },
  ): Promise<{ attachments: AttachmentDto[] }>;
  getDownload(
    principal: McpPrincipal,
    input: {
      companyId: string;
      transactionId: string;
      attachmentId: string;
    },
  ): Promise<AttachmentDownloadGrantDto>;
  deleteAttachment(
    principal: McpPrincipal,
    input: {
      companyId: string;
      transactionId: string;
      attachmentId: string;
      scope: 'local_only' | 'everywhere';
      idempotencyKey: string;
    },
  ): Promise<McpAttachmentOperationProjection>;
}

export function attachmentActorForPrincipal(
  principal: McpPrincipal,
): AttachmentActor {
  return {
    kind: 'mcp',
    actorKey: `mcp:${principal.tokenId}`,
    userId: principal.userId,
    isInstanceAdmin: principal.isInstanceAdmin,
    memberships: principal.memberships.map((membership) => ({
      companyId: membership.companyId,
      role: membership.role,
    })),
  };
}

export function projectMcpAttachmentOperation(
  operation: AttachmentOperationDto,
): McpAttachmentOperationProjection {
  const attachedCount = operation.files.filter(
    (file) => file.status === 'ATTACHED',
  ).length;
  const failedCount = operation.files.filter(
    (file) => file.status === 'FAILED' || file.status === 'QBO_MISSING',
  ).length;
  const uncertainCount = operation.files.filter(
    (file) => file.status === 'UNCERTAIN' || file.status === 'RECONCILING',
  ).length;
  const state =
    operation.status === 'VERIFIED' || operation.status === 'DELETED'
      ? 'committed'
      : operation.status === 'UNCERTAIN'
        ? 'reconciliation_required'
        : operation.status === 'FAILED' || operation.status === 'PARTIAL'
          ? 'retryable'
          : 'prepared';
  const phase =
    operation.status === 'VERIFIED' || operation.status === 'DELETED'
      ? 'verified'
      : operation.status === 'UNCERTAIN'
        ? 'write_uncertain'
        : operation.status === 'FAILED' || operation.status === 'PARTIAL'
          ? 'write_retryable'
          : operation.status === 'COMMITTING'
              || operation.status === 'DELETING'
            ? 'write_committing'
            : 'write_prepared';
  const firstError = operation.files.find((file) => file.error !== null)?.error;
  return {
    operationId: operation.operationId,
    kind: 'attachment',
    state,
    phase,
    result: {
      fileCount: operation.files.length,
      attachedCount,
      failedCount,
      uncertainCount,
    },
    error: firstError
      ? {
          code: firstError.code.slice(0, 64),
          message: firstError.message.slice(0, 200),
        }
      : null,
    actions: {
      canCommit: false,
      canRetry: operation.actions.canRetry,
      requiresReconciliation: operation.actions.requiresReconciliation,
    },
  };
}

export const mcpAttachmentOperations: McpAttachmentOperations = Object.freeze({
  createUpload: async (
    principal: McpPrincipal,
    input: Parameters<McpAttachmentOperations['createUpload']>[1],
  ) =>
    issueAttachmentUploadGrant({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      maxFileCount: input.fileCount,
      maxEncodedRequestBytes: input.maxEncodedRequestBytes,
    }),
  attachFiles: async (
    principal: McpPrincipal,
    input: Parameters<McpAttachmentOperations['attachFiles']>[1],
  ) =>
    projectMcpAttachmentOperation(await attachTransactionFiles({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      transactionId: input.transactionId,
      idempotencyKey: input.idempotencyKey,
      sources: input.sources,
    })),
  listAttachments: async (
    principal: McpPrincipal,
    input: Parameters<McpAttachmentOperations['listAttachments']>[1],
  ) => ({
    attachments: await refreshTransactionAttachments(
      attachmentActorForPrincipal(principal),
      input.companyId,
      input.transactionId,
    ),
  }),
  getDownload: async (
    principal: McpPrincipal,
    input: Parameters<McpAttachmentOperations['getDownload']>[1],
  ) =>
    issueAttachmentDownloadGrant({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      transactionId: input.transactionId,
      attachmentId: input.attachmentId,
    }),
  deleteAttachment: async (
    principal: McpPrincipal,
    input: Parameters<McpAttachmentOperations['deleteAttachment']>[1],
  ) =>
    projectMcpAttachmentOperation(await deleteTransactionAttachment({
      actor: attachmentActorForPrincipal(principal),
      companyId: input.companyId,
      transactionId: input.transactionId,
      attachmentId: input.attachmentId,
      scope: input.scope === 'local_only' ? 'local' : 'everywhere',
      idempotencyKey: input.idempotencyKey,
    })),
});

const uuid = z.string().uuid();
const idempotencyKey = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => value === value.normalize('NFC'));
const companyTransaction = {
  companyId: uuid,
  transactionId: uuid,
};
const source = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('upload'),
    uploadId: uuid,
  }),
  z.strictObject({
    kind: z.literal('https'),
    url: z.url().max(4096).refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:'
          && parsed.username === ''
          && parsed.password === '';
      } catch {
        return false;
      }
    }),
  }),
]);
const createUploadInput = z.strictObject({
  companyId: uuid,
  fileCount: z.number().int().min(1).max(20),
  maxEncodedRequestBytes: z.number().int()
    .min(1)
    .max(QBO_MAX_UPLOAD_REQUEST_BYTES),
});
const createUploadOutput = z.strictObject({
  uploadUrl: z.string().min(1).max(500),
  grant: z.string().min(16).max(256),
  expiresAt: z.iso.datetime(),
  maxFileCount: z.number().int().min(1).max(20),
  maxEncodedRequestBytes: z.number().int()
    .min(1)
    .max(QBO_MAX_UPLOAD_REQUEST_BYTES),
});
const attachInput = z.strictObject({
  ...companyTransaction,
  idempotencyKey,
  sources: z.array(source).min(1).max(20),
});
const listInput = z.strictObject(companyTransaction);
const downloadInput = z.strictObject({
  ...companyTransaction,
  attachmentId: uuid,
});
const deleteInput = z.strictObject({
  ...companyTransaction,
  attachmentId: uuid,
  scope: z.enum(['local_only', 'everywhere']),
  idempotencyKey,
});
const attachmentError = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().max(200),
}).nullable();
export const attachmentOperationOutput = z.strictObject({
  operationId: uuid,
  kind: z.literal('attachment'),
  state: z.enum([
    'prepared',
    'committed',
    'retryable',
    'reconciliation_required',
  ]),
  phase: z.enum([
    'write_prepared',
    'write_committing',
    'write_uncertain',
    'write_retryable',
    'verified',
  ]),
  result: z.strictObject({
    fileCount: z.number().int().min(0).max(20),
    attachedCount: z.number().int().min(0).max(20),
    failedCount: z.number().int().min(0).max(20),
    uncertainCount: z.number().int().min(0).max(20),
  }),
  error: attachmentError,
  actions: z.strictObject({
    canCommit: z.literal(false),
    canRetry: z.boolean(),
    requiresReconciliation: z.boolean(),
  }),
});
export const attachmentOutput = z.strictObject({
  id: uuid,
  transactionId: uuid,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0).max(QBO_MAX_UPLOAD_REQUEST_BYTES),
  sourceKind: z.enum(['LOCAL_UPLOAD', 'HTTPS_IMPORT', 'QBO_EXTERNAL']),
  retainedLocally: z.boolean(),
  status: z.enum([
    'STAGED',
    'UPLOADING',
    'ATTACHED',
    'FAILED',
    'UNCERTAIN',
    'RECONCILING',
    'DELETING',
    'DELETED',
    'QBO_MISSING',
  ]),
  qboAttached: z.boolean(),
  canPreview: z.boolean(),
  error: attachmentError,
});
const listOutput = z.strictObject({
  attachments: z.array(attachmentOutput).max(500),
});
const downloadOutput = z.strictObject({
  downloadUrl: z.string().min(1).max(500),
  grant: z.string().min(16).max(256),
  expiresAt: z.iso.datetime(),
});

export interface McpAttachmentToolDefinition {
  name: typeof ATTACHMENT_TOOL_NAMES[number];
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  invoke(
    operations: McpAttachmentOperations,
    principal: McpPrincipal,
    input: unknown,
  ): Promise<unknown>;
}

const writeAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});
const grantAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});
const readAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const providerReadAnnotations: ToolAnnotations = Object.freeze({
  ...readAnnotations,
  readOnlyHint: false,
  openWorldHint: true,
});
const downloadAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const deleteAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

export const attachmentToolDefinitions:
readonly McpAttachmentToolDefinition[] = [
  {
    name: 'create_attachment_upload',
    description:
      'Create a short-lived authenticated Recat HTTP upload. Send file bytes to the returned URL; never put binary or base64 content in MCP JSON.',
    inputSchema: createUploadInput,
    outputSchema: createUploadOutput,
    annotations: grantAnnotations,
    invoke: (operations, principal, input) =>
      operations.createUpload(
        principal,
        input as Parameters<McpAttachmentOperations['createUpload']>[1],
      ),
  },
  {
    name: 'attach_transaction_files',
    description:
      'Attach ordered staged upload IDs and/or public HTTPS files to one Recat transaction. File bytes are never accepted in MCP JSON.',
    inputSchema: attachInput,
    outputSchema: attachmentOperationOutput,
    annotations: writeAnnotations,
    invoke: (operations, principal, input) =>
      operations.attachFiles(
        principal,
        input as Parameters<McpAttachmentOperations['attachFiles']>[1],
      ),
  },
  {
    name: 'list_transaction_attachments',
    description:
      'List bounded attachment metadata for one visible Recat transaction.',
    inputSchema: listInput,
    outputSchema: listOutput,
    annotations: providerReadAnnotations,
    invoke: (operations, principal, input) =>
      operations.listAttachments(
        principal,
        input as Parameters<McpAttachmentOperations['listAttachments']>[1],
      ),
  },
  {
    name: 'get_attachment_download',
    description:
      'Create a short-lived authenticated Recat download without exposing a QuickBooks temporary URL.',
    inputSchema: downloadInput,
    outputSchema: downloadOutput,
    annotations: downloadAnnotations,
    invoke: (operations, principal, input) =>
      operations.getDownload(
        principal,
        input as Parameters<McpAttachmentOperations['getDownload']>[1],
      ),
  },
  {
    name: 'delete_transaction_attachment',
    description:
      'Delete only the retained local copy or delete the attachment everywhere, including QuickBooks.',
    inputSchema: deleteInput,
    outputSchema: attachmentOperationOutput,
    annotations: deleteAnnotations,
    invoke: (operations, principal, input) =>
      operations.deleteAttachment(
        principal,
        input as Parameters<McpAttachmentOperations['deleteAttachment']>[1],
      ),
  },
] as const;

for (const { inputSchema, outputSchema } of attachmentToolDefinitions) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}
