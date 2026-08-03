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
import { buildPreparedLineWrite } from '../lib/qbo/lineWrite.js';
import type {
  QboClient,
  QboLineWriteSnapshot,
  QboPreparedLineWrite,
  QboTxn,
} from '../lib/qbo/types.js';
import { writeAudit } from './audit.js';
import {
  stageCategorization,
  type CategorizationDb,
  type CategorizationDeps,
} from './categorization.js';
import {
  fenceEntityLeaseOwnerships,
  renewEntityLeases,
  withEntityLeases,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
} from './entityLease.js';
import {
  commitTransfer,
  getTransferOperation,
  retryTransferOperation,
  type TransferExecutionDb,
  type TransferExecutionDeps,
} from './transferExecution.js';
import {
  prepareTransfer,
  type PrepareTransferInput,
  type TransferOperationDb,
  type TransferOperationDeps,
} from './transferOperations.js';

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

function clone<T>(value: T): T {
  return structuredClone(value);
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

interface ProviderHarness {
  client: QboClient;
  snapshots: Map<string, QboLineWriteSnapshot>;
  sendCounts: Map<string, number>;
  fetchCounts: Map<string, number>;
  failQboIds: Set<string>;
  block: {
    qboId: string;
    started: Deferred;
    release: Deferred;
    phase?: 'before-guard' | 'after-guard';
  } | null;
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

function transferStore(
  value: PrismaClient | Prisma.TransactionClient,
): TransferOperationDb {
  return value as unknown as TransferOperationDb;
}

function executionStore(
  value: PrismaClient | Prisma.TransactionClient,
): TransferExecutionDb {
  return value as unknown as TransferExecutionDb;
}

function provider(fixture: Fixture): ProviderHarness {
  const snapshots = new Map<string, QboLineWriteSnapshot>();
  const sendCounts = new Map<string, number>();
  const fetchCounts = new Map<string, number>();
  const failQboIds = new Set<string>();
  const harness: ProviderHarness = {
    snapshots,
    sendCounts,
    fetchCounts,
    failQboIds,
    block: null,
    client: undefined as unknown as QboClient,
  };
  harness.client = {
    fetchTxn: vi.fn(async (_qboType: QboTxn['qboType'], qboId: string) =>
      clone(fixture.fresh.get(qboId) ?? null)),
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
    fetchLineWriteSnapshot: vi.fn(async (
      _qboType: QboTxn['qboType'],
      qboId: string,
    ) => {
      fetchCounts.set(qboId, (fetchCounts.get(qboId) ?? 0) + 1);
      return clone(snapshots.get(qboId) ?? null);
    }),
    sendPreparedLineWrite: vi.fn(async (
      prepared: QboPreparedLineWrite,
      beforeSend?: () => Promise<void>,
    ) => {
      if (
        harness.block?.qboId === prepared.qboId
        && harness.block.phase === 'before-guard'
      ) {
        harness.block.started.resolve();
        await harness.block.release.promise;
      }
      await beforeSend?.();
      sendCounts.set(
        prepared.qboId,
        (sendCounts.get(prepared.qboId) ?? 0) + 1,
      );
      if (
        harness.block?.qboId === prepared.qboId
        && harness.block.phase !== 'before-guard'
      ) {
        harness.block.started.resolve();
        await harness.block.release.promise;
      }
      if (failQboIds.has(prepared.qboId)) {
        throw new Error('generic provider failure');
      }
      const snapshot = {
        ...prepared.expected,
        syncToken: `${Number(prepared.before.syncToken) + 1}`,
      };
      snapshots.set(prepared.qboId, clone(snapshot));
      const fresh = fixture.fresh.get(prepared.qboId);
      if (fresh !== undefined) {
        fresh.syncToken = snapshot.syncToken;
        fresh.amount = 0;
        fresh.lines = [];
        fresh.raw = clone(prepared.body);
        fresh.raw.SyncToken = snapshot.syncToken;
      }
      return {
        ok: true as const,
        newSyncToken: snapshot.syncToken,
        snapshot,
      };
    }),
  } as unknown as QboClient;
  return harness;
}

describePostgres('transfer execution PostgreSQL durability', () => {
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
        email: `transfer-execution-${suffix}@example.invalid`,
        name: 'Generic Transfer Actor',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `transfer-execution-pg-${suffix}`,
        legalName: 'Generic Transfer Company',
        nickname: `execution-${suffix.slice(0, 8)}`,
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
    const operatingQboId = `account-operating-${suffix}`;
    const reserveQboId = `account-reserve-${suffix}`;
    await firstClient.qboAccount.createMany({
      data: [
        {
          companyId: company.id,
          qboId: operatingQboId,
          name: 'Generic Operating',
          fullName: 'Generic Operating',
          classification: 'Bank',
          active: true,
        },
        {
          companyId: company.id,
          qboId: reserveQboId,
          name: 'Generic Reserve',
          fullName: 'Generic Reserve',
          classification: 'Bank',
          active: true,
        },
      ],
    });
    const purchase = await firstClient.transaction.create({
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
            category: 'Generic Holding',
            categoryQboId: 'holding-generic',
            memo: 'Generic memo one',
          },
        },
      },
    });
    const deposit = await firstClient.transaction.create({
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
      [purchase.qboId, {
        qboId: purchase.qboId,
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
          Id: purchase.qboId,
          SyncToken: '4',
          TxnDate: '2026-07-27',
          AccountRef: {
            value: operatingQboId,
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
      [deposit.qboId, {
        qboId: deposit.qboId,
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
          Id: deposit.qboId,
          SyncToken: '8',
          TxnDate: '2026-07-29',
          DepositToAccountRef: {
            value: reserveQboId,
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
      transactionIds: [purchase.id, deposit.id],
      qboIds: [purchase.qboId, deposit.qboId],
      accountQboIds: [operatingQboId, reserveQboId],
      fresh,
      input: {
        companyId: company.id,
        transactionId: purchase.id,
        counterpartTransactionId: deposit.id,
        expectedRevision: purchase.revision,
        counterpartExpectedRevision: deposit.revision,
        idempotencyKey: `execution-${suffix}`,
        actor: {
          id: actor.id,
          label: 'Generic Transfer Actor',
        },
      },
    };
  }

  function preparationDeps(
    fixture: Fixture,
    harness: ProviderHarness,
    client: PrismaClient,
  ): TransferOperationDeps {
    return {
      db: transferStore(client),
      getClient: async () => harness.client,
      authorize: async () => true,
      lease: (keys, owner, callback) =>
        withEntityLeases(keys, owner, callback, {
          db: client as unknown as EntityLeaseDb,
        }),
      fence: (keys, owner, transaction) =>
        fenceEntityLeaseOwnerships(keys, owner, {
          db: transaction as unknown as EntityLeaseFenceDb,
        }),
      invocationId: randomUUID,
      operationId: randomUUID,
      now: () => new Date(),
    };
  }

  function executionDeps(
    harness: ProviderHarness,
    client: PrismaClient,
    audit: TransferExecutionDeps['audit'] = async (store, entry) =>
      writeAudit(
        store as unknown as PrismaClient | Prisma.TransactionClient,
        entry,
      ),
  ): TransferExecutionDeps {
    return {
      db: executionStore(client),
      getClient: async () => harness.client,
      audit,
      authorize: async () => true,
      lease: (keys, owner, callback) =>
        withEntityLeases(keys, owner, callback, {
          db: client as unknown as EntityLeaseDb,
        }),
      renewLease: (keys, owner) =>
        renewEntityLeases(keys, owner, {
          db: client as unknown as EntityLeaseDb,
        }),
      fence: (keys, owner, transaction) =>
        fenceEntityLeaseOwnerships(keys, owner, {
          db: transaction as unknown as EntityLeaseFenceDb,
        }),
      invocationId: randomUUID,
      now: () => new Date(),
      envDryRun: false,
    };
  }

  function categorizationDeps(client: PrismaClient): CategorizationDeps {
    return {
      db: client as unknown as CategorizationDb,
      lease: (key, owner, callback) =>
        withEntityLeases([key], owner, callback, {
          db: client as unknown as EntityLeaseDb,
        }),
      fence: (key, owner, transaction) =>
        fenceEntityLeaseOwnerships([key], owner, {
          db: transaction as unknown as EntityLeaseFenceDb,
        }),
      invocationId: randomUUID,
    };
  }

  async function prepareFixture(
    fixture: Fixture,
    harness: ProviderHarness,
    client = firstClient,
    expiresInMs?: number,
  ): Promise<string> {
    const deps = preparationDeps(fixture, harness, client);
    if (expiresInMs !== undefined) {
      deps.now = () =>
        new Date(Date.now() - 15 * 60 * 1000 + expiresInMs);
    }
    const prepared = await prepareTransfer(
      fixture.input,
      deps,
    );
    const attempts = await client.qboMutationAttempt.findMany({
      where: {
        requestId: {
          in: [
            `${prepared.operationId}-t0`,
            `${prepared.operationId}-t1`,
          ],
        },
      },
    });
    for (const attempt of attempts) {
      const payload = attempt.requestPayload as unknown as QboPreparedLineWrite;
      harness.snapshots.set(payload.qboId, clone(payload.before));
    }
    return prepared.operationId;
  }

  async function orderedAttempts(operationId: string) {
    return Promise.all([
      firstClient.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: `${operationId}-t0` },
      }),
      firstClient.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: `${operationId}-t1` },
      }),
    ]);
  }

  it('uses real dual leases so concurrent commits send each leg at most once', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const started = deferred();
    const release = deferred();
    harness.block = { qboId: firstPrepared.qboId, started, release };

    const first = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    );
    await started.promise;
    const second = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient),
    );

    try {
      await expect(second).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
    } finally {
      release.resolve();
    }
    await expect(first).resolves.toMatchObject({
      state: 'VERIFIED',
      complete: true,
    });
    expect(harness.sendCounts.get(firstPrepared.qboId)).toBe(1);
    const secondPrepared =
      attempts[1].requestPayload as unknown as QboPreparedLineWrite;
    expect(harness.sendCounts.get(secondPrepared.qboId)).toBe(1);
    await expect(firstClient.qboMutationAttempt.count({
      where: {
        transactionId: { in: fixture.transactionIds },
        status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
      },
    })).resolves.toBe(0);
  }, 30_000);

  it('never finalizes unchanged while an expired-lease send can still land', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const started = deferred();
    const release = deferred();
    harness.block = { qboId: firstPrepared.qboId, started, release };
    const shortLeaseDeps = (client: PrismaClient) => {
      const deps = executionDeps(harness, client);
      deps.lease = (keys, owner, callback) =>
        withEntityLeases(keys, owner, callback, {
          db: client as unknown as EntityLeaseDb,
          ttlMs: 200,
        });
      deps.renewLease = (keys, owner) =>
        renewEntityLeases(keys, owner, {
          db: client as unknown as EntityLeaseDb,
          ttlMs: 200,
        });
      Object.assign(deps, {
        heartbeatIntervalMs: 25,
        committingQuiescenceMs: 800,
      });
      return deps;
    };
    const first = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      shortLeaseDeps(firstClient),
    );
    await started.promise;
    await delay(450);
    const secondOutcome = await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      shortLeaseDeps(secondClient),
    ).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    release.resolve();
    await first.catch(() => undefined);
    if (secondOutcome.kind === 'resolved') {
      expect(secondOutcome.value.firstLeg.outcome).not.toBe('UNCHANGED');
    } else {
      expect(secondOutcome.error).toMatchObject({ code: 'ENTITY_BUSY' });
    }
    await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      shortLeaseDeps(secondClient),
    );
    const final = await getTransferOperation(
      operationId,
      fixture.input.actor,
      undefined,
      shortLeaseDeps(secondClient),
    );
    expect(final).toMatchObject({
      state: 'VERIFIED',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
    const persisted = await orderedAttempts(operationId);
    expect(persisted.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
    expect(harness.snapshots.get(firstPrepared.qboId)).toEqual({
      ...firstPrepared.expected,
      syncToken: `${Number(firstPrepared.before.syncToken) + 1}`,
    });
  }, 30_000);

  it('blocks a late provider POST when setup outlives quiescence and sender authority is lost', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const started = deferred();
    const release = deferred();
    harness.block = {
      qboId: firstPrepared.qboId,
      started,
      release,
      phase: 'before-guard',
    };
    const shortLeaseDeps = (client: PrismaClient) => {
      const deps = executionDeps(harness, client);
      deps.lease = (keys, owner, callback) =>
        withEntityLeases(keys, owner, callback, {
          db: client as unknown as EntityLeaseDb,
          ttlMs: 200,
        });
      deps.renewLease = (keys, owner) =>
        renewEntityLeases(keys, owner, {
          db: client as unknown as EntityLeaseDb,
          ttlMs: 200,
        });
      Object.assign(deps, {
        heartbeatIntervalMs: 25,
        committingQuiescenceMs: 300,
      });
      return deps;
    };
    const firstDeps = shortLeaseDeps(firstClient);
    const realRenew = firstDeps.renewLease;
    let renewals = 0;
    firstDeps.renewLease = async (keys, owner) => {
      renewals += 1;
      if (renewals >= 3) throw new Error('generic simulated lease loss');
      await realRenew(keys, owner);
    };

    const first = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      firstDeps,
    );
    await started.promise;
    await delay(650);
    const replacement = await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      shortLeaseDeps(secondClient),
    );
    expect(replacement).toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'UNCHANGED' },
    });

    release.resolve();
    await first.catch(() => undefined);
    expect(harness.sendCounts.get(firstPrepared.qboId) ?? 0).toBe(0);
    expect(harness.snapshots.get(firstPrepared.qboId)).toEqual(
      firstPrepared.before,
    );
    expect((await orderedAttempts(operationId))[0].status).toBe('UNCHANGED');
  }, 30_000);

  it('uses wall-clock database time after a final fence blocks across operation expiry', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(
      fixture,
      harness,
      firstClient,
      1_500,
    );
    const operation = await firstClient.qboTransferOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    const exactFetchStarted = deferred();
    const releaseExactFetch = deferred();
    const fetchSnapshot = harness.client.fetchLineWriteSnapshot.bind(
      harness.client,
    );
    harness.client.fetchLineWriteSnapshot = vi.fn(async (qboType, qboId) => {
      exactFetchStarted.resolve();
      await releaseExactFetch.promise;
      return fetchSnapshot(qboType, qboId);
    });
    const pending = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    );
    await exactFetchStarted.promise;

    const leaseRowsLocked = deferred();
    const releaseLeaseRows = deferred();
    const locker = secondClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT "qboId"
           FROM "QboEntityLease"
          WHERE "companyId" = $1
          ORDER BY "qboType", "qboId"
          FOR UPDATE`,
        fixture.companyId,
      );
      leaseRowsLocked.resolve();
      await releaseLeaseRows.promise;
    });
    await leaseRowsLocked.promise;
    releaseExactFetch.resolve();
    await delay(Math.max(
      0,
      operation.expiresAt.getTime() - Date.now() + 100,
    ));
    releaseLeaseRows.resolve();
    await locker;

    await expect(pending).resolves.toMatchObject({
      state: 'RETRYABLE',
      firstLeg: { outcome: 'RETRYABLE' },
    });
    expect(
      [...harness.sendCounts.values()]
        .reduce((total, count) => total + count, 0),
    ).toBe(0);
  }, 30_000);

  it('blocks provider POST when the final authority fence waits across lease expiry', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const deps = executionDeps(harness, firstClient);
    deps.lease = (keys, owner, callback) =>
      withEntityLeases(keys, owner, callback, {
        db: firstClient as unknown as EntityLeaseDb,
        ttlMs: 300,
      });
    const finalRenewed = deferred();
    const releaseFinalRenew = deferred();
    let renewals = 0;
    deps.renewLease = async (keys, owner) => {
      renewals += 1;
      await renewEntityLeases(keys, owner, {
        db: firstClient as unknown as EntityLeaseDb,
        ttlMs: 300,
      });
      if (renewals === 4) {
        finalRenewed.resolve();
        await releaseFinalRenew.promise;
      }
    };
    Object.assign(deps, { heartbeatIntervalMs: 10_000 });
    const pending = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      deps,
    );
    await finalRenewed.promise;

    const leaseRowsLocked = deferred();
    const releaseLeaseRows = deferred();
    const locker = secondClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT "qboId"
           FROM "QboEntityLease"
          WHERE "companyId" = $1
          ORDER BY "qboType", "qboId"
          FOR UPDATE`,
        fixture.companyId,
      );
      leaseRowsLocked.resolve();
      await releaseLeaseRows.promise;
      // Expire the leases under the same row lock the renewal is queued behind,
      // rather than sleeping past the TTL. The renewal then observes expiry the
      // instant it acquires the row, which is the property under test — and it
      // no longer depends on a wall-clock margin that a loaded runner can eat.
      await tx.$executeRawUnsafe(
        `UPDATE "QboEntityLease"
            SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
          WHERE "companyId" = $1`,
        fixture.companyId,
      );
    });
    await leaseRowsLocked.promise;
    releaseFinalRenew.resolve();
    releaseLeaseRows.resolve();
    await locker;
    await pending.catch(() => undefined);

    expect(harness.sendCounts.get(firstPrepared.qboId) ?? 0).toBe(0);
    expect(harness.snapshots.get(firstPrepared.qboId)).toEqual(
      firstPrepared.before,
    );
  }, 30_000);

  it('restarts a PREPARED operation through a fresh Prisma client', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness, firstClient);

    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient),
    )).resolves.toMatchObject({
      state: 'VERIFIED',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'VERIFIED' },
    });
    const attempts = await orderedAttempts(operationId);
    for (const attempt of attempts) {
      const prepared = attempt.requestPayload as unknown as QboPreparedLineWrite;
      expect(harness.sendCounts.get(prepared.qboId)).toBe(1);
    }
  });

  it.each(['COMMITTING', 'UNCERTAIN'] as const)(
    'recovers a persisted %s leg by fetching without resending it',
    async (status) => {
      const fixture = await seed();
      const harness = provider(fixture);
      const operationId = await prepareFixture(fixture, harness);
      const attempts = await orderedAttempts(operationId);
      const firstPrepared =
        attempts[0].requestPayload as unknown as QboPreparedLineWrite;
      harness.snapshots.set(firstPrepared.qboId, {
        ...clone(firstPrepared.expected),
        syncToken: `${Number(firstPrepared.before.syncToken) + 1}`,
      });
      await firstClient.qboMutationAttempt.update({
        where: { id: attempts[0].id },
        data: { status },
      });
      if (status === 'UNCERTAIN') {
        await firstClient.transaction.update({
          where: { id: attempts[0].transactionId },
          data: {
            status: 'ERROR',
            errorCode: 'QBO_WRITE_UNCERTAIN',
            errorMessage: 'Generic uncertain state.',
          },
        });
      }

      await expect(commitTransfer(
        operationId,
        fixture.input.actor,
        undefined,
        undefined,
        executionDeps(harness, secondClient),
      )).resolves.toMatchObject({
        state: 'VERIFIED',
        complete: true,
      });
      expect(harness.sendCounts.get(firstPrepared.qboId) ?? 0).toBe(0);
      expect(harness.fetchCounts.get(firstPrepared.qboId)).toBeGreaterThan(0);
      const secondPrepared =
        attempts[1].requestPayload as unknown as QboPreparedLineWrite;
      expect(harness.sendCounts.get(secondPrepared.qboId)).toBe(1);
    },
  );

  it('reconciles a provider-applied write after sync-shaped local drift', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const applied = {
      ...clone(firstPrepared.expected),
      syncToken: `${Number(firstPrepared.before.syncToken) + 1}`,
    };
    harness.snapshots.set(firstPrepared.qboId, applied);
    await firstClient.qboMutationAttempt.update({
      where: { id: attempts[0].id },
      data: {
        status: 'COMMITTING',
        updatedAt: new Date(Date.now() - 120_000),
      },
    });
    await firstClient.transaction.update({
      where: { id: attempts[0].transactionId },
      data: {
        revision: { increment: 1 },
        qboSyncToken: applied.syncToken,
        status: 'SUPERSEDED',
      },
    });

    const result = await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient),
    );

    expect(result).toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    const persisted = await orderedAttempts(operationId);
    expect(persisted[0].status).toBe('VERIFIED');
    expect(persisted[1].status).toBe('RETRYABLE');
    await expect(firstClient.transaction.findUniqueOrThrow({
      where: { id: attempts[0].transactionId },
    })).resolves.toMatchObject({
      status: 'POSTED',
      qboSyncToken: applied.syncToken,
    });
    expect(harness.fetchCounts.get(firstPrepared.qboId)).toBeGreaterThan(0);
    expect(harness.sendCounts.get(firstPrepared.qboId) ?? 0).toBe(0);
  });

  it('keeps a verified first leg durable when the second send becomes uncertain', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const secondPrepared =
      attempts[1].requestPayload as unknown as QboPreparedLineWrite;
    harness.failQboIds.add(secondPrepared.qboId);

    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    )).resolves.toMatchObject({
      state: 'UNCERTAIN',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'UNCERTAIN' },
    });
    let persisted = await orderedAttempts(operationId);
    expect(persisted.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'UNCERTAIN',
    ]);

    harness.failQboIds.delete(secondPrepared.qboId);
    await firstClient.qboMutationAttempt.update({
      where: { id: attempts[1].id },
      data: { updatedAt: new Date(Date.now() - 120_000) },
    });
    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient),
    )).resolves.toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'UNCHANGED' },
    });
    persisted = await orderedAttempts(operationId);
    expect(persisted.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'UNCHANGED',
    ]);
    expect(harness.sendCounts.get(firstPrepared.qboId)).toBe(1);
    expect(harness.sendCounts.get(secondPrepared.qboId)).toBe(1);
  });

  it('persists a one-child retry that inherits the verified parent attempt and creates only the safe replacement', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const secondPrepared =
      attempts[1].requestPayload as unknown as QboPreparedLineWrite;
    harness.snapshots.set(secondPrepared.qboId, {
      ...secondPrepared.before,
      syncToken: 'stale-generic',
    });

    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    )).resolves.toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    harness.snapshots.set(secondPrepared.qboId, clone(secondPrepared.before));
    const child = await retryTransferOperation(
      operationId,
      fixture.input.actor,
      undefined,
      executionDeps(harness, secondClient),
    );

    const coordinator =
      await firstClient.qboTransferOperation.findUniqueOrThrow({
        where: { id: child.operationId },
      });
    expect(coordinator).toMatchObject({
      retryOfId: operationId,
      firstAttemptRequestId: attempts[0].requestId,
      secondAttemptRequestId: `${child.operationId}-t1`,
    });
    expect(await firstClient.qboMutationAttempt.count({
      where: {
        requestId: {
          startsWith: `${child.operationId}-t`,
        },
      },
    })).toBe(1);
  });

  it('rejects retry inheritance at the database layer unless the inherited parent attempt is VERIFIED', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const parent = await firstClient.qboTransferOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    await firstClient.qboMutationAttempt.update({
      where: { id: attempts[0].id },
      data: {
        status: 'RETRYABLE',
        errorCode: 'TRANSFER_RETRYABLE',
        errorMessage: 'Generic retryable state.',
      },
    });
    const childId = randomUUID();

    await expect(firstClient.qboTransferOperation.create({
      data: {
        ...parent,
        id: childId,
        firstAttemptRequestId: parent.firstAttemptRequestId,
        secondAttemptRequestId: `${childId}-t1`,
        idempotencyHash: 'b'.repeat(64),
        inputHash: 'c'.repeat(64),
        retryOfId: parent.id,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      },
    })).rejects.toThrow();
    await expect(firstClient.qboTransferOperation.count({
      where: { retryOfId: parent.id },
    })).resolves.toBe(0);
  });

  it.each([
    ['expected revision', { firstExpectedRevision: 10 }],
    ['QBO type', { firstQboType: 'Purchase' }],
    ['QBO id', { firstQboId: 'qbo-other-generic' }],
    ['QBO sync token', { firstQboSyncToken: 'other-generic' }],
    ['target account', { firstTargetAccountQboId: 'account-other-generic' }],
  ])('rejects retry inheritance with a mismatched inherited %s', async (
    _field,
    mismatch,
  ) => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const secondPrepared =
      attempts[1].requestPayload as unknown as QboPreparedLineWrite;
    harness.snapshots.set(secondPrepared.qboId, {
      ...secondPrepared.before,
      syncToken: 'stale-generic',
    });
    await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    );
    const parent = await firstClient.qboTransferOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    const childId = randomUUID();

    await expect(firstClient.qboTransferOperation.create({
      data: {
        ...parent,
        id: childId,
        secondAttemptRequestId: `${childId}-t1`,
        idempotencyHash: 'd'.repeat(64),
        inputHash: 'e'.repeat(64),
        retryOfId: parent.id,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
        ...mismatch,
      },
    })).rejects.toThrow();
    await expect(firstClient.qboTransferOperation.count({
      where: { retryOfId: parent.id },
    })).resolves.toBe(0);
  });

  it('reloads the durable winner after a recovery fetch outlives TTL and loses ownership', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const expected = {
      ...clone(firstPrepared.expected),
      syncToken: `${Number(firstPrepared.before.syncToken) + 1}`,
    };
    harness.snapshots.set(firstPrepared.qboId, expected);
    await firstClient.qboMutationAttempt.update({
      where: { id: attempts[0].id },
      data: {
        status: 'COMMITTING',
        updatedAt: new Date(Date.now() - 120_000),
      },
    });
    await firstClient.qboMutationAttempt.update({
      where: { id: attempts[1].id },
      data: {
        status: 'RETRYABLE',
        errorCode: 'TRANSFER_RETRYABLE',
        errorMessage: 'Generic retryable state.',
      },
    });
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const staleFetchClient = {
      ...harness.client,
      fetchLineWriteSnapshot: vi.fn(async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return clone(firstPrepared.before);
      }),
    } as QboClient;
    const firstDeps = executionDeps(harness, firstClient);
    firstDeps.getClient = async () => staleFetchClient;
    firstDeps.lease = (keys, owner, callback) =>
      withEntityLeases(keys, owner, callback, {
        db: firstClient as unknown as EntityLeaseDb,
        ttlMs: 200,
      });
    let renewals = 0;
    firstDeps.renewLease = async (keys, owner) => {
      renewals += 1;
      if (renewals >= 3) throw new Error('generic recovery lease loss');
      await renewEntityLeases(keys, owner, {
        db: firstClient as unknown as EntityLeaseDb,
        ttlMs: 200,
      });
    };
    Object.assign(firstDeps, { heartbeatIntervalMs: 25 });

    const staleWorker = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      firstDeps,
    );
    await fetchStarted.promise;
    await delay(450);

    const winner = await commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient),
    );
    expect(winner).toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    releaseFetch.resolve();
    await expect(staleWorker).resolves.toMatchObject({
      state: 'PARTIAL',
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'RETRYABLE' },
    });
    expect((await orderedAttempts(operationId))[0].status).toBe('VERIFIED');
  }, 30_000);

  it('holds both entity leases against real categorization staging', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    const started = deferred();
    const release = deferred();
    harness.block = { qboId: firstPrepared.qboId, started, release };
    const transfer = commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient),
    );
    await started.promise;

    try {
      const transactions = await Promise.all(fixture.transactionIds.map((id) =>
        secondClient.transaction.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            companyId: true,
            revision: true,
            amount: true,
            splitLines: {
              orderBy: { idx: 'asc' },
              select: {
                idx: true,
                amount: true,
                categoryQboId: true,
                memo: true,
              },
            },
          },
        })
      ));
      for (const [index, transaction] of transactions.entries()) {
        await expect(stageCategorization({
          transactionId: transaction.id,
          companyId: transaction.companyId,
          expectedRevision: transaction.revision,
          proposal: {
            taxCalculation: 'NotApplicable',
            lines: [{
              grossCents: Math.round(Number(transaction.amount) * 100),
              categoryQboId: fixture.accountQboIds[index === 0 ? 1 : 0],
              memo: 'Generic blocked categorization',
              tagIds: [],
            }],
            tagIds: [],
          },
        }, categorizationDeps(secondClient))).rejects.toMatchObject({
          code: 'ENTITY_BUSY',
        });
      }
      const unchanged = await Promise.all(transactions.map((transaction) =>
        secondClient.transaction.findUniqueOrThrow({
          where: { id: transaction.id },
          select: {
            revision: true,
            splitLines: {
              orderBy: { idx: 'asc' },
              select: {
                idx: true,
                amount: true,
                categoryQboId: true,
                memo: true,
              },
            },
          },
        })
      ));
      expect(unchanged).toEqual(transactions.map((transaction) => ({
        revision: transaction.revision,
        splitLines: transaction.splitLines,
      })));
    } finally {
      release.resolve();
    }
    await expect(transfer).resolves.toMatchObject({
      state: 'VERIFIED',
      complete: true,
    });
  }, 30_000);

  it('rolls back attempt, transaction, and audit together when finalization fails', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);
    const firstPrepared =
      attempts[0].requestPayload as unknown as QboPreparedLineWrite;
    let rejectAudit = true;
    const atomicAudit: TransferExecutionDeps['audit'] =
      async (store, entry) => {
        if (rejectAudit) throw new Error('generic audit insert failure');
        await writeAudit(
          store as unknown as PrismaClient | Prisma.TransactionClient,
          entry,
        );
      };

    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, firstClient, atomicAudit),
    )).resolves.toMatchObject({
      state: 'IN_PROGRESS',
      firstLeg: { outcome: 'IN_PROGRESS' },
    });
    let persisted = await orderedAttempts(operationId);
    expect(persisted[0].status).toBe('COMMITTING');
    await expect(firstClient.transaction.findUniqueOrThrow({
      where: { id: persisted[0].transactionId },
    })).resolves.toMatchObject({
      status: 'PENDING',
      qboSyncToken: firstPrepared.before.syncToken,
    });
    await expect(firstClient.auditEntry.count({
      where: { companyId: fixture.companyId },
    })).resolves.toBe(0);

    rejectAudit = false;
    await expect(commitTransfer(
      operationId,
      fixture.input.actor,
      undefined,
      undefined,
      executionDeps(harness, secondClient, atomicAudit),
    )).resolves.toMatchObject({
      state: 'VERIFIED',
      complete: true,
    });
    persisted = await orderedAttempts(operationId);
    expect(persisted.map((attempt) => attempt.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
    expect(harness.sendCounts.get(firstPrepared.qboId)).toBe(1);
    await expect(firstClient.auditEntry.count({
      where: {
        companyId: fixture.companyId,
        action: 'transfer',
      },
    })).resolves.toBe(2);
  });

  it('enforces one active attempt per transaction at the database layer', async () => {
    const fixture = await seed();
    const harness = provider(fixture);
    const operationId = await prepareFixture(fixture, harness);
    const attempts = await orderedAttempts(operationId);

    await expect(firstClient.qboMutationAttempt.create({
      data: {
        transactionId: attempts[0].transactionId,
        requestId: `conflicting-${randomUUID()}`,
        operation: 'categorization',
        status: 'PREPARED',
        expectedRevision: attempts[0].expectedRevision,
        expectedSyncToken: attempts[0].expectedSyncToken,
        requestHash: 'generic-conflicting-request',
        requestPayload: { kind: 'generic-conflicting-request' },
        beforeSnapshot: { kind: 'generic-conflicting-before' },
      },
    })).rejects.toThrow();
    for (const transactionId of fixture.transactionIds) {
      await expect(firstClient.qboMutationAttempt.count({
        where: {
          transactionId,
          status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
        },
      })).resolves.toBe(1);
    }
  });
});
