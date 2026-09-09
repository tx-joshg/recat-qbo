import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertTransactionProviderActionability,
  createUnknownProviderActionabilityIfMissing,
  ensureUnknownProviderActionability,
  persistProviderActionability,
  type ProviderActionabilityDb,
} from './providerActionability.js';

const url = process.env.TEST_DATABASE_URL;
const describePostgres = url ? describe : describe.skip;

describePostgres('provider observations PostgreSQL binding', () => {
  let db: PrismaClient;
  const companies: string[] = [];
  const asStore = (client: unknown) => client as ProviderActionabilityDb;

  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: url! } } }); });
  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: companies.splice(0) } } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function seed() {
    const company = await db.company.create({ data: {
      realmId: `provider-status-pg-${randomUUID()}`,
      legalName: 'Provider Status Fixture', nickname: 'Status fixture',
    } });
    companies.push(company.id);
    return db.transaction.create({ data: {
      companyId: company.id, qboType: 'Purchase', qboId: 'purchase-fixture',
      qboSyncToken: '7', revision: 1, date: new Date('2026-08-01T00:00:00Z'),
      payee: 'Synthetic Supplier', amount: '-25.00', bankAccount: 'Synthetic Bank',
    } });
  }

  const evidence = { bookCloseDate: null, cleared: true, reconciled: true };

  it('persists current open-period evidence and rejects cross-company authority', async () => {
    const txn = await seed();
    await ensureUnknownProviderActionability(txn, asStore(db));
    expect(await persistProviderActionability({ ...txn, evidence }, asStore(db))).toBe(true);
    await expect(db.transactionActionability.findUniqueOrThrow({ where: { transactionId: txn.id } }))
      .resolves.toMatchObject({ disposition: 'WRITABLE', cleared: true, reconciled: true });
    await expect(assertTransactionProviderActionability(txn.companyId, txn.id, asStore(db))).resolves.toBeUndefined();
    const foreign = await seed();
    expect(await persistProviderActionability({ ...txn, companyId: foreign.companyId, evidence }, asStore(db))).toBe(false);
    await expect(assertTransactionProviderActionability(foreign.companyId, txn.id, asStore(db)))
      .rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
  });

  it('rejects a stale observation against the parent even before the cache is rebound', async () => {
    const txn = await seed();
    await ensureUnknownProviderActionability(txn, asStore(db));
    await persistProviderActionability({ ...txn, evidence }, asStore(db));
    const current = await db.transaction.update({ where: { id: txn.id }, data: {
      revision: 2, qboSyncToken: '8', date: new Date('2026-08-02T00:00:00Z'),
    } });
    expect(await persistProviderActionability({ ...txn, disposition: 'BLOCKED_PERIOD_CLOSED' }, asStore(db))).toBe(false);
    await expect(db.transactionActionability.findUniqueOrThrow({ where: { transactionId: txn.id } }))
      .resolves.toMatchObject({ revision: 1, disposition: 'WRITABLE' });
    await ensureUnknownProviderActionability(current, asStore(db));
    await expect(db.transactionActionability.findUniqueOrThrow({ where: { transactionId: txn.id } }))
      .resolves.toMatchObject({ revision: 2, qboSyncToken: '8', disposition: 'UNKNOWN', checkedAt: null });
    expect(await persistProviderActionability({ ...txn, evidence }, asStore(db))).toBe(false);
    expect(await persistProviderActionability({ ...current, evidence }, asStore(db))).toBe(true);
  });

  it('rolls back the revision and UNKNOWN rebind together', async () => {
    const txn = await seed();
    await ensureUnknownProviderActionability(txn, asStore(db));
    await persistProviderActionability({ ...txn, evidence }, asStore(db));
    await expect(db.$transaction(async (tx) => {
      const current = await tx.transaction.update({ where: { id: txn.id }, data: { revision: 2 } });
      await ensureUnknownProviderActionability(current, asStore(tx));
      throw new Error('Rollback fixture');
    })).rejects.toThrow('Rollback fixture');
    await expect(db.transaction.findUniqueOrThrow({ where: { id: txn.id } })).resolves.toMatchObject({ revision: 1 });
    await expect(db.transactionActionability.findUniqueOrThrow({ where: { transactionId: txn.id } }))
      .resolves.toMatchObject({ revision: 1, disposition: 'WRITABLE' });
  });

  it('seeds a missing cache once without overwriting the winning observation', async () => {
    const txn = await seed();
    const results = await Promise.all([
      createUnknownProviderActionabilityIfMissing(txn, asStore(db)),
      createUnknownProviderActionabilityIfMissing(txn, asStore(db)),
    ]);
    expect(results.sort()).toEqual([false, true]);
    await persistProviderActionability({ ...txn, evidence }, asStore(db));
    expect(await createUnknownProviderActionabilityIfMissing(txn, asStore(db))).toBe(false);
    await expect(db.transactionActionability.findUniqueOrThrow({ where: { transactionId: txn.id } }))
      .resolves.toMatchObject({ disposition: 'WRITABLE' });
  });
});
