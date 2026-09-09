import { categorizationSourceGrossCents } from './tax/sourceGross.js';
import { CategorizationError } from './categorizationError.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
  CompanyDto,
  QboAccountDto,
  Role,
  RuleDto,
  SuggestionDto,
  TagDto,
  TaxCodeDto,
  TaxReadinessDto,
  TaxSupportStatus,
  TransactionDto,
  TxnStatus,
} from '@recat/shared';
import { isUsableSalesTaxCodeDto, isUsableTaxCodeDto } from '@recat/shared';
import { env } from '../env.js';
import { HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { suggestForMany as defaultSuggestForMany } from './suggestions.js';
import { getTaxReadiness as defaultGetTaxReadiness } from './tax/reference.js';
import { transferCandidates as defaultTransferCandidates } from './transferCandidates.js';

export const DEFAULT_READ_LIMIT = 20;
export const MAX_READ_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_SEARCH_LENGTH = 200;
const MAX_ACCOUNT_LENGTH = 120;
const MAX_ID_LENGTH = 128;
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

type DbMethod = (args: Record<string, unknown>) => Promise<unknown>;

export interface CompanyReadDb {
  user: { findUnique: DbMethod; findMany?: DbMethod };
  membership: { findUnique: DbMethod };
  company: { findUnique: DbMethod; findMany: DbMethod };
  transaction: { findUnique: DbMethod; findMany: DbMethod; count: DbMethod };
  qboAccount: { findMany: DbMethod };
  qboTaxCode: { findMany: DbMethod };
  tag: { findMany: DbMethod };
  rule: { findMany: DbMethod };
}

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TransactionListInput extends PageInput {
  status?: TxnStatus;
  search?: string;
  account?: string;
  startDate?: string;
  endDate?: string;
}

export type VerificationReadStatus = 'verified' | 'dry-run' | 'failed' | 'uncertain' | 'unknown';
export type VerificationReadOutcome = 'VERIFIED' | 'DRY_RUN' | 'RETRYABLE' | 'UNCERTAIN' | 'UNCHANGED';

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
}

export interface CompanyReadDto extends CompanyDto {
  role: Role;
}

export interface CompanyReadRuleDto extends RuleDto {
  valid: boolean;
  invalidReasons: string[];
}

export interface TaxCodePage extends Page<TaxCodeDto> {
  status: TaxSupportStatus;
  reason: string | null;
  usingSalesTax: boolean | null;
  refreshedAt: string | null;
}

export interface TransferCandidateDto {
  a: TransactionDto;
  b: TransactionDto;
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
    txns: { payee: string; memo?: string | null; amount: number }[],
  ): Promise<(SuggestionDto | null)[]>;
  transferCandidates(companyId: string): Promise<Map<string, string>>;
}

const defaultDeps: CompanyReadDeps = {
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
    const expectedMac = cursorMac(secret, body);
    if (actual.length !== expectedMac.length || !timingSafeEqual(actual, expectedMac)) {
      badRequest('Invalid cursor', 'INVALID_CURSOR');
    }
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
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

function suggestionDto(value: unknown): SuggestionDto | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = (value as Row).source;
  const category = (value as Row).category;
  if (
    typeof category !== 'string' ||
    (source !== 'rule' && source !== 'history' && source !== 'ai')
  ) return null;
  const row = value as Row;
  return {
    category,
    source,
    ...(typeof row.categoryQboId === 'string' ? { categoryQboId: row.categoryQboId } : {}),
    ...(typeof row.ruleId === 'string' ? { ruleId: row.ruleId } : {}),
    ...(typeof row.matchedRules === 'number' ? { matchedRules: row.matchedRules } : {}),
    ...(typeof row.winnerMatchText === 'string' ? { winnerMatchText: row.winnerMatchText } : {}),
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  liveSuggestion: SuggestionDto | null,
  transferCandidateId: string | null,
  holdingAccountIds: unknown = [],
): TransactionDto {
  const splitLines = Array.isArray(row.splitLines) ? (row.splitLines as Row[]) : [];
  const attempts = Array.isArray(row.qboMutationAttempts) ? (row.qboMutationAttempts as Row[]) : [];
  const attempt = attempts[0];
  const operation = attempt?.operation;
  const attemptStatus = attempt?.status;
  const activeCategorizationAttempt: TransactionDto['activeCategorizationAttempt'] =
    attempt &&
    typeof attempt.requestId === 'string' &&
    UUID_PATTERN.test(attempt.requestId) &&
    (operation === 'recategorize' || operation === 'restore') &&
    (attemptStatus === 'PREPARED' || attemptStatus === 'COMMITTING' || attemptStatus === 'UNCERTAIN')
      ? {
          requestId: attempt.requestId,
          operation: operation as 'recategorize' | 'restore',
          status: attemptStatus as 'PREPARED' | 'COMMITTING' | 'UNCERTAIN',
        }
      : null;
  const sourceGrossCents = provenSourceGross(row, holdingAccountIds);
  const posterId = typeof row.postedByUserId === 'string' ? row.postedByUserId : null;
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
      row.status === 'PENDING'
        ? (liveSuggestion ?? suggestionDto(row.suggestion))
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
    transferCandidateId,
  };
}

export const transactionReadInclude = {
  txnTags: { select: { tagId: true } },
  splitLines: {
    include: { tags: { select: { tagId: true } } },
    orderBy: { idx: 'asc' },
  },
  qboMutationAttempts: {
    where: { status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] } },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { requestId: true, operation: true, status: true },
  },
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
    dto.suggestion?.category ?? '',
    dto.suggestion !== null ? (fullNameOf.get(dto.suggestion.category) ?? '') : '',
    STATUS_WORDS[dto.status],
    absolute,
    `$${absolute}`,
    `${dto.amount < 0 ? '-' : '+'}$${absolute}`,
  ].join(' ').toLowerCase();
}

export function filterTransactionDtos(
  dtos: TransactionDto[],
  input: Pick<TransactionListInput, 'status' | 'account' | 'search'>,
  fullNameOf: Map<string, string> = new Map(),
): TransactionDto[] {
  let filtered = dtos;
  if (input.status !== undefined) filtered = filtered.filter((dto) => dto.status === input.status);
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
  const pendingRows = rows.filter((row) => row.status === 'PENDING');
  const liveSuggestions = await deps.suggestForMany(
    companyId,
    pendingRows.map((row) => ({
      payee: String(row.payee),
      memo: typeof row.memo === 'string' ? row.memo : null,
      amount: Number(row.amount),
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

function ruleDto(row: Row): RuleDto {
  const candidateOrigin =
    row.candidateOrigin &&
    typeof row.candidateOrigin === 'object' &&
    !Array.isArray(row.candidateOrigin)
      ? row.candidateOrigin as Row
      : null;
  return {
    id: String(row.id),
    companyId: String(row.companyId),
    priority: Number(row.priority),
    matchField: 'payee',
    matchText: String(row.matchText),
    category: String(row.category),
    categoryQboId: typeof row.categoryQboId === 'string' ? row.categoryQboId : null,
    taxCalculation:
      row.taxCalculation === 'TaxInclusive' ||
      row.taxCalculation === 'TaxExcluded' ||
      row.taxCalculation === 'NotApplicable'
        ? row.taxCalculation
        : null,
    taxCode: typeof row.taxCode === 'string' ? row.taxCode : null,
    taxCodeQboId: typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null,
    tagIds: Array.isArray(row.ruleTags) ? (row.ruleTags as Row[]).map((tag) => String(tag.tagId)) : [],
    autoPost: row.autoPost === true,
    createdAt: iso(row.createdAt),
    reviewRequiredAt: row.reviewRequiredAt == null ? null : iso(row.reviewRequiredAt),
    reviewReason: typeof row.reviewReason === 'string' ? row.reviewReason : null,
    origin: candidateOrigin
      ? {
          candidateId: String(candidateOrigin.id),
          evidenceCount: Number(
            candidateOrigin.activationEvidenceCount ?? candidateOrigin.evidenceCount,
          ),
          schemaVersion: String(candidateOrigin.schemaVersion),
          configVersion: String(candidateOrigin.configVersion),
        }
      : null,
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
    const search = optionalString(input.search, 'search', MAX_SEARCH_LENGTH);
    const account = optionalString(input.account, 'account', MAX_ACCOUNT_LENGTH);
    const startDate = strictDate(input.startDate, 'startDate');
    const endDate = strictDate(input.endDate, 'endDate');
    if (startDate && endDate && startDate > endDate) badRequest('startDate must not be after endDate');
    return { limit, cursor: input.cursor, status: input.status, search, account, startDate, endDate };
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
    const scanLimit = normalized.search ? MAX_READ_LIMIT : normalized.limit;
    const [rawRows, pendingCount] = await Promise.all([
      db.transaction.findMany({
        where,
        include: companyReadTransactionInclude,
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        take: scanLimit,
      }) as Promise<Row[]>,
      role === 'viewer'
        ? Promise.resolve(0)
        : db.transaction.count({ where: { companyId, status: { in: ['PENDING', 'ERROR'] } } }) as Promise<number>,
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
      pendingCount: Number(pendingCount),
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
    input: PageInput = {},
  ): Promise<TaxCodePage> {
    await authorizeCompany(userId, companyId, 'viewer');
    const limit = readLimit(input.limit);
    const filter = canonicalFilter({});
    const expected = { resource: 'tax-codes', userId, companyId, filter };
    const position = decodeCursor(cursorSecret, input.cursor, expected);
    const afterQboId = typeof position?.qboId === 'string' ? position.qboId : null;
    if (position && !afterQboId) badRequest('Invalid cursor', 'INVALID_CURSOR');
    const readiness = await deps.getTaxReadiness(companyId);
    let eligible = eligibleTaxCodes(readiness)
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
      status: readiness.status,
      reason: readiness.reason,
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

  async function listRulesForUser(
    userId: string,
    companyId: string,
    input: PageInput = {},
  ): Promise<Page<CompanyReadRuleDto>> {
    const base = await listSimple(userId, companyId, input, {
      resource: 'rules',
      minimum: 'categorizer',
      model: db.rule,
      where: {},
      orderField: 'priority',
      include: {
        ruleTags: { select: { tagId: true } },
        candidateOrigin: true,
      },
      map: ruleDto,
    });
    if (base.items.length === 0) return { items: [], nextCursor: base.nextCursor };
    const accountIds = [...new Set(
      base.items.map((rule) => rule.categoryQboId).filter((id): id is string => id !== null),
    )];
    const tagIds = [...new Set(base.items.flatMap((rule) => rule.tagIds))];
    const needsTax = base.items.some(
      (rule) => rule.taxCalculation === 'TaxInclusive' || rule.taxCalculation === 'TaxExcluded',
    );
    const [accounts, tags, readiness] = await Promise.all([
      accountIds.length === 0
        ? Promise.resolve([])
        : db.qboAccount.findMany({
            where: { companyId, qboId: { in: accountIds } },
            select: { qboId: true, active: true },
          }) as Promise<Row[]>,
      tagIds.length === 0
        ? Promise.resolve([])
        : db.tag.findMany({
            where: { companyId, id: { in: tagIds } },
            select: { id: true },
          }) as Promise<Row[]>,
      needsTax ? deps.getTaxReadiness(companyId) : Promise.resolve(null),
    ]);
    const activeAccounts = new Set(
      accounts.filter((account) => account.active === true).map((account) => String(account.qboId)),
    );
    const existingTags = new Set(tags.map((tag) => String(tag.id)));
    const eligibleCodes = new Set(
      readiness === null ? [] : eligibleTaxCodes(readiness).map((code) => code.qboId),
    );
    return {
      ...base,
      items: base.items.map((rule) => {
        const reasons: string[] = [];
        if (rule.categoryQboId === null || !activeAccounts.has(rule.categoryQboId)) {
          reasons.push('Category account is missing or inactive.');
        }
        const taxed = rule.taxCalculation === 'TaxInclusive' || rule.taxCalculation === 'TaxExcluded';
        if (taxed && readiness?.status !== 'ready') {
          reasons.push('Tax reference is not ready.');
        }
        if (taxed && (rule.taxCodeQboId === null || !eligibleCodes.has(rule.taxCodeQboId))) {
          reasons.push('Tax code is missing or ineligible.');
        }
        if (rule.tagIds.some((tagId) => !existingTags.has(tagId))) {
          reasons.push('One or more tags no longer exist.');
        }
        return { ...rule, valid: reasons.length === 0, invalidReasons: reasons.slice(0, 4) };
      }),
    };
  }

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
    listRules: listRulesForUser,
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
export const listRules = defaultService.listRules;
export const listTransferCandidates = defaultService.listTransferCandidates;
