import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  collectUnreferencedBlobs,
  openAttachmentBlob,
  stageAttachment,
} from './blobStore.js';
import { BLOB_CHUNK_BYTES } from './validation.js';
import type { AttachmentStoragePolicyDefaults } from './policy.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const MIB = 1024n * 1024n;

async function* irregularChunks(content: Uint8Array) {
  const widths = [17, 700_003, 31, 1_200_001, 65_537];
  let offset = 0;
  let index = 0;
  while (offset < content.byteLength) {
    const end = Math.min(content.byteLength, offset + widths[index % widths.length]!);
    yield content.subarray(offset, end);
    offset = end;
    index += 1;
  }
}

function pdfFixture(size: number, fill: number): Uint8Array {
  const content = new Uint8Array(size).fill(fill);
  content.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
  return content;
}

describePostgres('attachment PostgreSQL blob store', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

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
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createCompany() {
    const company = await db.company.create({
      data: {
        realmId: `attachment-blob-${randomUUID()}`,
        legalName: 'Attachment Blob Fixture',
        nickname: 'Blob Fixture',
      },
    });
    companyIds.add(company.id);
    return company;
  }

  function stage(
    companyId: string,
    content: Uint8Array,
    actorKey = `user:${randomUUID()}`,
    options: {
      policyDefaults?: AttachmentStoragePolicyDefaults;
      now?: () => Date;
    } = {},
  ) {
    const stagedAt = options.now?.() ?? new Date();
    return stageAttachment({
      companyId,
      actorKey,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally: true,
      filename: 'receipt.pdf',
      declaredContentType: 'application/pdf',
      content: irregularChunks(content),
      expiresAt: new Date(stagedAt.getTime() + 60_000),
    }, { db, ...options });
  }

  it('streams a 2.5 MiB file into ordered chunks no larger than one MiB', async () => {
    const company = await createCompany();
    const content = pdfFixture(BLOB_CHUNK_BYTES * 2 + BLOB_CHUNK_BYTES / 2, 7);
    const staged = await stage(company.id, content);
    const row = await db.stagedAttachment.findUniqueOrThrow({
      where: { id: staged.id },
      select: { blobId: true },
    });
    const chunks = await db.attachmentBlobChunk.findMany({
      where: { blobId: row.blobId },
      orderBy: { ordinal: 'asc' },
    });

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.content.byteLength)).toEqual([
      BLOB_CHUNK_BYTES,
      BLOB_CHUNK_BYTES,
      BLOB_CHUNK_BYTES / 2,
    ]);

    const reader = await openAttachmentBlob(company.id, row.blobId, { db });
    const streamed: Buffer[] = [];
    for await (const chunk of reader.chunks()) streamed.push(Buffer.from(chunk));
    expect(Buffer.concat(streamed)).toEqual(Buffer.from(content));
  }, 30_000);

  it('deduplicates concurrent identical files per company but not across companies', async () => {
    const firstCompany = await createCompany();
    const secondCompany = await createCompany();
    const content = pdfFixture(256_000, 11);

    const [first, second] = await Promise.all([
      stage(firstCompany.id, content),
      stage(firstCompany.id, content),
    ]);
    const acrossCompany = await stage(secondCompany.id, content);

    expect(first.sha256).toBe(second.sha256);
    expect(acrossCompany.sha256).toBe(first.sha256);
    await expect(db.attachmentBlob.count({
      where: { companyId: firstCompany.id, state: 'READY' },
    })).resolves.toBe(1);
    await expect(db.attachmentBlob.count({
      where: { companyId: secondCompany.id, state: 'READY' },
    })).resolves.toBe(1);
    await expect(db.attachmentBlob.aggregate({
      where: { state: 'READY', companyId: { in: [firstCompany.id, secondCompany.id] } },
      _sum: { sizeBytes: true },
    })).resolves.toMatchObject({ _sum: { sizeBytes: 512_000n } });
  });

  it('stores a finite retention deadline from the effective company policy', async () => {
    const company = await createCompany();
    const now = new Date('2026-08-02T12:00:00.000Z');
    const staged = await stage(company.id, pdfFixture(4096, 17), undefined, {
      now: () => now,
      policyDefaults: {
        companyQuotaBytes: MIB,
        instanceQuotaBytes: 10n * MIB,
        retentionDays: 30,
      },
    });

    const row = await db.stagedAttachment.findUniqueOrThrow({
      where: { id: staged.id },
      include: { blob: true },
    });
    expect(row.blob.expiresAt?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('accepts the company boundary and rejects one additional physical blob', async () => {
    const company = await createCompany();
    const policyDefaults = {
      companyQuotaBytes: MIB,
      instanceQuotaBytes: 10n * MIB,
      retentionDays: 365,
    };
    await stage(company.id, pdfFixture(Number(MIB), 23), undefined, { policyDefaults });

    await expect(stage(
      company.id,
      pdfFixture(16, 24),
      undefined,
      { policyDefaults },
    )).rejects.toMatchObject({ code: 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED' });
    await expect(db.attachmentBlob.count({
      where: { companyId: company.id, state: 'STAGING' },
    })).resolves.toBe(0);
  }, 30_000);

  it('refuses an over-quota upload before the rest of it is streamed', async () => {
    const company = await createCompany();
    const policyDefaults = {
      companyQuotaBytes: 2n * MIB,
      instanceQuotaBytes: 1024n * MIB,
      retentionDays: 365,
    };
    let yieldedBytes = 0;
    async function* large() {
      const chunk = pdfFixture(Number(MIB), 41);
      for (let index = 0; index < 40; index += 1) {
        yieldedBytes += chunk.byteLength;
        yield chunk;
      }
    }

    await expect(stageAttachment({
      companyId: company.id,
      actorKey: `user:${randomUUID()}`,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally: true,
      filename: 'receipt.pdf',
      declaredContentType: 'application/pdf',
      content: large(),
      expiresAt: new Date(Date.now() + 60_000),
    }, { db, policyDefaults })).rejects.toMatchObject({
      code: 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED',
    });

    expect(yieldedBytes).toBeLessThanOrEqual(4 * Number(MIB));
    await expect(db.attachmentBlob.count({
      where: { companyId: company.id },
    })).resolves.toBe(0);
  }, 30_000);

  it('counts an in-flight upload reservation against a concurrent upload', async () => {
    const company = await createCompany();
    const policyDefaults = {
      companyQuotaBytes: 10n * MIB,
      instanceQuotaBytes: 1024n * MIB,
      retentionDays: 365,
    };
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let firstChunkYielded!: () => void;
    const firstChunkSent = new Promise<void>((resolve) => { firstChunkYielded = resolve; });
    async function* paused() {
      yield pdfFixture(Number(MIB), 51);
      firstChunkYielded();
      await released;
      yield new Uint8Array(1024).fill(52);
    }
    const first = stageAttachment({
      companyId: company.id,
      actorKey: `user:${randomUUID()}`,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally: true,
      filename: 'receipt.pdf',
      declaredContentType: 'application/pdf',
      content: paused(),
      expiresAt: new Date(Date.now() + 60_000),
    }, { db, policyDefaults });
    await firstChunkSent;
    await expect.poll(() => db.attachmentBlob.count({
      where: { companyId: company.id, state: 'STAGING', sizeBytes: { gt: 0n } },
    })).toBe(1);

    await expect(stage(
      company.id,
      pdfFixture(3 * Number(MIB), 53),
      undefined,
      { policyDefaults },
    )).rejects.toMatchObject({ code: 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED' });
    // A file that fits beside the reservation is still accepted.
    await expect(stage(
      company.id,
      pdfFixture(Number(MIB), 54),
      undefined,
      { policyDefaults },
    )).resolves.toMatchObject({ sizeBytes: Number(MIB) });

    release();
    await expect(first).resolves.toMatchObject({ sizeBytes: Number(MIB) + 1024 });
  }, 30_000);

  it('serializes concurrent companies at the instance boundary', async () => {
    const firstCompany = await createCompany();
    const secondCompany = await createCompany();
    const policyDefaults = {
      companyQuotaBytes: MIB,
      instanceQuotaBytes: MIB,
      retentionDays: 365,
    };
    const results = await Promise.allSettled([
      stage(firstCompany.id, pdfFixture(700_000, 31), undefined, { policyDefaults }),
      stage(secondCompany.id, pdfFixture(700_000, 32), undefined, { policyDefaults }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'ATTACHMENT_INSTANCE_QUOTA_EXCEEDED' }),
    });
    await expect(db.attachmentBlob.aggregate({
      where: { companyId: { in: [firstCompany.id, secondCompany.id] }, state: 'READY' },
      _sum: { sizeBytes: true },
    })).resolves.toMatchObject({ _sum: { sizeBytes: 700_000n } });
  }, 30_000);

  it('garbage-collects only blobs whose staged and transaction references are gone', async () => {
    const company = await createCompany();
    const staged = await stage(company.id, pdfFixture(4096, 19));

    await expect(collectUnreferencedBlobs(10, { db })).resolves.toBe(0);
    await db.stagedAttachment.delete({ where: { id: staged.id } });
    await expect(collectUnreferencedBlobs(10, { db })).resolves.toBe(1);
  });
});
