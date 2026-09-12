import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import type {
  QboClient,
  QboPreparedWrite,
  QboPurchaseSnapshot,
} from '../../lib/qbo/types.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import {
  pauseLiveCompany,
  pauseLiveCompanyInTransaction,
} from './circuitBreaker.js';
import {
  reconcileMutationAttempt,
  type DurableWritebackDb,
  type DurableWritebackDeps,
} from '../writeback.js';
import {
  deferLiveReconciliation,
  hashCheckpoint,
  isLiveReconciliationOwnedRequest,
  listAllLiveReconciliationCandidates,
  listLiveReconciliationCandidates,
  loadLiveReconciliationBinding,
  loadLiveReconciliationOperation,
  loadLiveReconciliationRequest,
  reconcileLiveMutation,
  reconcileScheduledLiveMutation,
  type LiveReconciliationInput,
} from './liveReconciliation.js';

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

interface RecoveryFixture {
  readonly companyId: string;
  readonly transactionId: string;
  readonly requestId: string;
  readonly input: LiveReconciliationInput;
  readonly expected: QboPurchaseSnapshot;
  readonly before: QboPurchaseSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres('live breaker and reconciliation PostgreSQL composition', () => {
  let second: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(async () => {
    second = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    await prisma.company.deleteMany({
      where: {
        OR: [
          { realmId: { startsWith: 'breaker-' } },
          { realmId: { startsWith: 'recovery-' } },
        ],
      },
    });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await prisma.company.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    await second.$disconnect();
    vi.restoreAllMocks();
  });

  async function seedPausedCompany() {
    const suffix = randomUUID();
    const company = await prisma.company.create({
      data: {
        realmId: `breaker-${suffix}`,
        legalName: 'Generic breaker fixture',
        nickname: `generic-${suffix.slice(0, 8)}`,
        holdingAccountIds: ['holding-generic'],
        dryRun: false,
      },
    });
    companyIds.add(company.id);
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
        limits: {},
        configVersion: 'config-v1',
        liveRequested: true,
        liveAcceptedPolicyVersion: 'policy-v1',
        liveAcceptedConfigVersion: 'config-v1',
        liveAcceptedProviderBinding: 'binding-v1',
        liveEnabledAt: new Date(),
      },
    });
    return company.id;
  }

  async function seedRecovery(): Promise<RecoveryFixture> {
    const suffix = randomUUID();
    const requestId = randomUUID();
    const company = await prisma.company.create({
      data: {
        realmId: `recovery-${suffix}`,
        legalName: 'Generic recovery fixture',
        nickname: `generic-${suffix.slice(0, 8)}`,
        holdingAccountIds: ['holding-generic'],
        dryRun: false,
      },
    });
    companyIds.add(company.id);
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
        limits: {},
        configVersion: 'config-v1',
        liveRequested: true,
        liveAcceptedPolicyVersion: 'policy-v1',
        liveAcceptedConfigVersion: 'config-v1',
        liveAcceptedProviderBinding: 'binding-v1',
        liveEnabledAt: new Date(),
        livePausedAt: new Date(),
        livePauseCode: 'UNCERTAIN_MUTATION',
        livePauseMessage: 'Live mode is paused: A live mutation requires reconciliation.',
      },
    });
    await prisma.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: 'category-generic',
        name: 'Generic category',
        fullName: 'Generic category',
        classification: 'Expenses',
        accountType: 'Expense',
        active: true,
      },
    });
    const transaction = await prisma.transaction.create({
      data: {
        companyId: company.id,
        qboId: `purchase-${suffix}`,
        qboType: 'Purchase',
        qboSyncToken: '7',
        date: new Date('2026-07-29T00:00:00.000Z'),
        payee: 'Generic counterparty',
        amount: '-10.00',
        bankAccount: 'Generic payment account',
        status: 'ERROR',
        revision: 1,
        taxCalculation: 'NotApplicable',
        splitLines: {
          create: [{
            idx: 0,
            amount: '-10.00',
            category: 'Generic category',
            categoryQboId: 'category-generic',
          }],
        },
      },
    });
    const before: QboPurchaseSnapshot = {
      qboId: transaction.qboId,
      syncToken: '7',
      totalCents: -1000,
      accountQboId: 'payment-generic',
      date: '2026-07-29',
      direction: 'purchase',
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      lines: [{
        id: 'line-before',
        amountCents: -1000,
        description: null,
        accountQboId: 'holding-generic',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: null,
        taxAmountCents: null,
        taxInclusiveCents: null,
      }],
    };
    const target = {
      id: null,
      amountCents: -1000,
      description: 'Generic categorization',
      accountQboId: 'category-generic',
      customerQboId: null,
      classQboId: null,
      taxCodeQboId: null,
      taxAmountCents: null,
      taxInclusiveCents: null,
    };
    const expected: QboPurchaseSnapshot = {
      ...before,
      syncToken: '8',
      lines: [{ ...target, id: 'line-after' }],
    };
    const body: QboPreparedWrite['body'] = {
      Id: transaction.qboId,
      SyncToken: '7',
      TxnDate: '2026-07-29',
      TotalAmt: 10,
      AccountRef: { value: 'payment-generic' },
      GlobalTaxCalculation: 'NotApplicable',
      Line: [{
        Amount: 10,
        Description: 'Generic categorization',
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'category-generic' },
        },
      }],
    };
    const requestHash = hashPreparedWriteBody(body);
    const prepared: QboPreparedWrite = {
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: transaction.qboId,
      requestId,
      requestHash,
      body,
      before,
      expected: {
        qboId: transaction.qboId,
        totalCents: -1000,
        accountQboId: 'payment-generic',
        date: '2026-07-29',
        direction: 'purchase',
        globalTaxCalculation: 'NotApplicable',
        totalTaxCents: 0,
        targetLines: [target],
        untouchedLineHashes: [],
      },
    };
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId,
        operation: 'recategorize',
        status: 'UNCERTAIN',
        expectedRevision: 1,
        expectedSyncToken: '7',
        requestHash,
        requestPayload: prepared,
        beforeSnapshot: before,
        errorCode: 'QBO_WRITE_UNCERTAIN',
        errorMessage: 'QuickBooks mutation requires reconciliation.',
      },
    });
    await prisma.agentJob.create({
      data: {
        id: requestId,
        companyId: company.id,
        transactionId: transaction.id,
        revision: 0,
        configVersion: 'config-v1',
        status: 'terminal',
        dueAt: new Date(),
        attemptCount: 1,
        lastErrorCode: 'LIVE_RECONCILIATION_REQUIRED',
      },
    });
    const decision = {
      kind: 'proposal' as const,
      taxCalculation: 'NotApplicable' as const,
      lines: [{
        grossCents: -1_000,
        categoryQboId: 'category-generic',
        taxCodeQboId: null,
        memo: 'Generic categorization',
        tagIds: [],
      }],
      tagIds: [],
      confidence: 0.99,
      evidence: [{ kind: 'category' as const, qboId: 'category-generic' }],
      rationale: 'Generic evidence.',
    };
    const checkpoint = {
      version: 1,
      result: {
        status: 'verified',
        decision,
        snapshotRevision: 0,
        decisionProvider: 'custom',
        decisionModel: 'decision-generic',
        promptVersion: 'agent-model-v1',
        schemaVersion: 1,
        durationMs: 10,
        turns: 1,
        toolCalls: 0,
        verificationMode: 'distinct_model',
        diagnosticCode: 'AGENT_RUN_VERIFIED',
      },
      verification: {
        ok: true,
        code: 'AGENT_DECISION_VERIFIED',
        message: 'Verified.',
        decision,
        liveIdentityProof: {
          version: 1,
          providerBinding: 'binding-v1',
          decisionIdentity: 'custom:resolved/decision',
          verifierIdentity: 'custom:resolved/verifier',
        },
      },
      proof: { providerBinding: 'binding-v1', taxAuthorityDigest: 'a'.repeat(64) },
    };
    await prisma.agentRun.create({
      data: {
        jobId: requestId,
        companyId: company.id,
        transactionId: transaction.id,
        revision: 0,
        configVersion: 'config-v1',
        attemptCount: 1,
        status: 'uncertain',
        snapshot: {},
        decision,
        verification: { liveCheckpoint: checkpoint, liveOutcome: 'uncertain' },
        decisionModel: 'decision-generic',
        verifierModel: 'verifier-generic',
        verifierKind: 'distinct_model',
        promptVersion: 'agent-model-v1',
        schemaVersion: '1',
        errorCode: 'LIVE_RECONCILIATION_REQUIRED',
        completedAt: new Date(),
      },
    });
    const input: LiveReconciliationInput = {
      companyId: company.id,
      transactionId: transaction.id,
      qboType: 'Purchase',
      qboId: transaction.qboId,
      requestId,
      operation: 'recategorize',
      expectedRevision: 1,
      configVersion: 'config-v1',
      requestHash,
      checkpointHash: hashCheckpoint(checkpoint),
    };
    return {
      companyId: company.id,
      transactionId: transaction.id,
      requestId,
      input,
      expected,
      before,
    };
  }

  it('serializes pause against the final send fence and persists the strongest reason across restart', async () => {
    const companyId = await seedPausedCompany();
    const release = deferred<void>();
    const locked = deferred<void>();
    const fence = prisma.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      const config = await tx.agentCompanyConfig.findUniqueOrThrow({
        where: { companyId },
      });
      expect(config.livePausedAt).toBeNull();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pausing = pauseLiveCompany(
      companyId,
      'UNCERTAIN_MUTATION',
      'Live mode is paused: A live mutation requires reconciliation.',
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await second.agentCompanyConfig.findUnique({
      where: { companyId },
      select: { livePausedAt: true },
    })).toEqual({ livePausedAt: null });
    release.resolve();
    await Promise.all([fence, pausing]);

    await pauseLiveCompany(
      companyId,
      'TAX_REFERENCE_STALE',
      'Live mode is paused: Tax references are stale.',
    );
    const restarted = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    const persisted = await restarted.agentCompanyConfig.findUniqueOrThrow({
      where: { companyId },
    });
    await restarted.$disconnect();
    expect(persisted).toMatchObject({
      liveRequested: true,
      livePauseCode: 'UNCERTAIN_MUTATION',
    });
    expect(persisted.livePausedAt).toBeInstanceOf(Date);
  });

  it('converges duplicate reconciliation with one fresh QBO read and atomic run/job truth', async () => {
    const fixture = await seedRecovery();
    const fetchPreparedSnapshot = vi.fn(async () => fixture.expected);
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot,
    } as unknown as QboClient);
    const candidates = await listLiveReconciliationCandidates(fixture.companyId);
    expect(candidates).toEqual([fixture.input]);

    const results = await Promise.all([
      reconcileScheduledLiveMutation(fixture.input),
      reconcileScheduledLiveMutation(fixture.input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'IN_PROGRESS',
      'VERIFIED',
    ]);
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
    const [attempt, transaction, job, run, config] = await Promise.all([
      prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: fixture.requestId } }),
      prisma.transaction.findUniqueOrThrow({ where: { id: fixture.transactionId } }),
      prisma.agentJob.findUniqueOrThrow({ where: { id: fixture.requestId } }),
      prisma.agentRun.findFirstOrThrow({ where: { jobId: fixture.requestId } }),
      prisma.agentCompanyConfig.findUniqueOrThrow({ where: { companyId: fixture.companyId } }),
    ]);
    expect(attempt.status).toBe('VERIFIED');
    expect(transaction.status).toBe('POSTED');
    expect(job.status).toBe('completed');
    expect(run.status).toBe('posted_verified');
    expect(config.livePauseCode).toBe('UNCERTAIN_MUTATION');

    await expect(reconcileScheduledLiveMutation(fixture.input)).resolves.toMatchObject({
      outcome: 'VERIFIED',
      status: 'POSTED',
    });
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
  });

  it('reconciles an old generation by its original durable identity without creating another attempt', async () => {
    const fixture = await seedRecovery();
    const original = await prisma.qboMutationAttempt.findUniqueOrThrow({
      where: { requestId: fixture.requestId },
    });
    await prisma.agentCompanyConfig.update({
      where: { companyId: fixture.companyId },
      data: { schedulingGeneration: { increment: 1 } },
    });
    const fetchPreparedSnapshot = vi.fn(async () => fixture.expected);
    const recategorize = vi.fn();
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot, recategorize,
    } as unknown as QboClient);

    await expect(listLiveReconciliationCandidates(fixture.companyId)).resolves.toEqual([fixture.input]);
    await expect(reconcileScheduledLiveMutation(fixture.input)).resolves.toMatchObject({
      outcome: 'VERIFIED', status: 'POSTED',
    });
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
    expect(recategorize).not.toHaveBeenCalled();
    const attempts = await prisma.qboMutationAttempt.findMany({
      where: { transactionId: fixture.transactionId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: original.id, requestId: original.requestId, requestHash: original.requestHash,
      requestPayload: original.requestPayload, status: 'VERIFIED',
    });
    await expect(prisma.agentJob.findUniqueOrThrow({
      where: { id: fixture.requestId },
    })).resolves.toMatchObject({ schedulingGeneration: 0, status: 'completed', attemptCount: 1 });
  });

  it('discovers connected durable recovery after mutable live mode is turned off', async () => {
    const fixture = await seedRecovery();
    await prisma.agentCompanyConfig.update({
      where: { companyId: fixture.companyId },
      data: { mode: 'off', liveRequested: false },
    });

    const candidates = await listAllLiveReconciliationCandidates();

    expect(candidates).toContainEqual(fixture.input);
  });

  it('does not discover or reload a malformed versioned live checkpoint', async () => {
    const fixture = await seedRecovery();
    await prisma.agentRun.updateMany({
      where: { jobId: fixture.requestId },
      data: {
        verification: {
          liveCheckpoint: { version: 2 },
          liveOutcome: 'uncertain',
        },
      },
    });

    await expect(
      listLiveReconciliationCandidates(fixture.companyId),
    ).resolves.toEqual([]);
    await expect(loadLiveReconciliationRequest(
      fixture.requestId,
      fixture.companyId,
      fixture.transactionId,
    )).resolves.toBeNull();
    await expect(deferLiveReconciliation(fixture.input)).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
  });

  it('rejects a malformed checkpoint binding before any QBO access', async () => {
    const fixture = await seedRecovery();
    const malformed = { version: 1 };
    await prisma.agentRun.updateMany({
      where: { jobId: fixture.requestId },
      data: {
        verification: {
          liveCheckpoint: malformed,
          liveOutcome: 'uncertain',
        },
      },
    });
    const fetchPreparedSnapshot = vi.fn(async () => fixture.expected);
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot,
    } as unknown as QboClient);

    await expect(reconcileScheduledLiveMutation({
      ...fixture.input,
      checkpointHash: hashCheckpoint(malformed),
    })).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    expect(fetchPreparedSnapshot).not.toHaveBeenCalled();
  });

  it('rejects cross-revision reconciliation in every loader before QBO access', async () => {
    const fixture = await seedRecovery();
    const existingRun = await prisma.agentRun.findFirstOrThrow({
      where: { jobId: fixture.requestId },
    });
    const verification = existingRun.verification as {
      liveCheckpoint: {
        result: Record<string, unknown>;
      };
      liveOutcome: string;
    };
    const crossRevisionCheckpoint = {
      ...verification.liveCheckpoint,
      result: {
        ...verification.liveCheckpoint.result,
        snapshotRevision: 1,
      },
    };
    await prisma.$transaction([
      prisma.agentJob.update({
        where: { id: fixture.requestId },
        data: {
          revision: 1,
          dueAt: new Date(Date.now() - 60_000),
        },
      }),
      prisma.agentRun.update({
        where: { id: existingRun.id },
        data: {
          revision: 1,
          verification: {
            liveCheckpoint: crossRevisionCheckpoint,
            liveOutcome: 'uncertain',
          },
        },
      }),
    ]);
    const crossRevisionInput = {
      ...fixture.input,
      checkpointHash: hashCheckpoint(crossRevisionCheckpoint),
    };
    const forCompany = vi.spyOn(qboFactory, 'forCompany');

    await expect(
      listLiveReconciliationCandidates(fixture.companyId),
    ).resolves.toEqual([]);
    await expect(
      loadLiveReconciliationBinding(crossRevisionInput),
    ).resolves.toBeNull();
    await expect(loadLiveReconciliationRequest(
      fixture.requestId,
      fixture.companyId,
      fixture.transactionId,
    )).resolves.toBeNull();
    await expect(loadLiveReconciliationOperation(
      existingRun.id,
      fixture.companyId,
    )).resolves.toBeNull();
    await expect(deferLiveReconciliation(crossRevisionInput)).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    await expect(
      reconcileScheduledLiveMutation(crossRevisionInput),
    ).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    expect(forCompany).not.toHaveBeenCalled();
  });

  it('rechecks the checkpoint before finalization when durable state changes after QBO readback', async () => {
    const fixture = await seedRecovery();
    const fetchPreparedSnapshot = vi.fn(async () => {
      await prisma.agentRun.updateMany({
        where: { jobId: fixture.requestId },
        data: {
          verification: {
            liveCheckpoint: { version: 2 },
            liveOutcome: 'uncertain',
          },
        },
      });
      return fixture.expected;
    });
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot,
    } as unknown as QboClient);

    await expect(
      reconcileScheduledLiveMutation(fixture.input),
    ).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
    await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
      where: { requestId: fixture.requestId },
    })).resolves.toMatchObject({ status: 'UNCERTAIN' });
  });

  it('discovers an exact terminal COMMITTING/PENDING fallback barrier', async () => {
    const fixture = await seedRecovery();
    await prisma.$transaction([
      prisma.qboMutationAttempt.update({
        where: { requestId: fixture.requestId },
        data: { status: 'COMMITTING', errorCode: null, errorMessage: null },
      }),
      prisma.transaction.update({
        where: { id: fixture.transactionId },
        data: { status: 'PENDING', errorCode: null, errorMessage: null },
      }),
    ]);

    await expect(
      listLiveReconciliationCandidates(fixture.companyId),
    ).resolves.toContainEqual(
      fixture.input,
    );
  });

  it('retains live ownership when exact reconciliation state drifts', async () => {
    const fixture = await seedRecovery();
    await prisma.transaction.update({
      where: { id: fixture.transactionId },
      data: { revision: fixture.input.expectedRevision + 1 },
    });

    await expect(isLiveReconciliationOwnedRequest(
      fixture.requestId,
      fixture.companyId,
      fixture.transactionId,
    )).resolves.toBe(true);
    await expect(loadLiveReconciliationRequest(
      fixture.requestId,
      fixture.companyId,
      fixture.transactionId,
    )).resolves.toBeNull();
  });

  it('durably backs off only automatic recovery while preserving explicit recheck', async () => {
    const deferredFixture = await seedRecovery();
    const readyFixture = await seedRecovery();

    await deferLiveReconciliation(deferredFixture.input);

    expect(
      await listLiveReconciliationCandidates(deferredFixture.companyId),
    ).not.toContainEqual(deferredFixture.input);
    expect(
      await listLiveReconciliationCandidates(readyFixture.companyId),
    ).toContainEqual(readyFixture.input);
    await expect(loadLiveReconciliationRequest(
      deferredFixture.requestId,
      deferredFixture.companyId,
      deferredFixture.transactionId,
    )).resolves.toEqual(deferredFixture.input);
  });

  it('keeps stale readback uncertain when a higher-revision attempt shares its timestamp', async () => {
    const fixture = await seedRecovery();
    const original = await prisma.qboMutationAttempt.findUniqueOrThrow({
      where: { requestId: fixture.requestId },
      select: { createdAt: true },
    });
    const readStarted = deferred<void>();
    const releaseRead = deferred<QboPurchaseSnapshot>();
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot: vi.fn(async () => {
        readStarted.resolve();
        return releaseRead.promise;
      }),
    } as unknown as QboClient);

    const reconciling = reconcileScheduledLiveMutation(fixture.input);
    await readStarted.promise;
    await prisma.qboMutationAttempt.create({
      data: {
        transactionId: fixture.transactionId,
        requestId: randomUUID(),
        operation: 'recategorize',
        status: 'FAILED',
        expectedRevision: 2,
        expectedSyncToken: '8',
        requestHash: createHash('sha256').update('newer').digest('hex'),
        requestPayload: {},
        beforeSnapshot: {},
        errorCode: 'LIVE_MUTATION_RETRY_EXHAUSTED',
        createdAt: original.createdAt,
      },
    });
    releaseRead.resolve(fixture.expected);

    await expect(reconciling).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    const [attempt, transaction, job] = await Promise.all([
      prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: fixture.requestId } }),
      prisma.transaction.findUniqueOrThrow({ where: { id: fixture.transactionId } }),
      prisma.agentJob.findUniqueOrThrow({ where: { id: fixture.requestId } }),
    ]);
    expect(attempt.status).toBe('UNCERTAIN');
    expect(transaction.status).toBe('ERROR');
    expect(job.status).toBe('terminal');
  });

  it('does not finalize a readback after current transaction revision drifts', async () => {
    const fixture = await seedRecovery();
    const readStarted = deferred<void>();
    const releaseRead = deferred<QboPurchaseSnapshot>();
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot: vi.fn(async () => {
        readStarted.resolve();
        return releaseRead.promise;
      }),
    } as unknown as QboClient);

    const reconciling = reconcileScheduledLiveMutation(fixture.input);
    await readStarted.promise;
    await prisma.transaction.update({
      where: { id: fixture.transactionId },
      data: { revision: 2 },
    });
    releaseRead.resolve(fixture.expected);

    await expect(reconciling).rejects.toMatchObject({
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
      where: { requestId: fixture.requestId },
    })).resolves.toMatchObject({ status: 'UNCERTAIN' });
    await expect(prisma.transaction.findUniqueOrThrow({
      where: { id: fixture.transactionId },
    })).resolves.toMatchObject({ revision: 2, status: 'ERROR' });
  });

  it('row-locks finalization against a non-locking sync mirror update', async () => {
    const fixture = await seedRecovery();
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot: vi.fn(async () => fixture.expected),
    } as unknown as QboClient);
    const attemptLocked = deferred<void>();
    const releaseAttempt = deferred<void>();
    const blocker = second.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT 1
           FROM "QboMutationAttempt"
          WHERE "requestId" = $1
          FOR UPDATE`,
        fixture.requestId,
      );
      attemptLocked.resolve();
      await releaseAttempt.promise;
    });
    await attemptLocked.promise;

    const reconciling = reconcileScheduledLiveMutation(fixture.input);
    const deadline = Date.now() + 5_000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const rows = await prisma.$queryRawUnsafe<{ blocked: boolean }[]>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND cardinality(pg_blocking_pids(pid)) > 0
              AND query LIKE '%QboMutationAttempt%'
         ) AS blocked`,
      );
      blocked = rows[0]?.blocked === true;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);

    const syncing = prisma.transaction.update({
      where: { id: fixture.transactionId },
      data: { qboSyncToken: 'sync-newer-token' },
    });
    const syncFinishedBeforeFinalization = await Promise.race([
      syncing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(syncFinishedBeforeFinalization).toBe(false);
    releaseAttempt.resolve();
    await blocker;

    await expect(reconciling).resolves.toMatchObject({ outcome: 'VERIFIED' });
    await syncing;
    await expect(prisma.transaction.findUniqueOrThrow({
      where: { id: fixture.transactionId },
    })).resolves.toMatchObject({
      qboSyncToken: 'sync-newer-token',
      status: 'POSTED',
    });
    await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
      where: { requestId: fixture.requestId },
    })).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('persists a safe mismatch code and stronger pause after one inconclusive read', async () => {
    const fixture = await seedRecovery();
    const fetchPreparedSnapshot = vi.fn()
      .mockResolvedValueOnce({
        ...fixture.expected,
        totalCents: -999,
      })
      .mockResolvedValueOnce(fixture.expected);
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      fetchPreparedSnapshot,
    } as unknown as QboClient);

    await expect(reconcileScheduledLiveMutation(fixture.input)).resolves.toMatchObject({
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_READBACK_MISMATCH' },
    });
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
    const [attempt, run, job, config] = await Promise.all([
      prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: fixture.requestId } }),
      prisma.agentRun.findFirstOrThrow({ where: { jobId: fixture.requestId } }),
      prisma.agentJob.findUniqueOrThrow({ where: { id: fixture.requestId } }),
      prisma.agentCompanyConfig.findUniqueOrThrow({ where: { companyId: fixture.companyId } }),
    ]);
    expect(attempt).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'QBO_READBACK_MISMATCH',
    });
    expect(run).toMatchObject({
      status: 'uncertain',
      errorCode: 'QBO_READBACK_MISMATCH',
    });
    expect(job).toMatchObject({
      status: 'terminal',
      lastErrorCode: 'QBO_READBACK_MISMATCH',
    });
    expect(config.livePauseCode).toBe('READBACK_MISMATCH');
    expect(await listAllLiveReconciliationCandidates()).not.toContainEqual(
      fixture.input,
    );

    const categorizer = await prisma.user.create({
      data: {
        email: `generic-categorizer-${randomUUID()}@example.test`,
        name: 'Generic categorizer',
        memberships: {
          create: {
            companyId: fixture.companyId,
            role: 'categorizer',
          },
        },
      },
    });
    await expect(reconcileLiveMutation(fixture.input, {
      actor: { id: categorizer.id, label: 'Generic categorizer' },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();

    const admin = await prisma.user.create({
      data: {
        email: `generic-admin-${randomUUID()}@example.test`,
        name: 'Generic administrator',
        isInstanceAdmin: true,
      },
    });
    await expect(reconcileLiveMutation(fixture.input, {
      actor: { id: admin.id, label: 'Generic administrator' },
    })).resolves.toMatchObject({
      outcome: 'VERIFIED',
      status: 'POSTED',
    });
    expect(fetchPreparedSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each(['instance', 'membership'] as const)(
    'rechecks revoked %s-admin authority inside the fenced reconciliation transaction',
    async (authority) => {
      const fixture = await seedRecovery();
      const admin = authority === 'instance'
        ? await prisma.user.create({
            data: {
              email: `generic-revoked-instance-${randomUUID()}@example.test`,
              name: 'Generic revoked instance administrator',
              isInstanceAdmin: true,
            },
          })
        : await prisma.user.create({
            data: {
              email: `generic-revoked-member-${randomUUID()}@example.test`,
              name: 'Generic revoked company administrator',
              memberships: {
                create: {
                  companyId: fixture.companyId,
                  role: 'admin',
                },
              },
            },
          });
      const readStarted = deferred<void>();
      const releaseRead = deferred<QboPurchaseSnapshot>();
      const fetchPreparedSnapshot = vi.fn(async () => {
        readStarted.resolve();
        return releaseRead.promise;
      });
      const forCompany = vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
        fetchPreparedSnapshot,
      } as unknown as QboClient);

      const reconciling = reconcileLiveMutation(fixture.input, {
        actor: { id: admin.id, label: 'Generic revoked administrator' },
      });
      await readStarted.promise;
      if (authority === 'instance') {
        await prisma.user.update({
          where: { id: admin.id },
          data: { isInstanceAdmin: false },
        });
      } else {
        await prisma.membership.update({
          where: {
            userId_companyId: {
              userId: admin.id,
              companyId: fixture.companyId,
            },
          },
          data: { role: 'categorizer' },
        });
      }
      releaseRead.resolve(fixture.expected);

      await expect(reconciling).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fetchPreparedSnapshot).toHaveBeenCalledOnce();
      await expect(prisma.qboMutationAttempt.findUniqueOrThrow({
        where: { requestId: fixture.requestId },
      })).resolves.toMatchObject({ status: 'UNCERTAIN' });
      forCompany.mockRestore();
    },
  );

  it('atomically persists pause when the primary uncertainty transaction fails and fallback wins', async () => {
    const fixture = await seedRecovery();
    await prisma.agentCompanyConfig.update({
      where: { companyId: fixture.companyId },
      data: {
        livePausedAt: null,
        livePauseCode: null,
        livePauseMessage: null,
      },
    });
    let failPrimary = true;
    const db = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async <T>(
          callback: (tx: DurableWritebackDb) => Promise<T>,
        ): Promise<T> => {
          if (failPrimary) {
            failPrimary = false;
            throw new Error('forced primary uncertainty rollback');
          }
          return prisma.$transaction((tx) =>
            callback(tx as unknown as DurableWritebackDb));
        };
      },
    }) as unknown as DurableWritebackDb;
    const deps: DurableWritebackDeps = {
      db,
      getClient: async () => ({
        fetchPreparedSnapshot: async () => ({
          ...fixture.expected,
          totalCents: -999,
        }),
      }) as unknown as QboClient,
      audit: vi.fn(async () => undefined),
      authorize: async () => true,
      envDryRun: false,
      lease: async (_key, _owner, callback) => callback(),
      renewLease: async () => undefined,
      invocationId: () => 'reconcile-fallback-generic',
      now: () => new Date(),
      onUncertainMutation: async (tx, outcome) => {
        await pauseLiveCompanyInTransaction(
          tx as never,
          outcome.transaction.companyId,
          'READBACK_MISMATCH',
          'Live mode is paused: A live mutation readback did not match durable intent.',
          new Date(),
        );
      },
    };

    await expect(reconcileMutationAttempt({
      requestId: fixture.requestId,
      actor: { id: null, label: 'system' },
    }, deps)).resolves.toMatchObject({
      outcome: 'UNCERTAIN',
      error: { code: 'QBO_READBACK_MISMATCH' },
    });

    const [attempt, config] = await Promise.all([
      prisma.qboMutationAttempt.findUniqueOrThrow({ where: { requestId: fixture.requestId } }),
      prisma.agentCompanyConfig.findUniqueOrThrow({ where: { companyId: fixture.companyId } }),
    ]);
    expect(attempt.errorCode).toBe('QBO_READBACK_MISMATCH');
    expect(config.livePauseCode).toBe('READBACK_MISMATCH');
  });

  it('preserves unknown authority pauses except when a possible write is more severe', async () => {
    const companyId = await seedPausedCompany();
    await prisma.agentCompanyConfig.update({
      where: { companyId },
      data: {
        livePausedAt: new Date(),
        livePauseCode: 'QBO_DISCONNECTED',
        livePauseMessage: 'Live mode is paused: QuickBooks is disconnected.',
      },
    });
    await prisma.$transaction(async (tx) => {
      await lockCompanyMutationScope(tx, companyId);
      await pauseLiveCompanyInTransaction(
        tx,
        companyId,
        'UNCERTAIN_MUTATION',
        'Live mode is paused: A live mutation requires reconciliation.',
        new Date(),
      );
    });
    await Promise.all([
      pauseLiveCompany(
        companyId,
        'TAX_REFERENCE_STALE',
        'Live mode is paused: Tax references are stale.',
      ),
      pauseLiveCompany(
        companyId,
        'QBO_ERROR_BURST',
        'Live mode is paused: QuickBooks live operation health degraded.',
      ),
    ]);
    expect(await prisma.agentCompanyConfig.findUniqueOrThrow({
      where: { companyId },
      select: { livePauseCode: true },
    })).toEqual({ livePauseCode: 'UNCERTAIN_MUTATION' });
  });
});
