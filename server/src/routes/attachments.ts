import { once } from 'node:events';
import Busboy from 'busboy';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { User, Membership, TransactionAttachment } from '@prisma/client';
import type {
  AttachmentOperationDto,
  AttachmentSourceInput,
} from '@recat/shared';
import { sha256Hex } from '../lib/crypto.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { streamToResponse } from '../lib/responseStream.js';
import { qboFactory } from '../lib/qbo/factory.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  attachTransactionFiles,
  deleteTransactionAttachment,
  getScopedAttachmentOperation,
  listTransactionAttachments,
  refreshTransactionAttachments,
  reconcileScopedAttachmentOperation,
  retryScopedAttachmentOperation,
  saveExternalAttachmentLocally,
  type AttachmentActor,
} from '../services/attachments/operations.js';
import {
  openAttachmentBlob,
  stageAttachment,
} from '../services/attachments/blobStore.js';
import {
  AttachmentError,
  type StagedAttachmentDto,
} from '../services/attachments/types.js';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from '../services/attachments/validation.js';
import {
  ATTACHMENT_GRANT_TTL_MS,
  ATTACHMENT_MAX_FILES,
  issueAttachmentUploadGrant,
} from '../services/attachments/grants.js';

const MAX_GRANT_TOKEN_BYTES = 256;

const attachBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  sources: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('upload'),
      uploadId: z.string().uuid(),
    }).strict(),
    z.object({
      kind: z.literal('https'),
      url: z.string().max(4096).url().refine(
        (value) => {
          try {
            return new URL(value).protocol === 'https:';
          } catch {
            return false;
          }
        },
        'HTTPS URL required',
      ),
    }).strict(),
  ])).min(1).max(ATTACHMENT_MAX_FILES),
}).strict();

const operationBody = z.object({}).strict();

const grantBody = z.object({
  fileCount: z.number().int().min(1).max(ATTACHMENT_MAX_FILES)
    .default(ATTACHMENT_MAX_FILES),
  maxEncodedRequestBytes: z.number().int().min(1)
    .max(QBO_MAX_UPLOAD_REQUEST_BYTES)
    .default(QBO_MAX_UPLOAD_REQUEST_BYTES),
}).strict();

const deleteQuery = z.object({
  scope: z.enum(['local', 'everywhere']).default('local'),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export function attachmentActorForUser(
  user: Pick<User, 'id' | 'isInstanceAdmin'> & {
    memberships: readonly Pick<Membership, 'companyId' | 'role'>[];
  },
): AttachmentActor {
  return {
    kind: 'session',
    actorKey: `session:${user.id}`,
    userId: user.id,
    isInstanceAdmin: user.isInstanceAdmin,
    memberships: user.memberships.map((membership) => ({
      companyId: membership.companyId,
      role: membership.role,
    })),
  };
}

export function attachmentContentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const basename = filename.split(/[\\/]/u).at(-1) ?? 'attachment';
  const safe = basename
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim()
    .slice(0, 255) || 'attachment';
  const encoded = encodeURIComponent(safe)
    .replace(/[!'()*]/gu, (character) =>
      `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  return `${disposition}; filename="attachment"; filename*=UTF-8''${encoded}`;
}

export function parseAttachmentGrantBearer(
  authorization: string | undefined,
): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/u.exec(authorization);
  return match?.[1] ?? null;
}

function requestActor(req: Request): AttachmentActor {
  if (!req.user) {
    throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  }
  return attachmentActorForUser(req.user);
}

function toHttpError(error: unknown): never {
  if (!(error instanceof AttachmentError)) throw error;
  const status =
    error.code === 'ATTACHMENT_FORBIDDEN'
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

async function transactionExists(
  companyId: string,
  transactionId: string,
): Promise<void> {
  const row = await prisma.transaction.findFirst({
    where: { id: transactionId, companyId },
    select: { id: true },
  });
  if (!row) {
    throw new HttpError(
      404,
      'Transaction not found',
      'TRANSACTION_NOT_FOUND',
    );
  }
}

async function attachmentCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return toHttpError(error);
  }
}

async function countMultipartBytes(
  request: Request,
  parser: ReturnType<typeof Busboy>,
  maxBytes: number,
): Promise<void> {
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maxBytes) {
      parser.destroy(new AttachmentError(
        'ATTACHMENT_TOO_LARGE',
        'Encoded attachment upload exceeds its byte limit.',
      ));
      return;
    }
    if (!parser.write(bytes)) await once(parser, 'drain');
  }
  parser.end();
}

async function parseMultipartUpload(
  request: Request,
  grant: {
    companyId: string;
    actorKey: string;
    retainLocally: boolean;
    maxFileCount: number;
    maxBytes: bigint;
  },
): Promise<StagedAttachmentDto[]> {
  const contentLength = request.headers['content-length'];
  const maximum = Number(grant.maxBytes);
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || (
      contentLength !== undefined
      && (
        !/^(0|[1-9]\d*)$/u.test(contentLength)
        || Number(contentLength) > maximum
      )
    )
  ) {
    throw new AttachmentError(
      'ATTACHMENT_TOO_LARGE',
      'Encoded attachment upload exceeds its byte limit.',
    );
  }
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        files: grant.maxFileCount,
        fields: 0,
        parts: grant.maxFileCount,
        fileSize: maximum,
      },
    });
  } catch {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'A valid multipart attachment upload is required.',
    );
  }
  const staged: Promise<StagedAttachmentDto>[] = [];
  let rejected: AttachmentError | null = null;
  parser.on('file', (_field, stream, info) => {
    let truncated = false;
    stream.on('limit', () => {
      truncated = true;
    });
    const task = stageAttachment({
      companyId: grant.companyId,
      actorKey: grant.actorKey,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally: grant.retainLocally,
      filename: info.filename,
      declaredContentType: info.mimeType,
      content: (async function* () {
        for await (const chunk of stream) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
        if (truncated) {
          throw new AttachmentError(
            'ATTACHMENT_TOO_LARGE',
            'Attachment file exceeds its byte limit.',
          );
        }
      })(),
      expiresAt: new Date(Date.now() + ATTACHMENT_GRANT_TTL_MS),
    });
    void task.catch((error: unknown) => {
      parser.destroy(
        error instanceof Error
          ? error
          : new Error('Attachment staging failed.'),
      );
    });
    staged.push(task);
  });
  parser.on('field', () => {
    rejected = new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment uploads accept file parts only.',
    );
  });
  parser.on('filesLimit', () => {
    rejected = new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment upload contains too many files.',
    );
  });
  parser.on('fieldsLimit', () => {
    rejected = new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment uploads accept file parts only.',
    );
  });
  const complete = new Promise<void>((resolve, reject) => {
    parser.once('finish', resolve);
    parser.once('error', reject);
  });
  await Promise.all([
    complete,
    countMultipartBytes(request, parser, maximum),
  ]);
  if (rejected) throw rejected;
  const result = await Promise.all(staged);
  if (result.length < 1 || result.length > grant.maxFileCount) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment upload must contain at least one file.',
    );
  }
  return result;
}

async function streamAttachmentResponse(
  attachment: TransactionAttachment,
  res: Response,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<void> {
  let contentType: string;
  let sizeBytes: number | null;
  let body: AsyncIterable<Uint8Array>;
  if (attachment.blobId !== null) {
    const reader = await attachmentCall(() => openAttachmentBlob(
      attachment.companyId,
      attachment.blobId!,
    ));
    contentType = reader.contentType;
    sizeBytes = reader.sizeBytes;
    body = reader.chunks();
  } else if (attachment.qboAttachableId !== null) {
    const qbo = await qboFactory.forCompany(attachment.companyId);
    const download = await qbo.openAttachmentDownload(
      attachment.qboAttachableId,
    );
    contentType = download.contentType;
    sizeBytes = download.sizeBytes;
    body = download.body;
  } else {
    throw new HttpError(
      404,
      'Attachment content not found',
      'ATTACHMENT_NOT_FOUND',
    );
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    attachmentContentDisposition(attachment.originalFilename, disposition),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  if (sizeBytes !== null) res.setHeader('Content-Length', String(sizeBytes));
  await streamToResponse(body, res);
}

export const companyAttachmentGrantsRouter = Router({ mergeParams: true });
companyAttachmentGrantsRouter.use(
  requireUser,
  withCompany(),
  requireRole('categorizer'),
);

companyAttachmentGrantsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) {
      throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    }
    const actor = requestActor(req);
    const limits = validate(grantBody)(req.body ?? {});
    const body = await attachmentCall(() => issueAttachmentUploadGrant({
      actor,
      companyId: company.id,
      maxFileCount: limits.fileCount,
      maxEncodedRequestBytes: limits.maxEncodedRequestBytes,
    }));
    res.status(201).json(body);
  }),
);

export const attachmentUploadsRouter = Router();

attachmentUploadsRouter.post(
  '/:grantId',
  asyncHandler(async (req, res) => {
    const token = parseAttachmentGrantBearer(req.headers.authorization);
    if (
      token === null
      || Buffer.byteLength(token, 'utf8') > MAX_GRANT_TOKEN_BYTES
    ) {
      throw new HttpError(
        401,
        'Attachment upload grant is invalid.',
        'ATTACHMENT_GRANT_INVALID',
      );
    }
    const now = new Date();
    const tokenHash = sha256Hex(token);
    const grant = await prisma.attachmentUploadGrant.findFirst({
      where: {
        id: req.params.grantId,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!grant) {
      throw new HttpError(
        401,
        'Attachment upload grant is invalid.',
        'ATTACHMENT_GRANT_INVALID',
      );
    }
    const claimed = await prisma.attachmentUploadGrant.updateMany({
      where: {
        id: grant.id,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      throw new HttpError(
        409,
        'Attachment upload grant was already used.',
        'ATTACHMENT_GRANT_USED',
      );
    }
    const company = await prisma.company.findUnique({
      where: { id: grant.companyId },
      select: { retainAttachmentFiles: true },
    });
    if (!company) {
      throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    }
    const uploads = await attachmentCall(() => parseMultipartUpload(req, {
      ...grant,
      retainLocally: company.retainAttachmentFiles,
    }));
    res.status(201).json({ uploads });
  }),
);

export const attachmentDownloadsRouter = Router();

attachmentDownloadsRouter.get(
  '/:grantId',
  asyncHandler(async (req, res) => {
    const token = parseAttachmentGrantBearer(req.headers.authorization);
    if (
      token === null
      || Buffer.byteLength(token, 'utf8') > MAX_GRANT_TOKEN_BYTES
    ) {
      throw new HttpError(
        401,
        'Attachment download grant is invalid.',
        'ATTACHMENT_GRANT_INVALID',
      );
    }
    const now = new Date();
    const tokenHash = sha256Hex(token);
    const grant = await prisma.attachmentDownloadGrant.findFirst({
      where: {
        id: req.params.grantId,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      include: { attachment: true },
    });
    if (!grant) {
      throw new HttpError(
        401,
        'Attachment download grant is invalid.',
        'ATTACHMENT_GRANT_INVALID',
      );
    }
    const claimed = await prisma.attachmentDownloadGrant.updateMany({
      where: {
        id: grant.id,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      throw new HttpError(
        409,
        'Attachment download grant was already used.',
        'ATTACHMENT_GRANT_USED',
      );
    }
    if (grant.attachment.status === 'DELETED') {
      throw new HttpError(
        404,
        'Attachment content not found',
        'ATTACHMENT_NOT_FOUND',
      );
    }
    await streamAttachmentResponse(grant.attachment, res);
  }),
);

export const transactionAttachmentsRouter = Router({ mergeParams: true });
transactionAttachmentsRouter.use(
  requireUser,
  withCompany({ allowDisconnected: true }),
  requireRole('viewer'),
  asyncHandler(async (req, _res, next) => {
    await transactionExists(
      req.params.companyId!,
      req.params.transactionId!,
    );
    next();
  }),
);

transactionAttachmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await attachmentCall(() => listTransactionAttachments(
      requestActor(req),
      req.params.companyId!,
      req.params.transactionId!,
    )));
  }),
);

transactionAttachmentsRouter.post(
  '/',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const body = validate(attachBody)(req.body);
    const result = await attachmentCall(() => attachTransactionFiles({
      actor: requestActor(req),
      companyId: req.params.companyId!,
      transactionId: req.params.transactionId!,
      idempotencyKey: body.idempotencyKey,
      sources: body.sources as AttachmentSourceInput[],
    }));
    res.status(202).json(result);
  }),
);

transactionAttachmentsRouter.post(
  '/refresh',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    validate(operationBody)(req.body ?? {});
    res.json(await attachmentCall(() => refreshTransactionAttachments(
      requestActor(req),
      req.params.companyId!,
      req.params.transactionId!,
    )));
  }),
);

transactionAttachmentsRouter.get(
  '/operations/:operationId',
  asyncHandler(async (req, res) => {
    res.json(await attachmentCall(() => getScopedAttachmentOperation(
      requestActor(req),
      req.params.companyId!,
      req.params.transactionId!,
      req.params.operationId!,
    )));
  }),
);

transactionAttachmentsRouter.post(
  '/operations/:operationId/retry',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    validate(operationBody)(req.body ?? {});
    const result: AttachmentOperationDto = await attachmentCall(
      () => retryScopedAttachmentOperation(
        requestActor(req),
        req.params.companyId!,
        req.params.transactionId!,
        req.params.operationId!,
      ),
    );
    res.status(202).json(result);
  }),
);

transactionAttachmentsRouter.post(
  '/operations/:operationId/reconcile',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    validate(operationBody)(req.body ?? {});
    const result: AttachmentOperationDto = await attachmentCall(
      () => reconcileScopedAttachmentOperation(
        requestActor(req),
        req.params.companyId!,
        req.params.transactionId!,
        req.params.operationId!,
      ),
    );
    res.status(202).json(result);
  }),
);

transactionAttachmentsRouter.get(
  '/:attachmentId/download',
  asyncHandler(async (req, res) => {
    const attachment = await prisma.transactionAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        companyId: req.params.companyId,
        transactionId: req.params.transactionId,
        status: { not: 'DELETED' },
      },
    });
    if (!attachment) {
      throw new HttpError(
        404,
        'Attachment not found',
        'ATTACHMENT_NOT_FOUND',
      );
    }
    await streamAttachmentResponse(attachment, res);
  }),
);

transactionAttachmentsRouter.get(
  '/:attachmentId/preview',
  asyncHandler(async (req, res) => {
    const attachment = await prisma.transactionAttachment.findFirst({
      where: {
        id: req.params.attachmentId,
        companyId: req.params.companyId,
        transactionId: req.params.transactionId,
        status: { not: 'DELETED' },
        OR: [
          { contentType: 'application/pdf' },
          { contentType: { startsWith: 'image/' } },
          { contentType: { startsWith: 'text/' } },
        ],
      },
    });
    if (!attachment) {
      throw new HttpError(
        404,
        'Attachment preview not found',
        'ATTACHMENT_NOT_FOUND',
      );
    }
    await streamAttachmentResponse(attachment, res, 'inline');
  }),
);

transactionAttachmentsRouter.post(
  '/:attachmentId/save-local',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    validate(operationBody)(req.body ?? {});
    res.json(await attachmentCall(() => saveExternalAttachmentLocally(
      requestActor(req),
      req.params.companyId!,
      req.params.transactionId!,
      req.params.attachmentId!,
    )));
  }),
);

transactionAttachmentsRouter.delete(
  '/:attachmentId',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const query = validate(deleteQuery)(req.query);
    const result = await attachmentCall(() => deleteTransactionAttachment({
      actor: requestActor(req),
      companyId: req.params.companyId!,
      transactionId: req.params.transactionId!,
      attachmentId: req.params.attachmentId!,
      scope: query.scope,
      idempotencyKey: query.idempotencyKey,
    }));
    res.status(202).json(result);
  }),
);
