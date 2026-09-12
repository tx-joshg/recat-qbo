import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, errorMiddleware } from '../lib/http.js';
import { QboAuthError } from '../lib/qbo/types.js';

const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  getIntuitCredentialPreflight: vi.fn(),
  testCompanyConnection: vi.fn(),
  hasIntuitCredentials: vi.fn(),
  authorizeUrl: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    appConfig: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    company: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: mocks.companyFindUnique,
      update: vi.fn(),
    },
    user: {
      count: vi.fn().mockResolvedValue(1),
    },
  },
}));

vi.mock('../lib/qbo/factory.js', () => ({
  getIntuitCredentialPreflight: mocks.getIntuitCredentialPreflight,
  hasIntuitCredentials: mocks.hasIntuitCredentials,
  isMockRealmId: vi.fn().mockReturnValue(false),
  qboFactory: {
    authorizeUrl: mocks.authorizeUrl,
    forCompany: vi.fn(),
  },
  revokeCapturedQboToken: vi.fn(),
  testCompanyConnection: mocks.testCompanyConnection,
}));

vi.mock('../middleware/auth.js', () => {
  const requireUser: RequestHandler = (req, _res, next) => {
    const role = req.header('x-test-user');
    if (!role) {
      next(new HttpError(401, 'Not signed in', 'UNAUTHENTICATED'));
      return;
    }
    req.user = {
      id: `${role}-user`,
      isInstanceAdmin: role === 'admin',
      memberships: [],
    } as NonNullable<typeof req.user>;
    next();
  };
  const requireInstanceAdmin: RequestHandler = (req, _res, next) => {
    if (!req.user?.isInstanceAdmin) {
      next(new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN'));
      return;
    }
    next();
  };
  return {
    requireUser,
    requireInstanceAdmin,
    requireRole: () => ((_req, _res, next) => next()) satisfies RequestHandler,
  };
});

import { companiesRouter } from './companies.js';
import { instanceRouter } from './instance.js';

const servers: Server[] = [];

function testApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/instance', instanceRouter);
  app.use('/api/companies', companiesRouter);
  app.use(errorMiddleware);
  return app;
}

async function request(
  app: Express,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasIntuitCredentials.mockResolvedValue(true);
  mocks.authorizeUrl.mockImplementation(async (_state: string, mode: string) => mode === 'demo'
    ? '/auth/qbo/mock-consent?state=synthetic-state' : 'https://appcenter.intuit.com/synthetic-authorize');
  mocks.getIntuitCredentialPreflight.mockResolvedValue({
    ok: true,
    clientIdConfigured: true,
    clientSecretConfigured: true,
    environment: 'production',
    redirectUri: 'https://recat.example/auth/qbo/callback',
    requiresOAuth: true,
  });
  mocks.companyFindUnique.mockResolvedValue({
    id: 'company-1',
    disconnectedAt: null,
  });
  mocks.testCompanyConnection.mockResolvedValue({
    ok: true,
    companyId: 'company-1',
    legalName: 'Example Books LLC',
    environment: 'production',
    mode: 'quickbooks',
    checkedAt: new Date().toISOString(),
  });
});

describe('connect flow credential failures', () => {
  it.each([
    { mode: 'Demo' }, { mode: 'unknown' }, { mode: ['real', 'demo'] },
    { mode: 'real', env: 'unknown' },
  ])('rejects malformed choices before a failing credential read', async (body) => {
    mocks.hasIntuitCredentials.mockRejectedValue(new Error('synthetic-settings-failure'));
    const response = await request(testApp(), '/api/companies/connect', {
      headers: { 'x-test-user': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.hasIntuitCredentials).not.toHaveBeenCalled();
    expect(mocks.authorizeUrl).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'])('keeps explicit demo setup independent of unreadable Intuit settings through %s', async (method) => {
    mocks.hasIntuitCredentials.mockRejectedValue(new Error('synthetic-settings-failure'));
    const response = await request(testApp(), method === 'GET'
      ? '/api/companies/connect-url?mode=demo' : '/api/companies/connect', {
      method, headers: { 'x-test-user': 'admin', 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ mode: 'demo' }) } : {}),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: '/auth/qbo/mock-consent?state=synthetic-state' });
    expect(mocks.hasIntuitCredentials).not.toHaveBeenCalled();
    expect(mocks.authorizeUrl).toHaveBeenCalledWith(expect.any(String), 'demo');
  });

  it('returns actionable bounded failure for real setup without logging or exposing settings details', async () => {
    mocks.hasIntuitCredentials.mockRejectedValue(new Error('synthetic-sensitive-settings-detail'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(testApp(), '/api/companies/connect', {
        headers: { 'x-test-user': 'admin', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'real' }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ code: 'QBO_CREDENTIALS_UNAVAILABLE',
        error: 'Current Intuit credentials could not be loaded. Check QuickBooks API access in Settings.' });
      expect(logged).not.toHaveBeenCalled();
      expect(mocks.authorizeUrl).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it('preserves the missing-credentials response when the current read succeeds but is empty', async () => {
    mocks.hasIntuitCredentials.mockResolvedValue(false);
    const response = await request(testApp(), '/api/companies/connect', {
      headers: { 'x-test-user': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'real' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'MISSING_CREDENTIALS' });
    expect(mocks.authorizeUrl).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe('QBO diagnostic route authorization', () => {
  it('rejects signed-out requests', async () => {
    const preflight = await request(testApp(), '/api/instance/qbo/preflight');
    const health = await request(testApp(), '/api/companies/company-1/test-connection');

    expect(preflight.status).toBe(401);
    expect(health.status).toBe(401);
  });

  it('rejects signed-in users who are not instance admins', async () => {
    const options = { headers: { 'x-test-user': 'member' } };
    const preflight = await request(testApp(), '/api/instance/qbo/preflight', options);
    const health = await request(
      testApp(),
      '/api/companies/company-1/test-connection',
      options,
    );

    expect(preflight.status).toBe(403);
    expect(health.status).toBe(403);
  });
});

describe('POST /api/instance/qbo/preflight', () => {
  it('returns the typed credential-presence response', async () => {
    const response = await request(testApp(), '/api/instance/qbo/preflight', {
      headers: { 'x-test-user': 'admin' },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      clientIdConfigured: true,
      clientSecretConfigured: true,
      environment: 'production',
      redirectUri: 'https://recat.example/auth/qbo/callback',
      requiresOAuth: true,
    });
  });
});

describe('POST /api/companies/:companyId/test-connection', () => {
  it('returns COMPANY_DISCONNECTED for a disconnected company', async () => {
    mocks.companyFindUnique.mockResolvedValue({
      id: 'company-1',
      disconnectedAt: new Date(),
    });
    mocks.testCompanyConnection.mockRejectedValue(
      new QboAuthError('DISCONNECTED_DETAIL_SENTINEL', 'COMPANY_DISCONNECTED'),
    );

    const response = await request(
      testApp(),
      '/api/companies/company-1/test-connection',
      { headers: { 'x-test-user': 'admin' } },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    expect(JSON.stringify(body)).not.toContain('DISCONNECTED_DETAIL_SENTINEL');
  });

  it('returns a stable code and generic message for a QBO health failure', async () => {
    mocks.testCompanyConnection.mockRejectedValue(
      new Error('RAW_QBO_BODY_SENTINEL stack/token detail'),
    );

    const response = await request(
      testApp(),
      '/api/companies/company-1/test-connection',
      { headers: { 'x-test-user': 'admin' } },
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      code: 'COMPANY_INFO_FAILED',
      error: 'QuickBooks connection test failed.',
    });
    expect(JSON.stringify(body)).not.toContain('RAW_QBO_BODY_SENTINEL');
  });
});
