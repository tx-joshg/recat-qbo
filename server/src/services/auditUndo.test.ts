import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntryDto } from '@recat/shared';

const prismaMock = vi.hoisted(() => ({
  transaction: { findMany: vi.fn() },
  auditEntry: { findMany: vi.fn() },
  qboTaxCode: { findMany: vi.fn() },
  qboTaxRate: { findMany: vi.fn() },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));

import {
  decorateAuditEntriesWithUndo,
  auditPageNeedsSalesTaxCodes,
  listAudit,
} from './audit.js';

function entry(overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: 'a1',
    companyId: 'c1',
    at: '2026-07-15T12:00:00.000Z',
    actor: 'Example user',
    payee: 'Example supplier',
    amount: -42.5,
    action: 'posted',
    before: 'Uncategorized Expense',
    after: 'Office Supplies',
    ...overrides,
  };
}

describe('decorateAuditEntriesWithUndo', () => {
  beforeEach(() => {
    prismaMock.transaction.findMany.mockReset();
    prismaMock.auditEntry.findMany.mockReset();
    prismaMock.qboTaxCode.findMany.mockReset();
    prismaMock.qboTaxRate.findMany.mockReset();
  });

  it('omits raw payload from list responses even when legacy metadata is stored', async () => {
    prismaMock.auditEntry.findMany.mockResolvedValueOnce([{ id: 'audit-example', companyId: 'c1', txnId: null,
      at: new Date(), actorLabel: 'Example user', payee: 'Example supplier', amount: -10,
      action: 'posted', before: 'Holding', after: 'Expense', payload: { rawProviderBody: 'synthetic-private-body' } }]);
    const page = await listAudit('c1');
    expect(page.entries[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(page)).not.toContain('synthetic-private-body');
  });

  it('offers durable undo only on the latest current verified categorization write', () => {
    const current = entry({
      id: 'audit-current',
      transactionId: 'transaction-generic',
      at: '2026-07-28T11:59:59.000Z',
      payload: {
        requestId: 'request-current',
        outcome: 'VERIFIED',
        references: { operation: 'recategorize' },
      },
    });
    const older = entry({ id: 'audit-older', at: '2026-07-20T12:00:00.000Z' });

    const decorated = decorateAuditEntriesWithUndo(
      [current, older],
      [{
        id: 'transaction-generic',
        status: 'POSTED',
        postedAt: new Date('2026-07-28T12:00:00.000Z'),
        legacyUndoAllowed: true,
      }],
      [{ id: 'audit-current', txnId: 'transaction-generic', payload: current.payload }],
      new Date('2026-07-29T12:00:00.000Z'),
    );

    expect(decorated[0]).toMatchObject({
      transactionId: 'transaction-generic',
      undo: { kind: 'categorization' },
    });
    expect(decorated[1]?.undo).toBeUndefined();
  });

  it.each([
    ['future', '2026-08-02T12:00:00.000Z', false],
    ['missing', null, false],
    ['exactly thirty days', '2026-07-02T12:00:00.000Z', true],
    ['past thirty days', '2026-07-02T11:59:59.999Z', false],
  ] as const)('handles a %s posted timestamp consistently', (_case, postedAt, allowed) => {
    const current = entry({ transactionId: 'transaction-example' });
    const [decorated] = decorateAuditEntriesWithUndo([current], [{ id: 'transaction-example', status: 'POSTED', postedAt: postedAt ? new Date(postedAt) : null, legacyUndoAllowed: true }], [{ id: current.id, txnId: 'transaction-example', payload: null }], new Date('2026-08-01T12:00:00.000Z'));
    expect(decorated?.undo !== undefined).toBe(allowed);
  });

  it('withholds an older entry when the latest write is outside this page or search result', () => {
    const older = entry({ id: 'older-example', transactionId: 'transaction-example' });
    const [decorated] = decorateAuditEntriesWithUndo([older], [{ id: 'transaction-example', status: 'POSTED', postedAt: new Date('2026-08-01T12:00:00.000Z'), legacyUndoAllowed: true }], [{ id: 'newer-example', txnId: 'transaction-example', payload: null }], new Date('2026-08-01T12:00:00.000Z'));
    expect(decorated?.undo).toBeUndefined();
  });

  it('offers legacy undo for a current legacy post and none after the window', () => {
    const legacy = entry({ id: 'audit-legacy', transactionId: 'transaction-legacy' });
    const available = decorateAuditEntriesWithUndo(
      [legacy],
      [{
        id: 'transaction-legacy',
        status: 'POSTED',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
        legacyUndoAllowed: true,
      }],
      [{ id: 'audit-legacy', txnId: 'transaction-legacy', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );
    const expired = decorateAuditEntriesWithUndo(
      [legacy],
      [{
        id: 'transaction-legacy',
        status: 'POSTED',
        postedAt: new Date('2026-06-01T12:00:00.000Z'),
        legacyUndoAllowed: true,
      }],
      [{ id: 'audit-legacy', txnId: 'transaction-legacy', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(available[0]?.undo).toEqual({ kind: 'legacy' });
    expect(expired[0]?.undo).toBeUndefined();
  });

  it('does not offer legacy undo when the transaction now requires staged restore', () => {
    const legacy = entry({ id: 'audit-legacy', transactionId: 'transaction-legacy' });
    const [decorated] = decorateAuditEntriesWithUndo(
      [legacy],
      [{
        id: 'transaction-legacy',
        status: 'POSTED',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
        legacyUndoAllowed: false,
      }],
      [{ id: 'audit-legacy', txnId: 'transaction-legacy', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toBeUndefined();
  });

  it('offers legacy requeue for the latest dry-run outcome', () => {
    const dryRun = entry({
      id: 'audit-dry-run',
      action: 'dry-run',
      transactionId: 'transaction-dry-run',
    });
    const [decorated] = decorateAuditEntriesWithUndo(
      [dryRun],
      [{
        id: 'transaction-dry-run',
        status: 'DRY_RUN',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
        legacyUndoAllowed: false,
      }],
      [{ id: 'audit-dry-run', txnId: 'transaction-dry-run', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toEqual({ kind: 'legacy' });
  });

  it('keeps dry-run requeue available after the QBO undo window', () => {
    const dryRun = entry({
      id: 'audit-dry-run',
      action: 'dry-run',
      transactionId: 'transaction-dry-run',
    });
    const [decorated] = decorateAuditEntriesWithUndo(
      [dryRun],
      [{
        id: 'transaction-dry-run',
        status: 'DRY_RUN',
        postedAt: new Date('2026-01-01T00:00:00.000Z'),
        legacyUndoAllowed: false,
      }],
      [{ id: 'audit-dry-run', txnId: 'transaction-dry-run', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toEqual({ kind: 'legacy' });
  });

  it('does not offer undo when QuickBooks is no longer in the posted state', () => {
    const posted = entry({ id: 'audit-post', transactionId: 'transaction-generic' });
    const [decorated] = decorateAuditEntriesWithUndo(
      [posted],
      [{
        id: 'transaction-generic',
        status: 'REVERTED',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
        legacyUndoAllowed: true,
      }],
      [{ id: 'audit-post', txnId: 'transaction-generic', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toBeUndefined();
  });

  it('does not offer a competing undo while a prepared write is active', () => {
    const posted = entry({ id: 'audit-post', transactionId: 'transaction-generic' });
    const [decorated] = decorateAuditEntriesWithUndo(
      [posted],
      [{
        id: 'transaction-generic',
        status: 'POSTED',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
        legacyUndoAllowed: true,
        hasActiveAttempt: true,
      }],
      [{ id: 'audit-post', txnId: 'transaction-generic', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toBeUndefined();
  });

  it('does not offer a competing undo through the production audit-page projection', async () => {
    const payload = {
      requestId: 'request-current',
      outcome: 'VERIFIED',
      references: { operation: 'recategorize' },
    };
    prismaMock.auditEntry.findMany
      .mockResolvedValueOnce([{
        id: 'audit-post',
        companyId: 'c1',
        at: new Date('2026-07-15T12:00:00.000Z'),
        actorId: null,
        actorLabel: 'Example user',
        txnId: 'transaction-generic',
        payee: 'Example supplier',
        amount: -42.5,
        action: 'posted',
        before: 'Uncategorized Expense',
        after: 'Office Supplies',
        payload,
      }])
      .mockResolvedValueOnce([{
        id: 'audit-post',
        txnId: 'transaction-generic',
        payload,
      }]);
    prismaMock.transaction.findMany.mockResolvedValueOnce([{
      id: 'transaction-generic',
      status: 'POSTED',
      postedAt: new Date(),
      qboType: 'Purchase',
      taxCalculation: null,
      taxCodeQboId: null,
      splitLines: [],
      qboMutationAttempts: [{ id: 'attempt-prepared' }],
      _count: { qboMutationAttempts: 1 },
      company: {
        taxSupportStatus: 'needs_setup',
        taxUsingSalesTax: false,
        taxSupportReason: null,
      },
    }]);

    const page = await listAudit('c1');

    expect(page.entries[0]?.undo).toBeUndefined();
    expect(prismaMock.qboTaxCode.findMany).not.toHaveBeenCalled();
  });

  it('does not offer legacy Deposit undo when sales readiness is derivable from rate rows', async () => {
    prismaMock.auditEntry.findMany
      .mockResolvedValueOnce([{
        id: 'audit-deposit', companyId: 'c1', at: new Date(), actorId: null,
        actorLabel: 'Example user', txnId: 'transaction-deposit', payee: 'Deposit', amount: 107,
        action: 'posted', before: 'Uncategorized Income', after: 'Sales', payload: null,
      }])
      .mockResolvedValueOnce([{ id: 'audit-deposit', txnId: 'transaction-deposit', payload: null }]);
    prismaMock.transaction.findMany.mockResolvedValueOnce([{
      id: 'transaction-deposit', status: 'POSTED', postedAt: new Date(), qboType: 'Deposit',
      taxCalculation: null, taxCodeQboId: null, splitLines: [], qboMutationAttempts: [],
      _count: { qboMutationAttempts: 0 },
      company: { taxSupportStatus: 'needs_setup', taxUsingSalesTax: true, taxSupportReason: null },
    }]);
    prismaMock.qboTaxCode.findMany.mockResolvedValueOnce([{
      active: true,
      taxable: true,
      salesTaxRateList: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }],
      combinedSalesRate: null,
    }]);
    prismaMock.qboTaxRate.findMany.mockResolvedValueOnce([{
      qboId: 'sales-rate', name: 'Sales tax', description: null, active: true,
      rateValue: 5, sourceUpdatedAt: null,
    }]);

    const page = await listAudit('c1');

    expect(page.entries[0]?.undo).toBeUndefined();
  });
});

describe('auditPageNeedsSalesTaxCodes', () => {
  const deposit = {
    id: 'transaction-deposit',
    qboType: 'Deposit',
    status: 'POSTED',
    postedAt: new Date('2026-07-15T12:00:00.000Z'),
  };

  it('skips the company tax-code scan when the page has no undo candidate', () => {
    expect(auditPageNeedsSalesTaxCodes(
      [entry({
        id: 'audit-error',
        transactionId: deposit.id,
        action: 'error',
      })],
      [deposit],
      [{ id: 'audit-posted', txnId: deposit.id, payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    )).toBe(false);
  });

  it('loads sales tax codes for a current legacy Deposit undo candidate', () => {
    expect(auditPageNeedsSalesTaxCodes(
      [entry({
        id: 'audit-posted',
        transactionId: deposit.id,
        action: 'posted',
      })],
      [deposit],
      [{ id: 'audit-posted', txnId: deposit.id, payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    )).toBe(true);
  });
});

