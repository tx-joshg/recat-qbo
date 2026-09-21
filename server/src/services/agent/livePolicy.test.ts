import { describe, expect, it } from 'vitest';
import {
  agentDecisionSchemaVersion,
  parseAgentDecision,
  type AgentDecision,
} from './core/decision.js';
import {
  AGENT_MODEL_PROMPT_VERSION,
  type AgentModelProvider,
} from './core/model.js';
import type { AgentRunResult } from './core/runner.js';
import {
  buildAgentSnapshot,
  type AgentSnapshotSource,
  type AgentTransactionSnapshot,
} from './core/snapshot.js';
import {
  verifyAgentDecision,
  type AgentVerification,
} from './core/verifier.js';
import {
  evaluateLiveEligibility,
  LIVE_ELIGIBILITY_VERSION,
  type LiveEligibilityInput,
} from './livePolicy.js';

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TRANSACTION_ID = '22222222-2222-4222-8222-222222222222';
const TAG_A_ID = '33333333-3333-4333-8333-333333333333';
const TAG_B_ID = '44444444-4444-4444-8444-444444444444';
const HISTORY_A_ID = '55555555-5555-4555-8555-555555555555';
const HISTORY_CATEGORY_B_ID = '66666666-6666-4666-8666-666666666666';
const HISTORY_TAX_B_ID = '77777777-7777-4777-8777-777777777777';

function source(): AgentSnapshotSource {
  return {
    transaction: { id: TRANSACTION_ID, revision: 7 },
    date: '2026-07-27',
    signedAmountCents: -1000,
    currency: 'XTS',
    sourceAccount: { displayName: 'Source account', type: 'BANK' },
    payee: 'Test counterparty',
    candidateCategories: [
      { qboId: 'category-a', name: 'Category alpha' },
      { qboId: 'category-b', name: 'Category beta' },
    ],
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxInclusive', 'TaxExcluded'],
      eligibleReferences: [
        { qboId: 'tax-a', label: 'Reference alpha' },
        { qboId: 'tax-b', label: 'Reference beta' },
      ],
    },
    tags: [
      { id: TAG_A_ID, name: 'Reference tag alpha' },
      { id: TAG_B_ID, name: 'Reference tag beta' },
    ],
    rules: [],
    similarVerifiedTransactions: [
      similarTransaction(HISTORY_A_ID, 'category-a', 'tax-a'),
      similarTransaction(HISTORY_CATEGORY_B_ID, 'category-b', 'tax-a'),
      similarTransaction(HISTORY_TAX_B_ID, 'category-a', 'tax-b'),
    ],
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config-v1',
  };
}

function similarTransaction(
  transactionId: string,
  categoryQboId: string,
  taxCodeQboId: string,
): AgentSnapshotSource['similarVerifiedTransactions'][number] {
  return {
    transactionId,
    date: '2026-07-20',
    signedAmountCents: -1000,
    currency: 'XTS',
    payee: 'Historical test counterparty',
    taxCalculation: 'TaxExcluded',
    lines: [{
      signedGrossCents: -1000,
      categoryQboId,
      taxCodeQboId,
      tagIds: [TAG_A_ID],
    }],
    tagIds: [TAG_A_ID],
    verifiedAt: '2026-07-21T00:00:00.000Z',
  };
}

interface ProposalOptions {
  categoryQboId?: string;
  taxCodeQboId?: string;
  tagIds?: string[];
  historyTransactionId?: string;
  confidence?: number;
  grossCents?: number;
}

function proposal(options: ProposalOptions = {}): AgentDecision {
  return parseAgentDecision({
    decision: {
      kind: 'proposal',
      confidence: options.confidence ?? 0.9,
      taxCalculation: 'TaxExcluded',
      tagIds: options.tagIds ?? [TAG_A_ID],
      evidence: [{
        kind: 'similar_transaction',
        transactionId: options.historyTransactionId ?? HISTORY_A_ID,
      }],
      rationale: 'Synthetic proposal.',
      lines: [{
        grossCents: options.grossCents ?? -1000,
        categoryQboId: options.categoryQboId ?? 'category-a',
        taxCodeQboId: options.taxCodeQboId ?? 'tax-a',
        memo: null,
        tagIds: options.tagIds ?? [TAG_A_ID],
      }],
    },
  });
}

interface TestInput {
  snapshot: AgentTransactionSnapshot;
  transaction: {
    id: string;
    qboType: string;
    expectedQboId: string;
    currentQboId: string;
    expectedSyncToken: string;
    currentSyncToken: string;
    revision: number;
    status: string;
    amountCents: number;
    currency: string;
    qboState: 'current' | 'drifted';
  };
  config: {
    companyCurrency: string;
    minimumConfidence: number;
    configVersion: string;
    provider: AgentModelProvider;
    decisionModel: string;
    verifierModel: string;
  };
  reviewedRun: {
    transactionId: string;
    configVersion: string;
    verifierModel: string;
    result: AgentRunResult;
    verification: AgentVerification;
  };
  coordination: {
    humanStagingPresent: boolean;
    activeRuleCount: number;
    ruleConflict: boolean;
    writeLeaseConflict: boolean;
  };
  warnings: string[];
}

function run(snapshot: AgentTransactionSnapshot, decision: AgentDecision): AgentRunResult {
  return {
    status: 'verified',
    decision,
    snapshotRevision: snapshot.transaction.revision,
    decisionProvider: 'fake',
    decisionModel: 'decision-model',
    promptVersion: AGENT_MODEL_PROMPT_VERSION,
    schemaVersion: agentDecisionSchemaVersion,
    durationMs: 1,
    turns: 2,
    toolCalls: 0,
    verificationMode: 'distinct_model',
    diagnosticCode: 'AGENT_RUN_VERIFIED',
  };
}

function fixture(overrides: Partial<TestInput> = {}): TestInput {
  const snapshot = buildAgentSnapshot(source());
  const decision = proposal();
  const input = {
    snapshot,
    transaction: {
      id: TRANSACTION_ID,
      qboType: 'Purchase',
      expectedQboId: 'purchase-a',
      currentQboId: 'purchase-a',
      expectedSyncToken: '7',
      currentSyncToken: '7',
      revision: 7,
      status: 'PENDING',
      amountCents: -1000,
      currency: 'XTS',
      qboState: 'current' as const,
    },
    config: {
      companyCurrency: 'XTS',
      minimumConfidence: 0.9,
      configVersion: 'config-v1',
      provider: 'fake',
      decisionModel: 'decision-model',
      verifierModel: 'verifier-model',
    },
    reviewedRun: {
      transactionId: TRANSACTION_ID,
      configVersion: 'config-v1',
      verifierModel: 'verifier-model',
      result: run(snapshot, decision),
      verification: verifyAgentDecision(snapshot, decision),
    },
    coordination: {
      humanStagingPresent: false,
      activeRuleCount: 0,
      ruleConflict: false,
      writeLeaseConflict: false,
    },
    warnings: [],
    ...overrides,
  } as TestInput;
  return input;
}

function withTransaction(
  input: TestInput,
  overrides: Partial<TestInput['transaction']>,
): TestInput {
  return { ...input, transaction: { ...input.transaction, ...overrides } };
}

function withConfig(
  input: TestInput,
  overrides: Partial<TestInput['config']>,
): TestInput {
  return { ...input, config: { ...input.config, ...overrides } };
}

function withReviewedRun(
  input: TestInput,
  overrides: Partial<TestInput['reviewedRun']>,
): TestInput {
  return { ...input, reviewedRun: { ...input.reviewedRun, ...overrides } };
}

function withResult(
  input: TestInput,
  overrides: Record<string, unknown>,
): TestInput {
  return withReviewedRun(input, {
    result: {
      ...input.reviewedRun.result,
      ...overrides,
    } as unknown as AgentRunResult,
  });
}

function expectDenied(input: unknown, code: string): void {
  expect(evaluateLiveEligibility(
    input as Parameters<typeof evaluateLiveEligibility>[0],
  )).toEqual({
    eligible: false,
    code,
    policyVersion: LIVE_ELIGIBILITY_VERSION,
  });
}

describe('evaluateLiveEligibility', () => {
  it('permits only one fresh, independently reviewed PR6 run', () => {
    expect(evaluateLiveEligibility(fixture())).toEqual({
      eligible: true,
      code: 'ELIGIBLE',
      policyVersion: LIVE_ELIGIBILITY_VERSION,
    });
  });

  it.each([
    [
      'category allocation',
      proposal({
        categoryQboId: 'category-b',
        historyTransactionId: HISTORY_CATEGORY_B_ID,
      }),
    ],
    [
      'tax allocation',
      proposal({
        taxCodeQboId: 'tax-b',
        historyTransactionId: HISTORY_TAX_B_ID,
      }),
    ],
    [
      'tag allocation',
      proposal({ tagIds: [TAG_B_ID] }),
    ],
  ] as const)('rejects proposal B when the deterministic review approved proposal A: %s', (
    _name,
    differentDecision,
  ) => {
    expect(verifyAgentDecision(fixture().snapshot, differentDecision).ok).toBe(true);
    expectDenied(
      withResult(fixture(), { decision: differentDecision }),
      'VERIFICATION_REQUIRED',
    );
  });

  it.each([
    ['run status', (input: TestInput) => withResult(input, { status: 'abstain' })],
    ['run snapshot revision', (input: TestInput) => withResult(input, { snapshotRevision: 8 })],
    ['run decision provider', (input: TestInput) => withResult(input, { decisionProvider: 'custom' })],
    ['run decision model', (input: TestInput) => withResult(input, { decisionModel: 'other-model' })],
    ['run prompt version', (input: TestInput) => withResult(input, { promptVersion: 'agent-model-v2' })],
    ['run schema version', (input: TestInput) => withResult(input, { schemaVersion: 2 })],
    ['run verification mode', (input: TestInput) => withResult(input, { verificationMode: 'same_model' })],
    ['run diagnostic code', (input: TestInput) => withResult(input, { diagnosticCode: 'AGENT_RUN_REVIEW_CONFLICT' })],
    ['run transaction ID', (input: TestInput) => withReviewedRun(input, { transactionId: OTHER_TRANSACTION_ID })],
    ['run configuration version', (input: TestInput) => withReviewedRun(input, { configVersion: 'config-v2' })],
    ['run verifier model', (input: TestInput) => withReviewedRun(input, { verifierModel: 'other-model' })],
    ['current provider', (input: TestInput) => withConfig(input, { provider: 'custom' })],
    ['current decision model', (input: TestInput) => withConfig(input, { decisionModel: 'other-model' })],
    ['current verifier model', (input: TestInput) => withConfig(input, { verifierModel: 'other-model' })],
    ['non-distinct configured models', (input: TestInput) => withConfig(input, { verifierModel: 'decision-model' })],
  ] as const)('rejects a mismatched reviewed identity: %s', (_name, mismatch) => {
    expectDenied(mismatch(fixture()), 'VERIFICATION_REQUIRED');
  });

  it.each([
    [
      'deterministic decision',
      (input: TestInput) => withReviewedRun(input, {
        verification: verifyAgentDecision(
          input.snapshot,
          proposal({ tagIds: [TAG_B_ID] }),
        ),
      }),
    ],
    [
      'deterministic success',
      (input: TestInput) => withReviewedRun(input, {
        verification: verifyAgentDecision(
          input.snapshot,
          proposal({ grossCents: -999 }),
        ),
      }),
    ],
    [
      'deterministic diagnostic',
      (input: TestInput) => withReviewedRun(input, {
        verification: {
          ...input.reviewedRun.verification,
          code: 'AGENT_DECISION_ABSTAIN',
        } as AgentVerification,
      }),
    ],
  ] as const)('requires the exact successful deterministic proof: %s', (_name, mismatch) => {
    expectDenied(mismatch(fixture()), 'VERIFICATION_REQUIRED');
  });

  it.each([
    [
      'snapshot/current transaction ID',
      (input: TestInput) => withTransaction(input, { id: OTHER_TRANSACTION_ID }),
    ],
    [
      'snapshot/current revision',
      (input: TestInput) => withTransaction(input, { revision: 8 }),
    ],
    [
      'snapshot/current amount',
      (input: TestInput) => withTransaction(input, { amountCents: -999 }),
    ],
    [
      'snapshot/current configuration version',
      (input: TestInput) => withConfig(input, { configVersion: 'config-v2' }),
    ],
    [
      'snapshot/current feature version',
      (input: TestInput) => {
        const snapshot = buildAgentSnapshot({
          ...source(),
          featureVersion: 'shadow-core.2',
        });
        const decision = proposal();
        return {
          ...input,
          snapshot,
          reviewedRun: {
            ...input.reviewedRun,
            result: run(snapshot, decision),
            verification: verifyAgentDecision(snapshot, decision),
          },
        };
      },
    ],
  ] as const)('rejects a mismatched freshness authority: %s', (_name, mismatch) => {
    expectDenied(mismatch(fixture()), 'FRESHNESS_REQUIRED');
  });

  it.each([
    [
      'expected QBO ID',
      (input: TestInput) => withTransaction(input, { expectedQboId: 'purchase-b' }),
    ],
    [
      'current QBO ID',
      (input: TestInput) => withTransaction(input, { currentQboId: 'purchase-b' }),
    ],
    [
      'expected SyncToken',
      (input: TestInput) => withTransaction(input, { expectedSyncToken: '8' }),
    ],
    [
      'current SyncToken',
      (input: TestInput) => withTransaction(input, { currentSyncToken: '8' }),
    ],
    [
      'explicit QBO drift state',
      (input: TestInput) => withTransaction(input, { qboState: 'drifted' }),
    ],
  ] as const)('rejects current QBO authority drift: %s', (_name, mismatch) => {
    expectDenied(mismatch(fixture()), 'QBO_STATE_DRIFT');
  });

  it.each([
    ['Deposit', 'ENTITY_UNSUPPORTED', { qboType: 'Deposit' }],
    ['JournalEntry', 'ENTITY_UNSUPPORTED', { qboType: 'JournalEntry' }],
    ['Transfer', 'ENTITY_UNSUPPORTED', { qboType: 'Transfer' }],
    ['Bill', 'ENTITY_UNSUPPORTED', { qboType: 'Bill' }],
    ['positive Purchase', 'REFUND_REVIEW_REQUIRED', { amountCents: 1000 }],
    ['zero Purchase', 'REFUND_REVIEW_REQUIRED', { amountCents: 0 }],
    ['non-pending status', 'FRESHNESS_REQUIRED', { status: 'POSTED' }],
  ] as const)('denies %s with a stable code', (_name, code, overrides) => {
    expectDenied(withTransaction(fixture(), overrides), code);
  });

  it.each([
    [
      'foreign transaction currency',
      (input: TestInput) => withTransaction(input, { currency: 'XXX' }),
    ],
    [
      'foreign company currency',
      (input: TestInput) => withConfig(input, { companyCurrency: 'XXX' }),
    ],
  ] as const)('denies %s', (_name, mismatch) => {
    expectDenied(mismatch(fixture()), 'MULTI_CURRENCY_REVIEW_REQUIRED');
  });

  it.each([
    [
      'human staging',
      (input: TestInput) => ({
        ...input,
        coordination: { ...input.coordination, humanStagingPresent: true },
      }),
      'HUMAN_STAGING_PRESENT',
    ],
    [
      'active rule',
      (input: TestInput) => ({
        ...input,
        coordination: { ...input.coordination, activeRuleCount: 1 },
      }),
      'ACTIVE_RULE_PRESENT',
    ],
    [
      'rule conflict',
      (input: TestInput) => ({
        ...input,
        coordination: { ...input.coordination, ruleConflict: true },
      }),
      'RULE_CONFLICT',
    ],
    [
      'write lease conflict',
      (input: TestInput) => ({
        ...input,
        coordination: { ...input.coordination, writeLeaseConflict: true },
      }),
      'WRITE_LEASE_CONFLICT',
    ],
    [
      'warning',
      (input: TestInput) => ({ ...input, warnings: ['opaque-warning'] }),
      'PROPOSAL_WARNING',
    ],
  ] as const)('denies %s', (_name, mismatch, code) => {
    expectDenied(mismatch(fixture()), code);
  });

  it('denies an abstention from the exact reviewed run', () => {
    const abstention = parseAgentDecision({
      decision: {
        kind: 'abstain',
        reasonCode: 'INSUFFICIENT_CONTEXT',
        rationale: 'Synthetic abstention.',
      },
    });
    const input = fixture();
    expectDenied(withReviewedRun(input, {
      result: run(input.snapshot, abstention),
      verification: verifyAgentDecision(input.snapshot, abstention),
    }), 'DECISION_ABSTAINED');
  });

  it('denies confidence below the exact threshold', () => {
    const lowConfidence = proposal({ confidence: 0.899999 });
    const input = fixture();
    expectDenied(withReviewedRun(input, {
      result: run(input.snapshot, lowConfidence),
      verification: verifyAgentDecision(input.snapshot, lowConfidence),
    }), 'CONFIDENCE_LOW');
  });

  it('denies an invalid proposal schema', () => {
    const input = fixture();
    expectDenied(withResult(input, {
      decision: {
        ...input.reviewedRun.result.decision,
        taxCalculation: 'UnknownTaxMode',
      },
    }), 'PROPOSAL_INVALID');
  });

  it.each([
    ['unbalanced total', proposal({ grossCents: -999 })],
    ['unavailable category', proposal({ categoryQboId: 'category-unavailable' })],
    ['unavailable tax reference', proposal({ taxCodeQboId: 'tax-unavailable' })],
    [
      'unavailable tag',
      proposal({ tagIds: ['99999999-9999-4999-8999-999999999999'] }),
    ],
  ] as const)('denies a deterministically invalid proposal: %s', (_name, invalid) => {
    const input = fixture();
    expectDenied(withReviewedRun(input, {
      result: run(input.snapshot, invalid),
      verification: verifyAgentDecision(input.snapshot, invalid),
    }), 'PROPOSAL_INVALID');
  });

  it('denies an applicable snapshot rule even if coordination reports none', () => {
    const snapshot = buildAgentSnapshot({
      ...source(),
      rules: [{
        id: '88888888-8888-4888-8888-888888888888',
        priority: 1,
        matchField: 'payee',
        matchText: 'test',
        categoryQboId: 'category-a',
        taxCalculation: 'TaxExcluded',
        taxCodeQboId: 'tax-a',
        tagIds: [TAG_A_ID],
      }],
    });
    const decision = proposal();
    expectDenied(fixture({
      snapshot,
      reviewedRun: {
        ...fixture().reviewedRun,
        result: run(snapshot, decision),
        verification: verifyAgentDecision(snapshot, decision),
      },
    }), 'ACTIVE_RULE_PRESENT');
  });

  it.each([
    [null],
    [{}],
    [{ transaction: { qboType: 'Purchase' } }],
    [withConfig(fixture(), { minimumConfidence: Number.NaN })],
    [withTransaction(fixture(), { expectedQboId: '', currentSyncToken: '' })],
    [{ ...fixture(), warnings: [123] }],
    [{
      ...fixture(),
      coordination: { ...fixture().coordination, activeRuleCount: -1 },
    }],
    [{
      ...fixture(),
      reviewedRun: {
        ...fixture().reviewedRun,
        result: { status: 'verified' },
      },
    }],
  ])('fails closed for malformed runtime input %#', (input) => {
    expectDenied(input, 'INPUT_INVALID');
  });

  it('rejects getter-backed values without invoking the accessor', () => {
    const input = fixture() as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, 'reviewedRun', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return fixture().reviewedRun;
      },
    });
    expectDenied(input, 'INPUT_INVALID');
    expect(reads).toBe(0);
  });

  it('rejects class-backed root and nested records', () => {
    class InputRecord {
      constructor(base: TestInput) {
        Object.assign(this, base);
      }
    }
    class RunRecord {
      constructor(base: TestInput['reviewedRun']) {
        Object.assign(this, base);
      }
    }
    expectDenied(new InputRecord(fixture()), 'INPUT_INVALID');
    const nested = fixture();
    nested.reviewedRun = new RunRecord(nested.reviewedRun) as unknown as TestInput['reviewedRun'];
    expectDenied(nested, 'INPUT_INVALID');
  });

  it('rejects transparent root and nested proxies', () => {
    expectDenied(new Proxy(fixture(), {}), 'INPUT_INVALID');
    const nested = fixture();
    nested.reviewedRun = new Proxy(nested.reviewedRun, {});
    expectDenied(nested, 'INPUT_INVALID');
  });

  it('rejects mutation hooks without allowing them to alter authorization', () => {
    const input = fixture();
    let mutations = 0;
    Object.defineProperty(input.coordination, 'humanStagingPresent', {
      configurable: true,
      enumerable: true,
      get: () => {
        mutations += 1;
        input.reviewedRun.result = withResult(
          input,
          { decision: proposal({ tagIds: [TAG_B_ID] }) },
        ).reviewedRun.result;
        return false;
      },
    });
    expectDenied(input, 'INPUT_INVALID');
    expect(mutations).toBe(0);
  });

  it.each([
    [{ ...fixture(), unexpected: true }],
    [{
      ...fixture(),
      config: { ...fixture().config, unexpected: true },
    }],
    [{
      ...fixture(),
      reviewedRun: { ...fixture().reviewedRun, unexpected: true },
    }],
    [{
      ...fixture(),
      reviewedRun: {
        ...fixture().reviewedRun,
        result: { ...fixture().reviewedRun.result, unexpected: true },
      },
    }],
  ])('rejects unexpected wrapper keys %#', (input) => {
    expectDenied(input, 'INPUT_INVALID');
  });

  it('preserves TaxExcluded totals without exposing or transforming the proposal', () => {
    const result = evaluateLiveEligibility(fixture());
    expect(result).toEqual(expect.objectContaining({ eligible: true }));
    expect(result).not.toHaveProperty('proposal');
  });

  it('does not expose provider, warning, or accounting content in a denial', () => {
    const opaque = 'opaque-provider-content-do-not-return';
    const result = evaluateLiveEligibility(
      { ...fixture(), warnings: [opaque] } as unknown as Parameters<
        typeof evaluateLiveEligibility
      >[0],
    );
    expect(JSON.stringify(result)).not.toContain(opaque);
    expect(Object.keys(result).sort()).toEqual([
      'code',
      'eligible',
      'policyVersion',
    ]);
  });
});
