import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  identity: vi.fn(async () => ({
    provider: 'codex',
    model: 'gpt-tested',
  })),
}));

vi.mock('./jobs.js', () => ({
  activeAgentVersionIdentity: mocks.identity,
  enqueueEligibleTransactions: mocks.enqueue,
}));

import {
  reconcileAutopilotJobs,
  sweepPendingAutopilotReconciliations,
} from './reconciliation.js';

function reconciliationDb(
  mode: 'off' | 'shadow' | 'live' = 'live',
  companyIds = ['co-1'],
  token = 'generation-1',
) {
  const companyFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    autopilotMode: mode,
    agentReconcileToken: token,
  }));
  const companyFindMany = vi.fn(async () => companyIds.map((id) => ({ id })));
  const companyUpdateMany = vi.fn(async () => ({ count: 1 }));
  const jobUpdateMany = vi.fn(async () => ({ count: 2 }));
  const jobCount = vi.fn(async () => 0);
  const db = {
    company: {
      findUnique: companyFindUnique,
      findMany: companyFindMany,
      updateMany: companyUpdateMany,
    },
    agentJob: { updateMany: jobUpdateMany, count: jobCount },
  } as unknown as PrismaClient;
  return {
    db,
    companyFindUnique,
    companyFindMany,
    companyUpdateMany,
    jobUpdateMany,
    jobCount,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({
    provider: 'codex',
    model: 'gpt-tested',
  });
  mocks.enqueue.mockResolvedValue({ created: 0, reset: 2, unchanged: 0, eligible: 2 });
});

describe('durable autopilot reconciliation', () => {
  it('requeues completed shadow jobs for live mode before clearing the marker', async () => {
    const value = reconciliationDb('live');

    await expect(reconcileAutopilotJobs('co-1', value.db)).resolves.toBe(true);

    expect(mocks.enqueue).toHaveBeenCalledWith('co-1', value.db, {
      identity: { provider: 'codex', model: 'gpt-tested' },
      requeueCompletedShadow: true,
    });
    expect(value.companyUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'co-1',
        autopilotMode: 'live',
        agentReconcileToken: 'generation-1',
      },
      data: { agentReconcileToken: null },
    });
  });

  it('does not clear a newer reconciliation request', async () => {
    const value = reconciliationDb('live', ['co-1'], 'generation-old');
    value.companyUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(reconcileAutopilotJobs('co-1', value.db)).resolves.toBe(false);

    expect(value.companyUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'co-1',
        autopilotMode: 'live',
        agentReconcileToken: 'generation-old',
      },
      data: { agentReconcileToken: null },
    });
  });

  it('holds the company row lock while applying and clearing a reconciliation', async () => {
    const inner = reconciliationDb('live');
    const queryRaw = vi.fn(async () => [{ id: 'co-1' }]);
    const tx = Object.assign(inner.db, { $queryRaw: queryRaw });
    const transaction = vi.fn(
      async (
        callback: (client: PrismaClient) => Promise<boolean>,
        _options: { maxWait: number; timeout: number },
      ) => callback(tx),
    );
    const db = { $transaction: transaction } as unknown as PrismaClient;

    await expect(reconcileAutopilotJobs('co-1', db)).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 60_000,
    });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.identity.mock.invocationCallOrder[0]!,
    );
    expect(inner.companyUpdateMany).toHaveBeenCalledOnce();
  });

  it('commits bounded queue pages before continuing the same generation', async () => {
    const inner = reconciliationDb('live');
    const queryRaw = vi.fn(async () => [{ id: 'co-1' }]);
    const tx = Object.assign(inner.db, { $queryRaw: queryRaw });
    const transaction = vi.fn(
      async (
        callback: (client: PrismaClient) => Promise<unknown>,
        _options: { maxWait: number; timeout: number },
      ) => callback(tx),
    );
    const db = { $transaction: transaction } as unknown as PrismaClient;
    mocks.enqueue
      .mockResolvedValueOnce({
        created: 50,
        reset: 0,
        unchanged: 0,
        eligible: 50,
        nextCursor: 'txn-050',
      })
      .mockResolvedValueOnce({
        created: 10,
        reset: 0,
        unchanged: 0,
        eligible: 10,
        nextCursor: null,
      });

    await expect(reconcileAutopilotJobs('co-1', db)).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenNthCalledWith(1, 'co-1', tx, {
      identity: { provider: 'codex', model: 'gpt-tested' },
      requeueCompletedShadow: true,
      batchSize: 50,
    });
    expect(mocks.enqueue).toHaveBeenNthCalledWith(2, 'co-1', tx, {
      identity: { provider: 'codex', model: 'gpt-tested' },
      requeueCompletedShadow: true,
      batchSize: 50,
      afterTransactionId: 'txn-050',
    });
    expect(inner.companyUpdateMany).toHaveBeenCalledOnce();
  });

  it('leaves the durable marker set when enqueueing fails', async () => {
    const value = reconciliationDb('live');
    mocks.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(reconcileAutopilotJobs('co-1', value.db)).rejects.toThrow(
      'queue unavailable',
    );

    expect(value.companyUpdateMany).not.toHaveBeenCalled();
  });

  it('keeps the generation marker until running owners finish', async () => {
    const value = reconciliationDb('shadow');
    value.jobCount.mockResolvedValueOnce(1);

    await expect(reconcileAutopilotJobs('co-1', value.db)).resolves.toBe(false);

    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(value.companyUpdateMany).not.toHaveBeenCalled();
    expect(value.jobCount).toHaveBeenCalledWith({
      where: { companyId: 'co-1', status: 'running' },
    });
  });

  it('cancels queued work for off mode before clearing the marker', async () => {
    const value = reconciliationDb('off');

    await expect(reconcileAutopilotJobs('co-1', value.db)).resolves.toBe(true);

    expect(value.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'co-1', status: { in: ['queued', 'retry'] } },
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('retries every pending company and keeps going after a failure', async () => {
    const value = reconciliationDb('live', ['co-1', 'co-2']);
    mocks.enqueue
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ created: 0, reset: 1, unchanged: 0, eligible: 1 });

    await expect(sweepPendingAutopilotReconciliations(value.db)).resolves.toBe(1);

    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(value.companyUpdateMany).toHaveBeenCalledOnce();
    expect(value.companyFindMany).toHaveBeenCalledWith({
      where: { agentReconcileToken: { not: null } },
      select: { id: true },
    });
  });
});
