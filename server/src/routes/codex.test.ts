import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
  test: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { session: { findUnique: mocks.sessionFindUnique } },
}));
vi.mock('../services/ai/codexAuth.js', () => ({
  startCodexDeviceFlow: mocks.start,
  pollCodexDeviceFlow: mocks.poll,
  cancelCodexDeviceFlow: mocks.cancel,
  getCodexStatus: mocks.status,
  disconnectCodex: mocks.disconnect,
}));
vi.mock('../services/ai/provider.js', () => ({ testCodexConnection: mocks.test }));

import { errorMiddleware } from '../lib/http.js';
import { originCheck } from '../middleware/auth.js';
import { codexRouter } from './codex.js';

const RAW_SESSION = 'raw-session-cookie';
const FLOW_ID = '123e4567-e89b-42d3-a456-426614174000';
const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];

async function request(
  path: string,
  { method = 'GET', body, origin, cookie = RAW_SESSION }: {
    method?: string;
    body?: unknown;
    origin?: string;
    cookie?: string | null;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(originCheck);
  app.use('/api/instance/ai/codex', codexRouter);
  app.use(errorMiddleware);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = `recat_session=${cookie}`;
  if (origin !== undefined) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}/api/instance/ai/codex${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  mocks.start.mockResolvedValue({
    flowId: FLOW_ID,
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: Date.now() + 900_000,
    intervalMs: 5000,
    status: 'pending',
  });
  mocks.poll.mockResolvedValue({ status: 'pending', retryAfterMs: 5000 });
  mocks.cancel.mockResolvedValue({ status: 'cancelled' });
  mocks.status.mockResolvedValue({
    connected: true,
    state: 'connected',
    accountLabel: 'o***@example.com',
    expiresAt: Date.now() + 3600_000,
  });
  mocks.disconnect.mockResolvedValue({ status: 'disconnected' });
  mocks.test.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (active) => new Promise<void>((resolve) => active.close(() => resolve())),
    ),
  );
});

describe('Codex admin routes', () => {
  it('requires an authenticated instance admin', async () => {
    const signedOut = await request('/status', { cookie: null });
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
    const nonAdmin = await request('/status');
    expect(nonAdmin.status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('inherits the CSRF Origin check for every mutating route', async () => {
    const response = await request('/device', {
      method: 'POST',
      origin: 'https://attacker.example',
    });
    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('hashes the raw session cookie and binds start, poll, and cancel to the same owner', async () => {
    expect((await request('/device', { method: 'POST' })).status).toBe(200);
    expect(
      (await request('/device/poll', { method: 'POST', body: { flowId: FLOW_ID } })).status,
    ).toBe(200);
    expect(
      (await request('/device', { method: 'DELETE', body: { flowId: FLOW_ID } })).status,
    ).toBe(200);

    const expectedOwner = { adminUserId: 'admin-1', sessionHash: sha256Hex(RAW_SESSION) };
    expect(mocks.start).toHaveBeenCalledWith(expectedOwner);
    expect(mocks.poll).toHaveBeenCalledWith({ flowId: FLOW_ID, ...expectedOwner });
    expect(mocks.cancel).toHaveBeenCalledWith({ flowId: FLOW_ID, ...expectedOwner });
    expect(JSON.stringify(mocks.start.mock.calls)).not.toContain(RAW_SESSION);
    expect(mocks.sessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256Hex(RAW_SESSION) } }),
    );
  });

  it('validates flow IDs before calling the session-bound service', async () => {
    const response = await request('/device/poll', { method: 'POST', body: { flowId: 'not-a-uuid' } });
    expect(response.status).toBe(400);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it('returns only masked status and exposes disconnect plus safe test actions', async () => {
    const statusResponse = await request('/status');
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json();
    expect(status).toEqual(expect.objectContaining({ accountLabel: 'o***@example.com' }));
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken|accountId|device_auth/i);

    expect((await request('', { method: 'DELETE' })).status).toBe(200);
    expect((await request('/test', { method: 'POST' })).status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.test).toHaveBeenCalledTimes(1);
  });
});
