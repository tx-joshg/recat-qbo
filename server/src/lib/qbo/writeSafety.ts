import type { QboClient, QboTxn } from './types.js';

// Recat can only redistribute a transaction across categories: staging asserts
// the lines total the proven source gross, so a write never moves the amount
// the bank side was reconciled against. Cleared and reconciled status is
// therefore not evidence about whether a write is safe, and is not collected.
export interface QboWriteSafetyEvidence {
  readonly bookCloseDate: string | null;
}

export interface QboWriteSafetyTarget {
  readonly qboType: 'Purchase' | 'Deposit' | 'JournalEntry';
  readonly qboId: string;
  readonly txnDate: string;
  /**
   * The funding side of the entity: the Purchase payment account, the Deposit
   * to-account, or a JournalEntry's first credit account.
   */
  readonly bankAccountQboId: string;
}

export class QboWriteSafetyError extends Error {
  readonly code:
    | 'QBO_PERIOD_CLOSED'
    // Retained for error records persisted before reconciled corrections were allowed.
    | 'QBO_TRANSACTION_LOCKED'
    | 'QBO_WRITE_SAFETY_UNAVAILABLE';

  constructor(code: QboWriteSafetyError['code'], message?: string) {
    super(message ?? (
      code === 'QBO_PERIOD_CLOSED'
        ? 'QuickBooks has closed this accounting period.'
        : code === 'QBO_TRANSACTION_LOCKED'
          ? 'QuickBooks reports this transaction as cleared or reconciled.'
          : 'QuickBooks write-safety status is unavailable.'
    ));
    this.name = 'QboWriteSafetyError';
    this.code = code;
  }
}

export function assertQboWriteAllowed(
  target: QboWriteSafetyTarget,
  evidence: QboWriteSafetyEvidence,
): void {
  if (
    !isWriteSafetyType(target.qboType)
    || !nonEmpty(target.qboId)
    || !nonEmpty(target.bankAccountQboId)
    || !dateOnly(target.txnDate)
    || (evidence.bookCloseDate !== null && !dateOnly(evidence.bookCloseDate))
  ) {
    throw new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE');
  }
  if (evidence.bookCloseDate !== null && target.txnDate <= evidence.bookCloseDate) {
    throw new QboWriteSafetyError(
      'QBO_PERIOD_CLOSED',
      `QuickBooks has closed books through ${evidence.bookCloseDate}.`,
    );
  }
}

export function isWriteSafetyType(value: unknown): value is QboWriteSafetyTarget['qboType'] {
  return value === 'Purchase' || value === 'Deposit' || value === 'JournalEntry';
}

function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nonEmpty(value: string): boolean {
  return value.trim() !== '' && value.length <= 200;
}

function refValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).value;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function fundingAccountQboId(txn: QboTxn): string | undefined {
  const raw = txn.raw && typeof txn.raw === 'object'
    ? txn.raw as Record<string, unknown>
    : undefined;
  if (!raw) return undefined;
  if (txn.qboType === 'Purchase') return refValue(raw.AccountRef);
  if (txn.qboType === 'Deposit') return refValue(raw.DepositToAccountRef);
  const lines = Array.isArray(raw.Line) ? raw.Line : [];
  for (const line of lines) {
    const detail = line && typeof line === 'object'
      ? (line as Record<string, unknown>).JournalEntryLineDetail
      : undefined;
    if (
      detail
      && typeof detail === 'object'
      && (detail as Record<string, unknown>).PostingType === 'Credit'
    ) {
      const id = refValue((detail as Record<string, unknown>).AccountRef);
      if (id) return id;
    }
  }
  return undefined;
}

/** The book-close check target for a freshly read QuickBooks entity. */
export function txnWriteSafetyTarget(txn: QboTxn): QboWriteSafetyTarget {
  const bankAccountQboId = fundingAccountQboId(txn);
  if (!bankAccountQboId) {
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

/** Refuse a write to a freshly read entity dated inside a closed period. */
export async function assertTxnWriteSafety(
  client: Pick<QboClient, 'fetchWriteSafety'>,
  txn: QboTxn,
): Promise<void> {
  const target = txnWriteSafetyTarget(txn);
  const evidence = await client.fetchWriteSafety(target);
  assertQboWriteAllowed(target, evidence);
}
