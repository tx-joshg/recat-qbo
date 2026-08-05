import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';

type McpGuardMiddleware = RequestHandler | ErrorRequestHandler;

interface McpHttpGuardOptions {
  appUrl: string;
  additionalHosts?: readonly string[];
  /**
   * Extra origins admitted per request, on top of appUrl — the configured
   * public URL, which an operator can change after boot.
   *
   * Resolved rather than fixed because appUrl is only the deployment's starting
   * address now. It *adds* to the allowed set and never replaces it: keeping
   * the boot-time origin means a misconfiguration degrades to "MCP does not
   * work on my new host yet" instead of severing a client that works today.
   * Failures here are swallowed for the same reason. See #40.
   */
  resolveExtraOrigins?: () => Promise<readonly string[]>;
  maxBodyBytes: number;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function deploymentUrl(appUrl: string): URL | null {
  try {
    return new URL(appUrl);
  } catch {
    return null;
  }
}

export function isAllowedMcpHost(
  hostHeader: string | undefined,
  appUrl: string,
  additionalHosts: readonly string[] = [],
): boolean {
  const deployment = deploymentUrl(appUrl);
  if (
    deployment === null ||
    hostHeader === undefined ||
    hostHeader.length === 0 ||
    /[\s/@?#\\]/.test(hostHeader)
  ) {
    return false;
  }
  try {
    const candidate = new URL(`${deployment.protocol}//${hostHeader}`);
    const deploymentMatches =
      candidate.hostname.toLowerCase() === deployment.hostname.toLowerCase() &&
      candidate.port === deployment.port &&
      candidate.pathname === '/' &&
      candidate.username === '' &&
      candidate.password === '';
    if (deploymentMatches) return true;
    return additionalHosts.some((allowedHost) => {
      if (
        allowedHost.length === 0 ||
        /[\s/@?#\\]/.test(allowedHost)
      ) {
        return false;
      }
      try {
        const allowed = new URL(`${deployment.protocol}//${allowedHost}`);
        return (
          candidate.hostname.toLowerCase() === allowed.hostname.toLowerCase() &&
          candidate.port === allowed.port &&
          allowed.pathname === '/' &&
          allowed.username === '' &&
          allowed.password === ''
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Origin absence is accepted only for non-browser MCP clients. It grants no
 * trust or authentication; any present browser Origin must match exactly.
 */
export function isAllowedMcpOrigin(
  originHeader: string | undefined,
  appUrl: string,
): boolean {
  if (originHeader === undefined) return true;
  const deployment = deploymentUrl(appUrl);
  if (deployment === null || originHeader === 'null') return false;
  try {
    const candidate = new URL(originHeader);
    return (
      candidate.origin === deployment.origin &&
      candidate.pathname === '/' &&
      candidate.search === '' &&
      candidate.hash === '' &&
      candidate.username === '' &&
      candidate.password === ''
    );
  } catch {
    return false;
  }
}

export function isMcpJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return /^[ \t]*application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")[ \t]*)?$/i
    .test(contentType);
}

function sendError(status: number, code: string): RequestHandler {
  return (_req, res) => {
    res.status(status).json({ error: code });
  };
}

export function createMcpHttpGuards(
  options: McpHttpGuardOptions,
): McpGuardMiddleware[] {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
    throw new Error('maxBodyBytes must be a positive safe integer');
  }
  if (deploymentUrl(options.appUrl) === null) {
    throw new Error('appUrl must be an absolute URL');
  }

  async function extraOrigins(): Promise<readonly string[]> {
    if (options.resolveExtraOrigins === undefined) return [];
    try {
      return await options.resolveExtraOrigins();
    } catch {
      // Never let an unresolvable extra origin reject a request that the
      // boot-time appUrl already admits.
      return [];
    }
  }

  const hostGuard: RequestHandler = (req, res, next) => {
    void extraOrigins().then((extra) => {
      const hosts = [
        ...(options.additionalHosts ?? []),
        ...extra.map(hostOf).filter((host): host is string => host !== null),
      ];
      if (!isAllowedMcpHost(req.headers.host, options.appUrl, hosts)) {
        sendError(421, 'invalid_host')(req, res, next);
        return;
      }
      next();
    });
  };
  const originGuard: RequestHandler = (req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    void extraOrigins().then((extra) => {
      if (
        !isAllowedMcpOrigin(origin, options.appUrl) &&
        !extra.some((allowed) => isAllowedMcpOrigin(origin, allowed))
      ) {
        sendError(403, 'invalid_origin')(req, res, next);
        return;
      }
      next();
    });
  };
  const entityGuard: RequestHandler = (req, res, next) => {
    if (req.method.toUpperCase() !== 'POST') {
      next();
      return;
    }
    const contentType =
      typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']
        : undefined;
    if (!isMcpJsonContentType(contentType)) {
      sendError(415, 'unsupported_media_type')(req, res, next);
      return;
    }
    const length = req.headers['content-length'];
    if (
      typeof length === 'string' &&
      (!/^\d+$/.test(length) || Number(length) > options.maxBodyBytes)
    ) {
      sendError(413, 'request_too_large')(req, res, next);
      return;
    }
    next();
  };
  const jsonParser = express.json({ limit: options.maxBodyBytes });
  const parserError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error && typeof error === 'object' && 'type' in error) {
      const type = (error as { type?: unknown }).type;
      if (type === 'entity.too.large') {
        res.status(413).json({ error: 'request_too_large' });
        return;
      }
      if (type === 'entity.parse.failed') {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
    }
    next(error);
  };

  return [hostGuard, originGuard, entityGuard, jsonParser, parserError];
}
