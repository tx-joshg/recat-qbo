import { describe, expect, it } from 'vitest';
import { agentDecisionSchema, type AgentDecision } from './decision.js';
import { buildAgentSnapshot, type AgentSnapshotSource } from './snapshot.js';
import { verifyAgentDecision } from './verifier.js';

const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const RULE_ID = '22222222-2222-4222-8222-222222222222';
const RULE_B_ID = '22222222-2222-4222-8222-222222222223';
const HISTORY_ID = '33333333-3333-4333-8333-333333333333';
const TAG_ID = '44444444-4444-4444-8444-444444444444';
const LINE_TAG_ID = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

function source(
  overrides: Partial<AgentSnapshotSource> = {},
): AgentSnapshotSource {
  return {
    transaction: { id: TRANSACTION_ID, revision: 7 },
    date: '2026-07-20',
    signedAmountCents: -10_00,
    currency: 'CAD',
    sourceAccount: { displayName: 'Generic account', type: 'BANK' },
    payee: 'Generic merchant',
    memo: 'Generic purchase',
    candidateCategories: [
      { qboId: 'expense-a', name: 'Expense A' },
      { qboId: 'expense-b', name: 'Expense B' },
    ],
    tax: {
      status: 'ready',
      supportedCalculationModes: ['TaxExcluded', 'TaxInclusive'],
      eligibleReferences: [
        { qboId: 'tax-a', label: 'Tax A' },
        { qboId: 'tax-b', label: 'Tax B' },
      ],
    },
    tags: [
      { id: TAG_ID, name: 'Top level' },
      { id: LINE_TAG_ID, name: 'Line level' },
    ],
    rules: [{
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
    }],
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
        tagIds: [LINE_TAG_ID],
      }],
      tagIds: [TAG_ID],
      verifiedAt: '2026-07-02T00:00:00.000Z',
    }],
    featureVersion: 'shadow-core.1',
    configurationVersion: 'config.1',
    ...overrides,
  };
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
      memo: 'Generic line',
      tagIds: [LINE_TAG_ID],
    }],
    tagIds: [TAG_ID],
    confidence: 0.8,
    evidence: [
      { kind: 'rule', id: RULE_ID },
      { kind: 'similar_transaction', transactionId: HISTORY_ID },
      { kind: 'category', qboId: 'expense-a' },
      { kind: 'tax_code', qboId: 'tax-a' },
    ],
    rationale: 'Generic evidence supports this proposal.',
    ...overrides,
  } as Extract<AgentDecision, { kind: 'proposal' }>;
}

function expectRejected(
  decision: AgentDecision,
  code: string,
  snapshotSource: AgentSnapshotSource = source(),
): void {
  expect(verifyAgentDecision(buildAgentSnapshot(snapshotSource), decision)).toEqual({
    ok: false,
    code,
    message: expect.any(String),
  });
}

describe('verifyAgentDecision', () => {
  it('accepts structurally valid abstentions as detached frozen terminal outcomes', () => {
    const decision: AgentDecision = {
      kind: 'abstain',
      reasonCode: 'INSUFFICIENT_CONTEXT',
      rationale: 'The generic fixture is ambiguous.',
    };

    const result = verifyAgentDecision(buildAgentSnapshot(source()), decision);

    expect(result).toMatchObject({
      ok: true,
      code: 'AGENT_DECISION_ABSTAIN',
      decision,
    });
    expect(result).not.toBe(decision);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
  });

  it('accepts verified single-category and balanced split proposals', () => {
    const secondRule = {
      ...source().rules[0]!,
      id: RULE_B_ID,
      priority: 2,
      action: {
        ...source().rules[0]!.action,
        category: 'Expense B',
        categoryQboId: 'expense-b',
        taxCodeQboId: 'tax-b',
      },
    };
    const snapshot = buildAgentSnapshot(source({
      rules: [...source().rules, secondRule],
    }));
    const single = verifyAgentDecision(snapshot, proposal());
    const splitDecision = proposal({
      lines: [
        {
          grossCents: -4_00,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'tax-a',
          memo: null,
          tagIds: [],
        },
        {
          grossCents: -6_00,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-b',
          memo: null,
          tagIds: [LINE_TAG_ID],
        },
      ],
      evidence: [
        { kind: 'rule', id: RULE_ID },
        { kind: 'rule', id: RULE_B_ID },
      ],
    });
    const split = verifyAgentDecision(snapshot, splitDecision);

    expect(single).toMatchObject({ ok: true, code: 'AGENT_DECISION_VERIFIED' });
    expect(split).toMatchObject({ ok: true, code: 'AGENT_DECISION_VERIFIED' });
    expect(split.ok && split.decision).not.toBe(splitDecision);
    expect(split.ok && Object.isFrozen(split.decision.lines)).toBe(true);
    expect(split.ok && Object.isFrozen(split.decision.lines[0])).toBe(true);
  });

  it.each([
    ['AGENT_LINE_AMOUNT_ZERO', [0, -10_00]],
    ['AGENT_LINE_SIGN_MISMATCH', [1, -10_01]],
    ['AGENT_LINE_TOTAL_UNBALANCED', [-4_00, -5_00]],
    ['AGENT_LINE_TOTAL_UNSAFE', [Number.MIN_SAFE_INTEGER, -1]],
  ])('rejects unsafe sum, zero, wrong-sign, and unbalanced totals with %s', (code, amounts) => {
    expectRejected(proposal({
      lines: amounts.map((grossCents) => ({
        grossCents,
        categoryQboId: 'expense-a',
        taxCodeQboId: 'tax-a',
        memo: null,
        tagIds: [],
      })),
      evidence: [{ kind: 'category', qboId: 'expense-a' }],
    }), code);
  });

  it('rejects category and top-level/per-line tag references outside the snapshot', () => {
    expectRejected(
      proposal({
        lines: [{
          ...proposal().lines[0],
          categoryQboId: 'fabricated-category',
        }],
        evidence: [{ kind: 'category', qboId: 'expense-a' }],
      }),
      'AGENT_CATEGORY_REFERENCE_INVALID',
    );
    expectRejected(
      proposal({ tagIds: [UNKNOWN_ID] }),
      'AGENT_TAG_REFERENCE_INVALID',
    );
    expectRejected(
      proposal({
        lines: [{ ...proposal().lines[0], tagIds: [UNKNOWN_ID] }],
      }),
      'AGENT_TAG_REFERENCE_INVALID',
    );
  });

  it('rejects duplicate top-level tags, per-line tags, and evidence references', () => {
    expectRejected(
      proposal({ tagIds: [TAG_ID, TAG_ID] }),
      'AGENT_TAG_REFERENCE_DUPLICATE',
    );
    expectRejected(
      proposal({
        lines: [{ ...proposal().lines[0], tagIds: [LINE_TAG_ID, LINE_TAG_ID] }],
      }),
      'AGENT_TAG_REFERENCE_DUPLICATE',
    );
    expectRejected(
      proposal({
        evidence: [
          { kind: 'rule', id: RULE_ID },
          { kind: 'rule', id: RULE_ID },
        ],
      }),
      'AGENT_EVIDENCE_REFERENCE_DUPLICATE',
    );
  });

  it.each([
    ['unsupported', [], [], 'TaxExcluded', 'AGENT_TAX_NOT_READY'],
    ['needs_setup', [], [], 'TaxExcluded', 'AGENT_TAX_NOT_READY'],
    ['ready', ['TaxInclusive'], [{ qboId: 'tax-a', label: 'Tax A' }], 'TaxExcluded', 'AGENT_TAX_MODE_UNSUPPORTED'],
  ] as const)(
    'rejects %s tax readiness/mode mismatches',
    (status, supportedCalculationModes, eligibleReferences, taxCalculation, code) => {
      expectRejected(
        proposal({ taxCalculation }),
        code,
        source({
          tax: { status, supportedCalculationModes, eligibleReferences },
          rules: [],
          similarVerifiedTransactions: [],
        }),
      );
    },
  );

  it('rejects taxable lines with missing or fabricated tax references', () => {
    expectRejected(
      proposal({
        lines: [{ ...proposal().lines[0], taxCodeQboId: null }] as never,
      }),
      'AGENT_TAX_REFERENCE_MISSING',
    );
    expectRejected(
      proposal({
        lines: [{ ...proposal().lines[0], taxCodeQboId: 'fabricated-tax' }],
        evidence: [{ kind: 'category', qboId: 'expense-a' }],
      }),
      'AGENT_TAX_REFERENCE_INVALID',
    );
  });

  it('rejects NotApplicable lines carrying a tax reference', () => {
    const invalid = {
      ...proposal({
        taxCalculation: 'NotApplicable',
        evidence: [{ kind: 'category', qboId: 'expense-a' }],
      }),
      lines: [{ ...proposal().lines[0], taxCodeQboId: 'tax-a' }],
    } as unknown as AgentDecision;

    expectRejected(invalid, 'AGENT_TAX_REFERENCE_NOT_APPLICABLE');
  });

  it.each([
    ['rule', { kind: 'rule', id: UNKNOWN_ID }, 'AGENT_EVIDENCE_RULE_INVALID'],
    ['history', { kind: 'similar_transaction', transactionId: UNKNOWN_ID }, 'AGENT_EVIDENCE_HISTORY_INVALID'],
    ['category', { kind: 'category', qboId: 'fabricated-category' }, 'AGENT_EVIDENCE_CATEGORY_INVALID'],
    ['tax', { kind: 'tax_code', qboId: 'fabricated-tax' }, 'AGENT_EVIDENCE_TAX_INVALID'],
  ] as const)('rejects fabricated %s evidence references', (_name, evidence, code) => {
    expectRejected(
      proposal({ evidence: [evidence] as never }),
      code,
    );
  });

  it('rejects historical observations as proposal evidence before verification', () => {
    const observationEvidence = {
      ...proposal(),
      evidence: [{ kind: 'historical_observation', id: HISTORY_ID }],
    };

    expect(agentDecisionSchema.safeParse({ decision: observationEvidence }).success).toBe(false);
  });

  it.each([
    [
      [{ kind: 'category', qboId: 'expense-b' }],
      'AGENT_EVIDENCE_CATEGORY_INCONSISTENT',
    ],
    [
      [{ kind: 'tax_code', qboId: 'tax-b' }],
      'AGENT_EVIDENCE_TAX_INCONSISTENT',
    ],
  ] as const)('rejects direct evidence inconsistent with selected references', (evidence, code) => {
    expectRejected(
      proposal({ evidence: evidence as never }),
      code,
    );
  });

  it('rejects rule and history evidence inconsistent with selected category/tax references', () => {
    const mismatchingRule = {
      ...source().rules[0]!,
      action: {
        ...source().rules[0]!.action,
        category: 'Expense B',
        categoryQboId: 'expense-b',
        taxCodeQboId: 'tax-b',
      },
    };
    const mismatchingHistory = {
      ...source().similarVerifiedTransactions[0]!,
      lines: [{
        ...source().similarVerifiedTransactions[0]!.lines[0]!,
        categoryQboId: 'expense-b',
        taxCodeQboId: 'tax-b',
      }],
    };
    expectRejected(
      proposal({ evidence: [{ kind: 'rule', id: RULE_ID }] }),
      'AGENT_EVIDENCE_RULE_INCONSISTENT',
      source({ rules: [mismatchingRule] }),
    );
    expectRejected(
      proposal({ evidence: [{ kind: 'similar_transaction', transactionId: HISTORY_ID }] }),
      'AGENT_EVIDENCE_HISTORY_INCONSISTENT',
      source({ similarVerifiedTransactions: [mismatchingHistory] }),
    );
  });

  it('requires selected category and tax evidence to match the same historical line', () => {
    const crossMatchedHistory = {
      ...source().similarVerifiedTransactions[0]!,
      lines: [
        {
          signedGrossCents: -5_00,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'tax-b',
          tagIds: [],
        },
        {
          signedGrossCents: -5_00,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-a',
          tagIds: [],
        },
      ],
    };

    expectRejected(
      proposal({
        evidence: [{
          kind: 'similar_transaction',
          transactionId: HISTORY_ID,
        }],
      }),
      'AGENT_EVIDENCE_HISTORY_INCONSISTENT',
      source({ similarVerifiedTransactions: [crossMatchedHistory] }),
    );
  });

  it('requires evidence to cover every selected split category and tax reference', () => {
    const splitLines = [
      {
        grossCents: -4_00,
        categoryQboId: 'expense-a',
        taxCodeQboId: 'tax-a',
        memo: null,
        tagIds: [],
      },
      {
        grossCents: -6_00,
        categoryQboId: 'expense-b',
        taxCodeQboId: 'tax-b',
        memo: null,
        tagIds: [],
      },
    ];
    expectRejected(
      proposal({
        lines: splitLines,
        evidence: [
          { kind: 'category', qboId: 'expense-a' },
          { kind: 'tax_code', qboId: 'tax-a' },
        ],
      }),
      'AGENT_EVIDENCE_PAIR_INCONSISTENT',
    );
    expectRejected(
      proposal({
        lines: splitLines,
        evidence: [
          { kind: 'category', qboId: 'expense-a' },
          { kind: 'category', qboId: 'expense-b' },
          { kind: 'tax_code', qboId: 'tax-a' },
        ],
      }),
      'AGENT_EVIDENCE_PAIR_INCONSISTENT',
    );
  });

  it('rejects crossed rule pairs that independently cover selected categories and tax refs', () => {
    const crossedRules = [
      {
        ...source().rules[0]!,
        action: {
          ...source().rules[0]!.action,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'tax-b',
        },
      },
      {
        ...source().rules[0]!,
        id: RULE_B_ID,
        priority: 2,
        action: {
          ...source().rules[0]!.action,
          category: 'Expense B',
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-a',
        },
      },
    ];
    const split = proposal({
      lines: [
        {
          ...proposal().lines[0],
          grossCents: -4_00,
        },
        {
          ...proposal().lines[0],
          grossCents: -6_00,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-b',
        },
      ],
      evidence: [
        { kind: 'rule', id: RULE_ID },
        { kind: 'rule', id: RULE_B_ID },
      ],
    });

    expectRejected(
      split,
      'AGENT_EVIDENCE_RULE_INCONSISTENT',
      source({ rules: crossedRules }),
    );
  });

  it('rejects crossed history pairs that independently cover selected categories and tax refs', () => {
    const crossedHistory = {
      ...source().similarVerifiedTransactions[0]!,
      lines: [
        {
          signedGrossCents: -4_00,
          categoryQboId: 'expense-a',
          taxCodeQboId: 'tax-b',
          tagIds: [],
        },
        {
          signedGrossCents: -6_00,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-a',
          tagIds: [],
        },
      ],
    };
    const split = proposal({
      lines: [
        {
          ...proposal().lines[0],
          grossCents: -4_00,
        },
        {
          ...proposal().lines[0],
          grossCents: -6_00,
          categoryQboId: 'expense-b',
          taxCodeQboId: 'tax-b',
        },
      ],
      evidence: [{
        kind: 'similar_transaction',
        transactionId: HISTORY_ID,
      }],
    });

    expectRejected(
      split,
      'AGENT_EVIDENCE_HISTORY_INCONSISTENT',
      source({ similarVerifiedTransactions: [crossedHistory] }),
    );
  });

  it('returns only stable sanitized diagnostics and never mutates or aliases inputs', () => {
    const secret = 'private-input-marker';
    const snapshot = buildAgentSnapshot(source({
      payee: secret,
      memo: secret,
    }));
    const decision = proposal({
      rationale: secret,
      lines: [{
        ...proposal().lines[0],
        categoryQboId: secret,
        memo: secret,
      }],
      evidence: [{ kind: 'category', qboId: 'expense-a' }],
    });
    const before = JSON.stringify(snapshot);

    const result = verifyAgentDecision(snapshot, decision);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      ok: false,
      code: 'AGENT_CATEGORY_REFERENCE_INVALID',
      message: 'Proposal references an unavailable category.',
    });
    expect(serialized).not.toContain(secret);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
