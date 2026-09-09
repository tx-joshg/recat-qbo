import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpPrincipal } from '../../mcp/auth.js';
import { prisma } from '../../lib/prisma.js';
import {
  commitTransfer,
  getTransferOperation,
  retryTransferOperationWithWorkflow,
  type RetryTransferOperationDto,
  type TransferOperationDto,
  type TransferRetryWorkflow,
} from '../transferExecution.js';
import {
  prepareTransferWithWorkflow,
  type PrepareTransferInput,
  type TransferOperationRecord,
  type TransferPreparationWorkflow,
} from '../transferOperations.js';
import {
  MCP_OPERATION_EXPIRY_MS,
  McpOperationError,
  createPreparedOperation,
  hasValidMcpOperationIntegrity,
  loadOwnedOperation,
  normalizeMcpOperationIdempotencyKey,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';
import {
  assertTransactionProviderActionability,
  type ProviderActionabilityDb,
} from '../providerActionability.js';

const TOOL_NAME = 'prepare_transfer';
const MAX_PRISMA_INT = 2_147_483_647;
const MAX_QBO_TYPE_LENGTH = 32;
const MAX_IDENTIFIER_LENGTH = 128;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface PrepareMcpTransferInput {
  companyId: string;
  transactionId: string;
  counterpartTransactionId: string;
  expectedRevision: number;
  counterpartExpectedRevision: number;
  idempotencyKey?: string;
}

export interface PreparedMcpTransferDto {
  operationId: string;
  expiresAt: string;
  preview: StoredMcpTransferPayload['preview'];
}

export interface StoredMcpTransferPayload {
  transferOperationId: string;
  first: {
    qboType: string;
    qboId: string;
    qboSyncToken: string;
  };
  second: {
    transactionId: string;
    qboType: string;
    qboId: string;
    qboSyncToken: string;
  };
  preview: {
    action: 'record_transfer';
    direction: 'between_accounts';
    totalCents: number;
    legCount: 2;
    preparationDigest: string;
  };
}

export interface McpTransferStore
  extends McpOperationStore, McpCategorizationAuthorizationStore {
  qboTransferOperation: {
    findFirst(args: {
      where: { id: string };
    }): Promise<TransferOperationRecord | null>;
  };
}

type PrepareWithWorkflow = <T>(
  input: PrepareTransferInput,
  workflow: TransferPreparationWorkflow<T>,
) => Promise<T>;

export interface McpTransferDeps {
  prepare?: PrepareWithWorkflow;
  createOperation?: typeof createPreparedOperation;
  now?: () => Date;
  randomId?: () => string;
}

export interface McpTransferExecutionDeps {
  store?: McpTransferStore;
  now?: () => Date;
  getTransfer?: (
    operationId: string,
    actor: { id: string; label: string },
    authorization: {
      kind: 'mcp';
      tokenId: string;
      tokenPrefix: string;
    },
  ) => Promise<TransferOperationDto>;
  commitTransfer?: (
    operationId: string,
    actor: { id: string; label: string },
    authorization: {
      kind: 'mcp';
      tokenId: string;
      tokenPrefix: string;
    },
    auditAttribution: {
      sourceOperationId: string;
      operationId: string;
      tokenPrefix: string;
    },
  ) => Promise<TransferOperationDto>;
  retryTransfer?: <T>(
    operationId: string,
    actor: { id: string; label: string },
    workflow: TransferRetryWorkflow<T>,
    authorization: {
      kind: 'mcp';
      tokenId: string;
      tokenPrefix: string;
    },
  ) => Promise<T>;
  createOperation?: typeof createPreparedOperation;
}

export interface McpTransferOperationDto {
  operationId: string;
  kind: 'transfer';
  expiresAt: string;
  state:
    | 'prepared'
    | 'committed'
    | 'retryable'
    | 'reconciliation_required'
    | 'expired'
    | 'cancelled';
  phase:
    | 'awaiting_commit'
    | 'write_prepared'
    | 'write_committing'
    | 'write_uncertain'
    | 'write_retryable'
    | 'write_unchanged'
    | 'verified'
    | 'dry_run'
    | 'corrupt';
  result: {
    complete: boolean;
    firstLeg: TransferOperationDto['firstLeg'];
    secondLeg: TransferOperationDto['secondLeg'];
  } | null;
  error: NonNullable<TransferOperationDto['error']> | null;
  actions: {
    canCommit: boolean;
    canRetry: boolean;
    requiresReconciliation: boolean;
  };
}

export type McpTransferExecutionErrorCode =
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_EXPIRED'
  | 'OPERATION_CANCELLED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RETRY_NOT_ALLOWED'
  | 'OPERATION_CORRUPT';

const EXECUTION_MESSAGES: Record<McpTransferExecutionErrorCode, string> = {
  OPERATION_NOT_FOUND: 'MCP operation not found.',
  OPERATION_EXPIRED: 'This MCP operation expired before it was committed.',
  OPERATION_CANCELLED: 'This MCP operation was cancelled.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key does not match this operation.',
  RETRY_NOT_ALLOWED: 'This operation cannot be retried; prepare a fresh operation.',
  OPERATION_CORRUPT: 'This MCP operation requires manual reconciliation.',
};

export class McpTransferExecutionError extends Error {
  constructor(readonly code: McpTransferExecutionErrorCode) {
    super(EXECUTION_MESSAGES[code]);
    this.name = 'McpTransferExecutionError';
  }
}

const identifier = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const qboType = z.string().min(1).max(MAX_QBO_TYPE_LENGTH);
const qboBinding = z.object({
  qboType,
  qboId: identifier,
  qboSyncToken: identifier,
}).strict();
const transferPayloadSchema = z.object({
  transferOperationId: identifier,
  first: qboBinding,
  second: qboBinding.extend({ transactionId: identifier }).strict(),
  preview: z.object({
    action: z.literal('record_transfer'),
    direction: z.literal('between_accounts'),
    totalCents: z.number().refine(Number.isSafeInteger),
    legCount: z.literal(2),
    preparationDigest: z.string().regex(SHA256),
  }).strict(),
}).strict();

export function parseStoredMcpTransferPayload(
  payload: unknown,
): StoredMcpTransferPayload {
  const parsed = transferPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new McpOperationError('OPERATION_CONFLICT');
  return parsed.data;
}

export function validateMcpTransferEnvelope(
  operation: McpOperationRecord,
  coordinator: TransferOperationRecord,
): StoredMcpTransferPayload {
  if (!hasValidMcpOperationIntegrity(operation)) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  const payload = parseStoredMcpTransferPayload(operation.payload);
  if (
    operation.kind !== 'transfer'
    || operation.toolName !== TOOL_NAME
    || operation.userId !== coordinator.actorId
    || operation.companyId !== coordinator.companyId
    || operation.transactionId !== coordinator.firstTransactionId
    || operation.sourceRevision !== coordinator.firstExpectedRevision
    || operation.preparedRevision !== coordinator.firstExpectedRevision
    || operation.qboType !== coordinator.firstQboType
    || operation.qboId !== coordinator.firstQboId
    || operation.qboSyncToken !== coordinator.firstQboSyncToken
    || operation.expiresAt.getTime() !== coordinator.expiresAt.getTime()
    || payload.transferOperationId !== coordinator.id
    || payload.first.qboType !== coordinator.firstQboType
    || payload.first.qboId !== coordinator.firstQboId
    || payload.first.qboSyncToken !== coordinator.firstQboSyncToken
    || payload.second.transactionId !== coordinator.secondTransactionId
    || payload.second.qboType !== coordinator.secondQboType
    || payload.second.qboId !== coordinator.secondQboId
    || payload.second.qboSyncToken !== coordinator.secondQboSyncToken
    || payload.preview.preparationDigest !== coordinator.preparedHash
  ) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  return payload;
}

export async function prepareMcpTransfer(
  principal: McpPrincipal,
  input: PrepareMcpTransferInput,
  dependencies: McpTransferDeps = {},
): Promise<PreparedMcpTransferDto> {
  const prepare = dependencies.prepare
    ?? ((preparedInput, workflow) =>
      prepareTransferWithWorkflow(preparedInput, workflow));
  const createOperation = dependencies.createOperation ?? createPreparedOperation;
  const initialTime = dependencies.now?.() ?? new Date();
  if (!isValidDate(initialTime)) {
    throw new McpOperationError('OPERATION_INVALID_INPUT');
  }
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(
    input.idempotencyKey,
  );
  const internalIdempotencyKey = createHash('sha256').update(JSON.stringify({
    tokenId: principal.tokenId,
    key: idempotencyKey ?? (dependencies.randomId?.() ?? randomUUID()),
    pair: [input.transactionId, input.counterpartTransactionId].sort(),
  })).digest('hex');

  const workflow: TransferPreparationWorkflow<PreparedMcpTransferDto> = {
    beforeValidation: async (rawStore) => {
      const store = rawStore as unknown as McpTransferStore;
      await assertCurrentMcpCategorizationAuthorization(
        store,
        principal,
        input.companyId,
        currentTime(dependencies),
      );
      if (idempotencyKey !== null) {
        const existing = await store.mcpOperation.findFirst({
          where: {
            tokenId: principal.tokenId,
            userId: principal.userId,
            toolName: TOOL_NAME,
            idempotencyKey,
          },
        });
        if (existing !== null) {
          const coordinator = await loadCoordinator(store, existing);
          assertExactPrepareInput(existing, coordinator, principal, input);
          return {
            kind: 'return',
            value: preparedDto(existing, coordinator),
          };
        }
      }
      const providerDb = store as unknown as ProviderActionabilityDb;
      await assertTransactionProviderActionability(
        input.companyId,
        input.transactionId,
        providerDb,
        currentTime(dependencies),
      );
      await assertTransactionProviderActionability(
        input.companyId,
        input.counterpartTransactionId,
        providerDb,
        currentTime(dependencies),
      );
      return { kind: 'continue' };
    },
    afterPrepare: async (rawStore, receipt) => {
      const store = rawStore as unknown as McpTransferStore;
      await assertCurrentMcpCategorizationAuthorization(
        store,
        principal,
        input.companyId,
        currentTime(dependencies),
      );
      const coordinator = receipt.operation;
      assertCoordinatorInput(coordinator, principal, input);
      const operation = await createOperation({
        principal,
        companyId: coordinator.companyId,
        transactionId: coordinator.firstTransactionId,
        toolName: TOOL_NAME,
        kind: 'transfer',
        idempotencyKey,
        payload: payloadFor(coordinator, receipt.prepared.preview),
        sourceRevision: coordinator.firstExpectedRevision,
        preparedRevision: coordinator.firstExpectedRevision,
        qboType: coordinator.firstQboType,
        qboId: coordinator.firstQboId,
        qboSyncToken: coordinator.firstQboSyncToken,
        retryOfId: null,
      }, {
        store,
        now: () => new Date(
          coordinator.expiresAt.getTime() - MCP_OPERATION_EXPIRY_MS,
        ),
      });
      validateMcpTransferEnvelope(operation, coordinator);
      assertExactPrepareInput(operation, coordinator, principal, input);
      return preparedDto(operation, coordinator);
    },
  };

  return prepare({
    ...input,
    idempotencyKey: internalIdempotencyKey,
    actor: { id: principal.userId, label: 'MCP transfer' },
    authorization: {
      kind: 'mcp',
      tokenId: principal.tokenId,
      tokenPrefix: principal.tokenPrefix,
    },
  }, workflow);
}

interface LoadedMcpTransfer {
  operation: McpOperationRecord;
  coordinator: TransferOperationRecord;
  payload: StoredMcpTransferPayload;
  actor: { id: string; label: string };
  authorization: {
    kind: 'mcp';
    tokenId: string;
    tokenPrefix: string;
  };
}

export async function getMcpTransferOperation(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpTransferExecutionDeps = {},
): Promise<McpTransferOperationDto> {
  const loaded = await loadMcpTransfer(
    principal,
    operationId,
    dependencies,
  );
  const get = dependencies.getTransfer
    ?? ((id, actor, authorization) =>
      getTransferOperation(id, actor, authorization));
  const transfer = await get(
    loaded.coordinator.id,
    loaded.actor,
    loaded.authorization,
  );
  return projectMcpTransfer(loaded.operation, transfer, nowFrom(dependencies));
}

export async function commitMcpTransfer(
  principal: McpPrincipal,
  input: { operationId: string; idempotencyKey?: string },
  dependencies: McpTransferExecutionDeps = {},
): Promise<McpTransferOperationDto> {
  const loaded = await loadMcpTransfer(
    principal,
    input.operationId,
    dependencies,
  );
  assertCommitKey(input.idempotencyKey, loaded.operation);
  const get = dependencies.getTransfer
    ?? ((id, actor, authorization) =>
      getTransferOperation(id, actor, authorization));
  const currentTransfer = await get(
    loaded.coordinator.id,
    loaded.actor,
    loaded.authorization,
  );
  const current = projectMcpTransfer(
    loaded.operation,
    currentTransfer,
    nowFrom(dependencies),
  );
  if (current.state === 'expired') {
    throw new McpTransferExecutionError('OPERATION_EXPIRED');
  }
  if (current.state === 'cancelled') {
    throw new McpTransferExecutionError('OPERATION_CANCELLED');
  }
  if (current.state === 'committed' || current.state === 'retryable') {
    return current;
  }
  const commit = dependencies.commitTransfer
    ?? ((id, actor, authorization, attribution) =>
      commitTransfer(id, actor, authorization, attribution));
  const committed = await commit(
    loaded.coordinator.id,
    loaded.actor,
    loaded.authorization,
    {
      sourceOperationId: loaded.coordinator.id,
      operationId: loaded.operation.id,
      tokenPrefix: loaded.operation.tokenPrefix,
    },
  );
  return projectMcpTransfer(
    loaded.operation,
    committed,
    nowFrom(dependencies),
  );
}

interface RetryEnvelopeResult {
  operation: McpOperationRecord;
  transfer: RetryTransferOperationDto;
}

export async function retryMcpTransferOperation(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpTransferExecutionDeps = {},
): Promise<McpTransferOperationDto> {
  const parent = await loadMcpTransfer(principal, operationId, dependencies);
  let current = await getMcpTransferOperation(
    principal,
    operationId,
    dependencies,
  );
  if (current.state === 'committed') return current;
  if (current.state !== 'retryable') {
    current = await commitMcpTransfer(
      principal,
      { operationId },
      dependencies,
    );
    if (current.state !== 'retryable') return current;
  }
  if (parent.operation.retryOfId !== null) {
    throw new McpTransferExecutionError('RETRY_NOT_ALLOWED');
  }

  const createOperation = dependencies.createOperation ?? createPreparedOperation;
  const retry = dependencies.retryTransfer
    ?? ((id, actor, workflow, authorization) =>
      retryTransferOperationWithWorkflow(id, actor, workflow, authorization));
  const workflow: TransferRetryWorkflow<RetryEnvelopeResult> = {
    beforeValidation: async (rawStore) => {
      const retryStore = rawStore as unknown as McpTransferStore;
      const existing = await retryStore.mcpOperation.findFirst({
        where: { retryOfId: parent.operation.id },
      });
      if (existing === null) return { kind: 'continue' };
      const childCoordinator = await loadCoordinator(retryStore, existing);
      assertRetryLineage(parent, existing, childCoordinator);
      const get = dependencies.getTransfer
        ?? ((id, actor, authorization) =>
          getTransferOperation(id, actor, authorization));
      const childTransfer = await get(
        childCoordinator.id,
        parent.actor,
        parent.authorization,
      );
      return {
        kind: 'return',
        value: {
          operation: existing,
          transfer: {
            retryOfId: parent.coordinator.id,
            ...childTransfer,
          },
        },
      };
    },
    afterRetry: async (rawStore, receipt) => {
      const retryStore = rawStore as unknown as McpTransferStore;
      const child = receipt.operation;
      if (child.retryOfId !== parent.coordinator.id) {
        throw new McpTransferExecutionError('OPERATION_CORRUPT');
      }
      const childOperation = await createOperation({
        principal,
        companyId: child.companyId,
        transactionId: child.firstTransactionId,
        toolName: TOOL_NAME,
        kind: 'transfer',
        idempotencyKey: null,
        payload: payloadFor(child, {
          ...parent.payload.preview,
          preparationDigest: child.preparedHash,
        }),
        sourceRevision: child.firstExpectedRevision,
        preparedRevision: child.firstExpectedRevision,
        qboType: child.firstQboType,
        qboId: child.firstQboId,
        qboSyncToken: child.firstQboSyncToken,
        retryOfId: parent.operation.id,
      }, {
        store: retryStore,
        now: () => new Date(
          child.expiresAt.getTime() - MCP_OPERATION_EXPIRY_MS,
        ),
      });
      validateMcpTransferEnvelope(childOperation, child);
      assertRetryLineage(parent, childOperation, child);
      return { operation: childOperation, transfer: receipt.retry };
    },
  };
  const child = await retry(
    parent.coordinator.id,
    parent.actor,
    workflow,
    parent.authorization,
  );
  return commitMcpTransfer(
    principal,
    { operationId: child.operation.id },
    dependencies,
  );
}

async function loadMcpTransfer(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpTransferExecutionDeps,
): Promise<LoadedMcpTransfer> {
  const store = storeFrom(dependencies);
  let operation: McpOperationRecord;
  try {
    operation = await loadOwnedOperation(operationId, principal, { store });
  } catch {
    throw new McpTransferExecutionError('OPERATION_NOT_FOUND');
  }
  await assertCurrentMcpCategorizationAuthorization(
    store,
    principal,
    operation.companyId,
    nowFrom(dependencies),
  );
  if (
    operation.tokenPrefix !== principal.tokenPrefix
    || operation.kind !== 'transfer'
  ) {
    throw new McpTransferExecutionError('OPERATION_NOT_FOUND');
  }
  let coordinator: TransferOperationRecord;
  let payload: StoredMcpTransferPayload;
  try {
    payload = parseStoredMcpTransferPayload(operation.payload);
    const found = await store.qboTransferOperation.findFirst({
      where: { id: payload.transferOperationId },
    });
    if (found === null) throw new Error('missing coordinator');
    coordinator = found;
    validateMcpTransferEnvelope(operation, coordinator);
    if (operation.retryOfId === null) {
      if (coordinator.retryOfId !== null) throw new Error('lineage mismatch');
    } else {
      const parentOperation = await store.mcpOperation.findFirst({
        where: {
          id: operation.retryOfId,
          tokenId: operation.tokenId,
          userId: operation.userId,
        },
      });
      if (parentOperation === null) throw new Error('missing parent');
      if (
        parentOperation.tokenPrefix !== operation.tokenPrefix
        || parentOperation.companyId !== operation.companyId
        || parentOperation.kind !== 'transfer'
        || parentOperation.toolName !== TOOL_NAME
        || !hasValidMcpOperationIntegrity(parentOperation)
      ) {
        throw new Error('invalid parent');
      }
      const parentPayload = parseStoredMcpTransferPayload(parentOperation.payload);
      const parentCoordinator = await store.qboTransferOperation.findFirst({
        where: { id: parentPayload.transferOperationId },
      });
      if (
        parentCoordinator === null
        || validateMcpTransferEnvelope(parentOperation, parentCoordinator)
          .transferOperationId !== parentCoordinator.id
        || coordinator.retryOfId !== parentCoordinator.id
      ) {
        throw new Error('lineage mismatch');
      }
    }
  } catch {
    throw new McpTransferExecutionError('OPERATION_CORRUPT');
  }
  return {
    operation,
    coordinator,
    payload,
    actor: { id: principal.userId, label: 'MCP transfer' },
    authorization: {
      kind: 'mcp',
      tokenId: principal.tokenId,
      tokenPrefix: principal.tokenPrefix,
    },
  };
}

function projectMcpTransfer(
  operation: McpOperationRecord,
  transfer: TransferOperationDto,
  now: Date,
): McpTransferOperationDto {
  const outcomes = [
    transfer.firstLeg.outcome,
    transfer.secondLeg.outcome,
  ] as const;
  let state: McpTransferOperationDto['state'];
  let phase: McpTransferOperationDto['phase'];
  let canCommit = false;
  let canRetry = false;
  let requiresReconciliation = false;
  if (operation.cancelledAt !== null) {
    state = 'cancelled';
    phase = 'awaiting_commit';
  } else if (
    transfer.state === 'PREPARED'
    && operation.expiresAt.getTime() <= now.getTime()
  ) {
    state = 'expired';
    phase = 'awaiting_commit';
  } else if (transfer.state === 'VERIFIED') {
    state = 'committed';
    phase = 'verified';
  } else if (transfer.state === 'DRY_RUN') {
    state = 'committed';
    phase = 'dry_run';
  } else if (transfer.state === 'UNCERTAIN') {
    state = 'reconciliation_required';
    phase = 'write_uncertain';
    requiresReconciliation = true;
  } else if (transfer.state === 'IN_PROGRESS') {
    state = 'reconciliation_required';
    phase = 'write_committing';
    requiresReconciliation = true;
  } else if (
    transfer.state === 'RETRYABLE'
    || (
      transfer.state === 'PARTIAL'
      && outcomes.some((outcome) => outcome === 'RETRYABLE' || outcome === 'UNCHANGED')
    )
  ) {
    state = 'retryable';
    phase = outcomes.includes('UNCHANGED') ? 'write_unchanged' : 'write_retryable';
    canRetry = operation.retryOfId === null;
  } else {
    state = 'prepared';
    phase = outcomes.some((outcome) => outcome === 'VERIFIED')
      ? 'write_prepared'
      : 'awaiting_commit';
    canCommit = true;
  }
  return {
    operationId: operation.id,
    kind: 'transfer',
    expiresAt: operation.expiresAt.toISOString(),
    state,
    phase,
    result: {
      complete: transfer.complete,
      firstLeg: transfer.firstLeg,
      secondLeg: transfer.secondLeg,
    },
    error: transfer.error ?? null,
    actions: { canCommit, canRetry, requiresReconciliation },
  };
}

function assertRetryLineage(
  parent: LoadedMcpTransfer,
  childOperation: McpOperationRecord,
  childCoordinator: TransferOperationRecord,
): void {
  if (
    childOperation.retryOfId !== parent.operation.id
    || childCoordinator.retryOfId !== parent.coordinator.id
    || childCoordinator.actorId !== parent.coordinator.actorId
    || childCoordinator.companyId !== parent.coordinator.companyId
    || childCoordinator.firstTransactionId
      !== parent.coordinator.firstTransactionId
    || childCoordinator.secondTransactionId
      !== parent.coordinator.secondTransactionId
  ) {
    throw new McpTransferExecutionError('OPERATION_CORRUPT');
  }
}

function assertCommitKey(
  value: string | undefined,
  operation: McpOperationRecord,
): void {
  if (
    value !== undefined
    && normalizeMcpOperationIdempotencyKey(value) !== operation.idempotencyKey
  ) {
    throw new McpTransferExecutionError('IDEMPOTENCY_CONFLICT');
  }
}

function storeFrom(
  dependencies: McpTransferExecutionDeps,
): McpTransferStore {
  return (dependencies.store ?? prisma) as unknown as McpTransferStore;
}

function nowFrom(dependencies: McpTransferExecutionDeps): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!isValidDate(now)) {
    throw new McpTransferExecutionError('OPERATION_CORRUPT');
  }
  return now;
}

function currentTime(
  dependencies: Pick<McpTransferDeps, 'now'>,
): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!isValidDate(now)) {
    throw new McpOperationError('OPERATION_INVALID_INPUT');
  }
  return now;
}

function payloadFor(
  coordinator: TransferOperationRecord,
  preview: StoredMcpTransferPayload['preview'],
): StoredMcpTransferPayload {
  return {
    transferOperationId: coordinator.id,
    first: {
      qboType: coordinator.firstQboType,
      qboId: coordinator.firstQboId,
      qboSyncToken: coordinator.firstQboSyncToken,
    },
    second: {
      transactionId: coordinator.secondTransactionId,
      qboType: coordinator.secondQboType,
      qboId: coordinator.secondQboId,
      qboSyncToken: coordinator.secondQboSyncToken,
    },
    preview: {
      ...preview,
      preparationDigest: coordinator.preparedHash,
    },
  };
}

async function loadCoordinator(
  store: McpTransferStore,
  operation: McpOperationRecord,
): Promise<TransferOperationRecord> {
  const payload = parseStoredMcpTransferPayload(operation.payload);
  const coordinator = await store.qboTransferOperation.findFirst({
    where: { id: payload.transferOperationId },
  });
  if (coordinator === null) throw new McpOperationError('OPERATION_CONFLICT');
  validateMcpTransferEnvelope(operation, coordinator);
  return coordinator;
}

function assertExactPrepareInput(
  operation: McpOperationRecord,
  coordinator: TransferOperationRecord,
  principal: McpPrincipal,
  input: PrepareMcpTransferInput,
): void {
  if (
    operation.tokenId !== principal.tokenId
    || operation.tokenPrefix !== principal.tokenPrefix
    || operation.userId !== principal.userId
    || operation.companyId !== input.companyId
    || operation.idempotencyKey
      !== normalizeMcpOperationIdempotencyKey(input.idempotencyKey)
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
  try {
    assertCoordinatorInput(coordinator, principal, input);
  } catch {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
}

function assertCoordinatorInput(
  coordinator: TransferOperationRecord,
  principal: McpPrincipal,
  input: PrepareMcpTransferInput,
): void {
  const revisions = new Map([
    [input.transactionId, input.expectedRevision],
    [input.counterpartTransactionId, input.counterpartExpectedRevision],
  ]);
  if (
    coordinator.actorId !== principal.userId
    || coordinator.companyId !== input.companyId
    || coordinator.firstTransactionId === coordinator.secondTransactionId
    || revisions.size !== 2
    || revisions.get(coordinator.firstTransactionId)
      !== coordinator.firstExpectedRevision
    || revisions.get(coordinator.secondTransactionId)
      !== coordinator.secondExpectedRevision
    || !Number.isInteger(input.expectedRevision)
    || !Number.isInteger(input.counterpartExpectedRevision)
    || input.expectedRevision < 0
    || input.counterpartExpectedRevision < 0
    || input.expectedRevision > MAX_PRISMA_INT
    || input.counterpartExpectedRevision > MAX_PRISMA_INT
  ) {
    throw new McpOperationError('OPERATION_INVALID_INPUT');
  }
}

function preparedDto(
  operation: McpOperationRecord,
  coordinator: TransferOperationRecord,
): PreparedMcpTransferDto {
  const payload = validateMcpTransferEnvelope(operation, coordinator);
  return {
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    preview: payload.preview,
  };
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
