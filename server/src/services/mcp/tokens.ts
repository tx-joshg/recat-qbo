import type {
  CreateMcpTokenResponse,
  McpTokenDto,
  McpTokenListResponse,
  McpTokenStatus,
} from '@recat/shared';
import { HttpError } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { writeSecurityAudit, type SecurityAuditWriter } from '../securityAudit.js';

export const MCP_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const MCP_TOKEN_MAX_EXPIRY_DAYS = 365;
export const MCP_TOKEN_MAX_LABEL_LENGTH = 80;
const TOKEN_PREFIX = 'rct_';
const DISPLAY_PREFIX_LENGTH = 12;
const MAX_COLLISION_ATTEMPTS = 3;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]+$/;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface McpTokenRow {
  id: string;
  userId: string;
  digest: string;
  prefix: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

type McpTokenListRow = Pick<
  McpTokenRow,
  'id' | 'prefix' | 'label' | 'createdAt' | 'expiresAt' | 'lastUsedAt' | 'revokedAt'
>;

interface McpTokenCursorPosition {
  createdAt: Date;
  id: string;
}

interface McpTokenListWhere {
  userId: string;
  OR?: [
    { createdAt: { lt: Date } },
    { createdAt: Date; id: { lt: string } },
  ];
}

interface McpTokenTransaction extends SecurityAuditWriter {
  mcpToken: {
    create(args: {
      data: {
        userId: string;
        digest: string;
        prefix: string;
        label: string;
        expiresAt: Date;
        viaExposedSession: boolean;
      };
    }): Promise<McpTokenRow>;
    findFirst(args: {
      where: { id: string; userId: string; revokedAt: null };
      select: { prefix: true };
    }): Promise<{ prefix: string } | null>;
    updateMany(args: {
      where: { id: string; userId: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface McpTokenStore {
  mcpToken: {
    findMany(args: {
      where: McpTokenListWhere;
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }];
      take: number;
      select: {
        id: true;
        prefix: true;
        label: true;
        createdAt: true;
        expiresAt: true;
        lastUsedAt: true;
        revokedAt: true;
      };
    }): Promise<McpTokenListRow[]>;
  };
  $transaction<T>(callback: (transaction: McpTokenTransaction) => Promise<T>): Promise<T>;
}

interface TokenDependencies {
  db?: McpTokenStore;
  now?: () => Date;
  generateToken?: () => string;
}

export interface CreateMcpTokenInput {
  userId: string;
  label: string;
  expiresInDays?: number;
  /**
   * Minted from a demo-mode devLink session. The token then stops working once
   * a real company is connected, so it cannot outlive the session it came from.
   */
  viaExposedSession?: boolean;
}

export interface ListMcpTokensInput {
  limit?: number;
  cursor?: string;
}

function normalizedLabel(label: string): string {
  const normalized = label.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MCP_TOKEN_MAX_LABEL_LENGTH ||
    !SAFE_LABEL.test(normalized)
  ) {
    throw new HttpError(400, 'Invalid token label', 'VALIDATION');
  }
  return normalized;
}

function normalizedExpiry(expiresInDays: number | undefined): number {
  const days = expiresInDays ?? MCP_TOKEN_DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MCP_TOKEN_MAX_EXPIRY_DAYS) {
    throw new HttpError(400, 'Token expiry must be between 1 and 365 days', 'VALIDATION');
  }
  return days;
}

function status(row: McpTokenListRow, now: Date): McpTokenStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function toDto(row: McpTokenListRow, now: Date): McpTokenDto {
  return {
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    status: status(row, now),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function normalizedListLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new HttpError(400, 'Token list limit must be between 1 and 100', 'VALIDATION');
  }
  return value;
}

function invalidCursor(): HttpError {
  return new HttpError(400, 'Invalid token list cursor', 'VALIDATION');
}

function encodeCursor(row: McpTokenListRow): string {
  return Buffer.from(
    JSON.stringify({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string | undefined): McpTokenCursorPosition | null {
  if (cursor === undefined) return null;
  if (
    cursor.length < 1 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !BASE64URL.test(cursor)
  ) {
    throw invalidCursor();
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
    const value = JSON.parse(decoded) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidCursor();
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'createdAt,id,v' ||
      record.v !== 1 ||
      typeof record.createdAt !== 'string' ||
      typeof record.id !== 'string' ||
      !UUID.test(record.id)
    ) {
      throw invalidCursor();
    }
    const createdAt = new Date(record.createdAt);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== record.createdAt
    ) {
      throw invalidCursor();
    }
    return { createdAt, id: record.id };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidCursor();
  }
}

function isUniqueCollision(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export async function createMcpToken(
  input: CreateMcpTokenInput,
  dependencies: TokenDependencies = {},
): Promise<CreateMcpTokenResponse> {
  const db = dependencies.db ?? (prisma as unknown as McpTokenStore);
  const now = dependencies.now?.() ?? new Date();
  const label = normalizedLabel(input.label);
  const expiresInDays = normalizedExpiry(input.expiresInDays);
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
  const generateToken =
    dependencies.generateToken ?? (() => `${TOKEN_PREFIX}${randomToken(32)}`);

  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const token = generateToken();
    const prefix = token.slice(0, DISPLAY_PREFIX_LENGTH);
    try {
      const row = await db.$transaction(async (transaction) => {
        const created = await transaction.mcpToken.create({
          data: {
            userId: input.userId,
            digest: sha256Hex(token),
            prefix,
            label,
            expiresAt,
            viaExposedSession: input.viaExposedSession === true,
          },
        });
        await writeSecurityAudit(transaction, {
          actorUserId: input.userId,
          action: 'mcp_token.created',
          subjectId: created.id,
          subjectPrefix: prefix,
        });
        return created;
      });
      return { token, mcpToken: toDto(row, now) };
    } catch (error) {
      if (isUniqueCollision(error) && attempt + 1 < MAX_COLLISION_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new Error('Unable to generate a unique MCP token');
}

export async function listMcpTokens(
  userId: string,
  input: ListMcpTokensInput = {},
  dependencies: TokenDependencies = {},
): Promise<McpTokenListResponse> {
  const db = dependencies.db ?? (prisma as unknown as McpTokenStore);
  const now = dependencies.now?.() ?? new Date();
  const limit = normalizedListLimit(input.limit);
  const position = decodeCursor(input.cursor);
  const where: McpTokenListWhere = position === null
    ? { userId }
    : {
        userId,
        OR: [
          { createdAt: { lt: position.createdAt } },
          { createdAt: position.createdAt, id: { lt: position.id } },
        ],
      };
  const rows = await db.mcpToken.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      prefix: true,
      label: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => toDto(row, now)),
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}

export async function revokeMcpToken(
  userId: string,
  tokenId: string,
  dependencies: TokenDependencies = {},
): Promise<void> {
  const db = dependencies.db ?? (prisma as unknown as McpTokenStore);
  const now = dependencies.now?.() ?? new Date();
  await db.$transaction(async (transaction) => {
    const existing = await transaction.mcpToken.findFirst({
      where: { id: tokenId, userId, revokedAt: null },
      select: { prefix: true },
    });
    if (existing === null) return;
    const result = await transaction.mcpToken.updateMany({
      where: { id: tokenId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count === 0) return;
    await writeSecurityAudit(transaction, {
      actorUserId: userId,
      action: 'mcp_token.revoked',
      subjectId: tokenId,
      subjectPrefix: existing.prefix,
    });
  });
}
