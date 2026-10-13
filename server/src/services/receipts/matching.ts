import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  ReceiptDocumentStatus,
} from '@prisma/client';
import type {
  AttachmentOperationDto,
  ReceiptDetailDto,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { runSerializableTransaction } from '../../lib/serializableTransaction.js';
import {
  fenceEntityLeaseOwnership,
  renewEntityLease,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from '../entityLease.js';
import {
  attachTransactionFiles,
  deleteTransactionAttachment,
  getAttachmentOperation,
  reconcileReceiptAttachmentOperation,
  type AttachFilesInput,
  type AttachmentActor,
  type DeleteAttachmentInput,
} from '../attachments/operations.js';
import {
  candidateAmountRange,
  rankReceiptCandidates,
  type MatchableTransaction,
  type ScoredReceiptCandidate,
} from './matcher.js';
import { getReceiptDetail } from './query.js';
import {
  DEFAULT_RECEIPT_SETTINGS,
} from './settings.js';
import { ReceiptError } from './types.js';

export interface ReceiptMatchBuildCandidate {
  transactionId: string;
  transactionRevision: number;
  rank: number;
  score: number;
  state: string;
  evidence: ScoredReceiptCandidate['evidence'];
}

export interface ReceiptMatchBuildResult {
  documentId: string;
  revision: number;
  status: ReceiptDocumentStatus;
  matchedTransactionId: string | null;
  candidates: ReceiptMatchBuildCandidate[];
}

export interface ConfirmReceiptMatchInput {
  actor: AttachmentActor;
  companyId: string;
  documentId: string;
  transactionId: string;
  expectedReceiptRevision: number;
  expectedTransactionRevision: number;
}

export interface RematchReceiptInput {
  actor: AttachmentActor;
  companyId: string;
  documentId: string;
  expectedReceiptRevision: number;
}

export interface ReceiptAttachmentMutationInput {
  actor: AttachmentActor;
  companyId: string;
  documentId: string;
  expectedReceiptRevision: number;
  expectedTransactionRevision: number;
}

export interface ReceiptMatchingDeps {
  db?: PrismaClient;
  lease?: <T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ) => Promise<T>;
  attach?: (
    input: AttachFilesInput,
  ) => Promise<AttachmentOperationDto>;
  delete?: (
    input: DeleteAttachmentInput,
  ) => Promise<AttachmentOperationDto>;
  getOperation?: (
    actor: AttachmentActor,
    operationId: string,
  ) => Promise<AttachmentOperationDto>;
  reconcileOperation?: (
    actor: AttachmentActor,
    operationId: string,
  ) => Promise<AttachmentOperationDto>;
  fence?: (
    key: EntityLeaseKey,
    owner: string,
    tx: Prisma.TransactionClient,
  ) => Promise<void>;
}

interface BuildOptions {
  companyId?: string;
  expectedRevision?: number;
  actorUserId?: string | null;
}

const ACTIVE_TRANSACTION_STATUSES = ['PENDING', 'ERROR'] as const;
const MONEY_OUT_DOCUMENT_TYPES = new Set([
  'expense_receipt',
  'expense',
  'purchase',
  'vendor_invoice',
  'bill',
]);
const MONEY_IN_DOCUMENT_TYPES = new Set([
  'issued_invoice',
  'sales_receipt',
  'sale',
  'deposit',
  'income',
]);

export async function buildReceiptMatches(
  documentId: string,
  generation: number,
  deps: ReceiptMatchingDeps = {},
  options: BuildOptions = {},
): Promise<ReceiptMatchBuildResult> {
  const db = deps.db ?? prisma;
  return runSerializableTransaction(db, async (tx) => {
    const locked = await tx.$queryRaw<Array<{
      id: string;
      companyId: string;
      generation: number;
      revision: number;
      status: ReceiptDocumentStatus;
      transactionAttachmentId: string | null;
      deletedAt: Date | null;
    }>>`
      SELECT "id", "companyId", "generation", "revision", "status",
             "transactionAttachmentId", "deletedAt"
        FROM "ReceiptDocument"
       WHERE "id" = ${documentId}
       FOR UPDATE`;
    const receipt = locked[0];
    if (
      !receipt
      || receipt.deletedAt !== null
      || (
        options.companyId !== undefined
        && receipt.companyId !== options.companyId
      )
    ) {
      throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
    }
    if (
      receipt.generation !== generation
      || receipt.status === 'ATTACHING'
      || receipt.status === 'ATTACHED'
      || receipt.transactionAttachmentId !== null
      || (
        options.expectedRevision !== undefined
        && receipt.revision !== options.expectedRevision
      )
    ) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'Receipt revision changed; refresh before retrying.',
      );
    }
    const attempt = await tx.receiptExtractionAttempt.findFirst({
      where: {
        documentId,
        generation,
        status: 'succeeded',
      },
      orderBy: [
        { attemptCount: 'desc' },
        { completedAt: 'desc' },
        { id: 'desc' },
      ],
    });
    if (!attempt) {
      throw new ReceiptError(
        'RECEIPT_STALE',
        'The current receipt extraction is unavailable.',
      );
    }

    // Filter by the amounts the matcher can score before capping the rows, so
    // a busy company's true match is not crowded out by unrelated newer rows.
    const amountRange = candidateAmountRange(
      attempt.totalAmount?.toString() ?? null,
    );
    const transactions = amountRange === null ? [] : await tx.transaction.findMany({
      where: {
        companyId: receipt.companyId,
        status: { in: [...ACTIVE_TRANSACTION_STATUSES] },
        ...transactionDirectionFilter(attempt.documentType),
        OR: [
          { amount: { gte: amountRange.min, lte: amountRange.max } },
          {
            amount: {
              gte: `-${amountRange.max}`,
              lte: `-${amountRange.min}`,
            },
          },
        ],
        ...(attempt.receiptDate
          ? {
            date: {
              gte: addDays(attempt.receiptDate, -14),
              lte: addDays(attempt.receiptDate, 14),
            },
          }
          : {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    const ranked = rankReceiptCandidates({
      totalAmount: attempt.totalAmount?.toString() ?? null,
      currency: attempt.currency,
      receiptDate: dateOnly(attempt.receiptDate),
      vendorName: attempt.vendorName,
      paymentIdentifier: attempt.paymentIdentifier,
      documentType: attempt.documentType,
    }, transactions.map(toMatchableTransaction));

    await tx.receiptMatchCandidate.updateMany({
      where: {
        documentId,
        extractionAttemptId: { not: attempt.id },
        state: { not: 'stale' },
      },
      data: { state: 'stale' },
    });
    await tx.receiptMatchCandidate.deleteMany({
      where: {
        documentId,
        extractionAttemptId: attempt.id,
        state: 'proposed',
      },
    });
    const rankedTransactionIds = ranked.map((candidate) =>
      candidate.transactionId);
    await tx.receiptMatchCandidate.updateMany({
      where: {
        documentId,
        extractionAttemptId: attempt.id,
        state: { not: 'stale' },
        ...(rankedTransactionIds.length > 0
          ? { transactionId: { notIn: rankedTransactionIds } }
          : {}),
      },
      data: { state: 'stale' },
    });

    const config = await tx.receiptCompanyConfig.findUnique({
      where: { companyId: receipt.companyId },
      select: {
        confidenceThreshold: true,
        autoMatchThreshold: true,
        autoMatchMargin: true,
      },
    });
    const confidenceThreshold = config?.confidenceThreshold.toNumber()
      ?? DEFAULT_RECEIPT_SETTINGS.confidenceThreshold;
    const confident = attempt.extractionConfidence !== null
      && attempt.extractionConfidence.toNumber() >= confidenceThreshold;
    const matchedTransactionId = confident
      ? localMatchDecision(
        ranked,
        config?.autoMatchThreshold
          ?? DEFAULT_RECEIPT_SETTINGS.autoMatchThreshold,
        config?.autoMatchMargin ?? DEFAULT_RECEIPT_SETTINGS.autoMatchMargin,
      )
      : null;
    for (const [index, candidate] of ranked.entries()) {
      const state = matchedTransactionId === null
        ? 'proposed'
        : candidate.transactionId === matchedTransactionId
          ? 'confirmed'
          : 'rejected';
      await tx.receiptMatchCandidate.upsert({
        where: {
          extractionAttemptId_transactionId: {
            extractionAttemptId: attempt.id,
            transactionId: candidate.transactionId,
          },
        },
        create: {
          documentId,
          extractionAttemptId: attempt.id,
          transactionId: candidate.transactionId,
          transactionRevision: candidate.transactionRevision,
          score: candidate.score,
          evidence: candidate.evidence as unknown as Prisma.InputJsonValue,
          rank: index + 1,
          state,
        },
        update: {
          transactionRevision: candidate.transactionRevision,
          score: candidate.score,
          evidence: candidate.evidence as unknown as Prisma.InputJsonValue,
          rank: index + 1,
          state,
        },
      });
    }

    const completeExtraction = attempt.totalAmount !== null;
    const status: ReceiptDocumentStatus = !confident
      ? 'NEEDS_REVIEW'
      : matchedTransactionId !== null
      ? 'MATCHED'
      : ranked.length > 0 && completeExtraction
        ? 'READY'
        : 'NEEDS_REVIEW';
    const winner = matchedTransactionId === null
      ? null
      : ranked.find((candidate) =>
        candidate.transactionId === matchedTransactionId) ?? null;
    const updated = await tx.receiptDocument.update({
      where: { id: documentId },
      data: {
        status,
        matchedTransactionId,
        matchedTransactionRevision: winner?.transactionRevision ?? null,
        approvedAt: matchedTransactionId === null ? null : new Date(),
        approvedByUserId: matchedTransactionId === null
          ? null
          : options.actorUserId ?? null,
        revision: { increment: 1 },
      },
      select: { revision: true },
    });
    await tx.receiptEvent.create({
      data: {
        companyId: receipt.companyId,
        documentId,
        actorUserId: options.actorUserId ?? null,
        action: options.actorUserId ? 'rematched' : 'matched',
        before: {
          generation,
          revision: receipt.revision,
        },
        after: {
          candidateCount: ranked.length,
          matchedTransactionId,
          status,
        },
      },
    });
    return {
      documentId,
      revision: updated.revision,
      status,
      matchedTransactionId,
      candidates: ranked.map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        state: matchedTransactionId === null
          ? 'proposed'
          : candidate.transactionId === matchedTransactionId
            ? 'confirmed'
            : 'rejected',
      })),
    };
  });
}

export async function rematchReceipt(
  input: RematchReceiptInput,
  deps: ReceiptMatchingDeps = {},
): Promise<ReceiptDetailDto> {
  assertActor(input.actor, input.companyId);
  const db = deps.db ?? prisma;
  const receipt = await db.receiptDocument.findFirst({
    where: {
      id: input.documentId,
      companyId: input.companyId,
      deletedAt: null,
    },
    select: { generation: true },
  });
  if (!receipt) {
    throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
  }
  await buildReceiptMatches(input.documentId, receipt.generation, deps, {
    companyId: input.companyId,
    expectedRevision: input.expectedReceiptRevision,
    actorUserId: input.actor.userId,
  });
  return getReceiptDetail(input.companyId, input.documentId, { db });
}

export async function confirmReceiptMatch(
  input: ConfirmReceiptMatchInput,
  deps: ReceiptMatchingDeps = {},
): Promise<ReceiptDetailDto> {
  assertActor(input.actor, input.companyId);
  const db = deps.db ?? prisma;
  const candidate = await db.receiptMatchCandidate.findFirst({
    where: {
      documentId: input.documentId,
      transactionId: input.transactionId,
      document: {
        companyId: input.companyId,
        deletedAt: null,
      },
      transaction: { companyId: input.companyId },
    },
    include: {
      transaction: {
        select: { qboId: true, qboType: true },
      },
    },
  });
  if (!candidate) {
    throw new ReceiptError(
      'RECEIPT_STALE',
      'The receipt match candidate is stale.',
    );
  }
  const key: EntityLeaseKey = {
    companyId: input.companyId,
    qboType: candidate.transaction.qboType,
    qboId: candidate.transaction.qboId,
  };
  const leaseOwner = `receipt-match-${randomUUID()}`;
  const lease = receiptLease(deps, db);
  const fence = receiptFence(deps);

  let outcome: { stale: boolean };
  try {
    outcome = await lease(key, leaseOwner, () =>
      runSerializableTransaction(db, async (tx) => {
        await fence(key, leaseOwner, tx);
        const locked = await tx.$queryRaw<Array<{
          id: string;
          companyId: string;
          generation: number;
          revision: number;
          status: ReceiptDocumentStatus;
          transactionAttachmentId: string | null;
          deletedAt: Date | null;
        }>>`
          SELECT "id", "companyId", "generation", "revision", "status",
                 "transactionAttachmentId", "deletedAt"
            FROM "ReceiptDocument"
           WHERE "id" = ${input.documentId}
           FOR UPDATE`;
        const receipt = locked[0];
        if (
          !receipt
          || receipt.companyId !== input.companyId
          || receipt.deletedAt !== null
        ) {
          throw new ReceiptError(
            'RECEIPT_NOT_FOUND',
            'Receipt was not found.',
          );
        }
        if (receipt.revision !== input.expectedReceiptRevision) {
          throw new ReceiptError(
            'RECEIPT_STALE',
            'Receipt revision changed; refresh before retrying.',
          );
        }
        if (
          (receipt.status !== 'READY' && receipt.status !== 'NEEDS_REVIEW')
          || receipt.transactionAttachmentId !== null
        ) {
          throw new ReceiptError(
            'RECEIPT_STALE',
            'Receipt state changed; refresh before retrying.',
          );
        }
        const currentAttempt = await tx.receiptExtractionAttempt.findFirst({
          where: {
            documentId: input.documentId,
            generation: receipt.generation,
            status: 'succeeded',
          },
          orderBy: [
            { attemptCount: 'desc' },
            { completedAt: 'desc' },
            { id: 'desc' },
          ],
          select: { id: true },
        });
        const current = await tx.receiptMatchCandidate.findFirst({
          where: {
            documentId: input.documentId,
            transactionId: input.transactionId,
          },
          include: {
            transaction: {
              select: {
                companyId: true,
                revision: true,
                status: true,
              },
            },
          },
        });
        const stale = (
          currentAttempt === null
          || current === null
          || current.extractionAttemptId !== currentAttempt.id
          || current.state !== 'proposed'
          || current.transaction.companyId !== input.companyId
          || !ACTIVE_TRANSACTION_STATUSES.includes(
            current.transaction.status as typeof ACTIVE_TRANSACTION_STATUSES[number],
          )
          || current.transactionRevision !== input.expectedTransactionRevision
          || current.transaction.revision !== input.expectedTransactionRevision
        );
        if (stale) {
          if (current !== null) {
            await tx.receiptMatchCandidate.update({
              where: { id: current.id },
              data: { state: 'stale' },
            });
          }
          await tx.receiptDocument.update({
            where: { id: input.documentId },
            data: {
              status: 'READY',
              matchedTransactionId: null,
              matchedTransactionRevision: null,
              approvedAt: null,
              approvedByUserId: null,
              revision: { increment: 1 },
            },
          });
          await tx.receiptEvent.create({
            data: {
              companyId: input.companyId,
              documentId: input.documentId,
              actorUserId: input.actor.userId,
              action: 'match_stale',
              before: {
                revision: receipt.revision,
                transactionId: input.transactionId,
              },
              after: { stale: true },
            },
          });
          return { stale: true as const };
        }
        await tx.receiptMatchCandidate.updateMany({
          where: {
            documentId: input.documentId,
            extractionAttemptId: currentAttempt.id,
            id: { not: current.id },
            state: 'proposed',
          },
          data: { state: 'rejected' },
        });
        await tx.receiptMatchCandidate.update({
          where: { id: current.id },
          data: { state: 'confirmed' },
        });
        await tx.receiptDocument.update({
          where: { id: input.documentId },
          data: {
            status: 'MATCHED',
            matchedTransactionId: input.transactionId,
            matchedTransactionRevision: input.expectedTransactionRevision,
            approvedAt: new Date(),
            approvedByUserId: input.actor.userId,
            revision: { increment: 1 },
          },
        });
        await tx.receiptEvent.create({
          data: {
            companyId: input.companyId,
            documentId: input.documentId,
            actorUserId: input.actor.userId,
            action: 'match_confirmed',
            before: { revision: receipt.revision },
            after: {
              transactionId: input.transactionId,
              transactionRevision: input.expectedTransactionRevision,
            },
          },
        });
        return { stale: false as const };
      }));
  } catch (error) {
    if (isRawSerializationConflict(error)) throw stale();
    throw error;
  }
  if (outcome.stale) {
    throw new ReceiptError(
      'RECEIPT_STALE',
      'The receipt match candidate is stale.',
    );
  }
  return getReceiptDetail(input.companyId, input.documentId, { db });
}

export async function attachMatchedReceipt(
  input: ReceiptAttachmentMutationInput,
  deps: ReceiptMatchingDeps = {},
): Promise<AttachmentOperationDto> {
  assertActor(input.actor, input.companyId);
  const db = deps.db ?? prisma;
  const target = await loadMatchedTarget(input, db);
  const lease = receiptLease(deps, db);
  const owner = `receipt-attach-${randomUUID()}`;
  return lease(target.key, owner, async () => {
    const fence = receiptFence(deps);
    const authority = { key: target.key, owner, fence };
    const prepared = await runSerializableTransaction(db, async (tx) => {
      await fence(target.key, owner, tx);
      const receipt = await lockReceipt(tx, input.documentId);
      assertReceiptMutationScope(receipt, input);
      if (
        receipt.matchedTransactionId !== target.transaction.id
        || receipt.matchedTransactionRevision
          !== input.expectedTransactionRevision
      ) {
        throw stale();
      }
      const transaction = await tx.transaction.findFirst({
        where: {
          id: target.transaction.id,
          companyId: input.companyId,
        },
        select: { revision: true, status: true },
      });
      if (
        !transaction
        || transaction.revision !== input.expectedTransactionRevision
        || !ACTIVE_TRANSACTION_STATUSES.includes(
          transaction.status as typeof ACTIVE_TRANSACTION_STATUSES[number],
        )
      ) {
        await clearStaleMatch(tx, receipt, input.actor.userId);
        return { kind: 'stale' as const };
      }
      if (
        receipt.status === 'ATTACHING'
      ) {
        const operation = await tx.attachmentOperation.findFirst({
          where: {
            companyId: input.companyId,
            transactionId: target.transaction.id,
            kind: 'ATTACH',
            receiptDocumentId: receipt.id,
            idempotencyKey:
              `receipt-attach:${receipt.id}:${receipt.revision}`,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (operation) {
          return {
            kind: 'resume' as const,
            revision: receipt.revision,
            resumeOperationId: operation.id,
            blobId: receipt.blobId,
            retainLocally: receipt.retainLocally,
          };
        }
        if (
          receipt.transactionAttachmentId !== null
          || receipt.blobId === null
        ) throw stale();
        return {
          kind: 'new' as const,
          revision: receipt.revision,
          source: {
            kind: 'receipt' as const,
            documentId: receipt.id,
            blobId: receipt.blobId,
            filename: receipt.originalFilename,
            contentType: receipt.contentType,
            sizeBytes: receipt.sizeBytes,
            sha256: receipt.sha256,
            retainLocally: receipt.retainLocally,
          },
        };
      }
      if (
        receipt.status !== 'MATCHED'
        || receipt.transactionAttachmentId !== null
        || receipt.blobId === null
      ) {
        throw stale();
      }
      const updated = await tx.receiptDocument.update({
        where: { id: receipt.id },
        data: {
          status: 'ATTACHING',
          revision: { increment: 1 },
        },
        select: { revision: true },
      });
      await tx.receiptEvent.create({
        data: {
          companyId: input.companyId,
          documentId: receipt.id,
          actorUserId: input.actor.userId,
          action: 'attach_started',
          before: { revision: receipt.revision, status: receipt.status },
          after: {
            revision: updated.revision,
            transactionId: target.transaction.id,
          },
        },
      });
      return {
        kind: 'new' as const,
        revision: updated.revision,
        source: {
          kind: 'receipt' as const,
          documentId: receipt.id,
          blobId: receipt.blobId,
          filename: receipt.originalFilename,
          contentType: receipt.contentType,
          sizeBytes: receipt.sizeBytes,
          sha256: receipt.sha256,
          retainLocally: receipt.retainLocally,
        },
      };
    });
    if (prepared.kind === 'stale') throw stale();

    let operation: AttachmentOperationDto;
    if (prepared.kind === 'resume') {
      operation = await (deps.getOperation
        ?? ((actor, operationId) =>
          getAttachmentOperation(actor, operationId, { db })))(
        input.actor,
        prepared.resumeOperationId,
      );
      if (operation.actions.requiresReconciliation) {
        operation = await (deps.reconcileOperation
          ?? ((actor, operationId) =>
            reconcileReceiptAttachmentOperation(actor, operationId, { db })))(
          input.actor,
          prepared.resumeOperationId,
        );
      }
      await finalizeReceiptAttach(
        db,
        input,
        target.transaction.id,
        prepared.revision,
        prepared.blobId,
        prepared.retainLocally,
        operation,
        authority,
      );
      return operation;
    }
    try {
      operation = await (deps.attach
        ?? ((value) => attachTransactionFiles(value, { db })))({
        actor: input.actor,
        companyId: input.companyId,
        transactionId: target.transaction.id,
        idempotencyKey: `receipt-attach:${input.documentId}:${prepared.revision}`,
        sources: [prepared.source],
      });
    } catch (error) {
      await restoreReceiptStatus(
        db,
        input,
        prepared.revision,
        'MATCHED',
        'attach_failed',
        authority,
      );
      throw error;
    }

    await finalizeReceiptAttach(
      db,
      input,
      target.transaction.id,
      prepared.revision,
      prepared.source.blobId,
      prepared.source.retainLocally,
      operation,
      authority,
    );
    return operation;
  });
}

export async function undoAttachedReceipt(
  input: ReceiptAttachmentMutationInput,
  deps: ReceiptMatchingDeps = {},
): Promise<AttachmentOperationDto> {
  assertActor(input.actor, input.companyId);
  const db = deps.db ?? prisma;
  const target = await loadMatchedTarget(input, db);
  const lease = receiptLease(deps, db);
  const owner = `receipt-undo-${randomUUID()}`;
  return lease(target.key, owner, async () => {
    const fence = receiptFence(deps);
    const authority = { key: target.key, owner, fence };
    const prepared = await runSerializableTransaction(db, async (tx) => {
      await fence(target.key, owner, tx);
      const receipt = await lockReceipt(tx, input.documentId);
      assertReceiptMutationScope(receipt, input);
      if (
        receipt.transactionAttachmentId === null
        || receipt.matchedTransactionId !== target.transaction.id
        || receipt.matchedTransactionRevision
          !== input.expectedTransactionRevision
      ) {
        throw stale();
      }
      const transaction = await tx.transaction.findFirst({
        where: {
          id: target.transaction.id,
          companyId: input.companyId,
        },
        select: { revision: true },
      });
      if (
        !transaction
        || transaction.revision !== input.expectedTransactionRevision
      ) {
        throw stale();
      }
      if (receipt.status === 'ATTACHING') {
        const operation = await tx.attachmentOperation.findFirst({
          where: {
            companyId: input.companyId,
            transactionId: target.transaction.id,
            kind: 'DELETE_EVERYWHERE',
            receiptDocumentId: receipt.id,
            idempotencyKey:
              `receipt-undo:${receipt.id}:${receipt.revision}`,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (operation) {
          return {
            kind: 'resume' as const,
            revision: receipt.revision,
            attachmentId: receipt.transactionAttachmentId,
            operationId: operation.id,
          };
        }
        return {
          kind: 'new' as const,
          revision: receipt.revision,
          attachmentId: receipt.transactionAttachmentId,
        };
      }
      if (receipt.status !== 'ATTACHED') throw stale();
      const updated = await tx.receiptDocument.update({
        where: { id: receipt.id },
        data: {
          status: 'ATTACHING',
          revision: { increment: 1 },
        },
        select: { revision: true },
      });
      await tx.receiptEvent.create({
        data: {
          companyId: input.companyId,
          documentId: receipt.id,
          actorUserId: input.actor.userId,
          action: 'undo_started',
          before: { revision: receipt.revision, status: receipt.status },
          after: {
            revision: updated.revision,
            attachmentId: receipt.transactionAttachmentId,
          },
        },
      });
      return {
        kind: 'new' as const,
        revision: updated.revision,
        attachmentId: receipt.transactionAttachmentId,
      };
    });

    let operation: AttachmentOperationDto;
    if (prepared.kind === 'resume') {
      operation = await (deps.getOperation
        ?? ((actor, operationId) =>
          getAttachmentOperation(actor, operationId, { db })))(
        input.actor,
        prepared.operationId,
      );
      if (operation.actions.requiresReconciliation) {
        operation = await (deps.reconcileOperation
          ?? ((actor, operationId) =>
            reconcileReceiptAttachmentOperation(actor, operationId, { db })))(
          input.actor,
          prepared.operationId,
        );
      }
      await finalizeReceiptUndo(
        db,
        input,
        prepared.revision,
        prepared.attachmentId,
        operation,
        authority,
      );
      return operation;
    }
    try {
      operation = await (deps.delete
        ?? ((value) => deleteTransactionAttachment(value, { db })))({
        actor: input.actor,
        companyId: input.companyId,
        transactionId: target.transaction.id,
        attachmentId: prepared.attachmentId,
        scope: 'everywhere',
        idempotencyKey: `receipt-undo:${input.documentId}:${prepared.revision}`,
        receiptDocumentId: input.documentId,
      });
    } catch (error) {
      await restoreReceiptStatus(
        db,
        input,
        prepared.revision,
        'ATTACHED',
        'undo_failed',
        authority,
      );
      throw error;
    }

    await finalizeReceiptUndo(
      db,
      input,
      prepared.revision,
      prepared.attachmentId,
      operation,
      authority,
    );
    return operation;
  });
}

function localMatchDecision(
  ranked: readonly ScoredReceiptCandidate[],
  threshold: number,
  margin: number,
): string | null {
  const first = ranked[0];
  if (!first || first.score < threshold) return null;
  const second = ranked[1];
  if (second && first.score - second.score < margin) return null;
  return first.transactionId;
}

interface LockedReceipt {
  id: string;
  companyId: string;
  status: ReceiptDocumentStatus;
  generation: number;
  revision: number;
  deletedAt: Date | null;
  blobId: string | null;
  originalFilename: string;
  contentType: string;
  sizeBytes: bigint;
  sha256: string;
  retainLocally: boolean;
  matchedTransactionId: string | null;
  matchedTransactionRevision: number | null;
  transactionAttachmentId: string | null;
}

async function lockReceipt(
  tx: Prisma.TransactionClient,
  documentId: string,
): Promise<LockedReceipt | null> {
  const rows = await tx.$queryRaw<LockedReceipt[]>`
    SELECT "id", "companyId", "status", "generation", "revision", "deletedAt",
           "blobId", "originalFilename", "contentType", "sizeBytes", "sha256",
           "retainLocally", "matchedTransactionId",
           "matchedTransactionRevision", "transactionAttachmentId"
      FROM "ReceiptDocument"
     WHERE "id" = ${documentId}
     FOR UPDATE`;
  return rows[0] ?? null;
}

function assertReceiptMutationScope(
  receipt: LockedReceipt | null,
  input: ReceiptAttachmentMutationInput,
): asserts receipt is LockedReceipt {
  if (
    !receipt
    || receipt.companyId !== input.companyId
    || receipt.deletedAt !== null
  ) {
    throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt was not found.');
  }
  if (receipt.revision !== input.expectedReceiptRevision) throw stale();
}

async function loadMatchedTarget(
  input: ReceiptAttachmentMutationInput,
  db: PrismaClient,
): Promise<{
  transaction: { id: string };
  key: EntityLeaseKey;
}> {
  const receipt = await db.receiptDocument.findFirst({
    where: {
      id: input.documentId,
      companyId: input.companyId,
      deletedAt: null,
      matchedTransactionId: { not: null },
    },
    select: {
      matchedTransaction: {
        select: { id: true, qboId: true, qboType: true },
      },
    },
  });
  if (!receipt?.matchedTransaction) throw stale();
  return {
    transaction: { id: receipt.matchedTransaction.id },
    key: {
      companyId: input.companyId,
      qboId: receipt.matchedTransaction.qboId,
      qboType: receipt.matchedTransaction.qboType,
    },
  };
}

function receiptLease(
  deps: ReceiptMatchingDeps,
  db: PrismaClient,
): NonNullable<ReceiptMatchingDeps['lease']> {
  if (deps.lease) return deps.lease;
  return <T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ) => withEntityLease(key, owner, async () => {
    const entityDb = db as unknown as EntityLeaseDb;
    let renewalFailure: unknown;
    const heartbeat = setInterval(() => {
      void renewEntityLease(key, owner, { db: entityDb }).catch((error) => {
        renewalFailure = error;
      });
    }, 10_000);
    heartbeat.unref();
    try {
      const result = await callback();
      if (renewalFailure !== undefined) throw renewalFailure;
      await renewEntityLease(key, owner, { db: entityDb });
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }, { db: db as unknown as EntityLeaseDb });
}

function receiptFence(
  deps: ReceiptMatchingDeps,
): NonNullable<ReceiptMatchingDeps['fence']> {
  if (deps.fence) return deps.fence;
  if (deps.lease) return async () => undefined;
  return (key, owner, tx) => fenceEntityLeaseOwnership(key, owner, {
    db: tx as unknown as EntityLeaseFenceDb,
  });
}

async function clearStaleMatch(
  tx: Prisma.TransactionClient,
  receipt: LockedReceipt,
  actorUserId: string | null,
): Promise<void> {
  await tx.receiptMatchCandidate.updateMany({
    where: {
      documentId: receipt.id,
      transactionId: receipt.matchedTransactionId ?? undefined,
      state: { in: ['proposed', 'confirmed'] },
    },
    data: { state: 'stale' },
  });
  await tx.receiptDocument.update({
    where: { id: receipt.id },
    data: {
      status: 'READY',
      matchedTransactionId: null,
      matchedTransactionRevision: null,
      approvedAt: null,
      approvedByUserId: null,
      revision: { increment: 1 },
    },
  });
  await tx.receiptEvent.create({
    data: {
      companyId: receipt.companyId,
      documentId: receipt.id,
      actorUserId,
      action: 'match_stale',
      before: {
        revision: receipt.revision,
        transactionId: receipt.matchedTransactionId,
      },
      after: { stale: true },
    },
  });
}

async function finalizeReceiptAttach(
  db: PrismaClient,
  input: ReceiptAttachmentMutationInput,
  transactionId: string,
  preparedRevision: number,
  blobId: string | null,
  retainLocally: boolean,
  operation: AttachmentOperationDto,
  authority: ReceiptMutationAuthority,
): Promise<void> {
  const attachmentId = operation.files[0]?.id ?? null;
  const finalStatus = operation.status === 'VERIFIED' && attachmentId !== null
    ? 'ATTACHED'
    : operation.status === 'UNCERTAIN'
      || operation.status === 'COMMITTING'
      || operation.status === 'PREPARED'
      ? 'ATTACHING'
      : 'MATCHED';
  await runSerializableTransaction(db, async (tx) => {
    await authority.fence(authority.key, authority.owner, tx);
    const receipt = await lockReceipt(tx, input.documentId);
    if (
      !receipt
      || receipt.companyId !== input.companyId
      || receipt.revision !== preparedRevision
      || receipt.status !== 'ATTACHING'
      || receipt.matchedTransactionId !== transactionId
    ) return;
    const transaction = await tx.transaction.findFirst({
      where: {
        id: transactionId,
        companyId: input.companyId,
        revision: input.expectedTransactionRevision,
        status: { in: [...ACTIVE_TRANSACTION_STATUSES] },
      },
      select: { id: true },
    });
    if (!transaction) throw stale();
    await tx.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        status: finalStatus,
        ...(attachmentId !== null && finalStatus !== 'MATCHED'
          ? { transactionAttachmentId: attachmentId }
          : {}),
        ...(finalStatus === 'ATTACHED' && !retainLocally
          ? { blobId: null }
          : {}),
        revision: finalStatus === 'ATTACHING'
          ? undefined
          : { increment: 1 },
      },
    });
    if (finalStatus === 'ATTACHED' && !retainLocally && blobId !== null) {
      await tx.attachmentBlob.deleteMany({
        where: {
          id: blobId,
          receiptDocuments: { none: {} },
          stagedFiles: { none: {} },
          attachments: { none: {} },
        },
      });
    }
    await tx.receiptEvent.create({
      data: {
        companyId: input.companyId,
        documentId: receipt.id,
        actorUserId: input.actor.userId,
        action: finalStatus === 'ATTACHED'
          ? 'attach_verified'
          : finalStatus === 'ATTACHING'
            ? 'attach_uncertain'
            : 'attach_failed',
        before: { revision: receipt.revision, status: receipt.status },
        after: {
          operationId: operation.operationId,
          operationStatus: operation.status,
          attachmentId,
          status: finalStatus,
        },
      },
    });
  });
}

async function finalizeReceiptUndo(
  db: PrismaClient,
  input: ReceiptAttachmentMutationInput,
  preparedRevision: number,
  attachmentId: string,
  operation: AttachmentOperationDto,
  authority: ReceiptMutationAuthority,
): Promise<void> {
  const finalStatus = operation.status === 'DELETED'
    ? 'MATCHED'
    : operation.status === 'UNCERTAIN'
      || operation.status === 'DELETING'
      ? 'ATTACHING'
      : 'ATTACHED';
  await runSerializableTransaction(db, async (tx) => {
    await authority.fence(authority.key, authority.owner, tx);
    const receipt = await lockReceipt(tx, input.documentId);
    if (
      !receipt
      || receipt.companyId !== input.companyId
      || receipt.revision !== preparedRevision
      || receipt.status !== 'ATTACHING'
      || receipt.transactionAttachmentId !== attachmentId
    ) return;
    const transaction = await tx.transaction.findFirst({
      where: {
        id: receipt.matchedTransactionId ?? '',
        companyId: input.companyId,
        revision: input.expectedTransactionRevision,
      },
      select: { id: true },
    });
    if (!transaction) throw stale();
    await tx.receiptDocument.update({
      where: { id: receipt.id },
      data: {
        status: finalStatus,
        ...(finalStatus === 'MATCHED'
          ? { transactionAttachmentId: null }
          : {}),
        revision: finalStatus === 'ATTACHING'
          ? undefined
          : { increment: 1 },
      },
    });
    await tx.receiptEvent.create({
      data: {
        companyId: input.companyId,
        documentId: receipt.id,
        actorUserId: input.actor.userId,
        action: finalStatus === 'MATCHED'
          ? 'undo_verified'
          : finalStatus === 'ATTACHING'
            ? 'undo_uncertain'
            : 'undo_failed',
        before: { revision: receipt.revision, status: receipt.status },
        after: {
          operationId: operation.operationId,
          operationStatus: operation.status,
          status: finalStatus,
        },
      },
    });
  });
}

async function restoreReceiptStatus(
  db: PrismaClient,
  input: ReceiptAttachmentMutationInput,
  preparedRevision: number,
  status: 'MATCHED' | 'ATTACHED',
  action: 'attach_failed' | 'undo_failed',
  authority: ReceiptMutationAuthority,
): Promise<void> {
  await runSerializableTransaction(db, async (tx) => {
    await authority.fence(authority.key, authority.owner, tx);
    const receipt = await lockReceipt(tx, input.documentId);
    if (
      !receipt
      || receipt.companyId !== input.companyId
      || receipt.revision !== preparedRevision
      || receipt.status !== 'ATTACHING'
    ) return;
    await tx.receiptDocument.update({
      where: { id: receipt.id },
      data: { status, revision: { increment: 1 } },
    });
    await tx.receiptEvent.create({
      data: {
        companyId: input.companyId,
        documentId: receipt.id,
        actorUserId: input.actor.userId,
        action,
        before: { revision: receipt.revision, status: receipt.status },
        after: { status },
      },
    });
  });
}

interface ReceiptMutationAuthority {
  key: EntityLeaseKey;
  owner: string;
  fence: NonNullable<ReceiptMatchingDeps['fence']>;
}

function stale(): ReceiptError {
  return new ReceiptError(
    'RECEIPT_STALE',
    'Receipt or transaction revision changed; refresh before retrying.',
  );
}

function isRawSerializationConflict(error: unknown): boolean {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || error.code !== 'P2010'
    || !('meta' in error)
  ) return false;
  const meta = error.meta;
  return typeof meta === 'object'
    && meta !== null
    && 'code' in meta
    && meta.code === '40001';
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function transactionDirectionFilter(
  documentType: string | null,
): { amount?: { lt: number } | { gt: number } } {
  const normalized = documentType?.trim().toLowerCase();
  if (normalized && MONEY_OUT_DOCUMENT_TYPES.has(normalized)) {
    return { amount: { lt: 0 } };
  }
  if (normalized && MONEY_IN_DOCUMENT_TYPES.has(normalized)) {
    return { amount: { gt: 0 } };
  }
  return {};
}

function dateOnly(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

function toMatchableTransaction(
  transaction: {
    id: string;
    amount: Prisma.Decimal;
    date: Date;
    payee: string;
    memo: string | null;
    rawData: Prisma.JsonValue | null;
    status: string;
    revision: number;
  },
): MatchableTransaction {
  return {
    id: transaction.id,
    amount: transaction.amount.toString(),
    currency: rawCurrency(transaction.rawData),
    date: transaction.date.toISOString().slice(0, 10),
    payee: transaction.payee,
    memo: transaction.memo,
    rawData: transaction.rawData,
    status: transaction.status as MatchableTransaction['status'],
    revision: transaction.revision,
  };
}

function rawCurrency(value: Prisma.JsonValue | null): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const ref = value.CurrencyRef;
  if (typeof ref === 'string') return ref;
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return null;
  return typeof ref.value === 'string' ? ref.value : null;
}

function assertActor(actor: AttachmentActor, companyId: string): void {
  if (
    actor.isInstanceAdmin
    || actor.memberships.some((membership) =>
      membership.companyId === companyId
      && (membership.role === 'admin' || membership.role === 'categorizer'))
  ) return;
  throw new ReceiptError('RECEIPT_FORBIDDEN', 'Receipt access is forbidden.');
}
