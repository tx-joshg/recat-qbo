import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '../../lib/db.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  createPreparedOperation,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
  type McpOperationStore,
} from './operations.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-29T12:00:00.000Z');

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

function operationInput(
  overrides: Partial<CreatePreparedOperationInput> = {},
): CreatePreparedOperationInput {
  const principal: McpPrincipal = {
    tokenId: randomUUID(),
    tokenPrefix: 'rct_pgtest01',
    userId: randomUUID(),
    isInstanceAdmin: false,
    memberships: [],
  };
  return {
    principal,
    companyId: randomUUID(),
    transactionId: randomUUID(),
    toolName: 'prepare_categorization',
    kind: 'categorization',
    idempotencyKey: `pg-${randomUUID()}`,
    payload: {
      proposal: {
        lines: [{ grossCents: -100, categoryQboId: 'expense-1' }],
        tagIds: [],
      },
    },
    sourceRevision: 0,
    preparedRevision: 1,
    qboType: 'Purchase',
    qboId: `purchase-${randomUUID()}`,
    qboSyncToken: '0',
    retryOfId: null,
    ...overrides,
  };
}

function barrierStore(
  transaction: Prisma.TransactionClient,
  reachedPreflight: Deferred,
  releasePreflight: Deferred,
): McpOperationStore {
  let paused = false;
  return {
    mcpOperation: {
      async findFirst({ where }) {
        const row = await transaction.mcpOperation.findFirst({ where });
        if (
          !paused
          && row === null
          && where.idempotencyKey !== undefined
          && where.id === undefined
        ) {
          paused = true;
          reachedPreflight.resolve();
          await releasePreflight.promise;
        }
        return row as unknown as McpOperationRecord | null;
      },
      async createMany({ data, skipDuplicates }) {
        return transaction.mcpOperation.createMany({
          data,
          skipDuplicates,
        });
      },
    },
  };
}

describePostgres('MCP operation PostgreSQL durability', () => {
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

  it('returns one exact replay for a uniqueness race inside caller transactions', async () => {
    const input = operationInput();
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();

    const first = firstClient.$transaction(
      (transaction) => createPreparedOperation(input, {
        store: barrierStore(transaction, firstReady, release),
        now: () => NOW,
      }),
      { timeout: 30_000 },
    );
    const second = secondClient.$transaction(
      (transaction) => createPreparedOperation(input, {
        store: barrierStore(transaction, secondReady, release),
        now: () => NOW,
      }),
      { timeout: 30_000 },
    );

    await Promise.all([firstReady.promise, secondReady.promise]);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    await expect(firstClient.mcpOperation.count({
      where: {
        tokenId: input.principal.tokenId,
        toolName: input.toolName,
        transactionId: input.transactionId,
        idempotencyKey: input.idempotencyKey,
      },
    })).resolves.toBe(1);
  }, 30_000);

  it('persists well-formed Unicode and rejects JSONB-invalid boundaries before insert', async () => {
    const valid = await createPreparedOperation(operationInput({
      payload: {
        memo: 'Cafe\u0301 ☕\nreviewed',
        proposal: { lines: [], tagIds: [] },
      },
    }), { store: firstClient, now: () => NOW });

    await expect(firstClient.mcpOperation.findUnique({
      where: { id: valid.id },
      select: { payload: true },
    })).resolves.toEqual({
      payload: {
        memo: 'Café ☕\nreviewed',
        proposal: { lines: [], tagIds: [] },
      },
    });

    for (const payload of [
      { memo: '\u0000' },
      { memo: '\uD800' },
      { memo: '\uDC00' },
      null,
    ]) {
      await expect(createPreparedOperation(operationInput({ payload }), {
        store: firstClient,
        now: () => NOW,
      })).rejects.toMatchObject({ code: 'OPERATION_INVALID_INPUT' });
    }
  });

  it('allows only first cancellation and blocks immutable updates and deletion', async () => {
    const operation = await createPreparedOperation(operationInput(), {
      store: firstClient,
      now: () => NOW,
    });

    await expect(firstClient.mcpOperation.update({
      where: { id: operation.id },
      data: { payload: { tampered: true } },
    })).rejects.toThrow('McpOperation immutable fields cannot be changed');

    const cancelledAt = new Date(NOW.getTime() + 1_000);
    await expect(firstClient.mcpOperation.update({
      where: { id: operation.id },
      data: { cancelledAt },
    })).resolves.toMatchObject({ cancelledAt });

    await expect(firstClient.mcpOperation.update({
      where: { id: operation.id },
      data: { cancelledAt: new Date(cancelledAt.getTime() + 1_000) },
    })).rejects.toThrow('McpOperation immutable fields cannot be changed');
    await expect(firstClient.mcpOperation.delete({
      where: { id: operation.id },
    })).rejects.toThrow('McpOperation immutable fields cannot be changed');
  });
});
