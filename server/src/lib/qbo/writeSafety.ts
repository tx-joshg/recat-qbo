// Recat can only redistribute a transaction across categories: staging asserts
// the lines total the proven source gross, so a write never moves the amount
// the bank side was reconciled against. Cleared and reconciled status is
// therefore not evidence about whether a write is safe, and is not collected.
export interface QboWriteSafetyEvidence {
  readonly bookCloseDate: string | null;
}

export interface QboWriteSafetyTarget {
  readonly qboType: 'Purchase' | 'Deposit';
  readonly qboId: string;
  readonly txnDate: string;
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
    (target.qboType !== 'Purchase' && target.qboType !== 'Deposit')
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

function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nonEmpty(value: string): boolean {
  return value.trim() !== '' && value.length <= 200;
}
