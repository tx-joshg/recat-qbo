import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, errorMiddleware } from '../lib/http.js';
import { QboAuthError } from '../lib/qbo/types.js';

const mocks = vi.hoisted(() => ({
  companyFindUnique: vi.fn(),
  getIntuitCredentialPreflight: vi.fn(),
  testCompanyConnection: vi.fn(),
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
  hasIntuitCredentials: vi.fn().mockResolvedValue(true),
  isMockRealmId: vi.fn().mockReturnValue(false),
  qboFactory: {
    authorizeUrl: vi.fn(),
    forCompany: vi.fn(),
    revoke: vi.fn(),
  },
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
