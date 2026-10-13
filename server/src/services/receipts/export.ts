import { Readable, Transform } from 'node:stream';
import { ZipArchive } from 'archiver';
import type {
  Prisma,
  PrismaClient,
  TransactionAttachment,
} from '@prisma/client';
import type {
  ReceiptExtractionDto,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import {
  openAttachmentBlob,
} from '../attachments/blobStore.js';
import type {
  AttachmentBlobReader,
} from '../attachments/types.js';
import {
  toReceiptExtractionDto,
} from './intake.js';
import { ReceiptError } from './types.js';

const MAX_EXPORT_RECEIPTS = 500;
const MAX_EXPORT_BYTES = 100_000_000;

const exportInclude = {
  attempts: {
    where: { status: 'succeeded' },
    orderBy: [
      { generation: 'desc' },
      { attemptCount: 'desc' },
      { startedAt: 'desc' },
    ],
    take: 1,
  },
  transactionAttachment: true,
} satisfies Prisma.ReceiptDocumentInclude;

type ExportRow = Prisma.ReceiptDocumentGetPayload<{
  include: typeof exportInclude;
}>;

interface ReceiptCsvSource {
  id: string;
  filename: string;
  approved: boolean;
  currentExtraction: Pick<
    ReceiptExtractionDto,
    | 'vendorName'
    | 'receiptDate'
    | 'subtotal'
    | 'taxAmount'
    | 'totalAmount'
    | 'currency'
    | 'documentType'
    | 'category'
  > | null;
}

export interface ReceiptExportInput {
  companyId: string;
  actorUserId: string;
  documentIds: string[];
  now?: Date;
}

export interface ReceiptExportDeps {
  readonly db?: PrismaClient;
  readonly openBlob?: (
    companyId: string,
    blobId: string,
  ) => Promise<AttachmentBlobReader>;
  readonly openQboFile?: (
    companyId: string,
    attachment: TransactionAttachment,
  ) => Promise<AttachmentBlobReader>;
}

export interface ReceiptExportResult {
  filename: string;
  stream: Readable;
  completed: Promise<void>;
}

function jsonObject(
  value: Prisma.JsonValue,
): Record<string, Prisma.JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function projectedExportDto(row: ExportRow): ReceiptCsvSource {
  const currentAttempt = row.attempts.find((attempt) =>
    attempt.generation === row.generation);
  const currentExtraction = currentAttempt
    ? toReceiptExtractionDto(currentAttempt)
    : null;
  if (currentExtraction === null) {
    return {
      id: row.id,
      filename: row.originalFilename,
      approved: row.approvedAt !== null,
      currentExtraction: null,
    };
  }
  const metadata = jsonObject(row.currentMetadata);
  return {
    id: row.id,
    filename: row.originalFilename,
    approved: row.approvedAt !== null,
    currentExtraction: {
      ...currentExtraction,
      ...metadata,
    } as ReceiptExtractionDto,
  };
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  if (/[",\r\n]/u.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function buildReceiptCsv(receipts: ReceiptCsvSource[]): string {
  const columns = [
    'receipt_id',
    'vendor_name',
    'receipt_date',
    'subtotal',
    'tax_amount',
    'total_amount',
    'currency',
    'document_type',
    'category',
    'approved',
    'filename',
  ];
  const rows = [...receipts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((receipt) => {
      const extraction = receipt.currentExtraction;
      return [
        receipt.id,
        extraction?.vendorName,
        extraction?.receiptDate,
        extraction?.subtotal,
        extraction?.taxAmount,
        extraction?.totalAmount,
        extraction?.currency,
        extraction?.documentType,
        extraction?.category,
        receipt.approved ? 'true' : 'false',
        receipt.filename,
      ].map(csvCell).join(',');
    });
  return `${columns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

function safeArchiveFilename(filename: string): string {
  const normalized = filename
    .normalize('NFKC')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 180);
  return normalized || 'receipt-file';
}

function assertInput(input: ReceiptExportInput): string[] {
  const ids = [...new Set(input.documentIds)].sort();
  if (
    input.companyId.trim() === ''
    || input.actorUserId.trim() === ''
    || ids.length < 1
    || ids.length > MAX_EXPORT_RECEIPTS
    || ids.some((id) => id.trim() === '' || Buffer.byteLength(id) > 120)
  ) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt export selection is invalid.',
    );
  }
  return ids;
}

function byteLimitStream(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new ReceiptError(
          'RECEIPT_INVALID_INPUT',
          'Receipt export exceeds the 100 MB archive limit.',
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function fileReader(
  row: ExportRow,
  deps: ReceiptExportDeps,
): Promise<AttachmentBlobReader> {
  const openBlob = deps.openBlob ?? openAttachmentBlob;
  const localBlobId = row.blobId ?? row.transactionAttachment?.blobId ?? null;
  if (localBlobId !== null) {
    return openBlob(row.companyId, localBlobId);
  }
  if (
    row.transactionAttachment !== null
    && row.transactionAttachment.qboAttachableId !== null
    && deps.openQboFile
  ) {
    return deps.openQboFile(row.companyId, row.transactionAttachment);
  }
  throw new ReceiptError(
    'RECEIPT_NOT_FOUND',
    `Original file is unavailable for receipt ${row.id}.`,
  );
}

function lazyFileStream(
  row: ExportRow,
  deps: ReceiptExportDeps,
): Readable {
  return Readable.from((async function* () {
    const reader = await fileReader(row, deps);
    yield* reader.chunks();
  })());
}

export async function exportReceipts(
  input: ReceiptExportInput,
  deps: ReceiptExportDeps = {},
): Promise<ReceiptExportResult> {
  const ids = assertInput(input);
  const db = deps.db ?? prisma;
  const now = input.now ?? new Date();
  const rows = await db.receiptDocument.findMany({
    where: {
      companyId: input.companyId,
      id: { in: ids },
      deletedAt: null,
    },
    orderBy: { id: 'asc' },
    include: exportInclude,
  });
  if (rows.length !== ids.length) {
    throw new ReceiptError(
      'RECEIPT_NOT_FOUND',
      'One or more selected receipts were not found.',
    );
  }
  const orderedRows = [...rows].sort((left, right) =>
    left.id.localeCompare(right.id));

  const knownBytes = orderedRows.reduce(
    (sum, row) => sum + Number(row.sizeBytes),
    Buffer.byteLength(
      buildReceiptCsv(orderedRows.map(projectedExportDto)),
      'utf8',
    ),
  );
  if (!Number.isSafeInteger(knownBytes) || knownBytes > MAX_EXPORT_BYTES) {
    throw new ReceiptError(
      'RECEIPT_INVALID_INPUT',
      'Receipt export exceeds the 100 MB archive limit.',
    );
  }

  const archive = new ZipArchive({ store: true });
  const output = byteLimitStream(MAX_EXPORT_BYTES);
  archive.pipe(output);
  // archiver never listens for `error` on entry streams, so an unreadable
  // file would otherwise be an unhandled 'error' event that exits the
  // process. Every failure is routed here instead: stop the archive and
  // fail the output stream the caller is reading.
  const fail = (error: unknown): void => {
    if (output.destroyed) return;
    archive.abort();
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  };
  const archiveDone = new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.on('warning', (error: Error) => reject(error));
  });
  archive.once('error', fail);
  archive.on('warning', fail);
  archive.append(buildReceiptCsv(orderedRows.map(projectedExportDto)), {
    name: 'receipts.csv',
    date: new Date(0),
  });
  for (const row of orderedRows) {
    const entry = lazyFileStream(row, deps);
    entry.once('error', fail);
    archive.append(entry, {
      name: `files/${row.id}-${safeArchiveFilename(row.originalFilename)}`,
      date: new Date(0),
    });
  }
  void archive.finalize().catch(fail);

  const completed = archiveDone.then(async () => {
    await db.$transaction(async (transaction) => {
      await transaction.receiptDocument.updateMany({
        where: { companyId: input.companyId, id: { in: ids } },
        data: { lastExportedAt: now },
      });
      await transaction.receiptEvent.createMany({
        data: ids.map((documentId) => ({
          companyId: input.companyId,
          documentId,
          actorUserId: input.actorUserId,
          action: 'receipt_exported',
          after: { exportedAt: now.toISOString() },
        })),
      });
    });
  });
  // A caller that stops at a stream error may never await `completed`;
  // keep that from becoming an unhandled rejection. Awaiting it still
  // rejects.
  completed.catch(() => undefined);

  return {
    filename: `recat-receipts-${now.toISOString().slice(0, 10)}.zip`,
    stream: output,
    completed,
  };
}
