import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  type Prisma,
} from '@prisma/client';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildPreparedLineWrite,
} from '../lib/qbo/lineWrite.js';
import type {
  QboClient,
  QboPreparedLineWrite,
  QboPreparedWrite,
  QboPurchaseSnapshot,
  QboTxn,
} from '../lib/qbo/types.js';
import {
  fenceEntityLeaseOwnerships,
  withEntityLeases,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
} from './entityLease.js';
import {
  prepareTransfer,
  type PrepareTransferInput,
  type TransferOperationDb,
  type TransferOperationDeps,
} from './transferOperations.js';
import {
  commitStagedCategorization,
  hashPreparedWriteBody,
  type DurableWritebackDb,
  type DurableWritebackDeps,
} from './writeback.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface Fixture {
  companyId: string;
  actorId: string;
  input: PrepareTransferInput;
  transactionIds: [string, string];
  qboIds: [string, string];
  accountQboIds: [string, string];
  fresh: Map<string, QboTxn>;
}

function preparedWrite(
  txn: QboTxn,
  accountQboId: string,
  requestId: string,
  memo?: string,
): QboPreparedLineWrite {
  return buildPreparedLineWrite({
    txn,
    splits: [{
      amount: txn.amount,
      accountQboId,
      ...(memo === undefined ? {} : { memo }),
    }],
    requestId,
    holdingAccountQboIds: ['holding-generic'],
  });
}

function storeOf(
  value: PrismaClient | Prisma.TransactionClient,
): TransferOperationDb {
  return value as unknown as TransferOperationDb;
}

function rootStore(
  client: PrismaClient,
  wrapTransaction: (
    transaction: Prisma.TransactionClient,
  ) => TransferOperationDb = storeOf,
): TransferOperationDb {
  const store = storeOf(client);
  return {
    transaction: store.transaction,
    qboAccount: store.qboAccount,
    qboMutationAttempt: store.qboMutationAttempt,
    qboTransferOperation: store.qboTransferOperation,
    $transaction: (callback) =>
      client.$transaction(
        (transaction) => callback(wrapTransaction(transaction)),
        { timeout: 30_000 },
      ),
  };
}

describePostgres('transfer operation PostgreSQL durability', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;

  beforeAll(() => {
    firstClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    secondClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterAll(async () => {
    await Promise.all([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
    ]);
  });

  async function seed(): Promise<Fixture> {
    const suffix = randomUUID();
    const actor = await firstClient.user.create({
      data: {
        email: `transfer-${suffix}@example.invalid`,
        name: 'Generic Transfer Actor',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `transfer-pg-${suffix}`,
        legalName: 'Generic Transfer Company',
        nickname: `transfer-${suffix.slice(0, 8)}`,
        dryRun: false,
        holdingAccountIds: ['holding-generic'],
      },
    });
    await firstClient.membership.create({
      data: {
        userId: actor.id,
        companyId: company.id,
        role: 'categorizer',
      },
    });
    await firstClient.qboAccount.createMany({
      data: [
        {
          companyId: company.id,
          qboId: `account-operating-${suffix}`,
          name: 'Generic Operating',
          fullName: 'Generic Operating',
          classification: 'Bank',
          active: true,
        },
        {
          companyId: company.id,
          qboId: `account-reserve-${suffix}`,
          name: 'Generic Reserve',
          fullName: 'Generic Reserve',
          classification: 'Bank',
          active: true,
        },
      ],
    });
    const first = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-out-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '4',
        date: new Date('2026-07-27T00:00:00.000Z'),
        payee: 'Generic Transfer Leg',
        memo: 'Generic memo one',
        amount: '-42.75',
        bankAccount: 'Generic Operating',
        revision: 3,
        taxCalculation: 'NotApplicable',
        splitLines: {
          create: {
            idx: 0,
            amount: '-42.75',
            category: 'Generic Reserve',
            categoryQboId: `account-reserve-${suffix}`,
            memo: 'Generic memo one',
          },
        },
      },
    });
    const second = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `deposit-in-${suffix}`,
        qboType: 'Deposit',
        qboSyncToken: '8',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'Generic Transfer Leg',
        memo: 'Generic memo two',
        amount: '42.75',
        bankAccount: 'Generic Reserve',
        revision: 5,
      },
    });
    const fresh = new Map<string, QboTxn>([
      [first.qboId, {
        qboId: first.qboId,
        qboType: 'Purchase',
        syncToken: '4',
        date: '2026-07-27',
        payee: 'Generic Transfer Leg',
        memo: 'Generic memo one',
        amount: -42.75,
        bankAccount: 'Generic Operating',
        lines: [{
          id: 'holding-one',
          amount: 42.75,
          accountQboId: 'holding-generic',
          accountName: 'Generic Holding',
        }],
        raw: {
          Id: first.qboId,
          SyncToken: '4',
          TxnDate: '2026-07-27',
          AccountRef: {
            value: `account-operating-${suffix}`,
            name: 'Generic Operating',
          },
          Line: [{
            Id: 'holding-one',
            Amount: 42.75,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: {
                value: 'holding-generic',
                name: 'Generic Holding',
              },
            },
          }],
        },
      }],
      [second.qboId, {
        qboId: second.qboId,
        qboType: 'Deposit',
        syncToken: '8',
        date: '2026-07-29',
        payee: 'Generic Transfer Leg',
        memo: 'Generic memo two',
        amount: 42.75,
        bankAccount: 'Generic Reserve',
        lines: [{
          id: 'holding-two',
          amount: 42.75,
          accountQboId: 'holding-generic',
          accountName: 'Generic Holding',
        }],
        raw: {
          Id: second.qboId,
          SyncToken: '8',
          TxnDate: '2026-07-29',
          DepositToAccountRef: {
            value: `account-reserve-${suffix}`,
            name: 'Generic Reserve',
          },
          Line: [{
            Id: 'holding-two',
            Amount: 42.75,
            DetailType: 'DepositLineDetail',
            DepositLineDetail: {
              AccountRef: {
                value: 'holding-generic',
                name: 'Generic Holding',
              },
              Entity: {
                value: 'generic-payer',
                name: 'Generic Payer',
              },
            },
          }],
        },
      }],
    ]);
    return {
      companyId: company.id,
      actorId: actor.id,
      transactionIds: [first.id, second.id],
      qboIds: [first.qboId, second.qboId],
      accountQboIds: [
        `account-operating-${suffix}`,
        `account-reserve-${suffix}`,
      ],
      fresh,
      input: {
        companyId: company.id,
        transactionId: first.id,
        counterpartTransactionId: second.id,
        expectedRevision: 3,
        counterpartExpectedRevision: 5,
        idempotencyKey: `transfer-${suffix}`,
        actor: { id: actor.id, label: 'Generic Transfer Actor' },
      },
    };
  }

  function operationDeps(
    fixture: Fixture,
    client: PrismaClient,
    overrides: Partial<TransferOperationDeps> = {},
  ): TransferOperationDeps {
    const qbo = {
      fetchTxn: vi.fn(async (_type: QboTxn['qboType'], qboId: string) =>
        structuredClone(fixture.fresh.get(qboId) ?? null)),
      prepareLineRecategorization: vi.fn(async (
        txn: QboTxn,
        splits: { amount: number; accountQboId: string; memo?: string }[],
        requestId: string,
      ) => preparedWrite(
        txn,
        splits[0]!.accountQboId,
        requestId,
        splits[0]!.memo,
      )),
      sendPreparedLineWrite: vi.fn(async () => {
        throw new Error('PostgreSQL preparation sent a QBO write');
      }),
    } as unknown as QboClient;
    return {
      db: rootStore(client),
      getClient: async () => qbo,
      authorize: async () => true,
      lease: async (_keys, _owner, callback) => callback(),
      fence: async () => undefined,
      invocationId: randomUUID,
      operationId: randomUUID,
      now: () => new Date(),
      ...overrides,
    };
  }

  it('rolls back the coordinator when the two-attempt insert fails', async () => {
    const fixture = await seed();
    const operationId = randomUUID();
    const sabotaged = rootStore(firstClient, (transaction) => {
      const base = storeOf(transaction);
      return {
        ...base,
        qboMutationAttempt: {
          ...base.qboMutationAttempt,
          createMany: async ({ data, skipDuplicates }) => {
            const invalid = structuredClone(data);
            invalid[1]!.transactionId = randomUUID();
            return transaction.qboMutationAttempt.createMany({
              data: invalid as unknown as Prisma.QboMutationAttemptCreateManyInput[],
              skipDuplicates,
            });
          },
        },
      };
    });

    await expect(prepareTransfer(fixture.input, operationDeps(
      fixture,
      firstClient,
      { db: sabotaged, operationId: () => operationId },
    ))).rejects.toThrow();

    await expect(firstClient.qboTransferOperation.count({
      where: { id: operationId },
    })).resolves.toBe(0);
    await expect(firstClient.qboMutationAttempt.count({
      where: { requestId: { startsWith: `${operationId}-t` } },
    })).resolves.toBe(0);
  });

  it('returns one operation identity from two concurrent exact preparations', async () => {
    const fixture = await seed();
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();
    let arrivals = 0;

    const barrierStore = (client: PrismaClient, ready: Deferred) =>
      rootStore(client, (transaction) => {
        const base = storeOf(transaction);
        return {
          ...base,
          qboTransferOperation: {
            ...base.qboTransferOperation,
            createMany: async (args) => {
              arrivals += 1;
              ready.resolve();
              await release.promise;
              return transaction.qboTransferOperation.createMany(args);
            },
          },
        };
      });
    const first = prepareTransfer(fixture.input, operationDeps(
      fixture,
      firstClient,
      { db: barrierStore(firstClient, firstReady) },
    ));
    const second = prepareTransfer(fixture.input, operationDeps(
      fixture,
      secondClient,
      { db: barrierStore(secondClient, secondReady) },
    ));

    await Promise.all([firstReady.promise, secondReady.promise]);
    expect(arrivals).toBe(2);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    await expect(firstClient.qboTransferOperation.count({
      where: {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      },
    })).resolves.toBe(1);
    await expect(firstClient.qboMutationAttempt.count({
      where: {
        requestId: { startsWith: `${firstResult.operationId}-t` },
      },
    })).resolves.toBe(2);
  }, 30_000);

  it('rejects conflicting reuse without changing the durable preparation', async () => {
    const fixture = await seed();
    const deps = operationDeps(fixture, firstClient);
    const created = await prepareTransfer(fixture.input, deps);

    await expect(prepareTransfer({
      ...fixture.input,
      counterpartExpectedRevision: fixture.input.counterpartExpectedRevision + 1,
    }, deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await expect(firstClient.qboTransferOperation.count({
      where: { id: created.operationId },
    })).resolves.toBe(1);
    await expect(firstClient.qboMutationAttempt.count({
      where: { requestId: { startsWith: `${created.operationId}-t` } },
    })).resolves.toBe(2);
  });

  it.each([0, 1])(
    'blocks preparation when leg %s already has an active attempt',
    async (legIndex) => {
      const fixture = await seed();
      const requestId = randomUUID();
      await firstClient.qboMutationAttempt.create({
        data: {
          transactionId: fixture.transactionIds[legIndex]!,
          requestId,
          operation: 'categorization',
          status: 'PREPARED',
          expectedRevision: legIndex === 0 ? 3 : 5,
          expectedSyncToken: legIndex === 0 ? '4' : '8',
          requestHash: `hash-${requestId}`,
          requestPayload: { kind: 'generic-active-attempt' },
          beforeSnapshot: { kind: 'generic-active-attempt' },
        },
      });

      await expect(prepareTransfer(
        fixture.input,
        operationDeps(fixture, firstClient),
      )).rejects.toMatchObject({ code: 'ACTIVE_ATTEMPT' });
      await expect(firstClient.qboTransferOperation.count({
        where: {
          actorId: fixture.actorId,
          companyId: fixture.companyId,
        },
      })).resolves.toBe(0);
    },
  );

  it('lets the actual categorization producer win a lost-lease race without creating a second active authority', async () => {
    const fixture = await seed();
    const transferAtFinalPersistence = deferred();
    const releaseTransferPersistence = deferred();
    const categorizationPrepared = deferred();
    const releaseCategorization = deferred();
    const baseStore = rootStore(firstClient);
    let persistenceCalls = 0;
    const racingStore: TransferOperationDb = {
      ...baseStore,
      $transaction: (callback) =>
        firstClient.$transaction(
          (transaction) => callback({
            ...storeOf(transaction),
            qboTransferOperation: {
              ...storeOf(transaction).qboTransferOperation,
              createMany: async (args) => {
                persistenceCalls += 1;
                transferAtFinalPersistence.resolve();
                await releaseTransferPersistence.promise;
                return transaction.qboTransferOperation.createMany(args);
              },
            },
          }),
          { timeout: 30_000 },
        ),
    };
    const transfer = prepareTransfer(
      fixture.input,
      operationDeps(fixture, firstClient, {
        db: racingStore,
        // Model a worker whose lease expired after its final active-attempt
        // read. The database constraint remains the last write-authority gate.
        lease: async (_keys, _owner, callback) => callback(),
        fence: async () => undefined,
      }),
    );
    await transferAtFinalPersistence.promise;
    expect(persistenceCalls).toBe(1);

    const transaction = await firstClient.transaction.findUniqueOrThrow({
      where: { id: fixture.transactionIds[0] },
    });
    const before: QboPurchaseSnapshot = {
      qboId: transaction.qboId,
      syncToken: transaction.qboSyncToken,
      totalCents: -4275,
      accountQboId: fixture.accountQboIds[0],
      date: '2026-07-27',
      direction: 'purchase',
      globalTaxCalculation: null,
      totalTaxCents: null,
      lines: [{
        id: 'holding-one',
        amountCents: -4275,
        description: null,
        accountQboId: 'holding-generic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: null,
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    };
    const preparedBody: QboPreparedWrite['body'] = {
      Id: transaction.qboId,
      SyncToken: transaction.qboSyncToken,
      TxnDate: '2026-07-27',
      TotalAmt: 42.75,
      AccountRef: { value: before.accountQboId! },
      GlobalTaxCalculation: 'NotApplicable',
      Line: [{
        Amount: 42.75,
        Description: 'Generic memo one',
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: {
            value: fixture.accountQboIds[1],
          },
        },
      }],
    };
    const preparedCategorization: QboPreparedWrite = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: transaction.qboId,
      requestId: `categorization-${randomUUID()}`,
      requestHash: hashPreparedWriteBody(preparedBody),
      body: preparedBody,
      before,
      expected: {
        qboId: transaction.qboId,
        totalCents: -4275,
        accountQboId: before.accountQboId,
        date: before.date,
        direction: 'purchase',
        globalTaxCalculation: 'NotApplicable',
        totalTaxCents: null,
        targetLines: [{
          id: null,
          amountCents: -4275,
          description: 'Generic memo one',
          accountQboId: fixture.accountQboIds[1],
          customerQboId: null,
          classQboId: null,
          taxCodeQboId: null,
          taxAmountCents: null,
          taxInclusiveCents: null,
        }],
        untouchedLineHashes: [],
      },
    };
    const fetchPreparedSnapshot = vi.fn(async () => structuredClone(before));
    const prepareRecategorization = vi.fn(async () =>
      structuredClone(preparedCategorization));
    const writebackClient = {
      fetchTxn: vi.fn(async () =>
        structuredClone(fixture.fresh.get(transaction.qboId) ?? null)),
      fetchPreparedSnapshot,
      fetchWriteSafety: vi.fn(async () => ({
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
      })),
      prepareRecategorization,
      fetchPurchaseSnapshot: fetchPreparedSnapshot,
      preparePurchaseRecategorization: prepareRecategorization,
      sendPreparedWrite: vi.fn(async () => {
        throw new Error('lost-lease categorization must not send');
      }),
    } as unknown as QboClient;
    let renewCalls = 0;
    const writebackDeps: DurableWritebackDeps = {
      db: firstClient as unknown as DurableWritebackDb,
      getClient: async () => writebackClient,
      audit: async () => undefined,
      authorize: async () => true,
      envDryRun: false,
      lease: async (_key, _owner, callback) => callback(),
      renewLease: async () => {
        renewCalls += 1;
        if (renewCalls === 1) return;
        categorizationPrepared.resolve();
        await releaseCategorization.promise;
        throw new Error('lease ownership was lost');
      },
      invocationId: randomUUID,
      now: () => new Date(),
    };
    const categorization = commitStagedCategorization({
      transactionId: transaction.id,
      companyId: fixture.companyId,
      expectedRevision: transaction.revision,
      requestId: preparedCategorization.requestId,
      actor: { id: fixture.actorId, label: 'Generic Transfer Actor' },
    }, writebackDeps);
    await Promise.race([
      categorizationPrepared.promise,
      categorization.then(
        () => {
          throw new Error('categorization completed before the PREPARED barrier');
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);

    try {
      releaseTransferPersistence.resolve();
      await expect(transfer).rejects.toMatchObject({
        code: 'OPERATION_CONFLICT',
      });
      await expect(firstClient.qboMutationAttempt.count({
        where: {
          transactionId: transaction.id,
          status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
        },
      })).resolves.toBe(1);
      await expect(firstClient.qboTransferOperation.count({
        where: {
          actorId: fixture.actorId,
          companyId: fixture.companyId,
        },
      })).resolves.toBe(0);
      expect(writebackClient.sendPreparedWrite).not.toHaveBeenCalled();
    } finally {
      releaseCategorization.resolve();
      await categorization.catch(() => undefined);
    }
  }, 30_000);

  it('rejects coordinator updates and deletes at the database layer', async () => {
    const fixture = await seed();
    const created = await prepareTransfer(
      fixture.input,
      operationDeps(fixture, firstClient),
    );

    await expect(firstClient.qboTransferOperation.update({
      where: { id: created.operationId },
      data: { firstExpectedRevision: 999 },
    })).rejects.toThrow('QboTransferOperation is immutable');
    await expect(firstClient.qboTransferOperation.delete({
      where: { id: created.operationId },
    })).rejects.toThrow('QboTransferOperation is immutable');
  });

  it('enforces every coordinator structural constraint at the database layer', async () => {
    const fixture = await seed();
    const created = await prepareTransfer(
      fixture.input,
      operationDeps(fixture, firstClient),
    );
    const operation = await firstClient.qboTransferOperation.findUniqueOrThrow({
      where: { id: created.operationId },
    });

    const clone = () => {
      const id = randomUUID();
      return {
        ...operation,
        id,
        actorId: `constraint-${randomUUID()}`,
        firstAttemptRequestId: `${id}-t0`,
        secondAttemptRequestId: `${id}-t1`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
        retryOfId: null as string | null,
      };
    };
    const legacy = clone();
    legacy.firstAttemptRequestId = `${legacy.id}:transfer:0`;
    legacy.secondAttemptRequestId = `${legacy.id}:transfer:1`;
    await expect(firstClient.qboTransferOperation.create({
      data: legacy,
    })).resolves.toMatchObject({
      firstAttemptRequestId: `${legacy.id}:transfer:0`,
      secondAttemptRequestId: `${legacy.id}:transfer:1`,
    });
    const invalidRows = [
      (() => {
        const row = clone();
        row.secondTransactionId = row.firstTransactionId;
        return row;
      })(),
      (() => {
        const row = clone();
        row.secondQboType = row.firstQboType;
        row.secondQboId = row.firstQboId;
        return row;
      })(),
      (() => {
        const row = clone();
        row.secondTargetAccountQboId = row.firstTargetAccountQboId;
        return row;
      })(),
      (() => {
        const row = clone();
        row.inputHash = 'A'.repeat(64);
        return row;
      })(),
      (() => {
        const row = clone();
        row.firstAttemptRequestId = 'r'.repeat(129);
        return row;
      })(),
      (() => {
        const row = clone();
        row.retryOfId = row.id;
        return row;
      })(),
      (() => {
        const row = clone();
        row.createdAt = new Date('2000-01-01T00:00:00.000Z');
        row.expiresAt = new Date('2000-01-01T00:15:00.000Z');
        return row;
      })(),
    ];

    for (const row of invalidRows) {
      await expect(firstClient.qboTransferOperation.create({
        data: row,
      })).rejects.toThrow();
    }

    await expect(firstClient.$transaction(async (transaction) => {
      const [clock] = await transaction.$queryRaw<
        { startedAt: Date }[]
      >`SELECT CURRENT_TIMESTAMP AS "startedAt"`;
      const row = clone();
      row.createdAt = clock!.startedAt;
      row.expiresAt = new Date(clock!.startedAt.getTime() + 100);
      await delay(250);
      await transaction.qboTransferOperation.create({ data: row });
    })).rejects.toThrow(/future at insert/i);
  });

  it('requires both lease rows to remain owned inside the persistence transaction', async () => {
    const fixture = await seed();
    const deps = operationDeps(fixture, firstClient);
    deps.lease = (keys, owner, callback) => withEntityLeases(
      keys,
      owner,
      callback,
      { db: firstClient as unknown as EntityLeaseDb },
    );
    const fence = vi.fn(async (keys, owner, transaction) => {
      await fenceEntityLeaseOwnerships(keys, owner, {
        db: transaction as unknown as EntityLeaseFenceDb,
      });
    });
    deps.fence = fence;
    const getClient = deps.getClient;
    deps.getClient = async (companyId) => {
      const client = await getClient(companyId);
      await secondClient.qboEntityLease.delete({
        where: {
          companyId_qboType_qboId: {
            companyId: fixture.companyId,
            qboType: 'Purchase',
            qboId: fixture.qboIds[0],
          },
        },
      });
      return client;
    };

    await expect(prepareTransfer(fixture.input, deps)).rejects.toMatchObject({
      code: 'ENTITY_BUSY',
    });
    expect(fence).toHaveBeenCalledTimes(2);
    await expect(firstClient.qboTransferOperation.count({
      where: {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      },
    })).resolves.toBe(0);
    await expect(firstClient.qboMutationAttempt.count({
      where: { transactionId: { in: fixture.transactionIds } },
    })).resolves.toBe(0);
  });
});
