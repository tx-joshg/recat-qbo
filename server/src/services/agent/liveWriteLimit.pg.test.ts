import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../lib/db.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import { issueLiveWritePermit } from './liveWriteLimit.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('daily live-write permit PostgreSQL invariant', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('issues exactly 25 default permits under 26 concurrent requests', async () => {
    const suffix = randomUUID();
    const company = await prisma.company.create({
      data: {
        realmId: `live-write-limit-${suffix}`,
        legalName: 'Live write limit PostgreSQL fixture',
        nickname: `limit-${suffix.slice(0, 8)}`,
        dryRun: false,
        accessToken: 'encrypted-access-placeholder',
        refreshToken: 'encrypted-refresh-placeholder',
      },
    });
    await prisma.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'custom',
        decisionModel: 'decision-model',
        verifierModel: 'verifier-model',
        scheduleMinutes: 10,
        companyConcurrency: 1,
        evidenceThreshold: 25,
        limits: {},
        configVersion: `config-${suffix}`,
      },
    });

    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 26 }, (_, index) =>
          prisma.$transaction(async (transaction) => {
            await lockCompanyMutationScope(transaction, company.id);
            return issueLiveWritePermit(transaction, {
              companyId: company.id,
              requestId: `permit-${suffix}-${index}`,
            });
          }, { maxWait: 30_000, timeout: 30_000 }),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(25);
      expect(outcomes.filter((outcome) =>
        outcome.status === 'rejected'
          && typeof outcome.reason === 'object'
          && outcome.reason !== null
          && 'code' in outcome.reason
          && outcome.reason.code === 'LIVE_DAILY_LIMIT_REACHED',
      )).toHaveLength(1);
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count"
           FROM "LiveWritePermit"
          WHERE "companyId" = $1
            AND "utcDay" = (clock_timestamp() AT TIME ZONE 'UTC')::date`,
        company.id,
      );
      expect(Number(rows[0]?.count)).toBe(25);
    } finally {
      await prisma.company.delete({ where: { id: company.id } });
    }
  }, 60_000);
});
