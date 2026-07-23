import { describe, expect, it, vi } from 'vitest';
import type { LocalAdminConfig } from './localAdminConfig.js';
import { authenticateLocalAdmin, type LocalAdminUserReader } from './localAdminAuth.js';

const ENABLED: LocalAdminConfig = {
  enabled: true,
  email: 'admin@example.com',
  password: 'correct horse battery staple',
};

function reader(user: Awaited<ReturnType<LocalAdminUserReader['user']['findUnique']>>): LocalAdminUserReader {
  return { user: { findUnique: async () => user } };
}

const ADMIN = {
  id: 'u1',
  email: 'admin@example.com',
  name: null,
  isInstanceAdmin: true,
  invitePending: false,
  dashboardLayout: null,
  createdAt: new Date(),
  memberships: [],
};

describe('authenticateLocalAdmin', () => {
  it('accepts only the configured existing instance admin', async () => {
    await expect(
      authenticateLocalAdmin('  ADMIN@example.com ', ENABLED.password, ENABLED, reader(ADMIN)),
    ).resolves.toEqual(ADMIN);
  });

  it.each([
    ['other@example.com', ENABLED.password],
    [ENABLED.email, 'wrong'],
    [ENABLED.email, `${ENABLED.password}-wrong`],
  ])('rejects a mismatched email or password', async (email, password) => {
    await expect(authenticateLocalAdmin(email, password, ENABLED, reader(ADMIN))).resolves.toBeNull();
  });

  it('queries only the configured administrator email', async () => {
    const findUnique = vi.fn(async () => ADMIN);

    await authenticateLocalAdmin('other@example.com', ENABLED.password, ENABLED, {
      user: { findUnique },
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { email: ENABLED.email },
      include: { memberships: true },
    });
  });

  it('rejects a configured email whose database user is not an instance admin', async () => {
    await expect(
      authenticateLocalAdmin(
        ENABLED.email,
        ENABLED.password,
        ENABLED,
        reader({ ...ADMIN, isInstanceAdmin: false }),
      ),
    ).resolves.toBeNull();
  });

  it('rejects a configured email with no existing user', async () => {
    await expect(
      authenticateLocalAdmin(ENABLED.email, ENABLED.password, ENABLED, reader(null)),
    ).resolves.toBeNull();
  });

  it('does not query users when local access is disabled', async () => {
    let queried = false;
    const db: LocalAdminUserReader = {
      user: { findUnique: async () => { queried = true; return ADMIN; } },
    };
    await expect(
      authenticateLocalAdmin('admin@example.com', 'any-password', { enabled: false, email: '', password: '' }, db),
    ).resolves.toBeNull();
    expect(queried).toBe(false);
  });
});
