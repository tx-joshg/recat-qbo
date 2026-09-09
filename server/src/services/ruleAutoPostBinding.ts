import { createHash } from 'node:crypto';

export function canonicalRuleAutoPostJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRuleAutoPostJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalRuleAutoPostJson(record[key])}`
  )).join(',')}}`;
}

export function hashRuleAutoPostValue(value: unknown): string {
  return createHash('sha256').update(canonicalRuleAutoPostJson(value), 'utf8').digest('hex');
}
