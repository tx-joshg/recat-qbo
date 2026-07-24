import type { TaxCalculation } from '@recat/shared';
import type { QboTxn } from '../../lib/qbo/types.js';

export type { TaxCalculation };

export interface PurchaseTaxDecision {
  taxCodeQboId: string | null;
  taxCodeName: string | null;
}

export interface QboRecategorizationLine {
  /** Signed gross bank movement, in dollars. */
  grossAmount: number;
  accountQboId: string;
  memo?: string;
  tax: PurchaseTaxDecision;
}

export interface QboRecategorizationPlan {
  qboType: QboTxn['qboType'];
  signedTransactionAmount: number;
  taxCalculation: TaxCalculation;
  /** Required representation for NotApplicable (normally QBO's Out of Scope code). */
  outOfScopeTaxCodeQboId?: string | null;
  lines: QboRecategorizationLine[];
}

export type TaxPlanErrorCode =
  | 'TAX_MODE_INVALID'
  | 'TAX_MODE_UNSUPPORTED'
  | 'TAX_LINES_REQUIRED'
  | 'TAX_CODE_REQUIRED'
  | 'TAX_OUT_OF_SCOPE_REQUIRED'
  | 'TAX_AMOUNT_MISMATCH';

export class TaxPlanError extends Error {
  constructor(
    readonly code: TaxPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaxPlanError';
  }
}

const TAX_CALCULATIONS = new Set<TaxCalculation>(['TaxInclusive', 'TaxExcluded', 'NotApplicable']);

function cents(value: number): number {
  return Math.round(value * 100);
}

/** Pure structural validation shared by routes, rules, builders, and agents. */
export function validateRecategorizationPlan(plan: QboRecategorizationPlan): void {
  if (!TAX_CALCULATIONS.has(plan.taxCalculation)) {
    throw new TaxPlanError('TAX_MODE_INVALID', `Unsupported tax calculation: ${String(plan.taxCalculation)}`);
  }
  if (plan.qboType !== 'Purchase') {
    throw new TaxPlanError('TAX_MODE_UNSUPPORTED', 'Tax treatment is currently supported only for Purchase transactions.');
  }
  if (plan.lines.length === 0) {
    throw new TaxPlanError('TAX_LINES_REQUIRED', 'At least one recategorization line is required.');
  }

  for (const line of plan.lines) {
    if (!line.tax.taxCodeQboId) {
      throw new TaxPlanError('TAX_CODE_REQUIRED', 'Every Purchase line needs a company tax code.');
    }
    if (
      plan.taxCalculation === 'NotApplicable' &&
      (!plan.outOfScopeTaxCodeQboId || line.tax.taxCodeQboId !== plan.outOfScopeTaxCodeQboId)
    ) {
      throw new TaxPlanError(
        'TAX_OUT_OF_SCOPE_REQUIRED',
        'NotApplicable lines must use the company Out of Scope tax code.',
      );
    }
  }

  const lineCents = plan.lines.reduce((sum, line) => sum + cents(line.grossAmount), 0);
  if (lineCents !== cents(plan.signedTransactionAmount)) {
    throw new TaxPlanError('TAX_AMOUNT_MISMATCH', 'Gross line amounts must add up to the transaction amount.');
  }
}
