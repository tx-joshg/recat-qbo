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

import {
  QboAuthError,
  QboSyncTokenConflict,
  type QboAccountInfo,
  type QboAccountTxn,
  type QboLogTxn,
  type QboClient,
  type QboCompanyInfo,
  type QboStatement,
  type QboStatementRow,
  type QboTokenSet,
  type QboTxn,
  type QboTxnLine,
  type QboWriteResult,
} from './types.js';
import { classifyIntuitOAuthBody } from './diagnostics.js';

const OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
// Revoke lives on the developer host, not the oauth host.
const OAUTH_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const OAUTH_SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** QBO query hard cap per page. */
const QUERY_PAGE_SIZE = 1000;

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

interface RawAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Classification?: string; // Asset | Liability | Equity | Revenue | Expense
  AccountType?: string; // Bank | Credit Card | Cost of Goods Sold | Expense | Income | ...
  Active?: boolean;
}

export interface RawPurchaseLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QboRef };
}

export interface RawPurchase {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt?: number;
  /** true = refund/credit — money coming back in */
  Credit?: boolean;
  PaymentType?: string;
  DocNumber?: string;
  PrivateNote?: string;
  EntityRef?: QboRef;
  /** the bank / credit-card account the purchase was paid from */
  AccountRef?: QboRef;
  Line?: RawPurchaseLine[];
  status?: string; // CDC: 'Deleted'
}

export interface RawDepositLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  DepositLineDetail?: { AccountRef?: QboRef; Entity?: QboRef; PaymentMethodRef?: QboRef };
}

export interface RawDeposit {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  PrivateNote?: string;
  DepositToAccountRef?: QboRef;
  Line?: RawDepositLine[];
  status?: string;
}

export interface RawJournalEntryLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: QboRef };
}

export interface RawJournalEntry {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  Line?: RawJournalEntryLine[];
  status?: string;
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
  CompanyInfo?: { CompanyName?: string; LegalName?: string };
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

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v && v.trim().length > 0) return v.trim();
  return undefined;
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

// ---------------------------------------------------------------------------
// Line rebuilding (pure, unit-tested): replace ONLY the lines posting to
// `replaceIds`, preserving every other line verbatim. This is what keeps a
// multi-line entity's already-categorized lines safe across a write.
// ---------------------------------------------------------------------------

export interface QboWriteLine {
  amount: number;
  accountQboId: string;
  memo?: string;
}

export function rebuildPurchaseLines(
  raw: RawPurchase,
  replaceIds: ReadonlySet<string>,
  newLines: QboWriteLine[],
): RawPurchaseLine[] {
  const keep = (raw.Line ?? []).filter((l) => {
    const id = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
    return id === undefined || !replaceIds.has(id);
  });
  return [
    ...keep,
    ...newLines.map(
      (s): RawPurchaseLine => ({
        Amount: round2(Math.abs(s.amount)),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: s.memo,
        AccountBasedExpenseLineDetail: { AccountRef: { value: s.accountQboId } },
      }),
    ),
  ];
}

export function rebuildDepositLines(
  raw: RawDeposit,
  replaceIds: ReadonlySet<string>,
  newLines: QboWriteLine[],
): RawDepositLine[] {
  const isReplaced = (l: RawDepositLine): boolean => {
    const id = l.DepositLineDetail?.AccountRef?.value;
    return id !== undefined && replaceIds.has(id);
  };
  const keep = (raw.Line ?? []).filter((l) => !isReplaced(l));
  // Preserve the payer Entity from the first replaced line so the deposit
  // keeps its "received from" attribution after the category swap.
  const entity = (raw.Line ?? []).find(isReplaced)?.DepositLineDetail?.Entity;
  return [
    ...keep,
    ...newLines.map(
      (s): RawDepositLine => ({
        Amount: round2(Math.abs(s.amount)),
        DetailType: 'DepositLineDetail',
        Description: s.memo,
        DepositLineDetail: { AccountRef: { value: s.accountQboId }, ...(entity ? { Entity: entity } : {}) },
      }),
    ),
  ];
}

export function rebuildJournalEntryLines(
  raw: RawJournalEntry,
  replaceIds: ReadonlySet<string>,
  newLines: QboWriteLine[],
): RawJournalEntryLine[] {
  const isReplaced = (l: RawJournalEntryLine): boolean => {
    const detail = l.JournalEntryLineDetail;
    return detail?.PostingType === 'Debit' && detail.AccountRef?.value !== undefined && replaceIds.has(detail.AccountRef.value);
  };
  const keep = (raw.Line ?? []).filter((l) => !isReplaced(l));
  return [
    ...keep,
    ...newLines.map(
      (s): RawJournalEntryLine => ({
        Amount: round2(Math.abs(s.amount)),
        DetailType: 'JournalEntryLineDetail',
        Description: s.memo,
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: s.accountQboId } },
      }),
    ),
  ];
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
  const request: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  };
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, request);
  } catch {
    throw new QboAuthError('Intuit token request was unavailable', 'INTUIT_UNAVAILABLE');
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 4096);
    const reason = classifyIntuitOAuthBody(res.status, detail);
    throw new QboAuthError(`Intuit token request failed (${res.status})`, reason);
  }
  const json = (await res.json()) as OAuthTokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
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
  try {
    await fetch(OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth(args.clientId, args.clientSecret)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: args.token }),
    });
  } catch {
    // best effort — a failed revoke must not block disconnect
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

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<T> {
    const accessToken = await this.ensureFreshToken();
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${this.base}${path}${sep}minorversion=${MINOR_VERSION}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      // Access token invalidated server-side: refresh once and retry.
      await this.refresh();
      return this.request<T>(method, path, body, true);
    }
    const text = await res.text();
    if (!res.ok) throw this.toError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
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
    };
  }

  async listAccounts(): Promise<QboAccountInfo[]> {
    const rows = await this.queryAll('select * from Account', 'Account');
    return rows.map(mapAccount);
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
      // 610 = Object Not Found (deleted). Surfaced by message since fault codes
      // are folded into the Error in toError().
      if (err instanceof Error && /not\s*found/i.test(err.message)) return null;
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
    return this.replaceLines(txn, this.holdingIds, splits);
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
