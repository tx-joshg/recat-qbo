import { createHash } from 'node:crypto';
import {
  QBO_NOT_APPLICABLE_TAX_CODE,
  type ClassificationCaseContext,
  type ClassificationCitation,
  type ClassificationOriginIntent,
  type ClassificationReviewer,
} from '@recat/shared';
import { z } from 'zod';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from './agent/evaluation.js';
import { candidateContextFor } from './agent/ruleCandidates.js';
import { normalizeVendorLookupKey } from './classification/vendorIdentity.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DECISION_CONTEXT_MAX_BYTES = 32 * 1024;

export interface CategorizationDecisionContext {
  vendorIdentityHint: {
    displayName: string;
    qboVendorId: string | null;
  } | null;
  rationale: string;
  requiredEvidence: string[];
  examples: string[];
  counterexamples: string[];
  citations: ClassificationCitation[];
  reviewer: ClassificationReviewer;
  originIntent: ClassificationOriginIntent;
  jurisdiction: string;
  currency: string;
  context: ClassificationCaseContext;
}

export interface NormalizedCategorizationDecisionContext
  extends CategorizationDecisionContext {
  vendorIdentityHint: {
    displayName: string;
    normalizedName: string;
    qboVendorId: string | null;
  } | null;
}

export interface PersistedClassificationDecision {
  version: 1;
  context: NormalizedCategorizationDecisionContext;
  contextHash: string;
  preparedBindingHash: string;
}

export interface PersistedClassificationEvidenceBinding {
  version: 1;
  proposalHash: string;
  candidateContextHash: string;
  preparedBindingHash: string;
}

export const CLASSIFICATION_ENVELOPE_VERSION = 2 as const;

function boundedText(maximum: number) {
  return z.string().superRefine((value, context) => {
    const normalized = value.normalize('NFC').trim();
    if (
      normalized.length === 0
      || Array.from(normalized).length > maximum
      || CONTROL_CHARACTER.test(value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Text is outside its bounded classification limit.',
      });
    }
  }).transform((value) => value.normalize('NFC').trim());
}

const text = boundedText(500);
const rationale = boundedText(2_000);
const textArray = z.array(text).max(20);
const nullableText = z.union([text, z.null()]);
const decisionContextSchema = z.object({
  vendorIdentityHint: z.object({
    displayName: text,
    // Persisted normalized envelopes contain this derived field. It is never
    // trusted: normalization below always recomputes it from displayName.
    normalizedName: text.optional(),
    qboVendorId: z.union([boundedText(120), z.null()]).optional().default(null),
  }).strict().nullable(),
  rationale,
  requiredEvidence: textArray,
  examples: textArray,
  counterexamples: textArray,
  citations: z.array(z.object({
    url: z.string().max(2_048).url().refine(
      (value) => value.startsWith('https://'),
      'Only HTTPS citations are allowed.',
    ),
    title: text,
    publisher: text,
    retrievedAt: z.string().max(64).refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'Citation time must be an ISO date or date-time.',
    ).transform((value) => new Date(value).toISOString()),
    claimSummary: rationale,
  }).strict()).max(10),
  reviewer: z.object({
    userId: z.union([boundedText(128), z.null()]),
    configVersion: boundedText(128),
    decision: z.literal('approved'),
  }).strict(),
  originIntent: z.enum(['apply_once', 'make_recurring', 'auto_candidate']),
  jurisdiction: z.union([z.literal('unknown'), boundedText(128)]),
  currency: z.string().regex(/^[A-Za-z]{3}$/u).transform((value) => value.toUpperCase()),
  context: z.object({
    transactionDirection: z.enum(['in', 'out', 'unknown']),
    qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
    sourceAccountName: nullableText,
    businessPurpose: nullableText,
  }).strict(),
}).strict();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function normalizeCategorizationDecisionContext(
  value: CategorizationDecisionContext,
): NormalizedCategorizationDecisionContext {
  const parsed = decisionContextSchema.parse(value);
  const hint = parsed.vendorIdentityHint;
  const normalized: NormalizedCategorizationDecisionContext = {
    ...parsed,
    vendorIdentityHint: hint === null
      ? null
      : {
          displayName: hint.displayName,
          normalizedName: normalizeVendorLookupKey(hint.displayName),
          qboVendorId: hint.qboVendorId,
        },
  };
  if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > DECISION_CONTEXT_MAX_BYTES) {
    throw new Error('Decision context exceeds its bounded JSON limit.');
  }
  return normalized;
}

export function categorizationDecisionContextHash(
  context: NormalizedCategorizationDecisionContext,
): string {
  return sha256(context);
}

export function classificationDecisionForPreparedWrite(
  context: NormalizedCategorizationDecisionContext,
  preparedWriteHash: string,
): PersistedClassificationDecision {
  const contextHash = categorizationDecisionContextHash(context);
  return {
    version: 1,
    context,
    contextHash,
    preparedBindingHash: sha256({
      preparedWriteHash,
      contextHash,
    }),
  };
}

export function classificationEvidenceBindingForPreparedWrite(
  proposal: VerifiedCategorizationProposal,
  candidateContext: VerifiedCategorizationOutcome['candidateContext'],
  preparedWriteHash: string,
): PersistedClassificationEvidenceBinding {
  const proposalHash = sha256(proposal);
  const candidateContextHash = sha256(candidateContext);
  return {
    version: 1,
    proposalHash,
    candidateContextHash,
    preparedBindingHash: sha256({
      preparedWriteHash,
      proposalHash,
      candidateContextHash,
    }),
  };
}

export function persistedClassificationEvidenceBinding(
  value: unknown,
  proposal: VerifiedCategorizationProposal,
  candidateContext: VerifiedCategorizationOutcome['candidateContext'],
  expectedPreparedWriteHash: string,
): PersistedClassificationEvidenceBinding | null {
  if (!isRuntimeRecord(value)) return null;
  const stored = value.classificationEvidenceBinding;
  if (
    !isRuntimeRecord(stored)
    || stored.version !== 1
    || typeof stored.proposalHash !== 'string'
    || typeof stored.candidateContextHash !== 'string'
    || typeof stored.preparedBindingHash !== 'string'
  ) return null;
  const canonical = classificationEvidenceBindingForPreparedWrite(
    proposal,
    candidateContext,
    expectedPreparedWriteHash,
  );
  return (
    stored.proposalHash === canonical.proposalHash
    && stored.candidateContextHash === canonical.candidateContextHash
    && stored.preparedBindingHash === canonical.preparedBindingHash
  ) ? canonical : null;
}

export function classificationEnvelopeHashForPreparedWrite(
  preparedWriteHash: string,
  decision: PersistedClassificationDecision | null,
  evidence: PersistedClassificationEvidenceBinding | null,
): string {
  return sha256({
    version: CLASSIFICATION_ENVELOPE_VERSION,
    preparedWriteHash,
    decision: decision === null
      ? null
      : {
          contextHash: decision.contextHash,
          preparedBindingHash: decision.preparedBindingHash,
        },
    evidence,
  });
}

export function persistedClassificationDecision(
  value: unknown,
  expectedPreparedWriteHash: string,
): PersistedClassificationDecision | null {
  if (!isRuntimeRecord(value)) return null;
  const stored = value.classificationDecision;
  if (
    !isRuntimeRecord(stored)
    || stored.version !== 1
    || typeof stored.contextHash !== 'string'
    || typeof stored.preparedBindingHash !== 'string'
  ) {
    return null;
  }
  let context: NormalizedCategorizationDecisionContext;
  try {
    context = normalizeCategorizationDecisionContext(
      stored.context as CategorizationDecisionContext,
    );
  } catch {
    return null;
  }
  const canonical = classificationDecisionForPreparedWrite(
    context,
    expectedPreparedWriteHash,
  );
  return (
    canonical.contextHash === stored.contextHash
    && canonical.preparedBindingHash === stored.preparedBindingHash
  ) ? canonical : null;
}

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
          ? (
              line.taxCodeQboId === null
              || line.taxCodeQboId === QBO_NOT_APPLICABLE_TAX_CODE
            )
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
