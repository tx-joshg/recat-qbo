import { describe, expect, it, vi } from 'vitest';
import { createDeferredRetryScheduler } from './syncRetry.js';

describe('deferred sync retry scheduler', () => {
  it('deduplicates pending retries and permits a still-busy run to reschedule', async () => {
    vi.useFakeTimers();
    try {
      let scheduler!: ReturnType<typeof createDeferredRetryScheduler>;
      const run = vi.fn(async (companyId: string) => {
        if (run.mock.calls.length === 1) scheduler.schedule(companyId);
      });
      scheduler = createDeferredRetryScheduler(run, { delayMs: 30_000 });

      expect(scheduler.schedule('co-1')).toBe(true);
      expect(scheduler.schedule('co-1')).toBe(false);
      expect(scheduler.pending('co-1')).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(scheduler.pending('co-1')).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(2);
      expect(scheduler.pending('co-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
