import type { Prisma } from '../../lib/db.js';

export interface LiveWritePermitUsage {
  readonly utcDay: string;
  readonly used: number;
  readonly limit: number;
}

interface StoredPermit {
  readonly companyId: string;
  readonly utcDay: Date;
  readonly limitAtIssue: number;
}

export interface LiveWriteLimitDeps {
  loadUtcDay(db: object): Promise<Date>;
  loadLimit(db: object, companyId: string): Promise<number | null>;
  findPermit(db: object, requestId: string): Promise<StoredPermit | null>;
  countPermits(db: object, companyId: string, utcDay: Date): Promise<number>;
  createPermit(db: object, permit: {
    requestId: string;
    companyId: string;
    utcDay: Date;
    limitAtIssue: number;
  }): Promise<void>;
}

export class LiveWriteLimitError extends Error {
  readonly code: 'LIVE_DAILY_LIMIT_REACHED' | 'LIVE_WRITE_LIMIT_UNAVAILABLE';

  constructor(code: LiveWriteLimitError['code']) {
    super(code === 'LIVE_DAILY_LIMIT_REACHED'
      ? 'Daily live-write limit reached.'
      : 'Daily live-write authority is unavailable.');
    this.name = 'LiveWriteLimitError';
    this.code = code;
  }
}

const defaultDeps: LiveWriteLimitDeps = {
  loadUtcDay: async (db) => {
    const rows = await (db as Prisma.TransactionClient).$queryRawUnsafe<{ utcDay: Date }[]>(
      `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS "utcDay"`,
    );
    const utcDay = rows[0]?.utcDay;
    if (!(utcDay instanceof Date) || Number.isNaN(utcDay.getTime())) {
      throw new LiveWriteLimitError('LIVE_WRITE_LIMIT_UNAVAILABLE');
    }
    return utcDay;
  },
  loadLimit: async (db, companyId) => {
    const rows = await (db as Prisma.TransactionClient).$queryRawUnsafe<{
      dailyLiveWriteLimit: number;
    }[]>(
      `SELECT "dailyLiveWriteLimit"
         FROM "AgentCompanyConfig"
        WHERE "companyId" = $1
        FOR SHARE`,
      companyId,
    );
    return rows[0]?.dailyLiveWriteLimit ?? null;
  },
  findPermit: async (db, requestId) => {
    const rows = await (db as Prisma.TransactionClient).$queryRawUnsafe<StoredPermit[]>(
      `SELECT "companyId", "utcDay", "limitAtIssue"
         FROM "LiveWritePermit"
        WHERE "requestId" = $1`,
      requestId,
    );
    return rows[0] ?? null;
  },
  countPermits: async (db, companyId, utcDay) => {
    const rows = await (db as Prisma.TransactionClient).$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count"
         FROM "LiveWritePermit"
        WHERE "companyId" = $1
          AND "utcDay" = $2::date`,
      companyId,
      utcDay,
    );
    return Number(rows[0]?.count ?? 0n);
  },
  createPermit: async (db, permit) => {
    await (db as Prisma.TransactionClient).$executeRawUnsafe(
      `INSERT INTO "LiveWritePermit"
        ("requestId", "companyId", "utcDay", "limitAtIssue", "createdAt")
       VALUES ($1, $2, $3::date, $4, clock_timestamp())`,
      permit.requestId,
      permit.companyId,
      permit.utcDay,
      permit.limitAtIssue,
    );
  },
};

export async function issueLiveWritePermit(
  db: object,
  input: { readonly companyId: string; readonly requestId: string },
  deps: LiveWriteLimitDeps = defaultDeps,
): Promise<LiveWritePermitUsage> {
  const existing = await deps.findPermit(db, input.requestId);
  if (existing !== null) {
    if (existing.companyId !== input.companyId) {
      throw new LiveWriteLimitError('LIVE_WRITE_LIMIT_UNAVAILABLE');
    }
    return {
      utcDay: dateOnly(existing.utcDay),
      used: await deps.countPermits(db, input.companyId, existing.utcDay),
      limit: existing.limitAtIssue,
    };
  }

  const limit = await deps.loadLimit(db, input.companyId);
  if (!Number.isInteger(limit) || limit === null || limit < 1 || limit > 10_000) {
    throw new LiveWriteLimitError('LIVE_WRITE_LIMIT_UNAVAILABLE');
  }
  const utcDay = await deps.loadUtcDay(db);
  const used = await deps.countPermits(db, input.companyId, utcDay);
  if (used >= limit) throw new LiveWriteLimitError('LIVE_DAILY_LIMIT_REACHED');

  await deps.createPermit(db, {
    requestId: input.requestId,
    companyId: input.companyId,
    utcDay,
    limitAtIssue: limit,
  });
  return { utcDay: dateOnly(utcDay), used: used + 1, limit };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
