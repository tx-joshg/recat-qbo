import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import type {
  QboClient,
  QboPreparedWrite,
  QboPurchaseSnapshot,
  QboTxn,
} from '../../lib/qbo/types.js';
import { stageGuardedLiveCategorization } from '../categorization.js';
import { disconnectCompanyWithLiveAuthority } from '../companyLiveAuthority.js';
import { commitGuardedLiveCategorization } from '../writeback.js';
import { isTransferPair } from '../transferCandidates.js';
import {
  refreshTaxReference,
  type TaxReferenceDb,
} from '../tax/reference.js';
import {
  claimShadowJobs,
  type AgentJobDb,
  type ClaimedAgentJob,
} from './jobs.js';
import {
  evaluateLiveGates,
  getLiveProviderBinding,
  LIVE_POLICY_VERSION,
} from './liveGates.js';
import { pauseLiveCompany } from './circuitBreaker.js';
import { updateShadowSettings, type AgentSettingsDb } from './settings.js';
import { acquireAgentJobSuiteLock } from '../../test/postgresSuiteLock.js';
import {
  liveTaxAuthorityDigest,
  type LiveMutationContext,
  type LiveMutationProof,
} from './liveMutationAuthority.js';
import {
  finishProductionLiveRun,
  isClaimedLiveJobAuthorized,
  runProductionClaimedLiveJob,
  runProductionClaimedLiveRecovery,
  type ProductionLiveWorkerModels,
} from './liveWorker.js';
import type { LiveAgentModel } from './liveVerifier.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hashPreparedWriteBody(body: QboPreparedWrite['body']): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
const LIMITS = {
  maxToolCalls: 8,
  maxTurns: 4,
  maxContextBytes: 64 * 1024,
  maxResponseBytes: 32 * 1024,
  timeoutMs: 30_000,
};

interface Fixture {
  readonly companyId: string;
  readonly transactionId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly context: LiveMutationContext;
  readonly proof: LiveMutationProof;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres('guarded live mutation PostgreSQL composition', () => {
  let second: PrismaClient;
  let third: PrismaClient;
  let lockClient: PrismaClient;
  let releaseSuiteLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    second = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    third = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    lockClient = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    try {
      releaseSuiteLock = await acquireAgentJobSuiteLock(lockClient);
    } catch (error) {
      await Promise.all([second.$disconnect(), third.$disconnect(), lockClient.$disconnect()]);
      throw error;
    }
  });

  afterAll(async () => {
    await releaseSuiteLock?.();
    await Promise.all([
      second.$disconnect(),
      third.$disconnect(),
      lockClient.$disconnect(),
    ]);
  });

  async function seed(options: {
    staged?: boolean;
    attemptCount?: number;
    dailyLiveWriteLimit?: number;
  } = {}): Promise<Fixture> {
    const suffix = randomUUID();
    const company = await prisma.company.create({
      data: {
        realmId: `live-mutation-${suffix}`,
        legalName: 'Generic live mutation fixture',
        nickname: `generic-${suffix.slice(0, 8)}`,
        holdingAccountIds: ['holding-generic'],
        dryRun: false,
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
        taxReferenceRefreshedAt: new Date(),
      },
    });
    await prisma.agentCompanyConfig.create({
      data: {
        companyId: company.id,
        mode: 'shadow',
        provider: 'custom',
        decisionModel: 'decision-generic',
        verifierModel: 'verifier-generic',
        scheduleMinutes: 10,
        companyConcurrency: 1,
        evidenceThreshold: 1,
        limits: LIMITS,
        configVersion: 'config-generic',
        liveRequested: true,
        liveAcceptedPolicyVersion: LIVE_POLICY_VERSION,
        liveAcceptedConfigVersion: 'config-generic',
        liveEnabledAt: new Date(),
      },
    });
    if (options.dailyLiveWriteLimit !== undefined) {
      await prisma.$executeRaw`
        UPDATE "AgentCompanyConfig"
        SET "dailyLiveWriteLimit" = ${options.dailyLiveWriteLimit}
        WHERE "companyId" = ${company.id}
      `;
    }
    const binding = await getLiveProviderBinding(company.id, prisma);
    await prisma.agentCompanyConfig.update({
      where: { companyId: company.id },
      data: { liveAcceptedProviderBinding: binding },
    });
    await prisma.qboAccount.createMany({
      data: [{
        companyId: company.id,
        qboId: 'source-generic',
        name: 'Generic source',
        fullName: 'Generic source',
        classification: 'Bank',
        accountType: 'Bank',
        active: true,
      }, {
        companyId: company.id,
        qboId: 'expense-generic',
        name: 'Generic expense',
        fullName: 'Generic expense',
        classification: 'Expenses',
        accountType: 'Expense',
        active: true,
      }, {
        companyId: company.id,
        qboId: 'holding-generic',
        name: 'Generic holding',
        fullName: 'Generic holding',
        classification: 'Expenses',
        accountType: 'Expense',
        active: true,
      }],
    });
    const staged = options.staged ?? true;
    const transaction = await prisma.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '7',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'Generic supplier',
        amount: '-10.00',
        bankAccount: 'Generic source',
        revision: staged ? 1 : 0,
        taxCalculation: staged ? 'NotApplicable' : null,
        rawData: {
          CurrencyRef: { value: 'XTS' },
          AccountRef: { value: 'source-generic' },
        },
        ...(staged
          ? {
              splitLines: {
                create: [{
                  idx: 0,
                  amount: '-10.00',
                  category: 'Generic expense',
                  categoryQboId: 'expense-generic',
                  taxCodeQboId: null,
                }],
              },
            }
          : {}),
      },
    });
    const attemptCount = options.attemptCount ?? 1;
    const workerId = 'worker-generic';
    const owner = `agent:job-pending:${attemptCount}`;
    const job = await prisma.agentJob.create({
      data: {
        companyId: company.id,
        transactionId: transaction.id,
        revision: 0,
        configVersion: 'config-generic',
        status: 'running',
        dueAt: new Date(),
        lockOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attemptCount,
      },
    });
    const exactOwner = `agent:${job.id}:${attemptCount}`;
    await prisma.qboEntityLease.createMany({
      data: [{
        companyId: company.id,
        qboType: 'Company',
        qboId: company.id,
        owner: exactOwner,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      }, {
        companyId: company.id,
        qboType: 'Purchase',
        qboId: transaction.qboId,
        owner: exactOwner,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      }],
    });
    const context: LiveMutationContext = {
      jobId: job.id,
      companyId: company.id,
      transactionId: transaction.id,
      originalRevision: 0,
      configVersion: 'config-generic',
      attemptCount,
      workerId,
      owner: exactOwner,
      entityKey: {
        companyId: company.id,
        qboType: 'Purchase',
        qboId: transaction.qboId,
      },
    };
    return {
      companyId: company.id,
      transactionId: transaction.id,
      jobId: job.id,
      owner,
      context,
      proof: {
        providerBinding: binding,
        taxAuthorityDigest: liveTaxAuthorityDigest({
          companyId: company.id,
          status: 'ready',
          usingSalesTax: true,
          refreshedAt: company.taxReferenceRefreshedAt?.toISOString() ?? null,
          codes: [],
          rates: [],
        }),
      },
    };
  }

  async function cleanup(fixture: Fixture): Promise<void> {
    await prisma.qboEntityLease.deleteMany({ where: { companyId: fixture.companyId } });
    await prisma.company.deleteMany({ where: { id: fixture.companyId } });
  }

  async function createLiveWritePermit(
    fixture: Fixture,
    requestId: string,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LiveWritePermit"
        ("requestId", "companyId", "utcDay", "limitAtIssue", "createdAt")
       VALUES ($1, $2, (clock_timestamp() AT TIME ZONE 'UTC')::date, 1, clock_timestamp())`,
      requestId,
      fixture.companyId,
    );
  }

  async function liveWritePermitCount(fixture: Fixture): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count"
         FROM "LiveWritePermit"
        WHERE "companyId" = $1`,
      fixture.companyId,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  function beforeSnapshot(fixture: Fixture): QboPurchaseSnapshot {
    return {
      qboId: fixture.context.entityKey.qboId,
      syncToken: '7',
      totalCents: -1_000,
      accountQboId: 'source-generic',
      date: '2026-07-29',
      direction: 'purchase',
      globalTaxCalculation: null,
      totalTaxCents: 0,
      lines: [{
        id: 'line-holding',
        amountCents: -1_000,
        description: null,
        accountQboId: 'holding-generic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: null,
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    };
  }

  function verifiedSnapshot(fixture: Fixture): QboPurchaseSnapshot {
    return {
      ...beforeSnapshot(fixture),
      syncToken: '8',
      globalTaxCalculation: 'NotApplicable',
      lines: [{
        ...beforeSnapshot(fixture).lines[0]!,
        id: 'line-expense',
        accountQboId: 'expense-generic',
      }],
    };
  }

  function prepared(fixture: Fixture): QboPreparedWrite {
    const before = beforeSnapshot(fixture);
    const body: QboPreparedWrite['body'] = {
      Id: fixture.context.entityKey.qboId,
      SyncToken: '7',
      TxnDate: '2026-07-29',
      TotalAmt: 10,
      AccountRef: { value: 'source-generic' },
      CurrencyRef: { value: 'XTS' },
      GlobalTaxCalculation: 'NotApplicable',
      Line: [{
        Id: 'line-expense',
        Amount: 10,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'expense-generic' },
        },
      }],
    };
    return {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: fixture.context.entityKey.qboId,
      requestId: fixture.jobId,
      requestHash: hashPreparedWriteBody(body),
      body,
      before,
      expected: {
        qboId: fixture.context.entityKey.qboId,
        totalCents: -1_000,
        accountQboId: 'source-generic',
        date: '2026-07-29',
        direction: 'purchase',
        globalTaxCalculation: 'NotApplicable',
        totalTaxCents: 0,
        targetLines: verifiedSnapshot(fixture).lines,
        untouchedLineHashes: [],
      },
    };
  }

  function currentTxn(fixture: Fixture): QboTxn {
    return {
      qboId: fixture.context.entityKey.qboId,
      qboType: 'Purchase',
      syncToken: '7',
      date: '2026-07-29',
      payee: 'Generic supplier',
      amount: -10,
      bankAccount: 'Generic source',
      lines: [{
        id: 'line-holding',
        amount: -10,
        accountQboId: 'holding-generic',
        accountName: 'Generic holding',
      }],
      raw: { CurrencyRef: { value: 'XTS' } },
    };
  }

  function recoveryCheckpoint(fixture: Fixture) {
    const decision = {
      kind: 'proposal' as const,
      taxCalculation: 'NotApplicable' as const,
      lines: [{
        grossCents: -1_000,
        categoryQboId: 'expense-generic',
        taxCodeQboId: null,
        memo: null,
        tagIds: [],
      }],
      tagIds: [],
      confidence: 0.99,
      evidence: [{ kind: 'category' as const, qboId: 'expense-generic' }],
      rationale: 'Generic evidence.',
    };
    const result = {
      status: 'verified' as const,
      decision,
      snapshotRevision: 0,
      decisionProvider: 'custom',
      decisionModel: 'decision-generic',
      promptVersion: 'agent-model-v1' as const,
      schemaVersion: 1 as const,
      durationMs: 10,
      turns: 1,
      toolCalls: 0,
      verificationMode: 'distinct_model' as const,
      diagnosticCode: 'AGENT_RUN_VERIFIED' as const,
    };
    return {
      decision,
      result,
      verification: {
        ok: true as const,
        code: 'AGENT_DECISION_VERIFIED' as const,
        message: 'Verified.',
        decision,
        liveIdentityProof: {
          version: 1 as const,
          providerBinding: fixture.proof.providerBinding,
          decisionIdentity: 'custom:resolved/decision',
          verifierIdentity: 'custom:resolved/verifier',
        },
      },
      proof: fixture.proof,
    };
  }

  async function createCheckpointRun(
    fixture: Fixture,
    attemptCount = 1,
  ): Promise<void> {
    const checkpoint = recoveryCheckpoint(fixture);
    await prisma.agentRun.create({
      data: {
        jobId: fixture.jobId,
        companyId: fixture.companyId,
        transactionId: fixture.transactionId,
        revision: 0,
        configVersion: 'config-generic',
        attemptCount,
        status: 'running',
        snapshot: {
          transaction: { id: fixture.transactionId, revision: 0 },
        },
        decision: checkpoint.decision,
        verification: { liveCheckpoint: { version: 1, ...checkpoint } },
        decisionModel: 'decision-generic',
        verifierModel: 'verifier-generic',
        verifierKind: 'distinct_model',
        promptVersion: 'agent-model-v1',
        schemaVersion: '1',
      },
    });
  }

  async function expireAndClaim(
    fixture: Fixture,
    workerId = 'worker-recovery',
    expectedAttemptCount = fixture.context.attemptCount + 1,
  ) {
    await prisma.agentJob.update({
      where: { id: fixture.jobId },
      data: {
        dueAt: new Date(Date.now() - 1_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    await prisma.qboEntityLease.deleteMany({ where: { companyId: fixture.companyId } });
    const [claimed] = await claimShadowJobs(workerId, 1, {
      db: prisma as unknown as AgentJobDb,
    });
    expect(claimed).toMatchObject({
      id: fixture.jobId,
      attemptCount: expectedAttemptCount,
      revision: 0,
    });
    return claimed!;
  }

  async function seedExpiredRecovery(
    fixture: Fixture,
    status: 'PREPARED' | 'RETRYABLE' | 'COMMITTING' | 'UNCERTAIN',
  ) {
    await createCheckpointRun(fixture);
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: fixture.transactionId,
        requestId: fixture.jobId,
        operation: 'recategorize',
        status,
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash: prepared(fixture).requestHash,
        requestPayload: prepared(fixture),
        beforeSnapshot: beforeSnapshot(fixture),
      },
    });
    return expireAndClaim(fixture);
  }

  function recoveryModels(nextTurn = vi.fn()): ProductionLiveWorkerModels {
    const model = (name: string): LiveAgentModel => ({
      identity: { provider: 'custom', model: name },
      healthAuthority: `authority-${name}`,
      nextTurn,
      probe: vi.fn(),
      reviewLiveDecision: vi.fn(),
    });
    return {
      decisionModel: model('decision-generic'),
      reviewModel: model('verifier-generic'),
      limits: LIMITS,
    };
  }

  function client(
    fixture: Fixture,
    snapshots: () => Promise<QboPurchaseSnapshot | null>,
    sendPreparedWrite = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' })),
  ): QboClient {
    return {
      fetchTxn: vi.fn(async () => currentTxn(fixture)),
      fetchPreparedSnapshot: vi.fn(snapshots),
      fetchWriteSafety: vi.fn(async () => ({
        bookCloseDate: null,
        cleared: false,
        reconciled: false,
      })),
      prepareRecategorization: vi.fn(async () => prepared(fixture)),
      preparePurchaseRecategorization: vi.fn(async () => prepared(fixture)),
      sendPreparedWrite,
    } as unknown as QboClient;
  }

  function unstagedProposal(fixture: Fixture) {
    return {
      transactionId: fixture.transactionId,
      companyId: fixture.companyId,
      expectedRevision: 0,
      proposal: {
        taxCalculation: 'NotApplicable' as const,
        lines: [{ grossCents: -1_000, categoryQboId: 'expense-generic', taxCodeQboId: null, tagIds: [] }],
        tagIds: [],
      },
    };
  }

  async function apparentCounterpart(fixture: Fixture, changes: {
    companyId?: string; amount?: string; bankAccount?: string; date?: Date;
    status?: 'PENDING' | 'POSTED'; category?: string; split?: boolean;
  } = {}) {
    return prisma.transaction.create({
      data: {
        companyId: changes.companyId ?? fixture.companyId,
        qboId: `counterpart-${randomUUID()}`,
        qboType: 'Deposit', qboSyncToken: '1',
        payee: 'Synthetic counterpart', amount: changes.amount ?? '10.00',
        bankAccount: changes.bankAccount ?? 'Other synthetic bank',
        date: changes.date ?? new Date('2026-07-29T00:00:00.000Z'),
        status: changes.status ?? 'PENDING', category: changes.category ?? null,
        rawData: {},
        ...(changes.split ? { splitLines: { create: [{
          idx: 0, amount: '10.00', category: 'Generic expense', categoryQboId: 'expense-generic',
        }] } } : {}),
      },
    });
  }

  it.each([
    { payee: 'Synthetic PAYROLL service', memo: null },
    { payee: 'Generic supplier', memo: 'Monthly salary payment' },
    { payee: 'Generic supplier', memo: 'Monthly salaries' },
    { payee: 'Generic supplier', memo: 'wage' },
    { payee: 'Generic supplier', memo: 'wages' },
    ...['adp', 'gusto', 'paychex', 'ceridian', 'deel'].map((marker) => ({
      payee: 'Generic supplier', memo: `Synthetic ${marker} entry`,
    })),
  ])('vetoes payroll-like staging before any local preparation: %j', async (text) => {
    const fixture = await seed({ staged: false });
    try {
      await prisma.transaction.update({ where: { id: fixture.transactionId }, data: text });
      await expect(stageGuardedLiveCategorization(
        unstagedProposal(fixture), fixture.context, fixture.proof,
      )).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED' });
      await expect(prisma.transaction.findUniqueOrThrow({ where: { id: fixture.transactionId } }))
        .resolves.toMatchObject({ revision: 0, taxCalculation: null });
      await expect(prisma.splitLine.count({ where: { txnId: fixture.transactionId } })).resolves.toBe(0);
      await expect(prisma.qboMutationAttempt.count({ where: { transactionId: fixture.transactionId } })).resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    ['same day', new Date('2026-07-29T00:00:00.000Z')],
    ['three days before', new Date('2026-07-26T00:00:00.000Z')],
    ['three days after', new Date('2026-08-01T00:00:00.000Z')],
  ] as const)('vetoes an apparent transfer %s before staging', async (_label, date) => {
    const fixture = await seed({ staged: false });
    try {
      const counterpart = await apparentCounterpart(fixture, { date });
      expect(isTransferPair({
        id: fixture.transactionId, amount: -10, bankAccount: 'Generic source',
        date: new Date('2026-07-29T00:00:00.000Z'),
      }, { ...counterpart, amount: Number(counterpart.amount) })).toBe(true);
      await expect(stageGuardedLiveCategorization(
        unstagedProposal(fixture), fixture.context, fixture.proof,
      )).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED' });
      await expect(prisma.transaction.findUniqueOrThrow({ where: { id: fixture.transactionId } }))
        .resolves.toMatchObject({ revision: 0, taxCalculation: null });
      await expect(prisma.splitLine.count({ where: { txnId: fixture.transactionId } })).resolves.toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it.each([
    ['different amount', { amount: '10.01' }, false],
    ['same sign', { amount: '-10.00' }, false],
    ['same bank', { bankAccount: 'Generic source' }, false],
    ['outside earlier date bound', { date: new Date('2026-07-25T23:59:59.999Z') }, false],
    ['outside later date bound', { date: new Date('2026-08-01T00:00:00.001Z') }, false],
    ['posted counterpart', { status: 'POSTED' as const }, true],
    ['category staged', { category: 'Generic expense' }, true],
    ['split staged', { split: true }, true],
  ] as const)('keeps an ordinary eligible Purchase stageable with %s', async (_label, changes, pairMatches) => {
    const fixture = await seed({ staged: false });
    try {
      const counterpart = await apparentCounterpart(fixture, changes);
      // Guard SQL must agree with the shared pair predicate; status/staging
      // eligibility additionally excludes otherwise matching counterparts.
      expect(isTransferPair({
        id: fixture.transactionId, amount: -10, bankAccount: 'Generic source',
        date: new Date('2026-07-29T00:00:00.000Z'),
      }, { ...counterpart, amount: Number(counterpart.amount) })).toBe(pairMatches);
      await prisma.transaction.update({
        where: { id: fixture.transactionId },
        data: { payee: 'Synthetic salaryman', memo: 'Upgraded supplies' },
      });
      await expect(stageGuardedLiveCategorization(
        unstagedProposal(fixture), fixture.context, fixture.proof,
      )).resolves.toMatchObject({ transactionId: fixture.transactionId, revision: 1 });
    } finally {
      await cleanup(fixture);
    }
  });

  it('does not treat a matching transaction in another company as a transfer', async () => {
    const fixture = await seed({ staged: false });
    const other = await seed({ staged: false });
    try {
      await apparentCounterpart(fixture, { companyId: other.companyId });
      await expect(stageGuardedLiveCategorization(
        unstagedProposal(fixture), fixture.context, fixture.proof,
      )).resolves.toMatchObject({ transactionId: fixture.transactionId, revision: 1 });
    } finally {
      await cleanup(other);
      await cleanup(fixture);
    }
  });

  it.each([
    ['payroll', 'PREPARED'], ['transfer', 'PREPARED'],
    ['payroll', 'RETRYABLE'], ['transfer', 'RETRYABLE'],
  ] as const)('vetoes %s introduced after staging on the production %s recovery entrypoint', async (risk, status) => {
    const fixture = await seed();
    const claimed = await seedExpiredRecovery(fixture, status);
    const nextTurn = vi.fn();
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => beforeSnapshot(fixture), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      if (risk === 'payroll') {
        await prisma.transaction.update({ where: { id: fixture.transactionId }, data: { memo: 'Synthetic payroll entry' } });
      } else {
        await apparentCounterpart(fixture);
      }
      await runProductionClaimedLiveJob(claimed, 'worker-recovery', recoveryModels(nextTurn));
      expect(nextTurn).not.toHaveBeenCalled();
      expect(qbo.prepareRecategorization).not.toHaveBeenCalled();
      expect(qbo.preparePurchaseRecategorization).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await expect(liveWritePermitCount(fixture)).resolves.toBe(0);
      await expect(prisma.transaction.findUniqueOrThrow({ where: { id: fixture.transactionId } }))
        .resolves.toMatchObject({ status: 'PENDING', revision: 1 });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('uses the hard-wired fixed actor/owner path and excludes only its own PREPARED attempt', async () => {
    const fixture = await seed();
    const snapshots = [
      beforeSnapshot(fixture),
      beforeSnapshot(fixture),
      verifiedSnapshot(fixture),
    ];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      const result = await commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);

      expect(result).toMatchObject({ outcome: 'VERIFIED', status: 'POSTED' });
      expect(send).toHaveBeenCalledOnce();
      await expect(liveWritePermitCount(fixture)).resolves.toBe(1);
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'VERIFIED' });
      await expect(prisma.auditEntry.findFirstOrThrow({
        where: { companyId: fixture.companyId, txnId: fixture.transactionId },
      })).resolves.toMatchObject({
        actorId: null,
        actorLabel: 'Recat autopilot',
      });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('terminalizes a cap-denied prepared attempt before COMMITTING or a QBO send', async () => {
    const fixture = await seed({ dailyLiveWriteLimit: 1 });
    await createLiveWritePermit(fixture, `already-used-${randomUUID()}`);
    const snapshots = [beforeSnapshot(fixture), beforeSnapshot(fixture)];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      await expect(commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof)).rejects.toMatchObject({
        code: 'LIVE_DAILY_LIMIT_REACHED',
      });

      expect(send).not.toHaveBeenCalled();
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'LIVE_DAILY_LIMIT_REACHED',
      });
      await expect(liveWritePermitCount(fixture)).resolves.toBe(1);
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('rejects a foreign unresolved attempt anywhere in the company before sending', async () => {
    const fixture = await seed();
    const other = await prisma.transaction.create({
      data: {
        companyId: fixture.companyId,
        qboId: `other-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'Other generic supplier',
        amount: '-1.00',
        bankAccount: 'Generic source',
        revision: 0,
        rawData: { CurrencyRef: { value: 'XTS' } },
      },
    });
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: other.id,
        requestId: `foreign-${randomUUID()}`,
        operation: 'recategorize',
        status: 'PREPARED',
        expectedRevision: 0,
        expectedSyncToken: '1',
        requestHash: `foreign-hash-${randomUUID()}`,
        requestPayload: prepared(fixture),
        beforeSnapshot: beforeSnapshot(fixture),
      },
    });
    const snapshots = [beforeSnapshot(fixture), beforeSnapshot(fixture)];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      await expect(commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof)).rejects.toMatchObject({
        code: 'LIVE_AUTHORITY_DENIED',
      });
      expect(send).not.toHaveBeenCalled();
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'RETRYABLE' });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('serializes a foreign PREPARED creator before the live absence decision', async () => {
    const fixture = await seed();
    const other = await prisma.transaction.create({
      data: {
        companyId: fixture.companyId,
        qboId: `other-race-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'Other generic supplier',
        amount: '-1.00',
        bankAccount: 'Generic source',
        revision: 0,
        rawData: { CurrencyRef: { value: 'XTS' } },
      },
    });
    const foreignLocked = deferred<void>();
    const allowForeignInsert = deferred<void>();
    const foreignRequestId = `foreign-race-${randomUUID()}`;
    const foreign = second.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1, 880217))',
        fixture.companyId,
      );
      foreignLocked.resolve();
      await allowForeignInsert.promise;
      await tx.qboMutationAttempt.create({
        data: {
          transactionId: other.id,
          requestId: foreignRequestId,
          operation: 'recategorize',
          status: 'PREPARED',
          expectedRevision: 0,
          expectedSyncToken: '1',
          requestHash: `foreign-hash-${foreignRequestId}`,
          requestPayload: prepared(fixture),
          beforeSnapshot: beforeSnapshot(fixture),
        },
      });
    });
    await foreignLocked.promise;
    const snapshots = [
      beforeSnapshot(fixture),
      beforeSnapshot(fixture),
      verifiedSnapshot(fixture),
    ];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    let live: Promise<unknown> | undefined;
    try {
      live = commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(send).not.toHaveBeenCalled();

      allowForeignInsert.resolve();
      await foreign;
      await expect(live).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED' });
      expect(send).not.toHaveBeenCalled();
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'RETRYABLE' });
    } finally {
      allowForeignInsert.resolve();
      await Promise.allSettled([foreign, live ?? Promise.resolve()]);
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it.each([
    'live pause',
    'accepted provider binding change',
    'current provider binding change',
  ] as const)(
    'lets a committed %s beat a blocked COMMITTING transition with zero sends',
    async (revocation) => {
    const fixture = await seed();
    await createCheckpointRun(fixture);
    const originalJob = await prisma.agentJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    }) as unknown as ClaimedAgentJob;
    const finalProof = deferred<QboPurchaseSnapshot | null>();
    const finalProofStarted = deferred<void>();
    let reads = 0;
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => {
      reads += 1;
      if (reads === 1) return beforeSnapshot(fixture);
      finalProofStarted.resolve();
      return finalProof.promise;
    }, send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      const committing = commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);
      await finalProofStarted.promise;
      let releasePause!: () => void;
      const pauseGate = new Promise<void>((resolve) => {
        releasePause = resolve;
      });
      const pauseLocked = deferred<void>();
      const pause = second.$transaction(async (tx) => {
        if (revocation === 'live pause') {
          await tx.agentCompanyConfig.update({
            where: { companyId: fixture.companyId },
            data: { livePausedAt: new Date(), livePauseCode: 'GENERIC_PAUSE' },
          });
        } else if (revocation === 'accepted provider binding change') {
          await tx.agentCompanyConfig.update({
            where: { companyId: fixture.companyId },
            data: { liveAcceptedProviderBinding: 'binding-no-longer-accepted' },
          });
        } else {
          await tx.agentCompanyConfig.update({
            where: { companyId: fixture.companyId },
            data: { provider: 'openrouter' },
          });
        }
        pauseLocked.resolve();
        await pauseGate;
      });
      await pauseLocked.promise;
      finalProof.resolve(beforeSnapshot(fixture));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(send).not.toHaveBeenCalled();
      releasePause();
      await pause;
      await expect(committing).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED' });
      expect(send).not.toHaveBeenCalled();
      await finishProductionLiveRun(originalJob, (
        await prisma.agentRun.findFirstOrThrow({
          where: { jobId: fixture.jobId, attemptCount: 1 },
          select: { id: true },
        })
      ).id, {
        status: 'failed',
        errorCode: 'LIVE_AUTHORITY_DENIED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'RETRYABLE' });
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'retry',
        attemptCount: 1,
        lastErrorCode: 'LIVE_AUTHORITY_DENIED',
      });
      await expect(prisma.agentRun.findFirstOrThrow({
        where: { jobId: fixture.jobId, attemptCount: 1 },
      })).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'LIVE_AUTHORITY_DENIED',
      });
      await expect(prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
      })).resolves.toMatchObject({ status: 'PENDING', revision: 1 });

      await prisma.agentCompanyConfig.update({
        where: { companyId: fixture.companyId },
        data: revocation === 'live pause'
          ? { livePausedAt: null, livePauseCode: null }
          : revocation === 'accepted provider binding change'
            ? { liveAcceptedProviderBinding: fixture.proof.providerBinding }
            : { provider: 'custom' },
      });
      const claimed = await expireAndClaim(fixture);
      const recoverySnapshots = [beforeSnapshot(fixture), verifiedSnapshot(fixture)];
      const recoverySend = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
      factory.mockResolvedValue(client(
        fixture,
        async () => structuredClone(recoverySnapshots.shift() ?? null),
        recoverySend,
      ));
      await runProductionClaimedLiveJob(claimed, 'worker-recovery', recoveryModels());
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({ status: 'completed', attemptCount: 2 });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'VERIFIED' });
      expect(recoverySend).toHaveBeenCalledOnce();
    } finally {
      finalProof.resolve(beforeSnapshot(fixture));
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('treats COMMITTING as durable intent when the transition wins before pause', async () => {
    const fixture = await seed();
    const sendStarted = deferred<void>();
    const allowSend = deferred<void>();
    const snapshots = [beforeSnapshot(fixture), beforeSnapshot(fixture), verifiedSnapshot(fixture)];
    const send = vi.fn(async () => {
      sendStarted.resolve();
      await allowSend.promise;
      return { ok: true as const, newSyncToken: '8' };
    });
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      const committing = commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);
      await sendStarted.promise;
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'COMMITTING' });
      await second.agentCompanyConfig.update({
        where: { companyId: fixture.companyId },
        data: { livePausedAt: new Date(), livePauseCode: 'GENERIC_PAUSE' },
      });
      allowSend.resolve();
      await expect(committing).resolves.toMatchObject({ outcome: 'VERIFIED' });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      allowSend.resolve();
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('lets the manual kill switch win before the final send fence with zero sends', async () => {
    const fixture = await seed();
    await createCheckpointRun(fixture);
    const finalProof = deferred<QboPurchaseSnapshot | null>();
    const finalProofStarted = deferred<void>();
    let reads = 0;
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(
      client(fixture, async () => {
        reads += 1;
        if (reads === 1) return beforeSnapshot(fixture);
        finalProofStarted.resolve();
        return finalProof.promise;
      }, send),
    );
    try {
      const committing = commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);
      await finalProofStarted.promise;

      await pauseLiveCompany(
        fixture.companyId,
        'MANUAL_PAUSE',
        'Live mode is paused by a company administrator.',
      );
      finalProof.resolve(beforeSnapshot(fixture));

      await expect(committing).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED' });
      expect(send).not.toHaveBeenCalled();
      await expect(prisma.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        livePauseCode: 'MANUAL_PAUSE',
        livePauseMessage: 'Live mode is paused by a company administrator.',
      });
    } finally {
      finalProof.resolve(beforeSnapshot(fixture));
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('keeps an already accepted final send truthful when it wins the manual kill race', async () => {
    const fixture = await seed();
    const sendStarted = deferred<void>();
    const allowSend = deferred<void>();
    const snapshots = [
      beforeSnapshot(fixture),
      beforeSnapshot(fixture),
      verifiedSnapshot(fixture),
    ];
    const send = vi.fn(async () => {
      sendStarted.resolve();
      await allowSend.promise;
      return { ok: true as const, newSyncToken: '8' };
    });
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(
      client(fixture, async () => structuredClone(snapshots.shift() ?? null), send),
    );
    try {
      const committing = commitGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 1,
        requestId: fixture.jobId,
      }, fixture.context, fixture.proof);
      await sendStarted.promise;

      await pauseLiveCompany(
        fixture.companyId,
        'MANUAL_PAUSE',
        'Live mode is paused by a company administrator.',
      );
      allowSend.resolve();

      await expect(committing).resolves.toMatchObject({
        outcome: 'VERIFIED',
        status: 'POSTED',
      });
      expect(send).toHaveBeenCalledOnce();
      await expect(prisma.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId: fixture.companyId },
      })).resolves.toMatchObject({
        liveRequested: true,
        livePauseCode: 'MANUAL_PAUSE',
        livePauseMessage: 'Live mode is paused by a company administrator.',
      });
    } finally {
      allowSend.resolve();
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('rolls back staging when a live configuration pause wins before the fenced authority read', async () => {
      const fixture = await seed({ staged: false });
      const leaseLocked = deferred<void>();
      let releaseLease!: () => void;
      const leaseGate = new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
      const refresh = second.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT 1 FROM "QboEntityLease"
            WHERE "companyId" = $1 AND "qboType" = 'Purchase' AND "qboId" = $2
            FOR UPDATE`,
          fixture.companyId,
          fixture.context.entityKey.qboId,
        );
        await tx.agentCompanyConfig.update({
          where: { companyId: fixture.companyId },
          data: { livePausedAt: new Date(), livePauseCode: 'GENERIC_PAUSE' },
        });
        leaseLocked.resolve();
        await leaseGate;
      });
      await leaseLocked.promise;
      const staging = stageGuardedLiveCategorization({
        transactionId: fixture.transactionId,
        companyId: fixture.companyId,
        expectedRevision: 0,
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense-generic',
            taxCodeQboId: null,
            tagIds: [],
          }],
          tagIds: [],
        },
      }, fixture.context, fixture.proof);
      const stagingOutcome = staging.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseLease();
      await refresh;
      try {
        await expect(stagingOutcome).resolves.toMatchObject({
          status: 'rejected',
          error: { code: 'LIVE_AUTHORITY_DENIED' },
        });
        await expect(prisma.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
        })).resolves.toMatchObject({
          revision: 0,
          taxCalculation: null,
        });
        await expect(prisma.splitLine.count({
          where: { txnId: fixture.transactionId },
        })).resolves.toBe(0);
      } finally {
        releaseLease();
        await cleanup(fixture);
      }
  });

  it('serializes the real tax-cache replacement before live staging without deadlock or partial writes', async () => {
    const fixture = await seed({ staged: false });
    const tableLocked = deferred<void>();
    const releaseTable = deferred<void>();
    const blocker = third.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'LOCK TABLE "QboTaxRate" IN SHARE ROW EXCLUSIVE MODE',
      );
      tableLocked.resolve();
      await releaseTable.promise;
    });
    await tableLocked.promise;
    const refresh = refreshTaxReference(fixture.companyId, { force: true }, {
      db: second as unknown as TaxReferenceDb,
      now: () => new Date(Date.now() + 5_000),
      getClient: async () => ({
        getTaxProfile: vi.fn(async () => ({
          usingSalesTax: true,
          partnerTaxEnabled: false,
        })),
        listTaxRates: vi.fn(async () => [{
          qboId: 'rate-generic',
          name: 'Generic rate',
          description: null,
          active: true,
          rateValue: 5,
          sourceUpdatedAt: null,
        }]),
        listTaxCodes: vi.fn(async () => [{
          qboId: 'tax-generic',
          name: 'Generic tax',
          description: null,
          active: true,
          taxable: true,
          purchaseRates: [{
            taxRateQboId: 'rate-generic',
            taxTypeApplicable: 'TaxOnAmount',
          }],
          salesRates: [],
          sourceUpdatedAt: null,
        }]),
      }),
    });
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::integer AS "count"
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND "wait_event_type" = 'Lock'
            AND query LIKE '%QboTaxRate%'`,
      );
      expect(rows[0]?.count ?? 0).toBeGreaterThan(0);
    }, { timeout: 2_000, interval: 10 });
    const staging = stageGuardedLiveCategorization({
      transactionId: fixture.transactionId,
      companyId: fixture.companyId,
      expectedRevision: 0,
      proposal: {
        taxCalculation: 'NotApplicable',
        lines: [{
          grossCents: -1_000,
          categoryQboId: 'expense-generic',
          taxCodeQboId: null,
          tagIds: [],
        }],
        tagIds: [],
      },
    }, fixture.context, fixture.proof);
    const stagingOutcome = staging.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      releaseTable.resolve();
      await blocker;
      await expect(refresh).resolves.toMatchObject({ refreshed: true });
      await expect(stagingOutcome).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'LIVE_AUTHORITY_DENIED' },
      });
      await expect(prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
      })).resolves.toMatchObject({ revision: 0, taxCalculation: null });
      await expect(prisma.splitLine.count({
        where: { txnId: fixture.transactionId },
      })).resolves.toBe(0);
      await expect(prisma.qboTaxCode.findUniqueOrThrow({
        where: {
          companyId_qboId: {
            companyId: fixture.companyId,
            qboId: 'tax-generic',
          },
        },
      })).resolves.toMatchObject({ active: true });
    } finally {
      releaseTable.resolve();
      await Promise.allSettled([blocker, refresh, stagingOutcome]);
      await cleanup(fixture);
    }
  }, 10_000);

  it('reclaims an expired PREPARED request and resumes it without inference or a second send', async () => {
    const fixture = await seed();
    const nextTurn = vi.fn();
    const claimed = await seedExpiredRecovery(fixture, 'PREPARED');
    const models = recoveryModels(nextTurn);
    const snapshots = [beforeSnapshot(fixture), verifiedSnapshot(fixture)];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      await runProductionClaimedLiveJob(claimed!, 'worker-recovery', models);
      expect(nextTurn).not.toHaveBeenCalled();
      const recoveredJob = await prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      });
      const recoveredRuns = await prisma.agentRun.findMany({
        where: { jobId: fixture.jobId },
      });
      const recoveredAttempt = await prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      });
      expect(recoveredRuns.map((run) => ({
        attemptCount: run.attemptCount,
        status: run.status,
        errorCode: run.errorCode,
      }))).toEqual([
        { attemptCount: 1, status: 'failed', errorCode: 'AGENT_RUN_ABANDONED' },
        { attemptCount: 2, status: 'posted_verified', errorCode: null },
      ]);
      expect({
        sends: send.mock.calls.length,
        job: recoveredJob,
        runs: recoveredRuns,
        attempt: recoveredAttempt,
      }).toMatchObject({
        sends: 1,
        job: { status: 'completed', attemptCount: 2 },
        runs: expect.any(Array),
        attempt: { status: 'VERIFIED' },
      });
      expect(recoveredRuns).toHaveLength(2);
      await expect(prisma.agentRun.count({
        where: { jobId: fixture.jobId, status: 'running' },
      })).resolves.toBe(0);
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it.each(['COMMITTING'] as const)(
    'reclaims expired %s intent as reconciliation-required without inference or a send',
    async (status) => {
      const fixture = await seed();
      const claimed = await seedExpiredRecovery(fixture, status);
      const nextTurn = vi.fn();
      const models = recoveryModels(nextTurn);
      const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
      const qbo = client(fixture, async () => beforeSnapshot(fixture), send);
      const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
      try {
        await runProductionClaimedLiveJob(claimed, 'worker-recovery', models);
        expect(nextTurn).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'terminal',
          attemptCount: 2,
          lastErrorCode: 'LIVE_RECONCILIATION_REQUIRED',
        });
        await expect(prisma.agentRun.findFirstOrThrow({
          where: { jobId: fixture.jobId, attemptCount: 2 },
        })).resolves.toMatchObject({
          status: 'uncertain',
          errorCode: 'LIVE_RECONCILIATION_REQUIRED',
        });
        await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
          where: { requestId: fixture.jobId },
        })).resolves.toMatchObject({ status });
      } finally {
        factory.mockRestore();
        await cleanup(fixture);
      }
    },
  );

  it.each([
    ['UNCERTAIN', 'ERROR', 'terminal', 'uncertain'],
    ['VERIFIED', 'POSTED', 'completed', 'posted_verified'],
  ] as const)(
    'reclaims a real writeback %s/%s pair without inference or a second send',
    async (attemptStatus, transactionStatus, jobStatus, runStatus) => {
      const fixture = await seed();
      await createCheckpointRun(fixture);
      const snapshots = attemptStatus === 'VERIFIED'
        ? [beforeSnapshot(fixture), beforeSnapshot(fixture), verifiedSnapshot(fixture)]
        : [beforeSnapshot(fixture), beforeSnapshot(fixture)];
      const send = attemptStatus === 'VERIFIED'
        ? vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }))
        : vi.fn(async () => {
            throw new Error('provider response was lost');
          });
      const qbo = client(
        fixture,
        async () => structuredClone(snapshots.shift() ?? null),
        send,
      );
      const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
      try {
        const mutation = await commitGuardedLiveCategorization({
          transactionId: fixture.transactionId,
          companyId: fixture.companyId,
          expectedRevision: 1,
          requestId: fixture.jobId,
        }, fixture.context, fixture.proof);
        expect(mutation).toMatchObject({ outcome: attemptStatus });
        await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
          where: { requestId: fixture.jobId },
        })).resolves.toMatchObject({ status: attemptStatus });
        await expect(prisma.transaction.findUniqueOrThrow({
          where: { id: fixture.transactionId },
        })).resolves.toMatchObject({ status: transactionStatus });
        expect(send).toHaveBeenCalledOnce();

        factory.mockClear();
        const claimed = await expireAndClaim(fixture);
        const nextTurn = vi.fn();
        await runProductionClaimedLiveJob(
          claimed,
          'worker-recovery',
          recoveryModels(nextTurn),
        );

        expect(nextTurn).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledOnce();
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({ status: jobStatus, attemptCount: 2 });
        await expect(prisma.agentRun.findFirstOrThrow({
          where: { jobId: fixture.jobId, attemptCount: 2 },
        })).resolves.toMatchObject({ status: runStatus });
      } finally {
        factory.mockRestore();
        await cleanup(fixture);
      }
    },
  );

  it('reclaims an expired RETRYABLE request through the bounded same-request path', async () => {
    const fixture = await seed();
    const claimed = await seedExpiredRecovery(fixture, 'RETRYABLE');
    await createLiveWritePermit(fixture, fixture.jobId);
    const nextTurn = vi.fn();
    const models = recoveryModels(nextTurn);
    const snapshots = [beforeSnapshot(fixture), verifiedSnapshot(fixture)];
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => structuredClone(snapshots.shift() ?? null), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      await runProductionClaimedLiveJob(claimed, 'worker-recovery', models);
      expect(nextTurn).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      await expect(liveWritePermitCount(fixture)).resolves.toBe(1);
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({ status: 'completed', attemptCount: 2 });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({ status: 'VERIFIED' });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('claims exact RETRYABLE recovery after a real settings version change', async () => {
    const fixture = await seed();
    await createCheckpointRun(fixture);
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: fixture.transactionId,
        requestId: fixture.jobId,
        operation: 'recategorize',
        status: 'RETRYABLE',
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash: prepared(fixture).requestHash,
        requestPayload: prepared(fixture),
        beforeSnapshot: beforeSnapshot(fixture),
      },
    });
    await prisma.agentCompanyConfig.update({
      where: { companyId: fixture.companyId },
      data: { evidenceThreshold: 25 },
    });
    await updateShadowSettings(fixture.companyId, {
      decisionModel: 'decision-reconfigured',
    }, {
      db: prisma as unknown as AgentSettingsDb,
      getInstanceSettings: async () => ({
        suggestionProvider: 'custom',
        agentDecisionModel: 'decision-generic',
        agentVerifierModel: 'verifier-generic',
        aiEndpoint: 'https://generic.invalid/v1',
        aiApiKey: '',
        openrouterApiKey: '',
      }),
      withSerializableTransaction: (callback) => prisma.$transaction(
        (tx) => callback(tx as unknown as AgentSettingsDb),
      ),
    });
    const claimed = await expireAndClaim(fixture);
    const factory = vi.spyOn(qboFactory, 'forCompany');
    try {
      await expect(isClaimedLiveJobAuthorized(claimed)).resolves.toBe(true);
      await expect(runProductionClaimedLiveRecovery(
        claimed,
        'worker-recovery',
      )).resolves.toBe(true);
      expect(factory).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'retry',
        attemptCount: 2,
        lastErrorCode: 'LIVE_AUTHORITY_DENIED',
      });
      const exhausted = await expireAndClaim(fixture, 'worker-exhausted', 3);
      await expect(runProductionClaimedLiveRecovery(
        exhausted,
        'worker-exhausted',
      )).resolves.toBe(true);
      expect(factory).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'terminal',
        attemptCount: 3,
        lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('moves exact PREPARED recovery to bounded failure after a real disconnect', async () => {
    const fixture = await seed();
    await createCheckpointRun(fixture);
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: fixture.transactionId,
        requestId: fixture.jobId,
        operation: 'recategorize',
        status: 'PREPARED',
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash: prepared(fixture).requestHash,
        requestPayload: prepared(fixture),
        beforeSnapshot: beforeSnapshot(fixture),
      },
    });
    await disconnectCompanyWithLiveAuthority(fixture.companyId, {
      now: () => new Date(),
      withSerializableTransaction: (callback) => prisma.$transaction(callback),
    });
    const claimed = await expireAndClaim(fixture);
    const factory = vi.spyOn(qboFactory, 'forCompany');
    try {
      await expect(runProductionClaimedLiveRecovery(
        claimed,
        'worker-recovery',
      )).resolves.toBe(true);
      expect(factory).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'retry',
        attemptCount: 2,
        lastErrorCode: 'COMPANY_DISCONNECTED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'RETRYABLE',
        errorCode: 'COMPANY_DISCONNECTED',
      });

      const exhausted = await expireAndClaim(fixture, 'worker-exhausted', 3);
      await expect(runProductionClaimedLiveRecovery(
        exhausted,
        'worker-exhausted',
      )).resolves.toBe(true);
      expect(factory).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'terminal',
        attemptCount: 3,
        lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it('terminalizes an attempt-three RETRYABLE request without a send or retry claim', async () => {
    const fixture = await seed({ attemptCount: 2 });
    const claimed = await seedExpiredRecovery(fixture, 'RETRYABLE');
    const nextTurn = vi.fn();
    const send = vi.fn(async () => ({ ok: true as const, newSyncToken: '8' }));
    const qbo = client(fixture, async () => beforeSnapshot(fixture), send);
    const factory = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue(qbo);
    try {
      await runProductionClaimedLiveJob(
        claimed,
        'worker-recovery',
        recoveryModels(nextTurn),
      );

      expect(nextTurn).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'terminal',
        attemptCount: 3,
        lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.agentRun.findFirstOrThrow({
        where: { jobId: fixture.jobId, attemptCount: 3 },
      })).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transactionId },
      })).resolves.toMatchObject({ status: 'PENDING', revision: 1 });
      await expect(claimShadowJobs('worker-after-exhaustion', 1, {
        db: prisma as unknown as AgentJobDb,
      })).resolves.toEqual([]);
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it.each(['PREPARED', 'RETRYABLE'] as const)(
    'atomically fails an expired attempt-three %s request without leaving a mutation blocker',
    async (attemptStatus) => {
      const fixture = await seed({ attemptCount: 3 });
      await createCheckpointRun(fixture, 3);
      await prisma.qboMutationAttempt.create({
        data: {
          transactionId: fixture.transactionId,
          requestId: fixture.jobId,
          operation: 'recategorize',
          status: attemptStatus,
          expectedRevision: 1,
          expectedSyncToken: '7',
          requestHash: prepared(fixture).requestHash,
          requestPayload: prepared(fixture),
          beforeSnapshot: beforeSnapshot(fixture),
        },
      });
      try {
        await prisma.agentJob.update({
          where: { id: fixture.jobId },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        await prisma.qboEntityLease.deleteMany({
          where: { companyId: fixture.companyId },
        });

        await expect(claimShadowJobs('worker-after-expiry', 1, {
          db: prisma as unknown as AgentJobDb,
        })).resolves.toEqual([]);
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'terminal',
          attemptCount: 3,
          lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
        await expect(prisma.agentRun.findFirstOrThrow({
          where: { jobId: fixture.jobId, attemptCount: 3 },
        })).resolves.toMatchObject({
          status: 'failed',
          errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
        await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
          where: { requestId: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'FAILED',
          errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
        await expect(prisma.qboMutationAttempt.count({
          where: {
            transactionId: fixture.transactionId,
            status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] },
          },
        })).resolves.toBe(0);
        const readiness = await evaluateLiveGates(fixture.companyId);
        expect(readiness.gates.find(
          (gate) => gate.code === 'UNRESOLVED_MUTATION',
        )).toMatchObject({ ok: true });
      } finally {
        await cleanup(fixture);
      }
    },
  );

  it.each([
    ['COMMITTING', 'PENDING'],
    ['UNCERTAIN', 'ERROR'],
  ] as const)(
    'preserves an expired attempt-three %s request as a reconciliation barrier',
    async (attemptStatus, transactionStatus) => {
      const fixture = await seed({ attemptCount: 3 });
      await createCheckpointRun(fixture, 3);
      await prisma.transaction.update({
        where: { id: fixture.transactionId },
        data: { status: transactionStatus },
      });
      await prisma.qboMutationAttempt.create({
        data: {
          transactionId: fixture.transactionId,
          requestId: fixture.jobId,
          operation: 'recategorize',
          status: attemptStatus,
          expectedRevision: 1,
          expectedSyncToken: '7',
          requestHash: prepared(fixture).requestHash,
          requestPayload: prepared(fixture),
          beforeSnapshot: beforeSnapshot(fixture),
        },
      });
      try {
        await prisma.agentJob.update({
          where: { id: fixture.jobId },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        await prisma.qboEntityLease.deleteMany({
          where: { companyId: fixture.companyId },
        });

        await expect(claimShadowJobs('worker-after-barrier', 1, {
          db: prisma as unknown as AgentJobDb,
        })).resolves.toEqual([]);
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'terminal',
          lastErrorCode: 'AGENT_JOB_EXHAUSTED',
        });
        await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
          where: { requestId: fixture.jobId },
        })).resolves.toMatchObject({
          status: attemptStatus,
          errorCode: null,
        });
        const readiness = await evaluateLiveGates(fixture.companyId);
        expect(readiness.gates.find(
          (gate) => gate.code === 'UNRESOLVED_MUTATION',
        )).toMatchObject({ ok: false });
      } finally {
        await cleanup(fixture);
      }
    },
  );

  it('fails an attempt-three PREPARED recovery when pre-send authority is unavailable', async () => {
    const fixture = await seed({ attemptCount: 3 });
    await createCheckpointRun(fixture, 2);
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: fixture.transactionId,
        requestId: fixture.jobId,
        operation: 'recategorize',
        status: 'PREPARED',
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash: prepared(fixture).requestHash,
        requestPayload: prepared(fixture),
        beforeSnapshot: beforeSnapshot(fixture),
      },
    });
    await disconnectCompanyWithLiveAuthority(fixture.companyId, {
      now: () => new Date(),
      withSerializableTransaction: (callback) => prisma.$transaction(callback),
    });
    const factory = vi.spyOn(qboFactory, 'forCompany');
    try {
      await expect(runProductionClaimedLiveRecovery(
        {
          ...await prisma.agentJob.findUniqueOrThrow({
            where: { id: fixture.jobId },
          }),
          lastErrorCode: null,
        },
        fixture.context.workerId,
      )).resolves.toBe(true);

      expect(factory).not.toHaveBeenCalled();
      await expect(prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'terminal',
        attemptCount: 3,
        lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.agentRun.findFirstOrThrow({
        where: { jobId: fixture.jobId, attemptCount: 3 },
      })).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.jobId },
      })).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
      });
    } finally {
      factory.mockRestore();
      await cleanup(fixture);
    }
  });

  it.each(['client construction', 'final pre-send proof'] as const)(
    'fails an attempt-three PREPARED recovery after a %s failure with zero sends',
    async (failureStage) => {
      const fixture = await seed({ attemptCount: 3 });
      await createCheckpointRun(fixture, 2);
      await prisma.qboMutationAttempt.create({
        data: {
          transactionId: fixture.transactionId,
          requestId: fixture.jobId,
          operation: 'recategorize',
          status: 'PREPARED',
          expectedRevision: 1,
          expectedSyncToken: '7',
          requestHash: prepared(fixture).requestHash,
          requestPayload: prepared(fixture),
          beforeSnapshot: beforeSnapshot(fixture),
        },
      });
      const send = vi.fn();
      const qbo = client(
        fixture,
        failureStage === 'final pre-send proof'
          ? async () => {
              throw new Error('pre-send read unavailable');
            }
          : async () => beforeSnapshot(fixture),
        send,
      );
      const factory = vi.spyOn(qboFactory, 'forCompany');
      if (failureStage === 'client construction') {
        factory.mockRejectedValue(new Error('client unavailable'));
      } else {
        factory.mockResolvedValue(qbo);
      }
      try {
        await expect(runProductionClaimedLiveRecovery(
          {
            ...await prisma.agentJob.findUniqueOrThrow({
              where: { id: fixture.jobId },
            }),
            lastErrorCode: null,
          },
          fixture.context.workerId,
        )).resolves.toBe(true);

        expect(factory).toHaveBeenCalledOnce();
        expect(send).not.toHaveBeenCalled();
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'terminal',
          attemptCount: 3,
          lastErrorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
        await expect(prisma.agentRun.findFirstOrThrow({
          where: { jobId: fixture.jobId, attemptCount: 3 },
        })).resolves.toMatchObject({
          status: 'failed',
          errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
        await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
          where: { requestId: fixture.jobId },
        })).resolves.toMatchObject({
          status: 'FAILED',
          errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        });
      } finally {
        factory.mockRestore();
        await cleanup(fixture);
      }
    },
  );

  it.each([
    ['MODEL_HEALTH_UNAVAILABLE', 'failed', 'retry'],
    ['LIVE_VERIFIER_TIMEOUT', 'failed', 'retry'],
    ['LIVE_VERIFIER_UNAVAILABLE', 'failed', 'retry'],
    ['LIVE_VERIFIER_RESPONSE_INVALID', 'failed', 'terminal'],
    ['LIVE_VERIFIER_IDENTITY_MISMATCH', 'failed', 'terminal'],
    ['LIVE_VERIFICATION_INPUT_INVALID', 'failed', 'terminal'],
    ['VERIFIER_NOT_DISTINCT', 'failed', 'terminal'],
    ['AGENT_DISTINCT_REVIEW_REJECTED', 'abstain', 'completed'],
  ] as const)(
    'persists %s as run %s with a %s job lifecycle',
    async (errorCode, runStatus, jobStatus) => {
      const fixture = await seed();
      const run = await prisma.agentRun.create({
        data: {
          jobId: fixture.jobId,
          companyId: fixture.companyId,
          transactionId: fixture.transactionId,
          revision: 0,
          configVersion: 'config-generic',
          attemptCount: 1,
          status: 'running',
          snapshot: { transaction: { id: fixture.transactionId, revision: 0 } },
          decisionModel: 'decision-generic',
          verifierModel: 'verifier-generic',
          verifierKind: 'distinct_model',
          promptVersion: 'recat-agent-v1',
          schemaVersion: '1',
        },
      });
      const claimed = await prisma.agentJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      }) as unknown as ClaimedAgentJob;
      try {
        await finishProductionLiveRun(claimed, run.id, {
          status: runStatus,
          errorCode,
        });
        await expect(prisma.agentRun.findUniqueOrThrow({
          where: { id: run.id },
        })).resolves.toMatchObject({ status: runStatus, errorCode });
        await expect(prisma.agentJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })).resolves.toMatchObject({ status: jobStatus, lastErrorCode: errorCode });
      } finally {
        await cleanup(fixture);
      }
    },
  );
});
