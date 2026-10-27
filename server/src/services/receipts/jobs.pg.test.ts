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
import {
  claimReceiptJobs,
  finishReceiptJob,
  type ReceiptJobDeps,
} from './jobs.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

describePostgres('durable receipt job claims on PostgreSQL', () => {
  let first: PrismaClient;
  let second: PrismaClient;
  let locker: PrismaClient;
  let releaseFileLock: () => void;
  let fileLock: Promise<void>;
  const companyIds = new Set<string>();

  beforeAll(async () => {
    first = new PrismaClient({
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
      await first.company.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    releaseFileLock?.();
    await fileLock;
    await Promise.all([
      first?.$disconnect(),
      second?.$disconnect(),
      locker?.$disconnect(),
    ]);
  }, 130_000);

  function deps(db: PrismaClient): ReceiptJobDeps {
    return { db: db as unknown as ReceiptJobDeps['db'] };
  }

  async function queuedJob(db = first) {
    const company = await db.company.create({
      data: {
        realmId: `receipt-job-${randomUUID()}`,
        legalName: 'Synthetic Receipt Job Company',
        nickname: 'Synthetic Receipt Job',
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

  it('allows only one owner to claim one job', async () => {
    const document = await queuedJob();
    const [a, b] = await Promise.all([
      claimReceiptJobs('worker-a', 4, deps(first)),
      claimReceiptJobs('worker-b', 4, deps(second)),
    ]);
    expect([...a, ...b].filter((job) => job.documentId === document.id))
      .toHaveLength(1);
  });

  it('leaves work queued while company receipt processing is disabled', async () => {
    const document = await queuedJob();
    await first.receiptCompanyConfig.create({
      data: {
        companyId: document.companyId,
        enabled: false,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        confidenceThreshold: 0.8,
        autoMatchThreshold: 85,
        autoMatchMargin: 15,
        maxPages: 20,
        configVersion: 'b'.repeat(64),
      },
    });
    expect((await claimReceiptJobs('worker-disabled', 4, deps(first)))
      .some((job) => job.documentId === document.id)).toBe(false);
    await expect(first.receiptProcessingJob.findUniqueOrThrow({
      where: { id: document.jobs[0]!.id },
      select: { status: true, attemptCount: true },
    })).resolves.toEqual({ status: 'queued', attemptCount: 0 });
  });

  it('reclaims an expired lease and increments attemptCount', async () => {
    const document = await queuedJob();
    const claimed = (await claimReceiptJobs('worker-a', 4, deps(first)))
      .find((job) => job.documentId === document.id);
    await first.receiptProcessingJob.update({
      where: { id: document.jobs[0]!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const reclaimed = (await claimReceiptJobs('worker-b', 4, deps(second)))
      .find((job) => job.documentId === document.id);
    expect(reclaimed).toMatchObject({
      id: claimed!.id,
      lockOwner: 'worker-b',
      attemptCount: 2,
    });
  });

  it('does not let a lease-lost owner finish', async () => {
    const document = await queuedJob();
    const claimed = (await claimReceiptJobs('worker-a', 4, deps(first)))
      .find((job) => job.documentId === document.id);
    await first.receiptProcessingJob.update({
      where: { id: document.jobs[0]!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const reclaimed = (await claimReceiptJobs('worker-b', 4, deps(second)))
      .find((job) => job.documentId === document.id);
    expect(await finishReceiptJob(
      claimed!,
      'worker-a',
      { kind: 'succeeded' },
      deps(first),
    )).toBe(false);
    expect(await finishReceiptJob(
      reclaimed!,
      'worker-b',
      { kind: 'succeeded' },
      deps(second),
    )).toBe(true);
  });

  it('terminalizes an abandoned third attempt for review', async () => {
    const document = await queuedJob();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = (await claimReceiptJobs(
        `worker-${attempt}`,
        4,
        deps(first),
      )).find((job) => job.documentId === document.id);
      expect(claimed?.attemptCount).toBe(attempt);
      await first.receiptProcessingJob.update({
        where: { id: document.jobs[0]!.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
    }
    expect((await claimReceiptJobs('worker-final', 4, deps(first)))
      .some((job) => job.documentId === document.id)).toBe(false);
    await expect(first.receiptProcessingJob.findUniqueOrThrow({
      where: { id: document.jobs[0]!.id },
      select: { status: true, lastErrorCode: true },
    })).resolves.toEqual({
      status: 'terminal',
      lastErrorCode: 'RECEIPT_JOB_EXHAUSTED',
    });
    await expect(first.receiptDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { status: true },
    })).resolves.toEqual({ status: 'NEEDS_REVIEW' });
    await expect(first.receiptExtractionAttempt.count({
      where: { documentId: document.id },
    })).resolves.toBe(3);
  });
});
