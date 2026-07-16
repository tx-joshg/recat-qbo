import { describe, expect, it } from 'vitest';
import type { Role } from '@recat/shared';
import { effectiveRole, roleRank, type MembershipReader } from './auth.js';

/** Fake Membership table keyed by `${userId}:${companyId}`. */
function fakeDb(rows: Record<string, Role>): MembershipReader {
  return {
    membership: {
      findUnique: async ({ where }) => {
        const key = `${where.userId_companyId.userId}:${where.userId_companyId.companyId}`;
        const role = rows[key];
        return role !== undefined ? { role } : null;
      },
    },
  };
}

describe('effectiveRole', () => {
  it("returns 'admin' for an instance admin in ANY company, membership or not", async () => {
    const db = fakeDb({}); // no memberships at all
    const admin = { id: 'u1', isInstanceAdmin: true };
    expect(await effectiveRole(admin, 'co-a', db)).toBe('admin');
    expect(await effectiveRole(admin, 'co-b', db)).toBe('admin');
  });

  it("returns the membership role for a member of the company", async () => {
    const db = fakeDb({ 'u2:co-a': 'categorizer', 'u2:co-b': 'viewer' });
    const user = { id: 'u2', isInstanceAdmin: false };
    expect(await effectiveRole(user, 'co-a', db)).toBe('categorizer');
    expect(await effectiveRole(user, 'co-b', db)).toBe('viewer');
  });

  it('returns null for a non-member (no membership row in that company)', async () => {
    const db = fakeDb({ 'u3:co-a': 'admin' });
    const user = { id: 'u3', isInstanceAdmin: false };
    expect(await effectiveRole(user, 'co-b', db)).toBeNull();
  });

  it('instance-admin override wins even when an explicit membership exists', async () => {
    const db = fakeDb({ 'u4:co-a': 'viewer' });
    const user = { id: 'u4', isInstanceAdmin: true };
    expect(await effectiveRole(user, 'co-a', db)).toBe('admin');
  });
});

describe('roleRank', () => {
  it('orders viewer < categorizer < admin', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('categorizer'));
    expect(roleRank('categorizer')).toBeLessThan(roleRank('admin'));
  });
});
