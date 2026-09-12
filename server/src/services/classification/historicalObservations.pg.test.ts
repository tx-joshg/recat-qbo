import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillHistoricalClassificationObservations,
  type HistoricalObservationDb,
} from './historicalObservations.js';

import { createCompanyReadService, type CompanyReadDb } from '../companyReads.js';
import { recordVerifiedClassificationCase } from './cases.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('historical classification observations on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
    userIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function company(label: string) {
    const created = await db.company.create({
      data: {
        realmId: `historical-observation-${label}-${randomUUID()}`,
        legalName: `${label} Legal`,
        nickname: label,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  async function transaction(companyId: string, rawData: unknown = { CurrencyRef: { value: 'CAD' } }) {
    return db.transaction.create({
      data: {
        companyId,
        qboId: `purchase-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '3',
        date: new Date('2026-06-15T00:00:00.000Z'),
        payee: 'Synthetic historical vendor',
        memo: 'Synthetic historical memo',
        amount: '-113.00',
        bankAccount: 'Synthetic bank account',
        status: 'POSTED',
        category: 'Synthetic inventory',
        categoryQboId: 'synthetic-category',
        taxCalculation: 'TaxExcluded',
        taxCode: 'Synthetic tax',
        taxCodeQboId: 'synthetic-tax',
        rawData: rawData as never,
      },
    });
  }

  async function addTags(companyId: string, sourceTransactionId: string, start: number, count: number) {
    const tags = await Promise.all(Array.from({ length: count }, (_, index) => db.tag.create({
      data: {
        companyId,
        name: `Historical tag ${String(start + index).padStart(2, '0')}`,
        color: '#112233',
      },
    })));
    await db.txnTag.createMany({
      data: tags.map((tag) => ({ txnId: sourceTransactionId, tagId: tag.id })),
    });
  }

  async function counts(companyId: string) {
    const [
      observations,
      transactions,
      cases,
      rules,
      candidates,
      candidateEvidence,
      candidateFolds,
      mutationAttempts,
    ] = await Promise.all([
      db.historicalClassificationObservation.count({ where: { companyId } }),
      db.transaction.count({ where: { companyId } }),
      db.classificationCase.count({ where: { companyId } }),
      db.rule.count({ where: { companyId } }),
      db.autopilotRuleCandidate.count({ where: { companyId } }),
      db.autopilotRuleCandidateEvidence.count({ where: { companyId } }),
      db.autopilotRuleCandidateFold.count({ where: { companyId } }),
      db.qboMutationAttempt.count({ where: { transaction: { companyId } } }),
    ]);
    return {
      observations, transactions, cases, rules, candidates, candidateEvidence, candidateFolds, mutationAttempts,
    };
  }

  async function latestCorpusRevision(companyId: string): Promise<bigint> {
    return (await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId },
      orderBy: { revision: 'desc' },
    })).revision;
  }

  function validObservation(companyId: string, sourceTransactionId: string) {
    return {
      companyId,
      sourceTransactionId,
      sourceQboType: 'Purchase',
      sourceQboId: `source-${randomUUID()}`,
      sourceTransactionRevision: 3,
      sourceQboSyncToken: '3',
      sourceStatus: 'POSTED',
      sourceUpdatedAt: new Date('2026-06-15T12:00:00.000Z'),
      transactionDate: new Date('2026-06-15T00:00:00.000Z'),
      payee: 'Synthetic historical vendor',
      memo: 'Synthetic historical memo',
      amountCents: -11300n,
      currency: 'CAD',
      sourceAccountName: 'Synthetic bank account',
      categoryName: 'Synthetic inventory',
      categoryQboId: 'synthetic-category',
      taxCalculation: 'TaxExcluded',
      taxCodeName: 'Synthetic tax',
      taxCodeQboId: 'synthetic-tax',
      tagNames: ['Synthetic tag'],
    };
  }

  it('accepts one observation per source revision and advances the corpus revision only on insert and delete', async () => {
    const companyA = await company('Observation A');
    const source = await transaction(companyA.id);
    const before = await latestCorpusRevision(companyA.id);
    const observation = validObservation(companyA.id, source.id);
    const row = await db.historicalClassificationObservation.create({ data: observation });
    const afterInsert = await latestCorpusRevision(companyA.id);
    expect(afterInsert).toBeGreaterThan(before);
    await expect(db.historicalClassificationObservation.create({ data: observation })).rejects.toMatchObject({ code: 'P2002' });

    await expect(db.historicalClassificationObservation.update({
      where: { id: row.id }, data: { memo: 'Synthetic attempted display rewrite' },
    })).rejects.toThrow('append-only');
    expect((await db.historicalClassificationObservation.findUniqueOrThrow({ where: { id: row.id } })).memo).toBe(observation.memo);
    expect(await latestCorpusRevision(companyA.id)).toBe(afterInsert);

    await db.historicalClassificationObservation.delete({ where: { id: row.id } });
    expect(await latestCorpusRevision(companyA.id)).toBeGreaterThan(afterInsert);
  });

  it('rejects duplicate source revision identities', async () => {
    const companyA = await company('Duplicate A');
    const source = await transaction(companyA.id);
    const observation = validObservation(companyA.id, source.id);
    observation.sourceQboId = 'duplicate-source';
    await db.historicalClassificationObservation.create({ data: observation });
    await expect(db.historicalClassificationObservation.create({ data: observation })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a source transaction from another company', async () => {
    const companyA = await company('Tenant A');
    const companyB = await company('Tenant B');
    const transactionB = await transaction(companyB.id);

    await expect(db.historicalClassificationObservation.create({
      data: validObservation(companyA.id, transactionB.id),
    })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('enforces posted source status and a nonnegative source revision', async () => {
    const companyA = await company('Constraint A');
    const source = await transaction(companyA.id);

    await expect(db.historicalClassificationObservation.create({
      data: { ...validObservation(companyA.id, source.id), sourceStatus: 'PENDING' },
    })).rejects.toThrow();
    await expect(db.historicalClassificationObservation.create({
      data: { ...validObservation(companyA.id, source.id), sourceTransactionRevision: -1 },
    })).rejects.toThrow();
  });

  it('atomically snapshots only a valid projected currency without promoting source rows', async () => {
    const companyA = await company('Apply currency source');
    await transaction(companyA.id, { CurrencyRef: { value: 'CAD' } });
    await transaction(companyA.id, { CurrencyRef: { value: 'cad' } });
    await transaction(companyA.id, { CurrencyRef: { value: { code: 'CAD' } } });
    await transaction(companyA.id, {});
    const before = await counts(companyA.id);

    const first = await backfillHistoricalClassificationObservations({
      companyId: companyA.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    const afterFirst = await counts(companyA.id);
    const second = await backfillHistoricalClassificationObservations({
      companyId: companyA.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    const afterSecond = await counts(companyA.id);

    expect(first).toMatchObject({ eligible: 1, inserted: 1, existing: 0 });
    expect(first.excluded.missing_currency).toBe(3);
    expect(afterFirst.observations).toBe(before.observations + 1);
    expect(afterFirst.transactions).toBe(before.transactions);
    expect(afterFirst.cases).toBe(before.cases);
    expect(afterFirst.rules).toBe(before.rules);
    expect(afterFirst.candidates).toBe(before.candidates);
    expect(afterFirst.candidateEvidence).toBe(before.candidateEvidence);
    expect(afterFirst.candidateFolds).toBe(before.candidateFolds);
    expect(afterFirst.mutationAttempts).toBe(before.mutationAttempts);
    expect(second).toMatchObject({ eligible: 1, inserted: 0, existing: 1 });
    expect(afterSecond).toEqual(afterFirst);
  });

  it('keeps 50 tags, excludes 51 tags, and rechecks the cap during the atomic insert', async () => {
    const withinCapCompany = await company('Tag cap accepted');
    const withinCap = await transaction(withinCapCompany.id);
    await addTags(withinCapCompany.id, withinCap.id, 1, 50);

    const withinCapResult = await backfillHistoricalClassificationObservations({
      companyId: withinCapCompany.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    const withinCapObservation = await db.historicalClassificationObservation.findFirstOrThrow({
      where: { companyId: withinCapCompany.id, sourceTransactionId: withinCap.id },
    });
    expect(withinCapResult).toMatchObject({ eligible: 1, inserted: 1, existing: 0 });
    expect(withinCapObservation.tagNames).toHaveLength(50);

    const overCapCompany = await company('Tag cap excluded');
    const overCap = await transaction(overCapCompany.id);
    await addTags(overCapCompany.id, overCap.id, 51, 51);
    const overCapResult = await backfillHistoricalClassificationObservations({
      companyId: overCapCompany.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, db);
    expect(overCapResult).toMatchObject({ eligible: 0, inserted: 0, existing: 0 });
    expect(overCapResult.excluded.missing_display_summary).toBe(1);
    expect(await db.historicalClassificationObservation.count({
      where: { companyId: overCapCompany.id, sourceTransactionId: overCap.id },
    })).toBe(0);

    const staleReadCompany = await company('Tag cap stale read');
    const changesAfterRead = await transaction(staleReadCompany.id);
    await addTags(staleReadCompany.id, changesAfterRead.id, 102, 50);
    let mutateAfterPreflight = true;
    const staleReadDb = {
      transaction: db.transaction,
      historicalClassificationObservation: db.historicalClassificationObservation,
      $transaction: db.$transaction.bind(db),
      $queryRaw: async (query: unknown) => {
        const rows = await db.$queryRaw(query as Prisma.Sql);
        if (mutateAfterPreflight) {
          mutateAfterPreflight = false;
          await addTags(staleReadCompany.id, changesAfterRead.id, 152, 1);
        }
        return rows;
      },
    } as unknown as HistoricalObservationDb;
    const staleReadResult = await backfillHistoricalClassificationObservations({
      companyId: staleReadCompany.id, startDate: '2025-01-01', endDate: '2026-12-31', dryRun: false,
    }, staleReadDb);
    expect(staleReadResult).toMatchObject({ eligible: 0, inserted: 0, existing: 0 });
    expect(await db.historicalClassificationObservation.count({
      where: { companyId: staleReadCompany.id, sourceTransactionId: changesAfterRead.id },
    })).toBe(0);
  });

  async function reader(companyId: string, isInstanceAdmin = false) {
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid`, isInstanceAdmin } });
    userIds.add(user.id);
    if (!isInstanceAdmin) await db.membership.create({ data: { userId: user.id, companyId, role: 'viewer' } });
    return user;
  }
  function reads() { return createCompanyReadService(db as unknown as CompanyReadDb, 'synthetic-history-cursor-secret'); }
  function backfill(companyId: string, dryRun = false, adapter: HistoricalObservationDb = db) {
    return backfillHistoricalClassificationObservations({
      companyId, startDate: '2026-06-01', endDate: '2026-06-30', dryRun,
    }, adapter);
  }

  it('keeps dry-run read-only and never turns an observation into a current verified case', async () => {
    const tenant = await company('Advisory'); const source = await transaction(tenant.id);
    const user = await reader(tenant.id); const before = await counts(tenant.id);
    expect(await backfill(tenant.id, true)).toMatchObject({ eligible: 1, inserted: 0 });
    expect(await counts(tenant.id)).toEqual(before);
    expect(await backfill(tenant.id)).toMatchObject({ eligible: 1, inserted: 1 });
    const page = await reads().listPastDecisions(user.id, tenant.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: 'historical_observation', advisory: true, executable: false, transactionId: source.id });
    expect(page.items[0]).not.toHaveProperty('action');
    await expect(reads().getCurrentClassificationCase(user.id, tenant.id, source.id)).rejects.toMatchObject({ code: 'CASE_NOT_FOUND' });
    expect((await counts(tenant.id)).mutationAttempts).toBe(before.mutationAttempts);
  });

  it('binds observation IDs and page cursors to the company and rechecks ordinary membership', async () => {
    const a = await company('Tenant A'); const b = await company('Tenant B');
    await transaction(a.id); await transaction(a.id); await transaction(b.id);
    await backfill(a.id); await backfill(b.id);
    const user = await reader(a.id); const second = await reader(a.id);
    await db.membership.create({ data: { userId: user.id, companyId: b.id, role: 'viewer' } });
    const foreign = await db.historicalClassificationObservation.findFirstOrThrow({ where: { companyId: b.id } });
    await expect(reads().getHistoricalObservation(user.id, a.id, foreign.id)).rejects.toMatchObject({ code: 'OBSERVATION_NOT_FOUND' });
    const first = await reads().listPastDecisions(user.id, a.id, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor!;
    for (const [readerId, tenantId, options] of [
      [second.id, a.id, { limit: 1, cursor }], [user.id, b.id, { limit: 1, cursor }],
      [user.id, a.id, { limit: 2, cursor }], [user.id, a.id, { limit: 1, cursor, kind: 'historical_observation' }],
    ] as const) {
      await expect(reads().listPastDecisions(readerId, tenantId, options)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    await db.membership.delete({ where: { userId_companyId: { userId: user.id, companyId: a.id } } });
    await expect(reads().listPastDecisions(user.id, a.id, { limit: 1, cursor })).rejects.toMatchObject({ code: 'COMPANY_NOT_FOUND' });
    await expect(reads().getHistoricalObservation(user.id, a.id, first.items[0]!.id)).rejects.toMatchObject({ code: 'COMPANY_NOT_FOUND' });
    const admin = await reader(a.id, true);
    expect((await reads().listPastDecisions(admin.id, a.id)).items).toHaveLength(2);
  });

  it('paginates tied timestamps without duplicates and rejects changed corpus snapshots', async () => {
    const tenant = await company('Stable pagination'); const user = await reader(tenant.id);
    await transaction(tenant.id); await transaction(tenant.id); await transaction(tenant.id);
    await backfill(tenant.id);
    const first = await reads().listPastDecisions(user.id, tenant.id, { limit: 1 });
    const second = await reads().listPastDecisions(user.id, tenant.id, { limit: 1, cursor: first.nextCursor! });
    const third = await reads().listPastDecisions(user.id, tenant.id, { limit: 1, cursor: second.nextCursor! });
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)).size).toBe(3);
    expect(third.nextCursor).toBeNull();
    await transaction(tenant.id); await backfill(tenant.id);
    await expect(reads().listPastDecisions(user.id, tenant.id, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it.each(['revision', 'sync-token', 'status'] as const)('rejects a source %s change between selection and atomic insertion', async (change) => {
    const tenant = await company('Concurrent source change'); const source = await transaction(tenant.id);
    let first = true;
    const adapter = {
      transaction: db.transaction, historicalClassificationObservation: db.historicalClassificationObservation,
      $transaction: db.$transaction.bind(db),
      $queryRaw: async (query: Prisma.Sql) => {
        const rows = await db.$queryRaw(query);
        if (first) { first = false; await db.transaction.update({ where: { id: source.id }, data:
          change === 'revision' ? { revision: { increment: 1 } } : change === 'sync-token' ? { qboSyncToken: '4' } : { status: 'PENDING' },
        }); }
        return rows;
      },
    } as unknown as HistoricalObservationDb;
    expect(await backfill(tenant.id, false, adapter)).toMatchObject({ eligible: 0, inserted: 0 });
    expect(await db.historicalClassificationObservation.count({ where: { companyId: tenant.id } })).toBe(0);
  });

  async function verifiedCase(tenant: Awaited<ReturnType<typeof company>>, source: Awaited<ReturnType<typeof transaction>>, user: Awaited<ReturnType<typeof reader>>, verifiedAt?: Date) {
    const attempt = await db.qboMutationAttempt.create({ data: {
      transactionId: source.id, requestId: `synthetic-${randomUUID()}`, operation: 'recategorize', status: 'VERIFIED',
      expectedRevision: source.revision, expectedSyncToken: source.qboSyncToken, requestHash: 'synthetic-request-hash',
      ...(verifiedAt === undefined ? {} : { updatedAt: verifiedAt }),
      requestPayload: {}, beforeSnapshot: {}, responseSnapshot: {}, verification: { outcome: 'VERIFIED', status: 'POSTED' },
    } });
    return recordVerifiedClassificationCase({
      companyId: tenant.id, transactionId: source.id, qboMutationAttemptId: attempt.id,
      action: { categoryQboId: 'synthetic-category', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      originIntent: 'apply_once', rationale: 'Synthetic verified evidence', requiredEvidence: [], examples: [], counterexamples: [], citations: [],
      reviewer: { userId: user.id, configVersion: 'synthetic-config', decision: 'approved' }, jurisdiction: 'unknown', currency: 'CAD',
      context: { transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: 'Synthetic bank', businessPurpose: null },
      provenance: { source: 'qbo_verified', sourceId: attempt.id, actorId: user.id, recordedAt: attempt.updatedAt.toISOString() },
    }, db);
  }

  it('persists deduplicated trimmed tag names without changing the source tags', async () => {
    const tenant = await company('Duplicate tag names'); const source = await transaction(tenant.id);
    const tags = await Promise.all(['Synthetic duplicate', ' Synthetic duplicate ', 'Synthetic duplicate'].map(name =>
      db.tag.create({ data: { companyId: tenant.id, name, color: '#112233' } })));
    await db.txnTag.createMany({ data: tags.map(tag => ({ txnId: source.id, tagId: tag.id })) });
    expect(await backfill(tenant.id)).toMatchObject({ inserted: 1 });
    const observation = await db.historicalClassificationObservation.findFirstOrThrow({ where: { companyId: tenant.id } });
    expect(observation.tagNames).toEqual(['Synthetic duplicate']);
    expect(await db.txnTag.count({ where: { txnId: source.id } })).toBe(3);
  });

  it('paginates both filtered SQL branches and retains immutable case transaction text', async () => {
    const tenant = await company('Filtered evidence'); const user = await reader(tenant.id);
    const a = await transaction(tenant.id); const b = await transaction(tenant.id);
    await backfill(tenant.id);
    const observation = await db.historicalClassificationObservation.findFirstOrThrow({ where: { companyId: tenant.id } });
    const verified = await verifiedCase(tenant, a, user, observation.observedAt); await verifiedCase(tenant, b, user, observation.observedAt);
    await db.transaction.update({ where: { id: a.id }, data: { payee: 'Later vendor', memo: 'Later memo', category: 'Later category', taxCode: 'Later tax' } });
    const combined = await reads().listPastDecisions(user.id, tenant.id);
    const paged: string[] = []; let cursor: string | undefined;
    do {
      const page = await reads().listPastDecisions(user.id, tenant.id, { limit: 1, cursor });
      paged.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(paged).toEqual(combined.items.map(item => item.id));
    expect(paged).toHaveLength(4);
    for (const kind of ['classification_case', 'historical_observation'] as const) {
      const first = await reads().listPastDecisions(user.id, tenant.id, { kind, limit: 1 });
      expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
      const second = await reads().listPastDecisions(user.id, tenant.id, { kind, limit: 1, cursor: first.nextCursor! });
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(2);
      expect([...first.items, ...second.items].every(item => item.kind === kind)).toBe(true);
      if (kind === 'classification_case') {
        expect([...first.items, ...second.items].find(item => item.id === verified.id)).toMatchObject({
          payee: a.payee, memo: a.memo, actionSummary: { categoryName: 'Category unavailable' },
        });
      }
    }
  });

  it('shows a verified superseding case without rewriting historical evidence', async () => {
    const tenant = await company('Verified supersession'); const source = await transaction(tenant.id);
    const user = await reader(tenant.id); await backfill(tenant.id);
    const observation = await db.historicalClassificationObservation.findFirstOrThrow({ where: { companyId: tenant.id } });
    const verified = await verifiedCase(tenant, source, user);
    await expect(db.historicalClassificationObservation.update({ where: { id: observation.id }, data: { memo: 'Synthetic attempted rewrite' } })).rejects.toThrow();
    const detail = await reads().getHistoricalObservation(user.id, tenant.id, observation.id);
    expect(detail).toMatchObject({ advisory: true, executable: false, supersededByCaseId: verified.id });
    expect(await db.historicalClassificationObservation.findUniqueOrThrow({ where: { id: observation.id } })).toEqual(observation);
    expect((await reads().getCurrentClassificationCase(user.id, tenant.id, source.id)).id).toBe(verified.id);
    expect((await reads().listPastDecisions(user.id, tenant.id)).items.map(item => item.kind).sort()).toEqual(['classification_case', 'historical_observation']);
    expect(await backfill(tenant.id)).toMatchObject({ inserted: 0, excluded: { already_verified_case: 1 } });
  });


  it('runs the real bounded CLI with explicit dry-run and apply, without provider credentials', async () => {
    const tenant = await company('CLI smoke'); await transaction(tenant.id);
    const cli = fileURLToPath(new URL('../../cli/backfillHistoricalClassificationObservations.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const invoke = (mode: string) => promisify(execFile)(process.execPath, [tsx, cli,
      '--company-id', tenant.id, '--start-date', '2026-06-01', '--end-date', '2026-06-30', mode, '--json',
    ], { env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL! }, timeout: 15_000 });
    expect(JSON.parse((await invoke('--dry-run')).stdout)).toMatchObject({ mode: 'dry_run', eligible: 1, inserted: 0 });
    expect(await db.historicalClassificationObservation.count({ where: { companyId: tenant.id } })).toBe(0);
    expect(JSON.parse((await invoke('--apply')).stdout)).toMatchObject({ mode: 'apply', inserted: 1 });
    expect(JSON.parse((await invoke('--apply')).stdout)).toMatchObject({ mode: 'apply', inserted: 0, existing: 1 });
  }, 30_000);

});
