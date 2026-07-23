import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNextJob } from './jobs.js';

const testDatabaseUrl = process.env.AGENT_TEST_DATABASE_URL;
const dbA = testDatabaseUrl ? new PrismaClient({ datasourceUrl: testDatabaseUrl }) : null;
const dbB = testDatabaseUrl ? new PrismaClient({ datasourceUrl: testDatabaseUrl }) : null;
const companyId = randomUUID();
const transactionId = randomUUID();

describe.skipIf(!testDatabaseUrl)('agent PostgreSQL claim integration', () => {
  beforeAll(async () => {
    await dbA!.company.create({
      data: {
        id: companyId,
        realmId: `agent-test-${companyId}`,
        legalName: 'Agent claim test',
        nickname: 'Agent claim test',
        autopilotMode: 'shadow',
        taxSupportStatus: 'ready',
      },
    });
    await dbA!.transaction.create({
      data: {
        id: transactionId,
        companyId,
        qboId: `purchase-${transactionId}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-23'),
        payee: 'Integration fixture',
        amount: -1,
        bankAccount: 'Test',
      },
    });
    await dbA!.agentJob.create({
      data: { transactionId, companyId, inputHash: 'integration-hash' },
    });
  });

  afterAll(async () => {
    await dbA!.company.delete({ where: { id: companyId } }).catch(() => undefined);
    await Promise.all([dbA!.disconnect(), dbB!.disconnect()]);
  });

  it('claims one queued job exactly once across independent Prisma clients', async () => {
    const now = new Date();
    const [first, second] = await Promise.all([
      claimNextJob('integration-worker-a', now, dbA!),
      claimNextJob('integration-worker-b', now, dbB!),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});
