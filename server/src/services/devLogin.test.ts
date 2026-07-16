// devLink auto-lock: allowed while the instance holds only demo companies (or
// none), locked the moment a real (non-mock-realm) company is connected, and
// force-enabled by ALLOW_DEV_LOGIN=true regardless.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowDevLogin: false,
  count: vi.fn(),
}));

vi.mock('../env.js', () => ({
  env: {
    get ALLOW_DEV_LOGIN() {
      return mocks.allowDevLogin;
    },
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { company: { count: mocks.count } },
}));

import { devLoginAllowed } from './devLogin.js';
import { MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from '../lib/qbo/mock.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowDevLogin = false;
});

describe('devLoginAllowed', () => {
  it('is allowed when no real company is connected (demo-only or empty instance)', async () => {
    mocks.count.mockResolvedValue(0);
    await expect(devLoginAllowed()).resolves.toBe(true);
    // The count must exclude the demo realms and disconnected companies.
    const where = mocks.count.mock.calls[0]?.[0]?.where as {
      disconnectedAt: null;
      realmId: { notIn: string[] };
    };
    expect(where.disconnectedAt).toBeNull();
    expect(where.realmId.notIn).toEqual(expect.arrayContaining([MOCK_REALM_HARBOR, MOCK_REALM_BLUEBIRD]));
  });

  it('locks as soon as a real company is connected', async () => {
    mocks.count.mockResolvedValue(1);
    await expect(devLoginAllowed()).resolves.toBe(false);
  });

  it('ALLOW_DEV_LOGIN=true forces it on without touching the database', async () => {
    mocks.allowDevLogin = true;
    mocks.count.mockResolvedValue(5);
    await expect(devLoginAllowed()).resolves.toBe(true);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});
