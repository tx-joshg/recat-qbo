import { Router } from 'express';
import type { Company } from '@prisma/client';
import type { QboTaxCodeDto, QboTaxProfileDto } from '@recat/shared';
import { asyncHandler, HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { refreshTaxReference } from '../services/tax/reference.js';

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

export const taxRouter = Router({ mergeParams: true });
taxRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('categorizer'));

taxRouter.get(
  '/tax-profile',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const body: QboTaxProfileDto = {
      status: company.taxSupportStatus as QboTaxProfileDto['status'],
      usingSalesTax: company.taxUsingSalesTax === true,
      lastRefreshedAt: company.taxReferenceRefreshedAt?.toISOString() ?? null,
      reason: company.taxSupportReason,
    };
    res.json(body);
  }),
);

taxRouter.get(
  '/tax-codes',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const includeInactive = req.query.includeInactive === 'true';
    const rows = await prisma.qboTaxCode.findMany({
      where: { companyId: company.id, ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const body: QboTaxCodeDto[] = rows.map((row) => ({
      qboId: row.qboId,
      name: row.name,
      description: row.description,
      active: row.active,
      taxable: row.taxable,
      purchaseApplicable:
        row.taxable === false ||
        (Array.isArray(row.purchaseTaxRateList) && row.purchaseTaxRateList.length > 0),
    }));
    res.json(body);
  }),
);

taxRouter.post(
  '/tax-codes/refresh',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    if (company.disconnectedAt !== null) {
      throw new HttpError(400, 'Reconnect this company before refreshing tax codes.', 'COMPANY_DISCONNECTED');
    }
    const refreshed = await refreshTaxReference(company.id, { force: true });
    const body: QboTaxProfileDto = {
      status: refreshed.status,
      usingSalesTax: refreshed.profile.usingSalesTax,
      lastRefreshedAt: refreshed.refreshedAt.toISOString(),
      reason: refreshed.reason,
    };
    res.json(body);
  }),
);
