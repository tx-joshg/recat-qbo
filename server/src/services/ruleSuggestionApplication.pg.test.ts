import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CategorizationStagingWorkflow, CategorizationStageReceipt } from './categorization.js';
import type { StageCategorizationInput, StagedCategorization } from '@recat/shared';
import { lockCompanyMutationScope, runCompanyMutationTransaction } from './companyMutationScope.js';
import { disableRuleForSafetyInTransaction } from './ruleSafetyTransition.js';
import { validateExistingRuleAction } from './rules.js';
import {
  acquireRuleSuggestionApplicationFence,
  stageRuleSuggestion,
} from './ruleSuggestionApplication.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describePostgres('rule suggestion application PostgreSQL fencing', () => {
  let stageClient: PrismaClient;
  let mutationClient: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    stageClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    mutationClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await stageClient.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    companyIds.clear();
  });

  afterAll(async () => {
    await Promise.all([stageClient?.$disconnect(), mutationClient?.$disconnect()]);
  });

  async function fixture() {
    const suffix = randomUUID();
    const company = await stageClient.company.create({ data: {
      realmId: `rule-suggestion-${suffix}`,
      legalName: 'Rule suggestion fence',
      nickname: `rule-suggestion-${suffix.slice(0, 8)}`,
      ruleRuntimeMode: 'canonical',
      holdingAccountIds: [`holding-${suffix}`],
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    } });
    companyIds.add(company.id);
    const account = await stageClient.qboAccount.create({ data: {
      companyId: company.id,
      qboId: `expense-${suffix}`,
      name: 'Meals',
      fullName: 'Expenses · Meals',
      classification: 'Expenses',
      active: true,
    } });
    const transaction = await stageClient.transaction.create({ data: {
      companyId: company.id,
      qboId: `purchase-${suffix}`,
      qboType: 'Purchase',
      qboSyncToken: '0',
      date: new Date('2026-09-01T00:00:00.000Z'),
      payee: 'Coffee House',
      amount: '-10.00',
      bankAccount: 'Bank',
      rawData: {
        Id: `purchase-${suffix}`,
        SyncToken: '0',
        TxnDate: '2026-09-01',
        AccountRef: { value: `bank-${suffix}` },
        GlobalTaxCalculation: 'NotApplicable',
        TotalAmt: 10,
        TxnTaxDetail: { TotalTax: 0 },
        Line: [{
          Id: 'holding-line',
          Amount: 10,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: `holding-${suffix}` },
          },
        }],
      },
    } });
    const rule = await stageClient.rule.create({ data: {
      companyId: company.id,
      matchText: 'Coffee',
      category: account.name,
      categoryQboId: account.qboId,
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      enabled: true,
      autoPost: false,
      revision: 1,
      canonicalVersion: 2,
      direction: 'Purchase',
      priority: 1,
    } });
    const suggestion = {
      source: 'rule' as const,
      version: 2 as const,
      ruleId: rule.id,
      ruleRevision: 1,
      action: {
        version: 2 as const,
        direction: 'Purchase' as const,
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable' as const,
        taxCodeQboId: null,
        tagIds: [],
      },
      autoPost: false,
    };
    return { company, transaction, rule, suggestion };
  }

  function staged(transactionId: string): StagedCategorization {
    return {
      transactionId,
      revision: 1,
      taxCalculation: 'NotApplicable',
      totals: { subtotalCents: -1_000, taxCents: 0, totalCents: -1_000 },
      lines: [],
      tagIds: [],
    };
  }

  it('returns promptly without staging when another company mutation owns the fence', async () => {
    const target = await fixture();
    const held = deferred();
    const release = deferred();
    const holder = mutationClient.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, target.company.id);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const afterStage = vi.fn();

    const attempt = stageRuleSuggestion({
      transactionId: target.transaction.id,
      companyId: target.company.id,
      expectedRevision: 0,
      suggestion: target.suggestion,
    }, {
      stage: async <T>(input: StageCategorizationInput, workflow: CategorizationStagingWorkflow<T>) => (
        stageClient.$transaction(async (tx) => {
          const decision = await workflow.beforeValidation(tx as never, input);
          if (decision.kind === 'return') return decision.value;
          afterStage();
          return workflow.afterStage(tx as never, { staged: staged(target.transaction.id) } as CategorizationStageReceipt);
        })
      ),
      validateRuleAction: validateExistingRuleAction,
      disableRuleForSafety: disableRuleForSafetyInTransaction,
      acquireFence: acquireRuleSuggestionApplicationFence,
    });

    await expect(Promise.race([
      attempt,
      delay(1_000).then(() => { throw new Error('rule suggestion fence attempt hung'); }),
    ])).rejects.toMatchObject({ code: 'RULE_SUGGESTION_BUSY' });
    expect(afterStage).not.toHaveBeenCalled();
    release.resolve();
    await holder;
  });

  it('maps real Company-row NOWAIT contention to a prompt no-stage conflict', async () => {
    const target = await fixture();
    const held = deferred();
    const release = deferred();
    const holder = mutationClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT "id" FROM "Company" WHERE "id" = $1 FOR UPDATE`,
        target.company.id,
      );
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const afterStage = vi.fn();

    const attempt = stageRuleSuggestion({
      transactionId: target.transaction.id,
      companyId: target.company.id,
      expectedRevision: 0,
      suggestion: target.suggestion,
    }, {
      stage: async <T>(input: StageCategorizationInput, workflow: CategorizationStagingWorkflow<T>) => (
        stageClient.$transaction(async (tx) => {
          const decision = await workflow.beforeValidation(tx as never, input);
          if (decision.kind === 'return') return decision.value;
          afterStage();
          return workflow.afterStage(tx as never, { staged: staged(target.transaction.id) } as CategorizationStageReceipt);
        })
      ),
      validateRuleAction: validateExistingRuleAction,
      disableRuleForSafety: disableRuleForSafetyInTransaction,
      acquireFence: acquireRuleSuggestionApplicationFence,
    });

    try {
      await expect(Promise.race([
        attempt,
        delay(1_000).then(() => { throw new Error('Company-row NOWAIT attempt hung'); }),
      ])).rejects.toMatchObject({ code: 'RULE_SUGGESTION_BUSY' });
      expect(afterStage).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await holder;
    }
  });

  it('prevents a winner mutation from crossing a successful verified stage', async () => {
    const target = await fixture();
    const verified = deferred();
    const releaseStage = deferred();
    const afterStage = vi.fn();
    const stage = stageRuleSuggestion({
      transactionId: target.transaction.id,
      companyId: target.company.id,
      expectedRevision: 0,
      suggestion: target.suggestion,
    }, {
      stage: async <T>(input: StageCategorizationInput, workflow: CategorizationStagingWorkflow<T>) => (
        stageClient.$transaction(async (tx) => {
          const decision = await workflow.beforeValidation(tx as never, input);
          if (decision.kind === 'return') return decision.value;
          verified.resolve();
          await releaseStage.promise;
          afterStage();
          return workflow.afterStage(tx as never, { staged: staged(target.transaction.id) } as CategorizationStageReceipt);
        })
      ),
      validateRuleAction: validateExistingRuleAction,
      disableRuleForSafety: disableRuleForSafetyInTransaction,
      acquireFence: acquireRuleSuggestionApplicationFence,
    });
    await verified.promise;

    let mutationSettled = false;
    const mutation = runCompanyMutationTransaction(mutationClient, target.company.id, async (tx) => {
      await tx.rule.update({
        where: { id: target.rule.id },
        data: { matchText: 'Changed', revision: { increment: 1 } },
      });
    }).then(() => { mutationSettled = true; });
    await delay(75);
    expect(mutationSettled).toBe(false);

    releaseStage.resolve();
    await expect(stage).resolves.toMatchObject({ transactionId: target.transaction.id });
    await mutation;
    expect(afterStage).toHaveBeenCalledTimes(1);
    await expect(stageClient.rule.findUnique({ where: { id: target.rule.id } }))
      .resolves.toMatchObject({ matchText: 'Changed', revision: 2 });
  });
});
