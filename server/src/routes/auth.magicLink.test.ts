import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userCreate: vi.fn(),
  companyCount: vi.fn(),
  issueMagicLink: vi.fn(),
  isSmtpConfigured: vi.fn(),
  localAdminConfig: { enabled: false, email: '', password: '' },
  allowDevLogin: false,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, count: mocks.userCount, create: mocks.userCreate },
    company: { count: mocks.companyCount },
  },
}));

vi.mock('../lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mailer.js')>();
  return { ...actual, isSmtpConfigured: mocks.isSmtpConfigured };
});

vi.mock('../services/magicLink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/magicLink.js')>();
  return { ...actual, issueMagicLink: mocks.issueMagicLink };
});

// devLogin.js stays REAL so localAdminLockdown's actual logic is under test;
// only its inputs (env, company count) are swapped.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    ...actual,
    get localAdminConfig() {
      return mocks.localAdminConfig;
    },
    env: {
      ...actual.env,
      get ALLOW_DEV_LOGIN() {
        return mocks.allowDevLogin;
      },
    },
  };
});

const { authRouter } = await import('./auth.js');

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  app.use(errorMiddleware);
  return app;
}

const ADMIN = { id: 'u1', email: 'admin@recat.local', isInstanceAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  // The limiter is module state shared across the file. It keys on the email,
  // so each test uses a distinct address rather than reaching into it.
  mocks.localAdminConfig = { enabled: false, email: '', password: '' };
  mocks.allowDevLogin = false;
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.userCount.mockResolvedValue(0);
  mocks.userCreate.mockResolvedValue({ id: 'u9', email: 'x@example.com' });
  mocks.companyCount.mockResolvedValue(0); // no real companies → devLoginAllowed
  mocks.issueMagicLink.mockResolvedValue({ link: 'http://localhost/auth/callback?token=t' });
  mocks.isSmtpConfigured.mockResolvedValue(false);
});

const post = (app: Express, email: string) =>
  request(app).post('/auth/magic-link').send({ email });

// This route is unauthenticated and the local-admin address is published in
// the Umbrel manifest, so on a local-admin deployment it must never create
// accounts nor put a sign-in link in the response body — either one hands the
// instance to whoever asks. (#53)
describe('POST /auth/magic-link — local-admin lockdown', () => {
  describe('when a local admin password is configured', () => {
    beforeEach(() => {
      mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };
    });

    it('does not bootstrap the first admin on a fresh instance', async () => {
      const res = await post(testApp(), 'attacker-a@evil.com').expect(200);

      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(res.body).toEqual({ ok: true, delivered: false }); // no devLink, no enumeration change
    });

    it('never returns devLink, even for the published admin address', async () => {
      mocks.userFindUnique.mockResolvedValue(ADMIN);

      const res = await post(testApp(), 'admin@recat.local').expect(200);

      // The link is still issued — it reaches the server log for the owner —
      // but the response body must not carry it.
      expect(mocks.issueMagicLink).toHaveBeenCalled();
      expect(res.body).not.toHaveProperty('devLink');
    });

    it('ALLOW_DEV_LOGIN=true restores dev behavior explicitly', async () => {
      mocks.allowDevLogin = true;

      const res = await post(testApp(), 'dev-c@example.com').expect(200);

      expect(mocks.userCreate).toHaveBeenCalled(); // bootstrap allowed again
      expect(res.body.devLink).toBeDefined();
    });
  });

  describe('without a local admin (dev / quick-start)', () => {
    it('still bootstraps the first admin and returns the link', async () => {
      const res = await post(testApp(), 'me-d@example.com').expect(200);

      expect(mocks.userCreate).toHaveBeenCalledWith({
        data: { email: 'me-d@example.com', isInstanceAdmin: true, invitePending: false },
      });
      expect(res.body.devLink).toBeDefined();
    });
  });

  // Keyed by address, never by req.ip: behind a proxy with TRUSTED_PROXY_IPS
  // unset every caller shares one address, so an IP key would let any anonymous
  // client hold a deployment-wide bucket empty and block sign-in for everyone.
  it('throttles one address without touching any other', async () => {
    const app = testApp();
    mocks.userFindUnique.mockResolvedValue(ADMIN);

    for (let i = 0; i < 5; i += 1) await post(app, 'target@example.com').expect(200);
    const res = await post(app, 'target@example.com').expect(429);

    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);

    // Same client, same connection — a different address must still work.
    await post(app, 'bystander@example.com').expect(200);
  });
});
