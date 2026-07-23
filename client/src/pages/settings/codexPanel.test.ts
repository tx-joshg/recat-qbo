import { describe, expect, it } from 'vitest';
import type { CodexDevicePollDto, CodexDeviceStartDto } from '@recat/shared';
import {
  createCodexDevicePoller,
  providerPersistenceForCodexTransition,
  providerSelectionDecision,
  type CodexDeviceUiState,
} from './codexPanel.js';

interface ScheduledTask {
  fn: () => void | Promise<void>;
  delay: number;
  cancelled: boolean;
}

function fakeScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    setTimer(fn: ScheduledTask['fn'], delay: number) {
      const task = { fn, delay, cancelled: false };
      tasks.push(task);
      return task;
    },
    clearTimer(task: unknown) {
      if (task) (task as ScheduledTask).cancelled = true;
    },
    delays() {
      return tasks.filter((task) => !task.cancelled).map((task) => task.delay);
    },
    async runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (!task) return;
      task.cancelled = true;
      await task.fn();
    },
  };
}

function deferred<T>() {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deviceResponse(overrides: Partial<CodexDeviceStartDto> = {}): CodexDeviceStartDto {
  return {
    flowId: '11111111-1111-4111-8111-111111111111',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalMs: 5000,
    expiresAt: 100_000,
    status: 'pending',
    ...overrides,
  };
}

function fixture(
  overrides: {
    startDevice?: () => Promise<CodexDeviceStartDto>;
    pollDevice?: (flowId: string) => Promise<CodexDevicePollDto>;
    cancelDevice?: (flowId: string) => Promise<CodexDevicePollDto>;
  } = {},
) {
  const scheduler = fakeScheduler();
  const states: CodexDeviceUiState[] = [];
  let currentTime = 10_000;
  const calls = { start: 0, poll: [] as string[], cancel: [] as string[] };
  const poller = createCodexDevicePoller({
    startDevice:
      overrides.startDevice ??
      (async () => {
        calls.start += 1;
        return deviceResponse();
      }),
    pollDevice:
      overrides.pollDevice ??
      (async (flowId) => {
        calls.poll.push(flowId);
        return { status: 'pending', retryAfterMs: 5000 };
      }),
    cancelDevice:
      overrides.cancelDevice ??
      (async (flowId) => {
        calls.cancel.push(flowId);
        return { status: 'cancelled' };
      }),
    onState: (state) => states.push(state),
    now: () => currentTime,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  return {
    poller,
    scheduler,
    states,
    calls,
    setNow(value: number) {
      currentTime = value;
    },
  };
}

describe('createCodexDevicePoller', () => {
  it('publishes only display-safe code, link, and timing state', async () => {
    const value = fixture();
    await expect(value.poller.start()).resolves.toEqual({
      phase: 'pending',
      flowId: '11111111-1111-4111-8111-111111111111',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: 100_000,
      retryAfterMs: 5000,
    });
    expect(value.scheduler.delays()).toEqual([5000]);
    expect(JSON.stringify(value.states)).not.toMatch(/token|device_auth|verifier/i);
  });

  it('resumes a server-backed pending flow without requesting another code', async () => {
    const value = fixture();
    await value.poller.start(deviceResponse({ intervalMs: 7000 }));
    expect(value.calls.start).toBe(0);
    expect(value.scheduler.delays()).toEqual([7000]);
  });

  it('uses each server delay and never overlaps polls', async () => {
    const pending = deferred<CodexDevicePollDto>();
    let polls = 0;
    const value = fixture({
      pollDevice: async () => {
        polls += 1;
        return pending.promise;
      },
    });
    await value.poller.start();
    const running = value.scheduler.runNext();
    expect(polls).toBe(1);
    expect(value.scheduler.delays()).toEqual([]);
    await value.scheduler.runNext();
    expect(polls).toBe(1);

    pending.resolve({ status: 'pending', retryAfterMs: 9000 });
    await running;
    expect(value.scheduler.delays()).toEqual([9000]);
  });

  it('retries a transient polling failure until the device flow expires', async () => {
    let attempts = 0;
    const value = fixture({
      pollDevice: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary network failure');
        return { status: 'connected' };
      },
    });
    await value.poller.start(deviceResponse({ intervalMs: 4000 }));

    await value.scheduler.runNext();
    expect(value.states.at(-1)?.phase).toBe('pending');
    expect(value.scheduler.delays()).toEqual([4000]);

    await value.scheduler.runNext();
    expect(value.states.at(-1)).toEqual({ phase: 'connected' });
    expect(value.scheduler.delays()).toEqual([]);
  });

  it('expires locally before another poll', async () => {
    const value = fixture();
    await value.poller.start();
    value.setNow(100_000);
    await value.scheduler.runNext();
    expect(value.calls.poll).toEqual([]);
    expect(value.states.at(-1)).toEqual({ phase: 'expired' });
  });

  it('cancels the owned flow and ignores a stale in-flight poll', async () => {
    const pending = deferred<CodexDevicePollDto>();
    const value = fixture({ pollDevice: async () => pending.promise });
    await value.poller.start();
    const running = value.scheduler.runNext();
    await value.poller.cancel();
    expect(value.calls.cancel).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(value.states.at(-1)).toEqual({ phase: 'cancelled' });

    pending.resolve({ status: 'pending', retryAfterMs: 5000 });
    await running;
    expect(value.scheduler.delays()).toEqual([]);
    expect(value.states.at(-1)).toEqual({ phase: 'cancelled' });
  });

  it.each([
    [{ status: 'connected' }, { phase: 'connected' }],
    [
      { status: 'failed', reconnectRequired: true, reason: 'authorization_failed' },
      { phase: 'failed', reconnectRequired: true, reason: 'authorization_failed' },
    ],
    [{ status: 'cancelled' }, { phase: 'cancelled' }],
    [{ status: 'expired' }, { phase: 'expired' }],
  ] as const)('maps terminal response %j to UI state', async (response, expected) => {
    const value = fixture({ pollDevice: async () => response });
    await value.poller.start();
    await value.scheduler.runNext();
    expect(value.states.at(-1)).toEqual(expected);
    expect(value.scheduler.delays()).toEqual([]);
  });

  it('disposes timers and suppresses late state updates', async () => {
    const pending = deferred<CodexDevicePollDto>();
    const value = fixture({ pollDevice: async () => pending.promise });
    await value.poller.start();
    const running = value.scheduler.runNext();
    const stateCount = value.states.length;
    value.poller.dispose();
    pending.resolve({ status: 'connected' });
    await running;
    expect(value.states).toHaveLength(stateCount);
    expect(value.scheduler.delays()).toEqual([]);
  });
});

describe('Codex provider activation decisions', () => {
  it('stages unconnected Codex locally and persists it only after connection completes', () => {
    expect(providerSelectionDecision('codex', 'custom', true, false)).toEqual({
      displayedProvider: 'codex',
      providerToPersist: null,
    });

    for (const phase of ['pending', 'cancelled', 'expired', 'failed', 'error'] as const) {
      expect(providerPersistenceForCodexTransition(phase, true)).toBeNull();
    }
    expect(providerPersistenceForCodexTransition('connected', true)).toBe('codex');
    expect(providerPersistenceForCodexTransition('connected', false)).toBeNull();
  });

  it('persists an already-connected Codex choice and keeps other providers immediate', () => {
    expect(providerSelectionDecision('codex', 'custom', true, true)).toEqual({
      displayedProvider: 'codex',
      providerToPersist: 'codex',
    });
    expect(providerSelectionDecision('custom', 'openrouter', false, false).providerToPersist).toBe(
      'custom',
    );
    expect(providerSelectionDecision('openrouter', 'custom', false, false).providerToPersist).toBe(
      'openrouter',
    );
  });

  it('rejects a Codex choice while status is loading without creating a display mismatch', () => {
    const whileLoading = providerSelectionDecision('codex', 'custom', false, false);
    expect(whileLoading).toEqual({ displayedProvider: 'custom', providerToPersist: null });

    expect(providerSelectionDecision('codex', whileLoading.displayedProvider, true, true)).toEqual({
      displayedProvider: 'codex',
      providerToPersist: 'codex',
    });
  });
});
