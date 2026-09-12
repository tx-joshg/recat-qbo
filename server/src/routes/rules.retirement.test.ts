import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rule: null as null | Record<string, any>,
  revisions: [] as Array<Record<string, any>>,
}));

const fakePrisma = vi.hoisted(() => ({
  qboAccount: {
    findFirst: vi.fn(async () => ({ qboId: 'account-synthetic', name: 'Synthetic expense' })),
  },
  tag: { count: vi.fn(async () => 1) },
  rule: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) =>
      state.rule?.id === where.id && state.rule?.companyId === where.companyId
        ? state.rule
        : null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      state.rule?.id === where.id ? state.rule : null),
    update: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      if (state.rule === null) throw new Error('Rule not found');
      const revision = data.revision?.increment === undefined
        ? state.rule.revision
        : state.rule.revision + data.revision.increment;
      state.rule = { ...state.rule, ...data, revision };
      return state.rule;
    }),
    delete: vi.fn(async () => {
      const deleted = state.rule;
      state.rule = null;
      return deleted;
    }),
  },
  ruleRevision: {
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      state.revisions.push(data);
      return data;
    }),
  },
  auditEntry: { create: vi.fn(async ({ data }: { data: Record<string, any> }) => data) },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: fakePrisma }));
vi.mock('../middleware/auth.js', () => ({
  requireUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'user-synthetic' } });
    next();
  },
  requireRole: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
vi.mock('../middleware/company.js', () => ({
  withCompany: () => (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    Object.assign(req, { company: { id: 'company-synthetic' } });
    next();
  },
}));
vi.mock('../services/companyMutationScope.js', () => ({
  runCompanyMutationTransaction: async (
    _client: unknown,
    _companyId: string,
    callback: (tx: typeof fakePrisma) => Promise<unknown>,
  ) => callback(fakePrisma),
}));

import { rulesRouter } from './rules.js';

describe('DELETE /api/companies/:companyId/rules/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.revisions = [];
    state.rule = {
      id: 'rule-synthetic',
      companyId: 'company-synthetic',
      priority: 4,
      matchField: 'payee',
      matchText: 'Synthetic Vendor',
      category: 'Synthetic expense',
      categoryQboId: 'account-synthetic',
      taxCalculation: 'NotApplicable',
      taxCode: null,
      taxCodeQboId: null,
      autoPost: true,
      enabled: true,
      revision: 0,
      originIntent: 'make_recurring',
      sourceCaseId: null,
      sourceCandidateId: null,
      retiredAt: null,
      createdById: 'creator-synthetic',
      createdAt: new Date('2026-08-30T00:00:00.000Z'),
      updatedAt: new Date('2026-08-30T00:00:00.000Z'),
      updatedById: null,
      reviewRequiredAt: null,
      reviewReason: null,
      ruleTags: [{
        ruleId: 'rule-synthetic',
        tagId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }],
      candidateOrigin: null,
    };
  });

  it('requires governed preparation and leaves the rule unchanged', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/companies/:companyId/rules', rulesRouter);

    const response = await request(app)
      .delete('/api/companies/company-synthetic/rules/rule-synthetic');

    expect(response.status).toBe(404);
    expect(state.rule).toMatchObject({
      id: 'rule-synthetic',
      enabled: true,
      revision: 0,
      updatedById: null,
    });
    expect(state.rule?.retiredAt).toBeNull();
    expect(state.revisions).toEqual([]);
  });
});
