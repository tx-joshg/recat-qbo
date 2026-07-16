// Company scoping for routes mounted at /api/companies/:companyId/...
// EVERY tenant query downstream must filter by req.company.id — a route that
// touches tenant data without this middleware is a security bug (CLAUDE.md).

import type { RequestHandler } from 'express';
import { asyncHandler, HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';

export interface WithCompanyOptions {
  /**
   * Allow a disconnected company (disconnectedAt set). Used by settings and
   * audit reads — history stays visible after disconnect; sync/write paths
   * must NOT set this.
   */
  allowDisconnected?: boolean;
}

export function withCompany(options: WithCompanyOptions = {}): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const companyId = req.params.companyId;
    if (!companyId) throw new HttpError(400, 'Missing companyId', 'BAD_REQUEST');
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company || (company.disconnectedAt !== null && !options.allowDisconnected)) {
      throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    }
    req.company = company;
    next();
  });
}
