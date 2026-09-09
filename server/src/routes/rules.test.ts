import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), company: vi.fn(), membership: vi.fn(), list: vi.fn(),
  lifecycle: vi.fn(), detail: vi.fn(), history: vi.fn(), affected: vi.fn(), test: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  session: { findUnique: mocks.session }, company: { findUnique: mocks.company },
  membership: { findUnique: mocks.membership },
} }));
vi.mock('../services/companyReads.js', () => ({
  listRuleLifecycle: mocks.lifecycle, getRule: mocks.detail, listRuleRevisions: mocks.history,
  listRuleAffectedTransactions: mocks.affected,
}));
vi.mock('../services/rules.js', async (original) => ({
  ...(await original<typeof import('../services/rules.js')>()), listRules: mocks.list, testRule: mocks.test,
}));

import { rulesRouter } from './rules.js';

function app() { const value = express(); value.use(cookieParser()); value.use(express.json());
  value.use('/api/companies/:companyId/rules', rulesRouter); value.use(errorMiddleware); return value; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: 'session-a', expiresAt: new Date(Date.now() + 60_000), user: {
    id: 'user-a', email: 'a@example.invalid', name: null, isInstanceAdmin: false, memberships: [],
  } });
  mocks.company.mockResolvedValue({ id: 'company-a', disconnectedAt: new Date() });
  mocks.membership.mockResolvedValue({ role: 'categorizer' });
  mocks.list.mockResolvedValue([{
    id: 'active-rule', companyId: 'company-a', priority: 0, matchText: 'Active vendor',
    category: 'Meals', categoryQboId: 'account-meals', taxCalculation: 'NotApplicable',
    taxCode: null, taxCodeQboId: null, autoPost: false, createdAt: new Date('2026-08-31T00:00:00.000Z'),
    reviewRequiredAt: null, reviewReason: null, ruleTags: [], candidateOrigin: null,
  }]);
  mocks.lifecycle.mockResolvedValue({ items: [{ state: 'disabled', revision: {
    ruleId: 'disabled-rule', revision: 3, state: 'disabled', valid: true, invalidReasons: [],
  } }], nextCursor: 'signed-next' });
  mocks.detail.mockResolvedValue({ revision: { revision: 4, state: 'disabled' } });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  mocks.affected.mockResolvedValue({
    items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, processedCount: 0,
  });
});

describe('governed rule REST', () => {
  it.each(['priority', 'priorityTop', 'orderIds'])('rejects obsolete %s inputs when testing a rule', async (field) => {
    const response = await request(app())
      .post('/api/companies/company-a/rules/test')
      .set('Cookie', 'recat_session=x')
      .send({ matchText: 'Coffee', direction: 'Purchase', [field]: 0 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION');
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it('serves the same disconnected-safe two-state lifecycle page from both collection routes', async () => {
    const lifecycle = await request(app())
      .get('/api/companies/company-a/rules/lifecycle?state=disabled&limit=1&cursor=signed-current')
      .set('Cookie', 'recat_session=x');
    const legacy = await request(app())
      .get('/api/companies/company-a/rules')
      .set('Cookie', 'recat_session=x');

    expect(lifecycle.status).toBe(200);
    expect(lifecycle.body).toEqual({ items: [{ state: 'disabled', revision: {
      ruleId: 'disabled-rule', revision: 3, state: 'disabled', valid: true, invalidReasons: [],
    } }], nextCursor: 'signed-next' });
    expect(mocks.lifecycle).toHaveBeenCalledWith('user-a', 'company-a', {
      state: 'disabled', limit: 1, cursor: 'signed-current',
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toEqual(lifecycle.body);
  });

  it('rejects an unknown lifecycle state instead of widening the collection', async () => {
    const response = await request(app())
      .get('/api/companies/company-a/rules/lifecycle?state=unknown')
      .set('Cookie', 'recat_session=x');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION');
  });

  it('keeps the lifecycle collection categorizer-only', async () => {
    mocks.membership.mockResolvedValue({ role: 'viewer' });
    const response = await request(app())
      .get('/api/companies/company-a/rules/lifecycle?state=all')
      .set('Cookie', 'recat_session=x');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('reads canonical detail and signed-cursor history while disconnected', async () => {
    mocks.membership.mockResolvedValue({ role: 'viewer' });
    const detail = await request(app()).get('/api/companies/company-a/rules/rule-a').set('Cookie', 'recat_session=x');
    const history = await request(app()).get('/api/companies/company-a/rules/rule-a/revisions?limit=10').set('Cookie', 'recat_session=x');
    expect(detail.status).toBe(200); expect(history.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a');
    expect(mocks.history).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a', { limit: 10 });
  });

  it('allows a viewer to read a company-scoped affected page but preserves the write migration fence', async () => {
    mocks.membership.mockResolvedValue({ role: 'viewer' });
    const response = await request(app())
      .get('/api/companies/company-a/rules/rule-a/affected-transactions')
      .query({ status: 'processed', limit: 20, cursor: 'signed-cursor' })
      .set('Cookie', 'recat_session=x');

    expect(response.status).toBe(200);
    expect(mocks.affected).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a', {
      status: 'processed', limit: 20, cursor: 'signed-cursor',
    });
    mocks.membership.mockResolvedValue({ role: 'categorizer' });
    await request(app()).patch('/api/companies/company-a/rules/rule-a')
      .set('Cookie', 'recat_session=x').send({ categoryQboId: 'account-a' })
      .expect(404);
  });

  it('keeps current list and test operations categorizer-only', async () => {
    mocks.membership.mockResolvedValue({ role: 'viewer' });
    for (const [method, path] of [
      ['get', '/api/companies/company-a/rules'],
      ['post', '/api/companies/company-a/rules/test'],
    ] as const) {
      const response = await request(app())[method](path).set('Cookie', 'recat_session=x').send({});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
  });

  it('does not reveal whether a guessed company exists before the viewer gate', async () => {
    mocks.membership.mockResolvedValue(null);
    mocks.company.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === 'company-missing' ? null : { id: where.id, disconnectedAt: new Date() }
    ));
    const existing = await request(app())
      .get('/api/companies/company-a/rules/rule-a')
      .set('Cookie', 'recat_session=x');
    const missing = await request(app())
      .get('/api/companies/company-missing/rules/rule-a')
      .set('Cookie', 'recat_session=x');

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(existing.body.code).toBe('FORBIDDEN');
    expect(missing.body.code).toBe('FORBIDDEN');
  });

  it('keeps generic creation behind the governed operation endpoint', async () => {
    const response = await request(app()).post('/api/companies/company-a/rules').set('Cookie', 'recat_session=x').send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RULE_OPERATION_REQUIRED');
  });

  it.each([
    ['patch', '/api/companies/company-a/rules/rule-a'],
    ['delete', '/api/companies/company-a/rules/rule-a'],
    ['put', '/api/companies/company-a/rules/order'],
  ] as const)('does not expose legacy %s policy writes', async (method, path) => {
    const response = await request(app())[method](path).set('Cookie', 'recat_session=x').send({});
    expect(response.status).toBe(404);
  });
});
