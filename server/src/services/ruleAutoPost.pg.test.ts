import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  QboRequestTimeout,
  type QboClient,
  type QboPreparedWrite,
  type QboPurchaseSnapshot,
  type QboTxn,
} from '../lib/qbo/types.js';
import {
  prepareRuleAutoPost,
  resumeRuleAutoPost,
} from './ruleAutoPost.js';
import {
  commitRuleAutoPostPreparation,
  hashPreparedWriteBody,
  reconcileRuleAutoPostPreparation,
  type DurableWritebackDb,
  type RuleAutoPostWritebackDeps,
} from './writeback.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule auto-post PostgreSQL composition', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    companyIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function taxablePurchaseFixture() {
    const suffix = randomUUID();
    const holdingQboId = `holding-${suffix}`;
    const purchaseQboId = `purchase-${suffix}`;
    const company = await db.company.create({ data: {
      realmId: `rule-auto-${suffix}`,
      legalName: 'Rule auto-post PostgreSQL',
      nickname: `rule-auto-${suffix.slice(0, 8)}`,
      ruleRuntimeMode: 'canonical',
      dryRun: true,
      holdingAccountIds: [holdingQboId],
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    } });
    companyIds.add(company.id);
    const category = await db.qboAccount.create({ data: {
      companyId: company.id,
      qboId: `expense-${suffix}`,
      name: 'Meals',
      fullName: 'Expenses · Meals',
      classification: 'Expenses',
      active: true,
    } });
    await db.qboTaxRate.create({ data: {
      companyId: company.id,
      qboId: `rate-${suffix}`,
      name: 'Purchase tax 12%',
      rateValue: 12,
      active: true,
    } });
    const taxCode = await db.qboTaxCode.create({ data: {
      companyId: company.id,
      qboId: `tax-${suffix}`,
      name: 'Purchase tax',
      active: true,
      taxable: true,
      purchaseTaxRateList: [{
        taxRateQboId: `rate-${suffix}`,
        taxTypeApplicable: 'TaxOnAmount',
      }],
      salesTaxRateList: [],
      combinedPurchaseRate: 12,
    } });
    const transaction = await db.transaction.create({ data: {
      companyId: company.id,
      qboId: purchaseQboId,
      qboType: 'Purchase',
      qboSyncToken: '3',
      date: new Date('2026-09-01T00:00:00.000Z'),
      payee: 'Coffee House',
      amount: '-10.00',
      bankAccount: 'Test bank',
      rawData: {
        Id: purchaseQboId,
        SyncToken: '3',
        TxnDate: '2026-09-01',
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TotalAmt: 11.2,
        TxnTaxDetail: { TotalTax: 1.2 },
        Line: [{
          Id: '1',
          Amount: 10,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: holdingQboId },
            TaxCodeRef: { value: taxCode.qboId },
            TaxInclusiveAmt: 11.2,
          },
        }],
      },
    } });
    const rule = await db.rule.create({ data: {
      companyId: company.id,
      matchText: 'Coffee',
      category: category.name,
      categoryQboId: category.qboId,
      taxCalculation: 'TaxInclusive',
      taxCode: taxCode.name,
      taxCodeQboId: taxCode.qboId,
      enabled: true,
      autoPost: true,
      revision: 1,
      canonicalVersion: 2,
      direction: 'Purchase',
      priority: 1,
    } });
    return { company, transaction, rule, category, taxCode, holdingQboId };
  }

  function fakePurchaseWriteback(
    fixture: Awaited<ReturnType<typeof taxablePurchaseFixture>>,
    options: { loseResponse: boolean; appliedAfterLoss?: boolean },
  ): { deps: RuleAutoPostWritebackDeps; send: ReturnType<typeof vi.fn> } {
    let providerWritten = false;
    const before: QboPurchaseSnapshot = {
      qboId: fixture.transaction.qboId,
      syncToken: '3',
      totalCents: -1120,
      accountQboId: 'bank-1',
      date: '2026-09-01',
      direction: 'purchase',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: -120,
      lines: [{
        id: '1',
        amountCents: -1000,
        description: null,
        accountQboId: fixture.holdingQboId,
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: fixture.taxCode.qboId,
        taxAmountCents: -120,
        taxInclusiveCents: -1120,
      }],
    };
    const expectedLine = {
      id: null,
      amountCents: -1000,
      description: null,
      accountQboId: fixture.category.qboId,
      customerQboId: null,
      classQboId: null,
      taxCodeQboId: fixture.taxCode.qboId,
      taxAmountCents: -120,
      taxInclusiveCents: -1120,
    };
    const verified: QboPurchaseSnapshot = {
      ...before,
      syncToken: '4',
      lines: [{ ...expectedLine, id: 'posted-line' }],
    };
    const fresh: QboTxn = {
      qboId: fixture.transaction.qboId,
      qboType: 'Purchase',
      syncToken: '3',
      date: '2026-09-01',
      payee: 'Coffee House',
      amount: -10,
      bankAccount: 'Test bank',
      lines: [{
        id: '1',
        amount: -10,
        accountQboId: fixture.holdingQboId,
        accountName: 'Holding',
      }],
      raw: {},
    };
    const prepareRecategorization = vi.fn(async (
      _txn: QboTxn,
      _staged: unknown,
      source: QboPurchaseSnapshot,
      requestId: string,
    ): Promise<QboPreparedWrite> => {
      const body = {
        Id: fixture.transaction.qboId,
        SyncToken: source.syncToken,
        TxnDate: '2026-09-01',
        TotalAmt: 11.2,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TxnTaxDetail: { TotalTax: 1.2 },
        Line: [{
          Amount: 10,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: fixture.category.qboId },
            TaxCodeRef: { value: fixture.taxCode.qboId },
            TaxAmount: 1.2,
            TaxInclusiveAmt: 11.2,
          },
        }],
      };
      return {
        operation: 'recategorize',
        qboType: 'Purchase',
        qboId: fixture.transaction.qboId,
        requestId,
        requestHash: hashPreparedWriteBody(body),
        body,
        before: structuredClone(source),
        expected: {
          qboId: fixture.transaction.qboId,
          totalCents: -1120,
          accountQboId: 'bank-1',
          date: '2026-09-01',
          direction: 'purchase',
          globalTaxCalculation: 'TaxInclusive',
          totalTaxCents: -120,
          targetLines: [expectedLine],
          untouchedLineHashes: [],
        },
      };
    });
    const send = vi.fn(async () => {
      providerWritten = true;
      if (options.loseResponse) throw new QboRequestTimeout();
      return { ok: true as const, newSyncToken: '4' };
    });
    const client: Partial<QboClient> = {
      fetchTxn: vi.fn(async () => structuredClone(fresh)),
      fetchPurchaseSnapshot: vi.fn(async () => structuredClone(
        providerWritten && options.appliedAfterLoss !== false ? verified : before,
      )),
      fetchPreparedSnapshot: vi.fn(async () => structuredClone(
        providerWritten && options.appliedAfterLoss !== false ? verified : before,
      )),
      fetchWriteSafety: vi.fn(async () => ({
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
      })),
      prepareRecategorization: prepareRecategorization as QboClient['prepareRecategorization'],
      sendPreparedWrite: send,
    };
    const deps: RuleAutoPostWritebackDeps = {
      db: db as unknown as DurableWritebackDb,
      getClient: async () => client as QboClient,
      audit: async () => undefined,
      envDryRun: false,
      lease: async (_key, _owner, callback) => callback(),
      renewLease: async () => undefined,
      invocationId: randomUUID,
      now: () => new Date(),
    };
    return { deps, send };
  }

  async function taxableDepositFixture() {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `rule-auto-deposit-${suffix}`,
      legalName: 'Rule auto-post PostgreSQL deposit',
      nickname: `rule-dep-${suffix.slice(0, 8)}`,
      ruleRuntimeMode: 'canonical',
      dryRun: true,
      holdingAccountIds: [`holding-${suffix}`],
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    } });
    companyIds.add(company.id);
    const category = await db.qboAccount.create({ data: {
      companyId: company.id,
      qboId: `income-${suffix}`,
      name: 'Services',
      fullName: 'Income · Services',
      classification: 'Income',
      active: true,
    } });
    await db.qboTaxRate.create({ data: {
      companyId: company.id,
      qboId: `sales-rate-${suffix}`,
      name: 'Sales tax 12%',
      rateValue: 12,
      active: true,
    } });
    const taxCode = await db.qboTaxCode.create({ data: {
      companyId: company.id,
      qboId: `sales-tax-${suffix}`,
      name: 'Sales tax',
      active: true,
      taxable: true,
      purchaseTaxRateList: [],
      salesTaxRateList: [{
        taxRateQboId: `sales-rate-${suffix}`,
        taxTypeApplicable: 'TaxOnAmount',
      }],
      combinedSalesRate: 12,
    } });
    const transaction = await db.transaction.create({ data: {
      companyId: company.id,
      qboId: `deposit-${suffix}`,
      qboType: 'Deposit',
      qboSyncToken: '5',
      date: new Date('2026-09-01T00:00:00.000Z'),
      payee: 'Consulting Client',
      amount: '11.20',
      bankAccount: 'Test bank',
      rawData: {},
    } });
    const rule = await db.rule.create({ data: {
      companyId: company.id,
      matchText: 'Consulting',
      category: category.name,
      categoryQboId: category.qboId,
      taxCalculation: 'TaxInclusive',
      taxCode: taxCode.name,
      taxCodeQboId: taxCode.qboId,
      enabled: true,
      autoPost: true,
      revision: 1,
      canonicalVersion: 2,
      direction: 'Deposit',
      priority: 1,
    } });
    return { company, transaction, rule, category, taxCode };
  }

  it('uses provider gross and composes real stage, envelope, and durable dry-run writeback', async () => {
    const fixture = await taxablePurchaseFixture();
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });

    const [staged, envelope] = await Promise.all([
      db.transaction.findUniqueOrThrow({
        where: { id: fixture.transaction.id },
        include: { splitLines: true },
      }),
      db.ruleAutoPostPreparation.findUniqueOrThrow({ where: { id: prepared.preparationId } }),
    ]);
    expect(staged).toMatchObject({ revision: 1, status: 'PENDING' });
    expect(staged.splitLines).toHaveLength(1);
    expect(staged.splitLines[0]!.amount.toString()).toBe('-11.2');
    expect(staged.splitLines[0]!.categoryQboId).toBe(fixture.category.qboId);
    expect(envelope).toMatchObject({
      sourceRevision: 0,
      preparedRevision: 1,
      qboType: 'Purchase',
      qboId: fixture.transaction.qboId,
      qboSyncToken: '3',
      state: 'PREPARED',
      proposal: expect.objectContaining({
        lines: [expect.objectContaining({ grossCents: -1120 })],
      }),
    });

    await resumeRuleAutoPost(prepared.preparationId);

    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'DRY_RUN' });
    await expect(db.qboMutationAttempt.count({
      where: { transactionId: fixture.transaction.id },
    })).resolves.toBe(1);
  });

  it('recovers response loss by readback without a second provider send', async () => {
    const fixture = await taxablePurchaseFixture();
    await db.company.update({ where: { id: fixture.company.id }, data: { dryRun: false } });
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });
    const writeback = fakePurchaseWriteback(fixture, { loseResponse: true });
    const deps = {
      commit: (id: string) => commitRuleAutoPostPreparation(id, writeback.deps),
      reconcile: (id: string) => reconcileRuleAutoPostPreparation(id, writeback.deps),
    };

    await resumeRuleAutoPost(prepared.preparationId, deps as never);
    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'UNCERTAIN' });
    expect(writeback.send).toHaveBeenCalledTimes(1);

    await resumeRuleAutoPost(prepared.preparationId, deps as never);

    expect(writeback.send).toHaveBeenCalledTimes(1);
    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'VERIFIED' });
    await expect(db.qboMutationAttempt.count({
      where: { transactionId: fixture.transaction.id },
    })).resolves.toBe(1);
  });

  it('terminally rejects an uncertain write proved unchanged without resending', async () => {
    const fixture = await taxablePurchaseFixture();
    await db.company.update({ where: { id: fixture.company.id }, data: { dryRun: false } });
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });
    const writeback = fakePurchaseWriteback(fixture, {
      loseResponse: true,
      appliedAfterLoss: false,
    });
    const deps = {
      commit: (id: string) => commitRuleAutoPostPreparation(id, writeback.deps),
      reconcile: (id: string) => reconcileRuleAutoPostPreparation(id, writeback.deps),
    };

    await resumeRuleAutoPost(prepared.preparationId, deps as never);
    await resumeRuleAutoPost(prepared.preparationId, deps as never);

    expect(writeback.send).toHaveBeenCalledTimes(1);
    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'REJECTED', errorCode: 'QBO_WRITE_NOT_APPLIED' });
  });

  it('rolls the real staged graph back when envelope persistence fails', async () => {
    const fixture = await taxablePurchaseFixture();
    const collision = randomUUID();
    const collisionTimestamp = new Date();
    await db.ruleAutoPostPreparation.create({ data: {
      id: collision,
      companyId: fixture.company.id,
      transactionId: 'collision-only',
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
      inputHash: 'a'.repeat(64),
      proposal: {},
      proposalHash: 'b'.repeat(64),
      stagedGraphHash: 'c'.repeat(64),
      sourceRevision: 0,
      preparedRevision: 1,
      qboType: 'Purchase',
      qboId: 'collision-only',
      qboSyncToken: '0',
      requestId: collision,
      state: 'CANCELLED',
      diagnostics: {},
      createdAt: collisionTimestamp,
      updatedAt: collisionTimestamp,
      completedAt: collisionTimestamp,
    } });

    await expect(prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    }, { id: () => collision } as never)).rejects.toMatchObject({ code: 'P2002' });

    await expect(db.transaction.findUniqueOrThrow({
      where: { id: fixture.transaction.id },
      include: { splitLines: true },
    })).resolves.toMatchObject({ revision: 0, splitLines: [] });
  });

  it('composes a real taxable Deposit stage and durable dry-run outcome', async () => {
    const fixture = await taxableDepositFixture();
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });
    const staged = await db.transaction.findUniqueOrThrow({
      where: { id: fixture.transaction.id },
      include: { splitLines: true },
    });
    expect(staged.splitLines).toHaveLength(1);
    expect(staged.splitLines[0]!.amount.toString()).toBe('11.2');
    expect(staged.splitLines[0]).toMatchObject({
      categoryQboId: fixture.category.qboId,
      taxCodeQboId: fixture.taxCode.qboId,
    });

    await resumeRuleAutoPost(prepared.preparationId);

    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'DRY_RUN', requestId: prepared.preparationId });
  });

  it('composes a real Purchase NoTax stage at provider gross', async () => {
    const fixture = await taxablePurchaseFixture();
    const rule = await db.rule.update({
      where: { id: fixture.rule.id },
      data: { taxCalculation: 'NotApplicable', taxCode: null, taxCodeQboId: null },
    });
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: rule.id,
      ruleRevision: rule.revision,
    });
    const [staged, envelope] = await Promise.all([
      db.transaction.findUniqueOrThrow({
        where: { id: fixture.transaction.id },
        include: { splitLines: true },
      }),
      db.ruleAutoPostPreparation.findUniqueOrThrow({ where: { id: prepared.preparationId } }),
    ]);
    expect(staged.taxCalculation).toBe('NotApplicable');
    expect(staged.splitLines[0]!.amount.toString()).toBe('-11.2');
    expect(staged.splitLines[0]!.taxCodeQboId).toBeNull();
    expect(envelope.proposal).toMatchObject({
      taxCalculation: 'NotApplicable',
      lines: [expect.objectContaining({ grossCents: -1120, taxCodeQboId: null })],
    });
  });

  it('rechecks the full winner set before recording a dry-run outcome', async () => {
    const fixture = await taxablePurchaseFixture();
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });
    await db.rule.create({ data: {
      companyId: fixture.company.id,
      matchText: 'Coffee',
      category: fixture.category.name,
      categoryQboId: fixture.category.qboId,
      taxCalculation: 'TaxInclusive',
      taxCode: fixture.taxCode.name,
      taxCodeQboId: fixture.taxCode.qboId,
      enabled: true,
      autoPost: false,
      revision: 1,
      canonicalVersion: 2,
      direction: 'Purchase',
      priority: 0,
    } });

    await expect(resumeRuleAutoPost(prepared.preparationId)).resolves.toBeUndefined();
    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'CANCELLED', errorCode: 'RULE_AUTO_POST_STALE' });
    await expect(db.qboMutationAttempt.count({
      where: { transactionId: fixture.transaction.id },
    })).resolves.toBe(0);
    await expect(db.ruleAutoPostPreparation.count({
      where: {
        transactionId: fixture.transaction.id,
        state: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE'] },
      },
    })).resolves.toBe(0);
    await expect(db.splitLine.count({ where: { txnId: fixture.transaction.id } })).resolves.toBe(1);
  });

  it('keeps a valid paused preparation pending without creating a provider attempt', async () => {
    const fixture = await taxablePurchaseFixture();
    const prepared = await prepareRuleAutoPost({
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    });
    await db.company.update({
      where: { id: fixture.company.id },
      data: { ruleRuntimeMode: 'paused' },
    });

    await expect(resumeRuleAutoPost(prepared.preparationId)).rejects.toMatchObject({
      code: 'RULE_AUTO_POST_AUTHORITY_DENIED',
    });

    await expect(db.ruleAutoPostPreparation.findUniqueOrThrow({
      where: { id: prepared.preparationId },
    })).resolves.toMatchObject({ state: 'PREPARED' });
    await expect(db.qboMutationAttempt.count({
      where: { transactionId: fixture.transaction.id },
    })).resolves.toBe(0);
  });

  it('returns one durable preparation under concurrent prepare calls', async () => {
    const fixture = await taxablePurchaseFixture();
    const input = {
      companyId: fixture.company.id,
      transactionId: fixture.transaction.id,
      ruleId: fixture.rule.id,
      ruleRevision: fixture.rule.revision,
    };
    const concurrent = await Promise.allSettled([
      prepareRuleAutoPost(input),
      prepareRuleAutoPost(input),
    ]);
    expect(concurrent.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const replay = await prepareRuleAutoPost(input);
    expect(replay.preparationId).toBe(
      (concurrent.find(({ status }) => status === 'fulfilled') as PromiseFulfilledResult<{
        preparationId: string;
      }>).value.preparationId,
    );
    await expect(db.ruleAutoPostPreparation.count({
      where: { companyId: fixture.company.id, transactionId: fixture.transaction.id },
    })).resolves.toBe(1);
  });
});
