export const LOCAL_LOGIN_MAX_FAILURES = 5;
export const LOCAL_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface LocalLoginReservation {
  readonly source: string;
  readonly id: number;
}

interface LocalLoginAttempt {
  timestamp: number;
  reservation: LocalLoginReservation;
}

export type LocalLoginAcquireResult =
  | { allowed: true; reservation: LocalLoginReservation }
  | { allowed: false; retryAfterSeconds: number };

export class LocalLoginLimiter {
  private readonly attempts = new Map<string, LocalLoginAttempt[]>();
  private nextReservationId = 0;

  /**
   * Defaults are the sign-in policy. First-run setup passes a much shorter
   * window: behind a reverse proxy every caller shares one bucket, so a long
   * lockout there denies the owner their own instance rather than just
   * slowing an attacker.
   */
  constructor(
    private readonly maxFailures: number = LOCAL_LOGIN_MAX_FAILURES,
    private readonly windowMs: number = LOCAL_LOGIN_WINDOW_MS,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, attempts] of this.attempts) {
      const active = attempts.filter(({ timestamp }) => timestamp > cutoff);
      if (active.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, active);
    }
  }

  acquire(source: string, now = Date.now()): LocalLoginAcquireResult {
    this.prune(now);
    const active = this.attempts.get(source) ?? [];
    if (active.length >= this.maxFailures) {
      const oldest = active[0]?.timestamp ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1_000)),
      };
    }

    const reservation: LocalLoginReservation = {
      source,
      id: this.nextReservationId,
    };
    this.nextReservationId += 1;
    this.attempts.set(source, [...active, { timestamp: now, reservation }]);
    return { allowed: true, reservation };
  }

  release(reservation: LocalLoginReservation): void {
    const active = this.attempts.get(reservation.source);
    if (active === undefined) return;
    const remaining = active.filter((attempt) => attempt.reservation !== reservation);
    if (remaining.length === 0) this.attempts.delete(reservation.source);
    else this.attempts.set(reservation.source, remaining);
  }

  clear(source: string): void {
    this.attempts.delete(source);
  }

  /** Drop every bucket. For tests, and for anything that rebuilds the router. */
  reset(): void {
    this.attempts.clear();
  }
}
