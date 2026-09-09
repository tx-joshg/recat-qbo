import type { HistoricalRuleMutationKind, RuleMutationKind } from '@recat/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { McpPrincipal } from '../../mcp/auth.js';
import { prisma } from '../../lib/prisma.js';

export const MCP_OPERATION_EXPIRY_MS = 15 * 60 * 1000;
export const MCP_OPERATION_MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_COLLECTION_ITEMS = 1_000;
const MAX_JSON_NODES = 5_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TOKEN_PREFIX_LENGTH = 12;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_QBO_TYPE_LENGTH = 32;
const MAX_PRISMA_INT = 2_147_483_647;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const OPERATION_KINDS = new Set<McpOperationKind>([
  'categorization',
  'transfer',
  'undo',
  'tax_refund',
]);

const RULE_RESOURCE_TYPES = new Set<McpRuleResourceType>([
  'rule',
  'rule_order',
  'rule_candidate',
]);

const HISTORICAL_RULE_MUTATION_KINDS = new Set<HistoricalRuleMutationKind>([
  'create',
  'update',
  'review',
  'enable',
  'disable',
  'reorder',
  'retire',
  'activate_candidate',
  'dismiss_candidate',
]);

const SHA256 = /^[0-9a-f]{64}$/u;

export type McpOperationKind = 'categorization' | 'transfer' | 'undo' | 'tax_refund';

export type McpOperationJsonValue =
  | null
  | boolean
  | number
  | string
  | McpOperationJsonValue[]
  | { [key: string]: McpOperationJsonValue };

export interface McpOperationJsonObject {
  [key: string]: McpOperationJsonValue;
}

export interface McpOperationRecord {
  id: string;
  tokenId: string;
  tokenPrefix: string;
  userId: string;
  companyId: string;
  transactionId: string;
  toolName: string;
  kind: McpOperationKind;
  idempotencyKey: string | null;
  inputHash: string;
  payload: McpOperationJsonValue;
  payloadHash: string;
  sourceRevision: number;
  preparedRevision: number;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  expiresAt: Date;
  retryOfId: string | null;
  cancelledAt: Date | null;
  manualRecordedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type McpRuleResourceType = 'rule' | 'rule_order' | 'rule_candidate';

export interface McpRuleOperationRecord {
  id: string;
  authKind: 'mcp' | 'session';
  tokenId: string | null;
  tokenPrefix: string | null;
  sessionId: string | null;
  userId: string;
  companyId: string;
  resourceType: McpRuleResourceType;
  resourceId: string;
  mutation: HistoricalRuleMutationKind;
  idempotencyKey: string;
  inputHash: string;
  payload: McpOperationJsonValue;
  payloadHash: string;
  sourceRevision: number;
  proposedRevision: number;
  proposedSnapshotHash: string;
  expiresAt: Date;
  retryOfId: string | null;
  committedAt: Date | null;
  commitResult: McpOperationJsonValue | null;
  commitResultHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RuleOperationPrincipal =
  | Pick<McpPrincipal, 'tokenId' | 'tokenPrefix' | 'userId'> & { kind?: 'mcp' }
  | { kind: 'session'; sessionId: string; userId: string };

type McpRuleOperationWhere = Partial<Pick<
  McpRuleOperationRecord,
  | 'id'
  | 'tokenId'
  | 'sessionId'
  | 'authKind'
  | 'userId'
  | 'companyId'
  | 'idempotencyKey'
  | 'retryOfId'
>>;

type McpRuleOperationCreateData = Omit<
  McpRuleOperationRecord,
  | 'id'
  | 'payload'
  | 'committedAt'
  | 'commitResult'
  | 'commitResultHash'
  | 'createdAt'
  | 'updatedAt'
> & { payload: McpOperationJsonObject };

type McpRuleOperationInsertData = McpRuleOperationCreateData & { id: string };

export interface McpRuleOperationStore {
  mcpRuleOperation: {
    findFirst(args: {
      where: McpRuleOperationWhere;
    }): Promise<McpRuleOperationRecord | null>;
    createMany(args: {
      data: McpRuleOperationInsertData;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export type McpRuleOperationPersistence =
  | McpRuleOperationStore
  | Pick<PrismaClient, never>
  | Pick<Prisma.TransactionClient, never>;

export interface McpRuleOperationDependencies {
  store?: McpRuleOperationPersistence;
  now?: () => Date;
}

export interface CreatePreparedRuleOperationInput {
  principal: RuleOperationPrincipal;
  companyId: string;
  resourceType: McpRuleResourceType;
  resourceId: string;
  mutation: RuleMutationKind;
  idempotencyKey: string;
  payload: unknown;
  sourceRevision: number;
  proposedRevision: number;
  proposedSnapshotHash: string;
  retryOfId?: string | null;
}

type McpOperationWhere = Partial<Pick<
  McpOperationRecord,
  | 'id'
  | 'tokenId'
  | 'userId'
  | 'toolName'
  | 'transactionId'
  | 'idempotencyKey'
  | 'retryOfId'
>>;

type McpOperationCreateData = Omit<
  McpOperationRecord,
  'id' | 'payload' | 'createdAt' | 'updatedAt'
> & {
  payload: McpOperationJsonObject;
};
type McpOperationInsertData = McpOperationCreateData & { id: string };

interface JsonNormalizationBudget {
  nodes: number;
  rawStringBytes: number;
}

/**
 * The minimal Prisma surface accepted by both PrismaClient and a
 * Prisma.TransactionClient. Passing this store lets staging persist its
 * operation envelope in the same transaction as the prepared revision.
 */
export interface McpOperationStore {
  mcpOperation: {
    findFirst(args: {
      where: McpOperationWhere;
    }): Promise<McpOperationRecord | null>;
    createMany(args: {
      data: McpOperationInsertData;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export type McpOperationPersistence =
  | McpOperationStore
  | Pick<PrismaClient, 'mcpOperation'>
  | Pick<Prisma.TransactionClient, 'mcpOperation'>;

export interface McpOperationDependencies {
  store?: McpOperationPersistence;
  now?: () => Date;
  expiresAt?: () => Date;
}

export interface CreatePreparedOperationInput {
  principal: Pick<McpPrincipal, 'tokenId' | 'tokenPrefix' | 'userId'>;
  companyId: string;
  transactionId: string;
  toolName: string;
  kind: McpOperationKind;
  idempotencyKey?: string | null;
  payload: unknown;
  sourceRevision: number;
  preparedRevision: number;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  retryOfId?: string | null;
}

export type McpOperationErrorCode =
  | 'OPERATION_INVALID_INPUT'
  | 'OPERATION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_CONFLICT';

const ERROR_MESSAGES: Readonly<Record<McpOperationErrorCode, string>> = {
  OPERATION_INVALID_INPUT: 'Invalid MCP operation input.',
  OPERATION_NOT_FOUND: 'MCP operation not found.',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with an existing operation.',
  OPERATION_CONFLICT: 'MCP operation changed concurrently.',
};

export class McpOperationError extends Error {
  constructor(readonly code: McpOperationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpOperationError';
  }
}

export function hashOperationPayload(payload: unknown): string {
  const { canonical } = normalizeOperationPayload(payload);
  return sha256(canonical);
}

export function hasValidMcpOperationIntegrity(operation: McpOperationRecord): boolean {
  try {
    const payloadHash = hashOperationPayload(operation.payload);
    if (payloadHash !== operation.payloadHash) return false;
    return operation.inputHash === hashOperationPayload({
      tokenId: operation.tokenId,
      tokenPrefix: operation.tokenPrefix,
      userId: operation.userId,
      companyId: operation.companyId,
      transactionId: operation.transactionId,
      toolName: operation.toolName,
      kind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      payloadHash,
      sourceRevision: operation.sourceRevision,
      preparedRevision: operation.preparedRevision,
      qboType: operation.qboType,
      qboId: operation.qboId,
      qboSyncToken: operation.qboSyncToken,
      retryOfId: operation.retryOfId,
    });
  } catch {
    return false;
  }
}

export async function createPreparedOperation(
  input: CreatePreparedOperationInput,
  dependencies: McpOperationDependencies = {},
): Promise<McpOperationRecord> {
  const store = (dependencies.store ?? prisma) as unknown as McpOperationStore;
  const now = dependencies.now?.() ?? new Date();
  if (!isValidDate(now)) invalidInput();

  const tokenId = boundedText(input.principal?.tokenId, MAX_IDENTIFIER_LENGTH);
  const tokenPrefix = boundedText(
    input.principal?.tokenPrefix,
    MAX_TOKEN_PREFIX_LENGTH,
  );
  const userId = boundedText(input.principal?.userId, MAX_IDENTIFIER_LENGTH);
  const companyId = boundedText(input.companyId, MAX_IDENTIFIER_LENGTH);
  const transactionId = boundedText(input.transactionId, MAX_IDENTIFIER_LENGTH);
  const toolName = normalizedToolName(input.toolName);
  const kind = normalizedKind(input.kind);
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  const sourceRevision = normalizedRevision(input.sourceRevision);
  const preparedRevision = normalizedRevision(input.preparedRevision);
  const qboType = boundedText(input.qboType, MAX_QBO_TYPE_LENGTH);
  const qboId = boundedText(input.qboId, MAX_IDENTIFIER_LENGTH);
  const qboSyncToken = boundedText(input.qboSyncToken, MAX_IDENTIFIER_LENGTH);
  const retryOfId = normalizedOptionalIdentifier(input.retryOfId);
  const { value: payload, canonical } = normalizeOperationPayload(input.payload);
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    invalidInput();
  }
  const payloadHash = sha256(canonical);
  const inputHash = hashOperationPayload({
    tokenId,
    tokenPrefix,
    userId,
    companyId,
    transactionId,
    toolName,
    kind,
    idempotencyKey,
    payloadHash,
    sourceRevision,
    preparedRevision,
    qboType,
    qboId,
    qboSyncToken,
    retryOfId,
  });
  const expiresAt = dependencies.expiresAt?.()
    ?? new Date(now.getTime() + MCP_OPERATION_EXPIRY_MS);
  if (!isValidDate(expiresAt) || expiresAt.getTime() <= now.getTime()) invalidInput();

  const data: McpOperationCreateData = {
    tokenId,
    tokenPrefix,
    userId,
    companyId,
    transactionId,
    toolName,
    kind,
    idempotencyKey,
    inputHash,
    payload,
    payloadHash,
    sourceRevision,
    preparedRevision,
    qboType,
    qboId,
    qboSyncToken,
    expiresAt,
    retryOfId,
    cancelledAt: null,
    manualRecordedAt: null,
  };

  await assertValidRetryParent(store, data);
  const existing = await findReplayCandidate(store, data);
  if (existing !== null) return assertExactReplay(existing, data);

  const id = randomUUID();
  const inserted = await store.mcpOperation.createMany({
    data: { id, ...data },
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    const created = await store.mcpOperation.findFirst({ where: { id } });
    if (created === null) throw new McpOperationError('OPERATION_CONFLICT');
    return created;
  }

  const raced = await findReplayCandidate(store, data);
  if (raced === null) throw new McpOperationError('OPERATION_CONFLICT');
  return assertExactReplay(raced, data);
}

export async function loadOwnedOperation(
  operationId: string,
  principal: Pick<McpPrincipal, 'tokenId' | 'userId'>,
  dependencies: Pick<McpOperationDependencies, 'store'> = {},
): Promise<McpOperationRecord> {
  const store = (dependencies.store ?? prisma) as unknown as McpOperationStore;
  const id = boundedText(operationId, MAX_IDENTIFIER_LENGTH);
  const tokenId = boundedText(principal?.tokenId, MAX_IDENTIFIER_LENGTH);
  const userId = boundedText(principal?.userId, MAX_IDENTIFIER_LENGTH);
  const operation = await store.mcpOperation.findFirst({
    where: { id, tokenId, userId },
  });
  if (operation === null) throw new McpOperationError('OPERATION_NOT_FOUND');
  return operation;
}

export function hasValidMcpRuleOperationIntegrity(
  operation: McpRuleOperationRecord,
): boolean {
  try {
    const payloadHash = hashOperationPayload(operation.payload);
    if (payloadHash !== operation.payloadHash) return false;
    if (!isValidDate(operation.expiresAt)) return false;
    const currentHash = hashOperationPayload({
        authKind: operation.authKind,
        tokenId: operation.tokenId,
        tokenPrefix: operation.tokenPrefix,
        sessionId: operation.sessionId,
        userId: operation.userId,
        companyId: operation.companyId,
        resourceType: operation.resourceType,
        resourceId: operation.resourceId,
        mutation: operation.mutation,
        idempotencyKey: operation.idempotencyKey,
        payloadHash,
        sourceRevision: operation.sourceRevision,
        proposedRevision: operation.proposedRevision,
        proposedSnapshotHash: operation.proposedSnapshotHash,
        expiresAt: operation.expiresAt.toISOString(),
        retryOfId: operation.retryOfId,
      });
    const legacyHash = operation.authKind === 'mcp' && operation.sessionId === null
      ? hashOperationPayload({
          tokenId: operation.tokenId, tokenPrefix: operation.tokenPrefix,
          userId: operation.userId, companyId: operation.companyId,
          resourceType: operation.resourceType, resourceId: operation.resourceId,
          mutation: operation.mutation, idempotencyKey: operation.idempotencyKey,
          payloadHash, sourceRevision: operation.sourceRevision,
          proposedRevision: operation.proposedRevision,
          proposedSnapshotHash: operation.proposedSnapshotHash,
          expiresAt: operation.expiresAt.toISOString(), retryOfId: operation.retryOfId,
        }) : null;
    if (operation.inputHash !== currentHash && operation.inputHash !== legacyHash) return false;

    const commitFields = [
      operation.committedAt,
      operation.commitResult,
      operation.commitResultHash,
    ];
    if (commitFields.every((value) => value === null)) return true;
    if (commitFields.some((value) => value === null)) return false;
    return isValidDate(operation.committedAt!)
      && operation.commitResultHash === hashOperationPayload(operation.commitResult);
  } catch {
    return false;
  }
}

export async function createPreparedRuleOperation(
  input: CreatePreparedRuleOperationInput,
  dependencies: McpRuleOperationDependencies = {},
): Promise<McpRuleOperationRecord> {
  const store = (dependencies.store ?? prisma) as unknown as McpRuleOperationStore;
  const now = dependencies.now?.() ?? new Date();
  if (!isValidDate(now)) invalidInput();

  const authKind = input.principal.kind === 'session' ? 'session' : 'mcp';
  const tokenId = authKind === 'mcp'
    ? boundedText((input.principal as Extract<RuleOperationPrincipal, { kind?: 'mcp' }>).tokenId, MAX_IDENTIFIER_LENGTH)
    : null;
  const tokenPrefix = authKind === 'mcp'
    ? boundedText((input.principal as Extract<RuleOperationPrincipal, { kind?: 'mcp' }>).tokenPrefix, MAX_TOKEN_PREFIX_LENGTH)
    : null;
  const sessionId = authKind === 'session'
    ? boundedText((input.principal as Extract<RuleOperationPrincipal, { kind: 'session' }>).sessionId, MAX_IDENTIFIER_LENGTH)
    : null;
  const userId = boundedText(input.principal?.userId, MAX_IDENTIFIER_LENGTH);
  const companyId = boundedText(input.companyId, MAX_IDENTIFIER_LENGTH);
  const resourceType = normalizedRuleResourceType(input.resourceType);
  const resourceId = boundedText(input.resourceId, MAX_IDENTIFIER_LENGTH);
  const mutation = normalizedRuleMutation(input.mutation);
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) invalidInput();
  const sourceRevision = normalizedRevision(input.sourceRevision);
  const proposedRevision = normalizedRevision(input.proposedRevision);
  if (proposedRevision !== sourceRevision + 1) invalidInput();
  const proposedSnapshotHash = normalizedSha256(input.proposedSnapshotHash);
  const retryOfId = normalizedOptionalIdentifier(input.retryOfId);
  const { value: payload, canonical } = normalizeOperationPayload(input.payload);
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    invalidInput();
  }
  const payloadHash = sha256(canonical);
  const expiresAt = new Date(now.getTime() + MCP_OPERATION_EXPIRY_MS);
  if (!isValidDate(expiresAt)) invalidInput();
  const hashInput = {
    tokenId, tokenPrefix, userId, companyId, resourceType, resourceId,
    mutation, idempotencyKey, payloadHash, sourceRevision, proposedRevision,
    proposedSnapshotHash, expiresAt: expiresAt.toISOString(), retryOfId,
  };
  // During rolling deployment, a pre-Task-6A committer must be able to read
  // MCP preparations emitted by a new instance. Session rows have no legacy
  // representation and therefore use the discriminator-aware hash.
  const inputHash = hashOperationPayload(authKind === 'mcp'
    ? hashInput
    : { authKind, ...hashInput, sessionId });
  const data: McpRuleOperationCreateData = {
    authKind,
    tokenId,
    tokenPrefix,
    sessionId,
    userId,
    companyId,
    resourceType,
    resourceId,
    mutation,
    idempotencyKey,
    inputHash,
    payload,
    payloadHash,
    sourceRevision,
    proposedRevision,
    proposedSnapshotHash,
    expiresAt,
    retryOfId,
  };

  await assertValidRuleRetryParent(store, data);
  const existing = await findRuleReplayCandidate(store, data);
  if (existing !== null) return assertExactRuleReplay(existing, data);

  const id = randomUUID();
  const inserted = await store.mcpRuleOperation.createMany({
    data: { id, ...data },
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    const created = await store.mcpRuleOperation.findFirst({ where: { id } });
    if (created === null) throw new McpOperationError('OPERATION_CONFLICT');
    return created;
  }
  const raced = await findRuleReplayCandidate(store, data);
  if (raced === null) throw new McpOperationError('OPERATION_CONFLICT');
  return assertExactRuleReplay(raced, data);
}

export async function loadOwnedRuleOperation(
  operationId: string,
  principal: RuleOperationPrincipal,
  dependencies: Pick<McpRuleOperationDependencies, 'store'> = {},
): Promise<McpRuleOperationRecord> {
  const store = (dependencies.store ?? prisma) as unknown as McpRuleOperationStore;
  const owner = principal.kind === 'session'
    ? { authKind: 'session' as const, sessionId: boundedText(principal.sessionId, MAX_IDENTIFIER_LENGTH) }
    : { authKind: 'mcp' as const, tokenId: boundedText(principal.tokenId, MAX_IDENTIFIER_LENGTH) };
  const operation = await store.mcpRuleOperation.findFirst({
    where: {
      id: boundedText(operationId, MAX_IDENTIFIER_LENGTH),
      userId: boundedText(principal?.userId, MAX_IDENTIFIER_LENGTH),
      ...owner,
    },
  });
  if (operation === null) throw new McpOperationError('OPERATION_NOT_FOUND');
  return operation;
}

async function assertValidRuleRetryParent(
  store: McpRuleOperationStore,
  data: McpRuleOperationCreateData,
): Promise<void> {
  if (data.retryOfId === null) return;
  const parent = await store.mcpRuleOperation.findFirst({
    where: {
      id: data.retryOfId,
      authKind: data.authKind,
      ...(data.authKind === 'session' ? { sessionId: data.sessionId } : { tokenId: data.tokenId }),
      userId: data.userId,
    },
  });
  if (parent === null) throw new McpOperationError('OPERATION_NOT_FOUND');
  if (
    parent.retryOfId !== null
    || parent.companyId !== data.companyId
    || parent.resourceType !== data.resourceType
    || parent.resourceId !== data.resourceId
    || parent.mutation !== data.mutation
  ) invalidInput();
}

async function findRuleReplayCandidate(
  store: McpRuleOperationStore,
  data: McpRuleOperationCreateData,
): Promise<McpRuleOperationRecord | null> {
  const byIdempotency = await store.mcpRuleOperation.findFirst({
    where: {
      authKind: data.authKind,
      ...(data.authKind === 'session' ? { sessionId: data.sessionId } : { tokenId: data.tokenId }),
      companyId: data.companyId,
      idempotencyKey: data.idempotencyKey,
    },
  });
  const byRetry = data.retryOfId === null
    ? null
    : await store.mcpRuleOperation.findFirst({ where: { retryOfId: data.retryOfId } });
  if (
    byIdempotency !== null
    && byRetry !== null
    && byIdempotency.id !== byRetry.id
  ) throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  return byIdempotency ?? byRetry;
}

function assertExactRuleReplay(
  existing: McpRuleOperationRecord,
  requested: McpRuleOperationCreateData,
): McpRuleOperationRecord {
  if (
    !hasValidMcpRuleOperationIntegrity(existing)
    || existing.authKind !== requested.authKind
    || existing.payloadHash !== requested.payloadHash
    || existing.tokenId !== requested.tokenId
    || existing.tokenPrefix !== requested.tokenPrefix
    || existing.sessionId !== requested.sessionId
    || existing.userId !== requested.userId
    || existing.companyId !== requested.companyId
    || existing.resourceType !== requested.resourceType
    || existing.resourceId !== requested.resourceId
    || existing.mutation !== requested.mutation
    || existing.idempotencyKey !== requested.idempotencyKey
    || existing.sourceRevision !== requested.sourceRevision
    || existing.proposedRevision !== requested.proposedRevision
    || existing.proposedSnapshotHash !== requested.proposedSnapshotHash
    || existing.retryOfId !== requested.retryOfId
  ) throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  return existing;
}

async function assertValidRetryParent(
  store: McpOperationStore,
  data: McpOperationCreateData,
): Promise<void> {
  if (data.retryOfId === null) return;
  const parent = await store.mcpOperation.findFirst({
    where: {
      id: data.retryOfId,
      tokenId: data.tokenId,
      userId: data.userId,
    },
  });
  if (parent === null) throw new McpOperationError('OPERATION_NOT_FOUND');
  if (
    parent.retryOfId !== null
    || parent.companyId !== data.companyId
    || parent.transactionId !== data.transactionId
    || parent.kind !== data.kind
  ) {
    invalidInput();
  }
}

async function findReplayCandidate(
  store: McpOperationStore,
  data: McpOperationCreateData,
): Promise<McpOperationRecord | null> {
  const byIdempotency = data.idempotencyKey === null
    ? null
    : await store.mcpOperation.findFirst({
        where: {
          tokenId: data.tokenId,
          toolName: data.toolName,
          transactionId: data.transactionId,
          idempotencyKey: data.idempotencyKey,
        },
      });
  const byRetry = data.retryOfId === null
    ? null
    : await store.mcpOperation.findFirst({
        where: { retryOfId: data.retryOfId },
      });

  if (
    byIdempotency !== null
    && byRetry !== null
    && byIdempotency.id !== byRetry.id
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
  return byIdempotency ?? byRetry;
}

function assertExactReplay(
  existing: McpOperationRecord,
  requested: McpOperationCreateData,
): McpOperationRecord {
  if (
    existing.inputHash !== requested.inputHash
    || existing.payloadHash !== requested.payloadHash
    || existing.tokenId !== requested.tokenId
    || existing.tokenPrefix !== requested.tokenPrefix
    || existing.userId !== requested.userId
    || existing.companyId !== requested.companyId
    || existing.transactionId !== requested.transactionId
    || existing.toolName !== requested.toolName
    || existing.kind !== requested.kind
    || existing.idempotencyKey !== requested.idempotencyKey
    || existing.sourceRevision !== requested.sourceRevision
    || existing.preparedRevision !== requested.preparedRevision
    || existing.qboType !== requested.qboType
    || existing.qboId !== requested.qboId
    || existing.qboSyncToken !== requested.qboSyncToken
    || existing.retryOfId !== requested.retryOfId
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
  return existing;
}

function normalizeOperationPayload(payload: unknown): {
  value: McpOperationJsonValue;
  canonical: string;
} {
  try {
    const value = normalizeJsonValue(
      payload,
      0,
      new Set<object>(),
      { nodes: 0, rawStringBytes: 0 },
    );
    const canonical = JSON.stringify(value);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) invalidInput();
    return { value, canonical };
  } catch (caught) {
    if (caught instanceof McpOperationError) throw caught;
    invalidInput();
  }
}

function normalizeJsonValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: JsonNormalizationBudget,
): McpOperationJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) invalidInput();
  if (depth > MAX_JSON_DEPTH) invalidInput();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    consumeRawStringBudget(value, budget);
    return normalizedJsonString(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidInput();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) invalidInput();

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (isArray && prototype !== Array.prototype)
    || (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    invalidInput();
  }

  ancestors.add(value);
  try {
    if (isArray) return normalizeJsonArray(value, depth, ancestors, budget);
    return normalizeJsonObject(value, depth, ancestors, budget);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonArray(
  value: unknown[],
  depth: number,
  ancestors: Set<object>,
  budget: JsonNormalizationBudget,
): McpOperationJsonValue[] {
  if (value.length > MAX_JSON_COLLECTION_ITEMS) invalidInput();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) invalidInput();

  const result: McpOperationJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || descriptor.value === undefined
    ) {
      invalidInput();
    }
    result.push(normalizeJsonValue(
      descriptor.value,
      depth + 1,
      ancestors,
      budget,
    ));
  }
  return result;
}

function normalizeJsonObject(
  value: object,
  depth: number,
  ancestors: Set<object>,
  budget: JsonNormalizationBudget,
): { [key: string]: McpOperationJsonValue } {
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_JSON_COLLECTION_ITEMS) invalidInput();
  const normalizedEntries: Array<[string, McpOperationJsonValue]> = [];
  const normalizedKeys = new Set<string>();

  for (const rawKey of keys) {
    if (typeof rawKey !== 'string') invalidInput();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, rawKey);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || descriptor.value === undefined
    ) {
      invalidInput();
    }
    consumeRawStringBudget(rawKey, budget);
    const key = normalizedJsonString(rawKey);
    if (key === '' || !SAFE_TEXT.test(key) || normalizedKeys.has(key)) invalidInput();
    normalizedKeys.add(key);
    normalizedEntries.push([
      key,
      normalizeJsonValue(descriptor.value, depth + 1, ancestors, budget),
    ]);
  }

  normalizedEntries.sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const result = Object.create(null) as Record<string, McpOperationJsonValue>;
  for (const [key, nested] of normalizedEntries) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: nested,
      writable: true,
    });
  }
  return result;
}

export function normalizeMcpOperationIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidInput();
  const normalized = normalizedJsonString(value.trim());
  if (
    normalized.length === 0
    || normalized.length > MCP_OPERATION_MAX_IDEMPOTENCY_KEY_LENGTH
    || !SAFE_TEXT.test(normalized)
  ) {
    invalidInput();
  }
  return normalized;
}

function consumeRawStringBudget(
  value: string,
  budget: JsonNormalizationBudget,
): void {
  budget.rawStringBytes += Buffer.byteLength(value, 'utf8');
  if (budget.rawStringBytes > MAX_PAYLOAD_BYTES) invalidInput();
}

function normalizedJsonString(value: string): string {
  const normalized = value.normalize('NFC');
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code === 0) invalidInput();
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalidInput();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalidInput();
    }
  }
  return normalized;
}

function normalizedOptionalIdentifier(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, MAX_IDENTIFIER_LENGTH);
}

function normalizedToolName(value: unknown): string {
  const normalized = boundedText(value, MAX_TOOL_NAME_LENGTH);
  if (!TOOL_NAME.test(normalized)) invalidInput();
  return normalized;
}

function normalizedKind(value: unknown): McpOperationKind {
  if (typeof value !== 'string' || !OPERATION_KINDS.has(value as McpOperationKind)) {
    invalidInput();
  }
  return value as McpOperationKind;
}

function normalizedRuleResourceType(value: unknown): McpRuleResourceType {
  if (
    typeof value !== 'string'
    || !RULE_RESOURCE_TYPES.has(value as McpRuleResourceType)
  ) invalidInput();
  return value as McpRuleResourceType;
}

function normalizedRuleMutation(value: unknown): HistoricalRuleMutationKind {
  if (
    typeof value !== 'string'
    || !HISTORICAL_RULE_MUTATION_KINDS.has(value as HistoricalRuleMutationKind)
  ) invalidInput();
  return value as HistoricalRuleMutationKind;
}

function normalizedSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) invalidInput();
  return value;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') invalidInput();
  const normalized = normalizedJsonString(value.trim());
  if (
    normalized.length === 0
    || normalized.length > maximum
    || !SAFE_TEXT.test(normalized)
  ) {
    invalidInput();
  }
  return normalized;
}

function normalizedRevision(value: unknown): number {
  if (
    !Number.isInteger(value)
    || (value as number) < 0
    || (value as number) > MAX_PRISMA_INT
  ) {
    invalidInput();
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function invalidInput(): never {
  throw new McpOperationError('OPERATION_INVALID_INPUT');
}
