import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AgentToolContext } from './context.js';
import { createAgentToolRegistry } from './tools.js';

const context: AgentToolContext = {
  schemaVersion: 'recat-agent-context-v1',
  companyId: 'co-1',
  transactionId: 'txn-1',
  expectedUpdatedAt: new Date('2026-07-23T12:00:00Z'),
  transaction: {
    id: 'txn-1',
    qboType: 'Purchase',
    qboSyncToken: '1',
    date: '2026-07-23T00:00:00.000Z',
    payee: 'WEBFLOW',
    memo: null,
    amount: -29,
    bankAccount: 'Visa',
  },
  holdingAccountQboIds: ['holding-1'],
  originalLines: [],
};

function toolDb() {
  return {
    transaction: { findMany: vi.fn(async () => []) },
    qboAccount: { findMany: vi.fn(async () => []) },
    qboTaxCode: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
}

describe('agent tool registry', () => {
  it('has no model argument that can override company or transaction scope', () => {
    const registry = createAgentToolRegistry(toolDb(), context);
    for (const definition of registry.definitions) {
      const properties = definition.parameters.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty('companyId');
      expect(properties).not.toHaveProperty('transactionId');
    }
  });

  it('declares every strict function property required and uses null for defaults', async () => {
    const registry = createAgentToolRegistry(toolDb(), context);
    for (const definition of registry.definitions) {
      const properties = definition.parameters.properties as Record<string, unknown>;
      expect(definition.parameters.required).toEqual(Object.keys(properties));
    }
    await expect(
      registry.execute('find_similar_transactions', { query: null, limit: null }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.execute('get_payee_history', { limit: null }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.execute('list_allowed_accounts', { offset: null, limit: null }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.execute('list_purchase_tax_codes', { offset: null, limit: null }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('returns structured argument/unknown-tool errors without echoing input', async () => {
    const registry = createAgentToolRegistry(toolDb(), context);
    const malformed = await registry.execute('get_transaction', {
      companyId: 'co-secret',
      accessToken: 'secret-token',
    });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'TOOL_ARGS' } });
    expect(JSON.stringify(malformed)).not.toContain('secret-token');
    await expect(registry.execute('post_transaction', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOOL_UNKNOWN' },
    });
  });

  it('queries history only inside the bound company and caps results', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: `history-${index}`,
      date: new Date(`2026-07-${String(22 - index).padStart(2, '0')}`),
      payee: 'WEBFLOW',
      memo: null,
      amount: -29,
      category: 'Software',
      categoryQboId: 'acct-1',
      taxCalculation: 'TaxInclusive',
      taxCode: 'GST 5%',
      taxCodeQboId: 'gst',
    }));
    const findMany = vi.fn(async () => rows);
    const db = {
      transaction: { findMany },
      qboAccount: { findMany: vi.fn() },
      qboTaxCode: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const result = await createAgentToolRegistry(db, context).execute('get_payee_history', {
      limit: 20,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: 'co-1' }), take: 201 }),
    );
    expect(result).toMatchObject({ ok: true, hasMore: true });
    if (result.ok) expect(result.data).toHaveLength(20);
  });

  it('finds recurring history across changing merchant suffixes', async () => {
    const matching = {
      id: 'history-1',
      date: new Date('2026-07-22'),
      payee: 'WEBFLOW * 5678',
      memo: null,
      amount: -29,
      category: 'Software',
      categoryQboId: 'acct-1',
      taxCalculation: 'TaxInclusive',
      taxCode: 'GST 5%',
      taxCodeQboId: 'gst',
    };
    const findMany = vi.fn(async () => [
      matching,
      { ...matching, id: 'history-2', payee: 'WEBFLOW CONSULTING' },
    ]);
    const db = {
      transaction: { findMany },
      qboAccount: { findMany: vi.fn() },
      qboTaxCode: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const suffixContext = {
      ...context,
      transaction: { ...context.transaction, payee: 'WEBFLOW * 1234' },
    };

    const result = await createAgentToolRegistry(db, suffixContext).execute(
      'get_payee_history',
      { limit: 10 },
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          payee: { contains: 'WEBFLOW', mode: 'insensitive' },
        }),
        take: 101,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ id: 'history-1' })],
    });
  });

  it('excludes holding, inactive, bank, and income accounts', async () => {
    const db = {
      transaction: { findMany: vi.fn() },
      qboAccount: {
        findMany: vi.fn(async () => [
          {
            qboId: 'expense-1',
            name: 'Software',
            fullName: 'Expenses · Software',
            classification: 'Expense',
            accountType: 'Expense',
            active: true,
          },
          {
            qboId: 'holding-1',
            name: 'Ask My Accountant',
            fullName: 'Ask My Accountant',
            classification: 'Expense',
            accountType: 'Expense',
            active: true,
          },
          {
            qboId: 'bank-1',
            name: 'Checking',
            fullName: 'Checking',
            classification: 'Bank',
            accountType: 'Bank',
            active: true,
          },
          {
            qboId: 'credit-card-1',
            name: 'Corporate Visa',
            fullName: 'Corporate Visa',
            classification: 'CreditCard',
            accountType: 'Credit Card',
            active: true,
          },
          {
            qboId: 'income-1',
            name: 'Sales',
            fullName: 'Sales',
            classification: 'Income',
            accountType: 'Income',
            active: true,
          },
        ]),
      },
      qboTaxCode: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const result = await createAgentToolRegistry(db, context).execute('list_allowed_accounts', {
      offset: 0,
      limit: 40,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [expect.objectContaining({ qboId: 'expense-1' })],
        nextOffset: null,
      },
    });
  });

  it('pages allowed accounts with a bounded response and stable next offset', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      qboId: `expense-${index}`,
      name: `Expense ${index}`,
      fullName: `Expenses · ${index}`,
      classification: 'Expense',
      accountType: 'Expense',
      active: true,
    }));
    const findMany = vi.fn(async () => rows);
    const db = {
      transaction: { findMany: vi.fn() },
      qboAccount: { findMany },
      qboTaxCode: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    const result = await createAgentToolRegistry(db, context).execute('list_allowed_accounts', {
      offset: 80,
      limit: 10,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'co-1', active: true },
        skip: 80,
        take: 11,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      hasMore: true,
      data: { items: expect.any(Array), nextOffset: 90 },
    });
    if (result.ok) {
      expect((result.data as { items: unknown[] }).items).toHaveLength(10);
    }
  });

  it('returns only active purchase-capable TaxCodes and strips raw rate details', async () => {
    const db = {
      transaction: { findMany: vi.fn() },
      qboAccount: { findMany: vi.fn() },
      qboTaxCode: {
        findMany: vi.fn(async () => [
          {
            qboId: 'gst',
            name: 'GST 5%',
            description: null,
            active: true,
            taxable: true,
            purchaseTaxRateList: [{ taxRateQboId: 'rate-1', secret: 'not-returned' }],
          },
          {
            qboId: 'sales',
            name: 'Sales only',
            description: null,
            active: true,
            taxable: true,
            purchaseTaxRateList: [],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const result = await createAgentToolRegistry(db, context).execute(
      'list_purchase_tax_codes',
      { offset: 0, limit: 40 },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [expect.objectContaining({ qboId: 'gst', purchaseRateCount: 1 })],
        nextOffset: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('not-returned');
  });

  it('pages purchase TaxCodes instead of exposing an unreachable truncated tail', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      qboId: `tax-${index}`,
      name: `Tax ${index}`,
      description: null,
      active: true,
      taxable: true,
      purchaseTaxRateList: [{ taxRateQboId: `rate-${index}` }],
    }));
    const findMany = vi.fn(async () => rows);
    const db = {
      transaction: { findMany: vi.fn() },
      qboAccount: { findMany: vi.fn() },
      qboTaxCode: { findMany },
    } as unknown as PrismaClient;

    const result = await createAgentToolRegistry(db, context).execute(
      'list_purchase_tax_codes',
      { offset: 40, limit: 10 },
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 11 }),
    );
    expect(result).toMatchObject({
      ok: true,
      hasMore: true,
      data: { items: expect.any(Array), nextOffset: 50 },
    });
  });

  it('searches transfer candidates around the bound transaction instead of a global first page', async () => {
    const counterpart = {
      id: 'txn-counterpart',
      amount: 29,
      bankAccount: 'Checking',
      date: new Date('2026-07-24T00:00:00Z'),
      payee: 'Card payment',
    };
    const findMany = vi.fn(async () => [counterpart]);
    const db = {
      transaction: { findMany },
      qboAccount: { findMany: vi.fn() },
      qboTaxCode: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    const result = await createAgentToolRegistry(db, context).execute(
      'find_transfer_candidates',
      {},
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          id: { not: 'txn-1' },
          amount: 29,
          bankAccount: { not: 'Visa' },
          date: {
            gte: new Date('2026-07-20T00:00:00Z'),
            lte: new Date('2026-07-26T00:00:00Z'),
          },
        }),
        take: 101,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ id: 'txn-counterpart' })],
    });
  });
});
