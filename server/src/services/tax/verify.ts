import type { QboTxn } from '../../lib/qbo/types.js';
import type { RawPurchase, RawPurchaseLine } from '../../lib/qbo/real.js';
import {
  canonicalHash,
  canonicalPurchaseAccountingState,
  type QboPurchaseExpectedState,
  type QboPurchaseRestoreExpected,
} from '../../lib/qbo/purchaseTax.js';

export interface VerificationResult {
  ok: boolean;
  code?: 'TAX_GROSS_MISMATCH' | 'QBO_STATE_DRIFT';
  message?: string;
  details: {
    returnedTotalTaxCents: number | null;
    expectedTargetTaxCents: number;
    matchedTargetLines: number;
    untouchedLineHashes: string[];
  };
}

function cents(value: number): number {
  return Math.round(Math.abs(value) * 100);
}

function fail(
  code: NonNullable<VerificationResult['code']>,
  message: string,
  details: VerificationResult['details'],
): VerificationResult {
  return { ok: false, code, message, details };
}

function lineAccount(line: RawPurchaseLine): string | null {
  return line.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null;
}

/**
 * Verify semantic accounting invariants after a tax-aware Purchase update.
 * Target lines are matched as a multiset (QBO assigns new line IDs/order);
 * every non-target line must retain its exact canonical hash.
 */
export function verifyPurchaseResult(
  expected: QboPurchaseExpectedState,
  after: QboTxn,
): VerificationResult {
  const raw = after.raw as RawPurchase;
  const expectedTax = expected.targetLines.reduce((sum, line) => sum + line.taxCents, 0);
  const returnedTotalTaxCents =
    typeof raw.TxnTaxDetail?.TotalTax === 'number' ? cents(raw.TxnTaxDetail.TotalTax) : null;
  const details: VerificationResult['details'] = {
    returnedTotalTaxCents,
    expectedTargetTaxCents: expectedTax,
    matchedTargetLines: 0,
    untouchedLineHashes: [],
  };

  if (after.qboType !== 'Purchase' || raw.Id !== expected.qboId) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks returned a different Purchase entity.', details);
  }
  if (cents(raw.TotalAmt ?? 0) !== expected.totalAmtCents) {
    return fail('TAX_GROSS_MISMATCH', 'QuickBooks changed the Purchase gross total.', details);
  }
  if ((raw.AccountRef?.value ?? null) !== expected.fundingAccountQboId) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks changed the funding account.', details);
  }
  if ((raw.CurrencyRef?.value ?? null) !== expected.currencyQboId) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks changed the Purchase currency.', details);
  }
  if ((raw.TxnDate ?? null) !== expected.txnDate || (raw.Credit === true) !== expected.credit) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks changed the date or refund direction.', details);
  }
  if (raw.GlobalTaxCalculation !== expected.taxCalculation) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks returned a different tax calculation mode.', details);
  }

  const remaining = [...(raw.Line ?? [])];
  for (const wanted of expected.targetLines) {
    const index = remaining.findIndex((line) => {
      const detail = line.AccountBasedExpenseLineDetail;
      return (
        lineAccount(line) === wanted.accountQboId &&
        detail?.TaxCodeRef?.value === wanted.taxCodeQboId &&
        cents(line.Amount ?? 0) === wanted.netCents &&
        (wanted.memo === undefined || line.Description === wanted.memo) &&
        (expected.taxCalculation !== 'TaxInclusive' ||
          cents(detail?.TaxInclusiveAmt ?? 0) === wanted.grossCents)
      );
    });
    if (index < 0) {
      return fail(
        'QBO_STATE_DRIFT',
        `QuickBooks did not return the expected account/tax treatment for ${wanted.accountQboId}.`,
        details,
      );
    }
    remaining.splice(index, 1);
    details.matchedTargetLines += 1;
  }

  details.untouchedLineHashes = remaining.map(canonicalHash).sort();
  if (JSON.stringify(details.untouchedLineHashes) !== JSON.stringify([...expected.untouchedLineHashes].sort())) {
    return fail('QBO_STATE_DRIFT', 'An unrelated Purchase line changed or disappeared.', details);
  }
  if (expectedTax > 0 && (returnedTotalTaxCents === null || returnedTotalTaxCents < expectedTax)) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks did not return a plausible calculated tax total.', details);
  }
  const netLineCents = (raw.Line ?? []).reduce((sum, line) => sum + cents(line.Amount ?? 0), 0);
  if (
    returnedTotalTaxCents !== null &&
    netLineCents + returnedTotalTaxCents !== expected.totalAmtCents
  ) {
    return fail('TAX_GROSS_MISMATCH', 'QuickBooks net lines plus tax do not reconcile to the gross total.', details);
  }
  return { ok: true, details };
}

export function verifyPurchaseRestore(
  expected: QboPurchaseRestoreExpected,
  after: QboTxn,
): VerificationResult {
  const raw = after.raw as RawPurchase;
  const details: VerificationResult['details'] = {
    returnedTotalTaxCents:
      typeof raw.TxnTaxDetail?.TotalTax === 'number'
        ? cents(raw.TxnTaxDetail.TotalTax)
        : null,
    expectedTargetTaxCents: expected.totalTaxCents ?? 0,
    matchedTargetLines: 0,
    untouchedLineHashes: [],
  };
  if (after.qboType !== 'Purchase' || raw.Id !== expected.qboId) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks returned a different Purchase during undo.', details);
  }
  if (canonicalHash(canonicalPurchaseAccountingState(raw)) !== expected.accountingHash) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks did not restore the original Purchase accounting state.', details);
  }
  if (
    expected.totalTaxCents !== null &&
    details.returnedTotalTaxCents !== expected.totalTaxCents
  ) {
    return fail('QBO_STATE_DRIFT', 'QuickBooks did not restore the original calculated tax.', details);
  }
  return { ok: true, details };
}
