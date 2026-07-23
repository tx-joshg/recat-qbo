import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  clearRuleWriteRetryPending,
  dueRuleWriteRetryCompanyIds,
  markRuleWriteRetryPending,
} from './ruleWriteRetry.js';

function retryDb() {
  const update = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findMany = vi.fn(async () => [{ id: 'co-1' }, { id: 'co-2' }]);
  const db = {
    company: { update, updateMany, findMany },
  } as unknown as PrismaClient;
  return { db, update, updateMany, findMany };
}

describe('durable deterministic-rule write retries', () => {
  it('persists the next retry before relying on the in-process timer', async () => {
    const value = retryDb();
    const retryAt = new Date('2026-07-23T12:00:30Z');

    await markRuleWriteRetryPending('co-1', retryAt, value.db);

    expect(value.update).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { ruleWriteRetryAt: retryAt },
    });
  });

  it('discovers due connected companies after a process restart', async () => {
    const value = retryDb();
    const now = new Date('2026-07-23T12:01:00Z');

    await expect(dueRuleWriteRetryCompanyIds(now, value.db)).resolves.toEqual([
      'co-1',
      'co-2',
    ]);
    expect(value.findMany).toHaveBeenCalledWith({
      where: {
        ruleWriteRetryAt: { lte: now },
        disconnectedAt: null,
      },
      select: { id: true },
    });
  });

  it('clears the durable marker only after a non-deferred rule pass', async () => {
    const value = retryDb();
    const observed = new Date('2026-07-23T12:00:30Z');

    await expect(clearRuleWriteRetryPending('co-1', observed, value.db)).resolves.toBe(true);

    expect(value.updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', ruleWriteRetryAt: observed },
      data: { ruleWriteRetryAt: null },
    });
  });

  it('does not clear a newer retry marker written by another sync', async () => {
    const value = retryDb();
    const observed = new Date('2026-07-23T12:00:30Z');
    value.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(clearRuleWriteRetryPending('co-1', observed, value.db)).resolves.toBe(false);

    expect(value.updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', ruleWriteRetryAt: observed },
      data: { ruleWriteRetryAt: null },
    });
  });

  it('does not issue a clear when the sync observed no retry marker', async () => {
    const value = retryDb();

    await expect(clearRuleWriteRetryPending('co-1', null, value.db)).resolves.toBe(false);

    expect(value.updateMany).not.toHaveBeenCalled();
  });
});
