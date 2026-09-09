import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import type { DurableMutationResult } from '../writeback.js';
import { createPreparedOperation } from './operations.js';
import {
  retryMcpOperation,
  type McpOperationExecutionStore,
} from './reconciliation.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-29T12:00:00.000Z');

describePostgres('MCP reconciliation PostgreSQL concurrency', () => {
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

  it('converges concurrent retry callers on one child and one PREPARED attempt', async () => {
    const suffix = randomUUID();
    const user = await firstClient.user.create({
      data: {
        email: `mcp-reconciliation-${suffix}@example.invalid`,
        name: 'MCP PostgreSQL Fixture',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `mcp-reconciliation-${suffix}`,
        legalName: 'MCP PostgreSQL Fixture',
        nickname: `mcp-${suffix.slice(0, 8)}`,
      },
    });
    await firstClient.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await firstClient.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_pgrecon1',
        label: 'MCP PostgreSQL Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: NOW,
        payee: 'MCP PostgreSQL Fixture',
        amount: '-10.00',
        bankAccount: 'Fixture bank',
        revision: 1,
      },
    });
    const principal: McpPrincipal = {
      tokenId: token.id,
      tokenPrefix: token.prefix,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const root = await createPreparedOperation({
      principal,
      companyId: company.id,
      transactionId: transaction.id,
      toolName: 'prepare_categorization',
      kind: 'categorization',
      idempotencyKey: `prepare-${suffix}`,
      payload: {
        proposal: {},
        preview: {
          transactionId: transaction.id,
          revision: 1,
          taxCalculation: 'NotApplicable',
          totals: { subtotalCents: -1000, taxCents: 0, totalCents: -1000 },
          lines: [{
            idx: 0,
            subtotalCents: -1000,
            taxCents: 0,
            totalCents: -1000,
            categoryQboId: 'expense-fixture',
            taxCodeQboId: null,
            memo: null,
            tagIds: [],
          }],
          tagIds: [],
        },
        warnings: [],
      },
      sourceRevision: 0,
      preparedRevision: 1,
      qboType: transaction.qboType,
      qboId: transaction.qboId,
      qboSyncToken: transaction.qboSyncToken,
      retryOfId: null,
    }, { store: firstClient, now: () => NOW });
    await firstClient.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: root.id,
        operation: 'recategorize',
        status: 'RETRYABLE',
        expectedRevision: 1,
        expectedSyncToken: '0',
        requestHash: 'root-retryable',
        requestPayload: {},
        beforeSnapshot: {},
      },
    });

    const commitWithoutQbo = (client: PrismaClient) => async (
      input: { transactionId: string; requestId: string; expectedRevision: number },
    ): Promise<DurableMutationResult> => {
      try {
        await client.qboMutationAttempt.create({
          data: {
            transactionId: input.transactionId,
            requestId: input.requestId,
            operation: 'recategorize',
            status: 'PREPARED',
            expectedRevision: input.expectedRevision,
            expectedSyncToken: '0',
            requestHash: `prepared-${input.requestId}`,
            requestPayload: {},
            beforeSnapshot: {},
          },
        });
      } catch (caught) {
        if (
          typeof caught !== 'object'
          || caught === null
          || !('code' in caught)
          || caught.code !== 'P2002'
        ) {
          throw caught;
        }
      }
      return {
        transactionId: input.transactionId,
        requestId: input.requestId,
        ok: false,
        status: 'PENDING',
        outcome: 'IN_PROGRESS',
      };
    };

    try {
      const [first, second] = await Promise.all([
        retryMcpOperation(principal, { operationId: root.id }, {
          store: firstClient as unknown as McpOperationExecutionStore,
          now: () => NOW,
          commit: commitWithoutQbo(firstClient),
          validateAttempt: (attempt) => ({
            operation: 'recategorize',
            qboType: transaction.qboType,
            qboId: transaction.qboId,
            requestId: attempt.requestId,
            requestHash: attempt.requestHash,
            expectedSyncToken: transaction.qboSyncToken,
          }),
        }),
        retryMcpOperation(principal, { operationId: root.id }, {
          store: secondClient as unknown as McpOperationExecutionStore,
          now: () => NOW,
          commit: commitWithoutQbo(secondClient),
          validateAttempt: (attempt) => ({
            operation: 'recategorize',
            qboType: transaction.qboType,
            qboId: transaction.qboId,
            requestId: attempt.requestId,
            requestHash: attempt.requestHash,
            expectedSyncToken: transaction.qboSyncToken,
          }),
        }),
      ]);

      expect(first.operationId).toBe(second.operationId);
      expect(first).toMatchObject({ state: 'prepared', phase: 'write_prepared' });
      await expect(firstClient.mcpOperation.count({
        where: { retryOfId: root.id },
      })).resolves.toBe(1);
      await expect(firstClient.qboMutationAttempt.count({
        where: { requestId: first.operationId },
      })).resolves.toBe(1);
    } finally {
      await firstClient.company.deleteMany({ where: { id: company.id } });
      await firstClient.user.deleteMany({ where: { id: user.id } });
    }
  }, 30_000);

  it('converges concurrent undo retries on one direct child and one restore attempt', async () => {
    const suffix = randomUUID();
    const user = await firstClient.user.create({
      data: {
        email: `mcp-undo-reconciliation-${suffix}@example.invalid`,
        name: 'MCP Undo Retry Fixture',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `mcp-undo-reconciliation-${suffix}`,
        legalName: 'MCP Undo Retry Fixture',
        nickname: `undo-${suffix.slice(0, 8)}`,
      },
    });
    await firstClient.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await firstClient.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(`undo-${suffix}`).digest('hex'),
        prefix: 'rct_pgretry1',
        label: 'MCP Undo Retry Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-undo-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '8',
        date: NOW,
        payee: 'MCP Undo Retry Fixture',
        amount: '-10.00',
        bankAccount: 'Fixture bank',
        revision: 2,
        status: 'POSTED',
      },
    });
    const principal: McpPrincipal = {
      tokenId: token.id,
      tokenPrefix: token.prefix,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const source = await createPreparedOperation({
      principal,
      companyId: company.id,
      transactionId: transaction.id,
      toolName: 'prepare_categorization',
      kind: 'categorization',
      idempotencyKey: `source-${suffix}`,
      payload: {
        proposal: {},
        preview: {
          transactionId: transaction.id,
          revision: 2,
          taxCalculation: 'NotApplicable',
          totals: { subtotalCents: -1000, taxCents: 0, totalCents: -1000 },
          lines: [{
            idx: 0,
            subtotalCents: -1000,
            taxCents: 0,
            totalCents: -1000,
            categoryQboId: 'expense-fixture',
            taxCodeQboId: null,
            memo: null,
            tagIds: [],
          }],
          tagIds: [],
        },
        warnings: [],
      },
      sourceRevision: 1,
      preparedRevision: 2,
      qboType: transaction.qboType,
      qboId: transaction.qboId,
      qboSyncToken: '7',
      retryOfId: null,
    }, { store: firstClient, now: () => NOW });
    await firstClient.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: source.id,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 2,
        expectedSyncToken: '7',
        requestHash: `source-${source.id}`,
        requestPayload: {},
        beforeSnapshot: {},
        responseSnapshot: {},
        verification: {
          outcome: 'VERIFIED',
          status: 'POSTED',
          newSyncToken: '8',
        },
      },
    });
    const root = await createPreparedOperation({
      principal,
      companyId: company.id,
      transactionId: transaction.id,
      toolName: 'prepare_undo',
      kind: 'undo',
      idempotencyKey: `undo-${suffix}`,
      payload: {
        sourceOperationId: source.id,
        sourcePreparedHash: 'a'.repeat(64),
        currentPostHash: 'b'.repeat(64),
        restoreHash: 'c'.repeat(64),
        preview: {
          action: 'restore_purchase_categorization',
          resultingStatus: 'PENDING',
          direction: 'purchase',
          totalCents: -1000,
          totalTaxCents: null,
          lineCount: 1,
          restorationDigest: 'c'.repeat(64),
        },
        warnings: [],
      },
      sourceRevision: 2,
      preparedRevision: 2,
      qboType: transaction.qboType,
      qboId: transaction.qboId,
      qboSyncToken: transaction.qboSyncToken,
      retryOfId: null,
    }, { store: firstClient, now: () => NOW });
    await firstClient.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: root.id,
        operation: 'restore',
        status: 'UNCHANGED',
        expectedRevision: 2,
        expectedSyncToken: '8',
        requestHash: 'root-undo-unchanged',
        requestPayload: {},
        beforeSnapshot: {},
        responseSnapshot: {},
        verification: { outcome: 'UNCHANGED', status: 'POSTED' },
      },
    });

    const undoWithoutQbo = (client: PrismaClient) => async (
      input: { transactionId: string; requestId: string },
    ): Promise<DurableMutationResult> => {
      try {
        await client.qboMutationAttempt.create({
          data: {
            transactionId: input.transactionId,
            requestId: input.requestId,
            operation: 'restore',
            status: 'PREPARED',
            expectedRevision: 2,
            expectedSyncToken: '8',
            requestHash: `prepared-${input.requestId}`,
            requestPayload: {},
            beforeSnapshot: {},
          },
        });
      } catch (caught) {
        if (
          typeof caught !== 'object'
          || caught === null
          || !('code' in caught)
          || caught.code !== 'P2002'
        ) {
          throw caught;
        }
      }
      return {
        transactionId: input.transactionId,
        requestId: input.requestId,
        ok: false,
        status: 'POSTED',
        outcome: 'IN_PROGRESS',
      };
    };
    const validateRestoreAttempt = (attempt: {
      requestId: string;
      requestHash: string;
      expectedSyncToken: string;
    }) => ({
      operation: attempt.requestId === source.id
        ? 'recategorize'
        : 'restore',
      qboType: transaction.qboType,
      qboId: transaction.qboId,
      requestId: attempt.requestId,
      requestHash: attempt.requestHash,
      expectedSyncToken: attempt.expectedSyncToken,
      preparedBindingHash: attempt.requestId === source.id
        ? 'a'.repeat(64)
        : 'c'.repeat(64),
      beforeSnapshotHash: attempt.requestId === source.id
        ? 'source-before'
        : 'b'.repeat(64),
    });

    try {
      const [first, second] = await Promise.all([
        retryMcpOperation(principal, { operationId: root.id }, {
          store: firstClient as unknown as McpOperationExecutionStore,
          now: () => NOW,
          undo: undoWithoutQbo(firstClient),
          validateAttempt: validateRestoreAttempt,
        }),
        retryMcpOperation(principal, { operationId: root.id }, {
          store: secondClient as unknown as McpOperationExecutionStore,
          now: () => NOW,
          undo: undoWithoutQbo(secondClient),
          validateAttempt: validateRestoreAttempt,
        }),
      ]);

      expect(first.operationId).toBe(second.operationId);
      expect(first).toMatchObject({
        kind: 'undo',
        state: 'prepared',
        phase: 'write_prepared',
      });
      await expect(firstClient.mcpOperation.count({
        where: { retryOfId: root.id },
      })).resolves.toBe(1);
      await expect(firstClient.qboMutationAttempt.count({
        where: { requestId: first.operationId, operation: 'restore' },
      })).resolves.toBe(1);
    } finally {
      await firstClient.company.deleteMany({ where: { id: company.id } });
      await firstClient.user.deleteMany({ where: { id: user.id } });
    }
  }, 30_000);
});
