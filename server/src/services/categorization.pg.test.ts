import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StageCategorizationInput } from '@recat/shared';
import type {
  QboClient,
  QboPreparedWrite,
  QboPurchaseSnapshot,
  QboTxn,
} from '../lib/qbo/types.js';
import {
  stageCategorization,
  type CategorizationDb,
  type CategorizationDeps,
} from './categorization.js';
import {
  acquireEntityLease,
  fenceEntityLeaseOwnership,
  releaseEntityLease,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';
import {
  commitStagedCategorization,
  type DurableWritebackDb,
  type DurableWritebackDeps,
} from './writeback.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fixture {
  companyId: string;
  transactionId: string;
  key: EntityLeaseKey;
  input: StageCategorizationInput;
}

describePostgres('stageCategorization PostgreSQL entity-lease races', () => {
  let stageClient: PrismaClient;
  let attemptClient: PrismaClient;

  beforeAll(() => {
    stageClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    attemptClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterAll(async () => {
    await Promise.all([
      stageClient?.$disconnect(),
      attemptClient?.$disconnect(),
    ]);
  });

  async function seed(): Promise<Fixture> {
    const suffix = randomUUID();
    const company = await stageClient.company.create({
      data: {
        realmId: `categorization-pg-${suffix}`,
        legalName: 'Categorization PostgreSQL Test',
        nickname: `pg-${suffix.slice(0, 8)}`,
        dryRun: false,
      },
    });
    const account = await stageClient.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `expense-${suffix}`,
        name: 'Lease race expense',
        fullName: 'Expenses · Lease race expense',
        classification: 'Expenses',
      },
    });
    const transaction = await stageClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-28T00:00:00.000Z'),
        payee: 'PostgreSQL lease fixture',
        amount: '-10.50',
        bankAccount: 'Test bank',
      },
    });
    return {
      companyId: company.id,
      transactionId: transaction.id,
      key: {
        companyId: company.id,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
      },
      input: {
        transactionId: transaction.id,
        companyId: company.id,
        expectedRevision: 0,
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1050,
            categoryQboId: account.qboId,
            memo: 'Lease race line',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
    };
  }

  async function seedDepositSalesTax(): Promise<Fixture> {
    const fixture = await seed();
    const accountQboId = fixture.input.proposal.lines[0]!.categoryQboId;
    await Promise.all([
      stageClient.company.update({
        where: { id: fixture.companyId },
        data: {
          taxSupportStatus: 'ready',
          taxUsingSalesTax: true,
          taxSupportReason: null,
        },
      }),
      stageClient.transaction.update({
        where: { id: fixture.transactionId },
        data: { qboType: 'Deposit', amount: '107.00' },
      }),
      stageClient.qboTaxRate.create({
        data: {
          companyId: fixture.companyId,
          qboId: 'sales-rate-7',
          name: 'Generic sales rate',
          rateValue: 7,
        },
      }),
      stageClient.qboTaxCode.create({
        data: {
          companyId: fixture.companyId,
          qboId: 'sales-code-standard',
          name: 'Generic sales tax',
          taxable: true,
          purchaseTaxRateList: [],
          salesTaxRateList: [{ taxRateQboId: 'sales-rate-7', taxTypeApplicable: 'TaxOnAmount' }],
          combinedSalesRate: 7,
        },
      }),
    ]);
    return {
      ...fixture,
      key: { ...fixture.key, qboType: 'Deposit' },
      input: {
        ...fixture.input,
        proposal: {
          taxCalculation: 'TaxInclusive',
          lines: [{
            grossCents: 10_700,
            categoryQboId: accountQboId,
            taxCodeQboId: 'sales-code-standard',
            memo: 'Generic deposit line',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
    };
  }

  async function seedPreserveCurrentPurchase(): Promise<Fixture> {
    const fixture = await seed();
    const target = await stageClient.qboAccount.create({
      data: {
        companyId: fixture.companyId,
        qboId: '42',
        name: 'Bank Charges',
        fullName: 'Expenses · Bank Charges',
        classification: 'Expenses',
      },
    });
    await stageClient.transaction.update({
      where: { id: fixture.transactionId },
      data: {
        amount: '-750.00',
        category: 'Uncategorized Expense',
        categoryQboId: '2',
        taxCalculation: 'NotApplicable',
        taxCode: 'Non-taxable',
        taxCodeQboId: 'NON',
        rawData: {
          Id: fixture.key.qboId,
          SyncToken: '0',
          TotalAmt: 750,
          GlobalTaxCalculation: 'NotApplicable',
          Line: [{
            Id: '1',
            Amount: 750,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '2' },
              TaxCodeRef: { value: 'NON' },
            },
          }],
        },
      },
    });
    await Promise.all([
      stageClient.qboAccount.create({
        data: {
          companyId: fixture.companyId,
          qboId: '2',
          name: 'Uncategorized Expense',
          fullName: 'Expenses · Uncategorized Expense',
          classification: 'Expenses',
        },
      }),
      stageClient.qboTaxCode.create({
        data: {
          companyId: fixture.companyId,
          qboId: 'NON',
          name: 'Non-taxable',
          taxable: false,
          purchaseTaxRateList: [],
          salesTaxRateList: [],
        },
      }),
    ]);
    return {
      ...fixture,
      input: {
        ...fixture.input,
        proposal: {
          taxDisposition: 'preserve_current',
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -75_000,
            categoryQboId: target.qboId,
            taxCodeQboId: 'NON',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
    };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await stageClient.qboEntityLease.deleteMany({
      where: fixture.key,
    });
    await stageClient.company.deleteMany({
      where: { id: fixture.companyId },
    });
  }

  function realStageDeps(client: PrismaClient): CategorizationDeps {
    return {
      db: client as unknown as CategorizationDb,
      lease: (key, owner, callback) => withEntityLease(key, owner, callback, {
        db: client as unknown as EntityLeaseDb,
      }),
      fence: (key, owner, tx) => fenceEntityLeaseOwnership(key, owner, {
        db: tx as unknown as EntityLeaseFenceDb,
      }),
      invocationId: randomUUID,
    };
  }

  function attemptData(fixture: Fixture, status: string) {
    const requestId = randomUUID();
    return {
      transactionId: fixture.transactionId,
      requestId,
      operation: 'COMMIT_CATEGORIZATION',
      status,
      expectedRevision: 0,
      expectedSyncToken: '0',
      requestHash: `hash-${requestId}`,
      requestPayload: { requestId, kind: 'generic-test' },
      beforeSnapshot: { syncToken: '0', kind: 'generic-test' },
    };
  }

  it('stages positive Deposit sales tax with database-backed references', async () => {
    const fixture = await seedDepositSalesTax();

    try {
      await expect(
        stageCategorization(fixture.input, realStageDeps(stageClient)),
      ).resolves.toMatchObject({
        transactionId: fixture.transactionId,
        revision: 1,
        totals: { subtotalCents: 10_000, taxCents: 700, totalCents: 10_700 },
        lines: [{ subtotalCents: 10_000, taxCents: 700, totalCents: 10_700 }],
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('persists an exact preserve-current Purchase intent from synchronized QBO references', async () => {
    const fixture = await seedPreserveCurrentPurchase();

    try {
      await expect(
        stageCategorization(fixture.input, realStageDeps(stageClient)),
      ).resolves.toMatchObject({
        transactionId: fixture.transactionId,
        revision: 1,
        taxDisposition: 'preserve_current',
        taxCalculation: 'NotApplicable',
        totals: { subtotalCents: -75_000, taxCents: 0, totalCents: -75_000 },
        lines: [{
          categoryQboId: '42',
          taxCodeQboId: 'NON',
          totalCents: -75_000,
        }],
      });
      await expect(stageClient.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
        select: {
          taxCalculation: true,
          taxCodeQboId: true,
          splitLines: {
            select: { categoryQboId: true, taxCodeQboId: true },
          },
        },
      })).resolves.toEqual({
        taxCalculation: 'NotApplicable',
        taxCodeQboId: 'NON',
        splitLines: [{ categoryQboId: '42', taxCodeQboId: 'NON' }],
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('persists synchronized NON when QBO tax-code inventory omits the sentinel', async () => {
    const fixture = await seedPreserveCurrentPurchase();
    await stageClient.qboTaxCode.deleteMany({
      where: { companyId: fixture.companyId, qboId: 'NON' },
    });

    try {
      await expect(
        stageCategorization(fixture.input, realStageDeps(stageClient)),
      ).resolves.toMatchObject({
        transactionId: fixture.transactionId,
        revision: 1,
        taxDisposition: 'preserve_current',
        taxCalculation: 'NotApplicable',
        lines: [{
          categoryQboId: '42',
          taxCodeQboId: 'NON',
          totalCents: -75_000,
        }],
      });
      await expect(stageClient.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
        select: {
          taxCode: true,
          taxCodeQboId: true,
          splitLines: { select: { taxCode: true, taxCodeQboId: true } },
        },
      })).resolves.toEqual({
        taxCode: 'NON',
        taxCodeQboId: 'NON',
        splitLines: [{ taxCode: 'NON', taxCodeQboId: 'NON' }],
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('makes stage lose without mutation while a leased PREPARED insert commits', async () => {
    const fixture = await seed();
    const inserted = deferred();
    const allowCommit = deferred();
    const leaseOwner = `attempt-${randomUUID()}`;
    let attemptTransaction: Promise<unknown> | undefined;

    try {
      await acquireEntityLease(fixture.key, leaseOwner, {
        db: attemptClient as unknown as EntityLeaseDb,
      });
      attemptTransaction = attemptClient.$transaction(async (tx) => {
        await tx.qboMutationAttempt.create({
          data: attemptData(fixture, 'PREPARED'),
        });
        inserted.resolve();
        await allowCommit.promise;
      });
      await inserted.promise;

      await expect(
        stageCategorization(fixture.input, realStageDeps(stageClient)),
      ).rejects.toMatchObject({
        name: 'EntityLeaseError',
        code: 'ENTITY_BUSY',
      });

      const beforeAttemptCommit = await stageClient.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
        select: { revision: true, splitLines: { select: { id: true } } },
      });
      expect(beforeAttemptCommit).toEqual({ revision: 0, splitLines: [] });

      allowCommit.resolve();
      await attemptTransaction;
      attemptTransaction = undefined;

      const [transaction, activeAttempt] = await Promise.all([
        stageClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true, splitLines: { select: { id: true } } },
        }),
        stageClient.qboMutationAttempt.findFirst({
          where: { transactionId: fixture.transactionId, status: 'PREPARED' },
          select: { id: true },
        }),
      ]);
      expect(transaction).toEqual({ revision: 0, splitLines: [] });
      expect(activeAttempt).not.toBeNull();
    } finally {
      allowCommit.resolve();
      await attemptTransaction;
      await releaseEntityLease(fixture.key, leaseOwner, {
        db: attemptClient as unknown as EntityLeaseDb,
      });
      await cleanup(fixture);
    }
  }, 30_000);

  it('lets stage commit after an attempt creator loses the common lease', async () => {
    const fixture = await seed();
    const leaseHeld = deferred();
    const allowStageTransaction = deferred();

    try {
      const stagePromise = stageCategorization(fixture.input, {
        ...realStageDeps(stageClient),
        lease: (key, owner, callback) => withEntityLease(key, owner, async () => {
          leaseHeld.resolve();
          await allowStageTransaction.promise;
          return callback();
        }, {
          db: stageClient as unknown as EntityLeaseDb,
        }),
      });
      await leaseHeld.promise;

      await expect(
        withEntityLease(fixture.key, `attempt-${randomUUID()}`, async () => {
          await attemptClient.qboMutationAttempt.create({
            data: attemptData(fixture, 'PREPARED'),
          });
        }, {
          db: attemptClient as unknown as EntityLeaseDb,
        }),
      ).rejects.toMatchObject({
        name: 'EntityLeaseError',
        code: 'ENTITY_BUSY',
      });

      allowStageTransaction.resolve();
      await expect(stagePromise).resolves.toMatchObject({
        transactionId: fixture.transactionId,
        revision: 1,
      });

      const [transaction, attemptCount] = await Promise.all([
        stageClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true, splitLines: { select: { id: true } } },
        }),
        stageClient.qboMutationAttempt.count({
          where: { transactionId: fixture.transactionId },
        }),
      ]);
      expect(transaction.revision).toBe(1);
      expect(transaction.splitLines).toHaveLength(1);
      expect(attemptCount).toBe(0);
    } finally {
      allowStageTransaction.resolve();
      await cleanup(fixture);
    }
  }, 30_000);

  it('reloads after blocked reacquisition so a stale prepared revision cannot enter COMMITTING', async () => {
    const fixture = await seed();
    const actorId = randomUUID();
    const requestId = randomUUID();
    const initialStage = await stageCategorization(
      fixture.input,
      realStageDeps(stageClient),
    );
    expect(initialStage.revision).toBe(1);

    const beforeSnapshot: QboPurchaseSnapshot = {
      qboId: fixture.key.qboId,
      syncToken: '0',
      totalCents: -1050,
      accountQboId: 'payment-generic',
      date: '2026-07-28',
      direction: 'purchase',
      globalTaxCalculation: null,
      totalTaxCents: null,
      lines: [{
        id: 'holding-line',
        amountCents: -1050,
        description: null,
        accountQboId: 'holding-generic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: null,
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    };
    const prepared: QboPreparedWrite = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: fixture.key.qboId,
      requestId,
      requestHash: `hash-${requestId}`,
      body: {
        Id: fixture.key.qboId,
        SyncToken: '0',
        TxnDate: '2026-07-28',
        TotalAmt: 10.5,
        GlobalTaxCalculation: 'NotApplicable',
        AccountRef: { value: 'payment-generic' },
        Line: [{
          Amount: 10.5,
          Description: 'Lease race line',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: fixture.input.proposal.lines[0]!.categoryQboId },
          },
        }],
      },
      before: structuredClone(beforeSnapshot),
      expected: {
        qboId: fixture.key.qboId,
        totalCents: -1050,
        accountQboId: 'payment-generic',
        date: '2026-07-28',
        direction: 'purchase',
        globalTaxCalculation: null,
        totalTaxCents: null,
        targetLines: [{
          id: null,
          amountCents: -1050,
          description: 'Lease race line',
          accountQboId: fixture.input.proposal.lines[0]!.categoryQboId,
          customerQboId: null,
          classQboId: null,
          taxCodeQboId: null,
          taxAmountCents: null,
          taxInclusiveCents: null,
        }],
        untouchedLineHashes: [],
      },
    };
    const freshTxn: QboTxn = {
      qboId: fixture.key.qboId,
      qboType: 'Purchase',
      syncToken: '0',
      date: '2026-07-28',
      payee: 'PostgreSQL lease fixture',
      amount: -10.5,
      bankAccount: 'Test bank',
      lines: [{
        id: 'holding-line',
        amount: -10.5,
        accountQboId: 'holding-generic',
        accountName: 'Holding',
      }],
      raw: {},
    };
    const prepareStarted = deferred();
    const allowPreparation = deferred();
    const stageAtCas = deferred();
    const allowStageCommit = deferred();
    const finalRenewStarted = deferred();
    const sendStarted = deferred();
    const sendPreparedWrite = vi.fn(async () => {
      sendStarted.resolve();
      throw new Error('send must remain unreachable');
    });
    const client: Partial<QboClient> = {
      fetchTxn: vi.fn(async () => structuredClone(freshTxn)),
      fetchPurchaseSnapshot: vi.fn(async () => structuredClone(beforeSnapshot)),
      fetchPreparedSnapshot: vi.fn(async () => structuredClone(beforeSnapshot)),
      fetchWriteSafety: vi.fn(async () => ({
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
      })),
      preparePurchaseRecategorization: vi.fn(async () => {
        prepareStarted.resolve();
        await allowPreparation.promise;
        return structuredClone(prepared);
      }),
      prepareRecategorization: vi.fn(async () => {
        prepareStarted.resolve();
        await allowPreparation.promise;
        return structuredClone(prepared);
      }),
      sendPreparedWrite,
    };
    let renewCount = 0;
    const writebackDeps: DurableWritebackDeps = {
      db: attemptClient as unknown as DurableWritebackDb,
      getClient: async () => client as QboClient,
      audit: async () => undefined,
      authorize: async () => true,
      envDryRun: false,
      lease: (key, owner, callback) => withEntityLease(key, owner, callback, {
        db: attemptClient as unknown as EntityLeaseDb,
        ttlMs: 20,
      }),
      renewLease: async (key, owner) => {
        renewCount += 1;
        if (renewCount === 2) finalRenewStarted.resolve();
        for (let retries = 0; retries < 100; retries += 1) {
          try {
            await acquireEntityLease(key, owner, {
              db: attemptClient as unknown as EntityLeaseDb,
              ttlMs: 20,
            });
            return;
          } catch (error) {
            if (
              typeof error !== 'object'
              || error === null
              || !('code' in error)
              || error.code !== 'ENTITY_BUSY'
            ) throw error;
            await delay(5);
          }
        }
        throw new Error('Timed out waiting to reacquire the test entity lease.');
      },
      invocationId: randomUUID,
      now: () => new Date(),
    };
    let commitOutcome: Promise<
      | { kind: 'resolved'; value: unknown }
      | { kind: 'rejected'; error: unknown }
    > | undefined;
    let stagePromise: Promise<unknown> | undefined;

    try {
      commitOutcome = commitStagedCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId,
        actor: { id: actorId, label: 'PostgreSQL Test Actor' },
      }, writebackDeps).then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      await prepareStarted.promise;
      await delay(40);

      stagePromise = stageCategorization({
        ...fixture.input,
        expectedRevision: 1,
        proposal: {
          ...fixture.input.proposal,
          lines: fixture.input.proposal.lines.map((line) => ({
            ...line,
            memo: 'Lease race replacement',
          })),
        },
      }, {
        ...realStageDeps(stageClient),
        lease: (key, owner, callback) => withEntityLease(key, owner, callback, {
          db: stageClient as unknown as EntityLeaseDb,
          ttlMs: 20,
        }),
        afterRevisionCas: async () => {
          stageAtCas.resolve();
          await allowStageCommit.promise;
        },
      });
      await stageAtCas.promise;
      allowPreparation.resolve();
      await finalRenewStarted.promise;

      const sentWhileStageWasLive = await Promise.race([
        sendStarted.promise.then(() => true),
        delay(50).then(() => false),
      ]);
      expect(sentWhileStageWasLive).toBe(false);

      allowStageCommit.resolve();
      await expect(stagePromise).resolves.toMatchObject({
        transactionId: fixture.transactionId,
        revision: 2,
      });
      stagePromise = undefined;

      const outcome = await commitOutcome;
      commitOutcome = undefined;
      expect(outcome).toMatchObject({
        kind: 'rejected',
        error: { code: 'STALE_REVISION' },
      });

      const [transaction, forbiddenAttemptCount] = await Promise.all([
        stageClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true, splitLines: { select: { id: true } } },
        }),
        stageClient.qboMutationAttempt.count({
          where: {
            transactionId: fixture.transactionId,
            expectedRevision: 1,
            status: { in: ['COMMITTING', 'UNCERTAIN'] },
          },
        }),
      ]);
      expect(transaction.revision).toBe(2);
      expect(transaction.splitLines).toHaveLength(1);
      expect(forbiddenAttemptCount).toBe(0);
      expect(sendPreparedWrite).not.toHaveBeenCalled();
    } finally {
      allowPreparation.resolve();
      allowStageCommit.resolve();
      await Promise.allSettled([
        stagePromise ?? Promise.resolve(),
        commitOutcome ?? Promise.resolve(),
      ]);
      await cleanup(fixture);
    }
  }, 30_000);

  it.each(['PREPARED', 'COMMITTING', 'UNCERTAIN'])(
    'sequentially rejects an active %s attempt without changing staged rows',
    async (status) => {
      const fixture = await seed();
      try {
        await attemptClient.qboMutationAttempt.create({
          data: attemptData(fixture, status),
        });

        await expect(
          stageCategorization(fixture.input, realStageDeps(stageClient)),
        ).rejects.toMatchObject({
          name: 'CategorizationError',
          code: 'MUTATION_BLOCKED',
        });

        const transaction = await stageClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true, splitLines: { select: { id: true } } },
        });
        expect(transaction).toEqual({ revision: 0, splitLines: [] });
      } finally {
        await cleanup(fixture);
      }
    },
    30_000,
  );
});
