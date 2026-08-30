// @recat/shared — API contract types shared by server and client.
// Mirrors "Recat Handoff.md" §1 (data model) and §4 (API surface).

export type Role = 'admin' | 'categorizer' | 'viewer';

/** How a QuickBooks connection is made: the real Intuit OAuth flow, or the
 * built-in demo (mock QuickBooks with sample companies). A user choice made
 * per connection — never a deployment-wide mode. */
export type ConnectMode = 'real' | 'demo';

/** Realm ids of the two built-in demo companies (Harbor & Main / Bluebird).
 * A Company row with one of these realm ids IS a demo company — client and
 * server both dispatch on this, independent of any env var. */
export const MOCK_REALM_IDS = ['9341002287640001', '4471889011230002'] as const;

export function isDemoRealmId(realmId: string): boolean {
  return (MOCK_REALM_IDS as readonly string[]).includes(realmId);
}

export type TxnStatus =
  | 'PENDING'
  | 'POSTING'
  | 'POSTED'
  | 'DRY_RUN'
  | 'ERROR'
  | 'SUPERSEDED'
  | 'REVERTED';

export type SyncMode = 'polling' | 'webhook';
export type QboEnv = 'sandbox' | 'production';
export type TaxCalculation = 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
export type TaxDisposition = 'set' | 'preserve_current';
export type TaxSupportStatus = 'unsupported' | 'needs_setup' | 'ready';

export interface TaxCodeDto {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  combinedPurchaseRate: number | null;
  combinedSalesRate: number | null;
}

export function isUsableTaxCodeDto(code: TaxCodeDto): boolean {
  return (
    code.active &&
    (
      (code.taxable === true &&
        code.combinedPurchaseRate !== null &&
        Number.isFinite(code.combinedPurchaseRate) &&
        code.combinedPurchaseRate >= 0 &&
        code.combinedPurchaseRate <= 999.999999) ||
      (code.taxable === false && code.combinedPurchaseRate === null)
    )
  );
}

export function isUsableSalesTaxCodeDto(code: TaxCodeDto): boolean {
  return (
    code.active &&
    (
      (code.taxable === true &&
        code.combinedSalesRate !== null &&
        Number.isFinite(code.combinedSalesRate) &&
        code.combinedSalesRate >= 0 &&
        code.combinedSalesRate <= 999.999999) ||
      (code.taxable === false && code.combinedSalesRate === null)
    )
  );
}

export interface TaxReadinessDto {
  status: TaxSupportStatus;
  reason: string | null;
  usingSalesTax: boolean | null;
  refreshedAt: string | null;
  taxCodes: TaxCodeDto[];
  salesStatus: TaxSupportStatus;
  salesReason: string | null;
  salesTaxCodes: TaxCodeDto[];
}

export interface CategorizationProposalLine {
  /** Signed cents matching the transaction direction. */
  grossCents: number;
  categoryQboId: string;
  /** Required for taxable staging and omitted for NotApplicable. */
  taxCodeQboId?: string | null;
  memo?: string;
  tagIds: string[];
}

/** A normalized, client-authored categorization proposal.
 * Tax totals are deliberately absent: the server calculates them. */
export interface CategorizationProposal {
  taxDisposition?: TaxDisposition;
  taxCalculation: TaxCalculation;
  lines: CategorizationProposalLine[];
  tagIds: string[];
}

export interface StageCategorizationInput {
  transactionId: string;
  companyId: string;
  expectedRevision: number;
  proposal: CategorizationProposal;
}

export interface StagedCategorizationLine {
  idx: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  categoryQboId: string;
  taxCodeQboId: string | null;
  memo: string | null;
  /** Present on stage responses; optional for older internal prepared-write fixtures. */
  tagIds?: string[];
}

export interface StagedCategorization {
  transactionId: string;
  revision: number;
  /** Present after preserve-current staging is implemented; omitted by legacy fixtures. */
  taxDisposition?: TaxDisposition;
  taxCalculation: TaxCalculation;
  totals: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  lines: StagedCategorizationLine[];
  tagIds: string[];
}

/** Largest revision that can be atomically incremented into a Prisma Int. */
export const MAX_EXPECTED_TRANSACTION_REVISION = 2_147_483_646;

/** Strict POST /api/transactions/:id/categorization/stage request body. */
export interface StageCategorizationBody {
  expectedRevision: number;
  taxCalculation: TaxCalculation;
  lines: Array<{
    grossCents: number;
    categoryQboId: string;
    taxCodeQboId: string | null;
    memo?: string;
    tagIds: string[];
  }>;
  tagIds: string[];
}

/** Strict POST /api/transactions/:id/categorization/commit request body. */
export interface CommitCategorizationBody {
  expectedRevision: number;
  requestId: string;
}

/** Reconciliation and reconciliation-only retry reuse the original request ID. */
export interface ReconcileCategorizationBody {
  requestId: string;
}

/** Undo starts a distinct durable mutation attempt. */
export interface UndoCategorizationBody {
  requestId: string;
}

export type CategorizationMutationOutcome =
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'IN_PROGRESS'
  | 'UNCHANGED'
  | 'DRY_RUN'
  | 'RETRYABLE';

export interface CategorizationMutationResult {
  transactionId: string;
  requestId: string;
  ok: boolean;
  status: TxnStatus;
  outcome: CategorizationMutationOutcome;
  error?: { code: string; message: string };
}

export interface ActiveCategorizationAttemptDto {
  requestId: string;
  operation: 'recategorize' | 'restore';
  status: 'PREPARED' | 'COMMITTING' | 'UNCERTAIN';
}

export type QboDiagnosticCode =
  | 'INVALID_CLIENT_CREDENTIALS'
  | 'REDIRECT_URI_MISMATCH'
  | 'AUTHORIZATION_EXPIRED'
  | 'ACCESS_DENIED'
  | 'STATE_EXPIRED'
  | 'INTUIT_UNAVAILABLE'
  | 'COMPANY_INFO_FAILED'
  | 'COMPANY_DISCONNECTED'
  | 'QBO_CONNECTION_FAILED';
export type PollInterval = 5 | 10 | 30 | 60;
export type SuggestionSource = 'rule' | 'history' | 'ai';
export type SuggestionSetting = 'builtin' | 'ai' | 'off';
export type SuggestionProvider = 'custom' | 'openrouter';

export type AgentMode = 'off' | 'shadow';
export type AgentJobStatus = 'queued' | 'running' | 'retry' | 'completed' | 'cancelled' | 'terminal';
/** Exact durable AgentRun.status values. UI meaning is projected separately. */
export type AgentRunStatus =
  | 'running'
  | 'verified'
  | 'abstain'
  | 'failed'
  | 'posted_verified'
  | 'dry_run'
  | 'unchanged'
  | 'uncertain'
  | 'retryable';

export type AutopilotRunOutcome =
  | 'shadow_proposed'
  | 'shadow_verified'
  | 'abstained'
  | 'failed_before_write'
  | 'posted_verified'
  | 'possible_write_uncertain'
  | 'readback_mismatch'
  | 'reconciled_unchanged'
  | 'reconciled_posted'
  | 'reverted'
  | 'retrying'
  | 'in_progress'
  | 'dry_run'
  | 'unavailable';

export interface AgentLimitsDto {
  maxToolCalls: number;
  maxTurns: number;
  maxContextBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

/** Company-scoped shadow configuration. Provider credentials are never included. */
export interface AgentCompanySettingsDto {
  mode: AgentMode;
  provider: SuggestionProvider;
  decisionModel: string;
  verifierModel: string;
  scheduleMinutes: number;
  companyConcurrency: number;
  evidenceThreshold: number;
  dailyLiveWriteLimit: number;
  limits: AgentLimitsDto;
  configVersion: string;
}

export type LiveGateCode =
  | 'SHADOW_MODE_UNHEALTHY'
  | 'EVIDENCE_INSUFFICIENT'
  | 'SHADOW_AGREEMENT_INSUFFICIENT'
  | 'SHADOW_ABSTENTION_EXCESSIVE'
  | 'SHADOW_ERROR_RATE_EXCESSIVE'
  | 'VERIFIER_NOT_DISTINCT'
  | 'PROVIDER_UNHEALTHY'
  | 'TAX_REFERENCE_STALE'
  | 'QBO_DISCONNECTED'
  | 'WRITEBACK_DISABLED'
  | 'UNRESOLVED_MUTATION'
  | 'WORKER_UNHEALTHY'
  | 'LIVE_POLICY_NOT_ACCEPTED';

/** Safe, bounded activation readiness status; provider and accounting details stay server-side. */
export interface LiveGateResult {
  code: LiveGateCode;
  ok: boolean;
  message: string;
}

export interface LivePauseStateDto {
  liveRequested: boolean;
  enabled: boolean;
  paused: boolean;
  pauseCode: string | null;
  pauseMessage: string | null;
}

export interface LiveReadinessDto {
  policyVersion: string;
  gates: LiveGateResult[];
  evidence: {
    completedSince: string;
    completedThrough: string;
    eligibleRuns: number;
    threshold: number;
    minimumAgreement: number;
    maximumAbstentionRate: number;
    maximumErrorRate: number;
  };
  models: {
    provider: string;
    decisionAlias: string;
    verifierAlias: string;
    decisionIdentity: string | null;
    verifierIdentity: string | null;
  };
  policy: {
    supportedEntities: ['Purchase'];
    minimumConfidence: number;
    policyAccepted: boolean;
    configurationAccepted: boolean;
    modelBindingAccepted: boolean;
  };
  state: LivePauseStateDto;
  lastAction: {
    outcome: AutopilotRunOutcome;
    at: string;
  } | null;
}
export type AuditAction =
  | 'posted'
  | 'dry-run'
  | 'error'
  | 'reverted'
  | 'superseded'
  | 'transfer'
  | 'auto-posted'
  | 'rule-candidate-dismissed'
  | 'rule-candidate-activated'
  | 'attachment_uploaded'
  | 'attachment_reconciled'
  | 'attachment_local_copy_deleted'
  | 'attachment_deleted_everywhere'
  | 'attachment_error';

export interface MembershipDto {
  companyId: string;
  role: Role;
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  /** Instance admins manage settings/users/connections and are admin in every company. */
  isInstanceAdmin: boolean;
  invitePending: boolean;
  /** Per-company roles (handoff §5 matrix, scoped per company). */
  memberships: MembershipDto[];
}

export type McpTokenStatus = 'active' | 'expired' | 'revoked';

/** Safe token metadata. Plaintext and digests are never part of list responses. */
export interface McpTokenDto {
  id: string;
  prefix: string;
  label: string;
  status: McpTokenStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface McpTokenListResponse {
  items: McpTokenDto[];
  nextCursor: string | null;
}

/** The plaintext token is returned by POST exactly once. */
export interface CreateMcpTokenResponse {
  token: string;
  mcpToken: McpTokenDto;
}

/** Effective role for a company: instance admins are admin everywhere. */
export function roleFor(user: UserDto, companyId: string | null): Role | null {
  if (user.isInstanceAdmin) return 'admin';
  if (companyId === null) return null;
  return user.memberships.find((m) => m.companyId === companyId)?.role ?? null;
}

/** One row of a company's Team card: the member's role IN THAT COMPANY. */
export interface TeamMemberDto {
  id: string;
  email: string;
  name: string | null;
  /** Effective role in the company ('admin' for instance admins). */
  role: Role;
  invitePending: boolean;
  /** True when access comes from instance adminship, not a Membership row. */
  isInstanceAdmin: boolean;
}

export interface CompanyDto {
  id: string;
  realmId: string;
  legalName: string;
  nickname: string;
  env: QboEnv;
  syncMode: SyncMode;
  pollIntervalMin: PollInterval;
  holdingAccountIds: string[];
  dryRun: boolean;
  tagsRequired: boolean;
  retainAttachmentFiles: boolean;
  connectedAt: string;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
}

export interface AttachmentStoragePolicyDto {
  companyQuotaBytes: string;
  instanceQuotaBytes: string;
  companyUsageBytes: string;
  instanceUsageBytes: string;
  retentionDays: number;
  companyQuotaOverrideBytes: string | null;
  companyRetentionOverrideDays: number | null;
}

export interface AttachmentInstanceStoragePolicyDto {
  companyQuotaBytes: string;
  instanceQuotaBytes: string;
  instanceUsageBytes: string;
  retentionDays: number;
  companyQuotaFromEnv: boolean;
  instanceQuotaFromEnv: boolean;
  retentionFromEnv: boolean;
}

export type AttachmentStatus =
  | 'STAGED'
  | 'UPLOADING'
  | 'ATTACHED'
  | 'FAILED'
  | 'UNCERTAIN'
  | 'RECONCILING'
  | 'DELETING'
  | 'DELETED'
  | 'QBO_MISSING';

export interface AttachmentDto {
  id: string;
  transactionId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT' | 'QBO_EXTERNAL';
  retainedLocally: boolean;
  status: AttachmentStatus;
  qboAttached: boolean;
  canPreview: boolean;
  error: { code: string; message: string } | null;
}

export interface AttachmentOperationDto {
  operationId: string;
  status:
    | 'PREPARED'
    | 'COMMITTING'
    | 'PARTIAL'
    | 'VERIFIED'
    | 'FAILED'
    | 'UNCERTAIN'
    | 'DELETING'
    | 'DELETED';
  files: AttachmentDto[];
  actions: {
    canRetry: boolean;
    requiresReconciliation: boolean;
  };
}

export interface AttachmentUploadGrantDto {
  uploadUrl: string;
  grant: string;
  expiresAt: string;
  maxFileCount: number;
  maxEncodedRequestBytes: number;
}

export type AttachmentSourceInput =
  | { kind: 'upload'; uploadId: string }
  | { kind: 'https'; url: string };

export type ReceiptDocumentStatus =
  | 'RECEIVED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'READY'
  | 'MATCHED'
  | 'ATTACHING'
  | 'ATTACHED'
  | 'FAILED';

export type ReceiptSourceKind = 'WEB_UPLOAD' | 'API_UPLOAD' | 'MCP_UPLOAD';

export interface ReceiptTaxComponentDto {
  label: string;
  rate: string | null;
  amount: string | null;
  confidence: number | null;
}

export interface ReceiptLineItemDto {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
}

export interface ReceiptExtractionDto {
  id: string;
  generation: number;
  status: 'running' | 'succeeded' | 'failed';
  receiptDate: string | null;
  documentTitle: string | null;
  vendorName: string | null;
  vendorTaxId: string | null;
  vendorReceiptId: string | null;
  clientName: string | null;
  clientTaxId: string | null;
  description: string | null;
  lineItems: ReceiptLineItemDto[];
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  currency: string | null;
  convertedAmount: string | null;
  conversionRate: string | null;
  paymentMethod: string | null;
  paymentIdentifier: string | null;
  language: string | null;
  additionalFields: Array<{ key: string; value: string }>;
  rawExtractedText: string | null;
  documentType: string | null;
  category: string | null;
  extractionConfidence: number | null;
  taxComponents: ReceiptTaxComponentDto[];
  parseSalvaged: boolean;
  warnings: string[];
  model: string;
  promptVersion: string;
  schemaVersion: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
  durationMs: number | null;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ReceiptMatchEvidenceDto {
  amountPoints: number;
  currencyPoints: number;
  datePoints: number;
  vendorPoints: number;
  paymentPoints: number;
  amountDifferenceCents: number;
  dateDifferenceDays: number | null;
  vendorSimilarity: number | null;
}

export interface ReceiptMatchCandidateDto {
  transactionId: string;
  transactionRevision: number;
  rank: number;
  score: number;
  state: 'proposed' | 'rejected' | 'confirmed' | 'stale';
  evidence: ReceiptMatchEvidenceDto;
  transaction: Pick<
    TransactionDto,
    'id' | 'date' | 'payee' | 'memo' | 'amount' | 'status' | 'revision'
  >;
}

export interface ReceiptDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: string;
  sha256: string;
  sourceKind: ReceiptSourceKind;
  status: ReceiptDocumentStatus;
  generation: number;
  revision: number;
  pageCount: number | null;
  retentionPolicy: boolean;
  retainedLocally: boolean;
  approved: boolean;
  userNotes: string | null;
  manuallyEdited: boolean;
  lastExportedAt: string | null;
  matchedTransactionId: string | null;
  transactionAttachmentId: string | null;
  currentExtraction: ReceiptExtractionDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptEventDto {
  id: string;
  action: string;
  actorUserId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface ReceiptDetailDto extends ReceiptDto {
  previousId: string | null;
  nextId: string | null;
  attempts: ReceiptExtractionDto[];
  candidates: ReceiptMatchCandidateDto[];
  events: ReceiptEventDto[];
  attachment: AttachmentDto | null;
}

export interface ReceiptListResponse {
  receipts: ReceiptDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReceiptStatsDto {
  received: number;
  needsReview: number;
  queued: number;
  processing: number;
  failed: number;
  totalByCurrency: Array<{ currency: string; amount: string }>;
  totalByCategory: Array<{
    category: string;
    currency: string;
    amount: string;
  }>;
  totalTaxByCurrency: Array<{ currency: string; amount: string }>;
  processingCostUsd: string;
  recentActivity: ReceiptEventDto[];
}

export interface ReceiptStatsRange {
  dateFrom?: string;
  dateTo?: string;
}

export interface ReceiptDuplicateGroupDto {
  key: string;
  reason: 'content_hash' | 'document_identity';
  receipts: ReceiptDto[];
}

export interface ReceiptCompanySettingsDto {
  enabled: boolean;
  provider: SuggestionProvider;
  model: string;
  confidenceThreshold: number;
  autoMatchThreshold: number;
  autoMatchMargin: number;
  maxPages: number;
  configVersion: string;
}

export interface CreateReceiptsBody {
  idempotencyKey: string;
  files: Array<{ uploadId: string; sourceExternalId?: string }>;
  sourceKind: ReceiptSourceKind;
}

export interface CreateReceiptsResult {
  receipts: ReceiptDto[];
}

export interface PatchReceiptBody {
  expectedRevision: number;
  patch: ReceiptEditablePatch;
}

export interface ReceiptEditablePatch {
  receiptDate?: string | null;
  documentTitle?: string | null;
  vendorName?: string | null;
  vendorTaxId?: string | null;
  vendorReceiptId?: string | null;
  clientName?: string | null;
  clientTaxId?: string | null;
  description?: string | null;
  subtotal?: string | null;
  taxAmount?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
  paymentMethod?: string | null;
  paymentIdentifier?: string | null;
  language?: string | null;
  documentType?: string | null;
  category?: string | null;
  userNotes?: string | null;
  lineItems?: ReceiptLineItemDto[];
  taxComponents?: ReceiptTaxComponentDto[];
  additionalFields?: Array<{ key: string; value: string }>;
  approved?: boolean;
}

export interface ReceiptRevisionBody {
  expectedRevision: number;
}

export interface ReceiptBatchItem {
  id: string;
  expectedRevision: number;
}

export interface ReceiptBatchBody {
  receipts: ReceiptBatchItem[];
  idempotencyKey?: string;
}

export interface ReceiptBatchResult {
  updated: number;
}

export interface ReceiptExportBody {
  documentIds?: string[];
  filters?: ReceiptListParams;
}

export interface ConfirmReceiptMatchBody {
  expectedReceiptRevision: number;
  expectedTransactionRevision: number;
}

export interface ReceiptListParams {
  statuses?: ReceiptDocumentStatus[];
  documentTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
  sourceKinds?: ReceiptSourceKind[];
  missingInfo?: boolean;
  duplicate?: boolean;
  matched?: boolean;
  search?: string;
  sortBy?: 'createdAt' | 'receiptDate' | 'vendorName' | 'totalAmount' | 'status';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface QboPreflightDto {
  ok: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  environment: QboEnv;
  redirectUri: string;
  requiresOAuth: true;
}

export interface QboConnectionTestDto {
  ok: true;
  companyId: string;
  legalName: string;
  environment: QboEnv;
  mode: 'quickbooks' | 'demo';
  checkedAt: string;
}

export interface SplitDto {
  amount: number; // splits must sum to Transaction.amount (absolute value semantics: signed like txn)
  category: string; // display name
  categoryQboId?: string;
  taxCode?: string | null;
  taxCodeQboId?: string | null;
  tagIds: string[];
  memo?: string;
}

export interface SuggestionDto {
  category: string;
  categoryQboId?: string;
  source: SuggestionSource;
  ruleId?: string;
  /** Total rules matching the payee (set when source = 'rule'). */
  matchedRules?: number;
  /** matchText of the winning (topmost) rule (set when source = 'rule'). */
  winnerMatchText?: string;
}

export interface TransactionDto {
  id: string;
  companyId: string;
  qboId: string;
  qboType: 'Purchase' | 'Deposit' | 'JournalEntry';
  date: string; // ISO
  payee: string;
  memo: string | null;
  amount: number; // signed; + = money in
  bankAccount: string;
  status: TxnStatus;
  /** Current local staging revision; tax-aware staging must send this exact value. */
  revision: number;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  splits: SplitDto[] | null;
  tagIds: string[];
  suggestion: SuggestionDto | null;
  error: { code: string; message: string } | null;
  postedAt: string | null;
  postedBy: string | null;
  /** Latest unresolved durable write attempt, reduced to reconciliation-safe fields. */
  activeCategorizationAttempt: ActiveCategorizationAttemptDto | null;
  /** id of a detected transfer counterpart (equal |amount|, opposite sign, different account, ≤3 days) */
  transferCandidateId?: string | null;
}

export interface TagDto {
  id: string;
  companyId: string;
  name: string;
  color: string;
  usageCount?: number;
}

/** One transaction hit by a draft rule tested via POST /rules/test. */
export interface RuleTestMatch {
  txnId: string;
  payee: string;
  date: string; // ISO
  amount: number;
  status: TxnStatus;
  /** Would the draft rule win against the existing rules for this payee? */
  wouldWin: boolean;
  /** matchText of the existing winning rule for this payee (null if none). */
  currentWinner: string | null;
}

/** Existing rule that also matches at least one of the tested payees. */
export interface RuleTestConflict {
  ruleId: string;
  matchText: string;
  category: string;
  priority: number;
}

export interface RuleTestResult {
  matches: RuleTestMatch[];
  pendingCount: number;
  postedCount: number;
  conflicts: RuleTestConflict[];
}

export interface RuleDto {
  id: string;
  companyId: string;
  /** Match order — lowest number wins when several rules match a payee. */
  priority: number;
  matchField: 'payee';
  matchText: string;
  category: string;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  tagIds: string[];
  autoPost: boolean;
  createdAt: string;
  reviewRequiredAt: string | null;
  reviewReason: string | null;
  origin: {
    candidateId: string;
    evidenceCount: number;
    schemaVersion: string;
    configVersion: string;
  } | null;
}

export type RuleCandidateState =
  | 'ready'
  | 'conflict'
  | 'stale'
  | 'dismissed'
  | 'activated';

export interface RuleCandidateEvidenceDto {
  transactionId: string;
  source: 'user' | 'autopilot' | 'mcp';
  observedAt: string;
}

export interface RuleCandidateDto {
  id: string;
  companyId: string;
  state: RuleCandidateState;
  matchField: 'payee';
  matchText: string;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: TaxCalculation | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  tagIds: string[];
  evidenceCount: number;
  conflictingEvidenceCount: number;
  evidenceThreshold: number;
  schemaVersion: string;
  configVersion: string;
  staleReasons: string[];
  canActivate: boolean;
  activatedRuleId: string | null;
  provenance: {
    user: number;
    autopilot: number;
    mcp: number;
  };
  evidence: RuleCandidateEvidenceDto[];
  updatedAt: string;
}

export interface SavedReportConfig {
  range: string; // 'all' | 'YYYY-MM'
  flow: 'in' | 'out' | 'both';
  account: string; // 'all' | bank account name
  groupBy: 'tag' | 'cat' | 'acct';
  tagIds: string[];
}

export interface SavedReportDto {
  id: string;
  companyId: string;
  name: string;
  config: SavedReportConfig;
}

export interface AuditEntryDto {
  id: string;
  companyId: string;
  at: string;
  actor: string; // display name or 'system'
  payee: string;
  amount: number;
  action: AuditAction;
  before: string;
  after: string;
  payload?: unknown;
}

export interface QboAccountDto {
  id: string;
  qboId: string;
  name: string;
  fullName: string;
  classification: string; // Income | COGS | Expenses | ...
  active: boolean;
}

export interface SyncLogDto {
  id: string;
  kind: 'poll' | 'webhook' | 'manual' | 'nightly' | 'initial';
  ok: boolean;
  message: string;
  at: string;
}

export interface InstanceSettingsDto {
  /** Public address users reach this deployment at; base for the redirect URI. */
  appUrl: string;
  /** True when APP_URL is set in the environment, which makes appUrl read-only. */
  appUrlEnvManaged: boolean;
  intuitClientId: string; // masked when read
  intuitClientSecretSet: boolean;
  redirectUri: string;
  /** Webhook endpoint derived from appUrl, not from the browser's location. */
  webhookUrl: string;
  webhookVerifierTokenSet: boolean;
  suggestionSource: SuggestionSetting;
  suggestionProvider: SuggestionProvider;
  suggestionModel: string;
  agentDecisionModel: string;
  agentVerifierModel: string;
  aiEndpoint: string | null;
  aiKeySet: boolean;
  openrouterKeySet: boolean;
  openrouterReferer: string;
  openrouterTitle: string;
  needsSetup: boolean; // true until an admin user exists
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpFrom: string;
  smtpPassSet: boolean;
  smtpConfigured: boolean; // an SMTP host is present (env var or DB)
  smtpFromEnv: boolean; // true → SMTP managed by env vars; DB values ignored
}

export interface SessionDto {
  user: UserDto;
}

export interface AuthMethodsDto {
  localAdmin: boolean;
}

// ---- Report payloads ----

export interface StatementCell {
  value: number;
  text: string; // formatted, negatives in parentheses
}

export interface StatementRow {
  label: string;
  kind: 'head' | 'line' | 'total' | 'grand';
  indent: boolean;
  cells: StatementCell[];
  /** present on account 'line' rows — enables transaction drill-down */
  accountQboId?: string;
}

export interface StatementDto {
  title: string;
  subtitle: string;
  columns: { label: string }[];
  rows: StatementRow[];
  basisLabel: string;
  /** primary column's date range (YYYY-MM-DD) — the drill-down window */
  period?: { start: string; end: string };
}

export interface StatementDrilldownRow {
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /** signed; + = money in */
  amount: number;
  txnType: string;
}

export interface StatementDrilldownDto {
  accountName: string;
  rows: StatementDrilldownRow[];
}

/** One row of the whole-company transaction log (read straight from QuickBooks). */
export interface TransactionLogRowDto {
  date: string; // YYYY-MM-DD
  txnType: string;
  docNum?: string;
  payee: string;
  memo?: string;
  /** the account the transaction is entered against (bank / credit card) */
  account: string;
  /** QBO's Split column — the categorization; multi-line entities read '- Split -' */
  category: string;
  /** signed; + = money in */
  amount: number;
  /** stable tag key: "<qboType>:<qboId>" when QBO returned the entity id,
   *  else "row:<hash>" derived from the row's visible identity */
  qboKey: string;
  /** Recat tags on this transaction (queue tags and log tags merged) */
  tagIds: string[];
}

export interface TransactionLogDto {
  start: string;
  end: string;
  rows: TransactionLogRowDto[];
}

/** PUT /reports/transaction-log/tags */
export interface LogTagsBody {
  qboKey: string;
  tagIds: string[];
}

export interface CustomReportRow {
  name: string;
  color: string | null;
  count: number;
  total: number;
}

export interface CustomReportDto {
  rows: CustomReportRow[];
  count: number;
  total: number;
}

// ---- Dashboard ----

export type WidgetType = 'rev' | 'exp' | 'net' | 'uncat' | 'chart' | 'break' | 'pl';

export interface DashboardWidget {
  t: WidgetType;
  sp: 1 | 2 | 3 | 4;
}

export interface DashboardDataDto {
  months: string[];
  rev: number[];
  exp: number[];
  breakdown: { name: string; amount: number }[];
  pl: { income: number; cogs: number; expenses: number };
  pendingCount: number;
  pendingTotal: number;
}

// ---- Request bodies ----

export interface CategorizeBody {
  category?: string | null;
  categoryQboId?: string | null;
  splits?: SplitDto[] | null;
  tagIds?: string[];
}

export interface CompanyPatchBody {
  nickname?: string;
  syncMode?: SyncMode;
  pollIntervalMin?: PollInterval;
  holdingAccountIds?: string[];
  dryRun?: boolean;
  tagsRequired?: boolean;
  retainAttachmentFiles?: boolean;
  attachmentQuotaBytes?: string | null;
  attachmentRetentionDays?: number | null;
}

export interface ApiError {
  error: string;
  code?: string;
}

// QuickBooks localizes these: a British company returns "Uncategorised".
const HOLDING_ACCOUNT_TERM = /uncategori[sz]ed/i;
const DEFAULT_HOLDING_ACCOUNT_TERM = /uncategori[sz]ed expense/i;
const ASK_MY_ACCOUNTANT = /ask my accountant/i;

// QuickBooks' built-in holding accounts, enumerated. A prefix test would also
// swallow a user's own "Uncategorised Travel" or "Uncategorised Software", and
// this predicate is used where a match REMOVES a choice.
const QBO_BUILTIN_HOLDING_ACCOUNT =
  /^(uncategori[sz]ed (income|expense|asset)|ask my accountant)$/i;

/**
 * Might this be a holding account? Deliberately broad, and only for building
 * the list of accounts to OFFER as holding-account candidates — a near miss
 * costs the operator one extra row to scan, and they choose from it.
 *
 * Do not use it to hide accounts. See isQboHoldingAccountName.
 */
export function isHoldingAccountName(name: string): boolean {
  return ASK_MY_ACCOUNTANT.test(name) || HOLDING_ACCOUNT_TERM.test(name);
}

/**
 * Is this one of QuickBooks' built-in holding accounts? Use it where a match
 * REMOVES an account from what the user can pick — the category destinations in
 * Queue and Rules, which already exclude the company's designated holding
 * accounts by id and use this only to catch the built-ins on top.
 *
 * Enumerated rather than pattern-matched, because the two ways of being wrong
 * are not symmetric. Missing a built-in shows an account the operator can still
 * designate in Settings, which uses the broad matcher above. Matching too much
 * silently removes a category they created on purpose — "Old Uncategorized
 * Costs", "Uncategorised Travel" — with nothing to explain where it went.
 */
export function isQboHoldingAccountName(name: string): boolean {
  return QBO_BUILTIN_HOLDING_ACCOUNT.test(name.trim());
}

/**
 * Which accounts Setup preselects. Narrower than the candidate list — the
 * expense holding account is the one nearly every company wants — but left
 * unanchored, as it was before localization support, because preselection is a
 * suggestion the operator can undo rather than something that removes a choice.
 */
export function isDefaultHoldingAccountName(name: string): boolean {
  return ASK_MY_ACCOUNTANT.test(name) || DEFAULT_HOLDING_ACCOUNT_TERM.test(name);
}
