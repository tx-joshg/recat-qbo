import { prisma } from '../../lib/prisma.js';
import { normalizePayee } from '../suggestions.js';
import type { AgentSnapshotSource } from './core/snapshot.js';

const MAX_RETAINED_ITEMS = 20;
const MAX_QUERY_ITEMS = 100;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ASSIGNED_CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));
// SQL mirror of normalizePayee: uppercase, treat '#', '*' and '·' as
// separators, split on the same whitespace set as JS \s, and drop tokens
// containing a digit. Verified history is evidence only when its payee
// normalizes to the same key as the current transaction.
const NORMALIZED_PAYEE_SQL = `array_to_string(ARRAY(
  SELECT token.value
  FROM regexp_split_to_table(upper(translate(txn."payee", '#*·', '   ')),
    '[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+')
    WITH ORDINALITY AS token(value, ord)
  WHERE token.value <> '' AND token.value !~ '[0-9]'
  ORDER BY token.ord
), ' ')`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AgentSnapshotQueryDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface AgentSnapshotLoaderDb {
  $transaction<T>(
    callback: (tx: AgentSnapshotQueryDb) => Promise<T>,
    options?: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

interface CurrentRow {
  id: unknown;
  companyId: unknown;
  revision: unknown;
  status: unknown;
  date: unknown;
  amount: unknown;
  currency: unknown;
  sourceAccountQboId: unknown;
  payee: unknown;
  memo: unknown;
  holdingAccountIds: unknown;
  taxSupportStatus: unknown;
  taxUsingSalesTax: unknown;
  configVersion: unknown;
}

interface AccountRow {
  qboId: unknown;
  fullName: unknown;
  classification: unknown;
  accountType: unknown;
  active: unknown;
}

interface TaxRow {
  qboId: unknown;
  name: unknown;
  active: unknown;
  taxable: unknown;
  purchaseTaxRateList: unknown;
  combinedPurchaseRate: unknown;
}

interface TagRow {
  id: unknown;
  name: unknown;
}

interface RuleRow {
  id: unknown;
  priority: unknown;
  matchField: unknown;
  matchText: unknown;
  categoryQboId: unknown;
  taxCalculation: unknown;
  taxCodeQboId: unknown;
  tagIds: unknown;
}

interface HistoryRow {
  transactionId: unknown;
  companyId: unknown;
  revision?: unknown;
  expectedRevision?: unknown;
  status: unknown;
  mutationStatus: unknown;
  operation?: unknown;
  date: unknown;
  signedAmount: unknown;
  currency: unknown;
  payee: unknown;
  memo: unknown;
  taxCalculation: unknown;
  categoryQboId?: unknown;
  taxCodeQboId?: unknown;
  tagIds: unknown;
  verifiedAt: unknown;
}

interface HistoryLineRow {
  transactionId: unknown;
  signedGrossAmount: unknown;
  categoryQboId: unknown;
  taxCodeQboId: unknown;
  memo: unknown;
  tagIds: unknown;
}

export class AgentSnapshotSourceError extends Error {
  readonly code = 'AGENT_MODEL_INPUT_INVALID';

  constructor() {
    super('Agent snapshot source is invalid.');
    this.name = 'AgentSnapshotSourceError';
  }
}

export async function loadAgentSnapshotSource(
  companyId: string,
  transactionId: string,
  db: AgentSnapshotLoaderDb = prisma as unknown as AgentSnapshotLoaderDb,
): Promise<AgentSnapshotSource> {
  identifier(companyId);
  identifier(transactionId);
  return db.$transaction(
    (tx) => loadAgentSnapshotSourceInTransaction(companyId, transactionId, tx),
    { isolationLevel: 'RepeatableRead' },
  );
}

export async function loadAgentSnapshotSourceInTransaction(
  companyId: string,
  transactionId: string,
  tx: AgentSnapshotQueryDb,
): Promise<AgentSnapshotSource> {
  identifier(companyId);
  identifier(transactionId);
  const currentRows = await tx.$queryRawUnsafe<CurrentRow[]>(
    `/* agent-snapshot:current */
     SELECT txn."id", txn."companyId", txn."revision", txn."status", txn."date",
       txn."amount"::text AS "amount",
       txn."rawData" #>> '{CurrencyRef,value}' AS "currency",
       CASE txn."qboType"
         WHEN 'Purchase' THEN txn."rawData" #>> '{AccountRef,value}'
         WHEN 'Deposit' THEN txn."rawData" #>> '{DepositToAccountRef,value}'
         WHEN 'JournalEntry' THEN (
           SELECT CASE
             WHEN COUNT(DISTINCT credit."accountQboId") = 1
               THEN MIN(credit."accountQboId")
             ELSE NULL
           END
           FROM (
             SELECT line.value #>> '{JournalEntryLineDetail,AccountRef,value}'
               AS "accountQboId"
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(txn."rawData" -> 'Line') = 'array'
                   THEN txn."rawData" -> 'Line'
                 ELSE '[]'::jsonb
               END
             ) AS line(value)
             WHERE line.value #>> '{JournalEntryLineDetail,PostingType}' = 'Credit'
               AND line.value #>> '{JournalEntryLineDetail,AccountRef,value}' IS NOT NULL
           ) AS credit
         )
         ELSE NULL
       END AS "sourceAccountQboId",
       txn."payee", txn."memo", company."holdingAccountIds",
       company."taxSupportStatus", company."taxUsingSalesTax",
       config."configVersion"
     FROM "Transaction" AS txn
     JOIN "Company" AS company ON company."id" = txn."companyId"
     JOIN "AgentCompanyConfig" AS config ON config."companyId" = txn."companyId"
     WHERE txn."companyId" = $1 AND txn."id" = $2
     LIMIT 1`,
    companyId,
    transactionId,
  );
  const current = currentRows[0];
  if (current === undefined) invalid();
  const currentSourceAccountId = reference(current.sourceAccountQboId);
  const payeeKey = typeof current.payee === 'string' ? normalizePayee(current.payee) : '';

  const [accounts, taxRows, tagRows, ruleRows, historyRows] = await Promise.all([
    tx.$queryRawUnsafe<AccountRow[]>(
      `/* agent-snapshot:accounts */
       SELECT "qboId", "fullName", "classification", "accountType", "active"
       FROM "QboAccount"
       WHERE "companyId" = $1
         AND (
           "qboId" = $2
           OR ("active" = TRUE AND "classification" IN ('Income', 'COGS', 'Expenses'))
         )
       ORDER BY CASE WHEN "qboId" = $2 THEN 0 ELSE 1 END, "fullName", "qboId"
       LIMIT ${MAX_QUERY_ITEMS + 1}`,
      companyId,
      currentSourceAccountId,
    ),
    tx.$queryRawUnsafe<TaxRow[]>(
      `/* agent-snapshot:tax */
       SELECT "qboId", "name", "active", "taxable", "purchaseTaxRateList",
         "combinedPurchaseRate"::text AS "combinedPurchaseRate"
       FROM "QboTaxCode"
       WHERE "companyId" = $1
         AND "active" = TRUE
       ORDER BY "name", "qboId"
       LIMIT ${MAX_QUERY_ITEMS + 1}`,
      companyId,
    ),
    tx.$queryRawUnsafe<TagRow[]>(
      `/* agent-snapshot:tags */
       SELECT "id", "name"
       FROM "Tag"
       WHERE "companyId" = $1
       ORDER BY "name", "id"
       LIMIT ${MAX_QUERY_ITEMS + 1}`,
      companyId,
    ),
    tx.$queryRawUnsafe<RuleRow[]>(
      `/* agent-snapshot:rules */
       SELECT rule."id", rule."priority", rule."matchField", rule."matchText",
         rule."categoryQboId", rule."taxCalculation", rule."taxCodeQboId",
         COALESCE(
           array_agg(rule_tag."tagId" ORDER BY rule_tag."tagId")
             FILTER (WHERE rule_tag."tagId" IS NOT NULL),
           ARRAY[]::text[]
         ) AS "tagIds"
       FROM "Rule" AS rule
       LEFT JOIN "RuleTag" AS rule_tag ON rule_tag."ruleId" = rule."id"
       WHERE rule."companyId" = $1
         AND rule."matchField" = 'payee'
         AND position(lower(rule."matchText") in lower($2)) > 0
       GROUP BY rule."id"
       ORDER BY rule."priority", rule."id"
       LIMIT ${MAX_QUERY_ITEMS + 1}`,
      companyId,
      text(current.payee, 160),
    ),
    payeeKey === ''
      ? Promise.resolve<HistoryRow[]>([])
      : tx.$queryRawUnsafe<HistoryRow[]>(
        `/* agent-snapshot:history */
         SELECT txn."id" AS "transactionId", txn."companyId", txn."revision",
           txn."status", verified."mutationStatus", verified."operation",
           verified."expectedRevision", txn."date",
           txn."amount"::text AS "signedAmount",
           txn."rawData" #>> '{CurrencyRef,value}' AS "currency",
           txn."payee", txn."memo", txn."taxCalculation",
           txn."categoryQboId", txn."taxCodeQboId",
           COALESCE(
             array_agg(txn_tag."tagId" ORDER BY txn_tag."tagId")
               FILTER (WHERE txn_tag."tagId" IS NOT NULL),
             ARRAY[]::text[]
           ) AS "tagIds",
           verified."verifiedAt"
         FROM "Transaction" AS txn
         CROSS JOIN LATERAL (
           SELECT attempt."status" AS "mutationStatus", attempt."operation",
             attempt."expectedRevision", attempt."updatedAt" AS "verifiedAt"
           FROM "QboMutationAttempt" AS attempt
           WHERE attempt."transactionId" = txn."id"
             AND attempt."status" = 'VERIFIED'
             AND attempt."operation" = 'recategorize'
           ORDER BY attempt."updatedAt" DESC, attempt."id" DESC
           LIMIT 1
         ) AS verified
         LEFT JOIN "TxnTag" AS txn_tag ON txn_tag."txnId" = txn."id"
         WHERE txn."companyId" = $1
           AND txn."id" <> $2
           AND txn."status" = 'POSTED'
           AND txn."revision" = verified."expectedRevision"
           AND ${NORMALIZED_PAYEE_SQL} = $3
         GROUP BY txn."id", verified."mutationStatus", verified."operation",
           verified."expectedRevision", verified."verifiedAt"
         ORDER BY verified."verifiedAt" DESC, txn."id"
         LIMIT ${MAX_QUERY_ITEMS}`,
        companyId,
        transactionId,
        payeeKey,
      ),
  ]);

  const historyIds = historyRows
    .map((row) => row.transactionId)
    .filter((value): value is string => typeof value === 'string');
  const historyLineRows = historyIds.length === 0
    ? []
    : await tx.$queryRawUnsafe<HistoryLineRow[]>(
      `/* agent-snapshot:history-lines */
       SELECT line."txnId" AS "transactionId",
         line."amount"::text AS "signedGrossAmount",
         line."categoryQboId", line."taxCodeQboId", line."memo",
         COALESCE(
           array_agg(line_tag."tagId" ORDER BY line_tag."tagId")
             FILTER (WHERE line_tag."tagId" IS NOT NULL),
           ARRAY[]::text[]
         ) AS "tagIds"
       FROM "SplitLine" AS line
       LEFT JOIN "SplitLineTag" AS line_tag ON line_tag."splitLineId" = line."id"
       WHERE line."txnId" = ANY($1::text[])
       GROUP BY line."id"
       ORDER BY line."txnId", line."idx"`,
      historyIds,
    );

  return mapSource({
    companyId,
    transactionId,
    current,
    accounts,
    taxRows,
    tagRows,
    ruleRows,
    historyRows,
    historyLineRows,
  });
}

function mapSource(input: {
  companyId: string;
  transactionId: string;
  current: CurrentRow;
  accounts: AccountRow[];
  taxRows: TaxRow[];
  tagRows: TagRow[];
  ruleRows: RuleRow[];
  historyRows: HistoryRow[];
  historyLineRows: HistoryLineRow[];
}): AgentSnapshotSource {
  const current = input.current;
  if (
    current.companyId !== input.companyId
    || current.id !== input.transactionId
    || current.status !== 'PENDING'
  ) invalid();
  const transactionId = uuid(current.id);
  const revision = nonnegativeInteger(current.revision);
  const currency = currencyCode(current.currency);
  const sourceAccountId = reference(current.sourceAccountQboId);
  const holdingIds = new Set(stringArray(current.holdingAccountIds).filter(isReference));
  const payeeKey = typeof current.payee === 'string' ? normalizePayee(current.payee) : '';

  const normalizedAccounts = input.accounts.flatMap((row) => {
    if (
      row.active !== true
      || !isReference(row.qboId)
      || typeof row.fullName !== 'string'
      || row.fullName.trim() === ''
      || row.fullName.length > 160
      || typeof row.classification !== 'string'
      || (row.accountType !== null && typeof row.accountType !== 'string')
    ) return [];
    return [{
      qboId: row.qboId,
      fullName: row.fullName.trim(),
      classification: row.classification,
      accountType: row.accountType ?? '',
    }];
  });
  const sourceAccount = normalizedAccounts.find((row) => row.qboId === sourceAccountId);
  if (sourceAccount === undefined) invalid();
  const sourceType = mappedAccountType(sourceAccount.accountType, sourceAccount.classification);

  const candidateCategories = normalizedAccounts
    .filter((row) =>
      !holdingIds.has(row.qboId)
      && (row.classification === 'Income'
        || row.classification === 'COGS'
        || row.classification === 'Expenses'))
    .sort((left, right) =>
      left.fullName.localeCompare(right.fullName)
      || left.qboId.localeCompare(right.qboId))
    .slice(0, MAX_RETAINED_ITEMS)
    .map((row) => ({ qboId: row.qboId, name: row.fullName }));
  const categoryIds = new Set(candidateCategories.map((entry) => entry.qboId));

  const eligibleReferences = input.taxRows
    .filter(isUsableTaxRow)
    .map((row) => ({
      qboId: reference(row.qboId),
      label: text(row.name, 160),
    }))
    .sort((left, right) =>
      left.label.localeCompare(right.label) || left.qboId.localeCompare(right.qboId))
    .slice(0, MAX_RETAINED_ITEMS);
  const taxIds = new Set(eligibleReferences.map((entry) => entry.qboId));
  const taxStatus = normalizedTaxStatus(
    current.taxSupportStatus,
    current.taxUsingSalesTax,
    eligibleReferences.length,
  );
  const tax: AgentSnapshotSource['tax'] = taxStatus === 'ready'
    ? {
        status: 'ready',
        supportedCalculationModes: ['TaxInclusive', 'TaxExcluded'],
        eligibleReferences,
      }
    : { status: taxStatus, supportedCalculationModes: [], eligibleReferences: [] };

  const tags = input.tagRows.flatMap((row) => {
    if (!isUuid(row.id) || typeof row.name !== 'string' || row.name.trim() === '' || row.name.length > 160) {
      return [];
    }
    return [{ id: row.id, name: row.name.trim() }];
  }).sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, MAX_RETAINED_ITEMS);
  const tagIds = new Set(tags.map((entry) => entry.id));

  const rules = input.ruleRows.flatMap((row) => {
    if (
      !isUuid(row.id)
      || !Number.isInteger(row.priority)
      || (row.priority as number) < 0
      || (row.priority as number) > 1_000_000
      || row.matchField !== 'payee'
      || typeof row.matchText !== 'string'
      || row.matchText.trim() === ''
      || row.matchText.length > 160
      || !isReference(row.categoryQboId)
      || !categoryIds.has(row.categoryQboId)
    ) return [];
    const calculation = normalizedTaxCalculation(row.taxCalculation, row.taxCodeQboId);
    if (calculation === null || !validTaxReference(calculation, row.taxCodeQboId, tax, taxIds)) return [];
    const ruleTagIds = validReferencedIds(row.tagIds, tagIds);
    if (ruleTagIds === null) return [];
    return [{
      id: row.id,
      priority: row.priority as number,
      matchField: 'payee' as const,
      matchText: row.matchText.trim(),
      categoryQboId: row.categoryQboId,
      taxCalculation: calculation,
      taxCodeQboId: calculation === 'NotApplicable' ? null : row.taxCodeQboId as string,
      tagIds: ruleTagIds,
    }];
  }).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .slice(0, MAX_RETAINED_ITEMS);

  const linesByTransaction = new Map<string, HistoryLineRow[]>();
  for (const line of input.historyLineRows) {
    if (typeof line.transactionId !== 'string') continue;
    const existing = linesByTransaction.get(line.transactionId) ?? [];
    existing.push(line);
    linesByTransaction.set(line.transactionId, existing);
  }
  const similarVerifiedTransactions = input.historyRows.flatMap((row) => {
    if (
      !isUuid(row.transactionId)
      || row.transactionId === transactionId
      || row.companyId !== input.companyId
      || row.status !== 'POSTED'
      || row.mutationStatus !== 'VERIFIED'
      || (row.operation !== undefined && row.operation !== 'recategorize')
      || (
        row.revision !== undefined
        && row.expectedRevision !== undefined
        && row.revision !== row.expectedRevision
      )
      || typeof row.payee !== 'string'
      || normalizePayee(row.payee) !== payeeKey
    ) return [];
    const amount = maybeCents(row.signedAmount);
    const historyCurrency = maybeCurrency(row.currency);
    const calculation = normalizedTaxCalculation(row.taxCalculation, row.taxCodeQboId);
    const verifiedAt = maybeTimestamp(row.verifiedAt);
    const historyTagIds = validReferencedIds(row.tagIds, tagIds);
    if (
      amount === null
      || amount === 0
      || historyCurrency === null
      || calculation === null
      || verifiedAt === null
      || historyTagIds === null
      || !validTaxReference(calculation, row.taxCodeQboId, tax, taxIds, true)
    ) return [];
    const rawLines = linesByTransaction.get(row.transactionId) ?? [];
    const sourceLines = rawLines.length > 0
      ? rawLines
      : [{
          transactionId: row.transactionId,
          signedGrossAmount: row.signedAmount,
          categoryQboId: row.categoryQboId,
          taxCodeQboId: row.taxCodeQboId,
          memo: null,
          tagIds: [],
        }];
    const lines = sourceLines.flatMap((line) => {
      const gross = maybeCents(line.signedGrossAmount);
      const lineTagIds = validReferencedIds(line.tagIds, tagIds);
      if (
        gross === null
        || gross === 0
        || Math.sign(gross) !== Math.sign(amount)
        || !isReference(line.categoryQboId)
        || !categoryIds.has(line.categoryQboId)
        || !validTaxReference(calculation, line.taxCodeQboId, tax, taxIds)
        || lineTagIds === null
      ) return [];
      const memo = optionalText(line.memo, 500);
      return [{
        signedGrossCents: gross,
        categoryQboId: line.categoryQboId,
        taxCodeQboId: calculation === 'NotApplicable' ? null : line.taxCodeQboId as string,
        ...(memo === undefined ? {} : { memo }),
        tagIds: lineTagIds,
      }];
    });
    if (
      lines.length !== sourceLines.length
      || lines.length === 0
      || lines.length > MAX_RETAINED_ITEMS
      || safeSum(lines.map((line) => line.signedGrossCents)) !== amount
    ) return [];
    const memo = optionalText(row.memo, 500);
    return [{
      transactionId: row.transactionId,
      date: dateOnly(row.date),
      signedAmountCents: amount,
      currency: historyCurrency,
      payee: text(row.payee, 160),
      ...(memo === undefined ? {} : { memo }),
      taxCalculation: calculation,
      lines,
      tagIds: historyTagIds,
      verifiedAt,
    }];
  }).sort((left, right) =>
    right.verifiedAt.localeCompare(left.verifiedAt)
    || left.transactionId.localeCompare(right.transactionId))
    .slice(0, MAX_RETAINED_ITEMS);

  const memo = optionalText(current.memo, 500);
  return {
    transaction: { id: transactionId, revision },
    date: dateOnly(current.date),
    signedAmountCents: exactCents(current.amount),
    currency,
    sourceAccount: {
      displayName: sourceType === 'BANK'
        ? 'Source bank account'
        : sourceType === 'CREDIT_CARD'
          ? 'Source credit card'
          : sourceType === 'CASH'
            ? 'Source cash account'
            : 'Source account',
      type: sourceType,
    },
    payee: text(current.payee, 160),
    ...(memo === undefined ? {} : { memo }),
    candidateCategories,
    tax,
    tags,
    rules,
    similarVerifiedTransactions,
    featureVersion: 'shadow-core.1',
    configurationVersion: version(current.configVersion),
  };
}

function isUsableTaxRow(row: TaxRow): boolean {
  if (
    row.active !== true
    || !isReference(row.qboId)
    || typeof row.name !== 'string'
    || row.name.trim() === ''
    || row.name.length > 160
    || !Array.isArray(row.purchaseTaxRateList)
  ) return false;
  if (row.taxable === false) {
    return row.purchaseTaxRateList.length === 0 && row.combinedPurchaseRate === null;
  }
  if (row.taxable !== true || row.purchaseTaxRateList.length !== 1) return false;
  const rate = Number(row.combinedPurchaseRate);
  return Number.isFinite(rate) && rate >= 0 && rate <= 999.999999;
}

function normalizedTaxStatus(
  status: unknown,
  usingSalesTax: unknown,
  referenceCount: number,
): 'unsupported' | 'needs_setup' | 'ready' {
  if (status === 'unsupported') return 'unsupported';
  if (status === 'ready' && usingSalesTax === true && referenceCount > 0) return 'ready';
  return 'needs_setup';
}

function normalizedTaxCalculation(
  calculation: unknown,
  taxCodeQboId: unknown,
): 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable' | null {
  if (calculation === 'TaxInclusive' || calculation === 'TaxExcluded') return calculation;
  if (
    (calculation === 'NotApplicable' || calculation === null)
    && taxCodeQboId === null
  ) return 'NotApplicable';
  return null;
}

function validTaxReference(
  calculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable',
  taxCodeQboId: unknown,
  tax: AgentSnapshotSource['tax'],
  taxIds: ReadonlySet<string>,
  transactionLevel = false,
): boolean {
  if (calculation === 'NotApplicable') return taxCodeQboId === null;
  if (tax.status !== 'ready') return false;
  if (transactionLevel && (taxCodeQboId === null || taxCodeQboId === undefined)) return true;
  return isReference(taxCodeQboId) && taxIds.has(taxCodeQboId);
}

function validReferencedIds(value: unknown, available: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_RETAINED_ITEMS) return null;
  const ids = value.filter((entry): entry is string => typeof entry === 'string');
  if (
    ids.length !== value.length
    || new Set(ids).size !== ids.length
    || ids.some((id) => !isUuid(id) || !available.has(id))
  ) return null;
  return ids.slice().sort();
}

function mappedAccountType(
  accountType: string,
  classification: string,
): AgentSnapshotSource['sourceAccount']['type'] {
  const normalized = `${accountType} ${classification}`.toUpperCase().replace(/[^A-Z]/gu, '');
  if (normalized.includes('CREDITCARD')) return 'CREDIT_CARD';
  if (normalized.includes('CASH')) return 'CASH';
  if (normalized.includes('BANK')) return 'BANK';
  return 'OTHER';
}

function exactCents(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number' && !hasToString(value)) invalid();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(String(value));
  if (match === null) invalid();
  const sign = match[1] === '-' ? -1n : 1n;
  const cents = sign * (
    BigInt(match[2]!) * 100n
    + BigInt((match[3] ?? '').padEnd(2, '0'))
  );
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(cents);
}

function maybeCents(value: unknown): number | null {
  try {
    return exactCents(value);
  } catch {
    return null;
  }
}

function safeSum(values: number[]): number | null {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function dateOnly(value: unknown): string {
  const date = checkedDate(value);
  return date.toISOString().slice(0, 10);
}

function maybeTimestamp(value: unknown): string | null {
  try {
    return checkedDate(value).toISOString();
  } catch {
    return null;
  }
}

function checkedDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) invalid();
  return date;
}

function currencyCode(value: unknown): string {
  if (
    typeof value !== 'string'
    || !CURRENCY_PATTERN.test(value)
    || !ASSIGNED_CURRENCY_CODES.has(value)
  ) invalid();
  return value;
}

function maybeCurrency(value: unknown): string | null {
  try {
    return currencyCode(value);
  } catch {
    return null;
  }
}

function reference(value: unknown): string {
  if (!isReference(value)) invalid();
  return value;
}

function isReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && REFERENCE_PATTERN.test(value);
}

function uuid(value: unknown): string {
  if (!isUuid(value)) invalid();
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim();
  if (normalized === '' || normalized.length > maximum) invalid();
  return normalized;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return text(value, maximum);
}

function version(value: unknown): string {
  return reference(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUERY_ITEMS) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function identifier(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) invalid();
}

function hasToString(value: unknown): value is { toString(): string } {
  return typeof value === 'object' && value !== null && typeof value.toString === 'function';
}

function invalid(): never {
  throw new AgentSnapshotSourceError();
}
