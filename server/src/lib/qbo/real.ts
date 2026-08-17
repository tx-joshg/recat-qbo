// RealQboClient — QuickBooks Online REST API (OAuth2) implementation of QboClient.
//
// Endpoints used (all under /v3/company/{realmId}, minorversion=75):
//   GET  /companyinfo/{realmId}
//   GET  /query?query=...                      Account / Purchase / Deposit / JournalEntry
//   GET  /cdc?entities=...&changedSince=...    Change Data Capture (poll/webhook deltas)
//   GET  /purchase/{id} etc.                   fresh fetch (SyncToken)
//   POST /purchase | /deposit | /journalentry  full-payload update (category swap)
//   POST /transfer                             create a Transfer entity
//
// Token handling: refresh tokens ROTATE on every use. We refresh proactively when
// the access token is within 5 minutes of expiry, persist the rotated refresh
// token immediately via onTokensRefreshed (before any further API call), and on a
// 401 we refresh once and retry the request.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  QboAttachmentNotFoundError,
  QboAuthError,
  QboRequestTimeout,
  QboSyncTokenConflict,
  type QboAccountInfo,
  type QboAccountTxn,
  type QboAttachable,
  type QboAttachmentDownload,
  type QboAttachmentRef,
  type QboAttachmentUploadFile,
  type QboAttachmentUploadOutcome,
  type QboLogTxn,
  type QboClient,
  type QboCompanyInfo,
  type QboLineWriteResult,
  type QboLineWriteSnapshot,
  type QboLineWriteSplit,
  type QboPreparedLineWrite,
  type QboDepositSnapshot,
  type QboPreparedWrite,
  type QboPurchasePreparedWrite,
  type QboStatement,
  type QboStatementRow,
  type QboPurchaseSnapshot,
  type RawPurchase,
  type RawPurchaseLine,
  type RawDeposit,
  type RawDepositLine,
  type RawJournalEntry,
  type RawJournalEntryLine,
  type QboTaxCodeInfo,
  type QboTaxProfile,
  type QboTaxRateInfo,
  type QboTokenSet,
  type QboTxn,
  type QboTxnLine,
  type QboWriteResult,
} from './types.js';
import type { StagedCategorization } from '@recat/shared';
import { classifyIntuitOAuthBody } from './diagnostics.js';
import { moneyToCents } from '../../services/tax/model.js';
import {
  isSupportedTaxRateValue,
  preparePurchaseRecategorization as preparePurchaseRecategorizationBody,
  preparePurchaseRestore as preparePurchaseRestoreBody,
} from './purchaseTax.js';
import {
  buildPreparedLineWrite,
  hashLineWriteContent,
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
  serializeLineWriteRequest,
  validatePreparedLineWrite,
  verifyLineWriteResult,
} from './lineWrite.js';
import {
  createQboAttachmentMultipart,
  parseQboAttachable,
  parseQboAttachmentUploadResponse,
  parseSupportedQboAttachable,
} from './attachments.js';
import {
  mapDepositSnapshot as mapDepositSnapshotBody,
  prepareDepositRecategorization as prepareDepositRecategorizationBody,
  prepareDepositRestore as prepareDepositRestoreBody,
} from './depositTax.js';
import {
  QboWriteSafetyError,
  type QboWriteSafetyEvidence,
  type QboWriteSafetyTarget,
} from './writeSafety.js';

export {
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
} from './lineWrite.js';
export type {
  RawDeposit,
  RawDepositLine,
  RawJournalEntry,
  RawJournalEntryLine,
  RawPurchase,
  RawPurchaseLine,
} from './types.js';
export type QboWriteLine = QboLineWriteSplit;

const OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
// Revoke lives on the developer host, not the oauth host.
const OAUTH_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const OAUTH_SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PREPARED_WRITE_TIMEOUT_MS = 30_000;
const QBO_READ_TIMEOUT_MS = 30_000;
const QBO_DOWNLOAD_TIMEOUT_MS = 60_000;
const OAUTH_TOKEN_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** QBO query hard cap per page. */
const QUERY_PAGE_SIZE = 1000;

class QboHttpNotFoundError extends Error {
  constructor() {
    super('QuickBooks resource was not found.');
    this.name = 'QboHttpNotFoundError';
  }
}

class QboObjectNotFoundError extends Error {
  constructor(message = 'QuickBooks object was not found.') {
    super(message);
    this.name = 'QboObjectNotFoundError';
  }
}

export type QboEnvironment = 'sandbox' | 'production';

function apiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Raw QBO payload shapes (subset of fields we read/write; everything optional
// that Intuit does not guarantee).
// ---------------------------------------------------------------------------

interface QboRef {
  value: string;
  name?: string;
}

interface RawMetaData {
  LastUpdatedTime?: string;
}

interface RawAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Classification?: string; // Asset | Liability | Equity | Revenue | Expense
  AccountType?: string; // Bank | Credit Card | Cost of Goods Sold | Expense | Income | ...
  Active?: boolean;
}

export interface RawPreferences {
  TaxPrefs?: { UsingSalesTax?: boolean; PartnerTaxEnabled?: boolean };
  AccountingInfoPrefs?: { BookCloseDate?: unknown };
}

export interface RawTaxRate {
  Id: string;
  Name: string;
  Description?: string;
  Active?: boolean;
  RateValue?: number;
  MetaData?: RawMetaData;
}

export interface RawTaxCode {
  Id: string;
  Name: string;
  Description?: string;
  Active?: boolean;
  Taxable?: boolean;
  PurchaseTaxRateList?: {
    TaxRateDetail?: { TaxRateRef?: QboRef; TaxTypeApplicable?: string }[];
  };
  SalesTaxRateList?: {
    TaxRateDetail?: { TaxRateRef?: QboRef; TaxTypeApplicable?: string }[];
  };
  MetaData?: RawMetaData;
}

interface QboFaultBody {
  Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] };
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface QueryBody {
  QueryResponse?: {
    Account?: RawAccount[];
    Attachable?: unknown[];
    Preferences?: RawPreferences[];
    TaxCode?: RawTaxCode[];
    TaxRate?: RawTaxRate[];
    Purchase?: RawPurchase[];
    Deposit?: RawDeposit[];
    JournalEntry?: RawJournalEntry[];
  };
}

interface CdcBody {
  CDCResponse?: {
    QueryResponse?: {
      Purchase?: RawPurchase[];
      Deposit?: RawDeposit[];
      JournalEntry?: RawJournalEntry[];
    }[];
  }[];
}

interface CompanyInfoBody {
  CompanyInfo?: { CompanyName?: string; LegalName?: string; Country?: string };
}

interface AttachableBody {
  Attachable?: unknown;
}

// ---------------------------------------------------------------------------
// Reports API JSON (quirky: nested Rows.Row arrays, Section vs Data rows,
// Header/Summary blocks, ColData carrying value + optional entity id). Every
// field is optional — Intuit omits liberally — so parsing is fully defensive.
// ---------------------------------------------------------------------------

export interface RawReportColData {
  value?: string;
  id?: string;
}

export interface RawReportRow {
  type?: string; // 'Section' | 'Data'
  group?: string; // 'Income' | 'COGS' | 'Expenses' | 'GrossProfit' | 'NetIncome' | 'TotalAssets' | ...
  ColData?: RawReportColData[];
  Header?: { ColData?: RawReportColData[] };
  Rows?: { Row?: RawReportRow[] };
  Summary?: { ColData?: RawReportColData[] };
}

export interface RawReport {
  Columns?: { Column?: { ColTitle?: string; ColType?: string }[] };
  Rows?: { Row?: RawReportRow[] };
}

/** '1,234.56' / '-45.00' / '' / undefined → number (0 on anything unparsable). */
function reportNumber(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return 0;
  const n = Number.parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Section groups whose Summary renders as a 'grand' row (vs a plain 'total'). */
const GRAND_GROUPS = new Set([
  'GrossProfit',
  'NetIncome',
  'NetOperatingIncome',
  'NetOtherIncome',
  'TotalAssets',
  'TotalLiabilitiesAndEquity',
]);

/**
 * Parse a ProfitAndLoss / BalanceSheet report body into the normalized
 * QboStatement tree. Column 0 of every ColData array is the label column; the
 * remaining columns are money values (dollars). Mapping:
 *   Section Header  → 'head'   (indent when nested)
 *   Data row        → 'line'   (accountQboId from ColData[0].id when present)
 *   Section Summary → 'total', or 'grand' for GrossProfit/NetIncome-style
 *                     groups and top-level header-less summary sections.
 */
export function parseStatementReport(raw: RawReport): QboStatement {
  const columns = (raw.Columns?.Column ?? []).slice(1).map((c) => ({ label: c.ColTitle ?? '' }));
  const rows: QboStatementRow[] = [];

  const values = (colData: RawReportColData[] | undefined): number[] =>
    (colData ?? []).slice(1).map((c) => reportNumber(c.value));

  const walk = (list: RawReportRow[], depth: number): void => {
    for (const row of list) {
      const isSection = row.type === 'Section' || row.Header !== undefined || row.Rows !== undefined || row.Summary !== undefined;
      if (isSection) {
        const headerLabel = row.Header?.ColData?.[0]?.value;
        const hasHeader = headerLabel !== undefined && headerLabel !== '';
        if (hasHeader) {
          rows.push({ label: headerLabel, kind: 'head', indent: depth > 0, values: [] });
        }
        walk(row.Rows?.Row ?? [], hasHeader ? depth + 1 : depth);
        const summary = row.Summary?.ColData;
        if (summary && summary.length > 0) {
          const grand = GRAND_GROUPS.has(row.group ?? '') || (depth === 0 && !hasHeader && row.Rows === undefined);
          rows.push({
            label: summary[0]?.value ?? '',
            kind: grand ? 'grand' : 'total',
            indent: false,
            values: values(summary),
          });
        }
      } else if (row.ColData && row.ColData.length > 0) {
        const id = row.ColData[0]?.id;
        rows.push({
          label: row.ColData[0]?.value ?? '',
          kind: 'line',
          indent: true,
          ...(id !== undefined && id !== '' ? { accountQboId: id } : {}),
          values: values(row.ColData),
        });
      }
    }
  };
  walk(raw.Rows?.Row ?? [], 0);
  return { columns, rows };
}

/** The TransactionList columns we request, in the order we ask for them. */
const TXN_LIST_COLUMNS = 'tx_date,txn_type,name,memo,subt_nat_amount';

/**
 * Parse a /reports/TransactionList body. Column positions are resolved from
 * the report's own Columns metadata (ColType, falling back to ColTitle) —
 * never assumed — and grouped sections are flattened; Summary/GrandTotal rows
 * are ignored. The row's entity id rides on the first ColData's `id`.
 */
export function parseTransactionListReport(raw: RawReport): QboAccountTxn[] {
  const cols = raw.Columns?.Column ?? [];
  const colIndex = (type: string, titleWord: string): number => {
    const byType = cols.findIndex((c) => c.ColType === type);
    if (byType >= 0) return byType;
    return cols.findIndex((c) => (c.ColTitle ?? '').toLowerCase().includes(titleWord));
  };
  const iDate = colIndex('tx_date', 'date');
  const iType = colIndex('txn_type', 'transaction type');
  const iName = colIndex('name', 'name');
  const iMemo = colIndex('memo', 'memo');
  const iAmount = colIndex('subt_nat_amount', 'amount');
  const at = (colData: RawReportColData[], i: number): RawReportColData | undefined =>
    i >= 0 ? colData[i] : undefined;

  const out: QboAccountTxn[] = [];
  const walk = (list: RawReportRow[]): void => {
    for (const row of list) {
      if (row.Rows?.Row) walk(row.Rows.Row); // grouped section — flatten
      const colData = row.ColData;
      if (!colData || colData.length === 0 || row.type === 'Section') continue;
      const date = at(colData, iDate)?.value ?? '';
      if (date === '') continue; // summary/blank row
      const memo = at(colData, iMemo)?.value;
      out.push({
        date,
        payee: at(colData, iName)?.value ?? '',
        ...(memo !== undefined && memo !== '' ? { memo } : {}),
        amount: reportNumber(at(colData, iAmount)?.value),
        txnType: at(colData, iType)?.value ?? '',
        qboId: at(colData, iDate)?.id ?? colData[0]?.id ?? '',
      });
    }
  };
  walk(raw.Rows?.Row ?? []);
  return out;
}

function canonicalSafetyReportType(value: string | undefined): 'Purchase' | 'Deposit' | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'deposit') return 'Deposit';
  if (
    normalized === 'purchase'
    || normalized === 'expense'
    || normalized === 'check'
    || normalized === 'cheque'
    || normalized === 'credit card expense'
    || normalized === 'credit card charge'
  ) return 'Purchase';
  return null;
}

function reportContainsSafetyTarget(raw: RawReport, target: QboWriteSafetyTarget): boolean {
  const columns = raw.Columns?.Column ?? [];
  const dateIndex = columns.findIndex((column) => column.ColType === 'tx_date');
  const typeIndex = columns.findIndex((column) => column.ColType === 'txn_type');
  if (dateIndex < 0 || typeIndex < 0) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  let found = false;
  const walk = (rows: RawReportRow[]): void => {
    for (const row of rows) {
      if (row.Rows?.Row) walk(row.Rows.Row);
      if (!row.ColData || row.type === 'Section') continue;
      const date = row.ColData[dateIndex];
      if (date?.value !== target.txnDate) continue;
      const type = canonicalSafetyReportType(row.ColData[typeIndex]?.value);
      const id = date.id ?? row.ColData[0]?.id;
      if (id === target.qboId) {
        if (type !== target.qboType) {
          throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
        }
        found = true;
        continue;
      }
      if (type === target.qboType && (id === undefined || id === '')) {
        throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
      }
    }
  };
  walk(raw.Rows?.Row ?? []);
  return found;
}

function closeDate(preferences: RawPreferences | undefined): string | null {
  if (preferences?.AccountingInfoPrefs === undefined) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  const value = preferences.AccountingInfoPrefs.BookCloseDate;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  return value;
}

/** The whole-company transaction-log columns, in the order we ask for them.
 * account_name = the bank/credit-card side; other_account = QBO's "Split"
 * column, i.e. the categorization. */
const TXN_LOG_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,account_name,other_account,subt_nat_amount';

/**
 * Parse a whole-company /reports/TransactionList body (the log view). Same
 * column-resolution rules as parseTransactionListReport, plus the posting
 * account and doc number.
 */
export function parseTransactionLogReport(raw: RawReport): QboLogTxn[] {
  const cols = raw.Columns?.Column ?? [];
  const colIndex = (type: string, titleWord: string): number => {
    const byType = cols.findIndex((c) => c.ColType === type);
    if (byType >= 0) return byType;
    return cols.findIndex((c) => (c.ColTitle ?? '').toLowerCase().includes(titleWord));
  };
  const iDate = colIndex('tx_date', 'date');
  const iType = colIndex('txn_type', 'transaction type');
  const iDocNum = colIndex('doc_num', 'num');
  const iName = colIndex('name', 'name');
  const iMemo = colIndex('memo', 'memo');
  const iAccount = colIndex('account_name', 'account');
  const iCategory = colIndex('other_account', 'split');
  const iAmount = colIndex('subt_nat_amount', 'amount');
  const at = (colData: RawReportColData[], i: number): RawReportColData | undefined =>
    i >= 0 ? colData[i] : undefined;

  const out: QboLogTxn[] = [];
  const walk = (list: RawReportRow[]): void => {
    for (const row of list) {
      if (row.Rows?.Row) walk(row.Rows.Row); // grouped section — flatten
      const colData = row.ColData;
      if (!colData || colData.length === 0 || row.type === 'Section') continue;
      const date = at(colData, iDate)?.value ?? '';
      if (date === '') continue; // summary/blank row
      const memo = at(colData, iMemo)?.value;
      const docNum = at(colData, iDocNum)?.value;
      out.push({
        date,
        txnType: at(colData, iType)?.value ?? '',
        ...(docNum !== undefined && docNum !== '' ? { docNum } : {}),
        payee: at(colData, iName)?.value ?? '',
        ...(memo !== undefined && memo !== '' ? { memo } : {}),
        account: at(colData, iAccount)?.value ?? '',
        category: at(colData, iCategory)?.value ?? '',
        amount: reportNumber(at(colData, iAmount)?.value),
        ...((): { qboId?: string } => {
          const id = at(colData, iDate)?.id ?? colData[0]?.id;
          return id !== undefined && id !== '' ? { qboId: id } : {};
        })(),
      });
    }
  };
  walk(raw.Rows?.Row ?? []);
  return out;
}

// ---------------------------------------------------------------------------
// Entity → QboTxn mapping
// ---------------------------------------------------------------------------

/** Map QBO Classification/AccountType onto our normalized buckets. */
function normalizeClassification(accountType: string | undefined, classification: string | undefined): string {
  // AccountType is more specific than Classification — check it first so Bank
  // and Credit Card don't collapse into Asset/Liability.
  switch (accountType) {
    case 'Bank':
      return 'Bank';
    case 'Credit Card':
      return 'CreditCard';
    case 'Cost of Goods Sold':
      return 'COGS';
    case 'Income':
    case 'Other Income':
      return 'Income';
    case 'Expense':
    case 'Other Expense':
      return 'Expenses';
    default:
      break;
  }
  switch (classification) {
    case 'Revenue':
      return 'Income';
    case 'Expense':
      return 'Expenses';
    case 'Asset':
      return 'Asset';
    case 'Liability':
      return 'Liability';
    case 'Equity':
      return 'Equity';
    default:
      return 'Other';
  }
}

function mapAccount(raw: RawAccount): QboAccountInfo {
  return {
    qboId: raw.Id,
    name: raw.Name,
    fullName: raw.FullyQualifiedName ?? raw.Name,
    classification: normalizeClassification(raw.AccountType, raw.Classification),
    accountType: raw.AccountType ?? '',
    active: raw.Active !== false,
  };
}

function requiredTaxIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Malformed QuickBooks tax ${field}.`);
  }
  return value;
}

function activeOrDefault(value: unknown, entity: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error(`Malformed QuickBooks ${entity} Active value.`);
  }
  return value;
}

export function mapTaxProfile(raw: RawPreferences | undefined): QboTaxProfile {
  return {
    usingSalesTax: typeof raw?.TaxPrefs?.UsingSalesTax === 'boolean' ? raw.TaxPrefs.UsingSalesTax : null,
    partnerTaxEnabled: typeof raw?.TaxPrefs?.PartnerTaxEnabled === 'boolean' ? raw.TaxPrefs.PartnerTaxEnabled : null,
  };
}

function sourceUpdatedAt(metadata: RawMetaData | undefined): string | null {
  const value: unknown = metadata?.LastUpdatedTime;
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Malformed QuickBooks source timestamp.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Malformed QuickBooks source timestamp.');
  return new Date(timestamp).toISOString();
}

export function mapTaxRate(raw: RawTaxRate): QboTaxRateInfo {
  return {
    qboId: requiredTaxIdentity(raw.Id, 'rate Id'),
    name: raw.Name,
    description: raw.Description ?? null,
    active: activeOrDefault(raw.Active, 'tax-rate'),
    rateValue: isSupportedTaxRateValue(raw.RateValue) ? raw.RateValue : null,
    sourceUpdatedAt: sourceUpdatedAt(raw.MetaData),
  };
}

export function mapTaxCode(raw: RawTaxCode): QboTaxCodeInfo {
  const mapRates = (
    details: { TaxRateRef?: QboRef; TaxTypeApplicable?: string }[] | undefined,
    direction: 'purchase' | 'sales',
  ) => (details ?? []).map((detail) => ({
    taxRateQboId: requiredTaxIdentity(detail.TaxRateRef?.value, `${direction} rate reference`),
    taxTypeApplicable: requiredTaxIdentity(detail.TaxTypeApplicable, 'component type'),
  }));
  return {
    qboId: requiredTaxIdentity(raw.Id, 'code Id'),
    name: raw.Name,
    description: raw.Description ?? null,
    active: activeOrDefault(raw.Active, 'tax-code'),
    taxable: typeof raw.Taxable === 'boolean' ? raw.Taxable : null,
    purchaseRates: mapRates(raw.PurchaseTaxRateList?.TaxRateDetail, 'purchase'),
    salesRates: mapRates(raw.SalesTaxRateList?.TaxRateDetail, 'sales'),
    sourceUpdatedAt: sourceUpdatedAt(raw.MetaData),
  };
}

export function mapPurchaseSnapshot(raw: RawPurchase): QboPurchaseSnapshot {
  const direction = raw.Credit === true ? 'refund' : 'purchase';
  const signedCents = (amount: number): number => {
    const cents = moneyToCents(amount);
    if (cents === 0) return 0;
    return direction === 'refund' ? Math.abs(cents) : -Math.abs(cents);
  };
  const lines = (raw.Line ?? []).map((line) => {
    const detail = line.AccountBasedExpenseLineDetail;
    const amountCents = signedCents(line.Amount ?? 0);
    const taxInclusiveCents = detail?.TaxInclusiveAmt === undefined
      ? null
      : signedCents(detail.TaxInclusiveAmt);
    const taxAmountCents = detail?.TaxAmount === undefined
      ? raw.GlobalTaxCalculation === 'TaxInclusive' && taxInclusiveCents !== null
        ? taxInclusiveCents - amountCents
        : null
      : signedCents(detail.TaxAmount);
    return {
      id: line.Id ?? null,
      amountCents,
      description: line.Description ?? null,
      accountQboId: detail?.AccountRef?.value ?? null,
      customerQboId: detail?.CustomerRef?.value ?? null,
      classQboId: detail?.ClassRef?.value ?? null,
      taxCodeQboId: detail?.TaxCodeRef?.value ?? null,
      taxAmountCents,
      taxInclusiveCents,
    };
  });
  const derivedTotalTaxCents = lines.reduce<number | null>((sum, line) => {
    if (sum === null) return null;
    if (line.taxAmountCents !== null) return sum + line.taxAmountCents;
    return line.taxCodeQboId === null ? sum : null;
  }, 0);
  return {
    qboId: raw.Id,
    syncToken: raw.SyncToken,
    totalCents: signedCents(raw.TotalAmt ?? 0),
    accountQboId: raw.AccountRef?.value ?? null,
    date: raw.TxnDate ?? '',
    direction,
    globalTaxCalculation: raw.GlobalTaxCalculation ?? null,
    totalTaxCents: raw.TxnTaxDetail?.TotalTax === undefined
      ? raw.GlobalTaxCalculation !== undefined
        ? derivedTotalTaxCents
        : null
      : signedCents(raw.TxnTaxDetail.TotalTax),
    lines,
  };
}

export function mapDepositSnapshot(raw: RawDeposit): QboDepositSnapshot {
  return mapDepositSnapshotBody(raw);
}

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v && v.trim().length > 0) return v.trim();
  return undefined;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function attachableDownloadUri(value: unknown): string | null {
  const raw = runtimeRecord(value);
  if (typeof raw?.TempDownloadUri !== 'string') return null;
  try {
    const url = new URL(raw.TempDownloadUri);
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function* responseBodyChunks(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * QboTxn.lines is defined as ONLY the lines posting to holding accounts (the
 * lines recategorize will replace) — never the bank/funding side and never
 * already-categorized lines. QboTxn.amount is the signed sum of those holding
 * lines, NOT TotalAmt, so splits validated against it always rebuild the
 * entity to the same total.
 */
export function mapPurchase(raw: RawPurchase, holdingIds: ReadonlySet<string>): QboTxn {
  const holdingLines: QboTxnLine[] = (raw.Line ?? [])
    .filter((l) => {
      const id = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
      return id !== undefined && holdingIds.has(id);
    })
    .map((l, i) => ({
      id: l.Id ?? String(i + 1),
      amount: l.Amount ?? 0,
      accountQboId: l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? '',
      accountName: l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '',
      memo: l.Description,
    }));
  const total = holdingLines.reduce((a, l) => a + l.amount, 0);
  return {
    qboId: raw.Id,
    qboType: 'Purchase',
    syncToken: raw.SyncToken,
    date: raw.TxnDate ?? '',
    // Payee fallbacks: named vendor → doc number → memo → payment type.
    payee: firstNonEmpty(raw.EntityRef?.name, raw.DocNumber, raw.PrivateNote, raw.PaymentType) ?? 'Purchase',
    memo: raw.PrivateNote,
    // Purchase = money out (negative), unless it's a credit/refund.
    amount: raw.Credit === true ? round2(total) : -round2(total),
    bankAccount: raw.AccountRef?.name ?? '',
    lines: holdingLines,
    raw,
  };
}

export function mapDeposit(raw: RawDeposit, holdingIds: ReadonlySet<string>): QboTxn {
  const holdingRawLines = (raw.Line ?? []).filter((l) => {
    const id = l.DepositLineDetail?.AccountRef?.value;
    return id !== undefined && holdingIds.has(id);
  });
  const holdingLines: QboTxnLine[] = holdingRawLines.map((l, i) => ({
    id: l.Id ?? String(i + 1),
    amount: l.Amount ?? 0,
    accountQboId: l.DepositLineDetail?.AccountRef?.value ?? '',
    accountName: l.DepositLineDetail?.AccountRef?.name ?? '',
    memo: l.Description,
  }));
  const total = holdingLines.reduce((a, l) => a + l.amount, 0);
  return {
    qboId: raw.Id,
    qboType: 'Deposit',
    syncToken: raw.SyncToken,
    date: raw.TxnDate ?? '',
    payee:
      firstNonEmpty(
        holdingRawLines[0]?.DepositLineDetail?.Entity?.name,
        raw.PrivateNote,
        holdingRawLines[0]?.Description,
        raw.DocNumber,
      ) ?? 'Deposit',
    memo: raw.PrivateNote,
    amount: round2(total), // money in
    bankAccount: raw.DepositToAccountRef?.name ?? '',
    lines: holdingLines,
    raw,
  };
}

/**
 * Journal entries: we treat the Debit side as the categorizable side (the
 * common shape for an expense parked in a holding account: debit holding,
 * credit bank). A JE that *credits* the holding account is a documented v1
 * limitation — it will not be picked up by the holding-account filter.
 */
export function mapJournalEntry(raw: RawJournalEntry, holdingIds: ReadonlySet<string>): QboTxn {
  const all = raw.Line ?? [];
  const holdingDebits = all.filter((l) => {
    const detail = l.JournalEntryLineDetail;
    return detail?.PostingType === 'Debit' && detail.AccountRef?.value !== undefined && holdingIds.has(detail.AccountRef.value);
  });
  const credits = all.filter((l) => l.JournalEntryLineDetail?.PostingType === 'Credit');
  const holdingLines: QboTxnLine[] = holdingDebits.map((l, i) => ({
    id: l.Id ?? String(i + 1),
    amount: l.Amount ?? 0,
    accountQboId: l.JournalEntryLineDetail?.AccountRef?.value ?? '',
    accountName: l.JournalEntryLineDetail?.AccountRef?.name ?? '',
    memo: l.Description,
  }));
  const total = holdingLines.reduce((a, l) => a + l.amount, 0);
  return {
    qboId: raw.Id,
    qboType: 'JournalEntry',
    syncToken: raw.SyncToken,
    date: raw.TxnDate ?? '',
    payee: firstNonEmpty(holdingDebits[0]?.Description, raw.PrivateNote, raw.DocNumber) ?? 'Journal entry',
    memo: raw.PrivateNote,
    amount: -round2(total), // debit-to-holding = money out
    bankAccount: credits[0]?.JournalEntryLineDetail?.AccountRef?.name ?? '',
    lines: holdingLines,
    raw,
  };
}

/** Sum (positive) of the raw category-detail lines posting to `accountIds`. */
export function sumLinesPostingTo(txn: QboTxn, accountIds: ReadonlySet<string>): number {
  if (txn.qboType === 'Purchase') {
    const raw = txn.raw as RawPurchase;
    return round2(
      (raw.Line ?? []).reduce((acc, l) => {
        const id = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
        return id !== undefined && accountIds.has(id) ? acc + (l.Amount ?? 0) : acc;
      }, 0),
    );
  }
  if (txn.qboType === 'Deposit') {
    const raw = txn.raw as RawDeposit;
    return round2(
      (raw.Line ?? []).reduce((acc, l) => {
        const id = l.DepositLineDetail?.AccountRef?.value;
        return id !== undefined && accountIds.has(id) ? acc + (l.Amount ?? 0) : acc;
      }, 0),
    );
  }
  const raw = txn.raw as RawJournalEntry;
  return round2(
    (raw.Line ?? []).reduce((acc, l) => {
      const detail = l.JournalEntryLineDetail;
      const id = detail?.AccountRef?.value;
      return detail?.PostingType === 'Debit' && id !== undefined && accountIds.has(id) ? acc + (l.Amount ?? 0) : acc;
    }, 0),
  );
}

// ---------------------------------------------------------------------------
// OAuth helpers (used by the factory)
// ---------------------------------------------------------------------------

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

export function intuitAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(clientId: string, clientSecret: string, body: URLSearchParams): Promise<QboTokenSet> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OAUTH_TOKEN_TIMEOUT_MS,
  );
  const request: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: controller.signal,
  };
  try {
    let res: Response;
    try {
      res = await fetch(OAUTH_TOKEN_URL, request);
    } catch {
      throw new QboAuthError(
        'Intuit token request was unavailable',
        'INTUIT_UNAVAILABLE',
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 4096);
      const reason = classifyIntuitOAuthBody(res.status, detail);
      throw new QboAuthError(`Intuit token request failed (${res.status})`, reason);
    }
    try {
      const json = (await res.json()) as OAuthTokenResponse;
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      };
    } catch {
      throw new QboAuthError(
        'Intuit token response was invalid',
        'INTUIT_UNAVAILABLE',
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function exchangeAuthCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<QboTokenSet> {
  return tokenRequest(
    args.clientId,
    args.clientSecret,
    new URLSearchParams({ grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri }),
  );
}

export async function refreshTokenGrant(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<QboTokenSet> {
  return tokenRequest(
    args.clientId,
    args.clientSecret,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: args.refreshToken }),
  );
}

/** Best-effort revoke; never throws. */
export async function revokeIntuitToken(args: { clientId: string; clientSecret: string; token: string }): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  try {
    await fetch(OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth(args.clientId, args.clientSecret)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: args.token }),
      signal: controller.signal,
    });
  } catch {
    // best effort — a failed revoke must not block disconnect
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RealQboClientOptions {
  realmId: string;
  environment: QboEnvironment;
  clientId: string;
  clientSecret: string;
  tokens: QboTokenSet;
  /** The company's watched holding-account QBO ids — the line filter for reads and writes. */
  holdingAccountQboIds: string[];
  /** MUST persist the rotated refresh token immediately (QBO rotates it on use). */
  onTokensRefreshed: (tokens: QboTokenSet) => Promise<void>;
}

export class RealQboClient implements QboClient {
  readonly realmId: string;
  private readonly base: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly holdingIds: ReadonlySet<string>;
  private tokens: QboTokenSet;
  private readonly onTokensRefreshed: (tokens: QboTokenSet) => Promise<void>;
  private refreshing: Promise<void> | null = null;

  constructor(opts: RealQboClientOptions) {
    this.realmId = opts.realmId;
    this.base = `${apiBase(opts.environment)}/v3/company/${encodeURIComponent(opts.realmId)}`;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.holdingIds = new Set(opts.holdingAccountQboIds);
    this.tokens = opts.tokens;
    this.onTokensRefreshed = opts.onTokensRefreshed;
  }

  // ---- token lifecycle ----

  private async ensureFreshToken(): Promise<string> {
    if (this.tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  /** Deduped refresh: concurrent callers share one in-flight rotation. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    this.tokens = await refreshTokenGrant({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.tokens.refreshToken,
    });
    // Persist BEFORE any further API call — losing a rotated refresh token
    // strands the connection until the admin reconnects.
    await this.onTokensRefreshed(this.tokens);
  }

  // ---- HTTP ----

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retried = false,
    signal?: AbortSignal,
  ): Promise<T> {
    const accessToken = await this.ensureFreshToken();
    if (signal?.aborted) throw abortedRequest();
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, QBO_READ_TIMEOUT_MS);
    const requestSignal = controller.signal;
    const sep = path.includes('?') ? '&' : '?';
    try {
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}${sep}minorversion=${MINOR_VERSION}`, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: requestSignal,
        });
      } catch (error) {
        if (method === 'POST' || timedOut) {
          throw new QboRequestTimeout('QuickBooks did not confirm the request.');
        }
        if (signal?.aborted) throw abortedRequest();
        throw error;
      }
      if (res.status === 401 && !retried) {
        // Access token invalidated server-side: refresh once and retry.
        await this.refresh();
        return this.request<T>(method, path, body, true, signal);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        if (method === 'POST' || timedOut) {
          throw new QboRequestTimeout('QuickBooks did not confirm the request.');
        }
        if (signal?.aborted) throw abortedRequest();
        throw error;
      }
      if (!res.ok) {
        if (method === 'POST' && res.status >= 500) {
          throw new QboRequestTimeout('QuickBooks did not confirm the request.');
        }
        throw this.toError(res.status, text);
      }
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        if (method === 'POST') {
          throw new QboRequestTimeout('QuickBooks did not confirm the request.');
        }
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /**
   * Prepared mutations are already the durable retry unit. Send their exact
   * body once and surface an ambiguous timeout to the lifecycle caller.
   */
  private async requestPreparedBody(
    path: string,
    requestId: string,
    body: Record<string, unknown> | string,
    beforeSend?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    const accessToken = await this.ensureFreshToken();
    await beforeSend?.();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PREPARED_WRITE_TIMEOUT_MS,
    );
    try {
      const res = await fetch(
        `${this.base}${path}?requestid=${encodeURIComponent(requestId)}&minorversion=${MINOR_VERSION}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: bodyText,
          signal: controller.signal,
        },
      );
      const text = await res.text();
      if (!res.ok) throw this.toError(res.status, text);
      const parsed: unknown = text ? JSON.parse(text) : {};
      return typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch (error) {
      const cause = error instanceof Error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;
      const causeCode =
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        typeof cause.code === 'string'
          ? cause.code
          : '';
      if (
        controller.signal.aborted ||
        (error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
        (error instanceof TypeError && causeCode.includes('TIMEOUT'))
      ) {
        throw new QboRequestTimeout();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestAttachmentUpload(
    ref: QboAttachmentRef,
    files: QboAttachmentUploadFile[],
    requestId: string,
    retried = false,
  ): Promise<QboAttachmentUploadOutcome[]> {
    const multipart = createQboAttachmentMultipart(ref, files, requestId);
    const accessToken = await this.ensureFreshToken();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PREPARED_WRITE_TIMEOUT_MS,
    );
    let sendBegan = false;
    const trackedBody = async function* () {
      for await (const chunk of multipart.openStream()) {
        sendBegan = true;
        yield chunk;
      }
    };
    let response: Response;
    try {
      try {
        response = await fetch(
          `${this.base}/upload?requestid=${encodeURIComponent(requestId)}&minorversion=${MINOR_VERSION}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': multipart.contentType,
              'Content-Length': String(multipart.contentLength),
            },
            body: Readable.from(trackedBody()) as unknown as BodyInit,
            signal: controller.signal,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' },
        );
      } catch (error) {
        if (sendBegan || controller.signal.aborted) {
          throw new QboRequestTimeout(
            'QuickBooks did not confirm the attachment upload.',
          );
        }
        throw error;
      }
      if (response.status === 401 && !retried && !sendBegan) {
        await response.body?.cancel().catch(() => undefined);
        await this.refresh();
        return this.requestAttachmentUpload(ref, files, requestId, true);
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new QboRequestTimeout(
          'QuickBooks did not confirm the attachment upload.',
        );
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          throw this.toError(response.status, text);
        }
        throw new QboRequestTimeout(
          'QuickBooks did not confirm the attachment upload.',
        );
      }
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        return parseQboAttachmentUploadResponse(
          parsed,
          files.map((file) => file.ordinal),
        );
      } catch {
        throw new QboRequestTimeout(
          'QuickBooks did not confirm the attachment upload.',
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestPreparedWrite(
    prepared: QboPreparedWrite,
  ): Promise<{ Purchase?: RawPurchase; Deposit?: RawDeposit }> {
    return this.requestPreparedBody(
      `/${entityPath(prepared.qboType)}`,
      prepared.requestId,
      prepared.body,
    ) as Promise<{ Purchase?: RawPurchase; Deposit?: RawDeposit }>;
  }

  private toError(status: number, bodyText: string): Error {
    let fault: QboFaultBody = {};
    try {
      fault = JSON.parse(bodyText) as QboFaultBody;
    } catch {
      // non-JSON error body
    }
    const errors = fault.Fault?.Error ?? [];
    const first = errors[0];
    // 5010 = "Stale Object Error": the entity was edited after our read.
    if (errors.some((e) => e.code === '5010')) return new QboSyncTokenConflict();
    // 610 is QBO's application-level not-found response. It is commonly
    // returned as HTTP 400 when a referenced object has been made inactive.
    if (errors.some((e) => e.code === '610')) {
      return new QboObjectNotFoundError(
        firstNonEmpty(first?.Detail, first?.Message)
          ?? 'QuickBooks object was not found.',
      );
    }
    if (status === 404) return new QboHttpNotFoundError();
    if (status === 401 || status === 403) {
      return new QboAuthError(first?.Message ?? `QuickBooks auth error (${status})`);
    }
    const message = firstNonEmpty(first?.Detail, first?.Message) ?? `QuickBooks API error (${status})`;
    return new Error(message);
  }

  private async query<T extends keyof NonNullable<QueryBody['QueryResponse']>>(
    statement: string,
    entity: T,
  ): Promise<NonNullable<NonNullable<QueryBody['QueryResponse']>[T]>> {
    const body = await this.request<QueryBody>('GET', `/query?query=${encodeURIComponent(statement)}`);
    const list = body.QueryResponse?.[entity];
    return (list ?? []) as NonNullable<NonNullable<QueryBody['QueryResponse']>[T]>;
  }

  /**
   * Page STARTPOSITION/MAXRESULTS until exhausted. Any failed page fetch
   * throws (via request), so callers never receive a silently truncated list —
   * critical for SUPERSEDED detection, which infers deletion from absence.
   */
  private async queryAll<T extends keyof NonNullable<QueryBody['QueryResponse']>>(
    baseStatement: string,
    entity: T,
  ): Promise<NonNullable<NonNullable<QueryBody['QueryResponse']>[T]>> {
    const out: unknown[] = [];
    let start = 1;
    for (;;) {
      const page = await this.query(`${baseStatement} startposition ${start} maxresults ${QUERY_PAGE_SIZE}`, entity);
      out.push(...page);
      if (page.length < QUERY_PAGE_SIZE) {
        return out as NonNullable<NonNullable<QueryBody['QueryResponse']>[T]>;
      }
      start += QUERY_PAGE_SIZE;
    }
  }

  // ---- QboClient ----

  async getCompanyInfo(): Promise<QboCompanyInfo> {
    const body = await this.request<CompanyInfoBody>('GET', `/companyinfo/${encodeURIComponent(this.realmId)}`);
    return {
      realmId: this.realmId,
      legalName: firstNonEmpty(body.CompanyInfo?.LegalName, body.CompanyInfo?.CompanyName) ?? this.realmId,
      country: firstNonEmpty(body.CompanyInfo?.Country) ?? null,
    };
  }

  async listAccounts(): Promise<QboAccountInfo[]> {
    const rows = await this.queryAll('select * from Account', 'Account');
    return rows.map(mapAccount);
  }

  async getTaxProfile(): Promise<QboTaxProfile> {
    const rows = await this.queryAll('select * from Preferences', 'Preferences');
    return mapTaxProfile(rows[0]);
  }

  async fetchWriteSafety(target: QboWriteSafetyTarget): Promise<QboWriteSafetyEvidence> {
    if (
      (target.qboType !== 'Purchase' && target.qboType !== 'Deposit')
      || target.qboId.trim() === ''
      || target.bankAccountQboId.trim() === ''
      || !/^\d{4}-\d{2}-\d{2}$/u.test(target.txnDate)
    ) throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');

    try {
      const query = (status: 'Cleared' | 'Reconciled') => {
        const params = new URLSearchParams({
          start_date: target.txnDate,
          end_date: target.txnDate,
          account: target.bankAccountQboId,
          cleared: status,
          columns: 'tx_date,txn_type',
        });
        return this.request<RawReport>('GET', `/reports/TransactionList?${params.toString()}`);
      };
      const [preferences, cleared, reconciled] = await Promise.all([
        this.queryAll('select * from Preferences', 'Preferences'),
        query('Cleared'),
        query('Reconciled'),
      ]);
      if (preferences.length !== 1) {
        throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
      }
      return {
        bookCloseDate: closeDate(preferences[0]),
        cleared: reportContainsSafetyTarget(cleared, target),
        reconciled: reportContainsSafetyTarget(reconciled, target),
      };
    } catch (error) {
      if (error instanceof QboWriteSafetyError) throw error;
      throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
    }
  }

  async listTaxCodes(): Promise<QboTaxCodeInfo[]> {
    const rows = await this.queryAll('select * from TaxCode', 'TaxCode');
    return rows.map(mapTaxCode);
  }

  async listTaxRates(): Promise<QboTaxRateInfo[]> {
    const rows = await this.queryAll('select * from TaxRate', 'TaxRate');
    return rows.map(mapTaxRate);
  }

  async uploadAttachments(
    ref: QboAttachmentRef,
    files: QboAttachmentUploadFile[],
    requestId: string,
  ): Promise<QboAttachmentUploadOutcome[]> {
    return this.requestAttachmentUpload(ref, files, requestId);
  }

  async listAttachments(ref: QboAttachmentRef): Promise<QboAttachable[]> {
    const rows = await this.queryAll('select * from Attachable', 'Attachable');
    return rows
      .map((row) => parseSupportedQboAttachable(row))
      .filter((attachment): attachment is QboAttachable =>
        attachment !== null)
      .filter((attachment) =>
        attachment.refs.some(
          (candidate) =>
            candidate.qboType === ref.qboType
            && candidate.qboId === ref.qboId,
        ));
  }

  private async getRawAttachment(id: string): Promise<{
    attachment: QboAttachable;
    raw: unknown;
  } | null> {
    try {
      const body = await this.request<AttachableBody>(
        'GET',
        `/attachable/${encodeURIComponent(id)}`,
      );
      if (body.Attachable === undefined) return null;
      return {
        attachment: parseQboAttachable(body.Attachable),
        raw: body.Attachable,
      };
    } catch (error) {
      if (
        error instanceof QboHttpNotFoundError
        || error instanceof QboObjectNotFoundError
      ) {
        return null;
      }
      throw error;
    }
  }

  async getAttachment(id: string): Promise<QboAttachable | null> {
    return (await this.getRawAttachment(id))?.attachment ?? null;
  }

  async openAttachmentDownload(id: string): Promise<QboAttachmentDownload> {
    const current = await this.getRawAttachment(id);
    if (!current) throw new QboAttachmentNotFoundError();
    const downloadUri = attachableDownloadUri(current.raw);
    if (!downloadUri) {
      throw new Error(
        'QuickBooks attachment download information was unavailable.',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      QBO_DOWNLOAD_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(downloadUri, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new QboRequestTimeout('QuickBooks attachment download timed out.');
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      clearTimeout(timeout);
      if (response.status === 404) {
        throw new QboAttachmentNotFoundError();
      }
      throw this.toError(response.status, text);
    }
    if (!response.body) {
      clearTimeout(timeout);
      throw new Error('QuickBooks attachment download was empty.');
    }
    const lengthText = response.headers.get('content-length');
    const parsedLength =
      lengthText !== null && /^(0|[1-9]\d*)$/u.test(lengthText)
        ? Number(lengthText)
        : null;
    return {
      contentType:
        response.headers.get('content-type') ?? current.attachment.contentType,
      sizeBytes:
        parsedLength !== null
        && Number.isSafeInteger(parsedLength)
        && parsedLength >= 0
          ? parsedLength
          : null,
      body: (async function* () {
        try {
          yield* responseBodyChunks(response.body!);
        } catch (error) {
          if (controller.signal.aborted) {
            throw new QboRequestTimeout(
              'QuickBooks attachment download timed out.',
            );
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      })(),
    };
  }

  async deleteAttachment(input: {
    id: string;
    syncToken: string;
    requestId: string;
  }): Promise<void> {
    const current = await this.getRawAttachment(input.id);
    if (!current) throw new Error('QuickBooks attachment was not found.');
    if (current.attachment.syncToken !== input.syncToken) {
      throw new QboSyncTokenConflict();
    }
    await this.request<AttachableBody>(
      'POST',
      `/attachable?operation=delete&requestid=${encodeURIComponent(input.requestId)}`,
      { Id: input.id, SyncToken: input.syncToken },
    );
  }

  async fetchPurchaseSnapshot(
    qboId: string,
    signal?: AbortSignal,
  ): Promise<QboPurchaseSnapshot | null> {
    try {
      const body = await abortableRequest(
        this.request<{ Purchase?: RawPurchase }>(
          'GET',
          `/purchase/${encodeURIComponent(qboId)}`,
          undefined,
          false,
          signal,
        ),
        signal,
      );
      return body.Purchase ? mapPurchaseSnapshot(body.Purchase) : null;
    } catch (err) {
      if (
        err instanceof QboObjectNotFoundError
        || (err instanceof Error && /not\s*found/i.test(err.message))
      ) return null;
      throw err;
    }
  }

  async fetchPreparedSnapshot(
    qboType: 'Purchase' | 'Deposit',
    qboId: string,
    signal?: AbortSignal,
  ): Promise<QboPurchaseSnapshot | QboDepositSnapshot | null> {
    if (qboType === 'Purchase') return this.fetchPurchaseSnapshot(qboId, signal);
    try {
      if (qboType === 'Deposit') {
        const body = await abortableRequest(
          this.request<{ Deposit?: RawDeposit }>(
            'GET',
            `/deposit/${encodeURIComponent(qboId)}`,
            undefined,
            false,
            signal,
          ),
          signal,
        );
        return body.Deposit ? mapDepositSnapshot(body.Deposit) : null;
      }
      throw new Error('Prepared snapshots support Purchase and Deposit transactions only.');
    } catch (err) {
      if (
        err instanceof QboObjectNotFoundError
        || (err instanceof Error && /not\s*found/i.test(err.message))
      ) return null;
      throw err;
    }
  }

  async fetchLineWriteSnapshot(
    qboType: QboTxn['qboType'],
    qboId: string,
  ): Promise<QboLineWriteSnapshot | null> {
    const txn = await this.fetchTxn(qboType, qboId);
    if (!txn) return null;
    return {
      qboType,
      qboId: txn.qboId,
      syncToken: txn.syncToken,
      contentHash: hashLineWriteContent(txn.raw),
    };
  }

  async prepareRecategorization(
    txn: QboTxn,
    staged: StagedCategorization,
    before: QboPurchaseSnapshot | QboDepositSnapshot,
    requestId: string,
  ): Promise<QboPreparedWrite> {
    if (txn.qboType === 'Purchase' && 'accountQboId' in before) {
      return preparePurchaseRecategorizationBody({
        current: txn.raw as RawPurchase,
        holdingAccountQboIds: [...this.holdingIds],
        staged,
        before,
        requestId,
      });
    }
    if (txn.qboType === 'Deposit' && 'depositToAccountQboId' in before) {
      return prepareDepositRecategorizationBody({
        current: txn.raw as RawDeposit,
        holdingAccountQboIds: [...this.holdingIds],
        staged,
        before,
        requestId,
      });
    }
    throw new Error('Prepared writes require a matching Purchase or Deposit snapshot.');
  }

  async preparePurchaseRecategorization(
    txn: QboTxn,
    staged: StagedCategorization,
    before: QboPurchaseSnapshot,
    requestId: string,
  ): Promise<QboPurchasePreparedWrite> {
    if (txn.qboType !== 'Purchase' || !('accountQboId' in before)) {
      throw new Error('Purchase compatibility recategorization requires a Purchase transaction.');
    }
    const prepared = await this.prepareRecategorization(
      txn,
      staged,
      before,
      requestId,
    );
    if (prepared.qboType !== 'Purchase') {
      throw new Error('Purchase compatibility recategorization returned a non-Purchase write.');
    }
    return prepared;
  }

  async sendPreparedWrite(prepared: QboPreparedWrite): Promise<QboWriteResult> {
    const response = await this.requestPreparedWrite(prepared);
    const responseEntity =
      prepared.qboType === 'Purchase' ? response.Purchase : response.Deposit;
    if (typeof responseEntity?.SyncToken !== 'string' || responseEntity.SyncToken.trim() === '') {
      throw new Error(
        `QuickBooks prepared write response omitted the updated ${prepared.qboType} SyncToken.`,
      );
    }
    return {
      ok: true,
      newSyncToken: responseEntity.SyncToken,
    };
  }

  async prepareLineRecategorization(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
    requestId: string,
  ): Promise<QboPreparedLineWrite> {
    return buildPreparedLineWrite({
      txn,
      splits,
      requestId,
      holdingAccountQboIds: [...this.holdingIds],
    });
  }

  async sendPreparedLineWrite(
    preparedValue: QboPreparedLineWrite,
    beforeSend?: () => Promise<void>,
  ): Promise<QboLineWriteResult> {
    const prepared = structuredClone(validatePreparedLineWrite(preparedValue));
    const bodyText = serializeLineWriteRequest(prepared.body);
    const response = await this.requestPreparedBody(
      `/${entityPath(prepared.qboType)}`,
      prepared.requestId,
      bodyText,
      beforeSend,
    );
    const raw = response[prepared.qboType];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        `QuickBooks prepared ${prepared.qboType} response omitted the updated entity.`,
      );
    }
    const record = raw as Record<string, unknown>;
    if (
      typeof record.Id !== 'string' ||
      record.Id.trim() === '' ||
      typeof record.SyncToken !== 'string' ||
      record.SyncToken.trim() === ''
    ) {
      throw new Error(
        `QuickBooks prepared ${prepared.qboType} response omitted its identity metadata.`,
      );
    }
    return verifyLineWriteResult(prepared, {
      qboType: prepared.qboType,
      qboId: record.Id,
      syncToken: record.SyncToken,
      contentHash: hashLineWriteContent(record),
    });
  }

  async prepareRestore(
    txn: QboTxn,
    prepared: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPreparedWrite> {
    if (txn.qboType === 'Purchase' && prepared.qboType === 'Purchase') {
      return preparePurchaseRestoreBody({
        current: txn.raw as RawPurchase,
        prepared,
        requestId,
      });
    }
    if (txn.qboType === 'Deposit' && prepared.qboType === 'Deposit') {
      return prepareDepositRestoreBody({
        current: txn.raw as RawDeposit,
        prepared,
        requestId,
      });
    }
    throw new Error('Prepared restore requires matching Purchase or Deposit transactions.');
  }

  async preparePurchaseRestore(
    txn: QboTxn,
    prepared: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPurchasePreparedWrite> {
    if (txn.qboType !== 'Purchase' || prepared.qboType !== 'Purchase') {
      throw new Error(
        'Purchase compatibility restore requires a Purchase transaction and prepared write.',
      );
    }
    const restore = await this.prepareRestore(
      txn,
      prepared,
      requestId,
    );
    if (restore.qboType !== 'Purchase') {
      throw new Error('Purchase compatibility restore returned a non-Purchase write.');
    }
    return restore;
  }

  async listTxnsInAccounts(accountQboIds: string[]): Promise<QboTxn[]> {
    // QBO's query dialect cannot reliably filter Purchase/Deposit/JournalEntry
    // by line-level AccountRef, so we pull the entities and filter locally.
    const [purchases, deposits, journals] = await Promise.all([
      this.queryAll('select * from Purchase', 'Purchase'),
      this.queryAll('select * from Deposit', 'Deposit'),
      this.queryAll('select * from JournalEntry', 'JournalEntry'),
    ]);
    // The caller's ids (not the client's holding set) are the line filter here,
    // so the setup wizard can probe candidate holding accounts.
    const ids = new Set(accountQboIds);
    const all = [
      ...purchases.map((p) => mapPurchase(p, ids)),
      ...deposits.map((d) => mapDeposit(d, ids)),
      ...journals.map((j) => mapJournalEntry(j, ids)),
    ];
    return all.filter((t) => t.lines.length > 0);
  }

  async changedSince(isoTimestamp: string): Promise<{ txns: QboTxn[]; deletedQboIds: { qboType: string; qboId: string }[] }> {
    const body = await this.request<CdcBody>(
      'GET',
      `/cdc?entities=Purchase,Deposit,JournalEntry&changedSince=${encodeURIComponent(isoTimestamp)}`,
    );
    const txns: QboTxn[] = [];
    const deletedQboIds: { qboType: string; qboId: string }[] = [];
    for (const block of body.CDCResponse ?? []) {
      for (const qr of block.QueryResponse ?? []) {
        for (const p of qr.Purchase ?? []) {
          if (p.status === 'Deleted') deletedQboIds.push({ qboType: 'Purchase', qboId: p.Id });
          else txns.push(mapPurchase(p, this.holdingIds));
        }
        for (const d of qr.Deposit ?? []) {
          if (d.status === 'Deleted') deletedQboIds.push({ qboType: 'Deposit', qboId: d.Id });
          else txns.push(mapDeposit(d, this.holdingIds));
        }
        for (const j of qr.JournalEntry ?? []) {
          if (j.status === 'Deleted') deletedQboIds.push({ qboType: 'JournalEntry', qboId: j.Id });
          else txns.push(mapJournalEntry(j, this.holdingIds));
        }
      }
    }
    return { txns, deletedQboIds };
  }

  async fetchTxn(qboType: QboTxn['qboType'], qboId: string): Promise<QboTxn | null> {
    const path = `/${entityPath(qboType)}/${encodeURIComponent(qboId)}`;
    try {
      if (qboType === 'Purchase') {
        const body = await this.request<{ Purchase?: RawPurchase }>('GET', path);
        return body.Purchase ? mapPurchase(body.Purchase, this.holdingIds) : null;
      }
      if (qboType === 'Deposit') {
        const body = await this.request<{ Deposit?: RawDeposit }>('GET', path);
        return body.Deposit ? mapDeposit(body.Deposit, this.holdingIds) : null;
      }
      const body = await this.request<{ JournalEntry?: RawJournalEntry }>('GET', path);
      return body.JournalEntry ? mapJournalEntry(body.JournalEntry, this.holdingIds) : null;
    } catch (err) {
      if (
        err instanceof QboObjectNotFoundError
        || (err instanceof Error && /not\s*found/i.test(err.message))
      ) return null;
      throw err;
    }
  }

  async recategorize(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
  ): Promise<QboWriteResult> {
    // Full-payload update: QBO does not support line-level sparse updates, so we
    // send the whole entity with ONLY the holding-account lines replaced —
    // already-categorized lines and the funding side are preserved verbatim.
    // Split amounts arrive signed (like txn.amount, the holding-line sum) and
    // must sum to it, so the entity's total never changes; QBO line amounts are
    // always positive.
    const prepared = await this.prepareLineRecategorization(
      txn,
      splits,
      randomUUID(),
    );
    const result = await this.sendPreparedLineWrite(prepared);
    return { ok: true, newSyncToken: result.newSyncToken };
  }

  async moveToAccount(txn: QboTxn, accountQboId: string, fromAccountQboIds: string[]): Promise<QboWriteResult> {
    // Undo = the posting update in reverse: replace the lines posting to the
    // categories a previous post wrote with one line back to the holding
    // account, summing exactly what those lines carry — every other line is
    // preserved verbatim.
    const replaceIds = new Set(fromAccountQboIds);
    const sum = sumLinesPostingTo(txn, replaceIds);
    if (sum <= 0) {
      throw new Error(
        'Undo found no lines posting to the previously chosen categories — this transaction was edited in QuickBooks. Verify it there.',
      );
    }
    return this.replaceLines(txn, replaceIds, [{ amount: sum, accountQboId }]);
  }

  private async replaceLines(
    txn: QboTxn,
    replaceIds: ReadonlySet<string>,
    newLines: QboWriteLine[],
  ): Promise<QboWriteResult> {
    if (txn.qboType === 'Purchase') {
      const raw = txn.raw as RawPurchase;
      const body: RawPurchase = {
        ...raw,
        SyncToken: txn.syncToken,
        Line: rebuildPurchaseLines(raw, replaceIds, newLines),
      };
      const res = await this.request<{ Purchase?: RawPurchase }>('POST', '/purchase', body);
      return { ok: true, newSyncToken: res.Purchase?.SyncToken ?? txn.syncToken };
    }
    if (txn.qboType === 'Deposit') {
      const raw = txn.raw as RawDeposit;
      const body: RawDeposit = {
        ...raw,
        SyncToken: txn.syncToken,
        Line: rebuildDepositLines(raw, replaceIds, newLines),
      };
      const res = await this.request<{ Deposit?: RawDeposit }>('POST', '/deposit', body);
      return { ok: true, newSyncToken: res.Deposit?.SyncToken ?? txn.syncToken };
    }
    // JournalEntry: replace only the matching Debit lines; the Credit side and
    // any other Debit lines are kept.
    const raw = txn.raw as RawJournalEntry;
    const body: RawJournalEntry = {
      ...raw,
      SyncToken: txn.syncToken,
      Line: rebuildJournalEntryLines(raw, replaceIds, newLines),
    };
    const res = await this.request<{ JournalEntry?: RawJournalEntry }>('POST', '/journalentry', body);
    return { ok: true, newSyncToken: res.JournalEntry?.SyncToken ?? txn.syncToken };
  }

  async getStatement(
    kind: 'pl' | 'bs',
    params: { startDate?: string; endDate: string; basis: 'cash' | 'accrual'; summarizeBy?: 'Total' | 'Month' },
  ): Promise<QboStatement> {
    const report = kind === 'pl' ? 'ProfitAndLoss' : 'BalanceSheet';
    const q = new URLSearchParams({
      end_date: params.endDate,
      accounting_method: params.basis === 'cash' ? 'Cash' : 'Accrual',
    });
    if (params.startDate !== undefined) q.set('start_date', params.startDate);
    if (params.summarizeBy !== undefined) q.set('summarize_column_by', params.summarizeBy);
    const raw = await this.request<RawReport>('GET', `/reports/${report}?${q.toString()}`);
    return parseStatementReport(raw);
  }

  async getAccountTransactions(params: {
    accountQboId: string;
    startDate: string;
    endDate: string;
  }): Promise<QboAccountTxn[]> {
    const q = new URLSearchParams({
      start_date: params.startDate,
      end_date: params.endDate,
      account: params.accountQboId,
      columns: TXN_LIST_COLUMNS,
    });
    const raw = await this.request<RawReport>('GET', `/reports/TransactionList?${q.toString()}`);
    return parseTransactionListReport(raw);
  }

  async listTransactions(params: { startDate: string; endDate: string }): Promise<QboLogTxn[]> {
    const q = new URLSearchParams({
      start_date: params.startDate,
      end_date: params.endDate,
      columns: TXN_LOG_COLUMNS,
    });
    const raw = await this.request<RawReport>('GET', `/reports/TransactionList?${q.toString()}`);
    return parseTransactionLogReport(raw);
  }

  async createTransfer(args: {
    amount: number;
    fromAccountQboId: string;
    toAccountQboId: string;
    date: string;
    memo?: string;
  }): Promise<{ qboId: string }> {
    const body = {
      Amount: round2(Math.abs(args.amount)),
      FromAccountRef: { value: args.fromAccountQboId },
      ToAccountRef: { value: args.toAccountQboId },
      TxnDate: args.date,
      ...(args.memo ? { PrivateNote: args.memo } : {}),
    };
    const res = await this.request<{ Transfer?: { Id?: string } }>('POST', '/transfer', body);
    return { qboId: res.Transfer?.Id ?? '' };
  }
}

function abortedRequest(): Error {
  const error = new Error('QuickBooks request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function abortableRequest<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(abortedRequest());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedRequest());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function entityPath(qboType: QboTxn['qboType']): string {
  switch (qboType) {
    case 'Purchase':
      return 'purchase';
    case 'Deposit':
      return 'deposit';
    case 'JournalEntry':
      return 'journalentry';
  }
}
