import { describe, expect, it } from 'vitest';
import type { Role } from '@recat/shared';
import {
  effectiveRole,
  originIsTrusted,
  parseTrustedOrigins,
  roleRank,
  sessionCookieOptions,
  type MembershipReader,
} from './auth.js';

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

describe('trusted browser origins', () => {
  it('includes APP_URL and explicitly configured http(s) origins', () => {
    const origins = parseTrustedOrigins(
      'https://recat.example:12443/setup',
      ' http://umbrel.local:12443, http://192.168.4.131:12443 ',
    );

    expect([...origins]).toEqual([
      'https://recat.example:12443',
      'http://umbrel.local:12443',
      'http://192.168.4.131:12443',
    ]);
    expect(originIsTrusted('http://umbrel.local:12443', origins)).toBe(true);
    expect(originIsTrusted('https://recat.example:12443', origins)).toBe(true);
  });

  it('rejects unconfigured, malformed, and non-http origins', () => {
    const origins = parseTrustedOrigins('https://recat.example', '');

    expect(originIsTrusted('https://attacker.example', origins)).toBe(false);
    expect(originIsTrusted('not a URL', origins)).toBe(false);
    expect(originIsTrusted('file:///tmp/recat', origins)).toBe(false);
  });

  it('fails startup configuration on invalid additional origins', () => {
    expect(() => parseTrustedOrigins('https://recat.example', 'not a URL')).toThrow(
      'TRUSTED_ORIGINS must contain valid absolute URLs',
    );
    expect(() => parseTrustedOrigins('https://recat.example', 'file:///tmp/recat')).toThrow(
      'TRUSTED_ORIGINS must contain only http(s) URLs',
    );
  });
});

describe('mixed-protocol session cookies', () => {
  it('uses Secure cookies for HTTPS browser origins', () => {
    expect(sessionCookieOptions('https://recat.example:12443').secure).toBe(true);
  });

  it('allows a session cookie on an explicitly trusted HTTP LAN origin', () => {
    expect(sessionCookieOptions('http://umbrel.local:12443').secure).toBe(false);
    expect(sessionCookieOptions('http://192.168.4.131:12443').secure).toBe(false);
  });
});
