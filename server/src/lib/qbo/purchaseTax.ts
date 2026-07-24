import { createHash } from 'node:crypto';
import type { QboTaxCodeInfo, QboTaxRateInfo, QboTxn } from './types.js';
import type { RawPurchase, RawPurchaseLine } from './real.js';
import {
  TaxPlanError,
  validateRecategorizationPlan,
  type QboRecategorizationPlan,
  type TaxCalculation,
} from '../../services/tax/model.js';

export interface QboPurchaseTaxReference {
  taxCodes: QboTaxCodeInfo[];
  taxRates: QboTaxRateInfo[];
}

export interface ExpectedPurchaseLine {
  accountQboId: string;
  taxCodeQboId: string;
  grossCents: number;
  netCents: number;
  taxCents: number;
  memo?: string;
}

export interface QboPurchaseExpectedState {
  qboId: string;
  totalAmtCents: number;
  fundingAccountQboId: string | null;
  currencyQboId: string | null;
  txnDate: string | null;
  credit: boolean;
  taxCalculation: TaxCalculation;
  targetLines: ExpectedPurchaseLine[];
  untouchedLineHashes: string[];
}

export interface QboPurchaseRestoreExpected {
  qboId: string;
  accountingHash: string;
  totalTaxCents: number | null;
}

interface QboPreparedWriteBase {
  qboType: 'Purchase';
  path: '/purchase';
  requestId: string;
  body: RawPurchase;
  before: RawPurchase;
}

export type QboPreparedWrite =
  | (QboPreparedWriteBase & { operation: 'recategorize'; expected: QboPurchaseExpectedState })
  | (QboPreparedWriteBase & { operation: 'restore'; expected: QboPurchaseRestoreExpected });

export type PurchaseTaxErrorCode =
  | 'TAX_CODE_UNKNOWN'
  | 'TAX_CODE_INACTIVE'
  | 'TAX_CODE_NOT_PURCHASE'
  | 'TAX_RATE_UNKNOWN'
  | 'TAX_RATE_INACTIVE'
  | 'TAX_RATE_UNSUPPORTED';

export class PurchaseTaxError extends Error {
  constructor(
    readonly code: PurchaseTaxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PurchaseTaxError';
  }
}

function cents(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

function dollars(minorUnits: number): number {
  return minorUnits / 100;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/** Only accounting-relevant fields; ignores SyncToken and QBO-computed tax. */
export function canonicalPurchaseAccountingState(raw: RawPurchase): unknown {
  return {
    Id: raw.Id,
    TxnDate: raw.TxnDate,
    TotalAmt: raw.TotalAmt,
    Credit: raw.Credit,
    PaymentType: raw.PaymentType,
    DocNumber: raw.DocNumber,
    PrivateNote: raw.PrivateNote,
    EntityRef: raw.EntityRef,
    AccountRef: raw.AccountRef,
    CurrencyRef: raw.CurrencyRef,
    DepartmentRef: raw.DepartmentRef,
    GlobalTaxCalculation: raw.GlobalTaxCalculation,
    Line: raw.Line ?? [],
  };
}

interface CalculatedLine {
  grossCents: number;
  netCents: number;
  taxCents: number;
}

/**
 * Supported v1 shape: a zero-rate/out-of-scope Purchase code, or one
 * active simple percentage rate applied directly to the line amount.
 * Compound/tax-on-tax codes fail closed until backed by sandbox fixtures.
 */
export function calculatePurchaseLine(
  grossAmount: number,
  taxCalculation: TaxCalculation,
  taxCodeQboId: string,
  reference: QboPurchaseTaxReference,
): CalculatedLine {
  const code = reference.taxCodes.find((candidate) => candidate.qboId === taxCodeQboId);
  if (!code) throw new PurchaseTaxError('TAX_CODE_UNKNOWN', `Unknown QuickBooks TaxCode ${taxCodeQboId}.`);
  if (!code.active) throw new PurchaseTaxError('TAX_CODE_INACTIVE', `QuickBooks TaxCode ${code.name} is inactive.`);

  const grossCents = cents(grossAmount);
  if (code.taxable === false && code.purchaseTaxRateList.length === 0) {
    return { grossCents, netCents: grossCents, taxCents: 0 };
  }
  if (code.purchaseTaxRateList.length === 0) {
    throw new PurchaseTaxError('TAX_CODE_NOT_PURCHASE', `QuickBooks TaxCode ${code.name} is not purchase-applicable.`);
  }
  if (code.purchaseTaxRateList.length !== 1) {
    throw new PurchaseTaxError(
      'TAX_RATE_UNSUPPORTED',
      `QuickBooks TaxCode ${code.name} has a composite rate shape Recat does not support.`,
    );
  }
  const detail = code.purchaseTaxRateList[0]!;
  if (
    detail.taxOnTaxOrder !== undefined ||
    (detail.taxTypeApplicable !== undefined && detail.taxTypeApplicable !== 'TaxOnAmount')
  ) {
    throw new PurchaseTaxError(
      'TAX_RATE_UNSUPPORTED',
      `QuickBooks TaxCode ${code.name} uses tax-on-tax or an unsupported rate basis.`,
    );
  }
  const rate = reference.taxRates.find((candidate) => candidate.qboId === detail.taxRateQboId);
  if (!rate || rate.rateValue === null) {
    throw new PurchaseTaxError('TAX_RATE_UNKNOWN', `TaxCode ${code.name} references an unavailable TaxRate.`);
  }
  if (!rate.active) throw new PurchaseTaxError('TAX_RATE_INACTIVE', `QuickBooks TaxRate ${rate.name} is inactive.`);

  // Rate values are percentages. Six fractional digits matches the mirrored
  // Decimal(12,6), and all arithmetic after scaling is integer.
  const rateMicros = Math.round(rate.rateValue * 10_000);
  if (rateMicros < 0) {
    throw new PurchaseTaxError('TAX_RATE_UNSUPPORTED', `QuickBooks TaxRate ${rate.name} is negative.`);
  }
  if (taxCalculation === 'NotApplicable') {
    throw new TaxPlanError('TAX_OUT_OF_SCOPE_REQUIRED', 'NotApplicable cannot use a taxable TaxCode.');
  }
  const netCents = Math.round((grossCents * 1_000_000) / (1_000_000 + rateMicros));
  return { grossCents, netCents, taxCents: grossCents - netCents };
}

/**
 * Build the literal Purchase update and its semantic post-read expectations.
 * No database or HTTP access occurs here; dry-run and live share this object.
 */
export function buildPurchaseRecategorization(
  fresh: QboTxn,
  replaceIds: ReadonlySet<string>,
  plan: QboRecategorizationPlan,
  reference: QboPurchaseTaxReference,
  requestId: string,
): QboPreparedWrite {
  validateRecategorizationPlan(plan);
  if (fresh.qboType !== 'Purchase') {
    throw new TaxPlanError('TAX_MODE_UNSUPPORTED', 'Tax-aware payloads are supported only for Purchase.');
  }
  const raw = fresh.raw as RawPurchase;
  const keptLines = (raw.Line ?? []).filter((line) => {
    const accountId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
    return accountId === undefined || !replaceIds.has(accountId);
  });
  const expectedLines: ExpectedPurchaseLine[] = [];
  const replacementLines: RawPurchaseLine[] = plan.lines.map((line) => {
    const taxCodeQboId = line.tax.taxCodeQboId;
    if (!taxCodeQboId) throw new TaxPlanError('TAX_CODE_REQUIRED', 'Every Purchase line needs a tax code.');
    const calculated = calculatePurchaseLine(line.grossAmount, plan.taxCalculation, taxCodeQboId, reference);
    expectedLines.push({
      accountQboId: line.accountQboId,
      taxCodeQboId,
      ...calculated,
      ...(line.memo !== undefined ? { memo: line.memo } : {}),
    });
    return {
      Amount: dollars(calculated.netCents),
      DetailType: 'AccountBasedExpenseLineDetail',
      ...(line.memo !== undefined ? { Description: line.memo } : {}),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: line.accountQboId },
        TaxCodeRef: { value: taxCodeQboId },
        ...(plan.taxCalculation === 'TaxInclusive'
          ? { TaxInclusiveAmt: dollars(calculated.grossCents) }
          : {}),
      },
    };
  });

  // Calculated tax is stale as soon as line codes change. QBO must recompute it.
  const { TxnTaxDetail: _staleTax, status: _cdcStatus, ...writeable } = raw;
  const body: RawPurchase = {
    ...writeable,
    Id: raw.Id,
    SyncToken: fresh.syncToken,
    GlobalTaxCalculation: plan.taxCalculation,
    Line: [...keptLines, ...replacementLines],
  };

  return {
    qboType: 'Purchase',
    operation: 'recategorize',
    path: '/purchase',
    requestId,
    body,
    before: structuredClone(raw),
    expected: {
      qboId: raw.Id,
      totalAmtCents: cents(raw.TotalAmt ?? Math.abs(fresh.amount)),
      fundingAccountQboId: raw.AccountRef?.value ?? null,
      currencyQboId: raw.CurrencyRef?.value ?? null,
      txnDate: raw.TxnDate ?? null,
      credit: raw.Credit === true,
      taxCalculation: plan.taxCalculation,
      targetLines: expectedLines,
      untouchedLineHashes: keptLines.map(canonicalHash).sort(),
    },
  };
}

/**
 * Prepare an exact accounting-state restore after the caller has verified that
 * `fresh` still matches Recat's posted result.
 */
export function buildPurchaseRestore(
  fresh: QboTxn,
  before: RawPurchase,
  requestId: string,
): QboPreparedWrite {
  if (fresh.qboType !== 'Purchase') {
    throw new TaxPlanError('TAX_MODE_UNSUPPORTED', 'Tax-aware restore is supported only for Purchase.');
  }
  const freshRaw = fresh.raw as RawPurchase;
  const {
    TxnTaxDetail: _freshCalculatedTax,
    status: _freshStatus,
    ...freshWriteable
  } = freshRaw;
  const desired: RawPurchase = {
    ...freshWriteable,
    TxnDate: before.TxnDate,
    TotalAmt: before.TotalAmt,
    Credit: before.Credit,
    PaymentType: before.PaymentType,
    DocNumber: before.DocNumber,
    PrivateNote: before.PrivateNote,
    EntityRef: before.EntityRef,
    AccountRef: before.AccountRef,
    CurrencyRef: before.CurrencyRef,
    DepartmentRef: before.DepartmentRef,
    GlobalTaxCalculation: before.GlobalTaxCalculation,
    Id: before.Id,
    SyncToken: fresh.syncToken,
    Line: structuredClone(before.Line ?? []),
  };
  return {
    qboType: 'Purchase',
    operation: 'restore',
    path: '/purchase',
    requestId,
    body: desired,
    before: structuredClone(freshRaw),
    expected: {
      qboId: before.Id,
      accountingHash: canonicalHash(canonicalPurchaseAccountingState(before)),
      totalTaxCents:
        typeof before.TxnTaxDetail?.TotalTax === 'number'
          ? Math.round(Math.abs(before.TxnTaxDetail.TotalTax) * 100)
          : null,
    },
  };
}
