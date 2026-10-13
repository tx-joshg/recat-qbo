import type {
  Prisma,
  PrismaClient,
  ReceiptDocumentStatus,
  ReceiptSourceKind,
} from '@prisma/client';
import {
  Prisma as PrismaRuntime,
} from '@prisma/client';
import { z } from 'zod';
import type {
  AttachmentDto,
  ReceiptDetailDto,
  ReceiptBatchItem,
  ReceiptBatchResult,
  ReceiptDuplicateGroupDto,
  ReceiptDto,
  ReceiptEditablePatch,
  ReceiptEventDto,
  ReceiptListResponse,
  ReceiptMatchCandidateDto,
  ReceiptMatchEvidenceDto,
  ReceiptStatsDto,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import {
  toReceiptDto,
  toReceiptExtractionDto,
} from './intake.js';
import { ReceiptError } from './types.js';

export interface ReceiptQuery {
  statuses: ReceiptDocumentStatus[];
  documentTypes: string[];
  dateFrom: Date | null;
  dateTo: Date | null;
  sourceKinds: ReceiptSourceKind[];
  missingInfo: boolean;
  duplicate: boolean;
  matched: boolean | null;
  search: string;
  sortBy: 'createdAt' | 'receiptDate' | 'vendorName' | 'totalAmount' | 'status';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface ReceiptQueryDeps {
  readonly db?: PrismaClient;
}

const receiptListInclude = {
  attempts: {
    where: { status: 'succeeded' },
    orderBy: [
      { generation: 'desc' },
      { attemptCount: 'desc' },
      { startedAt: 'desc' },
    ],
    take: 1,
  },
} satisfies Prisma.ReceiptDocumentInclude;

const receiptDetailInclude = {
  attempts: {
    orderBy: [
      { generation: 'desc' },
      { attemptCount: 'desc' },
      { startedAt: 'desc' },
    ],
    take: 25,
  },
  events: {
    orderBy: { createdAt: 'desc' },
    take: 100,
  },
  transactionAttachment: true,
} satisfies Prisma.ReceiptDocumentInclude;

const decimalString = z.string().regex(/^-?\d{1,14}(?:\.\d{1,4})?$/u);
const nullableTrimmed = (max: number) =>
  z.string().trim().max(max).nullable().optional();
const receiptLineItemSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  quantity: decimalString.nullable(),
  unitPrice: decimalString.nullable(),
}).strict();
const receiptTaxComponentSchema = z.object({
  label: z.string().trim().min(1).max(200),
  rate: decimalString.nullable(),
  amount: decimalString.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
}).strict();
const additionalFieldSchema = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().max(2_000),
}).strict();
const editableReceiptPatchSchema = z.object({
  receiptDate: z.string().date().nullable().optional(),
  documentTitle: nullableTrimmed(500),
  vendorName: nullableTrimmed(500),
  vendorTaxId: nullableTrimmed(200),
  vendorReceiptId: nullableTrimmed(200),
  clientName: nullableTrimmed(500),
  clientTaxId: nullableTrimmed(200),
  description: nullableTrimmed(10_000),
  subtotal: decimalString.nullable().optional(),
  taxAmount: decimalString.nullable().optional(),
  totalAmount: decimalString.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable().optional(),
  paymentMethod: nullableTrimmed(80),
  paymentIdentifier: nullableTrimmed(200),
  language: nullableTrimmed(16),
  documentType: nullableTrimmed(80),
  category: nullableTrimmed(500),
  userNotes: z.string().max(20_000).nullable().optional(),
  lineItems: z.array(receiptLineItemSchema).max(1_000).optional(),
  taxComponents: z.array(receiptTaxComponentSchema).max(20).optional(),
  additionalFields: z.array(additionalFieldSchema).max(200).optional(),
  approved: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0);

const metadataFields = [
  'receiptDate',
  'documentTitle',
  'vendorName',
  'vendorTaxId',
  'vendorReceiptId',
  'clientName',
  'clientTaxId',
  'description',
  'subtotal',
  'taxAmount',
  'totalAmount',
  'currency',
  'paymentMethod',
  'paymentIdentifier',
  'language',
  'documentType',
  'category',
  'lineItems',
  'taxComponents',
  'additionalFields',
] as const;

const matchSensitiveFields = new Set<keyof ReceiptEditablePatch>([
  'receiptDate',
  'vendorName',
  'totalAmount',
  'currency',
  'paymentIdentifier',
  'documentType',
]);

function dbOf(deps?: ReceiptQueryDeps): PrismaClient {
  return deps?.db ?? prisma;
}

function jsonObject(
  value: Prisma.JsonValue,
): Record<string, Prisma.JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

type ReceiptListRow = Prisma.ReceiptDocumentGetPayload<{
  include: typeof receiptListInclude;
}>;

function toProjectedReceiptDto(row: ReceiptListRow): ReceiptDto {
  const currentAttempt = row.attempts.find((attempt) =>
    attempt.generation === row.generation);
  const dto = toReceiptDto({
    ...row,
    attempts: currentAttempt ? [currentAttempt] : [],
  });
  if (dto.currentExtraction === null) return dto;
  const overrides = jsonObject(row.currentMetadata);
  const projection = { ...dto.currentExtraction };
  for (const field of metadataFields) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) {
      Object.assign(projection, { [field]: overrides[field] });
    }
  }
  return { ...dto, currentExtraction: projection };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function assertQuery(query: ReceiptQuery): void {
  if (
    query.statuses.length > 5
    || query.documentTypes.length > 5
    || query.sourceKinds.length > 5
    || query.documentTypes.some((value) =>
      value.trim() === '' || Buffer.byteLength(value, 'utf8') > 80)
    || Buffer.byteLength(query.search, 'utf8') > 200
    || !Number.isInteger(query.page)
    || query.page < 1
    || !Number.isInteger(query.pageSize)
    || query.pageSize < 1
    || query.pageSize > 100
    || ![
      'createdAt',
      'receiptDate',
      'vendorName',
      'totalAmount',
      'status',
    ].includes(query.sortBy)
    || (query.sortOrder !== 'asc' && query.sortOrder !== 'desc')
    || (
      query.dateFrom !== null
      && !Number.isFinite(query.dateFrom.getTime())
    )
    || (
      query.dateTo !== null
      && !Number.isFinite(query.dateTo.getTime())
    )
    || (
      query.dateFrom !== null
      && query.dateTo !== null
      && query.dateFrom > query.dateTo
    )
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt query is invalid.',
    );
  }
}

function projectedText(field: string): Prisma.Sql {
  return PrismaRuntime.raw(
    `(CASE WHEN d."currentMetadata" ? '${field}' `
    + `THEN d."currentMetadata"->>'${field}' ELSE a."${field}"::text END)`,
  );
}

function projectedDate(field: string): Prisma.Sql {
  return PrismaRuntime.raw(
    `(CASE WHEN d."currentMetadata" ? '${field}' `
    + `THEN (d."currentMetadata"->>'${field}')::date `
    + `ELSE a."${field}" END)`,
  );
}

function projectedDecimal(field: string): Prisma.Sql {
  return PrismaRuntime.raw(
    `(CASE WHEN d."currentMetadata" ? '${field}' `
    + `THEN (d."currentMetadata"->>'${field}')::decimal `
    + `ELSE a."${field}" END)`,
  );
}

function whereSql(companyId: string, query: ReceiptQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    PrismaRuntime.sql`d."companyId" = ${companyId}`,
    PrismaRuntime.sql`d."deletedAt" IS NULL`,
  ];
  if (query.statuses.length > 0) {
    conditions.push(
      PrismaRuntime.sql`d."status"::text IN (${PrismaRuntime.join(query.statuses)})`,
    );
  }
  if (query.sourceKinds.length > 0) {
    conditions.push(
      PrismaRuntime.sql`d."sourceKind"::text IN (${PrismaRuntime.join(query.sourceKinds)})`,
    );
  }
  if (query.documentTypes.length > 0) {
    conditions.push(
      PrismaRuntime.sql`${projectedText('documentType')} IN (${PrismaRuntime.join(query.documentTypes)})`,
    );
  }
  if (query.dateFrom !== null) {
    conditions.push(
      PrismaRuntime.sql`${projectedDate('receiptDate')} >= ${query.dateFrom}`,
    );
  }
  if (query.dateTo !== null) {
    conditions.push(
      PrismaRuntime.sql`${projectedDate('receiptDate')} <= ${query.dateTo}`,
    );
  }
  if (query.missingInfo) {
    conditions.push(PrismaRuntime.sql`(
      a."id" IS NULL
      OR ${projectedDate('receiptDate')} IS NULL
      OR ${projectedText('vendorName')} IS NULL
      OR ${projectedDecimal('totalAmount')} IS NULL
    )`);
  }
  if (query.matched !== null) {
    conditions.push(query.matched
      ? PrismaRuntime.sql`d."matchedTransactionId" IS NOT NULL`
      : PrismaRuntime.sql`d."matchedTransactionId" IS NULL`);
  }
  if (query.search.trim() !== '') {
    const text = query.search.trim();
    const filenamePattern = `%${escapeLikePattern(text)}%`;
    const predicates: Prisma.Sql[] = [
      PrismaRuntime.sql`(
        (
          d."currentMetadata" = '{}'::jsonb
          AND a."search_vector" @@ websearch_to_tsquery('simple', ${text})
        )
        OR (
          d."currentMetadata" <> '{}'::jsonb
          AND to_tsvector(
            'simple',
            concat_ws(
              ' ',
              ${projectedText('documentTitle')},
              ${projectedText('vendorName')},
              ${projectedText('vendorTaxId')},
              ${projectedText('vendorReceiptId')},
              ${projectedText('description')},
              a."rawExtractedText",
              ${projectedText('currency')}
            )
          ) @@ websearch_to_tsquery('simple', ${text})
        )
      )`,
      PrismaRuntime.sql`d."originalFilename" ILIKE ${filenamePattern} ESCAPE E'\\\\'`,
      PrismaRuntime.sql`d."id" = ${text}`,
    ];
    if (/^-?\d{1,14}(?:\.\d{1,4})?$/u.test(text)) {
      predicates.push(
        PrismaRuntime.sql`${projectedDecimal('totalAmount')} = CAST(${text} AS DECIMAL(18, 4))`,
      );
    }
    conditions.push(PrismaRuntime.sql`(${PrismaRuntime.join(predicates, ' OR ')})`);
  }
  if (query.duplicate) {
    conditions.push(PrismaRuntime.sql`EXISTS (
      SELECT 1
      FROM "ReceiptDocument" duplicate_document
      JOIN LATERAL (
        SELECT duplicate_attempt.*
        FROM "ReceiptExtractionAttempt" duplicate_attempt
        WHERE duplicate_attempt."documentId" = duplicate_document."id"
          AND duplicate_attempt."status" = 'succeeded'
          AND duplicate_attempt."generation" = duplicate_document."generation"
        ORDER BY
          duplicate_attempt."generation" DESC,
          duplicate_attempt."attemptCount" DESC,
          duplicate_attempt."startedAt" DESC
        LIMIT 1
      ) duplicate_extraction ON TRUE
      WHERE duplicate_document."companyId" = d."companyId"
        AND duplicate_document."deletedAt" IS NULL
        AND duplicate_document."id" <> d."id"
        AND (
          CASE
            WHEN duplicate_document."currentMetadata" ? 'vendorReceiptId'
              THEN duplicate_document."currentMetadata"->>'vendorReceiptId'
            ELSE duplicate_extraction."vendorReceiptId"
          END
        ) IS NOT NULL
        AND lower(trim(
          CASE
            WHEN duplicate_document."currentMetadata" ? 'vendorReceiptId'
              THEN duplicate_document."currentMetadata"->>'vendorReceiptId'
            ELSE duplicate_extraction."vendorReceiptId"
          END
        )) = lower(trim(${projectedText('vendorReceiptId')}))
        AND (
          CASE
            WHEN duplicate_document."currentMetadata" ? 'receiptDate'
              THEN (duplicate_document."currentMetadata"->>'receiptDate')::date
            ELSE duplicate_extraction."receiptDate"
          END
        ) IS NOT DISTINCT FROM ${projectedDate('receiptDate')}
        AND (
          CASE
            WHEN duplicate_document."currentMetadata" ? 'currency'
              THEN duplicate_document."currentMetadata"->>'currency'
            ELSE duplicate_extraction."currency"
          END
        ) IS NOT DISTINCT FROM ${projectedText('currency')}
        AND (
          CASE
            WHEN duplicate_document."currentMetadata" ? 'totalAmount'
              THEN (duplicate_document."currentMetadata"->>'totalAmount')::decimal
            ELSE duplicate_extraction."totalAmount"
          END
        ) IS NOT DISTINCT FROM ${projectedDecimal('totalAmount')}
    )`);
  }
  return PrismaRuntime.join(conditions, ' AND ');
}

function orderSql(query: ReceiptQuery): Prisma.Sql {
  const column = {
    createdAt: PrismaRuntime.raw('d."createdAt"'),
    receiptDate: projectedDate('receiptDate'),
    vendorName: projectedText('vendorName'),
    totalAmount: projectedDecimal('totalAmount'),
    status: PrismaRuntime.raw('d."status"'),
  }[query.sortBy];
  const direction = query.sortOrder === 'asc'
    ? PrismaRuntime.raw('ASC')
    : PrismaRuntime.raw('DESC');
  return PrismaRuntime.sql`${column} ${direction} NULLS LAST, d."id" ${direction}`;
}

function latestAttemptJoin(): Prisma.Sql {
  return PrismaRuntime.sql`
    FROM "ReceiptDocument" d
    LEFT JOIN LATERAL (
      SELECT current_attempt.*
      FROM "ReceiptExtractionAttempt" current_attempt
      WHERE current_attempt."documentId" = d."id"
        AND current_attempt."status" = 'succeeded'
        AND current_attempt."generation" = d."generation"
      ORDER BY
        current_attempt."generation" DESC,
        current_attempt."attemptCount" DESC,
        current_attempt."startedAt" DESC
      LIMIT 1
    ) a ON TRUE
  `;
}

export async function listReceipts(
  companyId: string,
  query: ReceiptQuery,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptListResponse> {
  assertQuery(query);
  if (companyId.trim() === '') {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt company scope is invalid.',
    );
  }
  const db = dbOf(deps);
  const where = whereSql(companyId, query);
  const join = latestAttemptJoin();
  const offset = (query.page - 1) * query.pageSize;
  const [idRows, countRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string }>>(PrismaRuntime.sql`
      SELECT d."id"
      ${join}
      WHERE ${where}
      ORDER BY ${orderSql(query)}
      LIMIT ${query.pageSize}
      OFFSET ${offset}
    `),
    db.$queryRaw<Array<{ count: bigint }>>(PrismaRuntime.sql`
      SELECT COUNT(*)::bigint AS "count"
      ${join}
      WHERE ${where}
    `),
  ]);
  const ids = idRows.map((row) => row.id);
  const rows = ids.length === 0
    ? []
    : await db.receiptDocument.findMany({
        where: { id: { in: ids }, companyId, deletedAt: null },
        include: receiptListInclude,
      });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    receipts: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toProjectedReceiptDto(row)] : [];
    }),
    total: Number(countRows[0]?.count ?? 0n),
    page: query.page,
    pageSize: query.pageSize,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function matchEvidence(value: Prisma.JsonValue): ReceiptMatchEvidenceDto {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
  return {
    amountPoints: finiteNumber(record.amountPoints),
    currencyPoints: finiteNumber(record.currencyPoints),
    datePoints: finiteNumber(record.datePoints),
    vendorPoints: finiteNumber(record.vendorPoints),
    paymentPoints: finiteNumber(record.paymentPoints),
    amountDifferenceCents: finiteNumber(record.amountDifferenceCents),
    dateDifferenceDays: nullableFiniteNumber(record.dateDifferenceDays),
    vendorSimilarity: nullableFiniteNumber(record.vendorSimilarity),
  };
}

function matchCandidateDto(
  row: Prisma.ReceiptMatchCandidateGetPayload<{
    include: { transaction: true };
  }>,
): ReceiptMatchCandidateDto {
  return {
    transactionId: row.transactionId,
    transactionRevision: row.transactionRevision,
    rank: row.rank,
    score: row.score,
    state: row.state as ReceiptMatchCandidateDto['state'],
    evidence: matchEvidence(row.evidence),
    transaction: {
      id: row.transaction.id,
      date: row.transaction.date.toISOString(),
      payee: row.transaction.payee,
      memo: row.transaction.memo,
      amount: Number(row.transaction.amount),
      status: row.transaction.status,
      revision: row.transaction.revision,
    },
  };
}

function eventRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventDto(
  row: Prisma.ReceiptEventGetPayload<Record<string, never>>,
): ReceiptEventDto {
  return {
    id: row.id,
    action: row.action,
    actorUserId: row.actorUserId,
    before: eventRecord(row.before),
    after: eventRecord(row.after),
    createdAt: row.createdAt.toISOString(),
  };
}

function attachmentDto(
  row: NonNullable<Prisma.ReceiptDocumentGetPayload<{
    include: { transactionAttachment: true };
  }>['transactionAttachment']>,
): AttachmentDto {
  return {
    id: row.id,
    transactionId: row.transactionId,
    filename: row.originalFilename,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sourceKind: row.sourceKind,
    retainedLocally: row.blobId !== null,
    status: row.status,
    qboAttached:
      row.qboAttachableId !== null
      && row.status !== 'DELETED'
      && row.status !== 'QBO_MISSING',
    canPreview:
      row.contentType === 'application/pdf'
      || row.contentType.startsWith('image/')
      || row.contentType.startsWith('text/'),
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: 'The attachment operation requires attention.',
        }
      : null,
  };
}

export async function getReceiptDetail(
  companyId: string,
  receiptId: string,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptDetailDto> {
  const db = dbOf(deps);
  const row = await db.receiptDocument.findFirst({
    where: { id: receiptId, companyId, deletedAt: null },
    include: receiptDetailInclude,
  });
  if (!row) {
    throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
  }
  const currentAttemptId = row.attempts.find(
    (attempt) =>
      attempt.status === 'succeeded' && attempt.generation === row.generation,
  )?.id;
  const [previous, next, candidates] = await Promise.all([
    db.receiptDocument.findFirst({
      where: {
        companyId,
        deletedAt: null,
        OR: [
          { createdAt: { gt: row.createdAt } },
          { createdAt: row.createdAt, id: { lt: row.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
      select: { id: true },
    }),
    db.receiptDocument.findFirst({
      where: {
        companyId,
        deletedAt: null,
        OR: [
          { createdAt: { lt: row.createdAt } },
          { createdAt: row.createdAt, id: { gt: row.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true },
    }),
    currentAttemptId
      ? db.receiptMatchCandidate.findMany({
          where: {
            documentId: row.id,
            extractionAttemptId: currentAttemptId,
          },
          orderBy: { rank: 'asc' },
          take: 20,
          include: { transaction: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    ...toProjectedReceiptDto({ ...row, attempts: row.attempts
      .filter((attempt) =>
        attempt.status === 'succeeded' && attempt.generation === row.generation)
      .slice(0, 1) }),
    previousId: previous?.id ?? null,
    nextId: next?.id ?? null,
    attempts: row.attempts.map(toReceiptExtractionDto),
    candidates: candidates.map(matchCandidateDto),
    events: row.events.map(eventDto),
    attachment: row.transactionAttachment
      ? attachmentDto(row.transactionAttachment)
      : null,
  };
}

export async function setReceiptDeleted(
  companyId: string,
  receiptId: string,
  actorUserId: string,
  deleted: boolean,
  expectedRevision: number,
  deps?: ReceiptQueryDeps,
): Promise<void> {
  const db = dbOf(deps);
  await runSerializableTransaction(db, async (transaction) => {
    const existing = await transaction.receiptDocument.findFirst({
      where: {
        id: receiptId,
        companyId,
      },
      select: {
        id: true,
        revision: true,
        status: true,
        deletedAt: true,
        transactionAttachmentId: true,
      },
    });
    if (!existing) {
      throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
    }
    if (
      existing.revision !== expectedRevision
      || (existing.deletedAt !== null) === deleted
      || existing.status === 'ATTACHING'
      || existing.status === 'ATTACHED'
      || existing.transactionAttachmentId !== null
    ) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    const updated = await transaction.receiptDocument.updateMany({
      where: {
        id: existing.id,
        companyId,
        revision: expectedRevision,
        deletedAt: deleted ? null : { not: null },
      },
      data: {
        deletedAt: deleted ? new Date() : null,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    await transaction.receiptEvent.create({
      data: {
        companyId,
        documentId: existing.id,
        actorUserId,
        action: deleted ? 'deleted' : 'restored',
        before: { deleted: existing.deletedAt !== null },
        after: { deleted },
      },
    });
  });
}

export interface UpdateReceiptInput {
  companyId: string;
  documentId: string;
  actorUserId: string;
  expectedRevision: number;
  patch: ReceiptEditablePatch;
}

function parseEditablePatch(patch: ReceiptEditablePatch): ReceiptEditablePatch {
  const result = editableReceiptPatchSchema.safeParse(patch);
  if (!result.success) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt edit is invalid.',
    );
  }
  return result.data;
}

export async function updateReceipt(
  input: UpdateReceiptInput,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptDetailDto> {
  const db = dbOf(deps);
  const patch = parseEditablePatch(input.patch);
  const changedFields = Object.keys(patch).sort();
  await runSerializableTransaction(db, async (transaction) => {
    const existing = await transaction.receiptDocument.findFirst({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        revision: true,
        status: true,
        currentMetadata: true,
      },
    });
    if (!existing) {
      throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
    }
    if (existing.revision !== input.expectedRevision) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    const currentMetadata = jsonObject(existing.currentMetadata);
    const invalidatesMatch = changedFields.some((field) =>
      matchSensitiveFields.has(field as keyof ReceiptEditablePatch));
    if (existing.status === 'ATTACHING') {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt cannot be edited while attachment work is in progress.',
      );
    }
    if (invalidatesMatch && existing.status === 'ATTACHED') {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Attached receipt matching fields cannot be edited.',
      );
    }
    for (const field of metadataFields) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        currentMetadata[field] = patch[field] as Prisma.JsonValue;
      }
    }
    const updated = await transaction.receiptDocument.updateMany({
      where: {
        id: existing.id,
        companyId: input.companyId,
        revision: input.expectedRevision,
        deletedAt: null,
      },
      data: {
        currentMetadata:
          currentMetadata as unknown as Prisma.InputJsonValue,
        ...(Object.prototype.hasOwnProperty.call(patch, 'userNotes')
          ? { userNotes: patch.userNotes }
          : {}),
        ...(patch.approved === true
          ? {
              approvedAt: new Date(),
              approvedByUserId: input.actorUserId,
            }
          : patch.approved === false
            ? { approvedAt: null, approvedByUserId: null }
            : {}),
        manuallyEdited: true,
        ...(invalidatesMatch && existing.status === 'MATCHED'
          ? {
              status: 'READY',
              matchedTransactionId: null,
              matchedTransactionRevision: null,
              approvedAt: null,
              approvedByUserId: null,
            }
          : {}),
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    if (invalidatesMatch) {
      await transaction.receiptMatchCandidate.updateMany({
        where: {
          documentId: existing.id,
          state: { in: ['proposed', 'confirmed'] },
        },
        data: { state: 'stale' },
      });
    }
    await transaction.receiptEvent.create({
      data: {
        companyId: input.companyId,
        documentId: existing.id,
        actorUserId: input.actorUserId,
        action: 'receipt_edited',
        before: {
          revision: existing.revision,
          changedFields,
        },
        after: {
          revision: existing.revision + 1,
          changedFields,
        },
      },
    });
  });
  return getReceiptDetail(input.companyId, input.documentId, deps);
}

export interface ReceiptStatsRangeInput {
  dateFrom: Date | null;
  dateTo: Date | null;
}

function assertStatsRange(range: ReceiptStatsRangeInput): void {
  if (
    (range.dateFrom !== null && !Number.isFinite(range.dateFrom.getTime()))
    || (range.dateTo !== null && !Number.isFinite(range.dateTo.getTime()))
    || (
      range.dateFrom !== null
      && range.dateTo !== null
      && range.dateFrom > range.dateTo
    )
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt stats range is invalid.',
    );
  }
}

function addCurrencyAmount(
  totals: Map<string, Prisma.Decimal>,
  currency: string | null,
  amount: string | null,
): void {
  if (currency === null || amount === null) return;
  const current = totals.get(currency) ?? new PrismaRuntime.Decimal(0);
  totals.set(currency, current.plus(new PrismaRuntime.Decimal(amount)));
}

function currencyTotals(
  totals: Map<string, Prisma.Decimal>,
): Array<{ currency: string; amount: string }> {
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toString() }));
}

export async function receiptStats(
  companyId: string,
  range: ReceiptStatsRangeInput,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptStatsDto> {
  assertStatsRange(range);
  const db = dbOf(deps);
  const createdAt = {
    ...(range.dateFrom === null ? {} : { gte: range.dateFrom }),
    ...(range.dateTo === null ? {} : { lte: range.dateTo }),
  };
  const where = {
    companyId,
    deletedAt: null,
    ...(Object.keys(createdAt).length === 0 ? {} : { createdAt }),
  };
  const [rows, cost, recentEvents] = await Promise.all([
    db.receiptDocument.findMany({
      where,
      include: receiptListInclude,
    }),
    db.receiptExtractionAttempt.aggregate({
      where: { document: where },
      _sum: { costUsd: true },
    }),
    db.receiptEvent.findMany({
      where: { companyId, document: { deletedAt: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ]);
  const totalByCurrency = new Map<string, Prisma.Decimal>();
  const totalTaxByCurrency = new Map<string, Prisma.Decimal>();
  const totalByCategory = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const extraction = toProjectedReceiptDto(row).currentExtraction;
    if (extraction === null) continue;
    addCurrencyAmount(
      totalByCurrency,
      extraction.currency,
      extraction.totalAmount,
    );
    addCurrencyAmount(
      totalTaxByCurrency,
      extraction.currency,
      extraction.taxAmount,
    );
    if (extraction.currency !== null && extraction.totalAmount !== null) {
      const category = extraction.category?.trim() || 'Uncategorized';
      const key = JSON.stringify([category, extraction.currency]);
      totalByCategory.set(
        key,
        (totalByCategory.get(key) ?? new PrismaRuntime.Decimal(0)).plus(
          new PrismaRuntime.Decimal(extraction.totalAmount),
        ),
      );
    }
  }
  const count = (status: ReceiptDocumentStatus) =>
    rows.filter((row) => row.status === status).length;
  return {
    received: rows.length,
    needsReview: count('NEEDS_REVIEW'),
    queued: count('QUEUED'),
    processing: count('PROCESSING'),
    failed: count('FAILED'),
    totalByCurrency: currencyTotals(totalByCurrency),
    totalByCategory: [...totalByCategory]
      .map(([key, amount]) => {
        const [category, currency] = JSON.parse(key) as [string, string];
        return { category, currency, amount: amount.toString() };
      })
      .sort((left, right) =>
        left.category.localeCompare(right.category)
        || left.currency.localeCompare(right.currency)),
    totalTaxByCurrency: currencyTotals(totalTaxByCurrency),
    processingCostUsd: cost._sum.costUsd?.toString() ?? '0',
    recentActivity: recentEvents.map(eventDto),
  };
}

function normalizeIdentityPart(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized === '' ? null : normalized;
}

interface DuplicateIdentityFields {
  vendorReceiptId: string | null;
  receiptDate: string | null;
  currency: string | null;
  totalAmount: string | null;
}

function duplicateIdentityKey(
  extraction: DuplicateIdentityFields | null,
): string | null {
  const vendorReceiptId = normalizeIdentityPart(
    extraction?.vendorReceiptId ?? null,
  );
  if (
    extraction === null
    || vendorReceiptId === null
    || extraction.receiptDate === null
    || extraction.currency === null
    || extraction.totalAmount === null
  ) {
    return null;
  }
  let normalizedTotal: string;
  try {
    normalizedTotal = new PrismaRuntime.Decimal(
      extraction.totalAmount,
    ).toString();
  } catch {
    return null;
  }
  return [
    vendorReceiptId,
    extraction.receiptDate,
    extraction.currency,
    normalizedTotal,
  ].join('|');
}

const duplicateIdentityOverrideFields = [
  'vendorReceiptId',
  'receiptDate',
  'currency',
  'totalAmount',
] as const;

export async function getReceiptDuplicateGroups(
  companyId: string,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptDuplicateGroupDto[]> {
  const db = dbOf(deps);
  // First pass reads only the identity columns, so the full receipt (with its
  // extracted text) is loaded only for receipts that actually have a twin.
  const identities = await db.receiptDocument.findMany({
    where: { companyId, deletedAt: null },
    select: {
      id: true,
      generation: true,
      currentMetadata: true,
      attempts: {
        ...receiptListInclude.attempts,
        select: {
          generation: true,
          vendorReceiptId: true,
          receiptDate: true,
          currency: true,
          totalAmount: true,
        },
      },
    },
  });
  const idsByKey = new Map<string, string[]>();
  for (const row of identities) {
    const attempt = row.attempts.find((candidate) =>
      candidate.generation === row.generation);
    if (attempt === undefined) continue;
    const fields: DuplicateIdentityFields = {
      vendorReceiptId: attempt.vendorReceiptId,
      receiptDate: attempt.receiptDate?.toISOString().slice(0, 10) ?? null,
      currency: attempt.currency,
      totalAmount: attempt.totalAmount?.toString() ?? null,
    };
    const overrides = jsonObject(row.currentMetadata);
    for (const field of duplicateIdentityOverrideFields) {
      if (Object.prototype.hasOwnProperty.call(overrides, field)) {
        const value = overrides[field];
        fields[field] = typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : null;
      }
    }
    const key = duplicateIdentityKey(fields);
    if (key === null) continue;
    const ids = idsByKey.get(key) ?? [];
    ids.push(row.id);
    idsByKey.set(key, ids);
  }
  const candidateIds = [...idsByKey.values()]
    .filter((ids) => ids.length > 1)
    .flat();
  if (candidateIds.length === 0) return [];

  const rows = await db.receiptDocument.findMany({
    where: { companyId, deletedAt: null, id: { in: candidateIds } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    include: receiptListInclude,
  });
  const byKey = new Map<string, ReceiptDto[]>();
  for (const row of rows) {
    const dto = toProjectedReceiptDto(row);
    const key = duplicateIdentityKey(dto.currentExtraction);
    if (key === null) continue;
    const group = byKey.get(key) ?? [];
    group.push(dto);
    byKey.set(key, group);
  }
  return [...byKey]
    .filter(([, receipts]) => receipts.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, receipts]) => ({
      key,
      reason: 'document_identity',
      receipts,
    }));
}

export interface BatchReceiptStateInput {
  companyId: string;
  actorUserId: string;
  action: 'approve' | 'delete';
  receipts: ReceiptBatchItem[];
}

function assertBatchInput(input: BatchReceiptStateInput): void {
  const ids = new Set(input.receipts.map((receipt) => receipt.id));
  if (
    input.companyId.trim() === ''
    || input.actorUserId.trim() === ''
    || input.receipts.length < 1
    || input.receipts.length > 100
    || ids.size !== input.receipts.length
    || input.receipts.some((receipt) =>
      receipt.id.trim() === ''
      || !Number.isInteger(receipt.expectedRevision)
      || receipt.expectedRevision < 0)
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt batch selection is invalid.',
    );
  }
}

export async function batchReceiptState(
  input: BatchReceiptStateInput,
  deps?: ReceiptQueryDeps,
): Promise<ReceiptBatchResult> {
  assertBatchInput(input);
  const db = dbOf(deps);
  await runSerializableTransaction(db, async (transaction) => {
    const ids = input.receipts.map((receipt) => receipt.id);
    const existing = await transaction.receiptDocument.findMany({
      where: {
        companyId: input.companyId,
        id: { in: ids },
        deletedAt: null,
      },
      select: {
        id: true,
        revision: true,
        approvedAt: true,
        status: true,
        transactionAttachmentId: true,
      },
    });
    const byId = new Map(existing.map((receipt) => [receipt.id, receipt]));
    for (const requested of input.receipts) {
      const receipt = byId.get(requested.id);
      if (!receipt) {
        throw new ReceiptError(
          'RECEIPT_NOT_FOUND',
          'One or more selected receipts were not found.',
        );
      }
      if (
        receipt.revision !== requested.expectedRevision
        || (input.action === 'approve' && receipt.approvedAt !== null)
        || (
          input.action === 'delete'
          && (
            receipt.status === 'ATTACHING'
            || receipt.status === 'ATTACHED'
            || receipt.transactionAttachmentId !== null
          )
        )
      ) {
        throw new ReceiptError(
          'RECEIPT_STALE',
          'A selected receipt changed; refresh before retrying.',
        );
      }
    }
    const changedAt = new Date();
    for (const requested of input.receipts) {
      const updated = await transaction.receiptDocument.updateMany({
        where: {
          id: requested.id,
          companyId: input.companyId,
          revision: requested.expectedRevision,
          deletedAt: null,
          ...(input.action === 'approve' ? { approvedAt: null } : {}),
        },
        data: input.action === 'approve'
          ? {
              approvedAt: changedAt,
              approvedByUserId: input.actorUserId,
              revision: { increment: 1 },
            }
          : {
              deletedAt: changedAt,
              revision: { increment: 1 },
            },
      });
      if (updated.count !== 1) {
        throw new ReceiptError(
          'RECEIPT_STALE',
          'A selected receipt changed; refresh before retrying.',
        );
      }
      await transaction.receiptEvent.create({
        data: {
          companyId: input.companyId,
          documentId: requested.id,
          actorUserId: input.actorUserId,
          action: input.action === 'approve'
            ? 'receipt_approved'
            : 'deleted',
          before: {
            revision: requested.expectedRevision,
            ...(input.action === 'approve' ? { approved: false } : {
              deleted: false,
            }),
          },
          after: {
            revision: requested.expectedRevision + 1,
            ...(input.action === 'approve' ? { approved: true } : {
              deleted: true,
            }),
          },
        },
      });
    }
  });
  return { updated: input.receipts.length };
}
