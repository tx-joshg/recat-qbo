import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod-v4';
import {
  prepareMcpCategorization,
  type PrepareMcpCategorizationInput,
} from '../services/mcp/categorization.js';
import {
  commitMcpCategorization,
  commitMcpUndo,
  getMcpOperation,
  retryMcpOperation,
  type CommitMcpCategorizationInput,
  type CommitMcpUndoInput,
  type GetMcpOperationInput,
  type RetryMcpOperationInput,
} from '../services/mcp/reconciliation.js';
import {
  prepareMcpUndo,
  type PrepareMcpUndoInput,
} from '../services/mcp/undo.js';
import {
  commitMcpTransfer,
  prepareMcpTransfer,
  type PrepareMcpTransferInput,
} from '../services/mcp/transfers.js';
import type { McpPrincipal } from './auth.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  toBoundedJsonSchema,
} from './schemaBounds.js';
import {
  ATTACHMENT_TOOL_NAMES,
  attachmentToolDefinitions,
  mcpAttachmentOperations,
  type McpAttachmentOperations,
} from './attachmentTools.js';
import {
  RECEIPT_TOOL_NAMES,
  mcpReceiptOperations,
  receiptToolDefinitions,
  type McpReceiptOperations,
} from './receiptTools.js';

const CORE_MUTATION_TOOL_NAMES = [
  'prepare_categorization',
  'commit_categorization',
  'get_operation',
  'retry_operation',
  'prepare_undo',
  'commit_undo',
  'prepare_transfer',
  'commit_transfer',
] as const;

export const MUTATION_TOOL_NAMES = [
  ...CORE_MUTATION_TOOL_NAMES,
  ...ATTACHMENT_TOOL_NAMES,
  ...RECEIPT_TOOL_NAMES,
] as const;

export interface McpMutationOperations
  extends McpAttachmentOperations, McpReceiptOperations {
  prepareCategorization(
    principal: McpPrincipal,
    input: PrepareMcpCategorizationInput,
  ): ReturnType<typeof prepareMcpCategorization>;
  commitCategorization(
    principal: McpPrincipal,
    input: CommitMcpCategorizationInput,
  ): ReturnType<typeof commitMcpCategorization>;
  getOperation(
    principal: McpPrincipal,
    input: GetMcpOperationInput,
  ): ReturnType<typeof getMcpOperation>;
  retryOperation(
    principal: McpPrincipal,
    input: RetryMcpOperationInput,
  ): ReturnType<typeof retryMcpOperation>;
  prepareUndo(
    principal: McpPrincipal,
    input: PrepareMcpUndoInput,
  ): ReturnType<typeof prepareMcpUndo>;
  commitUndo(
    principal: McpPrincipal,
    input: CommitMcpUndoInput,
  ): ReturnType<typeof commitMcpUndo>;
  prepareTransfer(
    principal: McpPrincipal,
    input: PrepareMcpTransferInput,
  ): ReturnType<typeof prepareMcpTransfer>;
  commitTransfer(
    principal: McpPrincipal,
    input: { operationId: string; idempotencyKey?: string },
  ): ReturnType<typeof commitMcpTransfer>;
}

export const mcpMutationOperations: McpMutationOperations = Object.freeze({
  ...mcpAttachmentOperations,
  ...mcpReceiptOperations,
  prepareCategorization: prepareMcpCategorization,
  commitCategorization: commitMcpCategorization,
  getOperation: getMcpOperation,
  retryOperation: retryMcpOperation,
  prepareUndo: prepareMcpUndo,
  commitUndo: commitMcpUndo,
  prepareTransfer: prepareMcpTransfer,
  commitTransfer: commitMcpTransfer,
});

interface McpMutationToolDefinition {
  name: typeof MUTATION_TOOL_NAMES[number];
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  invoke(
    operations: McpMutationOperations,
    principal: McpPrincipal,
    input: unknown,
  ): Promise<unknown>;
}

const MAX_EXPECTED_REVISION = 2_147_483_646;
const MAX_REVISION = 2_147_483_647;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_QBO_REFERENCE_LENGTH = 120;
const MAX_MEMO_LENGTH = 500;
const MAX_TAGS = 50;
const MAX_LINES = 20;
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 200;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

const uuid = z.string().uuid();
const revision = z.number().int().min(0).max(MAX_REVISION);
const safeInteger = z.number().int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string()
  .trim()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH)
  .regex(SAFE_TEXT)
  .refine((value) => value === value.normalize('NFC'));
const qboReference = z.string()
  .trim()
  .min(1)
  .max(MAX_QBO_REFERENCE_LENGTH);
const uniqueTagIds = z.array(uuid).max(MAX_TAGS)
  .refine((values) => new Set(values).size === values.length);
const proposalLine = z.strictObject({
  grossCents: safeInteger,
  categoryQboId: qboReference,
  taxCodeQboId: qboReference.nullable().optional(),
  memo: z.string().max(MAX_MEMO_LENGTH).optional(),
  tagIds: uniqueTagIds,
});
const proposal = z.strictObject({
  taxDisposition: z.enum(['set', 'preserve_current']).optional(),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  lines: z.array(proposalLine).min(1).max(MAX_LINES),
  tagIds: uniqueTagIds,
}).superRefine((value, context) => {
  if (value.taxDisposition === 'preserve_current') {
    if (value.taxCalculation !== 'NotApplicable') {
      context.addIssue({
        code: 'custom',
        message: 'Preserve-current requires NotApplicable tax calculation.',
        path: ['taxCalculation'],
      });
    }
    if (value.lines.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Preserve-current requires exactly one line.',
        path: ['lines'],
      });
    }
    if (value.tagIds.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'Preserve-current cannot change transaction tags.',
        path: ['tagIds'],
      });
    }
    for (const [index, line] of value.lines.entries()) {
      if (line.taxCodeQboId == null) {
        context.addIssue({
          code: 'custom',
          message: 'Preserve-current requires an explicit source tax code.',
          path: ['lines', index, 'taxCodeQboId'],
        });
      }
      if (line.memo !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Preserve-current cannot change line memos.',
          path: ['lines', index, 'memo'],
        });
      }
      if (line.tagIds.length !== 0) {
        context.addIssue({
          code: 'custom',
          message: 'Preserve-current cannot change line tags.',
          path: ['lines', index, 'tagIds'],
        });
      }
    }
    return;
  }

  for (const [index, line] of value.lines.entries()) {
    if (
      value.taxCalculation === 'NotApplicable'
      && line.taxCodeQboId != null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'NotApplicable lines cannot select a tax code.',
        path: ['lines', index, 'taxCodeQboId'],
      });
    }
    if (
      value.taxCalculation !== 'NotApplicable'
      && line.taxCodeQboId == null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Taxed lines require a tax code.',
        path: ['lines', index, 'taxCodeQboId'],
      });
    }
  }
});

const prepareCategorizationInput = z.strictObject({
  companyId: uuid,
  transactionId: uuid,
  expectedRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
  idempotencyKey,
  proposal,
});
const operationWithOptionalIdempotencyInput = z.strictObject({
  operationId: uuid,
  idempotencyKey: idempotencyKey.optional(),
});
const operationInput = z.strictObject({ operationId: uuid });
const prepareUndoInput = z.strictObject({
  operationId: uuid,
  idempotencyKey,
});
const prepareTransferInput = z.strictObject({
  companyId: uuid,
  transactionId: uuid,
  counterpartTransactionId: uuid,
  expectedRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
  counterpartExpectedRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
  idempotencyKey: idempotencyKey.optional(),
});

const warnings = z.array(
  z.string().max(MAX_WARNING_LENGTH),
).max(MAX_WARNINGS);
const previewLine = z.strictObject({
  idx: z.number().int().min(0).max(MAX_LINES - 1),
  subtotalCents: safeInteger,
  taxCents: safeInteger,
  totalCents: safeInteger,
  categoryQboId: qboReference,
  taxCodeQboId: qboReference.nullable(),
});
const preparedCategorizationOutput = z.strictObject({
  operationId: uuid,
  expiresAt: z.iso.datetime(),
  sourceRevision: revision,
  preparedRevision: z.number().int().min(1).max(MAX_REVISION),
  preview: z.strictObject({
    transactionId: uuid,
    revision: z.number().int().min(1).max(MAX_REVISION),
    taxDisposition: z.enum(['set', 'preserve_current']),
    taxCalculation: z.enum([
      'TaxInclusive',
      'TaxExcluded',
      'NotApplicable',
    ]),
    totals: z.strictObject({
      subtotalCents: safeInteger,
      taxCents: safeInteger,
      totalCents: safeInteger,
    }),
    lines: z.array(previewLine).min(1).max(MAX_LINES),
    transactionTagCount: z.number().int().min(0).max(MAX_TAGS),
    lineTagCount: z.number().int().min(0).max(MAX_LINES * MAX_TAGS),
  }),
  warnings,
});

const operationResult = z.strictObject({
  outcome: z.enum([
    'VERIFIED',
    'UNCERTAIN',
    'IN_PROGRESS',
    'UNCHANGED',
    'DRY_RUN',
    'RETRYABLE',
  ]),
  status: z.enum([
    'PENDING',
    'POSTING',
    'POSTED',
    'DRY_RUN',
    'ERROR',
    'SUPERSEDED',
    'REVERTED',
  ]),
});
const attachmentOperationResult = z.strictObject({
  fileCount: z.number().int().min(0).max(MAX_LINES),
  attachedCount: z.number().int().min(0).max(MAX_LINES),
  failedCount: z.number().int().min(0).max(MAX_LINES),
  uncertainCount: z.number().int().min(0).max(MAX_LINES),
});
const operationOutput = z.strictObject({
  operationId: uuid,
  kind: z.enum(['categorization', 'transfer', 'undo', 'attachment']),
  companyId: uuid.optional(),
  transactionId: uuid.optional(),
  sourceRevision: revision.optional(),
  preparedRevision: revision.optional(),
  expiresAt: z.iso.datetime().optional(),
  state: z.enum([
    'prepared',
    'committed',
    'retryable',
    'reconciliation_required',
    'expired',
    'cancelled',
  ]),
  phase: z.enum([
    'awaiting_commit',
    'write_prepared',
    'write_committing',
    'write_uncertain',
    'write_retryable',
    'write_unchanged',
    'verified',
    'dry_run',
    'corrupt',
  ]),
  result: z.union([
    operationResult,
    z.strictObject({
      complete: z.boolean(),
      firstLeg: z.strictObject({
        outcome: z.enum([
          'VERIFIED',
          'UNCERTAIN',
          'IN_PROGRESS',
          'UNCHANGED',
          'DRY_RUN',
          'RETRYABLE',
        ]),
      }),
      secondLeg: z.strictObject({
        outcome: z.enum([
          'VERIFIED',
          'UNCERTAIN',
          'IN_PROGRESS',
          'UNCHANGED',
          'DRY_RUN',
          'RETRYABLE',
        ]),
      }),
    }),
    attachmentOperationResult,
  ]).nullable(),
  error: z.strictObject({
    code: z.string().min(1).max(64),
    message: z.string().max(200),
  }).nullable(),
  actions: z.strictObject({
    canCommit: z.boolean(),
    canRetry: z.boolean(),
    requiresReconciliation: z.boolean(),
  }),
}).superRefine((value, context) => {
  const privateScalarFields = [
    'companyId',
    'transactionId',
    'sourceRevision',
    'preparedRevision',
  ] as const;
  if (value.kind === 'transfer' || value.kind === 'attachment') {
    for (const field of privateScalarFields) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Transfer status must not expose private scalar bindings.',
        });
      }
    }
    if (value.expiresAt !== undefined && value.kind === 'attachment') {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Attachment status must not expose an artificial expiry.',
      });
    }
    if (value.expiresAt === undefined && value.kind === 'transfer') {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Transfer status requires its expiry.',
      });
    }
    if (
      value.kind === 'transfer'
      && value.result !== null
      && !('complete' in value.result)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Transfer status requires a paired-leg result.',
      });
    }
    if (
      value.kind === 'attachment'
      && (
        value.result === null
        || !('fileCount' in value.result)
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Attachment status requires bounded file counts.',
      });
    }
  } else {
    for (const field of privateScalarFields) {
      if (value[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Single-transaction status requires its scalar binding.',
        });
      }
    }
    if (value.expiresAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Prepared operation status requires its expiry.',
      });
    }
    if (
      value.result !== null
      && !('outcome' in value.result)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Single-transaction status requires its write result.',
      });
    }
  }
});
const preparedUndoOutput = z.strictObject({
  operationId: uuid,
  sourceOperationId: uuid,
  expiresAt: z.iso.datetime(),
  preview: z.strictObject({
    action: z.literal('restore_purchase_categorization'),
    resultingStatus: z.literal('REVERTED'),
    direction: z.enum(['purchase', 'refund']),
    totalCents: safeInteger,
    totalTaxCents: safeInteger.nullable(),
    lineCount: z.number().int().min(0).max(10_000),
    restorationDigest: z.string().regex(SHA256),
  }),
  warnings,
});
const preparedTransferOutput = z.strictObject({
  operationId: uuid,
  expiresAt: z.iso.datetime(),
  preview: z.strictObject({
    action: z.literal('record_transfer'),
    direction: z.literal('between_accounts'),
    totalCents: safeInteger,
    legCount: z.literal(2),
    preparationDigest: z.string().regex(SHA256),
  }),
});

const prepareCategorizationAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});
const commitAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});
const getOperationAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const prepareUndoAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const prepareTransferAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

export const mutationToolDefinitions: readonly McpMutationToolDefinition[] = [
  {
    name: 'prepare_categorization',
    description: 'Validate and prepare a categorization operation.',
    inputSchema: prepareCategorizationInput,
    outputSchema: preparedCategorizationOutput,
    annotations: prepareCategorizationAnnotations,
    invoke: (operations, principal, input) =>
      operations.prepareCategorization(
        principal,
        input as PrepareMcpCategorizationInput,
      ),
  },
  {
    name: 'commit_categorization',
    description: 'Commit a prepared categorization operation.',
    inputSchema: operationWithOptionalIdempotencyInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.commitCategorization(
        principal,
        input as CommitMcpCategorizationInput,
      ),
  },
  {
    name: 'get_operation',
    description: 'Get the current state of an owned MCP operation.',
    inputSchema: operationInput,
    outputSchema: operationOutput,
    annotations: getOperationAnnotations,
    invoke: (operations, principal, input) =>
      operations.getOperation(principal, input as GetMcpOperationInput),
  },
  {
    name: 'retry_operation',
    description: 'Safely retry or reconcile an owned MCP operation.',
    inputSchema: operationInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.retryOperation(principal, input as RetryMcpOperationInput),
  },
  {
    name: 'prepare_undo',
    description: 'Prepare an undo for a verified categorization operation.',
    inputSchema: prepareUndoInput,
    outputSchema: preparedUndoOutput,
    annotations: prepareUndoAnnotations,
    invoke: (operations, principal, input) =>
      operations.prepareUndo(principal, input as PrepareMcpUndoInput),
  },
  {
    name: 'commit_undo',
    description: 'Commit a prepared undo operation.',
    inputSchema: operationWithOptionalIdempotencyInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.commitUndo(principal, input as CommitMcpUndoInput),
  },
  {
    name: 'prepare_transfer',
    description: 'Validate and prepare a durable two-leg transfer operation.',
    inputSchema: prepareTransferInput,
    outputSchema: preparedTransferOutput,
    annotations: prepareTransferAnnotations,
    invoke: (operations, principal, input) =>
      operations.prepareTransfer(
        principal,
        input as PrepareMcpTransferInput,
      ),
  },
  {
    name: 'commit_transfer',
    description: 'Commit or reconcile a prepared transfer operation.',
    inputSchema: operationWithOptionalIdempotencyInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.commitTransfer(
        principal,
        input as { operationId: string; idempotencyKey?: string },
      ),
  },
  ...attachmentToolDefinitions.map((definition) => ({
    ...definition,
    invoke: (
      operations: McpMutationOperations,
      principal: McpPrincipal,
      input: unknown,
    ) => definition.invoke(operations, principal, input),
  })),
  ...receiptToolDefinitions.map((definition) => ({
    ...definition,
    invoke: (
      operations: McpMutationOperations,
      principal: McpPrincipal,
      input: unknown,
    ) => definition.invoke(operations, principal, input),
  })),
] as const;

for (const { inputSchema, outputSchema } of mutationToolDefinitions) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}
