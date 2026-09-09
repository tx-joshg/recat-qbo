import { z } from 'zod';
import type {
  ClassificationAction,
  ClassificationActionSummary,
  ClassificationCase,
  ClassificationCitation,
  ClassificationConflict,
  ClassificationError,
  ClassificationErrorCode,
  HistoricalObservationProvenance,
  ClassificationProvenance,
  ClassificationSearchHit,
  ClassificationSearchResult,
  ClassificationReviewer,
  ClassificationRuleCondition,
  RuleMutationPreview,
  RuleCandidateMutationResult,
  RuleMutationResult,
  RuleMutationSample,
  RuleRevision,
  VendorAlias,
  VendorIdentity,
} from '@recat/shared';

/**
 * Public classification-memory limits. These are deliberately small enough
 * for MCP and agent cards, and large enough to preserve useful accounting
 * provenance. They are contract limits, not database column sizes.
 */
export const CLASSIFICATION_CONTRACT_LIMITS = Object.freeze({
  identifier: 128,
  text: 500,
  rationale: 2_000,
  query: 256,
  companyName: 200,
  array: 20,
  tags: 50,
  citations: 10,
  conflicts: 20,
  hits: 100,
  warnings: 20,
  samples: 20,
  total: 10_000,
  date: 64,
  url: 2_048,
} as const);

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_REVISION = 2_147_483_647;

function normalized(value: string): string {
  return value.normalize('NFC').trim();
}

function lookupKey(value: string): string {
  return normalized(value).replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/**
 * Zod's UTF-16 maxLength is not a code-point limit. The second refinement
 * keeps bounded contracts bounded for astral Unicode input as well.
 */
function boundedText(
  maximum: number,
  minimum = 1,
){
  return z.string()
    .max(maximum * 2)
    .superRefine((value, context) => {
      const valueLength = Array.from(normalized(value)).length;
      if (valueLength < minimum) {
        context.addIssue({
          code: z.ZodIssueCode.too_small,
          type: 'string',
          minimum,
          inclusive: true,
          message: 'Text is empty.',
        });
      }
      if (valueLength > maximum) {
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          type: 'string',
          maximum,
          inclusive: true,
          message: 'Text is too long.',
        });
      }
      if (!SAFE_TEXT.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.invalid_string,
          validation: 'regex',
          message: 'Text contains a control character.',
        });
      }
    })
    .transform(normalized);
}

const identifier = boundedText(CLASSIFICATION_CONTRACT_LIMITS.identifier);
const nullableIdentifier = z.union([identifier, z.null()]);
const qboReference = boundedText(120);
const text = boundedText(CLASSIFICATION_CONTRACT_LIMITS.text);
const nullableText = z.union([text, z.null()]);
const rationale = boundedText(CLASSIFICATION_CONTRACT_LIMITS.rationale);
const dateTime = boundedText(CLASSIFICATION_CONTRACT_LIMITS.date).refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Expected an ISO date or date-time.',
);
const currency = z.string().regex(/^[A-Z]{3}$/u, 'Expected a three-letter currency.');
const safeInteger = z.number()
  .int()
  .min(-MAX_SAFE_INTEGER)
  .max(MAX_SAFE_INTEGER);
const nonNegativeCount = z.number().int().min(0).max(CLASSIFICATION_CONTRACT_LIMITS.total);
const ruleImpactCount = z.number().int().min(0).max(MAX_REVISION);
const revision = z.number().int().min(0).max(MAX_REVISION);
const score = z.number().finite().min(0).max(1_000_000);
const tagIds = z.array(z.string().uuid())
  .max(CLASSIFICATION_CONTRACT_LIMITS.tags)
  .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.');
const boundedTextArray = z.array(text).max(CLASSIFICATION_CONTRACT_LIMITS.array);

const originIntent = z.enum(['apply_once', 'make_recurring', 'auto_candidate']);
const ruleOriginIntent = z.enum(['make_recurring', 'auto_candidate']).nullable();
const taxCalculation = z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']);

/** A single-line tax-aware action; this is not a rule mutation kind. */
export const classificationActionSchema = z.object({
  categoryQboId: qboReference,
  taxCalculation,
  taxCodeQboId: z.union([qboReference, z.null()]),
  tagIds,
  memo: nullableText.optional(),
}).strict().superRefine((value, context) => {
  if (value.taxCalculation === 'NotApplicable' && value.taxCodeQboId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeQboId'],
      message: 'NotApplicable actions cannot carry a tax-code QBO ID.',
    });
  }
  if (
    value.taxCalculation !== 'NotApplicable'
    && value.taxCodeQboId === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeQboId'],
      message: 'Taxable actions require a tax-code QBO ID.',
    });
  }
});

export const classificationActionSummarySchema = z.object({
  categoryName: text,
  taxCalculation,
  taxCodeName: nullableText,
  tagNames: z.array(text).max(CLASSIFICATION_CONTRACT_LIMITS.tags),
}).strict().superRefine((value, context) => {
  if (value.taxCalculation === 'NotApplicable' && value.taxCodeName !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeName'],
      message: 'NotApplicable summaries cannot carry a tax-code name.',
    });
  }
  if (value.taxCalculation !== 'NotApplicable' && value.taxCodeName === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeName'],
      message: 'Taxable summaries require a tax-code name.',
    });
  }
});

export const classificationRuleConditionSchema = z.object({
  matchField: z.literal('payee'),
  matchText: text,
}).strict();

export const classificationCitationSchema = z.object({
  url: z.string()
    .max(CLASSIFICATION_CONTRACT_LIMITS.url)
    .url()
    .refine((value) => value.startsWith('https://'), 'Only HTTPS citations are allowed.'),
  title: text,
  publisher: text,
  retrievedAt: dateTime,
  claimSummary: boundedText(CLASSIFICATION_CONTRACT_LIMITS.rationale),
}).strict();

export const classificationProvenanceSchema = z.object({
  source: z.enum(['user', 'mcp', 'autopilot', 'qbo_verified', 'rule', 'candidate', 'historical_observation']),
  sourceId: identifier,
  actorId: nullableIdentifier,
  recordedAt: dateTime,
}).strict();

export const historicalObservationProvenanceSchema: z.ZodType<HistoricalObservationProvenance> = z.object({
  sourceTransactionId: identifier,
  sourceQboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
  sourceQboId: boundedText(128),
  sourceTransactionRevision: safeInteger.min(0),
  sourceQboSyncToken: boundedText(128),
  sourceStatus: z.literal('POSTED'),
  sourceUpdatedAt: dateTime,
  observedAt: dateTime,
}).strict();

export const classificationConflictSchema = z.object({
  id: identifier,
  companyId: identifier,
  sourceId: identifier,
  kind: z.enum(['case', 'candidate', 'rule', 'jurisdiction', 'tax']),
  reason: text,
  action: classificationActionSchema.nullable(),
  actionSummary: classificationActionSummarySchema.nullable(),
  evidenceCount: nonNegativeCount,
}).strict().superRefine((value, context) => {
  if (value.action !== null && value.actionSummary === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSummary'],
      message: 'Executable action details require a human-readable summary.',
    });
  }
  if (
    value.action !== null
    && value.actionSummary !== null
    && value.action.taxCalculation !== value.actionSummary.taxCalculation
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSummary', 'taxCalculation'],
      message: 'Action summary tax treatment must match the exact action.',
    });
  }
});

export const vendorAliasSchema = z.object({
  id: identifier,
  companyId: identifier,
  vendorIdentityId: identifier,
  value: text,
  normalizedValue: text,
  source: z.enum(['qbo', 'user', 'import', 'inferred']),
  createdAt: dateTime,
}).strict().superRefine((value, context) => {
  if (value.normalizedValue !== lookupKey(value.value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['normalizedValue'],
      message: 'normalizedValue must be the deterministic alias lookup key.',
    });
  }
});

export const vendorIdentitySchema = z.object({
  id: identifier,
  companyId: identifier,
  qboVendorId: nullableIdentifier,
  displayName: text,
  normalizedName: text,
  aliases: z.array(vendorAliasSchema).max(CLASSIFICATION_CONTRACT_LIMITS.array),
  createdAt: dateTime,
  updatedAt: dateTime,
}).strict().superRefine((value, context) => {
  if (value.normalizedName !== lookupKey(value.displayName)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['normalizedName'],
      message: 'normalizedName must be the deterministic identity lookup key.',
    });
  }
  value.aliases.forEach((alias, index) => {
    if (alias.companyId !== value.companyId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'companyId'],
        message: 'Alias company scope must match its identity.',
      });
    }
    if (alias.vendorIdentityId !== value.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'vendorIdentityId'],
        message: 'Alias identity scope must match its identity.',
      });
    }
  });
});

const classificationCaseContextSchema = z.object({
  transactionDirection: z.enum(['in', 'out', 'unknown']),
  qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
  sourceAccountName: nullableText,
  businessPurpose: nullableText,
}).strict();

const classificationReviewerSchema = z.object({
  userId: nullableIdentifier,
  configVersion: identifier,
  decision: z.literal('approved'),
}).strict();

const jurisdiction = z.union([z.literal('unknown'), boundedText(128)]);

export const classificationCaseSchema = z.object({
  id: identifier,
  companyId: identifier,
  transactionId: identifier,
  vendorIdentityId: nullableIdentifier,
  qboMutationAttemptId: identifier,
  action: classificationActionSchema,
  actionFingerprint: identifier,
  originIntent,
  rationale,
  requiredEvidence: boundedTextArray,
  examples: boundedTextArray,
  counterexamples: boundedTextArray,
  citations: z.array(classificationCitationSchema)
    .max(CLASSIFICATION_CONTRACT_LIMITS.citations),
  reviewer: classificationReviewerSchema,
  jurisdiction,
  currency,
  context: classificationCaseContextSchema,
  provenance: classificationProvenanceSchema,
  verifiedAt: dateTime,
  invalidatedAt: dateTime.nullable(),
  invalidationReason: nullableText,
}).strict().superRefine((value, context) => {
  if (value.invalidatedAt === null && value.invalidationReason !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invalidationReason'],
      message: 'An invalidation reason requires invalidatedAt.',
    });
  }
  if (value.invalidatedAt !== null && value.invalidationReason === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invalidationReason'],
      message: 'Invalidated cases require a bounded invalidation reason.',
    });
  }
});

const companyRelation = z.enum(['current', 'foreign']);
const matchedIn = z.array(z.enum([
  'alias',
  'rule',
  'candidate',
  'case',
  'observation',
  'lexical',
  'semantic',
])).min(1).max(7).refine(
  (values) => new Set(values).size === values.length,
  'matchedIn values must be unique.',
);

export const classificationSearchHitSchema = z.object({
  id: identifier,
  sourceId: identifier,
  kind: z.enum([
    'vendor_identity',
    'vendor_alias',
    'classification_case',
    'rule',
    'rule_candidate',
    'historical_observation',
  ]),
  companyId: identifier,
  companyName: boundedText(CLASSIFICATION_CONTRACT_LIMITS.companyName),
  companyRelation,
  executable: z.boolean(),
  advisory: z.boolean(),
  matchedIn,
  score,
  vendorIdentityId: nullableIdentifier,
  vendorName: nullableText,
  action: classificationActionSchema.nullable(),
  actionSummary: classificationActionSummarySchema.nullable(),
  originIntent: originIntent.nullable(),
  evidenceCount: nonNegativeCount,
  conflictingEvidenceCount: nonNegativeCount,
  conflicts: z.array(classificationConflictSchema)
    .max(CLASSIFICATION_CONTRACT_LIMITS.conflicts),
  provenance: classificationProvenanceSchema,
  rationale: z.union([rationale, z.null()]),
  examples: boundedTextArray,
  counterexamples: boundedTextArray,
  jurisdiction: z.union([jurisdiction, z.null()]),
  currency: z.union([currency, z.null()]),
  verifiedAt: z.union([dateTime, z.null()]),
  ruleRevision: z.union([revision, z.null()]),
  observation: historicalObservationProvenanceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.advisory && value.executable) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executable'],
      message: 'Advisory hits cannot be executable.',
    });
  }
  if (value.executable && value.action === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message: 'Executable hits require an exact QBO-ID action.',
    });
  }
  if (value.action !== null && value.actionSummary === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSummary'],
      message: 'Exact actions require a human-readable summary.',
    });
  }
  if (
    value.action !== null
    && value.actionSummary !== null
    && value.action.taxCalculation !== value.actionSummary.taxCalculation
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSummary', 'taxCalculation'],
      message: 'Action summary tax treatment must match the exact action.',
    });
  }
  if (
    value.companyRelation === 'foreign'
    && ['classification_case', 'rule', 'rule_candidate'].includes(value.kind)
    && value.actionSummary === null
    && value.rationale === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSummary'],
      message: 'Foreign classification knowledge must retain a redacted action summary or historical rationale.',
    });
  }
  if (
    value.action !== null
    && (value.jurisdiction === null || value.jurisdiction === 'unknown')
    && value.action.taxCalculation !== 'NotApplicable'
    && (value.executable || !value.advisory)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['jurisdiction'],
      message: 'Taxable hits with unknown jurisdiction must be advisory and non-executable.',
    });
  }
  if (value.companyRelation === 'foreign') {
    if (!value.advisory) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['advisory'],
        message: 'Foreign-company hits must be advisory.',
      });
    }
    if (value.executable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executable'],
        message: 'Foreign-company hits cannot be executable.',
      });
    }
    if (value.action !== null || value.conflicts.some((conflict) => conflict.action !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'Foreign-company hits cannot expose QBO identifiers.',
      });
    }
  }
  if (value.conflictingEvidenceCount < value.conflicts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conflictingEvidenceCount'],
      message: 'Conflict count cannot be lower than returned conflicts.',
    });
  }
  if (value.kind === 'historical_observation') {
    if (!value.advisory) context.addIssue({ code: z.ZodIssueCode.custom, path: ['advisory'], message: 'Historical observations must be advisory.' });
    if (value.executable) context.addIssue({ code: z.ZodIssueCode.custom, path: ['executable'], message: 'Historical observations cannot be executable.' });
    if (value.action !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'Historical observations cannot carry an executable action.' });
    if (value.actionSummary === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['actionSummary'], message: 'Historical observations require a display action summary.' });
    if (value.originIntent !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['originIntent'], message: 'Historical observations have no origin intent.' });
    if (value.verifiedAt !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedAt'], message: 'Historical observations are not verified cases.' });
    if (value.evidenceCount !== 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceCount'], message: 'Historical observations have no verified evidence.' });
    if (value.observation === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['observation'], message: 'Historical observations require snapshot provenance.' });
    if (value.provenance.source !== 'historical_observation') context.addIssue({ code: z.ZodIssueCode.custom, path: ['provenance', 'source'], message: 'Historical observations require historical-observation provenance.' });
  } else if (value.observation !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['observation'], message: 'Only historical observations can carry snapshot provenance.' });
  }
  for (const [index, conflict] of value.conflicts.entries()) {
    if (conflict.companyId !== value.companyId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conflicts', index, 'companyId'],
        message: 'Nested conflicts must share the parent hit company scope.',
      });
    }
  }
});

const requestedSearchMode = z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']);
const effectiveSearchMode = z.enum(['exact', 'lexical', 'hybrid', 'semantic']);
const degradedReason = z.enum([
  'semantic_unavailable',
  'vector_capability_unavailable',
  'embedding_not_configured',
  'lexical_only',
  'semantic_error',
]);

export const classificationSearchResultSchema = z.object({
  query: boundedText(CLASSIFICATION_CONTRACT_LIMITS.query),
  companyId: identifier,
  scope: z.enum(['current_company', 'accessible_companies']),
  mode: effectiveSearchMode,
  requestedMode: requestedSearchMode,
  degraded: z.boolean(),
  degradedReason: z.union([degradedReason, z.null()]),
  status: z.enum(['matched', 'no_match']),
  noMatch: z.boolean(),
  hits: z.array(classificationSearchHitSchema)
    .max(CLASSIFICATION_CONTRACT_LIMITS.hits),
  total: nonNegativeCount,
}).strict().superRefine((value, context) => {
  if (value.degraded !== (value.degradedReason !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['degradedReason'],
      message: 'Degraded results require one explicit degradation reason.',
    });
  }
  if (value.degraded && (value.requestedMode !== 'auto' || value.mode !== 'lexical')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestedMode'],
      message: 'Only auto search may degrade, and its effective mode must be lexical.',
    });
  }
  if (value.requestedMode === 'auto' && value.mode === 'lexical' && !value.degraded) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['degraded'],
      message: 'Auto-to-lexical fallback must be explicitly labelled degraded.',
    });
  }
  if (value.requestedMode !== 'auto' && value.requestedMode !== value.mode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'Explicit search modes cannot report a different effective mode.',
    });
  }
  for (const [index, hit] of value.hits.entries()) {
    const sameCompany = hit.companyId === value.companyId;
    if (sameCompany !== (hit.companyRelation === 'current')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hits', index, 'companyRelation'],
        message: 'Hit company relation must match the result company.',
      });
    }
    if (value.scope === 'current_company' && !sameCompany) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hits', index, 'companyId'],
        message: 'Current-company search cannot return foreign-company hits.',
      });
    }
  }
  const actualNoMatch = value.hits.length === 0 && value.total === 0;
  if (value.noMatch !== actualNoMatch || (value.status === 'no_match') !== actualNoMatch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'No-match status must agree with an empty result set.',
    });
  }
  if (value.total < value.hits.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: 'Total cannot be lower than the returned hit count.',
    });
  }
});

const ruleRevisionState = z.enum(['enabled', 'disabled', 'retired']);
const ruleMutationKind = z.enum([
  'create',
  'update',
  'review',
  'enable',
  'disable',
  'activate_candidate',
  'dismiss_candidate',
]);

export const ruleRevisionSchema = z.object({
  id: identifier,
  ruleId: identifier,
  companyId: identifier,
  revision,
  state: ruleRevisionState,
  condition: classificationRuleConditionSchema,
  direction: z.enum(['Purchase', 'Deposit']).nullable(),
  action: classificationActionSchema.nullable(),
  categoryName: text,
  taxCodeName: nullableText,
  priority: z.number().int().min(0).max(MAX_REVISION),
  autoPost: z.boolean(),
  originIntent: ruleOriginIntent,
  sourceCaseId: nullableIdentifier,
  sourceCandidateId: nullableIdentifier,
  changedBy: nullableIdentifier,
  createdAt: dateTime,
  retiredAt: dateTime.nullable(),
  canonicalVersion: z.number().int().positive().nullable(),
  repairReason: nullableText,
  affectedJournalEntryCount: nonNegativeCount.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === 'retired' && value.retiredAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['retiredAt'],
      message: 'Retired revisions require retiredAt.',
    });
  }
  // Canonical backfill folds Retired into Disabled while retaining its immutable
  // tombstone. It must remain non-executable until a reviewed reactivation.
  const preservedCanonicalRetirement = value.state === 'disabled'
    && value.canonicalVersion === 2
    && !value.autoPost;
  if (value.state !== 'retired' && value.retiredAt !== null && !preservedCanonicalRetirement) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['retiredAt'],
      message: 'Only retired or disabled canonical revisions with auto-post off may carry retiredAt.',
    });
  }
  if (
    value.action !== null
    && (value.action.taxCalculation === 'NotApplicable')
      !== (value.taxCodeName === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeName'],
      message: 'Tax-code display context must match the exact action treatment.',
    });
  }
});

export const ruleMutationSampleSchema = z.object({
  transactionId: identifier,
  payee: text,
  date: dateTime,
  amountCents: safeInteger,
  status: z.enum(['PENDING', 'POSTED', 'DRY_RUN']),
}).strict();

export const ruleMutationPreviewSchema = z.object({
  operationId: identifier,
  companyId: identifier,
  ruleId: nullableIdentifier,
  candidateId: nullableIdentifier,
  mutation: ruleMutationKind,
  originIntent: ruleOriginIntent,
  currentRevision: revision,
  proposedRevision: revision,
  condition: classificationRuleConditionSchema,
  direction: z.enum(['Purchase', 'Deposit']).nullable(),
  action: classificationActionSchema.nullable(),
  categoryName: text,
  taxCodeName: nullableText,
  autoPost: z.boolean(),
  affectedPendingCount: ruleImpactCount,
  affectedProcessedCount: ruleImpactCount,
  sampleTransactions: z.array(ruleMutationSampleSchema)
    .max(CLASSIFICATION_CONTRACT_LIMITS.samples),
  conflicts: z.array(classificationConflictSchema)
    .max(CLASSIFICATION_CONTRACT_LIMITS.conflicts),
  warnings: z.array(text).max(CLASSIFICATION_CONTRACT_LIMITS.warnings),
  expiresAt: dateTime,
  preparationDigest: z.string().regex(SHA256),
}).strict().superRefine((value, context) => {
  if (
    value.action === null
    && value.mutation !== 'disable'
    && value.mutation !== 'dismiss_candidate'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message: 'Only safety-reducing mutations may carry non-executable history.',
    });
  }
  if (value.proposedRevision !== value.currentRevision + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposedRevision'],
      message: 'Each rule mutation must append exactly one revision.',
    });
  }
  if (
    (value.mutation === 'create' || value.mutation === 'activate_candidate')
    && value.autoPost
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['autoPost'],
      message: 'Recurring and candidate origins always start suggestion-only.',
    });
  }
  if (value.mutation === 'create' && value.originIntent !== 'make_recurring') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['originIntent'],
      message: 'Rule creation requires an explicit make_recurring intent.',
    });
  }
  if (
    (value.mutation === 'activate_candidate' || value.mutation === 'dismiss_candidate')
    && value.originIntent !== 'auto_candidate'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['originIntent'],
      message: 'Candidate mutations require auto_candidate provenance.',
    });
  }
  if (
    value.action !== null
    && (value.action.taxCalculation === 'NotApplicable')
      !== (value.taxCodeName === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCodeName'],
      message: 'Tax-code display context must match the exact action treatment.',
    });
  }
  if (value.action !== null && value.direction === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['direction'],
      message: 'Executable rule changes require a direction.',
    });
  }
});

export const CLASSIFICATION_SAFE_ERROR_MESSAGES: Readonly<
  Record<ClassificationErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: 'Check the classification request and try again.',
  FORBIDDEN: 'This caller does not have access to the requested classification data.',
  NOT_FOUND: 'The requested classification record was not found or is unavailable.',
  COMPANY_UNAVAILABLE: 'Classification data is temporarily unavailable. Try again later.',
  UNKNOWN_JURISDICTION: 'The tax jurisdiction is unknown; provide evidence before proceeding.',
  SEMANTIC_UNAVAILABLE: 'Semantic classification search is unavailable.',
  CONFLICT: 'The classification change conflicts with current evidence or revision state.',
  STALE_REVISION: 'The classification record changed; read it again before retrying.',
  INTERNAL: 'Classification could not be completed.',
});

export const classificationErrorSchema = z.object({
  code: z.enum([
    'INVALID_INPUT',
    'FORBIDDEN',
    'NOT_FOUND',
    'COMPANY_UNAVAILABLE',
    'UNKNOWN_JURISDICTION',
    'SEMANTIC_UNAVAILABLE',
    'CONFLICT',
    'STALE_REVISION',
    'INTERNAL',
  ]),
  message: text,
}).strict().superRefine((value, context) => {
  if (value.message !== CLASSIFICATION_SAFE_ERROR_MESSAGES[value.code]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message'],
      message: 'Error messages must use the fixed safe message for their code.',
    });
  }
});

export const currentRuleMutationRevisionSchema = ruleRevisionSchema.innerType().omit({
  categoryName: true,
  priority: true,
  retiredAt: true,
  canonicalVersion: true,
}).extend({
  state: z.enum(['enabled', 'disabled']),
  action: z.object({
    version: z.literal(2),
    direction: z.enum(['Purchase', 'Deposit']),
    category: text,
    categoryQboId: qboReference,
    taxCalculation,
    taxCodeQboId: qboReference.nullable(),
    tagIds,
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.action !== null && (
    value.action.direction !== value.direction
    || (value.action.taxCalculation === 'NotApplicable') !== (value.action.taxCodeQboId === null)
    || (value.action.taxCalculation === 'NotApplicable') !== (value.taxCodeName === null)
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'Rule action must match direction and tax treatment.' });
  }
  if (value.state === 'enabled' && (value.action === null || value.direction === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'Enabled rules require a complete action.' });
  }
  if (value.state === 'disabled' && value.autoPost) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['autoPost'], message: 'Disabled rules cannot auto-post.' });
  }
});

export const ruleMutationResultSchema = z.object({
  ok: z.boolean(),
  operationId: identifier,
  companyId: identifier,
  mutation: ruleMutationKind,
  originIntent: ruleOriginIntent,
  status: z.enum(['PREPARED', 'COMMITTED', 'REPLAYED', 'REJECTED']),
  ruleId: nullableIdentifier,
  revision: z.union([revision, z.null()]),
  rule: currentRuleMutationRevisionSchema.nullable(),
  candidate: z.object({
    candidateId: identifier,
    state: z.enum(['dismissed', 'activated']),
    ruleId: nullableIdentifier,
  }).strict().nullable(),
  preview: ruleMutationPreviewSchema.nullable(),
  error: classificationErrorSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'REJECTED' && (value.ok || value.error === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Rejected mutations must be unsuccessful and expose a safe error.',
    });
  }
  if (value.status !== 'REJECTED' && (!value.ok || value.error !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ok'],
      message: 'Successful mutation results cannot expose an error.',
    });
  }
  if (value.status === 'PREPARED' && value.preview === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preview'],
      message: 'Prepared mutations require a bounded preview.',
    });
  }
  if (value.preview !== null) {
    if (
      value.preview.operationId !== value.operationId
      || value.preview.companyId !== value.companyId
      || value.preview.mutation !== value.mutation
      || value.preview.originIntent !== value.originIntent
      || value.preview.ruleId !== value.ruleId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preview'],
        message: 'Nested preview must match its mutation-result envelope.',
      });
    }
    if (value.revision !== null && value.preview.proposedRevision !== value.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preview', 'proposedRevision'],
        message: 'Nested preview revision must match its result envelope.',
      });
    }
  }
  if (value.rule !== null) {
    if (
      value.rule.companyId !== value.companyId
      || value.rule.ruleId !== value.ruleId
      || value.rule.originIntent !== value.originIntent
      || value.rule.revision !== value.revision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule'],
        message: 'Nested rule revision must match its mutation-result envelope.',
      });
    }
  }
  if (
    (value.status === 'COMMITTED' || value.status === 'REPLAYED')
    && value.mutation !== 'dismiss_candidate'
    && (value.rule === null || value.ruleId === null || value.revision === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rule'],
      message: 'Committed mutation results require the exact resulting rule revision.',
    });
  }
  if (value.mutation === 'dismiss_candidate') {
    if (
      (value.status === 'COMMITTED' || value.status === 'REPLAYED')
      && (
        value.candidate === null
        || value.candidate.state !== 'dismissed'
        || value.candidate.ruleId !== null
        || value.rule !== null
        || value.ruleId !== null
        || value.revision !== null
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate'],
        message: 'Candidate dismissal must return the exact dismissed candidate and no rule.',
      });
    }
  } else if (value.mutation === 'activate_candidate') {
    if (
      (value.status === 'COMMITTED' || value.status === 'REPLAYED')
      && (
        value.candidate === null
        || value.candidate.state !== 'activated'
        || value.candidate.ruleId !== value.ruleId
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate'],
        message: 'Candidate activation must bind the activated candidate to the resulting rule.',
      });
    }
  } else if (value.candidate !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate'],
      message: 'Non-candidate mutations cannot return candidate state.',
    });
  }
  if (
    value.preview !== null
    && value.candidate !== null
    && value.preview.candidateId !== value.candidate.candidateId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'candidateId'],
      message: 'Candidate result must match the prepared candidate ID.',
    });
  }
  if (
    (value.status === 'PREPARED' || value.status === 'REJECTED')
    && value.candidate !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate'],
      message: 'Candidate post-state is available only after a successful commit or replay.',
    });
  }
});

export type ClassificationContractSchema =
  | typeof vendorAliasSchema
  | typeof vendorIdentitySchema
  | typeof classificationCaseSchema
  | typeof classificationSearchHitSchema
  | typeof classificationSearchResultSchema
  | typeof ruleRevisionSchema
  | typeof ruleMutationPreviewSchema
  | typeof ruleMutationResultSchema;

export const VendorAliasSchema = vendorAliasSchema;
export const VendorIdentitySchema = vendorIdentitySchema;
export const ClassificationCaseSchema = classificationCaseSchema;
export const ClassificationSearchHitSchema = classificationSearchHitSchema;
export const ClassificationSearchResultSchema = classificationSearchResultSchema;
export const RuleRevisionSchema = ruleRevisionSchema;
export const RuleMutationPreviewSchema = ruleMutationPreviewSchema;
export const RuleMutationResultSchema = ruleMutationResultSchema;

export class ClassificationContractError extends Error {
  constructor(readonly code: ClassificationErrorCode) {
    super(CLASSIFICATION_SAFE_ERROR_MESSAGES[code]);
    this.name = 'ClassificationContractError';
  }
}

const CLASSIFICATION_ERROR_CODES = new Set<ClassificationErrorCode>(
  Object.keys(CLASSIFICATION_SAFE_ERROR_MESSAGES) as ClassificationErrorCode[],
);

function codeFromUnknown(error: unknown): ClassificationErrorCode {
  if (error instanceof ClassificationContractError) return error.code;
  if (error instanceof z.ZodError) return 'INVALID_INPUT';
  if (error !== null && typeof error === 'object') {
    const candidate = (error as { code?: unknown }).code;
    if (typeof candidate === 'string' && CLASSIFICATION_ERROR_CODES.has(candidate as ClassificationErrorCode)) {
      return candidate as ClassificationErrorCode;
    }
  }
  return 'INTERNAL';
}

/** Serialize only an allowlisted code and fixed message; never echo provider/database errors. */
export function serializeClassificationError(error: unknown): ClassificationError {
  const code = codeFromUnknown(error);
  return { code, message: CLASSIFICATION_SAFE_ERROR_MESSAGES[code] };
}

export const safeClassificationError = serializeClassificationError;

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ClassificationContractError('INVALID_INPUT');
  return parsed.data;
}

export function parseVendorAlias(value: unknown): VendorAlias {
  return parseContract(vendorAliasSchema, value);
}

export function parseVendorIdentity(value: unknown): VendorIdentity {
  return parseContract(vendorIdentitySchema, value);
}

export function parseClassificationCase(value: unknown): ClassificationCase {
  return parseContract(classificationCaseSchema, value);
}

export function parseClassificationSearchHit(value: unknown): ClassificationSearchHit {
  return parseContract(classificationSearchHitSchema, value);
}

export function parseClassificationSearchResult(value: unknown): ClassificationSearchResult {
  return parseContract(classificationSearchResultSchema, value);
}

export function parseRuleRevision(value: unknown): RuleRevision {
  return parseContract(ruleRevisionSchema, value);
}

export function parseRuleMutationPreview(value: unknown): RuleMutationPreview {
  return parseContract(ruleMutationPreviewSchema, value);
}

export function parseRuleMutationResult(value: unknown): RuleMutationResult {
  return parseContract(ruleMutationResultSchema, value);
}

// Keep these aliases close to the schemas: callers that prefer an explicit
// `validate*` name get the same strict, normalized parser behavior.
export const validateVendorAlias = parseVendorAlias;
export const validateVendorIdentity = parseVendorIdentity;
export const validateClassificationCase = parseClassificationCase;
export const validateClassificationSearchHit = parseClassificationSearchHit;
export const validateClassificationSearchResult = parseClassificationSearchResult;
export const validateRuleRevision = parseRuleRevision;
export const validateRuleMutationPreview = parseRuleMutationPreview;
export const validateRuleMutationResult = parseRuleMutationResult;

// Make the structural helper types visible to generated declaration consumers
// without requiring them to import shared separately.
export type {
  ClassificationAction,
  ClassificationActionSummary,
  ClassificationCase,
  ClassificationCitation,
  ClassificationConflict,
  ClassificationError,
  ClassificationProvenance,
  ClassificationReviewer,
  ClassificationRuleCondition,
  RuleMutationPreview,
  RuleCandidateMutationResult,
  RuleMutationResult,
  RuleMutationSample,
  RuleRevision,
  VendorAlias,
  VendorIdentity,
};
