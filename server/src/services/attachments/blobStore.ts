import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../lib/db.js';
import { prisma } from '../../lib/prisma.js';
import {
  type AttachmentBatchBudget,
  type AttachmentBlobReader,
  AttachmentError,
  type StageAttachmentInput,
  type StagedAttachmentDto,
} from './types.js';
import {
  ATTACHMENT_DETECTION_BYTES,
  BLOB_CHUNK_BYTES,
  detectAllowedAttachment,
  normalizeAttachmentFilename,
  QBO_MAX_UPLOAD_REQUEST_BYTES,
} from './validation.js';
import {
  attachmentRetentionDeadline,
  resolveAttachmentStoragePolicy,
  type AttachmentStoragePolicyDefaults,
} from './policy.js';
import {
  getAttachmentStoragePolicyDefaults,
  ATTACHMENT_STORAGE_INSTANCE_LOCK,
  type AttachmentPolicyConfigDb,
} from './policyStore.js';

const CHUNK_READ_PAGE = 16;
const COMPANY_STORAGE_LOCK_SEED = 1_991_011_991n;
/**
 * Quota is reserved in steps while an upload streams, so concurrent uploads
 * are refused after at most one step each instead of after every byte has
 * already been written to the database.
 */
export const STAGING_RESERVATION_STEP_BYTES = BLOB_CHUNK_BYTES * 8;

type StorageTransaction = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

async function lockStorage(
  transaction: StorageTransaction,
  companyId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(${ATTACHMENT_STORAGE_INSTANCE_LOCK})::text`;
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${companyId}, ${COMPANY_STORAGE_LOCK_SEED})
    )::text`;
}

async function storagePolicyFor(
  transaction: StorageTransaction,
  companyId: string,
  deps?: AttachmentBlobStoreDeps,
) {
  const company = await transaction.company.findUnique({
    where: { id: companyId },
    select: {
      attachmentQuotaBytes: true,
      attachmentRetentionDays: true,
    },
  });
  if (company === null) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment company was not found.',
    );
  }
  return resolveAttachmentStoragePolicy(
    company,
    deps?.policyDefaults
      ?? await getAttachmentStoragePolicyDefaults(
        transaction as unknown as AttachmentPolicyConfigDb,
      ),
  );
}

/**
 * Stored bytes plus the reservations of other uploads still streaming. Must
 * run under `lockStorage`. Expired staging rows are crash leftovers awaiting
 * cleanup and no longer hold a reservation.
 */
async function assertWithinStorageQuota(
  transaction: StorageTransaction,
  input: {
    companyId: string;
    provisionalBlobId: string;
    sizeBytes: bigint;
    now: Date;
    policy: { instanceQuotaBytes: bigint; companyQuotaBytes: bigint };
  },
): Promise<void> {
  const counted = {
    OR: [
      { state: 'READY' as const },
      {
        state: 'STAGING' as const,
        id: { not: input.provisionalBlobId },
        expiresAt: { gt: input.now },
      },
    ],
  };
  const [instanceUsage, companyUsage] = await Promise.all([
    transaction.attachmentBlob.aggregate({
      where: counted,
      _sum: { sizeBytes: true },
    }),
    transaction.attachmentBlob.aggregate({
      where: { companyId: input.companyId, ...counted },
      _sum: { sizeBytes: true },
    }),
  ]);
  if ((instanceUsage._sum.sizeBytes ?? 0n) + input.sizeBytes > input.policy.instanceQuotaBytes) {
    throw new AttachmentError(
      'ATTACHMENT_INSTANCE_QUOTA_EXCEEDED',
      'Attachment storage exceeds the instance quota.',
    );
  }
  if ((companyUsage._sum.sizeBytes ?? 0n) + input.sizeBytes > input.policy.companyQuotaBytes) {
    throw new AttachmentError(
      'ATTACHMENT_COMPANY_QUOTA_EXCEEDED',
      'Attachment storage exceeds the company quota.',
    );
  }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof AttachmentError && (
    error.code === 'ATTACHMENT_INSTANCE_QUOTA_EXCEEDED'
    || error.code === 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED'
  );
}

export interface AttachmentBlobStoreDeps {
  readonly db?: PrismaClient;
  readonly now?: () => Date;
  readonly policyDefaults?: AttachmentStoragePolicyDefaults;
}

function resolvedDb(deps?: AttachmentBlobStoreDeps): PrismaClient {
  return deps?.db ?? prisma;
}

function assertStageInput(input: StageAttachmentInput, now: Date): void {
  if (
    typeof input.companyId !== 'string'
    || input.companyId.length < 1
    || input.companyId.length > 120
    || typeof input.actorKey !== 'string'
    || input.actorKey.length < 1
    || Buffer.byteLength(input.actorKey, 'utf8') > 160
    || !(input.expiresAt instanceof Date)
    || !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt <= now
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment staging scope or expiry is invalid.',
    );
  }
}

export function createAttachmentBatchBudget(maxBytes: number): AttachmentBatchBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment byte budget must be a positive safe integer.',
    );
  }
  let usedBytes = 0;
  return {
    maxBytes,
    get usedBytes() {
      return usedBytes;
    },
    consume(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new AttachmentError(
          'ATTACHMENT_INVALID_INPUT',
          'Attachment byte count must be a non-negative safe integer.',
        );
      }
      if (usedBytes + bytes > maxBytes) {
        throw new AttachmentError(
          'ATTACHMENT_TOO_LARGE',
          'Attachment content exceeds the upload byte limit.',
        );
      }
      usedBytes += bytes;
    },
  };
}

export async function* rechunkAttachmentContent(
  content: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let pending = new Uint8Array(BLOB_CHUNK_BYTES);
  let pendingBytes = 0;

  for await (const sourceChunk of content) {
    if (!(sourceChunk instanceof Uint8Array)) {
      throw new AttachmentError(
        'ATTACHMENT_INVALID_INPUT',
        'Attachment stream yielded an invalid chunk.',
      );
    }
    let offset = 0;
    while (offset < sourceChunk.byteLength) {
      const copyBytes = Math.min(
        BLOB_CHUNK_BYTES - pendingBytes,
        sourceChunk.byteLength - offset,
      );
      pending.set(sourceChunk.subarray(offset, offset + copyBytes), pendingBytes);
      pendingBytes += copyBytes;
      offset += copyBytes;
      if (pendingBytes === BLOB_CHUNK_BYTES) {
        yield pending;
        pending = new Uint8Array(BLOB_CHUNK_BYTES);
        pendingBytes = 0;
      }
    }
  }

  if (pendingBytes > 0) yield pending.slice(0, pendingBytes);
}

async function removeProvisionalBlob(db: PrismaClient, blobId: string): Promise<void> {
  try {
    await db.attachmentBlob.deleteMany({
      where: { id: blobId, state: 'STAGING' },
    });
  } catch {
    // Cleanup is best effort; the expiry-bound collector owns crash leftovers.
  }
}

function stagedDto(
  staged: {
    id: string;
    companyId: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: bigint;
    sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT' | 'QBO_EXTERNAL';
    retainLocally: boolean;
    expiresAt: Date;
  },
  sha256: string,
): StagedAttachmentDto {
  if (staged.sourceKind === 'QBO_EXTERNAL') {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'QuickBooks-native attachments cannot be local staging records.',
    );
  }
  const sizeBytes = Number(staged.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'Attachment size is outside the safe range.');
  }
  return {
    id: staged.id,
    companyId: staged.companyId,
    filename: staged.originalFilename,
    contentType: staged.contentType,
    sizeBytes,
    sha256,
    sourceKind: staged.sourceKind,
    retainLocally: staged.retainLocally,
    expiresAt: staged.expiresAt.toISOString(),
  };
}

export async function stageAttachment(
  input: StageAttachmentInput,
  deps?: AttachmentBlobStoreDeps,
): Promise<StagedAttachmentDto> {
  const db = resolvedDb(deps);
  const now = (deps?.now ?? (() => new Date()))();
  assertStageInput(input, now);
  const filename = normalizeAttachmentFilename(input.filename);
  const provisional = await db.attachmentBlob.create({
    data: {
      companyId: input.companyId,
      state: 'STAGING',
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });

  const budget = createAttachmentBatchBudget(QBO_MAX_UPLOAD_REQUEST_BYTES);
  const hash = createHash('sha256');
  const detectionPrefix = new Uint8Array(ATTACHMENT_DETECTION_BYTES);
  let detectionBytes = 0;
  let chunkCount = 0;
  let reservedBytes = 0;
  const reserveExactly = async (nextReservation: number): Promise<void> => {
    const reservedAt = (deps?.now ?? (() => new Date()))();
    await db.$transaction(async (transaction) => {
      await lockStorage(transaction, input.companyId);
      await assertWithinStorageQuota(transaction, {
        companyId: input.companyId,
        provisionalBlobId: provisional.id,
        sizeBytes: BigInt(nextReservation),
        now: reservedAt,
        policy: await storagePolicyFor(transaction, input.companyId, deps),
      });
      await transaction.attachmentBlob.update({
        where: { id: provisional.id },
        data: { sizeBytes: BigInt(nextReservation) },
      });
    });
    reservedBytes = nextReservation;
  };
  const reserve = async (neededBytes: number): Promise<void> => {
    const stepped = Math.min(
      Math.ceil(neededBytes / STAGING_RESERVATION_STEP_BYTES)
        * STAGING_RESERVATION_STEP_BYTES,
      budget.maxBytes,
    );
    try {
      await reserveExactly(stepped);
    } catch (error) {
      // Near the quota a whole step may not fit even though the file does.
      if (stepped === neededBytes || !isQuotaError(error)) throw error;
      await reserveExactly(neededBytes);
    }
  };

  try {
    for await (const chunk of rechunkAttachmentContent(input.content)) {
      budget.consume(chunk.byteLength);
      if (budget.usedBytes > reservedBytes) await reserve(budget.usedBytes);
      hash.update(chunk);
      if (detectionBytes < detectionPrefix.byteLength) {
        const copyBytes = Math.min(
          chunk.byteLength,
          detectionPrefix.byteLength - detectionBytes,
        );
        detectionPrefix.set(chunk.subarray(0, copyBytes), detectionBytes);
        detectionBytes += copyBytes;
      }
      await db.attachmentBlobChunk.create({
        data: {
          blobId: provisional.id,
          ordinal: chunkCount,
          content: Buffer.from(chunk),
        },
      });
      chunkCount += 1;
    }
    if (budget.usedBytes === 0 || chunkCount === 0) {
      throw new AttachmentError(
        'ATTACHMENT_INVALID_INPUT',
        'Attachment content must not be empty.',
      );
    }

    const detected = await detectAllowedAttachment(
      detectionPrefix.subarray(0, detectionBytes),
      filename,
      input.declaredContentType,
    );
    const sha256 = hash.digest('hex');
    const finalizedAt = (deps?.now ?? (() => new Date()))();
    const sizeBytes = BigInt(budget.usedBytes);
    const staged = await db.$transaction(async (transaction) => {
      await lockStorage(transaction, input.companyId);
      const policy = await storagePolicyFor(transaction, input.companyId, deps);
      const retentionDeadline = attachmentRetentionDeadline(
        finalizedAt,
        policy.retentionDays,
      );
      const canonical = await transaction.attachmentBlob.findUnique({
        where: {
          companyId_sha256: {
            companyId: input.companyId,
            sha256,
          },
        },
        select: {
          id: true,
          state: true,
          sizeBytes: true,
          contentType: true,
          expiresAt: true,
        },
      });
      if (canonical !== null) {
        if (
          canonical.state !== 'READY'
          || canonical.contentType !== detected.contentType
          || canonical.sizeBytes !== sizeBytes
          || canonical.expiresAt === null
        ) {
          throw new AttachmentError(
            'ATTACHMENT_BUSY',
            'An identical attachment is still being finalized.',
            true,
          );
        }
        if (canonical.expiresAt < retentionDeadline) {
          await transaction.attachmentBlob.update({
            where: { id: canonical.id },
            data: { expiresAt: retentionDeadline },
          });
        }
        const reference = await transaction.stagedAttachment.create({
          data: {
            companyId: input.companyId,
            actorKey: input.actorKey,
            blobId: canonical.id,
            originalFilename: filename,
            contentType: detected.contentType,
            sizeBytes,
            sourceKind: input.sourceKind,
            retainLocally: input.retainLocally,
            expiresAt: input.expiresAt,
          },
        });
        await transaction.attachmentBlob.delete({
          where: { id: provisional.id },
        });
        return reference;
      }

      await assertWithinStorageQuota(transaction, {
        companyId: input.companyId,
        provisionalBlobId: provisional.id,
        sizeBytes,
        now: finalizedAt,
        policy,
      });

      await transaction.attachmentBlob.update({
        where: { id: provisional.id },
        data: {
          state: 'READY',
          sha256,
          sizeBytes,
          contentType: detected.contentType,
          chunkCount,
          expiresAt: retentionDeadline,
        },
      });
      return transaction.stagedAttachment.create({
        data: {
          companyId: input.companyId,
          actorKey: input.actorKey,
          blobId: provisional.id,
          originalFilename: filename,
          contentType: detected.contentType,
          sizeBytes,
          sourceKind: input.sourceKind,
          retainLocally: input.retainLocally,
          expiresAt: input.expiresAt,
        },
      });
    });
    return stagedDto(staged, sha256);
  } catch (error) {
    await removeProvisionalBlob(db, provisional.id);
    throw error;
  }
}

export async function openAttachmentBlob(
  companyId: string,
  blobId: string,
  deps?: AttachmentBlobStoreDeps,
): Promise<AttachmentBlobReader> {
  const db = resolvedDb(deps);
  const blob = await db.attachmentBlob.findFirst({
    where: { id: blobId, companyId, state: 'READY' },
    select: {
      id: true,
      sizeBytes: true,
      contentType: true,
    },
  });
  if (!blob || blob.contentType === null) {
    throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment content was not found.');
  }
  const sizeBytes = Number(blob.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'Attachment size is outside the safe range.');
  }

  return {
    blobId: blob.id,
    sizeBytes,
    contentType: blob.contentType,
    async *chunks() {
      let lastOrdinal = -1;
      while (true) {
        const rows = await db.attachmentBlobChunk.findMany({
          where: {
            blobId: blob.id,
            ordinal: { gt: lastOrdinal },
          },
          orderBy: { ordinal: 'asc' },
          take: CHUNK_READ_PAGE,
          select: {
            ordinal: true,
            content: true,
          },
        });
        if (rows.length === 0) return;
        for (const row of rows) {
          lastOrdinal = row.ordinal;
          yield row.content;
        }
      }
    },
  };
}

export async function releaseAttachmentBlob(
  attachmentId: string,
  deps?: AttachmentBlobStoreDeps,
): Promise<void> {
  const db = resolvedDb(deps);
  await db.$transaction(async (transaction) => {
    const attachment = await transaction.transactionAttachment.findUnique({
      where: { id: attachmentId },
      select: { blobId: true },
    });
    if (!attachment) {
      throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment was not found.');
    }
    if (attachment.blobId === null) return;
    await transaction.transactionAttachment.update({
      where: { id: attachmentId },
      data: {
        blobId: null,
        retainLocally: false,
      },
    });
    await transaction.attachmentBlob.deleteMany({
      where: {
        id: attachment.blobId,
        stagedFiles: { none: {} },
        attachments: { none: {} },
        receiptDocuments: { none: {} },
      },
    });
  });
}

export async function collectUnreferencedBlobs(
  limit: number,
  deps?: AttachmentBlobStoreDeps,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment cleanup limit must be between 1 and 1000.',
    );
  }
  const db = resolvedDb(deps);
  const now = (deps?.now ?? (() => new Date()))();
  return db.$transaction(async (transaction) => {
    const candidates = await transaction.attachmentBlob.findMany({
      where: {
        stagedFiles: { none: {} },
        attachments: { none: {} },
        receiptDocuments: { none: {} },
        OR: [
          { state: 'READY' },
          { state: 'STAGING', expiresAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (candidates.length === 0) return 0;
    const deleted = await transaction.attachmentBlob.deleteMany({
      where: {
        id: { in: candidates.map((candidate) => candidate.id) },
        stagedFiles: { none: {} },
        attachments: { none: {} },
        receiptDocuments: { none: {} },
        OR: [
          { state: 'READY' },
          { state: 'STAGING', expiresAt: { lte: now } },
        ],
      },
    });
    return deleted.count;
  });
}
