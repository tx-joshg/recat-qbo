import { createHash } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type {
  ReceiptDocumentStatus,
  ReceiptSourceKind,
  TransactionAttachment,
} from '@prisma/client';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { streamToResponse } from '../lib/responseStream.js';
import { qboFactory } from '../lib/qbo/factory.js';
import { QboAttachmentNotFoundError } from '../lib/qbo/types.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  attachmentActorForUser,
  attachmentContentDisposition,
} from './attachments.js';
import { openAttachmentBlob } from '../services/attachments/blobStore.js';
import {
  AttachmentError,
  type AttachmentBlobReader,
} from '../services/attachments/types.js';
import { EntityLeaseError } from '../services/entityLease.js';
import { createReceipts } from '../services/receipts/intake.js';
import { exportReceipts } from '../services/receipts/export.js';
import {
  attachMatchedReceipt,
  confirmReceiptMatch,
  rematchReceipt,
  undoAttachedReceipt,
} from '../services/receipts/matching.js';
import {
  batchReceiptState,
  getReceiptDuplicateGroups,
  getReceiptDetail,
  listReceipts,
  receiptStats,
  setReceiptDeleted,
  updateReceipt,
  type ReceiptQuery,
} from '../services/receipts/query.js';
import { ReceiptError } from '../services/receipts/types.js';
import {
  batchReprocessReceipts,
  reprocessReceipt,
} from '../services/receipts/worker.js';

const receiptStatuses = [
  'RECEIVED',
  'QUEUED',
  'PROCESSING',
  'NEEDS_REVIEW',
  'READY',
  'MATCHED',
  'ATTACHING',
  'ATTACHED',
  'FAILED',
] as const;
const receiptSourceKinds = [
  'WEB_UPLOAD',
  'API_UPLOAD',
  'MCP_UPLOAD',
] as const;

function commaSeparatedArray<T extends readonly [string, ...string[]]>(
  values: T,
) {
  return z.preprocess((value) => {
    const source = Array.isArray(value) ? value : [value];
    return source.flatMap((item) =>
      typeof item === 'string' && item !== ''
        ? item.split(',').map((part) => part.trim())
        : []);
  }, z.array(z.enum(values)).max(5).default([]));
}

function optionalBoolean(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

const receiptListQuerySchema = z.object({
  status: commaSeparatedArray(receiptStatuses),
  documentType: z.preprocess((value) => {
    const source = Array.isArray(value) ? value : [value];
    return source.flatMap((item) =>
      typeof item === 'string' && item !== ''
        ? item.split(',').map((part) => part.trim())
        : []);
  }, z.array(z.string().trim().min(1).max(80)).max(5).default([])),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sourceKind: commaSeparatedArray(receiptSourceKinds),
  missingInfo: z.preprocess(optionalBoolean, z.boolean().default(false)),
  duplicate: z.preprocess(optionalBoolean, z.boolean().default(false)),
  matched: z.preprocess(optionalBoolean, z.boolean().optional()),
  search: z.string().trim().max(200).default(''),
  sortBy: z.enum([
    'createdAt',
    'receiptDate',
    'vendorName',
    'totalAmount',
    'status',
  ]).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const createReceiptsBodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  files: z.array(z.object({
    uploadId: z.string().uuid(),
    sourceExternalId: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(20),
  sourceKind: z.enum(receiptSourceKinds),
}).strict();

const receiptRevisionSchema = z.object({
  expectedRevision: z.coerce.number().int().min(0).max(2_147_483_647),
}).strict();
const receiptReprocessSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();
const receiptRematchSchema = z.object({
  expectedReceiptRevision: z.number().int().min(0).max(2_147_483_646),
}).strict();
const receiptConfirmMatchSchema = z.object({
  expectedReceiptRevision: z.number().int().min(0).max(2_147_483_646),
  expectedTransactionRevision: z.number().int().min(0).max(2_147_483_647),
}).strict();
const receiptAttachmentMutationSchema = receiptConfirmMatchSchema;
const receiptStatsQuerySchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
}).strict();
const decimalString = z.string().regex(/^-?\d{1,14}(?:\.\d{1,4})?$/u);
const nullableTrimmed = (max: number) =>
  z.string().trim().max(max).nullable().optional();
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
  lineItems: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    quantity: decimalString.nullable(),
    unitPrice: decimalString.nullable(),
  }).strict()).max(1_000).optional(),
  taxComponents: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    rate: decimalString.nullable(),
    amount: decimalString.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
  }).strict()).max(20).optional(),
  additionalFields: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    value: z.string().max(2_000),
  }).strict()).max(200).optional(),
  approved: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0);
const patchReceiptBodySchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  patch: editableReceiptPatchSchema,
}).strict();
const receiptBatchItemSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
}).strict();
const receiptBatchSchema = z.object({
  receipts: z.array(receiptBatchItemSchema).min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
}).strict();
const receiptExportSchema = z.union([
  z.object({
    documentIds: z.array(z.string().uuid()).min(1).max(500),
  }).strict(),
  z.object({
    filters: receiptListQuerySchema,
  }).strict(),
]);

export function parseReceiptListQuery(input: unknown): ReceiptQuery {
  const parsed = validate(receiptListQuerySchema)(input);
  return {
    statuses: parsed.status as ReceiptDocumentStatus[],
    documentTypes: parsed.documentType,
    dateFrom: parsed.dateFrom ?? null,
    dateTo: parsed.dateTo ?? null,
    sourceKinds: parsed.sourceKind as ReceiptSourceKind[],
    missingInfo: parsed.missingInfo,
    duplicate: parsed.duplicate,
    matched: parsed.matched ?? null,
    search: parsed.search,
    sortBy: parsed.sortBy,
    sortOrder: parsed.sortOrder,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

function receiptHttpError(error: unknown): never {
  if (error instanceof EntityLeaseError) {
    throw new HttpError(409, error.message, error.code);
  }
  if (error instanceof AttachmentError) {
    const status = error.code === 'ATTACHMENT_FORBIDDEN'
      ? 403
      : error.code === 'ATTACHMENT_NOT_FOUND'
        ? 404
        : error.code === 'ATTACHMENT_TOO_LARGE'
          || error.code === 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED'
          || error.code === 'ATTACHMENT_INSTANCE_QUOTA_EXCEEDED'
          ? 413
          : error.code === 'ATTACHMENT_BUSY'
            || error.code === 'ATTACHMENT_PROVIDER_UNCERTAIN'
            || error.code === 'IDEMPOTENCY_CONFLICT'
            ? 409
            : 400;
    throw new HttpError(status, error.message, error.code);
  }
  if (!(error instanceof ReceiptError)) throw error;
  const status = error.code === 'RECEIPT_FORBIDDEN'
    ? 403
    : error.code === 'RECEIPT_NOT_FOUND'
      ? 404
      : error.code === 'RECEIPT_IDEMPOTENCY_CONFLICT'
        || error.code === 'RECEIPT_STALE'
        ? 409
        : 400;
  throw new HttpError(status, error.message, error.code);
}

async function receiptCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return receiptHttpError(error);
  }
}

const hideUnscopedCompany: RequestHandler = (req, _res, next) => {
  if (
    req.user?.isInstanceAdmin
    || req.user?.memberships.some(
      (membership) => membership.companyId === req.params.companyId,
    )
  ) {
    next();
    return;
  }
  next(new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND'));
};

async function tryOpenBlob(
  companyId: string,
  blobId: string | null,
): Promise<AttachmentBlobReader | null> {
  if (blobId === null) return null;
  try {
    return await openAttachmentBlob(companyId, blobId);
  } catch (error) {
    if (
      error instanceof AttachmentError
      && error.code === 'ATTACHMENT_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
}

async function streamReceipt(
  companyId: string,
  receiptId: string,
  disposition: 'attachment' | 'inline',
  res: Response,
): Promise<void> {
  const receipt = await prisma.receiptDocument.findFirst({
    where: { id: receiptId, companyId, deletedAt: null },
    include: { transactionAttachment: true },
  });
  if (!receipt) {
    throw new HttpError(404, 'Receipt not found', 'RECEIPT_NOT_FOUND');
  }
  if (
    disposition === 'inline'
    && receipt.contentType !== 'application/pdf'
    && !receipt.contentType.startsWith('image/')
  ) {
    throw new HttpError(
      404,
      'Receipt preview not found',
      'RECEIPT_NOT_FOUND',
    );
  }

  let contentType: string;
  let sizeBytes: number | null;
  let body: AsyncIterable<Uint8Array>;
  const attachment = receipt.transactionAttachment;
  const primary = await tryOpenBlob(companyId, receipt.blobId);
  const fallback = primary === null && attachment?.blobId !== receipt.blobId
    ? await tryOpenBlob(companyId, attachment?.blobId ?? null)
    : null;
  const reader = primary ?? fallback;
  if (reader !== null) {
    contentType = reader.contentType;
    sizeBytes = reader.sizeBytes;
    body = reader.chunks();
  } else if (attachment !== null) {
    const source: TransactionAttachment = attachment;
    if (
      source.qboAttachableId !== null
      && source.status !== 'DELETED'
      && source.status !== 'QBO_MISSING'
    ) {
      const qbo = await qboFactory.forCompany(companyId);
      try {
        const download = await qbo.openAttachmentDownload(source.qboAttachableId);
        contentType = download.contentType;
        sizeBytes = download.sizeBytes;
        body = download.body;
      } catch (error) {
        if (!(error instanceof QboAttachmentNotFoundError)) throw error;
        throw new HttpError(
          410,
          'Receipt content is no longer available',
          'RECEIPT_GONE',
        );
      }
    } else {
      throw new HttpError(
        410,
        'Receipt content is no longer available',
        'RECEIPT_GONE',
      );
    }
  } else {
    throw new HttpError(
      410,
      'Receipt content is no longer available',
      'RECEIPT_GONE',
    );
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    attachmentContentDisposition(receipt.originalFilename, disposition),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; sandbox; img-src 'self' data:; style-src 'unsafe-inline'",
  );
  res.setHeader('Cache-Control', 'private, no-store');
  if (sizeBytes !== null) res.setHeader('Content-Length', String(sizeBytes));
  await streamToResponse(body, res);
}

export const receiptsRouter = Router({ mergeParams: true });
receiptsRouter.use(requireUser, withCompany(), hideUnscopedCompany);

receiptsRouter.post(
  '/',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(createReceiptsBodySchema)(req.body);
    const result = await receiptCall(() => createReceipts({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      files: body.files,
      sourceKind: body.sourceKind,
      idempotencyKey: body.idempotencyKey,
    }));
    res.status(202).json(result);
  }),
);

receiptsRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await receiptCall(() =>
      listReceipts(req.company!.id, parseReceiptListQuery(req.query))));
  }),
);

receiptsRouter.get(
  '/stats',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const range = validate(receiptStatsQuerySchema)(req.query);
    res.json(await receiptCall(() => receiptStats(req.company!.id, {
      dateFrom: range.dateFrom ?? null,
      dateTo: range.dateTo ?? null,
    })));
  }),
);

receiptsRouter.get(
  '/duplicates',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await receiptCall(() =>
      getReceiptDuplicateGroups(req.company!.id)));
  }),
);

receiptsRouter.post(
  '/batch/approve',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptBatchSchema)(req.body);
    res.json(await receiptCall(() => batchReceiptState({
      companyId: req.company!.id,
      actorUserId: req.user!.id,
      action: 'approve',
      receipts: body.receipts,
    })));
  }),
);

receiptsRouter.post(
  '/batch/delete',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptBatchSchema)(req.body);
    res.json(await receiptCall(() => batchReceiptState({
      companyId: req.company!.id,
      actorUserId: req.user!.id,
      action: 'delete',
      receipts: body.receipts,
    })));
  }),
);

receiptsRouter.post(
  '/batch/reprocess',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptBatchSchema)(req.body);
    if (!body.idempotencyKey) {
      throw new HttpError(
        400,
        'Batch reprocess requires an idempotency key.',
        'RECEIPT_INVALID_INPUT',
      );
    }
    await receiptCall(() => batchReprocessReceipts(
      req.company!.id,
      req.user!.id,
      body.receipts.map((receipt) => ({
        ...receipt,
        idempotencyKey: createHash('sha256')
          .update(`${body.idempotencyKey}:${receipt.id}`, 'utf8')
          .digest('hex'),
      })),
    ));
    res.status(202).json({ updated: body.receipts.length });
  }),
);

receiptsRouter.post(
  '/export',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptExportSchema)(req.body);
    let documentIds: string[];
    if ('documentIds' in body) {
      documentIds = body.documentIds;
    } else {
      const baseQuery = parseReceiptListQuery(body.filters);
      documentIds = [];
      let page = 1;
      while (documentIds.length < 500) {
        const result = await receiptCall(() => listReceipts(
          req.company!.id,
          { ...baseQuery, page, pageSize: 100 },
        ));
        if (result.total > 500) {
          throw new HttpError(
            400,
            'Receipt export cannot contain more than 500 receipts.',
            'RECEIPT_INVALID_INPUT',
          );
        }
        documentIds.push(...result.receipts.map((receipt) => receipt.id));
        if (documentIds.length >= result.total) break;
        page += 1;
      }
      if (documentIds.length < 1 || documentIds.length > 500) {
        throw new HttpError(
          400,
          'Receipt export must contain between 1 and 500 receipts.',
          'RECEIPT_INVALID_INPUT',
        );
      }
    }
    const exported = await receiptCall(() => exportReceipts({
      companyId: req.company!.id,
      actorUserId: req.user!.id,
      documentIds,
    }, {
      openQboFile: async (companyId, attachment) => {
        const qbo = await qboFactory.forCompany(companyId);
        try {
          const download = await qbo.openAttachmentDownload(
            attachment.qboAttachableId!,
          );
          return {
            blobId: `qbo:${attachment.qboAttachableId}`,
            sizeBytes: download.sizeBytes ?? Number(attachment.sizeBytes),
            contentType: download.contentType,
            chunks: () => download.body,
          };
        } catch (error) {
          if (error instanceof QboAttachmentNotFoundError) {
            throw new ReceiptError(
              'RECEIPT_NOT_FOUND',
              `Original file is unavailable for receipt ${attachment.id}.`,
            );
          }
          throw error;
        }
      },
    }));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      attachmentContentDisposition(exported.filename, 'attachment'),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await streamToResponse(exported.stream, res, false))) {
      // The client left; the archive is torn down with the stream, so its
      // completion no longer matters and must not surface as unhandled.
      exported.completed.catch(() => undefined);
      return;
    }
    await exported.completed;
    res.end();
  }),
);

receiptsRouter.get(
  '/:receiptId/file',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    await streamReceipt(
      req.company!.id,
      req.params.receiptId!,
      'attachment',
      res,
    );
  }),
);

receiptsRouter.patch(
  '/:receiptId',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(patchReceiptBodySchema)(req.body);
    res.json(await receiptCall(() => updateReceipt({
      companyId: req.company!.id,
      documentId: req.params.receiptId!,
      actorUserId: req.user!.id,
      expectedRevision: body.expectedRevision,
      patch: body.patch,
    })));
  }),
);

receiptsRouter.get(
  '/:receiptId/preview',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    await streamReceipt(
      req.company!.id,
      req.params.receiptId!,
      'inline',
      res,
    );
  }),
);

receiptsRouter.delete(
  '/:receiptId',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const query = validate(receiptRevisionSchema)(req.query);
    await receiptCall(() => setReceiptDeleted(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      true,
      query.expectedRevision,
    ));
    res.status(204).end();
  }),
);

receiptsRouter.post(
  '/:receiptId/restore',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptRevisionSchema)(req.body);
    await receiptCall(() => setReceiptDeleted(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      false,
      body.expectedRevision,
    ));
    res.json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);

receiptsRouter.post(
  '/:receiptId/reprocess',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptReprocessSchema)(req.body);
    await receiptCall(() => reprocessReceipt(
      req.company!.id,
      req.params.receiptId!,
      req.user!.id,
      body.expectedRevision,
      body.idempotencyKey,
    ));
    res.status(202).json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);

receiptsRouter.post(
  '/:receiptId/rematch',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptRematchSchema)(req.body);
    res.json(await receiptCall(() => rematchReceipt({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      documentId: req.params.receiptId!,
      expectedReceiptRevision: body.expectedReceiptRevision,
    })));
  }),
);

receiptsRouter.post(
  '/:receiptId/matches/:transactionId/confirm',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptConfirmMatchSchema)(req.body);
    res.json(await receiptCall(() => confirmReceiptMatch({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      documentId: req.params.receiptId!,
      transactionId: req.params.transactionId!,
      expectedReceiptRevision: body.expectedReceiptRevision,
      expectedTransactionRevision: body.expectedTransactionRevision,
    })));
  }),
);

receiptsRouter.post(
  '/:receiptId/attach',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptAttachmentMutationSchema)(req.body);
    res.status(202).json(await receiptCall(() => attachMatchedReceipt({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      documentId: req.params.receiptId!,
      expectedReceiptRevision: body.expectedReceiptRevision,
      expectedTransactionRevision: body.expectedTransactionRevision,
    })));
  }),
);

receiptsRouter.post(
  '/:receiptId/undo',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(receiptAttachmentMutationSchema)(req.body);
    res.status(202).json(await receiptCall(() => undoAttachedReceipt({
      actor: attachmentActorForUser(req.user!),
      companyId: req.company!.id,
      documentId: req.params.receiptId!,
      expectedReceiptRevision: body.expectedReceiptRevision,
      expectedTransactionRevision: body.expectedTransactionRevision,
    })));
  }),
);

receiptsRouter.get(
  '/:receiptId',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    res.json(await receiptCall(() =>
      getReceiptDetail(req.company!.id, req.params.receiptId!)));
  }),
);
