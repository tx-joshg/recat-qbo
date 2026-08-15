// Typed fetch wrapper + endpoint helpers for the whole Recat API surface.
// Paths follow "Recat Handoff.md" §4 with the project convention of an /api
// prefix (CLAUDE.md); auth endpoints live at /auth/* per the handoff and the
// Vite proxy. Where the server contract is not yet pinned down, the helper is
// marked with a TODO — server routes will be built to match this file.

import type {
  AgentCompanySettingsDto,
  AgentRunStatus,
  AttachmentDto,
  AttachmentOperationDto,
  AttachmentSourceInput,
  AttachmentStoragePolicyDto,
  AttachmentInstanceStoragePolicyDto,
  AttachmentUploadGrantDto,
  AutopilotRunOutcome,
  AuditEntryDto,
  AuthMethodsDto,
  CategorizeBody,
  CompanyDto,
  CategorizationMutationResult,
  CommitCategorizationBody,
  ConnectMode,
  CompanyPatchBody,
  CustomReportDto,
  DashboardDataDto,
  DashboardWidget,
  InstanceSettingsDto,
  LivePauseStateDto,
  LiveReadinessDto,
  CreateMcpTokenResponse,
  McpTokenListResponse,
  PollInterval,
  QboAccountDto,
  QboConnectionTestDto,
  QboEnv,
  QboPreflightDto,
  ConfirmReceiptMatchBody,
  CreateReceiptsResult,
  PatchReceiptBody,
  ReceiptBatchBody,
  ReceiptBatchResult,
  ReceiptCompanySettingsDto,
  ReceiptDetailDto,
  ReceiptDuplicateGroupDto,
  ReceiptExportBody,
  ReceiptListParams,
  ReceiptListResponse,
  ReceiptSourceKind,
  ReceiptStatsDto,
  ReceiptStatsRange,
  Role,
  ReconcileCategorizationBody,
  RuleDto,
  RuleCandidateDto,
  RuleTestResult,
  SavedReportConfig,
  SavedReportDto,
  SessionDto,
  StageCategorizationBody,
  StagedCategorization,
  LogTagsBody,
  StatementDrilldownDto,
  TransactionLogDto,
  StatementDto,
  SuggestionSetting,
  SyncMode,
  TaxReadinessDto,
  TagDto,
  TeamMemberDto,
  TransactionDto,
  TxnStatus,
  UndoCategorizationBody,
  UserDto,
  ApiError as ApiErrorBody,
} from '@recat/shared';

export type { LivePauseStateDto, LiveReadinessDto } from '@recat/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly mutationResult: CategorizationMutationResult | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
    mutationResult?: CategorizationMutationResult,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.mutationResult = mutationResult;
  }
}

const MUTATION_STATUSES: readonly TxnStatus[] = [
  'PENDING',
  'POSTING',
  'POSTED',
  'DRY_RUN',
  'ERROR',
  'SUPERSEDED',
  'REVERTED',
];
const MUTATION_OUTCOMES: readonly CategorizationMutationResult['outcome'][] = [
  'VERIFIED',
  'UNCERTAIN',
  'IN_PROGRESS',
  'UNCHANGED',
  'DRY_RUN',
  'RETRYABLE',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MUTATION_ERROR_CODE_LENGTH = 120;
const MAX_MUTATION_ERROR_MESSAGE_LENGTH = 500;

function boundedMutationResult(value: unknown): CategorizationMutationResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.transactionId !== 'string' ||
    !UUID_PATTERN.test(candidate.transactionId) ||
    typeof candidate.requestId !== 'string' ||
    !UUID_PATTERN.test(candidate.requestId) ||
    typeof candidate.ok !== 'boolean' ||
    typeof candidate.status !== 'string' ||
    !MUTATION_STATUSES.includes(candidate.status as TxnStatus) ||
    typeof candidate.outcome !== 'string' ||
    !MUTATION_OUTCOMES.includes(candidate.outcome as CategorizationMutationResult['outcome'])
  ) {
    return undefined;
  }
  const result: CategorizationMutationResult = {
    transactionId: candidate.transactionId,
    requestId: candidate.requestId,
    ok: candidate.ok,
    status: candidate.status as TxnStatus,
    outcome: candidate.outcome as CategorizationMutationResult['outcome'],
  };
  if (candidate.error !== undefined) {
    if (typeof candidate.error !== 'object' || candidate.error === null) return undefined;
    const error = candidate.error as Record<string, unknown>;
    if (
      typeof error.code !== 'string' ||
      error.code.length === 0 ||
      error.code.length > MAX_MUTATION_ERROR_CODE_LENGTH ||
      typeof error.message !== 'string' ||
      error.message.length === 0 ||
      error.message.length > MAX_MUTATION_ERROR_MESSAGE_LENGTH
    ) return undefined;
    result.error = { code: error.code, message: error.message };
  }
  return result;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    let code: string | undefined;
    let mutationResult: CategorizationMutationResult | undefined;
    try {
      const data = await res.json() as unknown;
      if (typeof data === 'object' && data !== null) {
        const errorBody = data as Partial<ApiErrorBody>;
        if (typeof errorBody.error === 'string') message = errorBody.error;
        if (typeof errorBody.code === 'string') code = errorBody.code;
      }
      mutationResult = boundedMutationResult(data);
      if (mutationResult?.error) {
        message = mutationResult.error.message;
        code = mutationResult.error.code;
      }
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new ApiError(res.status, message, code, mutationResult);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Generate once at the start of a user mutation and retain it across retries. */
export function createCategorizationRequestId(): string {
  const secureCrypto = globalThis.crypto;
  if (secureCrypto && typeof secureCrypto.randomUUID === 'function') {
    return secureCrypto.randomUUID();
  }
  if (!secureCrypto || typeof secureCrypto.getRandomValues !== 'function') {
    throw new Error('Secure random UUID generation is unavailable.');
  }
  const bytes = new Uint8Array(16);
  secureCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Response envelopes not defined in @recat/shared.
// TODO(server): server routes must return exactly these shapes.
// ---------------------------------------------------------------------------

export interface TransactionListParams {
  status?: TxnStatus;
  search?: string;
  account?: string;
  cursor?: string;
  /** true → server may return an empty `transactions` array; `pendingCount` is still filled. */
  countOnly?: boolean;
}

export interface TransactionListResponse {
  transactions: TransactionDto[];
  nextCursor: string | null;
  /** count of PENDING transactions for the company (queue tab badge). */
  pendingCount: number;
}

/** A detected transfer pair (equal |amount|, opposite sign, different accounts, ≤3 days). */
export interface TransferCandidatePair {
  a: TransactionDto;
  b: TransactionDto;
}

export interface AuditListParams {
  cursor?: string;
  q?: string;
}

export interface AuditListResponse {
  entries: AuditEntryDto[];
  nextCursor: string | null;
}

export interface AutopilotEvidenceDto {
  eligibleRuns: number;
  agreements: number;
  disagreements: number;
  threshold: number;
  thresholdMet: boolean;
}

export interface AutopilotQueueHealthDto {
  queued: number;
  running: number;
  retrying: number;
  terminal: number;
  cancelled: number;
  earliestDueAt: string | null;
  earliestLeaseExpiryAt: string | null;
}

export interface AutopilotOverviewDto {
  settings: AgentCompanySettingsDto;
  liveWrites: {
    utcDay: string;
    used: number;
    limit: number;
    /** Server-derived milliseconds until the cap resets. Relative on purpose:
     *  the browser is not an authority on PostgreSQL's UTC day. */
    resetsInMs: number;
  };
  queue: AutopilotQueueHealthDto;
  evidence: AutopilotEvidenceDto;
}

export interface AutopilotRunDto {
  id: string;
  status: AgentRunStatus | 'unavailable';
  outcome: AutopilotRunOutcome;
  operationId: string | null;
  attemptCount: number;
  configVersion: string;
  proposal:
    | {
        kind: 'proposal';
        taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
        confidence: number;
        lineCount: number;
        evidenceKinds: ('category' | 'rule' | 'similar_transaction' | 'tax_code')[];
      }
    | {
        kind: 'abstain';
        reasonCode:
          | 'INSUFFICIENT_CONTEXT'
          | 'CONFLICTING_EVIDENCE'
          | 'UNSUPPORTED_TRANSACTION'
          | 'INVALID_TAX_STATE'
          | 'PROVIDER_FAILURE';
      }
    | null;
  verification: {
    diagnosticCode: string | null;
    verifierKind: 'deterministic' | 'same_model' | 'distinct_model' | 'unavailable';
    evidence: {
      state: 'eligible' | 'invalidated';
      agreement?: boolean;
      invalidationReason?: 'corrected' | 'reverted';
    } | null;
  };
  models: {
    decision: string;
    verifier: string;
    promptVersion: string;
    schemaVersion: string;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  timing: {
    durationMs: number | null;
    createdAt: string;
    completedAt: string | null;
  };
  errorCode: string | null;
}

export interface AutopilotRunListDto {
  runs: AutopilotRunDto[];
  nextCursor: string | null;
}

export interface AutopilotSettingsPatch {
  mode?: AgentCompanySettingsDto['mode'];
  provider?: AgentCompanySettingsDto['provider'];
  decisionModel?: string;
  verifierModel?: string;
  scheduleMinutes?: number;
  companyConcurrency?: number;
  evidenceThreshold?: number;
  dailyLiveWriteLimit?: number;
  limits?: Partial<AgentCompanySettingsDto['limits']>;
}

export interface EnableLiveBody {
  confirmation: string;
  acceptedPolicyVersion: string;
}

export type LiveReconciliationResult = Omit<
  CategorizationMutationResult,
  'transactionId' | 'requestId'
>;

export interface PlReportParams {
  /** number of months (e.g. '6') or 'ytd'. TODO(server): confirm encoding. */
  period: string;
  columns: 'total' | 'months';
  compare: 'none' | 'prev' | 'py';
  basis: 'cash' | 'accrual';
}

export interface BsReportParams {
  /** 'YYYY-MM' month the balance sheet is drawn as of. */
  asOf: string;
  compare: 'none' | 'prev' | 'py';
  basis: 'cash' | 'accrual';
}

export interface InstanceSettingsPatchBody {
  /** Public address of this deployment; rejected when APP_URL is env-managed. */
  appUrl?: string;
  intuitClientId?: string;
  intuitClientSecret?: string;
  webhookVerifierToken?: string;
  suggestionSource?: SuggestionSetting;
  suggestionProvider?: 'custom' | 'openrouter';
  suggestionModel?: string;
  agentDecisionModel?: string;
  agentVerifierModel?: string;
  aiEndpoint?: string | null;
  aiKey?: string;
  aiApiKey?: string;
  openrouterApiKey?: string;
  openrouterReferer?: string;
  openrouterTitle?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

/** POST /api/instance/settings/test-email — delivered:false means the console fallback took it. */
export interface TestEmailResponse {
  ok: boolean;
  delivered: boolean;
  to: string;
}

export interface InviteMemberBody {
  email: string;
  role: Role;
}

/** Invite response — devLink is dev-mode only (no SMTP configured). */
export interface InviteMemberResponse {
  member: TeamMemberDto;
  devLink?: string;
}

/** GET /api/setup/status — used by /login and /setup routing. */
export interface SetupStatus {
  needsSetup: boolean;
  /** Real Intuit credentials are configured (env or wizard). The demo needs none. */
  credentialsSet: boolean;
  /** An SMTP host is present (env var or DB) — the wizard's Email step is optional. */
  smtpConfigured: boolean;
  /** `${APP_URL}/auth/qbo/callback` — shown verbatim on the Credentials step. */
  redirectUri: string;
  /** `${APP_URL}/webhooks/qbo` — shown on the Sync step when webhooks are picked. */
  webhookUrl?: string;
  /**
   * `LOCAL_ADMIN_EMAIL`, present only while `needsSetup` and local sign-in is
   * enabled. The wizard must create this exact address or the password the
   * deployment displays authenticates nobody — see the Admin step.
   */
  localAdminEmail?: string;
}

/** Connect-flow choices for GET /api/companies/connect-url. */
export interface ConnectUrlParams {
  /** 'demo' → built-in fake QuickBooks; 'real' (default) → Intuit OAuth. */
  mode: ConnectMode;
  /** sandbox/production for the real flow; ignored for demo. */
  env?: QboEnv;
}

// ---------------------------------------------------------------------------
// Endpoint helpers
// ---------------------------------------------------------------------------

export const auth = {
  methods: () => api.get<AuthMethodsDto>('/auth/methods'),
  /** Always 200 — no user enumeration. */
  magicLink: (email: string) => api.post<void>('/auth/magic-link', { email }),
  local: (email: string, password: string) =>
    api.post<SessionDto>('/auth/local', { email, password }),
  logout: () => api.post<void>('/auth/logout'),
  /** 401 (→ ApiError) when signed out. */
  session: () => api.get<SessionDto>('/api/session'),
};

export const companies = {
  list: () => api.get<CompanyDto[]>('/api/companies'),
  patch: (id: string, body: CompanyPatchBody) => api.patch<CompanyDto>(`/api/companies/${id}`, body),
  attachmentStoragePolicy: (id: string) =>
    api.get<AttachmentStoragePolicyDto>(`/api/companies/${id}/attachment-storage-policy`),
  sync: (id: string) => api.post<void>(`/api/companies/${id}/sync`),
  /** Consent URL for connecting a (new) company — mode=demo → the built-in
   * fake consent page; mode=real → Intuit OAuth (env picks sandbox/production). */
  connectUrl: (params: ConnectUrlParams) =>
    api.get<{ url: string }>(`/api/companies/connect-url${qs({ mode: params.mode, env: params.env })}`),
  /** Disconnect: revoke tokens, keep history. */
  disconnect: (id: string) => api.del<void>(`/api/companies/${id}`),
  accounts: (id: string) => api.get<QboAccountDto[]>(`/api/companies/${id}/accounts`),
  transferCandidates: (id: string) =>
    api.get<TransferCandidatePair[]>(`/api/companies/${id}/transfer-candidates`),
  dashboard: (id: string) => api.get<DashboardDataDto>(`/api/companies/${id}/dashboard`),
  /** Setup-wizard step 4: pick which holding accounts to watch. */
  setHoldingAccounts: (id: string, holdingAccountIds: string[]) =>
    api.post<CompanyDto>(`/api/companies/${id}/holding-accounts`, { holdingAccountIds }),
  /** Setup-wizard step 5 / Settings: sync mode. Plain PATCH under the hood. */
  setSyncMode: (id: string, syncMode: SyncMode, pollIntervalMin?: PollInterval) =>
    api.patch<CompanyDto>(`/api/companies/${id}`, { syncMode, pollIntervalMin }),
};

export const transactions = {
  list: (companyId: string, params: TransactionListParams = {}) =>
    api.get<TransactionListResponse>(`/api/companies/${companyId}/transactions${qs({ ...params })}`),
  /** Stage category/splits/tags — no QBO write. */
  categorize: (id: string, body: CategorizeBody) =>
    api.post<TransactionDto>(`/api/transactions/${id}/categorize`, body),
  /** Strict revision-bound tax-aware staging. */
  stageCategorization: (id: string, body: StageCategorizationBody) =>
    api.post<StagedCategorization>(`/api/transactions/${id}/categorization/stage`, body),
  /** A new operation gets a new ID; callers retain it if the outcome needs reconciliation. */
  commitCategorization: (
    id: string,
    expectedRevision: CommitCategorizationBody['expectedRevision'],
    requestId: CommitCategorizationBody['requestId'],
  ) =>
    api.post<CategorizationMutationResult>(
      `/api/transactions/${id}/categorization/commit`,
      { expectedRevision, requestId } satisfies CommitCategorizationBody,
    ),
  /** Reconciliation and retry always reuse the possibly-written attempt's ID. */
  reconcileCategorization: (id: string, requestId: ReconcileCategorizationBody['requestId']) =>
    api.post<CategorizationMutationResult>(
      `/api/transactions/${id}/categorization/reconcile`,
      { requestId } satisfies ReconcileCategorizationBody,
    ),
  retryCategorization: (id: string, requestId: ReconcileCategorizationBody['requestId']) =>
    api.post<CategorizationMutationResult>(
      `/api/transactions/${id}/categorization/retry`,
      { requestId } satisfies ReconcileCategorizationBody,
    ),
  undoCategorization: (
    id: string,
    requestId: UndoCategorizationBody['requestId'],
  ) =>
    api.post<CategorizationMutationResult>(
      `/api/transactions/${id}/categorization/undo`,
      { requestId } satisfies UndoCategorizationBody,
    ),
  /** 202 — returns the txn in POSTING; poll list (or SSE later) for the outcome. */
  post: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/post`),
  undo: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/undo`),
  transfer: (id: string, counterpartTxnId: string) =>
    api.post<TransactionDto[]>(`/api/transactions/${id}/transfer`, { counterpartTxnId }),
  /** ERROR → re-fetch SyncToken from QBO and re-queue as PENDING. TODO(server): not in handoff §4. */
  retry: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/retry`),
  bulkPost: (ids: string[]) => api.post<void>('/api/transactions/bulk-post', { ids }),
};

interface StagedAttachmentResponse {
  uploads: Array<{ id: string }>;
}

async function attachmentUploadRequest(
  grant: AttachmentUploadGrantDto,
  files: readonly File[],
): Promise<StagedAttachmentResponse> {
  const body = new FormData();
  for (const file of files) body.append('files', file, file.name);
  const res = await fetch(grant.uploadUrl, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${grant.grant}` },
    body,
  });
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const errorBody = await res.json() as Partial<ApiErrorBody>;
      if (typeof errorBody.error === 'string') message = errorBody.error;
      if (typeof errorBody.code === 'string') code = errorBody.code;
    } catch {
      // Preserve the bounded HTTP status message for non-JSON failures.
    }
    throw new ApiError(res.status, message, code);
  }
  return await res.json() as StagedAttachmentResponse;
}

const attachmentPath = (companyId: string, transactionId: string) =>
  `/api/companies/${companyId}/transactions/${transactionId}/attachments`;

export const attachments = {
  createGrant: (companyId: string, fileCount: number, _contentBytes: number) =>
    api.post<AttachmentUploadGrantDto>(
      `/api/companies/${companyId}/attachment-upload-grants`,
      {
        fileCount,
        // The server enforces the exact encoded request size while parsing.
        // Asking for the provider ceiling avoids guessing the browser boundary overhead.
        maxEncodedRequestBytes: 100_000_000,
      },
    ),
  stage: async (grant: AttachmentUploadGrantDto, files: readonly File[]) => {
    const response = await attachmentUploadRequest(grant, files);
    return response.uploads.map((upload) => upload.id);
  },
  attach: (
    companyId: string,
    transactionId: string,
    sources: readonly AttachmentSourceInput[],
  ) =>
    api.post<AttachmentOperationDto>(attachmentPath(companyId, transactionId), {
      idempotencyKey: createCategorizationRequestId(),
      sources,
    }),
  list: (
    companyId: string,
    transactionId: string,
    refresh = false,
  ) => refresh
    ? api.post<AttachmentDto[]>(`${attachmentPath(companyId, transactionId)}/refresh`, {})
    : api.get<AttachmentDto[]>(attachmentPath(companyId, transactionId)),
  retry: (companyId: string, transactionId: string, operationId: string) =>
    api.post<AttachmentOperationDto>(
      `${attachmentPath(companyId, transactionId)}/operations/${operationId}/retry`,
      {},
    ),
  reconcile: (companyId: string, transactionId: string, operationId: string) =>
    api.post<AttachmentOperationDto>(
      `${attachmentPath(companyId, transactionId)}/operations/${operationId}/reconcile`,
      {},
    ),
  downloadUrl: (companyId: string, transactionId: string, attachmentId: string) =>
    `${attachmentPath(companyId, transactionId)}/${attachmentId}/download`,
  previewUrl: (companyId: string, transactionId: string, attachmentId: string) =>
    `${attachmentPath(companyId, transactionId)}/${attachmentId}/preview`,
  saveLocal: (companyId: string, transactionId: string, attachmentId: string) =>
    api.post<AttachmentDto>(
      `${attachmentPath(companyId, transactionId)}/${attachmentId}/save-local`,
      {},
    ),
  delete: (
    companyId: string,
    transactionId: string,
    attachmentId: string,
    scope: 'local' | 'everywhere',
  ) =>
    api.del<AttachmentOperationDto>(
      `${attachmentPath(companyId, transactionId)}/${attachmentId}${qs({
        scope,
        idempotencyKey: createCategorizationRequestId(),
      })}`,
  ),
};

function receiptQuery(filters: ReceiptListParams): string {
  return qs({
    status: filters.statuses,
    documentType: filters.documentTypes,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    sourceKind: filters.sourceKinds,
    missingInfo: filters.missingInfo,
    duplicate: filters.duplicate,
    matched: filters.matched,
    search: filters.search,
    page: filters.page,
    pageSize: filters.pageSize,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });
}

async function receiptExport(
  companyId: string,
  body: ReceiptExportBody,
): Promise<Blob> {
  const response = await fetch(
    `/api/companies/${companyId}/receipts/export`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('filters' in body && body.filters
        ? {
            filters: {
              status: body.filters.statuses,
              documentType: body.filters.documentTypes,
              dateFrom: body.filters.dateFrom,
              dateTo: body.filters.dateTo,
              sourceKind: body.filters.sourceKinds,
              missingInfo: body.filters.missingInfo,
              duplicate: body.filters.duplicate,
              matched: body.filters.matched,
              search: body.filters.search,
              page: body.filters.page,
              pageSize: body.filters.pageSize,
              sortBy: body.filters.sortBy,
              sortOrder: body.filters.sortOrder,
            },
          }
        : body),
    },
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.statusText || `Request failed (${response.status})`,
    );
  }
  return response.blob();
}

const receiptBase = (companyId: string) =>
  `/api/companies/${companyId}/receipts`;

export const receipts = {
  async upload(
    companyId: string,
    files: File[],
    sourceKind: ReceiptSourceKind,
  ): Promise<CreateReceiptsResult> {
    const contentBytes = files.reduce((sum, file) => sum + file.size, 0);
    const grant = await attachments.createGrant(
      companyId,
      files.length,
      contentBytes,
    );
    const uploadIds = await attachments.stage(grant, files);
    return api.post<CreateReceiptsResult>(receiptBase(companyId), {
      idempotencyKey: createCategorizationRequestId(),
      files: uploadIds.map((uploadId) => ({ uploadId })),
      sourceKind,
    });
  },
  list: (companyId: string, filters: ReceiptListParams = {}) =>
    api.get<ReceiptListResponse>(
      `${receiptBase(companyId)}${receiptQuery(filters)}`,
    ),
  detail: (companyId: string, receiptId: string) =>
    api.get<ReceiptDetailDto>(`${receiptBase(companyId)}/${receiptId}`),
  stats: (companyId: string, range: ReceiptStatsRange = {}) =>
    api.get<ReceiptStatsDto>(
      `${receiptBase(companyId)}/stats${qs({ ...range })}`,
    ),
  duplicates: (companyId: string) =>
    api.get<ReceiptDuplicateGroupDto[]>(
      `${receiptBase(companyId)}/duplicates`,
    ),
  patch: (
    companyId: string,
    receiptId: string,
    body: PatchReceiptBody,
  ) => api.patch<ReceiptDetailDto>(
    `${receiptBase(companyId)}/${receiptId}`,
    body,
  ),
  reprocess: (
    companyId: string,
    receiptId: string,
    body: { expectedRevision: number; idempotencyKey: string },
  ) => api.post<ReceiptDetailDto>(
    `${receiptBase(companyId)}/${receiptId}/reprocess`,
    body,
  ),
  rematch: (
    companyId: string,
    receiptId: string,
    expectedReceiptRevision: number,
  ) => api.post<ReceiptDetailDto>(
    `${receiptBase(companyId)}/${receiptId}/rematch`,
    { expectedReceiptRevision },
  ),
  confirmMatch: (
    companyId: string,
    receiptId: string,
    transactionId: string,
    body: ConfirmReceiptMatchBody,
  ) => api.post<ReceiptDetailDto>(
    `${receiptBase(companyId)}/${receiptId}`
    + `/matches/${transactionId}/confirm`,
    body,
  ),
  attach: (
    companyId: string,
    receiptId: string,
    body: {
      expectedReceiptRevision: number;
      expectedTransactionRevision: number;
    },
  ) => api.post<AttachmentOperationDto>(
    `${receiptBase(companyId)}/${receiptId}/attach`,
    body,
  ),
  undo: (
    companyId: string,
    receiptId: string,
    body: {
      expectedReceiptRevision: number;
      expectedTransactionRevision: number;
    },
  ) => api.post<AttachmentOperationDto>(
    `${receiptBase(companyId)}/${receiptId}/undo`,
    body,
  ),
  restore: (
    companyId: string,
    receiptId: string,
    expectedRevision: number,
  ) => api.post<ReceiptDetailDto>(
    `${receiptBase(companyId)}/${receiptId}/restore`,
    { expectedRevision },
  ),
  delete: (
    companyId: string,
    receiptId: string,
    expectedRevision: number,
  ) => api.del<void>(
    `${receiptBase(companyId)}/${receiptId}${qs({ expectedRevision })}`,
  ),
  batchApprove: (companyId: string, body: ReceiptBatchBody) =>
    api.post<ReceiptBatchResult>(
      `${receiptBase(companyId)}/batch/approve`,
      body,
    ),
  batchDelete: (companyId: string, body: ReceiptBatchBody) =>
    api.post<ReceiptBatchResult>(
      `${receiptBase(companyId)}/batch/delete`,
      body,
    ),
  batchReprocess: (companyId: string, body: ReceiptBatchBody) =>
    api.post<ReceiptBatchResult>(
      `${receiptBase(companyId)}/batch/reprocess`,
      body,
    ),
  export: receiptExport,
  fileUrl: (companyId: string, receiptId: string) =>
    `${receiptBase(companyId)}/${receiptId}/file`,
  previewUrl: (companyId: string, receiptId: string) =>
    `${receiptBase(companyId)}/${receiptId}/preview`,
  settings: {
    get: (companyId: string) =>
      api.get<ReceiptCompanySettingsDto>(
        `/api/companies/${companyId}/receipt-settings`,
      ),
    patch: (
      companyId: string,
      patch: Partial<Omit<ReceiptCompanySettingsDto, 'configVersion'>>,
    ) => api.patch<ReceiptCompanySettingsDto>(
      `/api/companies/${companyId}/receipt-settings`,
      patch,
    ),
  },
};

export const tags = {
  list: (companyId: string) => api.get<TagDto[]>(`/api/companies/${companyId}/tags`),
  create: (companyId: string, body: { name: string; color: string }) =>
    api.post<TagDto>(`/api/companies/${companyId}/tags`, body),
  patch: (companyId: string, tagId: string, body: { name?: string; color?: string }) =>
    api.patch<TagDto>(`/api/companies/${companyId}/tags/${tagId}`, body),
  del: (companyId: string, tagId: string) =>
    api.del<void>(`/api/companies/${companyId}/tags/${tagId}`),
};

export interface RuleBody {
  matchText: string;
  category: string;
  categoryQboId?: string | null;
  tagIds?: string[];
  autoPost?: boolean;
  /** Match order — lowest number wins when several rules match. */
  priority?: number;
}

export const rules = {
  /** Returns rules in match order (priority asc) — render as-is, no re-sort. */
  list: (companyId: string) => api.get<RuleDto[]>(`/api/companies/${companyId}/rules`),
  create: (companyId: string, body: RuleBody) =>
    api.post<RuleDto>(`/api/companies/${companyId}/rules`, body),
  patch: (companyId: string, ruleId: string, body: Partial<RuleBody>) =>
    api.patch<RuleDto>(`/api/companies/${companyId}/rules/${ruleId}`, body),
  del: (companyId: string, ruleId: string) =>
    api.del<void>(`/api/companies/${companyId}/rules/${ruleId}`),
  /** Persist a full match order: ids[0] = topmost (wins first). Returns the reordered list. */
  reorder: (companyId: string, ids: string[]) =>
    api.put<RuleDto[]>(`/api/companies/${companyId}/rules/order`, { ids }),
  /** Dry-run a draft rule (placed at top priority) against recent transactions. */
  test: (companyId: string, matchText: string) =>
    api.post<RuleTestResult>(`/api/companies/${companyId}/rules/test`, { matchText }),
};

export const ruleCandidates = {
  list: (companyId: string, cursor?: string) =>
    api.get<{ candidates: RuleCandidateDto[]; nextCursor: string | null }>(
      `/api/companies/${companyId}/rule-candidates${qs({ cursor })}`,
    ),
  get: (companyId: string, candidateId: string) =>
    api.get<RuleCandidateDto>(
      `/api/companies/${companyId}/rule-candidates/${candidateId}`,
    ),
  dismiss: (companyId: string, candidateId: string) =>
    api.post<RuleCandidateDto>(
      `/api/companies/${companyId}/rule-candidates/${candidateId}/dismiss`,
    ),
  activate: (companyId: string, candidateId: string) =>
    api.post<RuleCandidateDto>(
      `/api/companies/${companyId}/rule-candidates/${candidateId}/activate`,
    ),
};

export const savedReports = {
  list: (companyId: string) => api.get<SavedReportDto[]>(`/api/companies/${companyId}/reports/saved`),
  create: (companyId: string, name: string, config: SavedReportConfig) =>
    api.post<SavedReportDto>(`/api/companies/${companyId}/reports/saved`, { name, config }),
  del: (companyId: string, reportId: string) =>
    api.del<void>(`/api/companies/${companyId}/reports/saved/${reportId}`),
};

export const reports = {
  pl: (companyId: string, params: PlReportParams) =>
    api.get<StatementDto>(`/api/companies/${companyId}/reports/pl${qs({ ...params })}`),
  bs: (companyId: string, params: BsReportParams) =>
    api.get<StatementDto>(`/api/companies/${companyId}/reports/bs${qs({ ...params })}`),
  custom: (companyId: string, config: SavedReportConfig) =>
    api.get<CustomReportDto>(
      `/api/companies/${companyId}/reports/custom${qs({
        range: config.range,
        flow: config.flow,
        account: config.account,
        groupBy: config.groupBy,
        tagIds: config.tagIds,
      })}`,
    ),
  /** Transactions behind one statement row: account = QBO account id, start/end = YYYY-MM-DD. */
  drilldown: (companyId: string, params: { account: string; start: string; end: string }) =>
    api.get<StatementDrilldownDto>(`/api/companies/${companyId}/reports/drilldown${qs({ ...params })}`),
  /** Whole-company transaction log, straight from QuickBooks. start/end = YYYY-MM-DD. */
  transactionLog: (companyId: string, params: { start: string; end: string }) =>
    api.get<TransactionLogDto>(`/api/companies/${companyId}/reports/transaction-log${qs({ ...params })}`),
  /** Replace the Recat tag set on one log row (categorizer+). */
  setLogTags: (companyId: string, body: LogTagsBody) =>
    api.put<{ ok: boolean }>(`/api/companies/${companyId}/reports/transaction-log/tags`, body),
};

export const dashboardLayout = {
  /** null → user has never customized; use the default widget set. TODO(server): confirm. */
  get: () => api.get<{ widgets: DashboardWidget[] | null }>('/api/me/dashboard-layout'),
  save: (widgets: DashboardWidget[]) => api.put<void>('/api/me/dashboard-layout', { widgets }),
};

export const mcpTokens = {
  list: (params: { limit?: number; cursor?: string } = {}) =>
    api.get<McpTokenListResponse>(`/api/me/mcp-tokens${qs(params)}`),
  create: (body: { label: string; expiresInDays?: number }) =>
    api.post<CreateMcpTokenResponse>('/api/me/mcp-tokens', body),
  revoke: (id: string) => api.del<void>(`/api/me/mcp-tokens/${id}`),
};

export const audit = {
  list: (companyId: string, params: AuditListParams = {}) =>
    api.get<AuditListResponse>(`/api/companies/${companyId}/audit${qs({ ...params })}`),
  /** Plain URL (not fetch) — use in an <a href> / window.open for the CSV download. */
  exportUrl: (companyId: string) => `/api/companies/${companyId}/audit/export.csv`,
};

export const instanceSettings = {
  get: () => api.get<InstanceSettingsDto>('/api/instance/settings'),
  patch: (body: InstanceSettingsPatchBody) =>
    api.patch<InstanceSettingsDto>('/api/instance/settings', body),
  /** Send a test email via the current SMTP config; defaults to the caller's address. */
  testEmail: (to?: string) =>
    api.post<TestEmailResponse>('/api/instance/settings/test-email', to !== undefined ? { to } : {}),
};

export const attachmentStoragePolicy = {
  getInstance: () =>
    api.get<AttachmentInstanceStoragePolicyDto>('/api/instance/attachment-storage-policy'),
  patchInstance: (body: {
    companyQuotaBytes?: string;
    instanceQuotaBytes?: string;
    retentionDays?: number;
  }) => api.patch<AttachmentInstanceStoragePolicyDto>(
    '/api/instance/attachment-storage-policy',
    body,
  ),
};

export const qboDiagnostics = {
  preflight: () => api.post<QboPreflightDto>('/api/instance/qbo/preflight'),
  testConnection: (companyId: string) =>
    api.post<QboConnectionTestDto>(`/api/companies/${companyId}/test-connection`),
};

export interface TaxRefreshResponse {
  readiness: TaxReadinessDto;
  refreshed: boolean;
}

/** Cached purchase-tax readiness (viewer+). */
export const tax = {
  get: (companyId: string) => api.get<TaxReadinessDto>(`/api/companies/${companyId}/tax`),
  /** Force a fresh QBO reference read (company admin only); it never writes QBO tax settings. */
  refresh: (companyId: string) =>
    api.post<TaxRefreshResponse>(`/api/companies/${companyId}/tax/refresh`),
};

/** Durable shadow operations. These endpoints expose summaries only and never mutate QBO. */
export const autopilot = {
  get: (companyId: string) =>
    api.get<AutopilotOverviewDto>(`/api/companies/${companyId}/autopilot`),
  patch: (companyId: string, body: AutopilotSettingsPatch) =>
    api.patch<AgentCompanySettingsDto>(`/api/companies/${companyId}/autopilot`, body),
  listRuns: (companyId: string, params: { cursor?: string; limit?: number } = {}) =>
    api.get<AutopilotRunListDto>(
      `/api/companies/${companyId}/autopilot/runs${qs(params)}`,
    ),
  run: (companyId: string, runId: string) =>
    api.get<AutopilotRunDto>(`/api/companies/${companyId}/autopilot/runs/${runId}`),
  getReadiness: (companyId: string) =>
    api.get<LiveReadinessDto>(
      `/api/companies/${companyId}/autopilot/live-readiness`,
    ),
  enableLive: (companyId: string, body: EnableLiveBody) =>
    api.post<LiveReadinessDto>(
      `/api/companies/${companyId}/autopilot/enable-live`,
      body,
    ),
  pauseLive: (companyId: string) =>
    api.post<LivePauseStateDto>(
      `/api/companies/${companyId}/autopilot/pause-live`,
      {},
    ),
  reconcileLive: (companyId: string, operationId: string) =>
    api.post<LiveReconciliationResult>(
      `/api/companies/${companyId}/autopilot/reconcile/${encodeURIComponent(operationId)}`,
      {},
    ),
  cancelQueued: (companyId: string) =>
    api.post<{ cancelled: number }>(
      `/api/companies/${companyId}/autopilot/cancel-queued`,
    ),
};

/** Instance-level user management — instance admins only. */
export const users = {
  list: () => api.get<UserDto[]>('/api/users'),
  patch: (id: string, body: { isInstanceAdmin?: boolean; name?: string }) =>
    api.patch<UserDto>(`/api/users/${id}`, body),
  del: (id: string) => api.del<void>(`/api/users/${id}`),
};

/** Per-company team (membership) management — company admins of that company. */
export const team = {
  list: (companyId: string) => api.get<TeamMemberDto[]>(`/api/companies/${companyId}/team`),
  invite: (companyId: string, body: InviteMemberBody) =>
    api.post<InviteMemberResponse>(`/api/companies/${companyId}/team`, body),
  patch: (companyId: string, userId: string, body: { role: Role }) =>
    api.patch<TeamMemberDto>(`/api/companies/${companyId}/team/${userId}`, body),
  remove: (companyId: string, userId: string) =>
    api.del<void>(`/api/companies/${companyId}/team/${userId}`),
};

export const setup = {
  status: () => api.get<SetupStatus>('/api/setup/status'),
  /** Wizard step 1 — create the admin account (verified by magic link). */
  admin: (email: string, password?: string) =>
    api.post<void>('/api/setup/admin', password === undefined ? { email } : { email, password }),
  /** Wizard step 2 — Intuit app credentials (stored encrypted; env vars take precedence). */
  credentials: (body: { clientId: string; clientSecret: string; env: QboEnv }) =>
    api.post<void>('/api/setup/credentials', body),
};
