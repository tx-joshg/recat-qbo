import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('legacy durable restore migration on PostgreSQL', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('requeues only REVERTED rows and clears their terminal metadata', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `restore-migration-${suffix}`,
        legalName: 'Restore migration fixture',
        nickname: `restore-${suffix.slice(0, 8)}`,
      },
    });
    const postedAt = new Date('2026-09-01T12:00:00.000Z');
    try {
      const [reverted, pending] = await Promise.all([
        db.transaction.create({
          data: {
            companyId: company.id,
            qboId: `reverted-${suffix}`,
            qboType: 'Purchase',
            qboSyncToken: '9',
            date: new Date('2026-09-01T00:00:00.000Z'),
            payee: 'Reverted migration fixture',
            amount: '-10.00',
            bankAccount: 'Migration bank',
            status: 'REVERTED',
            errorCode: 'OLD_ERROR',
            errorMessage: 'old error',
            postedAt,
            postedByUserId: randomUUID(),
          },
        }),
        db.transaction.create({
          data: {
            companyId: company.id,
            qboId: `pending-${suffix}`,
            qboType: 'Purchase',
            qboSyncToken: '1',
            date: new Date('2026-09-01T00:00:00.000Z'),
            payee: 'Pending migration fixture',
            amount: '-20.00',
            bankAccount: 'Migration bank',
            status: 'PENDING',
            errorCode: 'KEEP_ERROR',
            errorMessage: 'keep error',
          },
        }),
      ]);
      const migration = readFileSync(
        new URL(
          '../../../prisma/migrations/20260902130000_requeue_legacy_reverted_transactions/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );

      await db.$executeRawUnsafe(migration);

      await expect(db.transaction.findUniqueOrThrow({ where: { id: reverted.id } }))
        .resolves.toMatchObject({
          status: 'PENDING',
          postedAt: null,
          postedByUserId: null,
          errorCode: null,
          errorMessage: null,
        });
      await expect(db.transaction.findUniqueOrThrow({ where: { id: pending.id } }))
        .resolves.toMatchObject({
          status: 'PENDING',
          errorCode: 'KEEP_ERROR',
          errorMessage: 'keep error',
        });
    } finally {
      await db.company.delete({ where: { id: company.id } });
    }
  });
});
