import { createHash, randomUUID } from 'node:crypto';
import {
  hashLineWriteContent,
  validatePreparedLineTransformation,
  validatePreparedLineWrite,
  verifyLineWriteResult,
} from '../lib/qbo/lineWrite.js';
import { prisma } from '../lib/prisma.js';
import type {
  QboClient,
  QboLineWriteSnapshot,
  QboPreparedLineWrite,
  QboTxn,
} from '../lib/qbo/types.js';
import type { AuditInput, MutationAuditInput } from './audit.js';
import {
  EntityLeaseError,
  fenceEntityLeaseOwnerships,
  renewEntityLeases,
  withEntityLeases,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';
import type {
  Actor,
  DurableMutationAuthorization,
  DurableMutationOutcome,
  McpMutationAuditAttribution,
} from './writeback.js';
import type {
  TransferOperationRecord,
} from './transferOperations.js';

export type TransferOperationState =
  | 'PREPARED'
  | 'IN_PROGRESS'
  | 'PARTIAL'
  | 'VERIFIED'
  | 'DRY_RUN'
  | 'RETRYABLE'
  | 'UNCERTAIN';

export interface TransferOperationDto {
  operationId: string;
  state: TransferOperationState;
  complete: boolean;
  firstLeg: { outcome: DurableMutationOutcome };
  secondLeg: { outcome: DurableMutationOutcome };
  error?: { code: string; message: string };
}

export interface RetryTransferOperationDto extends TransferOperationDto {
  retryOfId: string;
}

export type TransferAttemptStatus =
  | 'PREPARED'
  | 'COMMITTING'
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'RETRYABLE'
  | 'UNCHANGED'
  | 'DRY_RUN';

export interface TransferExecutionAttempt {
  id: string;
  transactionId: string;
  requestId: string;
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
  updatedAt: Date;
}

export interface TransferExecutionTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: number | string | { toString(): string };
  bankAccount: string;
  memo: string | null;
  payee: string;
  date: Date;
  postedAt: Date | null;
  postedByUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  company: {
    id: string;
    disconnectedAt: Date | null;
    dryRun: boolean;
    holdingAccountIds: unknown;
  };
}

interface TransferOperationLocator {
  id: string;
  actorId: string;
  companyId: string;
}

export interface TransferExecutionDb {
  transaction: {
    findUnique(args: {
      where: { id: string };
      include: { company: true };
    }): Promise<TransferExecutionTransaction | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  qboMutationAttempt: {
    findUnique(args: {
      where: { requestId: string };
    }): Promise<TransferExecutionAttempt | null>;
    findMany(args: {
      where: { requestId: { in: string[] } };
    }): Promise<TransferExecutionAttempt[]>;
    updateMany(args: {
      where: {
        id: string;
        status: string | { in: string[] };
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    createMany?(args: {
      data: Record<string, unknown>[];
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  qboAccount: {
    findMany(args: {
      where: {
        companyId: string;
        name: { in: string[] };
        active: true;
      };
      select: { qboId: true; name: true; active: true };
    }): Promise<{ qboId: string; name: string; active: boolean }[]>;
  };
  qboTransferOperation: {
    findFirst(args: {
      where: { id?: string; retryOfId?: string };
      select?: { id: true; actorId: true; companyId: true };
    }): Promise<TransferOperationRecord | TransferOperationLocator | null>;
    createMany?(args: {
      data: TransferOperationRecord;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  $transaction<T>(
    callback: (tx: TransferExecutionDb) => Promise<T>,
  ): Promise<T>;
  $queryRawUnsafe?<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T>;
}

export interface TransferExecutionDeps {
  db: TransferExecutionDb;
  getClient(companyId: string): Promise<QboClient>;
  audit(store: TransferExecutionDb, entry: AuditInput): Promise<unknown>;
  authorize(
    actorId: string | null,
    companyId: string,
    authorization: DurableMutationAuthorization,
    store: TransferExecutionDb,
  ): Promise<boolean>;
  lease<T>(
    keys: readonly EntityLeaseKey[],
    owner: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  renewLease(
    keys: readonly EntityLeaseKey[],
    owner: string,
  ): Promise<void>;
  fence(
    keys: readonly EntityLeaseKey[],
    owner: string,
    tx: TransferExecutionDb,
  ): Promise<void>;
  invocationId(): string;
  operationId?(): string;
  now(): Date;
  envDryRun: boolean;
  heartbeatIntervalMs?: number;
  committingQuiescenceMs?: number;
}

interface TransferAuthorizationStore {
  mcpToken: {
    findFirst(args: {
      where: {
        id: string;
        userId: string;
        prefix: string;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  user: {
    findUnique(args: {
      where: { id: string };
      select: { isInstanceAdmin: true };
    }): Promise<{ isInstanceAdmin: boolean } | null>;
  };
  membership: {
    findUnique(args: {
      where: {
        userId_companyId: { userId: string; companyId: string };
      };
      select: { role: true };
    }): Promise<{ role: string } | null>;
  };
}

export type TransferExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_EXPIRED'
  | 'STALE_REVISION'
  | 'STALE_QBO_BINDING'
  | 'QBO_STATE_DRIFT';

const ERROR_MESSAGES: Readonly<Record<TransferExecutionErrorCode, string>> = {
  INVALID_INPUT: 'Invalid transfer operation request.',
  OPERATION_NOT_FOUND: 'Transfer operation was not found.',
  FORBIDDEN: 'You do not have permission to access this transfer operation.',
  OPERATION_CONFLICT: 'Stored transfer operation evidence is inconsistent.',
  OPERATION_EXPIRED: 'This prepared transfer operation expired before it could be sent.',
  STALE_REVISION: 'A transfer transaction changed before the prepared write could be sent.',
  STALE_QBO_BINDING: 'A transfer transaction QuickBooks binding changed.',
  QBO_STATE_DRIFT: 'QuickBooks changed before the prepared transfer write could be sent.',
};

export class TransferExecutionError extends Error {
  constructor(readonly code: TransferExecutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TransferExecutionError';
  }
}

interface TransferStateProjection {
  state: TransferOperationState;
  complete: boolean;
  firstLeg: { outcome: DurableMutationOutcome };
  secondLeg: { outcome: DurableMutationOutcome };
  error?: { code: string; message: string };
}

const UNCERTAIN_GUIDANCE =
  'A transfer write may have succeeded in QuickBooks. Verify the operation before retrying.';
const PARTIAL_GUIDANCE =
  'One transfer leg is durable, but the other leg still requires recovery.';
const RETRYABLE_GUIDANCE =
  'The transfer was not sent. Prepare a new operation before retrying.';
const IN_PROGRESS_GUIDANCE =
  'This transfer operation is already in progress and will not be sent again.';
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_OPERATION_ID_LENGTH = 128 - '-t0'.length;
const TRANSFER_OPERATION_EXPIRY_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
// QBO aborts a prepared write after 30 seconds. Requiring twice that age
// before accepting an unchanged readback leaves a quiet window for a timed-out
// or lease-orphaned request to land before absence is recorded durably.
const DEFAULT_COMMITTING_QUIESCENCE_MS = 60_000;

class TransferDryRunRequired extends Error {
  constructor() {
    super('Transfer execution switched to dry-run before provider send.');
    this.name = 'TransferDryRunRequired';
  }
}

function outcomeForStatus(status: TransferAttemptStatus): DurableMutationOutcome {
  if (status === 'PREPARED' || status === 'COMMITTING') return 'IN_PROGRESS';
  return status;
}

export function projectTransferState(
  firstStatus: TransferAttemptStatus,
  secondStatus: TransferAttemptStatus,
): TransferStateProjection {
  const statuses = [firstStatus, secondStatus] as const;
  const successes = statuses.filter((status) =>
    status === 'VERIFIED' || status === 'DRY_RUN'
  ).length;
  let state: TransferOperationState;
  if (statuses.includes('UNCERTAIN')) {
    state = 'UNCERTAIN';
  } else if (statuses.every((status) => status === 'VERIFIED')) {
    state = 'VERIFIED';
  } else if (statuses.every((status) => status === 'DRY_RUN')) {
    state = 'DRY_RUN';
  } else if (successes >= 1) {
    state = 'PARTIAL';
  } else if (statuses.includes('COMMITTING')) {
    state = 'IN_PROGRESS';
  } else if (
    statuses.some((status) =>
      status === 'RETRYABLE' || status === 'UNCHANGED'
    )
  ) {
    state = 'RETRYABLE';
  } else {
    state = 'PREPARED';
  }

  const projection: TransferStateProjection = {
    state,
    complete: state === 'VERIFIED' || state === 'DRY_RUN',
    firstLeg: { outcome: outcomeForStatus(firstStatus) },
    secondLeg: { outcome: outcomeForStatus(secondStatus) },
  };
  if (state === 'UNCERTAIN') {
    projection.error = {
      code: 'QBO_WRITE_UNCERTAIN',
      message: UNCERTAIN_GUIDANCE,
    };
  } else if (state === 'PARTIAL') {
    projection.error = {
      code: 'TRANSFER_PARTIAL',
      message: PARTIAL_GUIDANCE,
    };
  } else if (state === 'RETRYABLE') {
    projection.error = {
      code: 'TRANSFER_RETRYABLE',
      message: RETRYABLE_GUIDANCE,
    };
  } else if (state === 'IN_PROGRESS') {
    projection.error = {
      code: 'MUTATION_IN_PROGRESS',
      message: IN_PROGRESS_GUIDANCE,
    };
  }
  return projection;
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TransferExecutionError('INVALID_INPUT');
  }
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length === 0
    || normalized.length > MAX_IDENTIFIER_LENGTH
    || !SAFE_TEXT.test(normalized)
  ) {
    throw new TransferExecutionError('INVALID_INPUT');
  }
  return normalized;
}

async function executionNow(
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
): Promise<Date> {
  let value: unknown;
  if (store.$queryRawUnsafe) {
    const rows = await store.$queryRawUnsafe<{ now: Date | string }[]>(
      'SELECT clock_timestamp() AS "now"',
    );
    value = rows[0]?.now;
  } else {
    value = d.now();
  }
  const now = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(now.getTime())) {
    throw new TransferExecutionError('INVALID_INPUT');
  }
  return now;
}

function heartbeatInterval(d: TransferExecutionDeps): number {
  const configured = d.heartbeatIntervalMs;
  if (configured === undefined || !Number.isFinite(configured)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  return Math.max(1, Math.min(
    Math.trunc(configured),
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  ));
}

function committingQuiescence(d: TransferExecutionDeps): number {
  const configured = d.committingQuiescenceMs;
  if (configured === undefined || !Number.isFinite(configured)) {
    return DEFAULT_COMMITTING_QUIESCENCE_MS;
  }
  return Math.max(0, Math.min(Math.trunc(configured), 10 * 60_000));
}

function isQuiescent(
  attempt: TransferExecutionAttempt,
  now: Date,
  d: TransferExecutionDeps,
): boolean {
  return now.getTime() - attempt.updatedAt.getTime()
    >= committingQuiescence(d);
}

interface LeaseHeartbeat {
  guard(refreshAuthority?: () => Promise<void>): Promise<void>;
  stop(): Promise<boolean>;
}

function startLeaseHeartbeat(
  defaultRefreshAuthority: () => Promise<void>,
  intervalMs: number,
): LeaseHeartbeat {
  let stopped = false;
  let lost = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = async (
    refreshAuthority = defaultRefreshAuthority,
  ): Promise<void> => {
    if (stopped || lost) {
      throw new EntityLeaseError();
    }
    while (running !== null) {
      await running;
      if (stopped || lost) throw new EntityLeaseError();
    }
    const pending = refreshAuthority()
      .catch((error: unknown) => {
        lost = true;
        if (timer !== undefined) clearInterval(timer);
        throw error;
      })
      .finally(() => {
        if (running === pending) running = null;
      });
    running = pending;
    await pending;
  };
  const tick = (): void => {
    if (running !== null) return;
    void refresh().catch(() => undefined);
  };
  timer = setInterval(tick, intervalMs);
  return {
    async guard(refreshAuthority?: () => Promise<void>): Promise<void> {
      await refresh(refreshAuthority);
      if (lost) throw new EntityLeaseError();
    },
    async stop(): Promise<boolean> {
      if (!stopped) {
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
      }
      await running?.catch(() => undefined);
      return !lost;
    },
  };
}

function isOperationRecord(
  value: TransferOperationRecord | TransferOperationLocator,
): value is TransferOperationRecord {
  return 'expiresAt' in value && value.expiresAt instanceof Date;
}

function attemptStatus(value: string): TransferAttemptStatus {
  if (
    value === 'PREPARED'
    || value === 'COMMITTING'
    || value === 'VERIFIED'
    || value === 'UNCERTAIN'
    || value === 'RETRYABLE'
    || value === 'UNCHANGED'
    || value === 'DRY_RUN'
  ) {
    return value;
  }
  throw new TransferExecutionError('OPERATION_CONFLICT');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!isRecord(value)) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function targetAccountQboId(
  prepared: QboPreparedLineWrite,
  expectedAccountQboId: string,
): string {
  const lines = prepared.body.Line;
  if (
    !Array.isArray(lines)
    || expectedAccountQboId.trim() === ''
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  const detailKey = prepared.qboType === 'Purchase'
    ? 'AccountBasedExpenseLineDetail'
    : prepared.qboType === 'Deposit'
      ? 'DepositLineDetail'
      : 'JournalEntryLineDetail';
  const matchingLines = lines.filter((line) => {
    if (!isRecord(line)) return false;
    const detail = isRecord(line[detailKey]) ? line[detailKey] : null;
    const accountRef = detail === null ? null : detail.AccountRef;
    return (
      isRecord(accountRef)
      && accountRef.value === expectedAccountQboId
      && (
        prepared.qboType !== 'JournalEntry'
        || detail?.PostingType === 'Debit'
      )
    );
  });
  if (matchingLines.length !== 1) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return expectedAccountQboId;
}

function preparedDigestValue(
  transactionId: string,
  expectedRevision: number,
  targetAccountId: string,
  prepared: QboPreparedLineWrite,
): unknown {
  return {
    transactionId,
    expectedRevision,
    targetAccountQboId: targetAccountId,
    operation: prepared.operation,
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    requestHash: prepared.requestHash,
    body: prepared.body,
    before: prepared.before,
    expected: prepared.expected,
  };
}

function validateAttemptEvidence(
  operation: TransferOperationRecord,
  attempt: TransferExecutionAttempt,
  index: 0 | 1,
): QboPreparedLineWrite {
  const prefix = index === 0 ? 'first' : 'second';
  const transactionId = operation[`${prefix}TransactionId`];
  const requestId = operation[`${prefix}AttemptRequestId`];
  const expectedRevision = operation[`${prefix}ExpectedRevision`];
  const expectedSyncToken = operation[`${prefix}QboSyncToken`];
  const qboType = operation[`${prefix}QboType`];
  const qboId = operation[`${prefix}QboId`];
  const targetAccountId = operation[`${prefix}TargetAccountQboId`];
  let prepared: QboPreparedLineWrite;
  try {
    prepared = validatePreparedLineWrite(attempt.requestPayload);
  } catch {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  if (
    attempt.transactionId !== transactionId
    || attempt.requestId !== requestId
    || attempt.operation !== 'transfer'
    || attempt.expectedRevision !== expectedRevision
    || attempt.expectedSyncToken !== expectedSyncToken
    || attempt.requestHash !== prepared.requestHash
    || !sameJson(attempt.beforeSnapshot, prepared.before)
    || prepared.requestId !== requestId
    || prepared.qboType !== qboType
    || prepared.qboId !== qboId
    || prepared.before.syncToken !== expectedSyncToken
    || targetAccountQboId(prepared, targetAccountId) !== targetAccountId
    || !(attempt.updatedAt instanceof Date)
    || !Number.isFinite(attempt.updatedAt.getTime())
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }

  const status = attemptStatus(attempt.status);
  if (status === 'VERIFIED') {
    let result;
    try {
      result = verifyLineWriteResult(prepared, attempt.responseSnapshot);
    } catch {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    const verification = isRecord(attempt.verification)
      ? attempt.verification
      : null;
    if (
      verification === null
      || verification.outcome !== 'VERIFIED'
      || verification.status !== 'POSTED'
      || verification.newSyncToken !== result.newSyncToken
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  } else if (status === 'UNCHANGED') {
    const verification = isRecord(attempt.verification)
      ? attempt.verification
      : null;
    if (
      !sameJson(attempt.responseSnapshot, prepared.before)
      || verification === null
      || verification.outcome !== 'UNCHANGED'
      || verification.status !== 'PENDING'
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  } else if (status === 'DRY_RUN') {
    const verification = isRecord(attempt.verification)
      ? attempt.verification
      : null;
    if (
      attempt.responseSnapshot !== null
      || verification === null
      || verification.outcome !== 'DRY_RUN'
      || verification.status !== 'DRY_RUN'
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  } else if (
    (status === 'COMMITTING' || status === 'UNCERTAIN')
    && attempt.responseSnapshot !== null
  ) {
    try {
      verifyLineWriteResult(prepared, attempt.responseSnapshot);
    } catch {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    if (attempt.verification !== null) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  }
  return prepared;
}

function validateOperationEvidence(
  operation: TransferOperationRecord,
  attempts: [TransferExecutionAttempt, TransferExecutionAttempt],
  parent?: TransferOperationRecord,
): [QboPreparedLineWrite, QboPreparedLineWrite] {
  const retryIdempotencyHash = parent === undefined
    ? null
    : hashCanonical({ kind: 'transfer-retry', retryOfId: parent.id });
  const retryInputHash = parent === undefined
    ? null
    : hashCanonical({
        parentInputHash: parent.inputHash,
        retryOfId: parent.id,
      });
  if (
    operation.firstTransactionId === operation.secondTransactionId
    || (
      operation.firstQboType === operation.secondQboType
      && operation.firstQboId === operation.secondQboId
    )
    || operation.firstTargetAccountQboId === operation.secondTargetAccountQboId
    || operation.firstExpectedRevision < 0
    || operation.secondExpectedRevision < 0
    || !SHA256_HEX.test(operation.idempotencyHash)
    || !SHA256_HEX.test(operation.inputHash)
    || !SHA256_HEX.test(operation.preparedHash)
    || !(operation.expiresAt instanceof Date)
    || !Number.isFinite(operation.expiresAt.getTime())
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  if (parent === undefined) {
    const usesSafeRequestIds = (
      operation.firstAttemptRequestId === `${operation.id}-t0`
      && operation.secondAttemptRequestId === `${operation.id}-t1`
    );
    const usesLegacyRequestIds = (
      operation.firstAttemptRequestId === `${operation.id}:transfer:0`
      && operation.secondAttemptRequestId === `${operation.id}:transfer:1`
    );
    if (
      operation.retryOfId !== null
      || (!usesSafeRequestIds && !usesLegacyRequestIds)
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  } else {
    const childRequestIds = [
      [`${operation.id}-t0`, `${operation.id}:transfer:0`],
      [`${operation.id}-t1`, `${operation.id}:transfer:1`],
    ] as const;
    const parentRequestIds = [
      parent.firstAttemptRequestId,
      parent.secondAttemptRequestId,
    ] as const;
    const operationRequestIds = [
      operation.firstAttemptRequestId,
      operation.secondAttemptRequestId,
    ] as const;
    const inherited = operationRequestIds.map((requestId, index) =>
      requestId === parentRequestIds[index]
    );
    if (
      operation.retryOfId !== parent.id
      || parent.retryOfId !== null
      || operation.actorId !== parent.actorId
      || operation.companyId !== parent.companyId
      || operation.firstTransactionId !== parent.firstTransactionId
      || operation.secondTransactionId !== parent.secondTransactionId
      || operation.idempotencyHash !== retryIdempotencyHash
      || operation.inputHash !== retryInputHash
      || inherited.every(Boolean)
      || operationRequestIds.some((requestId, index) =>
        requestId !== parentRequestIds[index]
        && !childRequestIds[index]!.some((candidate) =>
          candidate === requestId
        )
      )
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    for (const index of [0, 1] as const) {
      if (!inherited[index]) continue;
      const prefix = index === 0 ? 'first' : 'second';
      if (
        attemptStatus(attempts[index].status) !== 'VERIFIED'
        || operation[`${prefix}ExpectedRevision`]
          !== parent[`${prefix}ExpectedRevision`]
        || operation[`${prefix}QboType`] !== parent[`${prefix}QboType`]
        || operation[`${prefix}QboId`] !== parent[`${prefix}QboId`]
        || operation[`${prefix}QboSyncToken`]
          !== parent[`${prefix}QboSyncToken`]
        || operation[`${prefix}TargetAccountQboId`]
          !== parent[`${prefix}TargetAccountQboId`]
      ) {
        throw new TransferExecutionError('OPERATION_CONFLICT');
      }
    }
  }
  const prepared = [
    validateAttemptEvidence(operation, attempts[0], 0),
    validateAttemptEvidence(operation, attempts[1], 1),
  ] as [QboPreparedLineWrite, QboPreparedLineWrite];
  const digest = hashCanonical([
    preparedDigestValue(
      operation.firstTransactionId,
      operation.firstExpectedRevision,
      operation.firstTargetAccountQboId,
      prepared[0],
    ),
    preparedDigestValue(
      operation.secondTransactionId,
      operation.secondExpectedRevision,
      operation.secondTargetAccountQboId,
      prepared[1],
    ),
  ]);
  if (digest !== operation.preparedHash) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return prepared;
}

interface LoadedOperation {
  operation: TransferOperationRecord;
  attempts: [TransferExecutionAttempt, TransferExecutionAttempt];
  prepared: [QboPreparedLineWrite, QboPreparedLineWrite];
}

async function defaultAuthorize(
  actorId: string | null,
  companyId: string,
  authorization: DurableMutationAuthorization,
  rawStore: TransferExecutionDb,
): Promise<boolean> {
  if (actorId === null) return false;
  const store = rawStore as unknown as TransferAuthorizationStore;
  if (authorization.kind === 'mcp') {
    const token = await store.mcpToken.findFirst({
      where: {
        id: authorization.tokenId,
        userId: actorId,
        prefix: authorization.tokenPrefix,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (token === null) return false;
  }
  const user = await store.user.findUnique({
    where: { id: actorId },
    select: { isInstanceAdmin: true },
  });
  if (user?.isInstanceAdmin) return true;
  const membership = await store.membership.findUnique({
    where: { userId_companyId: { userId: actorId, companyId } },
    select: { role: true },
  });
  return membership?.role === 'admin' || membership?.role === 'categorizer';
}

async function defaultExecutionDeps(): Promise<TransferExecutionDeps> {
  const [{ qboFactory }, { writeAudit }, { env }] = await Promise.all([
    import('../lib/qbo/factory.js'),
    import('./audit.js'),
    import('../env.js'),
  ]);
  return {
    db: prisma as unknown as TransferExecutionDb,
    getClient: (companyId) => qboFactory.forCompany(companyId),
    audit: (store, entry) =>
      writeAudit(store as never, entry),
    authorize: defaultAuthorize,
    lease: (keys, owner, callback) =>
      withEntityLeases(keys, owner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    renewLease: (keys, owner) =>
      renewEntityLeases(keys, owner, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    fence: (keys, owner, tx) =>
      fenceEntityLeaseOwnerships(keys, owner, {
        db: tx as unknown as EntityLeaseFenceDb,
      }),
    invocationId: randomUUID,
    operationId: randomUUID,
    now: () => new Date(),
    envDryRun: env.DRY_RUN,
  };
}

async function loadAuthorizedOperation(
  operationIdValue: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
): Promise<LoadedOperation> {
  const operationId = boundedIdentifier(operationIdValue);
  const actorId = boundedIdentifier(actor?.id);
  const locator = await store.qboTransferOperation.findFirst({
    where: { id: operationId },
    select: { id: true, actorId: true, companyId: true },
  });
  if (locator === null) {
    throw new TransferExecutionError('OPERATION_NOT_FOUND');
  }
  if (!await d.authorize(actorId, locator.companyId, authorization, store)) {
    throw new TransferExecutionError('FORBIDDEN');
  }
  if (locator.actorId !== actorId) {
    throw new TransferExecutionError('FORBIDDEN');
  }
  const operationValue = await store.qboTransferOperation.findFirst({
    where: { id: operationId },
  });
  if (operationValue === null || !isOperationRecord(operationValue)) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  if (
    operationValue.id !== locator.id
    || operationValue.actorId !== locator.actorId
    || operationValue.companyId !== locator.companyId
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  let parent: TransferOperationRecord | undefined;
  if (operationValue.retryOfId !== null) {
    const parentValue = await store.qboTransferOperation.findFirst({
      where: { id: operationValue.retryOfId },
    });
    if (
      parentValue === null
      || !isOperationRecord(parentValue)
      || parentValue.actorId !== locator.actorId
      || parentValue.companyId !== locator.companyId
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    parent = parentValue;
  }
  const attempts = await store.qboMutationAttempt.findMany({
    where: {
      requestId: {
        in: [
          operationValue.firstAttemptRequestId,
          operationValue.secondAttemptRequestId,
        ],
      },
    },
  });
  const first = attempts.find((attempt) =>
    attempt.requestId === operationValue.firstAttemptRequestId
  );
  const second = attempts.find((attempt) =>
    attempt.requestId === operationValue.secondAttemptRequestId
  );
  if (
    attempts.length !== 2
    || first === undefined
    || second === undefined
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  const ordered = [first, second] as [
    TransferExecutionAttempt,
    TransferExecutionAttempt,
  ];
  return {
    operation: operationValue,
    attempts: ordered,
    prepared: validateOperationEvidence(operationValue, ordered, parent),
  };
}

function operationDto(loaded: LoadedOperation): TransferOperationDto {
  return {
    operationId: loaded.operation.id,
    ...projectTransferState(
      attemptStatus(loaded.attempts[0].status),
      attemptStatus(loaded.attempts[1].status),
    ),
  };
}

interface LoadedLocalState {
  loaded: LoadedOperation;
  transactions: [
    TransferExecutionTransaction,
    TransferExecutionTransaction,
  ];
}

function expectedLocalSyncToken(
  attempt: TransferExecutionAttempt,
): string {
  if (attemptStatus(attempt.status) !== 'VERIFIED') {
    return attempt.expectedSyncToken;
  }
  const verification = isRecord(attempt.verification)
    ? attempt.verification
    : null;
  if (
    verification === null
    || typeof verification.newSyncToken !== 'string'
    || verification.newSyncToken.trim() === ''
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return verification.newSyncToken;
}

function allowedLocalStatuses(status: TransferAttemptStatus): string[] {
  if (status === 'VERIFIED') return ['POSTED'];
  if (status === 'DRY_RUN') return ['DRY_RUN'];
  if (status === 'UNCERTAIN') return ['PENDING', 'ERROR'];
  return ['PENDING'];
}

function validateLocalTransaction(
  operation: TransferOperationRecord,
  attempt: TransferExecutionAttempt,
  transaction: TransferExecutionTransaction,
  index: 0 | 1,
): void {
  const prefix = index === 0 ? 'first' : 'second';
  const expectedTransactionId = operation[`${prefix}TransactionId`];
  const expectedRevision = operation[`${prefix}ExpectedRevision`];
  const expectedQboType = operation[`${prefix}QboType`];
  const expectedQboId = operation[`${prefix}QboId`];
  if (
    transaction.id !== expectedTransactionId
    || transaction.companyId !== operation.companyId
    || transaction.company.id !== operation.companyId
    || transaction.revision !== expectedRevision
  ) {
    throw new TransferExecutionError('STALE_REVISION');
  }
  if (
    transaction.qboType !== expectedQboType
    || transaction.qboId !== expectedQboId
    || transaction.qboSyncToken !== expectedLocalSyncToken(attempt)
  ) {
    throw new TransferExecutionError('STALE_QBO_BINDING');
  }
  if (
    transaction.company.disconnectedAt !== null
    || !allowedLocalStatuses(attemptStatus(attempt.status))
      .includes(transaction.status)
  ) {
    throw new TransferExecutionError('STALE_QBO_BINDING');
  }
}

async function loadLocalState(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
): Promise<LoadedLocalState> {
  const loaded = await loadAuthorizedOperation(
    operationId,
    actor,
    authorization,
    d,
    store,
  );
  const transactions = await loadOperationTransactions(loaded, store);
  validateLocalTransaction(
    loaded.operation,
    loaded.attempts[0],
    transactions[0],
    0,
  );
  validateLocalTransaction(
    loaded.operation,
    loaded.attempts[1],
    transactions[1],
    1,
  );
  return { loaded, transactions };
}

async function loadOperationTransactions(
  loaded: LoadedOperation,
  store: TransferExecutionDb,
): Promise<
  [TransferExecutionTransaction, TransferExecutionTransaction]
> {
  const first = await store.transaction.findUnique({
    where: { id: loaded.operation.firstTransactionId },
    include: { company: true },
  });
  const second = await store.transaction.findUnique({
    where: { id: loaded.operation.secondTransactionId },
    include: { company: true },
  });
  if (first === null || second === null) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return [first, second];
}

function validateRecoveryTransaction(
  operation: TransferOperationRecord,
  transaction: TransferExecutionTransaction,
  index: 0 | 1,
): void {
  const prefix = index === 0 ? 'first' : 'second';
  if (
    transaction.id !== operation[`${prefix}TransactionId`]
    || transaction.companyId !== operation.companyId
    || transaction.company.id !== operation.companyId
    || transaction.qboType !== operation[`${prefix}QboType`]
    || transaction.qboId !== operation[`${prefix}QboId`]
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
}

async function loadRecoveryState(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
): Promise<LoadedLocalState> {
  const loaded = await loadAuthorizedOperation(
    operationId,
    actor,
    authorization,
    d,
    store,
  );
  const transactions = await loadOperationTransactions(loaded, store);
  validateRecoveryTransaction(loaded.operation, transactions[0], 0);
  validateRecoveryTransaction(loaded.operation, transactions[1], 1);
  return { loaded, transactions };
}

function canonicalLeaseKeys(
  operation: TransferOperationRecord,
): [EntityLeaseKey, EntityLeaseKey] {
  const keys = [
    {
      companyId: operation.companyId,
      qboType: operation.firstQboType,
      qboId: operation.firstQboId,
    },
    {
      companyId: operation.companyId,
      qboType: operation.secondQboType,
      qboId: operation.secondQboId,
    },
  ];
  keys.sort((left, right) => {
    for (const field of ['companyId', 'qboType', 'qboId'] as const) {
      const compared = left[field].localeCompare(right[field]);
      if (compared !== 0) return compared;
    }
    return 0;
  });
  if (
    keys[0]!.companyId === keys[1]!.companyId
    && keys[0]!.qboType === keys[1]!.qboType
    && keys[0]!.qboId === keys[1]!.qboId
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return keys as [EntityLeaseKey, EntityLeaseKey];
}

function withAttemptStatus(
  loaded: LoadedOperation,
  index: 0 | 1,
  status: TransferAttemptStatus,
  updatedAt?: Date,
): LoadedOperation {
  const attempts = loaded.attempts.map((attempt, attemptIndex) =>
    attemptIndex === index
      ? {
          ...attempt,
          status,
          ...(updatedAt === undefined ? {} : { updatedAt }),
        }
      : attempt
  ) as [TransferExecutionAttempt, TransferExecutionAttempt];
  return { ...loaded, attempts };
}

function mutationMetadata(
  operation: TransferOperationRecord,
  prepared: QboPreparedLineWrite,
  index: 0 | 1,
  outcome: MutationAuditInput['outcome'],
  attribution?: McpMutationAuditAttribution,
): MutationAuditInput {
  return {
    requestId: prepared.requestId,
    outcome,
    references: {
      operation: 'transfer',
      qboType: prepared.qboType,
      qboId: prepared.qboId,
      accountQboIds: [
        index === 0
          ? operation.firstTargetAccountQboId
          : operation.secondTargetAccountQboId,
      ],
      taxCodeQboIds: [],
    },
    ...(attribution === undefined ? {} : { mcp: attribution }),
  };
}

async function writeLegAudit(
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
  state: LoadedLocalState,
  index: 0 | 1,
  actor: Actor,
  action: AuditInput['action'],
  outcome: MutationAuditInput['outcome'],
  attribution?: McpMutationAuditAttribution,
): Promise<void> {
  const transaction = state.transactions[index];
  const prepared = state.loaded.prepared[index];
  await d.audit(store, {
    companyId: transaction.companyId,
    actorId: actor.id,
    actorLabel: actor.label,
    txnId: transaction.id,
    payee: transaction.payee,
    amount: Number(transaction.amount),
    action,
    before: 'QuickBooks transfer source',
    after: 'Transfer to counterpart account',
    mutation: mutationMetadata(
      state.loaded.operation,
      prepared,
      index,
      outcome,
      attribution,
    ),
  });
}

async function markPreparedRetryable(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  code:
    | 'OPERATION_EXPIRED'
    | 'STALE_REVISION'
    | 'STALE_QBO_BINDING'
    | 'QBO_STATE_DRIFT',
  d: TransferExecutionDeps,
): Promise<void> {
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const loaded = await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    if (attemptStatus(loaded.attempts[index].status) !== 'PREPARED') return;
    for (const attempt of loaded.attempts) {
      if (attemptStatus(attempt.status) !== 'PREPARED') continue;
      await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'PREPARED' },
        data: {
          status: 'RETRYABLE',
          errorCode: code,
          errorMessage: ERROR_MESSAGES[code],
        },
      });
    }
  });
}

async function markClaimedAndPreparedRetryable(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  claimedIndex: 0 | 1,
  code:
    | 'OPERATION_EXPIRED'
    | 'STALE_REVISION'
    | 'STALE_QBO_BINDING'
    | 'QBO_STATE_DRIFT',
  d: TransferExecutionDeps,
): Promise<void> {
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const loaded = await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    for (const [index, attempt] of loaded.attempts.entries()) {
      const status = attemptStatus(attempt.status);
      const safelyUnsent = status === 'PREPARED'
        || (index === claimedIndex && status === 'COMMITTING');
      if (!safelyUnsent) continue;
      await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status },
        data: {
          status: 'RETRYABLE',
          errorCode: code,
          errorMessage: ERROR_MESSAGES[code],
        },
      });
    }
  });
}

async function expirePreparedAttempts(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  d: TransferExecutionDeps,
): Promise<void> {
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const loaded = await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    for (const attempt of loaded.attempts) {
      if (attemptStatus(attempt.status) !== 'PREPARED') continue;
      await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'PREPARED' },
        data: {
          status: 'RETRYABLE',
          errorCode: 'OPERATION_EXPIRED',
          errorMessage: ERROR_MESSAGES.OPERATION_EXPIRED,
        },
      });
    }
  });
}

type PreparedStateResult =
  | { kind: 'state'; state: LoadedLocalState }
  | { kind: 'terminal'; dto: TransferOperationDto };

async function loadPreparedState(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  d: TransferExecutionDeps,
): Promise<PreparedStateResult> {
  try {
    return {
      kind: 'state',
      state: await loadLocalState(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      ),
    };
  } catch (error) {
    if (
      !(error instanceof TransferExecutionError)
      || (
        error.code !== 'STALE_REVISION'
        && error.code !== 'STALE_QBO_BINDING'
      )
    ) {
      throw error;
    }
    const loaded = await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      d.db,
    );
    const preparedIndices = loaded.attempts.flatMap((attempt, index) =>
      attemptStatus(attempt.status) === 'PREPARED'
        ? [index as 0 | 1]
        : []
    );
    if (preparedIndices.length === 0) throw error;
    for (const index of preparedIndices) {
      await markPreparedRetryable(
        operationId,
        actor,
        authorization,
        keys,
        owner,
        index,
        error.code,
        d,
      );
    }
    return {
      kind: 'terminal',
      dto: operationDto(await loadAuthorizedOperation(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      )),
    };
  }
}

async function enterCommitting(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  exactBefore: QboLineWriteSnapshot,
  d: TransferExecutionDeps,
): Promise<{ won: boolean; state: LoadedLocalState }> {
  let result: { won: boolean; state: LoadedLocalState } | undefined;
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const state = await loadLocalState(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    const attempt = state.loaded.attempts[index];
    const prepared = state.loaded.prepared[index];
    if (attemptStatus(attempt.status) !== 'PREPARED') {
      result = { won: false, state };
      return;
    }
    const now = await executionNow(d, tx);
    if (state.loaded.operation.expiresAt.getTime() <= now.getTime()) {
      throw new TransferExecutionError('OPERATION_EXPIRED');
    }
    if (!sameJson(exactBefore, prepared.before)) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
    const updated = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: 'PREPARED' },
      data: {
        status: 'COMMITTING',
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      },
    });
    result = {
      won: updated.count === 1,
      state: {
        ...state,
        loaded: updated.count === 1
          ? withAttemptStatus(state.loaded, index, 'COMMITTING', now)
          : state.loaded,
      },
    };
  });
  if (result === undefined) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  if (!result.won) {
    result.state = await loadLocalState(
      operationId,
      actor,
      authorization,
      d,
      d.db,
    );
  }
  return result;
}

async function finalizeVerified(
  d: TransferExecutionDeps,
  state: LoadedLocalState,
  index: 0 | 1,
  actor: Actor,
  keys: readonly EntityLeaseKey[],
  owner: string,
  response: QboLineWriteSnapshot,
  attribution?: McpMutationAuditAttribution,
): Promise<boolean> {
  const attempt = state.loaded.attempts[index];
  const transaction = state.transactions[index];
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const updated = await tx.qboMutationAttempt.updateMany({
      where: {
        id: attempt.id,
        status: { in: ['COMMITTING', 'UNCERTAIN'] },
      },
      data: {
        status: 'VERIFIED',
        responseSnapshot: response,
        verification: {
          outcome: 'VERIFIED',
          status: 'POSTED',
          newSyncToken: response.syncToken,
        },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) return;
    transitioned = true;
    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'POSTED',
        qboSyncToken: response.syncToken,
        postedAt: d.now(),
        postedByUserId: actor.id,
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeLegAudit(
      d,
      tx,
      state,
      index,
      actor,
      'transfer',
      'VERIFIED',
      attribution,
    );
  });
  return transitioned;
}

async function persistAcceptedResponse(
  d: TransferExecutionDeps,
  state: LoadedLocalState,
  index: 0 | 1,
  keys: readonly EntityLeaseKey[],
  owner: string,
  response: QboLineWriteSnapshot,
): Promise<boolean> {
  const attempt = state.loaded.attempts[index];
  let persisted = false;
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const now = await executionNow(d, tx);
    const updated = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: 'COMMITTING' },
      data: {
        responseSnapshot: response,
        updatedAt: now,
      },
    });
    persisted = updated.count === 1;
  });
  if (persisted) {
    attempt.responseSnapshot = response;
  }
  return persisted;
}

async function finalizeUnchanged(
  d: TransferExecutionDeps,
  state: LoadedLocalState,
  index: 0 | 1,
  actor: Actor,
  keys: readonly EntityLeaseKey[],
  owner: string,
  response: QboLineWriteSnapshot,
  attribution?: McpMutationAuditAttribution,
): Promise<boolean> {
  const attempt = state.loaded.attempts[index];
  const transaction = state.transactions[index];
  let transitioned = false;
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const updated = await tx.qboMutationAttempt.updateMany({
      where: {
        id: attempt.id,
        status: { in: ['COMMITTING', 'UNCERTAIN'] },
      },
      data: {
        status: 'UNCHANGED',
        responseSnapshot: response,
        verification: {
          outcome: 'UNCHANGED',
          status: 'PENDING',
        },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) return;
    transitioned = true;
    for (const [otherIndex, otherAttempt] of state.loaded.attempts.entries()) {
      if (
        otherIndex === index
        || attemptStatus(otherAttempt.status) !== 'PREPARED'
      ) {
        continue;
      }
      await tx.qboMutationAttempt.updateMany({
        where: { id: otherAttempt.id, status: 'PREPARED' },
        data: {
          status: 'RETRYABLE',
          errorCode: 'TRANSFER_RETRYABLE',
          errorMessage: RETRYABLE_GUIDANCE,
        },
      });
    }
    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'PENDING',
        errorCode: null,
        errorMessage: null,
      },
    });
    await writeLegAudit(
      d,
      tx,
      state,
      index,
      actor,
      'error',
      'UNCHANGED',
      attribution,
    );
  });
  return transitioned;
}

function syntheticUncertainDto(
  loaded: LoadedOperation,
  index: 0 | 1,
): TransferOperationDto {
  return operationDto(withAttemptStatus(loaded, index, 'UNCERTAIN'));
}

async function markUncertain(
  d: TransferExecutionDeps,
  state: LoadedLocalState,
  index: 0 | 1,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  attribution?: McpMutationAuditAttribution,
  acceptedResponse?: QboLineWriteSnapshot,
): Promise<TransferOperationDto> {
  const attempt = state.loaded.attempts[index];
  if (attemptStatus(attempt.status) === 'UNCERTAIN') {
    return operationDto(await loadAuthorizedOperation(
      state.loaded.operation.id,
      actor,
      authorization,
      d,
      d.db,
    ));
  }
  const transaction = state.transactions[index];
  try {
    await d.db.$transaction(async (tx) => {
      await d.fence(keys, owner, tx);
      const now = await executionNow(d, tx);
      const updated = await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: 'COMMITTING' },
        data: {
          status: 'UNCERTAIN',
          ...(acceptedResponse === undefined
            ? {}
            : { responseSnapshot: acceptedResponse }),
          errorCode: 'QBO_WRITE_UNCERTAIN',
          errorMessage: UNCERTAIN_GUIDANCE,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) return;
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'ERROR',
          errorCode: 'QBO_WRITE_UNCERTAIN',
          errorMessage: UNCERTAIN_GUIDANCE,
        },
      });
      await writeLegAudit(
        d,
        tx,
        state,
        index,
        actor,
        'error',
        'UNCERTAIN',
        attribution,
      );
    });
  } catch {
    // Ownership may have moved while the provider call was in flight. Never
    // project the stale in-memory attempt; reload the durable authority.
  }
  return operationDto(await loadAuthorizedOperation(
    state.loaded.operation.id,
    actor,
    authorization,
    d,
    d.db,
  ));
}

async function finalizeDryRun(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  indices: readonly (0 | 1)[],
  attribution: McpMutationAuditAttribution | undefined,
  d: TransferExecutionDeps,
  claimedIndex?: 0 | 1,
): Promise<'finalized' | 'not-enabled' | 'expired'> {
  return d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const state = await loadLocalState(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    if (indices.length === 0 || indices.some((index) => {
      const status = attemptStatus(state.loaded.attempts[index].status);
      return status !== 'PREPARED'
        && !(index === claimedIndex && status === 'COMMITTING');
    })) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    const now = await executionNow(d, tx);
    if (state.loaded.operation.expiresAt.getTime() <= now.getTime()) {
      for (const index of indices) {
        const attempt = state.loaded.attempts[index];
        const status = attemptStatus(attempt.status);
        await tx.qboMutationAttempt.updateMany({
          where: { id: attempt.id, status },
          data: {
            status: 'RETRYABLE',
            errorCode: 'OPERATION_EXPIRED',
            errorMessage: ERROR_MESSAGES.OPERATION_EXPIRED,
          },
        });
      }
      return 'expired';
    }
    const dryRun = d.envDryRun || state.transactions.some((transaction) =>
      transaction.company.dryRun
    );
    if (!dryRun) return 'not-enabled';
    for (const index of indices) {
      const attempt = state.loaded.attempts[index];
      const status = attemptStatus(attempt.status);
      const updated = await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status },
        data: {
          status: 'DRY_RUN',
          responseSnapshot: null,
          verification: {
            outcome: 'DRY_RUN',
            status: 'DRY_RUN',
          },
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count !== 1) {
        throw new TransferExecutionError('OPERATION_CONFLICT');
      }
      await tx.transaction.update({
        where: { id: state.transactions[index].id },
        data: {
          status: 'DRY_RUN',
          postedAt: d.now(),
          postedByUserId: actor.id,
          errorCode: null,
          errorMessage: null,
        },
      });
      await writeLegAudit(
        d,
        tx,
        state,
        index,
        actor,
        'dry-run',
        'DRY_RUN',
        attribution,
      );
    }
    return 'finalized';
  });
}

async function refreshCommittingAuthority(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  d: TransferExecutionDeps,
  strictLocalState = false,
): Promise<void> {
  await d.renewLease(keys, owner);
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const state = strictLocalState
      ? await loadLocalState(
          operationId,
          actor,
          authorization,
          d,
          tx,
        )
      : await loadRecoveryState(
          operationId,
          actor,
          authorization,
          d,
          tx,
        );
    const attempt = state.loaded.attempts[index];
    if (attemptStatus(attempt.status) !== 'COMMITTING') {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    const now = await executionNow(d, tx);
    if (strictLocalState) {
      if (state.loaded.operation.expiresAt.getTime() <= now.getTime()) {
        throw new TransferExecutionError('OPERATION_EXPIRED');
      }
      if (
        d.envDryRun
        || state.transactions.some((transaction) =>
          transaction.company.dryRun
        )
      ) {
        throw new TransferDryRunRequired();
      }
    }
    const updated = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status: 'COMMITTING' },
      data: { updatedAt: now },
    });
    if (updated.count !== 1) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  });
}

async function refreshRecoveryAuthority(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  d: TransferExecutionDeps,
): Promise<void> {
  await d.renewLease(keys, owner);
  await d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    const state = await loadRecoveryState(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
    const attempt = state.loaded.attempts[index];
    const status = attemptStatus(attempt.status);
    if (status !== 'COMMITTING' && status !== 'UNCERTAIN') {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    const now = await executionNow(d, tx);
    const updated = await tx.qboMutationAttempt.updateMany({
      where: { id: attempt.id, status },
      data: { updatedAt: now },
    });
    if (updated.count !== 1) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
  });
}

async function fencedReconciliationState(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  keys: readonly EntityLeaseKey[],
  owner: string,
  d: TransferExecutionDeps,
): Promise<LoadedLocalState> {
  await d.renewLease(keys, owner);
  return d.db.$transaction(async (tx) => {
    await d.fence(keys, owner, tx);
    return loadRecoveryState(
      operationId,
      actor,
      authorization,
      d,
      tx,
    );
  });
}

async function reconcileLeg(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  attribution: McpMutationAuditAttribution | undefined,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  d: TransferExecutionDeps,
): Promise<TransferOperationDto | undefined> {
  const state = await fencedReconciliationState(
    operationId,
    actor,
    authorization,
    keys,
    owner,
    d,
  );
  const attemptStatusValue = attemptStatus(state.loaded.attempts[index].status);
  if (
    attemptStatusValue !== 'COMMITTING'
    && attemptStatusValue !== 'UNCERTAIN'
  ) {
    return undefined;
  }
  const prepared = state.loaded.prepared[index];
  const startedQuiescent = isQuiescent(
    state.loaded.attempts[index],
    await executionNow(d, d.db),
    d,
  );
  const heartbeat = startLeaseHeartbeat(
    () => refreshRecoveryAuthority(
      operationId,
      actor,
      authorization,
      keys,
      owner,
      index,
      d,
    ),
    heartbeatInterval(d),
  );
  try {
    await heartbeat.guard();
    const client = await d.getClient(state.loaded.operation.companyId);
    const actual = await client.fetchLineWriteSnapshot(
      prepared.qboType,
      prepared.qboId,
    );
    await heartbeat.guard();
    if (actual === null) {
      await heartbeat.stop();
      return markUncertain(
        d,
        state,
        index,
        actor,
        authorization,
        keys,
        owner,
        attribution,
      );
    }
    try {
      const verified = verifyLineWriteResult(prepared, actual);
      await finalizeVerified(
        d,
        state,
        index,
        actor,
        keys,
        owner,
        verified.snapshot,
        attribution,
      );
      await heartbeat.stop();
      return undefined;
    } catch {
      if (sameJson(actual, prepared.before)) {
        if (state.loaded.attempts[index].responseSnapshot !== null) {
          await heartbeat.stop();
          return markUncertain(
            d,
            state,
            index,
            actor,
            authorization,
            keys,
            owner,
            attribution,
          );
        }
        if (!startedQuiescent) {
          await heartbeat.stop();
          return operationDto(await loadAuthorizedOperation(
            operationId,
            actor,
            authorization,
            d,
            d.db,
          ));
        }
        await finalizeUnchanged(
          d,
          state,
          index,
          actor,
          keys,
          owner,
          actual,
          attribution,
        );
        await heartbeat.stop();
        return undefined;
      }
      await heartbeat.stop();
      return markUncertain(
        d,
        state,
        index,
        actor,
        authorization,
        keys,
        owner,
        attribution,
      );
    }
  } catch {
    const retainedOwnership = await heartbeat.stop();
    if (!retainedOwnership) {
      return operationDto(await loadAuthorizedOperation(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      ));
    }
    const durable = await loadRecoveryState(
      operationId,
      actor,
      authorization,
      d,
      d.db,
    );
    const durableStatus = attemptStatus(durable.loaded.attempts[index].status);
    if (durableStatus !== 'COMMITTING' && durableStatus !== 'UNCERTAIN') {
      return operationDto(durable.loaded);
    }
    return markUncertain(
      d,
      durable,
      index,
      actor,
      authorization,
      keys,
      owner,
      attribution,
    );
  } finally {
    await heartbeat.stop();
  }
}

async function reproveInheritedVerifiedLegs(
  client: QboClient,
  state: LoadedLocalState,
  sendingIndex: 0 | 1,
): Promise<void> {
  if (state.loaded.operation.retryOfId === null) return;
  for (const index of [0, 1] as const) {
    if (
      index === sendingIndex
      || attemptStatus(state.loaded.attempts[index].status) !== 'VERIFIED'
    ) {
      continue;
    }
    const expected = verifyLineWriteResult(
      state.loaded.prepared[index],
      state.loaded.attempts[index].responseSnapshot,
    ).snapshot;
    const current = await client.fetchLineWriteSnapshot(
      state.loaded.prepared[index].qboType,
      state.loaded.prepared[index].qboId,
    );
    if (current === null || !sameJson(current, expected)) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
  }
}

async function executePreparedLeg(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  attribution: McpMutationAuditAttribution | undefined,
  keys: readonly EntityLeaseKey[],
  owner: string,
  index: 0 | 1,
  initial: LoadedLocalState,
  d: TransferExecutionDeps,
): Promise<TransferOperationDto | undefined> {
  const prepared = initial.loaded.prepared[index];
  let client: QboClient;
  try {
    client = await d.getClient(initial.loaded.operation.companyId);
  } catch {
    await markPreparedRetryable(
      operationId,
      actor,
      authorization,
      keys,
      owner,
      index,
      'QBO_STATE_DRIFT',
      d,
    );
    return undefined;
  }
  await d.renewLease(keys, owner);
  let exactBefore: QboLineWriteSnapshot | null;
  try {
    exactBefore = await client.fetchLineWriteSnapshot(
      prepared.qboType,
      prepared.qboId,
    );
  } catch {
    exactBefore = null;
  }
  if (exactBefore === null || !sameJson(exactBefore, prepared.before)) {
    await markPreparedRetryable(
      operationId,
      actor,
      authorization,
      keys,
      owner,
      index,
      'QBO_STATE_DRIFT',
      d,
    );
    return undefined;
  }

  let entered;
  try {
    entered = await enterCommitting(
      operationId,
      actor,
      authorization,
      keys,
      owner,
      index,
      exactBefore,
      d,
    );
  } catch (error) {
    if (
      error instanceof TransferExecutionError
      && (
        error.code === 'QBO_STATE_DRIFT'
        || error.code === 'OPERATION_EXPIRED'
        || error.code === 'STALE_REVISION'
        || error.code === 'STALE_QBO_BINDING'
      )
    ) {
      await markPreparedRetryable(
        operationId,
        actor,
        authorization,
        keys,
        owner,
        index,
        error.code,
        d,
      );
      if (
        error.code === 'STALE_REVISION'
        || error.code === 'STALE_QBO_BINDING'
      ) {
        throw error;
      }
      return undefined;
    }
    throw error;
  }
  if (!entered.won) {
    return operationDto(entered.state.loaded);
  }

  const refreshAuthority = () => refreshCommittingAuthority(
    operationId,
    actor,
    authorization,
    keys,
    owner,
    index,
    d,
  );
  const refreshStrictAuthority = () => refreshCommittingAuthority(
    operationId,
    actor,
    authorization,
    keys,
    owner,
    index,
    d,
    true,
  );
  try {
    await refreshAuthority();
  } catch {
    return operationDto(await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      d.db,
    ));
  }
  const heartbeat = startLeaseHeartbeat(
    refreshAuthority,
    heartbeatInterval(d),
  );
  let postGuardPassed = false;
  let acceptedResponse: QboLineWriteSnapshot | undefined;
  try {
    const response = await client.sendPreparedLineWrite(prepared, async () => {
      await heartbeat.guard();
      const current = await client.fetchLineWriteSnapshot(
        prepared.qboType,
        prepared.qboId,
      );
      if (current === null || !sameJson(current, prepared.before)) {
        throw new TransferExecutionError('QBO_STATE_DRIFT');
      }
      await reproveInheritedVerifiedLegs(client, entered.state, index);
      await heartbeat.guard(refreshStrictAuthority);
      postGuardPassed = true;
    });
    acceptedResponse = verifyLineWriteResult(
      prepared,
      response.snapshot,
    ).snapshot;
    if (!await persistAcceptedResponse(
      d,
      entered.state,
      index,
      keys,
      owner,
      acceptedResponse,
    )) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    await heartbeat.guard();
    const readback = await client.fetchLineWriteSnapshot(
      prepared.qboType,
      prepared.qboId,
    );
    await heartbeat.guard();
    const verified = verifyLineWriteResult(prepared, readback);
    await finalizeVerified(
      d,
      entered.state,
      index,
      actor,
      keys,
      owner,
      verified.snapshot,
      attribution,
    );
    await heartbeat.stop();
    return undefined;
  } catch (error) {
    const retainedOwnership = await heartbeat.stop();
    if (!postGuardPassed) {
      if (error instanceof TransferDryRunRequired) {
        const dryRunIndices = entered.state.loaded.attempts.flatMap(
          (attempt, attemptIndex) => {
            const status = attemptStatus(attempt.status);
            return status === 'PREPARED' || attemptIndex === index
              ? [attemptIndex as 0 | 1]
              : [];
          },
        );
        const dryRunResult = await finalizeDryRun(
          operationId,
          actor,
          authorization,
          keys,
          owner,
          dryRunIndices,
          attribution,
          d,
          index,
        );
        if (dryRunResult === 'not-enabled') {
          await markClaimedAndPreparedRetryable(
            operationId,
            actor,
            authorization,
            keys,
            owner,
            index,
            'QBO_STATE_DRIFT',
            d,
          );
        }
        return operationDto(await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        ));
      }
      if (
        error instanceof TransferExecutionError
        && (
          error.code === 'OPERATION_EXPIRED'
          || error.code === 'STALE_REVISION'
          || error.code === 'STALE_QBO_BINDING'
          || error.code === 'QBO_STATE_DRIFT'
        )
      ) {
        await markClaimedAndPreparedRetryable(
          operationId,
          actor,
          authorization,
          keys,
          owner,
          index,
          error.code,
          d,
        );
        return operationDto(await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        ));
      }
      if (!retainedOwnership) {
        return operationDto(await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        ));
      }
      await markClaimedAndPreparedRetryable(
        operationId,
        actor,
        authorization,
        keys,
        owner,
        index,
        'QBO_STATE_DRIFT',
        d,
      );
      return operationDto(await loadAuthorizedOperation(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      ));
    }
    return markUncertain(
      d,
      entered.state,
      index,
      actor,
      authorization,
      keys,
      owner,
      attribution,
      acceptedResponse,
    );
  } finally {
    await heartbeat.stop();
  }
}

function isKnownExecutionError(
  error: unknown,
): error is TransferExecutionError | EntityLeaseError {
  return error instanceof TransferExecutionError
    || error instanceof EntityLeaseError;
}

function retryDto(
  retryOfId: string,
  loaded: LoadedOperation,
): RetryTransferOperationDto {
  return { retryOfId, ...operationDto(loaded) };
}

function retryableParentStatus(status: TransferAttemptStatus): boolean {
  return status === 'RETRYABLE' || status === 'UNCHANGED';
}

function exactTransferCents(
  value: number | string | { toString(): string },
): number {
  const text = typeof value === 'number' ? String(value) : value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(text);
  if (match === null) throw new TransferExecutionError('OPERATION_CONFLICT');
  const cents = (match[1] === '-' ? -1n : 1n)
    * (
      BigInt(match[2]!) * 100n
      + BigInt((match[3] ?? '').padEnd(2, '0'))
    );
  if (
    cents < BigInt(Number.MIN_SAFE_INTEGER)
    || cents > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
  return Number(cents);
}

function transactionDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TransferExecutionError('QBO_STATE_DRIFT');
  }
  return value.toISOString().slice(0, 10);
}

function holdingAccountIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim() !== ''
      )
    : [];
}

function assertRetryFreshEvidence(
  transaction: TransferExecutionTransaction,
  fresh: QboTxn | null,
  expectedSyncToken: string,
): asserts fresh is QboTxn {
  if (
    fresh === null
    || fresh.qboType !== transaction.qboType
    || fresh.qboId !== transaction.qboId
    || fresh.syncToken !== expectedSyncToken
    || fresh.date !== transactionDate(transaction.date)
    || fresh.bankAccount !== transaction.bankAccount
  ) {
    throw new TransferExecutionError('QBO_STATE_DRIFT');
  }
  let amountCents: number;
  try {
    amountCents = exactTransferCents(fresh.amount);
    if (amountCents !== exactTransferCents(transaction.amount)) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
    const holdingIds = holdingAccountIds(
      transaction.company.holdingAccountIds,
    );
    if (
      fresh.lines.length === 0
      || holdingIds.length === 0
      || fresh.lines.some((line) =>
        !holdingIds.includes(line.accountQboId)
      )
    ) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
    const lineCents = fresh.lines.reduce(
      (sum, line) => sum + exactTransferCents(line.amount),
      0,
    );
    if (Math.abs(lineCents) !== Math.abs(amountCents)) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
  } catch (error) {
    if (error instanceof TransferExecutionError) throw error;
    throw new TransferExecutionError('QBO_STATE_DRIFT');
  }
}

function assertRetryPair(
  transactions: readonly [
    TransferExecutionTransaction,
    TransferExecutionTransaction,
  ],
): void {
  const [first, second] = transactions;
  const firstCents = exactTransferCents(first.amount);
  const secondCents = exactTransferCents(second.amount);
  if (
    firstCents === 0
    || firstCents !== -secondCents
    || first.bankAccount === second.bankAccount
    || Math.abs(first.date.getTime() - second.date.getTime())
      > 3 * 24 * 60 * 60 * 1000
    || (
      first.qboType === second.qboType
      && first.qboId === second.qboId
    )
  ) {
    throw new TransferExecutionError('QBO_STATE_DRIFT');
  }
}

async function assertRetryTargetAccounts(
  state: LoadedLocalState,
  store: TransferExecutionDb,
): Promise<void> {
  const names = [
    state.transactions[1].bankAccount,
    state.transactions[0].bankAccount,
  ];
  const accounts = await store.qboAccount.findMany({
    where: {
      companyId: state.loaded.operation.companyId,
      name: { in: names },
      active: true,
    },
    select: { qboId: true, name: true, active: true },
  });
  const matches = names.map((name) => accounts.filter((account) =>
    account.active && account.name === name
  ));
  if (
    matches[0]?.length !== 1
    || matches[1]?.length !== 1
    || matches[0][0]!.qboId === matches[1][0]!.qboId
    || matches[0][0]!.qboId
      !== state.loaded.operation.firstTargetAccountQboId
    || matches[1][0]!.qboId
      !== state.loaded.operation.secondTargetAccountQboId
  ) {
    throw new TransferExecutionError('QBO_STATE_DRIFT');
  }
}

async function existingRetry(
  parentId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization,
  d: TransferExecutionDeps,
  store: TransferExecutionDb,
): Promise<RetryTransferOperationDto | null> {
  const existing = await store.qboTransferOperation.findFirst({
    where: { retryOfId: parentId },
  });
  if (existing === null || !isOperationRecord(existing)) return null;
  return retryDto(
    parentId,
    await loadAuthorizedOperation(
      existing.id,
      actor,
      authorization,
      d,
      store,
    ),
  );
}

interface PreparedRetryLeg {
  prepared: QboPreparedLineWrite;
  expectedRevision: number;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  targetAccountQboId: string;
  inherited: boolean;
}

function assertRetryParentStatuses(loaded: LoadedOperation): void {
  const statuses = loaded.attempts.map((attempt) =>
    attemptStatus(attempt.status)
  );
  if (
    !statuses.some(retryableParentStatus)
    || statuses.some((status) =>
      status !== 'VERIFIED' && !retryableParentStatus(status)
    )
  ) {
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
}

async function prepareRetryLegs(
  state: LoadedLocalState,
  operationId: string,
  client: QboClient,
  store: TransferExecutionDb,
): Promise<[PreparedRetryLeg, PreparedRetryLeg]> {
  assertRetryPair(state.transactions);
  await assertRetryTargetAccounts(state, store);
  const output: PreparedRetryLeg[] = [];
  for (const index of [0, 1] as const) {
    const attempt = state.loaded.attempts[index];
    const status = attemptStatus(attempt.status);
    const transaction = state.transactions[index];
    const prefix = index === 0 ? 'first' : 'second';
    const retryTargetAccountQboId =
      state.loaded.operation[`${prefix}TargetAccountQboId`];
    if (transaction.company.disconnectedAt !== null) {
      throw new TransferExecutionError('STALE_QBO_BINDING');
    }
    if (status === 'VERIFIED') {
      const verified = verifyLineWriteResult(
        state.loaded.prepared[index],
        attempt.responseSnapshot,
      );
      if (
        transaction.status !== 'POSTED'
        || transaction.revision !== attempt.expectedRevision
        || transaction.qboType !== state.loaded.prepared[index].qboType
        || transaction.qboId !== state.loaded.prepared[index].qboId
        || transaction.qboSyncToken !== verified.newSyncToken
      ) {
        throw new TransferExecutionError('STALE_QBO_BINDING');
      }
      const current = await client.fetchLineWriteSnapshot(
        state.loaded.prepared[index].qboType,
        state.loaded.prepared[index].qboId,
      );
      if (current === null || !sameJson(current, verified.snapshot)) {
        throw new TransferExecutionError('QBO_STATE_DRIFT');
      }
      output.push({
        prepared: state.loaded.prepared[index],
        expectedRevision: attempt.expectedRevision,
        qboType: state.loaded.prepared[index].qboType,
        qboId: state.loaded.prepared[index].qboId,
        qboSyncToken: attempt.expectedSyncToken,
        targetAccountQboId: retryTargetAccountQboId,
        inherited: true,
      });
      continue;
    }
    if (
      !retryableParentStatus(status)
      || transaction.status !== 'PENDING'
    ) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    const fresh = await client.fetchTxn(
      state.loaded.prepared[index].qboType,
      state.loaded.prepared[index].qboId,
    );
    assertRetryFreshEvidence(
      transaction,
      fresh,
      transaction.qboSyncToken,
    );
    const requestId = `${operationId}-t${index}`;
    const splits = [{
      amount: fresh.amount,
      accountQboId: retryTargetAccountQboId,
      ...(transaction.memo === null ? {} : { memo: transaction.memo }),
    }];
    const candidate = await client.prepareLineRecategorization(
      fresh,
      splits,
      requestId,
    );
    let prepared: QboPreparedLineWrite;
    try {
      prepared = validatePreparedLineTransformation(
        validatePreparedLineWrite(candidate),
        {
          txn: fresh,
          splits,
          requestId,
          holdingAccountQboIds: holdingAccountIds(
            transaction.company.holdingAccountIds,
          ),
        },
      );
    } catch {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
    const freshSnapshot: QboLineWriteSnapshot = {
      qboType: fresh.qboType,
      qboId: fresh.qboId,
      syncToken: fresh.syncToken,
      contentHash: hashLineWriteContent(fresh.raw),
    };
    if (
      prepared.requestId !== requestId
      || prepared.qboType !== fresh.qboType
      || prepared.qboId !== fresh.qboId
      || !sameJson(prepared.before, freshSnapshot)
      || targetAccountQboId(
        prepared,
        retryTargetAccountQboId,
      ) !== retryTargetAccountQboId
    ) {
      throw new TransferExecutionError('QBO_STATE_DRIFT');
    }
    output.push({
      prepared,
      expectedRevision: transaction.revision,
      qboType: fresh.qboType,
      qboId: fresh.qboId,
      qboSyncToken: fresh.syncToken,
      targetAccountQboId: retryTargetAccountQboId,
      inherited: false,
    });
  }
  return output as [PreparedRetryLeg, PreparedRetryLeg];
}

function retryOperationRecord(
  parent: TransferOperationRecord,
  legs: [PreparedRetryLeg, PreparedRetryLeg],
  operationId: string,
  now: Date,
): TransferOperationRecord {
  const [first, second] = legs;
  return {
    id: operationId,
    actorId: parent.actorId,
    companyId: parent.companyId,
    firstTransactionId: parent.firstTransactionId,
    secondTransactionId: parent.secondTransactionId,
    firstExpectedRevision: first.expectedRevision,
    secondExpectedRevision: second.expectedRevision,
    firstQboType: first.qboType,
    firstQboId: first.qboId,
    firstQboSyncToken: first.qboSyncToken,
    firstTargetAccountQboId: first.targetAccountQboId,
    firstAttemptRequestId: first.prepared.requestId,
    secondQboType: second.qboType,
    secondQboId: second.qboId,
    secondQboSyncToken: second.qboSyncToken,
    secondTargetAccountQboId: second.targetAccountQboId,
    secondAttemptRequestId: second.prepared.requestId,
    idempotencyHash: hashCanonical({
      kind: 'transfer-retry',
      retryOfId: parent.id,
    }),
    inputHash: hashCanonical({
      parentInputHash: parent.inputHash,
      retryOfId: parent.id,
    }),
    preparedHash: hashCanonical([
      preparedDigestValue(
        parent.firstTransactionId,
        first.expectedRevision,
        first.targetAccountQboId,
        first.prepared,
      ),
      preparedDigestValue(
        parent.secondTransactionId,
        second.expectedRevision,
        second.targetAccountQboId,
        second.prepared,
      ),
    ]),
    expiresAt: new Date(now.getTime() + TRANSFER_OPERATION_EXPIRY_MS),
    retryOfId: parent.id,
    createdAt: now,
  };
}

function retryAttemptData(
  parent: LoadedOperation,
  legs: [PreparedRetryLeg, PreparedRetryLeg],
): Record<string, unknown>[] {
  return legs.flatMap((leg, index) => {
    if (leg.inherited) return [];
    return [{
      transactionId: index === 0
        ? parent.operation.firstTransactionId
        : parent.operation.secondTransactionId,
      requestId: leg.prepared.requestId,
      operation: 'transfer',
      status: 'PREPARED',
      expectedRevision: leg.expectedRevision,
      expectedSyncToken: leg.prepared.before.syncToken,
      requestHash: leg.prepared.requestHash,
      requestPayload: leg.prepared,
      beforeSnapshot: leg.prepared.before,
    }];
  });
}

export async function retryTransferOperation(
  parentOperationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  deps?: TransferExecutionDeps,
): Promise<RetryTransferOperationDto> {
  return retryTransferOperationWithWorkflow(parentOperationId, actor, {
    afterRetry: async (_store, receipt) => receipt.retry,
  }, authorization, deps);
}

export interface TransferRetryReceipt {
  parent: TransferOperationRecord;
  operation: TransferOperationRecord;
  retry: RetryTransferOperationDto;
}

export type TransferRetryDecision<T> =
  | { kind: 'continue' }
  | { kind: 'return'; value: T };

export interface TransferRetryWorkflow<T> {
  beforeValidation?(
    store: TransferExecutionDb,
    parent: TransferOperationRecord,
  ): Promise<TransferRetryDecision<T>>;
  afterRetry(
    store: TransferExecutionDb,
    receipt: TransferRetryReceipt,
  ): Promise<T>;
}

export async function retryTransferOperationWithWorkflow<T>(
  parentOperationId: string,
  actor: Actor,
  workflow: TransferRetryWorkflow<T>,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  deps?: TransferExecutionDeps,
): Promise<T> {
  try {
    const d = deps ?? await defaultExecutionDeps();
    const parent = await loadAuthorizedOperation(
      parentOperationId,
      actor,
      authorization,
      d,
      d.db,
    );
    if (parent.operation.retryOfId !== null) {
      throw new TransferExecutionError('OPERATION_CONFLICT');
    }
    if (workflow.beforeValidation !== undefined) {
      const decision = await d.db.$transaction((tx) =>
        workflow.beforeValidation!(tx, parent.operation)
      );
      if (decision.kind === 'return') return decision.value;
    }
    const replay = await existingRetry(
      parent.operation.id,
      actor,
      authorization,
      d,
      d.db,
    );
    if (replay !== null) {
      return d.db.$transaction(async (tx) => {
        const loaded = await loadAuthorizedOperation(
          replay.operationId,
          actor,
          authorization,
          d,
          tx,
        );
        return workflow.afterRetry(tx, {
          parent: parent.operation,
          operation: loaded.operation,
          retry: retryDto(parent.operation.id, loaded),
        });
      });
    }
    assertRetryParentStatuses(parent);
    const keys = canonicalLeaseKeys(parent.operation);
    const owner = boundedIdentifier(d.invocationId());
    return await d.lease(keys, owner, async () => {
      const fencedParent = await d.db.$transaction(async (tx) => {
        await d.fence(keys, owner, tx);
        const current = await loadRecoveryState(
          parent.operation.id,
          actor,
          authorization,
          d,
          tx,
        );
        assertRetryParentStatuses(current.loaded);
        return current;
      });
      const insideReplay = await existingRetry(
        parent.operation.id,
        actor,
        authorization,
        d,
        d.db,
      );
      if (insideReplay !== null) {
        return d.db.$transaction(async (tx) => {
          const loaded = await loadAuthorizedOperation(
            insideReplay.operationId,
            actor,
            authorization,
            d,
            tx,
          );
          return workflow.afterRetry(tx, {
            parent: parent.operation,
            operation: loaded.operation,
            retry: retryDto(parent.operation.id, loaded),
          });
        });
      }

      const operationId = boundedIdentifier(
        d.operationId?.() ?? randomUUID(),
      );
      if (operationId.length > MAX_OPERATION_ID_LENGTH) {
        throw new TransferExecutionError('INVALID_INPUT');
      }
      const client = await d.getClient(parent.operation.companyId);
      const legs = await prepareRetryLegs(
        fencedParent,
        operationId,
        client,
        d.db,
      );
      const now = await executionNow(d, d.db);
      const child = retryOperationRecord(
        parent.operation,
        legs,
        operationId,
        now,
      );
      const attempts = retryAttemptData(parent, legs);
      return d.db.$transaction(async (tx) => {
        await d.fence(keys, owner, tx);
        const current = await loadRecoveryState(
          parent.operation.id,
          actor,
          authorization,
          d,
          tx,
        );
        assertRetryParentStatuses(current.loaded);
        for (const index of [0, 1] as const) {
          if (
            current.loaded.attempts[index].id
              !== fencedParent.loaded.attempts[index].id
            || current.loaded.attempts[index].status
              !== fencedParent.loaded.attempts[index].status
            || current.transactions[index].revision
              !== fencedParent.transactions[index].revision
            || current.transactions[index].qboSyncToken
              !== fencedParent.transactions[index].qboSyncToken
            || current.transactions[index].status
              !== fencedParent.transactions[index].status
          ) {
            throw new TransferExecutionError('OPERATION_CONFLICT');
          }
        }
        const existing = await tx.qboTransferOperation.findFirst({
          where: { retryOfId: parent.operation.id },
        });
        if (existing !== null) {
          if (!isOperationRecord(existing)) {
            throw new TransferExecutionError('OPERATION_CONFLICT');
          }
          const loaded = await loadAuthorizedOperation(
            existing.id,
            actor,
            authorization,
            d,
            tx,
          );
          return workflow.afterRetry(tx, {
            parent: parent.operation,
            operation: loaded.operation,
            retry: retryDto(parent.operation.id, loaded),
          });
        }
        if (
          tx.qboTransferOperation.createMany === undefined
          || tx.qboMutationAttempt.createMany === undefined
        ) {
          throw new TransferExecutionError('OPERATION_CONFLICT');
        }
        const inserted = await tx.qboTransferOperation.createMany({
          data: child,
          skipDuplicates: true,
        });
        if (inserted.count === 1) {
          const attemptInsert = await tx.qboMutationAttempt.createMany({
            data: attempts,
            skipDuplicates: true,
          });
          if (attemptInsert.count !== attempts.length) {
            throw new TransferExecutionError('OPERATION_CONFLICT');
          }
          const loaded = await loadAuthorizedOperation(
            child.id,
            actor,
            authorization,
            d,
            tx,
          );
          return workflow.afterRetry(tx, {
            parent: parent.operation,
            operation: loaded.operation,
            retry: retryDto(parent.operation.id, loaded),
          });
        }
        const concurrent = await tx.qboTransferOperation.findFirst({
          where: { retryOfId: parent.operation.id },
        });
        if (concurrent === null || !isOperationRecord(concurrent)) {
          throw new TransferExecutionError('OPERATION_CONFLICT');
        }
        const loaded = await loadAuthorizedOperation(
          concurrent.id,
          actor,
          authorization,
          d,
          tx,
        );
        return workflow.afterRetry(tx, {
          parent: parent.operation,
          operation: loaded.operation,
          retry: retryDto(parent.operation.id, loaded),
        });
      });
    });
  } catch (error) {
    if (isKnownExecutionError(error)) throw error;
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
}

export async function getTransferOperation(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  deps?: TransferExecutionDeps,
): Promise<TransferOperationDto> {
  try {
    const d = deps ?? await defaultExecutionDeps();
    return operationDto(
      await loadAuthorizedOperation(operationId, actor, authorization, d, d.db),
    );
  } catch (error) {
    if (isKnownExecutionError(error)) throw error;
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
}

export async function commitTransfer(
  operationId: string,
  actor: Actor,
  authorization: DurableMutationAuthorization = { kind: 'user' },
  auditAttribution?: McpMutationAuditAttribution,
  deps?: TransferExecutionDeps,
): Promise<TransferOperationDto> {
  try {
    const d = deps ?? await defaultExecutionDeps();
    const initial = await loadAuthorizedOperation(
      operationId,
      actor,
      authorization,
      d,
      d.db,
    );
    const keys = canonicalLeaseKeys(initial.operation);
    const owner = boundedIdentifier(d.invocationId());
    return await d.lease(keys, owner, async () => {
      let loaded = await loadAuthorizedOperation(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      );
      const now = await executionNow(d, d.db);
      if (
        loaded.operation.expiresAt.getTime() <= now.getTime()
        && loaded.attempts.some((attempt) =>
          attemptStatus(attempt.status) === 'PREPARED'
        )
      ) {
        await expirePreparedAttempts(
          operationId,
          actor,
          authorization,
          keys,
          owner,
          d,
        );
        loaded = await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        );
      }

      const loadedStatuses = loaded.attempts.map((attempt) =>
        attemptStatus(attempt.status)
      );
      if (!loadedStatuses.some((status) =>
        status === 'PREPARED'
        || status === 'COMMITTING'
        || status === 'UNCERTAIN'
      )) {
        return operationDto(loaded);
      }

      if (loadedStatuses.every((status) => status === 'PREPARED')) {
        const preparedState = await loadPreparedState(
          operationId,
          actor,
          authorization,
          keys,
          owner,
          d,
        );
        if (preparedState.kind === 'terminal') return preparedState.dto;
        const dryRun = preparedState.state.transactions.some((transaction) =>
          transaction.company.dryRun
        ) || d.envDryRun;
        if (dryRun) {
          const dryRunResult = await finalizeDryRun(
            operationId,
            actor,
            authorization,
            keys,
            owner,
            [0, 1],
            auditAttribution,
            d,
          );
          if (dryRunResult !== 'not-enabled') {
            return operationDto(await loadAuthorizedOperation(
              operationId,
              actor,
              authorization,
              d,
              d.db,
            ));
          }
        }
      }

      for (const index of [0, 1] as const) {
        loaded = await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        );
        const status = attemptStatus(loaded.attempts[index].status);
        if (status === 'VERIFIED' || status === 'DRY_RUN') continue;
        let immediate: TransferOperationDto | undefined;
        if (status === 'COMMITTING' || status === 'UNCERTAIN') {
          immediate = await reconcileLeg(
            operationId,
            actor,
            authorization,
            auditAttribution,
            keys,
            owner,
            index,
            d,
          );
        } else if (status === 'PREPARED') {
          const preparedState = await loadPreparedState(
            operationId,
            actor,
            authorization,
            keys,
            owner,
            d,
          );
          if (preparedState.kind === 'terminal') return preparedState.dto;
          const dryRun = preparedState.state.transactions.some((transaction) =>
            transaction.company.dryRun
          ) || d.envDryRun;
          if (dryRun) {
            const dryRunResult = await finalizeDryRun(
              operationId,
              actor,
              authorization,
              keys,
              owner,
              [index],
              auditAttribution,
              d,
            );
            if (dryRunResult === 'not-enabled') {
              immediate = await executePreparedLeg(
                operationId,
                actor,
                authorization,
                auditAttribution,
                keys,
                owner,
                index,
                preparedState.state,
                d,
              );
            }
          } else {
            immediate = await executePreparedLeg(
              operationId,
              actor,
              authorization,
              auditAttribution,
              keys,
              owner,
              index,
              preparedState.state,
              d,
            );
          }
        } else {
          return operationDto(loaded);
        }
        if (immediate !== undefined) return immediate;

        loaded = await loadAuthorizedOperation(
          operationId,
          actor,
          authorization,
          d,
          d.db,
        );
        const completedStatus = attemptStatus(
          loaded.attempts[index].status,
        );
        if (
          completedStatus !== 'VERIFIED'
          && completedStatus !== 'DRY_RUN'
        ) {
          return operationDto(loaded);
        }
      }
      return operationDto(await loadAuthorizedOperation(
        operationId,
        actor,
        authorization,
        d,
        d.db,
      ));
    });
  } catch (error) {
    if (isKnownExecutionError(error)) throw error;
    throw new TransferExecutionError('OPERATION_CONFLICT');
  }
}
