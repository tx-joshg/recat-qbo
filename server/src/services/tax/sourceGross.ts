import {
  mapPurchaseTaxSnapshot,
  purchaseHoldingGrossCents,
} from '../../lib/qbo/purchaseTax.js';
import { CategorizationError } from '../categorizationError.js';

interface SourceTransaction {
  amount: number | string | { toString(): string };
  qboId: string;
  qboType: string;
  rawData: unknown;
}

function decimalToCents(value: SourceTransaction['amount']): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.toString());
  if (!match) {
    throw new CategorizationError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is not exact cents.');
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const cents = sign * (BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CategorizationError(
      'INVALID_TRANSACTION_AMOUNT',
      'Transaction amount exceeds the safe integer range.',
    );
  }
  return Number(cents);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function safeSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new CategorizationError(
        'TAX_AMOUNT_INVALID',
        'Categorization cents exceed the safe integer range.',
      );
    }
  }
  return total;
}

/**
 * Returns the exact signed provider gross for a synchronized Purchase or
 * Deposit without importing staging or any other mutation-capable service.
 */
export function categorizationSourceGrossCents(
  transaction: SourceTransaction,
  holdingAccountIds: unknown,
): number {
  const transactionCents = decimalToCents(transaction.amount);
  if (transaction.qboType === 'Deposit') return transactionCents;
  if (transaction.qboType !== 'Purchase') {
    throw new CategorizationError(
      'TAX_REQUIRES_PURCHASE',
      'Rule categorization supports Purchase and Deposit transactions only.',
    );
  }
  const holdingIds = new Set(stringArray(holdingAccountIds));
  if (holdingIds.size === 0) {
    throw new CategorizationError('UNBALANCED_TOTAL', 'Purchase holding accounts are not configured.');
  }
  let snapshot;
  try {
    snapshot = mapPurchaseTaxSnapshot(
      transaction.rawData as Parameters<typeof mapPurchaseTaxSnapshot>[0],
    );
  } catch {
    throw new CategorizationError('UNBALANCED_TOTAL', 'Purchase source gross could not be proven.');
  }
  if (snapshot.qboId !== transaction.qboId) {
    throw new CategorizationError('UNBALANCED_TOTAL', 'Purchase source identity could not be proven.');
  }
  const holdingLineIndexes = snapshot.lines.flatMap((line, index) =>
    line.accountQboId !== null && holdingIds.has(line.accountQboId) ? [index] : []
  );
  const holdingNet = safeSum(
    holdingLineIndexes.map((index) => snapshot.lines[index]!.amountCents),
  );
  const holdingGross = purchaseHoldingGrossCents(snapshot, holdingLineIndexes);
  if (holdingNet !== transactionCents || holdingGross === null) {
    throw new CategorizationError('UNBALANCED_TOTAL', 'Purchase source gross could not be proven.');
  }
  return holdingGross;
}
