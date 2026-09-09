import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  origins: new Set<string>(['http://umbrel.local:3009']),
  throws: false,
}));

vi.mock('../services/publicUrl.js', () => ({
  allowedOrigins: async () => {
    if (mocks.throws) throw new Error('unavailable');
    return mocks.origins;
  },
}));

vi.mock('../env.js', () => ({
  // auth.ts pulls in lib/crypto transitively, which needs a valid key at import.
  env: { APP_URL: 'http://umbrel.local:3009', ENCRYPTION_KEY: '0'.repeat(64) },
  isProd: false,
}));

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

import { originCheck, requireBrowserMutationOrigin } from './auth.js';

function run(method: string, origin?: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = { method, headers: origin === undefined ? {} : { origin } } as Request;
    const next: NextFunction = (err?: unknown) => resolve(err);
    originCheck(req, {} as Response, next);
  });
}

function runStrict(origin?: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: origin === undefined ? {} : { origin } } as Request;
    requireBrowserMutationOrigin(req, {} as Response, (err?: unknown) => resolve(err));
  });
}

beforeEach(() => {
  mocks.origins = new Set(['http://umbrel.local:3009']);
  mocks.throws = false;
});

describe('originCheck', () => {
  it('requires an allowed Origin on cookie-authenticated policy mutations', async () => {
    await expect(runStrict()).resolves.toMatchObject({ status: 403, code: 'BAD_ORIGIN' });
    await expect(runStrict('http://umbrel.local:3009')).resolves.toBeUndefined();
  });
  it('passes a mutating request from an allowed origin', async () => {
    await expect(run('POST', 'http://umbrel.local:3009')).resolves.toBeUndefined();
  });

  it('passes a mutating request from any configured origin', async () => {
    mocks.origins = new Set(['http://umbrel.local:3009', 'https://recat.example.ts.net']);
    await expect(run('PATCH', 'https://recat.example.ts.net')).resolves.toBeUndefined();
  });

  it('rejects an unrelated origin', async () => {
    await expect(run('POST', 'https://evil.example')).resolves.toMatchObject({
      status: 403,
      code: 'BAD_ORIGIN',
    });
  });

  it('rejects an unparseable origin', async () => {
    await expect(run('DELETE', 'not-a-url')).resolves.toMatchObject({ code: 'BAD_ORIGIN' });
  });

  it('passes when no Origin header is present', async () => {
    await expect(run('POST')).resolves.toBeUndefined();
  });

  it('ignores non-mutating methods entirely', async () => {
    await expect(run('GET', 'https://evil.example')).resolves.toBeUndefined();
  });

  it('fails closed when the allowed set cannot be resolved', async () => {
    // Better to reject writes than to accept every origin while the source of
    // truth is unavailable.
    mocks.throws = true;
    await expect(run('POST', 'http://umbrel.local:3009')).resolves.toMatchObject({
      code: 'BAD_ORIGIN',
    });
  });

  it('still admits the deployment origin when a bad public URL is configured', async () => {
    // The lockout guard, at the middleware level: a mistyped public URL adds a
    // useless origin but must never remove the one the operator is using, or
    // the PATCH that fixes it would be rejected too.
    mocks.origins = new Set(['http://umbrel.local:3009', 'https://typo.example']);
    await expect(run('PATCH', 'http://umbrel.local:3009')).resolves.toBeUndefined();
  });
});
