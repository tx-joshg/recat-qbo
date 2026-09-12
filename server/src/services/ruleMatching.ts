/**
 * Canonical rule-v2 matching semantics. Production consumers must remain on
 * their bridge-v1 paths until Company.ruleRuntimeMode gates canonical/bridge
 * integration after nullable direction schema and controlled backfill.
 */
import type { RuleDirection } from '@recat/shared';
import { foldUnicodeDefaultCase } from './unicodeCaseFold.js';

export function normalizeRuleMatchText(value: string): string {
  const normalizedText = value
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ');

  return foldUnicodeDefaultCase(normalizedText).normalize('NFC');
}

export function transactionDirection(type: string): RuleDirection | null {
  if (type === 'Purchase' || type === 'Deposit') return type;
  return null;
}

export interface PreparedRuleMatchRule {
  readonly direction: RuleDirection | null;
  readonly matchKey: string;
}

export interface PreparedRuleMatchTransaction {
  readonly direction: RuleDirection | null;
  readonly descriptionKey: string;
}

export function prepareRuleMatchRule(
  rule: { matchText: string; direction: RuleDirection | null },
): PreparedRuleMatchRule {
  return {
    direction: rule.direction,
    matchKey: rule.direction === null ? '' : normalizeRuleMatchText(rule.matchText),
  };
}

export function prepareRuleMatchTransaction(
  transaction: { description: string; type: string },
): PreparedRuleMatchTransaction {
  const direction = transactionDirection(transaction.type);
  return {
    direction,
    descriptionKey: direction === null ? '' : normalizeRuleMatchText(transaction.description),
  };
}

export function preparedRuleMatches(
  rule: PreparedRuleMatchRule,
  transaction: PreparedRuleMatchTransaction,
): boolean {
  return rule.direction !== null
    && transaction.direction !== null
    && rule.direction === transaction.direction
    && rule.matchKey.length > 0
    && transaction.descriptionKey.includes(rule.matchKey);
}

export function ruleMatches(
  rule: { matchText: string; direction: RuleDirection | null },
  transaction: { description: string; type: string },
): boolean {
  const direction = transactionDirection(transaction.type);
  if (direction === null || rule.direction === null || rule.direction !== direction) {
    return false;
  }
  return preparedRuleMatches(
    prepareRuleMatchRule(rule),
    prepareRuleMatchTransaction(transaction),
  );
}

export function compareRuleWinner(
  left: { priority: number; createdAt: Date; id: string },
  right: { priority: number; createdAt: Date; id: string },
): number {
  const priorityDifference = left.priority - right.priority;
  if (priorityDifference !== 0) return priorityDifference;

  const createdAtDifference = right.createdAt.getTime() - left.createdAt.getTime();
  if (createdAtDifference !== 0) return createdAtDifference;

  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}
