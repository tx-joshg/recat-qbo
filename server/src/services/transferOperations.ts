import { createHash, randomUUID } from 'node:crypto';
import type {
  QboClient,
  QboPreparedLineWrite,
  QboTxn,
} from '../lib/qbo/types.js';
import {
  validatePreparedLineTransformation,
  validatePreparedLineWrite,
} from '../lib/qbo/lineWrite.js';
import { prisma } from '../lib/prisma.js';
import {
  fenceEntityLeaseOwnerships,
  withEntityLeases,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';
import type {
  Actor,
  DurableMutationAuthorization,
} from './writeback.js';

const TRANSFER_OPERATION_EXPIRY_MS = 15 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_OPERATION_ID_LENGTH = 128 - '-t0'.length;
const MAX_QBO_TYPE_LENGTH = 32;
const MAX_PRISMA_INT = 2_147_483_647;
const ACTIVE_ATTEMPT_STATUSES = ['PREPARED', 'COMMITTING', 'UNCERTAIN'];
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export interface PrepareTransferInput {
  companyId: string;
  transactionId: string;
  counterpartTransactionId: string;
  expectedRevision: number;
  counterpartExpectedRevision: number;
  idempotencyKey: string;
  actor: Actor;
  authorization?: DurableMutationAuthorization;
}

export interface PreparedTransferDto {
  operationId: string;
  state: 'PREPARED';
  expiresAt: string;
  preview: {
    action: 'record_transfer';
    direction: 'between_accounts';
    totalCents: number;
    legCount: 2;
    preparationDigest: string;
  };
}

export interface TransferPreparationReceipt {
  operation: TransferOperationRecord;
  prepared: PreparedTransferDto;
}

export type TransferPreparationDecision<T> =
  | { kind: 'continue' }
  | { kind: 'return'; value: T };

export interface TransferPreparationWorkflow<T> {
  beforeValidation?(
    store: TransferOperationDb,
  ): Promise<TransferPreparationDecision<T>>;
  afterPrepare(
    store: TransferOperationDb,
    receipt: TransferPreparationReceipt,
  ): Promise<T>;
}

interface TransferTransaction {
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
  date: Date;
  company: {
    id: string;
    disconnectedAt: Date | null;
    holdingAccountIds: unknown;
  };
}

interface TransferAccount {
  qboId: string;
  name: string;
  active: boolean;
}

interface TransferAttempt {
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
}

interface TransferAttemptCreate {
  transactionId: string;
  requestId: string;
  operation: 'transfer';
  status: 'PREPARED';
  expectedRevision: number;
  expectedSyncToken: string;
  requestHash: string;
  requestPayload: QboPreparedLineWrite;
  beforeSnapshot: QboPreparedLineWrite['before'];
}

export interface TransferOperationRecord {
  id: string;
  actorId: string;
  companyId: string;
  firstTransactionId: string;
  secondTransactionId: string;
  firstExpectedRevision: number;
  secondExpectedRevision: number;
  firstQboType: string;
  firstQboId: string;
  firstQboSyncToken: string;
  firstTargetAccountQboId: string;
  firstAttemptRequestId: string;
  secondQboType: string;
  secondQboId: string;
  secondQboSyncToken: string;
  secondTargetAccountQboId: string;
  secondAttemptRequestId: string;
  idempotencyHash: string;
  inputHash: string;
  preparedHash: string;
  expiresAt: Date;
  retryOfId: string | null;
  createdAt: Date;
}

interface TransferOperationInsert
  extends Omit<TransferOperationRecord, 'createdAt'> {}

interface ReplayPair {
  firstTransactionId: string;
  secondTransactionId: string;
}

interface TransferOperationWhere {
  id?: string;
  actorId?: string;
  companyId?: string;
  idempotencyHash?: string;
  OR?: ReplayPair[];
}

export interface TransferOperationDb {
  transaction: {
    findUnique(args: {
      where: { id: string };
      include: { company: true };
    }): Promise<TransferTransaction | null>;
  };
  qboAccount: {
    findMany(args: {
      where: {
        companyId: string;
        name: { in: string[] };
        active: true;
      };
      select: { qboId: true; name: true; active: true };
    }): Promise<TransferAccount[]>;
  };
  qboMutationAttempt: {
    findFirst(args: {
      where: {
        transactionId?: string;
        requestId?: string;
        status?: string | { in: string[] };
      };
    }): Promise<TransferAttempt | null>;
    findMany(args: {
      where: { requestId: { in: string[] } };
    }): Promise<TransferAttempt[]>;
    createMany(args: {
      data: TransferAttemptCreate[];
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  qboTransferOperation: {
    findFirst(args: {
      where: TransferOperationWhere;
    }): Promise<TransferOperationRecord | null>;
    createMany(args: {
      data: TransferOperationInsert;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  $transaction<T>(
    callback: (tx: TransferOperationDb) => Promise<T>,
  ): Promise<T>;
}

export interface TransferOperationDeps {
  db: TransferOperationDb;
  getClient(companyId: string): Promise<QboClient>;
  authorize(
    actorId: string | null,
    companyId: string,
    authorization: DurableMutationAuthorization,
    store: TransferOperationDb,
  ): Promise<boolean>;
  lease<T>(
    keys: readonly EntityLeaseKey[],
    owner: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  fence(
    keys: readonly EntityLeaseKey[],
    owner: string,
    tx: TransferOperationDb,
  ): Promise<void>;
  invocationId(): string;
  operationId(): string;
  now(): Date;
}

export type TransferOperationErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'TRANSACTION_NOT_FOUND'
  | 'COMPANY_DISCONNECTED'
  | 'INVALID_TRANSFER_PAIR'
  | 'STALE_REVISION'
  | 'INVALID_STATUS'
  | 'TARGET_ACCOUNT_INVALID'
  | 'ACTIVE_ATTEMPT'
  | 'STALE_QBO_BINDING'
  | 'STALE_QBO_AMOUNT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_CONFLICT';

const ERROR_MESSAGES: Readonly<Record<TransferOperationErrorCode, string>> = {
  INVALID_INPUT: 'Invalid transfer preparation input.',
  FORBIDDEN: 'You do not have permission to prepare this transfer.',
  TRANSACTION_NOT_FOUND: 'Transfer transaction was not found for this company.',
  COMPANY_DISCONNECTED: 'This company is disconnected from QuickBooks.',
  INVALID_TRANSFER_PAIR: 'These transactions are not a valid transfer pair.',
  STALE_REVISION: 'A transfer transaction changed. Reload before preparing.',
  INVALID_STATUS: 'Both transfer transactions must be pending.',
  TARGET_ACCOUNT_INVALID: 'A counterpart bank account is missing or ambiguous.',
  ACTIVE_ATTEMPT: 'Another durable write is active for a transfer transaction.',
  STALE_QBO_BINDING: 'A transfer transaction QuickBooks binding changed.',
  STALE_QBO_AMOUNT: 'A transfer transaction amount changed in QuickBooks.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key conflicts with another transfer.',
  OPERATION_CONFLICT: 'The transfer preparation changed concurrently.',
};

export class TransferOperationError extends Error {
  constructor(readonly code: TransferOperationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TransferOperationError';
  }
}

interface NormalizedInput {
  actorId: string;
  companyId: string;
  transactionId: string;
  counterpartTransactionId: string;
  expectedRevision: number;
  counterpartExpectedRevision: number;
  idempotencyHash: string;
  inputHash: string;
  authorization: DurableMutationAuthorization;
}

interface PreparedLeg {
  transaction: TransferTransaction;
  expectedRevision: number;
  targetAccountQboId: string;
  fresh: QboTxn;
  prepared: QboPreparedLineWrite;
}

interface ExpectedPreparation {
  input: NormalizedInput;
  legs: [PreparedLeg, PreparedLeg];
  preparedHash: string;
}

type CanonicalTransferLeg = {
  transaction: TransferTransaction;
  expectedRevision: number;
};

interface FencedPreparationState {
  legs: [CanonicalTransferLeg, CanonicalTransferLeg];
  targets: [TransferAccount, TransferAccount];
}

type FencedPreparationResult =
  | { kind: 'replay'; dto: PreparedTransferDto }
  | { kind: 'continue'; state: FencedPreparationState };

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

export async function prepareTransfer(
  input: PrepareTransferInput,
  dependencies?: TransferOperationDeps,
): Promise<PreparedTransferDto> {
  return prepareTransferWithWorkflow(input, {
    afterPrepare: async (_store, receipt) => receipt.prepared,
  }, dependencies);
}

export async function prepareTransferWithWorkflow<T>(
  input: PrepareTransferInput,
  workflow: TransferPreparationWorkflow<T>,
  dependencies?: TransferOperationDeps,
): Promise<T> {
  const d = dependencies ?? await defaultDeps();
  const normalized = normalizeInput(input);

  await assertAuthorized(d, normalized, d.db);
  if (workflow.beforeValidation !== undefined) {
    const decision = await d.db.$transaction(async (tx) => {
      await assertAuthorized(d, normalized, tx);
      return workflow.beforeValidation!(tx);
    });
    if (decision.kind === 'return') return decision.value;
  }
  const replay = await findReplay(d.db, normalized);
  if (replay !== null) {
    return d.db.$transaction(async (tx) => {
      const persisted = await findReplay(tx, normalized);
      if (persisted === null) {
        throw new TransferOperationError('OPERATION_CONFLICT');
      }
      return workflow.afterPrepare(tx, {
        operation: persisted,
        prepared: await loadReplayDto(tx, persisted, normalized),
      });
    });
  }

  const initiallyLoaded = await loadPair(d.db, normalized);
  const initialLegs = canonicalLegs(initiallyLoaded, normalized);
  const keys = initialLegs.map(entityKey);
  const owner = boundedIdentifier(d.invocationId());

  return d.lease(keys, owner, async () => {
    const preflight = await d.db.$transaction((tx) =>
      loadFencedPreparationState(tx, d, normalized, keys, owner)
    );
    if (preflight.kind === 'replay') {
      return d.db.$transaction(async (tx) => {
        const persisted = await findReplay(tx, normalized);
        if (persisted === null) {
          throw new TransferOperationError('OPERATION_CONFLICT');
        }
        return workflow.afterPrepare(tx, {
          operation: persisted,
          prepared: await loadReplayDto(tx, persisted, normalized),
        });
      });
    }

    const operationId = boundedText(d.operationId(), MAX_OPERATION_ID_LENGTH);
    const expiresAt = expiryAt(d.now());
    const client = await d.getClient(normalized.companyId);
    const prepared = await prepareLegs(
      client,
      preflight.state.legs,
      preflight.state.targets,
      operationId,
    );
    const expected: ExpectedPreparation = {
      input: normalized,
      legs: prepared,
      preparedHash: hashPreparedLegs(prepared),
    };
    const data = operationData(expected, operationId, expiresAt);

    return d.db.$transaction(async (tx) => {
      const finalState = await loadFencedPreparationState(
        tx,
        d,
        normalized,
        keys,
        owner,
      );
      if (finalState.kind === 'replay') {
        const persisted = await findReplay(tx, normalized);
        if (persisted === null) {
          throw new TransferOperationError('OPERATION_CONFLICT');
        }
        return workflow.afterPrepare(tx, {
          operation: persisted,
          prepared: finalState.dto,
        });
      }
      assertPreparedStateStillCurrent(expected, finalState.state);

      const inserted = await tx.qboTransferOperation.createMany({
        data,
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        const attempts = attemptData(expected);
        const attemptInsert = await tx.qboMutationAttempt.createMany({
          data: attempts,
          skipDuplicates: true,
        });
        if (attemptInsert.count !== 2) {
          throw new TransferOperationError('OPERATION_CONFLICT');
        }
      }

      const persisted = inserted.count === 1
        ? await tx.qboTransferOperation.findFirst({ where: { id: operationId } })
        : await findReplay(tx, normalized);
      if (persisted === null) throw new TransferOperationError('OPERATION_CONFLICT');
      assertExpectedCoordinator(persisted, expected);
      return workflow.afterPrepare(tx, {
        operation: persisted,
        prepared: await loadReplayDto(tx, persisted, normalized, expected),
      });
    });
  });
}

async function loadFencedPreparationState(
  tx: TransferOperationDb,
  d: TransferOperationDeps,
  input: NormalizedInput,
  keys: EntityLeaseKey[],
  owner: string,
): Promise<FencedPreparationResult> {
  await d.fence(keys, owner, tx);
  await assertAuthorized(d, input, tx);

  const replay = await findReplay(tx, input);
  if (replay !== null) {
    return {
      kind: 'replay',
      dto: await loadReplayDto(tx, replay, input),
    };
  }

  const loaded = await loadPair(tx, input);
  const legs = canonicalLegs(loaded, input);
  assertSameLeaseKeys(keys, legs.map(entityKey));
  validatePair(legs);
  await assertNoActiveAttempts(tx, legs);
  const targets = await resolveTargetAccounts(tx, input.companyId, legs);
  return { kind: 'continue', state: { legs, targets } };
}

function assertPreparedStateStillCurrent(
  expected: ExpectedPreparation,
  current: FencedPreparationState,
): void {
  for (const [index, leg] of current.legs.entries()) {
    const prepared = expected.legs[index]!;
    if (
      leg.transaction.id !== prepared.transaction.id
      || leg.expectedRevision !== prepared.expectedRevision
      || leg.transaction.qboType !== prepared.fresh.qboType
      || leg.transaction.qboId !== prepared.fresh.qboId
      || leg.transaction.qboSyncToken !== prepared.fresh.syncToken
      || !sameHoldingAccountIds(
        leg.transaction.company.holdingAccountIds,
        prepared.transaction.company.holdingAccountIds,
      )
    ) {
      throw new TransferOperationError('STALE_QBO_BINDING');
    }
    if (
      exactCents(leg.transaction.amount)
        !== exactCents(prepared.transaction.amount)
      || leg.transaction.bankAccount !== prepared.transaction.bankAccount
      || leg.transaction.date.getTime() !== prepared.transaction.date.getTime()
      || leg.transaction.memo !== prepared.transaction.memo
    ) {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
    if (
      current.targets[index]!.qboId !== prepared.targetAccountQboId
    ) {
      throw new TransferOperationError('TARGET_ACCOUNT_INVALID');
    }
  }
}

async function defaultDeps(): Promise<TransferOperationDeps> {
  return {
    db: prisma as unknown as TransferOperationDb,
    getClient: async (companyId) => {
      const { qboFactory } = await import('../lib/qbo/factory.js');
      return qboFactory.forCompany(companyId);
    },
    authorize: defaultAuthorize,
    lease: (keys, owner, callback) =>
      withEntityLeases(keys, owner, callback, {
        db: prisma as unknown as EntityLeaseDb,
      }),
    fence: (keys, owner, tx) =>
      fenceEntityLeaseOwnerships(keys, owner, {
        db: tx as unknown as EntityLeaseFenceDb,
      }),
    invocationId: randomUUID,
    operationId: randomUUID,
    now: () => new Date(),
  };
}

async function defaultAuthorize(
  actorId: string | null,
  companyId: string,
  authorization: DurableMutationAuthorization,
  rawStore: TransferOperationDb,
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

async function assertAuthorized(
  d: TransferOperationDeps,
  input: NormalizedInput,
  store: TransferOperationDb,
): Promise<void> {
  if (!await d.authorize(input.actorId, input.companyId, input.authorization, store)) {
    throw new TransferOperationError('FORBIDDEN');
  }
}

function normalizeInput(input: PrepareTransferInput): NormalizedInput {
  const actorId = boundedIdentifier(input.actor?.id);
  const companyId = boundedIdentifier(input.companyId);
  const transactionId = boundedIdentifier(input.transactionId);
  const counterpartTransactionId = boundedIdentifier(input.counterpartTransactionId);
  if (transactionId === counterpartTransactionId) invalidInput('INVALID_TRANSFER_PAIR');
  const expectedRevision = boundedRevision(input.expectedRevision);
  const counterpartExpectedRevision = boundedRevision(input.counterpartExpectedRevision);
  const idempotencyKey = boundedText(input.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  const idempotencyHash = hashCanonical(idempotencyKey);
  const revisionByTransactionId = [
    { transactionId, expectedRevision },
    {
      transactionId: counterpartTransactionId,
      expectedRevision: counterpartExpectedRevision,
    },
  ].sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  return {
    actorId,
    companyId,
    transactionId,
    counterpartTransactionId,
    expectedRevision,
    counterpartExpectedRevision,
    idempotencyHash,
    inputHash: hashCanonical({
      actorId,
      companyId,
      idempotencyHash,
      legs: revisionByTransactionId,
    }),
    authorization: input.authorization ?? { kind: 'user' },
  };
}

async function loadPair(
  store: TransferOperationDb,
  input: NormalizedInput,
): Promise<[TransferTransaction, TransferTransaction]> {
  const [first, second] = await Promise.all([
    store.transaction.findUnique({
      where: { id: input.transactionId },
      include: { company: true },
    }),
    store.transaction.findUnique({
      where: { id: input.counterpartTransactionId },
      include: { company: true },
    }),
  ]);
  if (
    first === null
    || second === null
    || first.companyId !== input.companyId
    || second.companyId !== input.companyId
  ) {
    throw new TransferOperationError('TRANSACTION_NOT_FOUND');
  }
  return [first, second];
}

function canonicalLegs(
  pair: [TransferTransaction, TransferTransaction],
  input: NormalizedInput,
): [
  { transaction: TransferTransaction; expectedRevision: number },
  { transaction: TransferTransaction; expectedRevision: number },
] {
  const expected = new Map([
    [input.transactionId, input.expectedRevision],
    [input.counterpartTransactionId, input.counterpartExpectedRevision],
  ]);
  const legs = pair.map((transaction) => ({
    transaction,
    expectedRevision: expected.get(transaction.id)!,
  })).sort((left, right) => compareLegs(left.transaction, right.transaction));
  return legs as [
    { transaction: TransferTransaction; expectedRevision: number },
    { transaction: TransferTransaction; expectedRevision: number },
  ];
}

function compareLegs(
  left: TransferTransaction,
  right: TransferTransaction,
): number {
  for (const field of ['companyId', 'qboType', 'qboId', 'id'] as const) {
    const comparison = left[field].localeCompare(right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function entityKey(
  leg: { transaction: TransferTransaction },
): EntityLeaseKey {
  return {
    companyId: leg.transaction.companyId,
    qboType: leg.transaction.qboType,
    qboId: leg.transaction.qboId,
  };
}

function assertSameLeaseKeys(
  expected: EntityLeaseKey[],
  actual: EntityLeaseKey[],
): void {
  if (
    expected.length !== actual.length
    || expected.some((key, index) =>
      key.companyId !== actual[index]?.companyId
      || key.qboType !== actual[index]?.qboType
      || key.qboId !== actual[index]?.qboId
    )
  ) {
    throw new TransferOperationError('STALE_QBO_BINDING');
  }
}

function validatePair(
  legs: [
    { transaction: TransferTransaction; expectedRevision: number },
    { transaction: TransferTransaction; expectedRevision: number },
  ],
): void {
  const [first, second] = legs;
  if (
    first.transaction.company.disconnectedAt !== null
    || second.transaction.company.disconnectedAt !== null
  ) {
    throw new TransferOperationError('COMPANY_DISCONNECTED');
  }
  if (
    first.transaction.revision !== first.expectedRevision
    || second.transaction.revision !== second.expectedRevision
  ) {
    throw new TransferOperationError('STALE_REVISION');
  }
  if (
    first.transaction.status !== 'PENDING'
    || second.transaction.status !== 'PENDING'
  ) {
    throw new TransferOperationError('INVALID_STATUS');
  }
  const firstCents = exactCents(first.transaction.amount);
  const secondCents = exactCents(second.transaction.amount);
  if (
    firstCents === 0
    || firstCents !== -secondCents
    || first.transaction.bankAccount === second.transaction.bankAccount
    || Math.abs(
      first.transaction.date.getTime() - second.transaction.date.getTime(),
    ) > 3 * 24 * 60 * 60 * 1000
    || first.transaction.qboType === second.transaction.qboType
      && first.transaction.qboId === second.transaction.qboId
  ) {
    throw new TransferOperationError('INVALID_TRANSFER_PAIR');
  }
}

async function assertNoActiveAttempts(
  store: TransferOperationDb,
  legs: readonly { transaction: TransferTransaction }[],
): Promise<void> {
  for (const leg of legs) {
    const attempt = await store.qboMutationAttempt.findFirst({
      where: {
        transactionId: leg.transaction.id,
        status: { in: ACTIVE_ATTEMPT_STATUSES },
      },
    });
    if (attempt !== null) throw new TransferOperationError('ACTIVE_ATTEMPT');
  }
}

async function resolveTargetAccounts(
  store: TransferOperationDb,
  companyId: string,
  legs: [
    { transaction: TransferTransaction; expectedRevision: number },
    { transaction: TransferTransaction; expectedRevision: number },
  ],
): Promise<[TransferAccount, TransferAccount]> {
  const names = legs.map((_, index) => legs[index === 0 ? 1 : 0].transaction.bankAccount);
  const rows = await store.qboAccount.findMany({
    where: { companyId, name: { in: names }, active: true },
    select: { qboId: true, name: true, active: true },
  });
  const targets = names.map((name) => rows.filter((row) =>
    row.active && row.name === name
  ));
  if (
    targets[0]?.length !== 1
    || targets[1]?.length !== 1
    || targets[0][0]!.qboId === targets[1][0]!.qboId
  ) {
    throw new TransferOperationError('TARGET_ACCOUNT_INVALID');
  }
  return [targets[0][0]!, targets[1][0]!];
}

async function prepareLegs(
  client: QboClient,
  legs: [
    { transaction: TransferTransaction; expectedRevision: number },
    { transaction: TransferTransaction; expectedRevision: number },
  ],
  targets: [TransferAccount, TransferAccount],
  operationId: string,
): Promise<[PreparedLeg, PreparedLeg]> {
  const output: PreparedLeg[] = [];
  for (const [index, leg] of legs.entries()) {
    const txn = leg.transaction;
    if (!isQboType(txn.qboType)) {
      throw new TransferOperationError('STALE_QBO_BINDING');
    }
    const fresh = await client.fetchTxn(txn.qboType, txn.qboId);
    assertFreshEvidence(txn, fresh);
    const amountCents = exactCents(fresh!.amount);
    const requestId = `${operationId}-t${index}`;
    const splits = [{
      amount: amountCents / 100,
      accountQboId: targets[index]!.qboId,
      ...(txn.memo === null ? {} : { memo: txn.memo }),
    }];
    const candidate = await client.prepareLineRecategorization(
      fresh!,
      splits,
      requestId,
    );
    let prepared: QboPreparedLineWrite;
    try {
      prepared = validatePreparedLineWrite(candidate);
    } catch {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
    if (
      prepared.requestId !== requestId
      || prepared.qboType !== fresh!.qboType
      || prepared.qboId !== fresh!.qboId
      || prepared.before.syncToken !== fresh!.syncToken
    ) {
      throw new TransferOperationError('STALE_QBO_BINDING');
    }
    if (
      targetLineCents(
        prepared.body,
        prepared.qboType,
        targets[index]!.qboId,
      )
        !== Math.abs(amountCents)
    ) {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
    try {
      prepared = validatePreparedLineTransformation(prepared, {
        txn: fresh!,
        splits,
        requestId,
        holdingAccountQboIds: jsonStringArray(
          txn.company.holdingAccountIds,
        ),
      });
    } catch {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
    output.push({
      transaction: txn,
      expectedRevision: leg.expectedRevision,
      targetAccountQboId: targets[index]!.qboId,
      fresh: fresh!,
      prepared,
    });
  }
  return output as [PreparedLeg, PreparedLeg];
}

function assertFreshEvidence(
  transaction: TransferTransaction,
  fresh: QboTxn | null,
): void {
  if (
    fresh === null
    || fresh.qboType !== transaction.qboType
    || fresh.qboId !== transaction.qboId
    || fresh.syncToken !== transaction.qboSyncToken
    || fresh.date !== transactionDate(transaction.date)
    || fresh.bankAccount !== transaction.bankAccount
  ) {
    throw new TransferOperationError('STALE_QBO_BINDING');
  }
  const holdingIds = jsonStringArray(transaction.company.holdingAccountIds);
  let lineCents = 0;
  try {
    if (
      fresh.lines.length === 0
      || holdingIds.length === 0
      || fresh.lines.some((line) => !holdingIds.includes(line.accountQboId))
    ) {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
    for (const line of fresh.lines) lineCents += exactCents(line.amount);
    const expectedCents = exactCents(transaction.amount);
    if (
      exactCents(fresh.amount) !== expectedCents
      || Math.abs(lineCents) !== Math.abs(expectedCents)
    ) {
      throw new TransferOperationError('STALE_QBO_AMOUNT');
    }
  } catch (error) {
    if (error instanceof TransferOperationError) throw error;
    throw new TransferOperationError('STALE_QBO_AMOUNT');
  }
}

function transactionDate(value: Date): string {
  if (!isValidDate(value)) throw new TransferOperationError('STALE_QBO_BINDING');
  return value.toISOString().slice(0, 10);
}

function operationData(
  expected: ExpectedPreparation,
  operationId: string,
  expiresAt: Date,
): TransferOperationInsert {
  const [first, second] = expected.legs;
  return {
    id: operationId,
    actorId: expected.input.actorId,
    companyId: expected.input.companyId,
    firstTransactionId: first.transaction.id,
    secondTransactionId: second.transaction.id,
    firstExpectedRevision: first.expectedRevision,
    secondExpectedRevision: second.expectedRevision,
    firstQboType: first.fresh.qboType,
    firstQboId: first.fresh.qboId,
    firstQboSyncToken: first.fresh.syncToken,
    firstTargetAccountQboId: first.targetAccountQboId,
    firstAttemptRequestId: first.prepared.requestId,
    secondQboType: second.fresh.qboType,
    secondQboId: second.fresh.qboId,
    secondQboSyncToken: second.fresh.syncToken,
    secondTargetAccountQboId: second.targetAccountQboId,
    secondAttemptRequestId: second.prepared.requestId,
    idempotencyHash: expected.input.idempotencyHash,
    inputHash: expected.input.inputHash,
    preparedHash: expected.preparedHash,
    expiresAt,
    retryOfId: null,
  };
}

function attemptData(
  expected: ExpectedPreparation,
): [TransferAttemptCreate, TransferAttemptCreate] {
  return expected.legs.map((leg) => ({
    transactionId: leg.transaction.id,
    requestId: leg.prepared.requestId,
    operation: 'transfer',
    status: 'PREPARED',
    expectedRevision: leg.expectedRevision,
    expectedSyncToken: leg.prepared.before.syncToken,
    requestHash: leg.prepared.requestHash,
    requestPayload: leg.prepared,
    beforeSnapshot: leg.prepared.before,
  })) as [TransferAttemptCreate, TransferAttemptCreate];
}

async function findReplay(
  store: TransferOperationDb,
  input: NormalizedInput,
): Promise<TransferOperationRecord | null> {
  return store.qboTransferOperation.findFirst({
    where: {
      actorId: input.actorId,
      companyId: input.companyId,
      idempotencyHash: input.idempotencyHash,
      OR: [
        {
          firstTransactionId: input.transactionId,
          secondTransactionId: input.counterpartTransactionId,
        },
        {
          firstTransactionId: input.counterpartTransactionId,
          secondTransactionId: input.transactionId,
        },
      ],
    },
  });
}

async function loadReplayDto(
  store: TransferOperationDb,
  operation: TransferOperationRecord,
  input: NormalizedInput,
  expected?: ExpectedPreparation,
): Promise<PreparedTransferDto> {
  assertReplayInput(operation, input);
  if (expected !== undefined) assertExpectedCoordinator(operation, expected);
  const attempts = await store.qboMutationAttempt.findMany({
    where: {
      requestId: {
        in: [
          operation.firstAttemptRequestId,
          operation.secondAttemptRequestId,
        ],
      },
    },
  });
  const first = attempts.find((attempt) =>
    attempt.requestId === operation.firstAttemptRequestId
  );
  const second = attempts.find((attempt) =>
    attempt.requestId === operation.secondAttemptRequestId
  );
  if (first === undefined || second === undefined || attempts.length !== 2) {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
  const prepared = [
    validateAttempt(operation, first, 0),
    validateAttempt(operation, second, 1),
  ] as [QboPreparedLineWrite, QboPreparedLineWrite];
  const preparedHash = hashPreparedPayloads(operation, prepared);
  if (preparedHash !== operation.preparedHash) {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
  return toDto(operation, totalCentsFromPrepared(operation, prepared));
}

function assertReplayInput(
  operation: TransferOperationRecord,
  input: NormalizedInput,
): void {
  const pairMatches = (
    operation.firstTransactionId === input.transactionId
    && operation.secondTransactionId === input.counterpartTransactionId
  ) || (
    operation.firstTransactionId === input.counterpartTransactionId
    && operation.secondTransactionId === input.transactionId
  );
  if (
    operation.actorId !== input.actorId
    || operation.companyId !== input.companyId
    || operation.idempotencyHash !== input.idempotencyHash
    || operation.inputHash !== input.inputHash
    || !pairMatches
  ) {
    throw new TransferOperationError('IDEMPOTENCY_CONFLICT');
  }
}

function assertExpectedCoordinator(
  operation: TransferOperationRecord,
  expected: ExpectedPreparation,
): void {
  const requested = operationData(
    expected,
    operation.id,
    operation.expiresAt,
  );
  const comparableFields = [
    'actorId',
    'companyId',
    'firstTransactionId',
    'secondTransactionId',
    'firstExpectedRevision',
    'secondExpectedRevision',
    'firstQboType',
    'firstQboId',
    'firstQboSyncToken',
    'firstTargetAccountQboId',
    'secondQboType',
    'secondQboId',
    'secondQboSyncToken',
    'secondTargetAccountQboId',
    'idempotencyHash',
    'inputHash',
    'preparedHash',
    'retryOfId',
  ] as const;
  if (
    comparableFields.some((field) => operation[field] !== requested[field])
    || operation.firstAttemptRequestId !== `${operation.id}-t0`
    || operation.secondAttemptRequestId !== `${operation.id}-t1`
  ) {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
}

function validateAttempt(
  operation: TransferOperationRecord,
  attempt: TransferAttempt,
  index: 0 | 1,
): QboPreparedLineWrite {
  const prefix = index === 0 ? 'first' : 'second';
  const transactionId = operation[`${prefix}TransactionId`];
  const requestId = operation[`${prefix}AttemptRequestId`];
  const expectedRevision = operation[`${prefix}ExpectedRevision`];
  const expectedSyncToken = operation[`${prefix}QboSyncToken`];
  const qboType = operation[`${prefix}QboType`];
  const qboId = operation[`${prefix}QboId`];
  let prepared: QboPreparedLineWrite;
  try {
    prepared = validatePreparedLineWrite(attempt.requestPayload);
  } catch {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
  if (
    attempt.transactionId !== transactionId
    || attempt.requestId !== requestId
    || attempt.operation !== 'transfer'
    || attempt.expectedRevision !== expectedRevision
    || attempt.expectedSyncToken !== expectedSyncToken
    || attempt.requestHash !== prepared.requestHash
    || canonicalJson(attempt.beforeSnapshot) !== canonicalJson(prepared.before)
    || prepared.requestId !== requestId
    || prepared.qboType !== qboType
    || prepared.qboId !== qboId
    || prepared.before.syncToken !== expectedSyncToken
  ) {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
  return prepared;
}

function hashPreparedLegs(legs: [PreparedLeg, PreparedLeg]): string {
  return hashCanonical(legs.map((leg) => preparedDigestValue(
    leg.transaction.id,
    leg.expectedRevision,
    leg.targetAccountQboId,
    leg.prepared,
  )));
}

function hashPreparedPayloads(
  operation: TransferOperationRecord,
  prepared: [QboPreparedLineWrite, QboPreparedLineWrite],
): string {
  return hashCanonical([
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
}

function preparedDigestValue(
  transactionId: string,
  expectedRevision: number,
  targetAccountQboId: string,
  prepared: QboPreparedLineWrite,
): unknown {
  return {
    transactionId,
    expectedRevision,
    targetAccountQboId,
    operation: prepared.operation,
    qboType: prepared.qboType,
    qboId: prepared.qboId,
    requestHash: prepared.requestHash,
    body: prepared.body,
    before: prepared.before,
    expected: prepared.expected,
  };
}

function totalCentsFromPrepared(
  operation: TransferOperationRecord,
  prepared: [QboPreparedLineWrite, QboPreparedLineWrite],
): number {
  const first = targetLineCents(
    prepared[0].body,
    prepared[0].qboType,
    operation.firstTargetAccountQboId,
  );
  const second = targetLineCents(
    prepared[1].body,
    prepared[1].qboType,
    operation.secondTargetAccountQboId,
  );
  if (
    first === 0
    || Math.abs(first) !== Math.abs(second)
  ) {
    throw new TransferOperationError('OPERATION_CONFLICT');
  }
  return Math.abs(first);
}

function targetLineCents(
  body: Record<string, unknown>,
  qboType: QboTxn['qboType'],
  accountQboId: string,
): number {
  const lines = body.Line;
  if (!Array.isArray(lines)) throw new TransferOperationError('OPERATION_CONFLICT');
  const detailKey = qboType === 'Purchase'
    ? 'AccountBasedExpenseLineDetail'
    : qboType === 'Deposit'
      ? 'DepositLineDetail'
      : 'JournalEntryLineDetail';
  const targets = lines.filter((candidate) => {
    if (!isRecord(candidate) || typeof candidate.Amount !== 'number') return false;
    const detail = candidate[detailKey];
    const accountRef = isRecord(detail) ? detail.AccountRef : null;
    return (
      isRecord(accountRef)
      && accountRef.value === accountQboId
      && (
        qboType !== 'JournalEntry'
        || (
          isRecord(detail)
          && detail.PostingType === 'Debit'
        )
      )
    );
  });
  const line = targets[0];
  if (
    targets.length !== 1
    || !isRecord(line)
    || typeof line.Amount !== 'number'
  ) {
    throw new TransferOperationError('TARGET_ACCOUNT_INVALID');
  }
  return exactCents(line.Amount);
}

function sameHoldingAccountIds(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown): string[] =>
    [...new Set(jsonStringArray(value))].sort();
  return canonicalJson(normalized(left)) === canonicalJson(normalized(right));
}

function toDto(
  operation: TransferOperationRecord,
  totalCents: number,
): PreparedTransferDto {
  return {
    operationId: operation.id,
    state: 'PREPARED',
    expiresAt: operation.expiresAt.toISOString(),
    preview: {
      action: 'record_transfer',
      direction: 'between_accounts',
      totalCents,
      legCount: 2,
      preparationDigest: operation.preparedHash,
    },
  };
}

function exactCents(value: number | string | { toString(): string }): number {
  const text = typeof value === 'number' ? String(value) : value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) throw new TransferOperationError('INVALID_TRANSFER_PAIR');
  const cents = (match[1] === '-' ? -1n : 1n)
    * (
      BigInt(match[2]!) * 100n
      + BigInt((match[3] ?? '').padEnd(2, '0'))
    );
  if (
    cents < BigInt(Number.MIN_SAFE_INTEGER)
    || cents > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TransferOperationError('INVALID_TRANSFER_PAIR');
  }
  return Number(cents);
}

function boundedRevision(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_PRISMA_INT
  ) {
    invalidInput();
  }
  return value;
}

function boundedIdentifier(value: unknown): string {
  return boundedText(value, MAX_IDENTIFIER_LENGTH);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') invalidInput();
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length === 0
    || normalized.length > maximum
    || !SAFE_TEXT.test(normalized)
  ) {
    invalidInput();
  }
  return normalized;
}

function expiryAt(now: Date): Date {
  if (!isValidDate(now)) invalidInput();
  const expiry = new Date(now.getTime() + TRANSFER_OPERATION_EXPIRY_MS);
  if (!isValidDate(expiry)) invalidInput();
  return expiry;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isQboType(value: string): value is QboTxn['qboType'] {
  return (
    value.length <= MAX_QBO_TYPE_LENGTH
    && (
      value === 'Purchase'
      || value === 'Deposit'
      || value === 'JournalEntry'
    )
  );
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim() !== ''
      )
    : [];
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) invalidInput();
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!isRecord(value)) invalidInput();
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(
  code: TransferOperationErrorCode = 'INVALID_INPUT',
): never {
  throw new TransferOperationError(code);
}
