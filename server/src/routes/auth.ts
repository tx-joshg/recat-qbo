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
import { devLoginAllowed } from '../services/devLogin.js';
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

export const authRouter = Router();

// Always 200 {ok:true} — no user enumeration. First run (zero users in the
// DB) creates the requester as admin on the fly.
authRouter.post(
  '/auth/magic-link',
  asyncHandler(async (req, res) => {
    const { email } = validate(magicLinkBody)(req.body);

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const totalUsers = await prisma.user.count();
      if (totalUsers === 0) {
        // First-ever user bootstraps the instance as its instance admin.
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
      // magic link →" directly. Auto-locked the moment a real (non-demo)
      // company is connected, unless ALLOW_DEV_LOGIN=true forces it.
      if (!smtp && (await devLoginAllowed())) devLink = link;
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
      res.redirect(`${env.APP_URL}/?auth=invalid`);
      return;
    }
    const session = await createSession(user.id);
    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions());
    res.redirect(`${env.APP_URL}/`);
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const token = sessionTokenFromRequest(req.cookies);
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions(req.headers.origin));
    res.json({ ok: true });
  }),
);

authRouter.get('/api/session', requireUser, (req, res) => {
  const user = req.user;
  if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  const body: SessionDto = { user: toUserDto(user) };
  res.json(body);
});
