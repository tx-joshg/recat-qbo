import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { loadAgentToolContext, sanitizeOriginalPurchaseLines } from './context.js';

describe('agent context', () => {
  it('strips raw Purchase data down to accounting line context', () => {
    const lines = sanitizeOriginalPurchaseLines({
      accessToken: 'must-not-leak',
      Line: [
        {
          Id: 'line-1',
          Amount: 29,
          Description: 'Monthly plan',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'holding-1', name: 'Secret-ish display' },
            TaxCodeRef: { value: 'gst' },
            TaxInclusiveAmt: 29,
            CustomerRef: { value: 'customer-private' },
          },
        },
      ],
    });
    expect(lines).toEqual([
      {
        lineId: 'line-1',
        amount: 29,
        description: 'Monthly plan',
        detailType: 'AccountBasedExpenseLineDetail',
        accountQboId: 'holding-1',
        taxCodeQboId: 'gst',
        taxInclusiveAmount: 29,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('accessToken');
    expect(JSON.stringify(lines)).not.toContain('customer-private');
  });

  it('binds company and transaction in the host, not model arguments', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'txn-1',
      qboType: 'Purchase',
      qboSyncToken: '1',
      date: new Date('2026-07-23'),
      payee: 'WEBFLOW',
      memo: null,
      amount: -29,
      bankAccount: 'Visa',
      updatedAt: new Date('2026-07-23T12:00:00Z'),
      rawData: { Line: [] },
      company: { holdingAccountIds: ['holding-1'] },
    }));
    const db = { transaction: { findFirst } } as unknown as PrismaClient;
    const context = await loadAgentToolContext(db, 'co-1', 'txn-1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'txn-1', companyId: 'co-1' } }),
    );
    expect(context).toMatchObject({ companyId: 'co-1', transactionId: 'txn-1' });
  });
});
