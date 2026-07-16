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
export type PollInterval = 5 | 10 | 30 | 60;
export type SuggestionSource = 'rule' | 'history' | 'ai';
export type SuggestionSetting = 'builtin' | 'ai' | 'off';
export type AuditAction =
  | 'posted'
  | 'dry-run'
  | 'error'
  | 'reverted'
  | 'superseded'
  | 'transfer'
  | 'auto-posted';

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
  connectedAt: string;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
}

export interface SplitDto {
  amount: number; // splits must sum to Transaction.amount (absolute value semantics: signed like txn)
  category: string; // display name
  categoryQboId?: string;
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
  category: string | null;
  categoryQboId: string | null;
  splits: SplitDto[] | null;
  tagIds: string[];
  suggestion: SuggestionDto | null;
  error: { code: string; message: string } | null;
  postedAt: string | null;
  postedBy: string | null;
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
  tagIds: string[];
  autoPost: boolean;
  createdAt: string;
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
  intuitClientId: string; // masked when read
  intuitClientSecretSet: boolean;
  redirectUri: string;
  webhookVerifierTokenSet: boolean;
  suggestionSource: SuggestionSetting;
  aiEndpoint: string | null;
  aiKeySet: boolean;
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
}

export interface ApiError {
  error: string;
  code?: string;
}
