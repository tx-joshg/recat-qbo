// Magic-link issue/consume. Tokens are random, stored SHA-256-hashed, expire
// after 15 minutes, and are single-use (claimed with a guarded updateMany so
// concurrent clicks can't both win).

import type { User } from '../lib/db.js';
import { env } from '../env.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { devLoginAllowed } from './devLogin.js';
import { resolvePublicUrl } from './publicUrl.js';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function magicLinkUrl(token: string): Promise<string> {
  return `${await resolvePublicUrl()}/auth/callback?token=${encodeURIComponent(token)}`;
}

export interface IssueMagicLinkOptions {
  /** Invite email wording instead of plain sign-in wording. */
  invite?: boolean;
  /** Set false for trusted operator flows that must not depend on SMTP. */
  deliver?: boolean;
  /**
   * The caller will hand the link back in a response body (the demo-mode
   * devLink). Recorded on the token and on any session it mints, so both stop
   * working once a real company is connected.
   */
  exposed?: boolean;
}

/**
 * Create a single-use magic-link token and, by default, email it to the user.
 * Trusted operator flows can disable delivery and print the returned link.
 */
export async function issueMagicLink(
  user: Pick<User, 'id' | 'email'>,
  options: IssueMagicLinkOptions = {},
): Promise<{ link: string }> {
  const token = randomToken(32);
  // Housekeeping: drop this user's spent and expired tokens first, so repeated
  // unauthenticated requests (the login screen's magic-link button is public)
  // cannot grow the table without bound. Tokens are only ever created for
  // existing users, so live rows stay bounded by users × the issuance rate
  // within one TTL. Spent rows are safe to drop — consumption is recorded by
  // flipping usedAt, and a used token is invalid whether or not the row exists.
  await prisma.magicLinkToken.deleteMany({
    where: {
      userId: user.id,
      OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
    },
  });
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: sha256Hex(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      exposed: options.exposed === true,
    },
  });
  const link = await magicLinkUrl(token);
  const subject = options.invite ? "You've been invited to Recat" : 'Sign in to Recat';
  const intro = options.invite
    ? "You've been invited to Recat. Open this link to sign in:"
    : 'Open this link to sign in to Recat:';
  if (options.deliver !== false) {
    await sendMail({
      to: user.email,
      subject,
      text: `${intro}\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, you can ignore this email.`,
    });
  }
  return { link };
}

/**
 * Verify and consume a magic-link token: must exist, be unused, and be
 * unexpired. An exposed (response-body) token is also refused once dev login
 * has locked, i.e. a real company is connected. Marks it used and clears the
 * user's invitePending flag. Returns the user and whether the token was
 * exposed, or null if the token is invalid in any way.
 */
export async function consumeMagicLink(token: string): Promise<{ user: User; exposed: boolean } | null> {
  const record = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: sha256Hex(token) },
  });
  if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) return null;
  if (record.exposed && !(await devLoginAllowed())) return null;

  // Guarded claim: only one concurrent request can flip usedAt from null.
  const claimed = await prisma.magicLinkToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const user = await prisma.user.update({
    where: { id: record.userId },
    data: { invitePending: false },
  });
  return { user, exposed: record.exposed };
}
