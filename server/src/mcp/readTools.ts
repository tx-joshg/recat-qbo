import { parseClassificationSearchResult } from '../services/classification/contracts.js';
import type { ClassificationCase, RuleDirection, RuleLifecycleFilter, RuleLifecyclePageDto } from '@recat/shared';
import { HttpError } from '../lib/http.js';
import {
  McpServer,
  type JSONObject,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import type { Tracer } from '@opentelemetry/api';
import { z } from 'zod-v4';
import type { McpPrincipal } from './auth.js';
import {
  DEFAULT_READ_LIMIT,
  searchClassificationKnowledge,
  MAX_READ_LIMIT,
  getTransaction,
  getClassificationCase,
  getRule,
  getRuleCandidate,
  listRuleCandidates,
  testRule,
  listCategories,
  listCompanies,
  listRules,
  listTags,
  listTaxCodes,
  listTransactions,
  listTransferCandidates,
} from '../services/companyReads.js';
import type {
  CompanyRuleReadDto,
  ClassificationSearchPage,
  RuleCandidateReadDto,
  RuleTestReadDto,
  CompanyReadTransactionDto,
  CompanyReadDto,
  Page,
  TaxCodePage,
  TransactionListInput,
  TransactionPage,
  TransferCandidateDto,
} from '../services/companyReads.js';
import type { QboAccountDto, TagDto } from '@recat/shared';
import {
  writeSafetyReads,
  type WriteSafetyReadOperations,
} from '../services/writeSafetyReads.js';
import {
  DEFAULT_ACTIONABILITY_REFRESH_LIMIT,
  MAX_ACTIONABILITY_REFRESH_LIMIT,
  refreshProviderActionability,
  type ProviderActionabilityRefreshResult,
} from '../services/providerActionabilityRefresh.js';
import {
  refreshMirroredTransaction,
  syncCompany,
  type MirroredTransactionRefreshResult,
} from '../services/sync.js';
import type { McpToolLogger } from './observability.js';
import { observeMcpToolCall } from './observability.js';
import {
  safeInvalidToolFailure,
  safeToolFailure,
  toolSuccess,
} from './result.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  assertBoundedMcpOutput,
  toBoundedJsonSchema,
} from './schemaBounds.js';
import { extractMcpTraceContext, type McpTraceContext } from './trace.js';
import {
  mcpMutationOperations,
  mutationToolDefinitions,
  type McpMutationOperations,
} from './mutationTools.js';

export const READ_TOOL_NAMES = [
  'get_identity',
  'list_companies',
  'list_transactions',
  'get_transaction',
  'get_write_safety',
  'sync_company',
  'refresh_transaction_mirror',
  'refresh_provider_actionability',
  'list_categories',
  'list_tax_codes',
  'list_tags',
  'list_rules',
  'get_rule',
  'test_rule',
  'list_rule_candidates',
  'get_rule_candidate',
  'get_classification_case',
  'search_classification_knowledge',
  'list_transfer_candidates',
] as const;

export interface CompanyReadOperations {
  listCompanies(userId: string, input?: { limit?: number; cursor?: string }): Promise<Page<CompanyReadDto>>;
  listTransactions(
    userId: string,
    companyId: string,
    input?: TransactionListInput,
  ): Promise<TransactionPage>;
  getTransaction(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<CompanyReadTransactionDto>;
  listCategories(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<QboAccountDto>>;
  listTaxCodes(
    userId: string,
    companyId: string,
    input: { direction: RuleDirection; limit?: number; cursor?: string },
  ): Promise<TaxCodePage>;
  listTags(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<TagDto>>;
  listRules(
    userId: string,
    companyId: string,
    input?: { state?: RuleLifecycleFilter; limit?: number; cursor?: string },
  ): Promise<RuleLifecyclePageDto>;
  getRule(userId: string, companyId: string, ruleId: string): Promise<CompanyRuleReadDto>;
  testRule(
    userId: string,
    companyId: string,
    input: { matchText: string; direction: RuleDirection; limit?: number; cursor?: string },
  ): Promise<RuleTestReadDto>;
  listRuleCandidates(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<RuleCandidateReadDto>>;
  getRuleCandidate(
    userId: string,
    companyId: string,
    candidateId: string,
  ): Promise<RuleCandidateReadDto>;
  getClassificationCase(
    userId: string,
    companyId: string,
    caseId: string,
  ): Promise<ClassificationCase>;

  searchClassificationKnowledge(
    userId: string,
    companyId: string,
    input: {
      query: string;
      scope?: 'current_company' | 'accessible_companies';
      mode: 'auto' | 'exact' | 'lexical' | 'hybrid' | 'semantic';
      limit?: number;
      cursor?: string;
      transactionId?: string;
    },
  ): Promise<ClassificationSearchPage>;
  listTransferCandidates(
    userId: string,
    companyId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<Page<TransferCandidateDto>>;
}

export interface ProviderActionabilityRefreshOperations {
  refreshProviderActionability(
    userId: string,
    companyId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<ProviderActionabilityRefreshResult>;
}

export const companyReads: CompanyReadOperations = Object.freeze({
  listCompanies,
  listTransactions,
  getTransaction,
  listCategories,
  listTaxCodes,
  listTags,
  listRules,
  getRule,
  testRule,
  listRuleCandidates,
  getRuleCandidate,
  getClassificationCase,
  searchClassificationKnowledge,
  listTransferCandidates,
});

export interface RecatMcpContext {
  principal: McpPrincipal;
  era: 'legacy' | 'modern';
  reads?: CompanyReadOperations;
  writeSafetyReads?: WriteSafetyReadOperations;
  sync?: CompanySyncOperations;
  actionabilityRefresh?: ProviderActionabilityRefreshOperations;
  mutations?: McpMutationOperations;
  requestId?: string;
  traceId?: string;
  traceContext?: McpTraceContext;
  tracer?: Tracer;
  log?: McpToolLogger;
}

/** A Recat mirror refresh reads QBO and writes only Recat's local mirror. */
export interface CompanySyncOperations {
  syncCompany(companyId: string, kind: 'manual'): Promise<{
    ok: boolean;
    message: string;
    mirror?: {
      created: number;
      refreshed: number;
      stale: number;
      busy: number;
      contended: number;
    };
  }>;
  refreshTransaction(
    companyId: string,
    transactionId: string,
  ): Promise<MirroredTransactionRefreshResult>;
}


const ACTIONABILITY_CURSOR_MAX = 128;
const ID_MAX = 128;
const CURSOR_MAX = 2_048;
const SEARCH_MAX = 200;
const ACCOUNT_MAX = 120;
const annotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const syncAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

class InvalidMcpToolOutputError extends Error {
  constructor() {
    super('MCP tool output failed schema validation');
    this.name = 'InvalidMcpToolOutputError';
  }
}

const id = z.string().min(1).max(ID_MAX);
const cursor = z.string().min(1).max(CURSOR_MAX).optional();
const limit = z.number().int().min(1).max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT).optional();
const pageInput = {
  limit,
  cursor,
};
const companyInput = {
  companyId: id,
  ...pageInput,
};
const emptyInput = z.strictObject({});
const listCompaniesInput = z.strictObject(pageInput);
const companyPageInput = z.strictObject(companyInput);
const listTransactionsInput = z.strictObject({
  ...companyInput,
  status: z.enum([
    'PENDING',
    'POSTING',
    'POSTED',
    'DRY_RUN',
    'ERROR',
    'SUPERSEDED',
    'REVERTED',
  ]).optional(),
  providerDisposition: z.enum([
    'UNKNOWN',
    'WRITABLE',
    'BLOCKED_CLEARED',
    'BLOCKED_RECONCILED',
    'BLOCKED_PERIOD_CLOSED',
    'UNAVAILABLE',
  ]).optional(),
  search: z.string().max(SEARCH_MAX).optional(),
  account: z.string().max(ACCOUNT_MAX).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
}).superRefine((input, issue) => {
  if (input.startDate === undefined || input.endDate === undefined) return;
  const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${input.endDate}T00:00:00.000Z`);
  const spanDays = (end - start) / (24 * 60 * 60 * 1_000);
  if (spanDays < 0) {
    issue.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'endDate must not be before startDate',
    });
  } else if (spanDays > 366) {
    issue.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'date range must not exceed 366 days',
    });
  }
});
const getTransactionInput = z.strictObject({
  companyId: id,
  transactionId: id,
});

const getRuleInput = z.strictObject({ companyId: id, ruleId: id });

const taxCodeListInput = z.strictObject({
  companyId: id,
  direction: z.enum(['Purchase', 'Deposit']),
  ...pageInput,
});

const ruleListInput = z.strictObject({
  companyId: id,
  state: z.enum(['enabled', 'disabled', 'all']).optional(),
  ...pageInput,
});

const testRuleInput = z.strictObject({
  companyId: id,
  matchText: z.string().min(1).max(200),
  direction: z.enum(['Purchase', 'Deposit']),
  ...pageInput,
});

const getRuleCandidateInput = z.strictObject({ companyId: id, candidateId: id });

const getClassificationCaseInput = z.strictObject({ companyId: id, caseId: id });

const searchClassificationInput = z.strictObject({
  companyId: id,
  query: z.string().min(1).max(256),
  scope: z.enum(['current_company', 'accessible_companies']).default('current_company').optional(),
  mode: z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']),
  transactionId: id.optional(),
  ...pageInput,
});

const text = z.string().max(2_048);
const isoDate = z.string().max(64);
const nullableText = text.nullable();
const nullableIsoDate = isoDate.nullable();
const observationProvenanceText = z.string().min(1).max(256)
  .refine((value) => Array.from(value).length <= 128, 'Expected at most 128 code points.');
const taxCalculation = z.enum([
  'TaxInclusive',
  'TaxExcluded',
  'NotApplicable',
]);
const provenance = z.strictObject({
  source: z.enum(['user', 'mcp', 'autopilot', 'qbo_verified', 'rule', 'candidate', 'historical_observation']),
  sourceId: id,
  actorId: id.nullable(),
  recordedAt: isoDate,
});

const action = z.strictObject({
  categoryQboId: z.string().min(1).max(120),
  taxCalculation,
  taxCodeQboId: z.string().min(1).max(120).nullable(),
  tagIds: z.array(z.string().uuid()).max(50)
    .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.'),
  memo: nullableText.optional(),
});

const actionSummary = z.strictObject({
  categoryName: text,
  taxCalculation,
  taxCodeName: nullableText,
  tagNames: z.array(text).max(50),
});
const observation = z.strictObject({
  sourceTransactionId: id,
  sourceQboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
  sourceQboId: observationProvenanceText,
  sourceTransactionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sourceQboSyncToken: observationProvenanceText,
  sourceStatus: z.literal('POSTED'),
  sourceUpdatedAt: isoDate,
  observedAt: isoDate,
});
const conflict = z.strictObject({
  id,
  companyId: id,
  sourceId: id,
  kind: z.enum(['case', 'candidate', 'rule', 'jurisdiction', 'tax']),
  reason: text,
  action: action.nullable(),
  actionSummary: actionSummary.nullable(),
  evidenceCount: z.number().int().nonnegative().max(10_000),
});
const evidenceCard = z.strictObject({
  id,
  sourceId: id,
  kind: z.enum(['vendor_identity', 'vendor_alias', 'classification_case', 'rule', 'rule_candidate', 'historical_observation']),
  companyId: id,
  companyName: z.string().min(1).max(200),
  companyRelation: z.enum(['current', 'foreign']),
  executable: z.boolean(),
  advisory: z.boolean(),
  matchedIn: z.array(z.enum(['alias', 'rule', 'candidate', 'case', 'observation', 'lexical', 'semantic'])).min(1).max(7),
  score: z.number().finite().nonnegative(),
  vendorIdentityId: id.nullable(),
  vendorName: nullableText,
  action: action.nullable(),
  actionSummary: actionSummary.nullable(),
  originIntent: z.enum(['apply_once', 'make_recurring', 'auto_candidate']).nullable(),
  evidenceCount: z.number().int().nonnegative().max(10_000),
  conflictingEvidenceCount: z.number().int().nonnegative().max(10_000),
  conflicts: z.array(conflict).max(20),
  provenance,
  rationale: z.string().max(2_000).nullable(),
  examples: z.array(text).max(20),
  counterexamples: z.array(text).max(20),
  jurisdiction: z.string().max(128).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  verifiedAt: nullableIsoDate,
  ruleRevision: z.number().int().nonnegative().nullable(),
  observation: observation.nullable(),
}).superRefine((card, issue) => {
  if (
    card.companyRelation === 'foreign'
    && (
      card.action !== null
      || card.executable
      || !card.advisory
      || card.conflicts.some((item) => item.action !== null)
    )
  ) {
    issue.addIssue({
      code: 'custom',
      path: ['action'],
      message: 'Foreign evidence must be advisory and omit executable action identifiers.',
    });
  }
  if (card.kind === 'historical_observation') {
    if (!card.advisory || card.executable || card.action !== null || card.actionSummary === null
      || card.originIntent !== null || card.verifiedAt !== null || card.evidenceCount !== 0
      || card.observation === null || card.provenance.source !== 'historical_observation') {
      issue.addIssue({ code: 'custom', path: ['kind'], message: 'Historical observations are display-only evidence.' });
    }
  } else if (card.observation !== null) {
    issue.addIssue({ code: 'custom', path: ['observation'], message: 'Only historical observations carry snapshot provenance.' });
  }
});
const role = z.enum(['viewer', 'categorizer', 'admin']);
const transactionStatus = z.enum([
  'PENDING',
  'POSTING',
  'POSTED',
  'DRY_RUN',
  'ERROR',
  'SUPERSEDED',
  'REVERTED',
]);
const categoryHintSuggestion = z.strictObject({
  category: text,
  categoryQboId: text.optional(),
  source: z.enum(['history', 'ai']),
});

const ruleSuggestionAction = z.strictObject({
  version: z.literal(2),
  direction: z.enum(['Purchase', 'Deposit']),
  category: text,
  categoryQboId: text,
  taxCalculation,
  taxCodeQboId: nullableText,
  tagIds: z.array(id).max(MAX_READ_LIMIT),
}).superRefine((action, issue) => {
  if (
    (action.taxCalculation === 'NotApplicable') !== (action.taxCodeQboId === null)
  ) {
    issue.addIssue({
      code: 'custom',
      path: ['taxCodeQboId'],
      message: 'Rule suggestion tax treatment is inconsistent.',
    });
  }
});

const ruleSuggestion = z.strictObject({
  source: z.literal('rule'),
  version: z.literal(2),
  ruleId: id,
  ruleRevision: z.number().int().positive(),
  action: ruleSuggestionAction,
  autoPost: z.boolean(),
});

const suggestion = z.union([ruleSuggestion, categoryHintSuggestion]);
const split = z.strictObject({
  amount: z.number().finite(),
  category: text,
  categoryQboId: text.optional(),
  taxCode: nullableText.optional(),
  taxCodeQboId: nullableText.optional(),
  tagIds: z.array(id).max(MAX_READ_LIMIT),
  memo: text.optional(),
});
const transaction = z.strictObject({
  id,
  companyId: id,
  qboId: text,
  qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
  date: isoDate,
  payee: text,
  memo: nullableText,
  amount: z.number().finite(),
  sourceGrossCents: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  bankAccount: text,
  status: transactionStatus,
  revision: z.number().int().nonnegative(),
  category: nullableText,
  categoryQboId: nullableText,
  taxCalculation: taxCalculation.nullable(),
  taxCode: nullableText,
  taxCodeQboId: nullableText,
  splits: z.array(split).max(MAX_READ_LIMIT).nullable(),
  tagIds: z.array(id).max(MAX_READ_LIMIT),
  suggestion: suggestion.nullable(),
  error: z.strictObject({ code: text, message: text }).nullable(),
  postedAt: nullableIsoDate,
  postedBy: nullableText,
  activeCategorizationAttempt: z.strictObject({
    requestId: id,
    operation: z.enum(['recategorize', 'restore']),
    status: z.enum(['PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE']),
  }).nullable(),
  providerActionability: z.strictObject({
    disposition: z.enum([
      'UNKNOWN',
      'WRITABLE',
      'BLOCKED_CLEARED',
      'BLOCKED_RECONCILED',
      'BLOCKED_PERIOD_CLOSED',
      'UNAVAILABLE',
    ]),
    checkedAt: nullableIsoDate,
    revision: z.number().int().nonnegative(),
    qboSyncToken: text,
    qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
    qboId: text,
    txnDate: isoDate,
    bankAccountQboId: nullableText,
    bookCloseDate: nullableIsoDate,
    cleared: z.boolean().nullable(),
    reconciled: z.boolean().nullable(),
    unavailableCode: nullableText,
    unavailableReason: nullableText,
  }).nullable().optional(),
  transferCandidateId: id.nullable().optional(),
});
const transactionRead = transaction.extend({
  verification: z.strictObject({
    status: z.enum(['verified', 'dry-run', 'failed', 'uncertain', 'unknown']),
    outcome: z.enum(['VERIFIED', 'DRY_RUN', 'RETRYABLE', 'UNCERTAIN', 'UNCHANGED', 'REJECTED']).nullable(),
    summary: text,
  }),
});
const company = z.strictObject({
  id,
  realmId: text,
  legalName: text,
  nickname: text,
  env: z.enum(['sandbox', 'production']),
  syncMode: z.enum(['polling', 'webhook']),
  pollIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(30), z.literal(60)]),
  holdingAccountIds: z.array(text).max(MAX_READ_LIMIT),
  dryRun: z.boolean(),
  tagsRequired: z.boolean(),
  retainAttachmentFiles: z.boolean(),
  connectedAt: isoDate,
  disconnectedAt: nullableIsoDate,
  lastSyncedAt: nullableIsoDate,
  role,
});
const category = z.strictObject({
  id,
  qboId: text,
  name: text,
  fullName: text,
  classification: text,
  active: z.boolean(),
});
const taxCode = z.strictObject({
  qboId: text,
  name: text,
  active: z.boolean(),
  taxable: z.boolean().nullable(),
  combinedPurchaseRate: z.number().finite().nullable(),
  combinedSalesRate: z.number().finite().nullable(),
});
const tag = z.strictObject({
  id,
  companyId: id,
  name: text,
  color: text,
  usageCount: z.number().int().nonnegative().optional(),
});

const ruleRevisionOutput = z.strictObject({
  id,
  ruleId: id,
  companyId: id,
  revision: z.number().int().nonnegative(),
  state: z.enum(['enabled', 'disabled', 'retired']),
  condition: z.strictObject({ matchField: z.literal('payee'), matchText: text }),
  direction: z.enum(['Purchase', 'Deposit']).nullable(),
  action: action.nullable(),
  categoryName: text,
  taxCodeName: nullableText,
  priority: z.number().int().nonnegative(),
  autoPost: z.boolean(),
  originIntent: z.enum(['make_recurring', 'auto_candidate']).nullable(),
  sourceCaseId: id.nullable(),
  sourceCandidateId: id.nullable(),
  changedBy: id.nullable(),
  createdAt: isoDate,
  retiredAt: nullableIsoDate,
  canonicalVersion: z.number().int().positive().nullable(),
  repairReason: nullableText,
  affectedJournalEntryCount: z.number().int().nonnegative().nullable(),
  valid: z.boolean(),
  invalidReasons: z.array(text).max(4),
});

const currentRuleActionOutput = z.strictObject({
  version: z.literal(2),
  direction: z.enum(['Purchase', 'Deposit']),
  category: text,
  categoryQboId: text,
  taxCalculation,
  taxCodeQboId: nullableText,
  tagIds: z.array(id).max(MAX_READ_LIMIT),
});

const currentRuleRevisionOutput = z.strictObject({
  id,
  ruleId: id,
  companyId: id,
  revision: z.number().int().nonnegative(),
  state: z.enum(['enabled', 'disabled']),
  condition: z.strictObject({ matchField: z.literal('payee'), matchText: text }),
  direction: z.enum(['Purchase', 'Deposit']).nullable(),
  action: currentRuleActionOutput.nullable(),
  taxCodeName: nullableText,
  autoPost: z.boolean(),
  originIntent: z.enum(['make_recurring', 'auto_candidate']).nullable(),
  sourceCaseId: id.nullable(),
  sourceCandidateId: id.nullable(),
  changedBy: id.nullable(),
  createdAt: isoDate,
  repairReason: nullableText,
  affectedJournalEntryCount: z.number().int().nonnegative().nullable(),
  valid: z.boolean(),
  invalidReasons: z.array(text).max(4),
});

const getRuleOutput = z.strictObject({
  state: z.enum(['enabled', 'disabled']),
  reviewRequiredAt: nullableIsoDate,
  reviewReason: nullableText,
  repairReason: nullableText,
  revision: currentRuleRevisionOutput,
}).superRefine((value, issue) => {
  if (value.revision.valid !== (value.revision.invalidReasons.length === 0)) {
    issue.addIssue({ code: 'custom', path: ['revision', 'valid'], message: 'Rule validity must agree with its reasons.' });
  }
  if (value.revision.valid !== (value.revision.action !== null)) {
    issue.addIssue({ code: 'custom', path: ['revision', 'action'], message: 'Only valid rule revisions may expose actions.' });
  }
  if (value.revision.action !== null && value.revision.action.direction !== value.revision.direction) {
    issue.addIssue({ code: 'custom', path: ['revision', 'action', 'direction'], message: 'Rule action direction must match the revision.' });
  }
});

const ruleTestOutput = z.strictObject({
  samples: z.array(z.strictObject({
    transactionId: id,
    payee: text,
    date: isoDate,
    amount: z.number().finite(),
    status: z.enum(['PENDING', 'POSTED', 'DRY_RUN']),
    wouldWin: z.boolean(),
    currentWinner: nullableText,
  })).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
  pendingCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  conflicts: z.array(z.strictObject({
    ruleId: id,
    matchText: text,
    category: text,
    priority: z.number().int(),
  })).max(20),
  conflictsTruncated: z.boolean(),
});

const candidateEvidence = z.strictObject({
  id,
  transactionId: id,
  source: z.enum(['user', 'autopilot', 'mcp']),
  polarity: z.enum(['positive', 'negative']),
  active: z.boolean(),
  observedAt: isoDate,
  invalidatedAt: nullableIsoDate,
  invalidationReason: nullableText,
});

const candidateOutput = z.strictObject({
  id,
  companyId: id,
  state: z.enum(['gathering', 'ready', 'conflict', 'stale', 'dismissed', 'activated']),
  matchField: z.literal('payee'),
  matchText: text,
  categoryName: nullableText,
  taxCodeName: nullableText,
  action: action.nullable(),
  invalidReasons: z.array(text).max(4),
  executable: z.literal(false),
  advisory: z.literal(true),
  evidenceCount: z.number().int().nonnegative().max(10_000),
  conflictingEvidenceCount: z.number().int().nonnegative().max(10_000),
  schemaVersion: text,
  configVersion: text,
  activatedRuleId: id.nullable(),
  updatedAt: isoDate,
  evidence: z.array(candidateEvidence).max(20).optional(),
});

const classificationCaseOutput = z.strictObject({
  id,
  companyId: id,
  transactionId: id,
  vendorIdentityId: id.nullable(),
  qboMutationAttemptId: id,
  action,
  actionFingerprint: id,
  originIntent: z.enum(['apply_once', 'make_recurring', 'auto_candidate']),
  rationale: z.string().min(1).max(2_000),
  requiredEvidence: z.array(text).max(20),
  examples: z.array(text).max(20),
  counterexamples: z.array(text).max(20),
  citations: z.array(z.strictObject({
    url: z.string().url().max(2_048),
    title: text,
    publisher: text,
    retrievedAt: isoDate,
    claimSummary: z.string().min(1).max(2_000),
  })).max(10),
  reviewer: z.strictObject({ userId: id.nullable(), configVersion: id, decision: z.literal('approved') }),
  jurisdiction: z.string().min(1).max(128),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  context: z.strictObject({
    transactionDirection: z.enum(['in', 'out', 'unknown']),
    qboType: z.enum(['Purchase', 'Deposit', 'JournalEntry']),
    sourceAccountName: nullableText,
    businessPurpose: nullableText,
  }),
  provenance,
  verifiedAt: isoDate,
  invalidatedAt: nullableIsoDate,
  invalidationReason: nullableText,
});

const pageOutput = <T extends z.ZodType>(item: T) => z.strictObject({
  items: z.array(item).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
});
const transactionPageOutput = z.strictObject({
  items: z.array(transactionRead).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
  pendingCount: z.number().int().nonnegative(),
  actionableCount: z.number().int().nonnegative().optional(),
  blockedCount: z.number().int().nonnegative().optional(),
  unknownCount: z.number().int().nonnegative().optional(),
});
const taxPageOutput = z.strictObject({
  direction: z.enum(['Purchase', 'Deposit']),
  status: z.enum(['unsupported', 'needs_setup', 'ready']),
  reason: z.string().max(500).nullable(),
  usingSalesTax: z.boolean().nullable(),
  refreshedAt: z.string().max(64).nullable(),
  items: z.array(taxCode).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
});
const transactionOutput = z.strictObject({ transaction: transactionRead });
const writeSafetyOutput = z.strictObject({
  writeSafety: z.strictObject({
    transactionId: id,
    revision: z.number().int().nonnegative(),
    qboId: text,
    qboType: z.enum(['Purchase', 'Deposit']),
    qboSyncToken: text,
    txnDate: z.iso.date(),
    bankAccountQboId: text,
    bookCloseDate: z.iso.date().nullable(),
    cleared: z.boolean(),
    reconciled: z.boolean(),
    writable: z.boolean(),
    blockCode: z.enum([
      'QBO_PERIOD_CLOSED',
      'QBO_TRANSACTION_LOCKED',
    ]).nullable(),
  }),
});
const actionabilityRefreshInput = z.strictObject({
  companyId: id,
  cursor: z.string().min(1).max(ACTIONABILITY_CURSOR_MAX).nullable().optional(),
  limit: z.number().int().min(1).max(MAX_ACTIONABILITY_REFRESH_LIMIT)
    .default(DEFAULT_ACTIONABILITY_REFRESH_LIMIT).optional(),
});
const syncCompanyInput = z.strictObject({ companyId: id });
const refreshTransactionMirrorInput = z.strictObject({
  companyId: id,
  transactionId: id,
});
const syncCompanyOutput = z.strictObject({
  sync: z.strictObject({
    companyId: id,
    ok: z.boolean(),
    message: text,
    mirror: z.strictObject({
      created: z.number().int().nonnegative(),
      refreshed: z.number().int().nonnegative(),
      stale: z.number().int().nonnegative(),
      busy: z.number().int().nonnegative(),
      contended: z.number().int().nonnegative(),
    }).optional(),
  }),
});
const refreshTransactionMirrorOutput = z.strictObject({
  refresh: z.strictObject({
    transactionId: id,
    outcome: z.enum([
      'refreshed',
      'stale',
      'busy',
      'contended',
      'not_found',
      'missing_in_qbo',
      'not_in_holding',
    ]),
  }),
});
const actionabilityRefreshOutput = z.strictObject({
  refresh: z.strictObject({
    companyId: id,
    processed: z.number().int().nonnegative().max(MAX_ACTIONABILITY_REFRESH_LIMIT),
    persisted: z.number().int().nonnegative().max(MAX_ACTIONABILITY_REFRESH_LIMIT),
    failed: z.number().int().nonnegative().max(MAX_ACTIONABILITY_REFRESH_LIMIT),
    nextCursor: z.string().max(ACTIONABILITY_CURSOR_MAX).nullable(),
    partial: z.boolean(),
    complete: z.boolean(),
    items: z.array(z.strictObject({
      transactionId: id,
      persisted: z.boolean(),
      disposition: z.enum([
        'WRITABLE',
        'BLOCKED_CLEARED',
        'BLOCKED_RECONCILED',
        'BLOCKED_PERIOD_CLOSED',
        'UNAVAILABLE',
      ]),
      errorCode: nullableText,
    })).max(MAX_ACTIONABILITY_REFRESH_LIMIT),
  }),
});
const identityOutput = z.strictObject({
  identity: z.strictObject({
    userId: id,
    tokenPrefix: z.string().min(1).max(16),
    isInstanceAdmin: z.boolean(),
    memberships: z.array(z.strictObject({
      companyId: id,
      role: z.enum(['viewer', 'categorizer', 'admin']),
    })).max(100),
    totalMemberships: z.number().int().nonnegative(),
    membershipsTruncated: z.boolean(),
  }),
});
const companyListOutput = pageOutput(company);
const categoryListOutput = pageOutput(category);
const tagListOutput = pageOutput(tag);
const ruleListOutput = pageOutput(getRuleOutput).extend({ runtimeMode: z.enum(['legacy', 'bridge', 'paused', 'canonical']) });
const candidateListOutput = pageOutput(candidateOutput);

const searchClassificationOutput = z.strictObject({
  query: z.string().min(1).max(256),
  companyId: id,
  scope: z.enum(['current_company', 'accessible_companies']),
  mode: z.enum(['exact', 'lexical', 'hybrid', 'semantic']),
  requestedMode: z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']),
  degraded: z.boolean(),
  degradedReason: z.enum([
    'semantic_unavailable', 'vector_capability_unavailable', 'embedding_not_configured',
    'lexical_only', 'semantic_error',
  ]).nullable(),
  status: z.enum(['matched', 'no_match']),
  noMatch: z.boolean(),
  total: z.number().int().nonnegative().max(10_000),
  items: z.array(evidenceCard).max(MAX_READ_LIMIT),
  nextCursor: z.string().max(CURSOR_MAX).nullable(),
});
const transferCandidateListOutput = pageOutput(
  z.strictObject({ a: transaction, b: transaction }),
);

const authoredToolSchemas: ReadonlyArray<readonly [z.ZodType, z.ZodType]> = [
  [emptyInput, identityOutput],
  [listCompaniesInput, companyListOutput],
  [listTransactionsInput, transactionPageOutput],
  [getTransactionInput, transactionOutput],
  [getTransactionInput, writeSafetyOutput],
  [syncCompanyInput, syncCompanyOutput],
  [actionabilityRefreshInput, actionabilityRefreshOutput],
  [companyPageInput, categoryListOutput],
  [taxCodeListInput, taxPageOutput],
  [companyPageInput, tagListOutput],
  [ruleListInput, ruleListOutput],
  [getRuleInput, getRuleOutput],
  [testRuleInput, ruleTestOutput],
  [companyPageInput, candidateListOutput],
  [getRuleCandidateInput, candidateOutput],
  [getClassificationCaseInput, classificationCaseOutput],
  [searchClassificationInput, searchClassificationOutput],
  [companyPageInput, transferCandidateListOutput],
];

// These schemas are static authored definitions. Validate them once at module
// initialization so a per-request wall-clock deadline cannot fail under load.
for (const [inputSchema, outputSchema] of authoredToolSchemas) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}

function asJson(value: unknown): JSONObject {
  return value as JSONObject;
}

function inputWithoutCompany<T extends { companyId: string }>(
  input: T,
): Omit<T, 'companyId'> {
  const { companyId: _companyId, ...rest } = input;
  return rest;
}

export function createRecatMcpServer(context: RecatMcpContext): McpServer {
  const reads = context.reads ?? companyReads;
  const safetyReads = context.writeSafetyReads ?? writeSafetyReads;
  const sync = context.sync ?? {
    syncCompany,
    refreshTransaction: refreshMirroredTransaction,
  } satisfies CompanySyncOperations;
  const actionabilityRefresh = context.actionabilityRefresh ?? {
    refreshProviderActionability,
  } satisfies ProviderActionabilityRefreshOperations;
  const mutations = context.mutations ?? mcpMutationOperations;
  const requestId = context.requestId ?? randomUUID();
  const traceContext = context.traceContext ?? (
    context.traceId === undefined
      ? extractMcpTraceContext({})
      : Object.freeze({
          traceId: context.traceId,
          baggage: Object.freeze({}),
        })
  );
  const log = context.log ?? ((event) => console.info('[recat] mcp', event));
  const server = new McpServer(
    { name: 'recat-qbo', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false } },
      cacheHints: {
        'server/discover': { ttlMs: 0, cacheScope: 'private' },
        'tools/list': { ttlMs: 0, cacheScope: 'private' },
      },
    },
  );

  const register = <T extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: T,
    outputSchema: z.ZodObject,
    operation: (input: z.output<T>) => Promise<unknown>,
    toolAnnotations: ToolAnnotations = annotations,
    validateOutput?: (output: unknown) => void,
  ): void => {
    const callback = async (input: z.output<T>, sdkContext: ServerContext) => {
      const tokenPrefixPolicy =
        name === 'prepare_transfer' || name === 'commit_transfer'
          ? 'redact'
          : name === 'get_operation' || name === 'retry_operation'
            ? 'redact-for-transfer-result'
            : 'include';
      try {
        const value = await observeMcpToolCall(
          {
            requestId,
            traceId: traceContext.traceId,
            tokenPrefix: context.principal.tokenPrefix,
            tokenPrefixPolicy,
            method: sdkContext.mcpReq.method,
            tool: name,
            era: context.era,
            traceContext,
            tracer: context.tracer,
          },
          log,
          async () => {
            const operationValue = await operation(input);
            const parsed = outputSchema.safeParse(operationValue);
            if (!parsed.success) throw new InvalidMcpToolOutputError();
            // toolSuccess mirrors structured output into a text block.
            // Bound the complete wire representation before recording success.
            assertBoundedMcpOutput(toolSuccess(asJson(parsed.data)));
            try { validateOutput?.(parsed.data); } catch { throw new InvalidMcpToolOutputError(); }
            return parsed.data;
          },
        );
        // Keep the raw callback value for observability counts and transfer-token redaction.
        return toolSuccess(asJson(value));
      } catch (error) {
        if (error instanceof InvalidMcpToolOutputError) {
          return safeInvalidToolFailure(requestId);
        }
        return safeToolFailure(error, requestId);
      }
    };
    // SDK v2's callback conditional type cannot preserve a generic Zod
    // object's output through this local registration helper.
    server.registerTool(name, {
      description,
      inputSchema,
      outputSchema,
      annotations: toolAnnotations,
    }, callback as never);
  };

  register('get_identity', 'Return the authenticated Recat identity.', emptyInput, identityOutput, async () => {
    const memberships = context.principal.memberships
      .map(({ companyId, role }) => ({ companyId, role }))
      .sort((first, second) =>
        first.companyId.localeCompare(second.companyId) ||
        first.role.localeCompare(second.role),
      );
    return {
      identity: {
        userId: context.principal.userId,
        tokenPrefix: context.principal.tokenPrefix,
        isInstanceAdmin: context.principal.isInstanceAdmin,
        memberships: memberships.slice(0, 100),
        totalMemberships: memberships.length,
        membershipsTruncated: memberships.length > 100,
      },
    };
  });
  const assertCanRefresh = (companyId: string): void => {
    const membership = context.principal.memberships.find(
      (candidate) => candidate.companyId === companyId,
    );
    if (
      !context.principal.isInstanceAdmin
      && membership?.role !== 'admin'
      && membership?.role !== 'categorizer'
    ) {
      throw new HttpError(403, 'Company categorizer access is required.', 'FORBIDDEN');
    }
  };
  register('list_companies', 'List companies visible to the authenticated user.', listCompaniesInput, companyListOutput,
    (input) => reads.listCompanies(context.principal.userId, input));
  register('list_transactions', 'List bounded transactions for a company.', listTransactionsInput, transactionPageOutput,
    (input) => reads.listTransactions(
      context.principal.userId,
      input.companyId,
      inputWithoutCompany(input),
    ));
  register('get_transaction', 'Get one visible transaction.', getTransactionInput, transactionOutput,
    async (input) => ({
      transaction: await reads.getTransaction(
        context.principal.userId,
        input.companyId,
        input.transactionId,
      ),
    }));
  register(
    'get_write_safety',
    'Read current QuickBooks book-close, cleared, and reconciled safety and update Recat’s local observation. This never modifies QuickBooks transactions. Provider rate limits include a bounded retry hint.',
    getTransactionInput,
    writeSafetyOutput,
    async (input) => {
      assertCanRefresh(input.companyId);
      return { writeSafety: await safetyReads.getWriteSafety(
        context.principal.userId,
        input.companyId,
        input.transactionId,
      ) };
    },
    syncAnnotations,
  );
  register(
    'sync_company',
    'Refresh one company\'s Recat mirror from QuickBooks. This reads QuickBooks and updates only Recat\'s local mirror; it never writes QuickBooks.',
    syncCompanyInput,
    syncCompanyOutput,
    async (input) => {
      assertCanRefresh(input.companyId);
      const result = await sync.syncCompany(input.companyId, 'manual');
      return { sync: { companyId: input.companyId, ...result } };
    },
    syncAnnotations,
  );
  register(
    'refresh_transaction_mirror',
    'Refresh one existing Recat transaction from QuickBooks without a company-wide sweep. This updates only Recat’s local source mirror; it never writes QuickBooks.',
    refreshTransactionMirrorInput,
    refreshTransactionMirrorOutput,
    async (input) => {
      assertCanRefresh(input.companyId);
      return { refresh: await sync.refreshTransaction(input.companyId, input.transactionId) };
    },
    syncAnnotations,
  );
  register(
    'refresh_provider_actionability',
    'Read and persist one bounded page of current QuickBooks write-safety observations. Resume with nextCursor; this never mutates QuickBooks.',
    actionabilityRefreshInput,
    actionabilityRefreshOutput,
    async (input) => {
      assertCanRefresh(input.companyId);
      return { refresh: await actionabilityRefresh.refreshProviderActionability(
        context.principal.userId,
        input.companyId,
        { cursor: input.cursor ?? null, limit: input.limit },
      ) };
    },
    syncAnnotations,
  );
  register('list_categories', 'List active category accounts.', companyPageInput, categoryListOutput,
    (input) => reads.listCategories(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_tax_codes', 'List direction-eligible tax codes and readiness.', taxCodeListInput, taxPageOutput,
    (input) => reads.listTaxCodes(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_tags', 'List company tags.', companyPageInput, tagListOutput,
    (input) => reads.listTags(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register('list_rules', 'List current Enabled or Disabled categorization rules.', ruleListInput, ruleListOutput,
    (input) => reads.listRules(context.principal.userId, input.companyId, inputWithoutCompany(input)));
  register(
    'get_rule',
    'Read one canonical current rule with its Enabled or Disabled state and complete direction-aware action.',
    getRuleInput,
    getRuleOutput,
    (input) => reads.getRule(context.principal.userId, input.companyId, input.ruleId),
  );
  register(
    'test_rule',
    'Test a bounded payee rule against deterministically paginated samples and conflicts without saving or changing it.',
    testRuleInput,
    ruleTestOutput,
    (input) => reads.testRule(context.principal.userId, input.companyId, inputWithoutCompany(input)),
  );
  register(
    'list_rule_candidates',
    'List bounded learned candidates. Candidates are advisory; conflict and stale states never imply an executable rule.',
    companyPageInput,
    candidateListOutput,
    (input) => reads.listRuleCandidates(context.principal.userId, input.companyId, inputWithoutCompany(input)),
  );
  register(
    'get_rule_candidate',
    'Read one learned candidate with bounded evidence. Conflicting candidates remain explicitly conflicting and advisory.',
    getRuleCandidateInput,
    candidateOutput,
    (input) => reads.getRuleCandidate(context.principal.userId, input.companyId, input.candidateId),
  );
  register(
    'get_classification_case',
    'Read one immutable verified classification case and any invalidation provenance, without raw transaction or provider payloads.',
    getClassificationCaseInput,
    classificationCaseOutput,
    (input) => reads.getClassificationCase(context.principal.userId, input.companyId, input.caseId),
  );
  register(
    'search_classification_knowledge',
    'Search bounded classification evidence cards. An optional current-company transactionId derives canonical context and excludes that transaction from its own evidence. Defaults to the current company; accessible-companies includes only actual memberships and foreign hits are advisory with QBO action IDs removed. Auto may label lexical degradation; explicit semantic or hybrid fails safely when unavailable; empty evidence returns no_match.',
    searchClassificationInput,
    searchClassificationOutput,
    (input) => reads.searchClassificationKnowledge(
      context.principal.userId,
      input.companyId,
      inputWithoutCompany(input),
    ),
    annotations,
    (output) => {
      const page = output as ClassificationSearchPage;
      if (page.nextCursor !== null && (page.noMatch || page.items.length === 0)) {
        throw new InvalidMcpToolOutputError();
      }
      parseClassificationSearchResult({
        query: page.query,
        companyId: page.companyId,
        scope: page.scope,
        mode: page.mode,
        requestedMode: page.requestedMode,
        degraded: page.degraded,
        degradedReason: page.degradedReason,
        status: page.status,
        noMatch: page.noMatch,
        total: page.total,
        hits: page.items,
      });
    },
  );
  register('list_transfer_candidates', 'List bounded transfer candidate pairs.', companyPageInput, transferCandidateListOutput,
    (input) => reads.listTransferCandidates(context.principal.userId, input.companyId, inputWithoutCompany(input)));

  for (const definition of mutationToolDefinitions) {
    register(
      definition.name,
      definition.description,
      definition.inputSchema,
      definition.outputSchema,
      (input) => definition.invoke(mutations, context.principal, input),
      definition.annotations,
    );
  }

  return server;
}
