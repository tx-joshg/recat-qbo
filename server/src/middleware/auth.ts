// Session auth: random tokens in an httpOnly cookie, stored SHA-256-hashed in
// the Session table (a DB leak never exposes usable session tokens).

import type { CookieOptions, RequestHandler } from 'express';
import type { Role } from '@recat/shared';
import type { User } from '@prisma/client';
import { env, isProd } from '../env.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';

export const SESSION_COOKIE = 'recat_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessionCookieBaseOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS,
} as const;

/**
 * Mixed-origin self-hosting can serve the same deployment over HTTPS on a
 * tailnet and HTTP on a private LAN. Match the cookie's Secure attribute to
 * the already origin-checked browser request; non-browser flows fall back to
 * the canonical APP_URL.
 */
export function sessionCookieOptions(origin?: string): CookieOptions {
  let secure = isProd;
  try {
    secure = new URL(origin ?? env.APP_URL).protocol === 'https:';
  } catch {
    // Invalid browser origins are rejected by originCheck. Fail secure for any
    // non-browser caller whose canonical configuration is unexpectedly bad.
  }
  return { ...sessionCookieBaseOptions, secure };
}

/** Same attributes minus maxAge, for res.clearCookie (must match to clear). */
export function clearCookieOptions(origin?: string): CookieOptions {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(origin);
  return options;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { tokenHash: sha256Hex(token), userId, expiresAt },
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

export function sessionTokenFromRequest(cookies: unknown): string | null {
  if (typeof cookies !== 'object' || cookies === null) return null;
  const value = (cookies as Record<string, unknown>)[SESSION_COOKIE];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Loads the session's user (with memberships — the session DTO and role gates
 * both need them) onto req.user; 401 JSON when absent or expired.
 */
export const requireUser: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = sessionTokenFromRequest(req.cookies);
  if (!token) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { include: { memberships: true } } },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, 'Session expired — sign in again', 'UNAUTHENTICATED');
  }
  req.user = session.user;
  next();
});

// ---------------------------------------------------------------------------
// Per-company roles (handoff §5 matrix, scoped per company; specs.md §2)
// ---------------------------------------------------------------------------

/** viewer < categorizer < admin. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, categorizer: 1, admin: 2 };

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

/** The slice of the Prisma client effectiveRole needs — injectable for tests. */
export interface MembershipReader {
  membership: {
    findUnique(args: {
      where: { userId_companyId: { userId: string; companyId: string } };
      select: { role: true };
    }): Promise<{ role: Role } | null>;
  };
}

/**
 * The user's effective role for a company: instance admins are 'admin'
 * everywhere; everyone else gets their Membership role, or null when they
 * have no membership in that company.
 */
export async function effectiveRole(
  user: Pick<User, 'id' | 'isInstanceAdmin'>,
  companyId: string,
  db: MembershipReader = prisma,
): Promise<Role | null> {
  if (user.isInstanceAdmin) return 'admin';
  const membership = await db.membership.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/**
 * Per-company role gate (run after requireUser, and after withCompany on
 * company routers — the company the request targets is req.company, falling
 * back to req.params.companyId for routers that scope later). The minimum
 * required role is the lowest-ranked of `roles`; a higher role always passes,
 * and instance admins pass everything.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  const minRank = Math.min(...roles.map(roleRank));
  return asyncHandler(async (req, _res, next) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    if (user.isInstanceAdmin) {
      next();
      return;
    }
    const companyId = req.company?.id ?? req.params.companyId;
    if (!companyId) {
      // A company-role gate on a route with no company in scope is a wiring
      // bug — fail closed rather than letting a non-admin through.
      throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
    }
    const role = await effectiveRole(user, companyId);
    if (role === null || roleRank(role) < minRank) {
      throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
    }
    next();
  });
}

/**
 * Instance-admin gate (run after requireUser): instance settings, user +
 * membership management, connecting/disconnecting companies.
 */
export const requireInstanceAdmin: RequestHandler = (req, _res, next) => {
  const user = req.user;
  if (!user) {
    next(new HttpError(401, 'Not signed in', 'UNAUTHENTICATED'));
    return;
  }
  if (!user.isInstanceAdmin) {
    next(new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN'));
    return;
  }
  next();
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function httpOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must contain valid absolute URLs`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must contain only http(s) URLs`);
  }
  return url.origin;
}

/** Canonical APP_URL plus explicitly configured, comma-separated browser origins. */
export function parseTrustedOrigins(appUrl: string, additionalOrigins: string): ReadonlySet<string> {
  const origins = new Set<string>([httpOrigin(appUrl, 'APP_URL')]);
  for (const value of additionalOrigins.split(',')) {
    const trimmed = value.trim();
    if (trimmed !== '') origins.add(httpOrigin(trimmed, 'TRUSTED_ORIGINS'));
  }
  return origins;
}

export function originIsTrusted(origin: string, trustedOrigins: ReadonlySet<string>): boolean {
  try {
    return trustedOrigins.has(httpOrigin(origin, 'Origin'));
  } catch {
    return false;
  }
}

const trustedOrigins = parseTrustedOrigins(env.APP_URL, env.TRUSTED_ORIGINS);

/**
 * CSRF hardening: on mutating requests, an Origin header (when present) must
 * match the deployment's APP_URL origin or an explicitly configured
 * TRUSTED_ORIGINS entry. Requests without an Origin header (curl,
 * same-origin GET-initiated fetches in old browsers) pass through.
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    next();
    return;
  }
  if (!originIsTrusted(origin, trustedOrigins)) {
    next(new HttpError(403, 'Cross-origin request rejected', 'BAD_ORIGIN'));
    return;
  }
  next();
};
