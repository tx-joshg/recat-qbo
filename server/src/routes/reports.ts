// Reports — /api/companies/:companyId/reports (viewer+; saved-report writes
// are categorizer+). P&L / balance sheet / custom report / saved reports.

import { Router } from 'express';
import { z } from 'zod';
import type { Company } from '@prisma/client';
import type { SavedReportConfig, SavedReportDto } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { balanceSheet, customReport, profitAndLoss, statementDrilldown } from '../services/reports.js';

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

/** Default report month = the current calendar month (0-based index). */
const currentMonthIndex = (): string => String(new Date().getMonth());

const plQuery = z.object({
  period: z
    .union([z.literal('ytd'), z.string().regex(/^\d{1,2}$/, "month index '0'..'11' or 'ytd'")])
    .default(currentMonthIndex),
  columns: z.enum(['total', 'months']).default('total'),
  compare: z.enum(['none', 'prev', 'py']).default('none'),
  basis: z.enum(['cash', 'accrual']).default('cash'),
});

const bsQuery = z.object({
  // month index ('6') or 'YYYY-MM' — normalized to a month index below.
  asOf: z.string().regex(/^(\d{1,2}|\d{4}-\d{2})$/, "month index or 'YYYY-MM'").default(currentMonthIndex),
  compare: z.enum(['none', 'prev', 'py']).default('none'),
  basis: z.enum(['cash', 'accrual']).default('cash'),
});

const drilldownQuery = z.object({
  account: z.string().min(1, 'QBO account id'),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
});

const customQuery = z.object({
  range: z.string().default('all'),
  flow: z.enum(['in', 'out', 'both']).default('both'),
  account: z.string().default('all'),
  groupBy: z.enum(['tag', 'cat', 'acct']).default('tag'),
  tagIds: z.string().optional(), // CSV
});

const savedConfigSchema = z.object({
  range: z.string(),
  flow: z.enum(['in', 'out', 'both']),
  account: z.string(),
  groupBy: z.enum(['tag', 'cat', 'acct']),
  tagIds: z.array(z.string()),
});

const savedCreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  config: savedConfigSchema,
});

function toSavedReportDto(row: { id: string; companyId: string; name: string; config: unknown }): SavedReportDto {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    config: row.config as SavedReportConfig,
  };
}

export const reportsRouter = Router({ mergeParams: true });
reportsRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('viewer'));

reportsRouter.get(
  '/pl',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const q = validate(plQuery)(req.query);
    res.json(await profitAndLoss(company.id, q));
  }),
);

reportsRouter.get(
  '/bs',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const q = validate(bsQuery)(req.query);
    // 'YYYY-MM' → zero-based month index (the statement service's encoding).
    const yyyyMm = /^(\d{4})-(\d{2})$/.exec(q.asOf);
    const asOf = yyyyMm ? String(Number(yyyyMm[2]) - 1) : q.asOf;
    res.json(await balanceSheet(company.id, { asOf, compare: q.compare, basis: q.basis }));
  }),
);

// The transactions behind one statement row (viewer+): the account's activity
// within the statement's period.
reportsRouter.get(
  '/drilldown',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const q = validate(drilldownQuery)(req.query);
    res.json(await statementDrilldown(company.id, { accountQboId: q.account, start: q.start, end: q.end }));
  }),
);

reportsRouter.get(
  '/custom',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const q = validate(customQuery)(req.query);
    const config: SavedReportConfig = {
      range: q.range,
      flow: q.flow,
      account: q.account,
      groupBy: q.groupBy,
      tagIds: (q.tagIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    };
    res.json(await customReport(company.id, config));
  }),
);

reportsRouter.get(
  '/saved',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rows = await prisma.savedReport.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'asc' },
    });
    const body: SavedReportDto[] = rows.map(toSavedReportDto);
    res.json(body);
  }),
);

reportsRouter.post(
  '/saved',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { name, config } = validate(savedCreateBody)(req.body);
    const row = await prisma.savedReport.create({
      data: { companyId: company.id, name, config },
    });
    res.status(201).json(toSavedReportDto(row));
  }),
);

reportsRouter.delete(
  '/saved/:id',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing report id', 'BAD_REQUEST');
    const row = await prisma.savedReport.findUnique({ where: { id } });
    if (!row || row.companyId !== company.id) throw new HttpError(404, 'Saved report not found', 'REPORT_NOT_FOUND');
    await prisma.savedReport.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
