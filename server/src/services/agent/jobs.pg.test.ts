import { PrismaClient } from '../../lib/db.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cancelQueuedAgentJobs,
  cancelSupersededAgentJob,
  claimShadowJobs,
  discoverShadowJobs,
  finishAgentJob,
  renewJobLease,
  type AgentJobDb,
  type AgentJobDeps,
} from './jobs.js';
import { acquireAgentJobSuiteLock } from '../../test/postgresSuiteLock.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BASE_TIME = new Date('2026-07-29T08:00:00.000Z');

interface Fixture {
  companyId: string;
  transactionIds: string[];
}

describePostgres('shadow agent PostgreSQL jobs', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;
  let lockClient: PrismaClient;
  let releaseSuiteLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    firstClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    secondClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    lockClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      releaseSuiteLock = await acquireAgentJobSuiteLock(lockClient);
    } catch (error) {
      await Promise.all([firstClient.$disconnect(), secondClient.$disconnect(), lockClient.$disconnect()]);
      throw error;
    }
  });

  afterAll(async () => {
    await releaseSuiteLock?.();
    await Promise.all([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
      lockClient?.$disconnect(),
    ]);
  });

  function deps(client: PrismaClient, now = BASE_TIME): AgentJobDeps {
    return {
      db: client as unknown as AgentJobDb,
      now: async () => now,
    };
  }

  async function seed(transactionCount = 1, companyConcurrency = 1): Promise<Fixture> {
    const suffix = randomUUID();
    const company = await firstClient.company.create({
      data: {
        realmId: `agent-jobs-${suffix}`,
        legalName: 'Agent jobs PostgreSQL fixture',
        nickname: `jobs-${suffix.slice(0, 8)}`,
        dryRun: true,
      },
    });
    await firstClient.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'openrouter',
        decisionModel: 'decision-model',
        verifierModel: 'verifier-model',
        scheduleMinutes: 10,
        companyConcurrency,
        evidenceThreshold: 50,
        limits: {},
        configVersion: 'config-v1',
      },
    });
    const transactionIds = await Promise.all([...Array(transactionCount)].map(async (_, index) => {
      const transaction = await firstClient.transaction.create({
        data: {
          companyId: company.id,
          qboId: `agent-job-${suffix}-${index}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: BASE_TIME,
          payee: 'PostgreSQL fixture',
          amount: '-1.00',
          bankAccount: 'Fixture bank',
        },
      });
      return transaction.id;
    }));
    return { companyId: company.id, transactionIds };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await firstClient.company.deleteMany({ where: { id: fixture.companyId } });
  }

  async function discover(fixture: Fixture, at = BASE_TIME): Promise<void> {
    await discoverShadowJobs(fixture.companyId, deps(firstClient, at));
  }

  async function waitForCapacityLockWait(): Promise<void> {
    await vi.waitFor(async () => {
      const rows = await lockClient.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::integer AS "count"
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND "wait_event_type" = 'Lock'
           AND query LIKE '%pg_advisory_xact_lock(728202604)%'`,
      );
      expect(rows[0]?.count ?? 0).toBeGreaterThan(0);
    }, { timeout: 2_000, interval: 10 });
  }

  it('discovers one job per transaction revision and config version under concurrent schedulers', async () => {
    const fixture = await seed();
    try {
      await Promise.all([
        discoverShadowJobs(fixture.companyId, deps(firstClient)),
        discoverShadowJobs(fixture.companyId, deps(secondClient)),
      ]);
      await discover(fixture);
      await expect(firstClient.agentJob.count({ where: { companyId: fixture.companyId } })).resolves.toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it('does not discover jobs while the company is not in shadow mode', async () => {
    const fixture = await seed();
    try {
      await firstClient.agentCompanyConfig.update({
        where: { companyId: fixture.companyId },
        data: { mode: 'off' },
      });
      await discover(fixture);
      await expect(firstClient.agentJob.count({ where: { companyId: fixture.companyId } })).resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('does not discover jobs for a disconnected company', async () => {
    const fixture = await seed();
    try {
      await firstClient.company.update({
        where: { id: fixture.companyId },
        data: { disconnectedAt: BASE_TIME },
      });
      await discover(fixture);
      await expect(firstClient.agentJob.count({ where: { companyId: fixture.companyId } }))
        .resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('enforces company capacity across simultaneous independent clients', async () => {
    const fixture = await seed(5);
    try {
      await discover(fixture);
      const [first, second] = await Promise.all([
        claimShadowJobs('worker-a', 10, deps(firstClient)),
        claimShadowJobs('worker-b', 10, deps(secondClient)),
      ]);
      const claimedIds = [...first, ...second].map((job) => job.id);
      expect(claimedIds).toHaveLength(1);
      expect(new Set(claimedIds).size).toBe(1);
      await expect(firstClient.agentJob.count({
        where: { companyId: fixture.companyId, status: 'running' },
      })).resolves.toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it('enforces four global leases while different companies fill available slots', async () => {
    const fixtures = await Promise.all([
      seed(3, 2),
      seed(),
      seed(),
      seed(),
      seed(),
    ]);
    try {
      await Promise.all(fixtures.map((fixture) => discover(fixture)));
      const [first, second] = await Promise.all([
        claimShadowJobs('process-worker-a', 4, deps(firstClient)),
        claimShadowJobs('process-worker-b', 4, deps(secondClient)),
      ]);
      const claimed = [...first, ...second];
      const companyCounts = new Map<string, number>();
      for (const claimedJob of claimed) {
        companyCounts.set(
          claimedJob.companyId,
          (companyCounts.get(claimedJob.companyId) ?? 0) + 1,
        );
      }

      expect(claimed).toHaveLength(4);
      expect(new Set(claimed.map((claimedJob) => claimedJob.id)).size).toBe(4);
      expect(companyCounts.size).toBeGreaterThan(1);
      expect(companyCounts.get(fixtures[0]!.companyId) ?? 0).toBeLessThanOrEqual(2);
      for (const fixture of fixtures.slice(1)) {
        expect(companyCounts.get(fixture.companyId) ?? 0).toBeLessThanOrEqual(1);
      }
      await expect(firstClient.agentJob.count({
        where: { status: 'running', leaseExpiresAt: { gt: BASE_TIME } },
      })).resolves.toBe(4);
    } finally {
      await Promise.all(fixtures.map((fixture) => cleanup(fixture)));
    }
  });

  it('expired leases release global and company capacity', async () => {
    const fixtures = await Promise.all([seed(), seed(), seed(), seed(), seed()]);
    try {
      await Promise.all(fixtures.map((fixture) => discover(fixture)));
      const initial = await claimShadowJobs('worker-a', 4, deps(firstClient));
      expect(initial).toHaveLength(4);
      await firstClient.agentJob.update({
        where: { id: initial[0]!.id },
        data: { leaseExpiresAt: new Date(BASE_TIME.getTime() - 1) },
      });

      const replacement = await claimShadowJobs('worker-b', 4, deps(secondClient));
      expect(replacement).toHaveLength(1);
      await expect(firstClient.agentJob.count({
        where: { status: 'running', leaseExpiresAt: { gt: BASE_TIME } },
      })).resolves.toBe(4);
    } finally {
      await Promise.all(fixtures.map((fixture) => cleanup(fixture)));
    }
  });

  it('recovers an expired lease but not an active lease', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const first = await claimShadowJobs('worker-a', 1, deps(firstClient));
      expect(first).toHaveLength(1);
      await expect(claimShadowJobs('worker-b', 1, deps(secondClient))).resolves.toEqual([]);
      const afterLease = new Date(BASE_TIME.getTime() + 60_001);
      const recovered = await claimShadowJobs('worker-b', 1, deps(secondClient, afterLease));
      expect(recovered.map((job) => job.id)).toEqual(first.map((job) => job.id));
      expect(recovered[0]?.attemptCount).toBe(2);
    } finally {
      await cleanup(fixture);
    }
  });

  it('touches at most the requested number of expired jobs in a recovery backlog', async () => {
    const fixture = await seed(3, 3);
    try {
      await discover(fixture);
      const initial = await claimShadowJobs('worker-a', 3, deps(firstClient));
      expect(initial).toHaveLength(3);
      await firstClient.agentRun.createMany({
        data: initial.map((job) => ({
          jobId: job.id,
          companyId: job.companyId,
          transactionId: job.transactionId,
          revision: job.revision,
          configVersion: job.configVersion,
          attemptCount: job.attemptCount,
          status: 'running',
          snapshot: {},
          decisionModel: 'decision-model',
          verifierModel: 'verifier-model',
          verifierKind: 'distinct_model',
          promptVersion: 'test',
          schemaVersion: '1',
        })),
      });
      const afterLease = new Date(BASE_TIME.getTime() + 60_001);
      const recovered = await claimShadowJobs('worker-b', 1, deps(secondClient, afterLease));

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ lockOwner: 'worker-b', attemptCount: 2 });
      const jobs = await firstClient.agentJob.findMany({
        where: { companyId: fixture.companyId },
        orderBy: { id: 'asc' },
      });
      expect(jobs.filter((job) => job.lockOwner === 'worker-b')).toHaveLength(1);
      expect(jobs.filter((job) => job.lockOwner === 'worker-a' && job.attemptCount === 1))
        .toHaveLength(2);
      await expect(firstClient.agentRun.count({
        where: { companyId: fixture.companyId, status: 'failed', errorCode: 'AGENT_RUN_ABANDONED' },
      })).resolves.toBe(1);
      await expect(firstClient.agentRun.count({
        where: { companyId: fixture.companyId, status: 'running' },
      })).resolves.toBe(2);
    } finally {
      await cleanup(fixture);
    }
  });

  it('concurrent recovery claimers select distinct bounded expired jobs', async () => {
    const fixture = await seed(4, 4);
    try {
      await discover(fixture);
      await expect(claimShadowJobs('worker-a', 4, deps(firstClient))).resolves.toHaveLength(4);
      const afterLease = new Date(BASE_TIME.getTime() + 60_001);
      const [first, second] = await Promise.all([
        claimShadowJobs('worker-b', 1, deps(firstClient, afterLease)),
        claimShadowJobs('worker-c', 1, deps(secondClient, afterLease)),
      ]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]?.id).not.toBe(second[0]?.id);
      const jobs = await firstClient.agentJob.findMany({ where: { companyId: fixture.companyId } });
      expect(jobs.filter((job) => job.attemptCount === 2)).toHaveLength(2);
      expect(jobs.filter((job) => job.lockOwner === 'worker-a' && job.attemptCount === 1))
        .toHaveLength(2);
    } finally {
      await cleanup(fixture);
    }
  });

  it('fences renewal and completion to the active owner', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const [job] = await claimShadowJobs('worker-a', 1, deps(firstClient));
      const renewedAt = new Date(BASE_TIME.getTime() + 1_000);
      await expect(renewJobLease(job!.id, 'worker-a', job!.attemptCount, deps(firstClient, renewedAt))).resolves.toBe(true);
      await expect(renewJobLease(job!.id, 'worker-b', job!.attemptCount, deps(secondClient, renewedAt))).resolves.toBe(false);
      const reclaimed = await claimShadowJobs('worker-b', 1, deps(secondClient, new Date(BASE_TIME.getTime() + 60_000)));
      expect(reclaimed).toHaveLength(0);
      const afterRenewal = new Date(BASE_TIME.getTime() + 61_002);
      const nextOwner = await claimShadowJobs('worker-b', 1, deps(secondClient, afterRenewal));
      expect(nextOwner).toHaveLength(1);
      await expect(finishAgentJob(job!.id, 'worker-a', job!.attemptCount, { kind: 'completed' }, deps(firstClient, afterRenewal))).resolves.toBeNull();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fences an old claim when the same owner reclaims an expired lease', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const [first] = await claimShadowJobs('stable-worker', 1, deps(firstClient));
      const reclaimedAt = new Date(BASE_TIME.getTime() + 60_001);
      const [second] = await claimShadowJobs('stable-worker', 1, deps(secondClient, reclaimedAt));
      expect(second?.attemptCount).toBe(first!.attemptCount + 1);

      await expect(renewJobLease(first!.id, 'stable-worker', first!.attemptCount, deps(firstClient, reclaimedAt))).resolves.toBe(false);
      await expect(finishAgentJob(first!.id, 'stable-worker', first!.attemptCount, { kind: 'completed' }, deps(firstClient, reclaimedAt))).resolves.toBeNull();
    } finally {
      await cleanup(fixture);
    }
  });

  it('uses exact retry delays and makes attempt three terminal', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const [first] = await claimShadowJobs('worker-a', 1, deps(firstClient));
      const firstFinished = await finishAgentJob(first!.id, 'worker-a', first!.attemptCount, {
        kind: 'failed', transient: true, errorCode: 'AGENT_MODEL_NETWORK_ERROR',
      }, deps(firstClient));
      expect(firstFinished).toMatchObject({ status: 'retry', attemptCount: 1 });
      expect(firstFinished?.dueAt).toEqual(new Date(BASE_TIME.getTime() + 30_000));
      await expect(claimShadowJobs('worker-b', 1, deps(secondClient, new Date(BASE_TIME.getTime() + 29_999)))).resolves.toEqual([]);

      const retryOneAt = new Date(BASE_TIME.getTime() + 30_000);
      const [second] = await claimShadowJobs('worker-b', 1, deps(secondClient, retryOneAt));
      const secondFinished = await finishAgentJob(second!.id, 'worker-b', second!.attemptCount, {
        kind: 'failed', transient: true, errorCode: 'AGENT_MODEL_HTTP_ERROR',
      }, deps(secondClient, retryOneAt));
      expect(secondFinished?.dueAt).toEqual(new Date(retryOneAt.getTime() + 120_000));

      const retryTwoAt = new Date(retryOneAt.getTime() + 120_000);
      const [third] = await claimShadowJobs('worker-c', 1, deps(firstClient, retryTwoAt));
      const thirdFinished = await finishAgentJob(third!.id, 'worker-c', third!.attemptCount, {
        kind: 'failed', transient: true, errorCode: 'AGENT_MODEL_NETWORK_ERROR',
      }, deps(firstClient, retryTwoAt));
      expect(thirdFinished).toMatchObject({ status: 'terminal', attemptCount: 3 });
      await expect(claimShadowJobs('worker-d', 1, deps(secondClient, new Date(retryTwoAt.getTime() + 600_000)))).resolves.toEqual([]);
    } finally {
      await cleanup(fixture);
    }
  });

  it('terminalizes an expired crashed third attempt without a fourth claim', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const [claimed] = await claimShadowJobs('worker-a', 1, deps(firstClient));
      await firstClient.agentJob.update({
        where: { id: claimed!.id },
        data: { attemptCount: 3 },
      });
      const afterExpiry = new Date(BASE_TIME.getTime() + 60_001);
      await expect(claimShadowJobs('worker-b', 1, deps(secondClient, afterExpiry))).resolves.toEqual([]);
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: claimed!.id } })).resolves.toMatchObject({
        status: 'terminal',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_JOB_EXHAUSTED',
        attemptCount: 3,
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('terminalizes only the selected exhausted job when recovery is bounded', async () => {
    const fixture = await seed(2, 2);
    try {
      await discover(fixture);
      const initial = await claimShadowJobs('worker-a', 2, deps(firstClient));
      const [selected, untouched] = [...initial].sort((left, right) => left.id.localeCompare(right.id));
      await firstClient.agentJob.update({
        where: { id: selected!.id },
        data: {
          attemptCount: 3,
          dueAt: new Date(BASE_TIME.getTime() - 2),
          leaseExpiresAt: new Date(BASE_TIME.getTime() - 1),
        },
      });
      await firstClient.agentJob.update({
        where: { id: untouched!.id },
        data: {
          attemptCount: 3,
          dueAt: new Date(BASE_TIME.getTime() - 1),
          leaseExpiresAt: new Date(BASE_TIME.getTime() - 1),
        },
      });

      await expect(claimShadowJobs('worker-b', 1, deps(secondClient))).resolves.toEqual([]);
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: selected!.id } }))
        .resolves.toMatchObject({
          status: 'terminal',
          lockOwner: null,
          attemptCount: 3,
          lastErrorCode: 'AGENT_JOB_EXHAUSTED',
        });
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: untouched!.id } }))
        .resolves.toMatchObject({
          status: 'running',
          lockOwner: 'worker-a',
          attemptCount: 3,
        });
    } finally {
      await cleanup(fixture);
    }
  });

  it('uses database time for active, expired, and non-shortening lease decisions', async () => {
    const fixture = await seed();
    const databaseClockDeps = { db: firstClient as unknown as AgentJobDb } as AgentJobDeps;
    const secondDatabaseClockDeps = { db: secondClient as unknown as AgentJobDb } as AgentJobDeps;
    try {
      await discoverShadowJobs(fixture.companyId, databaseClockDeps);
      const [claimed] = await claimShadowJobs('worker-a', 1, databaseClockDeps);
      await firstClient.$executeRawUnsafe(
        'UPDATE "AgentJob" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL \'2 minutes\' WHERE "id" = $1',
        claimed!.id,
      );
      await expect(claimShadowJobs('worker-b', 1, secondDatabaseClockDeps)).resolves.toEqual([]);
      const beforeRenewal = await firstClient.agentJob.findUniqueOrThrow({ where: { id: claimed!.id } });
      await expect(renewJobLease(claimed!.id, 'worker-a', claimed!.attemptCount, databaseClockDeps)).resolves.toBe(true);
      const afterRenewal = await firstClient.agentJob.findUniqueOrThrow({ where: { id: claimed!.id } });
      expect(afterRenewal.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(beforeRenewal.leaseExpiresAt!.getTime());

      await firstClient.$executeRawUnsafe(
        'UPDATE "AgentJob" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "id" = $1',
        claimed!.id,
      );
      await expect(renewJobLease(claimed!.id, 'worker-a', claimed!.attemptCount, databaseClockDeps)).resolves.toBe(false);
      const reclaimed = await claimShadowJobs('worker-b', 1, secondDatabaseClockDeps);
      expect(reclaimed).toMatchObject([{ id: claimed!.id, attemptCount: 2 }]);
    } finally {
      await cleanup(fixture);
    }
  });

  it('serializes lease renewal with database-global claim capacity accounting', async () => {
    const fixture = await seed();
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      const databaseDeps = { db: firstClient as unknown as AgentJobDb } as AgentJobDeps;
      const secondDatabaseDeps = { db: secondClient as unknown as AgentJobDb } as AgentJobDeps;
      await discoverShadowJobs(fixture.companyId, databaseDeps);
      const [claimed] = await claimShadowJobs('worker-a', 1, databaseDeps);
      const holder = firstClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT 1 AS "locked" FROM pg_advisory_xact_lock(728202604)',
        );
        lockAcquired();
        await release;
      });
      await acquired;

      let renewalSettled = false;
      const renewal = renewJobLease(
        claimed!.id,
        'worker-a',
        claimed!.attemptCount,
        secondDatabaseDeps,
      ).finally(() => {
        renewalSettled = true;
      });
      await waitForCapacityLockWait();
      expect(renewalSettled).toBe(false);

      releaseLock();
      await holder;
      await expect(renewal).resolves.toBe(true);
    } finally {
      releaseLock?.();
      await cleanup(fixture);
    }
  });

  it('starts a full lease after waiting for the database-global capacity lock', async () => {
    const fixture = await seed();
    const claimNow = vi.fn(async () => BASE_TIME);
    const deterministicDeps = {
      db: secondClient as unknown as AgentJobDb,
      now: claimNow,
    } as AgentJobDeps;
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      await discover(fixture);
      const holder = firstClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT 1 AS "locked" FROM pg_advisory_xact_lock(728202604)',
        );
        lockAcquired();
        await release;
      });
      await acquired;

      const claim = claimShadowJobs('waiting-worker', 1, deterministicDeps);
      await waitForCapacityLockWait();
      expect(claimNow).not.toHaveBeenCalled();
      releaseLock();
      await holder;
      const [claimed] = await claim;

      expect(claimed).toBeDefined();
      expect(claimNow).toHaveBeenCalledOnce();
      expect(claimed!.leaseExpiresAt).toEqual(new Date(BASE_TIME.getTime() + 60_000));
    } finally {
      releaseLock?.();
      await cleanup(fixture);
    }
  });

  it('cancels stale transaction revisions before inference', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      await firstClient.transaction.update({
        where: { id: fixture.transactionIds[0]! },
        data: { revision: { increment: 1 } },
      });
      await expect(claimShadowJobs('worker-a', 1, deps(firstClient))).resolves.toEqual([]);
      await expect(firstClient.agentJob.findFirstOrThrow({ where: { companyId: fixture.companyId } })).resolves.toMatchObject({
        status: 'cancelled', lastErrorCode: 'AGENT_SUPERSEDED',
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('cancels jobs with obsolete company configuration before inference', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      await firstClient.agentCompanyConfig.update({
        where: { companyId: fixture.companyId },
        data: { configVersion: 'config-v2' },
      });
      await expect(claimShadowJobs('worker-a', 1, deps(firstClient))).resolves.toEqual([]);
      await expect(firstClient.agentJob.findFirstOrThrow({ where: { companyId: fixture.companyId } })).resolves.toMatchObject({
        status: 'cancelled', lastErrorCode: 'AGENT_SUPERSEDED',
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('cancels discovered work instead of claiming it after company disconnect', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      await firstClient.company.update({
        where: { id: fixture.companyId },
        data: { disconnectedAt: BASE_TIME },
      });

      await expect(claimShadowJobs('worker-a', 1, deps(firstClient))).resolves.toEqual([]);
      await expect(firstClient.agentJob.findFirstOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        status: 'cancelled',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_SUPERSEDED',
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('fenced-cancels a claimed job disabled after claim', async () => {
    const fixture = await seed();
    try {
      await discover(fixture);
      const [claimed] = await claimShadowJobs('worker-a', 1, deps(firstClient));
      await firstClient.agentCompanyConfig.update({
        where: { companyId: fixture.companyId },
        data: { mode: 'off', configVersion: 'config-v2' },
      });

      await expect(cancelSupersededAgentJob(
        claimed!,
        'worker-b',
        deps(secondClient),
      )).resolves.toBe(false);
      await expect(cancelSupersededAgentJob(
        claimed!,
        'worker-a',
        deps(firstClient),
      )).resolves.toBe(true);
      await expect(firstClient.agentJob.findUniqueOrThrow({
        where: { id: claimed!.id },
      })).resolves.toMatchObject({
        status: 'cancelled',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_SUPERSEDED',
        attemptCount: claimed!.attemptCount,
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('admin cancel keeps a retry job that still owns an unfinished QuickBooks write', async () => {
    const fixture = await seed(3);
    try {
      await discover(fixture);
      const jobs = await firstClient.agentJob.findMany({
        where: { companyId: fixture.companyId },
        orderBy: { transactionId: 'asc' },
      });
      expect(jobs).toHaveLength(3);
      const [owning, plainRetry, queued] = jobs as [typeof jobs[number], typeof jobs[number], typeof jobs[number]];
      await firstClient.agentJob.updateMany({
        where: { id: { in: [owning.id, plainRetry.id] } },
        data: { status: 'retry', attemptCount: 1 },
      });
      await firstClient.qboMutationAttempt.create({
        data: {
          transactionId: owning.transactionId,
          requestId: owning.id,
          operation: 'recategorize',
          status: 'PREPARED',
          expectedRevision: owning.revision,
          expectedSyncToken: '0',
          requestHash: 'hash',
          requestPayload: {},
          beforeSnapshot: {},
        },
      });

      await expect(cancelQueuedAgentJobs(fixture.companyId, deps(firstClient)))
        .resolves.toEqual({ cancelled: 2, kept: 1 });

      const after = new Map((await firstClient.agentJob.findMany({
        where: { companyId: fixture.companyId },
      })).map((job) => [job.id, job]));
      expect(after.get(owning.id)).toMatchObject({ status: 'retry', lastErrorCode: null });
      expect(after.get(plainRetry.id)).toMatchObject({
        status: 'cancelled',
        lastErrorCode: 'AGENT_CANCELLED_BY_ADMIN',
      });
      expect(after.get(queued.id)).toMatchObject({
        status: 'cancelled',
        lastErrorCode: 'AGENT_CANCELLED_BY_ADMIN',
      });
    } finally {
      await cleanup(fixture);
    }
  });
});
