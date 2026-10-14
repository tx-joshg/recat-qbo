import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { PrismaClient } from '../lib/db.js';
import { errorMiddleware } from '../lib/http.js';
import { createSession, SESSION_COOKIE } from '../middleware/auth.js';
import {
  getMockRealm,
  MOCK_REALM_HARBOR,
  resetMockRealms,
} from '../lib/qbo/mock.js';
import {
  attachmentDownloadsRouter,
  attachmentUploadsRouter,
  companyAttachmentGrantsRouter,
  transactionAttachmentsRouter,
} from './attachments.js';
import { companiesRouter } from './companies.js';
import { instanceRouter } from './instance.js';
import { issueAttachmentDownloadGrant } from '../services/attachments/grants.js';
import { ATTACHMENT_POLICY_CONFIG_KEYS } from '../services/attachments/policyStore.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('attachment HTTP routes on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  beforeEach(() => {
    resetMockRealms();
  });

  afterEach(async () => {
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
    await db.appConfig.deleteMany({
      where: { key: { in: Object.values(ATTACHMENT_POLICY_CONFIG_KEYS) } },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  function application() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: '1mb' }));
    app.use(
      '/api/companies/:companyId/transactions/:transactionId/attachments',
      transactionAttachmentsRouter,
    );
    app.use(
      '/api/companies/:companyId/attachment-upload-grants',
      companyAttachmentGrantsRouter,
    );
    app.use('/api/attachment-uploads', attachmentUploadsRouter);
    app.use('/api/attachment-downloads', attachmentDownloadsRouter);
    app.use('/api/companies', companiesRouter);
    app.use('/api/instance', instanceRouter);
    app.use(errorMiddleware);
    return app;
  }

  async function fixture() {
    const company = await db.company.create({
      data: {
        realmId: MOCK_REALM_HARBOR,
        legalName: 'Attachment Route Fixture',
        nickname: 'Route Fixture',
      },
    });
    companyIds.add(company.id);
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: '2',
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-01T00:00:00.000Z'),
        payee: 'Generic Route Fixture',
        amount: -12,
        bankAccount: 'Fixture Bank',
      },
    });
    return { company, transaction };
  }

  async function signedIn(
    companyId: string,
    role: 'viewer' | 'categorizer' | 'admin',
    isInstanceAdmin = false,
  ) {
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.invalid`,
        isInstanceAdmin,
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
    content = Buffer.from('%PDF-1.7\nroute fixture'),
  ) {
    const grantResponse = await request(app)
      .post(`/api/companies/${companyId}/attachment-upload-grants`)
      .set('Cookie', cookie)
      .send({});
    expect(grantResponse.status).toBe(201);
    const grant = grantResponse.body as {
      uploadUrl: string;
      grant: string;
    };
    const staged = await request(app)
      .post(grant.uploadUrl)
      .set('Authorization', `Bearer ${grant.grant}`)
      .attach('files', content, {
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
      });
    expect(staged.status).toBe(201);
    return { grant, staged: staged.body.uploads[0] as { id: string } };
  }

  it('issues one-use grants, attaches, lists, and securely streams a local file', async () => {
    const app = application();
    const { company, transaction } = await fixture();
    const cookie = await signedIn(company.id, 'categorizer');
    const { grant, staged } = await upload(app, company.id, cookie);

    const replay = await request(app)
      .post(grant.uploadUrl)
      .set('Authorization', `Bearer ${grant.grant}`)
      .attach('files', Buffer.from('%PDF-1.7\nreplay'), {
        filename: 'replay.pdf',
        contentType: 'application/pdf',
      });
    expect(replay.status).toBe(401);

    const attached = await request(app)
      .post(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments`,
      )
      .set('Cookie', cookie)
      .send({
        idempotencyKey: 'route-attach-1',
        sources: [{ kind: 'upload', uploadId: staged.id }],
      });
    expect(attached.status).toBe(202);
    expect(attached.body.status).toBe('VERIFIED');
    const attachmentId = attached.body.files[0].id as string;

    const listed = await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments`,
      )
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject([
      {
        id: attachmentId,
        filename: 'receipt.pdf',
        retainedLocally: true,
        qboAttached: true,
      },
    ]);

    const downloaded = await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/download`,
      )
      .set('Cookie', cookie)
      .buffer(true);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(downloaded.headers['content-disposition']).not.toMatch(/[\r\n]/u);
    expect(downloaded.body).toEqual(Buffer.from('%PDF-1.7\nroute fixture'));
    const previewed = await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/preview`,
      )
      .set('Cookie', cookie)
      .buffer(true);
    expect(previewed.status).toBe(200);
    expect(previewed.headers['content-disposition']).toMatch(/^inline;/u);

    const programmatic = await issueAttachmentDownloadGrant({
      actor: {
        kind: 'mcp',
        actorKey: 'mcp:route-fixture',
        userId: randomUUID(),
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, role: 'viewer' }],
      },
      companyId: company.id,
      transactionId: transaction.id,
      attachmentId,
    });
    const grantedDownload = await request(app)
      .get(programmatic.downloadUrl)
      .set('Authorization', `Bearer ${programmatic.grant}`)
      .buffer(true);
    expect(grantedDownload.status).toBe(200);
    expect(grantedDownload.body).toEqual(
      Buffer.from('%PDF-1.7\nroute fixture'),
    );
    await request(app)
      .get(programmatic.downloadUrl)
      .set('Authorization', `Bearer ${programmatic.grant}`)
      .expect(401);

    await request(app)
      .delete(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}?scope=everywhere&idempotencyKey=route-delete`,
      )
      .set('Cookie', cookie)
      .expect(202);
    await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/download`,
      )
      .set('Cookie', cookie)
      .expect(404);
  });

  it('scopes operation URLs to the company and transaction in the route', async () => {
    const app = application();
    const { company, transaction } = await fixture();
    const otherTransaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: 'other-route-operation',
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-07-02T00:00:00.000Z'),
        payee: 'Other Generic Route Fixture',
        amount: -9,
        bankAccount: 'Fixture Bank',
      },
    });
    const cookie = await signedIn(company.id, 'categorizer');
    const { staged } = await upload(app, company.id, cookie);
    const attached = await request(app)
      .post(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments`,
      )
      .set('Cookie', cookie)
      .send({
        idempotencyKey: 'route-operation-scope',
        sources: [{ kind: 'upload', uploadId: staged.id }],
      });
    const operationId = attached.body.operationId as string;
    const wrongBase =
      `/api/companies/${company.id}/transactions/${otherTransaction.id}`
      + `/attachments/operations/${operationId}`;

    await request(app).get(wrongBase).set('Cookie', cookie).expect(404);
    await request(app).post(`${wrongBase}/retry`).set('Cookie', cookie).send({}).expect(404);
    await request(app).post(`${wrongBase}/reconcile`).set('Cookie', cookie).send({}).expect(404);
  });

  it('allows viewer reads but gates upload/delete and admin-only retention changes', async () => {
    const app = application();
    const { company, transaction } = await fixture();
    const categorizer = await signedIn(company.id, 'categorizer');
    const viewer = await signedIn(company.id, 'viewer');
    const admin = await signedIn(company.id, 'admin');
    const { staged } = await upload(app, company.id, categorizer);
    const attached = await request(app)
      .post(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments`,
      )
      .set('Cookie', categorizer)
      .send({
        idempotencyKey: 'route-role-attach',
        sources: [{ kind: 'upload', uploadId: staged.id }],
      });
    const attachmentId = attached.body.files[0].id as string;

    await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments`,
      )
      .set('Cookie', viewer)
      .expect(200);
    await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/download`,
      )
      .set('Cookie', viewer)
      .expect(200);
    await request(app)
      .post(`/api/companies/${company.id}/attachment-upload-grants`)
      .set('Cookie', viewer)
      .send({})
      .expect(403);
    await request(app)
      .delete(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}?scope=local&idempotencyKey=viewer-delete`,
      )
      .set('Cookie', viewer)
      .expect(403);

    await request(app)
      .patch(`/api/companies/${company.id}`)
      .set('Cookie', categorizer)
      .send({ retainAttachmentFiles: false })
      .expect(403);
    const patched = await request(app)
      .patch(`/api/companies/${company.id}`)
      .set('Cookie', admin)
      .send({ retainAttachmentFiles: false });
    expect(patched.status).toBe(200);
    expect(patched.body.retainAttachmentFiles).toBe(false);
  });

  it('exposes exact usage and restricts quota overrides to instance admins', async () => {
    const app = application();
    const { company } = await fixture();
    const viewer = await signedIn(company.id, 'viewer');
    const companyAdmin = await signedIn(company.id, 'admin');
    const instanceAdmin = await signedIn(company.id, 'admin', true);
    const categorizer = await signedIn(company.id, 'categorizer');

    const initial = await request(app)
      .get(`/api/companies/${company.id}/attachment-storage-policy`)
      .set('Cookie', viewer);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      companyQuotaBytes: '1073741824',
      instanceQuotaBytes: '10737418240',
      companyUsageBytes: '0',
      retentionDays: 365,
      companyQuotaOverrideBytes: null,
    });

    await request(app)
      .patch(`/api/companies/${company.id}`)
      .set('Cookie', companyAdmin)
      .send({ attachmentQuotaBytes: '1048576' })
      .expect(403);

    const patched = await request(app)
      .patch(`/api/companies/${company.id}`)
      .set('Cookie', instanceAdmin)
      .send({
        attachmentQuotaBytes: '1048576',
        attachmentRetentionDays: 30,
      });
    expect(patched.status).toBe(200);

    const policy = await request(app)
      .get(`/api/companies/${company.id}/attachment-storage-policy`)
      .set('Cookie', viewer);
    expect(policy.body).toMatchObject({
      companyQuotaBytes: '1048576',
      companyUsageBytes: '0',
      retentionDays: 30,
      companyQuotaOverrideBytes: '1048576',
      companyRetentionOverrideDays: 30,
    });

    const grantResponse = await request(app)
      .post(`/api/companies/${company.id}/attachment-upload-grants`)
      .set('Cookie', categorizer)
      .send({});
    const pdfHeader = Buffer.from('%PDF-1.7\n');
    const rejected = await request(app)
      .post(grantResponse.body.uploadUrl as string)
      .set('Authorization', `Bearer ${grantResponse.body.grant as string}`)
      .attach('files', Buffer.concat([
        pdfHeader,
        Buffer.alloc(1_048_577 - pdfHeader.byteLength, 7),
      ]), {
        filename: 'over-quota.pdf',
        contentType: 'application/pdf',
      });
    expect(rejected.status).toBe(413);
    expect(rejected.body).toMatchObject({
      code: 'ATTACHMENT_COMPANY_QUOTA_EXCEEDED',
    });
  }, 30_000);

  it('persists bounded instance defaults through the instance-admin API', async () => {
    const app = application();
    const { company } = await fixture();
    const companyAdmin = await signedIn(company.id, 'admin');
    const instanceAdmin = await signedIn(company.id, 'admin', true);

    await request(app)
      .get('/api/instance/attachment-storage-policy')
      .set('Cookie', companyAdmin)
      .expect(403);

    const patched = await request(app)
      .patch('/api/instance/attachment-storage-policy')
      .set('Cookie', instanceAdmin)
      .send({
        companyQuotaBytes: '2097152',
        instanceQuotaBytes: '4194304',
        retentionDays: 60,
      });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      companyQuotaBytes: '2097152',
      instanceQuotaBytes: '4194304',
      instanceUsageBytes: '0',
      retentionDays: 60,
    });

    const stored = await db.appConfig.findMany({
      where: { key: { in: Object.values(ATTACHMENT_POLICY_CONFIG_KEYS) } },
      orderBy: { key: 'asc' },
      select: { key: true, value: true, encrypted: true },
    });
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => row.encrypted === false)).toBe(true);

    await request(app)
      .patch('/api/instance/attachment-storage-policy')
      .set('Cookie', instanceAdmin)
      .send({ instanceQuotaBytes: '1048575' })
      .expect(400);
  });

  it('refreshes provider-only metadata and saves external bytes locally', async () => {
    const app = application();
    const { company, transaction } = await fixture();
    const cookie = await signedIn(company.id, 'categorizer');
    const content = Buffer.from('%PDF-1.7\nexternal route fixture');
    getMockRealm(MOCK_REALM_HARBOR).attachments.push({
      id: 'route-external',
      syncToken: '0',
      filename: 'external.pdf',
      contentType: 'application/pdf',
      sizeBytes: content.byteLength,
      note: null,
      refs: [{ qboType: 'Purchase', qboId: '2' }],
      contentBase64: content.toString('base64'),
    });

    const refreshed = await request(app)
      .post(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/refresh`,
      )
      .set('Cookie', cookie)
      .send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject([{
      filename: 'external.pdf',
      sourceKind: 'QBO_EXTERNAL',
      retainedLocally: false,
    }]);
    const attachmentId = refreshed.body[0].id as string;

    const saved = await request(app)
      .post(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/save-local`,
      )
      .set('Cookie', cookie)
      .send({});
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      id: attachmentId,
      retainedLocally: true,
      sourceKind: 'QBO_EXTERNAL',
    });

    const downloaded = await request(app)
      .get(
        `/api/companies/${company.id}/transactions/${transaction.id}/attachments/${attachmentId}/download`,
      )
      .set('Cookie', cookie)
      .buffer(true);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body).toEqual(content);
  });

  it('does not leak transaction or attachment existence across company scopes', async () => {
    const app = application();
    const first = await fixture();
    await db.company.update({
      where: { id: first.company.id },
      data: { realmId: `route-first-${randomUUID()}` },
    });
    const second = await fixture();
    const firstUser = await signedIn(first.company.id, 'admin');

    await request(app)
      .get(
        `/api/companies/${first.company.id}/transactions/${second.transaction.id}/attachments`,
      )
      .set('Cookie', firstUser)
      .expect(404);
    await request(app)
      .get(
        `/api/companies/${second.company.id}/transactions/${second.transaction.id}/attachments`,
      )
      .set('Cookie', firstUser)
      .expect(403);
  });
});
