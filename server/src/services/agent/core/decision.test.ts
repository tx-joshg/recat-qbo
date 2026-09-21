import { describe, expect, it } from 'vitest';
import * as decisionModule from './decision.js';
import type { AgentDecision } from './decision.js';

const {
  AgentDecisionError,
  agentDecisionJsonSchema,
  agentDecisionSchema,
  parseAgentDecision,
} = decisionModule;

const IDS = {
  tag: '11111111-1111-4111-8111-111111111111',
  secondTag: '22222222-2222-4222-8222-222222222222',
  rule: '33333333-3333-4333-8333-333333333333',
  transaction: '44444444-4444-4444-8444-444444444444',
} as const;

type RecordValue = Record<string, unknown>;

function proposal(
  taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable' = 'TaxExcluded',
): RecordValue {
  return {
    decision: {
      kind: 'proposal',
      taxCalculation,
      lines: [{
        grossCents: -1250,
        categoryQboId: '100',
        taxCodeQboId: taxCalculation === 'NotApplicable' ? null : '200',
        memo: 'Coffee meeting',
        tagIds: [IDS.tag],
      }],
      tagIds: [IDS.secondTag],
      confidence: 0.8,
      evidence: [
        { kind: 'rule', id: IDS.rule },
        { kind: 'similar_transaction', transactionId: IDS.transaction },
        { kind: 'category', qboId: '100' },
        { kind: 'tax_code', qboId: '200' },
      ],
      rationale: 'Matched prior verified pattern.',
    },
  };
}

function abstain(reasonCode = 'INSUFFICIENT_CONTEXT'): RecordValue {
  return { decision: { kind: 'abstain', reasonCode, rationale: 'More context is needed.' } };
}

function nestedProposal(value: RecordValue): RecordValue {
  return value.decision as RecordValue;
}

function itemUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function resolveReference(root: unknown, reference: string): unknown {
  if (!reference.startsWith('#/')) throw new Error(`External reference is not provider-safe: ${reference}`);
  return reference.slice(2).split('/').reduce<unknown>((current, segment) => (
    (current as RecordValue)[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  ), root);
}

/** Raw-data validator for the supported provider JSON Schema subset. */
function providerSchemaAccepts(schema: unknown, value: unknown, root = schema): boolean {
  const node = schema as RecordValue;
  if ('$ref' in node) return providerSchemaAccepts(resolveReference(root, node.$ref as string), value, root);
  if (Array.isArray(node.anyOf)) return node.anyOf.some((branch) => providerSchemaAccepts(branch, value, root));
  if ('const' in node && value !== node.const) return false;
  if (Array.isArray(node.enum) && !node.enum.includes(value)) return false;
  if (node.type === 'null') return value === null;
  if (Array.isArray(node.type)) return node.type.some((type) => providerSchemaAccepts({ ...node, type }, value, root));
  if (node.type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof node.minLength === 'number' && codePointLength(value) < node.minLength) return false;
    if (typeof node.maxLength === 'number' && codePointLength(value) > node.maxLength) return false;
    return typeof node.pattern !== 'string' || new RegExp(node.pattern, 'u').test(value);
  }
  if (node.type === 'number' || node.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (node.type === 'integer' && !Number.isInteger(value))) return false;
    if (typeof node.minimum === 'number' && value < node.minimum) return false;
    return typeof node.maximum !== 'number' || value <= node.maximum;
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof node.minItems === 'number' && value.length < node.minItems) return false;
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false;
    return value.every((item) => providerSchemaAccepts(node.items, item, root));
  }
  if (node.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as RecordValue;
    const properties = (node.properties ?? {}) as RecordValue;
    const required = (node.required ?? []) as string[];
    if (required.some((key) => !(key in record))) return false;
    if (node.additionalProperties === false && Object.keys(record).some((key) => !(key in properties))) return false;
    return Object.entries(record).every(([key, item]) => !(key in properties) || providerSchemaAccepts(properties[key], item, root));
  }
  throw new Error(`Unhandled provider schema node: ${JSON.stringify(node)}`);
}

function assertProviderObjectsAreStrict(schema: unknown): void {
  const node = schema as RecordValue;
  if ('$ref' in node) throw new Error('Direct provider schema must not need a root reference.');
  if (node.type === 'object') {
    const properties = (node.properties ?? {}) as RecordValue;
    expect(node.additionalProperties).toBe(false);
    expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(properties)));
    for (const property of Object.values(properties)) assertProviderObjectsAreStrict(property);
  }
  if (node.type === 'array') assertProviderObjectsAreStrict(node.items);
  if (Array.isArray(node.type)) return;
  if (Array.isArray(node.anyOf)) for (const branch of node.anyOf) assertProviderObjectsAreStrict(branch);
}

function assertNoUnsupportedProviderKeywords(schema: unknown): void {
  const node = schema as RecordValue;
  for (const key of Object.keys(node)) {
    expect(key).not.toBe('uniqueItems');
    expect(key).not.toBe('$id');
    expect(key).not.toBe('$schema');
    expect(key.startsWith('x-')).toBe(false);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.filter((item) => typeof item === 'object' && item !== null).forEach(assertNoUnsupportedProviderKeywords);
    else if (typeof value === 'object' && value !== null) assertNoUnsupportedProviderKeywords(value);
  }
}

function expectRawParity(value: unknown, expected: boolean): void {
  expect(agentDecisionSchema.safeParse(value).success).toBe(expected);
  expect(providerSchemaAccepts(agentDecisionJsonSchema, value)).toBe(expected);
}

describe('agent decision provider contract', () => {
  it('exports a direct strict object root with only nested decision anyOf', () => {
    expect((agentDecisionJsonSchema as Record<string, unknown>).type).toBe('object');
    expect((agentDecisionJsonSchema as Record<string, unknown>).anyOf).toBeUndefined();
    expect(((agentDecisionJsonSchema as Record<string, unknown>).properties as RecordValue).decision).toMatchObject({ anyOf: expect.any(Array) });
    assertProviderObjectsAreStrict(agentDecisionJsonSchema);
    assertNoUnsupportedProviderKeywords(agentDecisionJsonSchema);
    expect(JSON.stringify(agentDecisionJsonSchema)).not.toContain('agent-decision-provider-text');
    expect((decisionModule as Record<string, unknown>).agentDecisionSchemaName).toBe('AgentDecision');
    expect((decisionModule as Record<string, unknown>).agentDecisionSchemaVersion).toBe(1);
  });

  it('accepts every raw decision and requires nullable memo in each line', () => {
    for (const taxCalculation of ['TaxInclusive', 'TaxExcluded', 'NotApplicable'] as const) expectRawParity(proposal(taxCalculation), true);
    for (const reasonCode of ['INSUFFICIENT_CONTEXT', 'CONFLICTING_EVIDENCE', 'UNSUPPORTED_TRANSACTION', 'INVALID_TAX_STATE', 'PROVIDER_FAILURE']) {
      expectRawParity(abstain(reasonCode), true);
    }
    const nullableMemo = proposal();
    (nestedProposal(nullableMemo).lines as RecordValue[])[0]!.memo = null;
    expectRawParity(nullableMemo, true);
    const missingMemo = proposal();
    delete (nestedProposal(missingMemo).lines as RecordValue[])[0]!.memo;
    expectRawParity(missingMemo, false);
  });

  it('has exact structural bounds and tax code branch rules in raw-data parity', () => {
    const minimum = proposal();
    nestedProposal(minimum).rationale = 'r';
    nestedProposal(minimum).confidence = 0;
    nestedProposal(minimum).tagIds = [];
    (nestedProposal(minimum).lines as RecordValue[])[0]!.memo = 'm';
    (nestedProposal(minimum).lines as RecordValue[])[0]!.categoryQboId = 'q';
    (nestedProposal(minimum).lines as RecordValue[])[0]!.tagIds = [];
    nestedProposal(minimum).evidence = [{ kind: 'rule', id: IDS.rule }];
    expectRawParity(minimum, true);

    const maximum = proposal();
    nestedProposal(maximum).rationale = 'r'.repeat(2000);
    (nestedProposal(maximum).lines as RecordValue[])[0]!.memo = 'm'.repeat(500);
    (nestedProposal(maximum).lines as RecordValue[])[0]!.categoryQboId = 'q'.repeat(120);
    nestedProposal(maximum).tagIds = Array.from({ length: 20 }, (_, index) => itemUuid(index + 1));
    nestedProposal(maximum).evidence = Array.from({ length: 20 }, (_, index) => ({ kind: 'rule', id: itemUuid(index + 1) }));
    const maximumLine = (nestedProposal(proposal()).lines as RecordValue[])[0]!;
    nestedProposal(maximum).lines = Array.from({ length: 20 }, () => ({
      ...maximumLine,
      taxCodeQboId: 't'.repeat(120),
      tagIds: Array.from({ length: 20 }, (_, index) => itemUuid(index + 1)),
    }));
    expectRawParity(maximum, true);

    const maximumEvidenceReference = proposal();
    nestedProposal(maximumEvidenceReference).evidence = [
      { kind: 'category', qboId: 'q'.repeat(120) },
      { kind: 'tax_code', qboId: 't'.repeat(120) },
    ];
    expectRawParity(maximumEvidenceReference, true);

    const maximumAbstain = abstain();
    (maximumAbstain.decision as RecordValue).rationale = 'r'.repeat(2000);
    expectRawParity(maximumAbstain, true);

    const maximumConfidence = proposal();
    nestedProposal(maximumConfidence).confidence = 1;
    (nestedProposal(maximumConfidence).lines as RecordValue[])[0]!.grossCents = Number.MAX_SAFE_INTEGER;
    expectRawParity(maximumConfidence, true);
    const minimumCents = proposal();
    (nestedProposal(minimumCents).lines as RecordValue[])[0]!.grossCents = Number.MIN_SAFE_INTEGER;
    expectRawParity(minimumCents, true);

    const cases: unknown[] = [
      { ...proposal(), extra: 'fabricated' },
      { ...proposal(), decision: { ...nestedProposal(proposal()), extra: 'fabricated' } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), rationale: 'r'.repeat(2001) } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), rationale: '' } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), rationale: '1234 5678 9012 3456' } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, memo: 'm'.repeat(501) }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, memo: '' }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, memo: '1234 5678 9012 3456' }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, categoryQboId: 'q'.repeat(121) }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, taxCodeQboId: 't'.repeat(121) }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, categoryQboId: '' }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, categoryQboId: 'not valid' }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: Array.from({ length: 21 }, () => (nestedProposal(proposal()).lines as RecordValue[])[0]) } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), tagIds: Array.from({ length: 21 }, (_, index) => itemUuid(index + 1)) } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), tagIds: ['not-a-uuid'] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, tagIds: Array.from({ length: 21 }, (_, index) => itemUuid(index + 1)) }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), evidence: [] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), evidence: Array.from({ length: 21 }, (_, index) => ({ kind: 'rule', id: itemUuid(index + 1) })) } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), evidence: [{ kind: 'rule', id: 'not-a-uuid' }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), evidence: [{ kind: 'category', qboId: 'q'.repeat(121) }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), confidence: -0.01 } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), confidence: 1.01 } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), confidence: Number.NaN } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), confidence: Number.POSITIVE_INFINITY } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, grossCents: 0 }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, grossCents: 1.5 }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal()), lines: [{ ...(nestedProposal(proposal()).lines as RecordValue[])[0]!, grossCents: Number.MAX_SAFE_INTEGER + 1 }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal('TaxInclusive')), lines: [{ ...(nestedProposal(proposal('TaxInclusive')).lines as RecordValue[])[0]!, taxCodeQboId: null }] } },
      { ...proposal(), decision: { ...nestedProposal(proposal('NotApplicable')), lines: [{ ...(nestedProposal(proposal('NotApplicable')).lines as RecordValue[])[0]!, taxCodeQboId: '200' }] } },
    ];
    for (const value of cases) expectRawParity(value, false);
  });

  it('uses code-point text limits and canonical whitespace in raw schema parity', () => {
    const astralMemo = proposal();
    (nestedProposal(astralMemo).lines as RecordValue[])[0]!.memo = '😀'.repeat(500);
    expectRawParity(astralMemo, true);
    const overlongAstralMemo = proposal();
    (nestedProposal(overlongAstralMemo).lines as RecordValue[])[0]!.memo = '😀'.repeat(501);
    expectRawParity(overlongAstralMemo, false);

    const astralRationale = proposal();
    nestedProposal(astralRationale).rationale = '😀'.repeat(2000);
    expectRawParity(astralRationale, true);
    const overlongAstralRationale = proposal();
    nestedProposal(overlongAstralRationale).rationale = '😀'.repeat(2001);
    expectRawParity(overlongAstralRationale, false);

    const astralAbstain = abstain();
    (astralAbstain.decision as RecordValue).rationale = '😀'.repeat(2000);
    expectRawParity(astralAbstain, true);
    const overlongAstralAbstain = abstain();
    (overlongAstralAbstain.decision as RecordValue).rationale = '😀'.repeat(2001);
    expectRawParity(overlongAstralAbstain, false);

    for (const text of [' leading', 'trailing ', 'double  space', 'tab\tspace', 'line\nbreak']) {
      const raw = proposal();
      nestedProposal(raw).rationale = text;
      expectRawParity(raw, false);
    }
    const decomposed = proposal();
    (nestedProposal(decomposed).lines as RecordValue[])[0]!.memo = 'Cafe\u0301';
    nestedProposal(decomposed).rationale = 'Cafe\u0301 pattern';
    expectRawParity(decomposed, true);
    const normalized: AgentDecision = parseAgentDecision(decomposed);
    expect(normalized).not.toBe(nestedProposal(decomposed));
    expect(normalized).toMatchObject({
      rationale: 'Café pattern',
      lines: [{ memo: 'Café' }],
    });
  });

  it('keeps duplicate-reference checks out of structural parsing for the deterministic verifier', () => {
    const duplicateReferences = proposal();
    nestedProposal(duplicateReferences).tagIds = [IDS.tag, IDS.tag];
    nestedProposal(duplicateReferences).evidence = [{ kind: 'rule', id: IDS.rule }, { kind: 'rule', id: IDS.rule }];
    expectRawParity(duplicateReferences, true);
    expect(parseAgentDecision(duplicateReferences)).toEqual(nestedProposal(duplicateReferences));
    expect(() => parseAgentDecision({ decision: { kind: 'proposal' } })).toThrow(AgentDecisionError);
  });
});
