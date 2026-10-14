import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../lib/db.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  acquireEntityLeases,
  fenceEntityLeaseOwnerships,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

function leaseKeys(): [EntityLeaseKey, EntityLeaseKey] {
  const suffix = randomUUID();
  const companyId = `company-${suffix}`;
  return [
    { companyId, qboType: 'Purchase', qboId: `purchase-a-${suffix}` },
    { companyId, qboType: 'Purchase', qboId: `purchase-b-${suffix}` },
  ];
}

describePostgres('entity lease PostgreSQL concurrency', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    firstClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    secondClient = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await firstClient.qboEntityLease.deleteMany({
        where: { companyId: { in: ids } },
      });
    }
  });

  afterAll(async () => {
    await Promise.all([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
    ]);
  });

  it('allows one reverse-order contender to atomically acquire both entities', async () => {
    const [keyA, keyB] = leaseKeys();
    companyIds.add(keyA.companyId);

    const results = await Promise.allSettled([
      acquireEntityLeases([keyA, keyB], 'owner-a', {
        db: firstClient as unknown as EntityLeaseDb,
      }),
      acquireEntityLeases([keyB, keyA], 'owner-b', {
        db: secondClient as unknown as EntityLeaseDb,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(firstClient.qboEntityLease.count({
      where: { companyId: keyA.companyId },
    })).resolves.toBe(2);
  }, 30_000);

  it('allows one owner to atomically reacquire both expired entities', async () => {
    const [keyA, keyB] = leaseKeys();
    companyIds.add(keyA.companyId);
    await firstClient.qboEntityLease.createMany({
      data: [
        { ...keyA, owner: 'expired-owner', leaseExpiresAt: PAST },
        { ...keyB, owner: 'expired-owner', leaseExpiresAt: PAST },
      ],
    });

    const results = await Promise.allSettled([
      acquireEntityLeases([keyA, keyB], 'owner-a', {
        db: firstClient as unknown as EntityLeaseDb,
      }),
      acquireEntityLeases([keyB, keyA], 'owner-b', {
        db: secondClient as unknown as EntityLeaseDb,
      }),
    ]);

    const fulfilled = results
      .map((result, index) => ({ result, owner: index === 0 ? 'owner-a' : 'owner-b' }))
      .filter(({ result }) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    await expect(firstClient.qboEntityLease.findMany({
      where: { companyId: keyA.companyId },
      orderBy: { qboId: 'asc' },
      select: { owner: true },
    })).resolves.toEqual([
      { owner: fulfilled[0]!.owner },
      { owner: fulfilled[0]!.owner },
    ]);
  }, 30_000);

  it.each([
    'missing',
    'expired',
    'owned by another invocation',
  ] as const)('rejects a fence when either entity is %s', async (condition) => {
    const [keyA, keyB] = leaseKeys();
    companyIds.add(keyA.companyId);
    await firstClient.qboEntityLease.createMany({
      data: [
        { ...keyA, owner: 'owner-a', leaseExpiresAt: FUTURE },
        { ...keyB, owner: 'owner-a', leaseExpiresAt: FUTURE },
      ],
    });

    if (condition === 'missing') {
      await firstClient.qboEntityLease.delete({
        where: {
          companyId_qboType_qboId: keyB,
        },
      });
    } else {
      await firstClient.qboEntityLease.update({
        where: {
          companyId_qboType_qboId: keyB,
        },
        data: condition === 'expired'
          ? { leaseExpiresAt: PAST }
          : { owner: 'owner-b' },
      });
    }

    await expect(firstClient.$transaction(async (transaction) => {
      await fenceEntityLeaseOwnerships([keyB, keyA], 'owner-a', {
        db: transaction as unknown as EntityLeaseFenceDb,
      });
    })).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
  });

  it('rejects a fence whose row-lock wait crosses lease expiry', async () => {
    const [keyA, keyB] = leaseKeys();
    companyIds.add(keyA.companyId);
    const leaseExpiresAt = new Date(Date.now() + 300);
    await firstClient.qboEntityLease.createMany({
      data: [
        { ...keyA, owner: 'owner-a', leaseExpiresAt },
        { ...keyB, owner: 'owner-a', leaseExpiresAt },
      ],
    });
    let releaseRows!: () => void;
    let announceLocked!: () => void;
    const rowsLocked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    const rowRelease = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    const locker = secondClient.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        `SELECT "qboId"
           FROM "QboEntityLease"
          WHERE "companyId" = $1
          ORDER BY "qboType", "qboId"
          FOR UPDATE`,
        keyA.companyId,
      );
      announceLocked();
      await rowRelease;
    });
    await rowsLocked;
    const fenced = firstClient.$transaction(async (transaction) => {
      await fenceEntityLeaseOwnerships([keyA, keyB], 'owner-a', {
        db: transaction as unknown as EntityLeaseFenceDb,
      });
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, leaseExpiresAt.getTime() - Date.now() + 100),
    ));
    releaseRows();
    await locker;

    await expect(fenced).resolves.toMatchObject({
      kind: 'rejected',
      error: { code: 'ENTITY_BUSY' },
    });
  }, 30_000);
});
