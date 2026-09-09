import type { AgentDecision } from './decision.js';
import type { AgentTransactionSnapshot } from './snapshot.js';

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type AgentVerificationFailureCode =
  | 'AGENT_LINE_TOTAL_UNSAFE'
  | 'AGENT_LINE_AMOUNT_ZERO'
  | 'AGENT_LINE_SIGN_MISMATCH'
  | 'AGENT_LINE_TOTAL_UNBALANCED'
  | 'AGENT_CATEGORY_REFERENCE_INVALID'
  | 'AGENT_TAX_NOT_READY'
  | 'AGENT_TAX_MODE_UNSUPPORTED'
  | 'AGENT_TAX_REFERENCE_MISSING'
  | 'AGENT_TAX_REFERENCE_INVALID'
  | 'AGENT_TAX_REFERENCE_NOT_APPLICABLE'
  | 'AGENT_TAG_REFERENCE_INVALID'
  | 'AGENT_TAG_REFERENCE_DUPLICATE'
  | 'AGENT_EVIDENCE_REFERENCE_DUPLICATE'
  | 'AGENT_EVIDENCE_PAIR_INCONSISTENT'
  | 'AGENT_EVIDENCE_RULE_INVALID'
  | 'AGENT_EVIDENCE_RULE_INCONSISTENT'
  | 'AGENT_EVIDENCE_HISTORY_INVALID'
  | 'AGENT_EVIDENCE_HISTORY_INCONSISTENT'
  | 'AGENT_EVIDENCE_CATEGORY_INVALID'
  | 'AGENT_EVIDENCE_CATEGORY_INCONSISTENT'
  | 'AGENT_EVIDENCE_TAX_INVALID'
  | 'AGENT_EVIDENCE_TAX_INCONSISTENT'
  | 'AGENT_DISTINCT_REVIEW_REJECTED';

export type AgentVerification =
  | {
    readonly ok: true;
    readonly code: 'AGENT_DECISION_VERIFIED' | 'AGENT_DECISION_ABSTAIN';
    readonly message: string;
    readonly decision: DeepReadonly<AgentDecision>;
  }
  | {
    readonly ok: false;
    readonly code: AgentVerificationFailureCode;
    readonly message: string;
  };

const FAILURE_MESSAGES: Readonly<Record<AgentVerificationFailureCode, string>> = {
  AGENT_LINE_TOTAL_UNSAFE: 'Proposal line total exceeds the safe integer range.',
  AGENT_LINE_AMOUNT_ZERO: 'Proposal lines must be nonzero.',
  AGENT_LINE_SIGN_MISMATCH: 'Proposal line direction does not match the transaction.',
  AGENT_LINE_TOTAL_UNBALANCED: 'Proposal lines do not balance to the transaction.',
  AGENT_CATEGORY_REFERENCE_INVALID: 'Proposal references an unavailable category.',
  AGENT_TAX_NOT_READY: 'Proposal requires tax references that are not ready.',
  AGENT_TAX_MODE_UNSUPPORTED: 'Proposal uses an unsupported tax calculation mode.',
  AGENT_TAX_REFERENCE_MISSING: 'A taxable proposal line is missing a tax reference.',
  AGENT_TAX_REFERENCE_INVALID: 'Proposal references an unavailable tax code.',
  AGENT_TAX_REFERENCE_NOT_APPLICABLE: 'A non-taxable proposal line includes a tax reference.',
  AGENT_TAG_REFERENCE_INVALID: 'Proposal references an unavailable tag.',
  AGENT_TAG_REFERENCE_DUPLICATE: 'Proposal contains a duplicate tag reference.',
  AGENT_EVIDENCE_REFERENCE_DUPLICATE: 'Proposal contains a duplicate evidence reference.',
  AGENT_EVIDENCE_PAIR_INCONSISTENT: 'Evidence does not cover every selected category and tax pairing.',
  AGENT_EVIDENCE_RULE_INVALID: 'Proposal references an unavailable rule.',
  AGENT_EVIDENCE_RULE_INCONSISTENT: 'Rule evidence is inconsistent with the proposal.',
  AGENT_EVIDENCE_HISTORY_INVALID: 'Proposal references unavailable verified history.',
  AGENT_EVIDENCE_HISTORY_INCONSISTENT: 'Verified-history evidence is inconsistent with the proposal.',
  AGENT_EVIDENCE_CATEGORY_INVALID: 'Proposal evidence references an unavailable category.',
  AGENT_EVIDENCE_CATEGORY_INCONSISTENT: 'Category evidence is inconsistent with the proposal.',
  AGENT_EVIDENCE_TAX_INVALID: 'Proposal evidence references an unavailable tax code.',
  AGENT_EVIDENCE_TAX_INCONSISTENT: 'Tax evidence is inconsistent with the proposal.',
  AGENT_DISTINCT_REVIEW_REJECTED: 'Distinct live review did not approve the proposal.',
};

export const agentLiveReviewSchemaName = 'recat_live_review_v1';
export const agentLiveReviewIssueCodes = [
  'DECISION_NOT_SUPPORTED',
  'SNAPSHOT_MISMATCH',
  'EVIDENCE_INSUFFICIENT',
  'REFERENCE_INVALID',
  'TAX_INVALID',
] as const;
export type AgentLiveReviewIssueCode = (typeof agentLiveReviewIssueCodes)[number];
export interface AgentLiveReview {
  readonly approved: boolean;
  readonly issues: readonly AgentLiveReviewIssueCode[];
}

export const agentLiveReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'issues'],
  properties: {
    approved: { type: 'boolean' },
    issues: {
      type: 'array',
      maxItems: agentLiveReviewIssueCodes.length,
      uniqueItems: true,
      items: { type: 'string', enum: [...agentLiveReviewIssueCodes] },
    },
  },
} as const;

export function parseAgentLiveReview(value: unknown): AgentLiveReview {
  if (!isPlainRecord(value)) throw new Error('Invalid live review.');
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes('approved')
    || !keys.includes('issues')
    || typeof value.approved !== 'boolean'
    || !Array.isArray(value.issues)
    || value.issues.length > agentLiveReviewIssueCodes.length
  ) {
    throw new Error('Invalid live review.');
  }
  const allowed = new Set<string>(agentLiveReviewIssueCodes);
  const issues = value.issues;
  if (
    issues.some((issue) => typeof issue !== 'string' || !allowed.has(issue))
    || new Set(issues).size !== issues.length
    || (value.approved && issues.length !== 0)
    || (!value.approved && issues.length === 0)
  ) {
    throw new Error('Invalid live review.');
  }
  return deepFreeze({
    approved: value.approved,
    issues: [...issues] as AgentLiveReviewIssueCode[],
  });
}

export function verifyAgentDecision(
  snapshot: AgentTransactionSnapshot,
  decision: AgentDecision,
): AgentVerification {
  if (decision.kind === 'abstain') {
    return accepted('AGENT_DECISION_ABSTAIN', 'Agent abstention is structurally valid.', decision);
  }

  const transactionSign = Math.sign(snapshot.signedAmountCents);
  let lineTotal = 0;
  for (const line of decision.lines) {
    if (line.grossCents === 0) return rejected('AGENT_LINE_AMOUNT_ZERO');
    if (Math.sign(line.grossCents) !== transactionSign) {
      return rejected('AGENT_LINE_SIGN_MISMATCH');
    }
    lineTotal += line.grossCents;
    if (!Number.isSafeInteger(lineTotal)) return rejected('AGENT_LINE_TOTAL_UNSAFE');
  }
  if (lineTotal !== snapshot.signedAmountCents) {
    return rejected('AGENT_LINE_TOTAL_UNBALANCED');
  }

  const categories = new Set(snapshot.candidateCategories.map((entry) => entry.qboId));
  const selectedCategories = new Set(decision.lines.map((line) => line.categoryQboId));
  if ([...selectedCategories].some((qboId) => !categories.has(qboId))) {
    return rejected('AGENT_CATEGORY_REFERENCE_INVALID');
  }

  const availableTags = new Set(snapshot.tags.map((entry) => entry.id));
  for (const ids of [decision.tagIds, ...decision.lines.map((line) => line.tagIds)]) {
    if (new Set(ids).size !== ids.length) {
      return rejected('AGENT_TAG_REFERENCE_DUPLICATE');
    }
    if (ids.some((id) => !availableTags.has(id))) {
      return rejected('AGENT_TAG_REFERENCE_INVALID');
    }
  }

  const availableTaxReferences = new Set(
    snapshot.tax.eligibleReferences.map((entry) => entry.qboId),
  );
  const selectedTaxReferences = new Set<string>();
  if (decision.taxCalculation === 'NotApplicable') {
    if (decision.lines.some((line) => line.taxCodeQboId !== null)) {
      return rejected('AGENT_TAX_REFERENCE_NOT_APPLICABLE');
    }
  } else {
    if (snapshot.tax.status !== 'ready') return rejected('AGENT_TAX_NOT_READY');
    if (!snapshot.tax.supportedCalculationModes.includes(decision.taxCalculation)) {
      return rejected('AGENT_TAX_MODE_UNSUPPORTED');
    }
    for (const line of decision.lines) {
      if (line.taxCodeQboId === null) return rejected('AGENT_TAX_REFERENCE_MISSING');
      if (!availableTaxReferences.has(line.taxCodeQboId)) {
        return rejected('AGENT_TAX_REFERENCE_INVALID');
      }
      selectedTaxReferences.add(line.taxCodeQboId);
    }
  }
  const selectedPairs = new Set(
    decision.lines.map((line) => categoryTaxPair(
      line.categoryQboId,
      line.taxCodeQboId,
    )),
  );

  const evidenceKeys = decision.evidence.map(evidenceKey);
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    return rejected('AGENT_EVIDENCE_REFERENCE_DUPLICATE');
  }

  const rules = new Map(snapshot.rules.map((entry) => [entry.id, entry]));
  const history = new Map(
    snapshot.similarVerifiedTransactions.map((entry) => [entry.transactionId, entry]),
  );
  const evidencedPairs = new Set<string>();
  for (const evidence of decision.evidence) {
    switch (evidence.kind) {
      case 'rule': {
        const rule = rules.get(evidence.id);
        if (rule === undefined) return rejected('AGENT_EVIDENCE_RULE_INVALID');
        if (
          rule.action.taxCalculation !== decision.taxCalculation
          || !selectedPairs.has(categoryTaxPair(
            rule.action.categoryQboId,
            rule.action.taxCodeQboId,
          ))
        ) {
          return rejected('AGENT_EVIDENCE_RULE_INCONSISTENT');
        }
        evidencedPairs.add(categoryTaxPair(rule.action.categoryQboId, rule.action.taxCodeQboId));
        break;
      }
      case 'similar_transaction': {
        const transaction = history.get(evidence.transactionId);
        if (transaction === undefined) return rejected('AGENT_EVIDENCE_HISTORY_INVALID');
        const matchingLines = transaction.taxCalculation === decision.taxCalculation
          ? transaction.lines.filter((line) =>
            selectedPairs.has(categoryTaxPair(
              line.categoryQboId,
              line.taxCodeQboId,
            )))
          : [];
        if (matchingLines.length === 0) {
          return rejected('AGENT_EVIDENCE_HISTORY_INCONSISTENT');
        }
        for (const line of matchingLines) {
          evidencedPairs.add(categoryTaxPair(
            line.categoryQboId,
            line.taxCodeQboId,
          ));
        }
        break;
      }
      case 'category':
        if (!categories.has(evidence.qboId)) {
          return rejected('AGENT_EVIDENCE_CATEGORY_INVALID');
        }
        if (!selectedCategories.has(evidence.qboId)) {
          return rejected('AGENT_EVIDENCE_CATEGORY_INCONSISTENT');
        }
        break;
      case 'tax_code':
        if (!availableTaxReferences.has(evidence.qboId)) {
          return rejected('AGENT_EVIDENCE_TAX_INVALID');
        }
        if (!selectedTaxReferences.has(evidence.qboId)) {
          return rejected('AGENT_EVIDENCE_TAX_INCONSISTENT');
        }
        break;
    }
  }
  if ([...selectedPairs].some((pair) => !evidencedPairs.has(pair))) {
    return rejected('AGENT_EVIDENCE_PAIR_INCONSISTENT');
  }

  return accepted('AGENT_DECISION_VERIFIED', 'Agent proposal passed deterministic verification.', decision);
}

function categoryTaxPair(categoryQboId: string, taxCodeQboId: string | null): string {
  return JSON.stringify([categoryQboId, taxCodeQboId]);
}

function evidenceKey(
  evidence: Extract<AgentDecision, { kind: 'proposal' }>['evidence'][number],
): string {
  switch (evidence.kind) {
    case 'rule':
      return `rule:${evidence.id}`;
    case 'similar_transaction':
      return `similar_transaction:${evidence.transactionId}`;
    case 'category':
      return `category:${evidence.qboId}`;
    case 'tax_code':
      return `tax_code:${evidence.qboId}`;
  }
}

function rejected(code: AgentVerificationFailureCode): AgentVerification {
  return deepFreeze({ ok: false as const, code, message: FAILURE_MESSAGES[code] });
}

function accepted(
  code: 'AGENT_DECISION_VERIFIED' | 'AGENT_DECISION_ABSTAIN',
  message: string,
  decision: AgentDecision,
): AgentVerification {
  return deepFreeze({
    ok: true as const,
    code,
    message,
    decision: structuredClone(decision),
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor;
  });
}
