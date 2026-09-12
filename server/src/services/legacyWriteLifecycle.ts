import {
  cachedSalesTaxReadiness,
  type CachedSalesTaxCode,
} from './tax/reference.js';

export interface LegacyStagingState {
  qboType: string;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  splitTaxCodeQboIds: readonly (string | null | undefined)[];
  hasDurableAttempt: boolean;
  company: {
    taxSupportStatus: string;
    taxUsingSalesTax: boolean | null;
    taxSupportReason: string | null;
  };
  cachedSalesTaxCodes: CachedSalesTaxCode[];
}

/**
 * Returns whether a transaction must use the durable staged lifecycle.
 * Queue posting and Audit undo offers share this exact decision so the UI
 * never advertises a legacy operation that the write boundary will reject.
 */
export function legacyStagingRequired(state: LegacyStagingState): boolean {
  if (
    state.taxCalculation !== null
    || state.taxCodeQboId !== null
    || state.splitTaxCodeQboIds.some((taxCodeQboId) => taxCodeQboId != null)
  ) {
    return true;
  }
  if (state.hasDurableAttempt) return true;
  if (state.qboType === 'Purchase') {
    return state.company.taxSupportStatus === 'ready';
  }
  if (state.qboType !== 'Deposit') return false;
  return cachedSalesTaxReadiness(
    state.company.taxUsingSalesTax,
    state.cachedSalesTaxCodes,
    state.company.taxSupportReason,
  ).status === 'ready';
}
