import { createHash, randomUUID } from 'node:crypto';
import type {
  AttachmentOperationKind,
  AttachmentOperationStatus,
  AttachmentSourceKind,
  AttachmentStatus as StoredAttachmentStatus,
  Prisma,
  PrismaClient,
} from '../../lib/db.js';
import type {
  AttachmentDto,
  AttachmentOperationDto,
  AttachmentSourceInput,
  AttachmentStatus,
  AuditAction,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import {
  QboRequestTimeout,
  type QboAttachmentRef,
  type QboAttachmentUploadOutcome,
  type QboClient,
} from '../../lib/qbo/types.js';
import {
  normalizeAttachmentAuditMetadata,
  writeAudit,
} from '../audit.js';
import {
  collectUnreferencedBlobs,
  createAttachmentBatchBudget,
  openAttachmentBlob,
  releaseAttachmentBlob,
  stageAttachment,
} from './blobStore.js';
import {
  AttachmentError,
  type AttachmentBlobReader,
  type StagedAttachmentDto,
} from './types.js';
import { importHttpsAttachment } from './urlImport.js';
import {
  normalizeAttachmentFilename,
  QBO_MAX_UPLOAD_REQUEST_BYTES,
} from './validation.js';
import { findExactMarkerMatches } from './reconciliation.js';

const MAX_FILES = 20;
const MAX_IDEMPOTENCY_KEY_BYTES = 128;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const STUCK_OPERATION_AGE_MS = 5 * 60 * 1000;
const STUCK_OPERATION_LIMIT = 25;

export interface AttachmentActor {
  kind: 'session' | 'mcp' | 'system';
  actorKey: string;
  userId: string | null;
  isInstanceAdmin: boolean;
  memberships: readonly { companyId: string; role: string }[];
}

export type InternalAttachmentSource =
  | AttachmentSourceInput
  | {
      kind: 'receipt';
      documentId: string;
      blobId: string;
      filename: string;
      contentType: string;
      sizeBytes: bigint;
      sha256: string;
      retainLocally: boolean;
    };

export interface AttachFilesInput {
  actor: AttachmentActor;
  companyId: string;
  transactionId: string;
  idempotencyKey: string;
  sources: readonly InternalAttachmentSource[];
}

export interface DeleteAttachmentInput {
  actor: AttachmentActor;
  companyId: string;
  transactionId: string;
  attachmentId: string;
  scope: 'local' | 'everywhere';
  idempotencyKey: string;
  receiptDocumentId?: string;
}

export interface AttachmentOperationDependencies {
  db?: PrismaClient;
  now?: () => Date;
  qboForCompany?: (companyId: string) => Promise<QboClient>;
  importHttps?: typeof importHttpsAttachment;
  openBlob?: (
    companyId: string,
    blobId: string,
  ) => Promise<AttachmentBlobReader>;
  releaseBlob?: (attachmentId: string) => Promise<void>;
}

interface HashSource {
  attachmentId: string;
  filename: string;
  sha256: string;
  sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT';
  retainLocally: boolean;
}

export interface AttachmentOperationHashInput {
  actorKey: string;
  companyId: string;
  transactionId: string;
  idempotencyKey: string;
  sources: readonly HashSource[];
}

interface ResolvedSource {
  stagedId: string | null;
  receiptDocumentId: string | null;
  blobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT';
  retainLocally: boolean;
}

const operationInclude = {
  transaction: {
    select: {
      id: true,
      payee: true,
      amount: true,
      qboId: true,
      qboType: true,
    },
  },
  files: {
    orderBy: { ordinal: 'asc' },
    include: { attachment: true },
  },
} satisfies Prisma.AttachmentOperationInclude;

type OperationRow = Prisma.AttachmentOperationGetPayload<{
  include: typeof operationInclude;
}>;

function dbOf(deps?: AttachmentOperationDependencies): PrismaClient {
  return deps?.db ?? prisma;
}

function nowOf(deps?: AttachmentOperationDependencies): Date {
  return (deps?.now ?? (() => new Date()))();
}

function qboOf(
  companyId: string,
  deps?: AttachmentOperationDependencies,
): Promise<QboClient> {
  return (deps?.qboForCompany ?? ((id) => qboFactory.forCompany(id)))(
    companyId,
  );
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

export function canonicalAttachmentOperationHash(
  input: AttachmentOperationHashInput,
): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

function deletionOperationHash(input: DeleteAttachmentInput): string {
  return createHash('sha256').update(canonicalJson({
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    attachmentId: input.attachmentId,
    scope: input.scope,
    idempotencyKey: input.idempotencyKey,
    receiptDocumentId: input.receiptDocumentId ?? null,
  }), 'utf8').digest('hex');
}

function sourceRequestHash(input: AttachFilesInput): string {
  return createHash('sha256').update(canonicalJson({
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    sources: input.sources.map((source) =>
      source.kind === 'upload'
        ? { kind: source.kind, uploadId: source.uploadId }
        : source.kind === 'https'
          ? {
            kind: source.kind,
            urlHash: createHash('sha256')
              .update(source.url, 'utf8')
              .digest('hex'),
          }
          : {
              kind: source.kind,
              documentId: source.documentId,
              blobId: source.blobId,
              sha256: source.sha256,
              retainLocally: source.retainLocally,
            }),
  }), 'utf8').digest('hex');
}

export function deriveAttachmentOperationStatus(
  statuses: readonly AttachmentStatus[],
): AttachmentOperationStatus {
  if (statuses.length === 0) return 'FAILED';
  if (statuses.every((status) => status === 'DELETED')) return 'DELETED';
  if (statuses.some((status) => status === 'DELETING')) return 'DELETING';
  if (
    statuses.some(
      (status) => status === 'UNCERTAIN' || status === 'RECONCILING',
    )
  ) {
    return 'UNCERTAIN';
  }
  if (statuses.some((status) => status === 'UPLOADING')) return 'COMMITTING';
  if (statuses.every((status) => status === 'ATTACHED')) return 'VERIFIED';
  if (
    statuses.some((status) => status === 'ATTACHED')
    && statuses.some(
      (status) => status === 'FAILED' || status === 'QBO_MISSING',
    )
  ) {
    return 'PARTIAL';
  }
  if (
    statuses.every(
      (status) => status === 'FAILED' || status === 'QBO_MISSING',
    )
  ) {
    return 'FAILED';
  }
  return 'PREPARED';
}

export function normalizeAttachmentAuditDetails(input: {
  attachmentCount: number;
  totalBytes: number;
  sourceKinds: readonly AttachmentSourceKind[];
  state: AttachmentOperationStatus;
}): {
  attachmentCount: number;
  sizeBucket: 'UNDER_1MB' | '1MB_TO_10MB' | '10MB_TO_100MB';
  sourceKinds: AttachmentSourceKind[];
  state: AttachmentOperationStatus;
} {
  return normalizeAttachmentAuditMetadata(input);
}

function roleAllows(
  actor: AttachmentActor,
  companyId: string,
  minimum: 'viewer' | 'categorizer',
): boolean {
  if (actor.isInstanceAdmin) return true;
  const role = actor.memberships.find(
    (membership) => membership.companyId === companyId,
  )?.role;
  if (minimum === 'viewer') {
    return role === 'viewer' || role === 'categorizer' || role === 'admin';
  }
  return role === 'categorizer' || role === 'admin';
}

function authorize(
  actor: AttachmentActor,
  companyId: string,
  minimum: 'viewer' | 'categorizer',
): void {
  if (!roleAllows(actor, companyId, minimum)) {
    throw new AttachmentError(
      'ATTACHMENT_FORBIDDEN',
      'Attachment access is not allowed.',
    );
  }
}

function validateScope(input: {
  actor: AttachmentActor;
  companyId: string;
  transactionId: string;
  idempotencyKey: string;
}): void {
  if (
    input.actor.actorKey.trim() === ''
    || Buffer.byteLength(input.actor.actorKey, 'utf8') > 160
    || input.companyId.trim() === ''
    || input.transactionId.trim() === ''
    || input.idempotencyKey.trim() === ''
    || Buffer.byteLength(input.idempotencyKey, 'utf8')
      > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment operation scope is invalid.',
    );
  }
}

function isSupportedQboType(
  value: string,
): value is QboAttachmentRef['qboType'] {
  return value === 'Purchase'
    || value === 'Deposit'
    || value === 'JournalEntry';
}

function errorMessage(code: string): string {
  if (code === 'ATTACHMENT_PROVIDER_UNCERTAIN') {
    return 'QuickBooks attachment status requires reconciliation.';
  }
  if (code === 'ATTACHMENT_PROVIDER_AMBIGUOUS') {
    return 'QuickBooks returned more than one matching attachment.';
  }
  if (code === 'ATTACHMENT_PROVIDER_NOT_FOUND') {
    return 'QuickBooks did not contain the expected attachment.';
  }
  return 'The attachment operation requires attention.';
}

function attachmentDto(
  row: OperationRow['files'][number]['attachment'],
  statusOverride?: StoredAttachmentStatus,
): AttachmentDto {
  const status = statusOverride ?? row.status;
  return {
    id: row.id,
    transactionId: row.transactionId,
    filename: row.originalFilename,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sourceKind: row.sourceKind,
    retainedLocally: row.blobId !== null,
    status,
    qboAttached:
      row.qboAttachableId !== null
      && status !== 'DELETED'
      && status !== 'QBO_MISSING',
    canPreview:
      row.contentType === 'application/pdf'
      || row.contentType.startsWith('image/')
      || row.contentType.startsWith('text/'),
    error: row.errorCode
      ? { code: row.errorCode, message: errorMessage(row.errorCode) }
      : null,
  };
}

function operationDto(row: OperationRow): AttachmentOperationDto {
  const statuses = row.files.map((file) => file.status);
  const status = deriveAttachmentOperationStatus(statuses);
  const receiptManaged = isReceiptManagedOperation(row);
  return {
    operationId: row.id,
    status,
    files: row.files.map((file) =>
      attachmentDto(file.attachment, file.status)),
    actions: {
      canRetry:
        !receiptManaged
        && row.kind !== 'DELETE_LOCAL'
        && statuses.some(
          (fileStatus) =>
            fileStatus === 'FAILED' || fileStatus === 'QBO_MISSING',
        ),
      requiresReconciliation: statuses.some(
        (fileStatus) => fileStatus === 'UNCERTAIN',
      ),
    },
  };
}

function isReceiptManagedOperation(
  row: Pick<OperationRow, 'receiptDocumentId'>,
): boolean {
  return row.receiptDocumentId !== null;
}

function usesReservedReceiptKey(idempotencyKey: string): boolean {
  return idempotencyKey.startsWith('receipt-attach:')
    || idempotencyKey.startsWith('receipt-undo:');
}

function requireGenericAttachmentOperation(row: OperationRow): void {
  if (!isReceiptManagedOperation(row)) return;
  throw new AttachmentError(
    'ATTACHMENT_BUSY',
    'Retry or reconcile this operation through the receipt workflow.',
    true,
  );
}

async function loadOperation(
  db: PrismaClient,
  operationId: string,
): Promise<OperationRow> {
  const row = await db.attachmentOperation.findUnique({
    where: { id: operationId },
    include: operationInclude,
  });
  if (!row) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment operation was not found.',
    );
  }
  return row;
}

async function loadIdempotentOperation(
  db: PrismaClient,
  input: {
    actorKey: string;
    companyId: string;
    transactionId: string;
    idempotencyKey: string;
  },
): Promise<OperationRow | null> {
  return db.attachmentOperation.findUnique({
    where: {
      actorKey_companyId_transactionId_idempotencyKey: {
        actorKey: input.actorKey,
        companyId: input.companyId,
        transactionId: input.transactionId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: operationInclude,
  });
}

function assertSameHash(row: OperationRow, inputHash: string): void {
  if (row.inputHash !== inputHash) {
    throw new AttachmentError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to different attachment inputs.',
    );
  }
}

function assertSameAttachRequest(
  row: OperationRow,
  requestHash: string,
): void {
  if (row.kind !== 'ATTACH' || row.requestHash !== requestHash) {
    throw new AttachmentError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to different attachment inputs.',
    );
  }
}

async function resolveSources(
  input: AttachFilesInput,
  retainLocally: boolean,
  deps?: AttachmentOperationDependencies,
): Promise<ResolvedSource[]> {
  const db = dbOf(deps);
  const now = nowOf(deps);
  if (input.sources.length < 1 || input.sources.length > MAX_FILES) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment batches must contain between 1 and 20 files.',
    );
  }
  const budget = createAttachmentBatchBudget(QBO_MAX_UPLOAD_REQUEST_BYTES);
  const staged: StagedAttachmentDto[] = [];
  const receipts = new Map<number, ResolvedSource>();
  for (const [index, source] of input.sources.entries()) {
    if (source.kind === 'receipt') {
      const row = await db.receiptDocument.findFirst({
        where: {
          id: source.documentId,
          companyId: input.companyId,
          blobId: source.blobId,
          matchedTransactionId: input.transactionId,
          transactionAttachmentId: null,
          status: { in: ['MATCHED', 'ATTACHING'] },
          deletedAt: null,
        },
        include: {
          blob: { select: { id: true, sha256: true, state: true } },
        },
      });
      const sizeBytes = Number(source.sizeBytes);
      if (
        !row
        || !row.blob
        || row.blob.state !== 'READY'
        || row.blob.sha256 !== source.sha256
        || row.originalFilename !== source.filename
        || row.contentType !== source.contentType
        || row.sizeBytes !== source.sizeBytes
        || row.sha256 !== source.sha256
        || row.retainLocally !== source.retainLocally
        || !Number.isSafeInteger(sizeBytes)
      ) {
        throw new AttachmentError(
          'ATTACHMENT_NOT_FOUND',
          'Receipt attachment source was not found.',
        );
      }
      budget.consume(sizeBytes);
      receipts.set(index, {
        stagedId: null,
        receiptDocumentId: row.id,
        blobId: row.blob.id,
        filename: row.originalFilename,
        contentType: row.contentType,
        sizeBytes,
        sha256: row.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: row.retainLocally,
      });
      continue;
    }
    if (source.kind === 'https') {
      staged.push(await (deps?.importHttps ?? importHttpsAttachment)({
        companyId: input.companyId,
        actorKey: input.actor.actorKey,
        retainLocally,
        url: source.url,
        batchBudget: budget,
        expiresAt: new Date(now.getTime() + STAGING_TTL_MS),
      }));
      continue;
    }
    const row = await db.stagedAttachment.findUnique({
      where: { id: source.uploadId },
      include: {
        blob: { select: { sha256: true, state: true } },
      },
    });
    if (
      !row
      || row.companyId !== input.companyId
      || row.actorKey !== input.actor.actorKey
      || row.sourceKind === 'QBO_EXTERNAL'
      || row.blob.state !== 'READY'
      || row.blob.sha256 === null
      || row.expiresAt <= now
    ) {
      throw new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'Staged attachment was not found.',
      );
    }
    const sizeBytes = Number(row.sizeBytes);
    budget.consume(sizeBytes);
    staged.push({
      id: row.id,
      companyId: row.companyId,
      filename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes,
      sha256: row.blob.sha256,
      sourceKind: row.sourceKind,
      retainLocally: row.retainLocally,
      expiresAt: row.expiresAt.toISOString(),
    });
  }
  const rows = await db.stagedAttachment.findMany({
    where: { id: { in: staged.map((source) => source.id) } },
    include: {
      blob: { select: { id: true, sha256: true, state: true } },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolvedStaged = staged.map((source) => {
    const row = byId.get(source.id);
    if (
      !row
      || row.companyId !== input.companyId
      || row.actorKey !== input.actor.actorKey
      || row.blob.state !== 'READY'
      || row.blob.sha256 !== source.sha256
    ) {
      throw new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'Staged attachment was not found.',
      );
    }
    return {
      stagedId: row.id,
      receiptDocumentId: null,
      blobId: row.blob.id,
      filename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: Number(row.sizeBytes),
      sha256: source.sha256,
      sourceKind: row.sourceKind as 'LOCAL_UPLOAD' | 'HTTPS_IMPORT',
      retainLocally: row.retainLocally,
    };
  });
  let stagedIndex = 0;
  return input.sources.map((_source, index) => {
    const receipt = receipts.get(index);
    if (receipt) return receipt;
    return resolvedStaged[stagedIndex++]!;
  });
}

function hashForSources(
  input: AttachFilesInput,
  sources: readonly ResolvedSource[],
  attachmentIds: readonly string[],
): string {
  return canonicalAttachmentOperationHash({
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    sources: sources.map((source, index) => ({
      attachmentId: attachmentIds[index]!,
      filename: source.filename,
      sha256: source.sha256,
      sourceKind: source.sourceKind,
      retainLocally: source.retainLocally,
    })),
  });
}

function replayHash(
  input: AttachFilesInput,
  sources: readonly ResolvedSource[],
  existing: OperationRow,
): string {
  if (existing.kind !== 'ATTACH' || existing.files.length !== sources.length) {
    return '';
  }
  return canonicalAttachmentOperationHash({
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    sources: sources.map((source, index) => ({
      attachmentId: existing.files[index]!.attachmentId,
      filename: source.filename,
      sha256: source.sha256,
      sourceKind: source.sourceKind,
      retainLocally: existing.files[index]!.attachment.retainLocally,
    })),
  });
}

async function updateAggregate(
  db: PrismaClient,
  operationId: string,
): Promise<OperationRow> {
  const current = await loadOperation(db, operationId);
  const status = deriveAttachmentOperationStatus(
    current.files.map((file) => file.status),
  );
  if (current.status !== status) {
    await db.attachmentOperation.update({
      where: { id: operationId },
      data: { status },
    });
  }
  return loadOperation(db, operationId);
}

function storedErrorCode(error: unknown): string {
  if (error instanceof AttachmentError) return error.code;
  if (error instanceof QboRequestTimeout) {
    return 'ATTACHMENT_PROVIDER_UNCERTAIN';
  }
  return 'ATTACHMENT_PROVIDER_FAILED';
}

async function auditOperation(
  db: PrismaClient,
  actor: AttachmentActor,
  row: OperationRow,
  action: AuditAction,
): Promise<void> {
  const totalBytes = row.files.reduce(
    (sum, file) => sum + Number(file.attachment.sizeBytes),
    0,
  );
  await writeAudit(db, {
    companyId: row.companyId,
    actorId: actor.userId,
    actorLabel:
      actor.kind === 'system'
        ? 'system'
        : actor.kind === 'mcp'
          ? 'MCP user'
          : 'User',
    txnId: row.transactionId,
    payee: row.transaction.payee,
    amount: row.transaction.amount,
    action,
    before: 'attachment',
    after: row.status.toLowerCase(),
    payload: normalizeAttachmentAuditDetails({
      attachmentCount: row.files.length,
      totalBytes,
      sourceKinds: row.files.map(
        (file) => file.attachment.sourceKind,
      ),
      state: deriveAttachmentOperationStatus(
        row.files.map((file) => file.status),
      ),
    }),
  });
}

async function markUploadFailure(
  db: PrismaClient,
  operationId: string,
  attachmentIds: readonly string[],
  status: 'FAILED' | 'UNCERTAIN',
  errorCode: string,
): Promise<OperationRow> {
  await db.$transaction([
    db.attachmentOperationFile.updateMany({
      where: {
        operationId,
        attachmentId: { in: [...attachmentIds] },
        status: 'UPLOADING',
      },
      data: { status, errorCode },
    }),
    db.transactionAttachment.updateMany({
      where: { id: { in: [...attachmentIds] }, status: 'UPLOADING' },
      data: { status, errorCode },
    }),
  ]);
  return updateAggregate(db, operationId);
}

async function dispatchAttach(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  const db = dbOf(deps);
  let row = await loadOperation(db, operationId);
  if (row.kind !== 'ATTACH') {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment operation kind is invalid.',
    );
  }
  if (row.files.some((file) => file.status === 'UNCERTAIN')) {
    throw new AttachmentError(
      'ATTACHMENT_PROVIDER_UNCERTAIN',
      'Reconcile the attachment operation before retrying.',
      true,
    );
  }
  const candidates = row.files.filter(
    (file) =>
      file.status === 'STAGED'
      || file.status === 'FAILED'
      || file.status === 'QBO_MISSING',
  );
  if (candidates.length === 0) return operationDto(row);
  const candidateIds = candidates.map((file) => file.attachmentId);
  await db.$transaction(async (transaction) => {
    const claimed = await transaction.attachmentOperation.updateMany({
      where: {
        id: operationId,
        status: { in: ['PREPARED', 'PARTIAL', 'FAILED'] },
      },
      data: { status: 'COMMITTING', errorCode: null },
    });
    const claimedFiles = await transaction.attachmentOperationFile.updateMany({
      where: {
        operationId,
        attachmentId: { in: candidateIds },
        status: { in: ['STAGED', 'FAILED', 'QBO_MISSING'] },
      },
      data: { status: 'UPLOADING', errorCode: null },
    });
    const claimedAttachments = await transaction.transactionAttachment.updateMany({
      where: {
        id: { in: candidateIds },
        status: { in: ['STAGED', 'FAILED', 'QBO_MISSING'] },
      },
      data: { status: 'UPLOADING', errorCode: null },
    });
    if (
      claimed.count !== 1
      || claimedFiles.count !== candidateIds.length
      || claimedAttachments.count !== candidateIds.length
    ) {
      throw new AttachmentError(
        'ATTACHMENT_BUSY',
        'Attachment operation is already in progress.',
        true,
      );
    }
  });
  row = await loadOperation(db, operationId);
  const sending = row.files.filter(
    (file) => candidateIds.includes(file.attachmentId),
  );
  const ref: QboAttachmentRef = {
    qboType: row.transaction.qboType as QboAttachmentRef['qboType'],
    qboId: row.transaction.qboId,
  };
  const openBlob = deps?.openBlob
    ?? ((companyId: string, blobId: string) =>
      openAttachmentBlob(companyId, blobId, { db }));
  let outcomes: QboAttachmentUploadOutcome[];
  try {
    const qbo = await qboOf(row.companyId, deps);
    outcomes = await qbo.uploadAttachments(
      ref,
      sending.map((file) => {
        if (file.attachment.blobId === null) {
          throw new AttachmentError(
            'ATTACHMENT_NOT_FOUND',
            'Attachment content was not found.',
          );
        }
        const blobId = file.attachment.blobId;
        return {
          ordinal: file.ordinal,
          filename: file.attachment.originalFilename,
          contentType: file.attachment.contentType,
          sizeBytes: Number(file.attachment.sizeBytes),
          marker: file.attachment.recatMarker,
          openContent: () => openBlob(row.companyId, blobId),
        };
      }),
      row.id,
    );
  } catch (error) {
    const uncertain = error instanceof QboRequestTimeout;
    const failed = await markUploadFailure(
      db,
      operationId,
      candidateIds,
      uncertain ? 'UNCERTAIN' : 'FAILED',
      storedErrorCode(error),
    );
    await auditOperation(db, actor, failed, 'attachment_error');
    if (!uncertain) throw error;
    return operationDto(failed);
  }
  const outcomesByOrdinal = new Map(
    outcomes.map((outcome) => [outcome.ordinal, outcome]),
  );
  try {
    await db.$transaction(async (transaction) => {
      const releasableBlobIds: string[] = [];
      for (const file of sending) {
        const outcome = outcomesByOrdinal.get(file.ordinal);
        const status = !outcome
          ? 'UNCERTAIN'
          : outcome.outcome === 'FAILED'
            ? 'FAILED'
            : 'ATTACHED';
        const errorCode = status === 'UNCERTAIN'
          ? 'ATTACHMENT_PROVIDER_UNCERTAIN'
          : status === 'FAILED'
            ? 'ATTACHMENT_PROVIDER_FAILED'
            : null;
        const operationFile = await transaction.attachmentOperationFile.updateMany({
          where: {
            operationId,
            attachmentId: file.attachmentId,
            status: 'UPLOADING',
          },
          data: { status, errorCode },
        });
        const attachment = await transaction.transactionAttachment.updateMany({
          where: {
            id: file.attachmentId,
            status: 'UPLOADING',
          },
          data: {
            status,
            errorCode,
            ...(outcome?.outcome === 'ATTACHED'
              ? {
                  qboAttachableId: outcome.attachable.id,
                  qboSyncToken: outcome.attachable.syncToken,
                  ...(!file.attachment.retainLocally
                    ? { blobId: null, retainLocally: false }
                    : {}),
                }
              : {}),
          },
        });
        if (operationFile.count !== 1 || attachment.count !== 1) {
          throw new AttachmentError(
            'ATTACHMENT_BUSY',
            'Attachment outcome could not be persisted safely.',
            true,
          );
        }
        if (
          outcome?.outcome === 'ATTACHED'
          && !file.attachment.retainLocally
          && file.attachment.blobId !== null
        ) {
          releasableBlobIds.push(file.attachment.blobId);
        }
      }
      if (releasableBlobIds.length > 0) {
        await transaction.attachmentBlob.deleteMany({
          where: {
            id: { in: releasableBlobIds },
            stagedFiles: { none: {} },
            attachments: { none: {} },
            receiptDocuments: { none: {} },
          },
        });
      }
    });
  } catch {
    const uncertain = await markUploadFailure(
      db,
      operationId,
      candidateIds,
      'UNCERTAIN',
      'ATTACHMENT_PROVIDER_UNCERTAIN',
    );
    await auditOperation(db, actor, uncertain, 'attachment_error');
    return operationDto(uncertain);
  }
  const complete = await updateAggregate(db, operationId);
  await auditOperation(
    db,
    actor,
    complete,
    complete.status === 'VERIFIED'
      ? 'attachment_uploaded'
      : 'attachment_error',
  );
  return operationDto(complete);
}

export async function attachTransactionFiles(
  input: AttachFilesInput,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  validateScope({
    actor: input.actor,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
  });
  const receiptSources = input.sources.filter(
    (source) => source.kind === 'receipt',
  );
  if (
    receiptSources.length > 1
    || (receiptSources.length === 1 && input.sources.length !== 1)
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'A receipt attachment operation must contain exactly one receipt.',
    );
  }
  const receiptDocumentId = receiptSources[0]?.documentId ?? null;
  if (
    receiptDocumentId === null
    && usesReservedReceiptKey(input.idempotencyKey)
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'The receipt attachment idempotency namespace is reserved.',
    );
  }
  authorize(input.actor, input.companyId, 'categorizer');
  const db = dbOf(deps);
  const requestHash = sourceRequestHash(input);
  const existing = await loadIdempotentOperation(db, {
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertSameAttachRequest(existing, requestHash);
    return operationDto(existing);
  }
  const transaction = await db.transaction.findFirst({
    where: { id: input.transactionId, companyId: input.companyId },
    select: {
      id: true,
      qboType: true,
      company: { select: { retainAttachmentFiles: true } },
    },
  });
  if (!transaction || !isSupportedQboType(transaction.qboType)) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Transaction was not found.',
    );
  }
  let sources: ResolvedSource[];
  try {
    sources = await resolveSources(
      input,
      transaction.company.retainAttachmentFiles,
      deps,
    );
  } catch (error) {
    const raced = await loadIdempotentOperation(db, {
      actorKey: input.actor.actorKey,
      companyId: input.companyId,
      transactionId: input.transactionId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!raced) throw error;
    assertSameAttachRequest(raced, requestHash);
    return operationDto(raced);
  }
  const attachmentIds = sources.map(() => randomUUID());
  const operationId = randomUUID();
  const inputHash = hashForSources(
    input,
    sources,
    attachmentIds,
  );
  const now = nowOf(deps);
  try {
    await db.$transaction(async (tx) => {
      for (const source of sources) {
        if (source.stagedId === null) {
          const receipt = await tx.receiptDocument.findFirst({
            where: {
              id: source.receiptDocumentId!,
              companyId: input.companyId,
              blobId: source.blobId,
              matchedTransactionId: input.transactionId,
              transactionAttachmentId: null,
              status: { in: ['MATCHED', 'ATTACHING'] },
              deletedAt: null,
            },
            include: {
              blob: { select: { sha256: true, state: true } },
            },
          });
          if (
            !receipt
            || receipt.blob?.state !== 'READY'
            || receipt.blob.sha256 !== source.sha256
            || receipt.sha256 !== source.sha256
            || receipt.originalFilename !== source.filename
            || receipt.contentType !== source.contentType
            || receipt.sizeBytes !== BigInt(source.sizeBytes)
            || receipt.retainLocally !== source.retainLocally
          ) {
            throw new AttachmentError(
              'ATTACHMENT_BUSY',
              'Receipt attachment source changed.',
              true,
            );
          }
          continue;
        }
        const consumed = await tx.stagedAttachment.updateMany({
          where: {
            id: source.stagedId,
            companyId: input.companyId,
            actorKey: input.actor.actorKey,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) {
          throw new AttachmentError(
            'ATTACHMENT_BUSY',
            'Staged attachment was already consumed.',
            true,
          );
        }
      }
      await tx.attachmentOperation.create({
        data: {
          id: operationId,
          kind: 'ATTACH',
          actorKey: input.actor.actorKey,
          companyId: input.companyId,
          transactionId: input.transactionId,
          receiptDocumentId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          inputHash,
          status: 'PREPARED',
          fileCount: sources.length,
          totalBytes: BigInt(
            sources.reduce((sum, source) => sum + source.sizeBytes, 0),
          ),
        },
      });
      for (const [index, source] of sources.entries()) {
        const attachmentId = attachmentIds[index]!;
        await tx.transactionAttachment.create({
          data: {
            id: attachmentId,
            companyId: input.companyId,
            transactionId: input.transactionId,
            blobId: source.blobId,
            originalFilename: source.filename,
            contentType: source.contentType,
            sizeBytes: BigInt(source.sizeBytes),
            sha256: source.sha256,
            sourceKind: source.sourceKind,
            retainLocally: source.retainLocally,
            status: 'STAGED',
            recatMarker: randomUUID(),
          },
        });
        await tx.attachmentOperationFile.create({
          data: {
            operationId,
            attachmentId,
            ordinal: index,
            status: 'STAGED',
          },
        });
        if (source.stagedId !== null) {
          await tx.stagedAttachment.delete({
            where: { id: source.stagedId },
          });
        }
      }
    });
  } catch (error) {
    const raced = await loadIdempotentOperation(db, {
      actorKey: input.actor.actorKey,
      companyId: input.companyId,
      transactionId: input.transactionId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!raced) throw error;
    assertSameAttachRequest(raced, requestHash);
    assertSameHash(raced, replayHash(input, sources, raced));
    return operationDto(raced);
  }
  return dispatchAttach(input.actor, operationId, deps);
}

export async function getAttachmentOperation(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  const row = await loadOperation(dbOf(deps), operationId);
  authorize(actor, row.companyId, 'viewer');
  return operationDto(row);
}

async function loadScopedOperation(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  operationId: string,
  minimum: 'viewer' | 'categorizer',
  deps?: AttachmentOperationDependencies,
): Promise<OperationRow> {
  authorize(actor, companyId, minimum);
  const row = await loadOperation(dbOf(deps), operationId);
  if (row.companyId !== companyId || row.transactionId !== transactionId) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment operation was not found.',
    );
  }
  return row;
}

export async function getScopedAttachmentOperation(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  return operationDto(await loadScopedOperation(
    actor,
    companyId,
    transactionId,
    operationId,
    'viewer',
    deps,
  ));
}

export async function retryScopedAttachmentOperation(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  await loadScopedOperation(
    actor,
    companyId,
    transactionId,
    operationId,
    'categorizer',
    deps,
  );
  return retryAttachmentOperation(actor, operationId, deps);
}

export async function reconcileScopedAttachmentOperation(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  await loadScopedOperation(
    actor,
    companyId,
    transactionId,
    operationId,
    'categorizer',
    deps,
  );
  return reconcileAttachmentOperation(actor, operationId, deps);
}

async function claimDelete(
  db: PrismaClient,
  operationId: string,
): Promise<OperationRow> {
  const initial = await loadOperation(db, operationId);
  const attachmentId = initial.files[0]?.attachmentId;
  if (!attachmentId) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment was not found.',
    );
  }
  await db.$transaction(async (transaction) => {
    const claimed = await transaction.attachmentOperation.updateMany({
      where: {
        id: operationId,
        status: { in: ['PREPARED', 'FAILED', 'PARTIAL'] },
      },
      data: { status: 'DELETING', errorCode: null },
    });
    const claimedFile = await transaction.attachmentOperationFile.updateMany({
      where: {
        operationId,
        attachmentId,
        status: { in: ['STAGED', 'FAILED', 'QBO_MISSING'] },
      },
      data: { status: 'DELETING', errorCode: null },
    });
    const claimedAttachment = await transaction.transactionAttachment.updateMany({
      where: {
        id: attachmentId,
        status: { in: ['ATTACHED', 'FAILED', 'QBO_MISSING'] },
      },
      data: { status: 'DELETING', errorCode: null },
    });
    if (
      claimed.count !== 1
      || claimedFile.count !== 1
      || claimedAttachment.count !== 1
    ) {
      throw new AttachmentError(
        'ATTACHMENT_BUSY',
        'Attachment deletion is already in progress.',
        true,
      );
    }
  });
  return loadOperation(db, operationId);
}

async function finalizeProviderDelete(
  db: PrismaClient,
  row: OperationRow,
  file: OperationRow['files'][number],
): Promise<void> {
  await db.$transaction(async (transaction) => {
    await transaction.attachmentOperationFile.update({
      where: {
        operationId_attachmentId: {
          operationId: row.id,
          attachmentId: file.attachmentId,
        },
      },
      data: { status: 'DELETED', errorCode: null },
    });
    await transaction.transactionAttachment.update({
      where: { id: file.attachmentId },
      data: {
        status: 'DELETED',
        blobId: null,
        retainLocally: false,
        errorCode: null,
      },
    });
    await transaction.attachmentOperation.update({
      where: { id: row.id },
      data: { status: 'DELETED', errorCode: null },
    });
    if (file.attachment.blobId !== null) {
      await transaction.attachmentBlob.deleteMany({
        where: {
          id: file.attachment.blobId,
          stagedFiles: { none: {} },
          attachments: { none: {} },
          receiptDocuments: { none: {} },
        },
      });
    }
  });
}

async function completeProviderDelete(
  actor: AttachmentActor,
  row: OperationRow,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  const db = dbOf(deps);
  const file = row.files[0];
  if (!file) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment was not found.',
    );
  }
  await finalizeProviderDelete(db, row, file);
  const complete = await loadOperation(db, row.id);
  await auditOperation(db, actor, complete, 'attachment_deleted_everywhere');
  return operationDto(complete);
}

async function dispatchDelete(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
  preclaimed = false,
): Promise<AttachmentOperationDto> {
  const db = dbOf(deps);
  let row = preclaimed
    ? await loadOperation(db, operationId)
    : await claimDelete(db, operationId);
  const file = row.files[0];
  if (!file) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment was not found.',
    );
  }
  if (row.kind === 'DELETE_LOCAL') {
    await (deps?.releaseBlob
      ?? ((attachmentId: string) =>
        releaseAttachmentBlob(attachmentId, { db })))(file.attachmentId);
    await db.$transaction([
      db.attachmentOperationFile.update({
        where: {
          operationId_attachmentId: {
            operationId,
            attachmentId: file.attachmentId,
          },
        },
        data: { status: 'DELETED', errorCode: null },
      }),
      db.transactionAttachment.update({
        where: { id: file.attachmentId },
        data: {
          status: file.attachment.qboAttachableId === null
            ? 'QBO_MISSING'
            : 'ATTACHED',
          errorCode: null,
        },
      }),
      db.attachmentOperation.update({
        where: { id: operationId },
        data: { status: 'DELETED', errorCode: null },
      }),
    ]);
    row = await loadOperation(db, operationId);
    await auditOperation(
      db,
      actor,
      row,
      'attachment_local_copy_deleted',
    );
    return operationDto(row);
  }
  if (row.kind !== 'DELETE_EVERYWHERE') {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment deletion kind is invalid.',
    );
  }
  try {
    if (file.attachment.qboAttachableId === null) {
      return completeProviderDelete(actor, row, deps);
    }
    const qbo = await qboOf(row.companyId, deps);
    const current = await qbo.getAttachment(file.attachment.qboAttachableId);
    if (current !== null) {
      await qbo.deleteAttachment({
        id: current.id,
        syncToken: current.syncToken,
        requestId: row.id,
      });
    }
    const verifiedAbsent =
      await qbo.getAttachment(file.attachment.qboAttachableId) === null;
    if (!verifiedAbsent) {
      throw new QboRequestTimeout(
        'QuickBooks attachment deletion was not verified.',
      );
    }
    return completeProviderDelete(actor, row, deps);
  } catch (error) {
    const uncertain = error instanceof QboRequestTimeout;
    await db.$transaction([
      db.attachmentOperationFile.update({
        where: {
          operationId_attachmentId: {
            operationId,
            attachmentId: file.attachmentId,
          },
        },
        data: {
          status: uncertain ? 'UNCERTAIN' : 'FAILED',
          errorCode: storedErrorCode(error),
        },
      }),
      db.transactionAttachment.update({
        where: { id: file.attachmentId },
        data: {
          status: uncertain ? 'UNCERTAIN' : 'ATTACHED',
          errorCode: storedErrorCode(error),
        },
      }),
    ]);
    const failed = await updateAggregate(db, operationId);
    await auditOperation(db, actor, failed, 'attachment_error');
    if (!uncertain) throw error;
    return operationDto(failed);
  }
}

export async function retryAttachmentOperation(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  const row = await loadOperation(dbOf(deps), operationId);
  authorize(actor, row.companyId, 'categorizer');
  requireGenericAttachmentOperation(row);
  if (row.files.some((file) => file.status === 'UNCERTAIN')) {
    throw new AttachmentError(
      'ATTACHMENT_PROVIDER_UNCERTAIN',
      'Reconcile the attachment operation before retrying.',
      true,
    );
  }
  return row.kind === 'ATTACH'
    ? dispatchAttach(actor, operationId, deps)
    : dispatchDelete(actor, operationId, deps);
}

export async function reconcileAttachmentOperation(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  return reconcileLoadedAttachmentOperation(actor, operationId, deps, false);
}

export async function reconcileReceiptAttachmentOperation(
  actor: AttachmentActor,
  operationId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  return reconcileLoadedAttachmentOperation(actor, operationId, deps, true);
}

async function reconcileLoadedAttachmentOperation(
  actor: AttachmentActor,
  operationId: string,
  deps: AttachmentOperationDependencies | undefined,
  receiptManaged: boolean,
): Promise<AttachmentOperationDto> {
  const db = dbOf(deps);
  let row = await loadOperation(db, operationId);
  authorize(actor, row.companyId, 'categorizer');
  if (receiptManaged !== isReceiptManagedOperation(row)) {
    if (!receiptManaged) requireGenericAttachmentOperation(row);
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Receipt attachment operation was not found.',
    );
  }
  const uncertain = row.files.filter((file) => file.status === 'UNCERTAIN');
  if (uncertain.length === 0) return operationDto(row);
  await db.$transaction(async (transaction) => {
    const claimed = await transaction.attachmentOperation.updateMany({
      where: { id: operationId, status: 'UNCERTAIN' },
      data: { status: 'COMMITTING' },
    });
    const claimedFiles = await transaction.attachmentOperationFile.updateMany({
      where: {
        operationId,
        attachmentId: {
          in: uncertain.map((file) => file.attachmentId),
        },
        status: 'UNCERTAIN',
      },
      data: { status: 'RECONCILING' },
    });
    if (claimed.count !== 1 || claimedFiles.count !== uncertain.length) {
      throw new AttachmentError(
        'ATTACHMENT_BUSY',
        'Attachment reconciliation is already in progress.',
        true,
      );
    }
  });
  try {
    const qbo = await qboOf(row.companyId, deps);
    if (row.kind === 'DELETE_EVERYWHERE') {
      for (const file of uncertain) {
        const qboId = file.attachment.qboAttachableId;
        const current = qboId === null ? null : await qbo.getAttachment(qboId);
        if (current === null) {
          await finalizeProviderDelete(db, row, file);
        } else {
          await db.$transaction([
            db.attachmentOperationFile.update({
              where: {
                operationId_attachmentId: {
                  operationId,
                  attachmentId: file.attachmentId,
                },
              },
              data: {
                status: 'FAILED',
                errorCode: 'ATTACHMENT_PROVIDER_FAILED',
              },
            }),
            db.transactionAttachment.update({
              where: { id: file.attachmentId },
              data: {
                status: 'ATTACHED',
                qboSyncToken: current.syncToken,
                errorCode: 'ATTACHMENT_PROVIDER_FAILED',
              },
            }),
          ]);
        }
      }
    } else {
      const ref: QboAttachmentRef = {
        qboType: row.transaction.qboType as QboAttachmentRef['qboType'],
        qboId: row.transaction.qboId,
      };
      const providerRows = await qbo.listAttachments(ref);
      for (const file of uncertain) {
        const matches = findExactMarkerMatches(
          providerRows,
          file.attachment.recatMarker,
        );
        if (matches.length === 1) {
          const match = matches[0]!;
          await db.$transaction(async (transaction) => {
            await transaction.attachmentOperationFile.update({
              where: {
                operationId_attachmentId: {
                  operationId,
                  attachmentId: file.attachmentId,
                },
              },
              data: { status: 'ATTACHED', errorCode: null },
            });
            await transaction.transactionAttachment.update({
              where: { id: file.attachmentId },
              data: {
                status: 'ATTACHED',
                qboAttachableId: match.id,
                qboSyncToken: match.syncToken,
                errorCode: null,
                ...(!file.attachment.retainLocally
                  ? { blobId: null, retainLocally: false }
                  : {}),
              },
            });
            if (
              !file.attachment.retainLocally
              && file.attachment.blobId !== null
            ) {
              await transaction.attachmentBlob.deleteMany({
                where: {
                  id: file.attachment.blobId,
                  stagedFiles: { none: {} },
                  attachments: { none: {} },
                  receiptDocuments: { none: {} },
                },
              });
            }
          });
        } else {
          const stillUncertain = matches.length > 1;
          const errorCode = stillUncertain
            ? 'ATTACHMENT_PROVIDER_AMBIGUOUS'
            : 'ATTACHMENT_PROVIDER_NOT_FOUND';
          await db.$transaction([
            db.attachmentOperationFile.update({
              where: {
                operationId_attachmentId: {
                  operationId,
                  attachmentId: file.attachmentId,
                },
              },
              data: {
                status: stillUncertain ? 'UNCERTAIN' : 'FAILED',
                errorCode,
              },
            }),
            db.transactionAttachment.update({
              where: { id: file.attachmentId },
              data: {
                status: stillUncertain ? 'UNCERTAIN' : 'FAILED',
                errorCode,
              },
            }),
          ]);
        }
      }
    }
  } catch {
    await db.$transaction([
      db.attachmentOperationFile.updateMany({
        where: { operationId, status: 'RECONCILING' },
        data: {
          status: 'UNCERTAIN',
          errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
        },
      }),
      db.attachmentOperation.update({
        where: { id: operationId },
        data: {
          status: 'UNCERTAIN',
          errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
        },
      }),
    ]);
    row = await loadOperation(db, operationId);
    await auditOperation(db, actor, row, 'attachment_error');
    return operationDto(row);
  }
  row = await updateAggregate(db, operationId);
  await auditOperation(db, actor, row, 'attachment_reconciled');
  return operationDto(row);
}

function systemAttachmentActor(): AttachmentActor {
  return {
    kind: 'system',
    actorKey: 'system:attachment-recovery',
    userId: null,
    isInstanceAdmin: true,
    memberships: [],
  };
}

export async function recoverStuckAttachmentOperations(
  input: { now?: Date; limit?: number } = {},
  deps?: AttachmentOperationDependencies,
): Promise<{ inspected: number; recovered: number }> {
  const db = dbOf(deps);
  const now = input.now ?? nowOf(deps);
  const limit = input.limit ?? STUCK_OPERATION_LIMIT;
  if (
    !(now instanceof Date)
    || !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > STUCK_OPERATION_LIMIT
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment recovery input is invalid.',
    );
  }
  const cutoff = new Date(now.getTime() - STUCK_OPERATION_AGE_MS);
  const candidates = await db.attachmentOperation.findMany({
    where: {
      receiptDocumentId: null,
      status: { in: ['PREPARED', 'COMMITTING', 'DELETING'] },
      updatedAt: { lte: cutoff },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  });
  let recovered = 0;
  const actor = systemAttachmentActor();
  for (const candidate of candidates) {
    try {
      let row = await loadOperation(db, candidate.id);
      if (row.status === 'COMMITTING') {
        const activeIds = row.files
          .filter((file) =>
            file.status === 'UPLOADING' || file.status === 'RECONCILING')
          .map((file) => file.attachmentId);
        for (const file of row.files) {
          if (
            file.status === 'ATTACHED'
            && !file.attachment.retainLocally
            && file.attachment.blobId !== null
          ) {
            await (deps?.releaseBlob
              ?? ((attachmentId: string) =>
                releaseAttachmentBlob(attachmentId, { db })))(
              file.attachmentId,
            );
          }
        }
        if (activeIds.length > 0) {
          await db.$transaction([
            db.attachmentOperationFile.updateMany({
              where: {
                operationId: row.id,
                attachmentId: { in: activeIds },
                status: { in: ['UPLOADING', 'RECONCILING'] },
              },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
            db.transactionAttachment.updateMany({
              where: {
                id: { in: activeIds },
                status: { in: ['UPLOADING', 'UNCERTAIN'] },
              },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
            db.attachmentOperation.updateMany({
              where: { id: row.id, status: 'COMMITTING' },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
          ]);
          await reconcileAttachmentOperation(actor, row.id, deps);
        } else {
          row = await updateAggregate(db, row.id);
          if (
            row.status === 'PREPARED'
            || row.status === 'PARTIAL'
            || row.status === 'FAILED'
          ) {
            await dispatchAttach(actor, row.id, deps);
          }
        }
      } else if (row.status === 'DELETING') {
        const file = row.files[0];
        if (!file) continue;
        if (row.kind === 'DELETE_LOCAL') {
          await db.$transaction([
            db.attachmentOperationFile.updateMany({
              where: {
                operationId: row.id,
                attachmentId: file.attachmentId,
                status: 'DELETING',
              },
              data: { status: 'STAGED', errorCode: null },
            }),
            db.transactionAttachment.updateMany({
              where: { id: file.attachmentId, status: 'DELETING' },
              data: {
                status: file.attachment.qboAttachableId === null
                  ? 'QBO_MISSING'
                  : 'ATTACHED',
                errorCode: null,
              },
            }),
            db.attachmentOperation.updateMany({
              where: { id: row.id, status: 'DELETING' },
              data: { status: 'PREPARED', errorCode: null },
            }),
          ]);
          await dispatchDelete(actor, row.id, deps);
        } else {
          await db.$transaction([
            db.attachmentOperationFile.updateMany({
              where: {
                operationId: row.id,
                attachmentId: file.attachmentId,
                status: 'DELETING',
              },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
            db.transactionAttachment.updateMany({
              where: { id: file.attachmentId, status: 'DELETING' },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
            db.attachmentOperation.updateMany({
              where: { id: row.id, status: 'DELETING' },
              data: {
                status: 'UNCERTAIN',
                errorCode: 'ATTACHMENT_PROVIDER_UNCERTAIN',
              },
            }),
          ]);
          await reconcileAttachmentOperation(actor, row.id, deps);
        }
      } else {
        await (row.kind === 'ATTACH'
          ? dispatchAttach(actor, row.id, deps)
          : dispatchDelete(actor, row.id, deps));
      }
      recovered += 1;
    } catch {
      // Each operation is independent; leave any still-ambiguous row for the
      // next bounded pass without logging receipt metadata.
    }
  }
  return { inspected: candidates.length, recovered };
}

export async function deleteTransactionAttachment(
  input: DeleteAttachmentInput,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentOperationDto> {
  validateScope({
    actor: input.actor,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
  });
  const receiptDocumentId = input.receiptDocumentId ?? null;
  if (
    receiptDocumentId === null
    && usesReservedReceiptKey(input.idempotencyKey)
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'The receipt attachment idempotency namespace is reserved.',
    );
  }
  authorize(input.actor, input.companyId, 'categorizer');
  const db = dbOf(deps);
  const inputHash = deletionOperationHash(input);
  const existing = await loadIdempotentOperation(db, {
    actorKey: input.actor.actorKey,
    companyId: input.companyId,
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    assertSameHash(existing, inputHash);
    return operationDto(existing);
  }
  const attachment = await db.transactionAttachment.findFirst({
    where: {
      id: input.attachmentId,
      companyId: input.companyId,
      transactionId: input.transactionId,
    },
    include: {
      transaction: {
        select: {
          id: true,
          qboType: true,
        },
      },
    },
  });
  if (!attachment || !isSupportedQboType(attachment.transaction.qboType)) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Attachment was not found.',
    );
  }
  if (receiptDocumentId !== null) {
    const receipt = await db.receiptDocument.findFirst({
      where: {
        id: receiptDocumentId,
        companyId: input.companyId,
        matchedTransactionId: input.transactionId,
        transactionAttachmentId: input.attachmentId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!receipt) {
      throw new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'Receipt attachment operation was not found.',
      );
    }
  }
  const operationId = randomUUID();
  const kind: AttachmentOperationKind = input.scope === 'local'
    ? 'DELETE_LOCAL'
    : 'DELETE_EVERYWHERE';
  try {
    await db.$transaction(async (transaction) => {
      const reserved = await transaction.transactionAttachment.updateMany({
        where: {
          id: attachment.id,
          status: { in: ['ATTACHED', 'FAILED', 'QBO_MISSING'] },
        },
        data: { status: 'DELETING', errorCode: null },
      });
      if (reserved.count !== 1) {
        throw new AttachmentError(
          'ATTACHMENT_BUSY',
          'Attachment is already changing.',
          true,
        );
      }
      await transaction.attachmentOperation.create({
        data: {
          id: operationId,
          kind,
          actorKey: input.actor.actorKey,
          companyId: input.companyId,
          transactionId: input.transactionId,
          receiptDocumentId,
          idempotencyKey: input.idempotencyKey,
          requestHash: inputHash,
          inputHash,
          status: 'DELETING',
          fileCount: 1,
          totalBytes: attachment.sizeBytes,
          files: {
            create: {
              attachmentId: attachment.id,
              ordinal: 0,
              status: 'DELETING',
            },
          },
        },
      });
    });
  } catch (error) {
    const raced = await loadIdempotentOperation(db, {
      actorKey: input.actor.actorKey,
      companyId: input.companyId,
      transactionId: input.transactionId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!raced) throw error;
    assertSameHash(raced, inputHash);
    return operationDto(raced);
  }
  return dispatchDelete(input.actor, operationId, deps, true);
}

export async function listTransactionAttachments(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentDto[]> {
  authorize(actor, companyId, 'viewer');
  const db = dbOf(deps);
  const transaction = await db.transaction.findFirst({
    where: { id: transactionId, companyId },
    select: { id: true },
  });
  if (!transaction) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Transaction was not found.',
    );
  }
  const rows = await db.transactionAttachment.findMany({
    where: { companyId, transactionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return rows.map((row) => attachmentDto(row));
}

const REFRESH_MUTABLE_STATUSES: readonly StoredAttachmentStatus[] = [
  'ATTACHED',
  'FAILED',
  'QBO_MISSING',
];

function externalMetadataHash(companyId: string, qboAttachableId: string): string {
  return createHash('sha256')
    .update(`qbo-external\0${companyId}\0${qboAttachableId}`, 'utf8')
    .digest('hex');
}

function validProviderMetadata(row: {
  id: string;
  syncToken: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): {
  id: string;
  syncToken: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
} | null {
  if (
    row.id.trim() === ''
    || Buffer.byteLength(row.id, 'utf8') > 128
    || row.syncToken.trim() === ''
    || Buffer.byteLength(row.syncToken, 'utf8') > 64
    || row.contentType.trim() === ''
    || Buffer.byteLength(row.contentType, 'utf8') > 120
    || !Number.isSafeInteger(row.sizeBytes)
    || row.sizeBytes < 0
    || row.sizeBytes > QBO_MAX_UPLOAD_REQUEST_BYTES
  ) {
    return null;
  }
  try {
    return {
      id: row.id,
      syncToken: row.syncToken,
      filename: normalizeAttachmentFilename(row.filename),
      contentType: row.contentType.trim(),
      sizeBytes: row.sizeBytes,
    };
  } catch {
    return null;
  }
}

export async function refreshTransactionAttachments(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentDto[]> {
  authorize(actor, companyId, 'viewer');
  const db = dbOf(deps);
  const transaction = await db.transaction.findFirst({
    where: { id: transactionId, companyId },
    select: { qboId: true, qboType: true },
  });
  if (!transaction || !isSupportedQboType(transaction.qboType)) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'Transaction was not found.',
    );
  }
  const providerRows = await (await qboOf(companyId, deps)).listAttachments({
    qboType: transaction.qboType,
    qboId: transaction.qboId,
  });
  const localRows = await db.transactionAttachment.findMany({
    where: { companyId, transactionId },
  });
  const seenIds = new Set<string>();

  for (const providerRow of providerRows) {
    const metadata = validProviderMetadata(providerRow);
    if (!metadata) continue;
    seenIds.add(metadata.id);
    const existing = localRows.find((local) =>
      local.qboAttachableId === metadata.id
      || findExactMarkerMatches([providerRow], local.recatMarker).length === 1);
    if (existing) {
      if (!REFRESH_MUTABLE_STATUSES.includes(existing.status)) continue;
      await db.transactionAttachment.updateMany({
        where: {
          id: existing.id,
          status: { in: [...REFRESH_MUTABLE_STATUSES] },
        },
        data: {
          qboAttachableId: metadata.id,
          qboSyncToken: metadata.syncToken,
          ...(existing.blobId === null
            ? {
                originalFilename: metadata.filename,
                contentType: metadata.contentType,
                sizeBytes: BigInt(metadata.sizeBytes),
              }
            : {}),
          status: 'ATTACHED',
          errorCode: null,
        },
      });
      continue;
    }
    try {
      await db.transactionAttachment.create({
        data: {
          companyId,
          transactionId,
          blobId: null,
          originalFilename: metadata.filename,
          contentType: metadata.contentType,
          sizeBytes: BigInt(metadata.sizeBytes),
          sha256: externalMetadataHash(companyId, metadata.id),
          sourceKind: 'QBO_EXTERNAL',
          retainLocally: false,
          status: 'ATTACHED',
          qboAttachableId: metadata.id,
          qboSyncToken: metadata.syncToken,
          recatMarker: randomUUID(),
        },
      });
    } catch (error) {
      // A concurrent refresh may win the provider-ID uniqueness race.
      if (
        typeof error !== 'object'
        || error === null
        || !('code' in error)
        || error.code !== 'P2002'
      ) {
        throw error;
      }
    }
  }

  const knownProviderIds = localRows
    .filter((row) =>
      row.qboAttachableId !== null
      && REFRESH_MUTABLE_STATUSES.includes(row.status)
      && !seenIds.has(row.qboAttachableId))
    .map((row) => row.id);
  if (knownProviderIds.length > 0) {
    await db.transactionAttachment.updateMany({
      where: {
        id: { in: knownProviderIds },
        status: { in: [...REFRESH_MUTABLE_STATUSES] },
      },
      data: {
        status: 'QBO_MISSING',
        errorCode: 'ATTACHMENT_PROVIDER_NOT_FOUND',
      },
    });
  }
  return listTransactionAttachments(actor, companyId, transactionId, deps);
}

export async function saveExternalAttachmentLocally(
  actor: AttachmentActor,
  companyId: string,
  transactionId: string,
  attachmentId: string,
  deps?: AttachmentOperationDependencies,
): Promise<AttachmentDto> {
  authorize(actor, companyId, 'categorizer');
  const db = dbOf(deps);
  const attachment = await db.transactionAttachment.findFirst({
    where: {
      id: attachmentId,
      companyId,
      transactionId,
      sourceKind: 'QBO_EXTERNAL',
      status: { not: 'DELETED' },
    },
  });
  if (!attachment || attachment.qboAttachableId === null) {
    throw new AttachmentError(
      'ATTACHMENT_NOT_FOUND',
      'QuickBooks attachment was not found.',
    );
  }
  if (attachment.blobId !== null) return attachmentDto(attachment);
  if (!REFRESH_MUTABLE_STATUSES.includes(attachment.status)) {
    throw new AttachmentError(
      'ATTACHMENT_BUSY',
      'Attachment content is changing.',
      true,
    );
  }
  const download = await (
    await qboOf(companyId, deps)
  ).openAttachmentDownload(attachment.qboAttachableId);
  const staged = await stageAttachment({
    companyId,
    actorKey: actor.actorKey,
    sourceKind: 'LOCAL_UPLOAD',
    retainLocally: true,
    filename: attachment.originalFilename,
    declaredContentType: download.contentType,
    content: download.body,
    expiresAt: new Date(nowOf(deps).getTime() + STAGING_TTL_MS),
  }, { db, now: deps?.now });

  const result = await db.$transaction(async (transaction) => {
    const fresh = await transaction.transactionAttachment.findFirst({
      where: {
        id: attachmentId,
        companyId,
        transactionId,
      },
    });
    const stagedRow = await transaction.stagedAttachment.findUnique({
      where: { id: staged.id },
    });
    if (!fresh || !stagedRow) {
      throw new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'Attachment content was not found.',
      );
    }
    if (
      fresh.blobId !== null
      || fresh.qboAttachableId !== attachment.qboAttachableId
      || !REFRESH_MUTABLE_STATUSES.includes(fresh.status)
    ) {
      await transaction.stagedAttachment.delete({ where: { id: staged.id } });
      return fresh.blobId !== null
        ? { kind: 'saved' as const, row: fresh }
        : { kind: 'busy' as const };
    }
    const row = await transaction.transactionAttachment.update({
      where: { id: attachmentId },
      data: {
        blobId: stagedRow.blobId,
        originalFilename: staged.filename,
        contentType: staged.contentType,
        sizeBytes: BigInt(staged.sizeBytes),
        sha256: staged.sha256,
        retainLocally: true,
      },
    });
    await transaction.stagedAttachment.delete({ where: { id: staged.id } });
    return { kind: 'saved' as const, row };
  });
  await collectUnreferencedBlobs(1, { db }).catch(() => undefined);
  if (result.kind === 'busy') {
    throw new AttachmentError(
      'ATTACHMENT_BUSY',
      'Attachment content changed while it was downloading.',
      true,
    );
  }
  return attachmentDto(result.row);
}
