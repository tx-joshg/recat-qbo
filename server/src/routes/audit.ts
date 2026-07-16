// Audit log — /api/companies/:companyId/audit (categorizer+, read + export
// only; the table itself is append-only).

import { Router } from 'express';
import { z } from 'zod';
import type { Company } from '@prisma/client';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { auditCsv, listAudit } from '../services/audit.js';

const listQuery = z.object({
  q: z.string().optional(),
  cursor: z.string().optional(),
});

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

export const auditRouter = Router({ mergeParams: true });
auditRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('categorizer'));

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const q = validate(listQuery)(req.query);
    const page = await listAudit(company.id, {
      ...(q.q !== undefined ? { search: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    res.json(page);
  }),
);

auditRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const csv = await auditCsv(company.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(csv);
  }),
);
