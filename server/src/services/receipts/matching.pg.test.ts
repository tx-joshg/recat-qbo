import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import type { AttachmentActor } from '../attachments/operations.js';
import {
  attachMatchedReceipt,
  buildReceiptMatches,
  confirmReceiptMatch,
  rematchReceipt,
  undoAttachedReceipt,
  type ReceiptMatchingDeps,
} from './matching.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const BLOB_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z');

describePostgres('receipt matching persistence on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
    });
  });

  afterEach(async () => {
    const companies = [...companyIds];
    companyIds.clear();
    if (companies.length > 0) {
      await db.company.deleteMany({ where: { id: { in: companies } } });
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

  function deps(): ReceiptMatchingDeps {
    return {
      db,
      lease: async (_key, _owner, callback) => callback(),
    };
  }

  async function company(label: string) {
    const row = await db.company.create({
      data: {
        realmId: `receipt-match-${label}-${randomUUID()}`,
        legalName: `Synthetic ${label} Company`,
        nickname: `Synthetic ${label}`,
      },
    });
    companyIds.add(row.id);
    return row;
  }

  async function fixture(options: {
    autoMatchThreshold?: number;
    autoMatchMargin?: number;
    documentType?: string | null;
    totalAmount?: string | null;
    extractionConfidence?: number | null;
  } = {}) {
    const owner = await company('Owner');
    const user = await db.user.create({
      data: {
        email: `receipt-match-${randomUUID()}@example.invalid`,
        memberships: {
          create: { companyId: owner.id, role: 'categorizer' },
        },
      },
    });
    userIds.add(user.id);
    const sha256 = createHash('sha256')
      .update(randomUUID(), 'utf8')
      .digest('hex');
    const blob = await db.attachmentBlob.create({
      data: {
        companyId: owner.id,
        state: 'READY',
        sha256,
        sizeBytes: 3n,
        contentType: 'image/png',
        chunkCount: 1,
        expiresAt: BLOB_EXPIRES_AT,
      },
    });
    const receipt = await db.receiptDocument.create({
      data: {
        companyId: owner.id,
        blobId: blob.id,
        originalFilename: 'synthetic-receipt.png',
        contentType: 'image/png',
        sizeBytes: 3n,
        sha256,
        sourceKind: 'WEB_UPLOAD',
        status: 'READY',
        jobs: {
          create: {
            companyId: owner.id,
            generation: 1,
            configVersion: 'a'.repeat(64),
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
    const attempt = await db.receiptExtractionAttempt.create({
      data: {
        jobId: job.id,
        documentId: receipt.id,
        generation: 1,
        attemptCount: 1,
        status: 'succeeded',
        receiptDate: new Date('2026-07-30T00:00:00.000Z'),
        vendorName: 'Synthetic Office Supply',
        totalAmount: options.totalAmount === undefined
          ? '100.00'
          : options.totalAmount,
        currency: 'CAD',
        paymentIdentifier: '1234',
        documentType: options.documentType === undefined
          ? 'expense_receipt'
          : options.documentType,
        extractionConfidence: options.extractionConfidence === undefined
          ? 0.9
          : options.extractionConfidence,
        model: 'synthetic/model',
        promptVersion: 'synthetic-v1',
        schemaVersion: 'synthetic-v1',
        completedAt: new Date(),
      },
    });
    if (
      options.autoMatchThreshold !== undefined
      || options.autoMatchMargin !== undefined
    ) {
      await db.receiptCompanyConfig.create({
        data: {
          companyId: owner.id,
          autoMatchThreshold: options.autoMatchThreshold ?? 85,
          autoMatchMargin: options.autoMatchMargin ?? 15,
          configVersion: 'b'.repeat(64),
        },
      });
    }
    const actor: AttachmentActor = {
      kind: 'session',
      actorKey: `session:${user.id}`,
      userId: user.id,
      isInstanceAdmin: false,
      memberships: [{ companyId: owner.id, role: 'categorizer' }],
    };
    return { actor, attempt, owner, receipt };
  }

  async function transaction(
    companyId: string,
    options: {
      amount?: string;
      date?: string;
      payee?: string;
      status?: 'PENDING' | 'ERROR' | 'POSTED';
      revision?: number;
    } = {},
  ) {
    return db.transaction.create({
      data: {
        companyId,
        qboId: randomUUID(),
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date(`${options.date ?? '2026-07-30'}T00:00:00.000Z`),
        payee: options.payee ?? 'Synthetic Office Supply 1234',
        memo: 'Card ending 1234',
        amount: options.amount ?? '-100.00',
        bankAccount: 'Synthetic Bank',
        status: options.status ?? 'PENDING',
        revision: options.revision ?? 0,
        rawData: { CurrencyRef: { value: 'CAD' } },
      },
    });
  }

  it('considers only same-company pending/error transactions within 14 days', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    const pending = await transaction(value.owner.id);
    const error = await transaction(value.owner.id, {
      date: '2026-07-31',
      status: 'ERROR',
      payee: 'Synthetic Office Supply',
    });
    await transaction(value.owner.id, { date: '2026-08-14' });
    await transaction(value.owner.id, { status: 'POSTED' });
    const other = await company('Other');
    await transaction(other.id);

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.candidates.map((item) => item.transactionId))
      .toEqual([pending.id, error.id]);
    await expect(db.receiptMatchCandidate.count({
      where: { documentId: value.receipt.id },
    })).resolves.toBe(2);
  });

  it('applies the 100-row bound after direction compatibility', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    await db.transaction.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        companyId: value.owner.id,
        qboId: `wrong-direction-${index}-${randomUUID()}`,
        qboType: 'Deposit',
        qboSyncToken: '0',
        date: new Date('2026-07-30T00:00:00.000Z'),
        payee: 'Synthetic Office Supply',
        memo: null,
        amount: '100.00',
        bankAccount: 'Synthetic Bank',
        status: 'PENDING' as const,
        rawData: { CurrencyRef: { value: 'CAD' } },
      })),
    });
    const compatible = await transaction(value.owner.id, {
      date: '2026-07-29',
    });

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.candidates.map((candidate) => candidate.transactionId))
      .toContain(compatible.id);
  });

  it('finds an early-window match in a busy company by filtering on amount first', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    const early = await transaction(value.owner.id, { date: '2026-07-17' });
    await db.transaction.createMany({
      data: Array.from({ length: 150 }, (_, index) => ({
        companyId: value.owner.id,
        qboId: `busy-unrelated-${index}-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-08-12T00:00:00.000Z'),
        payee: 'Synthetic Other Vendor',
        memo: null,
        amount: `-${(200 + index).toFixed(2)}`,
        bankAccount: 'Synthetic Bank',
        status: 'PENDING' as const,
        rawData: { CurrencyRef: { value: 'CAD' } },
      })),
    });

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.candidates.map((candidate) => candidate.transactionId))
      .toEqual([early.id]);
  });

  it('auto-matches locally only when score and margin clear policy', async () => {
    const value = await fixture({
      autoMatchThreshold: 85,
      autoMatchMargin: 15,
    });
    const winner = await transaction(value.owner.id);
    await transaction(value.owner.id, {
      date: '2026-08-05',
      payee: 'Unrelated Counterparty',
    });

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.status).toBe('MATCHED');
    expect(result.matchedTransactionId).toBe(winner.id);
    expect(result.candidates.map((candidate) => candidate.state))
      .toEqual(['confirmed', 'rejected']);
  });

  it('keeps an ambiguous winner READY', async () => {
    const value = await fixture({
      autoMatchThreshold: 85,
      autoMatchMargin: 15,
    });
    await transaction(value.owner.id);
    await transaction(value.owner.id, {
      payee: 'Synthetic Office Supply',
    });

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.status).toBe('READY');
    expect(result.matchedTransactionId).toBeNull();
    expect(result.candidates.every((candidate) =>
      candidate.state === 'proposed')).toBe(true);
  });

  it('keeps a low-confidence extraction in NEEDS_REVIEW without auto-match', async () => {
    const value = await fixture({ extractionConfidence: 0.5 });
    await transaction(value.owner.id);

    const result = await buildReceiptMatches(
      value.receipt.id,
      1,
      deps(),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.matchedTransactionId).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.state).toBe('proposed');
  });

  it('marks a candidate stale when its transaction revision changes', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    const candidate = await transaction(value.owner.id);
    const built = await buildReceiptMatches(value.receipt.id, 1, deps());
    await db.transaction.update({
      where: { id: candidate.id },
      data: { revision: { increment: 1 } },
    });

    await expect(confirmReceiptMatch({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      transactionId: candidate.id,
      expectedReceiptRevision: built.revision,
      expectedTransactionRevision: candidate.revision,
    }, deps())).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    await expect(db.receiptMatchCandidate.findFirstOrThrow({
      where: {
        documentId: value.receipt.id,
        transactionId: candidate.id,
      },
      select: { state: true },
    })).resolves.toEqual({ state: 'stale' });
  });

  it('stales prior confirmed candidates that are no longer eligible on rematch', async () => {
    const value = await fixture();
    const winner = await transaction(value.owner.id);
    const built = await buildReceiptMatches(value.receipt.id, 1, deps());
    expect(built.status).toBe('MATCHED');
    await db.transaction.update({
      where: { id: winner.id },
      data: { status: 'POSTED', revision: { increment: 1 } },
    });

    const detail = await rematchReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: built.revision,
    }, deps());

    expect(detail.status).toBe('NEEDS_REVIEW');
    expect(detail.matchedTransactionId).toBeNull();
    expect(detail.candidates).toHaveLength(1);
    expect(detail.candidates[0]!.state).toBe('stale');
  });

  it('rejects rematch and confirmation while attachment work is in flight', async () => {
    const rematchValue = await fixture({ autoMatchThreshold: 101 });
    await transaction(rematchValue.owner.id);
    const rematchBuilt = await buildReceiptMatches(
      rematchValue.receipt.id,
      1,
      deps(),
    );
    await db.receiptDocument.update({
      where: { id: rematchValue.receipt.id },
      data: { status: 'ATTACHING' },
    });
    await expect(rematchReceipt({
      actor: rematchValue.actor,
      companyId: rematchValue.owner.id,
      documentId: rematchValue.receipt.id,
      expectedReceiptRevision: rematchBuilt.revision,
    }, deps())).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    const confirmValue = await fixture({ autoMatchThreshold: 101 });
    const candidate = await transaction(confirmValue.owner.id);
    const confirmBuilt = await buildReceiptMatches(
      confirmValue.receipt.id,
      1,
      deps(),
    );
    await db.receiptDocument.update({
      where: { id: confirmValue.receipt.id },
      data: { status: 'ATTACHED' },
    });
    await expect(confirmReceiptMatch({
      actor: confirmValue.actor,
      companyId: confirmValue.owner.id,
      documentId: confirmValue.receipt.id,
      transactionId: candidate.id,
      expectedReceiptRevision: confirmBuilt.revision,
      expectedTransactionRevision: candidate.revision,
    }, deps())).rejects.toMatchObject({ code: 'RECEIPT_STALE' });
  });

  it('rejects cross-company confirmation without changing the receipt', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    await transaction(value.owner.id);
    const built = await buildReceiptMatches(value.receipt.id, 1, deps());
    const other = await company('Other Confirmation');
    const foreign = await transaction(other.id);

    await expect(confirmReceiptMatch({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      transactionId: foreign.id,
      expectedReceiptRevision: built.revision,
      expectedTransactionRevision: foreign.revision,
    }, deps())).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { matchedTransactionId: true, revision: true },
    })).resolves.toEqual({
      matchedTransactionId: null,
      revision: built.revision,
    });
  });

  it('revision-fences rematch and permits only one concurrent confirmation', async () => {
    const value = await fixture({ autoMatchThreshold: 101 });
    const candidate = await transaction(value.owner.id);
    const built = await buildReceiptMatches(value.receipt.id, 1, deps());

    await expect(rematchReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: built.revision - 1,
    }, deps())).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    const input = {
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      transactionId: candidate.id,
      expectedReceiptRevision: built.revision,
      expectedTransactionRevision: candidate.revision,
    };
    const settled = await Promise.allSettled([
      confirmReceiptMatch(input, deps()),
      confirmReceiptMatch(input, deps()),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    expect(settled.map((result) => result.status === 'fulfilled'
      ? 'fulfilled'
      : (result.reason as { code?: string }).code ?? String(result.reason)))
      .toContain('RECEIPT_STALE');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: {
        matchedTransactionId: true,
        matchedTransactionRevision: true,
      },
    })).resolves.toEqual({
      matchedTransactionId: candidate.id,
      matchedTransactionRevision: candidate.revision,
    });
  });

  it('attaches a retained blob only after a confirmed current match', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    const seen: unknown[] = [];
    const operation = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: value.receipt.revision,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      attach: async (input) => {
        seen.push(input);
        const attachment = await db.transactionAttachment.create({
          data: {
            companyId: value.owner.id,
            transactionId: matched.id,
            blobId: value.receipt.blobId,
            originalFilename: value.receipt.originalFilename,
            contentType: value.receipt.contentType,
            sizeBytes: value.receipt.sizeBytes,
            sha256: value.receipt.sha256,
            sourceKind: 'LOCAL_UPLOAD',
            retainLocally: true,
            status: 'ATTACHED',
            qboAttachableId: 'synthetic-qbo-attachment',
            recatMarker: randomUUID(),
          },
        });
        return {
          operationId: randomUUID(),
          status: 'VERIFIED',
          files: [{
            id: attachment.id,
            transactionId: matched.id,
            filename: attachment.originalFilename,
            contentType: attachment.contentType,
            sizeBytes: Number(attachment.sizeBytes),
            sourceKind: attachment.sourceKind,
            retainedLocally: true,
            status: 'ATTACHED',
            qboAttached: true,
            canPreview: true,
            error: null,
          }],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    });

    expect(operation.status).toBe('VERIFIED');
    expect(seen).toEqual([
      expect.objectContaining({
        companyId: value.owner.id,
        transactionId: matched.id,
        sources: [
          expect.objectContaining({
            kind: 'receipt',
            documentId: value.receipt.id,
            blobId: value.receipt.blobId,
          }),
        ],
      }),
    ]);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: {
        status: true,
        transactionAttachmentId: true,
        blobId: true,
      },
    })).resolves.toMatchObject({
      status: 'ATTACHED',
      transactionAttachmentId: operation.files[0]!.id,
      blobId: value.receipt.blobId,
    });
  });

  it('refuses attachment when the matched transaction revision changed', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    await db.transaction.update({
      where: { id: matched.id },
      data: { revision: { increment: 1 } },
    });
    let called = false;

    await expect(attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: value.receipt.revision,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      attach: async () => {
        called = true;
        throw new Error('must not attach');
      },
    })).rejects.toMatchObject({ code: 'RECEIPT_STALE' });

    expect(called).toBe(false);
  });

  it('releases a retention-off receipt blob only after verified attachment', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        retainLocally: false,
      },
    });
    const operation = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: value.receipt.revision,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      attach: async () => {
        const attachment = await db.transactionAttachment.create({
          data: {
            companyId: value.owner.id,
            transactionId: matched.id,
            blobId: null,
            originalFilename: value.receipt.originalFilename,
            contentType: value.receipt.contentType,
            sizeBytes: value.receipt.sizeBytes,
            sha256: value.receipt.sha256,
            sourceKind: 'LOCAL_UPLOAD',
            retainLocally: false,
            status: 'ATTACHED',
            qboAttachableId: 'synthetic-retention-off',
            recatMarker: randomUUID(),
          },
        });
        return {
          operationId: randomUUID(),
          status: 'VERIFIED',
          files: [{
            id: attachment.id,
            transactionId: matched.id,
            filename: attachment.originalFilename,
            contentType: attachment.contentType,
            sizeBytes: Number(attachment.sizeBytes),
            sourceKind: attachment.sourceKind,
            retainedLocally: false,
            status: 'ATTACHED',
            qboAttached: true,
            canPreview: true,
            error: null,
          }],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    });

    expect(operation.status).toBe('VERIFIED');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, blobId: true },
    })).resolves.toEqual({ status: 'ATTACHED', blobId: null });
    await expect(db.attachmentBlob.findUnique({
      where: { id: value.receipt.blobId! },
    })).resolves.toBeNull();
  });

  it('keeps an uncertain upload attaching with its local blob', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        retainLocally: false,
      },
    });

    const operation = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: value.receipt.revision,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      attach: async () => ({
        operationId: randomUUID(),
        status: 'UNCERTAIN',
        files: [],
        actions: { canRetry: false, requiresReconciliation: true },
      }),
    });

    expect(operation.status).toBe('UNCERTAIN');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, blobId: true },
    })).resolves.toEqual({
      status: 'ATTACHING',
      blobId: value.receipt.blobId,
    });
  });

  it('finalizes an uncertain attach after reconciliation verifies it', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    let reconciled = false;
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'UNCERTAIN',
        recatMarker: randomUUID(),
      },
    });
    const operationId = randomUUID();
    await db.attachmentOperation.create({
      data: {
        id: operationId,
        kind: 'ATTACH',
        actorKey: value.actor.actorKey,
        companyId: value.owner.id,
        transactionId: matched.id,
        receiptDocumentId: value.receipt.id,
        idempotencyKey: `receipt-attach:${value.receipt.id}:1`,
        requestHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        status: 'UNCERTAIN',
        fileCount: 1,
        totalBytes: value.receipt.sizeBytes,
        files: {
          create: {
            attachmentId: attachment.id,
            ordinal: 0,
            status: 'UNCERTAIN',
          },
        },
      },
    });
    const operation = (status: 'UNCERTAIN' | 'VERIFIED') => ({
      operationId,
      status,
      files: [{
        id: attachment.id,
        transactionId: matched.id,
        filename: attachment.originalFilename,
        contentType: attachment.contentType,
        sizeBytes: Number(attachment.sizeBytes),
        sourceKind: attachment.sourceKind,
        retainedLocally: true,
        status: status === 'VERIFIED' ? 'ATTACHED' as const : 'UNCERTAIN' as const,
        qboAttached: status === 'VERIFIED',
        canPreview: true,
        error: status === 'VERIFIED'
          ? null
          : {
            code: 'ATTACHMENT_PROVIDER_UNCERTAIN',
            message: 'Synthetic uncertainty.',
          },
      }],
      actions: {
        canRetry: false,
        requiresReconciliation: status === 'UNCERTAIN',
      },
    });
    const receiptDeps: ReceiptMatchingDeps = {
      ...deps(),
      attach: async () => operation('UNCERTAIN'),
      getOperation: async () =>
        operation(reconciled ? 'VERIFIED' : 'UNCERTAIN'),
    };

    await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 0,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);
    reconciled = true;
    const resumed = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 1,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);

    expect(resumed.status).toBe('VERIFIED');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'ATTACHED',
      transactionAttachmentId: attachment.id,
    });
  });

  it('discovers and finalizes a durable attach after a pre-finalizer crash', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHING',
        revision: 1,
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        qboAttachableId: 'synthetic-crash-window',
        recatMarker: randomUUID(),
      },
    });
    await db.attachmentOperation.create({
      data: {
        kind: 'ATTACH',
        actorKey: value.actor.actorKey,
        companyId: value.owner.id,
        transactionId: matched.id,
        receiptDocumentId: value.receipt.id,
        idempotencyKey: `receipt-attach:${value.receipt.id}:1`,
        requestHash: 'e'.repeat(64),
        inputHash: 'f'.repeat(64),
        status: 'VERIFIED',
        fileCount: 1,
        totalBytes: value.receipt.sizeBytes,
        files: {
          create: {
            attachmentId: attachment.id,
            ordinal: 0,
            status: 'ATTACHED',
          },
        },
      },
    });
    const decoyAttachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        originalFilename: 'legacy-prefixed-decoy.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sha256: '9'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: false,
        status: 'ATTACHED',
        qboAttachableId: 'legacy-prefixed-decoy',
        recatMarker: randomUUID(),
      },
    });
    await db.attachmentOperation.create({
      data: {
        kind: 'ATTACH',
        actorKey: `session:${randomUUID()}`,
        companyId: value.owner.id,
        transactionId: matched.id,
        idempotencyKey: `receipt-attach:${value.receipt.id}:1`,
        requestHash: '1'.repeat(64),
        inputHash: '2'.repeat(64),
        status: 'VERIFIED',
        fileCount: 1,
        totalBytes: decoyAttachment.sizeBytes,
        files: {
          create: {
            attachmentId: decoyAttachment.id,
            ordinal: 0,
            status: 'ATTACHED',
          },
        },
      },
    });

    const operation = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 1,
      expectedTransactionRevision: matched.revision,
    }, deps());

    expect(operation.status).toBe('VERIFIED');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'ATTACHED',
      transactionAttachmentId: attachment.id,
    });
  });

  it('does not adopt an earlier attach cycle after a reattach crash window', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHING',
        revision: 3,
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    const historicalAttachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        originalFilename: 'historical-attach.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sha256: '7'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: false,
        status: 'DELETED',
        recatMarker: randomUUID(),
      },
    });
    await db.attachmentOperation.create({
      data: {
        kind: 'ATTACH',
        actorKey: value.actor.actorKey,
        companyId: value.owner.id,
        transactionId: matched.id,
        receiptDocumentId: value.receipt.id,
        idempotencyKey: `receipt-attach:${value.receipt.id}:1`,
        requestHash: '3'.repeat(64),
        inputHash: '4'.repeat(64),
        status: 'VERIFIED',
        fileCount: 1,
        totalBytes: historicalAttachment.sizeBytes,
        files: {
          create: {
            attachmentId: historicalAttachment.id,
            ordinal: 0,
            status: 'ATTACHED',
          },
        },
      },
    });
    let attachCalls = 0;
    let currentAttachmentId = '';

    const result = await attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 3,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      attach: async () => {
        attachCalls += 1;
        const current = await db.transactionAttachment.create({
          data: {
            companyId: value.owner.id,
            transactionId: matched.id,
            blobId: value.receipt.blobId,
            originalFilename: value.receipt.originalFilename,
            contentType: value.receipt.contentType,
            sizeBytes: value.receipt.sizeBytes,
            sha256: value.receipt.sha256,
            sourceKind: 'LOCAL_UPLOAD',
            retainLocally: true,
            status: 'ATTACHED',
            qboAttachableId: 'current-reattach',
            recatMarker: randomUUID(),
          },
        });
        currentAttachmentId = current.id;
        return {
          operationId: randomUUID(),
          status: 'VERIFIED',
          files: [{
            id: current.id,
            transactionId: matched.id,
            filename: current.originalFilename,
            contentType: current.contentType,
            sizeBytes: Number(current.sizeBytes),
            sourceKind: current.sourceKind,
            retainedLocally: true,
            status: 'ATTACHED',
            qboAttached: true,
            canPreview: true,
            error: null,
          }],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    });

    expect(result.status).toBe('VERIFIED');
    expect(attachCalls).toBe(1);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'ATTACHED',
      transactionAttachmentId: currentAttachmentId,
    });
  });

  it('does not finalize after entity-lease authority is lost', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'MATCHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
      },
    });
    let fences = 0;
    let providerCompleted = false;

    await expect(attachMatchedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 0,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      fence: async () => {
        fences += 1;
        if (providerCompleted) {
          throw Object.assign(new Error('synthetic lost lease'), {
            code: 'ENTITY_BUSY',
          });
        }
      },
      attach: async () => {
        const attachment = await db.transactionAttachment.create({
          data: {
            companyId: value.owner.id,
            transactionId: matched.id,
            blobId: value.receipt.blobId,
            originalFilename: value.receipt.originalFilename,
            contentType: value.receipt.contentType,
            sizeBytes: value.receipt.sizeBytes,
            sha256: value.receipt.sha256,
            sourceKind: 'LOCAL_UPLOAD',
            retainLocally: true,
            status: 'ATTACHED',
            qboAttachableId: 'synthetic-lost-lease',
            recatMarker: randomUUID(),
          },
        });
        providerCompleted = true;
        return {
          operationId: randomUUID(),
          status: 'VERIFIED',
          files: [{
            id: attachment.id,
            transactionId: matched.id,
            filename: attachment.originalFilename,
            contentType: attachment.contentType,
            sizeBytes: Number(attachment.sizeBytes),
            sourceKind: attachment.sourceKind,
            retainedLocally: true,
            status: 'ATTACHED',
            qboAttached: true,
            canPreview: true,
            error: null,
          }],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    })).rejects.toMatchObject({ code: 'ENTITY_BUSY' });

    expect(fences).toBeGreaterThanOrEqual(2);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'ATTACHING',
      transactionAttachmentId: null,
    });
  });

  it('undoes through verified delete-everywhere and returns to MATCHED', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        qboAttachableId: 'synthetic-qbo-attachment',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        transactionAttachmentId: attachment.id,
      },
    });
    const seen: unknown[] = [];

    const operation = await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: value.receipt.revision,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      delete: async (input) => {
        seen.push(input);
        await db.transactionAttachment.update({
          where: { id: attachment.id },
          data: { status: 'DELETED', blobId: null },
        });
        return {
          operationId: randomUUID(),
          status: 'DELETED',
          files: [],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    });

    expect(operation.status).toBe('DELETED');
    expect(seen).toEqual([
      expect.objectContaining({
        attachmentId: attachment.id,
        scope: 'everywhere',
      }),
    ]);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'MATCHED',
      transactionAttachmentId: null,
    });
  });

  it('finalizes an uncertain undo after reconciliation verifies deletion', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'UNCERTAIN',
        qboAttachableId: 'synthetic-qbo-undo',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        transactionAttachmentId: attachment.id,
      },
    });
    const operationId = randomUUID();
    await db.attachmentOperation.create({
      data: {
        id: operationId,
        kind: 'DELETE_EVERYWHERE',
        actorKey: value.actor.actorKey,
        companyId: value.owner.id,
        transactionId: matched.id,
        receiptDocumentId: value.receipt.id,
        idempotencyKey: `receipt-undo:${value.receipt.id}:1`,
        requestHash: 'c'.repeat(64),
        inputHash: 'd'.repeat(64),
        status: 'UNCERTAIN',
        fileCount: 1,
        totalBytes: value.receipt.sizeBytes,
        files: {
          create: {
            attachmentId: attachment.id,
            ordinal: 0,
            status: 'UNCERTAIN',
          },
        },
      },
    });
    let reconciled = false;
    const operation = (status: 'UNCERTAIN' | 'DELETED') => ({
      operationId,
      status,
      files: [],
      actions: {
        canRetry: false,
        requiresReconciliation: status === 'UNCERTAIN',
      },
    });
    const receiptDeps: ReceiptMatchingDeps = {
      ...deps(),
      delete: async () => operation('UNCERTAIN'),
      getOperation: async () =>
        operation(reconciled ? 'DELETED' : 'UNCERTAIN'),
    };

    await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 0,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);
    reconciled = true;
    const resumed = await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 1,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);

    expect(resumed.status).toBe('DELETED');
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'MATCHED',
      transactionAttachmentId: null,
    });
  });

  it('uses a fresh operation key when retrying a definite undo failure', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    const attachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        qboAttachableId: 'synthetic-retry-undo',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHED',
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        transactionAttachmentId: attachment.id,
      },
    });
    const keys: string[] = [];
    const receiptDeps: ReceiptMatchingDeps = {
      ...deps(),
      delete: async (input) => {
        keys.push(input.idempotencyKey);
        return {
          operationId: randomUUID(),
          status: keys.length === 1 ? 'FAILED' : 'DELETED',
          files: [],
          actions: { canRetry: keys.length === 1, requiresReconciliation: false },
        };
      },
    };

    const failed = await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 0,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);
    expect(failed.status).toBe('FAILED');
    const retried = await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 2,
      expectedTransactionRevision: matched.revision,
    }, receiptDeps);

    expect(retried.status).toBe('DELETED');
    expect(new Set(keys).size).toBe(2);
  });

  it('does not adopt an earlier undo cycle after a repeated-undo crash window', async () => {
    const value = await fixture();
    const matched = await transaction(value.owner.id);
    const historicalAttachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        originalFilename: 'historical-undo.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8n,
        sha256: '5'.repeat(64),
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: false,
        status: 'DELETED',
        recatMarker: randomUUID(),
      },
    });
    const currentAttachment = await db.transactionAttachment.create({
      data: {
        companyId: value.owner.id,
        transactionId: matched.id,
        blobId: value.receipt.blobId,
        originalFilename: value.receipt.originalFilename,
        contentType: value.receipt.contentType,
        sizeBytes: value.receipt.sizeBytes,
        sha256: value.receipt.sha256,
        sourceKind: 'LOCAL_UPLOAD',
        retainLocally: true,
        status: 'ATTACHED',
        qboAttachableId: 'current-repeated-undo',
        recatMarker: randomUUID(),
      },
    });
    await db.receiptDocument.update({
      where: { id: value.receipt.id },
      data: {
        status: 'ATTACHING',
        revision: 4,
        matchedTransactionId: matched.id,
        matchedTransactionRevision: matched.revision,
        transactionAttachmentId: currentAttachment.id,
      },
    });
    await db.attachmentOperation.create({
      data: {
        kind: 'DELETE_EVERYWHERE',
        actorKey: value.actor.actorKey,
        companyId: value.owner.id,
        transactionId: matched.id,
        receiptDocumentId: value.receipt.id,
        idempotencyKey: `receipt-undo:${value.receipt.id}:2`,
        requestHash: '5'.repeat(64),
        inputHash: '6'.repeat(64),
        status: 'DELETED',
        fileCount: 1,
        totalBytes: historicalAttachment.sizeBytes,
        files: {
          create: {
            attachmentId: historicalAttachment.id,
            ordinal: 0,
            status: 'DELETED',
          },
        },
      },
    });
    const deletedIds: string[] = [];

    const result = await undoAttachedReceipt({
      actor: value.actor,
      companyId: value.owner.id,
      documentId: value.receipt.id,
      expectedReceiptRevision: 4,
      expectedTransactionRevision: matched.revision,
    }, {
      ...deps(),
      delete: async (input) => {
        deletedIds.push(input.attachmentId);
        return {
          operationId: randomUUID(),
          status: 'DELETED',
          files: [],
          actions: { canRetry: false, requiresReconciliation: false },
        };
      },
    });

    expect(result.status).toBe('DELETED');
    expect(deletedIds).toEqual([currentAttachment.id]);
    await expect(db.receiptDocument.findUniqueOrThrow({
      where: { id: value.receipt.id },
      select: { status: true, transactionAttachmentId: true },
    })).resolves.toEqual({
      status: 'MATCHED',
      transactionAttachmentId: null,
    });
  });
});
