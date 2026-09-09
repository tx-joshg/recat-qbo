import { describe, expect, it, vi } from 'vitest';
import {
  nextRulePriorityInTransaction,
  resolveRuleAction,
  reviewRuleInTransaction,
  setRuleEnabledInTransaction,
  updateRuleInTransaction,
} from './rules.js';

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1', companyId: 'company-1', priority: 0, matchField: 'payee',
    matchText: 'Vendor', category: 'Meals', categoryQboId: 'expense',
    taxCalculation: 'NotApplicable', taxCode: null, taxCodeQboId: null,
    autoPost: true, enabled: true, revision: 4, originIntent: null,
    sourceCaseId: null, sourceCandidateId: null, retiredAt: null,
    createdById: null, createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'), updatedById: null,
    reviewRequiredAt: null, reviewReason: null, direction: 'Purchase',
    canonicalVersion: 2, repairReason: null, affectedJournalEntryCount: 0,
    ruleTags: [], candidateOrigin: null,
    ...overrides,
  };
}

function mutationDb(
  current: ReturnType<typeof ruleRow>,
  safetyPayload: Record<string, unknown> | null = null,
) {
  const revisions: unknown[] = [];
  const audits: unknown[] = [];
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...current,
    ...data,
    revision: typeof data.revision === 'object' ? current.revision + 1 : data.revision,
    ruleTags: current.ruleTags,
  }));
  return {
    tx: {
      rule: { findFirst: vi.fn(async () => current), update },
      ruleTag: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      ruleRevision: {
        findUnique: vi.fn(async () => ({
          tagIds: safetyPayload?.preservedTagIds
            ?? current.ruleTags.map(({ tagId }: { tagId: string }) => tagId),
        })),
        create: vi.fn(async ({ data }: { data: unknown }) => { revisions.push(data); }),
      },
      auditEntry: {
        create: vi.fn(async ({ data }: { data: unknown }) => { audits.push(data); }),
      },
      qboAccount: { findFirst: vi.fn(async () => ({ name: 'Meals', classification: 'Expenses' })) },
      company: { findUniqueOrThrow: vi.fn(async () => ({ holdingAccountIds: [] })) },
      tag: { count: vi.fn(async () => current.ruleTags.length) },
    },
    update,
    revisions,
    audits,
  };
}

function taxDb(classification: string) {
  return {
    qboAccount: { findFirst: vi.fn(async () => ({ name: 'Category', classification })) },
    tag: { count: vi.fn(async () => 0) },
    company: { findUniqueOrThrow: vi.fn(async () => ({
      taxSupportStatus: 'ready', taxSupportReason: null, taxUsingSalesTax: true,
      taxReferenceRefreshedAt: new Date('2026-01-01T00:00:00Z'),
      holdingAccountIds: [],
    })) },
    qboTaxRate: { findMany: vi.fn(async () => [
      { qboId: 'purchase-rate', name: 'Purchase', active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'sales-rate', name: 'Sales', active: true, rateValue: 7, sourceUpdatedAt: null },
    ]) },
    qboTaxCode: { findMany: vi.fn(async () => [
      {
        qboId: 'purchase-tax', name: 'Purchase tax', active: true, taxable: true,
        description: null, purchaseTaxRateList: [{ taxRateQboId: 'purchase-rate', taxTypeApplicable: 'TaxOnAmount' }],
        salesTaxRateList: [], combinedPurchaseRate: 5, combinedSalesRate: null,
        sourceUpdatedAt: null,
      },
      {
        qboId: 'sales-tax', name: 'Sales tax', active: true, taxable: true,
        description: null, purchaseTaxRateList: [],
        salesTaxRateList: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }],
        combinedPurchaseRate: null, combinedSalesRate: 7, sourceUpdatedAt: null,
      },
    ]) },
  };
}

describe('two-state rule service', () => {
  it('validates category classification and tax readiness by direction', async () => {
    await expect(resolveRuleAction(taxDb('Income') as never, 'company-1', {
      direction: 'Deposit', categoryQboId: 'income', taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'sales-tax', tagIds: [],
    })).resolves.toMatchObject({ direction: 'Deposit', taxCodeName: 'Sales tax' });
    await expect(resolveRuleAction(taxDb('Income') as never, 'company-1', {
      direction: 'Purchase', categoryQboId: 'income', taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'purchase-tax', tagIds: [],
    })).rejects.toThrow(/direction/i);
    await expect(resolveRuleAction(taxDb('Expenses') as never, 'company-1', {
      direction: 'Purchase', categoryQboId: 'expense', taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'sales-tax', tagIds: [],
    })).rejects.toThrow(/tax reference/i);
    await expect(resolveRuleAction(taxDb('Expenses') as never, 'company-1', {
      direction: 'Transfer' as never, categoryQboId: 'expense',
      taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
    })).rejects.toThrow(/direction/i);

    const holdingDb = taxDb('Expenses');
    holdingDb.company.findUniqueOrThrow.mockResolvedValue({
      taxSupportStatus: 'ready', taxSupportReason: null, taxUsingSalesTax: true,
      taxReferenceRefreshedAt: new Date('2026-01-01T00:00:00Z'),
      holdingAccountIds: ['expense'],
    });
    await expect(resolveRuleAction(holdingDb as never, 'company-1', {
      direction: 'Purchase', categoryQboId: 'expense',
      taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
    })).rejects.toThrow(/Holding accounts/i);
  });

  it('allows No tax for either direction without loading tax readiness', async () => {
    const db = taxDb('Income');
    await expect(resolveRuleAction(db as never, 'company-1', {
      direction: 'Deposit', categoryQboId: 'income', taxCalculation: 'NotApplicable',
      taxCodeQboId: null, tagIds: [],
    })).resolves.toMatchObject({ direction: 'Deposit', taxCodeName: null });
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
    expect(db.qboTaxRate.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-taxable code for an explicitly taxable action', async () => {
    const db = taxDb('Expenses');
    db.qboTaxCode.findMany.mockResolvedValue([{
      qboId: 'non-taxable', name: 'No tax', active: true, taxable: false,
      description: null, purchaseTaxRateList: [], salesTaxRateList: [],
      combinedPurchaseRate: null, combinedSalesRate: null, sourceUpdatedAt: null,
    }]);
    await expect(resolveRuleAction(db as never, 'company-1', {
      direction: 'Purchase', categoryQboId: 'expense', taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'non-taxable', tagIds: [],
    })).rejects.toThrow(/tax reference/i);
  });

  it('disabling always turns auto-post off and appends one disabled revision', async () => {
    const current = ruleRow();
    const { tx, update, revisions, audits } = mutationDb(current);
    const result = await setRuleEnabledInTransaction(
      tx as never, current.companyId, current.id, current.revision, false,
      { id: 'user-1', label: 'Reviewer' },
    );
    expect(result).toMatchObject({ enabled: false, autoPost: false, revision: 5 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enabled: false, autoPost: false }),
    }));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ state: 'disabled', autoPost: false, direction: 'Purchase' });
    expect(audits).toHaveLength(1);
  });

  it('rejects enabling a review-held rule before any write', async () => {
    const current = ruleRow({ enabled: false, autoPost: false, reviewRequiredAt: new Date() });
    const { tx, update } = mutationDb(current);
    await expect(setRuleEnabledInTransaction(
      tx as never, current.companyId, current.id, current.revision, true,
      { id: 'user-1', label: 'Reviewer' },
    )).rejects.toThrow(/Review and save/i);
    expect(update).not.toHaveBeenCalled();

    const missingDirection = ruleRow({
      enabled: false, autoPost: false, direction: null,
      reviewRequiredAt: null, repairReason: null,
    });
    const missingDirectionDb = mutationDb(missingDirection);
    await expect(setRuleEnabledInTransaction(
      missingDirectionDb.tx as never,
      missingDirection.companyId,
      missingDirection.id,
      missingDirection.revision,
      true,
      { id: 'user-1', label: 'Reviewer' },
    )).rejects.toThrow(/Review and save/i);
    expect(missingDirectionDb.update).not.toHaveBeenCalled();
  });

  it.each(['update', 'review'] as const)('marks a validated %s action canonical for downstream matching', async (operation) => {
    const current = ruleRow({ enabled: false, autoPost: false, canonicalVersion: null });
    const { tx, revisions } = mutationDb(current);
    const actor = { id: 'user-1', label: 'Reviewer' };
    const result = operation === 'update'
      ? await updateRuleInTransaction(tx as never, current.companyId, current.id, current.revision,
        actor, { matchText: 'Updated vendor' })
      : await reviewRuleInTransaction(tx as never, current.companyId, current.id, current.revision, actor);
    expect(result).toMatchObject({ canonicalVersion: 2, direction: 'Purchase', enabled: false });
    expect(revisions).toEqual([expect.objectContaining({ canonicalVersion: 2, direction: 'Purchase' })]);
  });

  it('Review and save may be unchanged, clears hold and tombstone, and stays Disabled', async () => {
    const current = ruleRow({
      enabled: false, autoPost: false, retiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewRequiredAt: new Date('2026-02-01T00:00:00Z'), reviewReason: 'Needs review',
      repairReason: 'Retired rule requires reviewed reactivation.',
    });
    const { tx, revisions, audits } = mutationDb(current);
    const result = await reviewRuleInTransaction(
      tx as never, current.companyId, current.id, current.revision,
      { id: 'user-1', label: 'Reviewer' },
    );
    expect(result).toMatchObject({
      enabled: false, autoPost: false, retiredAt: null,
      reviewRequiredAt: null, reviewReason: null, repairReason: null, revision: 5,
    });
    expect(revisions).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ payload: expect.objectContaining({
      reason: 'Reviewed and saved.',
    }) });
  });

  it('requires explicit acknowledgement of a deleted tag before clearing its hold', async () => {
    const current = ruleRow({
      enabled: false, autoPost: false,
      reviewRequiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewReason: 'Tag deleted', repairReason: 'Tag deleted', ruleTags: [],
    });
    const { tx, update } = mutationDb(current, {
      ruleId: current.id,
      preservedTagIds: ['11111111-1111-4111-8111-111111111111'],
    });
    await expect(reviewRuleInTransaction(
      tx as never,
      current.companyId,
      current.id,
      current.revision,
      { id: 'user-1', label: 'Reviewer' },
    )).rejects.toThrow(/explicitly acknowledge/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('repairs an invalid retired action in the same reviewed revision', async () => {
    const current = ruleRow({
      enabled: false, autoPost: false, direction: null,
      categoryQboId: null, taxCalculation: null,
      retiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewRequiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewReason: 'Retired', repairReason: 'Retired rule requires reviewed repair.',
    });
    const { tx, revisions, audits } = mutationDb(current);
    await expect(reviewRuleInTransaction(
      tx as never,
      current.companyId,
      current.id,
      current.revision,
      { id: 'user-1', label: 'Reviewer' },
      {
        matchText: 'Repaired vendor', direction: 'Purchase', categoryQboId: 'expense',
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
      },
      'Reviewed the retired action and repaired its category.',
    )).resolves.toMatchObject({
      enabled: false, autoPost: false, direction: 'Purchase',
      categoryQboId: 'expense', retiredAt: null, repairReason: null, revision: 5,
    });
    expect(revisions).toHaveLength(1);
    expect(audits[0]).toMatchObject({ payload: expect.objectContaining({
      reason: 'Reviewed the retired action and repaired its category.',
    }) });
  });

  it('ordinary saves preserve a review hold and cannot clear a retirement tombstone', async () => {
    const deletedTagId = '11111111-1111-4111-8111-111111111111';
    const held = ruleRow({
      enabled: false,
      autoPost: false,
      reviewRequiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewReason: 'Needs review',
      repairReason: 'Repair required',
    });
    const heldDb = mutationDb(held, { preservedTagIds: [deletedTagId] });
    await expect(updateRuleInTransaction(
      heldDb.tx as never,
      held.companyId,
      held.id,
      held.revision,
      { id: 'user-1', label: 'Reviewer' },
      { matchText: 'Updated vendor' },
    )).resolves.toMatchObject({
      reviewRequiredAt: held.reviewRequiredAt,
      reviewReason: 'Needs review',
      repairReason: 'Repair required',
      enabled: false,
    });
    expect(heldDb.revisions[0]).toMatchObject({ tagIds: [deletedTagId] });

    const retired = ruleRow({
      enabled: false,
      autoPost: false,
      retiredAt: new Date('2026-02-01T00:00:00Z'),
    });
    const retiredDb = mutationDb(retired);
    await expect(updateRuleInTransaction(
      retiredDb.tx as never,
      retired.companyId,
      retired.id,
      retired.revision,
      { id: 'user-1', label: 'Reviewer' },
      { matchText: 'Updated vendor' },
    )).rejects.toThrow(/not found/i);
    expect(retiredDb.update).not.toHaveBeenCalled();
  });

  it('does not allow an ordinary save to turn auto-post back on while Disabled or held', async () => {
    const held = ruleRow({
      enabled: false,
      autoPost: false,
      reviewRequiredAt: new Date('2026-02-01T00:00:00Z'),
      reviewReason: 'Needs review',
      repairReason: 'Repair required',
    });
    const { tx, update } = mutationDb(held);
    await expect(updateRuleInTransaction(
      tx as never,
      held.companyId,
      held.id,
      held.revision,
      { id: 'user-1', label: 'Reviewer' },
      { autoPost: true },
    )).rejects.toThrow(/reviewed and Enabled/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('allocates new priority monotonically from all current rows', async () => {
    const aggregate = vi.fn(async () => ({ _max: { priority: 17 } }));
    await expect(nextRulePriorityInTransaction(
      { rule: { aggregate } } as never,
      'company-1',
    )).resolves.toBe(18);
    expect(aggregate).toHaveBeenCalledWith({
      where: { companyId: 'company-1' },
      _max: { priority: true },
    });
  });
});
