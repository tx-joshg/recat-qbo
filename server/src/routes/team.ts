// Per-company team (membership) management — company admins (or instance
// admins). Nested inside companiesRouter at /api/companies/:companyId/team
// (see routes/companies.ts).
//   GET    /            members of the company with their per-company role
//                       (instance admins included, labeled 'admin')
//   POST   /            invite {email, role} — creates the user if new, adds
//                       a Membership, sends a magic-link invite
//   PATCH  /:userId     {role} — change a member's role in this company
//   DELETE /:userId     remove the membership (the user keeps other companies)

import { Router } from 'express';
import { z } from 'zod';
import type { Company } from '@prisma/client';
import type { TeamMemberDto } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { isSmtpConfigured } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { devLoginAllowed } from '../services/devLogin.js';
import { issueMagicLink } from '../services/magicLink.js';

const roleSchema = z.enum(['admin', 'categorizer', 'viewer']);

const inviteBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: roleSchema,
});

const patchBody = z.object({ role: roleSchema });

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

function toMemberDto(
  user: { id: string; email: string; name: string | null; invitePending: boolean; isInstanceAdmin: boolean },
  role: TeamMemberDto['role'],
): TeamMemberDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role,
    invitePending: user.invitePending,
    isInstanceAdmin: user.isInstanceAdmin,
  };
}

/**
 * Guard shared by PATCH (demote) and DELETE (remove): don't strip the
 * company's last explicit admin membership unless an instance admin exists to
 * still manage the company (one always does — but verify, don't assume).
 */
async function assertNotLastCompanyAdmin(companyId: string, userId: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!membership || membership.role !== 'admin') return;
  const adminCount = await prisma.membership.count({ where: { companyId, role: 'admin' } });
  if (adminCount > 1) return;
  const instanceAdmins = await prisma.user.count({ where: { isInstanceAdmin: true } });
  if (instanceAdmins === 0) {
    throw new HttpError(400, 'Cannot remove the last admin of this company', 'LAST_COMPANY_ADMIN');
  }
}

export const teamRouter = Router({ mergeParams: true });
teamRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('admin'));

teamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const memberships = await prisma.membership.findMany({
      where: { companyId: company.id },
      include: { user: true },
    });
    // Instance admins hold 'admin' everywhere; show them even without an
    // explicit Membership row so the Team card reflects who really has access.
    const instanceAdmins = await prisma.user.findMany({ where: { isInstanceAdmin: true } });
    const byUserId = new Map<string, TeamMemberDto>();
    for (const admin of instanceAdmins) byUserId.set(admin.id, toMemberDto(admin, 'admin'));
    for (const m of memberships) {
      if (byUserId.has(m.userId)) continue; // instance admin — effective role is 'admin'
      byUserId.set(m.userId, toMemberDto(m.user, m.role));
    }
    const body: TeamMemberDto[] = [...byUserId.values()].sort((a, b) => a.email.localeCompare(b.email));
    res.json(body);
  }),
);

teamRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { email, role } = validate(inviteBody)(req.body);

    let user = await prisma.user.findUnique({ where: { email } });
    const isNew = !user;
    if (user) {
      if (user.isInstanceAdmin) {
        throw new HttpError(409, 'That user is an instance admin and already has access', 'USER_EXISTS');
      }
      const existing = await prisma.membership.findUnique({
        where: { userId_companyId: { userId: user.id, companyId: company.id } },
      });
      if (existing) throw new HttpError(409, 'That user is already a member of this company', 'MEMBER_EXISTS');
    } else {
      user = await prisma.user.create({ data: { email, invitePending: true } });
    }

    await prisma.membership.create({ data: { userId: user.id, companyId: company.id, role } });

    // New users get an invite link; existing users already sign in on their own.
    let devLink: string | undefined;
    if (isNew) {
      const { link } = await issueMagicLink(user, { invite: true });
      if (!(await isSmtpConfigured()) && (await devLoginAllowed())) devLink = link;
    }

    const member = toMemberDto(user, role);
    res.status(201).json(devLink !== undefined ? { member, devLink } : { member });
  }),
);

teamRouter.patch(
  '/:userId',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const userId = req.params.userId;
    if (!userId) throw new HttpError(400, 'Missing user id', 'BAD_REQUEST');
    const { role } = validate(patchBody)(req.body);

    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId: company.id } },
      include: { user: true },
    });
    if (!membership) throw new HttpError(404, 'Not a member of this company', 'MEMBER_NOT_FOUND');
    if (membership.user.isInstanceAdmin) {
      throw new HttpError(400, 'Instance admins are admin everywhere — manage them under Users', 'INSTANCE_ADMIN');
    }

    if (role !== 'admin') await assertNotLastCompanyAdmin(company.id, userId);

    const updated = await prisma.membership.update({
      where: { userId_companyId: { userId, companyId: company.id } },
      data: { role },
      include: { user: true },
    });
    res.json(toMemberDto(updated.user, updated.role));
  }),
);

teamRouter.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const userId = req.params.userId;
    if (!userId) throw new HttpError(400, 'Missing user id', 'BAD_REQUEST');

    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId: company.id } },
      include: { user: true },
    });
    if (!membership) throw new HttpError(404, 'Not a member of this company', 'MEMBER_NOT_FOUND');
    if (membership.user.isInstanceAdmin) {
      throw new HttpError(400, 'Instance admins are admin everywhere — manage them under Users', 'INSTANCE_ADMIN');
    }

    await assertNotLastCompanyAdmin(company.id, userId);

    await prisma.membership.delete({
      where: { userId_companyId: { userId, companyId: company.id } },
    });
    res.json({ ok: true });
  }),
);
