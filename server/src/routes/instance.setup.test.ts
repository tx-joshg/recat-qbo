import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  userCount: vi.fn(),
  userUpsert: vi.fn(),
  getInstanceSettings: vi.fn(),
  issueMagicLink: vi.fn(),
  isSmtpConfigured: vi.fn(),
  devLoginAllowed: vi.fn(),
  localAdminConfig: { enabled: false, email: '', password: '' },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { user: { count: mocks.userCount, upsert: mocks.userUpsert } },
}));

vi.mock('../services/magicLink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/magicLink.js')>();
  return { ...actual, issueMagicLink: mocks.issueMagicLink };
});

vi.mock('../lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mailer.js')>();
  return { ...actual, isSmtpConfigured: mocks.isSmtpConfigured };
});

vi.mock('../services/devLogin.js', () => ({ devLoginAllowed: mocks.devLoginAllowed }));

// Only localAdminConfig is swapped; the rest of env is real, because
// instance.ts transitively pulls in the QBO factory, which reads it.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    ...actual,
    get localAdminConfig() {
      return mocks.localAdminConfig;
    },
  };
});

vi.mock('../services/instanceSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/instanceSettings.js')>();
  return { ...actual, getInstanceSettings: mocks.getInstanceSettings };
});

const { setupRouter, setupClaimLimiter } = await import('./instance.js');

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter);
  app.use(errorMiddleware);
  return app;
}

const PASSWORD = 'umbrel-shown-password';

beforeEach(() => {
  vi.clearAllMocks();
  // The limiter is module state shared by every request, as it is in
  // production — reset it so one test's guesses do not throttle the next.
  setupClaimLimiter.reset();
  mocks.localAdminConfig = { enabled: false, email: '', password: '' };
  mocks.userUpsert.mockResolvedValue({ id: 'u1', email: 'admin@recat.local' });
  mocks.issueMagicLink.mockResolvedValue({ link: 'http://localhost/auth/callback?token=t' });
  mocks.isSmtpConfigured.mockResolvedValue(false);
  mocks.devLoginAllowed.mockResolvedValue(true);
  mocks.getInstanceSettings.mockResolvedValue({
    intuitClientId: '',
    smtpHost: '',
    appUrl: 'http://umbrel.local:3009',
  });
});

// The wizard must create the address local sign-in authenticates, or the
// password the deployment displays belongs to no account — and an Umbrel
// install has no SMTP to deliver a magic link instead.
describe('GET /api/setup/status — localAdminEmail', () => {
  it('offers the address while the instance is un-set-up and local sign-in is on', async () => {
    mocks.userCount.mockResolvedValue(0);
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(true);
    expect(res.body.localAdminEmail).toBe('admin@recat.local');
  });

  it('withholds it once an instance admin exists', async () => {
    mocks.userCount.mockResolvedValue(1);
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: 'x'.repeat(12) };

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(false);
    // This route is public. After setup the address identifies a real account,
    // and the wizard no longer needs it.
    expect(res.body).not.toHaveProperty('localAdminEmail');
  });

  it('omits it when local sign-in is off, even before setup', async () => {
    mocks.userCount.mockResolvedValue(0);

    const res = await request(testApp()).get('/api/setup/status').expect(200);

    expect(res.body.needsSetup).toBe(true);
    expect(res.body).not.toHaveProperty('localAdminEmail');
  });
});

// First-run has to be unauthenticated — somebody must create the first account.
// On a deployment reachable before setup that lets whoever arrives first claim
// the instance, and with no SMTP the response hands them a sign-in link. Umbrel
// makes it concrete: its dashboard auth is off so the Intuit callback can land.
// Where a local admin password exists, requiring it proves the caller can see
// the device without inventing a new secret.
describe('POST /api/setup/admin — claiming the instance', () => {
  const claim = (body: Record<string, unknown>) =>
    request(testApp()).post('/api/setup/admin').send(body);

  beforeEach(() => {
    mocks.userCount.mockResolvedValue(0);
  });

  it('creates the admin without a password when local sign-in is off', async () => {
    await claim({ email: 'me@example.com' }).expect(200);
    expect(mocks.userUpsert).toHaveBeenCalled();
  });

  describe('when a local admin password is configured', () => {
    beforeEach(() => {
      mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: PASSWORD };
    });

    it('refuses a claim that omits the password', async () => {
      const res = await claim({ email: 'attacker@example.com' }).expect(401);

      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      expect(mocks.userUpsert).not.toHaveBeenCalled();
    });

    it('refuses a claim with the wrong password', async () => {
      await claim({ email: 'attacker@example.com', password: 'guess' }).expect(401);
      expect(mocks.userUpsert).not.toHaveBeenCalled();
    });

    it('accepts the password the deployment displays', async () => {
      await claim({ email: 'admin@recat.local', password: PASSWORD }).expect(200);
      expect(mocks.userUpsert).toHaveBeenCalled();
    });

    // The limiter has to stop guesses being EVALUATED, not just hide their
    // results. If the password were compared before the bucket was consulted,
    // an attacker could submit unlimited guesses and a correct one would still
    // be let through — the 429s would conceal wrong answers while the real
    // brute force continued.
    it('stops evaluating guesses once the bucket is exhausted', async () => {
      const app = testApp();
      const guess = (password: string) =>
        request(app).post('/api/setup/admin').send({ email: 'a@example.com', password });

      for (let i = 0; i < 5; i += 1) await guess('wrong');

      // Even the CORRECT password is refused now — proof the comparison is
      // gated rather than merely unreported.
      const res = await guess(PASSWORD).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(mocks.userUpsert).not.toHaveBeenCalled();
    });

    // The lockout is shared, so it must be survivable: the window is a minute,
    // not the fifteen sign-in uses. Reported from a real device, where a
    // fifteen-minute bucket froze the wizard for the owner as well.
    it('bounds the shared lockout to about a minute', async () => {
      const app = testApp();
      for (let i = 0; i < 5; i += 1) {
        await request(app).post('/api/setup/admin').send({ email: 'a@example.com', password: 'x' });
      }

      const res = await request(app)
        .post('/api/setup/admin')
        .send({ email: 'a@example.com', password: 'x' })
        .expect(429);

      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('forgets earlier failures once a correct password gets through', async () => {
      const app = testApp();
      for (let i = 0; i < 3; i += 1) {
        await request(app).post('/api/setup/admin').send({ email: 'a@example.com', password: 'x' });
      }

      await request(app)
        .post('/api/setup/admin')
        .send({ email: 'admin@recat.local', password: PASSWORD })
        .expect(200);
      expect(mocks.userUpsert).toHaveBeenCalled();
    });

    it('rate limits repeated guesses rather than allowing a free brute force', async () => {
      const app = testApp();
      const attempt = () =>
        request(app).post('/api/setup/admin').send({ email: 'a@example.com', password: 'wrong' });

      const codes: number[] = [];
      for (let i = 0; i < 7; i += 1) codes.push((await attempt()).status);

      // Whatever the exact allowance, it must stop before unlimited and say so.
      expect(codes).toContain(429);
      expect(codes.filter((c) => c === 401).length).toBeLessThan(codes.length);
      expect(mocks.userUpsert).not.toHaveBeenCalled();
    });
  });

  it('still refuses once an admin exists, before any password check', async () => {
    mocks.userCount.mockResolvedValue(1);
    mocks.localAdminConfig = { enabled: true, email: 'admin@recat.local', password: PASSWORD };

    const res = await claim({ email: 'me@example.com', password: PASSWORD }).expect(409);
    expect(res.body.code).toBe('ALREADY_SETUP');
  });
});
