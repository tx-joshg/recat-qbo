// The QuickBooks Online client interface. Two implementations:
//  - RealQboClient (lib/qbo/real.ts): Intuit REST API with OAuth2
//  - MockQboClient (lib/qbo/mock.ts): in-memory demo realms (demo companies)
// All server code depends only on this interface so demo companies exercise
// the exact same sync/write-back paths as production. Which implementation a
// company gets is decided per company by its realmId (lib/qbo/factory.ts).

import type { QboDiagnosticCode } from '@recat/shared';
import type { QboPreparedWrite } from './purchaseTax.js';
import type { RawPurchase } from './real.js';
import type { QboRecategorizationPlan } from '../../services/tax/model.js';

export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
}

export interface QboAccountInfo {
  qboId: string;
  name: string;
  /** e.g. "Expenses:Meals" — colon path from QBO FullyQualifiedName */
  fullName: string;
  /** normalized bucket: Income | COGS | Expenses | Asset | Liability | Equity | Bank | CreditCard | Other */
  classification: string;
  accountType: string;
  active: boolean;
}

export interface QboTaxRateDetail {
  taxRateQboId: string;
  taxTypeApplicable?: string;
  taxOrder?: number;
  taxOnTaxOrder?: number;
}

export interface QboTaxCodeInfo {
  qboId: string;
  name: string;
  description?: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: QboTaxRateDetail[];
  salesTaxRateList: QboTaxRateDetail[];
  raw: unknown;
}

export interface QboTaxRateInfo {
  qboId: string;
  name: string;
  description?: string;
  active: boolean;
  rateValue: number | null;
  raw: unknown;
}

export interface QboTaxProfile {
  usingSalesTax: boolean;
  /** QBO locale/capability signal when supplied by Preferences. */
  partnerTaxEnabled: boolean | null;
  raw: unknown;
}

export interface QboTxnLine {
  /** QBO line Id */
  id: string;
  amount: number;
  /** account this line posts to */
  accountQboId: string;
  accountName: string;
  memo?: string;
}

export interface QboTxn {
  qboId: string;
  qboType: 'Purchase' | 'Deposit' | 'JournalEntry';
  syncToken: string;
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /**
   * Signed sum of the HOLDING-account lines (+ = money in) — NOT the entity's
   * TotalAmt. A multi-line entity that also carries already-categorized lines
   * only exposes (and only ever has rewritten) its holding portion.
   */
  amount: number;
  /** the bank/cc account the money moved through (display name) */
  bankAccount: string;
  /** ONLY the lines posting to holding accounts; other lines stay in `raw`. */
  lines: QboTxnLine[];
  raw: unknown;
}

export interface QboCompanyInfo {
  realmId: string;
  legalName: string;
}

/** One normalized row of a QBO-computed financial statement (values in dollars). */
export interface QboStatementRow {
  label: string;
  kind: 'head' | 'line' | 'total' | 'grand';
  indent: boolean;
  /** present on account data rows — enables transaction drill-down */
  accountQboId?: string;
  /** one entry per statement column; empty for 'head' rows */
  values: number[];
}

/** Normalized tree of a QBO Reports-API statement (P&L / Balance Sheet). */
export interface QboStatement {
  columns: { label: string }[];
  rows: QboStatementRow[];
}

/** One underlying transaction of a statement row (from /reports/TransactionList). */
export interface QboAccountTxn {
  date: string; // YYYY-MM-DD
  payee: string;
  memo?: string;
  /** signed; + = money in, per the report's natural amount */
  amount: number;
  txnType: string;
  qboId: string;
}

/** One row of the whole-company transaction log (from /reports/TransactionList). */
export interface QboLogTxn {
  date: string; // YYYY-MM-DD
  txnType: string;
  docNum?: string;
  payee: string;
  memo?: string;
  /** the account the transaction is entered against (bank / credit card) */
  account: string;
  /** QBO's Split column — the categorization; multi-line entities read '- Split -' */
  category: string;
  /** signed; + = money in, per the report's natural amount */
  amount: number;
  /** QBO entity id when the report provides one — enables tagging */
  qboId?: string;
}

export interface QboWriteResult {
  ok: true;
  newSyncToken: string;
  rawResponse?: unknown;
}

export class QboSyncTokenConflict extends Error {
  code = 'SYNC_TOKEN_CONFLICT' as const;
  constructor(message = 'SyncToken conflict — this transaction was edited in QuickBooks after our last sync.') {
    super(message);
  }
}

export class QboAuthError extends Error {
  code = 'QBO_AUTH' as const;
  readonly reason: QboDiagnosticCode;

  constructor(message: string, reason: QboDiagnosticCode = 'QBO_CONNECTION_FAILED') {
    super(message);
    this.name = 'QboAuthError';
    this.reason = reason;
  }
}

/**
 * Per-realm QuickBooks client. Token persistence is the caller's job: every
 * method may refresh tokens; `onTokensRefreshed` fires so the caller can
 * persist the rotated refresh token immediately (QBO rotates it on use).
 *
 * Clients are constructed with the company's holding-account QBO ids;
 * changedSince/fetchTxn/recategorize all interpret "the txn's lines" as the
 * holding-account lines only — every other line on the entity is preserved
 * verbatim by every write.
 */
export interface QboClient {
  readonly realmId: string;

  getCompanyInfo(): Promise<QboCompanyInfo>;
  listAccounts(): Promise<QboAccountInfo[]>;
  getTaxProfile(): Promise<QboTaxProfile>;
  listTaxCodes(): Promise<QboTaxCodeInfo[]>;
  listTaxRates(): Promise<QboTaxRateInfo[]>;

  /**
   * All txns (Purchase/Deposit/JournalEntry) with a line posting to any of the
   * given accounts. The given ids (not the client's holding set) act as the
   * line filter, so the setup wizard can probe candidate holding accounts.
   */
  listTxnsInAccounts(accountQboIds: string[]): Promise<QboTxn[]>;

  /** Change Data Capture: entities changed since the timestamp. */
  changedSince(isoTimestamp: string): Promise<{ txns: QboTxn[]; deletedQboIds: { qboType: string; qboId: string }[] }>;

  /** Re-fetch one entity fresh (for SyncToken). Returns null if deleted. */
  fetchTxn(qboType: QboTxn['qboType'], qboId: string): Promise<QboTxn | null>;

  /**
   * Rewrite ONLY the txn's holding-account lines as the given category lines,
   * preserving every other line verbatim. `splits` always used — single
   * category = one split of the full (holding-sum) amount.
   * Throws QboSyncTokenConflict on stale token.
   */
  recategorize(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
  ): Promise<QboWriteResult>;

  /** Build once after a fresh read; dry-run and live persist this exact artifact. */
  prepareRecategorization(
    txn: QboTxn,
    plan: QboRecategorizationPlan,
    requestId: string,
  ): Promise<QboPreparedWrite>;

  /** Execute the prepared body with its already-stored stable request ID. */
  executePreparedWrite(prepared: QboPreparedWrite): Promise<QboWriteResult>;

  preparePurchaseRestore(txn: QboTxn, before: RawPurchase, requestId: string): Promise<QboPreparedWrite>;

  /**
   * Undo: replace the lines posting to `fromAccountQboIds` (the categories a
   * previous post wrote) with a single line back to `accountQboId` (holding),
   * preserving every other line verbatim.
   */
  moveToAccount(txn: QboTxn, accountQboId: string, fromAccountQboIds: string[]): Promise<QboWriteResult>;

  /**
   * QBO's OWN P&L / Balance Sheet numbers via the Reports API — drift-free by
   * construction. `startDate` is ignored by the balance sheet (point-in-time).
   */
  getStatement(
    kind: 'pl' | 'bs',
    params: { startDate?: string; endDate: string; basis: 'cash' | 'accrual'; summarizeBy?: 'Total' | 'Month' },
  ): Promise<QboStatement>;

  /** Underlying transactions of one account within a date range (row drill-down). */
  getAccountTransactions(params: {
    accountQboId: string;
    startDate: string;
    endDate: string;
  }): Promise<QboAccountTxn[]>;

  /** Whole-company transaction log within a date range (QBO TransactionList). */
  listTransactions(params: { startDate: string; endDate: string }): Promise<QboLogTxn[]>;

  /** Create a QBO Transfer entity between two accounts. */
  createTransfer(args: {
    amount: number;
    fromAccountQboId: string;
    toAccountQboId: string;
    date: string;
    memo?: string;
  }): Promise<{ qboId: string }>;
}

/** How a connection is made: real Intuit OAuth, or the built-in demo. */
export type QboConnectMode = 'real' | 'demo';

export interface QboClientFactory {
  /** Consent URL for the connect flow (state = CSRF token). mode 'demo' →
   * the built-in fake consent page; 'real' → the Intuit authorize URL. */
  authorizeUrl(state: string, mode: QboConnectMode): string;
  /** Exchange an auth code for tokens (mode must match authorizeUrl's). */
  exchangeCode(code: string, realmId: string, mode: QboConnectMode): Promise<QboTokenSet>;
  /** Client for a connected company; dispatches mock vs real on the
   * company's realmId. Persists rotated tokens via the callback. */
  forCompany(companyId: string): Promise<QboClient>;
  /** Revoke tokens on disconnect (best effort; no-op for demo companies). */
  revoke(companyId: string): Promise<void>;
}
