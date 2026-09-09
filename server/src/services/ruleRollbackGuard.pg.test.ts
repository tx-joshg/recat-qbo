import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { backfillCanonicalRules } from './ruleCanonicalBackfill.js';
import { lockCompanyMutationScope } from './companyMutationScope.js';
import { prepareRuleRollback } from './ruleRollbackGuard.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describePostgres('canonical rule rollback guard', () => {
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

  async function preparedCompany() {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `rollback-${suffix}`, legalName: 'Rollback', nickname: 'Rollback',
      ruleRuntimeMode: 'paused', taxSupportStatus: 'ready', taxUsingSalesTax: true,
    } });
    companyIds.add(company.id);
    await db.qboAccount.createMany({ data: [
      { companyId: company.id, qboId: 'expense', name: 'Meals', fullName: 'Expenses · Meals', classification: 'Expenses' },
      { companyId: company.id, qboId: 'income', name: 'Sales', fullName: 'Income · Sales', classification: 'Income' },
    ] });
    await db.qboTaxRate.createMany({ data: [
      { companyId: company.id, qboId: 'purchase-rate', name: 'Purchase rate', rateValue: '5' },
      { companyId: company.id, qboId: 'sales-rate', name: 'Sales rate', rateValue: '5' },
    ] });
    await db.qboTaxCode.createMany({ data: [
      { companyId: company.id, qboId: 'purchase-tax', name: 'Purchase tax', taxable: true, purchaseTaxRateList: [{ taxRateQboId: 'purchase-rate', taxTypeApplicable: 'TaxOnAmount' }], salesTaxRateList: [], combinedPurchaseRate: '5' },
      { companyId: company.id, qboId: 'sales-tax', name: 'Sales tax', taxable: true, purchaseTaxRateList: [], salesTaxRateList: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }], combinedSalesRate: '5' },
    ] });
    await db.rule.createMany({ data: [
      {
        id: `purchase-${suffix}`, companyId: company.id, matchText: 'Purchase vendor',
        category: 'Meals', categoryQboId: 'expense', taxCalculation: 'TaxInclusive',
        taxCode: 'Purchase tax', taxCodeQboId: 'purchase-tax', autoPost: true,
      },
      {
        id: `deposit-${suffix}`, companyId: company.id, matchText: 'Deposit vendor',
        category: 'Sales', categoryQboId: 'income', taxCalculation: 'TaxExcluded',
        taxCode: 'Sales tax', taxCodeQboId: 'sales-tax', autoPost: true, priority: 1,
      },
      {
        id: `retired-${suffix}`, companyId: company.id, matchText: 'Retired vendor',
        category: 'Meals', categoryQboId: 'expense', taxCalculation: 'NotApplicable',
        retiredAt: new Date('2026-01-01T00:00:00.000Z'), enabled: false, autoPost: false, priority: 2,
      },
    ] });
    await backfillCanonicalRules({ companyId: company.id, actor: 'migration-test', apply: true }, db);
    await db.transaction.create({ data: {
      companyId: company.id, qboId: `rollback-qbo-${suffix}`, qboType: 'Purchase', qboSyncToken: '0',
      date: new Date('2026-05-01T00:00:00.000Z'), payee: 'Purchase vendor', amount: '-10', bankAccount: 'Bank',
      suggestion: { source: 'rule', ruleId: `purchase-${suffix}` },
    } });
    return company;
  }

  it('is paused-only, dry-run safe, atomic, and idempotent', async () => {
    const company = await preparedCompany();
    const before = await db.rule.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } });
    await db.company.update({ where: { id: company.id }, data: { ruleRuntimeMode: 'bridge' } });
    await expect(prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test', apply: false,
    }, db)).rejects.toThrow(/paused/i);
    await db.company.update({ where: { id: company.id }, data: { ruleRuntimeMode: 'paused' } });
    await expect(prepareRuleRollback({
      companyId: company.id, actor: '   ', apply: false,
    }, db)).rejects.toThrow(/actor/i);
    const dryRun = await prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test', apply: false,
    }, db);
    expect(dryRun).toMatchObject({
      applied: false, examinedCanonicalRules: 3, wouldDisableRules: 2,
      disabledRules: 0, wouldClearRuleSuggestions: 1, clearedRuleSuggestions: 0,
      revisionsAppended: 0, auditsAppended: 0,
    });
    expect(await db.rule.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } })).toEqual(before);

    const applied = await prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test', apply: true,
    }, db);
    expect(applied).toMatchObject({
      applied: true, disabledRules: 2, clearedRuleSuggestions: 1,
      revisionsAppended: 2, auditsAppended: 2,
    });
    const after = await db.rule.findMany({ where: { companyId: company.id } });
    expect(after.every((rule) => !rule.enabled && !rule.autoPost)).toBe(true);
    const retired = after.find((rule) => rule.id.startsWith('retired-'))!;
    expect(retired.retiredAt).not.toBeNull();
    expect(await db.ruleRevision.count({ where: {
      companyId: company.id, changedBy: 'rollback-test', state: 'disabled',
    } })).toBe(2);
    expect(await db.auditEntry.count({ where: {
      companyId: company.id, action: 'rule-rollback-guarded', actorLabel: 'rollback-test',
    } })).toBe(2);
    expect((await db.transaction.findFirst({ where: { companyId: company.id } }))?.suggestion).toBeNull();

    const rerun = await prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test', apply: true,
    }, db);
    expect(rerun).toMatchObject({
      wouldDisableRules: 0, disabledRules: 0, clearedRuleSuggestions: 0,
      revisionsAppended: 0, auditsAppended: 0,
    });
    expect(await db.auditEntry.count({ where: { companyId: company.id, action: 'rule-rollback-guarded' } })).toBe(2);
  });

  it('rejects uncommitted rule operations and every active auto-post preparation state', async () => {
    const company = await preparedCompany();
    const rule = await db.rule.findFirstOrThrow({ where: { companyId: company.id, retiredAt: null } });
    const txn = await db.transaction.findFirstOrThrow({ where: { companyId: company.id } });
    const operation = await db.mcpRuleOperation.create({ data: {
      authKind: 'session', sessionId: randomUUID(), userId: randomUUID(),
      companyId: company.id, resourceType: 'rule', resourceId: rule.id,
      mutation: 'enable', idempotencyKey: randomUUID(), inputHash: 'a'.repeat(64),
      payload: {}, payloadHash: 'b'.repeat(64), sourceRevision: rule.revision,
      proposedRevision: rule.revision + 1, proposedSnapshotHash: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    } });
    await expect(prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test', apply: true,
    }, db)).rejects.toThrow(/drained/i);
    await db.mcpRuleOperation.update({ where: { id: operation.id }, data: {
      committedAt: new Date(), commitResult: { status: 'test-drained' },
      commitResultHash: 'd'.repeat(64),
    } });

    for (const state of ['PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE'] as const) {
      const createdAt = new Date(Date.now() - 1_000);
      const startedAt = state === 'COMMITTING' || state === 'UNCERTAIN' ? new Date() : null;
      const preparation = await db.ruleAutoPostPreparation.create({ data: {
        companyId: company.id, transactionId: txn.id, ruleId: rule.id,
        ruleRevision: rule.revision, inputHash: 'e'.repeat(64), proposal: {},
        proposalHash: 'f'.repeat(64), stagedGraphHash: '1'.repeat(64),
        sourceRevision: txn.revision, preparedRevision: txn.revision + 1,
        qboType: txn.qboType, qboId: txn.qboId, qboSyncToken: txn.qboSyncToken,
        requestId: randomUUID(), state, createdAt, commitStartedAt: startedAt,
      } });
      await expect(prepareRuleRollback({
        companyId: company.id, actor: 'rollback-test', apply: true,
      }, db)).rejects.toThrow(/drained/i);
      await db.ruleAutoPostPreparation.update({ where: { id: preparation.id }, data: {
        state: state === 'PREPARED' || state === 'RETRYABLE' ? 'CANCELLED' : 'REJECTED',
        completedAt: new Date(),
      } });
    }
  });

  it('waits behind the company fence and disables the preceding committed enable', async () => {
    const company = await preparedCompany();
    await prepareRuleRollback({ companyId: company.id, actor: 'rollback-test', apply: true }, db);
    const rule = await db.rule.findFirstOrThrow({ where: { companyId: company.id, retiredAt: null } });
    const started = deferred();
    const release = deferred();
    const blockingWrite = db.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, company.id);
      await tx.rule.update({ where: { id: rule.id }, data: { enabled: true } });
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const guard = prepareRuleRollback({
      companyId: company.id, actor: 'rollback-test-2', apply: true,
    }, db);
    const completedWhileBlocked = await Promise.race([
      guard.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(completedWhileBlocked).toBe(false);
    release.resolve();
    await blockingWrite;
    await expect(guard).resolves.toMatchObject({ disabledRules: 1, revisionsAppended: 1 });
    await expect(db.rule.findUniqueOrThrow({ where: { id: rule.id } })).resolves.toMatchObject({
      enabled: false, autoPost: false,
    });
  });

  it('rolls every guard write back when a later audit append fails', async () => {
    const company = await preparedCompany();
    const beforeRules = await db.rule.findMany({
      where: { companyId: company.id }, orderBy: { id: 'asc' },
    });
    const beforeSuggestion = (await db.transaction.findFirstOrThrow({
      where: { companyId: company.id },
    })).suggestion;
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `fail_rollback_${suffix}`;
    const triggerName = `fail_rollback_trigger_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."actorLabel" = 'atomic-rollback' AND EXISTS (
          SELECT 1 FROM "AuditEntry"
           WHERE "companyId" = NEW."companyId" AND "actorLabel" = NEW."actorLabel"
        ) THEN
          RAISE EXCEPTION 'forced rollback audit failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "AuditEntry"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      await expect(prepareRuleRollback({
        companyId: company.id, actor: 'atomic-rollback', apply: true,
      }, db)).rejects.toThrow(/forced rollback audit failure/i);
      expect(await db.rule.findMany({
        where: { companyId: company.id }, orderBy: { id: 'asc' },
      })).toEqual(beforeRules);
      expect((await db.transaction.findFirstOrThrow({
        where: { companyId: company.id },
      })).suggestion).toEqual(beforeSuggestion);
      expect(await db.auditEntry.count({
        where: { companyId: company.id, actorLabel: 'atomic-rollback' },
      })).toBe(0);
      expect(await db.ruleRevision.count({
        where: { companyId: company.id, changedBy: 'atomic-rollback' },
      })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AuditEntry"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });
});
