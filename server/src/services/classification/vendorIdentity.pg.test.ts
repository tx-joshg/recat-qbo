import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createVendorAlias,
  createVendorIdentity,
  ensureVendorIdentity,
  findVendorIdentityByValue,
  mergeVendorIdentities,
  type VendorIdentityDb,
} from './vendorIdentity.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

function twoPartyBarrier() {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothArrived;
  };
}

describePostgres('vendor identities on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function company() {
    const created = await db.company.create({
      data: {
        realmId: `vendor-identity-${randomUUID()}`,
        legalName: 'Synthetic Vendor Identity Company',
        nickname: 'Synthetic Vendor Identity',
      },
    });
    companyIds.add(created.id);
    return created;
  }

  it('rejects an identity whose canonical key was already claimed by an alias', async () => {
    const owner = await company();
    const identity = await createVendorIdentity({
      companyId: owner.id,
      displayName: 'Synthetic Anchor Vendor',
    }, db);
    await createVendorAlias({
      companyId: owner.id,
      vendorIdentityId: identity.id,
      value: 'Shared Exact Key',
      source: 'user',
    }, db);

    await expect(db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: '  shared   exact key  ',
        normalizedName: 'shared exact key',
      },
    })).rejects.toThrow();
    await expect(findVendorIdentityByValue(owner.id, 'shared exact key', db))
      .resolves.toMatchObject({ id: identity.id });
  });

  it('rejects an alias whose key was already claimed by another identity', async () => {
    const owner = await company();
    const canonical = await createVendorIdentity({
      companyId: owner.id,
      displayName: 'Canonical Exact Key',
    }, db);
    const other = await createVendorIdentity({
      companyId: owner.id,
      displayName: 'Synthetic Other Vendor',
    }, db);

    await expect(db.vendorAlias.create({
      data: {
        companyId: owner.id,
        vendorIdentityId: other.id,
        value: ' canonical   exact key ',
        normalizedValue: 'canonical exact key',
        source: 'user',
      },
    })).rejects.toThrow();
    await expect(findVendorIdentityByValue(owner.id, 'canonical exact key', db))
      .resolves.toMatchObject({ id: canonical.id });
  });

  it('rejects one conflicting QBO binding when exact identity creation races', async () => {
    const owner = await company();
    const waitForBoth = twoPartyBarrier();
    const racingDb = {
      vendorIdentity: new Proxy(db.vendorIdentity, {
        get(target, property, receiver) {
          if (property !== 'create') return Reflect.get(target, property, receiver);
          return async (args: Parameters<typeof db.vendorIdentity.create>[0]) => {
            await waitForBoth();
            return db.vendorIdentity.create(args);
          };
        },
      }),
      vendorAlias: db.vendorAlias,
      vendorIdentityMerge: db.vendorIdentityMerge,
    } as VendorIdentityDb;

    const results = await Promise.allSettled([
      ensureVendorIdentity({
        companyId: owner.id,
        displayName: 'Synthetic Racing Vendor',
        qboVendorId: 'qbo-race-a',
      }, racingDb),
      ensureVendorIdentity({
        companyId: owner.id,
        displayName: 'synthetic racing vendor',
        qboVendorId: 'qbo-race-b',
      }, racingDb),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'IDENTITY_CONFLICT' }) }),
    ]);
    await expect(db.vendorIdentity.count({
      where: { companyId: owner.id, normalizedName: 'synthetic racing vendor' },
    })).resolves.toBe(1);
  });

  it('serializes reciprocal merge attempts so the stored graph cannot cycle', async () => {
    const owner = await company();
    const first = await createVendorIdentity({
      companyId: owner.id,
      displayName: 'Synthetic Merge A',
    }, db);
    const second = await createVendorIdentity({
      companyId: owner.id,
      displayName: 'Synthetic Merge B',
    }, db);
    const waitForBoth = twoPartyBarrier();
    const racingDb = {
      vendorIdentity: db.vendorIdentity,
      vendorAlias: db.vendorAlias,
      vendorIdentityMerge: new Proxy(db.vendorIdentityMerge, {
        get(target, property, receiver) {
          if (property !== 'create') return Reflect.get(target, property, receiver);
          return async (args: Parameters<typeof db.vendorIdentityMerge.create>[0]) => {
            await waitForBoth();
            return db.vendorIdentityMerge.create(args);
          };
        },
      }),
      $transaction: db.$transaction.bind(db),
    } as unknown as VendorIdentityDb;

    const results = await Promise.allSettled([
      mergeVendorIdentities({
        companyId: owner.id,
        sourceVendorIdentityId: first.id,
        targetVendorIdentityId: second.id,
        mergedBy: 'reviewer-a',
        reason: 'Synthetic reviewed duplicate A to B.',
      }, racingDb),
      mergeVendorIdentities({
        companyId: owner.id,
        sourceVendorIdentityId: second.id,
        targetVendorIdentityId: first.id,
        mergedBy: 'reviewer-b',
        reason: 'Synthetic reviewed duplicate B to A.',
      }, racingDb),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(db.vendorIdentityMerge.count({ where: { companyId: owner.id } }))
      .resolves.toBe(1);
    const resolvedFirst = await findVendorIdentityByValue(owner.id, first.displayName, db);
    const resolvedSecond = await findVendorIdentityByValue(owner.id, second.displayName, db);
    expect(resolvedSecond?.id).toBe(resolvedFirst?.id);
  });
});
