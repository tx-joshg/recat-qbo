import type { AgentJob, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from './model.js';
import type { AgentToolContext } from './context.js';
import { AgentError } from './errors.js';
import { StagingError } from '../categorization.js';
import { codexProviderState, completeShadowJob, runOneAgentJob } from './worker.js';

const job: AgentJob = {
  id: 'job-1',
  transactionId: 'txn-1',
  companyId: 'co-1',
  status: 'running',
  inputHash: 'hash-1',
  attempt: 1,
  nextAttemptAt: new Date('2026-07-23T10:00:00Z'),
  lockedAt: new Date('2026-07-23T10:00:00Z'),
  lockOwner: 'worker-1',
  leaseExpiresAt: new Date('2026-07-23T10:02:00Z'),
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: new Date('2026-07-23T09:00:00Z'),
  updatedAt: new Date('2026-07-23T10:00:00Z'),
};

const context: AgentToolContext = {
  schemaVersion: 'recat-agent-context-v1',
  companyId: 'co-1',
  transactionId: 'txn-1',
  expectedUpdatedAt: new Date('2026-07-23T09:00:00Z'),
  transaction: {
    id: 'txn-1',
    qboType: 'Purchase',
    qboSyncToken: '3',
    date: '2026-07-23T00:00:00.000Z',
    payee: 'Webflow',
    memo: null,
    amount: -29,
    bankAccount: 'Visa',
  },
  holdingAccountQboIds: ['holding-1'],
  originalLines: [],
};

const decision = {
  kind: 'categorize' as const,
  taxCalculation: 'TaxInclusive' as const,
  lines: [{ grossAmount: -29, categoryQboId: 'acct-1', taxCodeQboId: 'gst' }],
  rationale: 'Recurring software subscription.',
  evidence: ['Payee history'],
  confidence: 0.98,
};

function fixture(options: {
  mode?: 'off' | 'shadow' | 'live';
  hash?: string | null;
  hashes?: Array<string | null>;
  modes?: Array<'off' | 'shadow' | 'live'>;
  taxReady?: boolean;
  companyDryRun?: boolean;
  tagsRequired?: boolean;
  runError?: Error;
  acquire?: boolean;
  acquireResults?: boolean[];
  renew?: boolean;
  renewResults?: boolean[];
  deploymentWritesEnabled?: boolean;
  unresolvedWrites?: number;
  validatedShadowRuns?: number;
  providerStates?: Array<{ connected: boolean; generation: string | null }>;
  verifierVerdict?: 'agree' | 'disagree';
  ruleMatches?: boolean[];
  eligible?: boolean;
  complete?: boolean;
  configuredModels?: string[];
  attempt?: number;
} = {}) {
  const order: string[] = [];
  const createdRuns: unknown[] = [];
  const updatedRuns: unknown[] = [];
  const transactionUpdate = vi.fn();
  const complete = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const fail = vi.fn(async () => true);
  const cancel = vi.fn(async () => true);
  let renewRead = 0;
  const renew = vi.fn(async () => {
    order.push('job-lease');
    const result = options.renewResults?.[renewRead] ?? options.renew ?? true;
    renewRead += 1;
    return result;
  });
  let acquireRead = 0;
  const acquireWriteLease = vi.fn(async () => {
    order.push('write-lease');
    const result = options.acquireResults?.[acquireRead] ?? options.acquire ?? true;
    acquireRead += 1;
    return result;
  });
  const releaseWriteLease = vi.fn(async () => {
    order.push('release');
  });
  const stage = vi.fn(async () => {
    order.push('stage');
    return { id: 'txn-1', updatedAt: new Date('2026-07-23T10:00:02Z') };
  });
  const rollbackStage = vi.fn(async () => {
    order.push('rollback-stage');
    return true;
  });
  const post = vi.fn(async () => {
    order.push('post');
    return { id: 'txn-1', ok: true, status: 'POSTED' as const };
  });
  const writeVerification = vi.fn(async () => {
    order.push('verify');
    return { applied: true, mutation: { status: 'VERIFIED' } };
  });
  const verifyDecision = vi.fn(async () => {
    order.push('verifier');
    return {
      verdict: options.verifierVerdict ?? 'agree',
      rationale: 'Independent verifier evidence.',
    };
  });
  const refreshCandidate = vi.fn(async () => {
    order.push('candidate');
    return null;
  });
  const countUnresolvedWrites = vi.fn(async () => {
    order.push('write-readiness');
    return options.unresolvedWrites ?? 0;
  });
  const countValidatedShadowRuns = vi.fn(async () => {
    order.push('shadow-evidence');
    return options.validatedShadowRuns ?? 10;
  });
  let providerRead = 0;
  const providerState = vi.fn(async () => {
    const state = options.providerStates?.[providerRead] ?? {
      connected: true,
      generation: 'credential-v1',
    };
    providerRead += 1;
    return state;
  });
  let companyRead = 0;
  let hashRead = 0;
  let ruleRead = 0;
  const model: AgentModel = {
    provider: 'fake',
    model: 'fake-v1',
    nextTurn: vi.fn(),
  };
  let modelRead = 0;
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        order.push(companyRead === 0 ? 'company' : 'fresh-company');
        const mode = options.modes?.[companyRead] ?? options.mode ?? 'shadow';
        companyRead += 1;
        return {
          autopilotMode: mode,
          disconnectedAt: null,
          taxSupportStatus: options.taxReady === false ? 'unsupported' : 'ready',
          dryRun: options.companyDryRun ?? false,
          tagsRequired: options.tagsRequired ?? false,
        };
      }),
    },
    transaction: { update: transactionUpdate },
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdRuns.push(data);
        return { id: 'run-1', ...data };
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updatedRuns.push(data);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaClient;
  const run = options.runError
    ? vi.fn(async () => {
        order.push('model');
        throw options.runError;
      })
    : vi.fn(async () => ({
        ...(order.push('model') ? {} : {}),
        decision,
        toolTrace: [{ callId: 'call-1', name: 'get_payee_history', ok: true, resultBytes: 64 }],
        turnCount: 2,
        toolCallCount: 1,
      }));
  const validate = vi.fn(async () => ({
    ...(order.push('validate') ? {} : {}),
    ok: true,
    code: 'AGENT_VALID',
    message: 'valid',
    checkedAt: '2026-07-23T10:00:01.000Z',
    transactionUpdatedAt: '2026-07-23T10:00:01.000Z',
    resolvedLines: [
      {
        grossAmount: -29,
        categoryQboId: 'acct-1',
        category: 'Expenses · Software',
        taxCodeQboId: 'gst',
        taxCode: 'GST',
      },
    ],
  }));
  const completeShadow = vi.fn(
    async (
      _job: AgentJob,
      _workerId: string,
      _runId: string,
      values: Record<string, unknown>,
    ) => {
      if (options.complete === false) return false;
      await complete('job-1', 'worker-1', 'hash-1');
      const result = values.result as {
        decision: unknown;
        toolTrace: unknown;
        turnCount: number;
        toolCallCount: number;
      };
      updatedRuns.push({
        decision: result.decision,
        toolTrace: result.toolTrace,
        turnCount: result.turnCount,
        toolCallCount: result.toolCallCount,
        validation: values.validation,
        verifier: values.verifier,
        completedAt: new Date('2026-07-23T10:00:01Z'),
      });
      return true;
    },
  );
  const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
  return {
    createdRuns,
    order,
    updatedRuns,
    transactionUpdate,
    complete,
    completeShadow,
    retry,
    fail,
    cancel,
    acquireWriteLease,
    releaseWriteLease,
    stage,
    rollbackStage,
    post,
    writeVerification,
    verifyDecision,
    refreshCandidate,
    run,
    validate,
    deps: {
      db,
      claim: vi.fn(async () => {
        order.push('claim');
        return { ...job, attempt: options.attempt ?? job.attempt };
      }),
      renew,
      complete,
      completeShadow,
      retry,
      fail,
      cancel,
      currentHash: vi.fn(async () => {
        order.push(hashRead === 0 ? 'input-check' : 'write-input-check');
        const hash = options.hashes?.[hashRead] ?? options.hash ?? 'hash-1';
        hashRead += 1;
        return hash;
      }),
      hasRuleMatch: vi.fn(async () => {
        const match = options.ruleMatches?.[ruleRead] ?? false;
        ruleRead += 1;
        return match;
      }),
      isEligible: vi.fn(async () => {
        order.push('eligibility-check');
        return options.eligible ?? true;
      }),
      loadContext: vi.fn(async () => context),
      model: vi.fn(async () => ({
        ...model,
        model: options.configuredModels?.[modelRead++] ?? model.model,
      })),
      verifierModel: vi.fn(async () => model),
      run,
      validate,
      verifyDecision,
      refreshCandidate,
      acquireWriteLease,
      releaseWriteLease,
      stage,
      rollbackStage,
      post,
      writeVerification,
      deploymentWritesEnabled: () => options.deploymentWritesEnabled ?? true,
      countUnresolvedWrites,
      countValidatedShadowRuns,
      providerState,
      now: () => new Date('2026-07-23T10:00:01Z'),
      setInterval: vi.fn(() => timer),
      clearInterval: vi.fn(),
    },
  };
}

describe('completeShadowJob', () => {
  it('atomically records completion without starting queue reconciliation', async () => {
    const jobUpdateMany = vi.fn(async () => ({ count: 1 }));
    const runUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      agentJob: { updateMany: jobUpdateMany },
      agentRun: { updateMany: runUpdateMany },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      completeShadowJob(job, 'worker-1', 'run-1', {}, db),
    ).resolves.toBe(true);

    expect(jobUpdateMany).toHaveBeenCalledOnce();
    expect(runUpdateMany).toHaveBeenCalledOnce();
  });

  it('does not finalize the run when the job lease was lost', async () => {
    const tx = {
      agentJob: { updateMany: vi.fn(async () => ({ count: 0 })) },
      agentRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      completeShadowJob(job, 'worker-1', 'run-1', {}, db),
    ).resolves.toBe(false);

    expect(tx.agentRun.updateMany).not.toHaveBeenCalled();
  });
});

describe('codexProviderState', () => {
  it('keeps one generation across routine token rotation for the same account', async () => {
    const deps = {
      status: vi.fn(async () => ({ connected: true as const, state: 'connected' as const })),
      generation: vi.fn(async () => 'hashed-acct-stable'),
    };

    const before = await codexProviderState(deps);
    const after = await codexProviderState(deps);

    expect(after.generation).toBe(before.generation);
    expect(after.generation).toBe('hashed-acct-stable');
  });

  it('changes generation when the connected ChatGPT account changes', async () => {
    const status = vi.fn(async () => ({
      connected: true as const,
      state: 'connected' as const,
    }));

    const first = await codexProviderState({
      status,
      generation: vi.fn(async () => 'hashed-acct-one'),
    });
    const second = await codexProviderState({
      status,
      generation: vi.fn(async () => 'hashed-acct-two'),
    });

    expect(second.generation).not.toBe(first.generation);
  });
});

describe('runOneAgentJob', () => {
  it('stores validated shadow evidence without staging or mutating the transaction', async () => {
    const value = fixture();

    await expect(runOneAgentJob('worker-1', value.deps)).resolves.toBe(true);

    expect(value.createdRuns).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        transactionId: 'txn-1',
        companyId: 'co-1',
        mode: 'shadow',
        provider: 'fake',
      }),
    ]);
    expect(value.updatedRuns).toEqual([
      expect.objectContaining({
        decision,
        validation: expect.objectContaining({ ok: true }),
        completedAt: expect.any(Date),
      }),
    ]);
    expect(value.transactionUpdate).not.toHaveBeenCalled();
    expect(value.complete).toHaveBeenCalledWith('job-1', 'worker-1', 'hash-1');
    expect(value.retry).not.toHaveBeenCalled();
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('leaves promotion reconciliation to the durable company marker', async () => {
    const value = fixture({ modes: ['shadow', 'live'] });

    await expect(runOneAgentJob('worker-1', value.deps)).resolves.toBe(true);

    expect(value.complete).toHaveBeenCalledWith('job-1', 'worker-1', 'hash-1');
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('records a lease-lost shadow run as cancelled instead of valid evidence', async () => {
    const value = fixture({ complete: false });

    await expect(runOneAgentJob('worker-1', value.deps)).resolves.toBe(true);

    expect(value.updatedRuns).toEqual([
      expect.objectContaining({
        completedAt: expect.any(Date),
        errorCode: 'AGENT_CANCELLED',
      }),
    ]);
  });

  it('cancels stale input before asking the model', async () => {
    const value = fixture({ hash: 'new-hash' });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_STALE_INPUT' }),
    );
  });

  it('cancels a stale deterministic validation so durable recovery can requeue it', async () => {
    const value = fixture();
    value.deps.validate = vi.fn(async () => ({
      ok: false,
      code: 'AGENT_STALE_INPUT',
      message: 'The transaction changed after agent inference began.',
      checkedAt: '2026-07-23T10:00:01.000Z',
    }));

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_STALE_INPUT' }),
    );
    expect(value.fail).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('cancels before inference when a current deterministic rule covers the transaction', async () => {
    const value = fixture({ ruleMatches: [true] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_RULE_COVERED' }),
    );
  });

  it('cancels before inference when tax readiness was lost after queueing', async () => {
    const value = fixture({ taxReady: false });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_DISABLED' }),
    );
  });

  it('cancels before inference when a queued transaction was staged by a human', async () => {
    const value = fixture({ eligible: false });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_INELIGIBLE' }),
    );
  });

  it('retries immediately when claimed-job setup fails before a run is created', async () => {
    const value = fixture();
    value.deps.loadContext = vi.fn(async () => {
      throw new Error('database temporarily unavailable');
    });

    await expect(runOneAgentJob('worker-1', value.deps)).resolves.toBe(true);

    expect(value.retry).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_NETWORK', retryable: true }),
      expect.any(Date),
    );
    expect(value.fail).not.toHaveBeenCalled();
    expect(value.updatedRuns).toEqual([]);
  });

  it('retries retryable provider failures and closes the run evidence', async () => {
    const value = fixture({
      runError: new AgentError('AGENT_RATE_LIMIT', 'slow down', true),
    });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.retry).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_RATE_LIMIT' }),
      expect.any(Date),
    );
    expect(value.updatedRuns).toEqual([
      expect.objectContaining({
        completedAt: expect.any(Date),
        errorCode: 'AGENT_RATE_LIMIT',
      }),
    ]);
  });

  it('serializes a live stage, post, and verification after final checks', async () => {
    const value = fixture({ mode: 'live' });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.order).toEqual([
      'claim',
      'company',
      'write-readiness',
      'input-check',
      'eligibility-check',
      'shadow-evidence',
      'model',
      'write-input-check',
      'validate',
      'write-input-check',
      'verifier',
      'write-lease',
      'fresh-company',
      'write-input-check',
      'validate',
      'write-input-check',
      'write-readiness',
      'job-lease',
      'write-lease',
      'stage',
      'job-lease',
      'write-lease',
      'post',
      'verify',
      'candidate',
      'release',
    ]);
    expect(value.stage).toHaveBeenCalledWith(
      'txn-1',
      expect.objectContaining({
        categoryQboId: 'acct-1',
        taxCalculation: 'TaxInclusive',
        taxCodeQboId: 'gst',
      }),
      new Date('2026-07-23T10:00:01.000Z'),
    );
    expect(value.post).toHaveBeenCalledWith(
      'txn-1',
      new Date('2026-07-23T10:00:02Z'),
      expect.any(Function),
    );
    expect(value.complete).toHaveBeenCalledWith('job-1', 'worker-1', 'hash-1');
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('cancels live work before inference when the active model lacks shadow evidence', async () => {
    const value = fixture({ mode: 'live', validatedShadowRuns: 9 });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_LIVE_EVIDENCE_REQUIRED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('cancels live work when ChatGPT disconnects before the write lease', async () => {
    const value = fixture({
      mode: 'live',
      providerStates: [
        { connected: true, generation: 'credential-v1' },
        { connected: false, generation: null },
      ],
    });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_PROVIDER_CHANGED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('cancels live work when ChatGPT credentials rotate before the write lease', async () => {
    const value = fixture({
      mode: 'live',
      providerStates: [
        { connected: true, generation: 'credential-v1' },
        { connected: true, generation: 'credential-v2' },
      ],
    });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_PROVIDER_CHANGED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('cancels live work when the configured model changes before staging', async () => {
    const value = fixture({
      mode: 'live',
      configuredModels: ['fake-v1', 'fake-v2'],
    });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.deps.model).toHaveBeenCalledTimes(2);
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_STALE_INPUT' }),
    );
    expect(value.updatedRuns).toContainEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          applied: false,
          reason: 'model_changed',
        }),
      }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it.each([
    ['deployment dry-run', { deploymentWritesEnabled: false }],
    ['an unresolved QBO mutation', { unresolvedWrites: 1 }],
    ['company dry-run', { companyDryRun: true }],
    ['required transaction tags', { tagsRequired: true }],
  ])('blocks live inference when %s appears after activation', async (_name, options) => {
    const value = fixture({ mode: 'live', ...options });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.verifyDecision).not.toHaveBeenCalled();
    expect(value.createdRuns).toHaveLength(0);
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.retry).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_LIVE_NOT_READY', retryable: true }),
      expect.any(Date),
    );
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('keeps a persistently blocked live job retryable at capped backoff', async () => {
    const value = fixture({
      mode: 'live',
      deploymentWritesEnabled: false,
      attempt: 5,
    });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.run).not.toHaveBeenCalled();
    expect(value.createdRuns).toHaveLength(0);
    expect(value.retry).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_LIVE_NOT_READY', retryable: true }),
      expect.any(Date),
    );
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('does not stage when job ownership is lost at the write boundary', async () => {
    const value = fixture({ mode: 'live', renew: false });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.order).toContain('job-lease');
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.updatedRuns).toContainEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          applied: false,
          reason: 'write_lease_lost',
        }),
      }),
    );
  });

  it('does not stage when company ownership is lost at the write boundary', async () => {
    const value = fixture({ mode: 'live', acquireResults: [true, false] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.updatedRuns).toContainEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          applied: false,
          reason: 'write_lease_lost',
        }),
      }),
    );
  });

  it('does not post when ownership is lost after local staging', async () => {
    const value = fixture({ mode: 'live', renewResults: [true, false] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.stage).toHaveBeenCalledOnce();
    expect(value.rollbackStage).toHaveBeenCalledWith(
      'txn-1',
      new Date('2026-07-23T10:00:02Z'),
    );
    expect(value.post).not.toHaveBeenCalled();
    expect(value.updatedRuns).toContainEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          applied: false,
          reason: 'write_lease_lost_after_staging_recovered',
        }),
      }),
    );
  });

  it('drains an in-flight heartbeat before releasing the company lease', async () => {
    const value = fixture({ mode: 'live' });
    let heartbeat: (() => void) | undefined;
    let resolveRenewal: ((value: boolean) => void) | undefined;
    let acquisition = 0;
    value.deps.setInterval = vi.fn((callback: () => void) => {
      heartbeat = callback;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    value.deps.acquireWriteLease = vi.fn(async () => {
      acquisition += 1;
      if (acquisition <= 3) return true;
      return new Promise<boolean>((resolve) => {
        resolveRenewal = resolve;
      });
    });
    value.deps.post = vi.fn(async () => {
      heartbeat?.();
      return { id: 'txn-1', ok: true, status: 'POSTED' as const };
    });

    const running = runOneAgentJob('worker-1', value.deps);
    await vi.waitFor(() => expect(value.deps.acquireWriteLease).toHaveBeenCalledTimes(4));
    expect(value.releaseWriteLease).not.toHaveBeenCalled();
    resolveRenewal?.(true);
    await running;
    expect(value.releaseWriteLease).toHaveBeenCalled();
  });

  it('defers a live write when the company serialization lease is busy', async () => {
    const value = fixture({ mode: 'live', acquire: false });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.retry).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_COMPANY_BUSY' }),
      expect.any(Date),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('keeps verifier disagreement visible and out of the live write path', async () => {
    const value = fixture({ mode: 'live', verifierVerdict: 'disagree' });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.complete).toHaveBeenCalled();
    expect(value.updatedRuns).toEqual([
      expect.objectContaining({
        verifier: expect.objectContaining({ verdict: 'disagree' }),
        verification: expect.objectContaining({
          applied: false,
          reason: 'verifier_disagree',
        }),
      }),
    ]);
  });

  it('cancels when a deterministic rule appears after inference', async () => {
    const value = fixture({ mode: 'live', ruleMatches: [false, true] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_RULE_COVERED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });

  it('rechecks deterministic rules inside the company write lease', async () => {
    const value = fixture({ mode: 'live', ruleMatches: [false, false, true] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.acquireWriteLease).toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_RULE_COVERED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.releaseWriteLease).toHaveBeenCalled();
  });

  it('cancels when a rule wins the atomic staging boundary', async () => {
    const value = fixture({ mode: 'live' });
    value.stage.mockRejectedValueOnce(
      new StagingError('DETERMINISTIC_RULE', 'A deterministic rule now covers this transaction.'),
    );

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_RULE_COVERED' }),
    );
    expect(value.post).not.toHaveBeenCalled();
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('cancels when a human edit wins the atomic staging boundary', async () => {
    const value = fixture({ mode: 'live' });
    value.stage.mockRejectedValueOnce(
      new StagingError('STALE_TRANSACTION', 'This transaction changed.'),
    );

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_STALE_INPUT' }),
    );
    expect(value.post).not.toHaveBeenCalled();
    expect(value.fail).not.toHaveBeenCalled();
  });

  it('cancels if live mode is switched off before the write lease starts', async () => {
    const value = fixture({ modes: ['live', 'off'] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_DISABLED' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
    expect(value.releaseWriteLease).toHaveBeenCalled();
  });

  it('cancels stale input after deciding but before staging', async () => {
    const value = fixture({ mode: 'live', hashes: ['hash-1', 'hash-1', 'changed'] });

    await runOneAgentJob('worker-1', value.deps);

    expect(value.cancel).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      'hash-1',
      expect.objectContaining({ code: 'AGENT_STALE_INPUT' }),
    );
    expect(value.stage).not.toHaveBeenCalled();
    expect(value.post).not.toHaveBeenCalled();
  });
});
