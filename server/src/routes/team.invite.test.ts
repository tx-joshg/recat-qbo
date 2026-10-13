import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  membershipCreate: vi.fn(),
  companyCount: vi.fn(),
  issueMagicLink: vi.fn(),
  isSmtpConfigured: vi.fn(),
  localAdminConfig: { enabled: false, email: '', password: '' },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
    membership: { create: mocks.membershipCreate },
    company: { count: mocks.companyCount },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireUser: ((_req, _res, next) => next()) satisfies RequestHandler,
  requireRole: () => ((_req, _res, next) => next()) satisfies RequestHandler,
}));

vi.mock('../middleware/company.js', () => ({
  withCompany: () =>
    ((req, _res, next) => {
      req.company = { id: 'company-1' } as NonNullable<typeof req.company>;
      next();
    }) satisfies RequestHandler,
}));

vi.mock('../lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mailer.js')>();
  return { ...actual, isSmtpConfigured: mocks.isSmtpConfigured };
});

vi.mock('../services/magicLink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/magicLink.js')>();
  return { ...actual, issueMagicLink: mocks.issueMagicLink };
});

// devLogin.js stays real; only its inputs are swapped.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    ...actual,
    get localAdminConfig() {
      return mocks.localAdminConfig;
    },
    env: { ...actual.env, ALLOW_DEV_LOGIN: false },
  };
});

const { teamRouter } = await import('./team.js');

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/companies/:companyId/team', teamRouter);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localAdminConfig = { enabled: false, email: '', password: '' };
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.userCreate.mockResolvedValue({
    id: 'u2',
    email: 'new@example.com',
    name: null,
    invitePending: true,
    isInstanceAdmin: false,
  });
  mocks.membershipCreate.mockResolvedValue({});
  mocks.companyCount.mockResolvedValue(0);
  mocks.issueMagicLink.mockResolvedValue({ link: 'http://localhost/auth/callback?token=t' });
  mocks.isSmtpConfigured.mockResolvedValue(false);
});

const invite = (app: Express) =>
  request(app)
    .post('/api/companies/company-1/team')
    .send({ email: 'new@example.com', role: 'categorizer' });

describe('POST /team — invite link exposure', () => {
  it('never returns the invitee sign-in link on a local-admin deployment', async () => {
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };

    const res = await invite(testApp()).expect(201);

    expect(mocks.issueMagicLink).toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('devLink');
  });

  it('still returns it on a demo-only instance without a local admin', async () => {
    const res = await invite(testApp()).expect(201);

    expect(res.body.devLink).toBe('http://localhost/auth/callback?token=t');
  });
});
