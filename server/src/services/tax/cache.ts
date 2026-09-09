import type { QboTaxRateInfo } from '../../lib/qbo/types.js';
import { isSupportedTaxRateValue } from '../../lib/qbo/purchaseTax.js';

export interface CachedTaxRateRow {
  qboId: unknown;
  name?: unknown;
  description?: unknown;
  active: unknown;
  rateValue: unknown;
  sourceUpdatedAt?: unknown;
}

export interface CachedTaxCodeRow {
  active: unknown;
  taxable: unknown;
  purchaseTaxRateList?: unknown;
  salesTaxRateList?: unknown;
  purchaseRates?: unknown;
  salesRates?: unknown;
}

export interface CachedTaxCodeSupport {
  supported: boolean;
  combinedRate: number | null;
  componentCount: number;
}

interface TaxComponent {
  taxRateQboId: string;
  taxTypeApplicable: string;
}

function sourceUpdatedAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return null;
}

export function cachedTaxRates(rows: readonly CachedTaxRateRow[]): QboTaxRateInfo[] {
  return rows.flatMap((row) => {
    const rateValue = row.rateValue === null ? Number.NaN : Number(row.rateValue);
    if (
      typeof row.qboId !== 'string'
      || row.qboId.trim() === ''
      || row.active !== true
      || !isSupportedTaxRateValue(rateValue)
    ) return [];
    return [{
      qboId: row.qboId,
      name: typeof row.name === 'string' ? row.name : '',
      description: typeof row.description === 'string' ? row.description : null,
      active: true,
      rateValue,
      sourceUpdatedAt: sourceUpdatedAt(row.sourceUpdatedAt),
    }];
  });
}

function components(value: unknown): TaxComponent[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: TaxComponent[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'object'
      || entry === null
      || !('taxRateQboId' in entry)
      || !('taxTypeApplicable' in entry)
      || typeof entry.taxRateQboId !== 'string'
      || entry.taxRateQboId.trim() === ''
      || typeof entry.taxTypeApplicable !== 'string'
      || entry.taxTypeApplicable.trim() === ''
    ) return null;
    parsed.push({
      taxRateQboId: entry.taxRateQboId,
      taxTypeApplicable: entry.taxTypeApplicable,
    });
  }
  return parsed;
}

export function cachedTaxCodeSupport(
  code: CachedTaxCodeRow,
  rates: readonly QboTaxRateInfo[],
  direction: 'purchase' | 'sales',
): CachedTaxCodeSupport {
  const rawComponents = direction === 'purchase'
    ? code.purchaseTaxRateList ?? code.purchaseRates
    : code.salesTaxRateList ?? code.salesRates;
  const parsed = components(rawComponents);
  if (code.active !== true || parsed === null) {
    return { supported: false, combinedRate: null, componentCount: 0 };
  }
  if (code.taxable === false && parsed.length === 0) {
    return { supported: true, combinedRate: null, componentCount: 0 };
  }
  if (code.taxable !== true || parsed.length === 0) {
    return { supported: false, combinedRate: null, componentCount: 0 };
  }

  const ratesById = new Map(rates.map((rate) => [rate.qboId, rate]));
  const seen = new Set<string>();
  let combinedRate = 0;
  for (const component of parsed) {
    if (seen.has(component.taxRateQboId)) {
      return { supported: false, combinedRate: null, componentCount: 0 };
    }
    seen.add(component.taxRateQboId);
    const rate = ratesById.get(component.taxRateQboId);
    if (
      rate === undefined
      || rate.active !== true
      || component.taxTypeApplicable !== 'TaxOnAmount'
      || !isSupportedTaxRateValue(rate.rateValue)
    ) return { supported: false, combinedRate: null, componentCount: 0 };
    combinedRate = Number((combinedRate + rate.rateValue).toFixed(6));
    if (!isSupportedTaxRateValue(combinedRate)) {
      return { supported: false, combinedRate: null, componentCount: 0 };
    }
  }
  return { supported: true, combinedRate, componentCount: parsed.length };
}

export function deriveCachedTaxCodeRates<T extends CachedTaxCodeRow>(
  codes: readonly T[],
  rateRows: readonly CachedTaxRateRow[],
): Array<T & { combinedPurchaseRate: number | null; combinedSalesRate: number | null }> {
  const rates = cachedTaxRates(rateRows);
  return codes.map((code) => ({
    ...code,
    combinedPurchaseRate: cachedTaxCodeSupport(code, rates, 'purchase').combinedRate,
    combinedSalesRate: cachedTaxCodeSupport(code, rates, 'sales').combinedRate,
  }));
}
