import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  getMockRealm,
  MockQboClient,
  MOCK_REALM_HARBOR,
  resetMockRealms,
} from '../../lib/qbo/mock.js';
import { stageAttachment } from './blobStore.js';
import {
  attachTransactionFiles,
  deleteTransactionAttachment,
  refreshTransactionAttachments,
  reconcileAttachmentOperation,
  reconcileReceiptAttachmentOperation,
  recoverStuckAttachmentOperations,
  retryAttachmentOperation,
  saveExternalAttachmentLocally,
  type AttachmentActor,
  type AttachmentOperationDependencies,
} from './operations.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

function pdf(content: string): Uint8Array {
  return Buffer.from(`%PDF-1.7\n${content}`);
}

async function* chunks(content: Uint8Array) {
  yield content.subarray(0, Math.min(5, content.byteLength));
  yield content.subarray(Math.min(5, content.byteLength));
}

describePostgres('attachment operation PostgreSQL lifecycle', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  beforeEach(() => {
    resetMockRealms();
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

  async function fixture(retainAttachmentFiles = true) {
    const company = await db.company.create({
      data: {
        realmId: `attachment-operation-${randomUUID()}`,
        legalName: 'Attachment Operation Fixture',
        nickname: 'Attachment Fixture',
        retainAttachmentFiles,
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
        payee: 'Generic Fixture',
        amount: -10,
        bankAccount: 'Fixture Bank',
      },
    });
    const actor: AttachmentActor = {
      kind: 'session',
      actorKey: `session:${randomUUID()}`,
      userId: randomUUID(),
      isInstanceAdmin: false,
      memberships: [{ companyId: company.id, role: 'categorizer' }],
    };
    const qbo = new MockQboClient(MOCK_REALM_HARBOR, ['4']);
    const deps: AttachmentOperationDependencies = {
      db,
      qboForCompany: async () => qbo,
    };
    return { company, transaction, actor, qbo, deps };
  }

  async function stage(
    companyId: string,
    actorKey: string,
    label: string,
    retainLocally = true,
  ) {
    return stageAttachment({
      companyId,
      actorKey,
      sourceKind: 'LOCAL_UPLOAD',
      retainLocally,
      filename: `${label}.pdf`,
      declaredContentType: 'application/pdf',
      content: chunks(pdf(label)),
      expiresAt: new Date(Date.now() + 60_000),
    }, { db });
  }

  it('attaches an authorized receipt blob without a staged-file copy', async () => {
    const context = await fixture();
    const content = pdf('internal receipt source');
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: context.company.id,
        state: 'READY',
        sha256: '6'.repeat(64),
        sizeBytes: BigInt(content.byteLength),
        contentType: 'application/pdf',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
        chunks: { create: { ordinal: 0, content: Buffer.from(content) } },
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: context.company.id,
        blobId: blob.id,
        originalFilename: 'internal-receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: BigInt(content.byteLength),
        sha256: '6'.repeat(64),
        sourceKind: 'WEB_UPLOAD',
        status: 'MATCHED',
        matchedTransactionId: context.transaction.id,
        matchedTransactionRevision: context.transaction.revision,
      },
    });

    const result = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'receipt-source-1',
      sources: [{
        kind: 'receipt',
        documentId: receipt.id,
        blobId: blob.id,
        filename: receipt.originalFilename,
        contentType: receipt.contentType,
        sizeBytes: receipt.sizeBytes,
        sha256: receipt.sha256,
        retainLocally: true,
      }],
    }, context.deps);

    expect(result.status).toBe('VERIFIED');
    await expect(db.attachmentOperation.findUniqueOrThrow({
      where: { id: result.operationId },
      select: { receiptDocumentId: true },
    })).resolves.toEqual({ receiptDocumentId: receipt.id });
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: result.files[0]!.id },
      select: { blobId: true, retainLocally: true },
    })).resolves.toEqual({ blobId: blob.id, retainLocally: true });
    await expect(db.stagedAttachment.count({
      where: { companyId: context.company.id },
    })).resolves.toBe(0);
    await db.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        status: 'ATTACHED',
        transactionAttachmentId: result.files[0]!.id,
      },
    });

    const deleted = await deleteTransactionAttachment({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      attachmentId: result.files[0]!.id,
      scope: 'everywhere',
      idempotencyKey: `receipt-undo:${receipt.id}:1`,
      receiptDocumentId: receipt.id,
    }, context.deps);
    expect(deleted.status).toBe('DELETED');
    await expect(db.attachmentOperation.findUniqueOrThrow({
      where: { id: deleted.operationId },
      select: { receiptDocumentId: true },
    })).resolves.toEqual({ receiptDocumentId: receipt.id });
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: receipt.id },
      select: { blobId: true },
    })).resolves.toEqual({ blobId: blob.id });
    await expect(db.attachmentBlob.findUnique({
      where: { id: blob.id },
    })).resolves.not.toBeNull();
  });

  it('replays exactly, rejects changed inputs, and retries only failed partial files', async () => {
    const context = await fixture();
    const first = await stage(
      context.company.id,
      context.actor.actorKey,
      'first',
    );
    const second = await stage(
      context.company.id,
      context.actor.actorKey,
      'second',
    );
    getMockRealm(MOCK_REALM_HARBOR).attachmentUploadFaults['1'] = {
      code: 'REJECTED',
      message: 'configured failure',
    };
    const input = {
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'partial-1',
      sources: [
        { kind: 'upload' as const, uploadId: first.id },
        { kind: 'upload' as const, uploadId: second.id },
      ],
    };

    const partial = await attachTransactionFiles(input, context.deps);
    expect(partial.status).toBe('PARTIAL');
    const providerAfterFirst = getMockRealm(MOCK_REALM_HARBOR).attachments;
    expect(providerAfterFirst).toHaveLength(1);

    await db.stagedAttachment.deleteMany({
      where: { id: { in: [first.id, second.id] } },
    });
    await expect(attachTransactionFiles(input, context.deps)).resolves.toEqual(
      partial,
    );
    expect(providerAfterFirst).toHaveLength(1);

    const different = await stage(
      context.company.id,
      context.actor.actorKey,
      'different',
    );
    await expect(attachTransactionFiles({
      ...input,
      sources: [{ kind: 'upload', uploadId: different.id }],
    }, context.deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    delete getMockRealm(MOCK_REALM_HARBOR).attachmentUploadFaults['1'];
    const complete = await retryAttachmentOperation(
      context.actor,
      partial.operationId,
      context.deps,
    );
    expect(complete.status).toBe('VERIFIED');
    expect(providerAfterFirst).toHaveLength(2);
    expect(new Set(providerAfterFirst.map((row) => row.note)).size).toBe(2);
  });

  it.each([
    {
      label: 'attach',
      kind: 'ATTACH' as const,
      idempotencyKey: `receipt-attach:${randomUUID()}:1`,
      attachmentStatus: 'FAILED' as const,
    },
    {
      label: 'undo',
      kind: 'DELETE_EVERYWHERE' as const,
      idempotencyKey: `receipt-undo:${randomUUID()}:1`,
      attachmentStatus: 'ATTACHED' as const,
    },
  ])(
    'requires the receipt workflow to retry a failed $label operation',
    async ({ kind, idempotencyKey, attachmentStatus }) => {
      const context = await fixture();
      const attachment = await db.transactionAttachment.create({
        data: {
          companyId: context.company.id,
          transactionId: context.transaction.id,
          originalFilename: 'receipt-managed.pdf',
          contentType: 'application/pdf',
          sizeBytes: 8n,
          sha256: 'a'.repeat(64),
          sourceKind: 'LOCAL_UPLOAD',
          retainLocally: false,
          status: attachmentStatus,
          qboAttachableId: kind === 'DELETE_EVERYWHERE'
            ? 'receipt-managed-qbo-id'
            : null,
          qboSyncToken: kind === 'DELETE_EVERYWHERE' ? '0' : null,
          recatMarker: randomUUID(),
        },
      });
      const receipt = await db.receiptDocument.create({
        data: {
          companyId: context.company.id,
          originalFilename: 'receipt-managed.pdf',
          contentType: 'application/pdf',
          sizeBytes: attachment.sizeBytes,
          sha256: randomUUID().replaceAll('-', '').repeat(2),
          sourceKind: 'WEB_UPLOAD',
          status: kind === 'ATTACH' ? 'MATCHED' : 'ATTACHED',
          matchedTransactionId: context.transaction.id,
          matchedTransactionRevision: context.transaction.revision,
          transactionAttachmentId: kind === 'DELETE_EVERYWHERE'
            ? attachment.id
            : null,
        },
      });
      const operation = await db.attachmentOperation.create({
        data: {
          kind,
          actorKey: context.actor.actorKey,
          companyId: context.company.id,
          transactionId: context.transaction.id,
          receiptDocumentId: receipt.id,
          idempotencyKey,
          requestHash: 'b'.repeat(64),
          inputHash: 'c'.repeat(64),
          status: 'FAILED',
          fileCount: 1,
          totalBytes: attachment.sizeBytes,
          files: {
            create: {
              attachmentId: attachment.id,
              ordinal: 0,
              status: 'FAILED',
              errorCode: 'PROVIDER_REJECTED',
            },
          },
        },
      });

      await expect(retryAttachmentOperation(
        context.actor,
        operation.id,
        context.deps,
      )).rejects.toMatchObject({
        code: 'ATTACHMENT_BUSY',
        message: expect.stringContaining('receipt workflow'),
      });
    },
  );

  it('reserves receipt idempotency keys from public attachment sources', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'reserved-prefix',
    );

    await expect(attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: `receipt-attach:${randomUUID()}:1`,
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps)).rejects.toMatchObject({
      code: 'ATTACHMENT_INVALID_INPUT',
    });
  });

  it('replays a concurrent identical request after staging handoff', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'concurrent-replay',
    );
    const input = {
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'concurrent-replay',
      sources: [{ kind: 'https' as const, url: 'https://example.test/file.pdf' }],
    };
    let releaseFirstImport = () => {};
    const firstImportCanFinish = new Promise<void>((resolve) => {
      releaseFirstImport = resolve;
    });
    let markFirstImportSeen = () => {};
    const firstImportSeen = new Promise<void>((resolve) => {
      markFirstImportSeen = resolve;
    });
    let importCalls = 0;
    const deps: AttachmentOperationDependencies = {
      ...context.deps,
      importHttps: async () => {
        if (importCalls++ === 0) {
          markFirstImportSeen();
          await firstImportCanFinish;
        }
        return staged;
      }
    };

    const delayed = attachTransactionFiles(input, deps);
    await firstImportSeen;
    let winner;
    try {
      winner = await attachTransactionFiles(input, deps);
    } finally {
      releaseFirstImport();
    }
    const replay = await delayed;

    expect(replay).toEqual(winner);
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
    await expect(db.stagedAttachment.findUnique({
      where: { id: staged.id },
    })).resolves.toBeNull();
  });

  it('preserves the retention policy captured when bytes were staged', async () => {
    const keep = await fixture(true);
    const stagedKeep = await stage(
      keep.company.id,
      keep.actor.actorKey,
      'keep-policy',
      true,
    );
    await db.company.update({
      where: { id: keep.company.id },
      data: { retainAttachmentFiles: false },
    });
    const kept = await attachTransactionFiles({
      actor: keep.actor,
      companyId: keep.company.id,
      transactionId: keep.transaction.id,
      idempotencyKey: 'keep-policy',
      sources: [{ kind: 'upload', uploadId: stagedKeep.id }],
    }, keep.deps);
    expect(kept.files[0]?.retainedLocally).toBe(true);
    expect(await db.stagedAttachment.findUnique({
      where: { id: stagedKeep.id },
    })).toBeNull();
    expect(await db.attachmentBlob.findFirst({
      where: {
        companyId: keep.company.id,
        sha256: stagedKeep.sha256,
      },
    })).not.toBeNull();

    const release = await fixture(false);
    const stagedRelease = await stage(
      release.company.id,
      release.actor.actorKey,
      'release-policy',
      false,
    );
    await db.company.update({
      where: { id: release.company.id },
      data: { retainAttachmentFiles: true },
    });
    const released = await attachTransactionFiles({
      actor: release.actor,
      companyId: release.company.id,
      transactionId: release.transaction.id,
      idempotencyKey: 'release-policy',
      sources: [{ kind: 'upload', uploadId: stagedRelease.id }],
    }, release.deps);
    expect(released.files[0]?.retainedLocally).toBe(false);
    expect(await db.stagedAttachment.findUnique({
      where: { id: stagedRelease.id },
    })).toBeNull();
    expect(await db.attachmentBlob.findFirst({
      where: {
        companyId: release.company.id,
        sha256: stagedRelease.sha256,
      },
    })).toBeNull();
  });

  it('serializes deletion against an in-flight upload', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'serialized',
    );
    const originalUpload = context.qbo.uploadAttachments.bind(context.qbo);
    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    context.qbo.uploadAttachments = async (...args) => {
      uploadStarted();
      await gate;
      return originalUpload(...args);
    };

    const attaching = attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'serialized-attach',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    await started;
    const changing = await db.transactionAttachment.findFirstOrThrow({
      where: {
        companyId: context.company.id,
        transactionId: context.transaction.id,
      },
    });
    await expect(deleteTransactionAttachment({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      attachmentId: changing.id,
      scope: 'everywhere',
      idempotencyKey: 'serialized-delete',
    }, context.deps)).rejects.toMatchObject({ code: 'ATTACHMENT_BUSY' });
    releaseUpload();
    await expect(attaching).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
  });

  it('recovers a stale post-send upload by marker without resending it', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'recover-marker',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'recover-marker',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const attachmentId = attached.files[0]!.id;
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await db.$transaction([
      db.attachmentOperation.update({
        where: { id: attached.operationId },
        data: { status: 'COMMITTING', updatedAt: stale },
      }),
      db.attachmentOperationFile.update({
        where: {
          operationId_attachmentId: {
            operationId: attached.operationId,
            attachmentId,
          },
        },
        data: { status: 'UPLOADING', updatedAt: stale },
      }),
      db.transactionAttachment.update({
        where: { id: attachmentId },
        data: { status: 'UPLOADING', updatedAt: stale },
      }),
    ]);

    await expect(recoverStuckAttachmentOperations({
      now: new Date(),
    }, context.deps)).resolves.toEqual({ inspected: 1, recovered: 1 });
    await expect(db.attachmentOperation.findUniqueOrThrow({
      where: { id: attached.operationId },
      select: { status: true },
    })).resolves.toEqual({ status: 'VERIFIED' });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
  });

  it('recovers a stale provider deletion by verifying absence', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'recover-delete',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'recover-delete-attach',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const attachment = await db.transactionAttachment.findUniqueOrThrow({
      where: { id: attached.files[0]!.id },
    });
    await context.qbo.deleteAttachment({
      id: attachment.qboAttachableId!,
      syncToken: attachment.qboSyncToken!,
      requestId: 'recover-delete-provider',
    });
    const operationId = randomUUID();
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await db.$transaction([
      db.attachmentOperation.create({
        data: {
          id: operationId,
          kind: 'DELETE_EVERYWHERE',
          actorKey: context.actor.actorKey,
          companyId: context.company.id,
          transactionId: context.transaction.id,
          idempotencyKey: 'recover-delete-operation',
          requestHash: 'c'.repeat(64),
          inputHash: 'c'.repeat(64),
          status: 'DELETING',
          fileCount: 1,
          totalBytes: attachment.sizeBytes,
          createdAt: stale,
          updatedAt: stale,
          files: {
            create: {
              attachmentId: attachment.id,
              ordinal: 0,
              status: 'DELETING',
              createdAt: stale,
              updatedAt: stale,
            },
          },
        },
      }),
      db.transactionAttachment.update({
        where: { id: attachment.id },
        data: { status: 'DELETING', updatedAt: stale },
      }),
    ]);

    await expect(recoverStuckAttachmentOperations({
      now: new Date(),
    }, context.deps)).resolves.toEqual({ inspected: 1, recovered: 1 });
    await expect(db.attachmentOperation.findUniqueOrThrow({
      where: { id: operationId },
      select: { status: true },
    })).resolves.toEqual({ status: 'DELETED' });
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: attachment.id },
      select: { status: true, blobId: true },
    })).resolves.toEqual({ status: 'DELETED', blobId: null });
  });

  it('keeps bytes on timeout and reconciles the exact accepted marker without resending', async () => {
    const context = await fixture(false);
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'uncertain',
      false,
    );
    getMockRealm(MOCK_REALM_HARBOR).attachmentTimeoutAfterAccept = true;

    const uncertain = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'uncertain-1',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);

    expect(uncertain.status).toBe('UNCERTAIN');
    expect(uncertain.files[0]).toMatchObject({ retainedLocally: true });
    await expect(retryAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    )).rejects.toMatchObject({ code: 'ATTACHMENT_PROVIDER_UNCERTAIN' });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);

    const reconciled = await reconcileAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    );
    expect(reconciled.status).toBe('VERIFIED');
    expect(reconciled.files[0]).toMatchObject({
      status: 'ATTACHED',
      retainedLocally: false,
    });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
  });

  it('reconciles an uncertain receipt operation only through the receipt workflow', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'receipt-uncertain',
    );
    const stagedRow = await db.stagedAttachment.findUniqueOrThrow({
      where: { id: staged.id },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: context.company.id,
        blobId: stagedRow.blobId,
        originalFilename: staged.filename,
        contentType: staged.contentType,
        sizeBytes: BigInt(staged.sizeBytes),
        sha256: staged.sha256,
        sourceKind: 'WEB_UPLOAD',
        status: 'MATCHED',
        matchedTransactionId: context.transaction.id,
        matchedTransactionRevision: context.transaction.revision,
      },
    });
    getMockRealm(MOCK_REALM_HARBOR).attachmentTimeoutAfterAccept = true;
    const uncertain = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: `receipt-attach:${randomUUID()}:1`,
      sources: [{
        kind: 'receipt',
        documentId: receipt.id,
        blobId: stagedRow.blobId,
        filename: receipt.originalFilename,
        contentType: receipt.contentType,
        sizeBytes: receipt.sizeBytes,
        sha256: receipt.sha256,
        retainLocally: true,
      }],
    }, context.deps);
    expect(uncertain.status).toBe('UNCERTAIN');

    await expect(reconcileAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    )).rejects.toMatchObject({
      code: 'ATTACHMENT_BUSY',
      message: expect.stringContaining('receipt workflow'),
    });

    const reconciled = await reconcileReceiptAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    );
    expect(reconciled.status).toBe('VERIFIED');
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
  });

  it('never makes accepted provider outcomes retryable after a local persistence failure', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'persist-failure',
    );
    let transactionCalls = 0;
    const faultedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (...args: Parameters<PrismaClient['$transaction']>) => {
            transactionCalls += 1;
            if (transactionCalls === 3) {
              throw new Error('injected persistence failure');
            }
            return Reflect.apply(target.$transaction, target, args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const faultedDeps: AttachmentOperationDependencies = {
      ...context.deps,
      db: faultedDb,
    };

    const uncertain = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'persist-failure',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, faultedDeps);
    expect(uncertain).toMatchObject({
      status: 'UNCERTAIN',
      actions: { canRetry: false, requiresReconciliation: true },
    });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);

    await expect(reconcileAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    )).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(getMockRealm(MOCK_REALM_HARBOR).attachments).toHaveLength(1);
  });

  it('fails closed when two provider records carry the exact same marker', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'ambiguous',
    );
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    realm.attachmentTimeoutAfterAccept = true;
    const uncertain = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'ambiguous-1',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    realm.attachments.push({
      ...structuredClone(realm.attachments[0]!),
      id: 'duplicate-attachment',
    });

    const reconciled = await reconcileAttachmentOperation(
      context.actor,
      uncertain.operationId,
      context.deps,
    );
    expect(reconciled.status).toBe('UNCERTAIN');
    expect(reconciled.files[0]?.error?.code).toBe(
      'ATTACHMENT_PROVIDER_AMBIGUOUS',
    );
  });

  it('supports local-only and verified provider deletion with distinct durable operations', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'delete',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'attach-delete',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const attachmentId = attached.files[0]!.id;
    const providerId = (
      await db.transactionAttachment.findUniqueOrThrow({
        where: { id: attachmentId },
        select: { qboAttachableId: true },
      })
    ).qboAttachableId!;

    const local = await deleteTransactionAttachment({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      attachmentId,
      scope: 'local',
      idempotencyKey: 'delete-local',
    }, context.deps);
    expect(local.status).toBe('DELETED');
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { blobId: true, qboAttachableId: true, status: true },
    })).resolves.toEqual({
      blobId: null,
      qboAttachableId: providerId,
      status: 'ATTACHED',
    });
    await expect(context.qbo.getAttachment(providerId)).resolves.not.toBeNull();

    const everywhere = await deleteTransactionAttachment({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      attachmentId,
      scope: 'everywhere',
      idempotencyKey: 'delete-everywhere',
    }, context.deps);
    expect(everywhere.status).toBe('DELETED');
    await expect(context.qbo.getAttachment(providerId)).resolves.toBeNull();
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { blobId: true, status: true },
    })).resolves.toEqual({ blobId: null, status: 'DELETED' });
  });

  it('treats an already-missing provider attachment as an idempotent verified deletion', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'missing',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'attach-missing',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const attachmentId = attached.files[0]!.id;
    const row = await db.transactionAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { qboAttachableId: true, qboSyncToken: true },
    });
    await context.qbo.deleteAttachment({
      id: row.qboAttachableId!,
      syncToken: row.qboSyncToken!,
      requestId: 'external-delete',
    });

    const deleted = await deleteTransactionAttachment({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      attachmentId,
      scope: 'everywhere',
      idempotencyKey: 'delete-missing',
    }, context.deps);
    expect(deleted.status).toBe('DELETED');
  });

  it('blocks a retry while the same operation is already claimed', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'busy',
    );
    getMockRealm(MOCK_REALM_HARBOR).attachmentUploadFaults['0'] = {
      code: 'REJECTED',
      message: 'configured failure',
    };
    const failed = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'busy-1',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    await db.attachmentOperation.update({
      where: { id: failed.operationId },
      data: { status: 'COMMITTING' },
    });

    await expect(retryAttachmentOperation(
      context.actor,
      failed.operationId,
      context.deps,
    )).rejects.toMatchObject({ code: 'ATTACHMENT_BUSY' });
  });

  it('discovers provider-only metadata and saves its bytes locally on demand', async () => {
    const context = await fixture();
    getMockRealm(MOCK_REALM_HARBOR).attachments.push({
      id: 'external-attachment',
      syncToken: '0',
      filename: 'external.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdf('external').byteLength,
      note: null,
      refs: [{ qboType: 'Purchase', qboId: '2' }],
      contentBase64: Buffer.from(pdf('external')).toString('base64'),
    });

    const refreshed = await refreshTransactionAttachments(
      context.actor,
      context.company.id,
      context.transaction.id,
      context.deps,
    );
    expect(refreshed).toMatchObject([{
      filename: 'external.pdf',
      sourceKind: 'QBO_EXTERNAL',
      retainedLocally: false,
      qboAttached: true,
    }]);
    const external = await db.transactionAttachment.findFirstOrThrow({
      where: {
        companyId: context.company.id,
        qboAttachableId: 'external-attachment',
      },
    });
    expect(external.blobId).toBeNull();

    const saved = await saveExternalAttachmentLocally(
      context.actor,
      context.company.id,
      context.transaction.id,
      external.id,
      context.deps,
    );
    expect(saved).toMatchObject({
      id: external.id,
      retainedLocally: true,
      sourceKind: 'QBO_EXTERNAL',
    });
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: external.id },
      select: { blobId: true, sha256: true, retainLocally: true },
    })).resolves.toMatchObject({
      blobId: expect.any(String),
      sha256: expect.not.stringMatching(/^0+$/u),
      retainLocally: true,
    });
  });

  it('marks provider deletion missing without dropping retained bytes', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'provider-missing',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'provider-missing',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const local = await db.transactionAttachment.findUniqueOrThrow({
      where: { id: attached.files[0]!.id },
    });
    await context.qbo.deleteAttachment({
      id: local.qboAttachableId!,
      syncToken: local.qboSyncToken!,
      requestId: 'provider-delete',
    });

    const refreshed = await refreshTransactionAttachments(
      context.actor,
      context.company.id,
      context.transaction.id,
      context.deps,
    );

    expect(refreshed[0]).toMatchObject({
      status: 'QBO_MISSING',
      retainedLocally: true,
      qboAttached: false,
    });
    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: local.id },
      select: { blobId: true, status: true },
    })).resolves.toEqual({ blobId: local.blobId, status: 'QBO_MISSING' });
  });

  it('does not let refresh overwrite an attachment in a concurrent local operation', async () => {
    const context = await fixture();
    const staged = await stage(
      context.company.id,
      context.actor.actorKey,
      'refresh-race',
    );
    const attached = await attachTransactionFiles({
      actor: context.actor,
      companyId: context.company.id,
      transactionId: context.transaction.id,
      idempotencyKey: 'refresh-race',
      sources: [{ kind: 'upload', uploadId: staged.id }],
    }, context.deps);
    const local = await db.transactionAttachment.findUniqueOrThrow({
      where: { id: attached.files[0]!.id },
    });
    await db.transactionAttachment.update({
      where: { id: local.id },
      data: { status: 'DELETING' },
    });
    await context.qbo.deleteAttachment({
      id: local.qboAttachableId!,
      syncToken: local.qboSyncToken!,
      requestId: 'race-delete',
    });

    await refreshTransactionAttachments(
      context.actor,
      context.company.id,
      context.transaction.id,
      context.deps,
    );

    await expect(db.transactionAttachment.findUniqueOrThrow({
      where: { id: local.id },
      select: { status: true },
    })).resolves.toEqual({ status: 'DELETING' });
  });
});
