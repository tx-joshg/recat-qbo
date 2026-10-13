import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { requireUser } from '../middleware/auth.js';
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
} from '../services/mcp/tokens.js';

const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const createBody = z
  .object({
    label,
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
const tokenId = z.string().uuid();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();

export const mcpTokensRouter = Router();
mcpTokensRouter.use(requireUser);

mcpTokensRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const query = validate(listQuery)(req.query);
    res.json(
      await listMcpTokens(req.user.id, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
    );
  }),
);

mcpTokensRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const body = validate(createBody)(req.body);
    res.status(201).json(
      await createMcpToken({
        userId: req.user.id,
        label: body.label,
        viaExposedSession: req.sessionViaExposedLink === true,
        ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
      }),
    );
  }),
);

mcpTokensRouter.delete(
  '/:tokenId',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const id = validate(tokenId)(req.params.tokenId);
    await revokeMcpToken(req.user.id, id);
    res.status(204).end();
  }),
);
