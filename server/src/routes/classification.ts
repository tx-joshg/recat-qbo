import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  getClassificationCase,
  searchClassificationKnowledge,
  getHistoricalObservation,
  listPastDecisions,
  getCurrentClassificationCase,
} from '../services/companyReads.js';

const searchQuery = z.object({
  query: z.string().trim().min(1).max(256),
  mode: z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']),
  scope: z.enum(['current_company', 'accessible_companies']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
  transactionId: z.string().min(1).max(128).optional(),
}).strict();
const currentQuery = z.object({ transactionId: z.string().min(1).max(128) }).strict();
const pastDecisionQuery = z.object({
  kind: z.enum(['all', 'classification_case', 'historical_observation']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
}).strict();
const id = z.string().min(1).max(128);

function userId(req: Express.Request): string {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return req.user.id;
}

export const classificationRouter = Router({ mergeParams: true });
classificationRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('viewer'));



classificationRouter.get('/cases/current', asyncHandler(async (req, res) => {
  const query = validate(currentQuery)(req.query);
  res.json(await getCurrentClassificationCase(userId(req), req.params.companyId!, query.transactionId));
}));





classificationRouter.get('/cases/:caseId', asyncHandler(async (req, res) => {
  res.json(await getClassificationCase(
    userId(req), req.params.companyId!, validate(id)(req.params.caseId),
  ));
}));

classificationRouter.get('/past-decisions', asyncHandler(async (req, res) => {
  const query = validate(pastDecisionQuery)(req.query);
  res.json(await listPastDecisions(userId(req), req.params.companyId!, query));
}));

classificationRouter.get('/observations/:observationId', asyncHandler(async (req, res) => {
  res.json(await getHistoricalObservation(
    userId(req), req.params.companyId!, validate(id)(req.params.observationId),
  ));
}));

classificationRouter.get('/search', asyncHandler(async (req, res) => {
  const query = validate(searchQuery)(req.query);
  res.json(await searchClassificationKnowledge(userId(req), req.params.companyId!, {
    query: query.query,
    mode: query.mode,
    scope: query.scope ?? 'current_company',
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.transactionId === undefined ? {} : { transactionId: query.transactionId }),
  }));
}));
