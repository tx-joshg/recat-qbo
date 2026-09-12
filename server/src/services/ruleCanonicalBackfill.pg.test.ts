import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { backfillCanonicalRules } from './ruleCanonicalBackfill.js';
import { lockCompanyMutationScope } from './companyMutationScope.js';
import { setRuleEnabledInTransaction } from './rules.js';
import { createCompanyReadService, type CompanyReadDb } from './companyReads.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describePostgres('controlled canonical rule backfill', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    companyIds.clear();
  });

  afterAll(async () => { await db?.$disconnect(); });

  async function company(label: string, paused = true) {
    const suffix = randomUUID();
    const row = await db.company.create({ data: {
      realmId: `canonical-${label}-${suffix}`,
      legalName: `Canonical ${label}`,
      nickname: `Canonical ${label}`,
      ruleRuntimeMode: paused ? 'paused' : 'legacy',
      holdingAccountIds: ['holding-expense'],
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    } });
    companyIds.add(row.id);
    return row;
  }

  async function references(companyId: string) {
    await db.qboAccount.createMany({ data: [
      { companyId, qboId: 'expense', name: 'Meals', fullName: 'Expenses · Meals', classification: 'Expenses', active: true },
      { companyId, qboId: 'income', name: 'Sales', fullName: 'Income · Sales', classification: 'Income', active: true },
      { companyId, qboId: 'asset', name: 'Asset', fullName: 'Asset', classification: 'Asset', active: true },
      { companyId, qboId: 'holding-expense', name: 'Holding', fullName: 'Expenses · Holding', classification: 'Expenses', active: true },
    ] });
    await db.qboTaxRate.createMany({ data: [
      { companyId, qboId: 'purchase-rate', name: 'Purchase rate', rateValue: '5' },
      { companyId, qboId: 'sales-rate', name: 'Sales rate', rateValue: '5' },
    ] });
    await db.qboTaxCode.createMany({ data: [
      {
        companyId, qboId: 'purchase-tax', name: 'GST purchase', active: true,
        taxable: true,
        purchaseTaxRateList: [{ taxRateQboId: 'purchase-rate', taxTypeApplicable: 'TaxOnAmount' }],
        salesTaxRateList: [], combinedPurchaseRate: '5', combinedSalesRate: null,
      },
      {
        companyId, qboId: 'sales-tax', name: 'GST sales', active: true,
        taxable: true,
        purchaseTaxRateList: [],
        salesTaxRateList: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }],
        combinedPurchaseRate: null, combinedSalesRate: '5',
      },
    ] });
    return db.tag.create({ data: { companyId, name: 'Reviewed', color: '#123456' } });
  }

  async function rule(input: {
    companyId: string;
    id: string;
    matchText?: string;
    priority?: number;
    createdAt?: Date;
    categoryQboId?: string | null;
    category?: string;
    taxCalculation?: string | null;
    taxCodeQboId?: string | null;
    taxCode?: string | null;
    enabled?: boolean;
    autoPost?: boolean;
    retiredAt?: Date | null;
    reviewRequiredAt?: Date | null;
    tagIds?: string[];
  }) {
    return db.rule.create({ data: {
      id: input.id,
      companyId: input.companyId,
      matchText: input.matchText ?? input.id,
      priority: input.priority ?? 10,
      createdAt: input.createdAt,
      category: input.category ?? 'Meals',
      categoryQboId: input.categoryQboId === undefined ? 'expense' : input.categoryQboId,
      taxCalculation: input.taxCalculation === undefined ? 'NotApplicable' : input.taxCalculation,
      taxCodeQboId: input.taxCodeQboId ?? null,
      taxCode: input.taxCode ?? null,
      enabled: input.retiredAt ? false : (input.enabled ?? true),
      autoPost: input.retiredAt ? false : (input.autoPost ?? true),
      retiredAt: input.retiredAt ?? null,
      reviewRequiredAt: input.reviewRequiredAt ?? null,
      ruleTags: { create: (input.tagIds ?? []).map((tagId) => ({ tagId })) },
    } });
  }

  async function transaction(input: {
    companyId: string; id: string; payee: string; qboType?: string;
    status?: 'PENDING' | 'POSTED'; suggestion?: object | null;
  }) {
    return db.transaction.create({ data: {
      id: input.id,
      companyId: input.companyId,
      qboId: `qbo-${input.id}`,
      qboType: input.qboType ?? 'Purchase',
      qboSyncToken: '0',
      date: new Date('2026-05-01T00:00:00.000Z'),
      payee: input.payee,
      amount: '-10.00',
      bankAccount: 'Bank',
      status: input.status ?? 'PENDING',
      suggestion: input.suggestion ?? null,
    } });
  }

  it.each(['legacy', 'bridge', 'paused'] as const)('previews then atomically activates %s without hand-written SQL', async (mode) => {
    const target = await company(`activate-${mode}`, false);
    await db.company.update({ where: { id: target.id }, data: { ruleRuntimeMode: mode } });
    await references(target.id);
    const original = await rule({ companyId: target.id, id: `activate-${randomUUID()}` });
    const input = { companyId: target.id, actor: 'migration-test', activate: true };
    const preview = await backfillCanonicalRules({ ...input, apply: false }, db);
    expect(preview).toMatchObject({ wouldMigrateRules: 1, migratedRules: 0, activated: false, runtimeModeBefore: mode, runtimeModeAfter: mode });
    expect((await db.company.findUniqueOrThrow({ where: { id: target.id } })).ruleRuntimeMode).toBe(mode);
    expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(0);
    const applied = await backfillCanonicalRules({ ...input, apply: true }, db);
    expect(applied).toMatchObject({ migratedRules: 1, activated: true, runtimeModeBefore: mode, runtimeModeAfter: 'canonical' });
    expect((await db.company.findUniqueOrThrow({ where: { id: target.id } })).ruleRuntimeMode).toBe('canonical');
    expect((await db.rule.findUniqueOrThrow({ where: { id: original.id } })).canonicalVersion).toBe(2);
    expect(await backfillCanonicalRules({ ...input, apply: true }, db)).toMatchObject({ migratedRules: 0, activated: false, runtimeModeAfter: 'canonical' });
    expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(1);
  });

  it.each(['PREPARED', 'COMMITTING', 'UNCERTAIN'])('refuses activation while a %s write retains authority and preserves its exact envelope', async (status) => {
    const target = await company('activate-uncertain', false);
    const txn = await transaction({ companyId: target.id, id: `activate-${randomUUID()}`, payee: 'Synthetic supplier' });
    const attempt = await db.qboMutationAttempt.create({ data: {
      transactionId: txn.id, requestId: randomUUID(), operation: 'recategorize', status,
      expectedRevision: txn.revision, expectedSyncToken: txn.qboSyncToken, requestHash: 'a'.repeat(64),
      requestPayload: { stageHash: 'retained' }, beforeSnapshot: { retained: true },
    } });
    await expect(backfillCanonicalRules({ companyId: target.id, actor: 'migration-test', apply: true, activate: true }, db))
      .rejects.toThrow(/in-flight|active|drained/i);
    expect((await db.company.findUniqueOrThrow({ where: { id: target.id } })).ruleRuntimeMode).toBe('legacy');
    expect(await db.qboMutationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt);
  });

  it('rolls migrated rules back if the final mode transition fails', async () => {
    const target = await company('activation-final-failure', false);
    await references(target.id);
    await rule({ companyId: target.id, id: `activate-failure-${randomUUID()}` });
    const token = randomUUID().replaceAll('-', '');
    const name = `activation_failure_${token}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${target.id}' AND NEW."ruleRuntimeMode" = 'canonical' THEN
        RAISE EXCEPTION 'synthetic activation failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE UPDATE ON "Company" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
    try {
      await expect(backfillCanonicalRules({ companyId: target.id, actor: 'migration-test', apply: true, activate: true }, db))
        .rejects.toThrow(/synthetic activation failure/);
      expect((await db.company.findUniqueOrThrow({ where: { id: target.id } })).ruleRuntimeMode).toBe('legacy');
      expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(0);
      expect(await db.ruleCanonicalMigration.count({ where: { companyId: target.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "Company"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
  });

  it('keeps migrated retirement tombstones readable without enabling the retired rule', async () => {
    const target = await company('retirement-readback');
    const retiredAt = new Date('2026-01-01T00:00:00.000Z');
    await references(target.id);
    const retired = await rule({
      companyId: target.id, id: `retirement-readback-${randomUUID()}`, retiredAt,
      taxCalculation: 'TaxInclusive', taxCode: 'GST purchase', taxCodeQboId: 'purchase-tax',
    });
    const user = await db.user.create({ data: { email: `retirement-readback-${randomUUID()}@example.test` } });
    try {
      await db.membership.create({ data: { userId: user.id, companyId: target.id, role: 'categorizer' } });
      const report = await backfillCanonicalRules({ companyId: target.id, actor: 'readback-test', apply: true }, db);
      expect(report).toMatchObject({ migratedRules: 1, disabledRules: 1 });
      await db.company.update({ where: { id: target.id }, data: { ruleRuntimeMode: 'canonical' } });
      const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'retirement-readback-test-secret');
      const expected = {
        state: 'disabled', repairReason: expect.stringContaining('Retired rule requires reviewed reactivation'),
        revision: { ruleId: retired.id, state: 'disabled', direction: null, action: null, autoPost: false, valid: false },
      };
      await expect(reads.getRule(user.id, target.id, retired.id)).resolves.toMatchObject(expected);
      for (const state of ['all', 'disabled'] as const) {
        await expect(reads.listRules(user.id, target.id, { state })).resolves.toMatchObject({ items: [expected] });
      }
      await expect(reads.listRuleRevisions(user.id, target.id, retired.id)).resolves.toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({
          state: 'disabled', canonicalVersion: 2, retiredAt: retiredAt.toISOString(), autoPost: false,
        })]),
      });
      expect(await db.rule.findUnique({ where: { id: retired.id } })).toMatchObject({ enabled: false, retiredAt, autoPost: false });
    } finally {
      await db.membership.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it('requires a durable pause and leaves dry-run completely read-only', async () => {
    const target = await company('dry-run', false);
    await references(target.id);
    const existing = await rule({ companyId: target.id, id: 'dry-run-rule' });
    await transaction({
      companyId: target.id, id: 'dry-run-txn', payee: 'Dry run rule',
      suggestion: { source: 'rule', ruleId: existing.id },
    });
    await expect(backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: false,
    }, db)).rejects.toThrow(/paused/i);
    await db.company.update({ where: { id: target.id }, data: { ruleRuntimeMode: 'paused' } });
    await expect(backfillCanonicalRules({
      companyId: target.id, actor: '   ', apply: false,
    }, db)).rejects.toThrow(/actor/i);
    const operation = await db.mcpRuleOperation.create({ data: {
      authKind: 'session', sessionId: randomUUID(), userId: randomUUID(),
      companyId: target.id, resourceType: 'rule', resourceId: existing.id,
      mutation: 'update', idempotencyKey: randomUUID(), inputHash: 'a'.repeat(64),
      payload: {}, payloadHash: 'b'.repeat(64), sourceRevision: 0, proposedRevision: 1,
      proposedSnapshotHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 60_000),
    } });
    await expect(backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: false,
    }, db)).rejects.toThrow(/drained/i);
    await db.mcpRuleOperation.update({
      where: { id: operation.id },
      data: {
        committedAt: new Date(), commitResult: { status: 'test-drained' },
        commitResultHash: 'd'.repeat(64),
      },
    });

    const report = await backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: false,
    }, db);
    expect(report).toMatchObject({
      applied: false, examinedRules: 1, wouldMigrateRules: 1, migratedRules: 0,
      wouldClearRuleSuggestions: 1, clearedRuleSuggestions: 0,
      wouldAppendRevisions: 1, appendedRevisions: 0,
      wouldCreateMarkers: 1, createdMarkers: 0,
      proposals: [{
        ruleId: existing.id, sourceRevision: 0, canonicalRevision: 1,
        priority: 0, direction: 'Purchase', enabled: true, autoPost: true,
        repairReason: null,
      }],
    });
    expect(await db.rule.findUnique({ where: { id: existing.id } })).toMatchObject({
      revision: 0, canonicalVersion: null, priority: 10,
    });
    expect(await db.ruleCanonicalMigration.count({ where: { companyId: target.id } })).toBe(0);
    expect(await db.ruleRevision.count({ where: { companyId: target.id, ruleId: existing.id } })).toBe(1);
    expect((await db.transaction.findUnique({ where: { id: 'dry-run-txn' } }))?.suggestion).not.toBeNull();
  });

  it('migrates the complete matrix once, retains tombstones, and clears only pending rule suggestions', async () => {
    const target = await company('matrix');
    const tag = await references(target.id);
    const other = await company('matrix-other');
    const foreignTag = await db.tag.create({ data: { companyId: other.id, name: 'Foreign', color: '#654321' } });
    const tieTime = new Date('2026-04-01T00:00:00.000Z');
    await rule({ companyId: target.id, id: 'a-purchase', priority: 5, createdAt: tieTime, tagIds: [tag.id] });
    await rule({
      companyId: target.id, id: 'b-deposit', priority: 5, createdAt: tieTime,
      category: 'Sales', categoryQboId: 'income', taxCalculation: 'TaxInclusive',
      taxCode: 'GST sales', taxCodeQboId: 'sales-tax',
    });
    await rule({ companyId: target.id, id: 'disabled', priority: 9, enabled: false });
    await rule({
      companyId: target.id, id: 'retired', priority: 10,
      retiredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await rule({ companyId: target.id, id: 'invalid-category', priority: 11, categoryQboId: 'asset' });
    await rule({
      companyId: target.id, id: 'invalid-tax', priority: 12,
      taxCalculation: 'TaxExcluded', taxCode: 'GST sales', taxCodeQboId: 'sales-tax',
    });
    await rule({ companyId: target.id, id: 'invalid-tag', priority: 13, tagIds: [foreignTag.id] });
    await rule({
      companyId: target.id, id: 'review-held', priority: 14,
      reviewRequiredAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await rule({ companyId: target.id, id: 'journal vendor', priority: 15 });
    await transaction({ companyId: target.id, id: 'journal', payee: 'JOURNAL\tVENDOR payment', qboType: 'JournalEntry' });
    await transaction({ companyId: target.id, id: 'pending-rule', payee: 'x', suggestion: { source: 'rule', ruleId: 'a-purchase' } });
    await transaction({ companyId: target.id, id: 'pending-history', payee: 'x', suggestion: { source: 'history' } });
    await transaction({ companyId: target.id, id: 'pending-ai', payee: 'x', suggestion: { source: 'ai' } });
    await transaction({ companyId: target.id, id: 'posted-rule', payee: 'x', status: 'POSTED', suggestion: { source: 'rule' } });
    await transaction({ companyId: other.id, id: 'other-rule', payee: 'x', suggestion: { source: 'rule' } });
    const legacyAudit = await db.auditEntry.create({ data: {
      companyId: target.id, actorLabel: 'legacy-operator', payee: 'Legacy audit',
      amount: '0', action: 'legacy-rule-action', before: 'Before', after: 'After',
      payload: { preserved: true },
    } });
    const legacyRevisions = await db.ruleRevision.findMany({
      where: { companyId: target.id, revision: 0 }, orderBy: { ruleId: 'asc' },
    });

    const report = await backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    expect(report).toMatchObject({
      applied: true, examinedRules: 9, migratedRules: 9, alreadyMigratedRules: 0,
      disabledRules: 7, journalEntryHeldRules: 1,
      wouldClearRuleSuggestions: 1, clearedRuleSuggestions: 1,
    });
    const rows = await db.rule.findMany({ where: { companyId: target.id }, orderBy: { priority: 'asc' } });
    expect(rows.map((row) => row.priority)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(['a-purchase', 'b-deposit']);
    expect(rows.find((row) => row.id === 'a-purchase')).toMatchObject({
      direction: 'Purchase', enabled: true, autoPost: true, canonicalVersion: 2, revision: 1,
    });
    expect(rows.find((row) => row.id === 'b-deposit')).toMatchObject({
      direction: 'Deposit', enabled: true, autoPost: true, canonicalVersion: 2, revision: 1,
    });
    expect(rows.find((row) => row.id === 'disabled')).toMatchObject({ enabled: false, autoPost: false });
    const retired = rows.find((row) => row.id === 'retired')!;
    expect(retired).toMatchObject({ enabled: false, autoPost: false, direction: null });
    expect(retired.retiredAt).not.toBeNull();
    for (const id of ['invalid-category', 'invalid-tax', 'invalid-tag', 'review-held', 'journal vendor']) {
      const row = rows.find((candidate) => candidate.id === id)!;
      expect(row.enabled).toBe(false);
      expect(row.autoPost).toBe(false);
      expect(row.repairReason).not.toBeNull();
    }
    expect(rows.find((row) => row.id === 'journal vendor')?.affectedJournalEntryCount).toBe(1);
    expect(await db.ruleCanonicalMigration.count({ where: { companyId: target.id } })).toBe(9);
    expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(9);
    expect((await db.transaction.findUnique({ where: { id: 'pending-rule' } }))?.suggestion).toBeNull();
    expect((await db.transaction.findUnique({ where: { id: 'pending-history' } }))?.suggestion).not.toBeNull();
    expect((await db.transaction.findUnique({ where: { id: 'pending-ai' } }))?.suggestion).not.toBeNull();
    expect((await db.transaction.findUnique({ where: { id: 'posted-rule' } }))?.suggestion).not.toBeNull();
    expect((await db.transaction.findUnique({ where: { id: 'other-rule' } }))?.suggestion).not.toBeNull();
    expect(await db.ruleRevision.findMany({
      where: { id: { in: legacyRevisions.map(({ id }) => id) } }, orderBy: { ruleId: 'asc' },
    })).toEqual(legacyRevisions);
    expect(await db.auditEntry.findUnique({ where: { id: legacyAudit.id } })).toEqual(legacyAudit);

    await expect(db.$transaction((tx) => setRuleEnabledInTransaction(
      tx, target.id, retired.id, retired.revision, true, { id: 'test', label: 'test' },
    ))).rejects.toThrow(/not found/i);
    const rerun = await backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    expect(rerun).toMatchObject({
      migratedRules: 0, alreadyMigratedRules: 9,
      wouldClearRuleSuggestions: 0, clearedRuleSuggestions: 0,
    });
    expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(9);
  });

  it('fails closed on partial markers without changing another rule', async () => {
    const target = await company('partial');
    await references(target.id);
    const first = await rule({ companyId: target.id, id: 'partial-first' });
    const second = await rule({ companyId: target.id, id: 'partial-second' });
    await db.ruleCanonicalMigration.create({ data: {
      companyId: target.id, ruleId: first.id, canonicalVersion: 2,
      sourceRevision: 0, canonicalRevision: 1,
    } });
    await expect(backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db)).rejects.toThrow(/partially migrated/i);
    expect(await db.rule.findUnique({ where: { id: second.id } })).toMatchObject({
      revision: 0, canonicalVersion: null,
    });
  });

  it('fails closed when a marker or live pointer lacks matching immutable history', async () => {
    const target = await company('pointer');
    await references(target.id);
    const existing = await rule({ companyId: target.id, id: 'pointer-rule' });
    await backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    await db.rule.update({
      where: { id: existing.id },
      data: { revision: 2, matchText: 'unexpected live mutation' },
    });
    await expect(backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: false,
    }, db)).rejects.toThrow(/history.*live rule pointer/i);
  });

  it('waits behind the company fence and observes the preceding committed rule', async () => {
    const target = await company('fence');
    await references(target.id);
    const started = deferred();
    const release = deferred();
    const blockingWrite = db.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, target.id);
      await tx.rule.create({ data: {
        id: 'fenced-rule', companyId: target.id, matchText: 'Fenced rule',
        category: 'Meals', categoryQboId: 'expense', taxCalculation: 'NotApplicable',
      } });
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const cutover = backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    const completedWhileBlocked = await Promise.race([
      cutover.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(completedWhileBlocked).toBe(false);
    release.resolve();
    await blockingWrite;
    await expect(cutover).resolves.toMatchObject({
      examinedRules: 1, migratedRules: 1, createdMarkers: 1,
      proposals: [{ ruleId: 'fenced-rule' }],
    });
  });

  it('retries behind an unfenced Journal Entry insert and holds the exposed rule disabled', async () => {
    const target = await company('unfenced-journal');
    await references(target.id);
    await rule({ companyId: target.id, id: 'unfenced journal vendor' });
    const started = deferred();
    const release = deferred();
    const blockingWrite = db.$transaction(async (tx) => {
      await tx.transaction.create({ data: {
        id: 'unfenced-journal-txn', companyId: target.id,
        qboId: 'qbo-unfenced-journal', qboType: 'JournalEntry', qboSyncToken: '0',
        date: new Date('2026-05-01T00:00:00.000Z'),
        payee: 'UNFENCED\tJOURNAL VENDOR payment', amount: '-10.00', bankAccount: 'Bank',
      } });
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const cutover = backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    expect(await Promise.race([
      cutover.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).toBe(false);
    release.resolve();
    await blockingWrite;
    await expect(cutover).resolves.toMatchObject({
      journalEntryHeldRules: 1,
      proposals: [{ ruleId: 'unfenced journal vendor', enabled: false }],
    });
  });

  it('retries behind an unfenced reference update and sees the committed inactive category', async () => {
    const target = await company('unfenced-reference');
    await references(target.id);
    await rule({ companyId: target.id, id: 'unfenced-reference-rule' });
    const started = deferred();
    const release = deferred();
    const blockingWrite = db.$transaction(async (tx) => {
      await tx.qboAccount.update({
        where: { companyId_qboId: { companyId: target.id, qboId: 'expense' } },
        data: { active: false },
      });
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const cutover = backfillCanonicalRules({
      companyId: target.id, actor: 'migration-test', apply: true,
    }, db);
    expect(await Promise.race([
      cutover.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).toBe(false);
    release.resolve();
    await blockingWrite;
    await expect(cutover).resolves.toMatchObject({
      disabledRules: 1,
      proposals: [{
        ruleId: 'unfenced-reference-rule', enabled: false,
        repairReason: expect.stringMatching(/category/i),
      }],
    });
  });

  it('rolls the whole company back when a later rule write fails', async () => {
    const target = await company('atomic', false);
    await references(target.id);
    await rule({ companyId: target.id, id: 'atomic-first', priority: 1 });
    await rule({ companyId: target.id, id: 'atomic-second', priority: 2 });
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `fail_canonical_${suffix}`;
    const triggerName = `fail_canonical_trigger_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."ruleId" = 'atomic-second' AND NEW."canonicalVersion" = 2 THEN
          UPDATE "Rule" SET "revision" = "revision" + 1 WHERE "id" = NEW."ruleId";
        END IF;
        RETURN NEW;
      END $$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "RuleCanonicalMigration"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      await expect(backfillCanonicalRules({
        companyId: target.id, actor: 'migration-test', apply: true, activate: true,
      }, db)).rejects.toThrow(/CAS failed/i);
      expect((await db.company.findUniqueOrThrow({ where: { id: target.id } })).ruleRuntimeMode).toBe('legacy');
      expect(await db.ruleCanonicalMigration.count({ where: { companyId: target.id } })).toBe(0);
      expect(await db.ruleRevision.count({ where: { companyId: target.id, canonicalVersion: 2 } })).toBe(0);
      expect(await db.rule.count({ where: { companyId: target.id, canonicalVersion: null, revision: 0 } })).toBe(2);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "RuleCanonicalMigration"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });
});
