import { describe, expect, it } from 'vitest';
import { compileTrustedProxy } from './trustedProxy.js';

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
