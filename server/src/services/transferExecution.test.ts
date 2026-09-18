import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPreparedLineWrite,
  hashLineWriteContent,
  hashLineWriteRequest,
} from '../lib/qbo/lineWrite.js';
import type {
  QboClient,
  QboLineWriteSnapshot,
  QboPreparedLineWrite,
  QboTxn,
} from '../lib/qbo/types.js';
import { EntityLeaseError } from './entityLease.js';
import {
  commitTransfer,
  getTransferOperation,
  projectTransferState,
  retryTransferOperation,
  retryTransferOperationWithWorkflow,
  TransferExecutionError,
  type TransferAttemptStatus,
  type TransferExecutionDb,
  type TransferExecutionDeps,
} from './transferExecution.js';
import type { TransferOperationRecord } from './transferOperations.js';

const NOW = new Date('2026-07-29T18:00:00.000Z');
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const RETRY_OPERATION_ID = '123e4567-e89b-42d3-a456-426614174001';
const ACTOR = { id: 'actor-generic', label: 'Generic Actor' };
const PRIVATE_PROVIDER_SENTINEL = 'PRIVATE_PROVIDER_SENTINEL_7419';
const PRIVATE_USER_SENTINEL = 'PRIVATE_USER_SENTINEL_8520';

interface StoredTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: string;
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
    holdingAccountIds: string[];
  };
}

interface StoredAttempt {
  id: string;
  transactionId: string;
  requestId: string;
  operation: string;
  status: TransferAttemptStatus;
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

interface StoredAudit {
  action: string;
  mutation?: unknown;
  [key: string]: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function qboTxn(args: {
  qboId: string;
  qboType: 'Purchase' | 'Deposit';
  syncToken: string;
  amount: number;
  bankAccount: string;
  date: string;
  trailingUntouchedLine?: boolean;
}): QboTxn {
  const holdingLine = args.qboType === 'Purchase'
    ? {
        Id: `holding-${args.qboId}`,
        Amount: Math.abs(args.amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'holding-generic', name: 'Generic Holding' },
        },
      }
    : {
        Id: `holding-${args.qboId}`,
        Amount: Math.abs(args.amount),
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'holding-generic', name: 'Generic Holding' },
          Entity: { value: 'entity-generic', name: 'Generic Entity' },
        },
      };
  const untouchedLine = args.qboType === 'Purchase'
    ? {
        Id: `untouched-${args.qboId}`,
        Amount: 1,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'untouched-generic', name: 'Generic Untouched' },
        },
      }
    : {
        Id: `untouched-${args.qboId}`,
        Amount: 1,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'untouched-generic', name: 'Generic Untouched' },
        },
      };
  return {
    qboId: args.qboId,
    qboType: args.qboType,
    syncToken: args.syncToken,
    date: args.date,
    payee: PRIVATE_USER_SENTINEL,
    memo: PRIVATE_USER_SENTINEL,
    amount: args.amount,
    bankAccount: args.bankAccount,
    lines: [
      {
        id: `holding-${args.qboId}`,
        amount: Math.abs(args.amount),
        accountQboId: 'holding-generic',
        accountName: 'Generic Holding',
      },
      ...(args.trailingUntouchedLine
        ? [{
            id: `untouched-${args.qboId}`,
            amount: 1,
            accountQboId: 'untouched-generic',
            accountName: 'Generic Untouched',
          }]
        : []),
    ],
    raw: {
      Id: args.qboId,
      SyncToken: args.syncToken,
      TxnDate: args.date,
      PrivateNote: PRIVATE_PROVIDER_SENTINEL,
      ...(args.qboType === 'Purchase'
        ? { AccountRef: { value: 'bank-out', name: args.bankAccount } }
        : { DepositToAccountRef: { value: 'bank-in', name: args.bankAccount } }),
      Line: [
        holdingLine,
        ...(args.trailingUntouchedLine ? [untouchedLine] : []),
      ],
    },
  };
}

function prepared(
  txn: QboTxn,
  targetAccountQboId: string,
  requestId: string,
): QboPreparedLineWrite {
  return buildPreparedLineWrite({
    txn,
    splits: [{
      amount: txn.amount,
      accountQboId: targetAccountQboId,
      memo: PRIVATE_USER_SENTINEL,
    }],
    requestId,
    holdingAccountQboIds: ['holding-generic'],
  });
}

function preparedDigestValue(
  transactionId: string,
  expectedRevision: number,
  targetAccountQboId: string,
  value: QboPreparedLineWrite,
): unknown {
  return {
    transactionId,
    expectedRevision,
    targetAccountQboId,
    operation: value.operation,
    qboType: value.qboType,
    qboId: value.qboId,
    requestHash: value.requestHash,
    body: value.body,
    before: value.before,
    expected: value.expected,
  };
}

class FakeExecutionDb {
  readonly events: string[] = [];
  readonly audits: StoredAudit[] = [];
  readonly auditDepths: number[] = [];
  transactionDepth = 0;
  failAudit = false;
  transactions: StoredTransaction[];
  attempts: StoredAttempt[];
  operation: TransferOperationRecord;
  operations: TransferOperationRecord[];

  constructor(
    transactions: StoredTransaction[],
    attempts: StoredAttempt[],
    operation: TransferOperationRecord,
  ) {
    this.transactions = transactions;
    this.attempts = attempts;
    this.operation = operation;
    this.operations = [operation];
  }

  executionStore(): TransferExecutionDb {
    const self = this;
    return {
      transaction: {
        findUnique: async ({ where }) => {
          self.events.push(`transaction:${where.id}`);
          return clone(
            self.transactions.find((candidate) => candidate.id === where.id) ?? null,
          );
        },
        update: async ({ where, data }) => {
          self.events.push(`transaction-update:${where.id}:${String(data.status ?? '')}`);
          const row = self.transactions.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error('transaction missing');
          Object.assign(row, clone(data));
          return clone(row);
        },
      },
      qboMutationAttempt: {
        findUnique: async ({ where }) => {
          self.events.push(`attempt:${where.requestId}`);
          return clone(
            self.attempts.find((candidate) =>
              candidate.requestId === where.requestId
            ) ?? null,
          );
        },
        findMany: async ({ where }) => {
          self.events.push('attempts:detail');
          return clone(self.attempts.filter((candidate) =>
            where.requestId.in.includes(candidate.requestId)
          ));
        },
        updateMany: async ({ where, data }) => {
          const statuses = typeof where.status === 'string'
            ? [where.status]
            : where.status.in;
          const row = self.attempts.find((candidate) =>
            candidate.id === where.id && statuses.includes(candidate.status)
          );
          self.events.push(
            `attempt-update:${where.id}:${String(data.status ?? '')}:${row ? 'won' : 'lost'}`,
          );
          if (!row) return { count: 0 };
          Object.assign(row, clone(data));
          return { count: 1 };
        },
        createMany: async ({ data }: { data: StoredAttempt[] }) => {
          let count = 0;
          for (const candidate of data) {
            if (self.attempts.some((attempt) =>
              attempt.requestId === candidate.requestId
            )) {
              continue;
            }
            self.attempts.push({
              ...clone(candidate),
              id: `attempt-${self.attempts.length + 1}`,
              responseSnapshot: null,
              verification: null,
              errorCode: null,
              errorMessage: null,
              updatedAt: NOW,
            });
            count += 1;
          }
          return { count };
        },
      },
      qboAccount: {
        findMany: async ({ where }) => [
          {
            qboId: 'account-operating',
            name: 'Generic Operating',
            active: true,
          },
          {
            qboId: 'account-reserve',
            name: 'Generic Reserve',
            active: true,
          },
        ].filter((account) =>
          account.active
          && where.name.in.includes(account.name)
        ),
      },
      qboTransferOperation: {
        findFirst: async ({ where, select }: {
          where: { id?: string; retryOfId?: string };
          select?: unknown;
        }) => {
          const operation = self.operations.find((candidate) =>
            (where.id === undefined || candidate.id === where.id)
            && (
              where.retryOfId === undefined
              || candidate.retryOfId === where.retryOfId
            )
          );
          if (!operation) return null;
          if (select) {
            self.events.push('operation:locator');
            return {
              id: operation.id,
              actorId: operation.actorId,
              companyId: operation.companyId,
            };
          }
          self.events.push('operation:detail');
          return clone(operation);
        },
        createMany: async ({ data }: {
          data: TransferOperationRecord;
        }) => {
          if (
            self.operations.some((operation) =>
              operation.id === data.id
              || (
                data.retryOfId !== null
                && operation.retryOfId === data.retryOfId
              )
            )
          ) {
            return { count: 0 };
          }
          self.operations.push(clone(data));
          return { count: 1 };
        },
      },
      $transaction: async (callback) => {
        self.events.push('db:transaction:start');
        const beforeTransactions = clone(self.transactions);
        const beforeAttempts = clone(self.attempts);
        const beforeOperations = clone(self.operations);
        const beforeAudits = clone(self.audits);
        self.transactionDepth += 1;
        try {
          const value = await callback(self.executionStore());
          self.events.push('db:transaction:commit');
          return value;
        } catch (error) {
          self.transactions = beforeTransactions;
          self.attempts = beforeAttempts;
          self.operations = beforeOperations;
          self.audits.splice(0, self.audits.length, ...beforeAudits);
          self.events.push('db:transaction:rollback');
          throw error;
        } finally {
          self.transactionDepth -= 1;
        }
      },
    } as unknown as TransferExecutionDb;
  }
}

function fixture(overrides: {
  dryRun?: boolean;
  expiresAt?: Date;
  authorize?: boolean;
  envDryRun?: boolean;
  legacyRequestIds?: boolean;
  trailingUntouchedLine?: boolean;
} = {}) {
  const firstTxn = qboTxn({
    qboId: 'qbo-a-in',
    qboType: 'Deposit',
    syncToken: '8',
    amount: 124.5,
    bankAccount: 'Generic Reserve',
    date: '2026-07-29',
    trailingUntouchedLine: overrides.trailingUntouchedLine,
  });
  const secondTxn = qboTxn({
    qboId: 'qbo-z-out',
    qboType: 'Purchase',
    syncToken: '4',
    amount: -124.5,
    bankAccount: 'Generic Operating',
    date: '2026-07-27',
    trailingUntouchedLine: overrides.trailingUntouchedLine,
  });
  const firstPrepared = prepared(
    firstTxn,
    'account-operating',
    overrides.legacyRequestIds
      ? `${OPERATION_ID}:transfer:0`
      : `${OPERATION_ID}-t0`,
  );
  const secondPrepared = prepared(
    secondTxn,
    'account-reserve',
    overrides.legacyRequestIds
      ? `${OPERATION_ID}:transfer:1`
      : `${OPERATION_ID}-t1`,
  );
  const transactions: StoredTransaction[] = [
    {
      id: 'txn-in',
      companyId: 'company-generic',
      qboId: firstTxn.qboId,
      qboType: firstTxn.qboType,
      qboSyncToken: firstTxn.syncToken,
      revision: 9,
      status: 'PENDING',
      amount: '124.50',
      bankAccount: 'Generic Reserve',
      memo: PRIVATE_USER_SENTINEL,
      payee: PRIVATE_USER_SENTINEL,
      date: new Date('2026-07-29T00:00:00.000Z'),
      postedAt: null,
      postedByUserId: null,
      errorCode: null,
      errorMessage: null,
      company: {
        id: 'company-generic',
        disconnectedAt: null,
        dryRun: overrides.dryRun ?? false,
        holdingAccountIds: ['holding-generic'],
      },
    },
    {
      id: 'txn-out',
      companyId: 'company-generic',
      qboId: secondTxn.qboId,
      qboType: secondTxn.qboType,
      qboSyncToken: secondTxn.syncToken,
      revision: 7,
      status: 'PENDING',
      amount: '-124.50',
      bankAccount: 'Generic Operating',
      memo: PRIVATE_USER_SENTINEL,
      payee: PRIVATE_USER_SENTINEL,
      date: new Date('2026-07-27T00:00:00.000Z'),
      postedAt: null,
      postedByUserId: null,
      errorCode: null,
      errorMessage: null,
      company: {
        id: 'company-generic',
        disconnectedAt: null,
        dryRun: overrides.dryRun ?? false,
        holdingAccountIds: ['holding-generic'],
      },
    },
  ];
  const attempts: StoredAttempt[] = [
    {
      id: 'attempt-first',
      transactionId: 'txn-in',
      requestId: firstPrepared.requestId,
      operation: 'transfer',
      status: 'PREPARED',
      expectedRevision: 9,
      expectedSyncToken: '8',
      requestHash: firstPrepared.requestHash,
      requestPayload: clone(firstPrepared),
      beforeSnapshot: clone(firstPrepared.before),
      responseSnapshot: null,
      verification: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(NOW.getTime() - 120_000),
    },
    {
      id: 'attempt-second',
      transactionId: 'txn-out',
      requestId: secondPrepared.requestId,
      operation: 'transfer',
      status: 'PREPARED',
      expectedRevision: 7,
      expectedSyncToken: '4',
      requestHash: secondPrepared.requestHash,
      requestPayload: clone(secondPrepared),
      beforeSnapshot: clone(secondPrepared.before),
      responseSnapshot: null,
      verification: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(NOW.getTime() - 120_000),
    },
  ];
  const operation: TransferOperationRecord = {
    id: OPERATION_ID,
    actorId: ACTOR.id,
    companyId: 'company-generic',
    firstTransactionId: 'txn-in',
    secondTransactionId: 'txn-out',
    firstExpectedRevision: 9,
    secondExpectedRevision: 7,
    firstQboType: 'Deposit',
    firstQboId: 'qbo-a-in',
    firstQboSyncToken: '8',
    firstTargetAccountQboId: 'account-operating',
    firstAttemptRequestId: firstPrepared.requestId,
    secondQboType: 'Purchase',
    secondQboId: 'qbo-z-out',
    secondQboSyncToken: '4',
    secondTargetAccountQboId: 'account-reserve',
    secondAttemptRequestId: secondPrepared.requestId,
    idempotencyHash: hash('idempotency-generic'),
    inputHash: hash('input-generic'),
    preparedHash: hash([
      preparedDigestValue('txn-in', 9, 'account-operating', firstPrepared),
      preparedDigestValue('txn-out', 7, 'account-reserve', secondPrepared),
    ]),
    expiresAt: overrides.expiresAt
      ?? new Date(NOW.getTime() + 15 * 60 * 1000),
    retryOfId: null,
    createdAt: NOW,
  };
  const db = new FakeExecutionDb(transactions, attempts, operation);
  const snapshots = new Map<string, QboLineWriteSnapshot>([
    [firstPrepared.qboId, clone(firstPrepared.before)],
    [secondPrepared.qboId, clone(secondPrepared.before)],
  ]);
  const sendFailures = new Set<string>();
  const sendPreparedLineWrite = vi.fn(async (
    value: QboPreparedLineWrite,
    beforeSend?: () => Promise<void>,
  ) => {
    await beforeSend?.();
    db.events.push(`send:${value.requestId}`);
    expect(db.attempts.length).toBeGreaterThanOrEqual(2);
    if (sendFailures.has(value.qboId)) {
      throw new Error(PRIVATE_PROVIDER_SENTINEL);
    }
    const next = {
      ...value.expected,
      syncToken: `${Number(value.before.syncToken) + 1}`,
    };
    snapshots.set(value.qboId, next);
    return { ok: true as const, newSyncToken: next.syncToken, snapshot: next };
  });
  const fetchLineWriteSnapshot = vi.fn(async (
    _qboType: QboTxn['qboType'],
    qboId: string,
  ) => {
    db.events.push(`snapshot:${qboId}`);
    return clone(snapshots.get(qboId) ?? null);
  });
  const fetchTxn = vi.fn(async (
    qboType: QboTxn['qboType'],
    qboId: string,
  ) => {
    const txn = [firstTxn, secondTxn].find((candidate) =>
      candidate.qboType === qboType && candidate.qboId === qboId
    );
    return txn === undefined ? null : clone(txn);
  });
  const prepareLineRecategorization = vi.fn(async (
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
    requestId: string,
  ) => prepared(txn, splits[0]!.accountQboId, requestId));
  const client = {
    sendPreparedLineWrite,
    fetchLineWriteSnapshot,
    fetchTxn,
    prepareLineRecategorization,
  } as unknown as QboClient;
  const authorize = vi.fn(async (
    _actorId: string | null,
    _companyId: string,
  ) => {
    db.events.push('authorize');
    return overrides.authorize ?? true;
  });
  const getClient = vi.fn(async () => {
    db.events.push('client');
    return client;
  });
  const lease = vi.fn(async (
    _keys: Parameters<TransferExecutionDeps['lease']>[0],
    _owner: string,
    callback: () => Promise<unknown>,
  ) => {
    db.events.push('lease');
    return callback();
  });
  const renewLease = vi.fn(async () => {
    db.events.push('renew');
  });
  const fence = vi.fn(async () => {
    expect(db.transactionDepth).toBe(1);
    db.events.push('fence');
  });
  const audit = vi.fn(async (
    _store: TransferExecutionDb,
    entry: StoredAudit,
  ) => {
    db.events.push(`audit:${entry.action}`);
    db.auditDepths.push(db.transactionDepth);
    if (db.failAudit) throw new Error(PRIVATE_PROVIDER_SENTINEL);
    db.audits.push(clone(entry));
  });
  const deps: TransferExecutionDeps = {
    db: db.executionStore(),
    getClient,
    audit: audit as TransferExecutionDeps['audit'],
    authorize: authorize as TransferExecutionDeps['authorize'],
    lease: lease as TransferExecutionDeps['lease'],
    renewLease: renewLease as TransferExecutionDeps['renewLease'],
    fence: fence as TransferExecutionDeps['fence'],
    invocationId: () => 'invocation-generic',
    now: () => NOW,
    envDryRun: overrides.envDryRun ?? false,
  };
  Object.assign(deps, { operationId: () => RETRY_OPERATION_ID });
  const markVerified = (index: 0 | 1): void => {
    const attempt = db.attempts[index]!;
    const value = attempt.requestPayload as QboPreparedLineWrite;
    const response = {
      ...value.expected,
      syncToken: `${Number(value.before.syncToken) + 1}`,
    };
    attempt.status = 'VERIFIED';
    attempt.responseSnapshot = clone(response);
    attempt.verification = {
      outcome: 'VERIFIED',
      status: 'POSTED',
      newSyncToken: response.syncToken,
    };
    const transaction = db.transactions.find((candidate) =>
      candidate.id === attempt.transactionId
    )!;
    transaction.status = 'POSTED';
    transaction.qboSyncToken = response.syncToken;
    transaction.postedAt = NOW;
    transaction.postedByUserId = ACTOR.id;
    const providerTransaction = [firstTxn, secondTxn].find((candidate) =>
      candidate.qboId === value.qboId
    )!;
    providerTransaction.syncToken = response.syncToken;
    providerTransaction.amount = 0;
    providerTransaction.lines = [];
    providerTransaction.raw = clone(value.body);
    providerTransaction.raw.SyncToken = response.syncToken;
    snapshots.set(value.qboId, clone(response));
  };
  return {
    db,
    deps,
    operation,
    attempts,
    prepared: [firstPrepared, secondPrepared] as const,
    snapshots,
    sendFailures,
    sendPreparedLineWrite,
    fetchLineWriteSnapshot,
    fetchTxn,
    prepareLineRecategorization,
    getClient,
    authorize,
    lease,
    renewLease,
    fence,
    audit,
    markVerified,
  };
}

describe('projectTransferState', () => {
  const statuses = [
    'PREPARED',
    'COMMITTING',
    'VERIFIED',
    'UNCERTAIN',
    'RETRYABLE',
    'UNCHANGED',
    'DRY_RUN',
  ] as const;
  const expectedStates = [
    ['PREPARED', 'IN_PROGRESS', 'PARTIAL', 'UNCERTAIN', 'RETRYABLE', 'RETRYABLE', 'PARTIAL'],
    ['IN_PROGRESS', 'IN_PROGRESS', 'PARTIAL', 'UNCERTAIN', 'IN_PROGRESS', 'IN_PROGRESS', 'PARTIAL'],
    ['PARTIAL', 'PARTIAL', 'VERIFIED', 'UNCERTAIN', 'PARTIAL', 'PARTIAL', 'PARTIAL'],
    ['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'],
    ['RETRYABLE', 'IN_PROGRESS', 'PARTIAL', 'UNCERTAIN', 'RETRYABLE', 'RETRYABLE', 'PARTIAL'],
    ['RETRYABLE', 'IN_PROGRESS', 'PARTIAL', 'UNCERTAIN', 'RETRYABLE', 'RETRYABLE', 'PARTIAL'],
    ['PARTIAL', 'PARTIAL', 'PARTIAL', 'UNCERTAIN', 'PARTIAL', 'PARTIAL', 'DRY_RUN'],
  ] as const;

  it.each(statuses.flatMap((firstStatus, firstIndex) =>
    statuses.map((secondStatus, secondIndex) => ({
      firstStatus,
      secondStatus,
      expected: expectedStates[firstIndex]![secondIndex]!,
    }))
  ))('projects $firstStatus + $secondStatus as $expected', ({
    firstStatus,
    secondStatus,
    expected,
  }) => {
    const projection = projectTransferState(firstStatus, secondStatus);
    expect(projection.state).toBe(expected);
    expect(projection.complete).toBe(
      expected === 'VERIFIED' || expected === 'DRY_RUN',
    );
  });

  it('maps attempt evidence to the public per-leg outcomes', () => {
    expect(projectTransferState('PREPARED', 'COMMITTING')).toMatchObject({
      firstLeg: { outcome: 'IN_PROGRESS' },
      secondLeg: { outcome: 'IN_PROGRESS' },
    });
    expect(projectTransferState('UNCHANGED', 'RETRYABLE')).toMatchObject({
      firstLeg: { outcome: 'UNCHANGED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
  });
});

describe('transfer operation status', () => {
  it('is database-only, redacted, and authorizes before attempt status/detail reads', async () => {
    const f = fixture();

    const result = await getTransferOperation(OPERATION_ID, ACTOR, undefined, f.deps);

    expect(result).toEqual({
      operationId: OPERATION_ID,
      state: 'PREPARED',
      complete: false,
      firstLeg: { outcome: 'IN_PROGRESS' },
      secondLeg: { outcome: 'IN_PROGRESS' },
    });
    expect(f.getClient).not.toHaveBeenCalled();
    expect(f.lease).not.toHaveBeenCalled();
    expect(f.fence).not.toHaveBeenCalled();
    expect(f.db.events.indexOf('authorize')).toBeLessThan(
      f.db.events.indexOf('operation:detail'),
    );
    expect(f.db.events.indexOf('authorize')).toBeLessThan(
      f.db.events.indexOf('attempts:detail'),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PRIVATE_PROVIDER_SENTINEL);
    expect(serialized).not.toContain(PRIVATE_USER_SENTINEL);
    expect(serialized).not.toMatch(/transactionId|qboId|syncToken|requestId/i);
  });

  it('keeps pre-upgrade legacy request IDs readable for recovery', async () => {
    const f = fixture({ legacyRequestIds: true });

    await expect(
      getTransferOperation(OPERATION_ID, ACTOR, undefined, f.deps),
    ).resolves.toMatchObject({
      operationId: OPERATION_ID,
      state: 'PREPARED',
      complete: false,
    });
  });

  it('does not read attempt status or operation detail after current authorization fails', async () => {
    const f = fixture({ authorize: false });

    await expect(
      getTransferOperation(OPERATION_ID, ACTOR, undefined, f.deps),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to access this transfer operation.',
    });

    expect(f.db.events).toEqual(['operation:locator', 'authorize']);
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it('maps unexpected database failures to a fixed redacted status error', async () => {
    const f = fixture();
    vi.spyOn(f.deps.db.qboTransferOperation, 'findFirst')
      .mockRejectedValue(new Error(PRIVATE_PROVIDER_SENTINEL));

    await expect(
      getTransferOperation(OPERATION_ID, ACTOR, undefined, f.deps),
    ).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
      message: 'Stored transfer operation evidence is inconsistent.',
    });
  });
});

describe('commitTransfer', () => {
  it('maps unexpected default dependency bootstrap failures to a fixed redacted error', async () => {
    vi.doMock('../lib/qbo/factory.js', () => {
      throw new Error('PRIVATE_PROVIDER_SENTINEL_7419');
    });

    try {
      await expect(
        commitTransfer(OPERATION_ID, ACTOR),
      ).rejects.toMatchObject({
        code: 'OPERATION_CONFLICT',
        message: 'Stored transfer operation evidence is inconsistent.',
      });
    } finally {
      vi.doUnmock('../lib/qbo/factory.js');
    }
  });

  it('executes both legs sequentially with final dual-fence, auth, bindings, and exact before-image checks', async () => {
    const f = fixture();

    const result = await commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps);

    expect(result).toMatchObject({
      state: 'VERIFIED',
      complete: true,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(2);
    expect(f.fence).toHaveBeenCalledTimes(16);
    expect(f.renewLease).toHaveBeenCalledTimes(12);
    expect(f.fetchLineWriteSnapshot).toHaveBeenCalledTimes(6);
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
    expect(f.db.transactions.map((transaction) => transaction.status)).toEqual([
      'POSTED',
      'POSTED',
    ]);
    for (const [index, value] of f.prepared.entries()) {
      const sendEvent = `send:${value.requestId}`;
      const sendIndex = f.db.events.indexOf(sendEvent);
      const priorSendIndex = index === 0
        ? -1
        : f.db.events.indexOf(`send:${f.prepared[index - 1]!.requestId}`);
      const finalWindow = f.db.events.slice(priorSendIndex + 1, sendIndex);
      expect(finalWindow).toContain('renew');
      expect(finalWindow).toContain('fence');
      expect(finalWindow).toContain('authorize');
      expect(finalWindow).toContain('transaction:txn-in');
      expect(finalWindow).toContain('transaction:txn-out');
      expect(finalWindow).toContain(`snapshot:${value.qboId}`);
      expect(finalWindow.slice(-3)).toEqual([
        'transaction:txn-out',
        `attempt-update:${f.db.attempts[index]!.id}::won`,
        'db:transaction:commit',
      ]);
    }
  });

  it('accepts a prepared target line before an untouched trailing line', async () => {
    const f = fixture({ trailingUntouchedLine: true });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'VERIFIED',
      complete: true,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(2);
  });

  it('returns terminal VERIFIED replays without another QBO send or readback', async () => {
    const f = fixture();
    await commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps);
    f.sendPreparedLineWrite.mockClear();
    f.fetchLineWriteSnapshot.mockClear();

    const replay = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(replay.state).toBe('VERIFIED');
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.fetchLineWriteSnapshot).not.toHaveBeenCalled();
  });

  it('rechecks current authorization inside the final fence before the first send', async () => {
    const f = fixture();
    let authorizations = 0;
    f.authorize.mockImplementation(async () => {
      f.db.events.push('authorize');
      authorizations += 1;
      return authorizations < 4;
    });

    await expect(
      commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(authorizations).toBe(4);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'PREPARED',
      'PREPARED',
    ]);
  });

  it.each([
    ['revision', () => {
      const f = fixture();
      f.fetchLineWriteSnapshot.mockImplementationOnce(async (_type, qboId) => {
        f.db.events.push(`snapshot:${qboId}`);
        f.db.transactions[0]!.revision += 1;
        return clone(f.snapshots.get(qboId) ?? null);
      });
      return f;
    }, 'STALE_REVISION'],
    ['QBO binding', () => {
      const f = fixture();
      f.fetchLineWriteSnapshot.mockImplementationOnce(async (_type, qboId) => {
        f.db.events.push(`snapshot:${qboId}`);
        f.db.transactions[0]!.qboSyncToken = 'changed-locally';
        return clone(f.snapshots.get(qboId) ?? null);
      });
      return f;
    }, 'STALE_QBO_BINDING'],
  ] as const)(
    'rechecks both local %s values inside the final fence before sending',
    async (_label, setup, code) => {
      const f = setup();

      await expect(
        commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps),
      ).rejects.toMatchObject({ code });

      expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
      expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
        'RETRYABLE',
        'RETRYABLE',
      ]);
    },
  );

  it.each(['COMMITTING', 'UNCERTAIN'] as const)(
    'reconciles a %s first leg by readback without resending it',
    async (status) => {
      const f = fixture();
      f.db.attempts[0]!.status = status;
      f.snapshots.set(f.prepared[0].qboId, {
        ...f.prepared[0]!.expected,
        syncToken: '9',
      });

      const result = await commitTransfer(
        OPERATION_ID,
        ACTOR,
        undefined,
        undefined,
        f.deps,
      );

      expect(result.state).toBe('VERIFIED');
      expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(1);
      expect(f.sendPreparedLineWrite).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: f.prepared[1].requestId }),
        expect.any(Function),
      );
      expect(f.sendPreparedLineWrite).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: f.prepared[0].requestId }),
      );
    },
  );

  it('never sends leg two when leg one becomes uncertain and exposes only fixed bounded errors', async () => {
    const f = fixture();
    f.sendFailures.add(f.prepared[0].qboId);

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'UNCERTAIN',
      complete: false,
      firstLeg: { outcome: 'UNCERTAIN' },
      secondLeg: { outcome: 'IN_PROGRESS' },
      error: {
        code: 'QBO_WRITE_UNCERTAIN',
        message: 'A transfer write may have succeeded in QuickBooks. Verify the operation before retrying.',
      },
    });
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(1);
    expect(f.db.attempts[0]).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'QBO_WRITE_UNCERTAIN',
      errorMessage: 'A transfer write may have succeeded in QuickBooks. Verify the operation before retrying.',
    });
    const persistedAndReturned = JSON.stringify({
      result,
      errors: f.db.attempts.map((attempt) => ({
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
      })),
      auditMetadata: f.db.audits.map((audit) => audit.mutation),
    });
    expect(persistedAndReturned).not.toContain(PRIVATE_PROVIDER_SENTINEL);
  });

  it('preserves durable first-leg evidence when the second send becomes uncertain', async () => {
    const f = fixture();
    f.sendFailures.add(f.prepared[1].qboId);

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    const firstEvidence = clone(f.db.attempts[0]);

    expect(result).toMatchObject({
      state: 'UNCERTAIN',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'UNCERTAIN' },
    });
    expect(firstEvidence.status).toBe('VERIFIED');
    expect(f.db.transactions[0]!.status).toBe('POSTED');

    f.sendPreparedLineWrite.mockClear();
    await commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps);
    expect(f.db.attempts[0]).toEqual(firstEvidence);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: f.prepared[0].requestId }),
    );
  });

  it('projects an honest PARTIAL result when the second exact before-image has drifted', async () => {
    const f = fixture();
    f.markVerified(0);
    const firstEvidence = clone(f.db.attempts[0]);
    f.snapshots.set(f.prepared[1].qboId, {
      ...f.prepared[1]!.before,
      syncToken: '99',
      contentHash: hash('changed-content'),
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts[0]).toEqual(firstEvidence);
    expect(f.db.attempts[1]!.status).toBe('RETRYABLE');
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('persists exact unchanged readback as retryable evidence and never automatically resends it', async () => {
    const f = fixture();
    f.db.attempts[0]!.status = 'COMMITTING';

    const first = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    expect(first).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'UNCHANGED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts[0]).toMatchObject({
      status: 'UNCHANGED',
      verification: { outcome: 'UNCHANGED', status: 'PENDING' },
    });
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();

    f.fetchLineWriteSnapshot.mockClear();
    const replay = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    expect(replay.state).toBe('RETRYABLE');
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.fetchLineWriteSnapshot).not.toHaveBeenCalled();
  });

  it('blocks expired PREPARED sends but still reconciles an already-COMMITTING leg after expiry', async () => {
    const f = fixture({ expiresAt: new Date(NOW.getTime() - 1) });
    f.db.attempts[0]!.status = 'COMMITTING';
    f.snapshots.set(f.prepared[0].qboId, {
      ...f.prepared[0]!.expected,
      syncToken: '9',
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
      error: {
        code: 'TRANSFER_PARTIAL',
      },
    });
    expect(f.db.attempts[1]).toMatchObject({
      status: 'RETRYABLE',
      errorCode: 'OPERATION_EXPIRED',
    });
    expect(f.fetchLineWriteSnapshot).toHaveBeenCalledWith('Deposit', 'qbo-a-in');
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('rechecks expiry inside the final fence before sending a later leg', async () => {
    const expiresAt = new Date(NOW.getTime() + 1_000);
    const f = fixture({ expiresAt });
    let current = NOW;
    f.deps.now = () => current;
    f.fetchLineWriteSnapshot.mockImplementation(async (_type, qboId) => {
      f.db.events.push(`snapshot:${qboId}`);
      if (
        qboId === f.prepared[1].qboId
        && f.db.attempts[0]!.status === 'VERIFIED'
      ) {
        current = expiresAt;
      }
      return clone(f.snapshots.get(qboId) ?? null);
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts[1]).toMatchObject({
      status: 'RETRYABLE',
      errorCode: 'OPERATION_EXPIRED',
    });
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(1);
    expect(f.sendPreparedLineWrite).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: f.prepared[0].requestId }),
      expect.any(Function),
    );
  });

  it('blocks provider POST when token setup crosses operation expiry and drains every safely unsent leg', async () => {
    const expiresAt = new Date(NOW.getTime() + 1_000);
    const f = fixture({ expiresAt });
    let current = NOW;
    f.deps.now = () => current;
    const providerPost = vi.fn();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      preparedWrite,
      beforeSend,
    ) => {
      current = expiresAt;
      await beforeSend?.();
      providerPost();
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(providerPost).not.toHaveBeenCalled();
    expect(f.db.attempts).toMatchObject([
      { status: 'RETRYABLE', errorCode: 'OPERATION_EXPIRED' },
      { status: 'RETRYABLE', errorCode: 'OPERATION_EXPIRED' },
    ]);
  });

  it('requires an independent matching readback after a successful provider response', async () => {
    const f = fixture();
    f.fetchLineWriteSnapshot.mockClear();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      preparedWrite,
      beforeSend,
    ) => {
      await beforeSend?.();
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      f.snapshots.set(preparedWrite.qboId, {
        ...snapshot,
        contentHash: 'b'.repeat(64),
      });
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'UNCERTAIN',
      complete: false,
      firstLeg: { outcome: 'UNCERTAIN' },
      secondLeg: { outcome: 'IN_PROGRESS' },
    });
    expect(f.fetchLineWriteSnapshot).toHaveBeenCalledTimes(3);
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(1);
    expect(f.db.attempts[0]).toMatchObject({
      status: 'UNCERTAIN',
      responseSnapshot: expect.objectContaining({
        contentHash: f.prepared[0].expected.contentHash,
      }),
      verification: null,
    });

    f.db.attempts[0]!.updatedAt = new Date(NOW.getTime() - 120_000);
    f.snapshots.set(f.prepared[0].qboId, clone(f.prepared[0].before));
    f.sendPreparedLineWrite.mockClear();

    const recovery = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(recovery).toMatchObject({
      state: 'UNCERTAIN',
      firstLeg: { outcome: 'UNCERTAIN' },
      secondLeg: { outcome: 'IN_PROGRESS' },
    });
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.db.attempts[0]!.status).toBe('UNCERTAIN');
  });

  it('persists accepted provider evidence before waiting on independent readback', async () => {
    const f = fixture();
    let releaseReadback!: () => void;
    let announceReadback!: () => void;
    const readbackStarted = new Promise<void>((resolve) => {
      announceReadback = resolve;
    });
    const readbackRelease = new Promise<void>((resolve) => {
      releaseReadback = resolve;
    });
    let fetches = 0;
    f.fetchLineWriteSnapshot.mockImplementation(async (_type, qboId) => {
      fetches += 1;
      f.db.events.push(`snapshot:${qboId}`);
      if (fetches === 3) {
        announceReadback();
        await readbackRelease;
      }
      return clone(f.snapshots.get(qboId) ?? null);
    });

    const pending = commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    await readbackStarted;

    expect(f.db.attempts[0]).toMatchObject({
      status: 'COMMITTING',
      responseSnapshot: expect.objectContaining({
        contentHash: f.prepared[0].expected.contentHash,
      }),
    });

    releaseReadback();
    await expect(pending).resolves.toMatchObject({
      state: 'VERIFIED',
      complete: true,
    });
  });

  it('drains the second PREPARED authority when the first leg fails safely before claim', async () => {
    const f = fixture();
    f.getClient.mockRejectedValueOnce(new Error(PRIVATE_PROVIDER_SENTINEL));

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'RETRYABLE',
      'RETRYABLE',
    ]);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('drains every remaining PREPARED authority when recovery proves the first leg unchanged', async () => {
    const f = fixture();
    f.db.attempts[0]!.status = 'COMMITTING';
    f.db.attempts[0]!.updatedAt = new Date(NOW.getTime() - 120_000);

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'UNCHANGED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'UNCHANGED',
      'RETRYABLE',
    ]);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('expires every PREPARED authority even when local revision evidence has drifted', async () => {
    const f = fixture({ expiresAt: new Date(NOW.getTime() - 1) });
    f.db.transactions[0]!.revision += 1;

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'RETRYABLE',
      'RETRYABLE',
    ]);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('reconciles possible-write evidence after sync supersedes the local mirror', async () => {
    const f = fixture();
    f.db.attempts[0]!.status = 'COMMITTING';
    f.db.transactions[0]!.status = 'SUPERSEDED';
    f.db.transactions[0]!.qboSyncToken = '9';
    f.snapshots.set(f.prepared[0].qboId, {
      ...f.prepared[0]!.expected,
      syncToken: '9',
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'VERIFIED',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
    expect(f.db.attempts[0]!.status).toBe('VERIFIED');
    expect(f.db.transactions[0]).toMatchObject({
      status: 'POSTED',
      qboSyncToken: '9',
    });
    expect(f.fetchLineWriteSnapshot).toHaveBeenCalledWith(
      f.prepared[0].qboType,
      f.prepared[0].qboId,
    );
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: f.prepared[0].requestId }),
    );
  });

  it('does not treat a fresh COMMITTING exact-before readback as proof of no send', async () => {
    const f = fixture();
    f.db.attempts[0]!.status = 'COMMITTING';
    f.db.attempts[0]!.updatedAt = NOW;
    Object.assign(f.deps, { committingQuiescenceMs: 60_000 });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'IN_PROGRESS',
      firstLeg: { outcome: 'IN_PROGRESS' },
    });
    expect(f.db.attempts[0]!.status).toBe('COMMITTING');
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('renews both leases and durable sender activity while a prepared provider send is in flight', async () => {
    const f = fixture();
    Object.assign(f.deps, { heartbeatIntervalMs: 5 });
    f.sendPreparedLineWrite.mockImplementation(async (
      preparedWrite,
      beforeSend,
    ) => {
      await beforeSend?.();
      f.db.events.push(`send-start:${preparedWrite.requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      f.snapshots.set(preparedWrite.qboId, snapshot);
      f.db.events.push(`send-finish:${preparedWrite.requestId}`);
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    await expect(commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    )).resolves.toMatchObject({ state: 'VERIFIED' });

    for (const preparedWrite of f.prepared) {
      const start = f.db.events.indexOf(
        `send-start:${preparedWrite.requestId}`,
      );
      const finish = f.db.events.indexOf(
        `send-finish:${preparedWrite.requestId}`,
      );
      expect(f.db.events.slice(start + 1, finish)).toContain('renew');
      expect(f.db.events.slice(start + 1, finish)).toContain(
        `attempt-update:${f.db.attempts.find((attempt) =>
          attempt.requestId === preparedWrite.requestId
        )!.id}::won`,
      );
    }
  });

  it('rechecks COMMITTING authority immediately before provider POST after long setup', async () => {
    const f = fixture();
    let releaseSetup!: () => void;
    let announceSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      announceSetup = resolve;
    });
    const setupRelease = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const providerPost = vi.fn();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      preparedWrite,
      beforeSend,
    ) => {
      announceSetup();
      await setupRelease;
      await beforeSend?.();
      providerPost();
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      f.snapshots.set(preparedWrite.qboId, snapshot);
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    const pending = commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    await setupStarted;
    const attempt = f.db.attempts[0]!;
    const preparedWrite = attempt.requestPayload as QboPreparedLineWrite;
    attempt.status = 'UNCHANGED';
    attempt.responseSnapshot = clone(preparedWrite.before);
    attempt.verification = {
      outcome: 'UNCHANGED',
      status: 'PENDING',
    };
    releaseSetup();

    await expect(pending).resolves.toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'UNCHANGED' },
    });
    expect(providerPost).not.toHaveBeenCalled();
    expect(f.snapshots.get(preparedWrite.qboId)).toEqual(preparedWrite.before);
    expect(f.db.attempts[0]!.status).toBe('UNCHANGED');
  });

  it('blocks provider POST when local revision, binding, and status drift during long setup', async () => {
    const f = fixture();
    let releaseSetup!: () => void;
    let announceSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      announceSetup = resolve;
    });
    const setupRelease = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const providerPost = vi.fn();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      preparedWrite,
      beforeSend,
    ) => {
      announceSetup();
      await setupRelease;
      await beforeSend?.();
      providerPost();
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      f.snapshots.set(preparedWrite.qboId, snapshot);
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    const pending = commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );
    await setupStarted;
    Object.assign(f.db.transactions[0]!, {
      revision: f.db.transactions[0]!.revision + 1,
      qboSyncToken: 'sync-drift-generic',
      status: 'SUPERSEDED',
    });
    releaseSetup();

    await expect(pending).resolves.toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(providerPost).not.toHaveBeenCalled();
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'RETRYABLE',
      'RETRYABLE',
    ]);
  });

  it('rechecks current company dry-run mode immediately before provider POST', async () => {
    const f = fixture();
    const providerPost = vi.fn();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      preparedWrite,
      beforeSend,
    ) => {
      for (const transaction of f.db.transactions) {
        transaction.company.dryRun = true;
      }
      await beforeSend?.();
      providerPost();
      const snapshot = {
        ...preparedWrite.expected,
        syncToken: `${Number(preparedWrite.before.syncToken) + 1}`,
      };
      return {
        ok: true,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'DRY_RUN',
      complete: true,
      firstLeg: { outcome: 'DRY_RUN' },
      secondLeg: { outcome: 'DRY_RUN' },
    });
    expect(providerPost).not.toHaveBeenCalled();
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'DRY_RUN',
      'DRY_RUN',
    ]);
  });

  it('terminalizes safely when dry-run mode turns back off after blocking provider POST', async () => {
    const f = fixture();
    const providerPost = vi.fn();
    f.sendPreparedLineWrite.mockImplementationOnce(async (
      _preparedWrite,
      beforeSend,
    ) => {
      for (const transaction of f.db.transactions) {
        transaction.company.dryRun = true;
      }
      try {
        await beforeSend?.();
      } finally {
        for (const transaction of f.db.transactions) {
          transaction.company.dryRun = false;
        }
      }
      providerPost();
      throw new Error('unreachable provider post');
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(providerPost).not.toHaveBeenCalled();
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'RETRYABLE',
      'RETRYABLE',
    ]);
  });

  it('reloads durable state after losing recovery ownership during a provider fetch', async () => {
    const f = fixture();
    f.db.attempts[0]!.status = 'COMMITTING';
    f.db.attempts[0]!.updatedAt = new Date(NOW.getTime() - 120_000);
    Object.assign(f.deps, { heartbeatIntervalMs: 5 });
    let renewals = 0;
    f.renewLease.mockImplementation(async () => {
      f.db.events.push('renew');
      renewals += 1;
      if (renewals < 2) return;
      const first = f.db.attempts[0]!;
      first.status = 'UNCHANGED';
      first.responseSnapshot = clone(f.prepared[0].before);
      first.verification = { outcome: 'UNCHANGED', status: 'PENDING' };
      f.db.attempts[1]!.status = 'RETRYABLE';
      throw new EntityLeaseError();
    });
    f.fetchLineWriteSnapshot.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ...f.prepared[0]!.expected,
        syncToken: '9',
      };
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'UNCHANGED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'UNCHANGED',
      'RETRYABLE',
    ]);
    expect(f.db.audits).toHaveLength(0);
  });

  it('finalizes both dry-run attempts and transactions consistently without any QBO call', async () => {
    const f = fixture({ dryRun: true });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'DRY_RUN',
      complete: true,
      firstLeg: { outcome: 'DRY_RUN' },
      secondLeg: { outcome: 'DRY_RUN' },
    });
    expect(f.getClient).not.toHaveBeenCalled();
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.fetchLineWriteSnapshot).not.toHaveBeenCalled();
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'DRY_RUN',
      'DRY_RUN',
    ]);
    expect(f.db.transactions.map((transaction) => transaction.status)).toEqual([
      'DRY_RUN',
      'DRY_RUN',
    ]);
    expect(f.db.audits).toHaveLength(2);
  });

  it('does not finalize dry-run after its fenced transaction crosses operation expiry', async () => {
    const expiresAt = new Date(NOW.getTime() + 1_000);
    const f = fixture({ dryRun: true, expiresAt });
    let current = NOW;
    f.deps.now = () => current;
    f.fence.mockImplementation(async () => {
      expect(f.db.transactionDepth).toBe(1);
      f.db.events.push('fence');
      current = expiresAt;
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'RETRYABLE',
      'RETRYABLE',
    ]);
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it('does not finalize dry-run when current company mode turns off inside its fence', async () => {
    const f = fixture({ dryRun: true });
    let fences = 0;
    f.fence.mockImplementation(async () => {
      expect(f.db.transactionDepth).toBe(1);
      f.db.events.push('fence');
      fences += 1;
      if (fences === 1) {
        for (const transaction of f.db.transactions) {
          transaction.company.dryRun = false;
        }
      }
    });

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'VERIFIED',
      complete: true,
    });
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(2);
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
  });

  it('reports a mixed durable and dry-run pair as incomplete partial state', async () => {
    const f = fixture({ dryRun: true });
    f.markVerified(0);

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      complete: false,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'DRY_RUN' },
      error: { code: 'TRANSFER_PARTIAL' },
    });
    expect(f.db.attempts.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'DRY_RUN',
    ]);
    expect(f.db.transactions.map((transaction) => transaction.status)).toEqual([
      'POSTED',
      'DRY_RUN',
    ]);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });

  it('updates verified attempt, transaction, and transfer audit inside one database transaction', async () => {
    const f = fixture();

    await commitTransfer(OPERATION_ID, ACTOR, undefined, {
      sourceOperationId: 'source-generic',
      operationId: 'mcp-generic',
      tokenPrefix: 'rct_generic',
    }, f.deps);

    expect(f.db.auditDepths).toEqual([1, 1]);
    expect(f.db.audits).toHaveLength(2);
    for (const audit of f.db.audits) {
      expect(audit).toMatchObject({
        action: 'transfer',
        mutation: {
          outcome: 'VERIFIED',
          references: {
            operation: 'transfer',
            accountQboIds: [expect.any(String)],
            taxCodeQboIds: [],
          },
          mcp: {
            sourceOperationId: 'source-generic',
            operationId: 'mcp-generic',
            tokenPrefix: 'rct_generic',
          },
        },
      });
      const serialized = JSON.stringify(audit.mutation);
      expect(serialized).not.toContain(PRIVATE_PROVIDER_SENTINEL);
      expect(serialized).not.toContain(PRIVATE_USER_SENTINEL);
      expect(serialized).not.toMatch(/requestPayload|beforeSnapshot|responseSnapshot|SyncToken|body/);
    }
  });

  it('keeps COMMITTING as the no-resend barrier when terminal finalization rolls back', async () => {
    const f = fixture();
    f.db.failAudit = true;

    const result = await commitTransfer(
      OPERATION_ID,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result.state).toBe('IN_PROGRESS');
    expect(f.sendPreparedLineWrite).toHaveBeenCalledTimes(1);
    expect(['COMMITTING', 'UNCERTAIN']).toContain(f.db.attempts[0]!.status);
    expect(f.db.transactions[0]!.status).not.toBe('POSTED');
    expect(f.db.audits).toHaveLength(0);
  });

  it('rejects corrupt coordinator/attempt identity with a fixed redacted error', async () => {
    const f = fixture();
    const attempt = f.db.attempts[0]!;
    const value = attempt.requestPayload as QboPreparedLineWrite;
    value.body.PrivateNote = 'TAMPERED_PROVIDER_VALUE';
    value.requestHash = hashLineWriteRequest(value.body);
    value.expected.contentHash = hashLineWriteContent(value.body);
    attempt.requestHash = value.requestHash;

    await expect(
      commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps),
    ).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
      message: 'Stored transfer operation evidence is inconsistent.',
    });
    await expect(
      commitTransfer(OPERATION_ID, ACTOR, undefined, undefined, f.deps),
    ).rejects.not.toThrow(PRIVATE_PROVIDER_SENTINEL);
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
  });
});

describe('retryTransferOperation', () => {
  it('rolls back the retry coordinator and replacement attempts when the final envelope hook fails', async () => {
    const f = fixture({
      firstStatus: 'RETRYABLE',
      secondStatus: 'RETRYABLE',
    });
    const operationsBefore = f.db.operations.length;
    const attemptsBefore = f.db.attempts.length;

    await expect(retryTransferOperationWithWorkflow(
      OPERATION_ID,
      ACTOR,
      {
        afterRetry: async () => {
          throw new Error('private retry envelope insert failed');
        },
      },
      undefined,
      f.deps,
    )).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });

    expect(f.db.operations).toHaveLength(operationsBefore);
    expect(f.db.attempts).toHaveLength(attemptsBefore);
  });

  it('rejects a synced retry pair whose current amounts are no longer equal and opposite', async () => {
    const f = fixture();
    for (const attempt of f.db.attempts) {
      attempt.status = 'RETRYABLE';
    }
    f.db.transactions[1]!.amount = '-125.00';
    const changedSecond = qboTxn({
      qboId: 'qbo-z-out',
      qboType: 'Purchase',
      syncToken: '4',
      amount: -125,
      bankAccount: 'Generic Operating',
      date: '2026-07-27',
    });
    f.fetchTxn.mockImplementation(async (
      _qboType: QboTxn['qboType'],
      qboId: string,
    ) => clone(qboId === changedSecond.qboId
      ? changedSecond
      : qboTxn({
          qboId: 'qbo-a-in',
          qboType: 'Deposit',
          syncToken: '8',
          amount: 124.5,
          bankAccount: 'Generic Reserve',
          date: '2026-07-29',
        })));

    await expect(retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    )).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });

    expect(f.db.operations).toHaveLength(1);
    expect(f.db.attempts).toHaveLength(2);
  });

  it('rejects a retry adapter candidate that mutates unrelated provider fields', async () => {
    const f = fixture();
    for (const attempt of f.db.attempts) {
      attempt.status = 'RETRYABLE';
    }
    f.prepareLineRecategorization.mockImplementation(async (
      txn: QboTxn,
      splits: { amount: number; accountQboId: string; memo?: string }[],
      requestId: string,
    ) => {
      const candidate = prepared(
        txn,
        splits[0]!.accountQboId,
        requestId,
      );
      candidate.body.PrivateNote = 'MUTATED_UNRELATED_FIELD';
      candidate.requestHash = hashLineWriteRequest(candidate.body);
      candidate.expected.contentHash = hashLineWriteContent(candidate.body);
      return candidate;
    });

    await expect(retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    )).rejects.toMatchObject({ code: 'QBO_STATE_DRIFT' });

    expect(f.db.operations).toHaveLength(1);
    expect(f.db.attempts).toHaveLength(2);
  });

  it('creates one idempotent child with deterministic replacement attempts when both parent legs are safely unsent', async () => {
    const f = fixture();
    for (const attempt of f.db.attempts) {
      attempt.status = 'RETRYABLE';
      attempt.errorCode = 'OPERATION_EXPIRED';
      attempt.errorMessage = 'expired';
    }

    const first = await retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    );
    const replay = await retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      operationId: RETRY_OPERATION_ID,
      retryOfId: OPERATION_ID,
      state: 'PREPARED',
    });
    expect(f.db.operations).toHaveLength(2);
    expect(f.db.operations[1]).toMatchObject({
      retryOfId: OPERATION_ID,
      firstAttemptRequestId: `${RETRY_OPERATION_ID}-t0`,
      secondAttemptRequestId: `${RETRY_OPERATION_ID}-t1`,
    });
    expect(f.db.attempts).toHaveLength(4);
    expect(f.db.attempts.slice(2).map((attempt) => attempt.status)).toEqual([
      'PREPARED',
      'PREPARED',
    ]);
  });

  it('inherits and re-proves a VERIFIED first leg while creating only the safe replacement leg', async () => {
    const f = fixture();
    f.markVerified(0);
    await expect(f.fetchTxn(
      f.prepared[0].qboType,
      f.prepared[0].qboId,
    )).resolves.toMatchObject({
      amount: 0,
      lines: [],
    });
    f.db.attempts[1]!.status = 'RETRYABLE';
    f.db.attempts[1]!.errorCode = 'QBO_STATE_DRIFT';
    f.db.attempts[1]!.errorMessage = 'drift';

    const child = await retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    );

    expect(child.operationId).toBe(RETRY_OPERATION_ID);
    expect(f.fetchLineWriteSnapshot).toHaveBeenCalledWith(
      f.prepared[0].qboType,
      f.prepared[0].qboId,
    );
    expect(f.db.operations[1]).toMatchObject({
      retryOfId: OPERATION_ID,
      firstAttemptRequestId: f.prepared[0].requestId,
      secondAttemptRequestId: `${RETRY_OPERATION_ID}-t1`,
    });
    expect(f.db.attempts).toHaveLength(3);
    expect(f.db.attempts[2]).toMatchObject({
      transactionId: f.db.attempts[1]!.transactionId,
      requestId: `${RETRY_OPERATION_ID}-t1`,
      status: 'PREPARED',
    });

    await expect(commitTransfer(
      child.operationId,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    )).resolves.toMatchObject({
      state: 'VERIFIED',
      complete: true,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
  });

  it('re-proves an inherited VERIFIED snapshot inside the child replacement pre-POST callback', async () => {
    const f = fixture();
    f.markVerified(0);
    f.db.attempts[1]!.status = 'RETRYABLE';
    f.db.attempts[1]!.errorCode = 'QBO_STATE_DRIFT';
    f.db.attempts[1]!.errorMessage = 'drift';
    const child = await retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      f.deps,
    );
    const inheritedResponse = f.db.attempts[0]!
      .responseSnapshot as QboLineWriteSnapshot;
    f.snapshots.set(f.prepared[0].qboId, {
      ...inheritedResponse,
      contentHash: 'a'.repeat(64),
    });
    f.sendPreparedLineWrite.mockClear();

    const result = await commitTransfer(
      child.operationId,
      ACTOR,
      undefined,
      undefined,
      f.deps,
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      complete: false,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect(f.db.events).not.toContain(
      `send:${RETRY_OPERATION_ID}-t1`,
    );
  });

  it('rejects uncertain parents and any retry chain beyond one child', async () => {
    const uncertain = fixture();
    uncertain.db.attempts[0]!.status = 'UNCERTAIN';

    await expect(retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      uncertain.deps,
    )).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(uncertain.db.operations).toHaveLength(1);

    const retried = fixture();
    for (const attempt of retried.db.attempts) {
      attempt.status = 'RETRYABLE';
    }
    const child = await retryTransferOperation(
      OPERATION_ID,
      ACTOR,
      undefined,
      retried.deps,
    );

    await expect(retryTransferOperation(
      child.operationId,
      ACTOR,
      undefined,
      retried.deps,
    )).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(retried.db.operations).toHaveLength(2);
  });
});
