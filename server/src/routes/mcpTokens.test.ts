import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireUser: ((req, _res, next) => {
    const userId = req.header('x-test-user-id');
    if (!userId) {
      next(new HttpError(401, 'Not signed in', 'UNAUTHENTICATED'));
      return;
    }
    req.user = { id: userId, memberships: [] } as unknown as NonNullable<typeof req.user>;
    next();
  }) satisfies RequestHandler,
}));

vi.mock('../services/mcp/tokens.js', () => ({
  createMcpToken: mocks.create,
  listMcpTokens: mocks.list,
  revokeMcpToken: mocks.revoke,
}));

import { mcpTokensRouter } from './mcpTokens.js';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const TOKEN_ID = '20000000-0000-4000-8000-000000000001';

function app(): Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/me/mcp-tokens', mcpTokensRouter);
  instance.use(errorMiddleware);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.create.mockResolvedValue({
    token: 'rct_one_time_plaintext',
    mcpToken: {
      id: TOKEN_ID,
      prefix: 'rct_one_time',
      label: 'Automation',
      status: 'active',
      createdAt: '2026-07-28T12:00:00.000Z',
      expiresAt: '2026-10-26T12:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    },
  });
  mocks.revoke.mockResolvedValue(undefined);
});

describe('/api/me/mcp-tokens', () => {
  it('requires a signed-in user for list, create, and revoke', async () => {
    const instance = app();
    const responses = await Promise.all([
      request(instance).get('/api/me/mcp-tokens'),
      request(instance).post('/api/me/mcp-tokens').send({ label: 'Automation' }),
      request(instance).delete(`/api/me/mcp-tokens/${TOKEN_ID}`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('passes only the current owner to list and create and returns plaintext only on create', async () => {
    const instance = app();
    const list = await request(instance).get('/api/me/mcp-tokens').set('x-test-user-id', USER_ID);
    const created = await request(instance)
      .post('/api/me/mcp-tokens')
      .set('x-test-user-id', USER_ID)
      .send({ label: ' Automation ', expiresInDays: 30 });

    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [], nextCursor: null });
    expect(mocks.list).toHaveBeenCalledWith(USER_ID, { limit: 20 });
    expect(created.status).toBe(201);
    expect(created.body.token).toBe('rct_one_time_plaintext');
    expect(mocks.create).toHaveBeenCalledWith({
      userId: USER_ID,
      label: 'Automation',
      expiresInDays: 30,
    });
  });

  it('bounds and strictly validates list pagination before the service', async () => {
    const instance = app();
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        createdAt: '2026-07-28T12:00:00.000Z',
        id: TOKEN_ID,
      }),
    ).toString('base64url');
    const allowed = await request(instance)
      .get(`/api/me/mcp-tokens?limit=100&cursor=${cursor}`)
      .set('x-test-user-id', USER_ID);

    expect(allowed.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(USER_ID, { limit: 100, cursor });

    mocks.list.mockClear();
    for (const query of [
      '?limit=101',
      '?limit=0',
      '?limit=2.5',
      `?cursor=${'x'.repeat(513)}`,
      '?cursor=not%20base64url',
      '?extra=true',
    ]) {
      const response = await request(instance)
        .get(`/api/me/mcp-tokens${query}`)
        .set('x-test-user-id', USER_ID);
      expect(response.status).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('validates bounded create input before the service', async () => {
    const instance = app();
    for (const body of [
      { label: '' },
      { label: 'x'.repeat(81) },
      { label: 'Automation', expiresInDays: 0 },
      { label: 'Automation', expiresInDays: 366 },
      { label: 'Automation', expiresInDays: 2.5 },
      { label: 'Automation', extra: true },
    ]) {
      const response = await request(instance)
        .post('/api/me/mcp-tokens')
        .set('x-test-user-id', USER_ID)
        .send(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('revokes by owner without revealing whether the token exists', async () => {
    const response = await request(app())
      .delete(`/api/me/mcp-tokens/${TOKEN_ID}`)
      .set('x-test-user-id', USER_ID);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(mocks.revoke).toHaveBeenCalledWith(USER_ID, TOKEN_ID);
  });
});
