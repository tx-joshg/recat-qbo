import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
  TransferDiscoveryOverflowError,
  isTransferPair,
  pairTransfers,
  pickCounterpartAccount,
  recordTransfer,
  transferCandidates,
  type CounterpartAccountLike,
  type PairableTxn,
  type PairTransferStats,
  type RecordTransferDeps,
} from './transfers.js';

function t(id: string, amount: number, bankAccount: string, date: string): PairableTxn {
  return { id, amount, bankAccount, date: new Date(date) };
}

describe('isTransferPair', () => {
  const out = t('a', -750, 'Checking ·4821', '2026-07-13');

  it('matches equal |amount|, opposite sign, different account, same day', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-13'))).toBe(true);
  });

  it('rejects same sign', () => {
    expect(isTransferPair(out, t('b', -750, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('rejects same bank account', () => {
    expect(isTransferPair(out, t('b', 750, 'Checking ·4821', '2026-07-13'))).toBe(false);
  });

  it('rejects different amounts', () => {
    expect(isTransferPair(out, t('b', 750.5, 'Visa ·0392', '2026-07-13'))).toBe(false);
  });

  it('honors the 3-day window', () => {
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-16'))).toBe(true);
    expect(isTransferPair(out, t('b', 750, 'Visa ·0392', '2026-07-17'))).toBe(false);
  });
});

describe('pairTransfers', () => {
  function quadraticReference(txns: PairableTxn[]): Map<string, string> {
    const pairs = new Map<string, string>();
    const used = new Set<string>();
    const sorted = [...txns].sort(
      (a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
    );
    for (let index = 0; index < sorted.length; index += 1) {
      const first = sorted[index];
      if (!first || used.has(first.id)) continue;
      for (let secondIndex = index + 1; secondIndex < sorted.length; secondIndex += 1) {
        const second = sorted[secondIndex];
        if (!second || used.has(second.id) || !isTransferPair(first, second)) continue;
        pairs.set(first.id, second.id);
        pairs.set(second.id, first.id);
        used.add(first.id);
        used.add(second.id);
        break;
      }
    }
    return pairs;
  }

  it('pairs the prototype T17/T18 transfer and maps both directions', () => {
    const pairs = pairTransfers([
      t('t17', -750, 'Checking ·4821', '2026-07-13'),
      t('t18', 750, 'Visa ·0392', '2026-07-13'),
      t('t3', -52.4, 'Visa ·0392', '2026-07-01'),
    ]);
    expect(pairs.get('t17')).toBe('t18');
    expect(pairs.get('t18')).toBe('t17');
    expect(pairs.has('t3')).toBe(false);
  });

  it('pairs each txn at most once (greedy by date)', () => {
    const pairs = pairTransfers([
      t('out1', -100, 'Checking', '2026-07-01'),
      t('in1', 100, 'Visa', '2026-07-02'),
      t('in2', 100, 'Savings', '2026-07-03'),
    ]);
    expect(pairs.get('out1')).toBe('in1');
    expect(pairs.has('in2')).toBe(false);
    expect(pairs.size).toBe(2);
  });

  it('returns an empty map for unmatched txns', () => {
    const pairs = pairTransfers([
      t('a', -10, 'Checking', '2026-07-01'),
      t('b', 20, 'Visa', '2026-07-01'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('matches the prior greedy algorithm on deterministic randomized fixtures', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let fixture = 0; fixture < 50; fixture += 1) {
      const rows = Array.from({ length: 80 }, (_, index) => {
        const day = 1 + Math.floor(random() * 15);
        const cents = 1 + Math.floor(random() * 8);
        const sign = random() < 0.5 ? -1 : 1;
        const bank = `bank-${Math.floor(random() * 4)}`;
        return t(
          `f${String(fixture).padStart(2, '0')}-${String(index).padStart(3, '0')}`,
          sign * cents,
          bank,
          `2026-07-${String(day).padStart(2, '0')}`,
        );
      });
      expect([...pairTransfers(rows).entries()]).toEqual([...quadraticReference(rows).entries()]);
    }
  });

  it('uses bounded indexed queue operations for adversarial same-account buckets', () => {
    const count = 5_000;
    const rows = [
      ...Array.from({ length: count }, (_, index) =>
        t(`negative-${String(index).padStart(5, '0')}`, -10, 'Same bank', '2026-07-01')),
      ...Array.from({ length: count }, (_, index) =>
        t(`positive-${String(index).padStart(5, '0')}`, 10, 'Same bank', '2026-07-02')),
    ];
    const stats: PairTransferStats = { heapPushes: 0, heapPops: 0, queueShifts: 0 };

    expect(pairTransfers(rows, stats).size).toBe(0);
    expect(stats.heapPushes + stats.heapPops + stats.queueShifts).toBeGreaterThan(0);
    expect(stats.heapPushes + stats.heapPops + stats.queueShifts).toBeLessThan(rows.length * 8);
  });
});

describe('transferCandidates', () => {
  it.each([['BLOCKED_CLEARED', true], ['BLOCKED_RECONCILED', true], ['BLOCKED_PERIOD_CLOSED', false], ['UNKNOWN', false], ['UNAVAILABLE', false]])('pairs only effective writable rows (%s)', async (disposition, eligible) => {
    const now = new Date();
    const row = (id: string, amount: number, bankAccount: string, disposition: string) => ({
      id,
      companyId: 'company-1',
      revision: 0,
      qboSyncToken: '1',
      qboType: 'Purchase',
      qboId: id,
      amount,
      bankAccount,
      date: now,
      providerActionability: {
        companyId: 'company-1',
        transactionId: id,
        disposition,
        checkedAt: now,
        revision: 0,
        qboSyncToken: '1',
        qboType: 'Purchase',
        qboId: id,
        txnDate: now,
      },
    });
    const db = {
      transactionActionability: {},
      transaction: {
        findMany: vi.fn(async () => [
          row('blocked', -10, 'Checking', String(disposition)),
          row('writable', 10, 'Visa', 'WRITABLE'),
        ]),
      },
    };

    await expect(transferCandidates('company-1', db as never)).resolves.toEqual(new Map(eligible ? [
      ['blocked', 'writable'],
      ['writable', 'blocked'],
    ] : []));
  });

  it('queries one row beyond the fixed discovery cap and fails closed on overflow', async () => {
    const rows = Array.from(
      { length: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1 },
      (_, index) => ({
        id: `txn-${index}`,
        amount: index % 2 === 0 ? -10 : 10,
        bankAccount: index % 2 === 0 ? 'Checking' : 'Visa',
        date: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    const db = {
      transaction: {
        findMany: vi.fn(async () => rows),
      },
    };

    await expect(
      transferCandidates('company-1', db as never),
    ).rejects.toBeInstanceOf(TransferDiscoveryOverflowError);
    expect(db.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1,
      }),
    );
  });
});

describe('pickCounterpartAccount', () => {
  const acct = (qboId: string, name: string, active = true): CounterpartAccountLike => ({ qboId, name, active });

  it('picks the single active account matching the name', () => {
    const picked = pickCounterpartAccount([acct('1', 'Checking ·4821'), acct('2', 'Visa ·0392')], 'Visa ·0392');
    expect(picked.qboId).toBe('2');
  });

  it('ignores inactive accounts with the same name', () => {
    const picked = pickCounterpartAccount(
      [acct('1', 'Visa ·0392', false), acct('2', 'Visa ·0392')],
      'Visa ·0392',
    );
    expect(picked.qboId).toBe('2');
  });

  it('fails loudly when no active account matches', () => {
    expect(() => pickCounterpartAccount([acct('1', 'Visa ·0392', false)], 'Visa ·0392')).toThrow(/not found/);
    expect(() => pickCounterpartAccount([], 'Visa ·0392')).toThrow(/not found/);
  });

  it('fails loudly on an ambiguous name instead of guessing', () => {
    expect(() =>
      pickCounterpartAccount([acct('1', 'Checking'), acct('2', 'Checking')], 'Checking'),
    ).toThrow(/ambiguous/);
  });
});

describe('recordTransfer durable wrapper', () => {
  function wrapperFixture(overrides: {
    state?: 'VERIFIED' | 'DRY_RUN' | 'PARTIAL' | 'RETRYABLE' | 'UNCERTAIN';
    priorState?: 'PREPARED' | 'PARTIAL' | 'RETRYABLE' | 'UNCERTAIN';
  } = {}) {
    const rows = new Map([
      ['txn-z', {
        id: 'txn-z',
        companyId: 'company-generic',
        revision: 7,
        status: 'POSTED',
      }],
      ['txn-a', {
        id: 'txn-a',
        companyId: 'company-generic',
        revision: 11,
        status: 'ERROR',
      }],
    ]);
    const prepare = vi.fn(async () => ({
      operationId: 'operation-generic',
      state: 'PREPARED' as const,
      expiresAt: '2026-07-29T18:15:00.000Z',
      preview: {
        action: 'record_transfer' as const,
        direction: 'between_accounts' as const,
        totalCents: 1000,
        legCount: 2 as const,
        preparationDigest: 'a'.repeat(64),
      },
    }));
    const state = overrides.state ?? 'VERIFIED';
    const resultFor = (
      resultState: 'VERIFIED' | 'DRY_RUN' | 'PARTIAL' | 'RETRYABLE' | 'UNCERTAIN',
      operationId = 'operation-generic',
    ) => ({
      operationId,
      state: resultState,
      complete: resultState === 'VERIFIED' || resultState === 'DRY_RUN',
      firstLeg: {
        outcome: resultState === 'DRY_RUN'
          ? 'DRY_RUN' as const
          : resultState === 'RETRYABLE'
            ? 'RETRYABLE' as const
            : 'VERIFIED' as const,
      },
      secondLeg: {
        outcome: resultState === 'VERIFIED'
          ? 'VERIFIED' as const
          : resultState === 'DRY_RUN'
            ? 'DRY_RUN' as const
            : resultState === 'UNCERTAIN'
              ? 'UNCERTAIN' as const
              : 'RETRYABLE' as const,
      },
      ...(resultState === 'PARTIAL'
        ? {
            error: {
              code: 'TRANSFER_PARTIAL',
              message: 'One transfer leg is durable, but the other leg still requires recovery.',
            },
          }
        : resultState === 'UNCERTAIN'
          ? {
              error: {
                code: 'QBO_WRITE_UNCERTAIN',
                message: 'A transfer write may have succeeded in QuickBooks. Verify the operation before retrying.',
              },
            }
          : resultState === 'RETRYABLE'
            ? {
                error: {
                  code: 'TRANSFER_RETRYABLE',
                  message: 'The transfer was not sent. Prepare a new operation before retrying.',
                },
              }
            : {}),
    });
    const commit = vi.fn(async () => resultFor(state));
    const priorState = overrides.priorState ?? 'PREPARED';
    const get = vi.fn(async () => ({
      operationId: 'operation-generic',
      state: priorState,
      complete: false,
      firstLeg: {
        outcome: priorState === 'PARTIAL'
          ? 'VERIFIED' as const
          : priorState === 'RETRYABLE'
            ? 'RETRYABLE' as const
            : priorState === 'UNCERTAIN'
              ? 'UNCERTAIN' as const
              : 'IN_PROGRESS' as const,
      },
      secondLeg: {
        outcome: priorState === 'PARTIAL' || priorState === 'RETRYABLE'
          ? 'RETRYABLE' as const
          : 'IN_PROGRESS' as const,
      },
    }));
    const retry = vi.fn(async () => ({
      operationId: 'retry-operation-generic',
      retryOfId: 'operation-generic',
      state: 'PREPARED' as const,
      complete: false,
      firstLeg: { outcome: 'IN_PROGRESS' as const },
      secondLeg: { outcome: 'IN_PROGRESS' as const },
    }));
    const deps = {
      db: {
        transaction: {
          findUnique: vi.fn(async ({ where }) => rows.get(where.id) ?? null),
        },
      },
      prepare,
      get,
      retry,
      commit: commit as RecordTransferDeps['commit'],
    } as unknown as RecordTransferDeps;
    return { rows, prepare, get, retry, commit, deps, resultFor };
  }

  it('derives one stable idempotency key from actor, canonical pair, and both revisions', async () => {
    const first = wrapperFixture();
    const second = wrapperFixture();
    const actor = { id: 'actor-generic', label: 'Generic Actor' };

    await recordTransfer('txn-z', 'txn-a', actor, first.deps);
    await recordTransfer('txn-a', 'txn-z', actor, second.deps);

    const firstInput = first.prepare.mock.calls[0]![0];
    const secondInput = second.prepare.mock.calls[0]![0];
    expect(firstInput.idempotencyKey).toMatch(/^ui-transfer:[0-9a-f]{64}$/);
    expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);
    expect(firstInput).toMatchObject({
      companyId: 'company-generic',
      transactionId: 'txn-z',
      counterpartTransactionId: 'txn-a',
      expectedRevision: 7,
      counterpartExpectedRevision: 11,
      actor,
    });
    expect(first.commit).toHaveBeenCalledWith(
      'operation-generic',
      actor,
    );
  });

  it('recovers an exact prior partial replay before requiring current PENDING statuses', async () => {
    const f = wrapperFixture();

    await expect(recordTransfer(
      'txn-z',
      'txn-a',
      { id: 'actor-generic', label: 'Generic Actor' },
      f.deps,
    )).resolves.toEqual({ status: 'POSTED' });

    expect(f.rows.get('txn-z')?.status).toBe('POSTED');
    expect(f.rows.get('txn-a')?.status).toBe('ERROR');
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it('maps durable dry-run completion to the route-compatible status result', async () => {
    const f = wrapperFixture({ state: 'DRY_RUN' });

    await expect(recordTransfer(
      'txn-z',
      'txn-a',
      { id: 'actor-generic', label: 'Generic Actor' },
      f.deps,
    )).resolves.toEqual({ status: 'DRY_RUN' });
  });

  it('never reports POSTED for an inconsistent mixed verified and dry-run result', async () => {
    const f = wrapperFixture();
    f.commit.mockResolvedValueOnce({
      operationId: 'operation-generic',
      state: 'VERIFIED',
      complete: true,
      firstLeg: { outcome: 'VERIFIED' },
      secondLeg: { outcome: 'DRY_RUN' },
    });

    await expect(recordTransfer(
      'txn-z',
      'txn-a',
      { id: 'actor-generic', label: 'Generic Actor' },
      f.deps,
    )).rejects.toMatchObject({
      code: 'TRANSFER_RECONCILIATION_REQUIRED',
      message:
        'The transfer may be partially recorded. Verify both transactions in QuickBooks before retrying.',
    });
  });

  it.each(['PARTIAL', 'UNCERTAIN'] as const)(
    'surfaces fixed honest %s recovery guidance instead of reporting success',
    async (state) => {
      const f = wrapperFixture({ state });

      await expect(recordTransfer(
        'txn-z',
        'txn-a',
        { id: 'actor-generic', label: 'Generic Actor' },
        f.deps,
      )).rejects.toMatchObject({
        code: 'TRANSFER_RECONCILIATION_REQUIRED',
        message:
          'The transfer may be partially recorded. Verify both transactions in QuickBooks before retrying.',
      });

      expect(f.commit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['both safely unsent', 'RETRYABLE'],
    ['verified first leg', 'PARTIAL'],
  ] as const)(
    'creates and commits the one safe child on a new user call for %s',
    async (_label, parentState) => {
      const f = wrapperFixture({
        state: parentState,
        priorState: parentState,
      });
      f.commit
        .mockResolvedValueOnce(f.resultFor(parentState))
        .mockResolvedValueOnce(
          f.resultFor('VERIFIED', 'retry-operation-generic'),
        );

      await expect(recordTransfer(
        'txn-z',
        'txn-a',
        { id: 'actor-generic', label: 'Generic Actor' },
        f.deps,
      )).resolves.toEqual({ status: 'POSTED' });

      expect(f.retry).toHaveBeenCalledWith(
        'operation-generic',
        { id: 'actor-generic', label: 'Generic Actor' },
      );
      expect(f.commit.mock.calls).toEqual([
        ['operation-generic', { id: 'actor-generic', label: 'Generic Actor' }],
        ['retry-operation-generic', { id: 'actor-generic', label: 'Generic Actor' }],
      ]);
    },
  );

  it('does not create a child in the same call that first terminalizes the parent safely', async () => {
    const f = wrapperFixture({
      state: 'RETRYABLE',
      priorState: 'PREPARED',
    });

    await expect(recordTransfer(
      'txn-z',
      'txn-a',
      { id: 'actor-generic', label: 'Generic Actor' },
      f.deps,
    )).rejects.toMatchObject({
      code: 'TRANSFER_RETRYABLE',
      message: 'The transfer was not sent. Retry this transfer.',
    });

    expect(f.retry).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});
