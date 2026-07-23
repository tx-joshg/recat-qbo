import { describe, expect, it } from 'vitest';
import {
  assertActiveJobLease,
  assertAgentJobTransition,
  ownsCompanyWriteLease,
} from './types.js';

describe('agent job state machine', () => {
  it.each([
    ['queued', 'running'],
    ['queued', 'cancelled'],
    ['running', 'completed'],
    ['running', 'retry'],
    ['running', 'failed'],
    ['running', 'cancelled'],
    ['retry', 'running'],
    ['retry', 'failed'],
    ['retry', 'cancelled'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(() => assertAgentJobTransition(from, to)).not.toThrow();
  });

  it.each([
    ['queued', 'completed'],
    ['completed', 'running'],
    ['failed', 'running'],
    ['cancelled', 'running'],
    ['retry', 'completed'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(() => assertAgentJobTransition(from, to)).toThrow(/cannot transition/);
  });
});

describe('agent leases', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  it('requires running status, matching owner, and an unexpired job lease', () => {
    expect(() =>
      assertActiveJobLease(
        { status: 'running', lockOwner: 'worker-a', leaseExpiresAt: new Date('2026-07-23T12:01:00Z') },
        'worker-a',
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertActiveJobLease(
        { status: 'running', lockOwner: 'worker-b', leaseExpiresAt: new Date('2026-07-23T12:01:00Z') },
        'worker-a',
        now,
      ),
    ).toThrow(/no longer owns/);
    expect(() =>
      assertActiveJobLease(
        { status: 'running', lockOwner: 'worker-a', leaseExpiresAt: now },
        'worker-a',
        now,
      ),
    ).toThrow(/no longer owns/);
  });

  it('recognizes only a live company-write lease owned by the caller', () => {
    expect(
      ownsCompanyWriteLease(
        { owner: 'worker-a', leaseExpiresAt: new Date('2026-07-23T12:01:00Z') },
        'worker-a',
        now,
      ),
    ).toBe(true);
    expect(
      ownsCompanyWriteLease(
        { owner: 'worker-b', leaseExpiresAt: new Date('2026-07-23T12:01:00Z') },
        'worker-a',
        now,
      ),
    ).toBe(false);
    expect(
      ownsCompanyWriteLease({ owner: 'worker-a', leaseExpiresAt: now }, 'worker-a', now),
    ).toBe(false);
  });
});
