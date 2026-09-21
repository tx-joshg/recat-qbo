import type { ReceiptSourceKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { AttachmentActor } from '../attachments/operations.js';
import {
  createReceipts,
  type ReceiptIntakeDeps,
} from './intake.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const SHA256 = 'a'.repeat(64);

interface FakeState {
  staged: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function actor(role = 'categorizer'): AttachmentActor {
  return {
    kind: 'session',
    actorKey: 'session:synthetic-user',
    userId: 'synthetic-user',
    isInstanceAdmin: false,
    memberships: [{ companyId: 'company-1', role }],
  };
}

function staged(
  contentType = 'image/png',
  id = 'upload-1',
): Record<string, unknown> {
  return {
    id,
    companyId: 'company-1',
    actorKey: 'session:synthetic-user',
    blobId: 'blob-1',
    originalFilename: 'synthetic.png',
    contentType,
    sizeBytes: 4n,
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    createdAt: NOW,
    blob: { id: 'blob-1', sha256: SHA256 },
    company: { id: 'company-1', retainAttachmentFiles: true },
  };
}

function input(
  overrides: Partial<{
    contentType: string;
    uploadId: string;
    idempotencyKey: string;
    sourceKind: ReceiptSourceKind;
  }> = {},
) {
  return {
    actor: actor(),
    companyId: 'company-1',
    files: [{ uploadId: overrides.uploadId ?? 'upload-1' }],
    sourceKind: overrides.sourceKind ?? 'WEB_UPLOAD' as const,
    idempotencyKey: overrides.idempotencyKey ?? 'receipt-create-1',
  };
}

function dependencies(contentType = 'image/png') {
  const state: FakeState = {
    staged: [staged(contentType)],
    receipts: [],
    jobs: [],
    operations: [],
    events: [],
  };
  let receiptSequence = 0;

  const db = {
    receiptIntakeOperation: {
      findUnique: async ({ where }: any) =>
        state.operations.find((operation) =>
          operation.actorKey === where.actorKey_companyId_idempotencyKey.actorKey
          && operation.companyId === where.actorKey_companyId_idempotencyKey.companyId
          && operation.idempotencyKey
            === where.actorKey_companyId_idempotencyKey.idempotencyKey,
        ) ?? null,
      create: async ({ data }: any) => {
        const operation = { id: `operation-${state.operations.length + 1}`, ...data };
        state.operations.push(operation);
        return operation;
      },
    },
    stagedAttachment: {
      findMany: async ({ where }: any) =>
        state.staged.filter((file) =>
          where.id.in.includes(file.id)
          && file.companyId === where.companyId
          && file.actorKey === where.actorKey
          && file.consumedAt === null
          && (file.expiresAt as Date) > where.expiresAt.gt,
        ),
      update: async ({ where, data }: any) => {
        const file = state.staged.find((candidate) => candidate.id === where.id)!;
        Object.assign(file, data);
        return file;
      },
    },
    receiptDocument: {
      findFirst: async ({ where }: any) => {
        if (where.sourceExternalId !== undefined) {
          return state.receipts.find((receipt) =>
            receipt.companyId === where.companyId
            && receipt.sourceKind === where.sourceKind
            && receipt.sourceExternalId === where.sourceExternalId,
          ) ?? null;
        }
        return state.receipts.find((receipt) =>
          receipt.companyId === where.companyId
          && where.OR.some((clause: any) =>
            ('blobId' in clause && receipt.blobId === clause.blobId)
            || ('sha256' in clause && receipt.sha256 === clause.sha256)),
        ) ?? null;
      },
      findMany: async ({ where }: any) =>
        state.receipts.filter((receipt) => where.id.in.includes(receipt.id)),
      create: async ({ data }: any) => {
        receiptSequence += 1;
        const receipt = {
          id: `receipt-${receiptSequence}`,
          ...data,
          createdAt: NOW,
          updatedAt: NOW,
          approvedAt: null,
          blobId: data.blobId,
          deletedAt: null,
          attempts: [],
        };
        if (data.jobs?.create) state.jobs.push(data.jobs.create);
        state.receipts.push(receipt);
        return receipt;
      },
    },
    receiptEvent: {
      create: async ({ data }: any) => {
        const event = { id: `event-${state.events.length + 1}`, ...data };
        state.events.push(event);
        return event;
      },
    },
  };

  const deps: ReceiptIntakeDeps = {
    now: () => NOW,
    configVersion: async () => 'b'.repeat(64),
    serializable: async (callback) => callback(db as never),
  };
  return { state, deps };
}

describe('receipt intake', () => {
  it.each([
    ['application/pdf'],
    ['image/jpeg'],
    ['image/png'],
    ['image/gif'],
    ['image/tiff'],
  ])('accepts %s', async (contentType) => {
    const { deps } = dependencies(contentType);

    const result = await createReceipts(input({ contentType }), deps);

    expect(result.receipts[0]).toMatchObject({
      status: 'QUEUED',
      retentionPolicy: true,
      retainedLocally: true,
    });
  });

  it('rejects a staged Word document before consuming it', async () => {
    const { state, deps } = dependencies(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    await expect(createReceipts(input(), deps)).rejects.toMatchObject({
      code: 'RECEIPT_TYPE_UNSUPPORTED',
    });
    expect(state.staged[0]?.consumedAt).toBeNull();
  });

  it('snapshots retention off for this future upload only', async () => {
    const { state, deps } = dependencies();
    state.staged[0]!.company = {
      id: 'company-1',
      retainAttachmentFiles: false,
    };

    const result = await createReceipts(input(), deps);

    expect(result.receipts[0]).toMatchObject({
      retentionPolicy: false,
      retainedLocally: true,
    });
  });

  it('returns the existing document for the same company blob', async () => {
    const { state, deps } = dependencies();
    const first = await createReceipts(input(), deps);
    state.staged.push(staged('image/png', 'upload-2'));

    const second = await createReceipts(input({
      uploadId: 'upload-2',
      idempotencyKey: 'receipt-create-2',
    }), deps);

    expect(second.receipts[0]?.id).toBe(first.receipts[0]?.id);
    expect(state.jobs).toHaveLength(1);
  });

  it('records bounded intake history only for a newly created receipt', async () => {
    const { state, deps } = dependencies();
    await createReceipts(input(), deps);
    state.staged.push(staged('image/png', 'upload-2'));

    await createReceipts(input({
      uploadId: 'upload-2',
      idempotencyKey: 'receipt-create-2',
    }), deps);

    expect(state.events).toEqual([
      expect.objectContaining({
        companyId: 'company-1',
        documentId: 'receipt-1',
        actorUserId: 'synthetic-user',
        action: 'intake',
        after: {
          sourceKind: 'WEB_UPLOAD',
          status: 'QUEUED',
          retainLocally: true,
        },
      }),
    ]);
  });

  it('replays the same idempotency request and rejects a changed request', async () => {
    const { state, deps } = dependencies();
    const first = await createReceipts(input(), deps);

    await expect(createReceipts(input(), deps)).resolves.toEqual(first);
    state.staged.push(staged('image/png', 'upload-2'));
    await expect(createReceipts(input({ uploadId: 'upload-2' }), deps))
      .rejects.toMatchObject({ code: 'RECEIPT_IDEMPOTENCY_CONFLICT' });
  });

  it('rejects duplicate external source keys in one request', async () => {
    const { deps } = dependencies();

    await expect(createReceipts({
      ...input(),
      files: [
        { uploadId: 'upload-1', sourceExternalId: 'external-1' },
        { uploadId: 'upload-2', sourceExternalId: 'external-1' },
      ],
    }, deps)).rejects.toMatchObject({ code: 'RECEIPT_INVALID_INPUT' });
  });

  it('rejects an external source key reused for different content', async () => {
    const { state, deps } = dependencies();
    await createReceipts({
      ...input(),
      files: [{ uploadId: 'upload-1', sourceExternalId: 'external-1' }],
    }, deps);
    state.staged.push({
      ...staged('image/png', 'upload-2'),
      blobId: 'blob-2',
      blob: { id: 'blob-2', sha256: 'd'.repeat(64) },
    });

    await expect(createReceipts({
      ...input({
        uploadId: 'upload-2',
        idempotencyKey: 'receipt-create-2',
      }),
      files: [{ uploadId: 'upload-2', sourceExternalId: 'external-1' }],
    }, deps)).rejects.toMatchObject({
      code: 'RECEIPT_IDEMPOTENCY_CONFLICT',
    });
  });

  it('rejects assigning a new external identity to existing content', async () => {
    const { state, deps } = dependencies();
    await createReceipts(input(), deps);
    state.staged.push(staged('image/png', 'upload-2'));

    await expect(createReceipts({
      ...input({
        uploadId: 'upload-2',
        idempotencyKey: 'receipt-create-2',
        sourceKind: 'API_UPLOAD',
      }),
      files: [{
        uploadId: 'upload-2',
        sourceExternalId: 'external-new',
      }],
    }, deps)).rejects.toMatchObject({
      code: 'RECEIPT_IDEMPOTENCY_CONFLICT',
    });
  });

  it('retries a concurrent unique race and reloads the winning receipt', async () => {
    const { state, deps } = dependencies();
    const delegate = deps.serializable!;
    let attempts = 0;
    (deps as { serializable: typeof delegate }).serializable = (async (callback: Parameters<typeof delegate>[0]) => {
      attempts += 1;
      if (attempts === 1) throw { code: 'P2002' };
      return delegate(callback);
    }) as typeof delegate;

    await expect(createReceipts(input(), deps)).resolves.toMatchObject({
      receipts: [expect.objectContaining({ id: 'receipt-1' })],
    });
    expect(attempts).toBe(2);
    expect(state.jobs).toHaveLength(1);
  });

  it('does not return a soft-deleted duplicate as an active receipt', async () => {
    const { state, deps } = dependencies();
    await createReceipts(input(), deps);
    state.receipts[0]!.deletedAt = NOW;
    state.staged.push(staged('image/png', 'upload-2'));

    await expect(createReceipts(input({
      uploadId: 'upload-2',
      idempotencyKey: 'receipt-create-2',
    }), deps)).rejects.toMatchObject({
      code: 'RECEIPT_IDEMPOTENCY_CONFLICT',
    });
  });
});
