import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http.js';
import { QboRateLimitError } from '../lib/qbo/types.js';
import {
  MAX_ACTIONABILITY_REFRESH_LIMIT,
  refreshProviderActionability,
  type ProviderActionabilityRefreshDeps,
} from './providerActionabilityRefresh.js';
import type { WriteSafetyReadResult } from './writeSafetyReads.js';

const rows = [
  {
    id: 'txn-a',
    companyId: 'company-a',
    revision: 2,
    qboSyncToken: '7',
    qboType: 'Purchase',
    qboId: 'qbo-a',
    date: '2026-08-01',
  },
  {
    id: 'txn-b',
    companyId: 'company-a',
    revision: 3,
    qboSyncToken: '8',
    qboType: 'Purchase',
    qboId: 'qbo-b',
    date: '2026-08-02',
  },
];

function safety(overrides: Partial<WriteSafetyReadResult> = {}): WriteSafetyReadResult {
  return {
    transactionId: 'txn-a',
    revision: 2,
    qboId: 'qbo-a',
    qboType: 'Purchase',
    qboSyncToken: '7',
    txnDate: '2026-08-01',
    bankAccountQboId: 'bank-a',
    bookCloseDate: null,
    cleared: false,
    reconciled: false,
    writable: true,
    blockCode: null,
    ...overrides,
  };
}

function deps(overrides: Partial<ProviderActionabilityRefreshDeps> = {}): ProviderActionabilityRefreshDeps {
  return {
    listTransactions: vi.fn(async (_userId, _companyId, _cursor, limit) => rows.slice(0, limit)),
    readSafety: vi.fn(async (_userId, _companyId, transactionId) =>
      transactionId === 'txn-a'
        ? safety()
        : safety({
            transactionId: 'txn-b',
            revision: 3,
            qboId: 'qbo-b',
            qboSyncToken: '8',
            txnDate: '2026-08-02',
            blockCode: 'QBO_TRANSACTION_LOCKED',
            writable: false,
            cleared: true,
          })),
    persist: vi.fn(async () => true),
    ...overrides,
  };
}

describe('bounded provider actionability refresh', () => {
  it('processes a hard-bounded page and returns a resumable cursor', async () => {
    const dependencies = deps();
    const result = await refreshProviderActionability('user-a', 'company-a', { limit: 1 }, dependencies);

    expect(result).toMatchObject({
      companyId: 'company-a',
      processed: 1,
      persisted: 1,
      failed: 0,
      nextCursor: 'txn-a',
      partial: true,
      complete: false,
    });
    expect(result.items.map((item) => item.disposition)).toEqual(['WRITABLE']);
    expect(dependencies.listTransactions).toHaveBeenCalledWith('user-a', 'company-a', null, 1);
    expect(dependencies.readSafety).toHaveBeenCalledTimes(1);
    expect(dependencies.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps the cursor moving and records UNAVAILABLE when one exact read fails', async () => {
    const dependencies = deps({
      readSafety: vi.fn().mockRejectedValue(Object.assign(new Error('provider prose'), { code: 'QBO_WRITE_SAFETY_UNAVAILABLE' })),
    });
    const result = await refreshProviderActionability(
      'user-a',
      'company-a',
      { cursor: 'txn-before', limit: 1 },
      dependencies,
    );

    expect(result).toMatchObject({
      processed: 1,
      persisted: 1,
      failed: 1,
      nextCursor: 'txn-a',
      partial: true,
      complete: false,
    });
    expect(result.items.every((item) => item.disposition === 'UNAVAILABLE')).toBe(true);
    expect(result.items.every((item) => item.errorCode === 'QBO_WRITE_SAFETY_UNAVAILABLE')).toBe(true);
    expect(dependencies.persist).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'UNAVAILABLE',
      unavailableCode: 'QBO_WRITE_SAFETY_UNAVAILABLE',
    }));
  });

  it('stops on a typed QBO rate limit without persisting or advancing the failed row', async () => {
    const rateLimit = new QboRateLimitError(7, 'provider detail must not escape');
    const dependencies = deps({
      readSafety: vi.fn().mockRejectedValue(rateLimit),
    });

    await expect(refreshProviderActionability(
      'user-a',
      'company-a',
      { cursor: 'txn-before', limit: 1 },
      dependencies,
    )).rejects.toBe(rateLimit);

    expect(dependencies.readSafety).toHaveBeenCalledWith('user-a', 'company-a', 'txn-a');
    expect(dependencies.persist).not.toHaveBeenCalled();
  });

  it('normalizes an HTTP 429 to a bounded typed rate limit without advancing', async () => {
    const rateLimit = Object.assign(
      new HttpError(429, 'provider detail must not escape', 'RATE_LIMITED'),
      { retryAfterSeconds: 999 },
    );
    const dependencies = deps({
      readSafety: vi.fn().mockRejectedValue(rateLimit),
    });

    await expect(refreshProviderActionability(
      'user-a',
      'company-a',
      { limit: 1 },
      dependencies,
    )).rejects.toMatchObject({
      name: 'QboRateLimitError',
      code: 'QBO_RATE_LIMITED',
      retryAfterSeconds: 60,
    });
    expect(dependencies.persist).not.toHaveBeenCalled();
  });

  it('rejects an unbounded request before listing or reading provider data', async () => {
    const dependencies = deps();
    await expect(refreshProviderActionability(
      'user-a',
      'company-a',
      { limit: MAX_ACTIONABILITY_REFRESH_LIMIT + 1 },
      dependencies,
    )).rejects.toThrow(/between 1 and/);
    expect(dependencies.listTransactions).not.toHaveBeenCalled();
    expect(dependencies.readSafety).not.toHaveBeenCalled();
  });
});
