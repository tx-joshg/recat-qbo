import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../lib/db.js';
import { prisma } from '../../lib/prisma.js';
import { openAttachmentBlob } from '../attachments/blobStore.js';
import { AttachmentError } from '../attachments/types.js';
import {
  extractReceipt,
  ExtractorError,
  type ReceiptExtractionResult,
} from './extractorClient.js';
import {
  claimReceiptJobs,
  renewReceiptJob,
  receiptRetryDelayMs,
  type ClaimedReceiptJob,
} from './jobs.js';
import { buildReceiptMatches } from './matching.js';
import {
  DEFAULT_RECEIPT_CONFIG_VERSION,
  resolveReceiptProvider,
  ReceiptSettingError,
  type ResolvedReceiptProvider,
} from './settings.js';
import { ReceiptError } from './types.js';

const RECEIPT_WORKER_ID = `receipt-${process.pid}-${randomUUID()}`;
const MAX_ATTEMPTS = 3;

interface OwnedReceiptDocument {
  blobId: string | null;
  originalFilename: string;
  contentType: string;
  company: {
    names: string[];
    addresses: string[];
    taxIds: string[];
  };
  categories: {
    expense: Array<{ name: string; description: string }>;
    issued: Array<{ name: string; description: string }>;
  };
}

interface ReceiptFailure {
  errorCode: string;
  transient: boolean;
}

export interface ReceiptWorkerDeps {
  loadOwnedDocument(job: ClaimedReceiptJob): Promise<OwnedReceiptDocument | null>;
  setProcessing(job: ClaimedReceiptJob): Promise<boolean>;
  resolveProvider(companyId: string): Promise<ResolvedReceiptProvider>;
  openBlob(companyId: string, blobId: string): ReturnType<typeof openAttachmentBlob>;
  extract: typeof extractReceipt;
  renew(job: ClaimedReceiptJob, owner: string): Promise<boolean>;
  persistOwnedSuccess(
    job: ClaimedReceiptJob,
    extraction: ReceiptExtractionResult,
    confidenceThreshold: number,
  ): Promise<boolean>;
  persistOwnedFailure(
    job: ClaimedReceiptJob,
    failure: ReceiptFailure,
  ): Promise<boolean>;
  buildMatches(documentId: string, generation: number): Promise<unknown>;
  heartbeatMs?: number;
}

const defaultDeps: ReceiptWorkerDeps = {
  loadOwnedDocument,
  setProcessing,
  resolveProvider: resolveReceiptProvider,
  openBlob: openAttachmentBlob,
  extract: extractReceipt,
  renew: (job, owner) => renewReceiptJob(job, owner),
  persistOwnedSuccess,
  persistOwnedFailure,
  buildMatches: (documentId, generation) =>
    buildReceiptMatches(documentId, generation),
  heartbeatMs: 20_000,
};

export async function runClaimedReceiptJob(
  job: ClaimedReceiptJob,
  deps: ReceiptWorkerDeps = defaultDeps,
): Promise<void> {
  const owner = job.lockOwner;
  if (owner === null) return;
  const document = await deps.loadOwnedDocument(job);
  if (document === null || !await deps.setProcessing(job)) return;

  let heartbeat: NodeJS.Timeout | undefined;
  if ((deps.heartbeatMs ?? 20_000) > 0) {
    heartbeat = setInterval(() => {
      void deps.renew(job, owner).catch(() => false);
    }, deps.heartbeatMs ?? 20_000);
    heartbeat.unref();
  }
  let persistedSuccess = false;
  try {
    const provider = await deps.resolveProvider(job.companyId);
    if (!provider.settings.enabled) {
      throw new ExtractorError('RECEIPT_PROCESSING_DISABLED', false);
    }
    if (document.blobId === null) {
      throw new ExtractorError('RECEIPT_FILE_UNAVAILABLE', false);
    }
    const blob = await deps.openBlob(job.companyId, document.blobId);
    const result = await deps.extract({
      requestId: job.id,
      filename: document.originalFilename,
      contentType: document.contentType,
      blob,
      provider,
      company: document.company,
      categories: document.categories,
    });
    persistedSuccess = await deps.persistOwnedSuccess(
      job,
      result,
      provider.settings.confidenceThreshold,
    );
  } catch (error) {
    await deps.persistOwnedFailure(job, classifyReceiptFailure(error));
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
  if (persistedSuccess) {
    await deps.buildMatches(job.documentId, job.generation).catch(() => undefined);
  }
}

export async function runReceiptTick(): Promise<void> {
  const jobs = await claimReceiptJobs(RECEIPT_WORKER_ID, 4);
  await Promise.all(jobs.map((job) => runClaimedReceiptJob(job)));
}

async function loadOwnedDocument(
  job: ClaimedReceiptJob,
): Promise<OwnedReceiptDocument | null> {
  const rows = await prisma.$queryRaw<Array<{
    blobId: string | null;
    originalFilename: string;
    contentType: string;
    legalName: string;
    nickname: string;
  }>>`
    SELECT document."blobId", document."originalFilename",
           document."contentType", company."legalName", company."nickname"
      FROM "ReceiptProcessingJob" job
      JOIN "ReceiptDocument" document ON document."id" = job."documentId"
      JOIN "Company" company ON company."id" = job."companyId"
     WHERE job."id" = ${job.id}
       AND job."generation" = ${job.generation}
       AND job."attemptCount" = ${job.attemptCount}
       AND job."lockOwner" = ${job.lockOwner}
       AND job."status" = 'running'
       AND job."leaseExpiresAt" > clock_timestamp()
       AND document."generation" = job."generation"
       AND document."deletedAt" IS NULL`;
  const row = rows[0];
  if (!row) return null;
  const accounts = await prisma.qboAccount.findMany({
    where: { companyId: job.companyId, active: true },
    select: {
      fullName: true,
      accountType: true,
      classification: true,
    },
    orderBy: { fullName: 'asc' },
    take: 1_000,
  });
  const category = (classification: string, accountType: string | null) =>
    accounts
      .filter((account) =>
        account.classification === classification
        || account.accountType === accountType)
      .slice(0, 500)
      .map((account) => ({
        name: account.fullName,
        description: account.accountType ?? account.classification,
      }));
  return {
    blobId: row.blobId,
    originalFilename: row.originalFilename,
    contentType: row.contentType,
    company: {
      names: [...new Set([row.legalName, row.nickname].filter(Boolean))],
      addresses: [],
      taxIds: [],
    },
    categories: {
      expense: [
        ...category('Expenses', 'Expense'),
        ...category('COGS', 'Cost of Goods Sold'),
      ].slice(0, 500),
      issued: category('Income', 'Income'),
    },
  };
}

async function setProcessing(job: ClaimedReceiptJob): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "ReceiptDocument" AS document
       SET "status" = 'PROCESSING', "updatedAt" = clock_timestamp()
      FROM "ReceiptProcessingJob" AS job
     WHERE job."id" = ${job.id}
       AND job."documentId" = document."id"
       AND job."generation" = ${job.generation}
       AND job."attemptCount" = ${job.attemptCount}
       AND job."lockOwner" = ${job.lockOwner}
       AND job."status" = 'running'
       AND job."leaseExpiresAt" > clock_timestamp()
       AND document."generation" = job."generation"
       AND document."deletedAt" IS NULL`;
  return changed === 1;
}

export async function persistOwnedSuccess(
  job: ClaimedReceiptJob,
  extraction: ReceiptExtractionResult,
  confidenceThreshold: number,
  db: Pick<PrismaClient, '$transaction'> = prisma,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const completedAt = await lockOwnedJob(tx, job);
    if (completedAt === null) return false;
    const value = extraction.extraction;
    await tx.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: job.documentId,
        generation: job.generation,
        attemptCount: job.attemptCount,
        status: 'succeeded',
        result: extraction as unknown as Prisma.InputJsonValue,
        receiptDate: value.receiptDate
          ? new Date(`${value.receiptDate}T00:00:00.000Z`)
          : null,
        documentTitle: value.documentTitle,
        vendorName: value.vendorName,
        vendorTaxId: value.vendorTaxId,
        vendorReceiptId: value.vendorReceiptId,
        clientName: value.clientName,
        clientTaxId: value.clientTaxId,
        description: value.description,
        lineItems: value.lineItems as unknown as Prisma.InputJsonValue,
        subtotal: value.subtotal,
        taxAmount: value.taxAmount,
        totalAmount: value.totalAmount,
        currency: value.currency,
        paymentMethod: value.paymentMethod,
        paymentIdentifier: value.paymentIdentifier,
        language: value.language,
        additionalFields: value.additionalFields as unknown as Prisma.InputJsonValue,
        rawExtractedText: value.rawExtractedText,
        documentType: value.documentType,
        category: value.category,
        extractionConfidence: value.extractionConfidence,
        taxComponents: value.taxComponents as unknown as Prisma.InputJsonValue,
        parseSalvaged: extraction.parseSalvaged,
        warnings: extraction.warnings,
        model: extraction.model,
        promptVersion: extraction.promptVersion,
        schemaVersion: extraction.schemaVersion,
        tokensIn: extraction.tokensIn,
        tokensOut: extraction.tokensOut,
        costUsd: extraction.costUsd,
        durationMs: extraction.durationMs,
        completedAt,
      },
    });
    const confident = value.extractionConfidence !== null
      && value.extractionConfidence >= confidenceThreshold;
    await tx.receiptDocument.update({
      where: { id: job.documentId },
      data: {
        status: confident ? 'READY' : 'NEEDS_REVIEW',
        pageCount: extraction.pageCount,
      },
    });
    await tx.receiptProcessingJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        dueAt: completedAt,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    return true;
  });
}

export async function persistOwnedFailure(
  job: ClaimedReceiptJob,
  failure: ReceiptFailure,
  db: Pick<PrismaClient, '$transaction'> = prisma,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const completedAt = await lockOwnedJob(tx, job);
    if (completedAt === null) return false;
    const retry = failure.transient && job.attemptCount < MAX_ATTEMPTS;
    await tx.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: job.documentId,
        generation: job.generation,
        attemptCount: job.attemptCount,
        status: 'failed',
        model: 'unavailable',
        promptVersion: 'receiptory-5afac9f0+recat-tax-components-v1',
        schemaVersion: 'recat-receipt-extraction/v1',
        errorCode: failure.errorCode,
        completedAt,
      },
    });
    await tx.receiptDocument.update({
      where: { id: job.documentId },
      data: { status: retry ? 'QUEUED' : 'NEEDS_REVIEW' },
    });
    await tx.receiptProcessingJob.update({
      where: { id: job.id },
      data: {
        status: retry ? 'retry' : 'terminal',
        dueAt: retry
          ? new Date(completedAt.getTime() + receiptRetryDelayMs(job.attemptCount))
          : completedAt,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.errorCode,
      },
    });
    return true;
  });
}

async function lockOwnedJob(
  tx: Prisma.TransactionClient,
  job: ClaimedReceiptJob,
): Promise<Date | null> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
      FROM "ReceiptProcessingJob" AS job
      JOIN "ReceiptDocument" AS document ON document."id" = job."documentId"
     WHERE job."id" = ${job.id}
       AND job."generation" = ${job.generation}
       AND job."attemptCount" = ${job.attemptCount}
       AND job."lockOwner" = ${job.lockOwner}
       AND job."status" = 'running'
       AND job."leaseExpiresAt" > clock_timestamp()
       AND document."generation" = job."generation"
       AND document."deletedAt" IS NULL
       FOR UPDATE OF job, document`;
  return rows[0]?.now ?? null;
}

function classifyReceiptFailure(error: unknown): ReceiptFailure {
  if (error instanceof ExtractorError) {
    return { errorCode: error.code, transient: error.transient };
  }
  if (error instanceof ReceiptSettingError) {
    return { errorCode: error.code, transient: false };
  }
  if (error instanceof AttachmentError) {
    return { errorCode: 'RECEIPT_FILE_UNAVAILABLE', transient: false };
  }
  return { errorCode: 'RECEIPT_PROCESSING_FAILED', transient: true };
}

export async function reprocessReceipt(
  companyId: string,
  receiptId: string,
  actorUserId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<void> {
  await batchReprocessReceipts(companyId, actorUserId, [{
    id: receiptId,
    expectedRevision,
    idempotencyKey,
  }]);
}

export interface BatchReprocessReceiptItem {
  id: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export async function batchReprocessReceipts(
  companyId: string,
  actorUserId: string,
  receipts: BatchReprocessReceiptItem[],
): Promise<void> {
  const ids = new Set(receipts.map((receipt) => receipt.id));
  if (
    companyId.trim() === ''
    || actorUserId.trim() === ''
    || receipts.length < 1
    || receipts.length > 100
    || ids.size !== receipts.length
    || receipts.some((receipt) =>
      receipt.id.trim() === ''
      || !Number.isInteger(receipt.expectedRevision)
      || receipt.expectedRevision < 0
      || receipt.idempotencyKey.trim() === ''
      || receipt.idempotencyKey.length > 128)
  ) {
    throw new ReceiptError('RECEIPT_INVALID_INPUT', 'Invalid reprocess request.');
  }
  await prisma.$transaction(async (tx) => {
    const orderedIds = [...ids].sort();
    const rows = await tx.$queryRaw<Array<{
      id: string;
      revision: number;
      generation: number;
      status: string;
      transactionAttachmentId: string | null;
    }>>(Prisma.sql`
      SELECT "id", "revision", "generation", "status",
             "transactionAttachmentId"
        FROM "ReceiptDocument"
       WHERE "id" IN (${Prisma.join(orderedIds)})
         AND "companyId" = ${companyId}
         AND "deletedAt" IS NULL
       ORDER BY "id"
       FOR UPDATE`);
    const rowsById = new Map(rows.map((receipt) => [receipt.id, receipt]));
    const replayed = new Set<string>();
    for (const requested of receipts) {
      const receipt = rowsById.get(requested.id);
      if (!receipt) {
        throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt not found.');
      }
      const prior = await tx.$queryRaw<Array<{ expectedRevision: number }>>`
        SELECT ("before"->>'revision')::integer AS "expectedRevision"
          FROM "ReceiptEvent"
         WHERE "documentId" = ${requested.id}
           AND "companyId" = ${companyId}
           AND "actorUserId" = ${actorUserId}
           AND "action" = 'reprocess'
           AND "after"->>'idempotencyKey' = ${requested.idempotencyKey}
         ORDER BY "createdAt" DESC
         LIMIT 1`;
      if (prior[0]) {
        if (prior[0].expectedRevision === requested.expectedRevision) {
          replayed.add(requested.id);
          continue;
        }
        throw new ReceiptError(
          'RECEIPT_IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to another reprocess request.',
        );
      }
      if (
        receipt.revision !== requested.expectedRevision
        || receipt.status === 'ATTACHING'
        || receipt.status === 'ATTACHED'
        || receipt.transactionAttachmentId !== null
      ) {
        throw new ReceiptError('RECEIPT_STALE', 'Receipt revision is stale.');
      }
    }
    const config = await tx.receiptCompanyConfig.findUnique({
      where: { companyId },
      select: { configVersion: true },
    });
    const dueAt = new Date();
    for (const requested of receipts) {
      if (replayed.has(requested.id)) continue;
      const receipt = rowsById.get(requested.id)!;
      const generation = receipt.generation + 1;
      await tx.receiptProcessingJob.updateMany({
        where: {
          documentId: requested.id,
          companyId,
          status: { in: ['queued', 'retry', 'running'] },
        },
        data: {
          status: 'cancelled',
          lockOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: 'RECEIPT_SUPERSEDED',
        },
      });
      const updated = await tx.receiptDocument.updateMany({
        where: {
          id: requested.id,
          companyId,
          revision: requested.expectedRevision,
          deletedAt: null,
        },
        data: {
          generation,
          revision: { increment: 1 },
          status: 'QUEUED',
          pageCount: null,
          matchedTransactionId: null,
          matchedTransactionRevision: null,
          approvedAt: null,
          approvedByUserId: null,
        },
      });
      if (updated.count !== 1) {
        throw new ReceiptError('RECEIPT_STALE', 'Receipt revision is stale.');
      }
      await tx.receiptProcessingJob.create({
        data: {
          documentId: requested.id,
          companyId,
          generation,
          configVersion:
            config?.configVersion ?? DEFAULT_RECEIPT_CONFIG_VERSION,
          status: 'queued',
          dueAt,
        },
      });
      await tx.receiptEvent.create({
        data: {
          companyId,
          documentId: requested.id,
          actorUserId,
          action: 'reprocess',
          before: {
            generation: receipt.generation,
            revision: receipt.revision,
          },
          after: {
            generation,
            idempotencyKey: requested.idempotencyKey,
          },
        },
      });
    }
  });
}
