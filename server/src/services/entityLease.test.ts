import { describe, expect, it, vi } from 'vitest';
import type { EntityLeaseKey } from './entityLease.js';
import {
  EntityLeaseError,
  acquireEntityLease,
  renewEntityLease,
  acquireEntityLeases,
  canonicalEntityLeaseKeys,
  fenceEntityLeaseOwnerships,
  releaseEntityLease,
  renewEntityLeases,
  withEntityLease,
  withEntityLeases,
  type EntityLeaseDb,
} from './entityLease.js';
import * as entityLeaseModule from './entityLease.js';

interface LeaseRow {
  companyId: string;
  qboType: string;
  qboId: string;
  owner: string;
  leaseExpiresAt: Date;
}

class FakeLeaseDb implements EntityLeaseDb {
  rows: LeaseRow[] = [];
  deleteOrder: string[] = [];
  failRelease = false;
  transactionCount = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  qboEntityLease: EntityLeaseDb['qboEntityLease'] = {
    updateMany: async ({ where, data }) => {
      const row = this.rows.find(
        (candidate) =>
          candidate.companyId === where.companyId &&
          candidate.qboType === where.qboType &&
          candidate.qboId === where.qboId &&
          ('OR' in where
            ? (
                candidate.owner === where.OR[1]!.owner ||
                candidate.leaseExpiresAt.getTime() <= where.OR[0]!.leaseExpiresAt.lte.getTime()
              )
            : (
                candidate.owner === where.owner
                && candidate.leaseExpiresAt.getTime() > where.leaseExpiresAt.gt.getTime()
              )),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    create: async ({ data }) => {
      if (
        this.rows.some(
          (row) =>
            row.companyId === data.companyId &&
            row.qboType === data.qboType &&
            row.qboId === data.qboId,
        )
      ) {
        const error = new Error('unique');
        Object.assign(error, { code: 'P2002' });
        throw error;
      }
      const row = { ...data };
      this.rows.push(row);
      return row;
    },
    deleteMany: async ({ where }) => {
      if (this.failRelease) throw new Error('lease cleanup storage failed');
      this.deleteOrder.push(serialized(where));
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (row) =>
          !(
            row.companyId === where.companyId &&
            row.qboType === where.qboType &&
            row.qboId === where.qboId &&
            row.owner === where.owner
          ),
      );
      return { count: before - this.rows.length };
    },
  };

  async $transaction<T>(callback: (tx: EntityLeaseDb) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const predecessor = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const before = structuredClone(this.rows);
    try {
      return await callback(this);
    } catch (error) {
      this.rows = before;
      throw error;
    } finally {
      release();
    }
  }
}

function serialized(entity: {
  companyId: string;
  qboType: string;
  qboId: string;
}): string {
  return `${entity.companyId}:${entity.qboType}:${entity.qboId}`;
}

const keyA = {
  companyId: 'company-generic',
  qboType: 'Purchase',
  qboId: 'purchase-a',
};
const keyB = {
  companyId: 'company-generic',
  qboType: 'Purchase',
  qboId: 'purchase-b',
};
const key = keyA;
const at = new Date('2026-07-28T12:00:00.000Z');

describe('entity leases', () => {
  it('sorts keys canonically and rejects duplicate entities before opening a transaction', async () => {
    expect(canonicalEntityLeaseKeys([keyB, keyA])).toEqual([keyA, keyB]);
    expect(() => canonicalEntityLeaseKeys([keyA, keyA])).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_ENTITY' }),
    );

    const db = new FakeLeaseDb();
    await expect(
      acquireEntityLeases([keyA, { ...keyA }], 'owner-a', { db }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTITY' });
    expect(db.transactionCount).toBe(0);
  });

  it('does not leave the first lease when the second entity is busy', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(keyB, 'owner-b', { db, now: async () => at });

    await expect(
      acquireEntityLeases([keyA, keyB], 'owner-a', { db, now: async () => at }),
    ).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
    expect(db.rows.some((row) => serialized(row) === serialized(keyA))).toBe(false);
    expect(db.rows).toEqual([
      expect.objectContaining({ ...keyB, owner: 'owner-b' }),
    ]);
  });

  it('rolls back every renewal when any entity is no longer owned', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLeases([keyA, keyB], 'owner-a', { db, now: async () => at });
    const previousExpiry = db.rows.find(
      (row) => serialized(row) === serialized(keyA),
    )?.leaseExpiresAt;
    const second = db.rows.find((row) => serialized(row) === serialized(keyB));
    if (second) second.owner = 'owner-b';

    await expect(
      renewEntityLeases([keyB, keyA], 'owner-a', {
        db,
        now: async () => new Date(at.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
    expect(
      db.rows.find((row) => serialized(row) === serialized(keyA))?.leaseExpiresAt,
    ).toEqual(previousExpiry);
  });

  it('cleans up reversed callback keys canonically and only for the matching owner', async () => {
    const db = new FakeLeaseDb();
    const callbackError = new Error('multi callback failed');

    await expect(
      withEntityLeases(
        [keyB, keyA],
        'owner-a',
        async () => {
          const second = db.rows.find((row) => serialized(row) === serialized(keyB));
          if (second) second.owner = 'owner-b';
          throw callbackError;
        },
        { db, now: async () => at },
      ),
    ).rejects.toBe(callbackError);

    expect(db.deleteOrder).toEqual([serialized(keyA), serialized(keyB)]);
    expect(db.rows).toEqual([
      expect.objectContaining({ ...keyB, owner: 'owner-b' }),
    ]);
  });

  it('locks and verifies the exact parameterized lease owner before fenced work', async () => {
    const query = vi.fn(async (..._args: unknown[]) => [{ owner: 'owner-a' }]);
    const fenceEntityLeaseOwnership = (
      entityLeaseModule as unknown as {
        fenceEntityLeaseOwnership(
          key: EntityLeaseKey,
          owner: string,
          deps: { db: { $queryRawUnsafe: typeof query } },
        ): Promise<void>;
      }
    ).fenceEntityLeaseOwnership;

    await fenceEntityLeaseOwnership(key, 'owner-a', {
      db: { $queryRawUnsafe: query },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/"leaseExpiresAt" > CURRENT_TIMESTAMP[\s\S]*FOR UPDATE/),
      key.companyId,
      key.qboType,
      key.qboId,
    );
  });

  it('uses PostgreSQL wall-clock time when fencing live lease expiry', async () => {
    const query = vi.fn(async (..._args: unknown[]) => [{ owner: 'owner-a' }]);

    await fenceEntityLeaseOwnerships([keyA, keyB], 'owner-a', {
      // $queryRawUnsafe is generic in T; a concrete mock cannot satisfy it.
      db: { $queryRawUnsafe: query as unknown as <T>(...args: unknown[]) => Promise<T> },
    });

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('clock_timestamp()');
      expect(sql).not.toContain('CURRENT_TIMESTAMP');
    }
  });

  it.each([
    ['missing', []],
    ['stolen', [{ owner: 'owner-b' }]],
  ] as const)('rejects a %s lease row at the ownership fence', async (_case, rows) => {
    const fenceEntityLeaseOwnership = (
      entityLeaseModule as unknown as {
        fenceEntityLeaseOwnership(
          key: EntityLeaseKey,
          owner: string,
          deps: { db: { $queryRawUnsafe: (...values: unknown[]) => Promise<unknown> } },
        ): Promise<void>;
      }
    ).fenceEntityLeaseOwnership;

    await expect(fenceEntityLeaseOwnership(key, 'owner-a', {
      db: { $queryRawUnsafe: async () => rows },
    })).rejects.toMatchObject({
      name: 'EntityLeaseError',
      code: 'ENTITY_BUSY',
    });
  });

  it('atomically allows exactly one owner when two acquisitions leave the same barrier', async () => {
    const db = new FakeLeaseDb();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const contenders = ['owner-a', 'owner-b'].map(async (owner) => {
      await barrier;
      return acquireEntityLease(key, owner, { db, now: async () => at });
    });
    releaseBarrier();
    const results = await Promise.allSettled(contenders);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'ENTITY_BUSY' });
    expect(db.rows).toHaveLength(1);
    expect(['owner-a', 'owner-b']).toContain(db.rows[0]?.owner);
  });

  it('atomically allows exactly one takeover owner for an expired lease', async () => {
    const db = new FakeLeaseDb();
    db.rows.push({
      ...key,
      owner: 'expired-owner',
      leaseExpiresAt: new Date(at.getTime() - 1),
    });

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const contenders = ['owner-a', 'owner-b'].map(async (owner) => {
      await barrier;
      return acquireEntityLease(key, owner, { db, now: async () => at });
    });
    releaseBarrier();
    const results = await Promise.allSettled(contenders);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'ENTITY_BUSY' });
    expect(['owner-a', 'owner-b']).toContain(db.rows[0]?.owner);
    expect(db.rows[0]?.leaseExpiresAt.getTime()).toBe(at.getTime() + 30_000);
  });

  it('lets the same owner renew a live lease', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-b', { db, now: async () => at });
    await acquireEntityLease(key, 'owner-b', {
      db,
      now: async () => new Date(at.getTime() + 1_000),
    });
    expect(db.rows[0]?.leaseExpiresAt.getTime()).toBe(at.getTime() + 31_000);
  });

  it('strict renewal refuses to resurrect an expired same-owner lease', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-b', { db, now: async () => at });

    await expect(renewEntityLease(key, 'owner-b', {
      db,
      now: async () => new Date(at.getTime() + 30_001),
    })).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
  });

  it('keeps an outer lease held when the same async owner reenters and releases once', async () => {
    const db = new FakeLeaseDb();
    let releases = 0;
    const originalDelete = db.qboEntityLease.deleteMany;
    db.qboEntityLease.deleteMany = async (args) => {
      releases += 1;
      return originalDelete(args);
    };

    await withEntityLease(key, 'owner-a', async () => {
      expect(db.rows).toHaveLength(1);
      await Promise.resolve();
      await withEntityLease(key, 'owner-a', async () => {
        expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
      }, { db, now: async () => at });
      expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
      expect(releases).toBe(0);
    }, { db, now: async () => at });

    expect(releases).toBe(1);
    expect(db.rows).toHaveLength(0);
  });

  it('does not let a different owner bypass a propagated reentrant context', async () => {
    const db = new FakeLeaseDb();
    await withEntityLease(key, 'owner-a', async () => {
      await Promise.resolve();
      await expect(withEntityLease(
        key,
        'owner-b',
        async () => undefined,
        { db, now: async () => at },
      )).rejects.toMatchObject({ code: 'ENTITY_BUSY' });
      expect(db.rows).toMatchObject([{ owner: 'owner-a' }]);
    }, { db, now: async () => at });
  });

  it('strictly renews and DB-fences a reentrant owner before nested mutation', async () => {
    const db = new FakeLeaseDb();
    let now = at;
    await expect(withEntityLease(key, 'owner-a', async () => {
      now = new Date(at.getTime() + 30_001);
      await withEntityLease(key, 'owner-a', async () => undefined, {
        db,
        now: async () => now,
      });
    }, { db, now: async () => now })).rejects.toMatchObject({
      code: 'ENTITY_BUSY',
    });
  });

  it('does not treat an inherited but detached async context as lease authority', async () => {
    const db = new FakeLeaseDb();
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<void>;

    await withEntityLease(key, 'owner-a', async () => {
      detached = Promise.resolve().then(async () => {
        await detachedGate;
        await withEntityLease(key, 'owner-a', async () => undefined, {
          db,
          now: async () => at,
        });
      });
    }, { db, now: async () => at });

    releaseDetached();
    await expect(detached).rejects.toMatchObject({
      code: 'ENTITY_BUSY',
    });
    expect(db.rows).toHaveLength(0);
  });

  it('releases only for the matching owner', async () => {
    const db = new FakeLeaseDb();
    await acquireEntityLease(key, 'owner-a', { db, now: async () => at });

    expect(await releaseEntityLease(key, 'owner-b', { db })).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(await releaseEntityLease(key, 'owner-a', { db })).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it('releases the owner lease when the callback throws', async () => {
    const db = new FakeLeaseDb();

    await expect(
      withEntityLease(
        key,
        'owner-a',
        async () => {
          throw new Error('callback failed');
        },
        { db, now: async () => at },
      ),
    ).rejects.toThrow('callback failed');
    expect(db.rows).toHaveLength(0);
  });

  it('preserves a callback result when release fails and reports bounded cleanup metadata', async () => {
    const db = new FakeLeaseDb();
    const reportCleanupFailure = vi.fn();
    db.failRelease = true;
    const uncertain = {
      outcome: 'UNCERTAIN',
      error: { message: 'verify in QuickBooks' },
    };

    const result = await withEntityLease(
      key,
      'owner-a',
      async () => uncertain,
      { db, now: async () => at, reportCleanupFailure },
    );

    expect(result).toBe(uncertain);
    expect(reportCleanupFailure).toHaveBeenCalledWith({
      code: 'LEASE_RELEASE_FAILED',
      message: 'Entity lease cleanup failed.',
    });
    expect(JSON.stringify(reportCleanupFailure.mock.calls)).not.toContain('storage failed');
  });

  it('preserves the primary callback error when release also fails', async () => {
    const db = new FakeLeaseDb();
    const reportCleanupFailure = vi.fn();
    const primary = new Error('primary callback failed');
    db.failRelease = true;

    await expect(
      withEntityLease(
        key,
        'owner-a',
        async () => {
          throw primary;
        },
        { db, now: async () => at, reportCleanupFailure },
      ),
    ).rejects.toBe(primary);
    expect(reportCleanupFailure).toHaveBeenCalledWith({
      code: 'LEASE_RELEASE_FAILED',
      message: 'Entity lease cleanup failed.',
    });
  });
});
