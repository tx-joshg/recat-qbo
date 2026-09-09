import { describe, expect, it, vi } from 'vitest';
import type { AgentDecision } from './decision.js';
import {
  AgentModelError,
  AGENT_MODEL_PROMPT_VERSION,
  type AgentModel,
  type AgentModelErrorCode,
  type AgentModelIdentity,
  type AgentModelInput,
  type AgentModelTurn,
} from './model.js';
import {
  DEFAULT_AGENT_LIMITS,
  runShadowDecision,
  type AgentRunnerClock,
} from './runner.js';
import {
  agentDecisionSchemaVersion,
} from './decision.js';
import {
  buildAgentSnapshot,
  type AgentSnapshotSource,
  type AgentTransactionSnapshot,
} from './snapshot.js';
import { verifyAgentDecision } from './verifier.js';

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const RULE_ID = '22222222-2222-4222-8222-222222222222';
const RULE_TAX_B_ID = '22222222-2222-4222-8222-222222222223';
const HISTORY_ID = '33333333-3333-4333-8333-333333333333';
const TAG_ID = '44444444-4444-4444-8444-444444444444';

function snapshotSource(
  overrides: Partial<AgentSnapshotSource> = {},
): AgentSnapshotSource {
  return {
    transaction: { id: TRANSACTION_ID, revision: 9 },
    date: '2026-07-20',
    signedAmountCents: -10_00,
    currency: 'CAD',
    sourceAccount: { displayName: 'Generic account', type: 'BANK' },
    payee: 'Generic merchant',
    candidateCategories: [
      { qboId: 'expense-a', name: 'Expense A' },
      { qboId: 'expense-b', name: 'Expense B' },
    ],
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxExcluded'],
      eligibleReferences: [
        { qboId: 'tax-a', label: 'Tax A' },
        { qboId: 'tax-b', label: 'Tax B' },
      ],
    },
    tags: [{ id: TAG_ID, name: 'Generic tag' }],
    rules: [
      {
        id: RULE_ID,
        ruleRevision: 1,
        priority: 1,
        matchField: 'payee',
        matchText: 'Generic',
        action: {
          version: 2,
          direction: 'Purchase',
          category: 'Expense A',
          categoryQboId: 'expense-a',
          taxCalculation: 'TaxExcluded',
          taxCodeQboId: 'tax-a',
          tagIds: [TAG_ID],
        },
        autoPost: false,
      },
      {
        id: RULE_TAX_B_ID,
        ruleRevision: 1,
        priority: 2,
        matchField: 'payee',
        matchText: 'Generic tax alternative',
        action: {
          version: 2,
          direction: 'Purchase',
          category: 'Expense A',
          categoryQboId: 'expense-a',
          taxCalculation: 'TaxExcluded',
          taxCodeQboId: 'tax-b',
          tagIds: [TAG_ID],
        },
        autoPost: false,
      },
    ],
    similarVerifiedTransactions: [{
      transactionId: HISTORY_ID,
      date: '2026-07-01',
      signedAmountCents: -10_00,
      currency: 'CAD',
      payee: 'Earlier merchant',
      taxCalculation: 'TaxExcluded',
      lines: [{
        signedGrossCents: -10_00,
        categoryQboId: 'expense-a',
        taxCodeQboId: 'tax-a',
        tagIds: [],
      }],
      tagIds: [TAG_ID],
      verifiedAt: '2026-07-02T00:00:00.000Z',
    }],
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config.1',
    ...overrides,
  };
}

function snapshot(): AgentTransactionSnapshot {
  return buildAgentSnapshot(snapshotSource());
}

function proposal(
  overrides: Partial<Extract<AgentDecision, { kind: 'proposal' }>> = {},
): Extract<AgentDecision, { kind: 'proposal' }> {
  return {
    kind: 'proposal',
    taxCalculation: 'TaxExcluded',
    lines: [{
      grossCents: -10_00,
      categoryQboId: 'expense-a',
      taxCodeQboId: 'tax-a',
      memo: null,
      tagIds: [],
    }],
    tagIds: [TAG_ID],
    confidence: 0.8,
    evidence: [
      { kind: 'rule', id: RULE_ID },
      { kind: 'category', qboId: 'expense-a' },
      { kind: 'tax_code', qboId: 'tax-a' },
    ],
    rationale: 'Generic evidence supports this proposal.',
    ...overrides,
  } as Extract<AgentDecision, { kind: 'proposal' }>;
}

function abstention(): Extract<AgentDecision, { kind: 'abstain' }> {
  return {
    kind: 'abstain',
    reasonCode: 'INSUFFICIENT_CONTEXT',
    rationale: 'More generic context is required.',
  };
}

function decisionTurn(
  decision: AgentDecision,
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): AgentModelTurn {
  return {
    kind: 'decision',
    rawDecision: { decision },
    ...(usage === undefined ? {} : { usage }),
  };
}

type SequenceEntry =
  | AgentModelTurn
  | Error
  | ((input: AgentModelInput, signal: AbortSignal) => Promise<AgentModelTurn>);

class RecordingModel implements AgentModel {
  readonly identity: AgentModelIdentity;
  readonly inputs: AgentModelInput[] = [];
  calls = 0;

  constructor(
    private readonly sequence: readonly SequenceEntry[],
    provider: AgentModelIdentity['provider'] = 'fake',
    model = 'decision-model',
  ) {
    this.identity = Object.freeze({ provider, model });
  }

  async nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn> {
    this.calls += 1;
    this.inputs.push(input);
    const entry = this.sequence[this.calls - 1];
    if (entry === undefined) {
      throw new AgentModelError('AGENT_MODEL_EXHAUSTED', 'terminal');
    }
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(input, signal);
    return structuredClone(entry);
  }
}

class ManualClock implements AgentRunnerClock {
  current = 100;
  private callback: (() => void) | undefined;

  now = (): number => this.current;

  setTimeout = (callback: () => void, _delayMs: number): object => {
    this.callback = callback;
    return {};
  };

  clearTimeout = (): void => {
    this.callback = undefined;
  };

  advance(milliseconds: number): void {
    this.current += milliseconds;
    this.callback?.();
  }
}

function toolTurn(ids: readonly string[]): AgentModelTurn {
  return {
    kind: 'tool_calls',
    toolCalls: ids.map((id) => ({
      id,
      name: 'list_rules',
      arguments: {},
    })),
  };
}

describe('runShadowDecision', () => {
  it('exports immutable hard global defaults', () => {
    expect(DEFAULT_AGENT_LIMITS).toEqual({
      maxToolCalls: 8,
      maxTurns: 4,
      maxContextBytes: 64 * 1024,
      maxResponseBytes: 32 * 1024,
      timeoutMs: 30_000,
    });
    expect(Object.isFrozen(DEFAULT_AGENT_LIMITS)).toBe(true);
  });

  it('returns a verified proposal with exact deterministic metadata', async () => {
    const clock = new ManualClock();
    const model = new RecordingModel([decisionTurn(proposal())], 'custom', 'generic-model');

    const result = await runShadowDecision(snapshot(), { model, clock });

    expect(result).toEqual({
      status: 'verified',
      decision: proposal(),
      snapshotRevision: 9,
      decisionProvider: 'custom',
      decisionModel: 'generic-model',
      promptVersion: AGENT_MODEL_PROMPT_VERSION,
      schemaVersion: agentDecisionSchemaVersion,
      durationMs: 0,
      turns: 1,
      toolCalls: 0,
      verificationMode: 'deterministic',
      diagnosticCode: 'AGENT_RUN_VERIFIED',
    });
    expect(model.inputs[0]).toMatchObject({
      kind: 'decision',
      snapshot: expect.any(Object),
      history: [],
    });
  });

  it('returns a model abstention as a valid terminal result', async () => {
    const reviewer = new RecordingModel([decisionTurn(proposal())], 'custom', 'reviewer');
    const result = await runShadowDecision(
      snapshot(),
      {
        model: new RecordingModel([decisionTurn(abstention())]),
        reviewModel: reviewer,
      },
    );

    expect(result).toMatchObject({
      status: 'abstain',
      decision: abstention(),
      diagnosticCode: 'AGENT_RUN_MODEL_ABSTAIN',
      verificationMode: 'deterministic',
      turns: 1,
    });
    expect(reviewer.calls).toBe(0);
  });

  it('serializes and validates the snapshot before the first model call', async () => {
    const model = new RecordingModel([decisionTurn(proposal())]);
    const invalid = {
      ...structuredClone(snapshot()),
      transaction: { id: TRANSACTION_ID, revision: -1 },
    } as AgentTransactionSnapshot;

    const invalidResult = await runShadowDecision(invalid, { model });
    const boundedResult = await runShadowDecision(snapshot(), {
      model,
      limits: { maxContextBytes: 128 },
    });

    expect(invalidResult).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_SNAPSHOT_INVALID',
      turns: 0,
    });
    expect(boundedResult).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_CONTEXT_LIMIT',
      turns: 0,
    });
    expect(model.calls).toBe(0);
  });

  it('executes exactly eight tool calls and preserves deterministic complete history', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `call-${index + 1}`);
    const model = new RecordingModel([toolTurn(ids), decisionTurn(proposal())]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'verified',
      turns: 2,
      toolCalls: 8,
    });
    expect(model.inputs[1]?.history).toHaveLength(9);
    expect(model.inputs[1]?.history[0]).toEqual({
      role: 'assistant',
      toolCalls: ids.map((id) => ({
        id,
        name: 'list_rules',
        arguments: {},
      })),
    });
    expect(model.inputs[1]?.history.slice(1)).toEqual(ids.map((id) => ({
      role: 'tool',
      toolCallId: id,
      name: 'list_rules',
      result: { items: snapshot().rules },
    })));
  });

  it('executes none of a nine-call batch that exceeds the remaining global budget', async () => {
    const model = new RecordingModel([
      toolTurn(Array.from({ length: 9 }, (_, index) => `call-${index + 1}`)),
    ]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TOOL_LIMIT',
      turns: 1,
      toolCalls: 0,
    });
    expect(model.calls).toBe(1);
  });

  it('permits exactly four model turns and makes no fifth model call', async () => {
    const fourTurnModel = new RecordingModel([
      toolTurn(['call-1']),
      toolTurn(['call-2']),
      toolTurn(['call-3']),
      decisionTurn(proposal()),
    ]);
    const fifthTurnModel = new RecordingModel([
      toolTurn(['call-1']),
      toolTurn(['call-2']),
      toolTurn(['call-3']),
      toolTurn(['call-4']),
      decisionTurn(proposal()),
    ]);

    const accepted = await runShadowDecision(snapshot(), { model: fourTurnModel });
    const rejected = await runShadowDecision(snapshot(), { model: fifthTurnModel });

    expect(accepted).toMatchObject({
      status: 'verified',
      turns: 4,
      toolCalls: 3,
    });
    expect(rejected).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TURN_LIMIT',
      turns: 4,
      toolCalls: 4,
    });
    expect(fifthTurnModel.calls).toBe(4);
  });

  it.each([
    ['blank', [{ id: ' ', name: 'list_rules', arguments: {} }], 'AGENT_RUN_TOOL_CALL_INVALID'],
    [
      'duplicate batch',
      [
        { id: 'duplicate', name: 'list_rules', arguments: {} },
        { id: 'duplicate', name: 'list_rules', arguments: {} },
      ],
      'AGENT_RUN_TOOL_CALL_DUPLICATE',
    ],
  ])('rejects %s tool-call IDs without executing the batch', async (_name, toolCalls, code) => {
    const model = new RecordingModel([{ kind: 'tool_calls', toolCalls }]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: code,
      toolCalls: 0,
    });
  });

  it('rejects repeated IDs across turns before executing the repeated batch', async () => {
    const model = new RecordingModel([
      toolTurn(['duplicate']),
      toolTurn(['duplicate']),
    ]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TOOL_CALL_DUPLICATE',
      turns: 2,
      toolCalls: 1,
    });
  });

  it('rejects repeated IDs across primary and review phases globally', async () => {
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([
        toolTurn(['global-id']),
        decisionTurn(proposal()),
      ]),
      reviewModel: new RecordingModel([
        toolTurn(['global-id']),
        decisionTurn(proposal()),
      ], 'custom', 'reviewer'),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TOOL_CALL_DUPLICATE',
      turns: 3,
      toolCalls: 1,
    });
  });

  it.each([
    [
      'unknown tool',
      { id: 'call-1', name: 'unknown_tool', arguments: {} },
      'AGENT_TOOL_UNKNOWN',
    ],
    [
      'malformed arguments',
      { id: 'call-1', name: 'search_categories', arguments: { query: 'generic' } },
      'AGENT_TOOL_INVALID_INPUT',
    ],
  ])('turns %s failures into safe abstentions', async (_name, toolCall, code) => {
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([{ kind: 'tool_calls', toolCalls: [toolCall] }]),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: code,
      turns: 1,
      toolCalls: 0,
    });
  });

  it('turns malformed decisions and provider errors into safe abstentions', async () => {
    const malformed = await runShadowDecision(snapshot(), {
      model: new RecordingModel([{
        kind: 'decision',
        rawDecision: { decision: { kind: 'proposal', private: 'private-marker' } },
      }]),
    });
    const provider = await runShadowDecision(snapshot(), {
      model: new RecordingModel([
        new AgentModelError('AGENT_MODEL_NETWORK_ERROR', 'retryable'),
      ]),
    });
    const unexpected = await runShadowDecision(snapshot(), {
      model: new RecordingModel([new Error('private-marker')]),
    });

    expect(malformed).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_DECISION_INVALID',
    });
    expect(provider).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_MODEL_NETWORK_ERROR',
      providerFailure: {
        code: 'AGENT_MODEL_NETWORK_ERROR',
        classification: 'retryable',
      },
    });
    expect(unexpected).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_MODEL_ERROR',
    });
    expect(JSON.stringify([malformed, provider, unexpected])).not.toContain('private-marker');
  });

  it.each([
    'AGENT_MODEL_CONFIG_INVALID',
    'AGENT_MODEL_INPUT_INVALID',
    'AGENT_MODEL_NETWORK_ERROR',
    'AGENT_MODEL_HTTP_ERROR',
    'AGENT_MODEL_RESPONSE_TOO_LARGE',
    'AGENT_MODEL_RESPONSE_INVALID',
    'AGENT_MODEL_ABORTED',
    'AGENT_MODEL_EXHAUSTED',
  ] satisfies AgentModelErrorCode[])('converts safe model error %s without retrying', async (code) => {
    const model = new RecordingModel([
      new AgentModelError(code, code === 'AGENT_MODEL_NETWORK_ERROR' ? 'retryable' : 'terminal'),
      decisionTurn(proposal()),
    ]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: code,
      turns: 1,
      toolCalls: 0,
      providerFailure: {
        code,
        classification: code === 'AGENT_MODEL_NETWORK_ERROR' ? 'retryable' : 'terminal',
      },
    });
    expect(model.calls).toBe(1);
  });

  it.each([
    { kind: 'tool_calls', toolCalls: [] },
    { kind: 'fabricated', private: 'private-marker' },
  ])('turns malformed model turns into sanitized abstentions', async (turn) => {
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([turn as unknown as AgentModelTurn]),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_MODEL_RESPONSE_INVALID',
    });
    expect(JSON.stringify(result)).not.toContain('private-marker');
  });

  it('enforces the runner response bound independently of the adapter', async () => {
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([{
        kind: 'decision',
        rawDecision: {
          decision: abstention(),
          padding: 'x'.repeat(256),
        },
      }]),
      limits: { maxResponseBytes: 128 },
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_RESPONSE_TOO_LARGE',
    });
  });

  it('reports deterministic verification failure without reflecting fabricated data', async () => {
    const privateMarker = 'private-fabricated-category';
    const invalidProposal = proposal({
      lines: [{
        ...proposal().lines[0],
        categoryQboId: privateMarker,
        memo: privateMarker,
      }],
      rationale: privateMarker,
      evidence: [{ kind: 'category', qboId: 'expense-a' }],
    });

    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(invalidProposal)]),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_CATEGORY_REFERENCE_INVALID',
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it('maps tax verification failures to INVALID_TAX_STATE', async () => {
    const invalidTax = proposal({
      lines: [{
        ...proposal().lines[0],
        taxCodeQboId: 'fabricated-tax',
      }],
      evidence: [{ kind: 'category', qboId: 'expense-a' }],
    });

    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(invalidTax)]),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      decision: {
        kind: 'abstain',
        reasonCode: 'INVALID_TAX_STATE',
      },
      verificationMode: 'deterministic',
      diagnosticCode: 'AGENT_TAX_REFERENCE_INVALID',
    });
  });

  it('normalizes and aggregates usage across turns', async () => {
    const model = new RecordingModel([
      {
        ...toolTurn(['call-1']),
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      decisionTurn(proposal(), {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
      }),
    ]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
      },
      turns: 2,
      toolCalls: 1,
    });
  });

  it('validates each usage update atomically before mutating aggregate metadata', async () => {
    const invalidLaterField = await runShadowDecision(snapshot(), {
      model: new RecordingModel([{
        ...decisionTurn(proposal()),
        usage: {
          inputTokens: 10,
          outputTokens: -1,
        },
      } as AgentModelTurn]),
    });
    const aggregateOverflow = await runShadowDecision(snapshot(), {
      model: new RecordingModel([
        {
          ...toolTurn(['usage-call']),
          usage: { totalTokens: Number.MAX_SAFE_INTEGER },
        },
        {
          ...decisionTurn(proposal()),
          usage: {
            inputTokens: 10,
            totalTokens: 1,
          },
        },
      ]),
    });

    expect(invalidLaterField).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_MODEL_RESPONSE_INVALID',
    });
    expect(invalidLaterField).not.toHaveProperty('usage');
    expect(aggregateOverflow).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_MODEL_RESPONSE_INVALID',
      usage: {
        totalTokens: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(aggregateOverflow.usage).not.toHaveProperty('inputTokens');
  });

  it.each([
    ['same_model', 'fake', 'generic-review'],
    ['distinct_model', 'custom', 'other-review'],
  ] as const)('labels successful %s review explicitly', async (mode, provider, reviewName) => {
    const decisionModel = new RecordingModel(
      [decisionTurn(proposal())],
      'fake',
      mode === 'same_model' ? reviewName : 'decision-model',
    );
    const reviewModel = new RecordingModel(
      [decisionTurn(proposal())],
      provider,
      reviewName,
    );

    const result = await runShadowDecision(snapshot(), {
      model: decisionModel,
      reviewModel,
    });

    expect(result).toMatchObject({
      status: 'verified',
      verificationMode: mode,
      turns: 2,
      diagnosticCode: 'AGENT_RUN_VERIFIED',
    });
    expect(reviewModel.inputs[0]).toMatchObject({
      kind: 'review',
      candidateDecision: proposal(),
      history: [],
    });
  });

  it('allows the reviewer to use bounded snapshot tools', async () => {
    const reviewer = new RecordingModel([
      toolTurn(['review-call']),
      decisionTurn(proposal()),
    ], 'custom', 'reviewer');

    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(proposal())]),
      reviewModel: reviewer,
    });

    expect(result).toMatchObject({
      status: 'verified',
      verificationMode: 'distinct_model',
      turns: 3,
      toolCalls: 1,
    });
    expect(reviewer.inputs[1]?.history).toEqual([
      {
        role: 'assistant',
        toolCalls: [{
          id: 'review-call',
          name: 'list_rules',
          arguments: {},
        }],
      },
      {
        role: 'tool',
        toolCallId: 'review-call',
        name: 'list_rules',
        result: { items: snapshot().rules },
      },
    ]);
  });

  it('shares the global tool budget with review and executes none of an over-budget review batch', async () => {
    const primaryIds = Array.from({ length: 7 }, (_, index) => `primary-${index + 1}`);
    const reviewer = new RecordingModel([
      toolTurn(['review-1', 'review-2']),
    ], 'custom', 'reviewer');

    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([
        toolTurn(primaryIds),
        decisionTurn(proposal()),
      ]),
      reviewModel: reviewer,
    });

    expect(result).toMatchObject({
      status: 'abstain',
      verificationMode: 'distinct_model',
      diagnosticCode: 'AGENT_RUN_TOOL_LIMIT',
      turns: 3,
      toolCalls: 7,
    });
    expect(reviewer.calls).toBe(1);
  });

  it('stays deterministic when the global turn budget prevents any reviewer call', async () => {
    const reviewer = new RecordingModel([
      decisionTurn(proposal()),
    ], 'custom', 'reviewer');
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([
        toolTurn(['primary-1']),
        toolTurn(['primary-2']),
        toolTurn(['primary-3']),
        decisionTurn(proposal()),
      ]),
      reviewModel: reviewer,
    });

    expect(result).toMatchObject({
      status: 'abstain',
      verificationMode: 'deterministic',
      diagnosticCode: 'AGENT_RUN_TURN_LIMIT',
      turns: 4,
      toolCalls: 3,
    });
    expect(reviewer.calls).toBe(0);
  });

  it('makes abstaining, conflicting, invalid, or unverified review output abstain', async () => {
    const conflicting = proposal({
      confidence: 0.7,
      rationale: 'A distinct generic critique.',
    });
    const invalid = proposal({
      lines: [{
        ...proposal().lines[0],
        categoryQboId: 'fabricated',
      }],
      evidence: [{ kind: 'category', qboId: 'expense-a' }],
    });
    const cases: Array<[AgentModelTurn, string]> = [
      [decisionTurn(abstention()), 'AGENT_RUN_REVIEW_ABSTAIN'],
      [decisionTurn(conflicting), 'AGENT_RUN_REVIEW_CONFLICT'],
      [{
        kind: 'decision',
        rawDecision: { malformed: true },
      }, 'AGENT_RUN_REVIEW_INVALID'],
      [decisionTurn(invalid), 'AGENT_RUN_REVIEW_UNVERIFIED'],
    ];

    for (const [reviewTurn, diagnosticCode] of cases) {
      const result = await runShadowDecision(snapshot(), {
        model: new RecordingModel([decisionTurn(proposal())]),
        reviewModel: new RecordingModel([reviewTurn], 'custom', 'reviewer'),
      });
      expect(result).toMatchObject({
        status: 'abstain',
        verificationMode: 'distinct_model',
        diagnosticCode,
      });
    }
  });

  it.each([
    [
      'fabricated',
      proposal({
        lines: [{
          ...proposal().lines[0],
          taxCodeQboId: 'fabricated-tax',
        }],
      }),
      false,
    ],
    [
      'mismatched',
      proposal({
        lines: [{
          ...proposal().lines[0],
          taxCodeQboId: 'tax-b',
        }],
        evidence: [{
          kind: 'rule',
          id: RULE_TAX_B_ID,
        }],
      }),
      true,
    ],
  ] as const)('classifies %s review tax output without leaking it', async (
    _name,
    reviewed,
    independentlyVerified,
  ) => {
    expect(verifyAgentDecision(snapshot(), reviewed as AgentDecision).ok)
      .toBe(independentlyVerified);
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(proposal())]),
      reviewModel: new RecordingModel([
        decisionTurn(reviewed as AgentDecision),
      ], 'custom', 'reviewer'),
    });

    expect(result).toMatchObject({
      status: 'abstain',
      decision: {
        kind: 'abstain',
        reasonCode: 'INVALID_TAX_STATE',
      },
      verificationMode: 'distinct_model',
      diagnosticCode: 'AGENT_RUN_REVIEW_TAX_INVALID',
    });
    expect(JSON.stringify(result)).not.toContain('fabricated-tax');
  });

  it('times out before and during model execution using the deterministic clock/signal seam', async () => {
    const beforeClock = new ManualClock();
    beforeClock.current = 30_100;
    const beforeModel = new RecordingModel([decisionTurn(proposal())]);
    const before = await runShadowDecision(snapshot(), {
      model: beforeModel,
      clock: beforeClock,
      startedAtMs: 100,
    });

    const duringClock = new ManualClock();
    const duringModel = new RecordingModel([
      async (_input, signal) => {
        duringClock.advance(DEFAULT_AGENT_LIMITS.timeoutMs);
        expect(signal.aborted).toBe(true);
        return new Promise<AgentModelTurn>(() => undefined);
      },
    ]);
    const during = await runShadowDecision(snapshot(), {
      model: duringModel,
      clock: duringClock,
    });

    expect(before).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TIMEOUT',
      turns: 0,
    });
    expect(beforeModel.calls).toBe(0);
    expect(during).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TIMEOUT',
      turns: 1,
    });
  });

  it('detects a deadline crossed during tool execution without leaking tool input', async () => {
    let nowCalls = 0;
    const clock: AgentRunnerClock = {
      now: () => {
        nowCalls += 1;
        return nowCalls >= 6 ? DEFAULT_AGENT_LIMITS.timeoutMs : 0;
      },
      setTimeout: () => ({}),
      clearTimeout: () => undefined,
    };
    const result = await runShadowDecision(snapshot(), {
      model: new RecordingModel([{
        kind: 'tool_calls',
        toolCalls: [{
          id: 'call-1',
          name: 'search_categories',
          arguments: { query: 'private-tool-input', limit: 1 },
        }],
      }]),
      clock,
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_TIMEOUT',
      toolCalls: 1,
    });
    expect(JSON.stringify(result)).not.toContain('private-tool-input');
  });

  it('turns external cancellation into a structured abstention', async () => {
    const controller = new AbortController();
    const model = new RecordingModel([
      async (_input, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        return new Promise<AgentModelTurn>(() => undefined);
      },
    ]);

    const result = await runShadowDecision(snapshot(), {
      model,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_RUN_CANCELLED',
      turns: 1,
    });
  });

  it.each([
    ['timeout', 'AGENT_RUN_TIMEOUT'],
    ['cancel', 'AGENT_RUN_CANCELLED'],
  ] as const)('preserves %s when it is the first terminal cause', async (first, code) => {
    const controller = new AbortController();
    const clock = new ManualClock();
    const model = new RecordingModel([
      async () => {
        if (first === 'timeout') {
          clock.advance(DEFAULT_AGENT_LIMITS.timeoutMs);
          controller.abort();
        } else {
          controller.abort();
          clock.advance(DEFAULT_AGENT_LIMITS.timeoutMs);
        }
        return new Promise<AgentModelTurn>(() => undefined);
      },
    ]);

    const result = await runShadowDecision(snapshot(), {
      model,
      signal: controller.signal,
      clock,
    });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: code,
      turns: 1,
    });
  });

  it('returns deeply detached readonly results and does not expose model aliases', async () => {
    const candidate = proposal();
    const originalSnapshot = snapshot();
    const before = JSON.stringify(originalSnapshot);
    const result = await runShadowDecision(originalSnapshot, {
      model: new RecordingModel([decisionTurn(candidate)]),
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(result.decision).not.toBe(candidate);
    expect(result.decision.kind === 'proposal' && Object.isFrozen(result.decision.lines)).toBe(true);
    expect(() => {
      (result.decision as { rationale: string }).rationale = 'mutation';
    }).toThrow(TypeError);
    expect(JSON.stringify(originalSnapshot)).toBe(before);
  });

  it('passes detached frozen snapshot and history inputs to the model', async () => {
    const callerSnapshot = structuredClone(snapshot());
    const before = JSON.stringify(callerSnapshot);
    const model = new RecordingModel([
      async (input) => {
        expect(input.snapshot).not.toBe(callerSnapshot);
        expect(Object.isFrozen(input.snapshot)).toBe(true);
        expect(Object.isFrozen(input.snapshot.candidateCategories)).toBe(true);
        expect(Object.isFrozen(input.history)).toBe(true);
        expect(() => {
          (input.snapshot.transaction as { revision: number }).revision = 123;
        }).toThrow(TypeError);
        return toolTurn(['call-1']);
      },
      async (input) => {
        expect(Object.isFrozen(input.history)).toBe(true);
        expect(Object.isFrozen(input.history[0])).toBe(true);
        return decisionTurn(proposal());
      },
    ]);

    const result = await runShadowDecision(callerSnapshot, { model });

    expect(result).toMatchObject({ status: 'verified' });
    expect(JSON.stringify(callerSnapshot)).toBe(before);
  });

  it('does not retry provider failures or make hidden extra calls', async () => {
    const model = new RecordingModel([
      new AgentModelError('AGENT_MODEL_NETWORK_ERROR', 'retryable'),
      decisionTurn(proposal()),
    ]);

    const result = await runShadowDecision(snapshot(), { model });

    expect(result).toMatchObject({
      status: 'abstain',
      diagnosticCode: 'AGENT_MODEL_NETWORK_ERROR',
      turns: 1,
    });
    expect(model.calls).toBe(1);
  });

  it('does not call a reviewer after a primary abstention or verification failure', async () => {
    const reviewer = new RecordingModel([decisionTurn(proposal())]);
    await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(abstention())]),
      reviewModel: reviewer,
    });
    await runShadowDecision(snapshot(), {
      model: new RecordingModel([decisionTurn(proposal({
        lines: [{ ...proposal().lines[0], categoryQboId: 'fabricated' }],
      }))]),
      reviewModel: reviewer,
    });

    expect(reviewer.calls).toBe(0);
  });
});
