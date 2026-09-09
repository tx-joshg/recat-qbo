import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleSuggestionDto, StagedCategorization } from '@recat/shared';
import {
  acquireRuleSuggestionApplicationFence,
  stageRuleSuggestion,
} from './ruleSuggestionApplication.js';
import { RuleServiceError } from './rules.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000020';
const RULE_ID = '00000000-0000-4000-8000-000000000030';
const TAG_ID = '00000000-0000-4000-8000-000000000040';

const suggestion: RuleSuggestionDto = {
  source: 'rule',
  version: 2,
  ruleId: RULE_ID,
  ruleRevision: 6,
  action: {
    version: 2,
    direction: 'Purchase',
    category: 'Meals',
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCalculation: 'TaxExcluded',
    taxCodeQboId: 'PURCHASE_TAX',
    tagIds: [TAG_ID],
  },
  autoPost: false,
};

const staged: StagedCategorization = {
  transactionId: TRANSACTION_ID,
  revision: 8,
  taxCalculation: 'TaxExcluded',
  totals: { subtotalCents: -1_000, taxCents: -50, totalCents: -1_050 },
  lines: [{
    idx: 0,
    subtotalCents: -1_000,
    taxCents: -50,
    totalCents: -1_050,
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCodeQboId: 'PURCHASE_TAX',
    memo: null,
    tagIds: [TAG_ID],
  }],
  tagIds: [TAG_ID],
};

function currentRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    companyId: COMPANY_ID,
    revision: 6,
    enabled: true,
    retiredAt: null,
    reviewRequiredAt: null,
    reviewReason: null,
    repairReason: null,
    canonicalVersion: 2,
    matchText: 'Coffee',
    direction: 'Purchase',
    priority: 10,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    category: 'Meals',
    categoryQboId: 'EXPENSE_ACCOUNT',
    taxCalculation: 'TaxExcluded',
    taxCodeQboId: 'PURCHASE_TAX',
    autoPost: false,
    ruleTags: [{ tagId: TAG_ID }],
    candidateOrigin: null,
    ...overrides,
  };
}

function harness(options: {
  mode?: 'legacy' | 'bridge' | 'paused' | 'canonical';
  rules?: ReturnType<typeof currentRule>[];
  validateError?: Error;
} = {}) {
  const tx = {
    company: { findUnique: vi.fn(async () => ({ ruleRuntimeMode: options.mode ?? 'canonical' })) },
    transaction: { findFirst: vi.fn(async () => ({
      id: TRANSACTION_ID, companyId: COMPANY_ID, qboType: 'Purchase', payee: 'Coffee House', amount: -10.5,
    })) },
    rule: { findMany: vi.fn(async () => options.rules ?? [currentRule()]) },
  };
  const validateRuleAction = options.validateError
    ? vi.fn().mockRejectedValue(options.validateError)
    : vi.fn().mockResolvedValue({
        action: {
          categoryQboId: 'EXPENSE_ACCOUNT', taxCalculation: 'TaxExcluded',
          taxCodeQboId: 'PURCHASE_TAX', tagIds: [TAG_ID],
        },
        direction: 'Purchase',
        categoryName: 'Meals',
        taxCodeName: 'GST',
      });
  const disableRuleForSafety = vi.fn().mockResolvedValue({ changed: true, revision: 7 });
  const acquireFence = vi.fn().mockResolvedValue(undefined);
  const loadSourceGrossCents = vi.fn().mockResolvedValue(-1_050);
  const afterStage = vi.fn();
  const stage = vi.fn(async (input, workflow) => {
    const decision = await workflow.beforeValidation(tx, input);
    if (decision.kind === 'return') return decision.value;
    afterStage();
    return workflow.afterStage(tx, { staged });
  });
  return {
    tx,
    stage,
    validateRuleAction,
    disableRuleForSafety,
    acquireFence,
    loadSourceGrossCents,
    afterStage,
  };
}

describe('stageRuleSuggestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('constructs and stages the exact full action only after in-transaction verification', async () => {
    const deps = harness();

    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 7,
      suggestion,
    }, deps as never)).resolves.toEqual(staged);

    expect(deps.stage).toHaveBeenCalledWith({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 7,
      proposal: {
        taxCalculation: 'TaxExcluded',
        lines: [{
          grossCents: -1_050,
          categoryQboId: 'EXPENSE_ACCOUNT',
          taxCodeQboId: 'PURCHASE_TAX',
          tagIds: [TAG_ID],
        }],
        tagIds: [TAG_ID],
      },
    }, expect.any(Object));
    expect(deps.validateRuleAction).toHaveBeenCalledWith(
      deps.tx,
      COMPANY_ID,
      expect.objectContaining({ id: RULE_ID, revision: 6 }),
    );
    expect(deps.acquireFence).toHaveBeenCalledWith(deps.tx, COMPANY_ID);
    expect(deps.afterStage).toHaveBeenCalledTimes(1);
  });

  it('uses synchronized provider gross for a taxable Purchase instead of the net mirror amount', async () => {
    const deps = harness();
    deps.loadSourceGrossCents.mockResolvedValueOnce(-1_120);

    await stageRuleSuggestion({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 7,
      suggestion,
    }, deps as never);

    expect(deps.stage).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({
        lines: [expect.objectContaining({ grossCents: -1_120 })],
      }),
    }), expect.any(Object));
  });

  it('returns a retryable conflict without reading or staging when the company fence is busy', async () => {
    const deps = harness();
    deps.acquireFence.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'RULE_SUGGESTION_BUSY' }),
    );

    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID, companyId: COMPANY_ID, expectedRevision: 7,
      suggestion,
    }, deps as never)).rejects.toMatchObject({ code: 'RULE_SUGGESTION_BUSY' });
    expect(deps.tx.company.findUnique).not.toHaveBeenCalled();
    expect(deps.afterStage).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'bridge', 'paused'] as const)('fails closed in %s mode', async (mode) => {
    const deps = harness({ mode });
    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID, companyId: COMPANY_ID, expectedRevision: 7, suggestion,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_SUGGESTION' });
    expect(deps.validateRuleAction).not.toHaveBeenCalled();
    expect(deps.afterStage).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted', []],
    ['disabled', [currentRule({ enabled: false })]],
    ['retired', [currentRule({ retiredAt: new Date('2026-09-02T00:00:00.000Z') })]],
    ['repair-held', [currentRule({ repairReason: 'Repair references before enabling.' })]],
    ['revision changed', [currentRule({ revision: 7 })]],
  ])('rejects a %s rule without staging', async (_name, rules) => {
    const deps = harness({ rules: rules as ReturnType<typeof currentRule>[] });
    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID, companyId: COMPANY_ID, expectedRevision: 7, suggestion,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_SUGGESTION' });
    expect(deps.afterStage).not.toHaveBeenCalled();
  });

  it('rejects when another rule is now the deterministic winner', async () => {
    const deps = harness({ rules: [
      currentRule(),
      currentRule({ id: '00000000-0000-4000-8000-000000000001', priority: 1 }),
    ] });
    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID, companyId: COMPANY_ID, expectedRevision: 7, suggestion,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_SUGGESTION' });
    expect(deps.afterStage).not.toHaveBeenCalled();
  });

  it('commits the safety disable transition and returns without a partial stage on reference drift', async () => {
    const deps = harness({
      validateError: new RuleServiceError('NOT_FOUND', 'Category reference was not found.'),
    });
    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID, companyId: COMPANY_ID, expectedRevision: 7, suggestion,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_SUGGESTION' });

    expect(deps.disableRuleForSafety).toHaveBeenCalledWith(deps.tx, expect.objectContaining({
      companyId: COMPANY_ID,
      ruleId: RULE_ID,
      expectedRevision: 6,
      preserveTagIds: [TAG_ID],
    }));
    expect(deps.afterStage).not.toHaveBeenCalled();
  });

  it('rejects a snapshot whose exact full action no longer matches the verified revision', async () => {
    const deps = harness();
    await expect(stageRuleSuggestion({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 7,
      suggestion: { ...suggestion, action: { ...suggestion.action, taxCalculation: 'TaxInclusive' } },
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_SUGGESTION' });
    expect(deps.afterStage).not.toHaveBeenCalled();
  });
});

describe('acquireRuleSuggestionApplicationFence', () => {
  it('maps Prisma-wrapped PostgreSQL NOWAIT contention to a retryable conflict', async () => {
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockRejectedValueOnce(Object.assign(new Error('Raw query failed.'), {
          code: 'P2010',
          meta: { code: '55P03', message: 'could not obtain lock on row' },
        })),
    };

    await expect(acquireRuleSuggestionApplicationFence(tx as never, COMPANY_ID))
      .rejects.toMatchObject({ code: 'RULE_SUGGESTION_BUSY' });
  });
});
