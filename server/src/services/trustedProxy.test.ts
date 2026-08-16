import { describe, expect, it } from 'vitest';
import { compileTrustedProxy, hasUsableTrustedProxy, isPrivateAddress } from './trustedProxy.js';

describe('compileTrustedProxy', () => {
  it('trusts only trimmed exact IP entries and ignores empty entries', () => {
    const trust = compileTrustedProxy(' 192.0.2.10, ,2001:db8::10,');

    expect(trust('192.0.2.10', 0)).toBe(true);
    expect(trust('2001:db8::10', 0)).toBe(true);
    expect(trust('192.0.2.11', 0)).toBe(false);
    expect(trust('', 0)).toBe(false);
  });

  it('trusts no peers when the setting is empty', () => {
    const trust = compileTrustedProxy('');

    expect(trust('127.0.0.1', 0)).toBe(false);
    expect(trust('::1', 0)).toBe(false);
  });

  it('trusts a configured address only as the immediate peer', () => {
    const trust = compileTrustedProxy('192.0.2.10');

    expect(trust('192.0.2.10', 0)).toBe(true);
    expect(trust('192.0.2.10', 1)).toBe(false);
  });

  it('normalizes IPv4-mapped IPv6 addresses in either direction', () => {
    expect(compileTrustedProxy('192.0.2.10')('::ffff:192.0.2.10', 0)).toBe(true);
    expect(compileTrustedProxy('::ffff:192.0.2.10')('192.0.2.10', 0)).toBe(true);
  });

  it('does not interpret CIDR entries as broad trust', () => {
    const trust = compileTrustedProxy('192.0.2.0/24');

    expect(trust('192.0.2.10', 0)).toBe(false);
  });
});

// Deployments whose app port is not published reach the server only through a
// proxy on a container network. Trusting that one hop is what makes req.ip a
// per-client key there — without it every caller shares the proxy's address and
// a lockout falls on the owner as much as on an attacker (#57).
describe('compileTrustedProxy — private-peer hop trust', () => {
  it('trusts the immediate peer when it is on a private network', () => {
    const trust = compileTrustedProxy('', true);

    expect(trust('10.21.0.4', 0)).toBe(true);
    expect(trust('172.18.0.2', 0)).toBe(true);
    expect(trust('192.168.1.5', 0)).toBe(true);
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::1', 0)).toBe(true);
    expect(trust('fd00::1', 0)).toBe(true);
  });

  // The safety net: if the port ever becomes directly reachable, a public
  // client's forwarded headers must not be believed. It then rate-limits on
  // its own real address instead — degrading to the old behaviour, not to
  // trusting a stranger's claim about who it is.
  it('never trusts a public peer, even with hop trust on', () => {
    const trust = compileTrustedProxy('', true);

    expect(trust('203.0.113.7', 0)).toBe(false);
    expect(trust('8.8.8.8', 0)).toBe(false);
    expect(trust('2001:db8::1', 0)).toBe(false);
  });

  it('still trusts only the immediate hop', () => {
    expect(compileTrustedProxy('', true)('10.0.0.1', 1)).toBe(false);
  });

  it('is off by default, preserving the exact-allowlist behaviour', () => {
    expect(compileTrustedProxy('')('10.0.0.1', 0)).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it('accepts loopback, RFC1918, link-local and unique-local', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
                      '192.168.0.1', '169.254.1.1', '::1', 'fd12::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('rejects public addresses and 172 outside the reserved block', () => {
    for (const ip of ['203.0.113.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2001:db8::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('sees through IPv4-mapped IPv6', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

// A setting that looks configured but matches nothing leaves the key shared,
// so it must not be mistaken for per-client isolation when sizing a lockout.
describe('hasUsableTrustedProxy', () => {
  it('is true for at least one real address, or for hop trust', () => {
    expect(hasUsableTrustedProxy('192.0.2.10')).toBe(true);
    expect(hasUsableTrustedProxy('2001:db8::10')).toBe(true);
    expect(hasUsableTrustedProxy('', true)).toBe(true);
  });

  it('is false for entries compileTrustedProxy can never match', () => {
    expect(hasUsableTrustedProxy('')).toBe(false);
    expect(hasUsableTrustedProxy('   ')).toBe(false);
    expect(hasUsableTrustedProxy(',')).toBe(false);
    expect(hasUsableTrustedProxy('10.0.0.0/8')).toBe(false); // CIDR is never matched
    expect(hasUsableTrustedProxy('not-an-ip')).toBe(false);
    expect(hasUsableTrustedProxy('999.1.1.1')).toBe(false);
  });
});
