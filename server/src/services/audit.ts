// Append-only audit service. Every QBO write (real or dry-run) records an
// AuditEntry; callers pass their Prisma transaction client so the audit row
// commits atomically with the status change (CLAUDE.md requirement).
// There is intentionally no update or delete API for this table.

import type { AuditEntry, Prisma, PrismaClient } from '@prisma/client';
import type { AuditAction, AuditEntryDto } from '@recat/shared';
import { prisma } from '../lib/prisma.js';

/** Either the root client or an interactive-transaction client. */
export type PrismaTransactionClientOrPrisma = PrismaClient | Prisma.TransactionClient;

export type MutationAuditOutcome =
  | 'DRY_RUN'
  | 'VERIFIED'
  | 'UNCERTAIN'
  | 'UNCHANGED'
  | 'RETRYABLE';

export interface MutationAuditInput {
  requestId: string;
  outcome: MutationAuditOutcome;
  references: {
    operation: 'recategorize' | 'restore' | 'transfer';
    qboType: string;
    qboId: string;
    accountQboIds: string[];
    taxCodeQboIds: string[];
  };
  mcp?: {
    sourceOperationId: string;
    operationId: string;
    tokenPrefix: string;
  };
}

export interface AttachmentAuditInput {
  attachmentCount: number;
  totalBytes: number;
  sourceKinds: readonly (
    | 'LOCAL_UPLOAD'
    | 'HTTPS_IMPORT'
    | 'QBO_EXTERNAL'
  )[];
  state:
    | 'PREPARED'
    | 'COMMITTING'
    | 'PARTIAL'
    | 'VERIFIED'
    | 'FAILED'
    | 'UNCERTAIN'
    | 'DELETING'
    | 'DELETED';
}

export function normalizeAttachmentAuditMetadata(
  input: AttachmentAuditInput,
): {
  attachmentCount: number;
  sizeBucket: 'UNDER_1MB' | '1MB_TO_10MB' | '10MB_TO_100MB';
  sourceKinds: AttachmentAuditInput['sourceKinds'][number][];
  state: AttachmentAuditInput['state'];
} {
  const sizeBucket = input.totalBytes < 1_000_000
    ? 'UNDER_1MB'
    : input.totalBytes < 10_000_000
      ? '1MB_TO_10MB'
      : '10MB_TO_100MB';
  return {
    attachmentCount: Math.max(0, Math.min(20, input.attachmentCount)),
    sizeBucket,
    sourceKinds: [...new Set(input.sourceKinds)].sort(),
    state: input.state,
  };
}

export interface AuditInput {
  companyId: string;
  /** userId, or null/undefined for system actions */
  actorId?: string | null;
  /** display name or 'system' */
  actorLabel: string;
  txnId?: string;
  payee: string;
  amount: number | Prisma.Decimal;
  action: AuditAction;
  /** holding account */
  before: string;
  /** full category path, or split summary */
  after: string;
  /** QBO write details (dry-run keeps them too); credential fields are redacted. */
  payload?: unknown;
  /**
   * Tax-aware durable writes use a strict metadata allowlist. When present,
   * legacy `payload` is ignored so prepared bodies, snapshots, SyncTokens,
   * credentials, and raw errors cannot enter the audit log.
   */
  mutation?: MutationAuditInput;
}

const MAX_AUDIT_REFERENCE_LENGTH = 128;
const MAX_AUDIT_REFERENCES = 50;
const MAX_TOKEN_PREFIX_LENGTH = 12;

function boundedReference(
  value: string,
  maximum = MAX_AUDIT_REFERENCE_LENGTH,
): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, maximum);
}

function normalizedReferences(values: string[]): string[] {
  return [...new Set(
    values
      .map((value) => boundedReference(value))
      .filter((value) => value !== ''),
  )]
    .sort()
    .slice(0, MAX_AUDIT_REFERENCES);
}

export function normalizeMutationAuditMetadata(entry: MutationAuditInput): {
  requestId: string;
  outcome: MutationAuditOutcome;
  references: MutationAuditInput['references'];
  mcp?: NonNullable<MutationAuditInput['mcp']>;
} {
  return {
    requestId: boundedReference(entry.requestId),
    outcome: entry.outcome,
    references: {
      operation: entry.references.operation,
      qboType: boundedReference(entry.references.qboType),
      qboId: boundedReference(entry.references.qboId),
      accountQboIds: normalizedReferences(entry.references.accountQboIds),
      taxCodeQboIds: normalizedReferences(entry.references.taxCodeQboIds),
    },
    ...(entry.mcp === undefined
      ? {}
      : {
          mcp: {
            sourceOperationId: boundedReference(entry.mcp.sourceOperationId),
            operationId: boundedReference(entry.mcp.operationId),
            tokenPrefix: boundedReference(
              entry.mcp.tokenPrefix,
              MAX_TOKEN_PREFIX_LENGTH,
            ),
          },
        }),
  };
}

const CREDENTIAL_KEY = /token|authorization|secret|credential|(?:api|access|private)[_-]?key|password|passwd|passphrase|pwd|bearer/i;
const QBO_REVISION_KEY = /^sync[_-]?token$/i;

/** Copy legacy JSON payloads so redaction cannot alter a caller's write evidence. */
function redactAuditPayload(value: unknown): unknown {
  // JSON's normal serialization preserves Date/Decimal and calls each toJSON
  // once. The replacer also visits fields produced by those serializers.
  const serialized = JSON.stringify(value, (key, nested: unknown) => (
    CREDENTIAL_KEY.test(key) && !QBO_REVISION_KEY.test(key)
      ? '[REDACTED]'
      : nested
  ));
  return serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
}

export async function writeAudit(tx: PrismaTransactionClientOrPrisma, entry: AuditInput): Promise<void> {
  const payload = entry.mutation === undefined
    ? redactAuditPayload(entry.payload)
    : normalizeMutationAuditMetadata(entry.mutation);
  await tx.auditEntry.create({
    data: {
      companyId: entry.companyId,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel,
      txnId: entry.txnId ?? null,
      payee: entry.payee,
      amount: entry.amount,
      action: entry.action,
      before: entry.before,
      after: entry.after,
      payload: payload === undefined ? undefined : (payload as Prisma.InputJsonValue),
    },
  });
}

export interface ListAuditOptions {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  entries: AuditEntryDto[];
  nextCursor: string | null;
}

function toAuditDto(row: AuditEntry): AuditEntryDto {
  const dto: AuditEntryDto = {
    id: row.id,
    companyId: row.companyId,
    at: row.at.toISOString(),
    actor: row.actorLabel,
    payee: row.payee,
    amount: Number(row.amount),
    action: row.action as AuditAction,
    before: row.before,
    after: row.after,
  };
  if (row.payload !== null) dto.payload = row.payload;
  return dto;
}

/** Does the entry match the free-text search across when/who/payee/amount/action/before/after? */
function matchesSearch(dto: AuditEntryDto, q: string): boolean {
  const haystacks = [
    dto.at,
    dto.actor,
    dto.payee,
    String(dto.amount),
    dto.amount.toFixed(2),
    dto.action,
    dto.before,
    dto.after,
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listAudit(companyId: string, opts: ListAuditOptions = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const search = opts.search?.trim().toLowerCase() ?? '';

  if (search !== '') {
    // Search spans formatted fields (timestamps, amounts) that SQL contains()
    // can't express against Decimal/DateTime columns; audit volume per company
    // is small in a self-hosted install, so filter in memory.
    const rows = await prisma.auditEntry.findMany({
      where: { companyId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
    });
    const matched = rows.map(toAuditDto).filter((d) => matchesSearch(d, search));
    let start = 0;
    if (opts.cursor) {
      const idx = matched.findIndex((d) => d.id === opts.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const entries = matched.slice(start, start + limit);
    const last = entries[entries.length - 1];
    const nextCursor = last !== undefined && matched.length > start + limit ? last.id : null;
    return { entries, nextCursor };
  }

  const rows = await prisma.auditEntry.findMany({
    where: { companyId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map(toAuditDto);
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last !== undefined ? last.id : null;
  return { entries, nextCursor };
}

// ---- CSV export ----

/** RFC-4180 escaping: quote when the value contains a comma, quote, or newline. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const AUDIT_CSV_HEADER = 'When,Who,Transaction,Amount,Action,Before,After';

/** Pure CSV builder (unit-testable without a database). */
export function buildAuditCsv(entries: AuditEntryDto[]): string {
  const lines = entries.map((e) =>
    [e.at, e.actor, e.payee, e.amount.toFixed(2), e.action, e.before, e.after].map(csvEscape).join(','),
  );
  return [AUDIT_CSV_HEADER, ...lines].join('\n') + '\n';
}

export async function auditCsv(companyId: string): Promise<string> {
  const rows = await prisma.auditEntry.findMany({
    where: { companyId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  });
  return buildAuditCsv(rows.map(toAuditDto));
}
