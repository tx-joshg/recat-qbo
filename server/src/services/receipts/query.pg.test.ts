import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../lib/db.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  batchReceiptState,
  getReceiptDuplicateGroups,
  getReceiptDetail,
  listReceipts,
  receiptStats,
  updateReceipt,
  type ReceiptQuery,
} from './query.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

const DEFAULT_QUERY: ReceiptQuery = {
  statuses: [],
  documentTypes: [],
  dateFrom: null,
  dateTo: null,
  sourceKinds: [],
  missingInfo: false,
  duplicate: false,
  matched: null,
  search: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
  page: 1,
  pageSize: 50,
};

describePostgres('receipt library queries', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
    const users = [...userIds];
    userIds.clear();
    if (users.length > 0) {
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createSearchableReceipt(
    companyId: string,
    sha: string,
    vendorName: string,
  ) {
    const blob = await db.attachmentBlob.create({
      data: {
        companyId,
        state: 'READY',
        sha256: sha,
        sizeBytes: 4n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId,
        blobId: blob.id,
        originalFilename: 'synthetic.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: sha,
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        retainLocally: true,
        jobs: {
          create: {
            companyId,
            generation: 1,
            configVersion: 'c'.repeat(64),
            status: 'completed',
            dueAt: new Date(),
          },
        },
      },
    });
    const job = await db.receiptProcessingJob.findUniqueOrThrow({
      where: {
        documentId_generation: { documentId: receipt.id, generation: 1 },
      },
    });
    await db.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: receipt.id,
        generation: 1,
        attemptCount: 1,
        status: 'succeeded',
        vendorName,
        totalAmount: '12.3400',
        currency: 'USD',
        model: 'synthetic/model',
        promptVersion: 'synthetic-v1',
        schemaVersion: 'synthetic-v1',
        completedAt: new Date(),
      },
    });
    return receipt;
  }

  it('uses the search vector without leaking another company', async () => {
    const first = await db.company.create({
      data: {
        realmId: `receipt-query-${randomUUID()}`,
        legalName: 'Synthetic Query One',
        nickname: 'Query One',
      },
    });
    const second = await db.company.create({
      data: {
        realmId: `receipt-query-${randomUUID()}`,
        legalName: 'Synthetic Query Two',
        nickname: 'Query Two',
      },
    });
    companyIds.add(first.id);
    companyIds.add(second.id);
    const expected = await createSearchableReceipt(
      first.id,
      'd'.repeat(64),
      'Invented Aurora Supplies',
    );
    await createSearchableReceipt(
      second.id,
      'e'.repeat(64),
      'Invented Aurora Supplies',
    );

    for (const search of [
      'Aurora',
      'synthetic.png',
      expected.id,
      '12.34',
    ]) {
      const result = await listReceipts(first.id, {
        ...DEFAULT_QUERY,
        search,
      });

      expect(result.total, search).toBe(1);
      expect(result.receipts.map((receipt) => receipt.id), search)
        .toEqual([expected.id]);
      expect(result.receipts[0]?.currentExtraction?.totalAmount, search)
        .toBe('12.34');
    }
  });

  it('treats filename wildcard characters as literal search text', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-wildcard-${randomUUID()}`,
        legalName: 'Synthetic Wildcard Company',
        nickname: 'Wildcard',
      },
    });
    companyIds.add(company.id);
    const expected = await createSearchableReceipt(
      company.id,
      'a'.repeat(64),
      'Invented Literal Vendor',
    );
    await db.receiptDocument.update({
      where: { id: expected.id },
      data: { originalFilename: 'literal%_receipt.png' },
    });
    await createSearchableReceipt(
      company.id,
      'b'.repeat(64),
      'Invented Ordinary Vendor',
    );

    const result = await listReceipts(company.id, {
      ...DEFAULT_QUERY,
      search: '%_',
    });

    expect(result.receipts.map((receipt) => receipt.id)).toEqual([expected.id]);
  });

  it('bounds append-only attempts and events in receipt detail', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-detail-${randomUUID()}`,
        legalName: 'Synthetic Detail Company',
        nickname: 'Detail',
      },
    });
    companyIds.add(company.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256: 'f'.repeat(64),
        sizeBytes: 4n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: company.id,
        blobId: blob.id,
        originalFilename: 'bounded.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: 'f'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        generation: 30,
      },
    });
    for (let generation = 1; generation <= 30; generation += 1) {
      const job = await db.receiptProcessingJob.create({
        data: {
          documentId: receipt.id,
          companyId: company.id,
          generation,
          configVersion: 'f'.repeat(64),
          status: 'completed',
          dueAt: new Date(),
        },
      });
      await db.receiptExtractionAttempt.create({
        data: {
          jobId: job.id,
          documentId: receipt.id,
          generation,
          attemptCount: 1,
          status: 'succeeded',
          model: 'synthetic/model',
          promptVersion: 'synthetic-v1',
          schemaVersion: 'synthetic-v1',
          completedAt: new Date(),
        },
      });
    }
    await db.receiptEvent.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        companyId: company.id,
        documentId: receipt.id,
        action: `synthetic-${index}`,
      })),
    });

    const detail = await getReceiptDetail(company.id, receipt.id);

    expect(detail.attempts).toHaveLength(25);
    expect(detail.events).toHaveLength(100);
    expect(detail.attempts[0]?.generation).toBe(30);
  });

  it('projects revision-fenced edits without mutating extraction attempts', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-edit-${randomUUID()}`,
        legalName: 'Synthetic Edit Company',
        nickname: 'Edit',
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: { email: `receipt-edit-${randomUUID()}@example.invalid` },
    });
    userIds.add(user.id);
    const receipt = await createSearchableReceipt(
      company.id,
      '1'.repeat(64),
      'Invented Original Vendor',
    );

    await expect(updateReceipt({
      companyId: company.id,
      documentId: receipt.id,
      actorUserId: user.id,
      expectedRevision: receipt.revision - 1,
      patch: { vendorName: 'Invented Edited Vendor' },
    }, { db })).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    const updated = await updateReceipt({
      companyId: company.id,
      documentId: receipt.id,
      actorUserId: user.id,
      expectedRevision: receipt.revision,
      patch: {
        vendorName: 'Invented Edited Vendor',
        vendorTaxId: 'synthetic-tax-id',
        totalAmount: '14.25',
        userNotes: 'Synthetic note',
        approved: true,
      },
    }, { db });

    expect(updated).toMatchObject({
      revision: receipt.revision + 1,
      approved: true,
      userNotes: 'Synthetic note',
      manuallyEdited: true,
      currentExtraction: {
        vendorName: 'Invented Edited Vendor',
        vendorTaxId: 'synthetic-tax-id',
        totalAmount: '14.25',
      },
    });
    const attempt = await db.receiptExtractionAttempt.findFirstOrThrow({
      where: { documentId: receipt.id },
    });
    expect(attempt.vendorName).toBe('Invented Original Vendor');
    expect(attempt.totalAmount?.toString()).toBe('12.34');
    const event = await db.receiptEvent.findFirstOrThrow({
      where: { documentId: receipt.id, action: 'receipt_edited' },
    });
    expect(JSON.stringify(event)).not.toContain('synthetic-tax-id');
    expect(event.after).toMatchObject({
      changedFields: [
        'approved',
        'totalAmount',
        'userNotes',
        'vendorName',
        'vendorTaxId',
      ],
    });
    expect((await listReceipts(company.id, {
      ...DEFAULT_QUERY,
      search: 'Edited',
    })).receipts.map((item) => item.id)).toEqual([receipt.id]);
    expect((await listReceipts(company.id, {
      ...DEFAULT_QUERY,
      search: 'Original',
    })).receipts).toHaveLength(0);
  });

  it('never projects or filters on a successful attempt from an old generation', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-current-generation-${randomUUID()}`,
        legalName: 'Synthetic Current Generation Company',
        nickname: 'Current generation',
      },
    });
    companyIds.add(company.id);
    const receipt = await createSearchableReceipt(
      company.id,
      '8'.repeat(64),
      'Invented Old Generation Vendor',
    );
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: { generation: 2, status: 'QUEUED' },
    });

    const listed = await listReceipts(company.id, DEFAULT_QUERY, { db });
    expect(listed.receipts[0]?.currentExtraction).toBeNull();
    await expect(listReceipts(company.id, {
      ...DEFAULT_QUERY,
      search: 'Old Generation Vendor',
    }, { db })).resolves.toMatchObject({ total: 0, receipts: [] });
    await expect(getReceiptDetail(company.id, receipt.id, { db }))
      .resolves.toMatchObject({ currentExtraction: null, candidates: [] });
  });

  it('invalidates a confirmed match when match-sensitive metadata changes', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-edit-match-${randomUUID()}`,
        legalName: 'Synthetic Match Edit Company',
        nickname: 'Match edit',
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: { email: `receipt-edit-match-${randomUUID()}@example.invalid` },
    });
    userIds.add(user.id);
    const receipt = await createSearchableReceipt(
      company.id,
      '7'.repeat(64),
      'Invented Match Vendor',
    );
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `synthetic-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Invented Match Vendor',
        amount: '-12.34',
        bankAccount: 'Synthetic account',
        revision: 4,
      },
    });
    const attempt = await db.receiptExtractionAttempt.findFirstOrThrow({
      where: { documentId: receipt.id },
    });
    await db.receiptMatchCandidate.create({
      data: {
        documentId: receipt.id,
        extractionAttemptId: attempt.id,
        transactionId: transaction.id,
        transactionRevision: transaction.revision,
        score: 92,
        evidence: {},
        rank: 1,
        state: 'confirmed',
      },
    });
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: transaction.id,
        matchedTransactionRevision: transaction.revision,
        approvedAt: new Date(),
        approvedByUserId: user.id,
      },
    });

    const updated = await updateReceipt({
      companyId: company.id,
      documentId: receipt.id,
      actorUserId: user.id,
      expectedRevision: receipt.revision,
      patch: { totalAmount: '14.25' },
    }, { db });

    expect(updated).toMatchObject({
      status: 'READY',
      matchedTransactionId: null,
      approved: false,
    });
    await expect(db.receiptMatchCandidate.findFirstOrThrow({
      where: { documentId: receipt.id },
    })).resolves.toMatchObject({ state: 'stale' });
  });

  it('rejects every edit while attachment work is in progress', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-edit-attaching-${randomUUID()}`,
        legalName: 'Synthetic Attaching Edit Company',
        nickname: 'Attaching edit',
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: { email: `receipt-edit-attaching-${randomUUID()}@example.invalid` },
    });
    userIds.add(user.id);
    const receipt = await createSearchableReceipt(
      company.id,
      '9'.repeat(64),
      'Invented Attaching Vendor',
    );
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: { status: 'ATTACHING' },
    });

    await expect(updateReceipt({
      companyId: company.id,
      documentId: receipt.id,
      actorUserId: user.id,
      expectedRevision: receipt.revision,
      patch: { userNotes: 'Synthetic note' },
    }, { db })).rejects.toMatchObject({ code: 'RECEIPT_STALE' });
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: receipt.id },
    })).resolves.toMatchObject({ revision: receipt.revision, status: 'ATTACHING' });
  });

  it('returns company-scoped dashboard totals and processing cost', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-stats-${randomUUID()}`,
        legalName: 'Synthetic Stats Company',
        nickname: 'Stats',
      },
    });
    const other = await db.company.create({
      data: {
        realmId: `receipt-stats-other-${randomUUID()}`,
        legalName: 'Synthetic Other Stats Company',
        nickname: 'Other Stats',
      },
    });
    companyIds.add(company.id);
    companyIds.add(other.id);
    const first = await createSearchableReceipt(
      company.id,
      '2'.repeat(64),
      'Invented Stats Vendor',
    );
    await db.receiptExtractionAttempt.updateMany({
      where: { documentId: first.id },
      data: { taxAmount: '2.4000', costUsd: '0.01000000' },
    });
    const second = await createSearchableReceipt(
      company.id,
      '3'.repeat(64),
      'Invented Queue Vendor',
    );
    await db.receiptDocument.update({
      where: { id: second.id },
      data: { status: 'QUEUED' },
    });
    await createSearchableReceipt(
      other.id,
      '4'.repeat(64),
      'Invented Isolated Vendor',
    );

    const stats = await receiptStats(company.id, {
      dateFrom: new Date('2000-01-01T00:00:00Z'),
      dateTo: new Date('2100-01-01T00:00:00Z'),
    }, { db });

    expect(stats).toMatchObject({
      received: 2,
      needsReview: 0,
      queued: 1,
      processing: 0,
      failed: 0,
      totalByCurrency: [{ currency: 'USD', amount: '24.68' }],
      totalByCategory: [{
        category: 'Uncategorized',
        currency: 'USD',
        amount: '24.68',
      }],
      totalTaxByCurrency: [{ currency: 'USD', amount: '2.4' }],
      processingCostUsd: '0.01',
    });
  });

  it('groups duplicate document identities within one company', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-duplicates-${randomUUID()}`,
        legalName: 'Synthetic Duplicate Company',
        nickname: 'Duplicates',
      },
    });
    companyIds.add(company.id);
    const first = await createSearchableReceipt(
      company.id,
      '5'.repeat(64),
      'Invented Duplicate Vendor',
    );
    const second = await createSearchableReceipt(
      company.id,
      '6'.repeat(64),
      'Invented Duplicate Vendor',
    );
    await db.receiptExtractionAttempt.updateMany({
      where: { documentId: { in: [first.id, second.id] } },
      data: {
        vendorReceiptId: 'synthetic-receipt-1',
        receiptDate: new Date('2026-07-01T00:00:00Z'),
      },
    });

    const groups = await getReceiptDuplicateGroups(company.id, { db });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      reason: 'document_identity',
      receipts: [
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ id: expect.any(String) }),
      ],
    });
    expect(groups[0]?.receipts.map((item) => item.id).sort())
      .toEqual([first.id, second.id].sort());
  });

  it('groups by edited metadata and leaves receipts without a twin out', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-duplicates-edited-${randomUUID()}`,
        legalName: 'Synthetic Edited Duplicate Company',
        nickname: 'Edited Duplicates',
      },
    });
    companyIds.add(company.id);
    const first = await createSearchableReceipt(
      company.id,
      'a'.repeat(64),
      'Invented Edited Vendor',
    );
    const second = await createSearchableReceipt(
      company.id,
      'b'.repeat(64),
      'Invented Edited Vendor',
    );
    const unrelated = await createSearchableReceipt(
      company.id,
      'c'.repeat(64),
      'Invented Unrelated Vendor',
    );
    await db.receiptExtractionAttempt.updateMany({
      where: { documentId: { in: [first.id, second.id, unrelated.id] } },
      data: { receiptDate: new Date('2026-07-01T00:00:00Z') },
    });
    await db.receiptExtractionAttempt.updateMany({
      where: { documentId: first.id },
      data: { vendorReceiptId: 'synthetic-edited-1' },
    });
    await db.receiptExtractionAttempt.updateMany({
      where: { documentId: { in: [second.id, unrelated.id] } },
      data: { vendorReceiptId: 'misread-id' },
    });
    // A reviewer corrected the second receipt's number to match the first.
    await db.receiptDocument.update({
      where: { id: second.id },
      data: { currentMetadata: { vendorReceiptId: 'SYNTHETIC-EDITED-1' } },
    });

    const groups = await getReceiptDuplicateGroups(company.id, { db });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.receipts.map((item) => item.id).sort())
      .toEqual([first.id, second.id].sort());
  });

  it('batch approves with one audit event per receipt and rejects stale input', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-batch-${randomUUID()}`,
        legalName: 'Synthetic Batch Company',
        nickname: 'Batch',
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: { email: `receipt-batch-${randomUUID()}@example.invalid` },
    });
    userIds.add(user.id);
    const first = await createSearchableReceipt(
      company.id,
      '7'.repeat(64),
      'Invented Batch One',
    );
    const second = await createSearchableReceipt(
      company.id,
      '8'.repeat(64),
      'Invented Batch Two',
    );

    await expect(batchReceiptState({
      companyId: company.id,
      actorUserId: user.id,
      action: 'approve',
      receipts: [
        { id: first.id, expectedRevision: first.revision },
        { id: second.id, expectedRevision: second.revision + 1 },
      ],
    }, { db })).rejects.toMatchObject({ code: 'RECEIPT_STALE' });
    expect(await db.receiptDocument.count({
      where: { id: { in: [first.id, second.id] }, approvedAt: { not: null } },
    })).toBe(0);

    const result = await batchReceiptState({
      companyId: company.id,
      actorUserId: user.id,
      action: 'approve',
      receipts: [
        { id: first.id, expectedRevision: first.revision },
        { id: second.id, expectedRevision: second.revision },
      ],
    }, { db });

    expect(result).toEqual({ updated: 2 });
    expect(await db.receiptDocument.count({
      where: { id: { in: [first.id, second.id] }, approvedAt: { not: null } },
    })).toBe(2);
    expect(await db.receiptEvent.count({
      where: {
        documentId: { in: [first.id, second.id] },
        action: 'receipt_approved',
      },
    })).toBe(2);
  });
});
