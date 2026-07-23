// Typed fetch wrapper + endpoint helpers for the whole Recat API surface.
// Paths follow "Recat Handoff.md" §4 with the project convention of an /api
// prefix (CLAUDE.md); auth endpoints live at /auth/* per the handoff and the
// Vite proxy. Where the server contract is not yet pinned down, the helper is
// marked with a TODO — server routes will be built to match this file.

import type {
  AuditEntryDto,
  CategorizeBody,
  CompanyDto,
  ConnectMode,
  CompanyPatchBody,
  CustomReportDto,
  DashboardDataDto,
  DashboardWidget,
  InstanceSettingsDto,
  PollInterval,
  QboAccountDto,
  QboEnv,
  Role,
  RuleDto,
  RuleTestResult,
  SavedReportConfig,
  SavedReportDto,
  SessionDto,
  LogTagsBody,
  StatementDrilldownDto,
  TransactionLogDto,
  StatementDto,
  SuggestionSetting,
  SyncMode,
  TagDto,
  TeamMemberDto,
  TransactionDto,
  TxnStatus,
  UserDto,
  ApiError as ApiErrorBody,
} from '@recat/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
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
    try {
      const data = (await res.json()) as Partial<ApiErrorBody>;
      if (typeof data.error === 'string') message = data.error;
      if (typeof data.code === 'string') code = data.code;
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new ApiError(res.status, message, code);
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
  intuitClientId?: string;
  intuitClientSecret?: string;
  webhookVerifierToken?: string;
  suggestionSource?: SuggestionSetting;
  suggestionProvider?: 'custom' | 'openrouter';
  suggestionModel?: string;
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
  /** Always 200 — no user enumeration. */
  magicLink: (email: string) => api.post<void>('/auth/magic-link', { email }),
  logout: () => api.post<void>('/auth/logout'),
  /** 401 (→ ApiError) when signed out. */
  session: () => api.get<SessionDto>('/api/session'),
};

export const companies = {
  list: () => api.get<CompanyDto[]>('/api/companies'),
  patch: (id: string, body: CompanyPatchBody) => api.patch<CompanyDto>(`/api/companies/${id}`, body),
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
  /** 202 — returns the txn in POSTING; poll list (or SSE later) for the outcome. */
  post: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/post`),
  undo: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/undo`),
  transfer: (id: string, counterpartTxnId: string) =>
    api.post<TransactionDto[]>(`/api/transactions/${id}/transfer`, { counterpartTxnId }),
  /** ERROR → re-fetch SyncToken from QBO and re-queue as PENDING. TODO(server): not in handoff §4. */
  retry: (id: string) => api.post<TransactionDto>(`/api/transactions/${id}/retry`),
  bulkPost: (ids: string[]) => api.post<void>('/api/transactions/bulk-post', { ids }),
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
  admin: (email: string) => api.post<void>('/api/setup/admin', { email }),
  /** Wizard step 2 — Intuit app credentials (stored encrypted; env vars take precedence). */
  credentials: (body: { clientId: string; clientSecret: string; env: QboEnv }) =>
    api.post<void>('/api/setup/credentials', body),
};
