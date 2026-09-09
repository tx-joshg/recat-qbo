import {
  ClassificationSearchError,
  searchClassificationMemoryWithRuntimeSnapshot,
  type ClassificationSearchContextFilter,
  type ClassificationSearchInput,
  type ClassificationSearchSnapshot,
} from './classification/search.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { categorizationSourceGrossCents } from './tax/sourceGross.js';
import { CategorizationError } from './categorizationError.js';
import type {
  ClassificationCase,
  ClassificationSearchHit,
  ClassificationSearchMode,
  ClassificationSearchResult,
  ClassificationSearchScope,
  ClassificationActionSummary,
  ClassificationCasePastDecision,
  ClassificationPastDecisionPageDto,
  HistoricalObservationPastDecision,
  PastDecisionFilter,
  CanonicalSuggestionDto,
  CompanyDto,
  ProviderActionabilityDisposition,
  ProviderActionabilityDto,
  QboAccountDto,
  Role,
  RuleAffectedTransactionFilter,
  RuleAffectedTransactionPageDto,
  RuleCurrentRevisionReadDto,
  RuleDetailDto,
  RuleDirection,
  RuleLifecycleFilter,
  RuleLifecyclePageDto,
  RuleRuntimeMode,
  RuleRevision,
  RuleRevisionReadDto,
  TagDto,
  TaxCodeDto,
  TaxReadinessDto,
  TaxSupportStatus,
  TransactionDto,
  TxnStatus,
} from '@recat/shared';
import {
  isUsableSalesTaxCodeDto,
  isUsableTaxCodeDto,
  parseCanonicalSuggestionDto,
} from '@recat/shared';
import { env } from '../env.js';
import { HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { suggestForMany as defaultSuggestForMany } from './suggestions.js';
import {
  getTaxReadiness as defaultGetTaxReadiness,
  getTaxReadinessInTransaction as defaultGetTaxReadinessInTransaction,
  type TaxReadinessQueryDb,
} from './tax/reference.js';
import { transferCandidates as defaultTransferCandidates } from './transferCandidates.js';
import {
  PROVIDER_ACTIONABILITY_DISPOSITIONS,
  actionabilityObservationFromRow,
  effectiveProviderActionabilityCounts,
  effectiveProviderDisposition,
  providerActionabilityDto,
} from './providerActionability.js';
import {
  parseClassificationCase,
  parseRuleRevision,
} from './classification/contracts.js';
import { actionTagIdsReason, parseActionTagIds } from './classification/actionTagIds.js';
import { classificationReferenceReasons } from './classification/referenceReadiness.js';
import { compareRuleWinner, ruleMatches } from './ruleMatching.js';

export const DEFAULT_READ_LIMIT = 20;
export const MAX_READ_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_SEARCH_LENGTH = 200;
const MAX_CLASSIFICATION_QUERY_LENGTH = 256;
const MAX_ACCOUNT_LENGTH = 120;
const MAX_ID_LENGTH = 128;
const MAX_CANDIDATE_EVIDENCE = 20;
const MAX_RULE_CONFLICTS = 20;
const ROLE_RANK: Record<Role, number> = { viewer: 0, categorizer: 1, admin: 2 };
const VIEWER_HIDDEN_STATUSES = new Set<TxnStatus>(['PENDING', 'POSTING', 'ERROR']);
const TXN_STATUSES: readonly TxnStatus[] = [
  'PENDING',
  'POSTING',
  'POSTED',
  'DRY_RUN',
  'ERROR',
  'SUPERSEDED',
  'REVERTED',
];
const QUEUE_STATUSES = ['PENDING', 'ERROR'] as const;
const RULE_LIFECYCLE_FILTERS = new Set<RuleLifecycleFilter>([
  'enabled', 'disabled', 'all',
]);

type DbMethod = (args: Record<string, unknown>) => Promise<unknown>;

export interface CompanyReadDb {
  user: { findUnique: DbMethod; findMany?: DbMethod };
  membership: { findUnique: DbMethod; findMany?: DbMethod };
  company: { findUnique: DbMethod; findMany: DbMethod };
  transaction: { findUnique: DbMethod; findMany: DbMethod; count: DbMethod };
  /** Optional only for legacy unit-test adapters. Production applies the
   * additive migration before starting the application process. */
  transactionActionability?: { findMany?: DbMethod; count?: DbMethod };
  qboAccount: { findMany: DbMethod };
  qboTaxCode: { findMany: DbMethod };
  tag: { findMany: DbMethod };
  rule: { findMany: DbMethod; findFirst?: DbMethod };
  ruleRevision?: { findFirst: DbMethod; findMany?: DbMethod };
  autopilotRuleCandidate?: { findMany: DbMethod; findFirst: DbMethod };
  autopilotRuleCandidateEvidence?: { findMany: DbMethod };
  classificationCase?: { findFirst: DbMethod };
  historicalClassificationObservation?: { findFirst: DbMethod };
  classificationCorpusRevision?: { findFirst: DbMethod };
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $transaction<T>(
    callback: (tx: CompanyReadDb) => Promise<T>,
    options?: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface RuleLifecycleListInput extends PageInput {
  state?: RuleLifecycleFilter;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TransactionListInput extends PageInput {
  status?: TxnStatus;
  /** Provider disposition filter; omitted means the actionable queue view. */
  providerDisposition?: ProviderActionabilityDisposition;
  search?: string;
  account?: string;
  startDate?: string;
  endDate?: string;
}

export type VerificationReadStatus = 'verified' | 'dry-run' | 'failed' | 'uncertain' | 'unknown';
export type VerificationReadOutcome = 'VERIFIED' | 'DRY_RUN' | 'RETRYABLE' | 'UNCERTAIN' | 'UNCHANGED' | 'REJECTED';

export interface VerificationReadSummary {
  status: VerificationReadStatus;
  outcome: VerificationReadOutcome | null;
  summary: string;
}

export interface CompanyReadTransactionDto extends TransactionDto {
  verification: VerificationReadSummary;
}

export interface TransactionPage extends Page<CompanyReadTransactionDto> {
  pendingCount: number;
  /** Counts are additive and only returned when the actionability index exists. */
  actionableCount?: number;
  blockedCount?: number;
  unknownCount?: number;
}

export interface CompanyReadDto extends CompanyDto {
  role: Role;
}

export interface TaxCodePage extends Page<TaxCodeDto> {
  direction: RuleDirection;
  status: TaxSupportStatus;
  reason: string | null;
  usingSalesTax: boolean | null;
  refreshedAt: string | null;
}

export interface TransferCandidateDto {
  a: TransactionDto;
  b: TransactionDto;
}

export interface ClassificationSearchPage extends Page<ClassificationSearchHit> {
  query: string;
  companyId: string;
  scope: ClassificationSearchScope;
  mode: ClassificationSearchResult['mode'];
  requestedMode: ClassificationSearchMode;
  degraded: boolean;
  degradedReason: ClassificationSearchResult['degradedReason'];
  status: ClassificationSearchResult['status'];
  noMatch: boolean;
  total: number;
}

export type CompanyRuleRevisionReadDto = RuleRevisionReadDto;
export type CompanyRuleReadDto = RuleDetailDto;

export interface RuleCandidateReadDto {
  id: string;
  companyId: string;
  state: 'gathering' | 'ready' | 'conflict' | 'stale' | 'dismissed' | 'activated';
  matchField: 'payee';
  matchText: string;
  categoryName: string | null;
  taxCodeName: string | null;
  action: {
    categoryQboId: string;
    taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
    taxCodeQboId: string | null;
    tagIds: string[];
  } | null;
  invalidReasons: string[];
  executable: false;
  advisory: true;
  evidenceCount: number;
  conflictingEvidenceCount: number;
  schemaVersion: string;
  configVersion: string;
  activatedRuleId: string | null;
  updatedAt: string;
  evidence?: RuleCandidateEvidenceReadDto[];
}

export interface RuleCandidateEvidenceReadDto {
  id: string;
  transactionId: string;
  source: 'user' | 'autopilot' | 'mcp';
  polarity: 'positive' | 'negative';
  active: boolean;
  observedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface RuleTestReadDto {
  samples: Array<{
    transactionId: string;
    payee: string;
    date: string;
    amount: number;
    status: 'PENDING' | 'POSTED' | 'DRY_RUN';
    wouldWin: boolean;
    currentWinner: string | null;
  }>;
  nextCursor: string | null;
  pendingCount: number;
  processedCount: number;
  conflicts: Array<{
    ruleId: string;
    matchText: string;
    category: string;
    priority: number;
  }>;
  conflictsTruncated: boolean;
}

interface CursorPayload {
  v: 1;
  resource: string;
  userId: string;
  companyId: string | null;
  filter: string;
  position: Record<string, string | number>;
}

type Row = Record<string, unknown>;

export interface CompanyReadDeps {
  getTaxReadiness(companyId: string): Promise<TaxReadinessDto>;
  suggestForMany(
    companyId: string,
    txns: { payee: string; memo?: string | null; amount: number; qboType?: string }[],
  ): Promise<(CanonicalSuggestionDto | null)[]>;
  transferCandidates(companyId: string): Promise<Map<string, string>>;
  classificationSearch(input: ClassificationSearchInput): Promise<ClassificationSearchSnapshot | ClassificationSearchResult>;
}

const defaultDeps: CompanyReadDeps = {
  classificationSearch: searchClassificationMemoryWithRuntimeSnapshot,
  getTaxReadiness: defaultGetTaxReadiness,
  suggestForMany: defaultSuggestForMany,
  transferCandidates: (companyId) =>
    defaultTransferCandidates(companyId, prisma),
};

const safeCompanySelect = {
  id: true,
  realmId: true,
  legalName: true,
  nickname: true,
  env: true,
  syncMode: true,
  pollIntervalMin: true,
  holdingAccountIds: true,
  dryRun: true,
  tagsRequired: true,
  retainAttachmentFiles: true,
  connectedAt: true,
  disconnectedAt: true,
  lastSyncedAt: true,
} as const;

function badRequest(message: string, code = 'VALIDATION'): never {
  throw new HttpError(400, message, code);
}

function boundedId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH) {
    badRequest(`${label} must be between 1 and ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function readLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    badRequest(`limit must be an integer between 1 and ${MAX_READ_LIMIT}`);
  }
  return limit;
}

function optionalString(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) badRequest(`${label} must be at most ${max} characters`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function strictDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) badRequest(`${label} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    badRequest(`${label} must be a real calendar date`);
  }
  return value;
}

function dateStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateEndExclusive(value: string): Date {
  const date = dateStart(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function canonicalFilter(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFilter).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalFilter(item)}`).join(',')}}`;
}

function cursorMac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body, 'utf8').digest();
}

function encodeCursor(secret: string, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${cursorMac(secret, body).toString('base64url')}`;
}

function decodeCursor(
  secret: string,
  cursor: string | undefined,
  expected: Omit<CursorPayload, 'v' | 'position'>,
): Record<string, string | number> | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
    badRequest('Invalid cursor', 'INVALID_CURSOR');
  }
  const parts = cursor.split('.');
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) badRequest('Invalid cursor', 'INVALID_CURSOR');
  let actual: Buffer;
  let payload: CursorPayload;
  try {
    actual = Buffer.from(signature, 'base64url');
    const decodedBody = Buffer.from(body, 'base64url');
    if (
      actual.toString('base64url') !== signature
      || decodedBody.toString('base64url') !== body
    ) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const expectedMac = cursorMac(secret, body);
    if (actual.length !== expectedMac.length || !timingSafeEqual(actual, expectedMac)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    payload = JSON.parse(decodedBody.toString('utf8')) as CursorPayload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    badRequest('Invalid cursor', 'INVALID_CURSOR');
  }
  if (
    payload.v !== 1 ||
    payload.resource !== expected.resource ||
    payload.userId !== expected.userId ||
    payload.companyId !== expected.companyId ||
    payload.filter !== expected.filter ||
    payload.position === null ||
    typeof payload.position !== 'object' ||
    Array.isArray(payload.position)
  ) {
    badRequest('Cursor does not match this request', 'INVALID_CURSOR');
  }
  return payload.position;
}

function pageRows<T extends Row>(
  rows: T[],
  limit: number,
  makeCursor: (row: T) => string,
): { rows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return { rows: kept, nextCursor: hasMore && last ? makeCursor(last) : null };
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function iso(value: unknown): string {
  return asDate(value).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function pastDecisionActionSummary(row: Row): ClassificationActionSummary {
  const taxCalculation = row.taxCalculation;
  if (taxCalculation !== 'TaxInclusive' && taxCalculation !== 'TaxExcluded' && taxCalculation !== 'NotApplicable') {
    throw new HttpError(503, 'Past-decision data is unavailable', 'COMPANY_UNAVAILABLE');
  }
  const categoryName = typeof row.categoryName === 'string' && row.categoryName.trim() !== ''
    ? row.categoryName
    : 'Category unavailable';
  const taxCodeName = nullableString(row.taxCodeName);
  if ((taxCalculation === 'NotApplicable') !== (taxCodeName === null)) {
    throw new HttpError(503, 'Past-decision data is unavailable', 'COMPANY_UNAVAILABLE');
  }
  return { categoryName, taxCalculation, taxCodeName, tagNames: stringArray(row.tagNames) };
}

function observationPastDecision(row: Row): HistoricalObservationPastDecision {
  const qboType = row.qboType;
  if (qboType !== 'Purchase' && qboType !== 'Deposit' && qboType !== 'JournalEntry') {
    throw new HttpError(503, 'Historical observation is unavailable', 'COMPANY_UNAVAILABLE');
  }
  return {
    kind: 'historical_observation',
    id: String(row.id), companyId: String(row.companyId), transactionId: String(row.transactionId),
    qboType, qboId: String(row.qboId), payee: String(row.payee), memo: nullableString(row.memo),
    actionSummary: pastDecisionActionSummary(row), sourceStatus: nullableString(row.sourceStatus),
    observedRecatRevision: Number(row.observedRecatRevision), observedQboRevision: String(row.observedQboRevision),
    observedAt: iso(row.observedAt), supersededByCaseId: nullableString(row.supersededByCaseId),
    advisory: true, executable: false,
  };
}

function casePastDecision(row: Row): ClassificationCasePastDecision {
  return {
    kind: 'classification_case',
    id: String(row.id), companyId: String(row.companyId), transactionId: String(row.transactionId),
    payee: String(row.payee), memo: nullableString(row.memo), actionSummary: pastDecisionActionSummary(row),
    rationale: String(row.rationale), verifiedAt: iso(row.verifiedAt),
    invalidatedAt: nullableIso(row.invalidatedAt), invalidationReason: nullableString(row.invalidationReason),
    advisory: false, executable: false,
  };
}

async function latestClassificationCorpusRevision(
  tx: Pick<CompanyReadDb, 'classificationCorpusRevision'>,
  companyId: string,
): Promise<string> {
  if (tx.classificationCorpusRevision === undefined) {
    throw new HttpError(503, 'Classification corpus is unavailable', 'COMPANY_UNAVAILABLE');
  }
  const row = await tx.classificationCorpusRevision.findFirst({
    where: { companyId }, orderBy: { revision: 'desc' }, select: { revision: true },
  }) as Row | null;
  return row === null ? '0' : String(row.revision);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function companyDto(row: Row, role: Role): CompanyReadDto {
  const poll = Number(row.pollIntervalMin);
  return {
    id: String(row.id),
    realmId: String(row.realmId),
    legalName: String(row.legalName),
    nickname: String(row.nickname),
    env: row.env === 'production' ? 'production' : 'sandbox',
    syncMode: row.syncMode === 'webhook' ? 'webhook' : 'polling',
    pollIntervalMin: poll === 5 || poll === 30 || poll === 60 ? poll : 10,
    holdingAccountIds: stringArray(row.holdingAccountIds),
    dryRun: row.dryRun === true,
    tagsRequired: row.tagsRequired === true,
    retainAttachmentFiles: row.retainAttachmentFiles !== false,
    connectedAt: iso(row.connectedAt),
    disconnectedAt: nullableIso(row.disconnectedAt),
    lastSyncedAt: nullableIso(row.lastSyncedAt),
    role,
  };
}

function suggestionDto(value: unknown, allowRule: boolean): CanonicalSuggestionDto | null {
  try {
    const parsed = parseCanonicalSuggestionDto(value);
    // Persisted rule snapshots must be re-derived from live rule state on every
    // read. History and AI category hints remain safe advisory snapshots.
    return parsed.source === 'rule' && !allowRule ? null : parsed;
  } catch {
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasProviderActionability(db: CompanyReadDb): boolean {
  return db.transactionActionability !== undefined;
}

function rowActionabilityIdentity(row: Row) {
  return {
    id: String(row.id ?? ''),
    companyId: String(row.companyId ?? ''),
    revision: Number(row.revision),
    qboSyncToken: String(row.qboSyncToken ?? ''),
    qboType: String(row.qboType ?? ''),
    qboId: String(row.qboId ?? ''),
    date: row.date instanceof Date ? row.date : String(row.date ?? ''),
  };
}

function rowProviderDisposition(
  row: Row,
  supportsActionability: boolean,
  now = new Date(),
): ProviderActionabilityDisposition | null {
  // Legacy test stores may omit the index; production never does because the
  // container applies migrations before loading application code.
  if (!supportsActionability) return null;
  const observation = actionabilityObservationFromRow(row.providerActionability);
  if (observation === null) return 'UNKNOWN';
  return effectiveProviderDisposition(observation, rowActionabilityIdentity(row), now);
}

function rowProviderActionabilityDto(
  row: Row,
  supportsActionability: boolean,
): ProviderActionabilityDto | null | undefined {
  if (!supportsActionability && !Object.prototype.hasOwnProperty.call(row, 'providerActionability')) {
    return undefined;
  }
  const observation = actionabilityObservationFromRow(row.providerActionability);
  if (observation === null) return null;
  const dto = providerActionabilityDto(observation);
  if (dto === null) return null;
  // A stale cached WRITABLE row must never look actionable to the client.  The
  // evidence fields remain useful for diagnostics, while the disposition is
  // reduced to UNKNOWN until a bounded refresh checks it again.
  const disposition = effectiveProviderDisposition(
    observation,
    rowActionabilityIdentity(row),
  );
  return disposition === dto.disposition ? dto : { ...dto, disposition };
}

function filterRowsForProviderQueue(
  rows: Row[],
  dtos: TransactionDto[],
  supportsActionability: boolean,
  requested: ProviderActionabilityDisposition | undefined,
  role: Role,
): TransactionDto[] {
  if (!supportsActionability) return dtos;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return dtos.filter((dto) => {
    const row = byId.get(dto.id);
    if (!row) return false;
    const disposition = rowProviderDisposition(row, true);
    if (requested !== undefined) return disposition === requested;
    if (role === 'viewer' || !QUEUE_STATUSES.includes(row.status as (typeof QUEUE_STATUSES)[number])) {
      return true;
    }
    // The interactive queue is the complete pending-work surface. Cached
    // actionability is advisory metadata; commits still obtain fresh safety.
    return true;
  });
}

function provenSourceGross(row: Row, holdingAccountIds: unknown): number | undefined {
  try {
    return categorizationSourceGrossCents({
      amount: String(row.amount), qboId: String(row.qboId),
      qboType: String(row.qboType), rawData: row.rawData,
    }, holdingAccountIds);
  } catch (error) {
    if (error instanceof CategorizationError) return undefined;
    throw error;
  }
}

function transactionDto(
  row: Row,
  posterLabel: Map<string, string>,
  liveSuggestion: CanonicalSuggestionDto | null,
  transferCandidateId: string | null,
  supportsActionability = false,
  holdingAccountIds: unknown = [],
): TransactionDto {
  const splitLines = Array.isArray(row.splitLines) ? (row.splitLines as Row[]) : [];
  const attempts = Array.isArray(row.qboMutationAttempts) ? (row.qboMutationAttempts as Row[]) : [];
  const attempt = attempts[0];
  const operation = attempt?.operation;
  const attemptStatus = attempt?.status;
  const actionability = rowProviderActionabilityDto(row, supportsActionability);
  const providerWritable = !supportsActionability || actionability?.disposition === 'WRITABLE';
  const activeCategorizationAttempt: TransactionDto['activeCategorizationAttempt'] =
    attempt &&
    typeof attempt.requestId === 'string' &&
    UUID_PATTERN.test(attempt.requestId) &&
    (operation === 'recategorize' || operation === 'restore') &&
    (
      attemptStatus === 'PREPARED'
      || attemptStatus === 'RETRYABLE'
      || attemptStatus === 'COMMITTING'
      || attemptStatus === 'UNCERTAIN'
    )
      ? {
          requestId: attempt.requestId,
          operation: operation as 'recategorize' | 'restore',
          status: attemptStatus as 'PREPARED' | 'RETRYABLE' | 'COMMITTING' | 'UNCERTAIN',
        }
      : null;
  const posterId = typeof row.postedByUserId === 'string' ? row.postedByUserId : null;
  const sourceGrossCents = provenSourceGross(row, holdingAccountIds);
  return {
    id: String(row.id),
    companyId: String(row.companyId),
    qboId: String(row.qboId),
    qboType:
      row.qboType === 'Deposit' || row.qboType === 'JournalEntry' ? row.qboType : 'Purchase',
    date: iso(row.date),
    payee: String(row.payee),
    memo: typeof row.memo === 'string' ? row.memo : null,
    amount: Number(row.amount),
    ...(sourceGrossCents === undefined ? {} : { sourceGrossCents }),
    bankAccount: String(row.bankAccount),
    status: TXN_STATUSES.includes(row.status as TxnStatus) ? row.status as TxnStatus : 'PENDING',
    revision: Number(row.revision),
    category: typeof row.category === 'string' ? row.category : null,
    categoryQboId: typeof row.categoryQboId === 'string' ? row.categoryQboId : null,
    taxCalculation:
      row.taxCalculation === 'TaxInclusive' ||
      row.taxCalculation === 'TaxExcluded' ||
      row.taxCalculation === 'NotApplicable'
        ? row.taxCalculation
        : null,
    taxCode: typeof row.taxCode === 'string' ? row.taxCode : null,
    taxCodeQboId: typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null,
    splits:
      splitLines.length === 0
        ? null
        : splitLines.map((line) => ({
            amount: Number(line.amount),
            category: String(line.category),
            ...(typeof line.categoryQboId === 'string' ? { categoryQboId: line.categoryQboId } : {}),
            taxCode: typeof line.taxCode === 'string' ? line.taxCode : null,
            taxCodeQboId: typeof line.taxCodeQboId === 'string' ? line.taxCodeQboId : null,
            tagIds: Array.isArray(line.tags)
              ? (line.tags as Row[]).map((tag) => String(tag.tagId))
              : [],
            ...(typeof line.memo === 'string' ? { memo: line.memo } : {}),
          })),
    tagIds: Array.isArray(row.txnTags) ? (row.txnTags as Row[]).map((tag) => String(tag.tagId)) : [],
    suggestion:
      row.status === 'PENDING' && providerWritable
        ? (suggestionDto(liveSuggestion, true) ?? suggestionDto(row.suggestion, false))
        : null,
    error:
      row.status === 'ERROR' && (typeof row.errorCode === 'string' || typeof row.errorMessage === 'string')
        ? {
            code: typeof row.errorCode === 'string' ? row.errorCode : 'QBO_ERROR',
            message: typeof row.errorMessage === 'string' ? row.errorMessage : 'Unknown error',
          }
        : null,
    postedAt: nullableIso(row.postedAt),
    postedBy: posterId === null ? null : posterLabel.get(posterId) ?? null,
    activeCategorizationAttempt,
    ...(actionability !== undefined
      ? { providerActionability: actionability }
      : {}),
    transferCandidateId: providerWritable ? transferCandidateId : null,
  };
}

export const transactionReadInclude = {
  txnTags: { select: { tagId: true } },
  splitLines: {
    include: { tags: { select: { tagId: true } } },
    orderBy: { idx: 'asc' },
  },
  qboMutationAttempts: {
    // Project the newest attempt first, including terminal successors. Filtering
    // before ordering would let an older RETRYABLE attempt resurface forever
    // after a later retry completed successfully.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { requestId: true, operation: true, status: true },
  },
  providerActionability: true,
} as const satisfies Prisma.TransactionInclude;

export type TransactionReadRow = Prisma.TransactionGetPayload<{
  include: typeof transactionReadInclude;
}>;

export const companyReadTransactionInclude = {
  txnTags: { select: { tagId: true } },
  splitLines: {
    include: { tags: { select: { tagId: true } } },
    orderBy: { idx: 'asc' },
  },
  qboMutationAttempts: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { status: true, verification: true },
  },
  providerActionability: true,
} as const satisfies Prisma.TransactionInclude;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS_WORDS: Record<TxnStatus, string> = {
  PENDING: 'pending',
  POSTING: 'posting',
  POSTED: 'posted',
  DRY_RUN: 'dry run',
  ERROR: 'error failed',
  SUPERSEDED: 'superseded',
  REVERTED: 'reverted',
};

export function sortTransactionRows<T extends {
  date: Date;
  qboId: string;
  id: string;
}>(rows: T[]): T[] {
  return rows.sort((first, second) => {
    const date = first.date.getTime() - second.date.getTime();
    if (date !== 0) return date;
    const firstQbo = Number(first.qboId);
    const secondQbo = Number(second.qboId);
    if (Number.isFinite(firstQbo) && Number.isFinite(secondQbo) && firstQbo !== secondQbo) {
      return firstQbo - secondQbo;
    }
    return first.qboId.localeCompare(second.qboId) || first.id.localeCompare(second.id);
  });
}

function formatQueueDate(isoDate: string): string {
  const date = new Date(isoDate);
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}`;
}

function transactionHaystack(dto: TransactionDto, fullNameOf: Map<string, string>): string {
  const absolute = Math.abs(dto.amount).toFixed(2);
  return [
    dto.payee,
    dto.memo ?? '',
    dto.bankAccount,
    formatQueueDate(dto.date),
    dto.category ?? '',
    dto.category !== null ? (fullNameOf.get(dto.category) ?? '') : '',
    ...(dto.splits ?? []).flatMap((split) => [split.category, fullNameOf.get(split.category) ?? '']),
    dto.suggestion?.source === 'rule'
      ? dto.suggestion.action.category
      : dto.suggestion?.category ?? '',
    dto.suggestion !== null
      ? (fullNameOf.get(
          dto.suggestion.source === 'rule'
            ? dto.suggestion.action.category
            : dto.suggestion.category,
        ) ?? '')
      : '',
    STATUS_WORDS[dto.status],
    absolute,
    `$${absolute}`,
    `${dto.amount < 0 ? '-' : '+'}$${absolute}`,
  ].join(' ').toLowerCase();
}

export function filterTransactionDtos(
  dtos: TransactionDto[],
  input: Pick<TransactionListInput, 'status' | 'account' | 'search' | 'providerDisposition'>,
  fullNameOf: Map<string, string> = new Map(),
): TransactionDto[] {
  let filtered = dtos;
  if (input.status !== undefined) filtered = filtered.filter((dto) => dto.status === input.status);
  if (input.providerDisposition !== undefined) {
    filtered = filtered.filter((dto) => {
      const raw = dto.providerActionability?.disposition ?? 'UNKNOWN';
      return raw === input.providerDisposition;
    });
  }
  if (input.account !== undefined && input.account !== '' && input.account !== 'all') {
    filtered = filtered.filter((dto) => dto.bankAccount === input.account);
  }
  if (input.search !== undefined && input.search.trim() !== '') {
    const tokens = input.search.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    filtered = filtered.filter((dto) => {
      const haystack = transactionHaystack(dto, fullNameOf);
      return tokens.every((token) => haystack.includes(token));
    });
  }
  return filtered;
}

async function posterLabels(db: CompanyReadDb, rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.postedByUserId).filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0 || !db.user.findMany) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  }) as Row[];
  return new Map(users.map((user) => [
    String(user.id),
    typeof user.name === 'string'
      ? user.name
      : String(user.email).split('@')[0] ?? String(user.email),
  ]));
}

async function transactionDtosWithDeps(
  db: CompanyReadDb,
  deps: CompanyReadDeps,
  companyId: string,
  rows: Row[],
  candidatesIn?: Map<string, string>,
): Promise<TransactionDto[]> {
  const [labels, candidates, company] = await Promise.all([
    posterLabels(db, rows),
    candidatesIn ? Promise.resolve(candidatesIn) : deps.transferCandidates(companyId),
    db.company.findUnique({ where: { id: companyId }, select: { holdingAccountIds: true } }),
  ]);
  const supportsActionability = hasProviderActionability(db);
  const pendingRows = rows.filter((row) => {
    if (row.status !== 'PENDING') return false;
    const disposition = rowProviderDisposition(row, supportsActionability);
    return disposition === null || disposition === 'WRITABLE';
  });
  const liveSuggestions = await deps.suggestForMany(
    companyId,
    pendingRows.map((row) => ({
      payee: String(row.payee),
      memo: typeof row.memo === 'string' ? row.memo : null,
      amount: Number(row.amount),
      qboType: String(row.qboType),
    })),
  );
  const liveById = new Map(
    pendingRows.map((row, index) => [String(row.id), liveSuggestions[index] ?? null]),
  );
  return rows.map((row) => transactionDto(
    row,
    labels,
    liveById.get(String(row.id)) ?? null,
    candidates.get(String(row.id)) ?? null,
    supportsActionability,
    (company as Row | null)?.holdingAccountIds,
  ));
}

export async function transactionDtos(
  companyId: string,
  rows: Row[],
  candidatesIn?: Map<string, string>,
): Promise<TransactionDto[]> {
  return transactionDtosWithDeps(
    prisma as unknown as CompanyReadDb,
    defaultDeps,
    companyId,
    rows,
    candidatesIn,
  );
}

function verificationSummary(attempt: Row | undefined): VerificationReadSummary {
  const verification = attempt?.verification;
  const rawOutcome =
    verification !== null && typeof verification === 'object' && !Array.isArray(verification)
      ? (verification as Row).outcome
      : undefined;
  const candidate = typeof rawOutcome === 'string' ? rawOutcome : attempt?.status;
  switch (candidate) {
    case 'VERIFIED':
      return { status: 'verified', outcome: 'VERIFIED', summary: 'QuickBooks write verified.' };
    case 'UNCHANGED':
      return { status: 'verified', outcome: 'UNCHANGED', summary: 'No QuickBooks change was needed.' };
    case 'DRY_RUN':
      return { status: 'dry-run', outcome: 'DRY_RUN', summary: 'Dry run only; nothing was sent.' };
    case 'RETRYABLE':
      return { status: 'failed', outcome: 'RETRYABLE', summary: 'Write did not complete.' };
    case 'REJECTED':
      return { status: 'failed', outcome: 'REJECTED', summary: 'QuickBooks rejected the prepared write.' };
    case 'UNCERTAIN':
      return { status: 'uncertain', outcome: 'UNCERTAIN', summary: 'QuickBooks write could not be verified.' };
    default:
      return { status: 'unknown', outcome: null, summary: 'Verification status is unavailable.' };
  }
}

async function enrichTransactionReads(
  rows: Row[],
  dtos: TransactionDto[],
): Promise<CompanyReadTransactionDto[]> {
  if (dtos.length === 0) return [];
  const latest = new Map(rows.map((row) => {
    const attempts = Array.isArray(row.qboMutationAttempts) ? row.qboMutationAttempts as Row[] : [];
    return [String(row.id), attempts[0]] as const;
  }));
  return dtos.map((dto) => ({
    ...dto,
    verification: verificationSummary(latest.get(dto.id)),
  }));
}

function categoryDto(row: Row): QboAccountDto {
  return {
    id: String(row.id),
    qboId: String(row.qboId),
    name: String(row.name),
    fullName: String(row.fullName),
    classification: String(row.classification),
    active: row.active === true,
  };
}

function taxCodeDto(row: Row): TaxCodeDto {
  return {
    qboId: String(row.qboId),
    name: String(row.name),
    active: row.active === true,
    taxable: typeof row.taxable === 'boolean' ? row.taxable : null,
    combinedPurchaseRate:
      row.combinedPurchaseRate === null || row.combinedPurchaseRate === undefined
        ? null
        : Number(row.combinedPurchaseRate),
    combinedSalesRate:
      row.combinedSalesRate === null || row.combinedSalesRate === undefined
        ? null
        : Number(row.combinedSalesRate),
  };
}

export function eligibleTaxCodes(readiness: TaxReadinessDto): TaxCodeDto[] {
  return readiness.taxCodes.filter(isUsableTaxCodeDto);
}

function ruleReferenceReasons(
  rule: {
    direction: RuleDirection | null;
    categoryQboId: string | null;
    taxCalculation: unknown;
    taxCodeQboId: string | null;
    tagIds: readonly string[];
  },
  accountClassifications: ReadonlyMap<string, string>,
  existingTags: ReadonlySet<string>,
  readiness: TaxReadinessDto | null,
): string[] {
  const direction = rule.direction;
  const eligibleCodes = new Set(readiness === null || direction === null
    ? []
    : (direction === 'Purchase'
        ? eligibleTaxCodes(readiness)
        : readiness.salesTaxCodes.filter(isUsableSalesTaxCodeDto))
      .map((code) => code.qboId));
  const classification = rule.categoryQboId === null
    ? undefined
    : accountClassifications.get(rule.categoryQboId);
  const categoryActive = direction === 'Purchase'
    ? classification === 'Expenses' || classification === 'COGS'
    : direction === 'Deposit'
      ? classification === 'Income'
      : false;
  return classificationReferenceReasons(rule, {
    categoryActive,
    taxReady: direction === 'Purchase'
      ? readiness?.status === 'ready'
      : direction === 'Deposit'
        ? readiness?.salesStatus === 'ready'
        : false,
    taxCodeEligible: rule.taxCodeQboId !== null && eligibleCodes.has(rule.taxCodeQboId),
    tagsExist: rule.tagIds.every((tagId) => existingTags.has(tagId)),
  });
}

function ruleDetailDto(
  rule: Row,
  revisionRow: Row,
  accountClassifications: ReadonlyMap<string, string>,
  existingTags: ReadonlySet<string>,
  readiness: TaxReadinessDto | null,
): CompanyRuleReadDto {
  const rawCalculation = revisionRow.taxCalculation;
  const rawCategoryQboId = typeof revisionRow.categoryQboId === 'string'
    ? revisionRow.categoryQboId
    : null;
  const rawTaxCodeQboId = typeof revisionRow.taxCodeQboId === 'string'
    ? revisionRow.taxCodeQboId
    : null;
  const parsedTagIds = parseActionTagIds(revisionRow.tagIds);
  const tagIds = parsedTagIds ?? [];
  const direction = revisionRow.direction === 'Purchase' || revisionRow.direction === 'Deposit'
    ? revisionRow.direction
    : null;
  const structurallyValidAction = direction !== null && parsedTagIds !== null && rawCategoryQboId !== null
    && (rawCalculation === 'TaxInclusive'
      || rawCalculation === 'TaxExcluded'
      || rawCalculation === 'NotApplicable')
    && ((rawCalculation === 'NotApplicable') === (rawTaxCodeQboId === null));
  const parsedRevision = parseRuleRevision({
    id: String(revisionRow.id),
    ruleId: String(revisionRow.ruleId),
    companyId: String(revisionRow.companyId),
    revision: Number(revisionRow.revision),
    state: revisionRow.state,
    condition: { matchField: 'payee', matchText: revisionRow.matchText },
    direction,
    action: structurallyValidAction ? {
      categoryQboId: rawCategoryQboId,
      taxCalculation: rawCalculation,
      taxCodeQboId: rawTaxCodeQboId,
      tagIds,
    } : null,
    categoryName: revisionRow.category,
    taxCodeName: revisionRow.taxCode ?? null,
    priority: Number(revisionRow.priority),
    autoPost: revisionRow.autoPost === true,
    originIntent: revisionRow.originIntent ?? null,
    sourceCaseId: revisionRow.sourceCaseId ?? null,
    sourceCandidateId: revisionRow.sourceCandidateId ?? null,
    changedBy: revisionRow.changedBy ?? null,
    createdAt: iso(revisionRow.createdAt),
    retiredAt: nullableIso(revisionRow.retiredAt),
    canonicalVersion: typeof revisionRow.canonicalVersion === 'number'
      ? revisionRow.canonicalVersion
      : null,
    repairReason: typeof revisionRow.repairReason === 'string' ? revisionRow.repairReason : null,
    affectedJournalEntryCount: typeof revisionRow.affectedJournalEntryCount === 'number'
      ? revisionRow.affectedJournalEntryCount
      : null,
  });
  const invalidReasons = ruleReferenceReasons({
    direction,
    categoryQboId: rawCategoryQboId,
    taxCalculation: rawCalculation,
    taxCodeQboId: rawTaxCodeQboId,
    tagIds,
  }, accountClassifications, existingTags, readiness);
  if (parsedTagIds === null) invalidReasons.unshift('Action tag IDs are invalid.');
  invalidReasons.splice(4);
  const valid = structurallyValidAction && invalidReasons.length === 0;
  const state = rule.enabled === true && rule.retiredAt == null ? 'enabled' : 'disabled';
  const revision: RuleCurrentRevisionReadDto = {
    id: parsedRevision.id,
    ruleId: parsedRevision.ruleId,
    companyId: parsedRevision.companyId,
    revision: parsedRevision.revision,
    state,
    condition: parsedRevision.condition,
    direction,
    action: valid && parsedRevision.action !== null && direction !== null ? {
      version: 2,
      direction,
      category: parsedRevision.categoryName,
      ...parsedRevision.action,
    } : null,
    taxCodeName: parsedRevision.taxCodeName,
    autoPost: state === 'enabled' ? parsedRevision.autoPost : false,
    originIntent: parsedRevision.originIntent,
    sourceCaseId: parsedRevision.sourceCaseId,
    sourceCandidateId: parsedRevision.sourceCandidateId,
    changedBy: parsedRevision.changedBy,
    createdAt: parsedRevision.createdAt,
    repairReason: typeof rule.repairReason === 'string'
      ? rule.repairReason
      : parsedRevision.repairReason,
    affectedJournalEntryCount: parsedRevision.affectedJournalEntryCount,
    valid,
    invalidReasons,
  };
  const reviewRequiredAt = nullableIso(rule.reviewRequiredAt);
  return {
    state,
    reviewRequiredAt,
    reviewReason: typeof rule.reviewReason === 'string'
      ? rule.reviewReason
      : rule.retiredAt != null ? 'This rule requires review before reactivation.' : null,
    repairReason: revision.repairReason,
    revision,
  };
}

async function ruleLifecycleFingerprint(
  db: CompanyReadDb,
  companyId: string,
): Promise<string> {
  const rows = await db.$queryRaw<Array<{ revision: bigint }>>(Prisma.sql`
    SELECT "revision"
      FROM "RuleLifecycleRevision"
     WHERE "companyId" = ${companyId}
  `);
  const revision = rows[0]?.revision;
  if (typeof revision !== 'bigint') {
    throw new HttpError(503, 'Rule lifecycle is unavailable', 'COMPANY_UNAVAILABLE');
  }
  return `rule-lifecycle-fence-v1:${revision}`;
}

export function boundedTaxReadiness(
  readiness: TaxReadinessDto,
  limit = MAX_READ_LIMIT,
): TaxReadinessDto {
  return {
    ...readiness,
    taxCodes: eligibleTaxCodes(readiness).slice(0, limit),
    salesTaxCodes: readiness.salesTaxCodes
      .filter(isUsableSalesTaxCodeDto)
      .slice(0, limit),
  };
}

function tagDto(row: Row): TagDto {
  const count = row._count as Row | undefined;
  return {
    id: String(row.id),
    companyId: String(row.companyId),
    name: String(row.name),
    color: String(row.color),
    usageCount: Number(count?.txnTags ?? 0),
  };
}

export function createCompanyReadService(
  db: CompanyReadDb,
  cursorSecret: string,
  depsIn: Partial<CompanyReadDeps> = {},
) {
  if (cursorSecret.length < 16) throw new Error('Company read cursor secret must be at least 16 characters');
  const usesDefaultDb = db === (prisma as unknown as CompanyReadDb);
  const deps: CompanyReadDeps = {
    getTaxReadiness:
      depsIn.getTaxReadiness ??
      (usesDefaultDb
        ? defaultGetTaxReadiness
        : async (companyId) => {
            const rows = await db.qboTaxCode.findMany({ where: { companyId }, orderBy: { qboId: 'asc' } }) as Row[];
            return {
              status: 'needs_setup',
              reason: null,
              usingSalesTax: null,
              refreshedAt: null,
              taxCodes: rows.map(taxCodeDto).filter(isUsableTaxCodeDto),
              salesStatus: 'needs_setup',
              salesReason: null,
              salesTaxCodes: rows.map(taxCodeDto).filter(isUsableSalesTaxCodeDto),
            };
          }),
    suggestForMany:
      depsIn.suggestForMany ??
      (usesDefaultDb
        ? defaultSuggestForMany
        : async (_companyId, txns) => txns.map(() => null)),
    transferCandidates:
      depsIn.transferCandidates ??
      ((companyId) =>
        defaultTransferCandidates(companyId, db as never)),
    classificationSearch: depsIn.classificationSearch ?? searchClassificationMemoryWithRuntimeSnapshot,
  };

  async function currentUser(userId: string): Promise<Row> {
    boundedId(userId, 'userId');
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, isInstanceAdmin: true },
    }) as Row | null;
    if (!user) throw new HttpError(401, 'User no longer exists', 'UNAUTHENTICATED');
    return user;
  }

  async function authorizeCompany(
    userId: string,
    companyId: string,
    minimum: Role,
  ): Promise<{ company: Row; role: Role }> {
    boundedId(companyId, 'companyId');
    const user = await currentUser(userId);
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: safeCompanySelect,
    }) as Row | null;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    if (user.isInstanceAdmin === true) return { company, role: 'admin' };
    const membership = await db.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    }) as { role: Role } | null;
    if (!membership) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) {
      throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
    }
    return { company, role: membership.role };
  }

  async function actualMembershipCompanyIds(userId: string): Promise<string[]> {
    if (db.membership.findMany === undefined) {
      throw new HttpError(503, 'Company memberships are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const rows = await db.membership.findMany({
      where: { userId },
      select: { companyId: true },
      orderBy: { companyId: 'asc' },
      take: 101,
    }) as Row[];
    if (rows.length > 100) {
      throw new HttpError(400, 'Too many accessible companies', 'VALIDATION');
    }
    return [...new Set(rows.map((row) => String(row.companyId)))].sort();
  }

  async function runClassificationSearch<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ClassificationSearchError)) throw error;
      if (error.code === 'SEMANTIC_UNAVAILABLE') {
        throw new HttpError(503, 'Semantic classification search is unavailable.', 'SEMANTIC_UNAVAILABLE');
      }
      if (error.code === 'COMPANY_UNAVAILABLE') {
        throw new HttpError(503, 'Classification search is temporarily unavailable.', 'COMPANY_UNAVAILABLE');
      }
      if (error.code === 'FORBIDDEN') {
        throw new HttpError(403, 'Classification company access is forbidden.', 'FORBIDDEN');
      }
      throw new HttpError(400, 'Classification search input is invalid.', 'VALIDATION');
    }
  }

  async function searchClassificationKnowledgeForUser(
    userId: string,
    companyId: string,
    input: {
      query: string;
      scope?: ClassificationSearchScope;
      mode: ClassificationSearchMode;
      limit?: number;
      cursor?: string;
      transactionId?: string;
    },
  ): Promise<ClassificationSearchPage> {
    await authorizeCompany(userId, companyId, 'viewer');
    const query = optionalString(input.query, 'query', MAX_CLASSIFICATION_QUERY_LENGTH);
    if (query === undefined) badRequest('query must not be empty');
    const scope = input.scope ?? 'current_company';
    if (scope !== 'current_company' && scope !== 'accessible_companies') {
      badRequest('Invalid classification search scope');
    }
    if (!['auto', 'exact', 'lexical', 'hybrid', 'semantic'].includes(input.mode)) {
      badRequest('Invalid classification search mode');
    }
    const requestedLimit = readLimit(input.limit);
    const membershipIds = scope === 'accessible_companies'
      ? await actualMembershipCompanyIds(userId)
      : [companyId];
    if (!membershipIds.includes(companyId)) {
      throw new HttpError(403, 'Current company is not an actual membership', 'FORBIDDEN');
    }
    let context: ClassificationSearchContextFilter | undefined;
    let transactionRevision: number | undefined;
    if (input.transactionId !== undefined) {
      boundedId(input.transactionId, 'transactionId');
      const transaction = await db.transaction.findUnique({
        where: { id: input.transactionId },
        select: {
          id: true, companyId: true, revision: true, qboType: true, date: true,
          amount: true, bankAccount: true, rawData: true,
        },
      }) as Row | null;
      if (transaction === null || transaction.companyId !== companyId) {
        throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
      }
      const amount = Number(transaction.amount);
      const rawData = transaction.rawData !== null && typeof transaction.rawData === 'object'
        && !Array.isArray(transaction.rawData) ? transaction.rawData as Row : {};
      const currencyRef = rawData.CurrencyRef !== null && typeof rawData.CurrencyRef === 'object'
        && !Array.isArray(rawData.CurrencyRef) ? rawData.CurrencyRef as Row : {};
      const qboType = transaction.qboType === 'Purchase' || transaction.qboType === 'Deposit'
        || transaction.qboType === 'JournalEntry' ? transaction.qboType : undefined;
      context = {
        ...(Number.isFinite(amount) && amount !== 0
          ? { transactionDirection: amount < 0 ? 'out' as const : 'in' as const }
          : {}),
        ...(qboType === undefined ? {} : { qboType }),
        ...(typeof transaction.bankAccount === 'string' && transaction.bankAccount.trim() !== ''
          ? { sourceAccountName: transaction.bankAccount } : {}),
        ...(typeof currencyRef.value === 'string' ? { currency: currencyRef.value } : {}),
        transactionPeriod: iso(transaction.date).slice(0, 7),
      };
      transactionRevision = Number(transaction.revision);
    }
    const filter = canonicalFilter({
      query, scope, mode: input.mode, limit: requestedLimit,
      accessibleCompanyIds: [...membershipIds].sort(),
      transactionId: input.transactionId ?? null,
      transactionRevision: transactionRevision ?? null,
      context: context ?? null,
    });
    const expected = { resource: 'classification-search', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const offset = position === null ? 0 : Number(position.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const searched = await runClassificationSearch(() => deps.classificationSearch({
      query,
      companyId,
      scope,
      mode: input.mode,
      limit: MAX_READ_LIMIT,
      accessibleCompanyIds: membershipIds,
      context,
      ...(input.transactionId === undefined ? {} : { excludeTransactionId: input.transactionId }),
    }));
    const canonical = 'result' in searched ? searched.result : searched;
    const fingerprint = 'result' in searched
      ? searched.fingerprint
      : createHmac('sha256', cursorSecret).update(JSON.stringify(canonical)).digest('hex');
    if (position !== null && position.fingerprint !== fingerprint) {
      badRequest('Search population changed; restart pagination', 'INVALID_CURSOR');
    }
    const items = canonical.hits.slice(offset, offset + requestedLimit);
    const nextOffset = offset + items.length;
    return {
      query: canonical.query,
      companyId: canonical.companyId,
      scope: canonical.scope,
      mode: canonical.mode,
      requestedMode: canonical.requestedMode,
      degraded: canonical.degraded,
      degradedReason: canonical.degradedReason,
      status: canonical.status,
      noMatch: canonical.noMatch,
      total: Math.min(canonical.total, canonical.hits.length),
      items,
      nextCursor: nextOffset < canonical.hits.length
        ? encodeCursor(cursorSecret, {
            v: 1, ...expected, position: { offset: nextOffset, fingerprint },
          })
        : null,
    };
  }

  async function getRuleForCompany(
    companyId: string,
    ruleId: string,
  ): Promise<CompanyRuleReadDto> {
    if (db.rule.findFirst === undefined || db.ruleRevision === undefined) {
      throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
    }
    const rule = await db.rule.findFirst({
      where: { id: ruleId, companyId },
      select: {
        id: true, companyId: true, revision: true, enabled: true, retiredAt: true,
        reviewRequiredAt: true, reviewReason: true, repairReason: true,
      },
    }) as Row | null;
    if (rule === null) throw new HttpError(404, 'Rule not found', 'RULE_NOT_FOUND');
    const revisionRow = await db.ruleRevision.findFirst({
      where: { companyId, ruleId, revision: Number(rule.revision) },
    }) as Row | null;
    if (revisionRow === null) {
      throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
    }
    const rawCategoryQboId = typeof revisionRow.categoryQboId === 'string'
      ? revisionRow.categoryQboId
      : null;
    const parsedTagIds = parseActionTagIds(revisionRow.tagIds);
    const tagIds = parsedTagIds ?? [];
    const [accounts, tags, readiness] = await Promise.all([
      rawCategoryQboId === null
        ? Promise.resolve([])
        : db.qboAccount.findMany({
            where: { companyId, qboId: { in: [rawCategoryQboId] } },
            select: { qboId: true, active: true, classification: true },
          }) as Promise<Row[]>,
      tagIds.length === 0
        ? Promise.resolve([])
        : db.tag.findMany({
            where: { companyId, id: { in: tagIds } },
            select: { id: true },
          }) as Promise<Row[]>,
      revisionRow.taxCalculation === 'TaxInclusive' || revisionRow.taxCalculation === 'TaxExcluded'
        ? deps.getTaxReadiness(companyId)
        : Promise.resolve(null),
    ]);
    const accountClassifications = new Map(accounts
      .filter((account) => account.active === true)
      .map((account) => [String(account.qboId), String(account.classification)]));
    const existingTags = new Set(tags.map((tag) => String(tag.id)));
    return ruleDetailDto(rule, revisionRow, accountClassifications, existingTags, readiness);
  }

  async function getRuleForUser(
    userId: string,
    companyId: string,
    ruleId: string,
  ): Promise<CompanyRuleReadDto> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(ruleId, 'ruleId');
    return getRuleForCompany(companyId, ruleId);
  }

  async function listRuleRevisionsForUser(
    userId: string,
    companyId: string,
    ruleId: string,
    input: PageInput = {},
  ): Promise<Page<CompanyRuleRevisionReadDto>> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(ruleId, 'ruleId');
    if (db.rule.findFirst === undefined || db.ruleRevision?.findMany === undefined) {
      throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
    }
    const exists = await db.rule.findFirst({ where: { id: ruleId, companyId }, select: { id: true } }) as Row | null;
    if (exists === null) throw new HttpError(404, 'Rule not found', 'RULE_NOT_FOUND');
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({ ruleId });
    const expected = { resource: 'rule-revisions', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const before = position === null ? undefined : Number(position.revision);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const rows = await db.ruleRevision.findMany({
      where: { companyId, ruleId, ...(before === undefined ? {} : { revision: { lt: before } }) },
      orderBy: [{ revision: 'desc' }, { id: 'desc' }], take: limit + 1,
    }) as Row[];
    const page = pageRows(rows, limit, (row) => encodeCursor(cursorSecret, {
      v: 1, ...expected, position: { revision: Number(row.revision) },
    }));
    return {
      items: page.rows.map((row) => {
        const tags = parseActionTagIds(row.tagIds);
        const calculation = row.taxCalculation;
        const category = typeof row.categoryQboId === 'string' ? row.categoryQboId : null;
        const taxCode = typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null;
        const valid = tags !== null && category !== null
          && (calculation === 'TaxInclusive' || calculation === 'TaxExcluded' || calculation === 'NotApplicable')
          && ((calculation === 'NotApplicable') === (taxCode === null));
        const parsed = parseRuleRevision({
          id: String(row.id), ruleId: String(row.ruleId), companyId: String(row.companyId),
          revision: Number(row.revision), state: row.state,
          condition: { matchField: 'payee', matchText: row.matchText },
          direction: row.direction === 'Purchase' || row.direction === 'Deposit' ? row.direction : null,
          action: valid ? { categoryQboId: category!, taxCalculation: calculation, taxCodeQboId: taxCode, tagIds: tags! }
            : null,
          categoryName: row.category, taxCodeName: row.taxCode ?? null,
          priority: Number(row.priority), autoPost: row.autoPost === true,
          originIntent: row.originIntent ?? null, sourceCaseId: row.sourceCaseId ?? null,
          sourceCandidateId: row.sourceCandidateId ?? null, changedBy: row.changedBy ?? null,
          createdAt: iso(row.createdAt), retiredAt: nullableIso(row.retiredAt),
          canonicalVersion: typeof row.canonicalVersion === 'number' ? row.canonicalVersion : null,
          repairReason: typeof row.repairReason === 'string' ? row.repairReason : null,
          affectedJournalEntryCount: typeof row.affectedJournalEntryCount === 'number'
            ? row.affectedJournalEntryCount
            : null,
        });
        return { ...parsed, action: valid ? parsed.action : null, valid, invalidReasons: valid ? [] : ['Stored legacy action is non-executable.'] };
      }),
      nextCursor: page.nextCursor,
    };
  }

  async function hydrateRuleDetails(
    tx: CompanyReadDb,
    companyId: string,
    ruleRows: Row[],
  ): Promise<CompanyRuleReadDto[]> {
    if (ruleRows.length === 0) return [];
    if (tx.ruleRevision?.findMany === undefined) {
      throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
    }
    const revisionRows = await tx.ruleRevision.findMany({
      where: {
        companyId,
        OR: ruleRows.map((rule) => ({
          ruleId: String(rule.id),
          revision: Number(rule.revision),
        })),
      },
    }) as Row[];
    const revisionsByRule = new Map(revisionRows.map((revision) => [
      `${String(revision.ruleId)}:${Number(revision.revision)}`,
      revision,
    ]));
    const orderedRevisions = ruleRows.map((rule) => {
      const revision = revisionsByRule.get(`${String(rule.id)}:${Number(rule.revision)}`);
      if (revision === undefined) {
        throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
      }
      return revision;
    });
    const categoryQboIds = [...new Set(orderedRevisions.flatMap((revision) => (
      typeof revision.categoryQboId === 'string' ? [revision.categoryQboId] : []
    )))];
    const tagIds = [...new Set(orderedRevisions.flatMap((revision) => (
      parseActionTagIds(revision.tagIds) ?? []
    )))];
    const requiresTaxReadiness = orderedRevisions.some((revision) => (
      revision.taxCalculation === 'TaxInclusive' || revision.taxCalculation === 'TaxExcluded'
    ));
    const [accounts, tags, readiness] = await Promise.all([
      categoryQboIds.length === 0
        ? Promise.resolve([])
        : tx.qboAccount.findMany({
            where: { companyId, qboId: { in: categoryQboIds } },
            select: { qboId: true, active: true, classification: true },
          }) as Promise<Row[]>,
      tagIds.length === 0
        ? Promise.resolve([])
        : tx.tag.findMany({
            where: { companyId, id: { in: tagIds } },
            select: { id: true },
          }) as Promise<Row[]>,
      requiresTaxReadiness
        ? (depsIn.getTaxReadiness === undefined
            ? defaultGetTaxReadinessInTransaction(
                companyId,
                tx as unknown as TaxReadinessQueryDb,
              )
            : depsIn.getTaxReadiness(companyId))
        : Promise.resolve(null),
    ]);
    const accountClassifications = new Map(accounts
      .filter((account) => account.active === true)
      .map((account) => [String(account.qboId), String(account.classification)]));
    const existingTags = new Set(tags.map((tag) => String(tag.id)));
    return ruleRows.map((rule, index) => ruleDetailDto(
      rule,
      orderedRevisions[index]!,
      accountClassifications,
      existingTags,
      readiness,
    ));
  }

  async function listRuleLifecycleForUser(
    userId: string,
    companyId: string,
    input: RuleLifecycleListInput = {},
  ): Promise<RuleLifecyclePageDto> {
    await authorizeCompany(userId, companyId, 'categorizer');
    const limit = readLimit(input.limit);
    const requestedState = input.state ?? 'all';
    if (!RULE_LIFECYCLE_FILTERS.has(requestedState)) {
      badRequest('Invalid rule lifecycle state', 'BAD_REQUEST');
    }
    const state: RuleLifecycleFilter = requestedState;
    const filter = canonicalFilter({ state, limit });
    const expected = { resource: 'rule-lifecycle', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const cursorPriority = position?.priority;
    const cursorCreatedAt = position?.createdAt;
    const cursorId = position?.id;
    const cursorFingerprint = position?.fingerprint;
    if (position && (
      typeof cursorPriority !== 'number'
      || !Number.isInteger(cursorPriority)
      || typeof cursorCreatedAt !== 'string'
      || Number.isNaN(new Date(cursorCreatedAt).getTime())
      || typeof cursorId !== 'string'
      || typeof cursorFingerprint !== 'string'
    )) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const lifecycleWhere = state === 'enabled'
      ? { enabled: true, retiredAt: null }
      : state === 'disabled'
        ? { OR: [{ enabled: false }, { retiredAt: { not: null } }] }
        : {};
    return db.$transaction(async (tx) => {
      const fingerprint = await ruleLifecycleFingerprint(tx, companyId);
      if (position && cursorFingerprint !== fingerprint) {
        badRequest('Rule lifecycle changed; restart pagination', 'INVALID_CURSOR');
      }
      const cursorWhere = position
        ? {
            OR: [
              { priority: { gt: cursorPriority } },
              { priority: cursorPriority, createdAt: { lt: new Date(cursorCreatedAt as string) } },
              { priority: cursorPriority, createdAt: new Date(cursorCreatedAt as string), id: { gt: cursorId } },
            ],
          }
        : {};
      const rows = await tx.rule.findMany({
        where: { companyId, ...lifecycleWhere, ...cursorWhere },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        select: {
          id: true, companyId: true, revision: true, enabled: true, retiredAt: true,
          priority: true, createdAt: true, reviewRequiredAt: true, reviewReason: true,
          repairReason: true,
        },
      }) as Row[];
      const page = pageRows(rows, limit, (row) => encodeCursor(cursorSecret, {
        v: 1,
        ...expected,
        position: {
          priority: Number(row.priority),
          createdAt: iso(row.createdAt),
          id: String(row.id),
          fingerprint,
        },
      }));
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { ruleRuntimeMode: true } }) as { ruleRuntimeMode?: unknown } | null;
      if (!company) throw new HttpError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
      if (!['legacy', 'bridge', 'paused', 'canonical'].includes(String(company.ruleRuntimeMode))) {
        throw new HttpError(503, 'Rule runtime is unavailable', 'COMPANY_UNAVAILABLE');
      }
      return {
        runtimeMode: company.ruleRuntimeMode as RuleRuntimeMode,
        items: await hydrateRuleDetails(tx, companyId, page.rows),
        nextCursor: page.nextCursor,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  function candidateState(value: unknown): RuleCandidateReadDto['state'] {
    if (
      value === 'gathering'
      || value === 'ready'
      || value === 'conflict'
      || value === 'stale'
      || value === 'dismissed'
      || value === 'activated'
    ) return value;
    throw new HttpError(503, 'Rule candidate has an invalid state', 'COMPANY_UNAVAILABLE');
  }

  async function candidateDtos(companyId: string, rows: Row[]): Promise<RuleCandidateReadDto[]> {
    const accountIds = [...new Set(rows.flatMap((row) => (
      typeof row.categoryQboId === 'string' ? [row.categoryQboId] : []
    )))];
    const taxIds = [...new Set(rows.flatMap((row) => (
      typeof row.taxCodeQboId === 'string' ? [row.taxCodeQboId] : []
    )))];
    const [accounts, taxes] = await Promise.all([
      accountIds.length === 0 ? Promise.resolve([]) : db.qboAccount.findMany({
        where: { companyId, qboId: { in: accountIds }, active: true },
        select: { qboId: true, name: true },
      }) as Promise<Row[]>,
      taxIds.length === 0 ? Promise.resolve([]) : db.qboTaxCode.findMany({
        where: { companyId, qboId: { in: taxIds }, active: true },
        select: { qboId: true, name: true },
      }) as Promise<Row[]>,
    ]);
    const accountNames = new Map(accounts.map((row) => [String(row.qboId), String(row.name)]));
    const taxNames = new Map(taxes.map((row) => [String(row.qboId), String(row.name)]));
    return rows.map((row) => {
      const calculation = row.taxCalculation;
      const categoryQboId = typeof row.categoryQboId === 'string' ? row.categoryQboId : null;
      const taxCodeQboId = typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null;
      const tagIds = parseActionTagIds(row.tagIds);
      const invalidReasons = actionTagIdsReason(row.tagIds) === null
        ? [] : [actionTagIdsReason(row.tagIds)!];
      const validAction = categoryQboId !== null
        && tagIds !== null
        && (calculation === 'TaxInclusive' || calculation === 'TaxExcluded' || calculation === 'NotApplicable')
        && ((calculation === 'NotApplicable') === (taxCodeQboId === null));
      return {
        id: String(row.id),
        companyId: String(row.companyId),
        state: candidateState(row.state),
        matchField: 'payee',
        matchText: String(row.matchText),
        categoryName: categoryQboId === null ? null : accountNames.get(categoryQboId) ?? null,
        taxCodeName: taxCodeQboId === null ? null : taxNames.get(taxCodeQboId) ?? null,
        action: validAction ? {
          categoryQboId,
          taxCalculation: calculation,
          taxCodeQboId,
          tagIds,
        } : null,
        invalidReasons,
        executable: false,
        advisory: true,
        evidenceCount: Math.max(0, Number(row.evidenceCount) || 0),
        conflictingEvidenceCount: Math.max(0, Number(row.conflictingEvidenceCount) || 0),
        schemaVersion: String(row.schemaVersion),
        configVersion: String(row.configVersion),
        activatedRuleId: typeof row.activatedRuleId === 'string' ? row.activatedRuleId : null,
        updatedAt: iso(row.updatedAt),
      };
    });
  }

  async function listRuleCandidatesForUser(
    userId: string,
    companyId: string,
    input: PageInput = {},
  ): Promise<Page<RuleCandidateReadDto>> {
    await authorizeCompany(userId, companyId, 'categorizer');
    if (db.autopilotRuleCandidate === undefined) {
      throw new HttpError(503, 'Rule candidates are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const requestedLimit = readLimit(input.limit);
    const expected = { resource: 'rule-candidates', userId, companyId, filter: canonicalFilter({}) };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const updatedAt = typeof position?.updatedAt === 'string' ? new Date(position.updatedAt) : null;
    const id = typeof position?.id === 'string' ? position.id : null;
    if (position && (!updatedAt || Number.isNaN(updatedAt.getTime()) || !id)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const rows = await db.autopilotRuleCandidate.findMany({
      where: {
        companyId,
        state: { in: ['gathering', 'ready', 'conflict', 'dismissed', 'activated', 'stale'] },
        ...(updatedAt && id ? {
          OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: id } }],
        } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: requestedLimit + 1,
    }) as Row[];
    const page = pageRows(rows, requestedLimit, (row) => encodeCursor(cursorSecret, {
      v: 1,
      ...expected,
      position: { updatedAt: iso(row.updatedAt), id: String(row.id) },
    }));
    return { items: await candidateDtos(companyId, page.rows), nextCursor: page.nextCursor };
  }

  async function getRuleCandidateForUser(
    userId: string,
    companyId: string,
    candidateId: string,
  ): Promise<RuleCandidateReadDto> {
    await authorizeCompany(userId, companyId, 'categorizer');
    boundedId(candidateId, 'candidateId');
    if (db.autopilotRuleCandidate === undefined || db.autopilotRuleCandidateEvidence === undefined) {
      throw new HttpError(503, 'Rule candidates are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const row = await db.autopilotRuleCandidate.findFirst({ where: { id: candidateId, companyId } }) as Row | null;
    if (row === null) throw new HttpError(404, 'Rule candidate not found', 'CANDIDATE_NOT_FOUND');
    const [candidate] = await candidateDtos(companyId, [row]);
    if (candidate === undefined) throw new HttpError(503, 'Rule candidate is unavailable', 'COMPANY_UNAVAILABLE');
    const evidenceRows = await db.autopilotRuleCandidateEvidence.findMany({
      where: { companyId, candidateId },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: MAX_CANDIDATE_EVIDENCE,
      select: {
        id: true, transactionId: true, source: true, polarity: true, active: true,
        observedAt: true, invalidatedAt: true, invalidationReason: true,
      },
    }) as Row[];
    return {
      ...candidate,
      evidence: evidenceRows.map((evidence) => ({
        id: String(evidence.id),
        transactionId: String(evidence.transactionId),
        source: evidence.source === 'autopilot' || evidence.source === 'mcp' ? evidence.source : 'user',
        polarity: evidence.polarity === 'negative' ? 'negative' : 'positive',
        active: evidence.active === true,
        observedAt: iso(evidence.observedAt),
        invalidatedAt: nullableIso(evidence.invalidatedAt),
        invalidationReason: typeof evidence.invalidationReason === 'string' ? evidence.invalidationReason : null,
      })),
    };
  }

  async function getClassificationCaseForUser(
    userId: string,
    companyId: string,
    caseId: string,
  ): Promise<ClassificationCase> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(caseId, 'caseId');
    if (db.classificationCase === undefined) {
      throw new HttpError(503, 'Classification cases are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const row = await db.classificationCase.findFirst({
      where: { id: caseId, companyId },
      include: { invalidation: true },
    }) as Row | null;
    if (row === null) throw new HttpError(404, 'Classification case not found', 'CASE_NOT_FOUND');
    const invalidation = row.invalidation !== null && typeof row.invalidation === 'object'
      ? row.invalidation as Row
      : null;
    return parseClassificationCase({
      id: row.id,
      companyId: row.companyId,
      transactionId: row.transactionId,
      vendorIdentityId: row.vendorIdentityId ?? null,
      qboMutationAttemptId: row.qboMutationAttemptId,
      action: row.action,
      actionFingerprint: row.actionFingerprint,
      originIntent: row.originIntent,
      rationale: row.rationale,
      requiredEvidence: Array.isArray(row.requiredEvidence) ? row.requiredEvidence.slice(0, 20) : [],
      examples: Array.isArray(row.examples) ? row.examples.slice(0, 20) : [],
      counterexamples: Array.isArray(row.counterexamples) ? row.counterexamples.slice(0, 20) : [],
      citations: Array.isArray(row.citations) ? row.citations.slice(0, 10) : [],
      reviewer: row.reviewer,
      jurisdiction: row.jurisdiction,
      currency: row.currency,
      context: row.context,
      provenance: row.provenance,
      verifiedAt: iso(row.verifiedAt),
      invalidatedAt: invalidation === null ? null : iso(invalidation.invalidatedAt),
      invalidationReason: invalidation === null ? null : invalidation.reason,
    });
  }

  async function listPastDecisionsForUser(
    userId: string,
    companyId: string,
    input: { kind?: PastDecisionFilter; limit?: number; cursor?: string } = {},
  ): Promise<ClassificationPastDecisionPageDto> {
    await authorizeCompany(userId, companyId, 'viewer');
    const kind = input.kind ?? 'all';
    if (kind !== 'all' && kind !== 'classification_case' && kind !== 'historical_observation') {
      badRequest('Invalid past-decision kind');
    }
    const requestedLimit = readLimit(input.limit);
    const filter = canonicalFilter({ kind, limit: requestedLimit });
    const expected = { resource: 'classification-past-decisions', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const decisionAt = position === null ? null : new Date(String(position.decisionAt));
    const positionKind = position === null ? null : position.kind;
    const positionId = position === null ? null : position.id;
    const cursorRevision = position === null ? null : position.revision;
    if (position !== null && (
      decisionAt === null || Number.isNaN(decisionAt.getTime())
      || (positionKind !== 'classification_case' && positionKind !== 'historical_observation')
      || typeof positionId !== 'string'
      || typeof cursorRevision !== 'string'
    )) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }

    return db.$transaction(async (tx) => {
      const revision = await latestClassificationCorpusRevision(tx, companyId);
      if (cursorRevision !== null && cursorRevision !== revision) {
        badRequest('Past-decision population changed; restart pagination', 'INVALID_CURSOR');
      }
      // Bound each indexed source before projecting display fields or merging the feed.
      const branchCursor = (dateColumn: Prisma.Sql, branchKind: PastDecisionFilter) => decisionAt === null
        ? Prisma.empty
        : Prisma.sql`AND (${dateColumn} < ${decisionAt} OR (${dateColumn} = ${decisionAt}
          AND (${branchKind} > ${positionKind as string}
            OR (${branchKind} = ${positionKind as string} AND "id" > ${positionId as string}))))`;
      const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
        WITH case_page AS (
          SELECT * FROM "ClassificationCase"
          WHERE "companyId" = ${companyId} AND ${kind !== 'historical_observation'}
            ${branchCursor(Prisma.sql`"verifiedAt"`, 'classification_case')}
          ORDER BY "verifiedAt" DESC, "id" ASC
          LIMIT ${requestedLimit + 1}
        ), observation_page AS (
          SELECT * FROM "HistoricalClassificationObservation"
          WHERE "companyId" = ${companyId} AND ${kind !== 'classification_case'}
            ${branchCursor(Prisma.sql`"observedAt"`, 'historical_observation')}
          ORDER BY "observedAt" DESC, "id" ASC
          LIMIT ${requestedLimit + 1}
        ), decisions AS (
          SELECT
            'classification_case'::text AS "kind",
            classification_case."id"::text AS "id",
            classification_case."companyId"::text AS "companyId",
            classification_case."transactionId"::text AS "transactionId",
            COALESCE(classification_case."transactionSnapshot"->>'payee', 'Payee unavailable')::text AS "payee",
            (classification_case."transactionSnapshot"->>'memo')::text AS "memo",
            classification_case."rationale"::text AS "rationale",
            classification_case."verifiedAt" AS "verifiedAt",
            classification_case."verifiedAt" AS "decisionAt",
            invalidation."invalidatedAt" AS "invalidatedAt",
            invalidation."reason"::text AS "invalidationReason",
            COALESCE(account."name", 'Category unavailable')::text AS "categoryName",
            COALESCE(classification_case."action"->>'taxCalculation', 'NotApplicable')::text AS "taxCalculation",
            CASE WHEN classification_case."action"->>'taxCalculation' = 'NotApplicable' THEN NULL
              ELSE COALESCE(tax_code."name", 'Tax code unavailable') END::text AS "taxCodeName",
            COALESCE((
              SELECT jsonb_agg(tag."name" ORDER BY tag."name")
              FROM "Tag" tag
              WHERE tag."companyId" = classification_case."companyId"
                AND tag."id" IN (
                  SELECT jsonb_array_elements_text(COALESCE(classification_case."action"->'tagIds', '[]'::jsonb))
                )
            ), '[]'::jsonb) AS "tagNames",
            NULL::text AS "qboType", NULL::text AS "qboId", NULL::text AS "sourceStatus",
            NULL::integer AS "observedRecatRevision", NULL::text AS "observedQboRevision",
            NULL::timestamptz AS "observedAt", NULL::text AS "supersededByCaseId"
          FROM case_page classification_case
          LEFT JOIN "ClassificationCaseInvalidation" invalidation
            ON invalidation."companyId" = classification_case."companyId"
            AND invalidation."classificationCaseId" = classification_case."id"
          LEFT JOIN "QboAccount" account
            ON account."companyId" = classification_case."companyId"
            AND account."qboId" = classification_case."action"->>'categoryQboId'
          LEFT JOIN "QboTaxCode" tax_code
            ON tax_code."companyId" = classification_case."companyId"
            AND tax_code."qboId" = classification_case."action"->>'taxCodeQboId'
          WHERE classification_case."companyId" = ${companyId}
            AND ${kind !== 'historical_observation'}

          UNION ALL

          SELECT
            'historical_observation'::text AS "kind",
            observation."id"::text AS "id",
            observation."companyId"::text AS "companyId",
            observation."sourceTransactionId"::text AS "transactionId",
            observation."payee"::text AS "payee",
            observation."memo"::text AS "memo",
            NULL::text AS "rationale", NULL::timestamptz AS "verifiedAt",
            observation."observedAt" AS "decisionAt", NULL::timestamptz AS "invalidatedAt",
            NULL::text AS "invalidationReason", observation."categoryName"::text AS "categoryName",
            observation."taxCalculation"::text AS "taxCalculation", observation."taxCodeName"::text AS "taxCodeName",
            CASE WHEN jsonb_typeof(observation."tagNames") = 'array' THEN observation."tagNames" ELSE '[]'::jsonb END AS "tagNames",
            observation."sourceQboType"::text AS "qboType", observation."sourceQboId"::text AS "qboId",
            observation."sourceStatus"::text AS "sourceStatus",
            observation."sourceTransactionRevision"::integer AS "observedRecatRevision",
            observation."sourceQboSyncToken"::text AS "observedQboRevision",
            observation."observedAt" AS "observedAt", superseding_case."id"::text AS "supersededByCaseId"
          FROM observation_page observation
          LEFT JOIN LATERAL (
            SELECT classification_case."id"
            FROM "ClassificationCase" classification_case
            LEFT JOIN "ClassificationCaseInvalidation" invalidation
              ON invalidation."companyId" = classification_case."companyId"
              AND invalidation."classificationCaseId" = classification_case."id"
            WHERE classification_case."companyId" = observation."companyId"
              AND classification_case."transactionId" = observation."sourceTransactionId"
              AND invalidation."id" IS NULL
            ORDER BY classification_case."verifiedAt" DESC, classification_case."id" ASC
            LIMIT 1
          ) superseding_case ON true
          WHERE observation."companyId" = ${companyId}
            AND ${kind !== 'classification_case'}
        )
        SELECT * FROM decisions
        ORDER BY "decisionAt" DESC, "kind" ASC, "id" ASC
        LIMIT ${requestedLimit + 1}
      `);
      const page = pageRows(rows, requestedLimit, (row) => encodeCursor(cursorSecret, {
        v: 1, ...expected, position: {
          decisionAt: iso(row.decisionAt), kind: String(row.kind), id: String(row.id), revision,
        },
      }));
      return {
        items: page.rows.map((row) => row.kind === 'classification_case'
          ? casePastDecision(row)
          : observationPastDecision(row)),
        nextCursor: page.nextCursor,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async function getHistoricalObservationForUser(
    userId: string,
    companyId: string,
    observationId: string,
  ): Promise<HistoricalObservationPastDecision> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(observationId, 'observationId');
    if (db.historicalClassificationObservation === undefined) {
      throw new HttpError(503, 'Historical observations are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const row = await db.historicalClassificationObservation.findFirst({
      where: { id: observationId, companyId },
      select: {
        id: true, companyId: true, sourceTransactionId: true, sourceQboType: true, sourceQboId: true,
        sourceTransactionRevision: true, sourceQboSyncToken: true, sourceStatus: true, observedAt: true,
        payee: true, memo: true, categoryName: true, taxCalculation: true, taxCodeName: true, tagNames: true,
      },
    }) as Row | null;
    if (row === null) throw new HttpError(404, 'Historical observation not found', 'OBSERVATION_NOT_FOUND');
    const superseding = db.classificationCase === undefined ? null : await db.classificationCase.findFirst({
      where: { companyId, transactionId: row.sourceTransactionId, invalidation: null },
      orderBy: [{ verifiedAt: 'desc' }, { id: 'asc' }], select: { id: true },
    }) as Row | null;
    return observationPastDecision({
      ...row,
      transactionId: row.sourceTransactionId, qboType: row.sourceQboType, qboId: row.sourceQboId,
      observedRecatRevision: row.sourceTransactionRevision, observedQboRevision: row.sourceQboSyncToken,
      supersededByCaseId: superseding?.id ?? null,
    });
  }

  async function getCurrentClassificationCaseForUser(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<ClassificationCase> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(transactionId, 'transactionId');
    if (db.classificationCase === undefined) {
      throw new HttpError(503, 'Classification cases are unavailable', 'COMPANY_UNAVAILABLE');
    }
    const row = await db.classificationCase.findFirst({
      where: {
        companyId, transactionId, invalidation: null,
        qboMutationAttempt: { status: 'VERIFIED' },
      },
      orderBy: [{ verifiedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    }) as Row | null;
    if (row === null) throw new HttpError(404, 'Classification case not found', 'CASE_NOT_FOUND');
    return getClassificationCaseForUser(userId, companyId, String(row.id));
  }

  async function listRuleAffectedTransactionsForUser(
    userId: string,
    companyId: string,
    ruleId: string,
    input: { status?: RuleAffectedTransactionFilter; limit?: number; cursor?: string } = {},
  ): Promise<RuleAffectedTransactionPageDto> {
    await authorizeCompany(userId, companyId, 'viewer');
    boundedId(ruleId, 'ruleId');
    const status = input.status ?? 'all';
    if (status !== 'all' && status !== 'pending' && status !== 'processed') {
      badRequest('Invalid affected transaction status');
    }
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({ ruleId, status, limit });
    const expected = { resource: 'rule-affected-transactions', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const cursorDate = typeof position?.date === 'string' ? new Date(position.date) : null;
    const cursorId = typeof position?.id === 'string' ? position.id : null;
    const cursorFingerprint = typeof position?.fingerprint === 'string' ? position.fingerprint : null;
    if (position && (!cursorDate || Number.isNaN(cursorDate.getTime()) || !cursorId || !cursorFingerprint)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }

    // This is intentionally the same current RuleRevision read that powers the
    // canonical rule detail. Disabled and retired rules remain browseable.
    const rule = await getRuleForCompany(companyId, ruleId);
    const matchText = rule.revision.condition.matchText.trim();
    if (matchText === '') throw new HttpError(503, 'Rule history is unavailable', 'COMPANY_UNAVAILABLE');
    const direction = rule.revision.direction;

    return db.$transaction(async (tx) => {
      const fingerprint = await ruleLifecycleFingerprint(tx, companyId);
      if (cursorFingerprint !== null && cursorFingerprint !== fingerprint) {
        badRequest('Affected transaction population changed; restart pagination', 'INVALID_CURSOR');
      }
      if (direction === null) {
        return {
          items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, processedCount: 0,
        };
      }
      const matchingSql = Prisma.sql`
        txn."companyId" = ${companyId}
        AND txn."status" IN ('PENDING', 'POSTED', 'DRY_RUN')
        AND txn."qboType" = ${direction}
        AND position(rule_match_key(${matchText}) IN rule_match_key(txn."payee")) > 0
      `;
      const statusSql = status === 'all'
        ? Prisma.empty
        : status === 'pending'
          ? Prisma.sql`AND txn."status" = 'PENDING'`
          : Prisma.sql`AND txn."status" IN ('POSTED', 'DRY_RUN')`;
      const cursorSql = cursorDate && cursorId
        ? Prisma.sql`AND (txn."date", txn."id") < (${cursorDate}, ${cursorId})`
        : Prisma.empty;
      const counts = await tx.$queryRaw<Array<{
        matchedCount: number;
        pendingCount: number;
        processedCount: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "matchedCount",
          COUNT(*) FILTER (WHERE txn."status" = 'PENDING')::int AS "pendingCount",
          COUNT(*) FILTER (WHERE txn."status" IN ('POSTED', 'DRY_RUN'))::int AS "processedCount"
        FROM "Transaction" txn
        WHERE ${matchingSql}
      `);
      const rows = await tx.$queryRaw<Array<Row & { winningRuleId: string | null }>>(Prisma.sql`
        SELECT txn."id", txn."qboType", txn."qboId",
          txn."date", txn."payee", txn."memo",
          txn."amount", txn."status",
          winner."id" AS "winningRuleId"
        FROM "Transaction" txn
        LEFT JOIN LATERAL (
          SELECT candidate."id"
          FROM "Rule" candidate
          WHERE candidate."companyId" = txn."companyId"
            AND candidate."enabled" = true
            AND candidate."retiredAt" IS NULL
            AND candidate."direction"::text = txn."qboType"
            AND rule_match_key(candidate."matchText") <> ''
            AND position(rule_match_key(candidate."matchText") IN rule_match_key(txn."payee")) > 0
          ORDER BY candidate."priority" ASC, candidate."createdAt" DESC, candidate."id" ASC
          LIMIT 1
        ) winner ON true
        WHERE ${matchingSql}
          ${statusSql}
          ${cursorSql}
        ORDER BY txn."date" DESC, txn."id" DESC
        LIMIT ${limit + 1}
      `);
      const page = pageRows(rows, limit, (row) => encodeCursor(cursorSecret, {
        v: 1,
        ...expected,
        position: { date: iso(row.date), id: String(row.id), fingerprint },
      }));
      return {
        items: page.rows.map((row) => {
          const qboType = row.qboType;
          if (qboType !== 'Purchase' && qboType !== 'Deposit' && qboType !== 'JournalEntry') {
            throw new HttpError(503, 'Affected transaction data is unavailable', 'COMPANY_UNAVAILABLE');
          }
          const rowStatus = row.status;
          if (rowStatus !== 'PENDING' && rowStatus !== 'POSTED' && rowStatus !== 'DRY_RUN') {
            throw new HttpError(503, 'Affected transaction data is unavailable', 'COMPANY_UNAVAILABLE');
          }
          const winningRuleId = typeof row.winningRuleId === 'string' ? row.winningRuleId : null;
          return {
            transactionId: String(row.id), qboType, qboId: String(row.qboId), date: iso(row.date),
            payee: String(row.payee), memo: row.memo == null ? null : String(row.memo),
            amountCents: Math.round(Number(row.amount) * 100), status: rowStatus,
            ruleWins: winningRuleId === ruleId, winningRuleId,
          };
        }),
        nextCursor: page.nextCursor,
        matchedCount: counts[0]?.matchedCount ?? 0,
        pendingCount: counts[0]?.pendingCount ?? 0,
        processedCount: counts[0]?.processedCount ?? 0,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async function testRuleForUser(
    userId: string,
    companyId: string,
    input: { matchText: string; direction: RuleDirection; limit?: number; cursor?: string },
  ): Promise<RuleTestReadDto> {
    await authorizeCompany(userId, companyId, 'categorizer');
    const matchText = optionalString(input.matchText, 'matchText', 200);
    if (matchText === undefined) badRequest('matchText must not be empty');
    const requestedLimit = readLimit(input.limit);
    const direction = input.direction;
    if (direction !== 'Purchase' && direction !== 'Deposit') badRequest('Invalid rule direction');
    const filter = canonicalFilter({ matchText, direction });
    const expected = { resource: 'rule-test', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const cursorDate = typeof position?.date === 'string' ? new Date(position.date) : null;
    const cursorId = typeof position?.id === 'string' ? position.id : null;
    if (position && (!cursorDate || Number.isNaN(cursorDate.getTime()) || !cursorId)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const [transactions, rules] = await Promise.all([
      db.$queryRaw<Row[]>(Prisma.sql`
        SELECT txn."id", txn."qboType", txn."payee", txn."date", txn."amount", txn."status"
        FROM "Transaction" txn
        WHERE txn."companyId" = ${companyId}
          AND txn."qboType" = ${direction}
          AND txn."status" IN ('PENDING', 'POSTED', 'DRY_RUN')
          AND position(rule_match_key(${matchText}) IN rule_match_key(txn."payee")) > 0
          ${cursorDate && cursorId
            ? Prisma.sql`AND (txn."date", txn."id") < (${cursorDate}, ${cursorId})`
            : Prisma.empty}
        ORDER BY txn."date" DESC, txn."id" DESC
        LIMIT ${requestedLimit + 1}
      `),
      db.rule.findMany({
        where: { companyId, enabled: true, retiredAt: null, direction },
        select: { id: true, matchText: true, category: true, priority: true, createdAt: true, direction: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: 201,
      }) as Promise<Row[]>,
    ]);
    if (rules.length > 200) {
      throw new HttpError(503, 'Rule test population is unavailable', 'COMPANY_UNAVAILABLE');
    }
    const page = pageRows(transactions, requestedLimit, (row) => encodeCursor(cursorSecret, {
      v: 1,
      ...expected,
      position: { date: iso(row.date), id: String(row.id) },
    }));
    const matchingRule = (transaction: Row) => rules
      .filter((rule) => ruleMatches(
        {
          matchText: String(rule.matchText),
          direction: rule.direction === 'Purchase' || rule.direction === 'Deposit'
            ? rule.direction
            : null,
        },
        { description: String(transaction.payee), type: String(transaction.qboType) },
      ))
      .sort((left, right) => compareRuleWinner(
        { id: String(left.id), priority: Number(left.priority), createdAt: left.createdAt as Date },
        { id: String(right.id), priority: Number(right.priority), createdAt: right.createdAt as Date },
      ))[0];
    const samples = page.rows.map((row) => {
      const winner = matchingRule(row);
      return {
        transactionId: String(row.id),
        payee: String(row.payee),
        date: iso(row.date),
        amount: Number(row.amount),
        status: (row.status === 'POSTED' || row.status === 'DRY_RUN' ? row.status : 'PENDING') as
          'PENDING' | 'POSTED' | 'DRY_RUN',
        wouldWin: winner === undefined,
        currentWinner: winner === undefined ? null : String(winner.matchText),
      };
    });
    const allConflicts = rules.filter((rule) => page.rows.some((transaction) => ruleMatches(
      {
        matchText: String(rule.matchText),
        direction: rule.direction === 'Purchase' || rule.direction === 'Deposit'
          ? rule.direction
          : null,
      },
      { description: String(transaction.payee), type: String(transaction.qboType) },
    )));
    return {
      samples,
      nextCursor: page.nextCursor,
      pendingCount: samples.filter((sample) => sample.status === 'PENDING').length,
      processedCount: samples.filter((sample) => sample.status !== 'PENDING').length,
      conflicts: allConflicts.slice(0, MAX_RULE_CONFLICTS).map((rule) => ({
        ruleId: String(rule.id),
        matchText: String(rule.matchText),
        category: String(rule.category),
        priority: Number(rule.priority),
      })),
      conflictsTruncated: allConflicts.length > MAX_RULE_CONFLICTS,
    };
  }

  async function listCompaniesForUser(userId: string, input: PageInput = {}): Promise<Page<CompanyReadDto>> {
    const user = await currentUser(userId);
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({});
    const expected = { resource: 'companies', userId, companyId: null, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const connectedAt = typeof position?.connectedAt === 'string' ? new Date(position.connectedAt) : null;
    const id = typeof position?.id === 'string' ? position.id : null;
    if (position && (!connectedAt || Number.isNaN(connectedAt.getTime()) || !id)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const after = connectedAt && id
      ? { OR: [{ connectedAt: { gt: connectedAt } }, { connectedAt, id: { gt: id } }] }
      : {};
    const rows = await db.company.findMany({
      where: {
        disconnectedAt: null,
        ...(user.isInstanceAdmin === true ? {} : { memberships: { some: { userId } } }),
        ...after,
      },
      orderBy: [{ connectedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        ...safeCompanySelect,
        memberships: {
          where: { userId },
          select: { role: true },
          take: 1,
        },
      },
    }) as Row[];
    const page = pageRows(rows, limit, (row) => encodeCursor(cursorSecret, {
      v: 1,
      ...expected,
      position: { connectedAt: iso(row.connectedAt), id: String(row.id) },
    }));
    return {
      items: page.rows.map((row) => {
        const memberships = Array.isArray(row.memberships) ? row.memberships as Row[] : [];
        const role = user.isInstanceAdmin === true ? 'admin' : memberships[0]?.role;
        if (role !== 'viewer' && role !== 'categorizer' && role !== 'admin') {
          throw new Error('Company query returned no current membership');
        }
        return companyDto(row, role);
      }),
      nextCursor: page.nextCursor,
    };
  }

  async function getCompanyForUser(userId: string, companyId: string): Promise<CompanyReadDto> {
    const authorized = await authorizeCompany(userId, companyId, 'viewer');
    return companyDto(authorized.company, authorized.role);
  }

  function normalizedTransactionInput(input: TransactionListInput): Required<Pick<TransactionListInput, 'limit'>> &
    Omit<TransactionListInput, 'limit'> {
    const limit = readLimit(input.limit);
    if (input.status !== undefined && !TXN_STATUSES.includes(input.status)) badRequest('Invalid transaction status');
    if (
      input.providerDisposition !== undefined
      && !PROVIDER_ACTIONABILITY_DISPOSITIONS.includes(input.providerDisposition)
    ) badRequest('Invalid provider disposition');
    const search = optionalString(input.search, 'search', MAX_SEARCH_LENGTH);
    const account = optionalString(input.account, 'account', MAX_ACCOUNT_LENGTH);
    const startDate = strictDate(input.startDate, 'startDate');
    const endDate = strictDate(input.endDate, 'endDate');
    if (startDate && endDate && startDate > endDate) badRequest('startDate must not be after endDate');
    return {
      limit,
      cursor: input.cursor,
      status: input.status,
      providerDisposition: input.providerDisposition,
      search,
      account,
      startDate,
      endDate,
    };
  }

  async function listTransactionsForUser(
    userId: string,
    companyId: string,
    input: TransactionListInput = {},
  ): Promise<TransactionPage> {
    const { role } = await authorizeCompany(userId, companyId, 'viewer');
    const normalized = normalizedTransactionInput(input);
    const filter = canonicalFilter({
      status: normalized.status,
      providerDisposition: normalized.providerDisposition,
      search: normalized.search,
      account: normalized.account,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
    });
    const expected = { resource: 'transactions', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, normalized.cursor, expected);
    const cursorDate = typeof position?.date === 'string' ? new Date(position.date) : null;
    const cursorId = typeof position?.id === 'string' ? position.id : null;
    if (position && (!cursorDate || Number.isNaN(cursorDate.getTime()) || !cursorId)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const explicitlyExcluded = normalized.status === 'SUPERSEDED';
    const viewerStatus = normalized.status !== undefined && VIEWER_HIDDEN_STATUSES.has(normalized.status)
      ? '__NO_VIEWER_STATUS__'
      : normalized.status;
    const where: Record<string, unknown> = {
      companyId,
      status:
        explicitlyExcluded
          ? { in: [] }
          : role === 'viewer'
          ? (viewerStatus === '__NO_VIEWER_STATUS__'
              ? { in: [] }
              : viewerStatus ?? { notIn: ['SUPERSEDED', ...VIEWER_HIDDEN_STATUSES] })
          : normalized.status ?? { not: 'SUPERSEDED' },
      ...(normalized.account ? { bankAccount: normalized.account } : {}),
    };
    const dateConditions: Record<string, Date> = {};
    if (normalized.startDate) dateConditions.gte = dateStart(normalized.startDate);
    if (normalized.endDate) dateConditions.lt = dateEndExclusive(normalized.endDate);
    if (Object.keys(dateConditions).length > 0) where.date = dateConditions;
    if (cursorDate && cursorId) {
      const after = [{ date: { gt: cursorDate } }, { date: cursorDate, id: { gt: cursorId } }];
      where.OR = after;
    }
    const supportsActionability = hasProviderActionability(db);
    // Provider eligibility is a TTL- and transaction-binding-aware derived
    // value. Filter it after reading rows so list semantics exactly match the
    // DTO and counts instead of relying on a stale literal SQL disposition.
    const scanLimit = supportsActionability || normalized.search
      ? MAX_READ_LIMIT
      : normalized.limit;
    const [rawRows, queueCounts] = await Promise.all([
      db.transaction.findMany({
        where,
        include: companyReadTransactionInclude,
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        take: scanLimit,
      }) as Promise<Row[]>,
      role === 'viewer'
        ? Promise.resolve({ total: 0, actionable: 0, blocked: 0, unknown: 0 })
        : (async () => {
            const totalWhere = { companyId, status: { in: QUEUE_STATUSES } };
            if (!supportsActionability) {
              return {
                total: await db.transaction.count({ where: totalWhere }) as number,
                actionable: 0,
                blocked: 0,
                unknown: 0,
              };
            }
            const actionabilityRows = await db.transaction.findMany({
              where: totalWhere,
              select: {
                id: true,
                companyId: true,
                revision: true,
                qboSyncToken: true,
                qboType: true,
                qboId: true,
                date: true,
                providerActionability: true,
              },
            }) as Row[];
            return effectiveProviderActionabilityCounts(actionabilityRows.map((row) => ({
              ...rowActionabilityIdentity(row),
              providerActionability: row.providerActionability,
            })));
          })(),
    ]);
    const visibleRows = rawRows.filter((row) =>
      row.status !== 'SUPERSEDED' &&
      (role !== 'viewer' || !VIEWER_HIDDEN_STATUSES.has(row.status as TxnStatus)));
    let dtos = await transactionDtosWithDeps(
      db,
      deps,
      companyId,
      visibleRows,
      role === 'viewer' ? new Map() : undefined,
    );
    if (normalized.search) {
      const accounts = await db.qboAccount.findMany({
        where: { companyId },
        select: { name: true, fullName: true },
      }) as Row[];
      dtos = filterTransactionDtos(
        dtos,
        normalized,
        new Map(accounts.map((account) => [String(account.name), String(account.fullName)])),
      );
    } else {
      dtos = filterTransactionDtos(dtos, normalized);
    }
    dtos = filterRowsForProviderQueue(
      visibleRows,
      dtos,
      supportsActionability,
      normalized.providerDisposition,
      role,
    );
    const hasMoreMatches = dtos.length > normalized.limit;
    const items = hasMoreMatches ? dtos.slice(0, normalized.limit) : dtos;
    const enrichedItems = await enrichTransactionReads(visibleRows, items);
    const lastReturned = items.at(-1);
    const lastScanned = rawRows.at(-1);
    let hasLaterRow = false;
    if (!hasMoreMatches && rawRows.length === scanLimit && lastScanned) {
      const lastDate = asDate(lastScanned.date);
      const lastId = String(lastScanned.id);
      const lookahead = await db.transaction.findMany({
        where: {
          ...where,
          OR: [
            { date: { gt: lastDate } },
            { date: lastDate, id: { gt: lastId } },
          ],
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { id: true, date: true },
        take: 1,
      }) as Row[];
      hasLaterRow = lookahead.length > 0;
    }
    const cursorPosition = hasMoreMatches && lastReturned
      ? { date: lastReturned.date, id: lastReturned.id }
      : hasLaterRow && lastScanned
        ? { date: iso(lastScanned.date), id: String(lastScanned.id) }
        : null;
    return {
      items: enrichedItems,
      nextCursor: cursorPosition
        ? encodeCursor(cursorSecret, { v: 1, ...expected, position: cursorPosition })
        : null,
      pendingCount: Number(queueCounts.total),
      ...(supportsActionability
        ? {
            actionableCount: Number(queueCounts.actionable),
            blockedCount: Number(queueCounts.blocked),
            unknownCount: Number(queueCounts.unknown),
          }
        : {}),
    };
  }

  async function getTransactionForUser(
    userId: string,
    companyId: string,
    transactionId: string,
  ): Promise<CompanyReadTransactionDto> {
    const { role } = await authorizeCompany(userId, companyId, 'viewer');
    boundedId(transactionId, 'transactionId');
    const row = await db.transaction.findUnique({
      where: { id: transactionId },
      include: companyReadTransactionInclude,
    }) as Row | null;
    if (
      !row ||
      row.companyId !== companyId ||
      row.status === 'SUPERSEDED' ||
      (role === 'viewer' && VIEWER_HIDDEN_STATUSES.has(row.status as TxnStatus))
    ) {
      throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
    }
    const [dto] = await transactionDtosWithDeps(
      db,
      deps,
      companyId,
      [row],
      role === 'viewer' ? new Map() : undefined,
    );
    if (!dto) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
    const [enriched] = await enrichTransactionReads([row], [dto]);
    if (!enriched) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
    return enriched;
  }

  async function listSimple<T>(
    userId: string,
    companyId: string,
    input: PageInput,
    config: {
      resource: string;
      minimum: Role;
      model: { findMany: DbMethod };
      where: Record<string, unknown>;
      orderField: string;
      orderDirection?: 'asc' | 'desc';
      include?: Record<string, unknown>;
      select?: Record<string, unknown>;
      map: (row: Row) => T;
    },
  ): Promise<Page<T>> {
    await authorizeCompany(userId, companyId, config.minimum);
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({});
    const expected = { resource: config.resource, userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const value = position?.value;
    const id = typeof position?.id === 'string' ? position.id : null;
    if (position && ((typeof value !== 'string' && typeof value !== 'number') || !id)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    const direction = config.orderDirection ?? 'asc';
    const comparison = direction === 'asc' ? 'gt' : 'lt';
    const cursorWhere = position
      ? {
          OR: [
            { [config.orderField]: { [comparison]: value } },
            { [config.orderField]: value, id: { gt: id } },
          ],
        }
      : {};
    const rows = await config.model.findMany({
      where: { companyId, ...config.where, ...cursorWhere },
      orderBy: [{ [config.orderField]: direction }, { id: 'asc' }],
      take: limit + 1,
      ...(config.include ? { include: config.include } : {}),
      ...(config.select ? { select: config.select } : {}),
    }) as Row[];
    const page = pageRows(rows, limit, (row) => {
      const rawValue = row[config.orderField];
      const cursorValue = rawValue instanceof Date ? rawValue.toISOString() : rawValue;
      if (typeof cursorValue !== 'string' && typeof cursorValue !== 'number') {
        throw new Error(`Unsupported cursor field ${config.orderField}`);
      }
      return encodeCursor(cursorSecret, {
        v: 1,
        ...expected,
        position: { value: cursorValue, id: String(row.id) },
      });
    });
    return { items: page.rows.map(config.map), nextCursor: page.nextCursor };
  }

  const listCategoriesForUser = (userId: string, companyId: string, input: PageInput = {}) =>
    listSimple(userId, companyId, input, {
      resource: 'categories',
      minimum: 'categorizer',
      model: db.qboAccount,
      where: { active: true },
      orderField: 'fullName',
      map: categoryDto,
    });

  async function listTaxCodesForUser(
    userId: string,
    companyId: string,
    input: PageInput & { direction: RuleDirection },
  ): Promise<TaxCodePage> {
    await authorizeCompany(userId, companyId, 'viewer');
    if (input.direction !== 'Purchase' && input.direction !== 'Deposit') {
      badRequest('Invalid tax direction');
    }
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({});
    const expected = { resource: 'tax-codes', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const afterQboId = typeof position?.qboId === 'string' ? position.qboId : null;
    if (position && !afterQboId) badRequest('Invalid cursor', 'INVALID_CURSOR');
    const readiness = await deps.getTaxReadiness(companyId);
    let eligible = (input.direction === 'Purchase'
      ? eligibleTaxCodes(readiness)
      : readiness.salesTaxCodes.filter(isUsableSalesTaxCodeDto))
      .sort((first, second) => first.qboId.localeCompare(second.qboId));
    if (afterQboId) {
      const index = eligible.findIndex((code) => code.qboId === afterQboId);
      if (index < 0) badRequest('Cursor position no longer exists', 'INVALID_CURSOR');
      eligible = eligible.slice(index + 1);
    }
    const hasMore = eligible.length > limit;
    const items = hasMore ? eligible.slice(0, limit) : eligible;
    const last = items.at(-1);
    return {
      direction: input.direction,
      status: input.direction === 'Purchase' ? readiness.status : readiness.salesStatus,
      reason: input.direction === 'Purchase' ? readiness.reason : readiness.salesReason,
      usingSalesTax: readiness.usingSalesTax,
      refreshedAt: readiness.refreshedAt,
      items,
      nextCursor: hasMore && last
        ? encodeCursor(cursorSecret, { v: 1, ...expected, position: { qboId: last.qboId } })
        : null,
    };
  }

  const listTagsForUser = (userId: string, companyId: string, input: PageInput = {}) =>
    listSimple(userId, companyId, input, {
      resource: 'tags',
      minimum: 'viewer',
      model: db.tag,
      where: {},
      orderField: 'createdAt',
      include: { _count: { select: { txnTags: true } } },
      map: tagDto,
    });

  async function listTransferCandidatesForUser(
    userId: string,
    companyId: string,
    input: PageInput = {},
  ): Promise<Page<TransferCandidateDto>> {
    await authorizeCompany(userId, companyId, 'categorizer');
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({});
    const expected = { resource: 'transfer-candidates', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const pairId = typeof position?.pairId === 'string' ? position.pairId : null;
    if (position && !pairId) badRequest('Invalid cursor', 'INVALID_CURSOR');
    const candidates = await deps.transferCandidates(companyId);
    let pairIds: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const [first, second] of candidates) {
      if (seen.has(first) || seen.has(second)) continue;
      seen.add(first);
      seen.add(second);
      pairIds.push([first, second]);
    }
    if (pairId) {
      const index = pairIds.findIndex(([first, second]) => `${first}:${second}` === pairId);
      if (index < 0) badRequest('Cursor position no longer exists', 'INVALID_CURSOR');
      pairIds = pairIds.slice(index + 1);
    }
    const hasMore = pairIds.length > limit;
    const keptIds = hasMore ? pairIds.slice(0, limit) : pairIds;
    const ids = keptIds.flat();
    const rows = ids.length === 0
      ? []
      : await db.transaction.findMany({
          where: { companyId, id: { in: ids } },
          include: transactionReadInclude,
        }) as Row[];
    const dtos = await transactionDtosWithDeps(db, deps, companyId, rows, candidates);
    const byId = new Map(dtos.map((dto) => [dto.id, dto]));
    const items: TransferCandidateDto[] = [];
    for (const [firstId, secondId] of keptIds) {
      const first = byId.get(firstId);
      const second = byId.get(secondId);
      if (!first || !second) continue;
      items.push(first.amount < 0 ? { a: first, b: second } : { a: second, b: first });
    }
    const last = keptIds.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor(cursorSecret, {
          v: 1,
          ...expected,
          position: { pairId: `${last[0]}:${last[1]}` },
        })
      : null;
    return { items, nextCursor };
  }

  return {
    listCompanies: listCompaniesForUser,
    getCompany: getCompanyForUser,
    listTransactions: listTransactionsForUser,
    getTransaction: getTransactionForUser,
    listCategories: listCategoriesForUser,
    listTaxCodes: listTaxCodesForUser,
    listTags: listTagsForUser,
    listRules: listRuleLifecycleForUser,
    listRuleLifecycle: listRuleLifecycleForUser,
    getRule: getRuleForUser,
    listRuleRevisions: listRuleRevisionsForUser,
    listRuleAffectedTransactions: listRuleAffectedTransactionsForUser,
    testRule: testRuleForUser,
    listRuleCandidates: listRuleCandidatesForUser,
    getRuleCandidate: getRuleCandidateForUser,
    getClassificationCase: getClassificationCaseForUser,
    searchClassificationKnowledge: searchClassificationKnowledgeForUser,
    listPastDecisions: listPastDecisionsForUser,
    getHistoricalObservation: getHistoricalObservationForUser,
    getCurrentClassificationCase: getCurrentClassificationCaseForUser,
    listTransferCandidates: listTransferCandidatesForUser,
  };
}

const defaultService = createCompanyReadService(
  prisma as unknown as CompanyReadDb,
  env.SESSION_SECRET,
);

export const listCompanies = defaultService.listCompanies;
export const getCompany = defaultService.getCompany;
export const listTransactions = defaultService.listTransactions;
export const getTransaction = defaultService.getTransaction;
export const listCategories = defaultService.listCategories;
export const listTaxCodes = defaultService.listTaxCodes;
export const listTags = defaultService.listTags;
export const listRules = defaultService.listRuleLifecycle;
export const listRuleLifecycle = defaultService.listRuleLifecycle;
export const getRule = defaultService.getRule;
export const listRuleRevisions = defaultService.listRuleRevisions;
export const listRuleAffectedTransactions = defaultService.listRuleAffectedTransactions;
export const testRule = defaultService.testRule;
export const listRuleCandidates = defaultService.listRuleCandidates;
export const getRuleCandidate = defaultService.getRuleCandidate;
export const getClassificationCase = defaultService.getClassificationCase;
export const getCurrentClassificationCase = defaultService.getCurrentClassificationCase;
export const listTransferCandidates = defaultService.listTransferCandidates;

export const listPastDecisions = defaultService.listPastDecisions;
export const getHistoricalObservation = defaultService.getHistoricalObservation;

export const searchClassificationKnowledge = defaultService.searchClassificationKnowledge;
