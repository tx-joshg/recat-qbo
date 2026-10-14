import { Prisma } from '../../lib/db.js';

export interface MatchableReceipt {
  totalAmount: string | null;
  currency: string | null;
  receiptDate: string | null;
  vendorName: string | null;
  paymentIdentifier: string | null;
  documentType: string | null;
}

export interface MatchableTransaction {
  id: string;
  amount: string;
  currency: string | null;
  date: string;
  payee: string;
  memo: string | null;
  rawData: unknown;
  status: 'PENDING' | 'ERROR';
  revision: number;
}

export interface MatchEvidence {
  amountPoints: number;
  currencyPoints: number;
  datePoints: number;
  vendorPoints: number;
  paymentPoints: number;
  amountDifferenceCents: number;
  dateDifferenceDays: number | null;
  vendorSimilarity: number | null;
}

export interface ScoredReceiptCandidate {
  transactionId: string;
  transactionRevision: number;
  score: number;
  evidence: MatchEvidence;
}

/** Largest amount difference, as a share of the receipt total, that scores. */
const AMOUNT_TOLERANCE_RATIO = 0.02;

const MONEY_OUT_TYPES = new Set([
  'expense_receipt',
  'expense',
  'purchase',
  'vendor_invoice',
  'bill',
]);
const MONEY_IN_TYPES = new Set([
  'issued_invoice',
  'sales_receipt',
  'sale',
  'deposit',
  'income',
]);

export function tokenJaccard(
  left: string | null,
  right: string | null,
): number | null {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (a.size === 0 || b.size === 0) return null;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function scoreReceiptCandidate(
  receipt: MatchableReceipt,
  transaction: MatchableTransaction,
): ScoredReceiptCandidate | null {
  if (receipt.totalAmount === null) return null;
  const receiptCents = cents(receipt.totalAmount);
  const transactionCents = cents(transaction.amount);
  if (receiptCents === null || transactionCents === null) return null;
  const expectedDirection = direction(receipt.documentType);
  if (
    expectedDirection !== null
    && Math.sign(transactionCents) !== expectedDirection
  ) return null;

  const knownReceiptCurrency = currency(receipt.currency);
  const knownTransactionCurrency = currency(transaction.currency);
  if (
    knownReceiptCurrency !== null
    && knownTransactionCurrency !== null
    && knownReceiptCurrency !== knownTransactionCurrency
  ) return null;

  const differenceCents = Math.abs(
    Math.abs(transactionCents) - Math.abs(receiptCents),
  );
  const amountPoints = amountScore(
    differenceCents,
    Math.abs(receiptCents),
  );
  if (amountPoints < 0) return null;
  const days = dayDifference(receipt.receiptDate, transaction.date);
  if (days !== null && days > 14) return null;
  const similarity = tokenJaccard(receipt.vendorName, transaction.payee);
  const evidence: MatchEvidence = {
    amountPoints,
    currencyPoints: 10,
    datePoints: dateScore(days),
    vendorPoints: vendorScore(similarity),
    paymentPoints: paymentScore(receipt.paymentIdentifier, transaction),
    amountDifferenceCents: differenceCents,
    dateDifferenceDays: days,
    vendorSimilarity: similarity,
  };
  return {
    transactionId: transaction.id,
    transactionRevision: transaction.revision,
    score: evidence.amountPoints
      + evidence.currencyPoints
      + evidence.datePoints
      + evidence.vendorPoints
      + evidence.paymentPoints,
    evidence,
  };
}

/**
 * Amount, date and currency alone say only that a charge looks the same size
 * and time, which a different vendor's charge often does. Auto-matching
 * also needs something tying the receipt to this transaction: a similar
 * vendor name or the receipt's payment identifier on the transaction.
 */
export function hasIdentityEvidence(candidate: ScoredReceiptCandidate): boolean {
  return candidate.evidence.vendorPoints > 0 || candidate.evidence.paymentPoints > 0;
}

export function rankReceiptCandidates(
  receipt: MatchableReceipt,
  transactions: readonly MatchableTransaction[],
): ScoredReceiptCandidate[] {
  return transactions
    .flatMap((transaction) => {
      const scored = scoreReceiptCandidate(receipt, transaction);
      return scored === null ? [] : [scored];
    })
    .sort((a, b) =>
      b.score - a.score
      || nullableNumber(a.evidence.dateDifferenceDays)
        - nullableNumber(b.evidence.dateDifferenceDays)
      || a.evidence.amountDifferenceCents - b.evidence.amountDifferenceCents
      || a.transactionId.localeCompare(b.transactionId));
}

/**
 * The absolute transaction amounts `amountScore` can accept for a receipt
 * total, widened by half a cent so stored amounts with extra precision are not
 * cut off before rounding. Lets the candidate query filter by amount in SQL
 * instead of scoring only the newest rows in the date window.
 */
export function candidateAmountRange(
  totalAmount: string | null,
): { min: string; max: string } | null {
  if (totalAmount === null) return null;
  const receiptCents = cents(totalAmount);
  if (receiptCents === null) return null;
  const absoluteCents = Math.abs(receiptCents);
  const toleranceCents = Math.max(
    1,
    Math.floor(absoluteCents * AMOUNT_TOLERANCE_RATIO),
  );
  const min = new Prisma.Decimal(Math.max(0, absoluteCents - toleranceCents))
    .minus('0.5').dividedBy(100);
  const max = new Prisma.Decimal(absoluteCents + toleranceCents)
    .plus('0.5').dividedBy(100);
  return {
    min: Prisma.Decimal.max(min, 0).toFixed(3),
    max: max.toFixed(3),
  };
}

function normalizedTokens(value: string | null): Set<string> {
  if (!value) return new Set();
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (normalized === '') return new Set();
  return new Set(normalized.split(/\s+/u)
    .filter((token) => token.length > 1)
    .filter((token) => !/^\d+$/u.test(token)));
}

function cents(value: string): number | null {
  try {
    const decimal = new Prisma.Decimal(value);
    if (!decimal.isFinite()) return null;
    const result = decimal.toDecimalPlaces(2).times(100).toNumber();
    return Number.isSafeInteger(result) ? result : null;
  } catch {
    return null;
  }
}

function direction(documentType: string | null): -1 | 1 | null {
  const normalized = documentType?.trim().toLowerCase();
  if (!normalized) return null;
  if (MONEY_OUT_TYPES.has(normalized)) return -1;
  if (MONEY_IN_TYPES.has(normalized)) return 1;
  return null;
}

function currency(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/u.test(normalized) ? normalized : null;
}

function dayDifference(left: string | null, right: string): number | null {
  if (left === null) return null;
  const a = Date.parse(`${left}T00:00:00.000Z`);
  const b = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

function amountScore(differenceCents: number, receiptCents: number): number {
  if (differenceCents === 0) return 55;
  if (differenceCents <= 1) return 50;
  const ratio = differenceCents / Math.max(receiptCents, 1);
  if (ratio <= 0.005) return 40;
  if (ratio <= AMOUNT_TOLERANCE_RATIO) return 25;
  return -1;
}

function dateScore(days: number | null): number {
  if (days === null) return 0;
  if (days === 0) return 20;
  if (days <= 1) return 16;
  if (days <= 3) return 10;
  if (days <= 7) return 4;
  return 0;
}

function vendorScore(similarity: number | null): number {
  if (similarity === null) return 0;
  if (similarity >= 0.8) return 10;
  if (similarity >= 0.5) return 6;
  return 0;
}

function paymentScore(
  identifier: string | null,
  transaction: MatchableTransaction,
): number {
  const needle = identifier?.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toUpperCase() ?? '';
  if (needle.length < 3) return 0;
  const haystack = [
    transaction.payee,
    transaction.memo ?? '',
    safeRawData(transaction.rawData),
  ].join(' ').normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toUpperCase();
  return haystack.includes(needle) ? 5 : 0;
}

function safeRawData(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 20_000) ?? '';
  } catch {
    return '';
  }
}

function nullableNumber(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}
