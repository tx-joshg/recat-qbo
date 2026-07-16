// Small HTTP plumbing shared by every route: async wrapper, typed errors,
// central error middleware, and zod body validation.

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { ApiError } from '@recat/shared';

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** Wrap an async express handler so rejections reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Central error handler: HttpError → its status + {error, code}; anything else → 500. */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    const body: ApiError = err.code !== undefined ? { error: err.message, code: err.code } : { error: err.message };
    res.status(err.status).json(body);
    return;
  }
  console.error('[recat] unhandled error:', err);
  const body: ApiError = { error: 'Internal server error' };
  res.status(500).json(body);
};

/** Parse a request body against a zod schema; throws HttpError 400 on failure. */
export function validate<S extends z.ZodTypeAny>(schema: S): (body: unknown) => z.infer<S> {
  return (body: unknown): z.infer<S> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new HttpError(400, `Invalid request: ${detail}`, 'VALIDATION');
    }
    return result.data as z.infer<S>;
  };
}
