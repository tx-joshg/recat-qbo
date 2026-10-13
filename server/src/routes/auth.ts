// Auth routes: magic-link request, callback (session creation), logout, and
// the current-session endpoint. Mount this router at the app root — it owns
// both /auth/* and /api/session paths.

import express, { Router } from 'express';
import { z } from 'zod';
import type { Membership, User } from '@prisma/client';
import type { SessionDto, UserDto } from '@recat/shared';
import { env } from '../env.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { isSmtpConfigured } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { devLoginAllowed, localAdminLockdown } from '../services/devLogin.js';
import { BoundedRateLimiter } from '../mcp/rateLimit.js';
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
// throttled — but keyed by EMAIL, never by req.ip. Behind a reverse proxy with
// TRUSTED_PROXY_IPS unset (the Umbrel default) every caller shares one address,
// so an IP key is a deployment-wide bucket that any anonymous client can hold
// empty, blocking sign-in for everyone. Keyed by address, an attacker can only
// affect the address they target, and the per-user token growth this exists to
// bound is per-address anyway.
//
// BoundedRateLimiter rather than LocalLoginLimiter: this route is anonymously
// reachable with a caller-chosen key, so the key space needs a hard cap and
// O(1) admission. maxKeys evicts least-recently-used.
//
// Residual, accepted: an attacker can keep one known address throttled. On a
// local-admin deployment the password path is unaffected; elsewhere it is a
// bounded delay on one account, which is the normal cost of per-account limits.
export const magicLinkLimiter = new BoundedRateLimiter({
  limit: 5,
  windowMs: 60 * 1_000,
  maxKeys: 10_000,
});

export const authRouter = Router();

// Always 200 {ok:true} — no user enumeration. First run (zero users in the
// DB) creates the requester as admin on the fly, EXCEPT on local-admin
// deployments — see localAdminLockdown.
authRouter.post(
  '/auth/magic-link',
  asyncHandler(async (req, res) => {
    // Parsed first so the throttle can key on the address. A malformed body
    // does no work — no lookup, no token, no mail — so it needs no slot.
    const { email } = validate(magicLinkBody)(req.body);

    const limit = magicLinkLimiter.acquire(email);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpError(429, 'Too many requests — try again in a minute', 'RATE_LIMITED');
    }

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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The emailed link lands here, but opening it does not sign anyone in. Mail
 * scanners prefetch links, which would burn a single-use token before the
 * person clicks it, and a GET that creates a session lets another site sign a
 * visitor into the attacker's account (login CSRF). The page instead posts the
 * token back from this origin, which originCheck verifies.
 */
export function magicLinkConfirmPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in — Recat</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f1efe8; color: #22211d; font-family: system-ui, sans-serif; }
  form { background: #fff; border: 1px solid #e9e5db; border-radius: 10px; padding: 28px 32px; text-align: center; }
  p { margin: 0 0 18px; color: #6d685c; }
  button { font: inherit; font-weight: 600; color: #fff; background: #2f5d50; border: 0; border-radius: 6px; padding: 10px 22px; cursor: pointer; }
</style>
</head>
<body>
  <form method="post" action="/auth/callback">
    <p>Continue to sign in to Recat.</p>
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" autofocus>Sign in</button>
  </form>
</body>
</html>`;
}

authRouter.get(
  '/auth/callback',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (token === '') {
      res.redirect(`${await resolvePublicUrl()}/?auth=invalid`);
      return;
    }
    // same-origin, not no-referrer: a no-referrer page makes the browser send
    // `Origin: null` on the form post, which originCheck rightly rejects.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.type('html').send(magicLinkConfirmPage(token));
  }),
);

authRouter.post(
  '/auth/callback',
  express.urlencoded({ extended: false, limit: '4kb' }),
  asyncHandler(async (req, res) => {
    const body = req.body as { token?: unknown } | undefined;
    const token = typeof body?.token === 'string' ? body.token : '';
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
