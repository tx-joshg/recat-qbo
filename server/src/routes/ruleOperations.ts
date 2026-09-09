import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireBrowserMutationOrigin, requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { McpOperationError } from '../services/mcp/operations.js';
import {
  commitRuleChange,
  prepareRuleChange,
  prepareRuleChangeFromCase,
  RuleChangeError,
  type RuleChangePrincipal,
} from '../services/ruleChanges.js';

const id = z.string().min(1).max(128);
const proposal = z.object({
  matchText: z.string().trim().min(1).max(200).optional(),
  direction: z.enum(['Purchase', 'Deposit']).optional(),
  categoryQboId: z.string().trim().min(1).max(120).optional(),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']).optional(),
  taxCodeQboId: z.string().trim().min(1).max(120).nullable().optional(),
  tagIds: z.array(id).max(50).optional(),
  autoPost: z.boolean().optional(),
  sourceCaseId: id.nullable().optional(),
  reviewReason: z.string().trim().min(1).max(500).optional(),
}).strict();
const prepareBody = z.object({
  mutation: z.enum(['update', 'review', 'enable', 'disable', 'activate_candidate', 'dismiss_candidate']),
  ruleId: id.optional(), candidateId: id.optional(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  idempotencyKey: id, retryOfId: id.optional(),
  proposal: proposal.optional(),
}).strict();
const commitBody = z.object({ idempotencyKey: id }).strict();
const fromCaseBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  idempotencyKey: id, retryOfId: id.optional(),
}).strict();

function principal(req: Express.Request): RuleChangePrincipal {
  if (!req.user || !req.sessionId) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return { kind: 'session', sessionId: req.sessionId, userId: req.user.id };
}
async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof McpOperationError) {
      if (error.code === 'OPERATION_INVALID_INPUT') {
        throw new HttpError(400, error.message, 'INVALID_INPUT');
      }
      if (error.code === 'OPERATION_NOT_FOUND') {
        throw new HttpError(404, error.message, 'NOT_FOUND');
      }
      if (error.code === 'IDEMPOTENCY_CONFLICT') {
        throw new HttpError(409, error.message, 'IDEMPOTENCY_CONFLICT');
      }
      throw new HttpError(409, error.message, 'CONFLICT');
    }
    if (!(error instanceof RuleChangeError)) throw error;
    if (error.code === 'UNAUTHORIZED') throw new HttpError(401, error.message, error.code);
    if (error.code === 'FORBIDDEN') throw new HttpError(403, error.message, error.code);
    if (error.code === 'COMPANY_DISCONNECTED') throw new HttpError(409, error.message, error.code);
    if (error.code === 'NOT_FOUND') throw new HttpError(404, error.message, error.code);
    if (error.code === 'INVALID_INPUT') throw new HttpError(400, error.message, error.code);
    if (error.code === 'OPERATION_EXPIRED') throw new HttpError(410, error.message, error.code);
    throw new HttpError(409, error.message, error.code);
  }
}

export const ruleOperationsRouter = Router({ mergeParams: true });
ruleOperationsRouter.use(
  requireUser, requireBrowserMutationOrigin, withCompany(), requireRole('categorizer'),
);

ruleOperationsRouter.post('/prepare', asyncHandler(async (req, res) => {
  const body = validate(prepareBody)(req.body);
  res.json(await mapped(() => prepareRuleChange(principal(req), {
    companyId: req.params.companyId!, ...body,
  })));
}));

ruleOperationsRouter.post('/:operationId/commit', asyncHandler(async (req, res) => {
  const body = validate(commitBody)(req.body);
  res.json(await mapped(() => commitRuleChange(principal(req), {
    companyId: req.params.companyId!, operationId: validate(id)(req.params.operationId), ...body,
  })));
}));

ruleOperationsRouter.post('/from-case/:caseId/prepare', asyncHandler(async (req, res) => {
  const body = validate(fromCaseBody)(req.body);
  res.json(await mapped(() => prepareRuleChangeFromCase(
    principal(req), req.params.companyId!, validate(id)(req.params.caseId), body,
  )));
}));
