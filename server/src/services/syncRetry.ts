export interface DeferredRetryScheduler {
  schedule(key: string): boolean;
  pending(key: string): boolean;
}

export interface DeferredRetrySchedulerOptions {
  delayMs: number;
  onError?: (key: string, error: unknown) => void;
  setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
}

/**
 * Deduplicated in-process retry scheduling. The key is released before the
 * callback runs, so a still-busy retry can schedule itself again.
 */
export function createDeferredRetryScheduler(
  run: (key: string) => Promise<unknown>,
  options: DeferredRetrySchedulerOptions,
): DeferredRetryScheduler {
  const timers = new Map<string, NodeJS.Timeout>();
  const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));

  return {
    schedule(key) {
      if (timers.has(key)) return false;
      const timer = setTimer(() => {
        timers.delete(key);
        void run(key).catch((error) => options.onError?.(key, error));
      }, options.delayMs);
      timer.unref?.();
      timers.set(key, timer);
      return true;
    },
    pending(key) {
      return timers.has(key);
    },
  };
}
