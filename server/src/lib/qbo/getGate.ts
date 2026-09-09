import {
  QboRateLimitError,
  QBO_RATE_LIMIT_MIN_RETRY_SECONDS,
  QBO_RATE_LIMIT_MAX_RETRY_SECONDS,
  QBO_RATE_LIMIT_FALLBACK_SECONDS,
} from './types.js';

/** Keep QuickBooks GETs below the provider's per-realm request burst limit. */
export const QBO_GET_MIN_START_SPACING_MS = 500;

export {
  QBO_RATE_LIMIT_MIN_RETRY_SECONDS,
  QBO_RATE_LIMIT_MAX_RETRY_SECONDS,
  QBO_RATE_LIMIT_FALLBACK_SECONDS,
} from './types.js';

interface GetGateState {
  /** The tail of the FIFO queue.  Each turn always resolves, never rejects. */
  tail: Promise<void>;
  /** Earliest start permitted by the inter-request spacing rule. */
  nextStartAt: number;
  /** Earliest start permitted by the last provider rate-limit response. */
  notBefore: number;
}

const gates = new Map<string, GetGateState>();

function stateFor(key: string): GetGateState {
  let state = gates.get(key);
  if (state === undefined) {
    state = {
      tail: Promise.resolve(),
      nextStartAt: 0,
      notBefore: 0,
    };
    gates.set(key, state);
  }
  return state;
}

/** Stable process-wide key; environments with the same realm remain isolated. */
export function qboGetGateKey(
  environment: 'sandbox' | 'production',
  realmId: string,
): string {
  return JSON.stringify([environment, realmId]);
}

/**
 * Run one QuickBooks GET in the process-wide FIFO gate for an environment and
 * realm.  The gate deliberately does not retry a failed request: it only
 * prevents the next request from starting until the provider's cooldown has
 * elapsed.
 */
export async function withQboGetGate<T>(
  key: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const state = stateFor(key);
  const previous = state.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `tail` must never reject: a failed operation must not strand every later
  // request for this realm.
  state.tail = previous.then(() => turn, () => turn);

  try {
    await waitForTurn(previous, signal);
    // A concurrent POST may extend the realm cooldown while this GET is
    // already waiting. Re-read the shared deadline before starting a request.
    while (Math.max(state.nextStartAt, state.notBefore) > Date.now()) {
      await waitUntil(Math.max(state.nextStartAt, state.notBefore), signal);
    }
    if (signal?.aborted) throw abortedRequest();

    const startedAt = Date.now();
    state.nextStartAt = startedAt + QBO_GET_MIN_START_SPACING_MS;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QboRateLimitError) {
        noteQboRateLimit(key, error);
      }
      throw error;
    }
  } finally {
    release();
  }
}

/**
 * Record a provider cooldown even when a non-GET request (for example a
 * prepared POST) receives the 429.  It affects later GETs, but never retries
 * the request that was rejected.
 */
export function noteQboRateLimit(
  key: string,
  error: QboRateLimitError,
  now = Date.now(),
): void {
  const state = stateFor(key);
  state.notBefore = Math.max(
    state.notBefore,
    now + error.retryAfterSeconds * 1_000,
  );
}

/** Parse an RFC 9110 Retry-After value and clamp it to a safe interval. */
export function retryAfterSecondsFromHeader(
  header: string | null | undefined,
  now = Date.now(),
): number {
  if (header !== null && header !== undefined) {
    const value = header.trim();
    // RFC 9110 delay-seconds is an integer, not a fractional number.
    if (/^\d+$/u.test(value)) {
      const seconds = Number(value);
      if (Number.isSafeInteger(seconds)) {
        return clampRetryAfter(seconds);
      }
    } else if (!/^[+-]?\d+(?:\.\d+)?$/u.test(value)) {
      const dateMs = Date.parse(value);
      if (Number.isFinite(dateMs)) {
        return clampRetryAfter(Math.ceil((dateMs - now) / 1_000));
      }
    }
  }
  return QBO_RATE_LIMIT_FALLBACK_SECONDS;
}

/** Test isolation for the process-wide state; production code never calls it. */
export function resetQboGetGatesForTest(): void {
  gates.clear();
}

function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) return QBO_RATE_LIMIT_FALLBACK_SECONDS;
  return Math.min(
    QBO_RATE_LIMIT_MAX_RETRY_SECONDS,
    Math.max(QBO_RATE_LIMIT_MIN_RETRY_SECONDS, Math.ceil(seconds)),
  );
}

async function waitForTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  await waitForPromiseOrAbort(previous, signal);
}

async function waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortedRequest();
  const delayMs = deadline - Date.now();
  if (delayMs <= 0) return;
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortedRequest());
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForPromiseOrAbort(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortedRequest();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortedRequest());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortedRequest(): Error {
  const error = new Error('QuickBooks request was cancelled.');
  error.name = 'AbortError';
  return error;
}
