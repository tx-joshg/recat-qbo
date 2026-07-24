import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  companyFindUnique: vi.fn(),
  membershipFindUnique: vi.fn(),
  groupBy: vi.fn(),
  runFindFirst: vi.fn(),
  runCount: vi.fn(),
  mutationCount: vi.fn(),
  jobFindMany: vi.fn(),
  jobFindFirst: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdateMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  currentHash: vi.fn(),
  hasRule: vi.fn(),
  codexStatus: vi.fn(),
  codexTest: vi.fn(),
  settings: vi.fn(),
  reconcile: vi.fn(),
  cancel: vi.fn(),
  transaction: vi.fn(),
  txCompanyFindUnique: vi.fn(),
  companyUpdateMany: vi.fn(),
  candidateFindMany: vi.fn(),
  candidateUpdateMany: vi.fn(),
  activateCandidate: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique },
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    agentJob: {
      groupBy: mocks.groupBy,
      findMany: mocks.jobFindMany,
      findFirst: mocks.jobFindFirst,
      findUnique: mocks.jobFindUnique,
      updateMany: mocks.jobUpdateMany,
    },
    transaction: { findFirst: mocks.transactionFindFirst },
    agentRun: { findFirst: mocks.runFindFirst, count: mocks.runCount },
    qboMutationAttempt: { count: mocks.mutationCount },
    ruleCandidate: {
      findMany: mocks.candidateFindMany,
      updateMany: mocks.candidateUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../services/ai/codexAuth.js', () => ({
  getCodexStatus: mocks.codexStatus,
}));
vi.mock('../services/ai/provider.js', () => ({
  testCodexConnection: mocks.codexTest,
}));
vi.mock('../services/instanceSettings.js', () => ({
  getInstanceSettings: mocks.settings,
}));
vi.mock('../services/agent/jobs.js', () => ({
  countValidatedShadowRuns: mocks.runCount,
  cancelJob: mocks.cancel,
  currentAgentInputHash: mocks.currentHash,
  hasCurrentDeterministicRule: mocks.hasRule,
  MIN_LIVE_SHADOW_RUNS: 10,
}));
vi.mock('../services/agent/reconciliation.js', () => ({
  reconcileAutopilotJobs: mocks.reconcile,
}));
vi.mock('../services/audit.js', () => ({ writeAudit: mocks.writeAudit }));
vi.mock('../services/agent/ruleCandidates.js', () => ({
  activateRuleCandidate: mocks.activateCandidate,
}));

import { errorMiddleware } from '../lib/http.js';
import { originCheck } from '../middleware/auth.js';
import { autopilotRouter } from './autopilot.js';

const RAW_SESSION = 'raw-session-cookie';
const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
const company = {
  id: 'co-1',
  realmId: 'realm-1',
  legalName: 'Books Inc.',
  nickname: 'Books',
  env: 'production',
  syncMode: 'polling',
  pollIntervalMin: 10,
  holdingAccountIds: [],
  dryRun: false,
  tagsRequired: false,
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: null,
  connectedAt: new Date('2026-07-01'),
  disconnectedAt: null,
  lastSyncedAt: null,
  taxReferenceRefreshedAt: new Date('2026-07-23'),
  taxUsingSalesTax: true,
  taxSupportStatus: 'ready',
  taxSupportReason: null,
  autopilotMode: 'off',
  autopilotLiveConfirmedAt: null,
  agentReconcileToken: null,
  ruleWriteRetryAt: null,
};

async function request(
  path = '',
  options: { method?: string; body?: unknown; cookie?: string | null } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(originCheck);
  app.use('/api/companies/:companyId/autopilot', autopilotRouter);
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = {};
  if (options.cookie !== null) headers.Cookie = `recat_session=${options.cookie ?? RAW_SESSION}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}/api/companies/co-1/autopilot${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.companyFindUnique.mockResolvedValue(company);
  mocks.membershipFindUnique.mockResolvedValue({ role: 'categorizer' });
  mocks.groupBy.mockResolvedValue([{ status: 'completed', _count: { _all: 3 } }]);
  mocks.runFindFirst.mockResolvedValue(null);
  mocks.runCount.mockResolvedValue(10);
  mocks.mutationCount.mockResolvedValue(0);
  mocks.jobFindMany.mockResolvedValue([]);
  mocks.jobFindFirst.mockResolvedValue(null);
  mocks.jobFindUnique.mockResolvedValue(null);
  mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.currentHash.mockResolvedValue(null);
  mocks.hasRule.mockResolvedValue(false);
  mocks.codexStatus.mockResolvedValue({ connected: true, state: 'connected' });
  mocks.codexTest.mockResolvedValue({ ok: true });
  mocks.settings.mockResolvedValue({ codexModel: 'gpt-5.6-luna' });
  mocks.reconcile.mockResolvedValue(true);
  mocks.txCompanyFindUnique
    .mockResolvedValueOnce(company)
    .mockResolvedValue({ ...company, autopilotMode: 'live' });
  mocks.companyUpdateMany.mockResolvedValue({ count: 1 });
  mocks.candidateFindMany.mockResolvedValue([]);
  mocks.candidateUpdateMany.mockResolvedValue({ count: 1 });
  mocks.activateCandidate.mockResolvedValue({ candidateId: 'candidate-1', ruleId: 'rule-1' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      company: {
        findUnique: mocks.txCompanyFindUnique,
        updateMany: mocks.companyUpdateMany,
      },
      agentRun: { count: mocks.runCount },
      qboMutationAttempt: { count: mocks.mutationCount },
      auditEntry: { create: vi.fn(async () => ({})) },
    }),
  );
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (active) => new Promise<void>((resolve) => active.close(() => resolve())),
    ),
  );
});

describe('autopilot routes', () => {
  it('returns scoped readiness and durable job counts to categorizers', async () => {
    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'off',
      readiness: { providerConnected: true, taxReady: true },
      counts: { queued: 0, completed: 3, failed: 0 },
    });
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'co-1' } }),
    );
    expect(mocks.mutationCount).toHaveBeenCalledWith({
      where: {
        transaction: { companyId: 'co-1', status: 'ERROR' },
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
    });
    expect(mocks.runCount).toHaveBeenCalledWith('co-1', {
      provider: 'codex',
      model: 'gpt-5.6-luna',
    });
  });

  it('does not expose company data without membership', async () => {
    mocks.membershipFindUnique.mockResolvedValue(null);

    const response = await request('/jobs');

    expect(response.status).toBe(403);
    expect(mocks.jobFindMany).not.toHaveBeenCalled();
  });

  it('requires company admin for mode changes', async () => {
    const response = await request('', { method: 'PATCH', body: { mode: 'shadow' } });

    expect(response.status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before enabling live mode', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });

    const response = await request('', { method: 'PATCH', body: { mode: 'live' } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTOPILOT_CONFIRMATION',
    });
  });

  it('blocks live mode until enough validated shadow evidence exists', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.runCount.mockResolvedValue(3);

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTOPILOT_LIVE_NOT_READY',
    });
    expect(mocks.codexTest).not.toHaveBeenCalled();
  });

  it('does not count shadow evidence from a previous Codex model', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.settings.mockResolvedValue({ codexModel: 'gpt-5.6-new' });
    mocks.runCount.mockImplementation(
      async (_companyId: string, identity: { model: string }) =>
        identity.model === 'gpt-5.6-new' ? 0 : 10,
    );

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(409);
    expect(mocks.runCount).toHaveBeenCalledWith('co-1', {
      provider: 'codex',
      model: 'gpt-5.6-new',
    });
    expect(mocks.companyUpdateMany).not.toHaveBeenCalled();
  });

  it('tests the provider and audits a readiness-gated live activation', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(200);
    expect(mocks.codexTest).toHaveBeenCalledOnce();
    expect(mocks.companyUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'co-1',
        disconnectedAt: null,
        taxSupportStatus: 'ready',
        dryRun: false,
        tagsRequired: false,
      },
      data: {
        autopilotMode: 'live',
        autopilotLiveConfirmedAt: expect.any(Date),
        agentReconcileToken: expect.any(String),
      },
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: 'co-1',
        action: 'autopilot',
        before: 'off',
        after: 'live',
      }),
    );
    expect(mocks.reconcile).toHaveBeenCalledWith('co-1');
  });

  it('requeues completed shadow jobs exactly when promoting to live', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.txCompanyFindUnique
      .mockReset()
      .mockResolvedValueOnce({ ...company, autopilotMode: 'shadow' })
      .mockResolvedValue({ ...company, autopilotMode: 'live' });

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith('co-1');
  });

  it('reports a committed live activation even when post-commit reconciliation fails', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.reconcile.mockRejectedValueOnce(new Error('queue unavailable'));

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'live' });
    expect(mocks.companyUpdateMany).toHaveBeenCalled();
  });

  it('reports a committed live activation when the post-commit summary refresh fails', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.settings
      .mockResolvedValueOnce({ codexModel: 'gpt-5.6-luna' })
      .mockResolvedValueOnce({ codexModel: 'gpt-5.6-luna' })
      .mockRejectedValueOnce(new Error('settings unavailable'));

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'live' });
    expect(mocks.companyUpdateMany).toHaveBeenCalled();
  });

  it('can always disable autopilot without reading provider readiness first', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.codexStatus.mockRejectedValue(new Error('provider unavailable'));
    mocks.txCompanyFindUnique
      .mockReset()
      .mockResolvedValueOnce({ ...company, autopilotMode: 'live' })
      .mockResolvedValue({ ...company, autopilotMode: 'off' });

    const response = await request('', { method: 'PATCH', body: { mode: 'off' } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'off' });
    expect(mocks.companyUpdateMany).toHaveBeenCalled();
  });

  it('does not overwrite a disconnect that lands during the provider test', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.txCompanyFindUnique.mockReset();
    mocks.txCompanyFindUnique.mockResolvedValue({
      ...company,
      disconnectedAt: new Date('2026-07-23T12:30:00Z'),
      autopilotMode: 'off',
    });

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(mocks.companyUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('does not commit live after company write readiness changes', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.txCompanyFindUnique.mockReset();
    mocks.txCompanyFindUnique.mockResolvedValue({ ...company, dryRun: true });

    const response = await request('', {
      method: 'PATCH',
      body: { mode: 'live', confirmation: 'ENABLE LIVE AUTOPILOT' },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTOPILOT_LIVE_NOT_READY',
    });
    expect(mocks.companyUpdateMany).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const response = await request('', { cookie: null });
    expect(response.status).toBe(401);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it('uses only the current company in job-list reads', async () => {
    const response = await request('/jobs');

    expect(response.status).toBe(200);
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'co-1' }, take: 100 }),
    );
  });

  it('recomputes eligibility and the current input hash before retrying a stale job', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.companyFindUnique.mockResolvedValue({ ...company, autopilotMode: 'shadow' });
    const failedJob = {
      id: 'job-1',
      transactionId: 'txn-1',
      companyId: 'co-1',
      status: 'cancelled',
      inputHash: 'stale-hash',
      attempt: 1,
      nextAttemptAt: new Date('2026-07-23T10:00:00Z'),
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: 'AGENT_STALE_INPUT',
      lastErrorMessage: 'stale',
      createdAt: new Date('2026-07-23T09:00:00Z'),
      updatedAt: new Date('2026-07-23T10:00:00Z'),
    };
    mocks.jobFindFirst.mockResolvedValue(failedJob);
    mocks.transactionFindFirst.mockResolvedValue({ id: 'txn-1' });
    mocks.currentHash.mockResolvedValue('current-hash');
    mocks.jobUpdateMany.mockResolvedValue({ count: 1 });

    const response = await request('/jobs/job-1/retry', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          companyId: 'co-1',
          inputHash: 'stale-hash',
        }),
        data: expect.objectContaining({
          inputHash: 'current-hash',
          status: 'queued',
        }),
      }),
    );
  });

  it('does not retry a job once a deterministic rule owns the transaction', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.companyFindUnique.mockResolvedValue({ ...company, autopilotMode: 'shadow' });
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      transactionId: 'txn-1',
      companyId: 'co-1',
      status: 'failed',
      inputHash: 'stale-hash',
    });
    mocks.transactionFindFirst.mockResolvedValue({
      id: 'txn-1',
      suggestion: { source: 'rule', category: 'Software' },
    });
    mocks.hasRule.mockResolvedValue(true);

    const response = await request('/jobs/job-1/retry', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(mocks.currentHash).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it('ignores a stale cached rule suggestion after the rule is deleted', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.companyFindUnique.mockResolvedValue({ ...company, autopilotMode: 'shadow' });
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      transactionId: 'txn-1',
      companyId: 'co-1',
      status: 'cancelled',
      inputHash: 'stale-hash',
      attempt: 1,
      nextAttemptAt: new Date('2026-07-23T10:00:00Z'),
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: 'AGENT_RULE_COVERED',
      lastErrorMessage: 'covered',
      createdAt: new Date('2026-07-23T09:00:00Z'),
      updatedAt: new Date('2026-07-23T10:00:00Z'),
    });
    mocks.transactionFindFirst.mockResolvedValue({
      id: 'txn-1',
      suggestion: { source: 'rule', category: 'Software' },
    });
    mocks.hasRule.mockResolvedValue(false);
    mocks.currentHash.mockResolvedValue('current-hash');
    mocks.jobUpdateMany.mockResolvedValue({ count: 1 });

    const response = await request('/jobs/job-1/retry', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mocks.currentHash).toHaveBeenCalledWith('txn-1');
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inputHash: 'current-hash', status: 'queued' }),
      }),
    );
  });

  it('requires a negative Purchase amount before retrying a job', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.companyFindUnique.mockResolvedValue({ ...company, autopilotMode: 'shadow' });
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      transactionId: 'txn-1',
      companyId: 'co-1',
      status: 'failed',
      inputHash: 'stale-hash',
    });
    mocks.transactionFindFirst.mockResolvedValue(null);

    const response = await request('/jobs/job-1/retry', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(mocks.transactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          qboType: 'Purchase',
          amount: { lt: 0 },
        }),
      }),
    );
    expect(mocks.currentHash).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses to cancel a running job whose write may already be in flight', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        isInstanceAdmin: true,
        memberships: [],
      },
    });
    mocks.companyFindUnique.mockResolvedValue({ ...company, autopilotMode: 'shadow' });
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      transactionId: 'txn-1',
      companyId: 'co-1',
      status: 'running',
      inputHash: 'hash-1',
    });

    const response = await request('/jobs/job-1/cancel', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('scopes rule-candidate reads and keeps activation admin-only', async () => {
    const list = await request('/rule-candidates');
    expect(list.status).toBe(200);
    expect(mocks.candidateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'co-1' }, take: 100 }),
    );

    const activation = await request('/rule-candidates/candidate-1/activate', {
      method: 'POST',
    });
    expect(activation.status).toBe(403);
    expect(mocks.activateCandidate).not.toHaveBeenCalled();
  });

  it('hashes the same session cookie shape used throughout the app', () => {
    expect(sha256Hex(RAW_SESSION)).toHaveLength(64);
  });
});
