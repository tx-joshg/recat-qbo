// Append-only audit service. Every QBO write (real or dry-run) records an
// AuditEntry; callers pass their Prisma transaction client so the audit row
// commits atomically with the status change (CLAUDE.md requirement).
// There is intentionally no update or delete API for this table.

import type { AuditEntry, Prisma, PrismaClient } from '@prisma/client';
import type { AuditAction, AuditEntryDto } from '@recat/shared';
import { prisma } from '../lib/prisma.js';

/** Either the root client or an interactive-transaction client. */
export type PrismaTransactionClientOrPrisma = PrismaClient | Prisma.TransactionClient;

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
  /** exact QBO request body (dry-run keeps it too) */
  payload?: unknown;
}

const SECRET_KEY = /(?:access|refresh)?token|authorization|clientsecret|api[_-]?key|password/i;

/** Defense in depth: audit payloads are durable and must never retain secrets. */
export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditPayload);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : redactAuditPayload(nested),
      ]),
    );
  }
  return value;
}

export async function writeAudit(tx: PrismaTransactionClientOrPrisma, entry: AuditInput): Promise<void> {
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
      payload:
        entry.payload === undefined
          ? undefined
          : (redactAuditPayload(entry.payload) as Prisma.InputJsonValue),
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

/** Keep append-only legacy rows readable under the current public action name. */
export function normalizeAuditAction(action: string): AuditAction {
  return action === 'autopilot-mode-changed' ? 'autopilot' : (action as AuditAction);
}

function toAuditDto(row: AuditEntry): AuditEntryDto {
  const dto: AuditEntryDto = {
    id: row.id,
    companyId: row.companyId,
    at: row.at.toISOString(),
    actor: row.actorLabel,
    payee: row.payee,
    amount: Number(row.amount),
    action: normalizeAuditAction(row.action),
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
