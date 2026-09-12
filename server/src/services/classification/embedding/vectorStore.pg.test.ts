import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClassificationSearchRepository } from '../search.js';
import { classificationEmbeddingGeneration } from './recipe.js';
import { PgClassificationVectorStore } from './vectorStore.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PGVECTOR_DATABASE_URL = process.env.TEST_PGVECTOR_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const describePgvector = TEST_PGVECTOR_DATABASE_URL ? describe : describe.skip;

function vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => index === seed ? 1 : 0);
}

type OwnerMoveScenario = {
  name: string;
  arrange(
    db: PrismaClient,
    oldCompanyId: string,
    newCompanyId: string,
  ): Promise<() => Promise<unknown>>;
};

const ownerMoveScenarios: readonly OwnerMoveScenario[] = [
  {
    name: 'VendorIdentity.companyId',
    async arrange(db, oldCompanyId, newCompanyId) {
      const row = await db.vendorIdentity.create({
        data: { companyId: oldCompanyId, displayName: 'Moving identity', normalizedName: 'moving identity' },
      });
      return () => db.vendorIdentity.update({ where: { id: row.id }, data: { companyId: newCompanyId } });
    },
  },
  {
    name: 'Tag.companyId',
    async arrange(db, oldCompanyId, newCompanyId) {
      const row = await db.tag.create({
        data: { companyId: oldCompanyId, name: 'Moving tag', color: '#123456' },
      });
      const [oldRule, newRule] = await Promise.all([
        db.rule.create({
          data: { companyId: oldCompanyId, matchText: 'Old tagged rule', category: 'Synthetic expense' },
        }),
        db.rule.create({
          data: { companyId: newCompanyId, matchText: 'New tagged rule', category: 'Synthetic expense' },
        }),
      ]);
      await db.ruleTag.createMany({
        data: [
          { ruleId: oldRule.id, tagId: row.id },
          { ruleId: newRule.id, tagId: row.id },
        ],
      });
      return () => db.tag.update({ where: { id: row.id }, data: { companyId: newCompanyId } });
    },
  },
  {
    name: 'QboAccount.companyId',
    async arrange(db, oldCompanyId, newCompanyId) {
      const row = await db.qboAccount.create({
        data: {
          companyId: oldCompanyId, qboId: 'moving-account', name: 'Moving account',
          fullName: 'Expenses · Moving account', classification: 'Expense',
        },
      });
      await db.rule.createMany({
        data: [
          {
            companyId: oldCompanyId, matchText: 'Old account rule', category: row.name,
            categoryQboId: row.qboId,
          },
          {
            companyId: newCompanyId, matchText: 'New account rule', category: row.name,
            categoryQboId: row.qboId,
          },
        ],
      });
      return () => db.qboAccount.update({ where: { id: row.id }, data: { companyId: newCompanyId } });
    },
  },
  {
    name: 'QboTaxCode.companyId',
    async arrange(db, oldCompanyId, newCompanyId) {
      const row = await db.qboTaxCode.create({
        data: {
          companyId: oldCompanyId, qboId: 'moving-tax-code', name: 'Moving tax code',
          purchaseTaxRateList: [],
        },
      });
      await db.rule.createMany({
        data: [
          {
            companyId: oldCompanyId, matchText: 'Old tax rule', category: 'Synthetic expense',
            taxCode: row.name, taxCodeQboId: row.qboId,
          },
          {
            companyId: newCompanyId, matchText: 'New tax rule', category: 'Synthetic expense',
            taxCode: row.name, taxCodeQboId: row.qboId,
          },
        ],
      });
      return () => db.qboTaxCode.update({ where: { id: row.id }, data: { companyId: newCompanyId } });
    },
  },
  {
    name: 'Transaction.companyId',
    async arrange(db, oldCompanyId, newCompanyId) {
      const row = await db.transaction.create({
        data: {
          companyId: oldCompanyId, qboId: 'moving-transaction', qboType: 'Purchase',
          qboSyncToken: '1', date: new Date('2026-08-31T00:00:00.000Z'),
          payee: 'Moving transaction', amount: '-1.00', bankAccount: 'Synthetic bank',
        },
      });
      return () => db.transaction.update({ where: { id: row.id }, data: { companyId: newCompanyId } });
    },
  },
];

describePostgres('classification vector store on vanilla PostgreSQL', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('reports pgvector unavailable without creating an extension or derived tables', async () => {
    const store = new PgClassificationVectorStore(db);

    await expect(store.ensureAvailable()).resolves.toEqual({
      available: false,
      reason: 'vector_capability_unavailable',
    });
    await expect(db.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass('public."ClassificationEmbeddingChunk"') IS NOT NULL AS present
    `).resolves.toEqual([{ present: false }]);
  });
});

describePgvector('classification vector store on PostgreSQL with pgvector', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_PGVECTOR_DATABASE_URL! } } });
    await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function company(name: string) {
    const created = await db.company.create({
      data: {
        realmId: `vector-${randomUUID()}`,
        legalName: `${name} Legal`,
        nickname: name,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  async function publishEmptyGeneration(
    store: PgClassificationVectorStore,
    companyId: string,
    generation: ReturnType<typeof classificationEmbeddingGeneration>,
  ) {
    const attempt = await store.beginAttempt({ companyId, fingerprint: generation.fingerprint });
    const corpus = await new PrismaClassificationSearchRepository(db).documents(
      companyId,
      attempt.targetRevision,
    );
    await store.publishGeneration({
      companyId,
      generation,
      chunks: corpus.documents.flatMap((document) => document.chunks.map((chunk) => ({
        companyId,
        documentId: document.id,
        kind: document.kind,
        sourceId: document.sourceId,
        revisedAt: document.revisedAt,
        chunkIndex: chunk.index,
        contentHash: chunk.contentHash,
        embedding: vector(chunk.index % 1024),
      }))),
      totalDocuments: corpus.totalDocuments,
      skippedDocuments: corpus.skippedDocuments,
      targetRevision: attempt.targetRevision, attemptToken: attempt.token,
    });
  }

  async function latestRevision(companyId: string) {
    return (await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId }, orderBy: { revision: 'desc' },
    })).revision;
  }

  it('serves repeated capability checks while generation readers hold a lock that excludes DDL', async () => {
    const measuredDb = {
      $queryRaw: db.$queryRaw.bind(db),
      $executeRaw: (query: Parameters<typeof db.$executeRaw>[0]) => db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
        return tx.$executeRaw(query);
      }),
    };
    await new PgClassificationVectorStore(measuredDb as never).ensureAvailable();
    let locked!: () => void; let release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const reader = db.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "ClassificationEmbeddingGeneration" IN ACCESS SHARE MODE');
      locked(); await released;
    });
    try {
      await acquired;
      await expect(new PgClassificationVectorStore(measuredDb as never).ensureAvailable()).resolves.toEqual({ available: true, reason: null });
    } finally {
      release(); await reader;
    }
  });

  it('loads semantic health for one hundred companies with one database round trip', async () => {
    const prefix = `vector-health-many-${randomUUID()}`;
    await db.company.createMany({
      data: Array.from({ length: 100 }, (_unused, index) => ({
        realmId: `${prefix}-${index}`,
        legalName: `Health Many ${index} Legal`,
        nickname: `Health Many ${index}`,
      })),
    });
    const owners = await db.company.findMany({
      where: { realmId: { startsWith: prefix } },
      orderBy: { id: 'asc' },
    });
    owners.forEach((owner) => companyIds.add(owner.id));
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'health-many',
    });
    await new PgClassificationVectorStore(db).ensureAvailable();
    let queryCount = 0;
    const measuredDb = {
      async $queryRaw(query: unknown) {
        queryCount += 1;
        return db.$queryRaw(query as never);
      },
      async $executeRaw() { throw new Error('not expected'); },
    };

    const health = await new PgClassificationVectorStore(measuredDb as never)
      .healthMany(owners.map((owner) => owner.id), generation.fingerprint);

    expect(health).toHaveLength(100);
    expect(health.every((state) => state.currentCorpusRevision !== null)).toBe(true);
    expect(queryCount).toBe(1);
  });

  async function expectSemanticGuardRejectsStale(
    store: PgClassificationVectorStore,
    companyId: string,
    generation: ReturnType<typeof classificationEmbeddingGeneration>,
  ) {
    await expect(store.search({
      companyIds: [companyId], fingerprint: generation.fingerprint,
      embedding: vector(0), cosineFloor: 0.8, limit: 10,
    })).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
  }

  it('keeps a succeeded generation healthy across idempotent QBO lookup syncs', async () => {
    const owner = await company('Idempotent Lookup Sync Company');
    const account = await db.qboAccount.create({
      data: {
        companyId: owner.id, qboId: 'stable-account', name: 'Stable account',
        fullName: 'Expenses · Stable account', classification: 'Expense',
      },
    });
    const taxCode = await db.qboTaxCode.create({
      data: {
        companyId: owner.id, qboId: 'stable-tax', name: 'Stable tax',
        purchaseTaxRateList: [],
      },
    });
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'idempotent-lookup-sync',
    });
    await publishEmptyGeneration(store, owner.id, generation);
    const before = await latestRevision(owner.id);

    await db.qboAccount.update({
      where: { id: account.id },
      data: { qboId: account.qboId, name: account.name, fullName: account.fullName },
    });
    await db.qboTaxCode.update({
      where: { id: taxCode.id },
      data: { qboId: taxCode.qboId, name: taxCode.name },
    });

    expect(await latestRevision(owner.id)).toBe(before);
    await expect(store.health(owner.id, generation.fingerprint)).resolves.toMatchObject({
      expectedState: 'succeeded',
      backlog: 0,
      currentCorpusRevision: before.toString(),
      indexedCorpusRevision: before.toString(),
    });
  });

  it('rejects a previously active semantic generation after a reviewed vendor merge', async () => {
    const owner = await company('Vendor Merge Revision Company');
    const [source, target] = await Promise.all([
      db.vendorIdentity.create({
        data: {
          companyId: owner.id,
          displayName: 'Historical Merge Source',
          normalizedName: 'historical merge source',
        },
      }),
      db.vendorIdentity.create({
        data: {
          companyId: owner.id,
          displayName: 'Reviewed Merge Target',
          normalizedName: 'reviewed merge target',
        },
      }),
    ]);
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'vendor-merge-revision',
    });
    await publishEmptyGeneration(store, owner.id, generation);
    const before = await latestRevision(owner.id);

    await db.vendorIdentityMerge.create({
      data: {
        companyId: owner.id,
        sourceVendorIdentityId: source.id,
        targetVendorIdentityId: target.id,
        mergedBy: 'reviewer-vector',
        reason: 'Reviewed duplicate invalidates the previous semantic corpus.',
      },
    });

    expect(await latestRevision(owner.id)).toBeGreaterThan(before);
    await expectSemanticGuardRejectsStale(store, owner.id, generation);
  });

  it.each(ownerMoveScenarios)(
    '$name advances both owner revisions and invalidates active semantic indexes',
    async ({ name, arrange }) => {
      const oldOwner = await company(`${name} old owner`);
      const newOwner = await company(`${name} new owner`);
      const move = await arrange(db, oldOwner.id, newOwner.id);
      const store = new PgClassificationVectorStore(db);
      await store.ensureAvailable();
      const generation = classificationEmbeddingGeneration({
        baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: `owner-move-${name}`,
      });
      await publishEmptyGeneration(store, oldOwner.id, generation);
      await publishEmptyGeneration(store, newOwner.id, generation);
      const [oldBefore, newBefore] = await Promise.all([
        latestRevision(oldOwner.id), latestRevision(newOwner.id),
      ]);

      await move();

      const [oldAfter, newAfter] = await Promise.all([
        latestRevision(oldOwner.id), latestRevision(newOwner.id),
      ]);
      expect(oldAfter).toBeGreaterThan(oldBefore);
      expect(newAfter).toBeGreaterThan(newBefore);
      await expectSemanticGuardRejectsStale(store, oldOwner.id, generation);
      await expectSemanticGuardRejectsStale(store, newOwner.id, generation);
    },
  );

  it.each([
    {
      name: 'VendorIdentity.id',
      async arrange(companyId: string) {
        const row = await db.vendorIdentity.create({
          data: { companyId, displayName: 'Identity document ID', normalizedName: 'identity document id' },
        });
        return () => db.vendorIdentity.update({ where: { id: row.id }, data: { id: randomUUID() } });
      },
    },
    {
      name: 'QboAccount.qboId',
      async arrange(companyId: string) {
        const row = await db.qboAccount.create({
          data: {
            companyId, qboId: 'old-account-qbo-id', name: 'Joined account',
            fullName: 'Expenses · Joined account', classification: 'Expense',
          },
        });
        await db.rule.create({
          data: {
            companyId, matchText: 'Joined account rule', category: row.name,
            categoryQboId: row.qboId,
          },
        });
        return () => db.qboAccount.update({ where: { id: row.id }, data: { qboId: 'new-account-qbo-id' } });
      },
    },
    {
      name: 'QboTaxCode.qboId',
      async arrange(companyId: string) {
        const row = await db.qboTaxCode.create({
          data: {
            companyId, qboId: 'old-tax-qbo-id', name: 'Joined tax code', purchaseTaxRateList: [],
          },
        });
        await db.rule.create({
          data: {
            companyId, matchText: 'Joined tax rule', category: 'Synthetic expense',
            taxCode: row.name, taxCodeQboId: row.qboId,
          },
        });
        return () => db.qboTaxCode.update({ where: { id: row.id }, data: { qboId: 'new-tax-qbo-id' } });
      },
    },
  ])('$name invalidates an active semantic index', async ({ name, arrange }) => {
    const owner = await company(`${name} owner`);
    const mutate = await arrange(owner.id);
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: `join-key-${name}`,
    });
    await publishEmptyGeneration(store, owner.id, generation);
    const before = await latestRevision(owner.id);

    await mutate();

    expect(await latestRevision(owner.id)).toBeGreaterThan(before);
    await expectSemanticGuardRejectsStale(store, owner.id, generation);
  });

  it('publishes atomically, fences companies, and never ranks a retired generation', async () => {
    const first = await company('Vector Company A');
    const second = await company('Vector Company B');
    const store = new PgClassificationVectorStore(db);
    await expect(store.ensureAvailable()).resolves.toEqual({ available: true, reason: null });
    const oldGeneration = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'old-synthetic-generation',
    });
    const newGeneration = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'new-synthetic-generation',
    });
    const firstOldAttempt = await store.beginAttempt({ companyId: first.id, fingerprint: oldGeneration.fingerprint });
    await store.publishGeneration({
      targetRevision: firstOldAttempt.targetRevision,
      attemptToken: firstOldAttempt.token,
      companyId: first.id,
      generation: oldGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: first.id,
        documentId: 'classification_case:old-a',
        kind: 'classification_case',
        sourceId: 'old-a',
        revisedAt: '2026-08-30T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'a'.repeat(64),
        embedding: vector(0),
      }],
    });
    const secondNewAttempt = await store.beginAttempt({ companyId: second.id, fingerprint: newGeneration.fingerprint });
    await store.publishGeneration({
      targetRevision: secondNewAttempt.targetRevision,
      attemptToken: secondNewAttempt.token,
      companyId: second.id,
      generation: newGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: second.id,
        documentId: 'classification_case:new-b',
        kind: 'classification_case',
        sourceId: 'new-b',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'b'.repeat(64),
        embedding: vector(0),
      }],
    });
    const firstNewAttempt = await store.beginAttempt({ companyId: first.id, fingerprint: newGeneration.fingerprint });
    await store.publishGeneration({
      targetRevision: firstNewAttempt.targetRevision,
      attemptToken: firstNewAttempt.token,
      companyId: first.id,
      generation: newGeneration,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: first.id,
        documentId: 'classification_case:new-a',
        kind: 'classification_case',
        sourceId: 'new-a',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'c'.repeat(64),
        embedding: vector(0),
      }],
    });

    await expect(store.search({
      companyIds: [first.id],
      fingerprint: oldGeneration.fingerprint,
      embedding: vector(0),
      cosineFloor: 0.8,
      limit: 10,
    })).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
    const current = await store.search({
      companyIds: [first.id],
      fingerprint: newGeneration.fingerprint,
      embedding: vector(0),
      cosineFloor: 0.8,
      limit: 10,
    });
    expect(current).toEqual([
      expect.objectContaining({ documentId: 'classification_case:new-a', companyId: first.id, similarity: 1 }),
    ]);
    expect(current.some((hit) => hit.companyId === second.id)).toBe(false);
    await expect(store.health(first.id, newGeneration.fingerprint)).resolves.toMatchObject({
      activeGeneration: newGeneration.fingerprint,
      expectedGeneration: newGeneration.fingerprint,
      expectedState: 'succeeded',
      embedded: 1,
      skipped: 0,
      backlog: 0,
      progress: 1,
      lastError: null,
    });
  });

  it('leaves the active generation readable when a replacement vector is invalid', async () => {
    const owner = await company('Vector Failure Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const active = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'active-synthetic-generation',
    });
    const replacement = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'replacement-synthetic-generation',
    });
    const activeAttempt = await store.beginAttempt({ companyId: owner.id, fingerprint: active.fingerprint });
    await store.publishGeneration({
      targetRevision: activeAttempt.targetRevision,
      attemptToken: activeAttempt.token,
      companyId: owner.id,
      generation: active,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: owner.id,
        documentId: 'rule:active',
        kind: 'rule',
        sourceId: 'active',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'd'.repeat(64),
        embedding: vector(1),
      }],
    });
    const invalidAttempt = await store.beginAttempt({ companyId: owner.id, fingerprint: replacement.fingerprint });
    await expect(store.publishGeneration({
      targetRevision: invalidAttempt.targetRevision,
      attemptToken: invalidAttempt.token,
      companyId: owner.id,
      generation: replacement,
      totalDocuments: 1,
      skippedDocuments: 0,
      chunks: [{
        companyId: owner.id,
        documentId: 'rule:replacement',
        kind: 'rule',
        sourceId: 'replacement',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'e'.repeat(64),
        embedding: [1, 2],
      }],
    })).rejects.toMatchObject({ code: 'INVALID_VECTOR' });
    const incompleteAttempt = await store.beginAttempt({ companyId: owner.id, fingerprint: replacement.fingerprint });
    await expect(store.publishGeneration({
      targetRevision: incompleteAttempt.targetRevision,
      attemptToken: incompleteAttempt.token,
      companyId: owner.id,
      generation: replacement,
      totalDocuments: 2,
      skippedDocuments: 0,
      chunks: [{
        companyId: owner.id,
        documentId: 'rule:incomplete-replacement',
        kind: 'rule',
        sourceId: 'incomplete-replacement',
        revisedAt: '2026-08-31T00:00:00.000Z',
        chunkIndex: 0,
        contentHash: 'f'.repeat(64),
        embedding: vector(1),
      }],
    })).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      activeGeneration: active.fingerprint,
    });
  });

  it('persists build health before cutover and separates a reactivated generation from a newer failed attempt', async () => {
    const owner = await company('Vector Attempt Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const active = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'reactivated-generation',
    });
    const interim = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'interim-generation',
    });
    const failed = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'newer-failed-generation',
    });
    const chunk = (generationId: string, seed: number) => ({
      companyId: owner.id,
      documentId: `rule:${generationId}`,
      kind: 'rule' as const,
      sourceId: generationId,
      revisedAt: '2026-08-31T00:00:00.000Z',
      chunkIndex: 0,
      contentHash: String(seed).repeat(64).slice(0, 64),
      embedding: vector(seed),
    });
    let attempt = await store.beginAttempt({ companyId: owner.id, fingerprint: active.fingerprint });
    await store.publishGeneration({
      targetRevision: attempt.targetRevision, attemptToken: attempt.token,
      companyId: owner.id, generation: active, chunks: [chunk('active', 2)],
      totalDocuments: 1, skippedDocuments: 0,
    });
    await store.recordProgress({
      companyId: owner.id,
      fingerprint: active.fingerprint,
      totalDocuments: 2,
      embeddedDocuments: 1,
      skippedDocuments: 0,
      targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    });
    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      activeGeneration: active.fingerprint,
      expectedState: 'building',
      backlog: 1,
      progress: 0.5,
    });
    attempt = await store.beginAttempt({ companyId: owner.id, fingerprint: interim.fingerprint });
    await store.publishGeneration({
      targetRevision: attempt.targetRevision, attemptToken: attempt.token,
      companyId: owner.id, generation: interim, chunks: [chunk('interim', 3)],
      totalDocuments: 1, skippedDocuments: 0,
    });
    attempt = await store.beginAttempt({ companyId: owner.id, fingerprint: active.fingerprint });
    await store.publishGeneration({
      targetRevision: attempt.targetRevision, attemptToken: attempt.token,
      companyId: owner.id, generation: active, chunks: [chunk('active', 2)],
      totalDocuments: 1, skippedDocuments: 0,
    });
    const failedAttempt = await store.beginAttempt({ companyId: owner.id, fingerprint: failed.fingerprint });
    await store.recordFailure({
      companyId: owner.id,
      fingerprint: failed.fingerprint,
      totalDocuments: 2,
      embeddedDocuments: 0,
      skippedDocuments: 0,
      errorCode: 'semantic_error',
      targetRevision: failedAttempt.targetRevision,
      attemptToken: failedAttempt.token,
    });

    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      activeGeneration: active.fingerprint,
      expectedGeneration: active.fingerprint,
      expectedState: 'succeeded',
      embedded: 1,
      backlog: 0,
      lastError: null,
      latestAttemptGeneration: failed.fingerprint,
      latestAttemptState: 'failed',
      latestAttemptError: 'semantic_error',
    });
  });

  it('invalidates same-generation vectors immediately and fences stale publish before a clean retry', async () => {
    const owner = await company('Vector Revision Fence Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const active = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'same-generation-revision-fence',
    });
    let attempt = await store.beginAttempt({
      companyId: owner.id,
      fingerprint: active.fingerprint,
    });
    await store.publishGeneration({
      companyId: owner.id,
      generation: active,
      chunks: [],
      totalDocuments: 0,
      skippedDocuments: 0,
      targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    });
    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      currentCorpusRevision: attempt.targetRevision,
      indexedCorpusRevision: attempt.targetRevision,
      expectedCorpusRevision: attempt.targetRevision,
      expectedState: 'succeeded',
    });
    await expect(store.search({
      companyIds: [owner.id], fingerprint: active.fingerprint,
      embedding: vector(0), cosineFloor: 0.8, limit: 10,
    })).resolves.toEqual([]);

    await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Write Between Ticks',
        normalizedName: 'write between ticks',
      },
    });
    const stale = await store.health(owner.id, active.fingerprint);
    expect(stale.currentCorpusRevision).not.toBe(stale.indexedCorpusRevision);
    await expect(store.search({
      companyIds: [owner.id], fingerprint: active.fingerprint,
      embedding: vector(0), cosineFloor: 0.8, limit: 10,
    })).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });

    attempt = await store.beginAttempt({
      companyId: owner.id,
      fingerprint: active.fingerprint,
    });
    await store.recordProgress({
      companyId: owner.id,
      fingerprint: active.fingerprint,
      totalDocuments: 0,
      embeddedDocuments: 0,
      skippedDocuments: 0,
      targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    });
    await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Write Before Publish',
        normalizedName: 'write before publish',
      },
    });
    await expect(store.publishGeneration({
      companyId: owner.id,
      generation: active,
      chunks: [],
      totalDocuments: 0,
      skippedDocuments: 0,
      targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    })).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
    await store.recordFailure({
      companyId: owner.id,
      fingerprint: active.fingerprint,
      totalDocuments: 0,
      embeddedDocuments: 0,
      skippedDocuments: 0,
      errorCode: 'semantic_error',
      targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    });
    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      expectedState: 'failed',
      latestAttemptCorpusRevision: attempt.targetRevision,
    });

    const retryAttempt = await store.beginAttempt({
      companyId: owner.id,
      fingerprint: active.fingerprint,
    });
    await store.publishGeneration({
      companyId: owner.id,
      generation: active,
      chunks: [],
      totalDocuments: 0,
      skippedDocuments: 0,
      targetRevision: retryAttempt.targetRevision,
      attemptToken: retryAttempt.token,
    });
    await expect(store.health(owner.id, active.fingerprint)).resolves.toMatchObject({
      currentCorpusRevision: retryAttempt.targetRevision,
      indexedCorpusRevision: retryAttempt.targetRevision,
      expectedCorpusRevision: retryAttempt.targetRevision,
      expectedState: 'succeeded',
      lastError: null,
    });
  });

  it('waits for an earlier uncommitted writer before rejecting a stale publication', async () => {
    const owner = await company('Commit Order Barrier Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'commit-order-barrier',
    });
    const attempt = await store.beginAttempt({
      companyId: owner.id, fingerprint: generation.fingerprint,
    });
    let inserted!: () => void;
    let release!: () => void;
    const insertedPromise = new Promise<void>((resolve) => { inserted = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const earlyWriter = db.$transaction(async (tx) => {
      await tx.vendorIdentity.create({
        data: {
          companyId: owner.id,
          displayName: 'Allocated Earlier Commits Later',
          normalizedName: 'allocated earlier commits later',
        },
      });
      inserted();
      await releasePromise;
    });
    await insertedPromise;
    await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Allocated Later Commits Earlier',
        normalizedName: 'allocated later commits earlier',
      },
    });
    let settled = false;
    const publication = store.publishGeneration({
      companyId: owner.id, generation, chunks: [], totalDocuments: 0,
      skippedDocuments: 0, targetRevision: attempt.targetRevision,
      attemptToken: attempt.token,
    }).then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    release();
    await earlyWriter;
    await expect(publication).resolves.toMatchObject({ code: 'GENERATION_CONFLICT' });
  });

  it('drains in-flight writers before capturing an attempt revision', async () => {
    const owner = await company('Attempt Capture Barrier Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'attempt-capture-barrier',
    });
    let inserted!: () => void;
    let release!: () => void;
    const insertedPromise = new Promise<void>((resolve) => { inserted = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.$transaction(async (tx) => {
      await tx.vendorIdentity.create({
        data: {
          companyId: owner.id,
          displayName: 'Capture Barrier Writer',
          normalizedName: 'capture barrier writer',
        },
      });
      inserted();
      await releasePromise;
    });
    await insertedPromise;
    let settled = false;
    const attemptPromise = store.beginAttempt({
      companyId: owner.id, fingerprint: generation.fingerprint,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    release();
    await writer;
    const attempt = await attemptPromise;
    const latest = await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId: owner.id }, orderBy: { revision: 'desc' },
    });
    expect(attempt.targetRevision).toBe(latest.revision.toString());
  });

  it('prevents an older attempt failure from overwriting a newer success', async () => {
    type Attempt = { targetRevision: string; token: string };
    type AttemptStore = {
      beginAttempt(input: { companyId: string; fingerprint: string }): Promise<Attempt>;
      publishGeneration(input: {
        companyId: string; generation: ReturnType<typeof classificationEmbeddingGeneration>;
        chunks: readonly never[]; totalDocuments: number; skippedDocuments: number;
        targetRevision: string; attemptToken: string;
      }): Promise<void>;
      recordFailure(input: {
        companyId: string; fingerprint: string; totalDocuments: number;
        embeddedDocuments: number; skippedDocuments: number; errorCode: string;
        targetRevision: string; attemptToken: string;
      }): Promise<void>;
    };
    const owner = await company('Attempt CAS Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'attempt-cas',
    });
    const guarded = store as unknown as AttemptStore;
    const older = await guarded.beginAttempt({ companyId: owner.id, fingerprint: generation.fingerprint });
    const newer = await guarded.beginAttempt({ companyId: owner.id, fingerprint: generation.fingerprint });
    expect(older.token).not.toBe(newer.token);
    await guarded.publishGeneration({
      companyId: owner.id, generation, chunks: [], totalDocuments: 0, skippedDocuments: 0,
      targetRevision: newer.targetRevision, attemptToken: newer.token,
    });
    await guarded.recordFailure({
      companyId: owner.id, fingerprint: generation.fingerprint,
      totalDocuments: 1, embeddedDocuments: 0, skippedDocuments: 0,
      errorCode: 'semantic_error', targetRevision: older.targetRevision,
      attemptToken: older.token,
    });
    await expect(store.health(owner.id, generation.fingerprint)).resolves.toMatchObject({
      expectedState: 'succeeded', backlog: 0, lastError: null,
    });
  });

  it('bulk-publishes 10,001 chunks within the deliberate transaction budget', async () => {
    const owner = await company('Large Publication Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'large-publication',
    });
    const attempt = await store.beginAttempt({
      companyId: owner.id, fingerprint: generation.fingerprint,
    });
    const sharedVector = vector(0);
    const chunks = Array.from({ length: 10_001 }, (_unused, index) => ({
      companyId: owner.id,
      documentId: `vendor_identity:large-${String(index).padStart(5, '0')}`,
      kind: 'vendor_identity' as const,
      sourceId: `large-${String(index).padStart(5, '0')}`,
      revisedAt: '2026-08-31T00:00:00.000Z',
      chunkIndex: 0,
      contentHash: index.toString(16).padStart(64, '0'),
      embedding: sharedVector,
    }));

    await store.publishGeneration({
      companyId: owner.id, generation, chunks,
      totalDocuments: chunks.length, skippedDocuments: 0,
      targetRevision: attempt.targetRevision, attemptToken: attempt.token,
    });
    await expect(db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM "ClassificationEmbeddingChunk"
      WHERE "companyId" = ${owner.id} AND "fingerprint" = ${generation.fingerprint}
    `).resolves.toEqual([{ count: 10_001n }]);
  }, 60_000);

  it('compacts revision events and retired generations after successful cutover', async () => {
    const owner = await company('Embedding Retention Company');
    const store = new PgClassificationVectorStore(db);
    await store.ensureAvailable();
    const first = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'retention-first',
    });
    const second = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'retention-second',
    });
    let attempt = await store.beginAttempt({ companyId: owner.id, fingerprint: first.fingerprint });
    await store.publishGeneration({
      companyId: owner.id, generation: first, chunks: [], totalDocuments: 0,
      skippedDocuments: 0, targetRevision: attempt.targetRevision, attemptToken: attempt.token,
    });
    for (let index = 0; index < 20; index += 1) {
      await db.company.update({
        where: { id: owner.id }, data: { nickname: `Retention ${index}` },
      });
    }
    attempt = await store.beginAttempt({ companyId: owner.id, fingerprint: second.fingerprint });
    await store.publishGeneration({
      companyId: owner.id, generation: second, chunks: [], totalDocuments: 0,
      skippedDocuments: 0, targetRevision: attempt.targetRevision, attemptToken: attempt.token,
    });

    const [revisions, generations] = await Promise.all([
      db.classificationCorpusRevision.count({ where: { companyId: owner.id } }),
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM "ClassificationEmbeddingGeneration"
        WHERE "companyId" = ${owner.id}
      `,
    ]);
    expect(revisions).toBe(1);
    expect(generations).toEqual([{ count: 1n }]);
  });
});
