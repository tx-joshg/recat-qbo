import type { PrismaClient } from '../../lib/db.js';
import type { AttachmentUploadGrantDto } from '@recat/shared';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import type { AttachmentActor } from './operations.js';
import { AttachmentError } from './types.js';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from './validation.js';

export const ATTACHMENT_GRANT_TTL_MS = 15 * 60 * 1000;
export const ATTACHMENT_MAX_FILES = 20;

export interface AttachmentGrantDependencies {
  db?: PrismaClient;
  now?: () => Date;
}

export interface AttachmentDownloadGrantDto {
  downloadUrl: string;
  grant: string;
  expiresAt: string;
}

function authorize(
  actor: AttachmentActor,
  companyId: string,
  minimum: 'viewer' | 'categorizer',
): void {
  if (actor.isInstanceAdmin) return;
  const role = actor.memberships.find(
    (membership) => membership.companyId === companyId,
  )?.role;
  const allowed = minimum === 'viewer'
    ? role === 'viewer' || role === 'categorizer' || role === 'admin'
    : role === 'categorizer' || role === 'admin';
  if (!allowed) {
    throw new AttachmentError(
      'ATTACHMENT_FORBIDDEN',
      'Attachment access is not allowed.',
    );
  }
}

export async function issueAttachmentUploadGrant(
  input: {
    actor: AttachmentActor;
    companyId: string;
    maxFileCount: number;
    maxEncodedRequestBytes: number;
  },
  dependencies: AttachmentGrantDependencies = {},
): Promise<AttachmentUploadGrantDto> {
  authorize(input.actor, input.companyId, 'categorizer');
  if (
    !Number.isSafeInteger(input.maxFileCount)
    || input.maxFileCount < 1
    || input.maxFileCount > ATTACHMENT_MAX_FILES
    || !Number.isSafeInteger(input.maxEncodedRequestBytes)
    || input.maxEncodedRequestBytes < 1
    || input.maxEncodedRequestBytes > QBO_MAX_UPLOAD_REQUEST_BYTES
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment upload grant limits are invalid.',
    );
  }
  const db = dependencies.db ?? prisma;
  const now = (dependencies.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + ATTACHMENT_GRANT_TTL_MS);
  const token = randomToken(32);
  const grant = await db.attachmentUploadGrant.create({
    data: {
      tokenHash: sha256Hex(token),
      actorKey: input.actor.actorKey,
      companyId: input.companyId,
      maxFileCount: input.maxFileCount,
      maxBytes: BigInt(input.maxEncodedRequestBytes),
      expiresAt,
    },
    select: { id: true },
  });
  return {
    uploadUrl: `/api/attachment-uploads/${grant.id}`,
    grant: token,
    expiresAt: expiresAt.toISOString(),
    maxFileCount: input.maxFileCount,
    maxEncodedRequestBytes: input.maxEncodedRequestBytes,
  };
}

export async function issueAttachmentDownloadGrant(
  input: {
    actor: AttachmentActor;
    companyId: string;
    transactionId: string;
    attachmentId: string;
  },
  dependencies: AttachmentGrantDependencies = {},
): Promise<AttachmentDownloadGrantDto> {
  authorize(input.actor, input.companyId, 'viewer');
  const db = dependencies.db ?? prisma;
  const attachment = await db.transactionAttachment.findFirst({
    where: {
      id: input.attachmentId,
      companyId: input.companyId,
      transactionId: input.transactionId,
      status: { not: 'DELETED' },
    },
    select: { id: true },
  });
  if (!attachment) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment was not found.',
    );
  }
  const now = (dependencies.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + ATTACHMENT_GRANT_TTL_MS);
  const token = randomToken(32);
  const grant = await db.attachmentDownloadGrant.create({
    data: {
      tokenHash: sha256Hex(token),
      actorKey: input.actor.actorKey,
      companyId: input.companyId,
      attachmentId: attachment.id,
      expiresAt,
    },
    select: { id: true },
  });
  return {
    downloadUrl: `/api/attachment-downloads/${grant.id}`,
    grant: token,
    expiresAt: expiresAt.toISOString(),
  };
}
