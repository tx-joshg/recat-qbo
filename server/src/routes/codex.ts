// Instance-admin ChatGPT/Codex device authorization routes. The global
// originCheck middleware supplies CSRF protection before this router runs.

import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { sha256Hex } from '../lib/crypto.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import {
  requireInstanceAdmin,
  requireUser,
  sessionTokenFromRequest,
} from '../middleware/auth.js';
import {
  cancelCodexDeviceFlow,
  disconnectCodex,
  getCodexStatus,
  pollCodexDeviceFlow,
  startCodexDeviceFlow,
} from '../services/ai/codexAuth.js';
import { testCodexConnection } from '../services/ai/provider.js';

const flowBody = z.object({ flowId: z.string().uuid() });

function owner(req: Request): { adminUserId: string; sessionHash: string } {
  const token = sessionTokenFromRequest(req.cookies);
  if (!req.user || !token) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return { adminUserId: req.user.id, sessionHash: sha256Hex(token) };
}

function serviceError(error: unknown, fallback: string): HttpError {
  const value = error instanceof Error ? error : null;
  const rawStatus = value && 'status' in value ? value.status : undefined;
  const status =
    typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600
      ? rawStatus
      : 500;
  return new HttpError(status, status >= 500 ? fallback : (value?.message ?? fallback), 'CODEX_AUTH');
}

export const codexRouter = Router();
codexRouter.use(requireUser, requireInstanceAdmin);

codexRouter.post(
  '/device',
  asyncHandler(async (req, res) => {
    try {
      res.json(await startCodexDeviceFlow(owner(req)));
    } catch (error) {
      throw serviceError(error, 'Failed to start ChatGPT authorization');
    }
  }),
);

codexRouter.post(
  '/device/poll',
  asyncHandler(async (req, res) => {
    const { flowId } = validate(flowBody)(req.body);
    try {
      res.json(await pollCodexDeviceFlow({ flowId, ...owner(req) }));
    } catch (error) {
      throw serviceError(error, 'Failed to poll ChatGPT authorization');
    }
  }),
);

codexRouter.delete(
  '/device',
  asyncHandler(async (req, res) => {
    const { flowId } = validate(flowBody)(req.body);
    try {
      res.json(await cancelCodexDeviceFlow({ flowId, ...owner(req) }));
    } catch (error) {
      throw serviceError(error, 'Failed to cancel ChatGPT authorization');
    }
  }),
);

codexRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    try {
      res.json(await getCodexStatus(owner(req)));
    } catch (error) {
      throw serviceError(error, 'Failed to load ChatGPT status');
    }
  }),
);

codexRouter.post(
  '/test',
  asyncHandler(async (_req, res) => {
    try {
      res.json(await testCodexConnection());
    } catch (error) {
      throw serviceError(error, 'ChatGPT connection test failed');
    }
  }),
);

codexRouter.delete(
  '/',
  asyncHandler(async (_req, res) => {
    try {
      res.json(await disconnectCodex());
    } catch (error) {
      throw serviceError(error, 'Failed to disconnect ChatGPT');
    }
  }),
);
