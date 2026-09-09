import { describe, expect, it, vi } from 'vitest';
import { createClassificationOutcomeRecoveryWorker } from './recovery.js';

describe('classification outcome recovery worker', () => {
  it('discovers only exact verified envelopes in bounded company pages and wraps after the last page', async () => {
    const first = Array.from({ length: 10 }, (_, index) => ({ id: `company-${index}` }));
    const findMany = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const reconcile = vi.fn().mockResolvedValue(2);
    const worker = createClassificationOutcomeRecoveryWorker({ db: { company: { findMany } } as never, reconcile });
    await expect(worker()).resolves.toEqual({ examined: 10, repaired: 20, failed: 0 });
    await worker();
    await worker();
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { transactions: { some: { qboMutationAttempts: { some: {
        status: 'VERIFIED', operation: { in: ['recategorize', 'restore'] },
        ruleCandidateFoldedAt: null, classificationEnvelopeVersion: 2,
      } } } } }, select: { id: true }, orderBy: { id: 'asc' }, take: 10,
    });
    expect(findMany.mock.calls[1][0].where.id).toEqual({ gt: 'company-9' });
    expect(findMany.mock.calls[2][0].where).not.toHaveProperty('id');
  });

  it('continues after one company fails and retains its durable work for a later sweep', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'failed' }, { id: 'ready' }]);
    const reconcile = vi.fn().mockRejectedValueOnce(new Error('synthetic local failure')).mockResolvedValue(1);
    const worker = createClassificationOutcomeRecoveryWorker({ db: { company: { findMany } } as never, reconcile });
    await expect(worker()).resolves.toEqual({ examined: 2, repaired: 1, failed: 1 });
    await expect(worker()).resolves.toEqual({ examined: 2, repaired: 2, failed: 0 });
    expect(reconcile.mock.calls.map(([id]) => id)).toEqual(['failed', 'ready', 'failed', 'ready']);
  });

  it('does not overlap ticks and releases the guard after discovery fails', async () => {
    let reject!: (reason: Error) => void;
    const findMany = vi.fn().mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; })).mockResolvedValue([]);
    const worker = createClassificationOutcomeRecoveryWorker({ db: { company: { findMany } } as never, reconcile: vi.fn() });
    const running = worker();
    await expect(worker()).resolves.toEqual({ examined: 0, repaired: 0, failed: 0 });
    expect(findMany).toHaveBeenCalledTimes(1);
    reject(new Error('synthetic discovery failure'));
    await expect(running).rejects.toThrow('synthetic discovery failure');
    await expect(worker()).resolves.toEqual({ examined: 0, repaired: 0, failed: 0 });
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
