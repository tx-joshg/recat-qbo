import { describe, expect, it, vi } from 'vitest';
import {
  backfillHistoricalClassificationObservations,
  toHistoricalObservation,
  type HistoricalObservationSource,
} from './historicalObservations.js';

const COMPANY = '4b20f911-85dd-44f5-97c6-5fec9e7b33df';

function validSource(): HistoricalObservationSource {
  return {
    sourceTransactionId: '2f2c9b1b-9d84-4eaf-8218-47e983fa66a6',
    companyId: COMPANY,
    qboId: 'purchase-synthetic-001',
    qboType: 'Purchase',
    qboSyncToken: '3',
    revision: 4,
    status: 'POSTED',
    transactionDate: new Date('2026-06-15T00:00:00.000Z'),
    sourceUpdatedAt: new Date('2026-06-15T12:00:00.000Z'),
    payee: 'Synthetic supplier',
    memo: 'Synthetic inventory purchase',
    amount: '-113.00',
    currency: 'CAD',
    bankAccount: 'Synthetic bank account',
    category: 'Inventory',
    categoryQboId: 'synthetic-category',
    taxCalculation: 'TaxExcluded',
    taxCode: 'HST ON',
    taxCodeQboId: 'synthetic-tax',
    splitLines: [],
    tagNames: ['Seasonal', 'Inventory'],
    activeCaseId: null,
  };
}

describe('historical classification observation selection', () => {
  it.each([
    ['not_posted', { status: 'DRY_RUN' }],
    ['unsupported_qbo_type', { qboType: 'Transfer' }],
    ['split_transaction', { splitLines: [{ id: 'split-1' }] }],
    ['missing_source_identity', { qboId: '  ' }],
    ['missing_category', { categoryQboId: null }],
    ['invalid_tax_action', { taxCalculation: 'TaxExcluded', taxCodeQboId: null }],
    ['missing_currency', { currency: 'cad' }],
    ['missing_display_summary', { payee: '  ' }],
    ['already_verified_case', { activeCaseId: 'case-1' }],
  ] as const)('excludes %s before producing an observation', (reason, patch) => {
    expect(toHistoricalObservation({ ...validSource(), ...patch }, new Set()))
      .toEqual({ ok: false, reason });
  });

  it('excludes a protected source before snapshot mapping', () => {
    const source = validSource();
    const blocked = new Set([source.sourceTransactionId]);
    Object.defineProperty(source, 'rawData', {
      get() { throw new Error('protected sources must not be inspected'); },
    });

    expect(toHistoricalObservation(source, blocked)).toEqual({ ok: false, reason: 'excluded_source' });
  });

  it('normalizes bounded display fields, exact cents, and lexical tag order', () => {
    const selected = toHistoricalObservation({
      ...validSource(),
      memo: '  Synthetic inventory purchase  ',
      tagNames: ['zebra', 'Apple', 'apple'],
      amount: '-113.00',
    }, new Set());

    expect(selected).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        amountCents: -11300n,
        memo: 'Synthetic inventory purchase',
        tagNames: ['Apple', 'apple', 'zebra'],
      }),
    }));
  });

  it('accepts 50 tags and excludes 51 tags from an observation summary', () => {
    const fiftyTags = Array.from({ length: 50 }, (_, index) => `Tag ${String(index + 1).padStart(2, '0')}`);

    expect(toHistoricalObservation({ ...validSource(), tagNames: fiftyTags }, new Set())).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ tagNames: fiftyTags }),
    }));
    expect(toHistoricalObservation({
      ...validSource(),
      tagNames: [...fiftyTags, 'Tag 51'],
    }, new Set())).toEqual({ ok: false, reason: 'missing_display_summary' });
  });

  it('preserves an absent memo as null without excluding an otherwise complete action', () => {
    expect(toHistoricalObservation({ ...validSource(), memo: '   ' }, new Set())).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ memo: null }),
    }));
  });

  it('preserves provenance and action identifiers exactly after validating them', () => {
    const selected = toHistoricalObservation({
      ...validSource(),
      qboId: ' purchase-source-id ',
      qboSyncToken: ' sync-token ',
      categoryQboId: ' category-id ',
      taxCodeQboId: ' tax-id ',
    }, new Set());

    expect(selected).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        sourceQboId: ' purchase-source-id ',
        sourceQboSyncToken: ' sync-token ',
        categoryQboId: ' category-id ',
        taxCodeQboId: ' tax-id ',
      }),
    }));
  });

  it('reports aggregate eligibility without writing in dry-run mode', async () => {
    const source = validSource();
    const db = {
      transaction: {
        findMany: vi.fn(async () => [source]),
      },
      historicalClassificationObservation: {
        createMany: vi.fn(),
      },
      $queryRaw: vi.fn(async () => [source]),
      $transaction: vi.fn(),
    };

    const report = await backfillHistoricalClassificationObservations({
      companyId: COMPANY,
      startDate: '2025-01-01',
      endDate: '2026-12-31',
      dryRun: true,
    }, db);

    expect(report).toEqual({
      mode: 'dry_run',
      startDate: '2025-01-01',
      endDate: '2026-12-31',
      scanned: 1,
      eligible: 1,
      inserted: 0,
      existing: 0,
      excluded: {
        excluded_source: 0,
        not_posted: 0,
        unsupported_qbo_type: 0,
        split_transaction: 0,
        missing_source_identity: 0,
        missing_category: 0,
        invalid_tax_action: 0,
        missing_currency: 0,
        missing_display_summary: 0,
        already_verified_case: 0,
      },
    });
    expect(db.historicalClassificationObservation.createMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
