import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { McpPrincipal } from '../../mcp/auth.js';
import { createPreparedOperation } from './operations.js';
import {
  prepareMcpUndo,
  type McpUndoStore,
} from './undo.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-29T12:00:00.000Z');

describePostgres('MCP undo PostgreSQL durability', () => {
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

  it('converges concurrent preparations on one redacted undo envelope and creates no restore attempt', async () => {
    const suffix = randomUUID();
    const user = await firstClient.user.create({
      data: {
        email: `mcp-undo-${suffix}@example.invalid`,
        name: 'MCP Undo PostgreSQL Fixture',
      },
    });
    const company = await firstClient.company.create({
      data: {
        realmId: `mcp-undo-${suffix}`,
        legalName: 'MCP Undo PostgreSQL Fixture',
        nickname: `undo-${suffix.slice(0, 8)}`,
      },
    });
    await firstClient.membership.create({
      data: { userId: user.id, companyId: company.id, role: 'categorizer' },
    });
    const token = await firstClient.mcpToken.create({
      data: {
        userId: user.id,
        digest: createHash('sha256').update(suffix).digest('hex'),
        prefix: 'rct_pgundo01',
        label: 'MCP Undo PostgreSQL Fixture',
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '8',
        date: NOW,
        payee: 'MCP Undo PostgreSQL Fixture',
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
            categoryQboId: 'expense-private',
            taxCodeQboId: null,
            memo: 'private memo',
            tagIds: [],
          }],
          tagIds: [],
        },
        warnings: [],
      },
      sourceRevision: 1,
      preparedRevision: 2,
      qboType: 'Purchase',
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
        requestHash: 'source-request-hash',
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

    const prepareUndo = vi.fn(async (input: {
      sourceRequestId: string;
      transactionId: string;
      companyId: string;
    }) => {
      const attempt = await firstClient.qboMutationAttempt.findUnique({
        where: { requestId: input.sourceRequestId },
      });
      expect(attempt).toMatchObject({
        transactionId: input.transactionId,
        operation: 'recategorize',
        status: 'VERIFIED',
      });
      return {
        transactionId: input.transactionId,
        companyId: input.companyId,
        revision: 2,
        qboType: 'Purchase' as const,
        qboId: transaction.qboId,
        qboSyncToken: '8',
        sourcePreparedHash: 'a'.repeat(64),
        currentPostHash: 'b'.repeat(64),
        restoreHash: 'c'.repeat(64),
        preview: {
          action: 'restore_purchase_categorization' as const,
          resultingStatus: 'PENDING' as const,
          direction: 'purchase' as const,
          totalCents: -1000,
          totalTaxCents: null,
          lineCount: 1,
          restorationDigest: 'c'.repeat(64),
        },
      };
    });
    const input = {
      operationId: source.id,
      idempotencyKey: `undo-${suffix}`,
    };

    try {
      const [first, second] = await Promise.all([
        prepareMcpUndo(principal, input, {
          store: firstClient as unknown as McpUndoStore,
          now: () => NOW,
          prepareUndo,
        }),
        prepareMcpUndo(principal, input, {
          store: secondClient as unknown as McpUndoStore,
          now: () => NOW,
          prepareUndo,
        }),
      ]);

      expect(second).toEqual(first);
      await expect(firstClient.mcpOperation.count({
        where: {
          tokenId: token.id,
          transactionId: transaction.id,
          toolName: 'prepare_undo',
          idempotencyKey: input.idempotencyKey,
        },
      })).resolves.toBe(1);
      await expect(firstClient.qboMutationAttempt.count({
        where: { transactionId: transaction.id },
      })).resolves.toBe(1);
      const stored = await firstClient.mcpOperation.findUniqueOrThrow({
        where: { id: first.operationId },
        select: { payload: true },
      });
      expect(JSON.stringify(stored.payload)).not.toMatch(
        /expense-private|private memo|SyncToken|requestPayload|beforeSnapshot|body/i,
      );
    } finally {
      await firstClient.company.deleteMany({ where: { id: company.id } });
      await firstClient.user.deleteMany({ where: { id: user.id } });
    }
  }, 30_000);
});
