import type { TaxCalculation } from '@recat/shared';

interface SourceTaxCode {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
}

export interface SourcePurchaseTaxSelection {
  taxCalculation: TaxCalculation;
  taxCodeQboId: string;
}

export interface SourcePurchaseTaxDefault extends SourcePurchaseTaxSelection {
  taxCode: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function refValue(value: unknown): string | null {
  const ref = object(value);
  return typeof ref?.value === 'string' && ref.value.length > 0 ? ref.value : null;
}

function taxCalculation(value: unknown): TaxCalculation | null {
  return value === 'TaxInclusive' ||
    value === 'TaxExcluded' ||
    value === 'NotApplicable'
    ? value
    : null;
}

/**
 * Read the tax decision QuickBooks already placed on the holding-account
 * lines of a Purchase. A single-category default is safe only when every
 * holding line agrees on one TaxCode.
 */
export function sourcePurchaseTaxSelection(
  qboType: string,
  rawData: unknown,
  holdingAccountQboIds: readonly string[],
): SourcePurchaseTaxSelection | null {
  if (qboType !== 'Purchase' || holdingAccountQboIds.length === 0) return null;
  const raw = object(rawData);
  const mode = taxCalculation(raw?.GlobalTaxCalculation);
  const lines = Array.isArray(raw?.Line) ? raw.Line : [];
  if (!mode || lines.length === 0) return null;

  const holdingIds = new Set(holdingAccountQboIds);
  const codeIds = new Set<string>();
  for (const value of lines) {
    const line = object(value);
    const detail = object(line?.AccountBasedExpenseLineDetail);
    const accountQboId = refValue(detail?.AccountRef);
    if (!accountQboId || !holdingIds.has(accountQboId)) continue;
    const codeQboId = refValue(detail?.TaxCodeRef);
    if (!codeQboId) return null;
    codeIds.add(codeQboId);
  }
  if (codeIds.size !== 1) return null;
  const taxCodeQboId = [...codeIds][0];
  return taxCodeQboId ? { taxCalculation: mode, taxCodeQboId } : null;
}

/**
 * Attach the company-scoped display name only when Recat's v1 Purchase writer
 * supports the referenced code shape.
 */
export function completeSourcePurchaseTaxDefault(
  selection: SourcePurchaseTaxSelection | null,
  codes: readonly SourceTaxCode[],
): SourcePurchaseTaxDefault | null {
  if (!selection) return null;
  const code = codes.find((candidate) => candidate.qboId === selection.taxCodeQboId);
  if (!code?.active) return null;
  const purchaseRates = Array.isArray(code.purchaseTaxRateList)
    ? code.purchaseTaxRateList
    : [];
  const zeroRateShape = code.taxable === false && purchaseRates.length === 0;
  const simpleRateShape =
    selection.taxCalculation !== 'NotApplicable' && purchaseRates.length === 1;
  if (!zeroRateShape && !simpleRateShape) return null;
  return { ...selection, taxCode: code.name };
}
