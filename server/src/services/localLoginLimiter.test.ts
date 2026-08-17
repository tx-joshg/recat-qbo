import { describe, expect, it } from 'vitest';
import {
  LOCAL_LOGIN_SHARED_WINDOW_MS,
  LOCAL_LOGIN_WINDOW_MS,
  LocalLoginLimiter,
  loginLockoutWindowMs,
} from './localLoginLimiter.js';

describe('LocalLoginLimiter', () => {
  it('synchronously reserves five attempts and blocks the sixth with Retry-After', () => {
    const limiter = new LocalLoginLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.acquire('127.0.0.1', 1_000 + i).allowed).toBe(true);
    }
    expect(limiter.acquire('127.0.0.1', 2_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 899,
    });
  });

  it('uses a rolling window and permits attempts after the oldest failure expires', () => {
    const limiter = new LocalLoginLimiter();
    for (let i = 0; i < 5; i += 1) limiter.acquire('ip', i * 1_000);
    expect(limiter.acquire('ip', 5_000).allowed).toBe(false);
    expect(limiter.acquire('ip', LOCAL_LOGIN_WINDOW_MS + 1).allowed).toBe(true);
  });

  it('isolates source IPs and clears reserved failures after success', () => {
    const limiter = new LocalLoginLimiter();
    for (let i = 0; i < 5; i += 1) limiter.acquire('ip-a', i);
    expect(limiter.acquire('ip-a', 10).allowed).toBe(false);
    expect(limiter.acquire('ip-b', 10).allowed).toBe(true);
    limiter.clear('ip-a');
    expect(limiter.acquire('ip-a', 10).allowed).toBe(true);
  });

  it('releases only the matching reservation after an unexpected error', () => {
    const limiter = new LocalLoginLimiter();
    const first = limiter.acquire('ip', 1);
    const second = limiter.acquire('ip', 2);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) throw new Error('Expected reservations');

    limiter.release(first.reservation);
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.acquire('ip', 3 + i).allowed).toBe(true);
    }
    expect(limiter.acquire('ip', 10).allowed).toBe(false);

    limiter.release(first.reservation);
    expect(limiter.acquire('ip', 11).allowed).toBe(false);
    limiter.release(second.reservation);
    expect(limiter.acquire('ip', 12).allowed).toBe(true);
  });
});

// A lockout is only safe to make long when its key identifies one client.
// Behind a reverse proxy with TRUSTED_PROXY_IPS unset — the default, and what
// the Umbrel package deliberately ships — every caller shares the proxy's
// address, so a fifteen-minute bucket lets anyone deny local sign-in for
// everyone, indefinitely. On a no-SMTP deployment that is the only way in. (#57)
describe('loginLockoutWindowMs', () => {
  it('keeps the full lockout when keys identify one client', () => {
    expect(loginLockoutWindowMs(true)).toBe(LOCAL_LOGIN_WINDOW_MS);
  });

  // The short window is a fallback, not a fix: against an attacker who keeps
  // polling it does not bound the owner's wait, because each freed slot is
  // taken again immediately. It only limits the damage of a misconfiguration.
  it('shortens it when the key is shared, to limit the blast radius', () => {
    expect(loginLockoutWindowMs(false)).toBe(LOCAL_LOGIN_SHARED_WINDOW_MS);
    expect(LOCAL_LOGIN_SHARED_WINDOW_MS).toBeLessThan(LOCAL_LOGIN_WINDOW_MS);
  });

  // Only a signal that cannot go stale earns the long window. An IP allowlist
  // can be mistyped or outlive the proxy it names, and nothing detects that at
  // boot, so it keeps the shared-key window (#57, codex review on #60).
  it('gives the long window only to hop trust, never to an IP allowlist', () => {
    expect(loginLockoutWindowMs(true)).toBe(LOCAL_LOGIN_WINDOW_MS);
    expect(loginLockoutWindowMs(false)).toBe(LOCAL_LOGIN_SHARED_WINDOW_MS);
  });
});
