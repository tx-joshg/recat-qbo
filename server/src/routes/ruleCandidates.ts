import type { Company } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  getRuleCandidate,
  listRuleCandidates,
  RuleCandidateError,
} from '../services/ruleCandidates.js';

const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const idSchema = z.string().uuid();

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RuleCandidateError)) throw error;
    if (error.code === 'CANDIDATE_NOT_FOUND') {
      throw new HttpError(404, error.message, error.code);
    }
    throw new HttpError(409, error.message, error.code);
  }
}

export const ruleCandidatesRouter = Router({ mergeParams: true });
ruleCandidatesRouter.use(
  requireUser,
  requireRole('categorizer'),
  withCompany({ allowDisconnected: true }),
);

ruleCandidatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const query = validate(listQuery)(req.query);
    res.json(await mapped(() => listRuleCandidates(company.id, query)));
  }),
);

ruleCandidatesRouter.post(
  '/:id/dismiss',
  asyncHandler(async () => {
    throw new HttpError(409, 'Use the two-phase rule operation API', 'RULE_OPERATION_REQUIRED');
  }),
);

ruleCandidatesRouter.post(
  '/:id/activate',
  asyncHandler(async () => {
    throw new HttpError(409, 'Use the two-phase rule operation API', 'RULE_OPERATION_REQUIRED');
  }),
);

ruleCandidatesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const candidateId = validate(idSchema)(req.params.id);
    res.json(await mapped(() => getRuleCandidate(company.id, candidateId)));
  }),
);
