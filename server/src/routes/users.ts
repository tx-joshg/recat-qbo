// Instance-level user management — instance admins only. Mounted under
// /api/users. Per-company membership management (Team card) lives in
// routes/team.ts under /api/companies/:companyId/team.

import { Router } from 'express';
import { z } from 'zod';
import type { UserDto } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireInstanceAdmin, requireUser } from '../middleware/auth.js';
import { toUserDto } from './auth.js';

const patchBody = z.object({
  isInstanceAdmin: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const usersRouter = Router();

usersRouter.use(requireUser, requireInstanceAdmin);

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { memberships: true },
    });
    const body: UserDto[] = users.map(toUserDto);
    res.json(body);
  }),
);

usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing user id', 'BAD_REQUEST');
    const patch = validate(patchBody)(req.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');

    // Never leave the instance without an instance admin.
    if (patch.isInstanceAdmin === false && target.isInstanceAdmin) {
      const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
      if (adminCount <= 1) throw new HttpError(400, 'Cannot demote the last instance admin', 'LAST_ADMIN');
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(patch.isInstanceAdmin !== undefined ? { isInstanceAdmin: patch.isInstanceAdmin } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      },
      include: { memberships: true },
    });
    res.json(toUserDto(updated));
  }),
);

usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing user id', 'BAD_REQUEST');
    const actor = req.user;
    if (!actor) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    if (actor.id === id) throw new HttpError(400, 'You cannot delete your own account', 'CANNOT_DELETE_SELF');

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');

    if (target.isInstanceAdmin) {
      const adminCount = await prisma.user.count({ where: { isInstanceAdmin: true } });
      if (adminCount <= 1) throw new HttpError(400, 'Cannot delete the last instance admin', 'LAST_ADMIN');
    }

    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
