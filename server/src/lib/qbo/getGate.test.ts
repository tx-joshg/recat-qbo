import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QboRateLimitError } from './types.js';
import {
  QBO_GET_MIN_START_SPACING_MS,
  QBO_RATE_LIMIT_FALLBACK_SECONDS,
  QBO_RATE_LIMIT_MAX_RETRY_SECONDS,
  noteQboRateLimit,
  resetQboGetGatesForTest,
  retryAfterSecondsFromHeader,
  withQboGetGate,
} from './getGate.js';

describe('process-wide QuickBooks GET gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
    resetQboGetGatesForTest();
  });

  afterEach(() => {
    resetQboGetGatesForTest();
    vi.useRealTimers();
  });

  it('serializes same-realm calls and spaces their starts by 500ms', async () => {
    const starts: number[] = [];
    const first = withQboGetGate('sandbox:realm-1', async () => {
      starts.push(Date.now());
      return 'first';
    });
    await expect(first).resolves.toBe('first');

    const second = withQboGetGate('sandbox:realm-1', async () => {
      starts.push(Date.now());
      return 'second';
    });
    await vi.advanceTimersByTimeAsync(QBO_GET_MIN_START_SPACING_MS - 1);
    expect(starts).toEqual([Date.parse('2026-08-30T00:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe('second');
    expect(starts).toEqual([
      Date.parse('2026-08-30T00:00:00.000Z'),
      Date.parse('2026-08-30T00:00:00.500Z'),
    ]);
  });

  it('keeps different realms independent', async () => {
    const starts: string[] = [];
    const first = withQboGetGate('sandbox:realm-1', async () => {
      starts.push('realm-1');
      return undefined;
    });
    const second = withQboGetGate('sandbox:realm-2', async () => {
      starts.push('realm-2');
      return undefined;
    });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(starts).toEqual(['realm-1', 'realm-2']);
  });

  it('applies Retry-After to the realm cooldown without retrying the failed GET', async () => {
    const calls: number[] = [];
    const failed = withQboGetGate('sandbox:realm-1', async () => {
      calls.push(Date.now());
      throw new QboRateLimitError(2);
    });
    await expect(failed).rejects.toMatchObject({
      code: 'QBO_RATE_LIMITED',
      retryAfterSeconds: 2,
    });

    const next = withQboGetGate('sandbox:realm-1', async () => {
      calls.push(Date.now());
      return 'after-cooldown';
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe('after-cooldown');
    expect(calls).toEqual([
      Date.parse('2026-08-30T00:00:00.000Z'),
      Date.parse('2026-08-30T00:00:02.000Z'),
    ]);
  });

  it('uses a bounded fallback and clamps hostile Retry-After values', () => {
    expect(retryAfterSecondsFromHeader(undefined)).toBe(QBO_RATE_LIMIT_FALLBACK_SECONDS);
    expect(retryAfterSecondsFromHeader('not-a-delay')).toBe(QBO_RATE_LIMIT_FALLBACK_SECONDS);
    expect(retryAfterSecondsFromHeader('0')).toBe(1);
    expect(retryAfterSecondsFromHeader('999999')).toBe(QBO_RATE_LIMIT_MAX_RETRY_SECONDS);
    expect(retryAfterSecondsFromHeader('2.5')).toBe(QBO_RATE_LIMIT_FALLBACK_SECONDS);
    expect(retryAfterSecondsFromHeader('Thu, 01 Jan 1970 00:00:02 GMT', 0)).toBe(2);
  });

  it('rejects cancellation between receiving a turn and subscribing to its cooldown', async () => {
    noteQboRateLimit('sandbox:realm-1', new QboRateLimitError(60));
    const controller = new AbortController();
    const operation = vi.fn(async () => 'unexpected');
    let outcome: unknown = 'pending';
    const request = withQboGetGate('sandbox:realm-1', operation, controller.signal)
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });

    // The already-resolved queue turn first removes its abort listener. Abort
    // in the next microtask, before the cooldown installs its own listener.
    queueMicrotask(() => controller.abort());
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome).toMatchObject({ name: 'AbortError' });
    await request;
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an aborted queued caller leave the gate without starting a GET', async () => {
    let releaseFirst!: () => void;
    const first = withQboGetGate('sandbox:realm-1', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await vi.waitFor(() => expect(releaseFirst).toEqual(expect.any(Function)));

    const controller = new AbortController();
    let started = false;
    const second = withQboGetGate(
      'sandbox:realm-1',
      async () => {
        started = true;
      },
      controller.signal,
    );
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst();
    await first;
    expect(started).toBe(false);
  });
});
