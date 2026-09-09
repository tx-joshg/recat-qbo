import { describe, expect, it, vi } from 'vitest';
import type { RuleActionV2, StagedCategorization } from '@recat/shared';
import {
  prepareRuleAutoPost,
  recoverRuleAutoPosts,
  resumeRuleAutoPost,
} from './ruleAutoPost.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000020';
const RULE_ID = '00000000-0000-4000-8000-000000000030';
const PREPARATION_ID = '00000000-0000-4000-8000-000000000040';

const action: RuleActionV2 = {
  version: 2,
  direction: 'Purchase',
  category: 'Meals',
  categoryQboId: 'expense-1',
  taxCalculation: 'TaxInclusive',
  taxCodeQboId: 'tax-1',
  tagIds: ['00000000-0000-4000-8000-000000000050'],
};

const staged: StagedCategorization = {
  transactionId: TRANSACTION_ID,
  revision: 8,
  taxCalculation: 'TaxInclusive',
  totals: { subtotalCents: -1_000, taxCents: -120, totalCents: -1_120 },
  lines: [{
    idx: 0,
    subtotalCents: -1_000,
    taxCents: -120,
    totalCents: -1_120,
    categoryQboId: 'expense-1',
    taxCodeQboId: 'tax-1',
    memo: null,
    tagIds: action.tagIds,
  }],
  tagIds: action.tagIds,
};

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    id: PREPARATION_ID,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    ruleId: RULE_ID,
    ruleRevision: 6,
    requestId: PREPARATION_ID,
    state: 'PREPARED',
    ...overrides,
  };
}

function prepareHarness(options: {
  humanStage?: boolean;
  legacyCategoryStage?: boolean;
  verify?: boolean;
  verifiedQboType?: 'Purchase' | 'Deposit';
} = {}) {
  const create = vi.fn(async ({ data }) => ({ ...data }));
  const tx = {
    ruleAutoPostPreparation: {
      findFirst: vi.fn(async () => null),
      create,
    },
    splitLine: { count: vi.fn(async () => options.humanStage ? 1 : 0) },
    txnTag: { count: vi.fn(async () => 0) },
    transaction: {
      findFirst: vi.fn(async () => ({
        category: options.legacyCategoryStage ? 'Manual category' : null,
        categoryQboId: options.legacyCategoryStage ? 'expense-manual' : null,
      })),
    },
  };
  const stage = vi.fn(async (input, workflow) => {
    const decision = await workflow.beforeValidation(tx, input);
    if (decision.kind === 'return') return decision.value;
    return workflow.afterStage(tx, {
      normalizedProposal: input.proposal,
      sourceRevision: 7,
      preparedRevision: 8,
      qboType: 'Purchase',
      qboId: 'purchase-1',
      qboSyncToken: '3',
      staged,
    });
  });
  return {
    id: vi.fn(() => PREPARATION_ID),
    stage,
    loadCandidate: vi.fn(async () => ({
      expectedRevision: 7,
      grossCents: -1_120,
      action,
    })),
    verify: vi.fn(async () => options.verify === false ? null : ({
      action,
      autoPost: true,
      qboType: options.verifiedQboType ?? 'Purchase',
    })),
    commit: vi.fn(),
    reconcile: vi.fn(),
    loadPreparation: vi.fn(),
    listRecoverable: vi.fn(),
    loadAttemptStatus: vi.fn(),
    updatePreparationFromAttempt: vi.fn(async () => 'VERIFIED'),
    cancelStale: vi.fn(async () => false),
    tx,
  };
}

describe('prepareRuleAutoPost', () => {
  it('persists the immutable system envelope inside afterStage with exact stage and QBO bindings', async () => {
    const deps = prepareHarness();

    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).resolves.toEqual({ preparationId: PREPARATION_ID });

    expect(deps.tx.ruleAutoPostPreparation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: PREPARATION_ID,
        companyId: COMPANY_ID,
        transactionId: TRANSACTION_ID,
        ruleId: RULE_ID,
        ruleRevision: 6,
        proposal: expect.objectContaining({
          lines: [expect.objectContaining({ grossCents: -1_120 })],
        }),
        sourceRevision: 7,
        preparedRevision: 8,
        qboType: 'Purchase',
        qboId: 'purchase-1',
        qboSyncToken: '3',
        requestId: PREPARATION_ID,
        state: 'PREPARED',
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        proposalHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        stagedGraphHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    });
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('rejects stale rule authority before staging', async () => {
    const deps = prepareHarness({ verify: false });
    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_AUTO_POST' });
    expect(deps.tx.ruleAutoPostPreparation.create).not.toHaveBeenCalled();
  });

  it('rejects a verified transaction direction that differs from the rule action', async () => {
    const deps = prepareHarness({ verifiedQboType: 'Deposit' });
    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).rejects.toMatchObject({ code: 'STALE_RULE_AUTO_POST' });
    expect(deps.tx.ruleAutoPostPreparation.create).not.toHaveBeenCalled();
  });

  it('preserves an existing human stage', async () => {
    const deps = prepareHarness({ humanStage: true });
    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).rejects.toMatchObject({ code: 'HUMAN_STAGE_EXISTS' });
    expect(deps.tx.ruleAutoPostPreparation.create).not.toHaveBeenCalled();
  });

  it('preserves a legacy category-only human stage without split or tag rows', async () => {
    const deps = prepareHarness({ legacyCategoryStage: true });
    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).rejects.toMatchObject({ code: 'HUMAN_STAGE_EXISTS' });
    expect(deps.tx.ruleAutoPostPreparation.create).not.toHaveBeenCalled();
  });

  it('lets envelope persistence failure abort the staging call', async () => {
    const deps = prepareHarness();
    const failure = new Error('envelope persistence failed');
    deps.tx.ruleAutoPostPreparation.create.mockRejectedValueOnce(failure);
    await expect(prepareRuleAutoPost({
      companyId: COMPANY_ID,
      transactionId: TRANSACTION_ID,
      ruleId: RULE_ID,
      ruleRevision: 6,
    }, deps as never)).rejects.toBe(failure);
  });
});

describe('resumeRuleAutoPost', () => {
  it('resumes a prepared attempt through the hard-wired commit entrypoint', async () => {
    const deps = prepareHarness();
    deps.loadPreparation.mockResolvedValue(preparation());
    deps.loadAttemptStatus.mockResolvedValue('PREPARED');
    deps.commit.mockResolvedValue({ outcome: 'VERIFIED' });

    await resumeRuleAutoPost(PREPARATION_ID, deps as never);

    expect(deps.commit).toHaveBeenCalledWith(PREPARATION_ID);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.updatePreparationFromAttempt).toHaveBeenCalledWith(PREPARATION_ID);
  });

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'reconciles %s by readback without invoking the send path',
    async (attemptStatus) => {
      const deps = prepareHarness();
      deps.loadPreparation.mockResolvedValue(preparation({ state: attemptStatus }));
      deps.loadAttemptStatus.mockResolvedValue(attemptStatus);
      deps.reconcile.mockResolvedValue({ outcome: 'VERIFIED' });

      await resumeRuleAutoPost(PREPARATION_ID, deps as never);

      expect(deps.reconcile).toHaveBeenCalledWith(PREPARATION_ID);
      expect(deps.commit).not.toHaveBeenCalled();
    },
  );

  it.each(['COMMITTING', 'UNCERTAIN'])(
    'fails closed when a %s preparation has no durable mutation attempt',
    async (preparationState) => {
      const deps = prepareHarness();
      deps.loadPreparation.mockResolvedValue(preparation({ state: preparationState }));
      deps.loadAttemptStatus.mockResolvedValue(null);

      await expect(resumeRuleAutoPost(PREPARATION_ID, deps as never)).rejects.toMatchObject({
        code: 'MISSING_RULE_AUTO_POST_ATTEMPT',
      });

      expect(deps.commit).not.toHaveBeenCalled();
      expect(deps.reconcile).not.toHaveBeenCalled();
    },
  );

  it('terminally cancels a provably unsent stale preparation and preserves the staged graph', async () => {
    const deps = prepareHarness();
    deps.loadPreparation.mockResolvedValue(preparation());
    deps.loadAttemptStatus.mockResolvedValue(null);
    deps.commit.mockRejectedValue(new Error('rule authority changed'));
    deps.cancelStale.mockResolvedValue(true);

    await expect(resumeRuleAutoPost(PREPARATION_ID, deps as never)).resolves.toBeUndefined();

    expect(deps.cancelStale).toHaveBeenCalledWith(PREPARATION_ID);
    expect(deps.updatePreparationFromAttempt).not.toHaveBeenCalled();
  });
});

describe('recoverRuleAutoPosts', () => {
  it('isolates failures per preparation and reports durable outcomes', async () => {
    const deps = prepareHarness();
    deps.listRecoverable.mockResolvedValue([
      preparation({ id: 'prep-ok' }),
      preparation({ id: 'prep-fail' }),
    ]);
    deps.loadPreparation.mockImplementation(async (id) => preparation({ id }));
    deps.loadAttemptStatus.mockResolvedValue('PREPARED');
    deps.commit.mockImplementation(async (id) => {
      if (id === 'prep-fail') throw new Error('transient');
      return { outcome: 'VERIFIED' };
    });

    await expect(recoverRuleAutoPosts(COMPANY_ID, deps as never)).resolves.toEqual({
      examined: 2,
      completed: 1,
      pending: 0,
      failed: 1,
    });
  });
});
