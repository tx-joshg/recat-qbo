import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  membershipFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  activate: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
  },
}));

vi.mock('../services/ruleCandidates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ruleCandidates.js')>();
  return {
    ...actual,
    listRuleCandidates: mocks.list,
    getRuleCandidate: mocks.get,
    activateRuleCandidate: mocks.activate,
    dismissRuleCandidate: mocks.dismiss,
  };
});

import { ruleCandidatesRouter } from './ruleCandidates.js';

function app(): Express {
  const application = express();
  application.use(cookieParser());
  application.use(express.json());
  application.use('/api/companies/:companyId/rule-candidates', ruleCandidatesRouter);
  application.use(errorMiddleware);
  return application;
}

const sessionHeaders = { Cookie: 'recat_session=rule-candidate-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' | null;

beforeEach(() => {
  vi.clearAllMocks();
  role = 'categorizer';
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'reviewer-1',
      email: 'reviewer@example.invalid',
      name: 'Reviewer',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.companyFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    disconnectedAt: null,
  }));
  mocks.membershipFindUnique.mockImplementation(async (
    { where }: { where: { userId_companyId: { companyId: string } } },
  ) => (
    where.userId_companyId.companyId === 'company-1' && role !== null
      ? { role }
      : null
  ));
  mocks.list.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.activate.mockResolvedValue({ id: CANDIDATE_ID, state: 'activated' });
  mocks.dismiss.mockResolvedValue({ id: CANDIDATE_ID, state: 'dismissed' });
});

describe('rule candidate routes', () => {
  it('requires a company categorizer and scopes every service call', async () => {
    const allowed = await request(app())
      .get('/api/companies/company-1/rule-candidates?limit=10')
      .set(sessionHeaders);
    const foreign = await request(app())
      .get('/api/companies/company-2/rule-candidates')
      .set(sessionHeaders);

    expect(allowed.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith('company-1', { limit: 10 });
  });

  it('does not let a viewer activate or dismiss candidates', async () => {
    role = 'viewer';
    const application = app();

    const activate = await request(application)
      .post(`/api/companies/company-1/rule-candidates/${CANDIDATE_ID}/activate`)
      .set(sessionHeaders);
    const dismiss = await request(application)
      .post(`/api/companies/company-1/rule-candidates/${CANDIDATE_ID}/dismiss`)
      .set(sessionHeaders);

    expect(activate.status).toBe(403);
    expect(dismiss.status).toBe(403);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('rejects legacy candidate activation with the governed-operation migration code', async () => {
    const response = await request(app())
      .post(`/api/companies/company-1/rule-candidates/${CANDIDATE_ID}/activate`)
      .set(sessionHeaders);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RULE_OPERATION_REQUIRED');
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('rejects legacy candidate dismissal with the governed-operation migration code', async () => {
    const response = await request(app())
      .post(`/api/companies/company-1/rule-candidates/${CANDIDATE_ID}/dismiss`)
      .set(sessionHeaders);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RULE_OPERATION_REQUIRED');
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
