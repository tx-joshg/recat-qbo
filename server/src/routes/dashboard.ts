// Dashboard data (viewer+) and the per-user dashboard layout.
//   dashboardRouter → /api/companies/:companyId/dashboard
//   meRouter        → /api/me (GET/PUT /dashboard-layout)

import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { Company, User } from '@prisma/client';
import type { DashboardWidget } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { dashboardData } from '../services/reports.js';

const widgetSchema = z.object({
  t: z.enum(['rev', 'exp', 'net', 'uncat', 'chart', 'break', 'pl']),
  sp: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

const layoutBody = z.object({ widgets: z.array(widgetSchema).max(20) });

export const dashboardRouter = Router({ mergeParams: true });
dashboardRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('viewer'));

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company: Company | undefined = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    res.json(await dashboardData(company.id));
  }),
);

export const meRouter = Router();
meRouter.use(requireUser);

meRouter.get(
  '/dashboard-layout',
  asyncHandler(async (req, res) => {
    const user: User | undefined = req.user;
    if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const widgets = (fresh?.dashboardLayout as unknown as DashboardWidget[] | null) ?? null;
    res.json({ widgets });
  }),
);

meRouter.put(
  '/dashboard-layout',
  asyncHandler(async (req, res) => {
    const user: User | undefined = req.user;
    if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const { widgets } = validate(layoutBody)(req.body);
    await prisma.user.update({
      where: { id: user.id },
      data: { dashboardLayout: widgets as unknown as Prisma.InputJsonValue },
    });
    res.json({ widgets });
  }),
);
