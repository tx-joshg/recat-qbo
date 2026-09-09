// The QuickBooks Online client interface. Two implementations:
//  - RealQboClient (lib/qbo/real.ts): Intuit REST API with OAuth2
//  - MockQboClient (lib/qbo/mock.ts): in-memory demo realms (demo companies)
// All server code depends only on this interface so demo companies exercise
// the exact same sync/write-back paths as production. Which implementation a
// company gets is decided per company by its realmId (lib/qbo/factory.ts).

import type { QboDiagnosticCode, StagedCategorization, TaxDisposition } from '@recat/shared';
import type { AttachmentBlobReader } from '../../services/attachments/types.js';
import type { QboWriteSafetyEvidence, QboWriteSafetyTarget } from './writeSafety.js';

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
  /**
   * ISO country of the QuickBooks company, or null when QBO omits it.
   * GlobalTaxCalculation — and therefore tax-inclusive entry — is a non-US
   * construct, so this is what decides whether a company can express it at
   * all (#44).
   */
  country: string | null;
}

export interface QboTaxProfile {
  usingSalesTax: boolean | null;
  partnerTaxEnabled: boolean | null;
}

export interface QboTaxRateInfo {
  qboId: string;
  name: string;
  description: string | null;
  active: boolean;
  rateValue: number | null;
  sourceUpdatedAt: string | null;
}

export interface QboTaxCodeInfo {
  qboId: string;
  name: string;
  description: string | null;
  active: boolean;
  taxable: boolean | null;
  purchaseRates: { taxRateQboId: string; taxTypeApplicable: string }[];
  salesRates: { taxRateQboId: string; taxTypeApplicable: string }[];
  sourceUpdatedAt: string | null;
}

export interface QboPurchaseSnapshot {
  qboId: string;
  syncToken: string;
  totalCents: number;
  accountQboId: string | null;
  date: string;
  direction: 'purchase' | 'refund';
  globalTaxCalculation: string | null;
  totalTaxCents: number | null;
  /** Canonical fingerprint of writable entity fields a category-only write cannot change. */
  preservedHash?: string;
  lines: {
    id: string | null;
    amountCents: number;
    description: string | null;
    accountQboId: string | null;
    customerQboId: string | null;
    classQboId: string | null;
    taxCodeQboId: string | null;
    taxAmountCents: number | null;
    taxInclusiveCents: number | null;
    /** Full canonical raw-line fingerprint. Always populated by live QBO mapping. */
    rawHash?: string;
    /** Raw-line fingerprint with only AccountRef.value replaced by a stable sentinel. */
    categoryOnlyHash?: string;
  }[];
}

export interface QboRef {
  value: string;
  name?: string;
  [key: string]: unknown;
}

export interface RawPurchaseLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QboRef;
    CustomerRef?: QboRef;
    ClassRef?: QboRef;
    TaxCodeRef?: QboRef;
    TaxAmount?: number;
    TaxInclusiveAmt?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Complete QBO Purchase update shape. Unknown fields are retained verbatim. */
export interface RawPurchase {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt?: number;
  Credit?: boolean;
  PaymentType?: string;
  DocNumber?: string;
  PrivateNote?: string;
  EntityRef?: QboRef;
  AccountRef?: QboRef;
  CurrencyRef?: QboRef;
  ExchangeRate?: number;
  Line?: RawPurchaseLine[];
  GlobalTaxCalculation?: string;
  TxnTaxDetail?: {
    TotalTax?: number;
    [key: string]: unknown;
  };
  status?: string;
  [key: string]: unknown;
}

export interface RawDepositLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  DepositLineDetail?: {
    AccountRef?: QboRef;
    Entity?: QboRef;
    PaymentMethodRef?: QboRef;
    ClassRef?: QboRef;
    TaxCodeRef?: QboRef;
    TaxApplicableOn?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Complete QBO Deposit update shape. Unknown fields are retained verbatim. */
export interface RawDeposit {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  PrivateNote?: string;
  DepositToAccountRef?: QboRef;
  CurrencyRef?: QboRef;
  ExchangeRate?: number;
  Line?: RawDepositLine[];
  GlobalTaxCalculation?: string;
  TxnTaxDetail?: {
    TotalTax?: number;
    [key: string]: unknown;
  };
  status?: string;
  [key: string]: unknown;
}

export interface QboDepositSnapshot {
  qboId: string;
  syncToken: string;
  totalCents: number;
  depositToAccountQboId: string | null;
  date: string;
  globalTaxCalculation: string | null;
  totalTaxCents: number | null;
  /** Canonical fingerprint of writable entity fields that a tax write does not change. */
  preservedHash: string;
  lines: Array<{
    id: string | null;
    amountCents: number;
    description: string | null;
    accountQboId: string | null;
    entityQboId: string | null;
    paymentMethodQboId: string | null;
    classQboId: string | null;
    taxCodeQboId: string | null;
    taxApplicableOn: string | null;
    /** Full canonical raw-line fingerprint for untouched-line verification. */
    rawHash: string;
    /** Stable write-intent fingerprint excluding QBO-assigned/enriched fields. */
    targetHash: string;
  }>;
}

export interface QboPurchaseExpectedState {
  qboId: string;
  taxDisposition?: TaxDisposition;
  totalCents: number;
  accountQboId: string | null;
  date: string;
  direction: QboPurchaseSnapshot['direction'];
  globalTaxCalculation: string | null;
  totalTaxCents: number | null;
  preservedHash?: string;
  targetLines: QboPurchaseSnapshot['lines'];
  untouchedLineHashes: string[];
}

export interface QboDepositExpectedState {
  qboId: string;
  totalCents: number;
  depositToAccountQboId: string | null;
  date: string;
  globalTaxCalculation: string | null;
  totalTaxCents: number | null;
  preservedHash: string;
  targetLines: QboDepositSnapshot['lines'];
  untouchedLineHashes: string[];
}

interface QboPreparedWriteBase {
  operation: 'recategorize' | 'restore';
  qboId: string;
  requestId: string;
  requestHash: string;
}

export interface QboPurchasePreparedWrite extends QboPreparedWriteBase {
  qboType: 'Purchase';
  body: RawPurchase;
  before: QboPurchaseSnapshot;
  expected: QboPurchaseExpectedState;
}

export interface QboLineWriteSnapshot {
  qboType: QboTxn['qboType'];
  qboId: string;
  syncToken: string;
  contentHash: string;
}

export interface QboPreparedLineWrite {
  operation: 'transfer';
  qboType: QboTxn['qboType'];
  qboId: string;
  requestId: string;
  requestHash: string;
  body: Record<string, unknown>;
  before: QboLineWriteSnapshot;
  expected: Omit<QboLineWriteSnapshot, 'syncToken'>;
}

export interface QboLineWriteSplit {
  amount: number;
  accountQboId: string;
  memo?: string;
}

export interface RawJournalEntryLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: QboRef;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Complete QBO JournalEntry update shape. Unknown fields are retained verbatim. */
export interface RawJournalEntry {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  Line?: RawJournalEntryLine[];
  status?: string;
  [key: string]: unknown;
}

export interface QboDepositPreparedWrite extends QboPreparedWriteBase {
  qboType: 'Deposit';
  body: RawDeposit;
  before: QboDepositSnapshot;
  expected: QboDepositExpectedState;
}

export type QboPreparedWrite = QboPurchasePreparedWrite | QboDepositPreparedWrite;

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
}

export interface QboLineWriteResult extends QboWriteResult {
  snapshot: QboLineWriteSnapshot;
}

export interface QboAttachmentRef {
  qboType: 'Purchase' | 'Deposit' | 'JournalEntry';
  qboId: string;
}

export interface QboAttachable {
  id: string;
  syncToken: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  note: string | null;
  refs: readonly QboAttachmentRef[];
}

export interface QboAttachmentDownload {
  contentType: string;
  sizeBytes: number | null;
  body: AsyncIterable<Uint8Array>;
}

export interface QboAttachmentUploadFile {
  ordinal: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  marker: string;
  openContent(): Promise<AttachmentBlobReader>;
}

export type QboAttachmentUploadOutcome =
  | { ordinal: number; outcome: 'ATTACHED'; attachable: QboAttachable }
  | { ordinal: number; outcome: 'FAILED'; code: string; message: string };

export interface QboMultipartBody {
  contentType: string;
  contentLength: number;
  openStream(): AsyncIterable<Uint8Array>;
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

export class QboRequestTimeout extends Error {
  code = 'QBO_TIMEOUT' as const;

  constructor(message = 'QuickBooks did not confirm the prepared write before the request timed out.') {
    super(message);
    this.name = 'QboRequestTimeout';
  }
}

export class QboAttachmentNotFoundError extends Error {
  code = 'QBO_ATTACHMENT_NOT_FOUND' as const;

  constructor(message = 'QuickBooks attachment was not found.') {
    super(message);
    this.name = 'QboAttachmentNotFoundError';
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
  uploadAttachments(
    ref: QboAttachmentRef,
    files: QboAttachmentUploadFile[],
    requestId: string,
  ): Promise<QboAttachmentUploadOutcome[]>;
  listAttachments(ref: QboAttachmentRef): Promise<QboAttachable[]>;
  getAttachment(id: string): Promise<QboAttachable | null>;
  openAttachmentDownload(id: string): Promise<QboAttachmentDownload>;
  deleteAttachment(input: {
    id: string;
    syncToken: string;
    requestId: string;
  }): Promise<void>;
  fetchPurchaseSnapshot(
    qboId: string,
    signal?: AbortSignal,
  ): Promise<QboPurchaseSnapshot | null>;
  fetchWriteSafety(target: QboWriteSafetyTarget): Promise<QboWriteSafetyEvidence>;
  fetchLineWriteSnapshot(
    qboType: QboTxn['qboType'],
    qboId: string,
  ): Promise<QboLineWriteSnapshot | null>;

  fetchPreparedSnapshot(
    qboType: 'Purchase' | 'Deposit',
    qboId: string,
    signal?: AbortSignal,
  ): Promise<QboPurchaseSnapshot | QboDepositSnapshot | null>;

  prepareRecategorization(
    txn: QboTxn,
    staged: StagedCategorization,
    before: QboPurchaseSnapshot | QboDepositSnapshot,
    requestId: string,
  ): Promise<QboPreparedWrite>;

  sendPreparedWrite(prepared: QboPreparedWrite): Promise<QboWriteResult>;

  prepareLineRecategorization(
    txn: QboTxn,
    splits: { amount: number; accountQboId: string; memo?: string }[],
    requestId: string,
  ): Promise<QboPreparedLineWrite>;

  sendPreparedLineWrite(
    prepared: QboPreparedLineWrite,
    beforeSend?: () => Promise<void>,
  ): Promise<QboLineWriteResult>;

  preparePurchaseRestore(
    txn: QboTxn,
    prepared: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPreparedWrite>;

  prepareRestore(
    txn: QboTxn,
    prepared: QboPreparedWrite,
    requestId: string,
  ): Promise<QboPreparedWrite>;

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

export interface QboRevocationSource {
  realmId: string;
  refreshToken: string | null;
}

export type QboRevocationCapability = () => Promise<void>;

export interface QboClientFactory {
  /** Consent URL for the connect flow (state = CSRF token). mode 'demo' →
   * the built-in fake consent page; 'real' → the Intuit authorize URL. */
  authorizeUrl(state: string, mode: QboConnectMode): Promise<string>;
  /** Exchange an auth code for tokens (mode must match authorizeUrl's). */
  exchangeCode(code: string, realmId: string, mode: QboConnectMode): Promise<QboTokenSet>;
  /** Client for a connected company; dispatches mock vs real on the
   * company's realmId. Persists rotated tokens via the callback. */
  forCompany(companyId: string): Promise<QboClient>;
}
