import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  QboClient,
  QboPreparedLineWrite,
  QboTxn,
} from '../lib/qbo/types.js';
import {
  buildPreparedLineWrite,
  hashLineWriteContent,
  hashLineWriteRequest,
} from '../lib/qbo/lineWrite.js';
import {
  prepareTransfer,
  prepareTransferWithWorkflow,
  TransferOperationError,
  type PrepareTransferInput,
  type TransferOperationDb,
  type TransferOperationDeps,
  type TransferOperationRecord,
} from './transferOperations.js';

const NOW = new Date('2026-07-29T18:00:00.000Z');
const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const ACTOR = { id: 'user-generic', label: 'Generic User' };

interface StoredAttempt {
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
  date: Date;
  company: {
    id: string;
    disconnectedAt: Date | null;
    holdingAccountIds: string[];
  };
}

interface StoredAccount {
  qboId: string;
  name: string;
  active: boolean;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function qboTxn(
  overrides: Partial<QboTxn> & Pick<QboTxn, 'qboId' | 'amount' | 'bankAccount'>,
): QboTxn {
  const qboType = overrides.qboType ?? 'Purchase';
  const syncToken = overrides.syncToken ?? '4';
  const date = overrides.date ?? '2026-07-28';
  const holdingLine = qboType === 'Purchase'
    ? {
        Id: 'holding-line',
        Amount: Math.abs(overrides.amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'holding-1', name: 'Holding' },
        },
      }
    : {
        Id: 'holding-line',
        Amount: Math.abs(overrides.amount),
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'holding-1', name: 'Holding' },
          Entity: { value: 'payer-1', name: 'Generic Payer' },
        },
      };
  const untouchedLine = qboType === 'Purchase'
    ? {
        Id: 'untouched-line',
        Amount: 7.25,
        Description: 'Untouched purchase line',
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'expense-existing', name: 'Existing Expense' },
          ClassRef: { value: 'class-existing', name: 'Existing Class' },
        },
      }
    : {
        Id: 'untouched-line',
        Amount: 7.25,
        Description: 'Untouched deposit line',
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'income-existing', name: 'Existing Income' },
          Entity: { value: 'payer-2', name: 'Existing Payer' },
        },
      };
  return {
    qboType,
    syncToken,
    date,
    payee: 'Generic Counterparty',
    lines: [{
      id: 'holding-line',
      amount: Math.abs(overrides.amount),
      accountQboId: 'holding-1',
      accountName: 'Holding',
    }],
    raw: {
      Id: overrides.qboId,
      SyncToken: syncToken,
      TxnDate: date,
      PrivateNote: 'Preserve this top-level note',
      ...(qboType === 'Purchase'
        ? { AccountRef: { value: 'bank-purchase', name: overrides.bankAccount } }
        : { DepositToAccountRef: { value: 'bank-deposit', name: overrides.bankAccount } }),
      Line: [holdingLine, untouchedLine],
    },
    ...overrides,
  };
}

function preparedWrite(
  txn: QboTxn,
  requestId: string,
  targetAccountQboId: string,
  bodyAmount = txn.amount,
  memo?: string,
): QboPreparedLineWrite {
  return buildPreparedLineWrite({
    txn,
    splits: [{
      amount: bodyAmount,
      accountQboId: targetAccountQboId,
      ...(memo === undefined ? {} : { memo }),
    }],
    requestId,
    holdingAccountQboIds: ['holding-1'],
  });
}

function rehashPrepared(prepared: QboPreparedLineWrite): QboPreparedLineWrite {
  prepared.requestHash = hashLineWriteRequest(prepared.body);
  prepared.expected.contentHash = hashLineWriteContent(prepared.body);
  return prepared;
}

function input(overrides: Partial<PrepareTransferInput> = {}): PrepareTransferInput {
  return {
    companyId: 'company-generic',
    transactionId: 'txn-out',
    counterpartTransactionId: 'txn-in',
    expectedRevision: 7,
    counterpartExpectedRevision: 9,
    idempotencyKey: ' transfer-generic ',
    actor: ACTOR,
    ...overrides,
  };
}

class FakeTransferDb implements TransferOperationDb {
  transactions: StoredTransaction[] = [
    {
      id: 'txn-out',
      companyId: 'company-generic',
      qboId: 'qbo-z-out',
      qboType: 'Purchase',
      qboSyncToken: '4',
      revision: 7,
      status: 'PENDING',
      amount: '-124.50',
      bankAccount: 'Operating',
      memo: 'Internal reference one',
      date: new Date('2026-07-27T00:00:00.000Z'),
      company: {
        id: 'company-generic',
        disconnectedAt: null,
        holdingAccountIds: ['holding-1'],
      },
    },
    {
      id: 'txn-in',
      companyId: 'company-generic',
      qboId: 'qbo-a-in',
      qboType: 'Deposit',
      qboSyncToken: '8',
      revision: 9,
      status: 'PENDING',
      amount: '124.50',
      bankAccount: 'Reserve',
      memo: 'Internal reference two',
      date: new Date('2026-07-29T23:59:59.999Z'),
      company: {
        id: 'company-generic',
        disconnectedAt: null,
        holdingAccountIds: ['holding-1'],
      },
    },
  ];
  accounts: StoredAccount[] = [
    { qboId: 'account-operating', name: 'Operating', active: true },
    { qboId: 'account-reserve', name: 'Reserve', active: true },
  ];
  operations: TransferOperationRecord[] = [];
  attempts: StoredAttempt[] = [];
  events: string[] = [];
  failAttemptInsert = false;
  transactionCount = 0;
  transactionDepth = 0;

  transaction: TransferOperationDb['transaction'] = {
    findUnique: async ({ where }) => {
      this.events.push(`transaction:${where.id}`);
      return structuredClone(
        this.transactions.find((candidate) => candidate.id === where.id) ?? null,
      );
    },
  };

  qboAccount: TransferOperationDb['qboAccount'] = {
    findMany: async ({ where }) => {
      this.events.push('accounts');
      const names = where.name.in;
      return structuredClone(this.accounts.filter((candidate) =>
        candidate.active === where.active
        && candidate.name !== ''
        && names.includes(candidate.name)
      ));
    },
  };

  qboMutationAttempt: TransferOperationDb['qboMutationAttempt'] = {
    findFirst: async ({ where }) => {
      const statuses = typeof where.status === 'object'
        ? where.status.in
        : where.status === undefined ? null : [where.status];
      return structuredClone(this.attempts.find((candidate) =>
        (where.transactionId === undefined || candidate.transactionId === where.transactionId)
        && (where.requestId === undefined || candidate.requestId === where.requestId)
        && (statuses === null || statuses.includes(candidate.status))
      ) ?? null);
    },
    findMany: async ({ where }) => structuredClone(this.attempts.filter((candidate) =>
      where.requestId.in.includes(candidate.requestId)
    )),
    createMany: async ({ data }) => {
      if (this.failAttemptInsert) throw new Error('attempt insert failed');
      let count = 0;
      for (const candidate of data) {
        if (this.attempts.some((attempt) => attempt.requestId === candidate.requestId)) continue;
        this.attempts.push({
          id: `attempt-${this.attempts.length + 1}`,
          responseSnapshot: null,
          verification: null,
          errorCode: null,
          errorMessage: null,
          ...structuredClone(candidate),
        });
        count += 1;
      }
      return { count };
    },
  };

  qboTransferOperation: TransferOperationDb['qboTransferOperation'] = {
    findFirst: async ({ where }) => structuredClone(this.operations.find((candidate) =>
      (where.id === undefined || candidate.id === where.id)
      && (where.actorId === undefined || candidate.actorId === where.actorId)
      && (where.companyId === undefined || candidate.companyId === where.companyId)
      && (where.idempotencyHash === undefined
        || candidate.idempotencyHash === where.idempotencyHash)
      && (where.OR === undefined || where.OR.some((pair) =>
        candidate.firstTransactionId === pair.firstTransactionId
        && candidate.secondTransactionId === pair.secondTransactionId
      ))
    ) ?? null),
    createMany: async ({ data }) => {
      const conflicts = this.operations.some((candidate) =>
        candidate.id === data.id
        || (
          candidate.actorId === data.actorId
          && candidate.companyId === data.companyId
          && candidate.firstTransactionId === data.firstTransactionId
          && candidate.secondTransactionId === data.secondTransactionId
          && candidate.idempotencyHash === data.idempotencyHash
        )
      );
      if (conflicts) return { count: 0 };
      this.operations.push({
        ...structuredClone(data),
        retryOfId: data.retryOfId ?? null,
        createdAt: NOW,
      });
      return { count: 1 };
    },
  };

  async $transaction<T>(callback: (tx: TransferOperationDb) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.transactionDepth += 1;
    const operationsBefore = structuredClone(this.operations);
    const attemptsBefore = structuredClone(this.attempts);
    try {
      return await callback(this);
    } catch (error) {
      this.operations = operationsBefore;
      this.attempts = attemptsBefore;
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function fixture(overrides: Partial<TransferOperationDeps> = {}) {
  const db = new FakeTransferDb();
  const fresh = new Map<string, QboTxn>([
    ['qbo-z-out', qboTxn({
      qboId: 'qbo-z-out',
      qboType: 'Purchase',
      syncToken: '4',
      date: '2026-07-27',
      amount: -124.5,
      bankAccount: 'Operating',
    })],
    ['qbo-a-in', qboTxn({
      qboId: 'qbo-a-in',
      qboType: 'Deposit',
      syncToken: '8',
      date: '2026-07-29',
      amount: 124.5,
      bankAccount: 'Reserve',
    })],
  ]);
  const fetchTxn = vi.fn(async (_qboType: QboTxn['qboType'], qboId: string) =>
    structuredClone(fresh.get(qboId) ?? null));
  const prepareLineRecategorization = vi.fn(
    async (
      txn: QboTxn,
      splits: { amount: number; accountQboId: string; memo?: string }[],
      requestId: string,
    ) => preparedWrite(
      txn,
      requestId,
      splits[0]!.accountQboId,
      txn.amount,
      splits[0]!.memo,
    ),
  );
  const sendPreparedLineWrite = vi.fn(async () => {
    throw new Error('preparation must never send');
  });
  const client = {
    fetchTxn,
    prepareLineRecategorization,
    sendPreparedLineWrite,
  } as unknown as QboClient;
  const authorize = vi.fn(async () => {
    db.events.push('authorize');
    return true;
  });
  const lease = vi.fn(async (
    _keys: Parameters<TransferOperationDeps['lease']>[0],
    _owner: string,
    callback: () => Promise<unknown>,
  ) => callback());
  const fence = vi.fn(async () => undefined);
  const deps: TransferOperationDeps = {
    db,
    getClient: vi.fn(async () => client),
    authorize,
    lease: lease as TransferOperationDeps['lease'],
    fence,
    invocationId: () => 'invocation-generic',
    operationId: () => OPERATION_ID,
    now: () => NOW,
    ...overrides,
  };
  return {
    db,
    fresh,
    fetchTxn,
    prepareLineRecategorization,
    sendPreparedLineWrite,
    authorize,
    lease,
    fence,
    deps,
  };
}

describe('prepareTransfer', () => {
  it('atomically prepares canonical durable attempts with exact QBO evidence and no sends', async () => {
    const f = fixture();

    const result = await prepareTransfer(input(), f.deps);

    expect(result).toEqual({
      operationId: OPERATION_ID,
      state: 'PREPARED',
      expiresAt: '2026-07-29T18:15:00.000Z',
      preview: {
        action: 'record_transfer',
        direction: 'between_accounts',
        totalCents: 12450,
        legCount: 2,
        preparationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(f.lease).toHaveBeenCalledWith([
      { companyId: 'company-generic', qboType: 'Deposit', qboId: 'qbo-a-in' },
      { companyId: 'company-generic', qboType: 'Purchase', qboId: 'qbo-z-out' },
    ], 'invocation-generic', expect.any(Function));
    expect(f.fence).toHaveBeenCalledWith([
      { companyId: 'company-generic', qboType: 'Deposit', qboId: 'qbo-a-in' },
      { companyId: 'company-generic', qboType: 'Purchase', qboId: 'qbo-z-out' },
    ], 'invocation-generic', f.db);
    expect(f.prepareLineRecategorization).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        qboType: 'Deposit',
        qboId: 'qbo-a-in',
        syncToken: '8',
        amount: 124.5,
      }),
      [{ amount: 124.5, accountQboId: 'account-operating', memo: 'Internal reference two' }],
      `${OPERATION_ID}-t0`,
    );
    expect(f.prepareLineRecategorization).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        qboType: 'Purchase',
        qboId: 'qbo-z-out',
        syncToken: '4',
        amount: -124.5,
      }),
      [{ amount: -124.5, accountQboId: 'account-reserve', memo: 'Internal reference one' }],
      `${OPERATION_ID}-t1`,
    );
    expect(f.sendPreparedLineWrite).not.toHaveBeenCalled();
    expect(f.db.operations).toHaveLength(1);
    expect(f.db.attempts).toHaveLength(2);
    for (const attempt of f.db.attempts) {
      expect(attempt.requestId).toMatch(/^[A-Za-z0-9-]+$/);
      expect(encodeURIComponent(attempt.requestId).length).toBeLessThanOrEqual(50);
    }
    expect(f.db.attempts).toEqual([
      expect.objectContaining({
        transactionId: 'txn-in',
        requestId: `${OPERATION_ID}-t0`,
        operation: 'transfer',
        status: 'PREPARED',
        expectedRevision: 9,
        expectedSyncToken: '8',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestPayload: expect.objectContaining({
          operation: 'transfer',
          qboType: 'Deposit',
          qboId: 'qbo-a-in',
          requestId: `${OPERATION_ID}-t0`,
        }),
        beforeSnapshot: expect.objectContaining({
          qboType: 'Deposit',
          qboId: 'qbo-a-in',
          syncToken: '8',
        }),
      }),
      expect.objectContaining({
        transactionId: 'txn-out',
        requestId: `${OPERATION_ID}-t1`,
        operation: 'transfer',
        status: 'PREPARED',
        expectedRevision: 7,
        expectedSyncToken: '4',
        requestPayload: expect.objectContaining({
          operation: 'transfer',
          qboType: 'Purchase',
          qboId: 'qbo-z-out',
          requestId: `${OPERATION_ID}-t1`,
        }),
        beforeSnapshot: expect.objectContaining({
          qboType: 'Purchase',
          qboId: 'qbo-z-out',
          syncToken: '4',
        }),
      }),
    ]);
  });

  it('authorizes before detail reads and discloses no target details when authorization is denied', async () => {
    const f = fixture({
      authorize: vi.fn(async (_actorId, _companyId, authorization) => {
        f.db.events.push(`authorize:${authorization.kind}`);
        return false;
      }),
    });

    await expect(prepareTransfer(input({
      authorization: {
        kind: 'mcp',
        tokenId: 'token-generic',
        tokenPrefix: 'rct_generic1',
      },
    }), f.deps)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to prepare this transfer.',
    });

    expect(f.db.events).toEqual(['authorize:mcp']);
    expect(f.fetchTxn).not.toHaveBeenCalled();
    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('returns an exact authorized replay before mutable revision and status validation', async () => {
    const f = fixture();
    const first = await prepareTransfer(input(), f.deps);
    f.db.transactions[0]!.revision = 100;
    f.db.transactions[0]!.status = 'POSTED';
    f.db.transactions[1]!.revision = 101;
    f.db.transactions[1]!.status = 'ERROR';
    f.fetchTxn.mockClear();
    f.prepareLineRecategorization.mockClear();
    const authorizationsBeforeReplay = f.authorize.mock.calls.length;

    const replay = await prepareTransfer(input(), f.deps);

    expect(replay).toEqual(first);
    expect(f.authorize.mock.calls.length - authorizationsBeforeReplay).toBe(1);
    expect(f.fetchTxn).not.toHaveBeenCalled();
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
    expect(f.db.operations).toHaveLength(1);
    expect(f.db.attempts).toHaveLength(2);
  });

  it('rejects conflicting idempotency reuse before preparing either QBO leg', async () => {
    const f = fixture();
    await prepareTransfer(input(), f.deps);
    f.fetchTxn.mockClear();
    f.prepareLineRecategorization.mockClear();

    await expect(prepareTransfer(input({
      counterpartExpectedRevision: 10,
    }), f.deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(f.fetchTxn).not.toHaveBeenCalled();
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
    expect(f.db.operations).toHaveLength(1);
    expect(f.db.attempts).toHaveLength(2);
  });

  it.each([
    ['same transaction', () => input({ counterpartTransactionId: 'txn-out' }), 'INVALID_TRANSFER_PAIR'],
    ['different company', () => {
      const f = fixture();
      f.db.transactions[1]!.companyId = 'company-other';
      return { f, value: input() };
    }, 'TRANSACTION_NOT_FOUND'],
    ['same sign', () => {
      const f = fixture();
      f.db.transactions[1]!.amount = '-124.50';
      return { f, value: input() };
    }, 'INVALID_TRANSFER_PAIR'],
    ['different cents', () => {
      const f = fixture();
      f.db.transactions[1]!.amount = '124.51';
      return { f, value: input() };
    }, 'INVALID_TRANSFER_PAIR'],
    ['same bank account', () => {
      const f = fixture();
      f.db.transactions[1]!.bankAccount = 'Operating';
      return { f, value: input() };
    }, 'INVALID_TRANSFER_PAIR'],
    ['outside three days', () => {
      const f = fixture();
      f.db.transactions[1]!.date = new Date('2026-07-30T00:00:00.001Z');
      return { f, value: input() };
    }, 'INVALID_TRANSFER_PAIR'],
  ] as const)('rejects an invalid pair: %s', async (_label, setup, code) => {
    const value = setup();
    const f = 'f' in value ? value.f : fixture();
    const request = 'value' in value ? value.value : value;
    await expect(prepareTransfer(request, f.deps)).rejects.toMatchObject({ code });
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
  });

  it.each([
    ['first revision', 8, 9, 'PENDING', 'PENDING', 'STALE_REVISION'],
    ['second revision', 7, 8, 'PENDING', 'PENDING', 'STALE_REVISION'],
    ['first status', 7, 9, 'POSTED', 'PENDING', 'INVALID_STATUS'],
    ['second status', 7, 9, 'PENDING', 'ERROR', 'INVALID_STATUS'],
  ])('validates both expected revisions and PENDING statuses: %s', async (
    _label,
    firstRevision,
    secondRevision,
    firstStatus,
    secondStatus,
    code,
  ) => {
    const f = fixture();
    f.db.transactions[0]!.revision = firstRevision as number;
    f.db.transactions[1]!.revision = secondRevision as number;
    f.db.transactions[0]!.status = firstStatus as string;
    f.db.transactions[1]!.status = secondStatus as string;

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({ code });
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['inactive-only', [
      { qboId: 'account-operating', name: 'Operating', active: false },
      { qboId: 'account-reserve', name: 'Reserve', active: true },
    ]],
    ['ambiguous', [
      { qboId: 'account-operating-a', name: 'Operating', active: true },
      { qboId: 'account-operating-b', name: 'Operating', active: true },
      { qboId: 'account-reserve', name: 'Reserve', active: true },
    ]],
  ])('requires exactly one active target account per counterpart bank name: %s', async (
    _label,
    accounts,
  ) => {
    const f = fixture();
    f.db.accounts = accounts as StoredAccount[];

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'TARGET_ACCOUNT_INVALID',
    });
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
  });

  it.each([
    ['type', () => ({ qboType: 'JournalEntry' as const }), 'STALE_QBO_BINDING'],
    ['ID', () => ({ qboId: 'qbo-other' }), 'STALE_QBO_BINDING'],
    ['SyncToken', () => ({ syncToken: '99' }), 'STALE_QBO_BINDING'],
    ['date', () => ({ date: '2026-07-28' }), 'STALE_QBO_BINDING'],
    ['bank account', () => ({ bankAccount: 'Different Reserve' }), 'STALE_QBO_BINDING'],
    ['holding cents', () => ({ amount: 124.49, lines: [{
      id: 'holding-line',
      amount: 124.49,
      accountQboId: 'holding-1',
      accountName: 'Holding',
    }] }), 'STALE_QBO_AMOUNT'],
    ['holding-line sum', () => ({ lines: [{
      id: 'holding-line',
      amount: 124.49,
      accountQboId: 'holding-1',
      accountName: 'Holding',
    }] }), 'STALE_QBO_AMOUNT'],
  ])('rejects stale current QBO %s evidence', async (_label, changes, code) => {
    const f = fixture();
    const fresh = f.fresh.get('qbo-a-in')!;
    f.fresh.set('qbo-a-in', { ...fresh, ...changes() });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({ code });
    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('blocks preparation when either transaction has an active mutation attempt', async () => {
    const f = fixture();
    f.db.attempts.push({
      id: 'attempt-existing',
      transactionId: 'txn-in',
      requestId: 'request-existing',
      operation: 'categorization',
      status: 'PREPARED',
      expectedRevision: 9,
      expectedSyncToken: '8',
      requestHash: sha('existing'),
      requestPayload: {},
      beforeSnapshot: {},
      responseSnapshot: null,
      verification: null,
      errorCode: null,
      errorMessage: null,
    });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'ACTIVE_ATTEMPT',
    });
    expect(f.prepareLineRecategorization).not.toHaveBeenCalled();
  });

  it('keeps both QBO fetches and preparations outside interactive database transactions', async () => {
    const f = fixture();
    f.fetchTxn.mockImplementation(async (_qboType, qboId) => {
      expect(f.db.transactionDepth).toBe(0);
      return structuredClone(f.fresh.get(qboId) ?? null);
    });
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => {
      expect(f.db.transactionDepth).toBe(0);
      return preparedWrite(
        txn,
        requestId,
        splits[0]!.accountQboId,
        txn.amount,
        splits[0]!.memo,
      );
    });

    await prepareTransfer(input(), f.deps);

    expect(f.fetchTxn).toHaveBeenCalledTimes(2);
    expect(f.prepareLineRecategorization).toHaveBeenCalledTimes(2);
  });

  it('rejects self-consistent prepared bodies whose target lines do not preserve the exact holding cents', async () => {
    const f = fixture();
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => preparedWrite(
      txn,
      requestId,
      splits[0]!.accountQboId,
      99,
      splits[0]!.memo,
    ));

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'STALE_QBO_AMOUNT',
    });

    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('rejects a decoy target ID outside the entity-specific AccountRef path', async () => {
    const f = fixture();
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => {
      const prepared = preparedWrite(
        txn,
        requestId,
        splits[0]!.accountQboId,
        txn.amount,
        splits[0]!.memo,
      );
      const detailKey = txn.qboType === 'Purchase'
        ? 'AccountBasedExpenseLineDetail'
        : txn.qboType === 'Deposit'
          ? 'DepositLineDetail'
          : 'JournalEntryLineDetail';
      const line = (prepared.body.Line as Record<string, unknown>[]).find(
        (candidate) => {
          const candidateDetail = candidate[detailKey] as
            | Record<string, unknown>
            | undefined;
          const accountRef = candidateDetail?.AccountRef as
            | Record<string, unknown>
            | undefined;
          return accountRef?.value === splits[0]!.accountQboId;
        },
      )!;
      const detail = line[detailKey] as Record<string, unknown>;
      detail.AccountRef = { value: 'account-wrong' };
      detail.ClassRef = { value: splits[0]!.accountQboId };
      prepared.requestHash = hashLineWriteRequest(prepared.body);
      prepared.expected.contentHash = hashLineWriteContent(prepared.body);
      return prepared;
    });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'TARGET_ACCOUNT_INVALID',
    });

    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it.each([
    ['an extra target line', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines.push(structuredClone(lines.at(-1)!));
    }],
    ['a retained holding line', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines.splice(lines.length - 1, 0, {
        Id: 'holding-retained',
        Amount: 124.5,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: 'holding-1', name: 'Holding' },
        },
      });
    }],
    ['a dropped untouched line', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      prepared.body.Line = lines.filter((line) => line.Id !== 'untouched-line');
    }],
    ['a changed untouched line', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines[0] = { ...lines[0]!, Description: 'Changed by corrupt preparer' };
    }],
    ['a changed top-level date', (prepared: QboPreparedLineWrite) => {
      prepared.body.TxnDate = '2026-07-30';
    }],
    ['a changed top-level account', (prepared: QboPreparedLineWrite) => {
      prepared.body.DepositToAccountRef = {
        value: 'bank-other',
        name: 'Different Reserve',
      };
    }],
    ['a missing requested memo', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      delete lines.at(-1)!.Description;
    }],
    ['the wrong requested memo', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines.at(-1)!.Description = 'Wrong memo from corrupt preparer';
    }],
    ['the wrong detail shape', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines.at(-1)!.DetailType = 'AccountBasedExpenseLineDetail';
    }],
  ])('rejects a self-consistent corrupt preparer with %s', async (
    _label,
    mutate,
  ) => {
    const f = fixture();
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => {
      const prepared = preparedWrite(
        txn,
        requestId,
        splits[0]!.accountQboId,
        txn.amount,
        splits[0]!.memo,
      );
      if (txn.qboType === 'Deposit') {
        mutate(prepared);
        rehashPrepared(prepared);
      }
      return prepared;
    });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'STALE_QBO_AMOUNT',
    });
    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it.each([
    ['top-level content', (prepared: QboPreparedLineWrite) => {
      prepared.body.PrivateNote = 'Cross-leg adapter mutation';
    }, (stored: QboPreparedLineWrite) => {
      expect(stored.body.PrivateNote).toBe('Preserve this top-level note');
    }],
    ['an untouched line', (prepared: QboPreparedLineWrite) => {
      const lines = prepared.body.Line as Record<string, unknown>[];
      lines[0] = {
        ...lines[0]!,
        Description: 'Cross-leg adapter mutation',
      };
    }, (stored: QboPreparedLineWrite) => {
      expect(stored.body.Line).toEqual(expect.arrayContaining([
        expect.objectContaining({
          Id: 'untouched-line',
          Description: 'Untouched deposit line',
        }),
      ]));
    }],
  ] as const)('detaches validated first-leg writes before the adapter mutates %s', async (
    _label,
    mutate,
    assertStored,
  ) => {
    const f = fixture();
    let firstCandidate: QboPreparedLineWrite | undefined;
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => {
      const prepared = preparedWrite(
        txn,
        requestId,
        splits[0]!.accountQboId,
        txn.amount,
        splits[0]!.memo,
      );
      if (firstCandidate === undefined) {
        firstCandidate = prepared;
      } else {
        mutate(firstCandidate);
        rehashPrepared(firstCandidate);
      }
      return prepared;
    });

    await prepareTransfer(input(), f.deps);

    const stored = f.db.attempts[0]!.requestPayload as QboPreparedLineWrite;
    assertStored(stored);
    expect(stored.requestHash).toBe(hashLineWriteRequest(stored.body));
    expect(stored.expected.contentHash).toBe(
      hashLineWriteContent(stored.body),
    );
  });

  it('rejects holding-account configuration drift before durable insertion', async () => {
    const f = fixture();
    let preparedCount = 0;
    f.prepareLineRecategorization.mockImplementation(async (
      txn,
      splits,
      requestId,
    ) => {
      const prepared = preparedWrite(
        txn,
        requestId,
        splits[0]!.accountQboId,
        txn.amount,
        splits[0]!.memo,
      );
      preparedCount += 1;
      if (preparedCount === 2) {
        for (const transaction of f.db.transactions) {
          transaction.company.holdingAccountIds = ['holding-changed'];
        }
      }
      return prepared;
    });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'STALE_QBO_BINDING',
    });

    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('rolls back the coordinator when either attempt cannot be inserted', async () => {
    const f = fixture();
    f.db.failAttemptInsert = true;

    await expect(prepareTransfer(input(), f.deps)).rejects.toThrow('attempt insert failed');

    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('rolls back both attempts and the coordinator when the final envelope hook fails', async () => {
    const f = fixture();
    const afterPrepare = vi.fn(async (store: TransferOperationDb) => {
      expect(f.db.transactionDepth).toBeGreaterThan(0);
      expect(f.db.operations).toHaveLength(1);
      expect(f.db.attempts).toHaveLength(2);
      expect(store).toBe(f.db);
      throw new Error('private envelope insert failed');
    });

    await expect(prepareTransferWithWorkflow(input(), {
      afterPrepare,
    }, f.deps)).rejects.toThrow('private envelope insert failed');

    expect(afterPrepare).toHaveBeenCalledOnce();
    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('rejects a generated operation ID whose deterministic request IDs would exceed 128 characters', async () => {
    const f = fixture({ operationId: () => 'o'.repeat(126) });

    await expect(prepareTransfer(input(), f.deps)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    expect(f.db.operations).toEqual([]);
    expect(f.db.attempts).toEqual([]);
  });

  it('returns a bounded preview without transaction IDs, account names, memos, or raw bodies', async () => {
    const f = fixture();

    const result = await prepareTransfer(input(), f.deps);
    const serialized = JSON.stringify(result);

    expect(Object.keys(result.preview).sort()).toEqual([
      'action',
      'direction',
      'legCount',
      'preparationDigest',
      'totalCents',
    ]);
    for (const privateValue of [
      'txn-out',
      'txn-in',
      'qbo-z-out',
      'qbo-a-in',
      'Operating',
      'Reserve',
      'Internal reference one',
      'Internal reference two',
      '"Line"',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(1_000);
  });
});
