import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '../../lib/db.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import type { AttachmentActor } from '../attachments/operations.js';
import { createReceipts } from './intake.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

describePostgres('receipt schema', () => {
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

  async function intakeFixture(stagedCount: number, sha256: string) {
    const company = await db.company.create({
      data: {
        realmId: `receipt-concurrency-${randomUUID()}`,
        legalName: 'Synthetic Concurrency Company',
        nickname: 'Synthetic Concurrency',
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: {
        email: `receipt-concurrency-${randomUUID()}@example.invalid`,
        memberships: {
          create: { companyId: company.id, role: 'categorizer' },
        },
      },
    });
    userIds.add(user.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256,
        sizeBytes: 8n,
        contentType: 'application/pdf',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const staged = await Promise.all(Array.from(
      { length: stagedCount },
      (_, index) => db.stagedAttachment.create({
        data: {
          companyId: company.id,
          actorKey: `session:${user.id}`,
          blobId: blob.id,
          originalFilename: `synthetic-${index + 1}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 8n,
          sourceKind: 'LOCAL_UPLOAD',
          retainLocally: true,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ));
    const actor: AttachmentActor = {
      kind: 'session',
      actorKey: `session:${user.id}`,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const deps = {
      serializable: <T>(
        callback: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) => runSerializableTransaction<
        Prisma.TransactionClient,
        T
      >(db as never, callback),
    };
    return { actor, company, deps, staged };
  }

  it('allows one receipt per company blob and snapshots retention', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-schema-${randomUUID()}`,
        legalName: 'Synthetic Company',
        nickname: 'Synthetic',
        retainAttachmentFiles: true,
      },
    });
    companyIds.add(company.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256: 'a'.repeat(64),
        sizeBytes: 4n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });

    await db.receiptDocument.create({
      data: {
        companyId: company.id,
        blobId: blob.id,
        originalFilename: 'synthetic.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: 'a'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'RECEIVED',
        retainLocally: true,
      },
    });

    await expect(db.receiptDocument.create({
      data: {
        companyId: company.id,
        blobId: blob.id,
        originalFilename: 'duplicate.png',
        contentType: 'image/png',
        sizeBytes: 4n,
        sha256: 'a'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'RECEIVED',
        retainLocally: true,
      },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('atomically consumes actor-bound uploads with idempotent replay', async () => {
    const company = await db.company.create({
      data: {
        realmId: `receipt-intake-${randomUUID()}`,
        legalName: 'Synthetic Intake Company',
        nickname: 'Synthetic Intake',
        retainAttachmentFiles: true,
      },
    });
    companyIds.add(company.id);
    const user = await db.user.create({
      data: {
        email: `receipt-intake-${randomUUID()}@example.invalid`,
        memberships: {
          create: { companyId: company.id, role: 'categorizer' },
        },
      },
    });
    userIds.add(user.id);
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: company.id,
        state: 'READY',
        sha256: 'b'.repeat(64),
        sizeBytes: 8n,
        contentType: 'application/pdf',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const staged = await db.stagedAttachment.create({
      data: {
        companyId: company.id,
        actorKey: `session:${user.id}`,
        blobId: blob.id,
        originalFilename: 'synthetic.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const actor: AttachmentActor = {
      kind: 'session',
      actorKey: `session:${user.id}`,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const input = {
      actor,
      companyId: company.id,
      files: [{ uploadId: staged.id }],
      sourceKind: 'WEB_UPLOAD' as const,
      idempotencyKey: 'postgres-intake-1',
    };
    const deps = {
      serializable: <T>(
        callback: (transaction: Prisma.TransactionClient) => Promise<T>,
      ) => runSerializableTransaction<
        Prisma.TransactionClient,
        T
      >(db as never, callback),
    };

    const first = await createReceipts(input, deps);
    const replay = await createReceipts(input, deps);

    expect(replay).toEqual(first);
    await expect(db.receiptProcessingJob.count({
      where: { documentId: first.receipts[0]!.id },
    })).resolves.toBe(1);
    await expect(db.receiptEvent.count({
      where: {
        documentId: first.receipts[0]!.id,
        action: 'intake',
      },
    })).resolves.toBe(1);
    await expect(db.stagedAttachment.findUniqueOrThrow({
      where: { id: staged.id },
      select: { consumedAt: true },
    })).resolves.toMatchObject({ consumedAt: expect.any(Date) });
  });

  it('reconciles concurrent exact replays without duplicate jobs', async () => {
    const fixture = await intakeFixture(1, 'e'.repeat(64));
    const input = {
      actor: fixture.actor,
      companyId: fixture.company.id,
      files: [{ uploadId: fixture.staged[0]!.id }],
      sourceKind: 'API_UPLOAD' as const,
      idempotencyKey: 'concurrent-exact-replay',
    };

    const results = await Promise.all([
      createReceipts(input, fixture.deps),
      createReceipts(input, fixture.deps),
    ]);

    expect(results[0]).toEqual(results[1]);
    await expect(db.receiptProcessingJob.count({
      where: { companyId: fixture.company.id },
    })).resolves.toBe(1);
  });

  it('deduplicates concurrent identical content under different keys', async () => {
    const fixture = await intakeFixture(2, 'f'.repeat(64));

    const results = await Promise.all(fixture.staged.map((staged, index) =>
      createReceipts({
        actor: fixture.actor,
        companyId: fixture.company.id,
        files: [{ uploadId: staged.id }],
        sourceKind: 'API_UPLOAD',
        idempotencyKey: `concurrent-content-${index + 1}`,
      }, fixture.deps)));

    expect(results[0]!.receipts[0]!.id).toBe(results[1]!.receipts[0]!.id);
    await expect(db.receiptProcessingJob.count({
      where: { companyId: fixture.company.id },
    })).resolves.toBe(1);
  });

  it('returns a domain conflict when an external ID is reused for new content', async () => {
    const fixture = await intakeFixture(1, '1'.repeat(64));
    await createReceipts({
      actor: fixture.actor,
      companyId: fixture.company.id,
      files: [{
        uploadId: fixture.staged[0]!.id,
        sourceExternalId: 'external-synthetic-1',
      }],
      sourceKind: 'API_UPLOAD',
      idempotencyKey: 'external-first',
    }, fixture.deps);
    const secondBlob = await db.attachmentBlob.create({
      data: {
        companyId: fixture.company.id,
        state: 'READY',
        sha256: '2'.repeat(64),
        sizeBytes: 8n,
        contentType: 'application/pdf',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const secondStaged = await db.stagedAttachment.create({
      data: {
        companyId: fixture.company.id,
        actorKey: fixture.actor.actorKey,
        blobId: secondBlob.id,
        originalFilename: 'external-second.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(createReceipts({
      actor: fixture.actor,
      companyId: fixture.company.id,
      files: [{
        uploadId: secondStaged.id,
        sourceExternalId: 'external-synthetic-1',
      }],
      sourceKind: 'API_UPLOAD',
      idempotencyKey: 'external-second',
    }, fixture.deps)).rejects.toMatchObject({
      code: 'RECEIPT_IDEMPOTENCY_CONFLICT',
    });
  });

  it('does not silently add an external identity during content deduplication', async () => {
    const fixture = await intakeFixture(2, '3'.repeat(64));
    await createReceipts({
      actor: fixture.actor,
      companyId: fixture.company.id,
      files: [{ uploadId: fixture.staged[0]!.id }],
      sourceKind: 'WEB_UPLOAD',
      idempotencyKey: 'content-first',
    }, fixture.deps);

    await expect(createReceipts({
      actor: fixture.actor,
      companyId: fixture.company.id,
      files: [{
        uploadId: fixture.staged[1]!.id,
        sourceExternalId: 'external-new',
      }],
      sourceKind: 'API_UPLOAD',
      idempotencyKey: 'external-second',
    }, fixture.deps)).rejects.toMatchObject({
      code: 'RECEIPT_IDEMPOTENCY_CONFLICT',
    });
  });
});
