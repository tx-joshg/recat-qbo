import { z } from 'zod';

const MAX_LINES = 20;
const MAX_TAGS = 20;
const MAX_EVIDENCE = 20;
const MAX_REFERENCE_LENGTH = 120;
const MAX_MEMO_LENGTH = 500;
const MAX_RATIONALE_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QBO_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CANONICAL_TEXT_PATTERN = /^(?![\s\S]*\d(?:[ -]*\d){7,})\S+(?: \S+)*$/u;
const PROVIDER_TEXT_MARKER_PREFIX = 'agent-decision-provider-text:';

export const agentDecisionSchemaName = 'AgentDecision' as const;
export const agentDecisionSchemaVersion = 1 as const;

function providerText(minimum: number, maximum: number) {
  return z.string()
    // A code point can occupy two UTF-16 code units, so this protects Zod from
    // unbounded input while the refinement supplies the provider's real limit.
    .max(maximum * 2)
    .min(minimum)
    .regex(CANONICAL_TEXT_PATTERN)
    .superRefine((value, context) => {
      if (Array.from(value).length > maximum) {
        context.addIssue({ code: 'too_big', origin: 'string', maximum, inclusive: true, input: value, message: 'Text is too long.' });
      }
    })
    .describe(`${PROVIDER_TEXT_MARKER_PREFIX}${maximum}`);
}

const uuid = z.string().regex(UUID_PATTERN);
const qboReference = z.string().min(1).max(MAX_REFERENCE_LENGTH).regex(QBO_REFERENCE_PATTERN);
const tagIds = z.array(uuid).max(MAX_TAGS);

const evidenceSchema = z.union([
  z.object({ kind: z.literal('rule'), id: uuid }).strict(),
  z.object({ kind: z.literal('similar_transaction'), transactionId: uuid }).strict(),
  z.object({ kind: z.literal('category'), qboId: qboReference }).strict(),
  z.object({ kind: z.literal('tax_code'), qboId: qboReference }).strict(),
]);

const signedNonzeroSafeInteger = z.union([
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(-1),
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
]);

const taxableLine = z.object({
  grossCents: signedNonzeroSafeInteger,
  categoryQboId: qboReference,
  taxCodeQboId: qboReference,
  memo: z.union([providerText(1, MAX_MEMO_LENGTH), z.null()]),
  tagIds,
}).strict();

const notApplicableLine = z.object({
  grossCents: signedNonzeroSafeInteger,
  categoryQboId: qboReference,
  taxCodeQboId: z.null(),
  memo: z.union([providerText(1, MAX_MEMO_LENGTH), z.null()]),
  tagIds,
}).strict();

const proposalFields = {
  kind: z.literal('proposal'),
  tagIds,
  confidence: z.number().finite().min(0).max(1),
  // Duplicate tag and evidence references are deterministic verifier concerns,
  // not structural/provider-schema constraints.
  evidence: z.array(evidenceSchema).min(1).max(MAX_EVIDENCE),
  rationale: providerText(1, MAX_RATIONALE_LENGTH),
};

const taxInclusiveProposal = z.object({
  ...proposalFields,
  taxCalculation: z.literal('TaxInclusive'),
  lines: z.array(taxableLine).min(1).max(MAX_LINES),
}).strict();

const taxExcludedProposal = z.object({
  ...proposalFields,
  taxCalculation: z.literal('TaxExcluded'),
  lines: z.array(taxableLine).min(1).max(MAX_LINES),
}).strict();

const notApplicableProposal = z.object({
  ...proposalFields,
  taxCalculation: z.literal('NotApplicable'),
  lines: z.array(notApplicableLine).min(1).max(MAX_LINES),
}).strict();

const abstain = z.object({
  kind: z.literal('abstain'),
  reasonCode: z.enum([
    'INSUFFICIENT_CONTEXT',
    'CONFLICTING_EVIDENCE',
    'UNSUPPORTED_TRANSACTION',
    'INVALID_TAX_STATE',
    'PROVIDER_FAILURE',
  ]),
  rationale: providerText(1, MAX_RATIONALE_LENGTH),
}).strict();

const decision = z.union([
  taxInclusiveProposal,
  taxExcludedProposal,
  notApplicableProposal,
  abstain,
]);

/** The provider-compatible structural envelope consumed by provider and verifier code. */
export const agentDecisionSchema = z.object({ decision }).strict();

export type AgentDecision = z.infer<typeof decision>;
export type AgentDecisionEnvelope = z.infer<typeof agentDecisionSchema>;

const generatedAgentDecisionJsonSchema = z.toJSONSchema(agentDecisionSchema, {
  target: 'draft-7',
  reused: 'inline',
  override: ({ jsonSchema }) => {
    const description = jsonSchema.description;
    if (typeof description !== 'string' || !description.startsWith(PROVIDER_TEXT_MARKER_PREFIX)) return;
    delete jsonSchema.description;
    jsonSchema.maxLength = Number(description.slice(PROVIDER_TEXT_MARKER_PREFIX.length));
  },
});

const { $schema: _jsonSchemaDialect, ...providerJsonSchema } = generatedAgentDecisionJsonSchema;

/** Direct provider schema for OpenAI-compatible response_format.json_schema.schema. */
export const agentDecisionJsonSchema = providerJsonSchema;

export class AgentDecisionError extends Error {
  constructor(readonly code: 'AGENT_DECISION_INVALID' = 'AGENT_DECISION_INVALID') {
    super('Invalid agent decision.');
    this.name = 'AgentDecisionError';
  }
}

function normalizeDecision(decision: AgentDecision): AgentDecision {
  if (decision.kind === 'abstain') return { ...decision, rationale: decision.rationale.normalize('NFC') };
  if (decision.taxCalculation === 'NotApplicable') {
    return {
      ...decision,
      rationale: decision.rationale.normalize('NFC'),
      tagIds: [...decision.tagIds],
      evidence: decision.evidence.map((entry) => ({ ...entry })),
      lines: decision.lines.map((line) => ({
        ...line,
        memo: line.memo === null ? null : line.memo.normalize('NFC'),
        tagIds: [...line.tagIds],
      })),
    };
  }
  return {
    ...decision,
    rationale: decision.rationale.normalize('NFC'),
    tagIds: [...decision.tagIds],
    evidence: decision.evidence.map((entry) => ({ ...entry })),
    lines: decision.lines.map((line) => ({
      ...line,
      memo: line.memo === null ? null : line.memo.normalize('NFC'),
      tagIds: [...line.tagIds],
    })),
  };
}

/** Structural parsing mirrors the provider schema; NFC normalization happens only after it succeeds. */
export function parseAgentDecision(value: unknown): AgentDecision {
  const parsed = agentDecisionSchema.safeParse(value);
  if (!parsed.success) throw new AgentDecisionError();
  return normalizeDecision(parsed.data.decision);
}
