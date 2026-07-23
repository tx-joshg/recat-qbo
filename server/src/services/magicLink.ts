// Magic-link issue/consume. Tokens are random, stored SHA-256-hashed, expire
// after 15 minutes, and are single-use (claimed with a guarded updateMany so
// concurrent clicks can't both win).

import type { User } from '@prisma/client';
import { env } from '../env.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function magicLinkUrl(token: string): string {
  return `${env.APP_URL}/auth/callback?token=${encodeURIComponent(token)}`;
}

export interface IssueMagicLinkOptions {
  /** Invite email wording instead of plain sign-in wording. */
  invite?: boolean;
  /** Set false for trusted operator flows that must not depend on SMTP. */
  deliver?: boolean;
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
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: sha256Hex(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    },
  });
  const link = magicLinkUrl(token);
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
 * unexpired. Marks it used and clears the user's invitePending flag.
 * Returns the user, or null if the token is invalid in any way.
 */
export async function consumeMagicLink(token: string): Promise<User | null> {
  const record = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: sha256Hex(token) },
  });
  if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) return null;

  // Guarded claim: only one concurrent request can flip usedAt from null.
  const claimed = await prisma.magicLinkToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  return prisma.user.update({
    where: { id: record.userId },
    data: { invitePending: false },
  });
}
