import { createHash } from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  ReceiptDocumentStatus,
  ReceiptSourceKind,
} from '../../lib/db.js';
import type {
  CreateReceiptsResult,
  ReceiptDto,
  ReceiptExtractionDto,
  ReceiptLineItemDto,
  ReceiptTaxComponentDto,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import type { AttachmentActor } from '../attachments/operations.js';
import { ReceiptError } from './types.js';
import { DEFAULT_RECEIPT_CONFIG_VERSION } from './settings.js';

const RECEIPT_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
]);
const RECEIPT_SOURCE_KINDS = new Set<ReceiptSourceKind>([
  'WEB_UPLOAD',
  'API_UPLOAD',
  'MCP_UPLOAD',
]);
const MAX_FILES = 20;
const MAX_IDEMPOTENCY_KEY_BYTES = 128;

const receiptInclude = {
  attempts: {
    orderBy: { startedAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.ReceiptDocumentInclude;

type ReceiptRow = Prisma.ReceiptDocumentGetPayload<{
  include: typeof receiptInclude;
}>;

export interface CreateReceiptsInput {
  actor: AttachmentActor;
  companyId: string;
  files: readonly {
    uploadId: string;
    sourceExternalId?: string;
  }[];
  sourceKind: ReceiptSourceKind;
  idempotencyKey: string;
}

export interface ReceiptIntakeDeps {
  readonly now?: () => Date;
  readonly configVersion?: (
    companyId: string,
    db: Prisma.TransactionClient,
  ) => Promise<string>;
  readonly serializable?: <T>(
    callback: (db: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
}

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'number'
    || typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function requestHash(input: CreateReceiptsInput): string {
  return createHash('sha256').update(canonicalJson({
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    sourceKind: input.sourceKind,
    files: input.files.map((file) => ({
      uploadId: file.uploadId,
      sourceExternalId: file.sourceExternalId,
    })),
  }), 'utf8').digest('hex');
}

function roleAllowsMutation(actor: AttachmentActor, companyId: string): boolean {
  if (actor.isInstanceAdmin) return true;
  const role = actor.memberships.find(
    (membership) => membership.companyId === companyId,
  )?.role;
  return role === 'categorizer' || role === 'admin';
}

function authorizeReceiptMutation(
  actor: AttachmentActor,
  companyId: string,
): void {
  if (!roleAllowsMutation(actor, companyId)) {
    throw new ReceiptError(
      'RECEIPT_FORBIDDEN',
      'Receipt mutation is not allowed.',
    );
  }
}

function assertCreateInput(input: CreateReceiptsInput): void {
  const uploadIds = new Set(input.files.map((file) => file.uploadId));
  const externalIds = input.files.flatMap((file) =>
    file.sourceExternalId === undefined ? [] : [file.sourceExternalId]);
  if (
    input.actor.actorKey.trim() === ''
    || Buffer.byteLength(input.actor.actorKey, 'utf8') > 160
    || input.companyId.trim() === ''
    || input.idempotencyKey.trim() === ''
    || Buffer.byteLength(input.idempotencyKey, 'utf8')
      > MAX_IDEMPOTENCY_KEY_BYTES
    || input.files.length < 1
    || input.files.length > MAX_FILES
    || uploadIds.size !== input.files.length
    || new Set(externalIds).size !== externalIds.length
    || !RECEIPT_SOURCE_KINDS.has(input.sourceKind)
    || input.files.some((file) =>
      file.uploadId.trim() === ''
      || (
        file.sourceExternalId !== undefined
        && (
          file.sourceExternalId.trim() === ''
          || Buffer.byteLength(file.sourceExternalId, 'utf8') > 200
        )
      ))
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt intake input is invalid.',
    );
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002'
  );
}

async function retryUniqueRace<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      if (attempt === 3) {
        throw new ReceiptError(
          'RECEIPT_IDEMPOTENCY_CONFLICT',
          'Concurrent receipt intake could not be reconciled.',
        );
      }
    }
  }
  throw new ReceiptError(
    'RECEIPT_IDEMPOTENCY_CONFLICT',
    'Concurrent receipt intake could not be reconciled.',
  );
}

function stringArray(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function jsonString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

function lineItemArray(
  value: Prisma.JsonValue | null,
): ReceiptLineItemDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return [];
    }
    const description = jsonString(item.description);
    if (description === null) return [];
    return [{
      description,
      quantity: jsonString(item.quantity),
      unitPrice: jsonString(item.unitPrice ?? item.unit_price),
    }];
  });
}

function additionalFieldArray(
  value: Prisma.JsonValue | null,
): Array<{ key: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return [];
    }
    const key = jsonString(item.key);
    const fieldValue = jsonString(item.value);
    return key === null || fieldValue === null ? [] : [{ key, value: fieldValue }];
  });
}

function taxComponentArray(
  value: Prisma.JsonValue | null,
): ReceiptTaxComponentDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return [];
    }
    const label = jsonString(item.label);
    if (label === null) return [];
    return [{
      label,
      rate: jsonString(item.rate),
      amount: jsonString(item.amount),
      confidence: typeof item.confidence === 'number'
        && Number.isFinite(item.confidence)
        ? item.confidence
        : null,
    }];
  });
}

export function toReceiptExtractionDto(
  attempt: ReceiptRow['attempts'][number],
): ReceiptExtractionDto {
  return {
    id: attempt.id,
    generation: attempt.generation,
    status: attempt.status as ReceiptExtractionDto['status'],
    receiptDate: attempt.receiptDate?.toISOString().slice(0, 10) ?? null,
    documentTitle: attempt.documentTitle,
    vendorName: attempt.vendorName,
    vendorTaxId: attempt.vendorTaxId,
    vendorReceiptId: attempt.vendorReceiptId,
    clientName: attempt.clientName,
    clientTaxId: attempt.clientTaxId,
    description: attempt.description,
    lineItems: lineItemArray(attempt.lineItems),
    subtotal: attempt.subtotal?.toString() ?? null,
    taxAmount: attempt.taxAmount?.toString() ?? null,
    totalAmount: attempt.totalAmount?.toString() ?? null,
    currency: attempt.currency,
    convertedAmount: attempt.convertedAmount?.toString() ?? null,
    conversionRate: attempt.conversionRate?.toString() ?? null,
    paymentMethod: attempt.paymentMethod,
    paymentIdentifier: attempt.paymentIdentifier,
    language: attempt.language,
    additionalFields: additionalFieldArray(attempt.additionalFields),
    rawExtractedText: attempt.rawExtractedText,
    documentType: attempt.documentType,
    category: attempt.category,
    extractionConfidence: attempt.extractionConfidence?.toNumber() ?? null,
    taxComponents: taxComponentArray(attempt.taxComponents),
    parseSalvaged: attempt.parseSalvaged,
    warnings: stringArray(attempt.warnings),
    model: attempt.model,
    promptVersion: attempt.promptVersion,
    schemaVersion: attempt.schemaVersion,
    tokensIn: attempt.tokensIn,
    tokensOut: attempt.tokensOut,
    costUsd: attempt.costUsd?.toString() ?? null,
    durationMs: attempt.durationMs,
    errorCode: attempt.errorCode,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
  };
}

export function toReceiptDto(
  receipt: ReceiptRow,
): ReceiptDto {
  const sizeBytes = receipt.sizeBytes.toString();
  return {
    id: receipt.id,
    filename: receipt.originalFilename,
    contentType: receipt.contentType,
    sizeBytes,
    sha256: receipt.sha256,
    sourceKind: receipt.sourceKind,
    status: receipt.status,
    generation: receipt.generation,
    revision: receipt.revision,
    pageCount: receipt.pageCount,
    retentionPolicy: receipt.retainLocally,
    retainedLocally: receipt.blobId !== null,
    approved: receipt.approvedAt !== null,
    userNotes: receipt.userNotes,
    manuallyEdited: receipt.manuallyEdited,
    lastExportedAt: receipt.lastExportedAt?.toISOString() ?? null,
    matchedTransactionId: receipt.matchedTransactionId,
    transactionAttachmentId: receipt.transactionAttachmentId,
    currentExtraction: receipt.attempts[0]
      ? toReceiptExtractionDto(receipt.attempts[0])
      : null,
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
  };
}

async function configVersion(
  companyId: string,
  db: Prisma.TransactionClient,
  deps: ReceiptIntakeDeps,
): Promise<string> {
  if (deps.configVersion) return deps.configVersion(companyId, db);
  const config = await db.receiptCompanyConfig.findUnique({
    where: { companyId },
    select: { configVersion: true },
  });
  return config?.configVersion ?? DEFAULT_RECEIPT_CONFIG_VERSION;
}

function receiptIds(value: Prisma.JsonValue): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string')
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Stored receipt intake state is invalid.',
    );
  }
  return [...value] as string[];
}

async function loadReceipts(
  db: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<ReceiptRow[]> {
  const rows = await db.receiptDocument.findMany({
    where: { id: { in: [...ids] } },
    include: receiptInclude,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id));
  if (ordered.some((row) => row === undefined)) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Stored receipt intake state is incomplete.',
    );
  }
  return ordered as ReceiptRow[];
}

export async function createReceipts(
  input: CreateReceiptsInput,
  deps: ReceiptIntakeDeps = {},
): Promise<CreateReceiptsResult> {
  authorizeReceiptMutation(input.actor, input.companyId);
  assertCreateInput(input);
  const hash = requestHash(input);
  const now = deps.now ?? (() => new Date());
  const serializable = deps.serializable
    ?? (<T>(callback: (db: Prisma.TransactionClient) => Promise<T>) =>
      runSerializableTransaction<
        Prisma.TransactionClient,
        T
      >(prisma as unknown as PrismaClient, callback));

  return retryUniqueRace(() => serializable(async (db) => {
    const prior = await db.receiptIntakeOperation.findUnique({
      where: {
        actorKey_companyId_idempotencyKey: {
          actorKey: input.actor.actorKey,
          companyId: input.companyId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new ReceiptError(
          'RECEIPT_IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to different receipt inputs.',
        );
      }
      const receipts = await loadReceipts(db, receiptIds(prior.receiptIds));
      return { receipts: receipts.map(toReceiptDto) };
    }

    const currentTime = now();
    const stagedRows = await db.stagedAttachment.findMany({
      where: {
        id: { in: input.files.map((file) => file.uploadId) },
        companyId: input.companyId,
        actorKey: input.actor.actorKey,
        consumedAt: null,
        expiresAt: { gt: currentTime },
      },
      include: { blob: true, company: true },
      orderBy: { createdAt: 'asc' },
    });
    if (stagedRows.length !== input.files.length) {
      throw new ReceiptError(
        'RECEIPT_INVALID_INPUT',
        'One or more staged uploads are unavailable.',
      );
    }
    const stagedById = new Map(stagedRows.map((file) => [file.id, file]));
    const orderedStaged = input.files.map((file) => stagedById.get(file.uploadId));
    if (orderedStaged.some((file) => file === undefined)) {
      throw new ReceiptError(
        'RECEIPT_INVALID_INPUT',
        'One or more staged uploads are unavailable.',
      );
    }
    for (const file of orderedStaged) {
      if (!RECEIPT_CONTENT_TYPES.has(file!.contentType)) {
        throw new ReceiptError(
          'RECEIPT_TYPE_UNSUPPORTED',
          'Receipt extraction supports PDF and image files only.',
        );
      }
      if (!file!.blob.sha256) {
        throw new ReceiptError(
          'RECEIPT_INVALID_INPUT',
          'A staged receipt file is not ready.',
        );
      }
    }

    const receipts: ReceiptRow[] = [];
    for (let index = 0; index < orderedStaged.length; index += 1) {
      const file = orderedStaged[index]!;
      const descriptor = input.files[index]!;
      if (descriptor.sourceExternalId !== undefined) {
        const external = await db.receiptDocument.findFirst({
          where: {
            companyId: input.companyId,
            sourceKind: input.sourceKind,
            sourceExternalId: descriptor.sourceExternalId,
          },
          include: receiptInclude,
        });
        if (external) {
          if (external.deletedAt !== null) {
            throw new ReceiptError(
              'RECEIPT_IDEMPOTENCY_CONFLICT',
              'The matching receipt is deleted and must be restored.',
            );
          }
          if (external.sha256 !== file.blob.sha256) {
            throw new ReceiptError(
              'RECEIPT_IDEMPOTENCY_CONFLICT',
              'The external receipt identifier is bound to different content.',
            );
          }
          await db.stagedAttachment.update({
            where: { id: file.id },
            data: { consumedAt: currentTime },
          });
          receipts.push(external);
          continue;
        }
      }
      const existing = await db.receiptDocument.findFirst({
        where: {
          companyId: input.companyId,
          OR: [
            { blobId: file.blobId },
            { sha256: file.blob.sha256! },
          ],
        },
        include: receiptInclude,
      });
      if (existing) {
        if (
          descriptor.sourceExternalId !== undefined
          && (
            existing.sourceKind !== input.sourceKind
            || existing.sourceExternalId !== descriptor.sourceExternalId
          )
        ) {
          throw new ReceiptError(
            'RECEIPT_IDEMPOTENCY_CONFLICT',
            'The receipt content already exists under a different source identity.',
          );
        }
        if (existing.deletedAt !== null) {
          throw new ReceiptError(
            'RECEIPT_IDEMPOTENCY_CONFLICT',
            'The matching receipt is deleted and must be restored.',
          );
        }
        await db.stagedAttachment.update({
          where: { id: file.id },
          data: { consumedAt: currentTime },
        });
        receipts.push(existing);
        continue;
      }

      const receipt = await db.receiptDocument.create({
        data: {
          companyId: input.companyId,
          blobId: file.blobId,
          originalFilename: file.originalFilename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          sha256: file.blob.sha256!,
          sourceKind: input.sourceKind,
          sourceExternalId: descriptor.sourceExternalId,
          status: 'QUEUED' satisfies ReceiptDocumentStatus,
          retainLocally: file.company.retainAttachmentFiles,
          createdByUserId: input.actor.userId,
          jobs: {
            create: {
              companyId: input.companyId,
              generation: 1,
              configVersion: await configVersion(input.companyId, db, deps),
              status: 'queued',
              dueAt: currentTime,
            },
          },
        },
        include: receiptInclude,
      });
      await db.receiptEvent.create({
        data: {
          companyId: input.companyId,
          documentId: receipt.id,
          actorUserId: input.actor.userId,
          action: 'intake',
          after: {
            sourceKind: input.sourceKind,
            status: 'QUEUED',
            retainLocally: file.company.retainAttachmentFiles,
          },
        },
      });
      await db.stagedAttachment.update({
        where: { id: file.id },
        data: { consumedAt: currentTime },
      });
      receipts.push(receipt);
    }

    await db.receiptIntakeOperation.create({
      data: {
        actorKey: input.actor.actorKey,
        companyId: input.companyId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        receiptIds: receipts.map((receipt) => receipt.id),
      },
    });
    return { receipts: receipts.map(toReceiptDto) };
  }));
}
