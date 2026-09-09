import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AuditEntryDto } from '@recat/shared';
import {
  AUDIT_CSV_HEADER,
  buildAuditCsv,
  csvEscape,
  writeAudit,
} from './audit.js';

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

describe('writeAudit legacy payload redaction', () => {
  const auditFields = {
    companyId: 'company-example',
    actorLabel: 'Example operator',
    payee: 'Example supplier',
    amount: -12.34,
    action: 'posted' as const,
    before: 'Holding',
    after: 'Office supplies',
  };

  it('redacts nested credential keys before persistence without mutating the caller payload', async () => {
    const payload = Object.freeze({
      qbo: Object.freeze({ Id: 'purchase-example', SyncToken: '7', authorization: 'synthetic-authorization' }),
      syncToken: '7',
      accessToken: 'synthetic-access',
      nested: Object.freeze([
        Object.freeze({ refresh_token: 'synthetic-refresh', amount: 12.34, active: true }),
        null,
        'ordinary accounting note',
      ]),
    });
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => undefined);

    await writeAudit({ auditEntry: { create } } as never, { ...auditFields, payload });

    expect(create.mock.calls[0]?.[0].data).toEqual({
      ...auditFields,
      actorId: null,
      txnId: null,
      payload: {
        qbo: { Id: 'purchase-example', SyncToken: '7', authorization: '[REDACTED]' },
        syncToken: '7',
        accessToken: '[REDACTED]',
        nested: [{ refresh_token: '[REDACTED]', amount: 12.34, active: true }, null, 'ordinary accounting note'],
      },
    });
    expect(payload.qbo.authorization).toBe('synthetic-authorization');
    expect(payload.accessToken).toBe('synthetic-access');
    expect(payload.nested[0]).toEqual({ refresh_token: 'synthetic-refresh', amount: 12.34, active: true });
  });

  it('redacts credential spelling variants inside a top-level array', async () => {
    const payload = [{
      Authorization: 'synthetic-authorization',
      clientSecret: 'synthetic-client-secret',
      client_secret: 'synthetic-client-secret',
      'client-secret': 'synthetic-client-secret',
      apiKey: 'synthetic-api-key',
      api_key: 'synthetic-api-key',
      'api-key': 'synthetic-api-key',
      password: 'synthetic-password',
      sessionToken: 'synthetic-session',
      Line: [{ Amount: 12.34, AccountRef: { value: 'expense-example' } }],
    }];
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => undefined);

    await writeAudit({ auditEntry: { create } } as never, { ...auditFields, payload });

    expect(create.mock.calls[0]?.[0].data.payload).toEqual([{
      Authorization: '[REDACTED]',
      clientSecret: '[REDACTED]',
      client_secret: '[REDACTED]',
      'client-secret': '[REDACTED]',
      apiKey: '[REDACTED]',
      api_key: '[REDACTED]',
      'api-key': '[REDACTED]',
      password: '[REDACTED]',
      sessionToken: '[REDACTED]',
      Line: [{ Amount: 12.34, AccountRef: { value: 'expense-example' } }],
    }]);
  });

  it('preserves Date and Decimal JSON values without changing the caller payload', async () => {
    const date = Object.freeze(new Date('2026-01-02T03:04:05.000Z'));
    const amount = Object.freeze(new Prisma.Decimal('12.34'));
    const payload = Object.freeze({ at: date, nested: Object.freeze([amount]) });
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => undefined);

    await writeAudit({ auditEntry: { create } } as never, { ...auditFields, payload });

    expect(create.mock.calls[0]?.[0].data.payload).toEqual({
      at: '2026-01-02T03:04:05.000Z', nested: ['12.34'],
    });
    expect(payload.at).toBe(date);
    expect(date.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(payload.nested[0]).toBe(amount);
    expect(amount.toString()).toBe('12.34');
  });

  it('calls custom JSON serialization once and redacts its resulting credential fields', async () => {
    const serialized = Object.freeze({ nested: Object.freeze({ secret: 'synthetic-secret', amount: 12.34 }) });
    const toJSON = vi.fn(() => serialized);
    const payload = Object.freeze({ details: Object.freeze({ toJSON }) });
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => undefined);

    await writeAudit({ auditEntry: { create } } as never, { ...auditFields, payload });

    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].data.payload).toEqual({
      details: { nested: { secret: '[REDACTED]', amount: 12.34 } },
    });
    expect(serialized.nested.secret).toBe('synthetic-secret');
  });

  it.each([
    'secret', 'secret_key', 'privateKey', 'private_key', 'accessKey',
    'access_key', 'passwd', 'pwd', 'bearer', 'credentials', 'passphrase',
  ])('redacts the credential field %s', async (key) => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => undefined);
    await writeAudit({ auditEntry: { create } } as never, {
      ...auditFields,
      payload: { nested: { [key]: 'synthetic-value', amount: 12.34 } },
    });
    expect(create.mock.calls[0]?.[0].data.payload).toEqual({
      nested: { [key]: '[REDACTED]', amount: 12.34 },
    });
  });
});

describe('writeAudit mutation metadata', () => {
  it('stores only bounded normalized references, request ID, and outcome', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User',
        txnId: 'transaction-generic',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'posted',
        before: 'Holding',
        after: 'Prepared purchase',
        payload: {
          accessToken: 'must-not-survive',
          body: { secret: 'must-not-survive' },
        },
        mutation: {
          requestId: ' request-generic ',
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: ' purchase-generic ',
            accountQboIds: ['expense-b', 'expense-a', 'expense-a'],
            taxCodeQboIds: ['tax-generic'],
          },
        },
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: {
          requestId: 'request-generic',
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            accountQboIds: ['expense-a', 'expense-b'],
            taxCodeQboIds: ['tax-generic'],
          },
        },
      }),
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toMatch(
      /accessToken|must-not-survive|secret|SyncToken|beforeSnapshot|requestPayload/,
    );
  });

  it('truncates references to 128 characters and caps each reference list at 50', async () => {
    const create = vi.fn(async () => undefined);
    const longReference = `reference-${'x'.repeat(200)}`;
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorLabel: 'Generic User',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'posted',
        before: 'Holding',
        after: 'Prepared purchase',
        mutation: {
          requestId: `request-${'r'.repeat(200)}`,
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: longReference,
            accountQboIds: Array.from(
              { length: 60 },
              (_value, index) => `${String(index).padStart(2, '0')}-${longReference}`,
            ),
            taxCodeQboIds: Array.from(
              { length: 55 },
              (_value, index) => `${String(index).padStart(2, '0')}-tax-${'t'.repeat(180)}`,
            ),
          },
        },
      },
    );

    const payload = create.mock.calls[0]?.[0].data.payload as {
      requestId: string;
      references: {
        qboId: string;
        accountQboIds: string[];
        taxCodeQboIds: string[];
      };
    };
    expect(payload.requestId).toHaveLength(128);
    expect(payload.references.qboId).toHaveLength(128);
    expect(payload.references.accountQboIds).toHaveLength(50);
    expect(payload.references.taxCodeQboIds).toHaveLength(50);
    expect(payload.references.accountQboIds.every((reference) => reference.length <= 128)).toBe(true);
    expect(payload.references.taxCodeQboIds.every((reference) => reference.length <= 128)).toBe(true);
  });

  it('stores only bounded MCP operation attribution and excludes raw proof or prepared data', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User (MCP rct_example1)',
        txnId: 'transaction-generic',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'reverted',
        before: 'Prepared purchase',
        after: 'QuickBooks Purchase',
        mutation: {
          requestId: 'undo-operation',
          outcome: 'VERIFIED',
          references: {
            operation: 'restore',
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            accountQboIds: [],
            taxCodeQboIds: [],
          },
          mcp: {
            sourceOperationId: `source-${'s'.repeat(200)}`,
            operationId: `undo-${'o'.repeat(200)}`,
            tokenPrefix: `rct_${'p'.repeat(30)}`,
            sourcePreparedHash: 'must-not-survive',
            currentPostHash: 'must-not-survive',
            restoreHash: 'must-not-survive',
            body: { secret: 'must-not-survive' },
          } as never,
        },
      },
    );

    const payload = create.mock.calls[0]?.[0].data.payload as {
      mcp: {
        sourceOperationId: string;
        operationId: string;
        tokenPrefix: string;
      };
    };
    expect(payload.mcp).toEqual({
      sourceOperationId: `source-${'s'.repeat(121)}`,
      operationId: `undo-${'o'.repeat(123)}`,
      tokenPrefix: 'rct_pppppppp',
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /sourcePreparedHash|currentPostHash|restoreHash|must-not-survive|secret|body/,
    );
  });

  it('stores bounded transfer attribution without prepared bodies or provider details', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User (MCP rct_example1)',
        txnId: 'transaction-generic',
        payee: 'Generic Transfer',
        amount: -250,
        action: 'transfer',
        before: 'QuickBooks transfer source',
        after: 'Transfer to counterpart account',
        payload: {
          accessToken: 'must-not-survive',
          requestPayload: { SyncToken: 'must-not-survive' },
          providerError: 'must-not-survive',
        },
        mutation: {
          requestId: `transfer-request-${'r'.repeat(200)}`,
          outcome: 'VERIFIED',
          references: {
            operation: 'transfer',
            qboType: 'Transfer',
            qboId: `transfer-${'q'.repeat(200)}`,
            accountQboIds: ['bank-b', 'bank-a', 'bank-b'],
            taxCodeQboIds: [],
          },
          mcp: {
            sourceOperationId: `source-${'s'.repeat(200)}`,
            operationId: `operation-${'o'.repeat(200)}`,
            tokenPrefix: `rct_${'p'.repeat(30)}`,
          },
        },
      },
    );

    const data = create.mock.calls[0]?.[0].data;
    expect(data).toEqual(expect.objectContaining({
      action: 'transfer',
      payload: {
        requestId: `transfer-request-${'r'.repeat(111)}`,
        outcome: 'VERIFIED',
        references: {
          operation: 'transfer',
          qboType: 'Transfer',
          qboId: `transfer-${'q'.repeat(119)}`,
          accountQboIds: ['bank-a', 'bank-b'],
          taxCodeQboIds: [],
        },
        mcp: {
          sourceOperationId: `source-${'s'.repeat(121)}`,
          operationId: `operation-${'o'.repeat(118)}`,
          tokenPrefix: 'rct_pppppppp',
        },
      },
    }));
    expect(JSON.stringify(data)).not.toMatch(
      /accessToken|requestPayload|SyncToken|providerError|must-not-survive/,
    );
  });
});
