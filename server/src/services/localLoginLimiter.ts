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

  private prune(now: number): void {
    const cutoff = now - LOCAL_LOGIN_WINDOW_MS;
    for (const [key, attempts] of this.attempts) {
      const active = attempts.filter(({ timestamp }) => timestamp > cutoff);
      if (active.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, active);
    }
  }

  acquire(source: string, now = Date.now()): LocalLoginAcquireResult {
    this.prune(now);
    const active = this.attempts.get(source) ?? [];
    if (active.length >= LOCAL_LOGIN_MAX_FAILURES) {
      const oldest = active[0]?.timestamp ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + LOCAL_LOGIN_WINDOW_MS - now) / 1_000)),
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
}
