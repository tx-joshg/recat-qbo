// Auth routes: magic-link request, callback (session creation), logout, and
// the current-session endpoint. Mount this router at the app root — it owns
// both /auth/* and /api/session paths.

import { Router } from 'express';
import { z } from 'zod';
import type { Membership, User } from '@prisma/client';
import type { SessionDto, UserDto } from '@recat/shared';
import { env } from '../env.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { isSmtpConfigured } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { devLoginAllowed, localAdminLockdown } from '../services/devLogin.js';
import { LocalLoginLimiter } from '../services/localLoginLimiter.js';
import {
  clearCookieOptions,
  createSession,
  destroySession,
  requireUser,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionTokenFromRequest,
} from '../middleware/auth.js';
import { consumeMagicLink, issueMagicLink } from '../services/magicLink.js';
import { resolvePublicUrl } from '../services/publicUrl.js';

export function toUserDto(user: User & { memberships: Membership[] }): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isInstanceAdmin: user.isInstanceAdmin,
    invitePending: user.invitePending,
    memberships: user.memberships.map((m) => ({ companyId: m.companyId, role: m.role })),
  };
}

const magicLinkBody = z.object({ email: z.string().trim().toLowerCase().email() });

// Every request writes a token row and a mail (or log line), so issuance is
// throttled per source. Behind a reverse proxy the bucket is shared (see the
// setup limiter in routes/instance.ts for why) — five a minute is plenty for a
// human signing in and bounds what an anonymous caller can grow the token
// table and server log by. Exported so tests can reset the shared state.
export const magicLinkLimiter = new LocalLoginLimiter(5, 60 * 1000);

export const authRouter = Router();

// Always 200 {ok:true} — no user enumeration. First run (zero users in the
// DB) creates the requester as admin on the fly, EXCEPT on local-admin
// deployments — see localAdminLockdown.
authRouter.post(
  '/auth/magic-link',
  asyncHandler(async (req, res) => {
    const source = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = magicLinkLimiter.acquire(source);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpError(429, 'Too many requests — try again in a minute', 'RATE_LIMITED');
    }

    const { email } = validate(magicLinkBody)(req.body);

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const totalUsers = await prisma.user.count();
      // First-ever user bootstraps the instance as its instance admin — but
      // never when a local admin password is configured. That password gates
      // first-run via POST /api/setup/admin; letting this unauthenticated
      // route create the account instead would hand the instance to whoever
      // reached it first, or at minimum let them squat the first-admin slot
      // so the owner's wizard 409s. (#53)
      if (totalUsers === 0 && !localAdminLockdown()) {
        user = await prisma.user.create({
          data: { email, isInstanceAdmin: true, invitePending: false },
        });
      }
    }

    // `delivered` reflects only whether this instance can send email — a
    // per-instance constant, so it leaks nothing about account existence.
    const smtp = await isSmtpConfigured();
    let devLink: string | undefined;
    if (user) {
      const { link } = await issueMagicLink(user);
      // Dev convenience: no SMTP configured → let the UI offer "open the
      // magic link →" directly. Never on a local-admin deployment: this route
      // is unauthenticated and the admin address is published (Umbrel's
      // defaultUsername), so a response-body link is an admin session for the
      // asking. The link still reaches the server log for the operator, which
      // the login screen points to. Otherwise auto-locked the moment a real
      // (non-demo) company is connected, unless ALLOW_DEV_LOGIN=true forces it.
      if (!smtp && !localAdminLockdown() && (await devLoginAllowed())) devLink = link;
    }

    res.json(devLink !== undefined ? { ok: true, delivered: smtp, devLink } : { ok: true, delivered: smtp });
  }),
);

authRouter.get(
  '/auth/callback',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const user = token !== '' ? await consumeMagicLink(token) : null;
    if (!user) {
      res.redirect(`${await resolvePublicUrl()}/?auth=invalid`);
      return;
    }
    const session = await createSession(user.id);
    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions);
    res.redirect(`${await resolvePublicUrl()}/`);
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const token = sessionTokenFromRequest(req.cookies);
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions);
    res.json({ ok: true });
  }),
);

authRouter.get('/api/session', requireUser, (req, res) => {
  const user = req.user;
  if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  const body: SessionDto = { user: toUserDto(user) };
  res.json(body);
});
