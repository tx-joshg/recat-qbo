import { describe, expect, it, vi } from 'vitest';
import type { CategorizationProposal, StagedCategorization } from '@recat/shared';
import { calculatePurchaseTransaction } from '../../lib/qbo/purchaseTax.js';
import type { QboPurchaseSnapshot } from '../../lib/qbo/types.js';
import type { ClaimedAgentJob } from './jobs.js';
import type { LiveEligibilityInput } from './livePolicy.js';
import {
  homeCurrencyAuthorityWarnings,
  reconcileLiveProposalForStaging,
  runClaimedLiveJob,
  type FreshLiveInput,
  type LiveRunCompletion,
  type LiveWorkerDeps,
} from './liveWorker.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000002';
const JOB_ID = '00000000-0000-4000-8000-000000000003';
const RUN_ID = '00000000-0000-4000-8000-000000000004';
const CONFIG_VERSION = 'a'.repeat(64);
const OWNER = 'agent:00000000-0000-4000-8000-000000000003:1';

function job(): ClaimedAgentJob {
  const now = new Date('2026-07-29T12:00:00.000Z');
  return {
    id: JOB_ID,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    revision: 4,
    configVersion: CONFIG_VERSION,
    schedulingGeneration: 0,
    status: 'running',
    dueAt: now,
    lockOwner: 'worker-generic',
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function proposal(
  options: Partial<Extract<LiveEligibilityInput['reviewedRun']['result']['decision'], { kind: 'proposal' }>> = {},
): Extract<LiveEligibilityInput['reviewedRun']['result']['decision'], { kind: 'proposal' }> {
  return {
    kind: 'proposal',
    taxCalculation: 'NotApplicable',
    lines: [{
      grossCents: -10_00,
      categoryQboId: 'expense-generic',
      taxCodeQboId: null,
      memo: null,
      tagIds: [],
    }],
    tagIds: [],
    confidence: 0.95,
    evidence: [{ kind: 'category', qboId: 'expense-generic' }],
    rationale: 'Generic verified evidence.',
    ...options,
  } as Extract<LiveEligibilityInput['reviewedRun']['result']['decision'], { kind: 'proposal' }>;
}

function qboSnapshot(syncToken = '7'): QboPurchaseSnapshot {
  return {
    qboId: 'purchase-generic',
    syncToken,
    totalCents: -10_00,
    accountQboId: 'source-generic',
    date: '2026-07-29',
    direction: 'purchase',
    globalTaxCalculation: null,
    totalTaxCents: 0,
    lines: [{
      id: 'line-generic',
      amountCents: -10_00,
      description: null,
      accountQboId: 'holding-generic',
      customerQboId: null,
      classQboId: null,
      taxCodeQboId: null,
      taxAmountCents: null,
      taxInclusiveCents: null,
    }],
  };
}

function freshInput(
  overrides: Partial<FreshLiveInput> = {},
): FreshLiveInput {
  const decision = proposal();
  const snapshot: FreshLiveInput['snapshot'] = {
    transaction: { id: TRANSACTION_ID, revision: 4 },
    date: '2026-07-29',
    signedAmountCents: -10_00,
    currency: 'XTS',
    sourceAccount: { displayName: 'Source account', type: 'BANK' },
    payee: 'Generic vendor',
    candidateCategories: [{ qboId: 'expense-generic', name: 'Generic expense' }],
    tax: { status: 'needs_setup', supportedCalculationModes: [], eligibleReferences: [] },
    tags: [],
    rules: [],
    similarVerifiedTransactions: [],
    featureVersion: 'shadow-core.1',
    configurationVersion: CONFIG_VERSION,
  };
  return {
    snapshot,
    qboSnapshot: qboSnapshot(),
    entityKey: {
      companyId: COMPANY_ID,
      qboType: 'Purchase',
      qboId: 'purchase-generic',
    },
    transaction: {
      id: TRANSACTION_ID,
      qboType: 'Purchase',
      expectedQboId: 'purchase-generic',
      currentQboId: 'purchase-generic',
      expectedSyncToken: '7',
      currentSyncToken: '7',
      revision: 4,
      status: 'PENDING',
      amountCents: -10_00,
      currency: 'XTS',
      qboState: 'current',
    },
    config: {
      companyCurrency: 'XTS',
      minimumConfidence: 0.9,
      configVersion: CONFIG_VERSION,
      provider: 'openrouter',
      decisionModel: 'decision-generic',
      verifierModel: 'verifier-generic',
    },
    coordination: {
      humanStagingPresent: false,
      activeRuleCount: 0,
      ruleConflict: false,
      writeLeaseConflict: false,
    },
    warnings: [],
    taxReference: {
      companyId: COMPANY_ID,
      status: 'needs_setup',
      usingSalesTax: null,
      refreshedAt: null,
      codes: [],
      rates: [],
    },
    providerBinding: 'b'.repeat(64),
    ...overrides,
  };
}

function staged(): StagedCategorization {
  return {
    transactionId: TRANSACTION_ID,
    revision: 5,
    taxCalculation: 'NotApplicable',
    totals: { subtotalCents: -10_00, taxCents: 0, totalCents: -10_00 },
    lines: [{
      idx: 0,
      subtotalCents: -10_00,
      taxCents: 0,
      totalCents: -10_00,
      categoryQboId: 'expense-generic',
      taxCodeQboId: null,
      memo: null,
      tagIds: [],
    }],
    tagIds: [],
  };
}

function deps(
  overrides: Partial<LiveWorkerDeps> = {},
): LiveWorkerDeps & {
  completions: LiveRunCompletion[];
} {
  const completions: LiveRunCompletion[] = [];
  const before = freshInput();
  const decision = proposal();
  const verification = {
    ok: true as const,
    code: 'AGENT_DECISION_VERIFIED' as const,
    message: 'Agent proposal passed deterministic verification.',
    decision,
  };
  const result = {
    status: 'verified' as const,
    decision,
    snapshotRevision: 4,
    decisionProvider: 'openrouter',
    decisionModel: 'decision-generic',
    promptVersion: 'recat-agent-v1' as const,
    schemaVersion: 1 as const,
    durationMs: 10,
    turns: 2,
    toolCalls: 0,
    verificationMode: 'distinct_model' as const,
    diagnosticCode: 'AGENT_RUN_VERIFIED' as const,
  };
  return {
    workerId: 'worker-generic',
    beginRun: vi.fn(async () => ({ runId: RUN_ID })),
    assertLiveAuthority: vi.fn(async () => true),
    locateEntity: vi.fn(async () => before.entityKey),
    withCompanyLease: vi.fn(async (_companyId, _owner, callback) => callback()),
    withEntityLease: vi.fn(async (_key, _owner, callback) => callback()),
    renewAuthority: vi.fn(async () => true),
    loadFreshInput: vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValue(before),
    runDecision: vi.fn(async () => result),
    verifyDecision: vi.fn(async () => verification),
    evaluateEligibility: vi.fn(() => ({
      eligible: true,
      code: 'ELIGIBLE',
      policyVersion: 'purchase-negative-v1',
    })),
    checkpoint: vi.fn(async () => undefined),
    stage: vi.fn(async () => staged()),
    commit: vi.fn(async () => ({
      transactionId: TRANSACTION_ID,
      requestId: JOB_ID,
      ok: true,
      status: 'POSTED',
      outcome: 'VERIFIED',
    })),
    finish: vi.fn(async (_job, _runId, completion) => {
      completions.push(completion);
    }),
    completions,
    ...overrides,
  };
}

describe('guarded live worker', () => {
  it.each([
    ['exact home-currency reference', { CurrencyRef: { value: 'XTS' } }, []],
    ['missing reference', {}, ['CURRENCY_AUTHORITY_UNAVAILABLE']],
    ['malformed reference', { CurrencyRef: { value: 7 } }, ['CURRENCY_AUTHORITY_UNAVAILABLE']],
    ['different reference', { CurrencyRef: { value: 'XXX' } }, ['MULTI_CURRENCY_REVIEW_REQUIRED']],
    ['unit exchange rate', { CurrencyRef: { value: 'XTS' }, ExchangeRate: 1 }, ['MULTI_CURRENCY_REVIEW_REQUIRED']],
    ['non-unit exchange rate', { CurrencyRef: { value: 'XTS' }, ExchangeRate: 1.25 }, ['MULTI_CURRENCY_REVIEW_REQUIRED']],
  ] as const)('requires provider-backed home currency: %s', (_label, raw, expected) => {
    expect(homeCurrencyAuthorityWarnings(raw, 'XTS')).toEqual(expected);
  });

  it('rechecks QBO and local freshness immediately before staging and never writes stale output', async () => {
    const before = freshInput();
    const after = freshInput({
      qboSnapshot: qboSnapshot('8'),
      transaction: {
        ...before.transaction,
        currentSyncToken: '8',
        qboState: 'drifted',
      },
    });
    const d = deps({
      loadFreshInput: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'QBO_STATE_DRIFT',
    })]);
  });

  it('rejects accounting-body drift even when the QBO SyncToken is unchanged', async () => {
    const before = freshInput();
    const after = freshInput({
      qboSnapshot: {
        ...qboSnapshot(),
        lines: [{
          ...qboSnapshot().lines[0]!,
          accountQboId: 'changed-account',
        }],
      },
    });
    const d = deps({
      loadFreshInput: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'QBO_STATE_DRIFT',
    })]);
  });

  it('rejects a matching-SyncToken Purchase whose provider total differs from the pending amount before inference', async () => {
    const staleAmount = freshInput({
      qboSnapshot: {
        ...qboSnapshot(),
        totalCents: -12_00,
        lines: [{
          ...qboSnapshot().lines[0]!,
          amountCents: -12_00,
        }],
      },
    });
    const d = deps({
      loadFreshInput: vi.fn(async () => staleAmount),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.runDecision).not.toHaveBeenCalled();
    expect(d.verifyDecision).not.toHaveBeenCalled();
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'QBO_AMOUNT_DRIFT',
    })]);
  });

  it('rejects a config identity change after verification and before staging', async () => {
    const before = freshInput();
    const after = freshInput({
      config: {
        ...before.config,
        provider: 'custom',
        decisionModel: 'changed-decision',
      },
    });
    const d = deps({
      loadFreshInput: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'FRESHNESS_REQUIRED',
    })]);
  });

  it('rejects a provider-binding authority change after successful verification', async () => {
    const assertLiveAuthority = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const d = deps({ assertLiveAuthority });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'LIVE_AUTHORITY_DENIED',
    })]);
  });

  it.each([
    ['LIVE_VERIFIER_TIMEOUT', 'failed'],
    ['LIVE_VERIFIER_UNAVAILABLE', 'failed'],
    ['MODEL_HEALTH_UNAVAILABLE', 'failed'],
    ['LIVE_VERIFIER_RESPONSE_INVALID', 'failed'],
    ['LIVE_VERIFIER_IDENTITY_MISMATCH', 'failed'],
    ['LIVE_VERIFICATION_INPUT_INVALID', 'failed'],
    ['VERIFIER_NOT_DISTINCT', 'failed'],
  ] as const)('persists %s as a truthful verifier failure instead of an abstention', async (
    code,
    status,
  ) => {
    const d = deps({
      verifyDecision: vi.fn(async () => {
        throw Object.assign(new Error('safe verifier failure'), { code });
      }),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status,
      errorCode: code,
    })]);
  });

  it('keeps an explicit schema-valid distinct-review rejection as an abstention', async () => {
    const d = deps({
      verifyDecision: vi.fn(async () => ({
        ok: false,
        code: 'AGENT_DISTINCT_REVIEW_REJECTED',
        message: 'Distinct review rejected the proposal.',
      })),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'AGENT_DISTINCT_REVIEW_REJECTED',
    })]);
  });

  it('rejects a tax-reference refresh change after inference', async () => {
    const before = freshInput();
    const after = freshInput({
      taxReference: {
        companyId: COMPANY_ID,
        status: 'needs_setup',
        usingSalesTax: null,
        refreshedAt: null,
        codes: [],
        rates: [{
          qboId: 'rate-generic',
          name: 'Generic rate',
          description: null,
          active: true,
          rateValue: 5,
          sourceUpdatedAt: '2026-07-29T12:00:01.000Z',
        }],
      },
    });
    const d = deps({
      loadFreshInput: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'TAX_REFERENCE_CHANGED',
    })]);
  });

  it('renews authority during a slow QBO fetch and stops when the job lease is lost', async () => {
    vi.useFakeTimers();
    let releaseFetch!: (value: FreshLiveInput) => void;
    const loadFreshInput = vi.fn(() => new Promise<FreshLiveInput>((resolve) => {
      releaseFetch = resolve;
    }));
    const renewAuthority = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const d = deps({
      loadFreshInput,
      renewAuthority,
      renewalIntervalMs: 100,
    });

    try {
      const running = runClaimedLiveJob(job(), d);
      await vi.advanceTimersByTimeAsync(100);
      releaseFetch(freshInput());
      await running;

      expect(renewAuthority.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(d.stage).not.toHaveBeenCalled();
      expect(d.commit).not.toHaveBeenCalled();
      expect(d.completions).toEqual([expect.objectContaining({
        status: 'abstain',
        errorCode: 'AGENT_RUN_LEASE_LOST',
      })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes UI, MCP, and live writers on the exact entity lease', async () => {
    const d = deps({
      withEntityLease: vi.fn(async () => {
        const error = new Error('busy');
        Object.assign(error, { code: 'ENTITY_BUSY' });
        throw error;
      }),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'abstain',
      errorCode: 'ENTITY_BUSY',
    })]);
  });

  it('records posted success only after the shared writeback returns VERIFIED readback', async () => {
    const d = deps();

    await runClaimedLiveJob(job(), d);

    expect(d.stage).toHaveBeenCalledOnce();
    expect(d.commit).toHaveBeenCalledWith({
      transactionId: TRANSACTION_ID,
      companyId: COMPANY_ID,
      expectedRevision: 5,
      requestId: JOB_ID,
    }, OWNER, expect.objectContaining({
      providerBinding: 'b'.repeat(64),
      taxAuthorityDigest: expect.any(String),
    }), freshInput().entityKey);
    expect(d.completions).toEqual([expect.objectContaining({
      status: 'posted_verified',
      errorCode: null,
    })]);
    expect(vi.mocked(d.finish).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(d.commit).mock.invocationCallOrder[0]!);
  });

  it('does not swallow a failed terminal write and retries truthful finalization once', async () => {
    const finish = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('lease race'), {
        code: 'AGENT_RUN_LEASE_LOST',
      }))
      .mockResolvedValueOnce(undefined);
    const d = deps({ finish });

    await runClaimedLiveJob(job(), d);

    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish.mock.calls[0]?.[2]).toMatchObject({ status: 'posted_verified' });
    expect(finish.mock.calls[1]?.[2]).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_RUN_LEASE_LOST',
    });
  });

  it('persists guarded mutation authority loss as a failed retryable lifecycle', async () => {
    const d = deps({
      commit: vi.fn(async () => {
        throw Object.assign(new Error('guarded authority changed'), {
          code: 'LIVE_AUTHORITY_DENIED',
        });
      }),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.completions).toEqual([expect.objectContaining({
      status: 'failed',
      errorCode: 'LIVE_AUTHORITY_DENIED',
    })]);
  });

  it.each([
    ['DRY_RUN', 'dry_run'],
    ['UNCHANGED', 'unchanged'],
    ['UNCERTAIN', 'uncertain'],
    ['IN_PROGRESS', 'retryable'],
    ['RETRYABLE', 'retryable'],
  ] as const)('never calls a %s writeback outcome posted', async (outcome, status) => {
    const d = deps({
      commit: vi.fn(async () => ({
        transactionId: TRANSACTION_ID,
        requestId: JOB_ID,
        ok: outcome === 'DRY_RUN' || outcome === 'UNCHANGED',
        status: outcome === 'DRY_RUN' ? 'DRY_RUN' : outcome === 'UNCERTAIN' ? 'ERROR' : 'PENDING',
        outcome,
      })),
    });

    await runClaimedLiveJob(job(), d);

    expect(d.completions).toEqual([expect.objectContaining({ status })]);
    expect(d.completions[0]?.status).not.toBe('posted_verified');
  });

  it.each([
    ['Deposit', 1_000, 'ENTITY_UNSUPPORTED'],
    ['Purchase', 1_000, 'REFUND_REVIEW_REQUIRED'],
  ] as const)('does not infer or mutate unsupported %s amount %d', async (qboType, amountCents, code) => {
    const input = freshInput({
      entityKey: { companyId: COMPANY_ID, qboType, qboId: 'entity-generic' },
      transaction: {
        ...freshInput().transaction,
        qboType,
        amountCents,
      },
    });
    const d = deps({
      loadFreshInput: vi.fn(async () => input),
      evaluateEligibility: vi.fn(() => ({
        eligible: false,
        code,
        policyVersion: 'purchase-negative-v1',
      })) as LiveWorkerDeps['evaluateEligibility'],
    });

    await runClaimedLiveJob(job(), d);

    expect(d.runDecision).not.toHaveBeenCalled();
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('uses the deterministic job request ID on retry so shared writeback resumes one attempt', async () => {
    const d = deps();
    await runClaimedLiveJob(job(), d);
    await runClaimedLiveJob(job(), d);

    expect(vi.mocked(d.commit).mock.calls.map(([input]) => input.requestId))
      .toEqual([JOB_ID, JOB_ID]);
  });
});

describe('agent final-total staging reconciliation', () => {
  it('passes TaxInclusive and NotApplicable final totals through exactly', () => {
    for (const taxCalculation of ['TaxInclusive', 'NotApplicable'] as const) {
      const input = proposal({
        taxCalculation,
        lines: [{
          grossCents: -10_00,
          categoryQboId: 'expense-generic',
          taxCodeQboId: taxCalculation === 'NotApplicable' ? null : 'tax-generic',
          memo: null,
          tagIds: [],
        }],
      } as Partial<Extract<ReturnType<typeof proposal>, { kind: 'proposal' }>>);
      const reconciled = reconcileLiveProposalForStaging(
        COMPANY_ID,
        input,
        taxCalculation === 'NotApplicable'
          ? { companyId: COMPANY_ID, codes: [], rates: [] }
          : {
              companyId: COMPANY_ID,
              codes: [{
                qboId: 'tax-generic',
                name: 'Generic tax',
                description: null,
                active: true,
                taxable: true,
                purchaseRates: [{ taxRateQboId: 'rate-generic', taxTypeApplicable: 'TaxOnAmount' }],
                sourceUpdatedAt: null,
              }],
              rates: [{
                qboId: 'rate-generic',
                name: 'Generic rate',
                description: null,
                active: true,
                rateValue: 10,
                sourceUpdatedAt: null,
              }],
            },
      );
      expect(reconciled.lines.map((line) => line.grossCents)).toEqual([-10_00]);
    }
  });

  it('converts TaxExcluded final totals to bases and proves the shared calculator round trip', () => {
    const input = proposal({
      taxCalculation: 'TaxExcluded',
      lines: [{
        grossCents: -11_00,
        categoryQboId: 'expense-generic',
        taxCodeQboId: 'tax-generic',
        memo: null,
        tagIds: [],
      }],
    });
    const reconciled = reconcileLiveProposalForStaging(COMPANY_ID, input, {
      companyId: COMPANY_ID,
      codes: [{
        qboId: 'tax-generic',
        name: 'Generic tax',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'rate-generic', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      }],
      rates: [{
        qboId: 'rate-generic',
        name: 'Generic rate',
        description: null,
        active: true,
        rateValue: 10,
        sourceUpdatedAt: null,
      }],
    });

    expect(reconciled).toMatchObject<CategorizationProposal>({
      taxCalculation: 'TaxExcluded',
      lines: [expect.objectContaining({ grossCents: -10_00 })],
      tagIds: [],
    });
  });

  it('round-trips a multi-line TaxExcluded remainder allocation through the shared oracle', () => {
    const reference = {
      companyId: COMPANY_ID,
      codes: [{
        qboId: 'tax-generic',
        name: 'Generic tax',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'rate-generic', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      }],
      rates: [{
        qboId: 'rate-generic',
        name: 'Generic rate',
        description: null,
        active: true,
        rateValue: 5,
        sourceUpdatedAt: null,
      }],
    } as const;
    const input = proposal({
      taxCalculation: 'TaxExcluded',
      lines: [
        {
          grossCents: -10_51,
          categoryQboId: 'expense-generic',
          taxCodeQboId: 'tax-generic',
          memo: null,
          tagIds: [],
        },
        {
          grossCents: -10_50,
          categoryQboId: 'expense-other',
          taxCodeQboId: 'tax-generic',
          memo: null,
          tagIds: [],
        },
      ],
    });

    const reconciled = reconcileLiveProposalForStaging(COMPANY_ID, input, reference);
    const forward = calculatePurchaseTransaction({
      companyId: COMPANY_ID,
      taxCalculation: 'TaxExcluded',
      lines: reconciled.lines.map((line) => ({
        grossCents: line.grossCents,
        taxCodeQboId: line.taxCodeQboId ?? '',
      })),
    }, {
      companyId: COMPANY_ID,
      codes: [...reference.codes],
      rates: [...reference.rates],
    });

    expect(forward).toMatchObject({
      eligible: true,
      grossCents: -20_01,
      taxCents: -1_00,
    });
    if (!forward.eligible) throw new Error('Expected exact tax reference eligibility.');
    expect(forward.lines.map((line) => line.netCents + line.taxCents))
      .toEqual([-10_51, -10_50]);
  });

  it('fails closed when a TaxExcluded final cent cannot be reconciled exactly', () => {
    const input = proposal({
      taxCalculation: 'TaxExcluded',
      lines: [{
        grossCents: -1,
        categoryQboId: 'expense-generic',
        taxCodeQboId: 'tax-generic',
        memo: null,
        tagIds: [],
      }],
    });

    expect(() => reconcileLiveProposalForStaging(COMPANY_ID, input, {
      companyId: COMPANY_ID,
      codes: [{
        qboId: 'tax-generic',
        name: 'Generic tax',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'rate-generic', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      }],
      rates: [{
        qboId: 'rate-generic',
        name: 'Generic rate',
        description: null,
        active: true,
        rateValue: 999.999999,
        sourceUpdatedAt: null,
      }],
    })).toThrowError(expect.objectContaining({ code: 'TAX_ROUNDING_AMBIGUOUS' }));
  });
});
