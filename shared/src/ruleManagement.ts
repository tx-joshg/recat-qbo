import type { TaxCalculation } from './index.js';

export type RuleDirection = 'Purchase' | 'Deposit';
export type RuleCurrentState = 'enabled' | 'disabled';
export type HistoricalRuleRevisionState = RuleCurrentState | 'retired';

export interface RuleActionV2 {
  version: 2;
  direction: RuleDirection;
  category: string;
  categoryQboId: string;
  taxCalculation: TaxCalculation;
  taxCodeQboId: string | null;
  tagIds: string[];
}

export type RuleSuggestionDto = {
  source: 'rule';
  version: 2;
  ruleId: string;
  ruleRevision: number;
  action: RuleActionV2;
  autoPost: boolean;
};

export type CategoryHintSuggestionDto = {
  source: 'history' | 'ai';
  category: string;
  categoryQboId?: string;
};

export type CanonicalSuggestionDto = RuleSuggestionDto | CategoryHintSuggestionDto;

const RULE_ACTION_KEYS = [
  'version',
  'direction',
  'category',
  'categoryQboId',
  'taxCalculation',
  'taxCodeQboId',
  'tagIds',
] as const;

const RULE_SUGGESTION_KEYS = [
  'source',
  'version',
  'ruleId',
  'ruleRevision',
  'action',
  'autoPost',
] as const;

const CATEGORY_HINT_KEYS = ['source', 'category', 'categoryQboId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowedKeys.includes(key))
    && requiredKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isTaxCalculation(value: unknown): value is TaxCalculation {
  return value === 'TaxInclusive'
    || value === 'TaxExcluded'
    || value === 'NotApplicable';
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(label: string): never {
  throw new TypeError(`Invalid ${label}`);
}

export function parseRuleCurrentState(value: unknown): RuleCurrentState {
  if (value !== 'enabled' && value !== 'disabled') {
    return invalid('current rule state');
  }
  return value;
}

export function parseHistoricalRuleRevisionState(
  value: unknown,
): HistoricalRuleRevisionState {
  if (value === 'retired') return value;
  return parseRuleCurrentState(value);
}

export function parseRuleActionV2(value: unknown): RuleActionV2 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, RULE_ACTION_KEYS)
    || value.version !== 2
    || (value.direction !== 'Purchase' && value.direction !== 'Deposit')
    || !isNonBlankString(value.category)
    || !isNonBlankString(value.categoryQboId)
    || !isTaxCalculation(value.taxCalculation)
    || (value.taxCodeQboId !== null && typeof value.taxCodeQboId !== 'string')
    || (value.taxCodeQboId !== null && !isNonBlankString(value.taxCodeQboId))
    || (value.taxCalculation === 'NotApplicable' && value.taxCodeQboId !== null)
    || (value.taxCalculation !== 'NotApplicable' && value.taxCodeQboId === null)
    || !Array.isArray(value.tagIds)
    || !value.tagIds.every(isNonBlankString)
    || new Set(value.tagIds).size !== value.tagIds.length
  ) {
    return invalid('rule action');
  }

  return value as unknown as RuleActionV2;
}

export function parseRuleSuggestionDto(value: unknown): RuleSuggestionDto {
  if (
    !isRecord(value)
    || !hasExactKeys(value, RULE_SUGGESTION_KEYS)
    || value.source !== 'rule'
    || value.version !== 2
    || !isNonBlankString(value.ruleId)
    || typeof value.ruleRevision !== 'number'
    || !Number.isSafeInteger(value.ruleRevision)
    || value.ruleRevision <= 0
    || typeof value.autoPost !== 'boolean'
  ) {
    return invalid('rule suggestion');
  }

  try {
    parseRuleActionV2(value.action);
  } catch {
    return invalid('rule suggestion');
  }

  return value as unknown as RuleSuggestionDto;
}

export function parseCategoryHintSuggestionDto(
  value: unknown,
): CategoryHintSuggestionDto {
  if (
    !isRecord(value)
    || !hasExactKeys(value, CATEGORY_HINT_KEYS, ['source', 'category'])
    || (value.source !== 'history' && value.source !== 'ai')
    || !isNonBlankString(value.category)
    || (Object.hasOwn(value, 'categoryQboId') && !isNonBlankString(value.categoryQboId))
  ) {
    return invalid('category hint suggestion');
  }

  return value as CategoryHintSuggestionDto;
}

export function parseCanonicalSuggestionDto(value: unknown): CanonicalSuggestionDto {
  if (!isRecord(value)) return invalid('suggestion');
  if (value.source === 'rule') return parseRuleSuggestionDto(value);
  if (value.source === 'history' || value.source === 'ai') {
    return parseCategoryHintSuggestionDto(value);
  }
  return invalid('suggestion source');
}
