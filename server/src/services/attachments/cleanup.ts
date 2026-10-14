import type { PrismaClient } from '../../lib/db.js';
import { prisma } from '../../lib/prisma.js';
import { AttachmentError } from './types.js';

const MAX_GRANTS_PER_PASS = 100;
const MAX_STAGING_PER_PASS = 25;
const MAX_BLOBS_PER_PASS = 100;

export interface AttachmentCleanupInput {
  now?: Date;
  grantLimit?: number;
  stagingLimit?: number;
  blobLimit?: number;
}

export interface AttachmentCleanupDependencies {
  db?: PrismaClient;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment cleanup limit is invalid.',
    );
  }
  return resolved;
}

export async function runAttachmentCleanup(
  input: AttachmentCleanupInput = {},
  dependencies: AttachmentCleanupDependencies = {},
): Promise<{ grants: number; staging: number; blobs: number }> {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment cleanup time is invalid.',
    );
  }
  const grantLimit = boundedLimit(
    input.grantLimit,
    MAX_GRANTS_PER_PASS,
    MAX_GRANTS_PER_PASS,
  );
  const stagingLimit = boundedLimit(
    input.stagingLimit,
    MAX_STAGING_PER_PASS,
    MAX_STAGING_PER_PASS,
  );
  const blobLimit = boundedLimit(
    input.blobLimit,
    MAX_BLOBS_PER_PASS,
    MAX_BLOBS_PER_PASS,
  );
  const db = dependencies.db ?? prisma;

  const uploadGrantIds = await db.attachmentUploadGrant.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: grantLimit,
    select: { id: true },
  });
  const deletedUploads = uploadGrantIds.length === 0
    ? 0
    : (await db.attachmentUploadGrant.deleteMany({
        where: {
          id: { in: uploadGrantIds.map((row) => row.id) },
          expiresAt: { lte: now },
        },
      })).count;
  const remainingGrantBudget = grantLimit - deletedUploads;
  let deletedDownloads = 0;
  if (remainingGrantBudget > 0) {
    const downloadGrantIds = await db.attachmentDownloadGrant.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: remainingGrantBudget,
      select: { id: true },
    });
    if (downloadGrantIds.length > 0) {
      deletedDownloads = (await db.attachmentDownloadGrant.deleteMany({
        where: {
          id: { in: downloadGrantIds.map((row) => row.id) },
          expiresAt: { lte: now },
        },
      })).count;
    }
  }

  const stagingCandidates = await db.attachmentBlob.findMany({
    where: {
      state: 'STAGING',
      expiresAt: { lte: now },
      stagedFiles: { none: {} },
      attachments: { none: {} },
      receiptDocuments: { none: {} },
    },
    orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: stagingLimit,
    select: { id: true },
  });
  let staging = 0;
  for (const candidate of stagingCandidates) {
    staging += await db.$transaction(async (transaction) => {
      const deleted = await transaction.attachmentBlob.deleteMany({
        where: {
          id: candidate.id,
          state: 'STAGING',
          expiresAt: { lte: now },
          stagedFiles: { none: {} },
          attachments: { none: {} },
          receiptDocuments: { none: {} },
        },
      });
      return deleted.count;
    });
  }

  // Expired staging handles are no longer usable. Removing them permits their
  // immutable READY blobs to be collected below; durable metadata references
  // survive byte expiry through nullable foreign keys.
  const expiredStaged = await db.stagedAttachment.findMany({
    where: { expiresAt: { lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: blobLimit,
    select: { id: true },
  });
  if (expiredStaged.length > 0) {
    await db.stagedAttachment.deleteMany({
      where: {
        id: { in: expiredStaged.map((row) => row.id) },
        expiresAt: { lte: now },
      },
    });
  }

  const blobCandidates = await db.attachmentBlob.findMany({
    where: {
      state: 'READY',
      expiresAt: { lte: now },
      stagedFiles: { none: {} },
    },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: blobLimit,
    select: { id: true },
  });
  let blobs = 0;
  for (const candidate of blobCandidates) {
    blobs += await db.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM "AttachmentBlob"
         WHERE "id" = ${candidate.id}
           AND "state" = 'READY'
           AND "expiresAt" <= ${now}
         FOR UPDATE SKIP LOCKED`;
      if (locked.length !== 1) return 0;
      const blockers = await transaction.attachmentBlob.findUnique({
        where: { id: candidate.id },
        select: {
          stagedFiles: { select: { id: true }, take: 1 },
          attachments: {
            where: {
              operationFiles: {
                some: {
                  operation: {
                    status: {
                      in: ['PREPARED', 'COMMITTING', 'PARTIAL', 'UNCERTAIN', 'DELETING'],
                    },
                  },
                },
              },
            },
            select: { id: true },
            take: 1,
          },
          receiptDocuments: {
            where: {
              OR: [
                {
                  jobs: {
                    some: { status: { in: ['queued', 'retry', 'running'] } },
                  },
                },
                {
                  attachmentOperations: {
                    some: {
                      status: {
                        in: ['PREPARED', 'COMMITTING', 'PARTIAL', 'UNCERTAIN', 'DELETING'],
                      },
                    },
                  },
                },
              ],
            },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (
        blockers === null
        || blockers.stagedFiles.length > 0
        || blockers.attachments.length > 0
        || blockers.receiptDocuments.length > 0
      ) return 0;
      const deleted = await transaction.attachmentBlob.deleteMany({
        where: {
          id: candidate.id,
          state: 'READY',
          expiresAt: { lte: now },
          stagedFiles: { none: {} },
          receiptDocuments: {
            none: {
              OR: [
                {
                  jobs: {
                    some: { status: { in: ['queued', 'retry', 'running'] } },
                  },
                },
                {
                  attachmentOperations: {
                    some: {
                      status: {
                        in: ['PREPARED', 'COMMITTING', 'PARTIAL', 'UNCERTAIN', 'DELETING'],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      });
      return deleted.count;
    });
  }

  return {
    grants: deletedUploads + deletedDownloads,
    staging,
    blobs,
  };
}
