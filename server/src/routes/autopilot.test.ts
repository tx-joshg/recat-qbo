import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000020';
const RUN_ID = '00000000-0000-4000-8000-000000000030';
const FOREIGN_RUN_ID = '00000000-0000-4000-8000-000000000031';
const LIVE_POLICY_VERSION = 'recat-live-purchase-v1';

const mocks = vi.hoisted(() => ({
  agentJobCount: vi.fn(),
  agentJobFindFirst: vi.fn(),
  agentJobUpdateMany: vi.fn(),
  cancelQueuedAgentJobs: vi.fn(),
  agentRunFindFirst: vi.fn(),
  agentRunFindMany: vi.fn(),
  qboMutationAttemptFindMany: vi.fn(),
  companyFindUnique: vi.fn(),
  enableLiveModeForAdmin: vi.fn(),
  evaluateLiveGates: vi.fn(),
  getAgentSettings: vi.fn(),
  getShadowEvidenceSummary: vi.fn(),
  loadLiveReconciliationOperation: vi.fn(),
  membershipFindUnique: vi.fn(),
  pauseLiveModeManually: vi.fn(),
  prismaQueryRawUnsafe: vi.fn(),
  prismaTransaction: vi.fn(),
  reconcileLiveMutation: vi.fn(),
  sessionFindUnique: vi.fn(),
  updateShadowSettings: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    agentJob: {
      count: mocks.agentJobCount,
      findFirst: mocks.agentJobFindFirst,
      updateMany: mocks.agentJobUpdateMany,
    },
    agentRun: {
      findFirst: mocks.agentRunFindFirst,
      findMany: mocks.agentRunFindMany,
    },
    qboMutationAttempt: {
      findMany: mocks.qboMutationAttemptFindMany,
    },
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
    $queryRawUnsafe: mocks.prismaQueryRawUnsafe,
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock('../services/agent/settings.js', () => ({
  AgentSettingError: class AgentSettingError extends Error {
    readonly code = 'AGENT_SETTING_INVALID';
  },
  getAgentSettings: mocks.getAgentSettings,
  updateShadowSettings: mocks.updateShadowSettings,
}));

vi.mock('../services/agent/evaluation.js', () => ({
  getShadowEvidenceSummary: mocks.getShadowEvidenceSummary,
  getShadowEvidenceSummaryInTransaction: mocks.getShadowEvidenceSummary,
}));

vi.mock('../services/agent/liveGates.js', () => ({
  LIVE_POLICY_VERSION: 'recat-live-purchase-v1',
  LiveGateError: class LiveGateError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  enableLiveModeForAdmin: mocks.enableLiveModeForAdmin,
  evaluateLiveGates: mocks.evaluateLiveGates,
}));

vi.mock('../services/agent/jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/agent/jobs.js')>(),
  cancelQueuedAgentJobs: mocks.cancelQueuedAgentJobs,
}));

vi.mock('../services/agent/circuitBreaker.js', () => ({
  ManualLivePauseAuthorizationError: class ManualLivePauseAuthorizationError extends Error {
    readonly code = 'FORBIDDEN';
  },
  pauseLiveModeManually: mocks.pauseLiveModeManually,
}));

vi.mock('../services/agent/liveReconciliation.js', () => ({
  LiveReconciliationAuthorizationError: class LiveReconciliationAuthorizationError extends Error {
    readonly code = 'FORBIDDEN';
  },
  LiveReconciliationError: class LiveReconciliationError extends Error {
    readonly code = 'LIVE_RECONCILIATION_BINDING_MISMATCH';
  },
  loadLiveReconciliationOperation: mocks.loadLiveReconciliationOperation,
  reconcileLiveMutation: mocks.reconcileLiveMutation,
}));

vi.mock('../services/instanceSettings.js', () => ({
  getInstanceSettings: vi.fn(),
}));

import { autopilotRouter } from './autopilot.js';

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/companies/:companyId/autopilot', autopilotRouter);
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=autopilot-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'admin';
let disconnected = false;

const overviewTransactionClient = {
  agentJob: {
    count: (...args: unknown[]) => mocks.agentJobCount(...args),
    findFirst: (...args: unknown[]) => mocks.agentJobFindFirst(...args),
  },
  $queryRawUnsafe: (...args: unknown[]) => mocks.prismaQueryRawUnsafe(...args),
};

const CONFIG_VERSION = 'a'.repeat(64);

const liveReadiness = {
  policyVersion: LIVE_POLICY_VERSION,
  gates: [
    { code: 'SHADOW_MODE_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'EVIDENCE_INSUFFICIENT', ok: true, message: 'Ready.' },
    { code: 'SHADOW_AGREEMENT_INSUFFICIENT', ok: true, message: 'Ready.' },
    { code: 'SHADOW_ABSTENTION_EXCESSIVE', ok: true, message: 'Ready.' },
    { code: 'SHADOW_ERROR_RATE_EXCESSIVE', ok: true, message: 'Ready.' },
    { code: 'VERIFIER_NOT_DISTINCT', ok: true, message: 'Ready.' },
    { code: 'PROVIDER_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'TAX_REFERENCE_STALE', ok: true, message: 'Ready.' },
    { code: 'QBO_DISCONNECTED', ok: true, message: 'Ready.' },
    { code: 'WRITEBACK_DISABLED', ok: true, message: 'Ready.' },
    { code: 'UNRESOLVED_MUTATION', ok: true, message: 'Ready.' },
    { code: 'WORKER_UNHEALTHY', ok: true, message: 'Ready.' },
    { code: 'LIVE_POLICY_NOT_ACCEPTED', ok: true, message: 'Ready.' },
  ],
  evidence: {
    completedSince: '2026-06-29T10:00:00.000Z',
    completedThrough: '2026-07-29T10:00:00.000Z',
    eligibleRuns: 50,
    threshold: 50,
    minimumAgreement: 0.98,
    maximumAbstentionRate: 0.25,
    maximumErrorRate: 0.05,
  },
  models: {
    provider: 'custom',
    decisionAlias: 'decision-model',
    verifierAlias: 'verifier-model',
    decisionIdentity: 'provider/decision-v1',
    verifierIdentity: 'provider/verifier-v1',
  },
  policy: {
    supportedEntities: ['Purchase'],
    minimumConfidence: 0.9,
    policyAccepted: true,
    configurationAccepted: true,
    modelBindingAccepted: true,
  },
  state: {
    liveRequested: true,
    enabled: true,
    paused: false,
    pauseCode: null,
    pauseMessage: null,
  },
  lastAction: {
    outcome: 'posted_verified',
    at: '2026-07-29T10:00:00.250Z',
  },
};

const settings = {
  mode: 'shadow',
  provider: 'custom',
  decisionModel: 'decision-model',
  verifierModel: 'verifier-model',
  scheduleMinutes: 10,
  companyConcurrency: 1,
  evidenceThreshold: 50,
  dailyLiveWriteLimit: 100,
  limits: {
    maxToolCalls: 8,
    maxTurns: 4,
    maxContextBytes: 65_536,
    maxResponseBytes: 32_768,
    timeoutMs: 30_000,
  },
  configVersion: CONFIG_VERSION,
};

const run = {
  id: RUN_ID,
  jobId: 'job-live-request',
  companyId: COMPANY_ID,
  transactionId: 'PRIVATE_TRANSACTION_ID',
  revision: 7,
  configVersion: CONFIG_VERSION,
  attemptCount: 1,
  status: 'verified',
  snapshot: { payee: 'PRIVATE_PAYEE_SENTINEL', providerKey: 'PRIVATE_KEY_SENTINEL' },
  decision: {
    kind: 'proposal',
    taxCalculation: 'TaxInclusive',
    confidence: 0.92,
    rationale: 'PRIVATE_RATIONALE_SENTINEL',
    evidence: [
      { kind: 'rule', id: '00000000-0000-4000-8000-000000000050' },
      { kind: 'category', qboId: 'PRIVATE_QBO_ACCOUNT_SENTINEL' },
    ],
    tagIds: ['00000000-0000-4000-8000-000000000060'],
    lines: [{
      grossCents: -12_345,
      categoryQboId: 'PRIVATE_QBO_ACCOUNT_SENTINEL',
      taxCodeQboId: 'PRIVATE_QBO_TAX_SENTINEL',
      memo: 'PRIVATE_MEMO_SENTINEL',
      tagIds: [],
    }],
  },
  verification: {
    diagnosticCode: 'AGENT_RUN_VERIFIED',
    verificationMode: 'distinct_model',
    turns: 2,
    toolCalls: 3,
    evidenceEvaluation: {
      state: 'eligible',
      outcomeRequestId: 'PRIVATE_REQUEST_ID_SENTINEL',
      inputRevision: 7,
      agreement: true,
    },
    rawProviderResponse: 'PRIVATE_PROVIDER_RESPONSE_SENTINEL',
  },
  decisionModel: 'decision-model',
  verifierModel: 'verifier-model',
  verifierKind: 'distinct_model',
  promptVersion: 'agent-model-v1',
  schemaVersion: '1',
  durationMs: 250,
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    raw: 'PRIVATE_USAGE_SENTINEL',
  },
  errorCode: null,
  createdAt: new Date('2026-07-29T10:00:00.000Z'),
  completedAt: new Date('2026-07-29T10:00:00.250Z'),
};

function validLiveCheckpoint(): Record<string, unknown> {
  return {
    version: 1,
    result: {
      status: 'verified',
      decision: run.decision,
      snapshotRevision: run.revision,
      decisionProvider: 'custom',
      decisionModel: run.decisionModel,
      promptVersion: run.promptVersion,
      schemaVersion: 1,
      durationMs: 250,
      turns: 2,
      toolCalls: 3,
      verificationMode: 'distinct_model',
      diagnosticCode: 'AGENT_RUN_VERIFIED',
    },
    verification: {
      ok: true,
      code: 'AGENT_DECISION_VERIFIED',
      message: 'Verified.',
      decision: run.decision,
      liveIdentityProof: {
        version: 1,
        providerBinding: 'binding-v1',
        decisionIdentity: 'custom:resolved/decision',
        verifierIdentity: 'custom:resolved/verifier',
      },
    },
    proof: {
      providerBinding: 'binding-v1',
      taxAuthorityDigest: 'd'.repeat(64),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
  disconnected = false;
  mocks.prismaTransaction.mockImplementation(
    async (callback: (tx: typeof overviewTransactionClient) => Promise<unknown>) =>
      callback(overviewTransactionClient),
  );
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'autopilot-route-user',
      email: 'generic-admin@example.test',
      name: 'Generic administrator',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.companyFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      legalName: 'Generic Company',
      disconnectedAt: disconnected ? new Date('2026-07-29T08:00:00.000Z') : null,
    }),
  );
  mocks.membershipFindUnique.mockImplementation(
    async ({ where }: { where: { userId_companyId: { companyId: string } } }) =>
      where.userId_companyId.companyId === COMPANY_ID ? { role } : null,
  );
  mocks.getAgentSettings.mockResolvedValue(settings);
  mocks.updateShadowSettings.mockResolvedValue(settings);
  mocks.evaluateLiveGates.mockResolvedValue(liveReadiness);
  mocks.enableLiveModeForAdmin.mockResolvedValue(liveReadiness);
  mocks.pauseLiveModeManually.mockResolvedValue({
    liveRequested: true,
    enabled: false,
    paused: true,
    pauseCode: 'MANUAL_PAUSE',
    pauseMessage: 'Live mode is paused by a company administrator.',
  });
  mocks.prismaQueryRawUnsafe.mockResolvedValue([]);
  mocks.loadLiveReconciliationOperation.mockResolvedValue({
    companyId: COMPANY_ID,
    transactionId: '00000000-0000-4000-8000-000000000040',
    qboType: 'Purchase',
    qboId: 'private-qbo-id',
    requestId: '00000000-0000-4000-8000-000000000041',
    operation: 'recategorize',
    expectedRevision: 7,
    configVersion: CONFIG_VERSION,
    requestHash: 'b'.repeat(64),
    checkpointHash: 'c'.repeat(64),
  });
  mocks.reconcileLiveMutation.mockResolvedValue({
    transactionId: '00000000-0000-4000-8000-000000000040',
    requestId: '00000000-0000-4000-8000-000000000041',
    ok: false,
    status: 'POSTING',
    outcome: 'IN_PROGRESS',
    error: {
      code: 'MUTATION_IN_PROGRESS',
      message: 'The exact reconciliation is already in progress.',
    },
  });
  mocks.getShadowEvidenceSummary.mockResolvedValue({
    eligibleRuns: 12,
    agreements: 10,
    disagreements: 2,
    threshold: 50,
    thresholdMet: false,
  });
  mocks.agentJobCount.mockImplementation(
    async ({ where }: { where: { status?: string | { in: string[] } } }) => {
      if (where.status === 'running') return 1;
      if (where.status === 'queued') return 3;
      if (typeof where.status === 'object' && where.status.in.includes('queued')) return 3;
      if (where.status === 'retry') return 1;
      if (where.status === 'terminal') return 2;
      if (where.status === 'cancelled') return 4;
      return 0;
    },
  );
  mocks.agentJobFindFirst.mockImplementation(
    async ({ where }: { where: { status: string | { in: string[] } } }) =>
      where.status === 'running'
        ? { leaseExpiresAt: new Date('2026-07-29T10:01:00.000Z') }
        : { dueAt: new Date('2026-07-29T09:00:00.000Z') },
  );
  mocks.agentJobUpdateMany.mockResolvedValue({ count: 4 });
  mocks.cancelQueuedAgentJobs.mockResolvedValue({ cancelled: 4, kept: 1 });
  mocks.agentRunFindMany.mockResolvedValue([
    run,
    {
      ...run,
      id: '00000000-0000-4000-8000-000000000031',
      createdAt: new Date('2026-07-29T09:59:00.000Z'),
      completedAt: new Date('2026-07-29T09:59:00.250Z'),
    },
  ]);
  mocks.qboMutationAttemptFindMany.mockResolvedValue([{
    requestId: 'job-live-request',
    transactionId: 'PRIVATE_TRANSACTION_ID',
    operation: 'recategorize',
    status: 'VERIFIED',
    responseSnapshot: { accepted: true },
    verification: { outcome: 'VERIFIED', status: 'POSTED' },
  }]);
  mocks.agentRunFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; companyId: string } }) =>
      where.id === RUN_ID && where.companyId === COMPANY_ID ? run : null,
  );
});

describe('autopilot route authorization and settings', () => {
  it('lets company admins configure shadow mode and categorizers inspect runs', async () => {
    const app = testApp();
    const patch = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ evidenceThreshold: 75 });

    role = 'categorizer';
    const runs = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);

    role = 'viewer';
    const viewerRuns = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);

    expect(patch.status).toBe(200);
    expect(runs.status).toBe(200);
    expect(viewerRuns.status).toBe(200);
    expect(mocks.updateShadowSettings).toHaveBeenCalledWith(
      COMPANY_ID,
      { evidenceThreshold: 75 },
    );
  });

  it('rejects non-admin updates and unknown, out-of-range, or mistyped settings', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'shadow' });

    role = 'admin';
    const invalidBodies = [
      { evidenceThreshold: 24 },
      { companyConcurrency: '1' },
      { scheduleMinutes: 1, unknown: true },
      { limits: { timeoutMs: 30_000, providerKey: 'PRIVATE_KEY_SENTINEL' } },
    ];
    const invalid = await Promise.all(invalidBodies.map((body) =>
      request(app)
        .patch(`/api/companies/${COMPANY_ID}/autopilot`)
        .set(sessionHeaders)
        .send(body)));

    expect(forbidden.status).toBe(403);
    expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(mocks.updateShadowSettings).not.toHaveBeenCalled();
  });

  it('rejects enabling shadow after disconnect while still allowing an administrator to turn it off', async () => {
    disconnected = true;
    const app = testApp();
    const enabled = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'shadow' });
    const disabled = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'off' });

    expect(enabled.status).toBe(409);
    expect(enabled.body).toEqual({
      error: 'Shadow autopilot cannot be enabled for a disconnected company.',
      code: 'COMPANY_DISCONNECTED',
    });
    expect(disabled.status).toBe(200);
    expect(mocks.updateShadowSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateShadowSettings).toHaveBeenCalledWith(COMPANY_ID, { mode: 'off' });
  });

  it('fails company isolation closed for both list and detail reads', async () => {
    role = 'categorizer';
    const app = testApp();
    const otherCompany = await request(app)
      .get(`/api/companies/${OTHER_COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);
    const foreignRun = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${FOREIGN_RUN_ID}`)
      .set(sessionHeaders);

    expect(otherCompany.status).toBe(403);
    expect(foreignRun.status).toBe(404);
    expect(mocks.agentRunFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: FOREIGN_RUN_ID, companyId: COMPANY_ID },
    }));
  });
});

describe('autopilot safe operational responses', () => {
  it('returns bounded health and evidence without lease ownership or raw content', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      settings,
      liveWrites: { used: 0, limit: 100 },
      evidence: { eligibleRuns: 12, threshold: 50, thresholdMet: false },
      queue: {
        queued: 3,
        running: 1,
        retrying: 1,
        terminal: 2,
        cancelled: 4,
        earliestDueAt: '2026-07-29T09:00:00.000Z',
        earliestLeaseExpiryAt: '2026-07-29T10:01:00.000Z',
      },
    });
    expect(serialized).not.toMatch(/lockOwner|leaseExpiresAt|snapshot|providerKey/i);
  });

  it('builds settings, evidence, and queue health from one repeatable-read snapshot client', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(mocks.prismaTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'RepeatableRead' },
    );
    expect(mocks.getAgentSettings).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ db: overviewTransactionClient }),
    );
    expect(mocks.getShadowEvidenceSummary).toHaveBeenCalledWith(
      COMPANY_ID,
      overviewTransactionClient,
    );
  });

  it('projects proposals, evaluation, models, usage, and timing without raw accounting content', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: RUN_ID,
      status: 'verified',
      outcome: 'shadow_verified',
      operationId: null,
      attemptCount: 1,
      configVersion: CONFIG_VERSION,
      proposal: {
        kind: 'proposal',
        taxCalculation: 'TaxInclusive',
        confidence: 0.92,
        lineCount: 1,
        evidenceKinds: ['category', 'rule'],
      },
      verification: {
        diagnosticCode: 'AGENT_RUN_VERIFIED',
        verifierKind: 'distinct_model',
        evidence: { state: 'eligible', agreement: true },
      },
      models: {
        decision: 'decision-model',
        verifier: 'verifier-model',
        promptVersion: 'agent-model-v1',
        schemaVersion: '1',
      },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      timing: {
        durationMs: 250,
        createdAt: '2026-07-29T10:00:00.000Z',
        completedAt: '2026-07-29T10:00:00.250Z',
      },
      errorCode: null,
    });
    expect(serialized).not.toMatch(
      /PRIVATE_|transactionId|revision|snapshot|rationale|memo|qbo|rawProvider|outcomeRequestId/i,
    );
  });

  it('reports the verification mode that actually ran instead of only the configured reviewer pair', async () => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      verifierKind: 'distinct_model',
      verification: {
        diagnosticCode: 'AGENT_RUN_REVIEW_TAX_INVALID',
        verificationMode: 'deterministic',
      },
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.verification.verifierKind).toBe('deterministic');
  });

  it.each([
    ['running without verification', 'running', null],
    ['abandoned without verification mode', 'failed', { diagnosticCode: 'AGENT_RUN_ABANDONED' }],
    ['corrupt verification mode', 'failed', { verificationMode: 'future_mode' }],
  ])('reports verification unavailable for %s', async (_label, status, verification) => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status,
      verification,
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.verification.verifierKind).toBe('unavailable');
  });

  it('fails closed on corrupt run versions while preserving bounded model aliases', async () => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      configVersion: 'not-a-hash',
      promptVersion: 'future-or-corrupt-prompt',
      schemaVersion: '999',
      decisionModel: 'bounded-decision-alias',
      verifierModel: 'bounded-verifier-alias',
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configVersion: 'unavailable',
      models: {
        decision: 'bounded-decision-alias',
        verifier: 'bounded-verifier-alias',
        promptVersion: 'unavailable',
        schemaVersion: 'unavailable',
      },
    });
  });

  it('uses bounded opaque cursor pagination and rejects malformed limits', async () => {
    role = 'categorizer';
    const app = testApp();
    const first = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=1`)
      .set(sessionHeaders);
    const invalid = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=51`)
      .set(sessionHeaders);

    expect(first.status).toBe(200);
    expect(first.body.runs).toHaveLength(1);
    expect(typeof first.body.nextCursor).toBe('string');
    expect(first.body.nextCursor).not.toContain(RUN_ID);
    expect(invalid.status).toBe(400);

    mocks.agentRunFindMany.mockResolvedValue([]);
    const next = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(sessionHeaders);
    expect(next.status).toBe(200);
    expect(mocks.agentRunFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: COMPANY_ID }),
      take: 2,
    }));
  });

  it('cancels queued work through the guarded job service for admins only', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/cancel-queued`)
      .set(sessionHeaders);

    role = 'admin';
    const cancelled = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/cancel-queued`)
      .set(sessionHeaders);

    expect(forbidden.status).toBe(403);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: 4, kept: 1 });
    expect(mocks.cancelQueuedAgentJobs).toHaveBeenCalledTimes(1);
    expect(mocks.cancelQueuedAgentJobs).toHaveBeenCalledWith(COMPANY_ID);
    expect(mocks.agentJobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.agentRunFindMany).not.toHaveBeenCalled();
  });
});

describe('guarded live controls and truthful history', () => {
  it('preserves every actual durable run status and projects a separate truthful outcome', async () => {
    role = 'viewer';
    const cases = [
      ['running', null, 'in_progress'],
      [
        'verified',
        {
          diagnosticCode: 'AGENT_RUN_VERIFIED',
          verificationMode: 'distinct_model',
        },
        'shadow_verified',
      ],
      ['abstain', null, 'abstained'],
      ['failed', null, 'failed_before_write'],
      [
        'posted_verified',
        {
          verificationMode: 'distinct_model',
          liveOutcome: 'posted_verified',
          mutation: {
            requestId: 'job-live-request',
            outcome: 'VERIFIED',
            status: 'POSTED',
            errorCode: null,
          },
        },
        'posted_verified',
      ],
      ['dry_run', {
        liveOutcome: 'dry_run',
        mutation: { requestId: 'job-live-request', outcome: 'DRY_RUN', status: 'DRY_RUN' },
      }, 'dry_run'],
      ['unchanged', {
        liveOutcome: 'reconciled_unchanged',
        mutation: { requestId: 'job-live-request', outcome: 'UNCHANGED', status: 'PENDING' },
      }, 'reconciled_unchanged'],
      ['uncertain', {
        liveOutcome: 'uncertain',
        mutation: { requestId: 'job-live-request', outcome: 'UNCERTAIN', status: 'ERROR' },
      }, 'possible_write_uncertain'],
      ['retryable', {
        liveOutcome: 'retryable',
        mutation: { requestId: 'job-live-request', outcome: 'RETRYABLE', status: 'ERROR' },
      }, 'retrying'],
      ['future_corrupt', { liveOutcome: 'posted_verified', mutation: { outcome: 'VERIFIED', status: 'POSTED' } }, 'unavailable'],
    ] as const;

    for (const [status, verification, outcome] of cases) {
      const attempt = status === 'dry_run'
        ? {
            requestId: 'job-live-request',
            transactionId: 'PRIVATE_TRANSACTION_ID',
            operation: 'recategorize',
            status: 'DRY_RUN',
            expectedRevision: 8,
            responseSnapshot: null,
            verification: { outcome: 'DRY_RUN', status: 'DRY_RUN' },
          }
        : status === 'unchanged'
          ? {
              requestId: 'job-live-request',
              transactionId: 'PRIVATE_TRANSACTION_ID',
              operation: 'recategorize',
              status: 'UNCHANGED',
              expectedRevision: 8,
              responseSnapshot: { unchanged: true },
              verification: { outcome: 'UNCHANGED', status: 'PENDING' },
            }
          : status === 'uncertain'
            ? {
                requestId: 'job-live-request',
                transactionId: 'PRIVATE_TRANSACTION_ID',
                operation: 'recategorize',
                status: 'UNCERTAIN',
                expectedRevision: 8,
                responseSnapshot: null,
                verification: null,
              }
            : status === 'retryable'
              ? {
                  requestId: 'job-live-request',
                  transactionId: 'PRIVATE_TRANSACTION_ID',
                  operation: 'recategorize',
                  status: 'RETRYABLE',
                  expectedRevision: 8,
                  responseSnapshot: null,
                  verification: null,
                }
              : {
                  requestId: 'job-live-request',
                  transactionId: 'PRIVATE_TRANSACTION_ID',
                  operation: 'recategorize',
                  status: 'VERIFIED',
                  expectedRevision: 8,
                  responseSnapshot: { accepted: true },
                  verification: { outcome: 'VERIFIED', status: 'POSTED' },
                };
      mocks.qboMutationAttemptFindMany.mockResolvedValueOnce([attempt]);
      mocks.agentRunFindFirst.mockResolvedValueOnce({
        ...run,
        status,
        verification,
      });
      const response = await request(testApp())
        .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
        .set(sessionHeaders);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(
        status === 'future_corrupt' ? 'unavailable' : status,
      );
      expect(response.body.outcome).toBe(outcome);
    }
  });

  it.each([
    [
      'same-model readback',
      {
        verificationMode: 'same_model',
        liveOutcome: 'posted_verified',
        mutation: { outcome: 'VERIFIED', status: 'POSTED' },
      },
    ],
    [
      'corrupt mutation outcome',
      {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: { outcome: 'UNCERTAIN', status: 'POSTED' },
      },
    ],
    [
      'non-final mutation status',
      {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: { outcome: 'VERIFIED', status: 'POSTING' },
      },
    ],
  ])('requires durable verified POST and readback evidence before reporting posted success: %s', async (
    _case,
    verification,
  ) => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'posted_verified',
      verification,
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('posted_verified');
    expect(response.body.outcome).toBe('unavailable');
    expect(JSON.stringify(response.body)).not.toMatch(/posted successfully/i);
  });

  it('never projects posted success from AgentRun JSON without the exact canonical mutation attempt', async () => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      jobId: 'job-live-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('posted_verified');
    expect(response.body.outcome).toBe('unavailable');
    expect(JSON.stringify(response.body)).not.toMatch(/requestId|transactionId|qbo|hash|checkpoint/i);
  });

  it('projects reverted from an exact later verified restore without changing the original run status', async () => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([
      {
        requestId: 'job-live-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '8' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:00:00.100Z'),
      },
      {
        requestId: 'restore-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '9' },
        verification: { outcome: 'VERIFIED', status: 'REVERTED' },
        createdAt: new Date('2026-07-29T10:05:00.000Z'),
        updatedAt: new Date('2026-07-29T10:06:00.000Z'),
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('posted_verified');
    expect(response.body.outcome).toBe('reverted');
  });

  it('rejects a restore whose internally consistent proof belongs to a different run revision', async () => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 9,
          invalidationReason: 'reverted',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([
      {
        requestId: 'job-live-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 9,
        responseSnapshot: { syncToken: '9' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:00:00.100Z'),
      },
      {
        requestId: 'restore-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 9,
        responseSnapshot: { syncToken: '10' },
        verification: { outcome: 'VERIFIED', status: 'REVERTED' },
        createdAt: new Date('2026-07-29T10:05:00.000Z'),
        updatedAt: new Date('2026-07-29T10:06:00.000Z'),
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('posted_verified');
    expect(response.body.outcome).toBe('unavailable');
  });

  it.each([
    [
      'unrelated',
      'different-restore-request',
      new Date('2026-07-29T10:05:00.000Z'),
    ],
    [
      'stale',
      'restore-request',
      new Date('2026-07-29T09:55:00.000Z'),
    ],
  ])('does not attach an %s restore to the original live run', async (
    _case,
    restoreRequestId,
    restoreCreatedAt,
  ) => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([
      {
        requestId: 'job-live-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '8' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:00:00.100Z'),
      },
      {
        requestId: restoreRequestId,
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '9' },
        verification: { outcome: 'VERIFIED', status: 'REVERTED' },
        createdAt: restoreCreatedAt,
        updatedAt: new Date('2026-07-29T10:06:00.000Z'),
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('posted_verified');
    expect(response.body.outcome).toBe('unavailable');
  });

  it.each([
    ['dry_run', {
      liveOutcome: 'dry_run',
      mutation: { requestId: 'job-live-request', outcome: 'DRY_RUN', status: 'DRY_RUN' },
    }],
    ['unchanged', {
      liveOutcome: 'reconciled_unchanged',
      mutation: { requestId: 'job-live-request', outcome: 'UNCHANGED', status: 'PENDING' },
    }],
    ['uncertain', {
      liveOutcome: 'uncertain',
      liveCheckpoint: { version: 1 },
      mutation: { requestId: 'job-live-request', outcome: 'UNCERTAIN', status: 'ERROR' },
    }],
    ['retryable', {
      liveOutcome: 'retryable',
      mutation: { requestId: 'job-live-request', outcome: 'RETRYABLE', status: 'ERROR' },
    }],
  ])('fails live %s projection closed without its exact canonical attempt', async (
    status,
    verification,
  ) => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status,
      errorCode: status === 'uncertain' ? 'LIVE_RECONCILIATION_REQUIRED' : run.errorCode,
      verification,
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('unavailable');
    if (status === 'uncertain') expect(response.body.operationId).toBeNull();
  });

  it('emits an operation capability only for a server-issued run UUID', async () => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      id: 'not-a-server-run-uuid',
      status: 'uncertain',
      errorCode: 'LIVE_RECONCILIATION_REQUIRED',
      verification: {
        liveCheckpoint: { version: 1 },
      },
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.operationId).toBeNull();
  });

  it('emits an operation capability for a fully bound versioned live checkpoint', async () => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'uncertain',
      errorCode: 'LIVE_RECONCILIATION_REQUIRED',
      verification: {
        liveOutcome: 'uncertain',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'UNCERTAIN',
          status: 'ERROR',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([{
      requestId: 'job-live-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      operation: 'recategorize',
      status: 'UNCERTAIN',
      expectedRevision: 8,
      responseSnapshot: null,
      verification: null,
      createdAt: new Date('2026-07-29T10:00:00.100Z'),
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.operationId).toBe(RUN_ID);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['malformed', 'not-an-object'],
    ['version-invalid', { ...validLiveCheckpoint(), version: 2 }],
    ['shape-invalid', { version: 1 }],
  ])('rejects a %s live checkpoint before emitting an operation capability', async (
    _case,
    checkpoint,
  ) => {
    role = 'viewer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status: 'uncertain',
      errorCode: 'LIVE_RECONCILIATION_REQUIRED',
      verification: {
        liveOutcome: 'uncertain',
        ...(checkpoint === undefined ? {} : { liveCheckpoint: checkpoint }),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'UNCERTAIN',
          status: 'ERROR',
        },
      },
    });
    mocks.qboMutationAttemptFindMany.mockResolvedValue([{
      requestId: 'job-live-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      operation: 'recategorize',
      status: 'UNCERTAIN',
      expectedRevision: 8,
      responseSnapshot: null,
      verification: null,
      createdAt: new Date('2026-07-29T10:00:00.100Z'),
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.operationId).toBeNull();
  });

  it('lets every company role read bounded fail-closed readiness without authority or secrets', async () => {
    const app = testApp();
    for (const nextRole of ['viewer', 'categorizer', 'admin'] as const) {
      role = nextRole;
      const response = await request(app)
        .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
        .set(sessionHeaders);
      const serialized = JSON.stringify(response.body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(liveReadiness);
      expect(serialized).not.toMatch(
        /private-qbo-id|requestHash|checkpointHash|providerBinding|accessToken|refreshToken|prompt|snapshot|payload/i,
      );
    }
  });

  it('selects lastAction only from a canonically bound actual live action', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    mocks.agentRunFindMany.mockResolvedValue([{
      ...run,
      status: 'failed',
      verification: { diagnosticCode: 'AGENT_RUN_PROVIDER_FAILURE' },
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toBeNull();
  });

  it('uses the exact later restore time for a canonically reverted last action', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    mocks.agentRunFindMany.mockResolvedValue([{
      ...run,
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    }]);
    mocks.qboMutationAttemptFindMany.mockResolvedValue([
      {
        requestId: 'job-live-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '8' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:00:00.100Z'),
      },
      {
        requestId: 'restore-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '9' },
        verification: { outcome: 'VERIFIED', status: 'REVERTED' },
        createdAt: new Date('2026-07-29T10:05:00.000Z'),
        updatedAt: new Date('2026-07-29T10:06:00.000Z'),
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toEqual({
      outcome: 'reverted',
      at: '2026-07-29T10:06:00.000Z',
    });
  });

  it('orders live actions by their canonical effective timestamp after proof validation', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    const recentPostedRun = {
      ...run,
      id: '00000000-0000-4000-8000-000000000032',
      jobId: 'job-recent-live-request',
      transactionId: 'PRIVATE_RECENT_TRANSACTION_ID',
      status: 'posted_verified',
      completedAt: new Date('2026-07-29T10:10:00.000Z'),
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-recent-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
      },
    };
    const revertedRun = {
      ...run,
      status: 'posted_verified',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    };
    mocks.agentRunFindMany.mockResolvedValue([recentPostedRun, revertedRun]);
    mocks.qboMutationAttemptFindMany.mockResolvedValue([
      {
        requestId: 'job-recent-live-request',
        transactionId: 'PRIVATE_RECENT_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '8' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:09:59.000Z'),
        updatedAt: new Date('2026-07-29T10:10:00.000Z'),
      },
      {
        requestId: 'job-live-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '8' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
        createdAt: new Date('2026-07-29T10:00:00.100Z'),
        updatedAt: new Date('2026-07-29T10:00:00.200Z'),
      },
      {
        requestId: 'restore-request',
        transactionId: 'PRIVATE_TRANSACTION_ID',
        operation: 'restore',
        status: 'VERIFIED',
        expectedRevision: 8,
        responseSnapshot: { syncToken: '9' },
        verification: { outcome: 'VERIFIED', status: 'REVERTED' },
        createdAt: new Date('2026-07-29T10:19:00.000Z'),
        updatedAt: new Date('2026-07-29T10:20:00.000Z'),
      },
    ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toEqual({
      outcome: 'reverted',
      at: '2026-07-29T10:20:00.000Z',
    });
  });

  it('includes a recent verified restore whose original run is outside the completion window', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    const recentRuns = Array.from({ length: 20 }, (_, index) => ({
      ...run,
      id: `00000000-0000-4000-8000-${String(index + 40).padStart(12, '0')}`,
      jobId: `job-recent-${index}`,
      transactionId: `recent-transaction-${index}`,
      status: index === 0 ? 'posted_verified' : 'failed',
      completedAt: new Date(`2026-07-29T10:${String(40 - index).padStart(2, '0')}:00.000Z`),
      verification: index === 0
        ? {
            verificationMode: 'distinct_model',
            liveOutcome: 'posted_verified',
            liveCheckpoint: validLiveCheckpoint(),
            mutation: {
              requestId: 'job-recent-0',
              outcome: 'VERIFIED',
              status: 'POSTED',
            },
          }
        : { diagnosticCode: 'AGENT_RUN_PROVIDER_FAILURE' },
    }));
    const displacedRevertedRun = {
      ...run,
      status: 'posted_verified',
      completedAt: new Date('2026-07-29T09:00:00.000Z'),
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    };
    const recentRestore = {
      requestId: 'restore-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      operation: 'restore',
      status: 'VERIFIED',
      expectedRevision: 8,
      responseSnapshot: { syncToken: '9' },
      verification: { outcome: 'VERIFIED', status: 'REVERTED' },
      createdAt: new Date('2026-07-29T10:49:00.000Z'),
      updatedAt: new Date('2026-07-29T10:50:00.000Z'),
    };
    mocks.agentRunFindMany.mockResolvedValue(recentRuns);
    mocks.prismaQueryRawUnsafe.mockResolvedValue([displacedRevertedRun]);
    mocks.qboMutationAttemptFindMany.mockImplementation(async (query: {
      where: { operation?: string };
    }) => query.where.operation === 'restore'
      ? [recentRestore]
      : [
          {
            requestId: 'job-recent-0',
            transactionId: 'recent-transaction-0',
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 8,
            responseSnapshot: { syncToken: '8' },
            verification: { outcome: 'VERIFIED', status: 'POSTED' },
            createdAt: new Date('2026-07-29T10:39:59.000Z'),
            updatedAt: new Date('2026-07-29T10:40:00.000Z'),
          },
          {
            requestId: 'job-live-request',
            transactionId: 'PRIVATE_TRANSACTION_ID',
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 8,
            responseSnapshot: { syncToken: '8' },
            verification: { outcome: 'VERIFIED', status: 'POSTED' },
            createdAt: new Date('2026-07-29T08:59:59.000Z'),
            updatedAt: new Date('2026-07-29T09:00:00.000Z'),
          },
          recentRestore,
        ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toEqual({
      outcome: 'reverted',
      at: '2026-07-29T10:50:00.000Z',
    });
    expect(mocks.prismaQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(
        /JOIN "QboMutationAttempt" original[\s\S]+JOIN "QboMutationAttempt" restore[\s\S]+ORDER BY restore\."updatedAt" DESC[\s\S]+LIMIT 20/u,
      ),
      COMPANY_ID,
    );
    expect(mocks.agentRunFindMany).toHaveBeenCalledTimes(1);
  });

  it('bounds restored action candidates only after excluding unrelated verified restores', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    const recentPostedRun = {
      ...run,
      id: '00000000-0000-4000-8000-000000000032',
      jobId: 'job-recent-live-request',
      transactionId: 'PRIVATE_RECENT_TRANSACTION_ID',
      status: 'posted_verified',
      completedAt: new Date('2026-07-29T10:50:00.000Z'),
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-recent-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
      },
    };
    const restoredRun = {
      ...run,
      status: 'posted_verified',
      completedAt: new Date('2026-07-29T09:00:00.000Z'),
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'posted_verified',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'VERIFIED',
          status: 'POSTED',
        },
        evidenceEvaluation: {
          state: 'invalidated',
          outcomeRequestId: 'restore-live-request',
          inputRevision: 8,
          invalidationReason: 'reverted',
        },
      },
    };
    const liveRestore = {
      requestId: 'restore-live-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      operation: 'restore',
      status: 'VERIFIED',
      expectedRevision: 8,
      responseSnapshot: { accepted: true },
      verification: { outcome: 'VERIFIED', status: 'REVERTED' },
      createdAt: new Date('2026-07-29T10:59:00.000Z'),
      updatedAt: new Date('2026-07-29T11:00:00.000Z'),
    };
    const unrelatedRestores = Array.from({ length: 20 }, (_, index) => ({
      requestId: `manual-restore-${index}`,
      transactionId: `unrelated-transaction-${index}`,
      operation: 'restore',
      status: 'VERIFIED',
      expectedRevision: 1,
      responseSnapshot: { accepted: true },
      verification: { outcome: 'VERIFIED', status: 'REVERTED' },
      createdAt: new Date(`2026-07-29T11:${String(index).padStart(2, '0')}:00.000Z`),
      updatedAt: new Date(`2026-07-29T11:${String(index).padStart(2, '0')}:30.000Z`),
    }));
    mocks.agentRunFindMany.mockImplementation(async (query: {
      where: { OR?: unknown };
    }) => query.where.OR === undefined ? [recentPostedRun] : []);
    mocks.prismaQueryRawUnsafe.mockResolvedValue([restoredRun]);
    mocks.qboMutationAttemptFindMany.mockImplementation(async (query: {
      where: { operation?: string };
    }) => query.where.operation === 'restore'
      ? unrelatedRestores
      : [
          {
            requestId: 'job-recent-live-request',
            transactionId: 'PRIVATE_RECENT_TRANSACTION_ID',
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 8,
            responseSnapshot: { accepted: true },
            verification: { outcome: 'VERIFIED', status: 'POSTED' },
            createdAt: new Date('2026-07-29T10:49:00.000Z'),
            updatedAt: new Date('2026-07-29T10:50:00.000Z'),
          },
          {
            requestId: 'job-live-request',
            transactionId: 'PRIVATE_TRANSACTION_ID',
            operation: 'recategorize',
            status: 'VERIFIED',
            expectedRevision: 8,
            responseSnapshot: { accepted: true },
            verification: { outcome: 'VERIFIED', status: 'POSTED' },
            createdAt: new Date('2026-07-29T08:59:00.000Z'),
            updatedAt: new Date('2026-07-29T09:00:00.000Z'),
          },
          liveRestore,
        ]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toEqual({
      outcome: 'reverted',
      at: '2026-07-29T11:00:00.000Z',
    });
    expect(mocks.prismaQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/LIMIT 20/u),
      COMPANY_ID,
    );
  });

  it('projects a canonically reconciled unchanged attempt as the latest live action', async () => {
    role = 'viewer';
    mocks.evaluateLiveGates.mockResolvedValue({
      ...liveReadiness,
      lastAction: null,
    });
    mocks.agentRunFindMany.mockResolvedValue([{
      ...run,
      status: 'unchanged',
      verification: {
        verificationMode: 'distinct_model',
        liveOutcome: 'reconciled_unchanged',
        liveCheckpoint: validLiveCheckpoint(),
        mutation: {
          requestId: 'job-live-request',
          outcome: 'UNCHANGED',
          status: 'PENDING',
        },
      },
    }]);
    mocks.qboMutationAttemptFindMany.mockResolvedValue([{
      requestId: 'job-live-request',
      transactionId: 'PRIVATE_TRANSACTION_ID',
      operation: 'recategorize',
      status: 'UNCHANGED',
      expectedRevision: 8,
      responseSnapshot: { unchanged: true },
      verification: { outcome: 'UNCHANGED', status: 'PENDING' },
      createdAt: new Date('2026-07-29T10:00:00.100Z'),
      updatedAt: new Date('2026-07-29T10:00:00.200Z'),
    }]);

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.lastAction).toEqual({
      outcome: 'reconciled_unchanged',
      at: '2026-07-29T10:00:00.250Z',
    });
  });

  it('enables live mode only for an admin with exact confirmation and the literal current policy', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/enable-live`)
      .set(sessionHeaders)
      .send({
        confirmation: 'Generic Company',
        acceptedPolicyVersion: LIVE_POLICY_VERSION,
      });

    role = 'admin';
    const invalidBodies = [
      { confirmation: 'Generic', acceptedPolicyVersion: LIVE_POLICY_VERSION },
      { confirmation: 'Generic Company', acceptedPolicyVersion: 'stale-policy' },
      {
        confirmation: 'Generic Company',
        acceptedPolicyVersion: LIVE_POLICY_VERSION,
        companyId: COMPANY_ID,
      },
      {
        confirmation: 'Generic Company',
        acceptedPolicyVersion: LIVE_POLICY_VERSION,
        providerBinding: 'client-forged',
      },
    ];
    const invalid = await Promise.all(invalidBodies.map((body) =>
      request(app)
        .post(`/api/companies/${COMPANY_ID}/autopilot/enable-live`)
        .set(sessionHeaders)
        .send(body)));
    const enabled = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/enable-live`)
      .set(sessionHeaders)
      .send({
        confirmation: 'Generic Company',
        acceptedPolicyVersion: LIVE_POLICY_VERSION,
      });

    expect(forbidden.status).toBe(403);
    expect(invalid.map((response) => response.status)).toEqual([409, 400, 400, 400]);
    expect(enabled.status).toBe(200);
    expect(enabled.body).toEqual(liveReadiness);
    expect(mocks.enableLiveModeForAdmin).toHaveBeenCalledOnce();
    expect(mocks.enableLiveModeForAdmin).toHaveBeenCalledWith(
      COMPANY_ID,
      'Generic Company',
      'autopilot-route-user',
    );
  });

  it('uses an empty strict body and the company mutation fence for an admin kill switch', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/pause-live`)
      .set(sessionHeaders)
      .send({});

    role = 'admin';
    const forged = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/pause-live`)
      .set(sessionHeaders)
      .send({ liveRequested: false });
    const paused = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/pause-live`)
      .set(sessionHeaders)
      .send({});

    expect(forbidden.status).toBe(403);
    expect(forged.status).toBe(400);
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'MANUAL_PAUSE',
      pauseMessage: 'Live mode is paused by a company administrator.',
    });
    expect(mocks.pauseLiveModeManually).toHaveBeenCalledOnce();
    expect(mocks.pauseLiveModeManually).toHaveBeenCalledWith(
      COMPANY_ID,
      'autopilot-route-user',
    );
  });

  it.each([
    {
      liveRequested: false,
      enabled: false,
      paused: false,
      pauseCode: null,
      pauseMessage: null,
    },
    {
      liveRequested: true,
      enabled: false,
      paused: true,
      pauseCode: 'UNCERTAIN_MUTATION',
      pauseMessage: 'Live mode is paused: A live mutation requires reconciliation.',
    },
  ])('returns the canonical final pause state from the mutation transaction: $pauseCode', async (ack) => {
    mocks.pauseLiveModeManually.mockResolvedValueOnce(ack);

    const response = await request(testApp())
      .post(`/api/companies/${COMPANY_ID}/autopilot/pause-live`)
      .set(sessionHeaders)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ack);
  });

  it('reconciles by opaque run operation only and loads every live binding on the server', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
      .set(sessionHeaders)
      .send({});

    role = 'admin';
    const forged = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
      .set(sessionHeaders)
      .send({ transactionId: 'client-forged', requestHash: 'client-forged' });
    const reconciled = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
      .set(sessionHeaders)
      .send({});

    expect(forbidden.status).toBe(403);
    expect(forged.status).toBe(400);
    expect(reconciled.status).toBe(202);
    expect(reconciled.body).toEqual({
      ok: false,
      status: 'POSTING',
      outcome: 'IN_PROGRESS',
      error: {
        code: 'MUTATION_IN_PROGRESS',
        message: 'Reconciliation is already in progress.',
      },
    });
    expect(JSON.stringify(reconciled.body)).not.toMatch(
      /transactionId|requestId|qbo|revision|hash|checkpoint|private/i,
    );
    expect(mocks.loadLiveReconciliationOperation).toHaveBeenCalledWith(
      RUN_ID,
      COMPANY_ID,
    );
    expect(mocks.reconcileLiveMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        transactionId: '00000000-0000-4000-8000-000000000040',
        requestId: '00000000-0000-4000-8000-000000000041',
      }),
      {
        actor: {
          id: 'autopilot-route-user',
          label: 'Generic administrator',
        },
      },
    );
  });

  it('fails drifted live ownership closed without falling back to generic reconciliation', async () => {
    mocks.loadLiveReconciliationOperation.mockResolvedValue(null);

    const response = await request(testApp())
      .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
      .set(sessionHeaders)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'This live operation is no longer bound to current durable state.',
      code: 'LIVE_RECONCILIATION_BINDING_MISMATCH',
    });
    expect(mocks.reconcileLiveMutation).not.toHaveBeenCalled();
  });

  it('maps final in-transaction administrator revocation to a bounded 403', async () => {
    mocks.reconcileLiveMutation.mockRejectedValueOnce(Object.assign(
      new Error('PRIVATE_FINAL_TRANSACTION_DETAIL'),
      {
        name: 'WritebackLifecycleError',
        code: 'FORBIDDEN',
      },
    ));

    const response = await request(testApp())
      .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
      .set(sessionHeaders)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'You do not have permission to do that',
      code: 'FORBIDDEN',
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_FINAL_TRANSACTION_DETAIL');
  });

  it('keeps disconnected history readable while every live mutation fails closed', async () => {
    disconnected = true;
    role = 'admin';
    const app = testApp();
    const readiness = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/live-readiness`)
      .set(sessionHeaders);
    const mutations = await Promise.all([
      request(app)
        .post(`/api/companies/${COMPANY_ID}/autopilot/enable-live`)
        .set(sessionHeaders)
        .send({
          confirmation: 'Generic Company',
          acceptedPolicyVersion: LIVE_POLICY_VERSION,
        }),
      request(app)
        .post(`/api/companies/${COMPANY_ID}/autopilot/pause-live`)
        .set(sessionHeaders)
        .send({}),
      request(app)
        .post(`/api/companies/${COMPANY_ID}/autopilot/reconcile/${RUN_ID}`)
        .set(sessionHeaders)
        .send({}),
    ]);

    expect(readiness.status).toBe(200);
    expect(mutations.map((response) => response.status)).toEqual([409, 409, 409]);
    expect(mocks.enableLiveModeForAdmin).not.toHaveBeenCalled();
    expect(mocks.pauseLiveModeManually).not.toHaveBeenCalled();
    expect(mocks.reconcileLiveMutation).not.toHaveBeenCalled();
  });
});
