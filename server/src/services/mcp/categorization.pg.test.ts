import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  fenceEntityLeaseOwnership,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from '../entityLease.js';
import type {
  CategorizationDb,
  CategorizationDeps,
} from '../categorization.js';
import {
  prepareMcpCategorization,
  type McpCategorizationAuthorizationStore,
  type PrepareMcpCategorizationInput,
} from './categorization.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-29T12:00:00.000Z');

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface Fixture {
  userId: string;
  companyId: string;
  transactionId: string;
  principal: McpPrincipal;
  input: PrepareMcpCategorizationInput;
  leaseKey: EntityLeaseKey;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describePostgres('MCP categorization PostgreSQL atomicity', () => {
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
    const user = await firstClient.user.create({
      data: {
        email: `mcp-categorization-${suffix}@example.invalid`,
        name: 'MCP PostgreSQL Fixture',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `mcp-categorization-${suffix}`,
        legalName: 'MCP PostgreSQL Fixture',
        nickname: `mcp-${suffix.slice(0, 8)}`,
        dryRun: false,
        holdingAccountIds: ['holding'],
      },
    });
    await firstClient.membership.create({
      data: {
        userId: user.id,
        companyId: company.id,
        role: 'categorizer',
      },
    });
    const token = await firstClient.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_pgcat01',
        label: 'MCP PostgreSQL Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const account = await firstClient.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `expense-${suffix}`,
        name: 'Fixture expense',
        fullName: 'Expenses · Fixture expense',
        classification: 'Expenses',
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'MCP PostgreSQL Fixture',
        amount: '-10.50',
        bankAccount: 'Fixture bank',
        rawData: {
          Id: `purchase-${suffix}`, SyncToken: '0', TotalAmt: 10.5,
          TxnDate: '2026-07-29', AccountRef: { value: 'payment-generic' },
          GlobalTaxCalculation: 'NotApplicable',
          Line: [{
            Id: '1', Amount: 10.5, DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding' } },
          }],
        },
      },
    });
    await firstClient.transactionActionability.create({
      data: {
        companyId: company.id,
        transactionId: transaction.id,
        disposition: 'WRITABLE',
        checkedAt: NOW,
        revision: transaction.revision,
        qboSyncToken: transaction.qboSyncToken,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
        txnDate: transaction.date,
        cleared: false,
        reconciled: false,
      },
    });
    return {
      userId: user.id,
      companyId: company.id,
      transactionId: transaction.id,
      principal: {
        tokenId: token.id,
        tokenPrefix: token.prefix,
        userId: user.id,
        isInstanceAdmin: false,
        memberships: [{
          companyId: company.id,
          role: 'categorizer',
        }],
      },
      input: {
        companyId: company.id,
        transactionId: transaction.id,
        expectedRevision: 0,
        idempotencyKey: `prepare-${suffix}`,
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1050,
            categoryQboId: account.qboId,
            memo: 'PostgreSQL fixture',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
      leaseKey: {
        companyId: company.id,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
      },
    };
  }

  function categorizationDeps(
    client: PrismaClient,
    afterRevisionCas?: () => Promise<void>,
  ): CategorizationDeps {
    return {
      db: client as unknown as CategorizationDb,
      lease: (key, owner, callback) => withEntityLease(key, owner, callback, {
        db: client as unknown as EntityLeaseDb,
      }),
      fence: (key, owner, transaction) => fenceEntityLeaseOwnership(
        key,
        owner,
        { db: transaction as unknown as EntityLeaseFenceDb },
      ),
      invocationId: randomUUID,
      afterRevisionCas,
    };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await firstClient.qboEntityLease.deleteMany({
      where: fixture.leaseKey,
    });
    await firstClient.company.deleteMany({
      where: { id: fixture.companyId },
    });
    await firstClient.user.deleteMany({
      where: { id: fixture.userId },
    });
  }

  it('keeps an overlapping exact request safe, then replays one revision and one operation', async () => {
    const fixture = await seed();
    const stagedAtCas = deferred();
    const allowFirstCommit = deferred();
    let firstPrepare: Promise<unknown> | undefined;

    try {
      firstPrepare = prepareMcpCategorization(
        fixture.principal,
        fixture.input,
        {
          authorizationStore:
            firstClient as unknown as McpCategorizationAuthorizationStore,
          categorization: categorizationDeps(firstClient, async () => {
            stagedAtCas.resolve();
            await allowFirstCommit.promise;
          }),
          now: () => NOW,
        },
      );
      await Promise.race([stagedAtCas.promise, firstPrepare]);

      await expect(prepareMcpCategorization(
        fixture.principal,
        fixture.input,
        {
          authorizationStore:
            secondClient as unknown as McpCategorizationAuthorizationStore,
          categorization: categorizationDeps(secondClient),
          now: () => NOW,
        },
      )).rejects.toMatchObject({
        code: 'ENTITY_BUSY',
        message: 'Another write is in progress. Retry with the same idempotency key.',
      });

      allowFirstCommit.resolve();
      const first = await firstPrepare;
      firstPrepare = undefined;
      const replay = await prepareMcpCategorization(
        fixture.principal,
        fixture.input,
        {
          authorizationStore:
            secondClient as unknown as McpCategorizationAuthorizationStore,
          categorization: categorizationDeps(secondClient),
          now: () => new Date(NOW.getTime() + 1_000),
        },
      );

      expect(replay).toEqual(first);
      const [transaction, operationCount] = await Promise.all([
        firstClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true },
        }),
        firstClient.mcpOperation.count({
          where: {
            tokenId: fixture.principal.tokenId,
            transactionId: fixture.transactionId,
            toolName: 'prepare_categorization',
            idempotencyKey: fixture.input.idempotencyKey,
          },
        }),
      ]);
      expect(transaction.revision).toBe(1);
      expect(operationCount).toBe(1);
    } finally {
      allowFirstCommit.resolve();
      await firstPrepare;
      await cleanup(fixture);
    }
  }, 30_000);

  it('rolls back the staged revision and rows when operation persistence fails', async () => {
    const fixture = await seed();
    const persistenceError = new Error('forced operation persistence failure');

    try {
      await expect(prepareMcpCategorization(
        fixture.principal,
        fixture.input,
        {
          authorizationStore:
            firstClient as unknown as McpCategorizationAuthorizationStore,
          categorization: categorizationDeps(firstClient),
          now: () => NOW,
          createOperation: async () => {
            throw persistenceError;
          },
        },
      )).rejects.toBe(persistenceError);

      const [transaction, splitCount, operationCount] = await Promise.all([
        firstClient.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
          select: { revision: true },
        }),
        firstClient.splitLine.count({
          where: { txnId: fixture.transactionId },
        }),
        firstClient.mcpOperation.count({
          where: {
            tokenId: fixture.principal.tokenId,
            transactionId: fixture.transactionId,
          },
        }),
      ]);
      expect(transaction.revision).toBe(0);
      expect(splitCount).toBe(0);
      expect(operationCount).toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });
});
