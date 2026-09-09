import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { CLASSIFICATION_CONTRACT_LIMITS } from './contracts.js';

const SUPPORTED_QBO_TYPES = new Set(['Purchase', 'Deposit', 'JournalEntry']);
const TAX_CALCULATIONS = new Set(['TaxInclusive', 'TaxExcluded']);
const ISO_CURRENCY = /^[A-Z]{3}$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_PAGE_SIZE = 250;
const MAX_DATE_SPAN_DAYS = 730;

export type HistoricalObservationExclusionReason =
  | 'excluded_source'
  | 'not_posted'
  | 'unsupported_qbo_type'
  | 'split_transaction'
  | 'missing_source_identity'
  | 'missing_category'
  | 'invalid_tax_action'
  | 'missing_currency'
  | 'missing_display_summary'
  | 'already_verified_case';

const EXCLUSION_REASONS: readonly HistoricalObservationExclusionReason[] = [
  'excluded_source',
  'not_posted',
  'unsupported_qbo_type',
  'split_transaction',
  'missing_source_identity',
  'missing_category',
  'invalid_tax_action',
  'missing_currency',
  'missing_display_summary',
  'already_verified_case',
];

export interface HistoricalObservationBackfillInput {
  companyId: string;
  startDate: string;
  endDate: string;
  dryRun: boolean;
  pageSize?: number;
  excludeSourceTransactionIds?: readonly string[];
  now?: Date;
}

export interface HistoricalObservationBackfillReport {
  mode: 'dry_run' | 'apply';
  startDate: string;
  endDate: string;
  scanned: number;
  eligible: number;
  inserted: number;
  existing: number;
  excluded: Record<HistoricalObservationExclusionReason, number>;
}

export interface HistoricalObservationSource {
  sourceTransactionId: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  transactionDate: Date;
  sourceUpdatedAt: Date;
  payee: string;
  memo: string | null;
  amount: string | number | { toString(): string };
  currency: string | null;
  bankAccount: string;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  splitLines: readonly { id: string }[];
  tagNames: readonly string[];
  activeCaseId: string | null;
}

export interface HistoricalObservationInsert {
  companyId: string;
  sourceTransactionId: string;
  sourceQboType: string;
  sourceQboId: string;
  sourceTransactionRevision: number;
  sourceQboSyncToken: string;
  sourceStatus: 'POSTED';
  sourceUpdatedAt: Date;
  transactionDate: Date;
  payee: string;
  memo: string | null;
  amountCents: bigint;
  currency: string;
  sourceAccountName: string;
  categoryName: string;
  categoryQboId: string;
  taxCalculation: string;
  taxCodeName: string | null;
  taxCodeQboId: string | null;
  tagNames: string[];
}

export type ObservationSelection =
  | { ok: true; value: HistoricalObservationInsert }
  | { ok: false; reason: HistoricalObservationExclusionReason };

export interface HistoricalObservationDb {
  transaction: Pick<PrismaClient['transaction'], 'findMany'>;
  historicalClassificationObservation: Pick<PrismaClient['historicalClassificationObservation'], 'createMany'>;
  $queryRaw: PrismaClient['$queryRaw'];
  $transaction: PrismaClient['$transaction'];
}

export class HistoricalObservationBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalObservationBackfillError';
  }
}

function emptyExclusions(): Record<HistoricalObservationExclusionReason, number> {
  return Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<
    HistoricalObservationExclusionReason,
    number
  >;
}

function boundedText(value: string, maximum: number): string | null {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) return null;
  const normalized = value.normalize('NFC').trim();
  if (normalized === '' || Array.from(normalized).length > maximum) return null;
  return normalized;
}

function boundedIdentifier(value: string, maximum: number): string | null {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) return null;
  return value.trim() !== '' && Array.from(value).length <= maximum ? value : null;
}

function optionalBoundedText(value: string | null, maximum: number): string | null | undefined {
  if (value === null) return null;
  return boundedText(value, maximum) ?? undefined;
}

function optionalBoundedIdentifier(value: string | null, maximum: number): string | null | undefined {
  if (value === null) return null;
  return boundedIdentifier(value, maximum) ?? undefined;
}

function optionalMemo(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) return undefined;
  const normalized = value.normalize('NFC').trim();
  if (normalized === '') return null;
  return Array.from(normalized).length <= 2_000 ? normalized : undefined;
}

function exactCents(value: HistoricalObservationSource['amount']): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(String(value));
  if (match === null) return null;
  const cents = (match[1] === '-' ? -1n : 1n) * (
    BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))
  );
  return cents >= BigInt(Number.MIN_SAFE_INTEGER) && cents <= BigInt(Number.MAX_SAFE_INTEGER)
    ? cents
    : null;
}

function stableTagNames(values: readonly string[]): string[] | null {
  if (values.length > CLASSIFICATION_CONTRACT_LIMITS.tags) return null;
  const names: string[] = [];
  for (const value of values) {
    const name = boundedText(value, 500);
    if (name === null) return null;
    names.push(name);
  }
  return [...new Set(names)].sort();
}

/**
 * Converts an allow-listed transaction snapshot to an advisory observation.
 * Protected source IDs are intentionally checked before touching any fields.
 */
export function toHistoricalObservation(
  source: HistoricalObservationSource,
  excludedSourceTransactionIds: ReadonlySet<string>,
): ObservationSelection {
  if (excludedSourceTransactionIds.has(source.sourceTransactionId)) {
    return { ok: false, reason: 'excluded_source' };
  }
  if (source.status !== 'POSTED') return { ok: false, reason: 'not_posted' };
  if (!SUPPORTED_QBO_TYPES.has(source.qboType)) return { ok: false, reason: 'unsupported_qbo_type' };
  if (source.splitLines.length !== 0) return { ok: false, reason: 'split_transaction' };
  const sourceQboId = boundedIdentifier(source.qboId, 128);
  const sourceQboSyncToken = boundedIdentifier(source.qboSyncToken, 128);
  if (
    sourceQboId === null
    || sourceQboSyncToken === null
    || !Number.isSafeInteger(source.revision)
    || source.revision < 0
  ) return { ok: false, reason: 'missing_source_identity' };
  const categoryName = source.category === null ? null : boundedText(source.category, 500);
  const categoryQboId = source.categoryQboId === null
    ? null
    : boundedIdentifier(source.categoryQboId, 120);
  if (categoryName === null || categoryQboId === null) return { ok: false, reason: 'missing_category' };
  const taxCalculation = source.taxCalculation === null ? null : boundedText(source.taxCalculation, 32);
  const taxCodeName = optionalBoundedText(source.taxCode, 500);
  const taxCodeQboId = optionalBoundedIdentifier(source.taxCodeQboId, 120);
  if (
    taxCalculation === 'NotApplicable'
      ? taxCodeName !== null || taxCodeQboId !== null
      : !TAX_CALCULATIONS.has(taxCalculation ?? '') || taxCodeName === undefined || taxCodeQboId === undefined
      || taxCodeName === null || taxCodeQboId === null
  ) return { ok: false, reason: 'invalid_tax_action' };
  const currency = source.currency === null ? null : boundedText(source.currency, 3);
  if (currency === null || !ISO_CURRENCY.test(currency)) return { ok: false, reason: 'missing_currency' };
  const payee = boundedText(source.payee, 500);
  const sourceAccountName = boundedText(source.bankAccount, 500);
  const memo = optionalMemo(source.memo);
  const amountCents = exactCents(source.amount);
  const tagNames = stableTagNames(source.tagNames);
  if (
    payee === null || sourceAccountName === null || memo === undefined || amountCents === null || tagNames === null
    || !(source.transactionDate instanceof Date) || Number.isNaN(source.transactionDate.getTime())
    || !(source.sourceUpdatedAt instanceof Date) || Number.isNaN(source.sourceUpdatedAt.getTime())
  ) return { ok: false, reason: 'missing_display_summary' };
  if (source.activeCaseId !== null) return { ok: false, reason: 'already_verified_case' };
  return {
    ok: true,
    value: {
      companyId: source.companyId,
      sourceTransactionId: source.sourceTransactionId,
      sourceQboType: source.qboType,
      sourceQboId,
      sourceTransactionRevision: source.revision,
      sourceQboSyncToken,
      sourceStatus: 'POSTED',
      sourceUpdatedAt: source.sourceUpdatedAt,
      transactionDate: source.transactionDate,
      payee,
      memo,
      amountCents,
      currency,
      sourceAccountName,
      categoryName,
      categoryQboId,
      taxCalculation: taxCalculation!,
      taxCodeName: taxCodeName!,
      taxCodeQboId: taxCodeQboId!,
      tagNames,
    },
  };
}

function dateAtStart(value: string, field: string): Date {
  if (!DATE_ONLY.test(value)) throw new HistoricalObservationBackfillError(`${field} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HistoricalObservationBackfillError(`${field} must be a calendar date.`);
  }
  return date;
}

function validateInput(input: HistoricalObservationBackfillInput): {
  start: Date;
  endExclusive: Date;
  pageSize: number;
  excludedSourceTransactionIds: Set<string>;
} {
  if (typeof input.companyId !== 'string' || input.companyId.trim() === '') {
    throw new HistoricalObservationBackfillError('companyId is required.');
  }
  const start = dateAtStart(input.startDate, 'startDate');
  const end = dateAtStart(input.endDate, 'endDate');
  if (end < start) throw new HistoricalObservationBackfillError('endDate must not be before startDate.');
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DATE_SPAN_DAYS) {
    throw new HistoricalObservationBackfillError('date range must span at most 731 inclusive days.');
  }
  const pageSize = input.pageSize ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new HistoricalObservationBackfillError('pageSize must be between 1 and 250.');
  }
  const endExclusive = new Date(end.getTime() + 86_400_000);
  return {
    start,
    endExclusive,
    pageSize,
    excludedSourceTransactionIds: new Set(input.excludeSourceTransactionIds ?? []),
  };
}

type HistoricalObservationSourceRow = {
  sourceTransactionId: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  transactionDate: Date;
  sourceUpdatedAt: Date;
  payee: string;
  memo: string | null;
  amount: { toString(): string };
  currency: string | null;
  bankAccount: string;
  category: string | null;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  hasSplitLines: boolean;
  tagNames: string[];
  activeCaseId: string | null;
};

function sourceFromRow(row: HistoricalObservationSourceRow): HistoricalObservationSource {
  return {
    sourceTransactionId: row.sourceTransactionId,
    companyId: row.companyId,
    qboId: row.qboId,
    qboType: row.qboType,
    qboSyncToken: row.qboSyncToken,
    revision: row.revision,
    status: row.status,
    transactionDate: row.transactionDate,
    sourceUpdatedAt: row.sourceUpdatedAt,
    payee: row.payee,
    memo: row.memo,
    amount: row.amount,
    // The query projects only rawData.CurrencyRef.value as a scalar. It does
    // not select the provider payload or copy it to the observation.
    currency: row.currency,
    bankAccount: row.bankAccount,
    category: row.category,
    categoryQboId: row.categoryQboId,
    taxCalculation: row.taxCalculation,
    taxCode: row.taxCode,
    taxCodeQboId: row.taxCodeQboId,
    splitLines: row.hasSplitLines ? [{ id: 'split' }] : [],
    tagNames: row.tagNames,
    activeCaseId: row.activeCaseId,
  };
}

async function sourcePage(
  db: HistoricalObservationDb,
  companyId: string,
  start: Date,
  endExclusive: Date,
  pageSize: number,
  afterId: string | null,
): Promise<HistoricalObservationSource[]> {
  const rows = await db.$queryRaw<HistoricalObservationSourceRow[]>(Prisma.sql`
    SELECT
      transaction."id" AS "sourceTransactionId",
      transaction."companyId",
      transaction."qboId",
      transaction."qboType",
      transaction."qboSyncToken",
      transaction."revision",
      transaction."status"::text AS "status",
      transaction."date" AS "transactionDate",
      transaction."updatedAt" AS "sourceUpdatedAt",
      transaction."payee",
      transaction."memo",
      transaction."amount",
      transaction."rawData" #>> '{CurrencyRef,value}' AS "currency",
      transaction."bankAccount",
      transaction."category",
      transaction."categoryQboId",
      transaction."taxCalculation",
      transaction."taxCode",
      transaction."taxCodeQboId",
      EXISTS (
        SELECT 1 FROM "SplitLine" split
        WHERE split."txnId" = transaction."id"
      ) AS "hasSplitLines",
      COALESCE((
        SELECT array_agg(tag."name" ORDER BY tag."name" ASC)
        FROM "TxnTag" transaction_tag
        JOIN "Tag" tag ON tag."id" = transaction_tag."tagId"
        WHERE transaction_tag."txnId" = transaction."id"
      ), ARRAY[]::text[]) AS "tagNames",
      (
        SELECT classification_case."id"
        FROM "ClassificationCase" classification_case
        LEFT JOIN "ClassificationCaseInvalidation" invalidation
          ON invalidation."companyId" = classification_case."companyId"
          AND invalidation."classificationCaseId" = classification_case."id"
        WHERE classification_case."companyId" = transaction."companyId"
          AND classification_case."transactionId" = transaction."id"
          AND invalidation."id" IS NULL
        ORDER BY classification_case."id" ASC
        LIMIT 1
      ) AS "activeCaseId"
    FROM "Transaction" transaction
    WHERE transaction."companyId" = ${companyId}
      AND transaction."date" >= ${start}
      AND transaction."date" < ${endExclusive}
      ${afterId === null ? Prisma.empty : Prisma.sql`AND transaction."id" > ${afterId}`}
    ORDER BY transaction."id" ASC
    LIMIT ${pageSize}
  `);
  return rows.map(sourceFromRow);
}

type ApplyResult = { eligible: bigint; inserted: bigint };

async function applyPage(
  db: HistoricalObservationDb,
  input: HistoricalObservationBackfillInput,
  start: Date,
  endExclusive: Date,
  values: readonly HistoricalObservationInsert[],
): Promise<{ eligible: number; inserted: number }> {
  if (values.length === 0) return { eligible: 0, inserted: 0 };
  const sourceValues = Prisma.join(values.map((value) => Prisma.sql`(
    ${value.sourceTransactionId},
    ${value.sourceTransactionRevision},
    ${value.sourceQboSyncToken},
    ${value.currency}
  )`));
  const excluded = input.excludeSourceTransactionIds ?? [];
  const protectedSourcePredicate = excluded.length === 0
    ? Prisma.empty
    : Prisma.sql`AND transaction."id" NOT IN (${Prisma.join([...excluded])})`;
  const [result] = await db.$transaction((transaction) => transaction.$queryRaw<ApplyResult[]>(Prisma.sql`
    WITH selected (
      "sourceTransactionId", "sourceTransactionRevision", "sourceQboSyncToken", "currency"
    ) AS (VALUES ${sourceValues}),
    qualifying AS (
      SELECT
        transaction."companyId",
        transaction."id" AS "sourceTransactionId",
        transaction."qboType" AS "sourceQboType",
        transaction."qboId" AS "sourceQboId",
        transaction."revision" AS "sourceTransactionRevision",
        transaction."qboSyncToken" AS "sourceQboSyncToken",
        transaction."updatedAt" AS "sourceUpdatedAt",
        transaction."date" AS "transactionDate",
        btrim(transaction."payee") AS "payee",
        NULLIF(btrim(transaction."memo"), '') AS "memo",
        (transaction."amount" * 100)::bigint AS "amountCents",
        selected."currency" AS "currency",
        btrim(transaction."bankAccount") AS "sourceAccountName",
        btrim(transaction."category") AS "categoryName",
        transaction."categoryQboId" AS "categoryQboId",
        transaction."taxCalculation" AS "taxCalculation",
        CASE WHEN transaction."taxCode" IS NULL THEN NULL ELSE btrim(transaction."taxCode") END AS "taxCodeName",
        transaction."taxCodeQboId" AS "taxCodeQboId",
        tags."tagNames"
      FROM "Transaction" transaction
      JOIN selected ON selected."sourceTransactionId" = transaction."id"
        AND selected."sourceTransactionRevision" = transaction."revision"
        AND selected."sourceQboSyncToken" = transaction."qboSyncToken"
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(DISTINCT btrim(tag."name") ORDER BY btrim(tag."name") ASC), '[]'::jsonb) AS "tagNames"
        FROM "TxnTag" transaction_tag
        JOIN "Tag" tag ON tag."id" = transaction_tag."tagId"
        WHERE transaction_tag."txnId" = transaction."id"
        HAVING count(*) <= ${CLASSIFICATION_CONTRACT_LIMITS.tags}
      ) tags
      WHERE transaction."companyId" = ${input.companyId}
        AND transaction."date" >= ${start}
        AND transaction."date" < ${endExclusive}
        AND transaction."status" = 'POSTED'::"TxnStatus"
        AND transaction."qboType" IN ('Purchase', 'Deposit', 'JournalEntry')
        AND NOT EXISTS (
          SELECT 1 FROM "SplitLine" split WHERE split."txnId" = transaction."id"
        )
        AND btrim(transaction."qboId") <> ''
        AND char_length(transaction."qboId") <= 128
        AND btrim(transaction."qboSyncToken") <> ''
        AND char_length(transaction."qboSyncToken") <= 128
        AND transaction."revision" >= 0
        AND transaction."category" IS NOT NULL
        AND btrim(transaction."category") <> ''
        AND char_length(transaction."category") <= 500
        AND transaction."categoryQboId" IS NOT NULL
        AND btrim(transaction."categoryQboId") <> ''
        AND char_length(transaction."categoryQboId") <= 120
        AND (
          (transaction."taxCalculation" = 'NotApplicable'
            AND transaction."taxCode" IS NULL AND transaction."taxCodeQboId" IS NULL)
          OR (
            transaction."taxCalculation" IN ('TaxInclusive', 'TaxExcluded')
            AND transaction."taxCode" IS NOT NULL AND btrim(transaction."taxCode") <> ''
            AND char_length(transaction."taxCode") <= 500
            AND transaction."taxCodeQboId" IS NOT NULL AND btrim(transaction."taxCodeQboId") <> ''
            AND char_length(transaction."taxCodeQboId") <= 120
          )
        )
        AND transaction."rawData" #>> '{CurrencyRef,value}' = selected."currency"
        AND transaction."rawData" #>> '{CurrencyRef,value}' ~ '^[A-Z]{3}$'
        AND btrim(transaction."payee") <> '' AND char_length(transaction."payee") <= 500
        AND btrim(transaction."bankAccount") <> '' AND char_length(transaction."bankAccount") <= 500
        AND (transaction."memo" IS NULL OR char_length(transaction."memo") <= 2000)
        AND NOT EXISTS (
          SELECT 1
          FROM "ClassificationCase" classification_case
          LEFT JOIN "ClassificationCaseInvalidation" invalidation
            ON invalidation."companyId" = classification_case."companyId"
            AND invalidation."classificationCaseId" = classification_case."id"
          WHERE classification_case."companyId" = transaction."companyId"
            AND classification_case."transactionId" = transaction."id"
            AND invalidation."id" IS NULL
        )
        ${protectedSourcePredicate}
    ),
    inserted AS (
      INSERT INTO "HistoricalClassificationObservation" (
        "id", "companyId", "sourceTransactionId", "sourceQboType", "sourceQboId",
        "sourceTransactionRevision", "sourceQboSyncToken", "sourceStatus", "sourceUpdatedAt",
        "transactionDate", "payee", "memo", "amountCents", "currency", "sourceAccountName",
        "categoryName", "categoryQboId", "taxCalculation", "taxCodeName", "taxCodeQboId", "tagNames"
      )
      SELECT
        gen_random_uuid()::text, qualifying."companyId", qualifying."sourceTransactionId",
        qualifying."sourceQboType", qualifying."sourceQboId", qualifying."sourceTransactionRevision",
        qualifying."sourceQboSyncToken", 'POSTED'::"TxnStatus", qualifying."sourceUpdatedAt",
        qualifying."transactionDate", qualifying."payee", qualifying."memo", qualifying."amountCents",
        qualifying."currency", qualifying."sourceAccountName", qualifying."categoryName",
        qualifying."categoryQboId", qualifying."taxCalculation", qualifying."taxCodeName",
        qualifying."taxCodeQboId", qualifying."tagNames"
      FROM qualifying
      ON CONFLICT ("companyId", "sourceQboType", "sourceQboId", "sourceTransactionRevision", "sourceQboSyncToken")
      DO NOTHING
      RETURNING "id"
    )
    SELECT
      (SELECT count(*) FROM qualifying)::bigint AS "eligible",
      (SELECT count(*) FROM inserted)::bigint AS "inserted"
  `));
  return { eligible: Number(result?.eligible ?? 0n), inserted: Number(result?.inserted ?? 0n) };
}

export async function backfillHistoricalClassificationObservations(
  input: HistoricalObservationBackfillInput,
  db: HistoricalObservationDb = prisma,
): Promise<HistoricalObservationBackfillReport> {
  const checked = validateInput(input);
  const report: HistoricalObservationBackfillReport = {
    mode: input.dryRun ? 'dry_run' : 'apply',
    startDate: input.startDate,
    endDate: input.endDate,
    scanned: 0,
    eligible: 0,
    inserted: 0,
    existing: 0,
    excluded: emptyExclusions(),
  };
  let afterId: string | null = null;
  for (;;) {
    const sources = await sourcePage(
      db, input.companyId, checked.start, checked.endExclusive, checked.pageSize, afterId,
    );
    if (sources.length === 0) break;
    afterId = sources.at(-1)!.sourceTransactionId;
    const selectedValues: HistoricalObservationInsert[] = [];
    for (const source of sources) {
      report.scanned += 1;
      const selected = toHistoricalObservation(source, checked.excludedSourceTransactionIds);
      if (!selected.ok) {
        report.excluded[selected.reason] += 1;
        continue;
      }
      report.eligible += 1;
      selectedValues.push(selected.value);
    }
    if (!input.dryRun) {
      const applied = await applyPage(db, input, checked.start, checked.endExclusive, selectedValues);
      // The SQL statement is authoritative when a source changes after the
      // preflight read; it binds the revision and sync token before inserting.
      report.eligible += applied.eligible - selectedValues.length;
      report.inserted += applied.inserted;
      report.existing += applied.eligible - applied.inserted;
    }
    if (sources.length < checked.pageSize) break;
  }
  return report;
}
