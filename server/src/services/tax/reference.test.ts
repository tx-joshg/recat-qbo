import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { QboClient } from '../../lib/qbo/types.js';
import { refreshTaxReference, TAX_REFERENCE_TTL_MS, type TaxReferenceDeps } from './reference.js';

function fakeDeps(refreshedAt: Date | null): {
  deps: TaxReferenceDeps;
  client: Pick<QboClient, 'getTaxProfile' | 'listTaxCodes' | 'listTaxRates'>;
  db: Record<string, unknown>;
} {
  const now = new Date('2026-07-23T12:00:00.000Z');
  const client = {
    getTaxProfile: vi.fn(async () => ({ usingSalesTax: true, partnerTaxEnabled: false, raw: {} })),
    listTaxCodes: vi.fn(async () => [
      {
        qboId: 'gst',
        name: 'GST 5%',
        active: true,
        taxable: true,
        purchaseTaxRateList: [{ taxRateQboId: 'rate-gst' }],
        salesTaxRateList: [],
        raw: {},
      },
    ]),
    listTaxRates: vi.fn(async () => [
      { qboId: 'rate-gst', name: 'GST 5%', active: true, rateValue: 5, raw: {} },
    ]),
  };
  const db = {
    company: {
      findUnique: vi.fn(async () => ({
        id: 'co-1',
        taxReferenceRefreshedAt: refreshedAt,
        taxUsingSalesTax: true,
        taxSupportStatus: 'ready',
        taxSupportReason: null,
      })),
      update: vi.fn(async () => undefined),
    },
    qboTaxCode: {
      count: vi.fn(async () => 1),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined),
    },
    qboTaxRate: {
      count: vi.fn(async () => 1),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(db)),
  };
  return {
    deps: {
      db: db as unknown as PrismaClient,
      getClient: vi.fn(async () => client as unknown as QboClient),
      now: () => now,
    },
    client,
    db,
  };
}

describe('refreshTaxReference', () => {
  it('uses a fresh cache without calling QBO', async () => {
    const { deps, client } = fakeDeps(new Date('2026-07-23T11:59:00.000Z'));
    const result = await refreshTaxReference('co-1', {}, deps);
    expect(result).toMatchObject({ cached: true, status: 'ready' });
    expect(client.listTaxCodes).not.toHaveBeenCalled();
  });

  it('mirrors codes and rates atomically when stale', async () => {
    const { deps, db } = fakeDeps(new Date(Date.parse('2026-07-23T12:00:00.000Z') - TAX_REFERENCE_TTL_MS - 1));
    const result = await refreshTaxReference('co-1', {}, deps);
    expect(result).toMatchObject({ cached: false, status: 'ready', taxCodeCount: 1, taxRateCount: 1 });
    expect((db.qboTaxCode as { upsert: ReturnType<typeof vi.fn> }).upsert).toHaveBeenCalled();
    expect((db.qboTaxRate as { upsert: ReturnType<typeof vi.fn> }).upsert).toHaveBeenCalled();
    expect((db.company as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxReferenceRefreshedAt: new Date('2026-07-23T12:00:00.000Z'),
        }),
      }),
    );
  });

  it('force bypasses a fresh cache', async () => {
    const { deps, client } = fakeDeps(new Date('2026-07-23T11:59:00.000Z'));
    await refreshTaxReference('co-1', { force: true }, deps);
    expect(client.listTaxCodes).toHaveBeenCalledOnce();
  });

  it('does not commit a partial cache when a code references a missing rate', async () => {
    const { deps, client, db } = fakeDeps(null);
    vi.mocked(client.listTaxRates).mockResolvedValueOnce([]);
    await expect(refreshTaxReference('co-1', {}, deps)).rejects.toThrow(/unknown TaxRate/);
    expect((db.$transaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
