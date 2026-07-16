import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, randomToken, sha256Hex } from './crypto.js';

describe('encrypt/decrypt', () => {
  it('round-trips arbitrary strings', () => {
    const samples = ['hello', '', 'ünïcødé ✓ 中文', 'a'.repeat(10_000), '{"json":true}'];
    for (const s of samples) {
      expect(decrypt(encrypt(s))).toBe(s);
    }
  });

  it('produces a self-describing three-part payload', () => {
    const payload = encrypt('secret');
    expect(payload.split('.')).toHaveLength(3);
  });

  it('uses a fresh IV per call (same plaintext, different ciphertext)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('detects tampering with the ciphertext', () => {
    const payload = encrypt('sensitive-token');
    const parts = payload.split('.');
    const ct = Buffer.from(parts[2] as string, 'base64');
    ct[0] = (ct[0] as number) ^ 0xff; // flip bits in the first byte
    const tampered = `${parts[0]}.${parts[1]}.${ct.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('detects tampering with the auth tag', () => {
    const payload = encrypt('sensitive-token');
    const parts = payload.split('.');
    const tag = Buffer.from(parts[1] as string, 'base64');
    tag[0] = (tag[0] as number) ^ 0x01;
    const tampered = `${parts[0]}.${tag.toString('base64')}.${parts[2]}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decrypt('not-encrypted')).toThrow();
    expect(() => decrypt('a.b')).toThrow();
    expect(() => decrypt('..')).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', () => {
    // echo -n "abc" | shasum -a 256
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is deterministic', () => {
    expect(sha256Hex('recat')).toBe(sha256Hex('recat'));
  });
});

describe('randomToken', () => {
  it('is url-safe (base64url alphabet only)', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('encodes the requested number of bytes', () => {
    // 32 bytes → 43 base64url chars (no padding)
    expect(randomToken().length).toBe(43);
    expect(randomToken(16).length).toBe(22);
  });

  it('never repeats in practice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(randomToken());
    expect(seen.size).toBe(100);
  });
});
