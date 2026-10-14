import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../lib/db.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import type { ReceiptExtractionResult } from './extractorClient.js';
import {
  claimReceiptJobs,
  type ReceiptJobDeps,
} from './jobs.js';
import { persistOwnedSuccess } from './worker.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

function result(confidence = 0.9): ReceiptExtractionResult {
  return {
    schemaVersion: 'recat-receipt-extraction/v1',
    promptVersion: 'receiptory-5afac9f0+recat-tax-components-v1',
    pageCount: 1,
    extraction: {
      receiptDate: '2026-07-30',
      documentTitle: 'Synthetic',
      vendorName: 'Synthetic Vendor',
      vendorTaxId: null,
      vendorReceiptId: null,
      clientName: null,
      clientTaxId: null,
      description: null,
      lineItems: [],
      subtotal: '10',
      taxAmount: '1',
      totalAmount: '11',
      currency: 'USD',
      paymentMethod: null,
      paymentIdentifier: null,
      language: 'en',
      additionalFields: [],
      rawExtractedText: null,
      documentType: 'expense_receipt',
      category: null,
      extractionConfidence: confidence,
      taxComponents: [],
    },
    parseSalvaged: false,
    warnings: [],
    model: 'synthetic/model',
    tokensIn: 1,
    tokensOut: 2,
    costUsd: '0.01',
    durationMs: 3,
  };
}

describePostgres('receipt worker ownership fence on PostgreSQL', () => {
  let db: PrismaClient;
  let second: PrismaClient;
  let locker: PrismaClient;
  let releaseFileLock: () => void;
  let fileLock: Promise<void>;
  const companyIds = new Set<string>();

  beforeAll(async () => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    second = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    locker = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const releasePromise = new Promise<void>((resolve) => {
      releaseFileLock = resolve;
    });
    fileLock = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS "locked"
        FROM pg_advisory_xact_lock(728202606)`;
      acquired();
      await releasePromise;
    }, { maxWait: 120_000, timeout: 120_000 });
    await acquiredPromise;
  }, 130_000);

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    releaseFileLock?.();
    await fileLock;
    await Promise.all([
      db?.$disconnect(),
      second?.$disconnect(),
      locker?.$disconnect(),
    ]);
  }, 130_000);

  function deps(client: PrismaClient): ReceiptJobDeps {
    return { db: client as unknown as ReceiptJobDeps['db'] };
  }

  async function fixture() {
    const company = await db.company.create({
      data: {
        realmId: `receipt-worker-${randomUUID()}`,
        legalName: 'Synthetic Worker Company',
        nickname: 'Synthetic Worker',
      },
    });
    companyIds.add(company.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        sizeBytes: 3n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
        chunks: {
          create: { ordinal: 0, content: Buffer.from([1, 2, 3]) },
        },
      },
    });
    return db.receiptDocument.create({
      data: {
        companyId: company.id,
        blobId: blob.id,
        originalFilename: 'synthetic.png',
        contentType: 'image/png',
        sizeBytes: 3n,
        sha256: blob.sha256!,
        sourceKind: 'WEB_UPLOAD',
        status: 'QUEUED',
        jobs: {
          create: {
            companyId: company.id,
            generation: 1,
            configVersion: 'a'.repeat(64),
            status: 'queued',
            dueAt: new Date(Date.now() - 1_000),
          },
        },
      },
      include: { jobs: true },
    });
  }

  it('persists an immutable attempt and advances a confident receipt', async () => {
    const document = await fixture();
    const job = (await claimReceiptJobs('worker-a', 4, deps(db)))
      .find((job) => job.documentId === document.id);
    expect(await persistOwnedSuccess(job!, result(), 0.8, db)).toBe(true);
    expect(await db.receiptExtractionAttempt.count({
      where: { documentId: document.id },
    })).toBe(1);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { status: true, pageCount: true },
    })).resolves.toEqual({ status: 'READY', pageCount: 1 });
  });

  it('discards a provider result after expiry and reclaim', async () => {
    const document = await fixture();
    const first = (await claimReceiptJobs('worker-a', 4, deps(db)))
      .find((job) => job.documentId === document.id);
    await db.receiptProcessingJob.update({
      where: { id: document.jobs[0]!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const reclaimed = (await claimReceiptJobs('worker-b', 4, deps(second)))
      .find((job) => job.documentId === document.id);
    expect(await persistOwnedSuccess(first!, result(), 0.8, db)).toBe(false);
    expect(await persistOwnedSuccess(reclaimed!, result(), 0.8, second)).toBe(true);
    const attempts = await db.receiptExtractionAttempt.findMany({
      where: { documentId: document.id },
      select: { attemptCount: true },
    });
    expect(attempts).toEqual([
      { attemptCount: 1 },
      { attemptCount: 2 },
    ]);
  });
});
