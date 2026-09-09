import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentModelIdentity,
  AgentModelInput,
  AgentModelTurn,
} from './core/model.js';
import { AgentModelError } from './core/model.js';
import {
  claimShadowJobs,
  discoverShadowJobs,
  type AgentJobDb,
  type AgentJobDeps,
  type ClaimedAgentJob,
} from './jobs.js';
import {
  runClaimedShadowJob,
  type ShadowWorkerDb,
  type ShadowWorkerDeps,
} from './worker.js';
import { acquireAgentJobSuiteLock } from '../../test/postgresSuiteLock.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BASE_TIME = new Date('2026-07-29T09:00:00.000Z');
const RULE_ID = '77777777-7777-4777-8777-777777777777';
const LIMITS = {
  maxToolCalls: 8,
  maxTurns: 4,
  maxContextBytes: 64 * 1024,
  maxResponseBytes: 32 * 1024,
  timeoutMs: 30_000,
};

interface Fixture {
  companyId: string;
  transactionId: string;
  verifiedHistoryId: string;
  job: ClaimedAgentJob;
}

class TestModel implements AgentModel {
  readonly nextTurn = vi.fn<
    (input: AgentModelInput, signal: AbortSignal) => Promise<AgentModelTurn>
  >();

  constructor(
    readonly identity: AgentModelIdentity,
    implementation: (input: AgentModelInput, signal: AbortSignal) => Promise<AgentModelTurn>,
  ) {
    this.nextTurn.mockImplementation(implementation);
  }
}

describePostgres('durable shadow worker PostgreSQL lifecycle', () => {
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;
  let lockClient: PrismaClient;
  let releaseSuiteLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    firstClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    secondClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    lockClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      releaseSuiteLock = await acquireAgentJobSuiteLock(lockClient);
    } catch (error) {
      await Promise.all([firstClient.$disconnect(), secondClient.$disconnect(), lockClient.$disconnect()]);
      throw error;
    }
  });

  afterAll(async () => {
    await releaseSuiteLock?.();
    await Promise.all([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
      lockClient?.$disconnect(),
    ]);
  });

  function jobDeps(client: PrismaClient, now = BASE_TIME): AgentJobDeps {
    return { db: client as unknown as AgentJobDb, now: async () => now };
  }

  async function seed(): Promise<Fixture> {
    const suffix = randomUUID();
    const company = await firstClient.company.create({
      data: {
        realmId: `agent-worker-${suffix}`,
        legalName: 'Agent worker PostgreSQL fixture',
        nickname: `worker-${suffix.slice(0, 8)}`,
        holdingAccountIds: ['holding'],
        dryRun: true,
        taxSupportStatus: 'needs_setup',
      },
    });
    await firstClient.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'custom',
        decisionModel: 'decision-model',
        verifierModel: 'review-model',
        scheduleMinutes: 10,
        companyConcurrency: 1,
        evidenceThreshold: 50,
        limits: LIMITS,
        configVersion: 'config-v1',
      },
    });
    await firstClient.qboAccount.createMany({
      data: [{
        companyId: company.id,
        qboId: 'source-bank',
        name: 'Sensitive source label',
        fullName: 'Sensitive source label',
        classification: 'Bank',
        accountType: 'Bank',
        active: true,
      }, {
        companyId: company.id,
        qboId: 'expense-a',
        name: 'Generic expense',
        fullName: 'Expenses · Generic expense',
        classification: 'Expenses',
        accountType: 'Expense',
        active: true,
      }, {
        companyId: company.id,
        qboId: 'holding',
        name: 'Holding',
        fullName: 'Holding',
        classification: 'Expenses',
        accountType: 'Expense',
        active: true,
      }],
    });
    await firstClient.rule.create({
      data: {
        id: RULE_ID,
        companyId: company.id,
        priority: 1,
        matchField: 'payee',
        matchText: 'Generic',
        category: 'Generic expense',
        categoryQboId: 'expense-a',
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
      },
    });
    const verifiedHistory = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `verified-history-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '2',
        date: new Date('2026-07-20T00:00:00.000Z'),
        payee: 'Earlier verified merchant',
        amount: '-10.00',
        bankAccount: 'Sensitive source label',
        status: 'POSTED',
        revision: 2,
        taxCalculation: 'NotApplicable',
        rawData: {
          CurrencyRef: { value: 'XDR' },
          AccountRef: { value: 'source-bank' },
        },
        splitLines: {
          create: [{
            idx: 0,
            amount: '-10.00',
            category: 'Expenses · Generic expense',
            categoryQboId: 'expense-a',
            taxCodeQboId: null,
          }],
        },
      },
    });
    await firstClient.qboMutationAttempt.create({
      data: {
        transactionId: verifiedHistory.id,
        requestId: `verified-history-${suffix}`,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 2,
        expectedSyncToken: '1',
        requestHash: `verified-${suffix}`,
        requestPayload: {},
        beforeSnapshot: {},
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
      },
    });
    const dryRunHistory = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `dry-history-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-07-19T00:00:00.000Z'),
        payee: 'Earlier dry-run merchant',
        amount: '-10.00',
        bankAccount: 'Sensitive source label',
        status: 'DRY_RUN',
        revision: 1,
        taxCalculation: 'NotApplicable',
        rawData: {
          CurrencyRef: { value: 'XDR' },
          AccountRef: { value: 'source-bank' },
        },
        splitLines: {
          create: [{
            idx: 0,
            amount: '-10.00',
            category: 'Expenses · Generic expense',
            categoryQboId: 'expense-a',
            taxCodeQboId: null,
          }],
        },
      },
    });
    await firstClient.qboMutationAttempt.create({
      data: {
        transactionId: dryRunHistory.id,
        requestId: `dry-history-${suffix}`,
        operation: 'recategorize',
        status: 'DRY_RUN',
        expectedRevision: 1,
        expectedSyncToken: '0',
        requestHash: `dry-${suffix}`,
        requestPayload: {},
        beforeSnapshot: {},
        verification: { outcome: 'DRY_RUN', status: 'DRY_RUN' },
      },
    });
    const transaction = await firstClient.transaction.create({
      data: {
        companyId: company.id,
        qboId: `agent-worker-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-28T00:00:00.000Z'),
        payee: 'Generic merchant',
        memo: 'Generic memo',
        amount: '-10.00',
        bankAccount: 'Sensitive source label',
        rawData: {
          CurrencyRef: { value: 'XDR', name: 'Generic Currency' },
          AccountRef: { value: 'source-bank', name: 'Sensitive source label' },
          privatePayload: 'must-not-persist',
        },
      },
    });
    await discoverShadowJobs(company.id, jobDeps(firstClient));
    const [job] = await claimShadowJobs('worker-a', 1, jobDeps(firstClient));
    return {
      companyId: company.id,
      transactionId: transaction.id,
      verifiedHistoryId: verifiedHistory.id,
      job: job!,
    };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await firstClient.company.deleteMany({ where: { id: fixture.companyId } });
  }

  function proposalTurn(): AgentModelTurn {
    return {
      kind: 'decision',
      rawDecision: {
        decision: {
          kind: 'proposal',
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense-a',
            taxCodeQboId: null,
            memo: null,
            tagIds: [],
          }],
          tagIds: [],
          confidence: 0.8,
          evidence: [
            { kind: 'rule', id: RULE_ID },
            { kind: 'category', qboId: 'expense-a' },
          ],
          rationale: 'The bounded category evidence supports this proposal.',
        },
      },
    };
  }

  function abstainTurn(): AgentModelTurn {
    return {
      kind: 'decision',
      rawDecision: {
        decision: {
          kind: 'abstain',
          reasonCode: 'INSUFFICIENT_CONTEXT',
          rationale: 'The bounded context is insufficient.',
        },
      },
    };
  }

  function deps(
    decisionModel: AgentModel,
    reviewModel?: AgentModel,
    overrides: Partial<ShadowWorkerDeps> = {},
  ): ShadowWorkerDeps {
    return {
      db: firstClient as unknown as ShadowWorkerDb,
      workerId: 'worker-a',
      decisionModel,
      reviewModel,
      limits: LIMITS,
      now: async () => BASE_TIME,
      ...overrides,
    };
  }

  function model(
    name: string,
    turn: AgentModelTurn = proposalTurn(),
  ): TestModel {
    return new TestModel(
      { provider: 'custom', model: name },
      async () => structuredClone(turn),
    );
  }

  it('persists one sanitized verified run and atomically completes its job', async () => {
    const fixture = await seed();
    try {
      await runClaimedShadowJob(
        fixture.job,
        deps(model('decision-model'), model('review-model')),
      );

      const [job, runs] = await Promise.all([
        firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }),
        firstClient.agentRun.findMany({ where: { jobId: fixture.job.id } }),
      ]);
      expect(job).toMatchObject({ status: 'completed', lockOwner: null, attemptCount: 1 });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        attemptCount: 1,
        status: 'verified',
        errorCode: null,
        decisionModel: 'decision-model',
        verifierModel: 'review-model',
      });
      expect(JSON.stringify(runs[0]?.snapshot)).not.toMatch(/privatePayload|Sensitive source label/);
      expect(runs[0]?.snapshot).toMatchObject({
        similarVerifiedTransactions: [{
          transactionId: fixture.verifiedHistoryId,
        }],
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('completes genuine model abstentions without retrying', async () => {
    const fixture = await seed();
    try {
      const decision = model('decision-model', abstainTurn());
      const review = model('review-model');
      await runClaimedShadowJob(fixture.job, deps(decision, review));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'completed', lastErrorCode: null });
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'abstain', errorCode: null });
      expect(review.nextTurn).not.toHaveBeenCalled();
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    ['retryable network', 'AGENT_MODEL_NETWORK_ERROR', 'retryable', 'retry'],
    ['terminal provider', 'AGENT_MODEL_HTTP_ERROR', 'terminal', 'terminal'],
  ] as const)('persists a %s outcome with classified job lifecycle', async (
    _name,
    code,
    classification,
    expectedStatus,
  ) => {
    const fixture = await seed();
    try {
      const decision = new TestModel(
        { provider: 'custom', model: 'decision-model' },
        async () => {
          throw new AgentModelError(code, classification);
        },
      );
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: expectedStatus, lastErrorCode: code });
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'failed', errorCode: code });
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    ['retryable network', 'AGENT_MODEL_NETWORK_ERROR', 'retryable', 'retry'],
    ['retryable HTTP', 'AGENT_MODEL_HTTP_ERROR', 'retryable', 'retry'],
    ['terminal provider', 'AGENT_MODEL_HTTP_ERROR', 'terminal', 'terminal'],
  ] as const)('persists a review-model %s outcome with classified job lifecycle', async (
    _name,
    code,
    classification,
    expectedStatus,
  ) => {
    const fixture = await seed();
    try {
      const review = new TestModel(
        { provider: 'custom', model: 'review-model' },
        async () => {
          throw new AgentModelError(code, classification);
        },
      );
      await runClaimedShadowJob(fixture.job, deps(model('decision-model'), review));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: expectedStatus, lastErrorCode: code });
      const run = await firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } });
      expect(run).toMatchObject({ status: 'failed', errorCode: code });
      expect(run.verification).toMatchObject({
        providerFailure: { code, classification },
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('terminalizes invalid snapshot metadata without creating a run or calling a model', async () => {
    const fixture = await seed();
    try {
      await firstClient.transaction.update({
        where: { id: fixture.transactionId },
        data: {
          rawData: {
            AccountRef: { value: 'source-bank' },
          },
        },
      });
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'terminal',
          lastErrorCode: 'AGENT_MODEL_INPUT_INVALID',
        });
      await expect(firstClient.agentRun.count({ where: { jobId: fixture.job.id } }))
        .resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when raw provider source-account metadata is absent despite matching display names', async () => {
    const fixture = await seed();
    try {
      await firstClient.qboAccount.create({
        data: {
          companyId: fixture.companyId,
          qboId: 'source-bank-duplicate',
          name: 'Sensitive source label',
          fullName: 'Sensitive source label',
          classification: 'Bank',
          accountType: 'Bank',
          active: true,
        },
      });
      await firstClient.transaction.update({
        where: { id: fixture.transactionId },
        data: {
          rawData: {
            CurrencyRef: { value: 'XDR' },
          },
        },
      });
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'terminal',
          lastErrorCode: 'AGENT_MODEL_INPUT_INVALID',
        });
      await expect(firstClient.agentRun.count({ where: { jobId: fixture.job.id } }))
        .resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('fails closed when a journal has ambiguous credit-side provider account references', async () => {
    const fixture = await seed();
    try {
      await firstClient.transaction.update({
        where: { id: fixture.transactionId },
        data: {
          qboType: 'JournalEntry',
          rawData: {
            CurrencyRef: { value: 'XDR' },
            Line: [{
              JournalEntryLineDetail: {
                PostingType: 'Credit',
                AccountRef: { value: 'source-bank' },
              },
            }, {
              JournalEntryLineDetail: {
                PostingType: 'Credit',
                AccountRef: { value: 'expense-a' },
              },
            }],
          },
        },
      });
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'terminal',
          lastErrorCode: 'AGENT_MODEL_INPUT_INVALID',
        });
      await expect(firstClient.agentRun.count({ where: { jobId: fixture.job.id } }))
        .resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('does not retry malformed model responses', async () => {
    const fixture = await seed();
    try {
      const decision = model('decision-model', {
        kind: 'decision',
        rawDecision: { malformed: true },
      });
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'completed', lastErrorCode: null });
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'abstain', errorCode: 'AGENT_DECISION_INVALID' });
    } finally {
      await cleanup(fixture);
    }
  });

  it('makes a classified transient provider failure terminal on attempt three', async () => {
    const fixture = await seed();
    try {
      await firstClient.agentJob.update({
        where: { id: fixture.job.id },
        data: { attemptCount: 3 },
      });
      const thirdAttempt = { ...fixture.job, attemptCount: 3 };
      const decision = new TestModel(
        { provider: 'custom', model: 'decision-model' },
        async () => {
          throw new AgentModelError('AGENT_MODEL_NETWORK_ERROR', 'retryable');
        },
      );
      await runClaimedShadowJob(thirdAttempt, deps(decision, model('review-model')));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'terminal',
          attemptCount: 3,
          lastErrorCode: 'AGENT_MODEL_NETWORK_ERROR',
        });
    } finally {
      await cleanup(fixture);
    }
  });

  it('cancels stale revision and configuration before inference', async () => {
    const fixture = await seed();
    try {
      await firstClient.transaction.update({
        where: { id: fixture.transactionId },
        data: { revision: { increment: 1 } },
      });
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'cancelled', lastErrorCode: 'AGENT_SUPERSEDED' });
      await expect(firstClient.agentRun.count({ where: { jobId: fixture.job.id } }))
        .resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('rejects a superseded scheduling intent after run start without inference', async () => {
    const fixture = await seed();
    try {
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model'), {
        afterStarted: async () => {
          await secondClient.agentCompanyConfig.update({
            where: { companyId: fixture.companyId }, data: { schedulingGeneration: { increment: 1 } },
          });
        },
      }));
      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'failed', errorCode: 'AGENT_SUPERSEDED' });
    } finally { await cleanup(fixture); }
  });

  it('revalidates after the started run and records stale without inference', async () => {
    const fixture = await seed();
    try {
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model'), {
        afterStarted: async () => {
          await secondClient.agentCompanyConfig.update({
            where: { companyId: fixture.companyId },
            data: { configVersion: 'config-v2' },
          });
        },
      }));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'failed', errorCode: 'AGENT_SUPERSEDED' });
    } finally {
      await cleanup(fixture);
    }
  });

  it('revalidates company connection after the started run and does not begin inference', async () => {
    const fixture = await seed();
    try {
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model'), {
        afterStarted: async () => {
          await secondClient.company.update({
            where: { id: fixture.companyId },
            data: { disconnectedAt: BASE_TIME },
          });
        },
      }));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'cancelled',
          lastErrorCode: 'AGENT_SUPERSEDED',
        });
      await expect(firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'failed',
          errorCode: 'AGENT_SUPERSEDED',
        });
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    'transaction revision',
    'transaction status',
    'configuration mode',
    'configuration version',
  ] as const)('revalidates %s after provider execution before persisting a decision', async (change) => {
    const fixture = await seed();
    try {
      const decision = model('decision-model');
      const review = model('review-model');
      await runClaimedShadowJob(fixture.job, deps(decision, review, {
        beforeComplete: async () => {
          if (change === 'transaction revision') {
            await secondClient.transaction.update({
              where: { id: fixture.transactionId },
              data: { revision: { increment: 1 } },
            });
          } else if (change === 'transaction status') {
            await secondClient.transaction.update({
              where: { id: fixture.transactionId },
              data: { status: 'ERROR' },
            });
          } else if (change === 'configuration mode') {
            await secondClient.agentCompanyConfig.update({
              where: { companyId: fixture.companyId },
              data: { mode: 'off' },
            });
          } else {
            await secondClient.agentCompanyConfig.update({
              where: { companyId: fixture.companyId },
              data: { configVersion: 'config-v2' },
            });
          }
        },
      }));

      expect(decision.nextTurn).toHaveBeenCalled();
      expect(review.nextTurn).toHaveBeenCalled();
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'cancelled',
          lastErrorCode: 'AGENT_SUPERSEDED',
        });
      const run = await firstClient.agentRun.findFirstOrThrow({ where: { jobId: fixture.job.id } });
      expect(run).toMatchObject({
        status: 'failed',
        errorCode: 'AGENT_SUPERSEDED',
        decision: null,
        verification: null,
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('does not let a lease-lost worker persist a provider result or mutate the reclaimed job', async () => {
    const fixture = await seed();
    try {
      const decision = new TestModel(
        { provider: 'custom', model: 'decision-model' },
        async () => {
          await secondClient.agentJob.update({
            where: { id: fixture.job.id },
            data: { leaseExpiresAt: new Date(BASE_TIME.getTime() - 1) },
          });
          const [reclaimed] = await claimShadowJobs(
            'worker-b',
            1,
            jobDeps(secondClient, new Date(BASE_TIME.getTime() + 1)),
          );
          expect(reclaimed?.attemptCount).toBe(2);
          return proposalTurn();
        },
      );
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'running', lockOwner: 'worker-b', attemptCount: 2 });
      await expect(firstClient.agentRun.findFirstOrThrow({
        where: { jobId: fixture.job.id, attemptCount: 1 },
      })).resolves.toMatchObject({ status: 'failed', errorCode: 'AGENT_RUN_ABANDONED' });
    } finally {
      await cleanup(fixture);
    }
  });

  it('records lease loss after a provider response when the attempt expires unreclaimed', async () => {
    const fixture = await seed();
    try {
      const decision = new TestModel(
        { provider: 'custom', model: 'decision-model' },
        async () => {
          await secondClient.agentJob.update({
            where: { id: fixture.job.id },
            data: { leaseExpiresAt: new Date(BASE_TIME.getTime() - 1) },
          });
          return proposalTurn();
        },
      );
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({ status: 'running', lockOwner: 'worker-a', attemptCount: 1 });
      await expect(firstClient.agentRun.findFirstOrThrow({
        where: { jobId: fixture.job.id, attemptCount: 1 },
      })).resolves.toMatchObject({ status: 'failed', errorCode: 'AGENT_RUN_LEASE_LOST' });
    } finally {
      await cleanup(fixture);
    }
  });

  it.each(['afterStarted', 'beforeComplete'] as const)(
    'abandons a crashed prior attempt on restart at %s and creates one run per attempt',
    async (crashPoint) => {
      const fixture = await seed();
      try {
        const crash = async (): Promise<void> => {
          throw new Error('simulated-process-stop');
        };
        await expect(runClaimedShadowJob(fixture.job, deps(
          model('decision-model'),
          model('review-model'),
          { [crashPoint]: crash },
        ))).rejects.toThrow('simulated-process-stop');

        await firstClient.agentJob.update({
          where: { id: fixture.job.id },
          data: { leaseExpiresAt: new Date(BASE_TIME.getTime() - 1) },
        });
        const [reclaimed] = await claimShadowJobs(
          'worker-b',
          1,
          jobDeps(firstClient, new Date(BASE_TIME.getTime() + 1)),
        );
        await expect(firstClient.agentRun.findFirstOrThrow({
          where: { jobId: fixture.job.id, attemptCount: 1 },
        })).resolves.toMatchObject({
          status: 'failed',
          errorCode: 'AGENT_RUN_ABANDONED',
        });
        await runClaimedShadowJob(reclaimed!, deps(
          model('decision-model'),
          model('review-model'),
          { workerId: 'worker-b', now: async () => new Date(BASE_TIME.getTime() + 1) },
        ));

        const runs = await firstClient.agentRun.findMany({
          where: { jobId: fixture.job.id },
          orderBy: { attemptCount: 'asc' },
        });
        expect(runs).toMatchObject([
          { attemptCount: 1, status: 'failed', errorCode: 'AGENT_RUN_ABANDONED' },
          { attemptCount: 2, status: 'verified', errorCode: null },
        ]);
      } finally {
        await cleanup(fixture);
      }
    },
  );

  it('abandons a crashed third run when the exhausted job is terminalized', async () => {
    const fixture = await seed();
    try {
      await firstClient.agentJob.update({
        where: { id: fixture.job.id },
        data: { attemptCount: 3 },
      });
      const thirdAttempt = { ...fixture.job, attemptCount: 3 };
      await expect(runClaimedShadowJob(thirdAttempt, deps(
        model('decision-model'),
        model('review-model'),
        { afterStarted: async () => { throw new Error('simulated-process-stop'); } },
      ))).rejects.toThrow();
      await firstClient.agentJob.update({
        where: { id: fixture.job.id },
        data: { leaseExpiresAt: new Date(BASE_TIME.getTime() - 1) },
      });

      await expect(claimShadowJobs(
        'worker-b',
        1,
        jobDeps(firstClient, new Date(BASE_TIME.getTime() + 1)),
      )).resolves.toEqual([]);
      await expect(firstClient.agentRun.findFirstOrThrow({
        where: { jobId: fixture.job.id, attemptCount: 3 },
      })).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'AGENT_RUN_ABANDONED',
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('closes a crashed started run when claim-time freshness cancellation wins', async () => {
    const fixture = await seed();
    try {
      await expect(runClaimedShadowJob(fixture.job, deps(
        model('decision-model'),
        model('review-model'),
        { afterStarted: async () => { throw new Error('simulated-process-stop'); } },
      ))).rejects.toThrow();
      await firstClient.transaction.update({
        where: { id: fixture.transactionId },
        data: { revision: { increment: 1 } },
      });

      await expect(claimShadowJobs(
        'worker-b',
        1,
        jobDeps(firstClient, new Date(BASE_TIME.getTime() + 1)),
      )).resolves.toEqual([]);
      await expect(firstClient.agentJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .resolves.toMatchObject({
          status: 'cancelled',
          lastErrorCode: 'AGENT_SUPERSEDED',
        });
      await expect(firstClient.agentRun.findFirstOrThrow({
        where: { jobId: fixture.job.id, attemptCount: 1 },
      })).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'AGENT_SUPERSEDED',
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it('is idempotent when the same claimed attempt is invoked again', async () => {
    const fixture = await seed();
    try {
      await expect(runClaimedShadowJob(fixture.job, deps(
        model('decision-model'),
        model('review-model'),
        { afterStarted: async () => { throw new Error('simulated-process-stop'); } },
      ))).rejects.toThrow();
      const decision = model('decision-model');
      await runClaimedShadowJob(fixture.job, deps(decision, model('review-model')));

      expect(decision.nextTurn).not.toHaveBeenCalled();
      await expect(firstClient.agentRun.count({ where: { jobId: fixture.job.id } }))
        .resolves.toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });
});
