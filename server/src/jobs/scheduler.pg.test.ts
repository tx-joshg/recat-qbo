import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { claimDailyRun, completeDailyRun, sweepStuckPosting } from './scheduler.js';

const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('background job scheduler (PostgreSQL)', () => {
  afterAll(async () => {
    await prisma.appConfig.deleteMany({ where: { key: { startsWith: 'jobs.lastRun.' } } });
    await prisma.$disconnect();
  });

  it('lets exactly one of several concurrent instances claim a daily run', async () => {
    const day = `test-${randomUUID()}`;
    const claims = await Promise.all([...Array(6)].map(() => claimDailyRun('digest', day)));

    expect(claims.filter((claim) => claim === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim === 'busy')).toHaveLength(5);
    await completeDailyRun('digest', day);
    await expect(claimDailyRun('digest', day)).resolves.toBe('done');
    await expect(claimDailyRun('digest', `${day}-next`)).resolves.toBe('claimed');
    // Each job keeps its own claim.
    await expect(claimDailyRun('nightly', day)).resolves.toBe('claimed');
  });

  it('lets another instance take over a run whose claimant died before finishing', async () => {
    const day = `test-${randomUUID()}`;
    await expect(claimDailyRun('nightly', day)).resolves.toBe('claimed');
    await expect(claimDailyRun('nightly', day)).resolves.toBe('busy');

    await prisma.$executeRaw`
      UPDATE "AppConfig" SET "updatedAt" = now() - interval '16 minutes'
       WHERE "key" = 'jobs.lastRun.nightly'`;

    await expect(claimDailyRun('nightly', day)).resolves.toBe('claimed');
  });

  it('does not sweep a transaction whose post finished after it was read', async () => {
    const suffix = randomUUID();
    const company = await prisma.company.create({
      data: { realmId: `sweep-${suffix}`, legalName: 'Sweep fixture', nickname: `sweep-${suffix.slice(0, 8)}` },
    });
    try {
      const stale = new Date(Date.now() - 10 * 60_000);
      const make = (qboId: string) => prisma.transaction.create({
        data: {
          companyId: company.id,
          qboId,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: stale,
          payee: 'Sweep fixture',
          amount: '-1.00',
          bankAccount: 'Fixture bank',
          status: 'POSTING',
        },
      });
      const stuck = await make(`stuck-${suffix}`);
      const finished = await make(`finished-${suffix}`);
      await prisma.$executeRaw`UPDATE "Transaction" SET "updatedAt" = ${stale} WHERE "companyId" = ${company.id}`;

      // The post completes between the sweep's read and its write.
      const original = prisma.$transaction.bind(prisma);
      let raced = false;
      (prisma as { $transaction: unknown }).$transaction = async (...args: Parameters<typeof original>) => {
        if (!raced) {
          raced = true;
          await prisma.transaction.update({ where: { id: finished.id }, data: { status: 'POSTED' } });
        }
        return original(...args);
      };
      try {
        await sweepStuckPosting();
      } finally {
        (prisma as { $transaction: unknown }).$transaction = original;
      }

      const rows = new Map((await prisma.transaction.findMany({ where: { companyId: company.id } }))
        .map((row) => [row.id, row]));
      expect(rows.get(stuck.id)).toMatchObject({ status: 'ERROR', errorCode: 'STUCK_POSTING' });
      expect(rows.get(finished.id)).toMatchObject({ status: 'POSTED', errorCode: null });
      const audits = await prisma.auditEntry.findMany({ where: { companyId: company.id } });
      expect(audits.map((entry) => entry.txnId)).toEqual([stuck.id]);
    } finally {
      await prisma.company.deleteMany({ where: { id: company.id } });
    }
  });
});
