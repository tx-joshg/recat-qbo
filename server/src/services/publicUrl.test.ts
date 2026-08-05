import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appUrl: 'http://umbrel.local:3009',
  stored: 'http://umbrel.local:3009',
  previous: '',
  throws: false,
}));

vi.mock('../env.js', () => ({
  env: {
    get APP_URL() {
      return mocks.appUrl;
    },
  },
  appUrlEnvManaged: false,
}));

vi.mock('./instanceSettings.js', () => ({
  getInstanceSettings: async () => {
    if (mocks.throws) throw new Error('database unavailable');
    return { appUrl: mocks.stored, previousAppUrl: mocks.previous };
  },
}));

import {
  allowedOrigins,
  invalidatePublicUrl,
  resolvePublicUrl,
  resolveRedirectUri,
} from './publicUrl.js';

beforeEach(() => {
  mocks.appUrl = 'http://umbrel.local:3009';
  mocks.stored = 'http://umbrel.local:3009';
  mocks.previous = '';
  mocks.throws = false;
  invalidatePublicUrl();
});

describe('resolvePublicUrl', () => {
  it('uses the stored address and strips a trailing slash', async () => {
    mocks.stored = 'https://recat.example.ts.net/';
    await expect(resolvePublicUrl()).resolves.toBe('https://recat.example.ts.net');
  });

  it('builds the redirect URI from the stored address', async () => {
    mocks.stored = 'https://recat.example.ts.net';
    await expect(resolveRedirectUri()).resolves.toBe(
      'https://recat.example.ts.net/auth/qbo/callback',
    );
  });

  it('falls back to the environment when settings are unavailable', async () => {
    mocks.throws = true;
    await expect(resolvePublicUrl()).resolves.toBe('http://umbrel.local:3009');
  });

  it('serves a cached value until invalidated', async () => {
    await resolvePublicUrl();
    mocks.stored = 'https://changed.example';
    await expect(resolvePublicUrl()).resolves.toBe('http://umbrel.local:3009');
    invalidatePublicUrl();
    await expect(resolvePublicUrl()).resolves.toBe('https://changed.example');
  });
});

describe('allowedOrigins', () => {
  it('accepts both the environment and the stored address', async () => {
    mocks.stored = 'https://recat.example.ts.net';
    const allowed = await allowedOrigins();
    expect(allowed.has('http://umbrel.local:3009')).toBe(true);
    expect(allowed.has('https://recat.example.ts.net')).toBe(true);
  });

  it('rejects an unrelated origin', async () => {
    const allowed = await allowedOrigins();
    expect(allowed.has('https://evil.example')).toBe(false);
  });

  it('keeps the environment origin when the stored address is wrong', async () => {
    // The lockout guard. An operator who saves a bad public URL must still be
    // able to reach the instance on the address the deployment shipped with —
    // otherwise the request that would correct the mistake is itself rejected.
    mocks.stored = 'https://typo.example';
    const allowed = await allowedOrigins();
    expect(allowed.has('http://umbrel.local:3009')).toBe(true);
  });

  it('keeps the address in use before the last change', async () => {
    // The typo case the environment origin alone does not cover: an operator on
    // a packaged install may only ever reach the instance through the address
    // they configured, so dropping it on save would strand them.
    mocks.previous = 'https://working.example.ts.net';
    mocks.stored = 'https://typo.example';
    const allowed = await allowedOrigins();
    expect(allowed.has('https://working.example.ts.net')).toBe(true);
    expect(allowed.has('https://typo.example')).toBe(true);
  });

  it('ignores an empty previous address', async () => {
    mocks.previous = '';
    const allowed = await allowedOrigins();
    expect(allowed.has('')).toBe(false);
  });

  it('keeps the environment origin even when settings cannot be read', async () => {
    mocks.throws = true;
    const allowed = await allowedOrigins();
    expect(allowed.has('http://umbrel.local:3009')).toBe(true);
  });
});
