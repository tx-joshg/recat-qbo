import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { LocalLoginLimiter } from '../services/localLoginLimiter.js';
import { compileTrustedProxy } from '../services/trustedProxy.js';
import { createLocalAuthRouter, type LocalAuthDependencies } from './localAuth.js';

const ADMIN = {
  id: 'u1',
  email: 'admin@example.com',
  name: null,
  isInstanceAdmin: true,
  invitePending: false,
  dashboardLayout: null,
  createdAt: new Date(),
  memberships: [],
};

function dependencies(overrides: Partial<LocalAuthDependencies> = {}): LocalAuthDependencies {
  return {
    config: { enabled: true, email: ADMIN.email, password: 'correct horse battery staple' },
    authenticate: vi.fn(async () => ADMIN),
    createSession: vi.fn(async () => ({ token: 'session-token', expiresAt: new Date(Date.now() + 60_000) })),
    limiter: new LocalLoginLimiter(),
    cookieOptions: () => ({ httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 60_000 }),
    ...overrides,
  };
}

const TEST_PROXY_IPS = '127.0.0.1,::1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function app(deps: LocalAuthDependencies, trustedProxyIps = '') {
  const instance = express();
  instance.set('trust proxy', compileTrustedProxy(trustedProxyIps));
  instance.use(express.json());
  instance.use(createLocalAuthRouter(deps));
  instance.use(errorMiddleware);
  return instance;
}

beforeEach(() => vi.clearAllMocks());

describe('local auth routes', () => {
  it('reports only whether local admin access is enabled', async () => {
    await request(app(dependencies())).get('/auth/methods').expect(200, { localAdmin: true });
    await request(app(dependencies({ config: { enabled: false, email: '', password: '' } })))
      .get('/auth/methods')
      .expect(200, { localAdmin: false });
  });

  it('returns 404 when local access is disabled', async () => {
    await request(app(dependencies({ config: { enabled: false, email: '', password: '' } })))
      .post('/auth/local')
      .send({})
      .expect(404, { error: 'Not found', code: 'NOT_FOUND' });
  });

  it('sets the ordinary session cookie and returns SessionDto on success', async () => {
    const deps = dependencies();
    const response = await request(app(deps))
      .post('/auth/local')
      .send({ email: ' ADMIN@example.com ', password: 'correct horse battery staple' })
      .expect(200);

    expect(deps.authenticate).toHaveBeenCalledWith('admin@example.com', 'correct horse battery staple');
    expect(deps.createSession).toHaveBeenCalledWith(ADMIN.id);
    expect(response.headers['set-cookie']?.[0]).toContain('recat_session=session-token');
    expect(response.body.user.email).toBe(ADMIN.email);
  });

  it('uses one generic error for all invalid credentials', async () => {
    await request(app(dependencies({ authenticate: vi.fn(async () => null) })))
      .post('/auth/local')
      .send({ email: 'unknown@example.com', password: 'wrong-password' })
      .expect(401, { error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
  });

  it('uses the generic invalid-credentials error for malformed and empty bodies', async () => {
    const instance = app(dependencies());
    const invalidCredentials = { error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' };

    await request(instance).post('/auth/local').send({}).expect(401, invalidCredentials);
    await request(instance)
      .post('/auth/local')
      .send({ email: 'not-an-email', password: '' })
      .expect(401, invalidCredentials);
  });

  it('counts malformed credentials toward the failure budget', async () => {
    const instance = app(dependencies());
    const invalidCredentials = { error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .send({ email: '', password: '' })
        .expect(401, invalidCredentials);
    }
    const blocked = await request(instance)
      .post('/auth/local')
      .send({ email: '', password: '' })
      .expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('permits five failures, then returns 429 with Retry-After', async () => {
    const instance = app(dependencies({ authenticate: vi.fn(async () => null) }), TEST_PROXY_IPS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', '192.0.2.10')
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(401);
    }
    const blocked = await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '192.0.2.10')
      .send({ email: ADMIN.email, password: 'wrong-password' })
      .expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('reserves five synchronized authentication attempts and rate-limits the sixth', async () => {
    const authenticationGate = deferred<void>();
    const fifthAuthentication = deferred<void>();
    const sixthAuthentication = deferred<void>();
    const authenticate = vi.fn(async () => {
      if (authenticate.mock.calls.length === 5) fifthAuthentication.resolve();
      if (authenticate.mock.calls.length === 6) sixthAuthentication.resolve();
      await authenticationGate.promise;
      return null;
    });
    const instance = app(dependencies({ authenticate }));
    const responses = Array.from({ length: 6 }, () =>
      request(instance)
        .post('/auth/local')
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .then((response) => response),
    );

    await fifthAuthentication.promise;
    const rateLimited = Promise.any(
      responses.map(async (response) => {
        const result = await response;
        if (result.status !== 429) throw new Error(`Unexpected status ${result.status}`);
        return result;
      }),
    );

    let firstOutcome: 'rate-limited' | 'sixth-authentication';
    try {
      firstOutcome = await Promise.race([
        rateLimited.then(() => 'rate-limited' as const),
        sixthAuthentication.promise.then(() => 'sixth-authentication' as const),
      ]);
      expect(firstOutcome).toBe('rate-limited');
    } finally {
      authenticationGate.resolve();
      await Promise.all(responses);
    }

    const results = await Promise.all(responses);
    expect(authenticate).toHaveBeenCalledTimes(5);
    expect(results.map(({ status }) => status).sort()).toEqual([401, 401, 401, 401, 401, 429]);
    const blocked = results.find(({ status }) => status === 429);
    expect(Number(blocked?.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('releases an attempt whose authentication fails unexpectedly', async () => {
    const authenticate = vi.fn()
      .mockRejectedValueOnce(new Error('Authentication unavailable'))
      .mockResolvedValue(null);
    const instance = app(dependencies({ authenticate }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await request(instance)
        .post('/auth/local')
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(500);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(instance)
          .post('/auth/local')
          .send({ email: ADMIN.email, password: 'wrong-password' })
          .expect(401);
      }
      await request(instance)
        .post('/auth/local')
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(429);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('blocks a direct untrusted peer that rotates X-Forwarded-For values', async () => {
    const instance = app(dependencies({ authenticate: vi.fn(async () => null) }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', `192.0.2.${attempt + 1}`)
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(401);
    }
    const blocked = await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '192.0.2.6')
      .send({ email: ADMIN.email, password: 'wrong-password' })
      .expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('isolates forwarded clients behind an explicitly trusted proxy', async () => {
    const instance = app(dependencies({ authenticate: vi.fn(async () => null) }), TEST_PROXY_IPS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', '192.0.2.10')
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(401);
    }
    await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '192.0.2.10')
      .send({ email: ADMIN.email, password: 'wrong-password' })
      .expect(429);
    await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '192.0.2.11')
      .send({ email: ADMIN.email, password: 'wrong-password' })
      .expect(401);
  });

  it('does not trust a configured address beyond the immediate proxy hop', async () => {
    const fartherProxy = '198.51.100.10';
    const instance = app(
      dependencies({ authenticate: vi.fn(async () => null) }),
      `${TEST_PROXY_IPS},${fartherProxy}`,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', `192.0.2.${attempt + 1}, ${fartherProxy}`)
        .send({ email: ADMIN.email, password: 'wrong-password' })
        .expect(401);
    }
    const blocked = await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', `192.0.2.6, ${fartherProxy}`)
      .send({ email: ADMIN.email, password: 'wrong-password' })
      .expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('clears the direct source after rotated X-Forwarded-For values and restores five failures', async () => {
    const authenticate = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValue(null);
    const instance = app(dependencies({ authenticate }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', `192.0.2.${attempt + 1}`)
        .send({ email: ADMIN.email, password: 'wrong' })
        .expect(401);
    }
    await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '192.0.2.5')
      .send({ email: ADMIN.email, password: 'correct' })
      .expect(200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(instance)
        .post('/auth/local')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .send({ email: ADMIN.email, password: 'wrong' })
        .expect(401);
    }
    await request(instance)
      .post('/auth/local')
      .set('X-Forwarded-For', '198.51.100.6')
      .send({ email: ADMIN.email, password: 'wrong' })
      .expect(429);
  });
});
