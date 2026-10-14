import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '../../lib/db.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  projectTransferState,
  type TransferAttemptStatus,
} from '../transferExecution.js';
import type { TransferOperationRecord } from '../transferOperations.js';
import {
  createPreparedOperation,
  type CreatePreparedOperationInput,
} from './operations.js';
import {
  getMcpTransferOperation,
  type McpTransferStore,
  type StoredMcpTransferPayload,
} from './transfers.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date();

describePostgres('MCP transfer PostgreSQL durability', () => {
  let first: PrismaClient;
  let second: PrismaClient;

  beforeAll(() => {
    first = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    second = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterAll(async () => {
    await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  });

  it('atomically rolls back a failed private envelope and converges replay across restart', async () => {
    const suffix = randomUUID();
    const user = await first.user.create({
      data: {
        email: `mcp-transfer-${suffix}@example.invalid`,
        name: 'Transfer fixture',
      },
    });
    const company = await first.company.create({
      data: {
        realmId: `mcp-transfer-${suffix}`,
        legalName: 'Transfer fixture',
        nickname: `transfer-${suffix.slice(0, 8)}`,
      },
    });
    await first.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await first.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_pgtrans1',
        label: 'Transfer fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      },
    });
    const transactions = await Promise.all([
      first.transaction.create({
        data: {
          companyId: company.id,
          qboId: `purchase-${suffix}`,
          qboType: 'Purchase',
          qboSyncToken: '3',
          date: NOW,
          payee: 'Fixture',
          amount: '-12.50',
          bankAccount: 'Account one',
          revision: 2,
        },
      }),
      first.transaction.create({
        data: {
          companyId: company.id,
          qboId: `deposit-${suffix}`,
          qboType: 'Deposit',
          qboSyncToken: '4',
          date: NOW,
          payee: 'Fixture',
          amount: '12.50',
          bankAccount: 'Account two',
          revision: 5,
        },
      }),
    ]);
    const principal: McpPrincipal = {
      tokenId: token.id,
      tokenPrefix: token.prefix,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const coordinatorId = randomUUID();
    const coordinator: TransferOperationRecord = {
      id: coordinatorId,
      actorId: user.id,
      companyId: company.id,
      firstTransactionId: transactions[0].id,
      secondTransactionId: transactions[1].id,
      firstExpectedRevision: 2,
      secondExpectedRevision: 5,
      firstQboType: 'Purchase',
      firstQboId: transactions[0].qboId,
      firstQboSyncToken: '3',
      firstTargetAccountQboId: `target-a-${suffix}`,
      firstAttemptRequestId: `${coordinatorId}-t0`,
      secondQboType: 'Deposit',
      secondQboId: transactions[1].qboId,
      secondQboSyncToken: '4',
      secondTargetAccountQboId: `target-b-${suffix}`,
      secondAttemptRequestId: `${coordinatorId}-t1`,
      idempotencyHash: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      preparedHash: 'c'.repeat(64),
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
      retryOfId: null,
      createdAt: NOW,
    };
    const payload: StoredMcpTransferPayload = {
      transferOperationId: coordinator.id,
      first: {
        qboType: coordinator.firstQboType,
        qboId: coordinator.firstQboId,
        qboSyncToken: coordinator.firstQboSyncToken,
      },
      second: {
        transactionId: coordinator.secondTransactionId,
        qboType: coordinator.secondQboType,
        qboId: coordinator.secondQboId,
        qboSyncToken: coordinator.secondQboSyncToken,
      },
      preview: {
        action: 'record_transfer',
        direction: 'between_accounts',
        totalCents: 1_250,
        legCount: 2,
        preparationDigest: coordinator.preparedHash,
      },
    };
    const operationInput: CreatePreparedOperationInput = {
      principal,
      companyId: company.id,
      transactionId: coordinator.firstTransactionId,
      toolName: 'prepare_transfer',
      kind: 'transfer',
      idempotencyKey: `transfer-${suffix}`,
      payload,
      sourceRevision: 2,
      preparedRevision: 2,
      qboType: coordinator.firstQboType,
      qboId: coordinator.firstQboId,
      qboSyncToken: coordinator.firstQboSyncToken,
      retryOfId: null,
    };

    await expect(first.$transaction(async (tx) => {
      await tx.qboTransferOperation.create({ data: coordinator });
      await tx.qboMutationAttempt.createMany({
        data: attemptRows(coordinator),
      });
      await createPreparedOperation(operationInput, { store: tx, now: () => NOW });
      throw new Error('simulate envelope crash');
    })).rejects.toThrow('simulate envelope crash');
    await expect(first.qboTransferOperation.count({
      where: { id: coordinator.id },
    })).resolves.toBe(0);
    await expect(first.qboMutationAttempt.count({
      where: {
        requestId: {
          in: [
            coordinator.firstAttemptRequestId,
            coordinator.secondAttemptRequestId,
          ],
        },
      },
    })).resolves.toBe(0);

    await first.$transaction(async (tx) => {
      await tx.qboTransferOperation.create({ data: coordinator });
      await tx.qboMutationAttempt.createMany({ data: attemptRows(coordinator) });
    });
    const [created, replay] = await Promise.all([
      createPreparedOperation(operationInput, { store: first, now: () => NOW }),
      createPreparedOperation(operationInput, { store: second, now: () => NOW }),
    ]);
    expect(replay.id).toBe(created.id);

    const getTransfer = (client: PrismaClient) => async () => {
      const attempts = await client.qboMutationAttempt.findMany({
        where: {
          requestId: {
            in: [
              coordinator.firstAttemptRequestId,
              coordinator.secondAttemptRequestId,
            ],
          },
        },
        orderBy: { requestId: 'asc' },
      });
      const projection = projectTransferState(
        attempts[0]!.status as TransferAttemptStatus,
        attempts[1]!.status as TransferAttemptStatus,
      );
      return { operationId: coordinator.id, ...projection };
    };
    const restarted = await getMcpTransferOperation(principal, created.id, {
      store: second as unknown as McpTransferStore,
      getTransfer: getTransfer(second),
      now: () => NOW,
    });
    expect(restarted).toMatchObject({
      state: 'prepared',
      actions: { canCommit: true },
    });

    await first.qboMutationAttempt.update({
      where: { requestId: coordinator.firstAttemptRequestId },
      data: { status: 'VERIFIED' },
    });
    await first.qboMutationAttempt.update({
      where: { requestId: coordinator.secondAttemptRequestId },
      data: { status: 'UNCHANGED' },
    });
    const partial = await getMcpTransferOperation(principal, created.id, {
      store: second as unknown as McpTransferStore,
      getTransfer: getTransfer(second),
      now: () => NOW,
    });
    expect(partial).toMatchObject({
      state: 'retryable',
      result: {
        firstLeg: { outcome: 'VERIFIED' },
        secondLeg: { outcome: 'UNCHANGED' },
      },
      actions: { canRetry: true },
    });

    await first.mcpToken.update({
      where: { id: token.id },
      data: { revokedAt: NOW },
    });
    await expect(getMcpTransferOperation(principal, created.id, {
      store: second as unknown as McpTransferStore,
      getTransfer: getTransfer(second),
      now: () => new Date(NOW.getTime() + 1),
    })).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
  }, 30_000);
});

function attemptRows(coordinator: TransferOperationRecord) {
  return [
    {
      transactionId: coordinator.firstTransactionId,
      requestId: coordinator.firstAttemptRequestId,
      operation: 'transfer',
      status: 'PREPARED',
      expectedRevision: coordinator.firstExpectedRevision,
      expectedSyncToken: coordinator.firstQboSyncToken,
      requestHash: 'request-first',
      requestPayload: {},
      beforeSnapshot: {},
    },
    {
      transactionId: coordinator.secondTransactionId,
      requestId: coordinator.secondAttemptRequestId,
      operation: 'transfer',
      status: 'PREPARED',
      expectedRevision: coordinator.secondExpectedRevision,
      expectedSyncToken: coordinator.secondQboSyncToken,
      requestHash: 'request-second',
      requestPayload: {},
      beforeSnapshot: {},
    },
  ];
}
