import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TaxReferenceDeps } from './tax/reference.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { disableRuleForSafetyInTransaction } from './ruleSafetyTransition.js';
import { replaceAccountReferenceCache } from './sync.js';
import { refreshTaxReference } from './tax/reference.js';
import {
  retireRuleInTransaction,
  reviewRuleInTransaction,
  updateRuleInTransaction,
} from './rules.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule reference drift safety', () => {
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

  afterAll(async () => { await db?.$disconnect(); });

  async function company(label: string) {
    const suffix = randomUUID();
    const row = await db.company.create({ data: {
      realmId: `reference-drift-${label}-${suffix}`,
      legalName: `Reference drift ${label}`,
      nickname: `drift-${suffix.slice(0, 8)}`,
      ruleRuntimeMode: 'canonical',
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    } });
    companyIds.add(row.id);
    return row;
  }

  async function rule(input: {
    companyId: string;
    id: string;
    direction?: 'Purchase' | 'Deposit';
    categoryQboId?: string;
    taxCalculation?: string;
    taxCodeQboId?: string | null;
    tagIds?: string[];
  }) {
    const direction = input.direction ?? 'Purchase';
    return db.rule.create({ data: {
      id: input.id,
      companyId: input.companyId,
      matchText: input.id,
      category: direction === 'Purchase' ? 'Meals' : 'Sales',
      categoryQboId: input.categoryQboId ?? (direction === 'Purchase' ? 'expense' : 'income'),
      taxCalculation: input.taxCalculation ?? 'NotApplicable',
      taxCode: input.taxCodeQboId ? `Tax ${input.taxCodeQboId}` : null,
      taxCodeQboId: input.taxCodeQboId ?? null,
      direction,
      canonicalVersion: 1,
      enabled: true,
      autoPost: true,
      ruleTags: { create: (input.tagIds ?? []).map((tagId) => ({ tagId })) },
    } });
  }

  async function suggestedTransaction(companyId: string, ruleId: string) {
    return db.transaction.create({ data: {
      companyId,
      qboId: `qbo-${randomUUID()}`,
      qboType: 'Purchase',
      qboSyncToken: '0',
      date: new Date('2026-09-01T00:00:00.000Z'),
      payee: ruleId,
      amount: '-10.00',
      bankAccount: 'Bank',
      suggestion: { source: 'rule', ruleId, category: 'Stale category' },
    } });
  }

  it('serializes repeated category drift and writes exactly one fail-closed transition', async () => {
    const target = await company('category');
    await db.qboAccount.create({ data: {
      companyId: target.id, qboId: 'removed', name: 'Removed', fullName: 'Removed',
      classification: 'Expenses', active: true,
    } });
    const affected = await rule({ companyId: target.id, id: `category-${randomUUID()}`, categoryQboId: 'removed' });
    const pending = await suggestedTransaction(target.id, affected.id);
    const replacement = [{
      qboId: 'current', name: 'Current', fullName: 'Expenses:Current',
      classification: 'Expenses', accountType: 'Expense', active: true,
    }];

    await Promise.all([
      replaceAccountReferenceCache(target.id, replacement, db),
      replaceAccountReferenceCache(target.id, replacement, db),
    ]);

    await expect(db.rule.findUniqueOrThrow({ where: { id: affected.id } })).resolves.toMatchObject({
      enabled: false,
      autoPost: false,
      revision: 1,
      reviewReason: expect.stringContaining('removed'),
      repairReason: expect.stringContaining('removed'),
    });
    await expect(db.qboAccount.findUniqueOrThrow({
      where: { companyId_qboId: { companyId: target.id, qboId: 'removed' } },
    })).resolves.toMatchObject({ active: false });
    await expect(db.transaction.findUniqueOrThrow({ where: { id: pending.id } }))
      .resolves.toMatchObject({ suggestion: null });
    await expect(db.ruleRevision.count({
      where: { companyId: target.id, ruleId: affected.id, revision: 1 },
    }))
      .resolves.toBe(1);
    await expect(db.auditEntry.count({
      where: { companyId: target.id, action: 'rule-disabled-for-safety' },
    })).resolves.toBe(1);
    await expect(db.qboMutationAttempt.count({ where: { transactionId: pending.id } })).resolves.toBe(0);

    // Even an identical idempotent retry reasserts the no-suggestion invariant
    // without appending another rule revision or audit event.
    await db.transaction.update({
      where: { id: pending.id },
      data: { suggestion: { source: 'rule', ruleId: affected.id, category: 'Stale again' } },
    });
    const retry = await runCompanyMutationTransaction(db, target.id, (tx) =>
      disableRuleForSafetyInTransaction(tx, {
        companyId: target.id,
        ruleId: affected.id,
        expectedRevision: 0,
        reason: 'Category reference removed is unavailable for this rule direction.',
        actor: 'system:account-reference-refresh',
      }));
    expect(retry).toEqual({ changed: false, revision: 1 });
    await expect(db.transaction.findUniqueOrThrow({ where: { id: pending.id } }))
      .resolves.toMatchObject({ suggestion: null });
    await expect(db.ruleRevision.count({
      where: { companyId: target.id, ruleId: affected.id, revision: 1 },
    })).resolves.toBe(1);
    await expect(db.auditEntry.count({
      where: { companyId: target.id, action: 'rule-disabled-for-safety' },
    })).resolves.toBe(1);
  });

  it('preserves a deleted tag identifier in the immutable disabled revision', async () => {
    const target = await company('tag');
    await db.qboAccount.create({ data: {
      companyId: target.id, qboId: 'expense', name: 'Meals', fullName: 'Expenses · Meals',
      classification: 'Expenses', active: true,
    } });
    const tag = await db.tag.create({ data: { companyId: target.id, name: 'Removed tag', color: '#123456' } });
    const secondTag = await db.tag.create({ data: {
      companyId: target.id, name: 'Second removed tag', color: '#abcdef',
    } });
    const affected = await rule({
      companyId: target.id,
      id: `tag-${randomUUID()}`,
      tagIds: [tag.id, secondTag.id],
    });

    await runCompanyMutationTransaction(db, target.id, async (tx) => {
      await disableRuleForSafetyInTransaction(tx, {
        companyId: target.id,
        ruleId: affected.id,
        expectedRevision: affected.revision,
        reason: `Rule tag ${tag.id} was deleted and requires reviewed repair.`,
        actor: 'system:tag-delete-test',
        preserveTagIds: [tag.id, secondTag.id],
      });
      await tx.tag.delete({ where: { id: tag.id } });
    });

    await expect(db.rule.findUniqueOrThrow({ where: { id: affected.id } })).resolves.toMatchObject({
      enabled: false, autoPost: false, revision: 1,
    });
    await expect(db.ruleTag.findMany({
      where: { ruleId: affected.id },
      select: { tagId: true },
    })).resolves.toEqual([{ tagId: secondTag.id }]);
    await expect(db.ruleRevision.findUniqueOrThrow({
      where: { companyId_ruleId_revision: { companyId: target.id, ruleId: affected.id, revision: 1 } },
    })).resolves.toMatchObject({ state: 'disabled', tagIds: [tag.id, secondTag.id].sort() });

    const edited = await runCompanyMutationTransaction(db, target.id, (tx) =>
      updateRuleInTransaction(
        tx,
        target.id,
        affected.id,
        1,
        { id: 'reviewer', label: 'Reviewer' },
        { matchText: 'Edited while held' },
      ));
    expect(edited).toMatchObject({ revision: 2, reviewRequiredAt: expect.any(Date) });
    await expect(db.ruleRevision.findUniqueOrThrow({
      where: { companyId_ruleId_revision: { companyId: target.id, ruleId: affected.id, revision: 2 } },
    })).resolves.toMatchObject({ state: 'disabled', tagIds: [tag.id, secondTag.id].sort() });

    const secondHold = await runCompanyMutationTransaction(db, target.id, (tx) =>
      disableRuleForSafetyInTransaction(tx, {
        companyId: target.id,
        ruleId: affected.id,
        expectedRevision: 2,
        reason: 'Later contradictory evidence also requires reviewed repair.',
        actor: 'system:contradiction-test',
      }));
    expect(secondHold).toEqual({ changed: true, revision: 3 });
    await expect(db.ruleRevision.findUniqueOrThrow({
      where: { companyId_ruleId_revision: { companyId: target.id, ruleId: affected.id, revision: 3 } },
    })).resolves.toMatchObject({ state: 'disabled', tagIds: [tag.id, secondTag.id].sort() });

    const secondTagHold = await runCompanyMutationTransaction(db, target.id, async (tx) => {
      const live = await tx.rule.findUniqueOrThrow({
        where: { id: affected.id },
        include: { ruleTags: true },
      });
      const result = await disableRuleForSafetyInTransaction(tx, {
        companyId: target.id,
        ruleId: affected.id,
        expectedRevision: 3,
        reason: `Rule tag ${secondTag.id} was deleted and requires reviewed repair.`,
        actor: 'system:second-tag-delete-test',
        preserveTagIds: live.ruleTags.map(({ tagId }) => tagId),
      });
      await tx.tag.delete({ where: { id: secondTag.id } });
      return result;
    });
    expect(secondTagHold).toEqual({ changed: true, revision: 4 });
    await expect(db.ruleRevision.findUniqueOrThrow({
      where: { companyId_ruleId_revision: { companyId: target.id, ruleId: affected.id, revision: 4 } },
    })).resolves.toMatchObject({ state: 'disabled', tagIds: [tag.id, secondTag.id].sort() });

    await expect(db.$transaction((tx) => reviewRuleInTransaction(
      tx, target.id, affected.id, 4,
      { id: 'reviewer', label: 'Reviewer' },
    ))).rejects.toThrow(/explicitly acknowledge/i);
    await expect(db.$transaction((tx) => reviewRuleInTransaction(
      tx, target.id, affected.id, 4,
      { id: 'reviewer', label: 'Reviewer' },
      { tagIds: [] },
      'Confirmed the deleted tag should be removed.',
    ))).resolves.toMatchObject({
      enabled: false, autoPost: false, revision: 5,
      reviewRequiredAt: null, repairReason: null, retiredAt: null,
    });
    await expect(db.auditEntry.findFirstOrThrow({
      where: { companyId: target.id, action: 'rule-reviewed' },
      orderBy: { at: 'desc' },
    })).resolves.toMatchObject({
      payload: expect.objectContaining({
        reason: 'Confirmed the deleted tag should be removed.',
      }),
    });
  });

  it('requires explicit tag acknowledgement when a retired rule loses a referenced tag', async () => {
    const target = await company('retired-tag');
    await db.qboAccount.create({ data: {
      companyId: target.id, qboId: 'expense', name: 'Meals', fullName: 'Expenses · Meals',
      classification: 'Expenses', active: true,
    } });
    const tag = await db.tag.create({ data: {
      companyId: target.id, name: 'Retired tag', color: '#654321',
    } });
    const affected = await rule({
      companyId: target.id,
      id: `retired-tag-${randomUUID()}`,
      tagIds: [tag.id],
    });
    const retired = await runCompanyMutationTransaction(db, target.id, (tx) =>
      retireRuleInTransaction(
        tx,
        target.id,
        affected.id,
        affected.revision,
        { id: 'reviewer', label: 'Reviewer' },
      ));
    await db.tag.delete({ where: { id: tag.id } });

    await expect(db.$transaction((tx) => reviewRuleInTransaction(
      tx, target.id, affected.id, retired.revision,
      { id: 'reviewer', label: 'Reviewer' },
    ))).rejects.toThrow(/explicitly acknowledge/i);
    await expect(db.$transaction((tx) => reviewRuleInTransaction(
      tx, target.id, affected.id, retired.revision,
      { id: 'reviewer', label: 'Reviewer' },
      { tagIds: [] },
      'Confirmed the retired rule no longer needs the deleted tag.',
    ))).resolves.toMatchObject({
      enabled: false, autoPost: false, retiredAt: null, revision: retired.revision + 1,
    });
  });

  it('disables purchase and deposit rules when their directional tax codes become inactive', async () => {
    const target = await company('tax');
    const purchase = await rule({
      companyId: target.id, id: `purchase-${randomUUID()}`, direction: 'Purchase',
      taxCalculation: 'TaxInclusive', taxCodeQboId: 'purchase-tax',
    });
    const deposit = await rule({
      companyId: target.id, id: `deposit-${randomUUID()}`, direction: 'Deposit',
      taxCalculation: 'TaxExcluded', taxCodeQboId: 'sales-tax',
    });
    const nonTaxable = await rule({
      companyId: target.id, id: `non-taxable-${randomUUID()}`, direction: 'Purchase',
      taxCalculation: 'TaxInclusive', taxCodeQboId: 'non-taxable',
    });
    const rates = [
      { qboId: 'purchase-rate', name: 'Purchase 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'sales-rate', name: 'Sales 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
    ];
    const codes = [
      {
        qboId: 'purchase-tax', name: 'Purchase tax', description: null, active: false, taxable: true,
        purchaseRates: [{ taxRateQboId: 'purchase-rate', taxTypeApplicable: 'TaxOnAmount' }],
        salesRates: [], sourceUpdatedAt: null,
      },
      {
        qboId: 'sales-tax', name: 'Sales tax', description: null, active: false, taxable: true,
        purchaseRates: [],
        salesRates: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'non-taxable', name: 'No tax', description: null, active: true, taxable: false,
        purchaseRates: [], salesRates: [], sourceUpdatedAt: null,
      },
    ];
    const deps: TaxReferenceDeps = {
      db: db as unknown as TaxReferenceDeps['db'],
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      getClient: async () => ({
        getTaxProfile: async () => ({ usingSalesTax: true, partnerTaxEnabled: false }),
        listTaxCodes: async () => codes,
        listTaxRates: async () => rates,
      }),
    };

    await refreshTaxReference(target.id, { force: true }, deps);

    for (const affected of [purchase, deposit, nonTaxable]) {
      await expect(db.rule.findUniqueOrThrow({ where: { id: affected.id } })).resolves.toMatchObject({
        enabled: false, autoPost: false, revision: 1,
      });
      await expect(db.ruleRevision.count({
        where: { companyId: target.id, ruleId: affected.id, revision: 1 },
      }))
        .resolves.toBe(1);
    }
    await expect(db.auditEntry.count({
      where: { companyId: target.id, action: 'rule-disabled-for-safety' },
    })).resolves.toBe(3);
  });

  it('disables taxable rules when malformed provider references abort the refresh', async () => {
    const target = await company('tax-failure');
    const affected = await rule({
      companyId: target.id, id: `tax-failure-${randomUUID()}`, direction: 'Purchase',
      taxCalculation: 'TaxInclusive', taxCodeQboId: 'broken-tax',
    });
    const deps: TaxReferenceDeps = {
      db: db as unknown as TaxReferenceDeps['db'],
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      getClient: async () => ({
        getTaxProfile: async () => ({ usingSalesTax: true, partnerTaxEnabled: false }),
        listTaxCodes: async () => [{
          qboId: 'broken-tax', name: 'Broken tax', description: null, active: true, taxable: true,
          purchaseRates: [{ taxRateQboId: 'missing-rate', taxTypeApplicable: 'TaxOnAmount' }],
          salesRates: [], sourceUpdatedAt: null,
        }],
        listTaxRates: async () => [],
      }),
    };

    await expect(refreshTaxReference(target.id, { force: true }, deps))
      .rejects.toThrow(/unknown tax rate/i);
    await expect(db.rule.findUniqueOrThrow({ where: { id: affected.id } })).resolves.toMatchObject({
      enabled: false, autoPost: false, revision: 1,
      repairReason: expect.stringContaining('refresh failed'),
    });
    await expect(db.company.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({
      taxSupportStatus: 'needs_setup',
      taxSupportReason: 'Tax reference refresh failed.',
    });
  });

  it('disables taxable rules when the QBO tax profile is disabled despite usable cached metadata', async () => {
    const target = await company('tax-profile');
    const affected = await rule({
      companyId: target.id, id: `tax-profile-${randomUUID()}`, direction: 'Purchase',
      taxCalculation: 'TaxInclusive', taxCodeQboId: 'purchase-tax',
    });
    const deps: TaxReferenceDeps = {
      db: db as unknown as TaxReferenceDeps['db'],
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      getClient: async () => ({
        getTaxProfile: async () => ({ usingSalesTax: false, partnerTaxEnabled: false }),
        listTaxCodes: async () => [{
          qboId: 'purchase-tax', name: 'Purchase tax', description: null, active: true, taxable: true,
          purchaseRates: [{ taxRateQboId: 'purchase-rate', taxTypeApplicable: 'TaxOnAmount' }],
          salesRates: [], sourceUpdatedAt: null,
        }],
        listTaxRates: async () => [{
          qboId: 'purchase-rate', name: 'Purchase 5%', description: null, active: true,
          rateValue: 5, sourceUpdatedAt: null,
        }],
      }),
    };

    await refreshTaxReference(target.id, { force: true }, deps);
    await expect(db.rule.findUniqueOrThrow({ where: { id: affected.id } })).resolves.toMatchObject({
      enabled: false, autoPost: false, revision: 1,
      repairReason: expect.stringContaining('purchase-tax'),
    });
  });
});
