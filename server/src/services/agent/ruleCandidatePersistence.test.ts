import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { rebuildRuleCandidates } from './ruleCandidatePersistence.js';

describe('rule candidate repair budget', () => {
  it('repairs one bounded missing-only batch in one company transaction', async () => {
    const legacyScan = vi.fn(async () => []);
    const tx = {
      $queryRawUnsafe: vi.fn(async () => [{ locked: 1 }]),
      $queryRaw: vi.fn(async () => []),
    };
    const transaction = vi.fn(async (
      callback: (transactionClient: unknown) => Promise<unknown>,
    ) => callback(tx));
    const db = {
      qboMutationAttempt: { findMany: legacyScan },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await rebuildRuleCandidates('company-1', { db });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(legacyScan).not.toHaveBeenCalled();
    const query = (tx.$queryRaw.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { strings?: readonly string[] }
      | undefined;
    const sql = query?.strings?.join(' ') ?? '';
    expect(sql).toContain('attempt."ruleCandidateFoldedAt" IS NULL');
    expect(sql).toContain(
      `attempt."requestPayload"->'ruleCandidateFold'->>'version' = '1'`,
    );
  });
});
