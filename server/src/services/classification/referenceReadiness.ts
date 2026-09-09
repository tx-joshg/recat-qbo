export interface ClassificationReferenceFacts {
  categoryActive: boolean;
  taxReady: boolean;
  taxCodeEligible: boolean;
  tagsExist: boolean;
}

interface ClassificationReferenceAction {
  categoryQboId: string | null;
  taxCalculation: unknown;
  taxCodeQboId: string | null;
  tagIds: readonly string[];
}

/** Canonical action-reference gate shared by company reads and search cards. */
export function classificationReferenceReasons(
  action: ClassificationReferenceAction,
  facts: ClassificationReferenceFacts,
): string[] {
  const reasons: string[] = [];
  if (!facts.categoryActive) reasons.push('Category account is missing or inactive.');
  if (action.taxCalculation !== 'TaxInclusive'
    && action.taxCalculation !== 'TaxExcluded'
    && action.taxCalculation !== 'NotApplicable') {
    reasons.push('Tax treatment is missing or invalid.');
  }
  const taxed = action.taxCalculation === 'TaxInclusive' || action.taxCalculation === 'TaxExcluded';
  if (taxed && !facts.taxReady) reasons.push('Tax reference is not ready.');
  if (taxed && !facts.taxCodeEligible) reasons.push('Tax code is missing or ineligible.');
  if (action.taxCalculation === 'NotApplicable' && action.taxCodeQboId !== null) {
    reasons.push('Tax treatment is missing or invalid.');
  }
  if (!facts.tagsExist) reasons.push('One or more tags no longer exist.');
  return reasons.slice(0, 4);
}
