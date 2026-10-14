import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../lib/db.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const FIXTURE_SHA256 = 'a'.repeat(64);

interface AttachmentBlobClient {
  create(args: {
    data: {
      companyId: string;
      state: 'READY';
      expiresAt: Date;
      sha256: string;
      sizeBytes: bigint;
      contentType: string;
      chunkCount: number;
    };
  }): Promise<unknown>;
}

describePostgres('attachment schema constraints', () => {
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
        realmId: `attachment-schema-${randomUUID()}`,
        legalName: 'Attachment Schema Fixture',
        nickname: 'Attachment Fixture',
      },
    });
    companyIds.add(company.id);
    return company as typeof company & { retainAttachmentFiles: boolean };
  }

  function createReadyBlob(companyId: string, sha256: string) {
    const attachmentBlob = (
      db as unknown as { attachmentBlob: AttachmentBlobClient }
    ).attachmentBlob;
    return attachmentBlob.create({
      data: {
        companyId,
        state: 'READY',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        sha256,
        sizeBytes: 1n,
        contentType: 'image/png',
        chunkCount: 1,
      },
    });
  }

  it('defaults retention on and enforces company-scoped ready-blob hashes', async () => {
    const firstCompany = await createCompany();
    const secondCompany = await createCompany();

    expect(firstCompany.retainAttachmentFiles).toBe(true);
    await createReadyBlob(firstCompany.id, FIXTURE_SHA256);
    await expect(createReadyBlob(firstCompany.id, FIXTURE_SHA256))
      .rejects.toMatchObject({ code: 'P2002' });
    await expect(createReadyBlob(secondCompany.id, FIXTURE_SHA256))
      .resolves.toBeDefined();
  });

  it('rejects a READY blob without a 64-character lowercase sha256', async () => {
    const company = await createCompany();

    await expect(db.$executeRawUnsafe(
      `INSERT INTO "AttachmentBlob"
        ("id", "companyId", "state", "sha256", "sizeBytes",
         "contentType", "chunkCount", "createdAt")
       VALUES ($1, $2, 'READY', NULL, 1, 'image/png', 1, CURRENT_TIMESTAMP)`,
      randomUUID(),
      company.id,
    )).rejects.toThrow();
  });
});
