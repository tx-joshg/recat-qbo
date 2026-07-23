import { describe, expect, it } from 'vitest';
import { LocalLoginLimiter, LOCAL_LOGIN_WINDOW_MS } from './localLoginLimiter.js';

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
