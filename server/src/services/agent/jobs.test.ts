import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('../instanceSettings.js', () => ({
  getInstanceSettings: vi.fn(async () => ({ codexModel: 'gpt-5.6-luna' })),
}));

import {
  acquireCompanyWriteLease,
  agentInputHash,
  cancelJob,
  cancelClaimedJob,
  claimNextJob,
  completeJob,
  countValidatedShadowRuns,
  enqueueEligibleTransactions,
  hasCurrentDeterministicRule,
  isCurrentAgentTransactionEligible,
  requeueStaleAgentJobs,
  retryDelayMs,
  sweepExpiredAgentLeases,
  withCompanyWriteLeases,
} from './jobs.js';

function txn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    companyId: 'co-1',
    qboId: 'purchase-1',
    qboType: 'Purchase',
    qboSyncToken: '4',
    date: new Date('2026-07-23'),
    payee: 'WEBFLOW',
    memo: 'Monthly plan',
    amount: { toString: () => '-29.00' },
    bankAccount: 'Visa',
    rawData: {
      Line: [
        {
          Id: 'line-1',
          Amount: 29,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding-1' } },
        },
      ],
    },
    ...overrides,
  };
}

const accounts = [
  {
    qboId: 'acct-1',
    name: 'Software',
    fullName: 'Expenses · Software',
    active: true,
    classification: 'Expense',
    accountType: 'Expense',
    updatedAt: new Date('2026-07-23T10:00:00Z'),
  },
];
const taxCodes = [
  {
    qboId: 'gst',
    name: 'GST 5%',
    description: 'Goods and services tax',
    active: true,
    taxable: true,
    purchaseTaxRateList: [{ taxRateQboId: 'rate-1' }],
    updatedAt: new Date('2026-07-23T10:00:00Z'),
  },
];

describe('agentInputHash', () => {
  it('ignores refresh timestamps but changes with decision-relevant content', () => {
    const original = agentInputHash(txn(), accounts, taxCodes);
    expect(agentInputHash(txn(), [...accounts].reverse(), [...taxCodes].reverse())).toBe(original);
    expect(agentInputHash(txn({ memo: 'Annual plan' }), accounts, taxCodes)).not.toBe(original);
    expect(
      agentInputHash(
        txn(),
        [{ ...accounts[0]!, updatedAt: new Date('2026-07-23T11:00:00Z') }],
        taxCodes,
      ),
    ).toBe(original);
    expect(
      agentInputHash(
        txn(),
        [{ ...accounts[0]!, fullName: 'Expenses · Online services' }],
        taxCodes,
      ),
    ).not.toBe(original);
    expect(agentInputHash(txn(), accounts, taxCodes, ['holding-2'])).not.toBe(
      agentInputHash(txn(), accounts, taxCodes, ['holding-1']),
    );
    expect(agentInputHash(txn(), accounts, taxCodes, ['b', 'a'])).toBe(
      agentInputHash(txn(), accounts, taxCodes, ['a', 'b']),
    );
    expect(
      agentInputHash(txn(), accounts, taxCodes, [], {
        provider: 'codex',
        model: 'gpt-model-b',
      }),
    ).not.toBe(
      agentInputHash(txn(), accounts, taxCodes, [], {
        provider: 'codex',
        model: 'gpt-model-a',
      }),
    );
  });
});

describe('validated shadow evidence', () => {
  it('pins evidence to provider, model, decision and verifier prompts, and tool schema', async () => {
    const findMany = vi.fn(async () =>
      Array.from({ length: 7 }, (_, index) => ({ transactionId: `txn-${index}` })),
    );
    const db = { agentRun: { findMany } } as unknown as PrismaClient;

    await expect(
      countValidatedShadowRuns('co-1', { provider: 'codex', model: 'gpt-tested' }, db),
    ).resolves.toBe(7);

    expect(findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        companyId: 'co-1',
        provider: 'codex',
        model: 'gpt-tested',
        promptVersion: 'recat-autopilot-v2+recat-verifier-v1',
        toolSchemaVersion: 'recat-tools-v1',
        mode: 'shadow',
      }),
      distinct: ['transactionId'],
      select: { transactionId: true },
    });
  });
});

function enqueueDb(options: {
  mode?: 'off' | 'shadow' | 'live';
  existing?: {
    id: string;
    inputHash: string;
    status: string;
    lastErrorCode?: string | null;
  } | null;
  lastRunMode?: 'shadow' | 'live' | null;
  transactions?: ReturnType<typeof txn>[];
  rules?: Array<{
    id: string;
    matchText: string;
    category: string;
    categoryQboId: string | null;
    priority: number;
    createdAt: Date;
  }>;
}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const cancelled: unknown[] = [];
  return {
    created,
    updated,
    db: {
      company: {
        findUnique: vi.fn(async () => ({
          id: 'co-1',
          autopilotMode: options.mode ?? 'shadow',
          disconnectedAt: null,
          taxSupportStatus: 'ready',
        })),
      },
      transaction: { findMany: vi.fn(async () => options.transactions ?? [txn()]) },
      qboAccount: { findMany: vi.fn(async () => accounts) },
      qboTaxCode: { findMany: vi.fn(async () => taxCodes) },
      rule: { findMany: vi.fn(async () => options.rules ?? []) },
      agentJob: {
        findUnique: vi.fn(async () => options.existing ?? null),
        create: vi.fn(async ({ data }: { data: unknown }) => {
          created.push(data);
          return data;
        }),
        update: vi.fn(async ({ data }: { data: unknown }) => {
          updated.push(data);
          return data;
        }),
        updateMany: vi.fn(async (args: any) => {
          if (args?.where?.id) updated.push(args.data);
          else cancelled.push(args);
          return { count: 1 };
        }),
      },
      agentRun: {
        findFirst: vi.fn(async () =>
          options.lastRunMode ? { mode: options.lastRunMode } : null,
        ),
      },
    } as unknown as PrismaClient,
    cancelled,
  };
}

describe('enqueueEligibleTransactions', () => {
  it('does nothing while company autopilot is off', async () => {
    const { db, created } = enqueueDb({ mode: 'off' });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toEqual({
      created: 0,
      reset: 0,
      unchanged: 0,
      eligible: 0,
    });
    expect(created).toHaveLength(0);
  });

  it('creates one durable job and treats duplicate enqueue as unchanged', async () => {
    const first = enqueueDb({ mode: 'shadow' });
    const result = await enqueueEligibleTransactions('co-1', first.db);
    expect(result).toMatchObject({ created: 1, eligible: 1 });
    const inputHash = (first.created[0] as { inputHash: string }).inputHash;

    const duplicate = enqueueDb({
      mode: 'shadow',
      existing: { id: 'job-1', inputHash, status: 'queued' },
    });
    await expect(enqueueEligibleTransactions('co-1', duplicate.db)).resolves.toMatchObject({
      unchanged: 1,
      created: 0,
    });
    expect(duplicate.updated).toHaveLength(0);
  });

  it('returns a scan cursor for bounded durable reconciliation pages', async () => {
    const value = enqueueDb({
      mode: 'shadow',
      transactions: [txn({ id: 'txn-001' }), txn({ id: 'txn-002' })],
    });

    await expect(
      enqueueEligibleTransactions('co-1', value.db, {
        batchSize: 1,
        afterTransactionId: 'txn-000',
      }),
    ).resolves.toMatchObject({
      created: 1,
      eligible: 1,
      nextCursor: 'txn-001',
    });

    expect(value.db.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { gt: 'txn-000' } }),
        orderBy: { id: 'asc' },
        take: 2,
      }),
    );
    expect(value.created).toHaveLength(1);
  });

  it('leaves deterministic rule matches and human-staged tax choices out of the agent queue', async () => {
    const { db, created, cancelled } = enqueueDb({
      mode: 'shadow',
      rules: [
        {
          id: 'rule-new',
          matchText: 'webflow',
          category: 'Software',
          categoryQboId: 'acct-1',
          priority: 0,
          createdAt: new Date('2026-07-23T12:00:00Z'),
        },
      ],
      transactions: [
        txn({ id: 'rule-txn', suggestion: null }),
        txn({ id: 'tax-txn', taxCodeQboId: 'gst' }),
      ],
    });

    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toEqual({
      created: 0,
      reset: 0,
      unchanged: 0,
      eligible: 0,
    });
    expect(created).toHaveLength(0);
    expect(cancelled).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          transactionId: { in: ['rule-txn', 'tax-txn'] },
          status: { in: ['queued', 'retry'] },
        }),
        data: expect.objectContaining({
          status: 'cancelled',
          lastErrorCode: 'AGENT_RULE_COVERED',
        }),
      }),
    );
  });

  it('keeps positive Purchase refunds out of the queue', async () => {
    const { db, created } = enqueueDb({
      mode: 'live',
      transactions: [txn({ amount: { toString: () => '29.00' } })],
    });
    vi.mocked(db.transaction.findMany).mockResolvedValue([]);

    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      created: 0,
      eligible: 0,
    });
    expect(db.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amount: { lt: 0 } }),
      }),
    );
    expect(created).toHaveLength(0);
  });

  it('resets the same job when transaction input changes', async () => {
    const { db, updated } = enqueueDb({
      mode: 'live',
      existing: { id: 'job-1', inputHash: 'old-hash', status: 'completed' },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({ reset: 1 });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      attempt: 0,
      lockOwner: null,
      leaseExpiresAt: null,
    });
  });

  it('requeues a completed same-input shadow job for a live promotion', async () => {
    const { db, updated } = enqueueDb({
      mode: 'live',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'completed',
      },
      lastRunMode: 'shadow',
    });

    await expect(
      enqueueEligibleTransactions('co-1', db, { requeueCompletedShadow: true }),
    ).resolves.toMatchObject({ reset: 1, unchanged: 0 });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      attempt: 0,
      lastErrorCode: null,
    });
  });

  it('does not requeue a completed same-input live job on an idempotent live request', async () => {
    const { db, updated } = enqueueDb({
      mode: 'live',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'completed',
      },
      lastRunMode: 'live',
    });

    await expect(
      enqueueEligibleTransactions('co-1', db, { requeueCompletedShadow: true }),
    ).resolves.toMatchObject({ reset: 0, unchanged: 1 });
    expect(updated).toHaveLength(0);
  });

  it('defers changed input while the current job lease is running', async () => {
    const { db, updated } = enqueueDb({
      mode: 'live',
      existing: {
        id: 'job-1',
        inputHash: 'old-hash',
        status: 'running',
      },
    });

    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 0,
      unchanged: 1,
    });
    expect(updated).toHaveLength(0);
  });

  it('requeues same-input work cancelled only because autopilot was disabled', async () => {
    const { db, updated } = enqueueDb({
      mode: 'shadow',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'cancelled',
        lastErrorCode: 'AGENT_DISABLED',
      },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 1,
      unchanged: 0,
    });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      attempt: 0,
      lastErrorCode: null,
    });
  });

  it('requeues same-input work after stale timestamp validation', async () => {
    const { db, updated } = enqueueDb({
      mode: 'shadow',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'failed',
        lastErrorCode: 'AGENT_STALE_INPUT',
      },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 1,
      unchanged: 0,
    });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      lastErrorCode: null,
    });
  });

  it('requeues same-input work after ChatGPT is reconnected', async () => {
    const { db, updated } = enqueueDb({
      mode: 'live',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'cancelled',
        lastErrorCode: 'AGENT_PROVIDER_CHANGED',
      },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 1,
      unchanged: 0,
    });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      lastErrorCode: null,
    });
  });

  it('requeues same-input work that failed while ChatGPT authorization was expired', async () => {
    const { db, updated } = enqueueDb({
      mode: 'shadow',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'failed',
        lastErrorCode: 'AGENT_AUTH',
      },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 1,
      unchanged: 0,
    });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      attempt: 0,
      lastErrorCode: null,
    });
  });

  it('requeues same-input work after a covering rule is removed', async () => {
    const { db, updated } = enqueueDb({
      mode: 'shadow',
      existing: {
        id: 'job-1',
        inputHash: agentInputHash(txn(), accounts, taxCodes),
        status: 'cancelled',
        lastErrorCode: 'AGENT_RULE_COVERED',
      },
    });
    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      reset: 1,
      unchanged: 0,
    });
    expect(updated[0]).toMatchObject({
      status: 'queued',
      lastErrorCode: null,
    });
  });

  it('ignores a stale cached rule suggestion after the current rule is removed', async () => {
    const { db, created } = enqueueDb({
      mode: 'shadow',
      transactions: [
        txn({
          suggestion: {
            source: 'rule',
            ruleId: 'deleted-rule',
            category: 'Software',
          },
        }),
      ],
      rules: [],
    });

    await expect(enqueueEligibleTransactions('co-1', db)).resolves.toMatchObject({
      created: 1,
      eligible: 1,
    });
    expect(created).toHaveLength(1);
  });
});

describe('hasCurrentDeterministicRule', () => {
  it('matches the current rule table instead of the cached suggestion snapshot', async () => {
    const db = {
      transaction: {
        findUnique: vi.fn(async () => ({ companyId: 'co-1', payee: 'WEBFLOW *123' })),
      },
      rule: {
        findMany: vi.fn(async () => [
          {
            id: 'rule-1',
            matchText: 'webflow',
            category: 'Software',
            categoryQboId: 'acct-1',
            priority: 0,
            createdAt: new Date('2026-07-23T12:00:00Z'),
            taxCalculation: null,
            taxCode: null,
            taxCodeQboId: null,
          },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(hasCurrentDeterministicRule('txn-1', db)).resolves.toBe(true);
  });
});

describe('isCurrentAgentTransactionEligible', () => {
  it('requires an unstaged negative pending Purchase in the claimed company', async () => {
    const findFirst = vi.fn(async () => ({ id: 'txn-1' }));
    const db = { transaction: { findFirst } } as unknown as PrismaClient;

    await expect(
      isCurrentAgentTransactionEligible('txn-1', 'co-1', db),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'txn-1',
        companyId: 'co-1',
        status: 'PENDING',
        qboType: 'Purchase',
        amount: { lt: 0 },
        category: null,
        txnTags: { none: {} },
        splitLines: { none: {} },
      }),
      select: { id: true },
    });
  });
});

function claimDb() {
  const state = {
    id: 'job-1',
    transactionId: 'txn-1',
    companyId: 'co-1',
    status: 'queued',
    inputHash: 'hash-1',
    attempt: 0,
    nextAttemptAt: new Date('2026-07-23T12:00:00Z'),
    lockedAt: null as Date | null,
    lockOwner: null as string | null,
    leaseExpiresAt: null as Date | null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: new Date('2026-07-23T11:00:00Z'),
    updatedAt: new Date('2026-07-23T11:00:00Z'),
  };
  const db = {
    agentJob: {
      findFirst: vi.fn(async () =>
        state.status === 'queued' || state.status === 'retry' ? { ...state } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
        if (state.status !== where.status) return { count: 0 };
        state.status = data.status as string;
        state.attempt += 1;
        state.lockedAt = data.lockedAt as Date;
        state.lockOwner = data.lockOwner as string;
        state.leaseExpiresAt = data.leaseExpiresAt as Date;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ ...state })),
    },
  } as unknown as PrismaClient;
  return { db, state };
}

describe('claim and finish', () => {
  it('uses compare-and-swap so two workers cannot claim one job', async () => {
    const { db } = claimDb();
    const now = new Date('2026-07-23T12:00:00Z');
    const [a, b] = await Promise.all([
      claimNextJob('worker-a', now, db),
      claimNextJob('worker-b', now, db),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect([a?.lockOwner, b?.lockOwner].filter(Boolean)).toHaveLength(1);
  });

  it('requires the current owner, input hash, and live lease to complete', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const db = { agentJob: { updateMany } } as unknown as PrismaClient;
    const now = new Date('2026-07-23T12:00:00Z');
    await expect(completeJob('job-1', 'wrong-worker', 'hash-1', now, db)).resolves.toBe(false);
    await expect(completeJob('job-1', 'worker-a', 'hash-1', now, db)).resolves.toBe(true);
  });

  it('cannot cancel a replacement job from a stale worker claim', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = { agentJob: { updateMany } } as unknown as PrismaClient;
    const now = new Date('2026-07-23T12:00:00Z');

    await expect(
      cancelClaimedJob(
        'job-1',
        'stale-worker',
        'stale-hash',
        { code: 'AGENT_STALE_INPUT', message: 'stale' },
        now,
        db,
      ),
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          inputHash: 'stale-hash',
          status: 'running',
          lockOwner: 'stale-worker',
          leaseExpiresAt: { gt: now },
        }),
      }),
    );
  });

  it('allows external cancellation only before a worker claim is running', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = { agentJob: { updateMany } } as unknown as PrismaClient;

    await expect(
      cancelJob(
        'job-1',
        { code: 'AGENT_CANCELLED', message: 'Cancelled by an administrator.' },
        db,
      ),
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: { in: ['queued', 'retry'] } },
      }),
    );
  });
});

describe('company write lease and recovery', () => {
  it('does not steal a live company lease', async () => {
    const db = {
      agentCompanyLease: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      acquireCompanyWriteLease('co-1', 'worker-b', new Date('2026-07-23T12:00:00Z'), db),
    ).resolves.toBe(false);
  });

  it('recovers expired job and company leases', async () => {
    const jobUpdate = vi.fn(async () => ({ count: 2 }));
    const leaseDelete = vi.fn(async () => ({ count: 1 }));
    const db = {
      agentJob: { updateMany: jobUpdate },
      agentCompanyLease: { deleteMany: leaseDelete },
      $transaction: vi.fn(async (promises: Promise<unknown>[]) => Promise.all(promises)),
    } as unknown as PrismaClient;
    await expect(
      sweepExpiredAgentLeases(new Date('2026-07-23T12:00:00Z'), db),
    ).resolves.toEqual({ jobsRecovered: 2, companyLeasesRemoved: 1 });
  });

  it('holds sorted company leases around one accounting operation', async () => {
    const order: string[] = [];
    const deps = {
      acquire: vi.fn(async (companyId: string) => {
        order.push(`acquire:${companyId}`);
        return true;
      }),
      release: vi.fn(async (companyId: string) => {
        order.push(`release:${companyId}`);
      }),
    };

    await expect(
      withCompanyWriteLeases(
        ['co-b', 'co-a', 'co-b'],
        'human:request-1',
        async () => {
          order.push('write');
          return 'done';
        },
        deps,
      ),
    ).resolves.toBe('done');
    expect(order).toEqual([
      'acquire:co-a',
      'acquire:co-b',
      'write',
      'release:co-b',
      'release:co-a',
    ]);
  });

  it('renews every held company lease while a long operation runs', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const action = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const deps = {
        acquire: vi.fn(async () => true),
        release: vi.fn(async () => undefined),
      };

      const pending = withCompanyWriteLeases(
        ['co-b', 'co-a'],
        'human:request-1',
        () => action,
        deps,
      );
      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.acquire.mock.calls).toEqual([
        ['co-a', 'human:request-1'],
        ['co-b', 'human:request-1'],
        ['co-a', 'human:request-1'],
        ['co-b', 'human:request-1'],
      ]);
      finish();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a completed action result when a heartbeat reports lease loss', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const action = new Promise<string>((resolve) => {
        finish = () => resolve('written');
      });
      const acquire = vi
        .fn<(companyId: string, owner: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const deps = {
        acquire,
        release: vi.fn(async () => undefined),
      };

      const pending = withCompanyWriteLeases(
        ['co-a'],
        'human:request-1',
        () => action,
        deps,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      finish();

      await expect(pending).resolves.toBe('written');
      expect(deps.release).toHaveBeenCalledWith('co-a', 'human:request-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes heartbeat lease loss so a long action can stop subsequent writes', async () => {
    vi.useFakeTimers();
    try {
      let canContinue: (() => boolean) | undefined;
      let finish!: () => void;
      const action = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const deps = {
        acquire: vi
          .fn<(companyId: string, owner: string) => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        release: vi.fn(async () => undefined),
      };

      const pending = withCompanyWriteLeases(
        ['co-a'],
        'human:request-1',
        (guard) => {
          canContinue = guard.canContinue;
          return action;
        },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(canContinue?.()).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(canContinue?.()).toBe(false);
      finish();

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops subsequent writes when a renewal hangs past the lease expiry', async () => {
    vi.useFakeTimers();
    try {
      let finishAction!: () => void;
      let finishRenewal!: (acquired: boolean) => void;
      let canContinue: (() => boolean) | undefined;
      const action = new Promise<void>((resolve) => {
        finishAction = resolve;
      });
      const renewal = new Promise<boolean>((resolve) => {
        finishRenewal = resolve;
      });
      const deps = {
        acquire: vi
          .fn<(companyId: string, owner: string) => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockReturnValueOnce(renewal),
        release: vi.fn(async () => undefined),
      };

      const pending = withCompanyWriteLeases(
        ['co-a'],
        'human:request-1',
        (guard) => {
          canContinue = guard.canContinue;
          return action;
        },
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(canContinue?.()).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(canContinue?.()).toBe(false);

      finishRenewal(true);
      await vi.advanceTimersByTimeAsync(0);
      finishAction();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases earlier leases when a later company is busy', async () => {
    const release = vi.fn(async () => undefined);
    const deps = {
      acquire: vi
        .fn<(companyId: string, owner: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      release,
    };

    await expect(
      withCompanyWriteLeases(['co-a', 'co-b'], 'human:request-1', vi.fn(), deps),
    ).rejects.toMatchObject({ name: 'CompanyWriteLeaseBusyError', companyId: 'co-b' });
    expect(release).toHaveBeenCalledWith('co-a', 'human:request-1');
  });

  it('re-enqueues stale cancelled jobs for webhook-only companies', async () => {
    const enqueue = vi.fn(async () => ({
      created: 0,
      reset: 2,
      unchanged: 0,
      eligible: 2,
    }));
    const findMany = vi.fn(async () => [
      { id: 'job-1', companyId: 'co-1' },
      { id: 'job-2', companyId: 'co-1' },
      { id: 'job-3', companyId: 'co-2' },
    ]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      agentJob: { findMany, updateMany },
    } as unknown as PrismaClient;

    await expect(requeueStaleAgentJobs(db, enqueue)).resolves.toEqual({
      companiesScanned: 2,
      jobsQueued: 4,
      jobsRetired: 2,
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: { in: ['job-1', 'job-2'] },
          status: 'cancelled',
          lastErrorCode: 'AGENT_STALE_INPUT',
        },
        data: expect.objectContaining({ lastErrorCode: 'AGENT_INELIGIBLE' }),
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'cancelled',
          lastErrorCode: 'AGENT_STALE_INPUT',
        }),
      }),
    );
  });
});

describe('retryDelayMs', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(retryDelayMs(1, () => 0)).toBe(12_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(30_000);
    expect(retryDelayMs(99, () => 1)).toBe(2_160_000);
  });
});
