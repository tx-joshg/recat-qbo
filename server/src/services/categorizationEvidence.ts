import { QBO_NOT_APPLICABLE_TAX_CODE } from '@recat/shared';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from './agent/evaluation.js';
import { candidateContextFor } from './agent/ruleCandidates.js';

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const EVIDENCE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVIDENCE_QBO_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isEvidenceTagIds(value: unknown): value is string[] {
  return (
    isStringArray(value)
    && value.length <= 50
    && new Set(value).size === value.length
    && value.every((tagId) => EVIDENCE_UUID_PATTERN.test(tagId))
  );
}

function isEvidenceQboReference(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length <= 120
    && EVIDENCE_QBO_REFERENCE_PATTERN.test(value)
  );
}

function isVerifiedCategorizationProposal(
  value: unknown,
): value is VerifiedCategorizationProposal {
  if (!isRuntimeRecord(value)) return false;
  if (
    value.taxCalculation !== 'TaxInclusive'
    && value.taxCalculation !== 'TaxExcluded'
    && value.taxCalculation !== 'NotApplicable'
  ) {
    return false;
  }
  if (
    !isEvidenceTagIds(value.tagIds)
    || !Array.isArray(value.lines)
    || value.lines.length === 0
    || value.lines.length > 20
  ) {
    return false;
  }
  const indexes = new Set<number>();
  return value.lines.every((line) => {
    if (!isRuntimeRecord(line)) return false;
    if (
      !Number.isSafeInteger(line.idx)
      || (line.idx as number) < 0
      || indexes.has(line.idx as number)
    ) {
      return false;
    }
    indexes.add(line.idx as number);
    const subtotalCents = line.subtotalCents;
    const taxCents = line.taxCents;
    const totalCents = line.totalCents;
    return (
      Number.isSafeInteger(subtotalCents)
      && Number.isSafeInteger(taxCents)
      && Number.isSafeInteger(totalCents)
      && Number.isSafeInteger((subtotalCents as number) + (taxCents as number))
      && (subtotalCents as number) + (taxCents as number) === totalCents
      && isEvidenceQboReference(line.categoryQboId)
      && (
        value.taxCalculation === 'NotApplicable'
          ? (line.taxCodeQboId === null || line.taxCodeQboId === QBO_NOT_APPLICABLE_TAX_CODE)
          : isEvidenceQboReference(line.taxCodeQboId)
      )
      && (
        line.memo === null
        || (typeof line.memo === 'string' && line.memo.length <= 500)
      )
      && isEvidenceTagIds(line.tagIds)
    );
  });
}

export function persistedEvidenceProposal(
  value: unknown,
): VerifiedCategorizationProposal | null {
  if (!isRuntimeRecord(value)) return null;
  const evidence = value.categorizationEvidence;
  if (
    !isRuntimeRecord(evidence)
    || evidence.version !== 1
    || !isVerifiedCategorizationProposal(evidence.proposal)
  ) {
    return null;
  }
  return evidence.proposal;
}

export function persistedRuleCandidateContext(
  value: unknown,
): VerifiedCategorizationOutcome['candidateContext'] {
  if (!isRuntimeRecord(value)) return null;
  const context = value.ruleCandidateEvidence;
  if (
    !isRuntimeRecord(context)
    || context.version !== 1
    || context.schemaVersion !== 'rule-candidate-v1'
    || context.matchField !== 'payee'
    || typeof context.matchText !== 'string'
    || typeof context.conditionFingerprint !== 'string'
    || typeof context.configVersion !== 'string'
    || context.configVersion.trim() === ''
    || (
      context.source !== 'user'
      && context.source !== 'autopilot'
      && context.source !== 'mcp'
    )
  ) {
    return null;
  }
  const canonical = candidateContextFor(
    context.matchText,
    context.configVersion,
    context.source,
  );
  if (
    canonical === null
    || canonical.conditionFingerprint !== context.conditionFingerprint
  ) {
    return null;
  }
  return canonical;
}
