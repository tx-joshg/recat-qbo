import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../lib/crypto.js';
import { HttpError, errorMiddleware } from '../lib/http.js';
import { QboAuthError } from '../lib/qbo/types.js';

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  forCompany: vi.fn(),
  inspectAuthorizedConnection: vi.fn(),
  installDemoFinancials: vi.fn(),
  companyCreate: vi.fn(),
  companyFindMany: vi.fn(),
  companyFindUnique: vi.fn(),
  companyUpdate: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    appConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    company: {
      create: mocks.companyCreate,
      findMany: mocks.companyFindMany,
      findUnique: mocks.companyFindUnique,
      update: mocks.companyUpdate,
    },
  },
}));

vi.mock('../env.js', () => ({
  env: {
    APP_URL: 'https://recat.example',
    ENCRYPTION_KEY: '0'.repeat(64),
    QBO_ENVIRONMENT: 'production',
  },
}));

vi.mock('../lib/qbo/factory.js', () => ({
  inspectAuthorizedConnection: mocks.inspectAuthorizedConnection,
  isMockRealmId: vi.fn((realmId: string) => realmId === '9341002287640001'),
  qboFactory: {
    exchangeCode: mocks.exchangeCode,
    forCompany: mocks.forCompany,
  },
}));

vi.mock('../services/demoFinancials.js', () => ({
  installDemoFinancials: mocks.installDemoFinancials,
}));

vi.mock('../middleware/auth.js', () => {
  const requireUser: RequestHandler = (req, _res, next) => {
    if (req.header('x-test-user') !== 'admin') {
      next(new HttpError(401, 'Not signed in', 'UNAUTHENTICATED'));
      return;
    }
    req.user = {
      id: 'admin-user',
      isInstanceAdmin: true,
      memberships: [],
    } as NonNullable<typeof req.user>;
    next();
  };
  return {
    requireUser,
    requireInstanceAdmin: ((_req, _res, next) => next()) satisfies RequestHandler,
  };
});

import { createOauthState, qboOauthRouter } from './qboOauth.js';

const servers: Server[] = [];

function testApp(): Express {
  const app = express();
  app.use(qboOauthRouter);
  app.use(errorMiddleware);
  return app;
}

async function callback(path: string): Promise<Response> {
  const server = testApp().listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { 'x-test-user': 'admin' },
    redirect: 'manual',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exchangedTokens = {
    accessToken: 'exchanged-access-token',
    refreshToken: 'exchanged-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  const inspectedTokens = {
    accessToken: 'inspected-access-token',
    refreshToken: 'inspected-refresh-token',
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  };
  mocks.exchangeCode.mockResolvedValue(exchangedTokens);
  mocks.inspectAuthorizedConnection.mockResolvedValue({
    info: { realmId: 'REALM-1', legalName: 'Example Books LLC' },
    tokens: inspectedTokens,
  });
  mocks.forCompany.mockResolvedValue({
    getCompanyInfo: vi.fn().mockResolvedValue({
      realmId: 'REALM-1',
      legalName: 'Example Books LLC',
    }),
  });
  mocks.installDemoFinancials.mockResolvedValue(undefined);
  mocks.companyFindMany.mockResolvedValue([]);
  mocks.companyFindUnique.mockResolvedValue(null);
  mocks.companyCreate.mockImplementation(async ({ data }) => ({
    id: 'new-company',
    ...data,
  }));
  mocks.companyUpdate.mockImplementation(async ({ where, data }) => ({
    id: where.id,
    ...data,
  }));
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
  vi.restoreAllMocks();
});

describe('QuickBooks OAuth callback failure redirects', () => {
  it('consumes state before mapping access_denied to a sanitized redirect', async () => {
    const state = createOauthState({ mode: 'real', env: 'production' });
    const first = await callback(
      `/auth/qbo/callback?state=${state}&error=access_denied&error_description=RAW_BODY_SENTINEL`,
    );
    const second = await callback(
      `/auth/qbo/callback?state=${state}&error=access_denied&error_description=RAW_BODY_SENTINEL`,
    );

    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=ACCESS_DENIED',
    );
    expect(first.headers.get('location')).not.toContain('RAW_BODY_SENTINEL');
    expect(second.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=STATE_EXPIRED',
    );
  });

  it('redirects an expired state with only STATE_EXPIRED', async () => {
    const state = createOauthState(
      { mode: 'real', env: 'production' },
      Date.now() - 10 * 60 * 1000 - 1,
    );
    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=CODE_SENTINEL&realmId=REALM_SENTINEL`,
    );
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBe('https://recat.example/setup?qbo_error=STATE_EXPIRED');
    expect(location).not.toContain('CODE_SENTINEL');
    expect(location).not.toContain('REALM_SENTINEL');
  });

  it('redirects a typed auth failure with only its public enum', async () => {
    mocks.exchangeCode.mockRejectedValue(
      new QboAuthError(
        'RAW_BODY_SENTINEL TOKEN_SENTINEL CODE_SENTINEL stack trace',
        'INVALID_CLIENT_CREDENTIALS',
      ),
    );
    const state = createOauthState({ mode: 'real', env: 'production' });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=CODE_SENTINEL&realmId=REALM_SENTINEL`,
    );
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBe(
      'https://recat.example/setup?qbo_error=INVALID_CLIENT_CREDENTIALS',
    );
    expect(location).not.toContain('RAW_BODY_SENTINEL');
    expect(location).not.toContain('TOKEN_SENTINEL');
    expect(location).not.toContain('CODE_SENTINEL');
    expect(location).not.toContain('REALM_SENTINEL');
  });
});

describe('QuickBooks OAuth callback publication', () => {
  it('validates CompanyInfo before creating a new real connected company', async () => {
    const state = createOauthState({ mode: 'real', env: 'production' });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=AUTH_CODE&realmId=REALM-1`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?connected=new-company',
    );
    expect(mocks.inspectAuthorizedConnection).toHaveBeenCalledTimes(1);
    expect(mocks.companyCreate).toHaveBeenCalledTimes(1);
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
    expect(mocks.inspectAuthorizedConnection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.companyCreate.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.companyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        realmId: 'REALM-1',
        legalName: 'Example Books LLC',
        nickname: 'Example Books',
        env: 'production',
        disconnectedAt: null,
      }),
    });
    const published = mocks.companyCreate.mock.calls[0]?.[0].data;
    expect(decrypt(published.accessToken)).toBe('inspected-access-token');
    expect(decrypt(published.refreshToken)).toBe('inspected-refresh-token');
  });

  it('publishes a successful reconnect in one update after validation', async () => {
    const existing = {
      id: 'existing-company',
      realmId: 'REALM-1',
      legalName: 'Old Legal Name',
      nickname: 'Keep This Nickname',
      env: 'production',
      disconnectedAt: null,
      accessToken: 'old-encrypted-access',
      refreshToken: 'old-encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 60_000),
    };
    mocks.companyFindUnique.mockResolvedValue(existing);
    mocks.companyUpdate.mockImplementation(async ({ data }) => ({
      ...existing,
      ...data,
    }));
    const state = createOauthState({ mode: 'real', env: 'production' });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=AUTH_CODE&realmId=REALM-1`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?connected=existing-company',
    );
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.companyUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.inspectAuthorizedConnection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.companyUpdate.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.companyUpdate).toHaveBeenCalledWith({
      where: { id: 'existing-company' },
      data: expect.objectContaining({
        legalName: 'Example Books LLC',
        disconnectedAt: null,
        autopilotMode: 'off',
        autopilotLiveConfirmedAt: null,
      }),
    });
    expect(mocks.companyUpdate.mock.calls[0]?.[0].data).not.toHaveProperty('nickname');
    const published = mocks.companyUpdate.mock.calls[0]?.[0].data;
    expect(decrypt(published.accessToken)).toBe('inspected-access-token');
    expect(decrypt(published.refreshToken)).toBe('inspected-refresh-token');
  });

  it('keeps a new demo row disconnected until demo installation succeeds', async () => {
    const realmId = '9341002287640001';
    mocks.inspectAuthorizedConnection.mockResolvedValue({
      info: { realmId, legalName: 'Harbor & Main Coffee Co.' },
      tokens: {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    const state = createOauthState({ mode: 'demo', env: null });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=mock-harbor&realmId=${realmId}`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?connected=new-company',
    );
    const pendingData = mocks.companyCreate.mock.calls[0]?.[0].data;
    expect(pendingData.disconnectedAt).toBeInstanceOf(Date);
    expect(pendingData.accessToken).toBeUndefined();
    expect(pendingData.refreshToken).toBeUndefined();
    expect(mocks.companyCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installDemoFinancials.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.installDemoFinancials.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.companyUpdate.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.installDemoFinancials).toHaveBeenCalledWith(
      'new-company',
      realmId,
    );
    expect(mocks.companyUpdate).toHaveBeenCalledWith({
      where: { id: 'new-company' },
      data: expect.objectContaining({ disconnectedAt: null }),
    });
    const published = mocks.companyUpdate.mock.calls[0]?.[0].data;
    expect(decrypt(published.accessToken)).toBe('mock-access-token');
    expect(decrypt(published.refreshToken)).toBe('mock-refresh-token');
  });

  it('does not create a connected row when CompanyInfo fails after exchange', async () => {
    const failure = new Error('RAW_COMPANY_INFO_SENTINEL');
    mocks.inspectAuthorizedConnection.mockRejectedValue(failure);
    mocks.forCompany.mockResolvedValue({
      getCompanyInfo: vi.fn().mockRejectedValue(failure),
    });
    const state = createOauthState({ mode: 'real', env: 'production' });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=AUTH_CODE&realmId=REALM-1`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=COMPANY_INFO_FAILED',
    );
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
  });

  it('preserves a healthy existing connection when replacement CompanyInfo fails', async () => {
    const existing = {
      id: 'existing-company',
      realmId: 'REALM-1',
      legalName: 'Healthy Books LLC',
      nickname: 'Healthy Books',
      env: 'production',
      disconnectedAt: null,
      accessToken: 'old-encrypted-access',
      refreshToken: 'old-encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 60_000),
    };
    mocks.companyFindUnique.mockResolvedValue(existing);
    const failure = new Error('RAW_COMPANY_INFO_SENTINEL');
    mocks.inspectAuthorizedConnection.mockRejectedValue(failure);
    mocks.forCompany.mockResolvedValue({
      getCompanyInfo: vi.fn().mockRejectedValue(failure),
    });
    const state = createOauthState({ mode: 'real', env: 'production' });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=AUTH_CODE&realmId=REALM-1`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=COMPANY_INFO_FAILED',
    );
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
    expect(existing.accessToken).toBe('old-encrypted-access');
    expect(existing.refreshToken).toBe('old-encrypted-refresh');
    expect(existing.disconnectedAt).toBeNull();
  });

  it('leaves a new demo row disconnected when installation fails', async () => {
    const realmId = '9341002287640001';
    mocks.inspectAuthorizedConnection.mockResolvedValue({
      info: { realmId, legalName: 'Harbor & Main Coffee Co.' },
      tokens: {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    mocks.installDemoFinancials.mockRejectedValue(
      new Error('DEMO_INSTALL_SENTINEL'),
    );
    const state = createOauthState({ mode: 'demo', env: null });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=mock-harbor&realmId=${realmId}`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=QBO_CONNECTION_FAILED',
    );
    expect(mocks.companyCreate.mock.calls[0]?.[0].data.disconnectedAt).toBeInstanceOf(
      Date,
    );
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
  });

  it('preserves an existing demo connection when installation fails', async () => {
    const realmId = '9341002287640001';
    const existing = {
      id: 'existing-demo',
      realmId,
      legalName: 'Harbor & Main Coffee Co.',
      nickname: 'Harbor',
      env: 'sandbox',
      disconnectedAt: null,
      accessToken: 'old-demo-access',
      refreshToken: 'old-demo-refresh',
      tokenExpiresAt: new Date(Date.now() + 60_000),
    };
    mocks.companyFindUnique.mockResolvedValue(existing);
    mocks.inspectAuthorizedConnection.mockResolvedValue({
      info: { realmId, legalName: 'Harbor & Main Coffee Co.' },
      tokens: {
        accessToken: 'replacement-demo-access',
        refreshToken: 'replacement-demo-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    mocks.installDemoFinancials.mockRejectedValue(
      new Error('DEMO_INSTALL_SENTINEL'),
    );
    const state = createOauthState({ mode: 'demo', env: null });

    const response = await callback(
      `/auth/qbo/callback?state=${state}&code=mock-harbor&realmId=${realmId}`,
    );

    expect(response.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=QBO_CONNECTION_FAILED',
    );
    expect(mocks.companyCreate).not.toHaveBeenCalled();
    expect(mocks.companyUpdate).not.toHaveBeenCalled();
    expect(existing.accessToken).toBe('old-demo-access');
    expect(existing.refreshToken).toBe('old-demo-refresh');
    expect(existing.disconnectedAt).toBeNull();
  });

  it('resumes a failed pending demo with a fresh flow and stamps publication time', async () => {
    const realmId = '9341002287640001';
    const pendingConnectedAt = new Date('2020-01-01T00:00:00.000Z');
    let stored: Record<string, any> | null = null;
    mocks.companyFindUnique.mockImplementation(async () => stored);
    mocks.companyCreate.mockImplementation(async ({ data }) => {
      stored = {
        id: 'pending-demo',
        connectedAt: pendingConnectedAt,
        ...data,
      };
      return stored;
    });
    mocks.companyUpdate.mockImplementation(async ({ data }) => {
      stored = { ...stored, ...data };
      return stored;
    });
    mocks.inspectAuthorizedConnection.mockResolvedValue({
      info: { realmId, legalName: 'Harbor & Main Coffee Co.' },
      tokens: {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    mocks.installDemoFinancials
      .mockRejectedValueOnce(new Error('DEMO_INSTALL_SENTINEL'))
      .mockResolvedValueOnce(undefined);

    const failedState = createOauthState({ mode: 'demo', env: null });
    const failed = await callback(
      `/auth/qbo/callback?state=${failedState}&code=mock-harbor&realmId=${realmId}`,
    );

    expect(failed.headers.get('location')).toBe(
      'https://recat.example/setup?qbo_error=QBO_CONNECTION_FAILED',
    );
    expect(stored?.disconnectedAt).toBeInstanceOf(Date);
    expect(mocks.companyUpdate).not.toHaveBeenCalled();

    const freshState = createOauthState({ mode: 'demo', env: null });
    const resumed = await callback(
      `/auth/qbo/callback?state=${freshState}&code=mock-harbor&realmId=${realmId}`,
    );

    expect(resumed.headers.get('location')).toBe(
      'https://recat.example/setup?connected=pending-demo',
    );
    expect(mocks.companyCreate).toHaveBeenCalledTimes(1);
    expect(mocks.installDemoFinancials).toHaveBeenCalledTimes(2);
    expect(mocks.companyUpdate).toHaveBeenCalledTimes(1);
    const publication = mocks.companyUpdate.mock.calls[0]?.[0].data;
    expect(publication.disconnectedAt).toBeNull();
    expect(publication.connectedAt).toBeInstanceOf(Date);
    expect(publication.connectedAt.getTime()).toBeGreaterThan(
      pendingConnectedAt.getTime(),
    );
    expect(stored?.disconnectedAt).toBeNull();
    expect(stored?.connectedAt.getTime()).toBe(publication.connectedAt.getTime());
  });
});
