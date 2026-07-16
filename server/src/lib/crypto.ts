// Symmetric encryption for secrets at rest (QBO tokens, instance settings)
// plus small hashing/token helpers used by auth.
//
// Encrypted payload format (self-describing, dot-separated):
//   base64(iv) . base64(authTag) . base64(ciphertext)
// AES-256-GCM with a 12-byte IV; the auth tag makes tampering detectable.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex'); // validated as 64 hex chars in env.ts
const IV_BYTES = 12;

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

/** Throws on malformed input or any tampering (GCM auth tag mismatch). */
export function decrypt(payload: string): string {
  const parts = payload.split('.');
  const [ivB64, tagB64, ctB64] = parts;
  // ctB64 may legitimately be '' (encrypting the empty string).
  if (parts.length !== 3 || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error('decrypt: malformed payload (expected iv.tag.ciphertext)');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** URL-safe random token (base64url), default 32 bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
