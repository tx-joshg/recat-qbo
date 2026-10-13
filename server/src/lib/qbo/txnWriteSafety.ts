import type { QboClient, QboTxn } from './types.js';
import {
  assertQboWriteAllowed,
  QboWriteSafetyError,
  type QboWriteSafetyTarget,
} from './writeSafety.js';

/**
 * Builds the closed-books target from a freshly read entity. A JournalEntry
 * has no single payment account, so only its date is checked.
 */
export function freshTxnWriteSafetyTarget(txn: QboTxn): QboWriteSafetyTarget {
  if (txn.qboType === 'JournalEntry') {
    return {
      qboType: txn.qboType,
      qboId: txn.qboId,
      txnDate: txn.date,
      bankAccountQboId: null,
    };
  }
  const raw = txn.raw;
  const accountRef = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>)[
      txn.qboType === 'Purchase' ? 'AccountRef' : 'DepositToAccountRef'
    ]
    : undefined;
  const bankAccountQboId = accountRef && typeof accountRef === 'object'
    ? (accountRef as Record<string, unknown>).value
    : undefined;
  if (typeof bankAccountQboId !== 'string' || bankAccountQboId.length === 0) {
    throw new QboWriteSafetyError(
      'QBO_WRITE_SAFETY_UNAVAILABLE',
      'QuickBooks payment-account identity is unavailable for the safety check.',
    );
  }
  return {
    qboType: txn.qboType,
    qboId: txn.qboId,
    txnDate: txn.date,
    bankAccountQboId,
  };
}

/** Refuses a write to an entity dated inside QuickBooks' closed books. */
export async function assertFreshTxnWriteAllowed(
  client: Pick<QboClient, 'fetchWriteSafety'>,
  txn: QboTxn,
): Promise<void> {
  const target = freshTxnWriteSafetyTarget(txn);
  assertQboWriteAllowed(target, await client.fetchWriteSafety(target));
}
