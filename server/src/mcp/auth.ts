import { requireBearerAuth } from '@modelcontextprotocol/express';
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import { sha256Hex } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { devLoginAllowed } from '../services/devLogin.js';

export const RECAT_MCP_SCOPE = 'recat:mcp';

const RECAT_PAT = /^rct_[A-Za-z0-9_-]{43}$/;

export interface McpMembership {
  readonly companyId: string;
  readonly role: string;
}

export interface McpPrincipal {
  readonly tokenId: string;
  readonly tokenPrefix: string;
  readonly userId: string;
  readonly isInstanceAdmin: boolean;
  readonly memberships: readonly McpMembership[];
}

interface McpTokenAuthRow {
  id: string;
  prefix: string;
  expiresAt: Date;
  revokedAt: Date | null;
  viaExposedSession?: boolean;
  user: {
    id: string;
    isInstanceAdmin: boolean;
    memberships: Array<{ companyId: string; role: string }>;
  };
}

interface McpTokenAuthStore {
  mcpToken: {
    findUnique(args: {
      where: { digest: string };
      include: { user: { include: { memberships: true } } };
    }): Promise<McpTokenAuthRow | null>;
    updateMany(args: {
      where: {
        id: string;
        revokedAt: null;
        expiresAt: { gt: Date };
      };
      data: { lastUsedAt: Date };
    }): Promise<{ count: number }>;
  };
}

interface RecatTokenVerifierDependencies {
  db?: McpTokenAuthStore;
  now?: () => Date;
  onLastUsedError?: (error: unknown) => void;
  devLoginAllowed?: () => Promise<boolean>;
}

function invalidToken(): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
}

function safePrincipal(row: McpTokenAuthRow): McpPrincipal {
  const memberships = row.user.memberships.map((membership) =>
    Object.freeze({
      companyId: membership.companyId,
      role: membership.role,
    }),
  );
  Object.freeze(memberships);
  return Object.freeze({
    tokenId: row.id,
    tokenPrefix: row.prefix,
    userId: row.user.id,
    isInstanceAdmin: row.user.isInstanceAdmin,
    memberships,
  });
}

export function createRecatTokenVerifier(
  dependencies: RecatTokenVerifierDependencies = {},
): OAuthTokenVerifier {
  const db = dependencies.db ?? (prisma as unknown as McpTokenAuthStore);
  const now = dependencies.now ?? (() => new Date());
  const isDevLoginAllowed = dependencies.devLoginAllowed ?? devLoginAllowed;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!RECAT_PAT.test(token)) throw invalidToken();

      const checkedAt = now();
      const row = await db.mcpToken.findUnique({
        where: { digest: sha256Hex(token) },
        include: { user: { include: { memberships: true } } },
      });
      if (
        row === null ||
        row.revokedAt !== null ||
        row.expiresAt.getTime() <= checkedAt.getTime()
      ) {
        throw invalidToken();
      }
      // Minted from a demo-mode devLink session: dies with that session once
      // real books are connected (see requireUser).
      if (row.viaExposedSession === true && !(await isDevLoginAllowed())) throw invalidToken();

      const principal = safePrincipal(row);
      void Promise.resolve()
        .then(() =>
          db.mcpToken.updateMany({
            where: {
              id: row.id,
              revokedAt: null,
              expiresAt: { gt: checkedAt },
            },
            data: { lastUsedAt: checkedAt },
          }),
        )
        .catch((error: unknown) => {
          dependencies.onLastUsedError?.(error);
        });

      return Object.freeze({
        token: row.id,
        clientId: `recat-user:${row.user.id}`,
        scopes: Object.freeze([RECAT_MCP_SCOPE]) as unknown as string[],
        expiresAt: row.expiresAt.getTime() / 1_000,
        extra: Object.freeze({ principal }),
      });
    },
  };
}

export function createRecatBearerAuth(verifier: OAuthTokenVerifier): RequestHandler {
  const options = {
    verifier,
    requiredScopes: [RECAT_MCP_SCOPE],
  };
  const sdkBearerAuth = requireBearerAuth(options);
  return (req, res, next) => {
    const authorization = req.headers.authorization;
    if (
      authorization === undefined ||
      !/^Bearer [^\s]+$/i.test(authorization)
    ) {
      const error = invalidToken();
      const challenge = bearerAuthChallengeResponse(error, options)
        .headers.get('WWW-Authenticate');
      if (challenge !== null) res.set('WWW-Authenticate', challenge);
      res.status(401).json(error.toResponseObject());
      return;
    }
    sdkBearerAuth(req, res, next);
  };
}
