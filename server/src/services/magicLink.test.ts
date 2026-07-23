// Magic-link flow tests with prisma and the mailer mocked — no database needed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  magicLinkToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  user: {
    update: vi.fn(),
  },
  sendMail: vi.fn(async () => undefined),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    magicLinkToken: mocks.magicLinkToken,
    user: mocks.user,
  },
}));

vi.mock('../lib/mailer.js', () => ({
  isSmtpConfigured: async () => false,
  sendMail: mocks.sendMail,
}));

import { sha256Hex } from '../lib/crypto.js';
import { consumeMagicLink, issueMagicLink, MAGIC_LINK_TTL_MS, magicLinkUrl } from './magicLink.js';

const USER = { id: 'u1', email: 'josh@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.magicLinkToken.create.mockResolvedValue({});
  mocks.magicLinkToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.user.update.mockResolvedValue({ id: USER.id, email: USER.email, invitePending: false });
});

function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  expect(token).toBeTruthy();
  return token as string;
}

describe('issueMagicLink', () => {
  it('stores only the sha256 hash of the token, with a 15-minute expiry', async () => {
    const before = Date.now();
    const { link } = await issueMagicLink(USER);
    const after = Date.now();

    const createArgs = mocks.magicLinkToken.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string; userId: string; expiresAt: Date };
    };
    const token = tokenFromLink(link);

    expect(createArgs.data.userId).toBe(USER.id);
    expect(createArgs.data.tokenHash).toBe(sha256Hex(token));
    expect(createArgs.data.tokenHash).not.toContain(token); // never the raw token
    expect(createArgs.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + MAGIC_LINK_TTL_MS);
    expect(createArgs.data.expiresAt.getTime()).toBeLessThanOrEqual(after + MAGIC_LINK_TTL_MS);
  });

  it('emails the link to the user', async () => {
    const { link } = await issueMagicLink(USER);
    const mail = mocks.sendMail.mock.calls[0]?.[0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe(USER.email);
    expect(mail.text).toContain(link);
    expect(mail.subject).toContain('Sign in');
  });

  it('uses invite wording for invites', async () => {
    await issueMagicLink(USER, { invite: true });
    const mail = mocks.sendMail.mock.calls[0]?.[0] as { subject: string };
    expect(mail.subject.toLowerCase()).toContain('invited');
  });

  it('can issue a console-only link without attempting email delivery', async () => {
    const { link } = await issueMagicLink(USER, { deliver: false });

    expect(link).toContain('/auth/callback?token=');
    expect(mocks.magicLinkToken.create).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('builds the callback URL off APP_URL', () => {
    expect(magicLinkUrl('tok123')).toMatch(/\/auth\/callback\?token=tok123$/);
  });
});

describe('consumeMagicLink', () => {
  const validRecord = () => ({
    id: 'mlt1',
    tokenHash: sha256Hex('the-token'),
    userId: USER.id,
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });

  it('accepts a fresh token: marks used, clears invitePending, returns the user', async () => {
    mocks.magicLinkToken.findUnique.mockResolvedValue(validRecord());

    const user = await consumeMagicLink('the-token');

    expect(mocks.magicLinkToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: sha256Hex('the-token') },
    });
    expect(mocks.magicLinkToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'mlt1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: USER.id },
      data: { invitePending: false },
    });
    expect(user).not.toBeNull();
    expect(user?.invitePending).toBe(false);
  });

  it('rejects an unknown token', async () => {
    mocks.magicLinkToken.findUnique.mockResolvedValue(null);
    expect(await consumeMagicLink('nope')).toBeNull();
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it('rejects an already-used token', async () => {
    mocks.magicLinkToken.findUnique.mockResolvedValue({ ...validRecord(), usedAt: new Date() });
    expect(await consumeMagicLink('the-token')).toBeNull();
    expect(mocks.magicLinkToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    mocks.magicLinkToken.findUnique.mockResolvedValue({
      ...validRecord(),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await consumeMagicLink('the-token')).toBeNull();
    expect(mocks.magicLinkToken.updateMany).not.toHaveBeenCalled();
  });

  it('loses the race gracefully when another request claims the token first', async () => {
    mocks.magicLinkToken.findUnique.mockResolvedValue(validRecord());
    mocks.magicLinkToken.updateMany.mockResolvedValue({ count: 0 });
    expect(await consumeMagicLink('the-token')).toBeNull();
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
});
