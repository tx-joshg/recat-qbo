import type { TxnStatus, StagedCategorization } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  commitStagedCategorization,
  hashStagedCategorization,
  reconcileMutationAttempt,
  undoCategorization,
  validateDurableAttemptPersistence,
  type DurableAttemptPersistenceProof,
  type DurableMutationOutcome,
  type DurableMutationResult,
} from '../writeback.js';
import {
  createPreparedOperation,
  hasValidMcpOperationIntegrity,
  loadOwnedOperation,
  McpOperationError,
  normalizeMcpOperationIdempotencyKey,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
  type McpOperationKind,
  type McpOperationStore,
} from './operations.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  parseStoredMcpCategorizationPayload,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';
import {
  parseStoredMcpUndoPayload,
  type StoredMcpUndoPayload,
} from './undo.js';
import {
  getMcpTransferOperation,
  retryMcpTransferOperation,
  type McpTransferExecutionDeps,
  type McpTransferOperationDto,
} from './transfers.js';
import {
  getAttachmentOperation,
  reconcileAttachmentOperation,
  retryAttachmentOperation,
  type AttachmentActor,
  type AttachmentOperationDependencies,
} from '../attachments/operations.js';
import {
  projectMcpAttachmentOperation,
  type McpAttachmentOperationProjection,
} from '../../mcp/attachmentTools.js';

export type McpOperationState =
  | 'prepared'
  | 'committed'
  | 'rejected'
  | 'retryable'
  | 'reconciliation_required'
  | 'expired'
  | 'cancelled';

export type McpOperationPhase =
  | 'awaiting_commit'
  | 'write_prepared'
  | 'write_committing'
  | 'write_uncertain'
  | 'write_retryable'
  | 'write_rejected'
  | 'write_unchanged'
  | 'verified'
  | 'dry_run'
  | 'corrupt';

export interface McpOperationDto {
  operationId: string;
  kind: McpOperationKind | 'attachment';
  companyId?: string;
  transactionId?: string;
  sourceRevision?: number;
  preparedRevision?: number;
  expiresAt?: string;
  state: McpOperationState;
  phase: McpOperationPhase;
  result: null
    | { outcome: DurableMutationOutcome; status: TxnStatus }
    | McpTransferOperationDto['result']
    | McpAttachmentOperationProjection['result'];
  error: null | { code: string; message: string };
  actions: {
    canCommit: boolean;
    canRetry: boolean;
    requiresReconciliation: boolean;
  };
}

export type McpCategorizationState = McpOperationState;
export type McpCategorizationPhase = McpOperationPhase;
export type McpCategorizationOperationDto = McpOperationDto;

export interface GetMcpOperationInput { operationId: string }
export interface CommitMcpCategorizationInput {
  operationId: string;
  idempotencyKey?: string;
}
export interface RetryMcpOperationInput { operationId: string }
export interface CommitMcpUndoInput {
  operationId: string;
  idempotencyKey?: string;
}

interface McpAttemptProjection {
  id: string;
  requestId: string;
  transactionId: string;
  operation: string;
  status: string;
  expectedRevision: number;
  expectedSyncToken: string;
  requestHash: string;
  requestPayload: unknown;
  beforeSnapshot: unknown;
  responseSnapshot: unknown;
  verification: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface McpOperationExecutionStore
  extends McpOperationStore, McpCategorizationAuthorizationStore {
  qboMutationAttempt: {
    findUnique(args: {
      where: { requestId: string };
    }): Promise<McpAttemptProjection | null>;
  };
  transaction: {
    findUnique(args: {
      where: { id: string };
      select: {
        status: true;
        revision: true;
        qboType: true;
        qboId: true;
        qboSyncToken: true;
      };
    }): Promise<{
      status: string;
      revision: number;
      qboType: string;
      qboId: string;
      qboSyncToken: string;
    } | null>;
  };
  user: {
    findUnique(args: {
      where: { id: string };
      select: { name: true };
    }): Promise<{ name: string | null } | null>;
  };
}

export interface McpOperationExecutionDeps {
  store?: McpOperationExecutionStore;
  now?: () => Date;
  commit?: typeof commitStagedCategorization;
  undo?: typeof undoCategorization;
  reconcile?: typeof reconcileMutationAttempt;
  createOperation?: typeof createPreparedOperation;
  validateAttempt?: (attempt: McpAttemptProjection) => DurableAttemptPersistenceProof;
  transfer?: Omit<McpTransferExecutionDeps, 'store'>;
  getTransferOperation?: typeof getMcpTransferOperation;
  retryTransferOperation?: typeof retryMcpTransferOperation;
  findAttachmentOperation?: (
    operationId: string,
    actorKey: string,
  ) => Promise<boolean>;
  getAttachmentOperation?: typeof getAttachmentOperation;
  retryAttachmentOperation?: typeof retryAttachmentOperation;
  reconcileAttachmentOperation?: typeof reconcileAttachmentOperation;
  attachmentDependencies?: AttachmentOperationDependencies;
}

export type McpOperationExecutionErrorCode =
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_EXPIRED'
  | 'OPERATION_CANCELLED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RETRY_NOT_ALLOWED'
  | 'OPERATION_CORRUPT';

const ERROR_MESSAGES: Record<McpOperationExecutionErrorCode, string> = {
  OPERATION_NOT_FOUND: 'MCP operation not found.',
  OPERATION_EXPIRED: 'This MCP operation expired before it was committed.',
  OPERATION_CANCELLED: 'This MCP operation was cancelled.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key does not match this operation.',
  RETRY_NOT_ALLOWED: 'This operation cannot be retried; prepare a fresh operation.',
  OPERATION_CORRUPT: 'This MCP operation requires manual reconciliation.',
};

export class McpOperationExecutionError extends Error {
  constructor(readonly code: McpOperationExecutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpOperationExecutionError';
  }
}

interface LoadedExecution {
  operation: McpOperationRecord;
  attempt: McpAttemptProjection | null;
  transactionStatus: TxnStatus | null;
  preview: StagedCategorization | null;
  undoPayload: StoredMcpUndoPayload | null;
  attemptCorrupt: boolean;
}

function attachmentActor(principal: McpPrincipal): AttachmentActor {
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

async function ownsAttachmentOperation(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpOperationExecutionDeps,
): Promise<boolean> {
  const actorKey = `mcp:${principal.tokenId}`;
  if (dependencies.findAttachmentOperation) {
    return dependencies.findAttachmentOperation(operationId, actorKey);
  }
  const row = await prisma.attachmentOperation.findFirst({
    where: { id: operationId, actorKey },
    select: { id: true },
  });
  return row !== null;
}

async function getOwnedAttachmentOperation(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpOperationExecutionDeps,
): Promise<McpAttachmentOperationProjection> {
  if (!await ownsAttachmentOperation(principal, operationId, dependencies)) {
    throw new McpOperationExecutionError('OPERATION_NOT_FOUND');
  }
  const get = dependencies.getAttachmentOperation ?? getAttachmentOperation;
  return projectMcpAttachmentOperation(await get(
    attachmentActor(principal),
    operationId,
    dependencies.attachmentDependencies,
  ));
}

async function resolveRetryChild(
  principal: McpPrincipal,
  operation: McpOperationRecord,
  dependencies: McpOperationExecutionDeps,
): Promise<McpOperationRecord> {
  if (operation.retryOfId !== null) return operation;
  const store = storeFrom(dependencies);
  const candidate = await store.mcpOperation.findFirst({
    where: { retryOfId: operation.id },
  });
  if (candidate === null) return operation;
  const child = await loadOwnedOperation(candidate.id, principal, { store });
  if (
    child.retryOfId !== operation.id
    || child.idempotencyKey !== null
    || child.tokenId !== operation.tokenId
    || child.tokenPrefix !== operation.tokenPrefix
    || child.userId !== operation.userId
    || child.companyId !== operation.companyId
    || child.transactionId !== operation.transactionId
    || child.toolName !== operation.toolName
    || child.kind !== operation.kind
    || child.payloadHash !== operation.payloadHash
    || child.sourceRevision !== operation.sourceRevision
    || child.preparedRevision !== operation.preparedRevision
    || child.qboType !== operation.qboType
    || child.qboId !== operation.qboId
    || child.qboSyncToken !== operation.qboSyncToken
  ) {
    throw new McpOperationExecutionError('OPERATION_CORRUPT');
  }
  return child;
}

export async function getMcpOperation(
  principal: McpPrincipal,
  input: GetMcpOperationInput,
  dependencies: McpOperationExecutionDeps = {},
): Promise<McpCategorizationOperationDto> {
  let owned: McpOperationRecord;
  try {
    owned = await loadOwnedOperation(input.operationId, principal, {
      store: storeFrom(dependencies),
    });
  } catch (error) {
    if (
      error instanceof McpOperationError
      && error.code === 'OPERATION_NOT_FOUND'
    ) {
      return getOwnedAttachmentOperation(
        principal,
        input.operationId,
        dependencies,
      );
    }
    throw error;
  }
  if (owned.kind === 'transfer') {
    const getTransfer = dependencies.getTransferOperation
      ?? getMcpTransferOperation;
    return getTransfer(principal, input.operationId, {
      ...dependencies.transfer,
      store: storeFrom(dependencies) as never,
    });
  }
  owned = await resolveRetryChild(principal, owned, dependencies);
  const loaded = await loadExecution(principal, owned.id, dependencies);
  return project(loaded, nowFrom(dependencies));
}

export async function commitMcpCategorization(
  principal: McpPrincipal,
  input: CommitMcpCategorizationInput,
  dependencies: McpOperationExecutionDeps = {},
): Promise<McpCategorizationOperationDto> {
  const loaded = await loadExecution(principal, input.operationId, dependencies);
  if (loaded.operation.kind !== 'categorization' || loaded.preview === null) {
    throw new McpOperationExecutionError('OPERATION_NOT_FOUND');
  }
  assertCommitIdempotency(input.idempotencyKey, loaded.operation);
  const current = project(loaded, nowFrom(dependencies));
  if (current.phase === 'corrupt') throw new McpOperationExecutionError('OPERATION_CORRUPT');
  if (current.state === 'expired') throw new McpOperationExecutionError('OPERATION_EXPIRED');
  if (current.state === 'cancelled') throw new McpOperationExecutionError('OPERATION_CANCELLED');
  if (current.state === 'retryable') throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
  if (current.state === 'rejected') return current;
  if (current.state === 'committed') return current;

  const actor = await actorFor(loaded.operation, dependencies);
  const authorization = {
    kind: 'mcp' as const,
    tokenId: loaded.operation.tokenId,
    tokenPrefix: loaded.operation.tokenPrefix,
  };
  let result: DurableMutationResult;
  if (
    loaded.attempt?.status === 'COMMITTING'
    || loaded.attempt?.status === 'UNCERTAIN'
  ) {
    result = await (dependencies.reconcile ?? reconcileMutationAttempt)({
      requestId: loaded.operation.id,
      actor,
      authorization,
      expectedStageHash: hashStagedCategorization(loaded.preview),
      expectedTaxDisposition: loaded.preview.taxDisposition ?? 'set',
      expectedQboBinding: {
        qboType: loaded.operation.qboType,
        qboId: loaded.operation.qboId,
        qboSyncToken: loaded.operation.qboSyncToken,
      },
    });
  } else {
    result = await (dependencies.commit ?? commitStagedCategorization)({
      transactionId: loaded.operation.transactionId,
      companyId: loaded.operation.companyId,
      expectedRevision: loaded.operation.preparedRevision,
      expectedStageHash: hashStagedCategorization(loaded.preview),
      expectedTaxDisposition: loaded.preview.taxDisposition ?? 'set',
      expectedQboBinding: {
        qboType: loaded.operation.qboType,
        qboId: loaded.operation.qboId,
        qboSyncToken: loaded.operation.qboSyncToken,
      },
      requestId: loaded.operation.id,
      actor,
      authorization,
    });
  }
  void result;
  return getMcpOperation(principal, { operationId: loaded.operation.id }, dependencies);
}

export async function commitMcpUndo(
  principal: McpPrincipal,
  input: CommitMcpUndoInput,
  dependencies: McpOperationExecutionDeps = {},
): Promise<McpOperationDto> {
  const loaded = await loadExecution(principal, input.operationId, dependencies);
  if (loaded.operation.kind !== 'undo' || loaded.undoPayload === null) {
    throw new McpOperationExecutionError('OPERATION_NOT_FOUND');
  }
  assertCommitIdempotency(input.idempotencyKey, loaded.operation);
  const current = project(loaded, nowFrom(dependencies));
  if (current.phase === 'corrupt') {
    throw new McpOperationExecutionError('OPERATION_CORRUPT');
  }
  if (current.state === 'expired') {
    throw new McpOperationExecutionError('OPERATION_EXPIRED');
  }
  if (current.state === 'cancelled') {
    throw new McpOperationExecutionError('OPERATION_CANCELLED');
  }
  if (current.state === 'retryable') {
    throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
  }
  if (current.state === 'rejected') return current;
  if (current.state === 'committed') return current;

  const operation = loaded.operation;
  const payload = loaded.undoPayload;
  const actor = await actorFor(operation, dependencies);
  const authorization = {
    kind: 'mcp' as const,
    tokenId: operation.tokenId,
    tokenPrefix: operation.tokenPrefix,
  };
  const expectedQboBinding = {
    qboType: operation.qboType,
    qboId: operation.qboId,
    qboSyncToken: operation.qboSyncToken,
  };
  const auditAttribution = {
    sourceOperationId: payload.sourceOperationId,
    operationId: operation.id,
    tokenPrefix: operation.tokenPrefix,
  };
  if (
    loaded.attempt?.status === 'COMMITTING'
    || loaded.attempt?.status === 'UNCERTAIN'
  ) {
    await (dependencies.reconcile ?? reconcileMutationAttempt)({
      requestId: operation.id,
      actor,
      authorization,
      expectedQboBinding,
      auditAttribution,
    });
  } else {
    await (dependencies.undo ?? undoCategorization)({
      transactionId: operation.transactionId,
      companyId: operation.companyId,
      requestId: operation.id,
      actor,
      authorization,
      proof: {
        sourceRequestId: payload.sourceOperationId,
        expectedRevision: operation.preparedRevision,
        expectedQboBinding,
        sourcePreparedHash: payload.sourcePreparedHash,
        currentPostHash: payload.currentPostHash,
        restoreHash: payload.restoreHash,
      },
      auditAttribution,
    });
  }
  return getMcpOperation(principal, { operationId: operation.id }, dependencies);
}

export async function retryMcpOperation(
  principal: McpPrincipal,
  input: RetryMcpOperationInput,
  dependencies: McpOperationExecutionDeps = {},
): Promise<McpCategorizationOperationDto> {
  let owned: McpOperationRecord;
  try {
    owned = await loadOwnedOperation(input.operationId, principal, {
      store: storeFrom(dependencies),
    });
  } catch (error) {
    if (
      error instanceof McpOperationError
      && error.code === 'OPERATION_NOT_FOUND'
    ) {
      const current = await getOwnedAttachmentOperation(
        principal,
        input.operationId,
        dependencies,
      );
      const actor = attachmentActor(principal);
      const result = current.actions.requiresReconciliation
        ? await (
            dependencies.reconcileAttachmentOperation
            ?? reconcileAttachmentOperation
          )(
            actor,
            input.operationId,
            dependencies.attachmentDependencies,
          )
        : await (
            dependencies.retryAttachmentOperation
            ?? retryAttachmentOperation
          )(
            actor,
            input.operationId,
            dependencies.attachmentDependencies,
          );
      return projectMcpAttachmentOperation(result);
    }
    throw error;
  }
  if (owned.kind === 'transfer') {
    const retryTransfer = dependencies.retryTransferOperation
      ?? retryMcpTransferOperation;
    return retryTransfer(principal, input.operationId, {
      ...dependencies.transfer,
      store: storeFrom(dependencies) as never,
    });
  }
  owned = await resolveRetryChild(principal, owned, dependencies);
  const loaded = await loadExecution(principal, owned.id, dependencies);
  const current = project(loaded, nowFrom(dependencies));
  const commit = loaded.operation.kind === 'undo'
    ? commitMcpUndo
    : commitMcpCategorization;
  if (current.state === 'committed') return current;
  if (current.state === 'rejected') return current;
  if (current.state === 'prepared' || current.state === 'reconciliation_required') {
    const resumed = await commit(
      principal,
      { operationId: loaded.operation.id },
      dependencies,
    );
    if (loaded.operation.retryOfId !== null) {
      if (
        resumed.state === 'retryable'
        && resumed.phase !== 'write_unchanged'
      ) {
        throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
      }
      return resumed;
    }
    if (resumed.phase !== 'write_unchanged') return resumed;
  } else if (current.state !== 'retryable') {
    throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
  }
  if (loaded.operation.retryOfId !== null) {
    throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
  }
  const store = storeFrom(dependencies);
  let child = await store.mcpOperation.findFirst({
    where: { retryOfId: loaded.operation.id },
  });
  if (child === null) {
    const create = dependencies.createOperation ?? createPreparedOperation;
    const createInput: CreatePreparedOperationInput = {
      principal,
      companyId: loaded.operation.companyId,
      transactionId: loaded.operation.transactionId,
      toolName: loaded.operation.toolName,
      kind: loaded.operation.kind,
      idempotencyKey: null,
      payload: loaded.operation.payload,
      sourceRevision: loaded.operation.sourceRevision,
      preparedRevision: loaded.operation.preparedRevision,
      qboType: loaded.operation.qboType,
      qboId: loaded.operation.qboId,
      qboSyncToken: loaded.operation.qboSyncToken,
      retryOfId: loaded.operation.id,
    };
    child = await create(createInput, { store, now: dependencies.now });
  }
  const childResult = await commit(
    principal,
    { operationId: child.id },
    dependencies,
  );
  if (childResult.state === 'retryable') {
    throw new McpOperationExecutionError('RETRY_NOT_ALLOWED');
  }
  return childResult;
}

async function loadExecution(
  principal: McpPrincipal,
  operationId: string,
  dependencies: McpOperationExecutionDeps,
): Promise<LoadedExecution> {
  const store = storeFrom(dependencies);
  const operation = await loadOwnedOperation(operationId, principal, { store });
  await assertCurrentMcpCategorizationAuthorization(
    store,
    principal,
    operation.companyId,
    nowFrom(dependencies),
  );
  if (
    !isValidDate(operation.expiresAt)
    || !hasValidMcpOperationIntegrity(operation)
  ) {
    throw new McpOperationExecutionError('OPERATION_CORRUPT');
  }
  let preview: StagedCategorization | null = null;
  let undoPayload: StoredMcpUndoPayload | null = null;
  try {
    if (
      operation.kind === 'categorization'
      && operation.toolName === 'prepare_categorization'
    ) {
      preview = parseStoredMcpCategorizationPayload(operation.payload).preview;
    } else if (
      operation.kind === 'undo'
      && operation.toolName === 'prepare_undo'
    ) {
      undoPayload = parseStoredMcpUndoPayload(operation.payload);
    } else {
      throw new Error('unsupported operation envelope');
    }
  } catch {
    throw new McpOperationExecutionError('OPERATION_CORRUPT');
  }
  const attempt = await store.qboMutationAttempt.findUnique({
    where: { requestId: operation.id },
  });
  const validateAttempt = dependencies.validateAttempt
    ?? ((candidate: McpAttemptProjection) =>
      validateDurableAttemptPersistence(candidate));
  const sourceCorrupt = undoPayload === null
    ? false
    : !await validUndoSourceEvidence(
        store,
        operation,
        undoPayload,
        validateAttempt,
      );
  if (
    attempt !== null
    && (
      attempt.requestId !== operation.id
      || attempt.transactionId !== operation.transactionId
      || attempt.operation !== (
        operation.kind === 'undo' ? 'restore' : 'recategorize'
      )
      || attempt.expectedRevision !== operation.preparedRevision
    )
  ) {
    throw new McpOperationExecutionError('OPERATION_CORRUPT');
  }
  const transaction = attempt === null
    ? null
    : await store.transaction.findUnique({
        where: { id: operation.transactionId },
        select: {
          status: true,
          revision: true,
          qboType: true,
          qboId: true,
          qboSyncToken: true,
        },
      });
  const attemptCorrupt = attempt !== null
    && (
      transaction === null
      || !validAttemptState(
        attempt,
        transaction,
        operation,
        undoPayload,
        validateAttempt,
      )
    );
  return {
    operation,
    attempt,
    transactionStatus: transaction?.status as TxnStatus | null ?? null,
    preview,
    undoPayload,
    attemptCorrupt: sourceCorrupt || attemptCorrupt,
  };
}

async function validUndoSourceEvidence(
  store: McpOperationExecutionStore,
  operation: McpOperationRecord,
  payload: StoredMcpUndoPayload,
  validateAttempt: (attempt: McpAttemptProjection) => DurableAttemptPersistenceProof,
): Promise<boolean> {
  const sourceOperation = await store.mcpOperation.findFirst({
    where: {
      id: payload.sourceOperationId,
      tokenId: operation.tokenId,
      userId: operation.userId,
    },
  });
  if (
    sourceOperation === null
    || sourceOperation.tokenPrefix !== operation.tokenPrefix
    || sourceOperation.companyId !== operation.companyId
    || sourceOperation.transactionId !== operation.transactionId
    || sourceOperation.kind !== 'categorization'
    || sourceOperation.toolName !== 'prepare_categorization'
    || sourceOperation.preparedRevision !== operation.preparedRevision
    || sourceOperation.qboType !== operation.qboType
    || sourceOperation.qboId !== operation.qboId
    || !hasValidMcpOperationIntegrity(sourceOperation)
  ) {
    return false;
  }
  const sourceAttempt = await store.qboMutationAttempt.findUnique({
    where: { requestId: payload.sourceOperationId },
  });
  if (
    sourceAttempt === null
    || sourceAttempt.requestId !== sourceOperation.id
    || sourceAttempt.transactionId !== operation.transactionId
    || sourceAttempt.operation !== 'recategorize'
    || sourceAttempt.status !== 'VERIFIED'
    || sourceAttempt.expectedRevision !== sourceOperation.preparedRevision
  ) {
    return false;
  }
  try {
    const proof = validateAttempt(sourceAttempt);
    return (
      proof.operation === 'recategorize'
      && proof.qboType === sourceOperation.qboType
      && proof.qboId === sourceOperation.qboId
      && proof.requestId === sourceOperation.id
      && proof.requestHash === sourceAttempt.requestHash
      && proof.expectedSyncToken === sourceOperation.qboSyncToken
      && proof.preparedBindingHash === payload.sourcePreparedHash
    );
  } catch {
    return false;
  }
}

function project(
  loaded: LoadedExecution,
  now: Date,
): McpOperationDto {
  const { operation, attempt, transactionStatus } = loaded;
  if (loaded.attemptCorrupt) {
    return base(
      operation,
      'reconciliation_required',
      'corrupt',
      false,
      false,
      true,
      null,
      {
        code: 'OPERATION_CORRUPT',
        message: ERROR_MESSAGES.OPERATION_CORRUPT,
      },
    );
  }
  if (attempt === null) {
    if (operation.cancelledAt !== null) return base(operation, 'cancelled', 'awaiting_commit');
    if (operation.expiresAt.getTime() <= now.getTime()) return base(operation, 'expired', 'awaiting_commit');
    return base(operation, 'prepared', 'awaiting_commit', true);
  }
  const result = transactionStatus === null ? null : {
    outcome: attemptOutcome(attempt.status),
    status: transactionStatus,
  };
  switch (attempt.status) {
    case 'PREPARED': return base(operation, 'prepared', 'write_prepared', true);
    case 'COMMITTING': return base(operation, 'reconciliation_required', 'write_committing', false, false, true);
    case 'UNCERTAIN': return base(operation, 'reconciliation_required', 'write_uncertain', false, false, true);
    case 'VERIFIED': return base(operation, 'committed', 'verified', false, false, false, result);
    case 'DRY_RUN': return base(operation, 'committed', 'dry_run', false, false, false, result);
    case 'RETRYABLE': return base(operation, 'retryable', 'write_retryable', false, operation.retryOfId === null, false, result);
    case 'UNCHANGED': return base(operation, 'retryable', 'write_unchanged', false, operation.retryOfId === null, false, result);
    case 'REJECTED': return base(
      operation,
      'rejected',
      'write_rejected',
      false,
      false,
      false,
      result,
      {
        code: 'QBO_WRITE_REJECTED',
        message: 'QuickBooks rejected the prepared transaction.',
      },
    );
    default:
      return base(operation, 'reconciliation_required', 'corrupt', false, false, true, null, {
        code: 'OPERATION_CORRUPT',
        message: ERROR_MESSAGES.OPERATION_CORRUPT,
      });
  }
}

function base(
  operation: McpOperationRecord,
  state: McpOperationState,
  phase: McpOperationPhase,
  canCommit = false,
  canRetry = false,
  requiresReconciliation = false,
  result: McpOperationDto['result'] = null,
  error: McpOperationDto['error'] = null,
): McpOperationDto {
  return {
    operationId: operation.id,
    kind: operation.kind,
    companyId: operation.companyId,
    transactionId: operation.transactionId,
    sourceRevision: operation.sourceRevision,
    preparedRevision: operation.preparedRevision,
    expiresAt: operation.expiresAt.toISOString(),
    state,
    phase,
    result,
    error,
    actions: { canCommit, canRetry, requiresReconciliation },
  };
}

function attemptOutcome(status: string): DurableMutationOutcome {
  if (status === 'VERIFIED' || status === 'DRY_RUN' || status === 'UNCHANGED' || status === 'RETRYABLE' || status === 'REJECTED') {
    return status;
  }
  return status === 'UNCERTAIN' ? 'UNCERTAIN' : 'IN_PROGRESS';
}

function assertCommitIdempotency(
  idempotencyKey: string | undefined,
  operation: McpOperationRecord,
): void {
  if (idempotencyKey === undefined) return;
  let normalized: string | null;
  try {
    normalized = normalizeMcpOperationIdempotencyKey(idempotencyKey);
  } catch {
    throw new McpOperationExecutionError('IDEMPOTENCY_CONFLICT');
  }
  if (normalized !== operation.idempotencyKey) {
    throw new McpOperationExecutionError('IDEMPOTENCY_CONFLICT');
  }
}

async function actorFor(
  operation: McpOperationRecord,
  dependencies: McpOperationExecutionDeps,
) {
  const user = await storeFrom(dependencies).user.findUnique({
    where: { id: operation.userId },
    select: { name: true },
  });
  const name = user?.name?.trim().slice(0, 100);
  return {
    id: operation.userId,
    label: `${name || 'MCP user'} (MCP ${operation.tokenPrefix})`,
  };
}

function storeFrom(dependencies: McpOperationExecutionDeps): McpOperationExecutionStore {
  return (dependencies.store ?? prisma) as unknown as McpOperationExecutionStore;
}

function nowFrom(dependencies: McpOperationExecutionDeps): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new McpOperationExecutionError('OPERATION_CORRUPT');
  return now;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function exactVerification(
  value: unknown,
  expected: Record<string, string>,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, expectedValue]) => record[key] === expectedValue);
}

function validAttemptState(
  attempt: McpAttemptProjection,
  transaction: {
    status: string;
    revision: number;
    qboType: string;
    qboId: string;
    qboSyncToken: string;
  },
  operation: McpOperationRecord,
  undoPayload: StoredMcpUndoPayload | null,
  validateAttempt: (attempt: McpAttemptProjection) => DurableAttemptPersistenceProof,
): boolean {
  if (
    transaction.revision !== operation.preparedRevision
    || transaction.qboType !== operation.qboType
    || transaction.qboId !== operation.qboId
    || attempt.expectedSyncToken !== operation.qboSyncToken
  ) {
    return false;
  }
  if (attempt.status !== 'DRY_RUN') {
    let proof: DurableAttemptPersistenceProof;
    try {
      proof = validateAttempt(attempt);
    } catch {
      return false;
    }
    const expectedOperation = operation.kind === 'undo'
      ? 'restore'
      : 'recategorize';
    if (
      proof.operation !== expectedOperation
      || proof.qboType !== operation.qboType
      || proof.qboId !== operation.qboId
      || proof.requestId !== operation.id
      || proof.requestHash !== attempt.requestHash
      || proof.expectedSyncToken !== operation.qboSyncToken
      || (
        operation.kind === 'undo'
        && (
          undoPayload === null
          || proof.preparedBindingHash !== undoPayload.restoreHash
          || proof.beforeSnapshotHash !== undoPayload.currentPostHash
        )
      )
    ) {
      return false;
    }
  }
  const retainsPreparedSync = transaction.qboSyncToken === operation.qboSyncToken;
  const preparedStatus = operation.kind === 'undo' ? 'POSTED' : 'PENDING';
  switch (attempt.status) {
    case 'PREPARED':
    case 'RETRYABLE':
      return transaction.status === preparedStatus
        && retainsPreparedSync
        && attempt.verification === null;
    case 'COMMITTING':
      return (
        transaction.status === preparedStatus
        || (
          operation.kind === 'categorization'
          && transaction.status === 'POSTING'
        )
        || transaction.status === 'ERROR'
      ) && retainsPreparedSync && attempt.verification === null;
    case 'UNCERTAIN':
      return transaction.status === 'ERROR'
        && retainsPreparedSync
        && attempt.verification === null;
    case 'VERIFIED':
      {
        const verification = attempt.verification as Record<string, unknown> | null;
        const newSyncToken = verification?.newSyncToken;
        const verificationStatus = operation.kind === 'undo' ? 'REVERTED' : 'POSTED';
        const transactionStatus = operation.kind === 'undo' ? 'PENDING' : 'POSTED';
        return transaction.status === transactionStatus
        && typeof newSyncToken === 'string'
        && newSyncToken.length > 0
        && newSyncToken.length <= 128
        && /^[^\u0000-\u001f\u007f]+$/u.test(newSyncToken)
        && transaction.qboSyncToken === newSyncToken
        && exactVerification(verification, {
          outcome: 'VERIFIED',
          status: verificationStatus,
          newSyncToken,
        });
      }
    case 'DRY_RUN':
      return operation.kind === 'categorization'
        && transaction.status === 'DRY_RUN'
        && retainsPreparedSync
        && exactVerification(attempt.verification, {
          outcome: 'DRY_RUN',
          status: 'DRY_RUN',
        });
    case 'UNCHANGED':
      {
        return transaction.status === preparedStatus
        && retainsPreparedSync
        && exactVerification(attempt.verification, {
          outcome: 'UNCHANGED',
          status: preparedStatus,
        });
      }
    case 'REJECTED':
      return transaction.status === preparedStatus
        && retainsPreparedSync
        && attempt.responseSnapshot === null
        && attempt.errorCode === 'QBO_WRITE_REJECTED'
        && exactVerification(attempt.verification, {
          outcome: 'REJECTED',
          status: preparedStatus,
        });
    default:
      return false;
  }
}
