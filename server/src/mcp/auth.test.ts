import { OAuthError } from '@modelcontextprotocol/server';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';
import {
  createRecatBearerAuth,
  createRecatTokenVerifier,
  RECAT_MCP_SCOPE,
} from './auth.js';

const RAW_TOKEN = `rct_${'A'.repeat(43)}`;
const NOW = new Date('2026-07-28T20:00:00.000Z');
const EXPIRES_AT = new Date('2026-07-29T20:00:00.000Z');

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-id',
    prefix: RAW_TOKEN.slice(0, 12),
    digest: sha256Hex(RAW_TOKEN),
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    user: {
      id: 'user-id',
      isInstanceAdmin: false,
      memberships: [{ companyId: 'company-a', role: 'categorizer' }],
    },
    ...overrides,
  };
}

describe('createRecatTokenVerifier', () => {
  it('hashes the raw PAT, reloads the user graph, and returns only safe identity fields', async () => {
    const findUnique = vi.fn().mockResolvedValue(tokenRow());
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const verifier = createRecatTokenVerifier({
      db: { mcpToken: { findUnique, updateMany } },
      now: () => NOW,
    });

    const auth = await verifier.verifyAccessToken(RAW_TOKEN);

    expect(findUnique).toHaveBeenCalledWith({
      where: { digest: sha256Hex(RAW_TOKEN) },
      include: { user: { include: { memberships: true } } },
    });
    expect(auth).toEqual({
      token: 'token-id',
      clientId: 'recat-user:user-id',
      scopes: [RECAT_MCP_SCOPE],
      expiresAt: EXPIRES_AT.getTime() / 1_000,
      extra: {
        principal: {
          tokenId: 'token-id',
          tokenPrefix: RAW_TOKEN.slice(0, 12),
          userId: 'user-id',
          isInstanceAdmin: false,
          memberships: [{ companyId: 'company-a', role: 'categorizer' }],
        },
      },
    });
    expect(JSON.stringify(auth)).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(auth)).not.toContain(sha256Hex(RAW_TOKEN));
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['unknown', null],
    ['revoked', tokenRow({ revokedAt: NOW })],
    ['expired', tokenRow({ expiresAt: NOW })],
  ])('rejects an %s token with the same invalid-token shape', async (_case, row) => {
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique: vi.fn().mockResolvedValue(row),
          updateMany: vi.fn(),
        },
      },
      now: () => NOW,
    });

    await expect(verifier.verifyAccessToken(RAW_TOKEN)).rejects.toBeInstanceOf(OAuthError);
  });

  it.each([
    ['still demo-only', true, true],
    ['real books connected', false, false],
  ])('a token minted from a devLink session, %s, is accepted: %s', async (_case, allowed, accepted) => {
    const devLoginAllowed = vi.fn().mockResolvedValue(allowed);
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique: vi.fn().mockResolvedValue(tokenRow({ viaExposedSession: true })),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      },
      now: () => NOW,
      devLoginAllowed,
    });

    const result = verifier.verifyAccessToken(RAW_TOKEN);
    if (accepted) await expect(result).resolves.toMatchObject({ token: 'token-id' });
    else await expect(result).rejects.toBeInstanceOf(OAuthError);
  });

  it('does not consult the dev-login lock for an ordinary token', async () => {
    const devLoginAllowed = vi.fn().mockResolvedValue(false);
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique: vi.fn().mockResolvedValue(tokenRow()),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      },
      now: () => NOW,
      devLoginAllowed,
    });

    await expect(verifier.verifyAccessToken(RAW_TOKEN)).resolves.toMatchObject({ token: 'token-id' });
    expect(devLoginAllowed).not.toHaveBeenCalled();
  });

  it('rejects malformed PATs without querying storage', async () => {
    const findUnique = vi.fn();
    const verifier = createRecatTokenVerifier({
      db: { mcpToken: { findUnique, updateMany: vi.fn() } },
      now: () => NOW,
    });

    await expect(verifier.verifyAccessToken('short token')).rejects.toBeInstanceOf(OAuthError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not let an asynchronous last-used failure weaken successful authentication', async () => {
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique: vi.fn().mockResolvedValue(tokenRow()),
          updateMany: vi.fn().mockRejectedValue(new Error('storage unavailable')),
        },
      },
      now: () => NOW,
      onLastUsedError: vi.fn(),
    });

    await expect(verifier.verifyAccessToken(RAW_TOKEN)).resolves.toMatchObject({ token: 'token-id' });
  });

  it('keeps principals isolated across concurrent requests and observes membership changes', async () => {
    const rows = [
      tokenRow(),
      tokenRow({
        id: 'token-b',
        prefix: 'recat_mcp_ot',
        user: {
          id: 'user-b',
          isInstanceAdmin: true,
          memberships: [{ companyId: 'company-b', role: 'admin' }],
        },
      }),
    ];
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique: vi.fn().mockImplementation(async () => rows.shift() ?? null),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      },
      now: () => NOW,
    });

    const [first, second] = await Promise.all([
      verifier.verifyAccessToken(RAW_TOKEN),
      verifier.verifyAccessToken(`rct_${'B'.repeat(43)}`),
    ]);

    expect(first.extra?.principal).not.toBe(second.extra?.principal);
    expect(first.extra?.principal).toMatchObject({ userId: 'user-id' });
    expect(second.extra?.principal).toMatchObject({ userId: 'user-b' });
    expect(Object.isFrozen(first.extra?.principal)).toBe(true);
  });

  it('returns a Bearer challenge for missing or malformed authorization syntax before storage', async () => {
    const findUnique = vi.fn();
    const verifier = createRecatTokenVerifier({
      db: { mcpToken: { findUnique, updateMany: vi.fn() } },
      now: () => NOW,
    });
    const app = express();
    app.use(createRecatBearerAuth(verifier));
    app.post('/mcp', (_req, res) => res.status(204).end());

    for (const authorization of [undefined, 'Basic abc', 'Bearer', `Bearer ${RAW_TOKEN} extra`]) {
      const pending = request(app).post('/mcp');
      if (authorization !== undefined) pending.set('Authorization', authorization);
      const response = await pending.send({}).expect(401);
      expect(response.headers['www-authenticate']).toMatch(/^Bearer\b/);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});
