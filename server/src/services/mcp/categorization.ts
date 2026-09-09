import type {
  CategorizationProposal,
  StageCategorizationInput,
  StagedCategorization,
} from '@recat/shared';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  stageCategorizationWithWorkflow,
  type CategorizationDeps,
  type CategorizationStagingWorkflow,
} from '../categorization.js';
import {
  McpOperationError,
  createPreparedOperation,
  hashOperationPayload,
  normalizeMcpOperationIdempotencyKey,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';
import {
  assertProviderActionabilityAllowsPrepare,
  actionabilityObservationFromRow,
  type ActionabilityTransactionIdentity,
  type ProviderActionabilityObservation,
} from '../providerActionability.js';

const TOOL_NAME = 'prepare_categorization';
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 200;
const MAX_PREVIEW_LINES = 20;
const MAX_TAGS = 50;
const MAX_MEMO_LENGTH = 500;
const MAX_QBO_REFERENCE_LENGTH = 120;
const MAX_PRISMA_INT = 2_147_483_647;

export interface PrepareMcpCategorizationInput {
  companyId: string;
  transactionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  proposal: CategorizationProposal;
}

/**
 * Read-only recovery input for an exact prepare that was accepted by a
 * transport but whose response was lost before the caller received its ID.
 */
export interface GetPreparedMcpCategorizationInput {
  companyId: string;
  transactionId: string;
  idempotencyKey: string;
}

export interface PreparedMcpCategorizationDto {
  operationId: string;
  expiresAt: string;
  sourceRevision: number;
  preparedRevision: number;
  preview: {
    transactionId: string;
    revision: number;
    taxDisposition: NonNullable<StagedCategorization['taxDisposition']>;
    taxCalculation: StagedCategorization['taxCalculation'];
    totals: StagedCategorization['totals'];
    lines: Array<Pick<
      StagedCategorization['lines'][number],
      | 'idx'
      | 'subtotalCents'
      | 'taxCents'
      | 'totalCents'
      | 'categoryQboId'
      | 'taxCodeQboId'
    >>;
    transactionTagCount: number;
    lineTagCount: number;
  };
  warnings: string[];
}

type StageWithWorkflow = typeof stageCategorizationWithWorkflow;
type CreateOperation = typeof createPreparedOperation;

export interface McpCategorizationDeps {
  stage?: StageWithWorkflow;
  categorization?: CategorizationDeps;
  authorizationStore?: McpCategorizationAuthorizationStore;
  operationStore?: McpOperationStore;
  createOperation?: CreateOperation;
  now?: () => Date;
}

interface CurrentTokenRow {
  id: string;
  user: { isInstanceAdmin: boolean };
}

export interface McpCategorizationAuthorizationStore {
  mcpToken: {
    findFirst(args: {
      where: {
        id: string;
        userId: string;
        prefix: string;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
      select: {
        id: true;
        user: { select: { isInstanceAdmin: true } };
      };
    }): Promise<CurrentTokenRow | null>;
  };
  company: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ disconnectedAt: Date | null } | null>;
  };
  membership: {
    findUnique(args: {
      where: {
        userId_companyId: {
          userId: string;
          companyId: string;
        };
      };
      select: { role: true };
    }): Promise<{ role: string } | null>;
  };
}

interface McpCategorizationTransaction
  extends McpOperationStore, McpCategorizationAuthorizationStore {
  /** Optional after the provider-actionability migration. */
  transaction?: {
    findFirst(args: {
      where: { id: string; companyId: string };
    }): Promise<ActionabilityTransactionIdentity | null>;
  };
  transactionActionability?: {
    findUnique(args: { where: { transactionId: string } }): Promise<ProviderActionabilityObservation | null>;
  };
}

export type McpCategorizationErrorCode =
  | 'MCP_UNAUTHORIZED'
  | 'MCP_FORBIDDEN'
  | 'COMPANY_DISCONNECTED'
  | 'ENTITY_BUSY';

const ERROR_MESSAGES: Readonly<Record<McpCategorizationErrorCode, string>> = {
  MCP_UNAUTHORIZED: 'MCP token is no longer authorized.',
  MCP_FORBIDDEN: 'Current company role cannot use categorization operations.',
  COMPANY_DISCONNECTED: 'This company is disconnected from QuickBooks.',
  ENTITY_BUSY: 'Another write is in progress. Retry with the same idempotency key.',
};

export class McpCategorizationError extends Error {
  constructor(readonly code: McpCategorizationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpCategorizationError';
  }
}

const safeCents = z.number().refine(Number.isSafeInteger);
const boundedTagIds = z.array(z.string().uuid()).max(MAX_TAGS)
  .refine((values) => new Set(values).size === values.length);
const previewSchema = z.object({
  transactionId: z.string().uuid(),
  revision: z.number().int().min(1).max(MAX_PRISMA_INT),
  taxDisposition: z.enum(['set', 'preserve_current']).optional(),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  totals: z.object({
    subtotalCents: safeCents,
    taxCents: safeCents,
    totalCents: safeCents,
  }).strict(),
  lines: z.array(z.object({
    idx: z.number().int().min(0).max(MAX_PREVIEW_LINES - 1),
    subtotalCents: safeCents,
    taxCents: safeCents,
    totalCents: safeCents,
    categoryQboId: z.string().min(1).max(MAX_QBO_REFERENCE_LENGTH),
    taxCodeQboId: z.string().min(1).max(MAX_QBO_REFERENCE_LENGTH).nullable(),
    memo: z.string().max(MAX_MEMO_LENGTH).nullable(),
    tagIds: boundedTagIds,
  }).strict()).min(1).max(MAX_PREVIEW_LINES),
  tagIds: boundedTagIds,
}).strict();
const storedPayloadSchema = z.object({
  proposal: z.unknown(),
  preview: previewSchema,
  warnings: z.array(z.string().max(MAX_WARNING_LENGTH)).max(MAX_WARNINGS),
}).strict();

export function parseStoredMcpCategorizationPayload(payload: unknown): {
  preview: StagedCategorization;
  warnings: string[];
} {
  const parsed = storedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new McpOperationError('OPERATION_CONFLICT');
  return {
    preview: parsed.data.preview,
    warnings: parsed.data.warnings,
  };
}

export async function prepareMcpCategorization(
  principal: McpPrincipal,
  input: PrepareMcpCategorizationInput,
  dependencies: McpCategorizationDeps = {},
): Promise<PreparedMcpCategorizationDto> {
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) {
    throw new McpOperationError('OPERATION_INVALID_INPUT');
  }
  const stage = dependencies.stage ?? stageCategorizationWithWorkflow;
  const authorizationStore = dependencies.authorizationStore
    ?? prisma as unknown as McpCategorizationAuthorizationStore;
  const createOperation = dependencies.createOperation ?? createPreparedOperation;
  const currentTime = dependencies.now ?? (() => new Date());
  let authorizedAt: Date | null = null;

  const preliminaryAt = currentTime();
  if (!isValidDate(preliminaryAt)) {
    throw new McpOperationError('OPERATION_INVALID_INPUT');
  }
  await assertCurrentMcpCategorizationAuthorization(
    authorizationStore,
    principal,
    input.companyId,
    preliminaryAt,
  );

  const stageInput: StageCategorizationInput = {
    companyId: input.companyId,
    transactionId: input.transactionId,
    expectedRevision: input.expectedRevision,
    proposal: input.proposal,
  };
  const workflow: CategorizationStagingWorkflow<PreparedMcpCategorizationDto> = {
    beforeValidation: async (rawTransaction, normalizedInput) => {
      const transaction = rawTransaction as unknown as McpCategorizationTransaction;
      authorizedAt = currentTime();
      if (!isValidDate(authorizedAt)) {
        throw new McpOperationError('OPERATION_INVALID_INPUT');
      }
      await assertCurrentMcpCategorizationAuthorization(
        transaction,
        principal,
        normalizedInput.companyId,
        authorizedAt,
      );

      // A byte-identical replay returns the already prepared durable
      // operation. It must not depend on a later-expiring actionability cache.
      const existing = await transaction.mcpOperation.findFirst({
        where: {
          tokenId: principal.tokenId,
          toolName: TOOL_NAME,
          transactionId: normalizedInput.transactionId,
          idempotencyKey,
        },
      });
      if (existing !== null) {
        assertExactPrepareReplay(existing, principal, normalizedInput, idempotencyKey);
        return { kind: 'return', value: toPreparedDto(existing) };
      }

      // Once the provider-actionability migration is present, reject known
      // blocked/unknown transactions before staging changes or creating a new
      // MCP operation. Commit still performs its independent fresh QBO check.
      if (transaction.transaction && transaction.transactionActionability) {
        const current = await transaction.transaction.findFirst({
          where: {
            id: normalizedInput.transactionId,
            companyId: normalizedInput.companyId,
          },
        });
        if (current !== null) {
          const observation = await transaction.transactionActionability.findUnique({
            where: { transactionId: normalizedInput.transactionId },
          });
          assertProviderActionabilityAllowsPrepare(
            actionabilityObservationFromRow(observation),
            current,
            authorizedAt,
          );
        }
      }

      return { kind: 'continue' };
    },
    afterStage: async (rawTransaction, receipt) => {
      const transaction = rawTransaction as unknown as McpCategorizationTransaction;
      if (authorizedAt === null) throw new McpOperationError('OPERATION_CONFLICT');
      const operationInput: CreatePreparedOperationInput = {
        principal,
        companyId: input.companyId,
        transactionId: input.transactionId,
        toolName: TOOL_NAME,
        kind: 'categorization',
        idempotencyKey,
        payload: {
          proposal: receipt.normalizedProposal,
          preview: receipt.staged,
          warnings: [],
        },
        sourceRevision: receipt.sourceRevision,
        preparedRevision: receipt.preparedRevision,
        qboType: receipt.qboType,
        qboId: receipt.qboId,
        qboSyncToken: receipt.qboSyncToken,
        retryOfId: null,
      };
      const operation = await createOperation(operationInput, {
        store: transaction,
        now: () => authorizedAt!,
      });
      return toPreparedDto(operation);
    },
  };

  try {
    return await stage(stageInput, workflow, dependencies.categorization);
  } catch (caught) {
    if (isEntityBusy(caught)) throw new McpCategorizationError('ENTITY_BUSY');
    throw caught;
  }
}

/**
 * Recover only the caller's exact durable preparation envelope. This is a
 * read path: it neither stages a revision nor reaches QuickBooks.
 */
export async function getPreparedMcpCategorization(
  principal: McpPrincipal,
  input: GetPreparedMcpCategorizationInput,
  dependencies: McpCategorizationDeps = {},
): Promise<PreparedMcpCategorizationDto> {
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) throw new McpOperationError('OPERATION_INVALID_INPUT');

  const currentTime = dependencies.now ?? (() => new Date());
  const checkedAt = currentTime();
  if (!isValidDate(checkedAt)) throw new McpOperationError('OPERATION_INVALID_INPUT');

  const authorizationStore = dependencies.authorizationStore
    ?? prisma as unknown as McpCategorizationAuthorizationStore;
  await assertCurrentMcpCategorizationAuthorization(
    authorizationStore,
    principal,
    input.companyId,
    checkedAt,
  );

  const operationStore = dependencies.operationStore
    ?? prisma as unknown as McpOperationStore;
  const operation = await operationStore.mcpOperation.findFirst({
    where: {
      tokenId: principal.tokenId,
      toolName: TOOL_NAME,
      transactionId: input.transactionId,
      idempotencyKey,
    },
  });
  if (
    operation === null
    || operation.tokenPrefix !== principal.tokenPrefix
    || operation.userId !== principal.userId
    || operation.companyId !== input.companyId
    || operation.kind !== 'categorization'
    || operation.cancelledAt !== null
    || operation.retryOfId !== null
  ) throw new McpOperationError('OPERATION_NOT_FOUND');

  return toPreparedDto(operation);
}

export async function assertCurrentMcpCategorizationAuthorization(
  transaction: McpCategorizationAuthorizationStore,
  principal: McpPrincipal,
  companyId: string,
  checkedAt: Date,
): Promise<void> {
  const token = await transaction.mcpToken.findFirst({
    where: {
      id: principal.tokenId,
      userId: principal.userId,
      prefix: principal.tokenPrefix,
      revokedAt: null,
      expiresAt: { gt: checkedAt },
    },
    select: {
      id: true,
      user: { select: { isInstanceAdmin: true } },
    },
  });
  if (token === null) throw new McpCategorizationError('MCP_UNAUTHORIZED');

  if (!token.user.isInstanceAdmin) {
    const membership = await transaction.membership.findUnique({
      where: {
        userId_companyId: {
          userId: principal.userId,
          companyId,
        },
      },
      select: { role: true },
    });
    if (membership?.role !== 'categorizer' && membership?.role !== 'admin') {
      throw new McpCategorizationError('MCP_FORBIDDEN');
    }
  }

  const company = await transaction.company.findUnique({
    where: { id: companyId },
  });
  if (company === null || company.disconnectedAt !== null) {
    throw new McpCategorizationError('COMPANY_DISCONNECTED');
  }
}

function assertExactPrepareReplay(
  existing: McpOperationRecord,
  principal: McpPrincipal,
  input: StageCategorizationInput,
  idempotencyKey: string,
): void {
  const payload = dataRecord(existing.payload);
  let proposalMatches = false;
  try {
    proposalMatches = (
      payload !== null
      && 'proposal' in payload
      && hashOperationPayload(payload.proposal) === hashOperationPayload(input.proposal)
    );
  } catch {
    proposalMatches = false;
  }
  if (
    existing.tokenId !== principal.tokenId
    || existing.tokenPrefix !== principal.tokenPrefix
    || existing.userId !== principal.userId
    || existing.companyId !== input.companyId
    || existing.transactionId !== input.transactionId
    || existing.toolName !== TOOL_NAME
    || existing.kind !== 'categorization'
    || existing.idempotencyKey !== idempotencyKey
    || existing.sourceRevision !== input.expectedRevision
    || existing.retryOfId !== null
    || !proposalMatches
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
}

function toPreparedDto(operation: McpOperationRecord): PreparedMcpCategorizationDto {
  if (!isValidDate(operation.expiresAt)) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  const payload = parseStoredMcpCategorizationPayload(operation.payload);
  const staged = payload.preview;
  return {
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    sourceRevision: operation.sourceRevision,
    preparedRevision: operation.preparedRevision,
    preview: {
      transactionId: staged.transactionId,
      revision: staged.revision,
      taxDisposition: staged.taxDisposition ?? 'set',
      taxCalculation: staged.taxCalculation,
      totals: staged.totals,
      lines: staged.lines.map((line) => ({
        idx: line.idx,
        subtotalCents: line.subtotalCents,
        taxCents: line.taxCents,
        totalCents: line.totalCents,
        categoryQboId: line.categoryQboId,
        taxCodeQboId: line.taxCodeQboId,
      })),
      transactionTagCount: staged.tagIds.length,
      lineTagCount: staged.lines.reduce(
        (count, line) => count + (line.tagIds?.length ?? 0),
        0,
      ),
    },
    warnings: payload.warnings,
  };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isEntityBusy(value: unknown): boolean {
  return (
    value !== null
    && typeof value === 'object'
    && 'code' in value
    && (value as { code?: unknown }).code === 'ENTITY_BUSY'
  );
}
