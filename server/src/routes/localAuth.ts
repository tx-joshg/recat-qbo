import type { CookieOptions } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthMethodsDto, SessionDto } from '@recat/shared';
import { localAdminConfig } from '../env.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../middleware/auth.js';
import {
  authenticateLocalAdmin,
  type LocalAdminUser,
} from '../services/localAdminAuth.js';
import type { LocalAdminConfig } from '../services/localAdminConfig.js';
import { LocalLoginLimiter } from '../services/localLoginLimiter.js';
import { toUserDto } from './auth.js';

const localLoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export interface LocalAuthDependencies {
  config: LocalAdminConfig;
  authenticate(email: string, password: string): Promise<LocalAdminUser | null>;
  createSession(userId: string): Promise<{ token: string; expiresAt: Date }>;
  limiter: LocalLoginLimiter;
  cookieOptions(origin?: string): CookieOptions;
}

const realDependencies: LocalAuthDependencies = {
  config: localAdminConfig,
  authenticate: (email, password) => authenticateLocalAdmin(email, password),
  createSession,
  limiter: new LocalLoginLimiter(),
  cookieOptions: sessionCookieOptions,
};

export function createLocalAuthRouter(deps: LocalAuthDependencies = realDependencies): Router {
  const router = Router();

  router.get('/auth/methods', (_req, res) => {
    const body: AuthMethodsDto = { localAdmin: deps.config.enabled };
    res.json(body);
  });

  router.post('/auth/local', asyncHandler(async (req, res) => {
    if (!deps.config.enabled) throw new HttpError(404, 'Not found', 'NOT_FOUND');
    const source = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = deps.limiter.acquire(source);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpError(429, 'Too many login attempts — try again later', 'RATE_LIMITED');
    }

    const body = localLoginBody.safeParse(req.body);
    if (!body.success) {
      throw new HttpError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }
    let user: LocalAdminUser | null;
    try {
      user = await deps.authenticate(body.data.email, body.data.password);
    } catch (error) {
      deps.limiter.release(limit.reservation);
      throw error;
    }
    if (!user) {
      throw new HttpError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    deps.limiter.clear(source);
    const session = await deps.createSession(user.id);
    res.cookie(SESSION_COOKIE, session.token, deps.cookieOptions(req.headers.origin));
    const response: SessionDto = { user: toUserDto(user) };
    res.json(response);
  }));

  return router;
}

export const localAuthRouter = createLocalAuthRouter();
