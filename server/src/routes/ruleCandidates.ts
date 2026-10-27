import type { Company } from '../lib/db.js';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  activateRuleCandidate,
  dismissRuleCandidate,
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

function actor(req: Express.Request): { id: string; label: string } {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return {
    id: req.user.id,
    label: req.user.name?.trim() || req.user.email,
  };
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
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const candidateId = validate(idSchema)(req.params.id);
    res.json(await mapped(() =>
      dismissRuleCandidate(company.id, candidateId, actor(req))));
  }),
);

ruleCandidatesRouter.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const candidateId = validate(idSchema)(req.params.id);
    res.json(await mapped(() =>
      activateRuleCandidate(company.id, candidateId, actor(req))));
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
