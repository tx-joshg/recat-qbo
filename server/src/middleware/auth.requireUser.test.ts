// requireUser with prisma and the dev-login lock mocked: a session minted from
// a demo-mode devLink is revoked once a real company is connected, while an
// ordinary (emailed or logged) session keeps working.

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';
import { errorMiddleware } from '../lib/http.js';

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionDeleteMany: vi.fn(),
  devLoginAllowed: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { session: { findUnique: mocks.sessionFindUnique, deleteMany: mocks.sessionDeleteMany } },
}));

vi.mock('../services/devLogin.js', () => ({ devLoginAllowed: mocks.devLoginAllowed }));

const { requireUser, SESSION_COOKIE } = await import('./auth.js');

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.get('/whoami', requireUser, (req, res) => res.json({ id: req.user?.id }));
  app.use(errorMiddleware);
  return app;
}

const USER = { id: 'u1', email: 'admin@example.com', isInstanceAdmin: true, memberships: [] };

function session(viaExposedLink: boolean) {
  return {
    id: 's1',
    tokenHash: sha256Hex('tok'),
    userId: USER.id,
    user: USER,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    viaExposedLink,
  };
}

const get = () => request(testApp()).get('/whoami').set('Cookie', `${SESSION_COOKIE}=tok`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionDeleteMany.mockResolvedValue({ count: 1 });
  mocks.devLoginAllowed.mockResolvedValue(true);
});

describe('requireUser and devLink sessions', () => {
  it('lets a devLink session through while the instance is still demo-only', async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(true));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: USER.id });
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it('revokes a devLink session once real books are connected', async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(true));
    mocks.devLoginAllowed.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(401);
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('keeps an ordinary session working after real books are connected', async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(false));
    mocks.devLoginAllowed.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(200);
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it('does not consult the dev-login lock for an ordinary session', async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(false));
    await get();
    expect(mocks.devLoginAllowed).not.toHaveBeenCalled();
  });
});
