export const LOCAL_LOGIN_MAX_FAILURES = 5;
export const LOCAL_LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Used when the limiter's keys cannot distinguish callers — see below. */
export const LOCAL_LOGIN_SHARED_WINDOW_MS = 60 * 1000;

/**
 * How long a lockout should last, given the deployment's trusted-proxy setting.
 *
 * The limiter keys on `req.ip`. That is a per-client key only when Express can
 * trust a forwarded address — which requires TRUSTED_PROXY_IPS to name the
 * proxy. Unset (the default, and what the Umbrel package ships, deliberately,
 * so a client cannot spoof its own address) every request behind a reverse
 * proxy carries the proxy's address, and the bucket is deployment-wide.
 *
 * A fifteen-minute lockout on a per-client key only ever punishes the client
 * doing the guessing. On a shared key it punishes everyone, and an attacker can
 * renew it indefinitely — permanently denying local sign-in, which on a
 * no-SMTP deployment is the only way in (#57).
 *
 * So the window follows what the key can prove: the full lockout when clients
 * are distinguishable, a minute when they are not. Five guesses a minute is
 * ~7k a day, negligible against a password whose floor is 12 characters, and it
 * keeps the owner's wait to seconds rather than a quarter of an hour.
 *
 * Only TRUSTED_PROXY_HOP qualifies. A TRUSTED_PROXY_IPS allowlist may be stale,
 * mistyped, or unmatchable, and none of that is detectable at boot — the peer
 * address is not known until a request arrives. Hop trust cannot go stale: it
 * matches whatever private peer actually connects.
 *
 * The asymmetry decides it. Choosing the long window wrongly hands an attacker a
 * renewable deployment-wide lockout; choosing the short one wrongly allows ~7k
 * guesses a day instead of ~480, which is noise against a password whose floor
 * is 12 characters. So the long window needs a signal that cannot be wrong, and
 * a correctly configured allowlist still gets per-client keys — just the shorter
 * lockout with them.
 *
 * The short window is a fallback, not the fix: against an attacker who keeps
 * polling it does not bound the owner's wait at all, because each freed slot is
 * taken again immediately. The fix is making the key per-client in the first
 * place — TRUSTED_PROXY_HOP on deployments whose only route in is a proxy.
 */
export function loginLockoutWindowMs(perClientKeys: boolean): number {
  return perClientKeys ? LOCAL_LOGIN_WINDOW_MS : LOCAL_LOGIN_SHARED_WINDOW_MS;
}

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
