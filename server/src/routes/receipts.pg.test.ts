import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '../lib/db.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { errorMiddleware } from '../lib/http.js';
import { qboFactory } from '../lib/qbo/factory.js';
import { QboAttachmentNotFoundError } from '../lib/qbo/types.js';
import { createSession, SESSION_COOKIE } from '../middleware/auth.js';
import {
  attachmentUploadsRouter,
  companyAttachmentGrantsRouter,
} from './attachments.js';
import { receiptsRouter } from './receipts.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

describePostgres('receipt HTTP routes on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const companies = [...companyIds];
    const users = [...userIds];
    companyIds.clear();
    userIds.clear();
    if (companies.length > 0) {
      await db.company.deleteMany({ where: { id: { in: companies } } });
    }
    if (users.length > 0) {
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  function application() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: '1mb' }));
    app.use(
      '/api/companies/:companyId/attachment-upload-grants',
      companyAttachmentGrantsRouter,
    );
    app.use('/api/attachment-uploads', attachmentUploadsRouter);
    app.use('/api/companies/:companyId/receipts', receiptsRouter);
    app.use(errorMiddleware);
    return app;
  }

  async function company(realmId = `receipt-route-${randomUUID()}`) {
    const row = await db.company.create({
      data: {
        realmId,
        legalName: 'Synthetic Receipt Route Company',
        nickname: 'Receipt Route',
      },
    });
    companyIds.add(row.id);
    return row;
  }

  async function signedIn(
    companyId: string,
    role: 'viewer' | 'categorizer' | 'admin',
  ) {
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.invalid`,
        memberships: { create: { companyId, role } },
      },
    });
    userIds.add(user.id);
    const session = await createSession(user.id);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  async function upload(
    app: ReturnType<typeof application>,
    companyId: string,
    cookie: string,
    suffix = '',
  ) {
    const grantResponse = await request(app)
      .post(`/api/companies/${companyId}/attachment-upload-grants`)
      .set('Cookie', cookie)
      .send({});
    expect(grantResponse.status).toBe(201);
    const grant = grantResponse.body as { uploadUrl: string; grant: string };
    const staged = await request(app)
      .post(grant.uploadUrl)
      .set('Authorization', `Bearer ${grant.grant}`)
      .attach('files', Buffer.from(`%PDF-1.7\nsynthetic receipt${suffix}`), {
        filename: 'synthetic.pdf',
        contentType: 'application/pdf',
      });
    expect(staged.status).toBe(201);
    return staged.body.uploads[0] as { id: string };
  }

  it('lets a categorizer ingest and a viewer read and preview a receipt', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const staged = await upload(app, firstCompany.id, categorizer);

    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'receipt-create-1',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    expect(created.status).toBe(202);
    expect(created.body.receipts[0]).toMatchObject({
      filename: 'synthetic.pdf',
      status: 'QUEUED',
    });
    const receiptId = created.body.receipts[0].id as string;

    const listed = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.receipts.map((receipt: { id: string }) => receipt.id))
      .toContain(receiptId);

    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}`)
      .set('Cookie', viewer)
      .expect(200);
    const preview = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/preview`)
      .set('Cookie', viewer)
      .buffer(true);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(Buffer.from('%PDF-1.7\nsynthetic receipt'));
    expect(preview.headers['content-disposition']).toMatch(/^inline;/u);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('keeps workspace, batch, and export endpoints company scoped', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'workspace-route',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;

    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/stats`)
      .set('Cookie', viewer)
      .expect(200)
      .expect((response) => {
        expect(response.body.received).toBe(1);
      });
    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/duplicates`)
      .set('Cookie', viewer)
      .expect(200)
      .expect([]);
    const edited = await request(app)
      .patch(`/api/companies/${firstCompany.id}/receipts/${receiptId}`)
      .set('Cookie', categorizer)
      .send({
        expectedRevision: 0,
        patch: {
          vendorName: 'Invented Workspace Vendor',
          totalAmount: '12.34',
          currency: 'USD',
        },
      });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      revision: 1,
      currentExtraction: null,
    });
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/batch/approve`)
      .set('Cookie', categorizer)
      .send({
        receipts: [{ id: receiptId, expectedRevision: 1 }],
      })
      .expect(200)
      .expect({ updated: 1 });
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/batch/delete`)
      .set('Cookie', viewer)
      .send({
        receipts: [{ id: receiptId, expectedRevision: 2 }],
      })
      .expect(403);
    const exported = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/export`)
      .set('Cookie', viewer)
      .send({ documentIds: [receiptId] })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toMatch(/application\/zip/u);
    expect(exported.headers['content-disposition']).toContain(
      'recat-receipts-',
    );
    expect(Buffer.isBuffer(exported.body)).toBe(true);
  });

  it('returns 403 for a viewer mutation and 404 outside company scope', async () => {
    const app = application();
    const firstCompany = await company();
    const secondCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const otherCategorizer = await signedIn(secondCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'scope-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;

    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', viewer)
      .send({
        idempotencyKey: 'viewer-receipt',
        files: [{ uploadId: randomUUID() }],
        sourceKind: 'WEB_UPLOAD',
      })
      .expect(403);
    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', otherCategorizer)
      .expect(404);
    for (const suffix of [
      receiptId,
      `${receiptId}/file`,
      `${receiptId}/preview`,
    ]) {
      await request(app)
        .get(`/api/companies/${firstCompany.id}/receipts/${suffix}`)
        .set('Cookie', otherCategorizer)
        .expect(404);
    }
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', otherCategorizer)
      .expect(404);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', otherCategorizer)
      .send({ expectedRevision: 0 })
      .expect(404);
    for (const action of ['attach', 'undo']) {
      await request(app)
        .post(
          `/api/companies/${firstCompany.id}/receipts/${receiptId}/${action}`,
        )
        .set('Cookie', viewer)
        .send({
          expectedReceiptRevision: 0,
          expectedTransactionRevision: 0,
        })
        .expect(403);
      await request(app)
        .post(
          `/api/companies/${firstCompany.id}/receipts/${receiptId}/${action}`,
        )
        .set('Cookie', categorizer)
        .send({ expectedReceiptRevision: -1 })
        .expect(400);
    }
  });

  it('revision-fences delete and restore mutations', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'revision-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;

    await request(app)
      .delete(`/api/companies/${firstCompany.id}/receipts/${receiptId}`)
      .set('Cookie', categorizer)
      .expect(400);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=1',
      )
      .set('Cookie', categorizer)
      .expect(409);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', categorizer)
      .expect(204);
    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', categorizer)
      .expect(409);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', categorizer)
      .send({ expectedRevision: 0 })
      .expect(409);
    const restored = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/restore`)
      .set('Cookie', categorizer)
      .send({ expectedRevision: 1 });
    expect(restored.status).toBe(200);
    expect(restored.body.revision).toBe(2);
  });

  it('rejects delete and reprocess while attachment work is in flight', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'attachment-state-guard',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    await db.receiptDocument.update({
      where: { id: receiptId },
      data: { status: 'ATTACHING' },
    });

    await request(app)
      .delete(
        `/api/companies/${firstCompany.id}/receipts/${receiptId}`
        + '?expectedRevision=0',
      )
      .set('Cookie', categorizer)
      .expect(409);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/reprocess`)
      .set('Cookie', categorizer)
      .send({
        expectedRevision: 0,
        idempotencyKey: 'attachment-state-reprocess',
      })
      .expect(409);
  });

  it('rolls back a batch reprocess when any selected revision is stale', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const receiptIds: string[] = [];
    for (const idempotencyKey of ['batch-reprocess-first', 'batch-reprocess-second']) {
      const staged = await upload(
        app,
        firstCompany.id,
        categorizer,
        idempotencyKey,
      );
      const created = await request(app)
        .post(`/api/companies/${firstCompany.id}/receipts`)
        .set('Cookie', categorizer)
        .send({
          idempotencyKey,
          files: [{ uploadId: staged.id }],
          sourceKind: 'WEB_UPLOAD',
        });
      receiptIds.push(created.body.receipts[0].id as string);
    }

    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/batch/reprocess`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'batch-reprocess-atomic',
        receipts: [
          { id: receiptIds[0], expectedRevision: 0 },
          { id: receiptIds[1], expectedRevision: 1 },
        ],
      })
      .expect(409);

    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: receiptIds[0] },
    })).resolves.toMatchObject({ generation: 1, revision: 0, status: 'QUEUED' });
  });

  it('authorizes and revision-fences rematch and confirmation routes', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const viewer = await signedIn(firstCompany.id, 'viewer');
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: firstCompany.id,
        state: 'READY',
        sha256: '7'.repeat(64),
        sizeBytes: 3n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: firstCompany.id,
        blobId: blob.id,
        originalFilename: 'route-match.png',
        contentType: 'image/png',
        sizeBytes: 3n,
        sha256: '7'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        jobs: {
          create: {
            companyId: firstCompany.id,
            generation: 1,
            configVersion: 'd'.repeat(64),
            status: 'completed',
            dueAt: new Date(),
          },
        },
      },
    });
    const job = await db.receiptProcessingJob.findUniqueOrThrow({
      where: {
        documentId_generation: {
          documentId: receipt.id,
          generation: 1,
        },
      },
    });
    await db.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: receipt.id,
        generation: 1,
        attemptCount: 1,
        status: 'succeeded',
        receiptDate: new Date('2026-07-30T00:00:00.000Z'),
        vendorName: 'Synthetic Route Vendor',
        totalAmount: '10.00',
        currency: 'CAD',
        documentType: 'expense_receipt',
        extractionConfidence: 0.9,
        model: 'synthetic/model',
        promptVersion: 'synthetic-v1',
        schemaVersion: 'synthetic-v1',
        completedAt: new Date(),
      },
    });
    const transactions = await Promise.all([0, 1].map((index) =>
      db.transaction.create({
        data: {
          companyId: firstCompany.id,
          qboId: `route-match-${index}-${randomUUID()}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-07-30T00:00:00.000Z'),
          payee: 'Synthetic Route Vendor',
          amount: -10,
          bankAccount: 'Synthetic Bank',
          status: 'PENDING',
          rawData: { CurrencyRef: { value: 'CAD' } },
        },
      })));

    await request(app)
      .post(
        `/api/companies/${firstCompany.id}/receipts/${receipt.id}/rematch`,
      )
      .set('Cookie', viewer)
      .send({ expectedReceiptRevision: 0 })
      .expect(403);
    await request(app)
      .post(
        `/api/companies/${firstCompany.id}/receipts/${receipt.id}/rematch`,
      )
      .set('Cookie', categorizer)
      .send({ expectedReceiptRevision: -1 })
      .expect(400);

    const rematched = await request(app)
      .post(
        `/api/companies/${firstCompany.id}/receipts/${receipt.id}/rematch`,
      )
      .set('Cookie', categorizer)
      .send({ expectedReceiptRevision: 0 });
    expect(rematched.status).toBe(200);
    expect(rematched.body).toMatchObject({
      id: receipt.id,
      revision: 1,
      status: 'READY',
    });
    expect(rematched.body.candidates).toHaveLength(2);

    await db.qboEntityLease.create({
      data: {
        companyId: firstCompany.id,
        qboType: transactions[0]!.qboType,
        qboId: transactions[0]!.qboId,
        owner: 'synthetic-concurrent-writer',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await request(app)
      .post(
        `/api/companies/${firstCompany.id}/receipts/${receipt.id}`
        + `/matches/${transactions[0]!.id}/confirm`,
      )
      .set('Cookie', categorizer)
      .send({
        expectedReceiptRevision: 1,
        expectedTransactionRevision: 0,
      })
      .expect(409);
    await db.qboEntityLease.delete({
      where: {
        companyId_qboType_qboId: {
          companyId: firstCompany.id,
          qboType: transactions[0]!.qboType,
          qboId: transactions[0]!.qboId,
        },
      },
    });

    const confirmed = await request(app)
      .post(
        `/api/companies/${firstCompany.id}/receipts/${receipt.id}`
        + `/matches/${transactions[0]!.id}/confirm`,
      )
      .set('Cookie', categorizer)
      .send({
        expectedReceiptRevision: 1,
        expectedTransactionRevision: 0,
      });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      id: receipt.id,
      revision: 2,
      status: 'MATCHED',
      matchedTransactionId: transactions[0]!.id,
    });
  });

  it('reprocesses once per idempotency key and generation-fences old work', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'reprocess-source',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    const body = {
      expectedRevision: 0,
      idempotencyKey: 'reprocess-once',
    };

    const first = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/reprocess`)
      .set('Cookie', categorizer)
      .send(body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      generation: 2,
      revision: 1,
      status: 'QUEUED',
    });
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/reprocess`)
      .set('Cookie', categorizer)
      .send(body)
      .expect(202);
    await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts/${receiptId}/reprocess`)
      .set('Cookie', categorizer)
      .send({ expectedRevision: 0, idempotencyKey: 'different-request' })
      .expect(409);

    const jobs = await db.receiptProcessingJob.findMany({
      where: { documentId: receiptId },
      orderBy: { generation: 'asc' },
      select: { generation: true, status: true },
    });
    expect(jobs).toEqual([
      { generation: 1, status: 'cancelled' },
      { generation: 2, status: 'queued' },
    ]);
  });

  it('falls back to attached local content when the primary blob is unavailable', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'fallback-receipt',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    const receipt = await db.receiptDocument.findUniqueOrThrow({
      where: { id: receiptId },
    });
    const fallbackContent = Buffer.from('%PDF-1.7\nfallback receipt');
    const fallbackBlob = await db.attachmentBlob.create({
      data: {
        companyId: firstCompany.id,
        state: 'READY',
        sha256: 'c'.repeat(64),
        sizeBytes: BigInt(fallbackContent.byteLength),
        contentType: 'application/pdf',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
        chunks: {
          create: { ordinal: 0, content: fallbackContent },
        },
      },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: firstCompany.id,
        qboId: `fallback-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Synthetic Fallback Vendor',
        amount: -10,
        bankAccount: 'Synthetic Bank',
      },
    });
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: firstCompany.id,
        transactionId: transaction.id,
        blobId: fallbackBlob.id,
        originalFilename: 'fallback.pdf',
        contentType: 'application/pdf',
        sizeBytes: BigInt(fallbackContent.byteLength),
        sha256: 'c'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: { transactionAttachmentId: attachment.id },
    });
    await db.attachmentBlob.update({
      where: { id: receipt.blobId! },
      data: {
        state: 'STAGING',
        sha256: null,
        sizeBytes: 0n,
        contentType: null,
        chunkCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const preview = await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/preview`)
      .set('Cookie', categorizer)
      .buffer(true);

    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(fallbackContent);
  });

  it.each(['DELETED', 'QBO_MISSING'] as const)(
    'does not download a logically unavailable %s QuickBooks attachment',
    async (status) => {
      const app = application();
      const firstCompany = await company();
      const categorizer = await signedIn(firstCompany.id, 'categorizer');
      const staged = await upload(app, firstCompany.id, categorizer);
      const created = await request(app)
        .post(`/api/companies/${firstCompany.id}/receipts`)
        .set('Cookie', categorizer)
        .send({
          idempotencyKey: `unavailable-${status.toLowerCase()}`,
          files: [{ uploadId: staged.id }],
          sourceKind: 'WEB_UPLOAD',
        });
      const receiptId = created.body.receipts[0].id as string;
      const receipt = await db.receiptDocument.findUniqueOrThrow({
        where: { id: receiptId },
      });
      const transaction = await db.transaction.create({
        data: {
          companyId: firstCompany.id,
          qboId: `unavailable-${status.toLowerCase()}`,
          qboType: 'Purchase',
          qboSyncToken: '0',
          date: new Date('2026-07-30T00:00:00.000Z'),
          payee: 'Synthetic Unavailable Vendor',
          amount: -10,
          bankAccount: 'Synthetic Bank',
        },
      });
      const attachment = await db.transactionAttachment.create({
        data: {
          companyId: firstCompany.id,
          transactionId: transaction.id,
          originalFilename: 'unavailable.pdf',
          contentType: 'application/pdf',
          sizeBytes: 8n,
          sha256: '9'.repeat(64),
          sourceKind: 'LOCAL_UPLOAD',
          retainLocally: false,
          status,
          qboAttachableId: 'missing-qbo-attachment',
          recatMarker: randomUUID(),
        },
      });
      await db.receiptDocument.update({
        where: { id: receipt.id },
        data: {
          blobId: null,
          transactionAttachmentId: attachment.id,
        },
      });
      await db.attachmentBlob.update({
        where: { id: receipt.blobId! },
        data: {
          state: 'STAGING',
          sha256: null,
          sizeBytes: 0n,
          contentType: null,
          chunkCount: 0,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await request(app)
        .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/file`)
        .set('Cookie', categorizer)
        .expect(410);
    },
  );

  it('maps a missing QuickBooks provider object to gone', async () => {
    const app = application();
    const firstCompany = await company();
    const categorizer = await signedIn(firstCompany.id, 'categorizer');
    const staged = await upload(app, firstCompany.id, categorizer);
    const created = await request(app)
      .post(`/api/companies/${firstCompany.id}/receipts`)
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'provider-missing',
        files: [{ uploadId: staged.id }],
        sourceKind: 'WEB_UPLOAD',
      });
    const receiptId = created.body.receipts[0].id as string;
    const receipt = await db.receiptDocument.findUniqueOrThrow({
      where: { id: receiptId },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: firstCompany.id,
        qboId: 'provider-missing',
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Synthetic Missing Vendor',
        amount: -10,
        bankAccount: 'Synthetic Bank',
      },
    });
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: firstCompany.id,
        transactionId: transaction.id,
        originalFilename: 'provider-missing.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sha256: '8'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: false,
        status: 'ATTACHED',
        qboAttachableId: 'missing-qbo-attachment',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        blobId: null,
        transactionAttachmentId: attachment.id,
      },
    });
    await db.attachmentBlob.update({
      where: { id: receipt.blobId! },
      data: {
        state: 'STAGING',
        sha256: null,
        sizeBytes: 0n,
        contentType: null,
        chunkCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    vi.spyOn(qboFactory, 'forCompany').mockResolvedValue({
      getAttachment: async () => ({
        id: 'missing-qbo-attachment',
        syncToken: '0',
        filename: 'provider-missing.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8,
        note: null,
        refs: [{ qboType: 'Purchase', qboId: 'provider-missing' }],
      }),
      openAttachmentDownload: async () => {
        throw new QboAttachmentNotFoundError();
      },
    } as never);

    await request(app)
      .get(`/api/companies/${firstCompany.id}/receipts/${receiptId}/file`)
      .set('Cookie', categorizer)
      .expect(410);
  });
});
