import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  testStoredQboConnection: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique },
  },
}));
vi.mock('../lib/qbo/factory.js', () => ({
  testStoredQboConnection: mocks.testStoredQboConnection,
}));
vi.mock('../services/instanceSettings.js', () => ({
  getInstanceSettings: vi.fn(),
  getInstanceSettingsDto: vi.fn(),
  updateInstanceSettings: vi.fn(),
}));
vi.mock('../lib/mailer.js', () => ({
  invalidateMailerCache: vi.fn(),
  isSmtpConfigured: vi.fn(),
  sendMail: vi.fn(),
}));
vi.mock('../services/devLogin.js', () => ({ devLoginAllowed: vi.fn() }));
vi.mock('../services/magicLink.js', () => ({ issueMagicLink: vi.fn() }));

import { errorMiddleware } from '../lib/http.js';
import { instanceRouter } from './instance.js';

const RAW_SESSION = 'raw-session-cookie';
const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];

async function request(
  body: unknown,
  { cookie = RAW_SESSION }: { cookie?: string | null } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/instance', instanceRouter);
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie !== null) headers.Cookie = `recat_session=${cookie}`;
  return fetch(`http://127.0.0.1:${port}/api/instance/settings/test-qbo`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'admin-1',
      email: 'admin@example.com',
      isInstanceAdmin: true,
      memberships: [],
    },
  });
  mocks.testStoredQboConnection.mockResolvedValue({ kind: 'verified' });
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (active) => new Promise<void>((resolve) => active.close(() => resolve())),
    ),
  );
});

describe('QuickBooks connection test', () => {
  it('uses the active company for an authoritative stored-connection probe', async () => {
    const response = await request({ companyId: 'company-1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.testStoredQboConnection).toHaveBeenCalledWith('company-1');
  });

  it('requires an authenticated instance admin', async () => {
    const signedOut = await request({ companyId: 'company-1' }, { cookie: null });
    expect(signedOut.status).toBe(401);

    mocks.sessionFindUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        email: 'user@example.com',
        isInstanceAdmin: false,
        memberships: [],
      },
    });
    const nonAdmin = await request({ companyId: 'company-1' });
    expect(nonAdmin.status).toBe(403);
  });

  it('rejects an invalid company id before calling QuickBooks', async () => {
    const response = await request({ companyId: '   ' });

    expect(response.status).toBe(400);
    expect(mocks.testStoredQboConnection).not.toHaveBeenCalled();
  });

  it('does not report a demo company as an Intuit verification', async () => {
    mocks.testStoredQboConnection.mockResolvedValueOnce({ kind: 'demo' });

    const response = await request({ companyId: 'demo-company' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Choose a real QuickBooks company to test the stored Intuit credentials.',
      code: 'QBO_DEMO_COMPANY',
    });
  });

  it('returns a useful connection error without reporting success', async () => {
    mocks.testStoredQboConnection.mockRejectedValueOnce(new Error('token expired'));

    const response = await request({ companyId: 'company-1' });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        'QuickBooks connection failed. Reconnect QuickBooks or verify the stored Intuit credentials.',
      code: 'QBO_CONNECTION_FAILED',
    });
  });
});
