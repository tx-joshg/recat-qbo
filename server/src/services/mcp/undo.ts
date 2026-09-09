import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import type {
  Actor,
  PreparedCategorizationUndo,
} from '../writeback.js';
import { prepareCategorizationUndo } from '../writeback.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';
import {
  McpOperationError,
  createPreparedOperation,
  hasValidMcpOperationIntegrity,
  loadOwnedOperation,
  normalizeMcpOperationIdempotencyKey,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';

const TOOL_NAME = 'prepare_undo';
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 200;
const MAX_PRISMA_INT = 2_147_483_647;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PrepareMcpUndoInput {
  operationId: string;
  idempotencyKey: string;
}

export interface McpUndoPreview {
  action: 'restore_purchase_categorization';
  resultingStatus: 'PENDING';
  direction: 'purchase' | 'refund';
  totalCents: number;
  totalTaxCents: number | null;
  lineCount: number;
  restorationDigest: string;
}

export interface PreparedMcpUndoDto {
  operationId: string;
  sourceOperationId: string;
  expiresAt: string;
  preview: McpUndoPreview;
  warnings: string[];
}

type PrepareUndo = typeof prepareCategorizationUndo;

type CreateOperation = typeof createPreparedOperation;

export interface McpUndoStore
  extends McpOperationStore, McpCategorizationAuthorizationStore {
  user: {
    findUnique(args: {
      where: { id: string };
      select: { name: true };
    }): Promise<{ name: string | null } | null>;
  };
}

export interface McpUndoDeps {
  store?: McpUndoStore;
  now?: () => Date;
  prepareUndo?: PrepareUndo;
  createOperation?: CreateOperation;
}

export type McpUndoErrorCode =
  | 'UNDO_NOT_ALLOWED'
  | 'OPERATION_CORRUPT';

const ERROR_MESSAGES: Readonly<Record<McpUndoErrorCode, string>> = {
  UNDO_NOT_ALLOWED: 'This operation cannot be undone through MCP.',
  OPERATION_CORRUPT: 'This MCP undo operation is corrupt.',
};

export class McpUndoError extends Error {
  constructor(readonly code: McpUndoErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpUndoError';
  }
}

const safeCents = z.number().refine(Number.isSafeInteger);
const previewSchema = z.object({
  action: z.literal('restore_purchase_categorization'),
  resultingStatus: z.literal('PENDING'),
  direction: z.enum(['purchase', 'refund']),
  totalCents: safeCents,
  totalTaxCents: safeCents.nullable(),
  lineCount: z.number().int().min(0).max(10_000),
  restorationDigest: z.string().regex(SHA256),
}).strict();
const storedPreviewSchema = previewSchema.extend({
  // Pre-upgrade operations recorded the provider transition instead of the
  // mutable Transaction projection's queue state. Accept and normalize them.
  resultingStatus: z.enum(['PENDING', 'REVERTED']),
});
const storedUndoPayloadSchema = z.object({
  sourceOperationId: z.string().uuid(),
  sourcePreparedHash: z.string().regex(SHA256),
  currentPostHash: z.string().regex(SHA256),
  restoreHash: z.string().regex(SHA256),
  preview: storedPreviewSchema,
  warnings: z.array(z.string().max(MAX_WARNING_LENGTH)).max(MAX_WARNINGS),
}).strict();

export interface StoredMcpUndoPayload {
  sourceOperationId: string;
  sourcePreparedHash: string;
  currentPostHash: string;
  restoreHash: string;
  preview: McpUndoPreview;
  warnings: string[];
}

export function parseStoredMcpUndoPayload(payload: unknown): StoredMcpUndoPayload {
  const parsed = storedUndoPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new McpUndoError('OPERATION_CORRUPT');
  return {
    ...parsed.data,
    preview: {
      ...parsed.data.preview,
      resultingStatus: 'PENDING',
    },
  };
}

export async function prepareMcpUndo(
  principal: McpPrincipal,
  input: PrepareMcpUndoInput,
  dependencies: McpUndoDeps = {},
): Promise<PreparedMcpUndoDto> {
  const store = (dependencies.store ?? prisma) as unknown as McpUndoStore;
  const now = nowFrom(dependencies);
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) throw new McpOperationError('OPERATION_INVALID_INPUT');

  const source = await loadOwnedOperation(input.operationId, principal, { store });
  await assertCurrentMcpCategorizationAuthorization(
    store,
    principal,
    source.companyId,
    now,
  );
  assertEligibleSource(source);

  const replay = await store.mcpOperation.findFirst({
    where: {
      tokenId: principal.tokenId,
      toolName: TOOL_NAME,
      transactionId: source.transactionId,
      idempotencyKey,
    },
  });
  if (replay !== null) {
    assertExactReplay(replay, source, principal, idempotencyKey);
    return toPreparedDto(replay);
  }

  const prepareUndo = dependencies.prepareUndo ?? prepareCategorizationUndo;
  const prepared = await prepareUndo({
    transactionId: source.transactionId,
    companyId: source.companyId,
    sourceRequestId: source.id,
    expectedRevision: source.preparedRevision,
    expectedSourceSyncToken: source.qboSyncToken,
    expectedQboBinding: {
      qboType: source.qboType,
      qboId: source.qboId,
    },
    actor: await actorFor(source, store),
    authorization: {
      kind: 'mcp',
      tokenId: source.tokenId,
      tokenPrefix: source.tokenPrefix,
    },
  });
  assertPreparedMatchesSource(prepared, source);

  const create = dependencies.createOperation ?? createPreparedOperation;
  const operation = await create({
    principal,
    companyId: source.companyId,
    transactionId: source.transactionId,
    toolName: TOOL_NAME,
    kind: 'undo',
    idempotencyKey,
    payload: {
      sourceOperationId: source.id,
      sourcePreparedHash: prepared.sourcePreparedHash,
      currentPostHash: prepared.currentPostHash,
      restoreHash: prepared.restoreHash,
      preview: prepared.preview,
      warnings: [],
    },
    sourceRevision: prepared.revision,
    preparedRevision: prepared.revision,
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    qboSyncToken: prepared.qboSyncToken,
    retryOfId: null,
  }, { store, now: () => now });
  return toPreparedDto(operation);
}

function assertEligibleSource(source: McpOperationRecord): void {
  if (
    source.kind !== 'categorization'
    || source.toolName !== 'prepare_categorization'
  ) {
    throw new McpOperationError('OPERATION_NOT_FOUND');
  }
  if (
    source.qboType !== 'Purchase'
    || !hasValidMcpOperationIntegrity(source)
  ) {
    throw new McpUndoError('UNDO_NOT_ALLOWED');
  }
}

function assertPreparedMatchesSource(
  prepared: PreparedCategorizationUndo,
  source: McpOperationRecord,
): void {
  if (
    prepared.transactionId !== source.transactionId
    || prepared.companyId !== source.companyId
    || prepared.revision !== source.preparedRevision
    || prepared.qboType !== 'Purchase'
    || prepared.qboId !== source.qboId
    || !SHA256.test(prepared.sourcePreparedHash)
    || !SHA256.test(prepared.currentPostHash)
    || !SHA256.test(prepared.restoreHash)
    || prepared.preview.restorationDigest !== prepared.restoreHash
    || !previewSchema.safeParse(prepared.preview).success
  ) {
    throw new McpUndoError('UNDO_NOT_ALLOWED');
  }
}

function assertExactReplay(
  operation: McpOperationRecord,
  source: McpOperationRecord,
  principal: McpPrincipal,
  idempotencyKey: string,
): void {
  let payload: StoredMcpUndoPayload;
  try {
    payload = parseStoredMcpUndoPayload(operation.payload);
  } catch {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
  if (
    operation.tokenId !== principal.tokenId
    || operation.tokenPrefix !== principal.tokenPrefix
    || operation.userId !== principal.userId
    || operation.companyId !== source.companyId
    || operation.transactionId !== source.transactionId
    || operation.toolName !== TOOL_NAME
    || operation.kind !== 'undo'
    || operation.idempotencyKey !== idempotencyKey
    || operation.retryOfId !== null
    || payload.sourceOperationId !== source.id
    || !hasValidMcpOperationIntegrity(operation)
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
}

function toPreparedDto(operation: McpOperationRecord): PreparedMcpUndoDto {
  if (!isValidDate(operation.expiresAt)) throw new McpUndoError('OPERATION_CORRUPT');
  const payload = parseStoredMcpUndoPayload(operation.payload);
  return {
    operationId: operation.id,
    sourceOperationId: payload.sourceOperationId,
    expiresAt: operation.expiresAt.toISOString(),
    preview: payload.preview,
    warnings: payload.warnings,
  };
}

async function actorFor(
  operation: McpOperationRecord,
  store: McpUndoStore,
): Promise<Actor> {
  const user = await store.user.findUnique({
    where: { id: operation.userId },
    select: { name: true },
  });
  const name = user?.name?.trim().slice(0, 100);
  return {
    id: operation.userId,
    label: `${name || 'MCP user'} (MCP ${operation.tokenPrefix})`,
  };
}

function nowFrom(dependencies: McpUndoDeps): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!isValidDate(now)) throw new McpUndoError('OPERATION_CORRUPT');
  return now;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
