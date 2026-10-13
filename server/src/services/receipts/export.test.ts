import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReceiptCsv,
  csvCell,
  exportReceipts,
} from './export.js';

function exportRow(id: string, blobId: string) {
  return {
    id,
    companyId: 'company-1',
    originalFilename: `${id}.pdf`,
    sizeBytes: 4n,
    generation: 1,
    blobId,
    transactionAttachment: null,
    attempts: [],
    approvedAt: null,
    userNotes: null,
    currentMetadata: {},
  };
}

function exportDb(rows: unknown[]) {
  const updateMany = vi.fn().mockResolvedValue({ count: rows.length });
  const createMany = vi.fn().mockResolvedValue({ count: rows.length });
  return {
    updateMany,
    createMany,
    db: {
      receiptDocument: {
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany,
      },
      receiptEvent: { createMany },
      $transaction: vi.fn(async (callback) => callback({
        receiptDocument: { updateMany },
        receiptEvent: { createMany },
      })),
    } as never,
  };
}

describe('receipt export', () => {
  it('prevents spreadsheet formula injection and uses RFC 4180 quoting', () => {
    expect(csvCell('=HYPERLINK("https://example.invalid")'))
      .toBe(`"'=HYPERLINK(""https://example.invalid"")"`);
    expect(csvCell('+synthetic')).toBe("'+synthetic");
    expect(csvCell('plain')).toBe('plain');
  });

  it('builds deterministic UTF-8 CSV rows', () => {
    const csv = buildReceiptCsv([
      {
        id: 'receipt-b',
        filename: 'synthetic-two.png',
        approved: false,
        currentExtraction: null,
      },
      {
        id: 'receipt-a',
        filename: 'synthetic-one.pdf',
        approved: true,
        currentExtraction: {
          vendorName: 'Invented Vendor',
          receiptDate: '2026-07-30',
          subtotal: '10',
          taxAmount: '1',
          totalAmount: '11',
          currency: 'USD',
          documentType: 'receipt',
          category: 'Synthetic category',
        },
      },
    ]);

    expect(csv).toContain(
      'receipt_id,vendor_name,receipt_date,subtotal,tax_amount,total_amount,currency',
    );
    expect(csv.indexOf('receipt-a')).toBeLessThan(csv.indexOf('receipt-b'));
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('exports originals in stable ID-prefixed order', async () => {
    const rows = [
      {
        id: 'receipt-b',
        companyId: 'company-1',
        originalFilename: 'synthetic two.png',
        sizeBytes: 4n,
        generation: 1,
        blobId: 'blob-b',
        transactionAttachment: null,
        attempts: [],
        approvedAt: null,
        userNotes: null,
        currentMetadata: {},
      },
      {
        id: 'receipt-a',
        companyId: 'company-1',
        originalFilename: 'synthetic one.pdf',
        sizeBytes: 4n,
        generation: 1,
        blobId: 'blob-a',
        transactionAttachment: null,
        attempts: [],
        approvedAt: null,
        userNotes: null,
        currentMetadata: {},
      },
    ];
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const result = await exportReceipts({
      companyId: 'company-1',
      actorUserId: 'user-1',
      documentIds: ['receipt-b', 'receipt-a'],
      now: new Date('2026-07-30T12:00:00Z'),
    }, {
      db: {
        receiptDocument: {
          findMany: vi.fn().mockResolvedValue(rows),
          updateMany,
        },
        receiptEvent: { createMany },
        $transaction: vi.fn(async (callback) => callback({
          receiptDocument: { updateMany },
          receiptEvent: { createMany },
        })),
      } as never,
      openBlob: async (_companyId, blobId) => ({
        blobId,
        contentType: 'application/octet-stream',
        sizeBytes: 4,
        chunks: () => Readable.from([Buffer.from('data')]),
      }),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    await result.completed;
    const zip = Buffer.concat(chunks);
    const csvAt = zip.indexOf('receipts.csv');
    const firstAt = zip.indexOf('files/receipt-a-synthetic-one.pdf');
    const secondAt = zip.indexOf('files/receipt-b-synthetic-two.png');

    expect(result.filename).toBe('recat-receipts-2026-07-30.zip');
    expect(csvAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBeGreaterThan(csvAt);
    expect(secondAt).toBeGreaterThan(firstAt);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: 'company-1',
        id: { in: ['receipt-a', 'receipt-b'] },
      },
    }));
    expect(createMany).toHaveBeenCalled();
  });
  it('fails the stream instead of crashing when one file cannot be opened', async () => {
    const { db, updateMany } = exportDb([
      exportRow('receipt-a', 'blob-a'),
      exportRow('receipt-b', 'blob-missing'),
    ]);
    const result = await exportReceipts({
      companyId: 'company-1',
      actorUserId: 'user-1',
      documentIds: ['receipt-a', 'receipt-b'],
    }, {
      db,
      openBlob: async (_companyId, blobId) => {
        if (blobId === 'blob-missing') throw new Error('blob is gone');
        return {
          blobId,
          contentType: 'application/octet-stream',
          sizeBytes: 4,
          chunks: () => Readable.from([Buffer.from('data')]),
        };
      },
    });

    await expect((async () => {
      for await (const _chunk of result.stream) { /* drain */ }
    })()).rejects.toThrow('blob is gone');
    await expect(result.completed).rejects.toThrow('blob is gone');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('fails the stream when a file errors mid-read', async () => {
    const { db } = exportDb([exportRow('receipt-a', 'blob-a')]);
    const result = await exportReceipts({
      companyId: 'company-1',
      actorUserId: 'user-1',
      documentIds: ['receipt-a'],
    }, {
      db,
      openBlob: async (_companyId, blobId) => ({
        blobId,
        contentType: 'application/octet-stream',
        sizeBytes: 4,
        chunks: async function* () {
          yield Buffer.from('da');
          throw new Error('upstream 503');
        },
      }),
    });

    await expect((async () => {
      for await (const _chunk of result.stream) { /* drain */ }
    })()).rejects.toThrow('upstream 503');
    await expect(result.completed).rejects.toThrow('upstream 503');
  });

  it('does not leave completed as an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { db } = exportDb([exportRow('receipt-a', 'blob-missing')]);
      const result = await exportReceipts({
        companyId: 'company-1',
        actorUserId: 'user-1',
        documentIds: ['receipt-a'],
      }, {
        db,
        openBlob: async () => {
          throw new Error('blob is gone');
        },
      });
      // A caller that stops at the stream error never awaits `completed`.
      await expect((async () => {
        for await (const _chunk of result.stream) { /* drain */ }
      })()).rejects.toThrow('blob is gone');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
  it('releases open file readers when the consumer abandons the stream', async () => {
    const { db, updateMany } = exportDb([exportRow('receipt-a', 'blob-a')]);
    let readerClosed = false;
    const result = await exportReceipts({
      companyId: 'company-1',
      actorUserId: 'user-1',
      documentIds: ['receipt-a'],
    }, {
      db,
      openBlob: async (_companyId, blobId) => ({
        blobId,
        contentType: 'application/octet-stream',
        sizeBytes: 4,
        chunks: async function* () {
          try {
            for (;;) {
              yield Buffer.alloc(64 * 1024);
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          } finally {
            readerClosed = true;
          }
        },
      }),
    });

    for await (const _chunk of result.stream) {
      result.stream.destroy();
      break;
    }
    await expect(result.completed).rejects.toThrow('closed before completion');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readerClosed).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
