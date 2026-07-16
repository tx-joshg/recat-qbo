import { describe, expect, it } from 'vitest';
import type { AuditEntryDto } from '@recat/shared';
import { AUDIT_CSV_HEADER, buildAuditCsv, csvEscape } from './audit.js';

function entry(overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: 'a1',
    companyId: 'c1',
    at: '2026-07-15T12:00:00.000Z',
    actor: 'Josh',
    payee: 'Staples',
    amount: -42.5,
    action: 'posted',
    before: 'Uncategorized Expense',
    after: 'Office Supplies',
    ...overrides,
  };
}

describe('csvEscape', () => {
  it('passes plain values through untouched', () => {
    expect(csvEscape('Office Supplies')).toBe('Office Supplies');
  });

  it('quotes values containing commas', () => {
    expect(csvEscape('Meals, Entertainment')).toBe('"Meals, Entertainment"');
  });

  it('doubles embedded quotes and wraps in quotes', () => {
    expect(csvEscape('Bob "The Builder" LLC')).toBe('"Bob ""The Builder"" LLC"');
  });

  it('quotes values containing newlines', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('buildAuditCsv', () => {
  it('emits the exact required header', () => {
    const csv = buildAuditCsv([]);
    expect(csv.split('\n')[0]).toBe('When,Who,Transaction,Amount,Action,Before,After');
    expect(AUDIT_CSV_HEADER).toBe('When,Who,Transaction,Amount,Action,Before,After');
  });

  it('formats a row with a fixed two-decimal amount', () => {
    const csv = buildAuditCsv([entry()]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('2026-07-15T12:00:00.000Z,Josh,Staples,-42.50,posted,Uncategorized Expense,Office Supplies');
  });

  it('escapes payees with commas and quotes so columns stay aligned', () => {
    const csv = buildAuditCsv([entry({ payee: 'Acme, "Inc."', after: 'Meals, 50% deductible' })]);
    const row = csv.trimEnd().split('\n')[1] as string;
    expect(row).toBe(
      '2026-07-15T12:00:00.000Z,Josh,"Acme, ""Inc.""",-42.50,posted,Uncategorized Expense,"Meals, 50% deductible"',
    );
  });

  it('keeps one line per entry even when a field contains a newline', () => {
    const csv = buildAuditCsv([entry({ after: 'Split:\nOffice / Meals' })]);
    // Quoted newline stays inside the quoted field; naive line count is header + 2
    // but a CSV parser sees exactly one record. Assert the quoting is present.
    expect(csv).toContain('"Split:\nOffice / Meals"');
  });
});
