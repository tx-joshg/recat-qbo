import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  ClassificationAction,
  ClassificationCase,
  ClassificationCaseContext,
  ClassificationCitation,
  ClassificationOriginIntent,
  ClassificationProvenance,
  ClassificationReviewer,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import {
  classificationActionSchema,
  parseClassificationCase,
} from './contracts.js';

const MAX_TEXT_CODE_POINTS = 2_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_ARRAY_ITEMS = 20;
const MAX_CITATIONS = 10;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

export interface ClassificationCaseDb {
  classificationCase: PrismaClient['classificationCase'];
  classificationCaseInvalidation: PrismaClient['classificationCaseInvalidation'];
  qboMutationAttempt: PrismaClient['qboMutationAttempt'];
  transaction: PrismaClient['transaction'];
  vendorIdentity: PrismaClient['vendorIdentity'];
}

export interface ClassificationCaseTransactionSnapshot {
  schemaVersion?: string;
  transactionId?: string;
  transactionRevision?: number;
  qboType?: string;
  qboId?: string;
  date?: string;
  amountCents?: number;
  currency?: string;
  payee?: string;
  memo?: string | null;
  sourceAccountName?: string | null;
}

export interface RecordClassificationCaseInput {
  companyId: string;
  transactionId?: string;
  qboMutationAttemptId?: string;
  requestId?: string;
  vendorIdentityId?: string | null;
  action: ClassificationAction;
  /** If supplied, it must equal the deterministic action fingerprint. */
  actionFingerprint?: string;
  originIntent: ClassificationOriginIntent;
  rationale: string;
  requiredEvidence: string[];
  examples: string[];
  counterexamples: string[];
  citations: ClassificationCitation[];
  reviewer: ClassificationReviewer;
  jurisdiction: string;
  currency: string;
  context: ClassificationCaseContext;
  provenance: ClassificationProvenance;
  /** A caller may add bounded, non-provider context; transaction facts win. */
  transactionSnapshot?: ClassificationCaseTransactionSnapshot;
}

export class ClassificationCaseError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'NOT_VERIFIED'
      | 'CONFLICT'
      | 'IMMUTABLE',
    message: string,
  ) {
    super(message);
    this.name = 'ClassificationCaseError';
  }
}

export type ClassificationCaseServiceDb = ClassificationCaseDb;

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new ClassificationCaseError('INVALID_INPUT', 'A company identifier is required.');
  }
}

function assertIdentifier(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} is required.`);
  }
  return value;
}

function boundedText(value: string, field: string, maximum = MAX_TEXT_CODE_POINTS): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} is not valid text.`);
  }
  const normalized = value.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > maximum) {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} exceeds its bounded text limit.`);
  }
  return normalized;
}

function boundedArray(values: string[], field: string, maximum = MAX_ARRAY_ITEMS): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} exceeds its bounded item limit.`);
  }
  return values.map((value, index) => boundedText(value, `${field}[${index}]`, 500));
}

function safeIsoDate(value: string, field: string): string {
  const normalized = boundedText(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} must be an ISO date or date-time.`);
  }
  return normalized;
}

function safeCurrency(value: string): string {
  const normalized = boundedText(value, 'Currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new ClassificationCaseError('INVALID_INPUT', 'Currency must be a three-letter code.');
  }
  return normalized;
}

function safeAmountCents(value: Prisma.Decimal | number | string): number {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(text);
  if (!match) {
    throw new ClassificationCaseError('INVALID_INPUT', 'Transaction amount is not a bounded decimal.');
  }
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = (whole * 100) + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new ClassificationCaseError('INVALID_INPUT', 'Transaction amount is too large.');
  }
  return match[1] === '-' ? -cents : cents;
}

function canonicalAction(action: ClassificationAction): Record<string, unknown> {
  return {
    categoryQboId: action.categoryQboId,
    taxCalculation: action.taxCalculation,
    taxCodeQboId: action.taxCodeQboId,
    tagIds: [...action.tagIds].sort(),
    memo: action.memo ?? null,
  };
}

export function classificationActionFingerprint(action: ClassificationAction): string {
  const parsed = classificationActionSchema.safeParse(action);
  if (!parsed.success) {
    throw new ClassificationCaseError('INVALID_INPUT', 'The classification action is invalid.');
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalAction(parsed.data)), 'utf8')
    .digest('hex');
}

function jsonSize(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ClassificationCaseError('INVALID_INPUT', 'The classification snapshot is not serializable.');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function boundedJsonObject(value: Record<string, unknown>, field: string): Prisma.InputJsonValue {
  if (jsonSize(value) > MAX_SNAPSHOT_BYTES) {
    throw new ClassificationCaseError('INVALID_INPUT', `${field} exceeds the bounded snapshot limit.`);
  }
  return value as Prisma.InputJsonValue;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

type CaseRow = {
  id: string;
  companyId: string;
  transactionId: string;
  vendorIdentityId: string | null;
  qboMutationAttemptId: string;
  action: Prisma.JsonValue;
  actionFingerprint: string;
  originIntent: string;
  rationale: string;
  requiredEvidence: Prisma.JsonValue;
  examples: Prisma.JsonValue;
  counterexamples: Prisma.JsonValue;
  citations: Prisma.JsonValue;
  reviewer: Prisma.JsonValue;
  jurisdiction: string;
  currency: string;
  context: Prisma.JsonValue;
  provenance: Prisma.JsonValue;
  transactionSnapshot: Prisma.JsonValue;
  verifiedAt: Date;
  createdAt: Date;
  invalidation?: {
    invalidatedAt: Date;
    reason: string;
  } | null;
};

const caseInclude = { invalidation: true };

function caseRow(row: CaseRow): ClassificationCase {
  const invalidation = row.invalidation ?? null;
  return parseClassificationCase({
    id: row.id,
    companyId: row.companyId,
    transactionId: row.transactionId,
    vendorIdentityId: row.vendorIdentityId,
    qboMutationAttemptId: row.qboMutationAttemptId,
    action: row.action,
    actionFingerprint: row.actionFingerprint,
    originIntent: row.originIntent,
    rationale: row.rationale,
    requiredEvidence: row.requiredEvidence,
    examples: row.examples,
    counterexamples: row.counterexamples,
    citations: row.citations,
    reviewer: row.reviewer,
    jurisdiction: row.jurisdiction,
    currency: row.currency,
    context: row.context,
    provenance: row.provenance,
    verifiedAt: row.verifiedAt.toISOString(),
    invalidatedAt: invalidation?.invalidatedAt.toISOString() ?? null,
    invalidationReason: invalidation?.reason ?? null,
  });
}

async function findCaseById(
  companyId: string,
  id: string,
  db: ClassificationCaseDb,
): Promise<CaseRow | null> {
  const row = await db.classificationCase.findUnique({
    where: { companyId_id: { companyId, id } },
    include: caseInclude,
  });
  return row as CaseRow | null;
}

async function findCaseByAttempt(
  companyId: string,
  qboMutationAttemptId: string,
  db: ClassificationCaseDb,
): Promise<CaseRow | null> {
  const row = await db.classificationCase.findUnique({
    where: { qboMutationAttemptId },
    include: caseInclude,
  });
  if (row === null || row.companyId !== companyId) return null;
  return row as CaseRow;
}

export async function getClassificationCase(
  companyId: string,
  id: string,
  db: ClassificationCaseDb = prisma,
): Promise<ClassificationCase | null> {
  assertCompanyId(companyId);
  const row = await findCaseById(companyId, assertIdentifier(id, 'Case identifier'), db);
  return row === null ? null : caseRow(row);
}

export async function getClassificationCaseByAttempt(
  companyId: string,
  qboMutationAttemptId: string,
  db: ClassificationCaseDb = prisma,
): Promise<ClassificationCase | null> {
  assertCompanyId(companyId);
  const row = await findCaseByAttempt(
    companyId,
    assertIdentifier(qboMutationAttemptId, 'QBO mutation attempt identifier'),
    db,
  );
  return row === null ? null : caseRow(row);
}

async function findAttempt(
  input: RecordClassificationCaseInput,
  db: ClassificationCaseDb,
) {
  const attemptId = input.qboMutationAttemptId;
  const requestId = input.requestId;
  if (attemptId === undefined && requestId === undefined) {
    throw new ClassificationCaseError(
      'INVALID_INPUT',
      'A QBO mutation attempt identifier or request identifier is required.',
    );
  }
  const [byId, byRequest] = await Promise.all([
    attemptId === undefined
      ? null
      : db.qboMutationAttempt.findFirst({
          where: {
            id: assertIdentifier(attemptId, 'QBO mutation attempt identifier'),
            transaction: { companyId: input.companyId },
          },
          select: {
            id: true,
            requestId: true,
            transactionId: true,
            status: true,
            verification: true,
            updatedAt: true,
          },
        }),
    requestId === undefined
      ? null
      : db.qboMutationAttempt.findFirst({
          where: {
            requestId: assertIdentifier(requestId, 'QBO request identifier'),
            transaction: { companyId: input.companyId },
          },
          select: {
            id: true,
            requestId: true,
            transactionId: true,
            status: true,
            verification: true,
            updatedAt: true,
          },
        }),
  ]);
  if (byId !== null && byRequest !== null && byId.id !== byRequest.id) {
    throw new ClassificationCaseError(
      'CONFLICT',
      'The QBO attempt and request identifiers refer to different attempts.',
    );
  }
  const attempt = byId ?? byRequest;
  if (attempt === null) {
    throw new ClassificationCaseError('NOT_FOUND', 'The QBO mutation attempt was not found.');
  }
  if (attempt.status !== 'VERIFIED') {
    throw new ClassificationCaseError(
      'NOT_VERIFIED',
      'Only a verified QBO mutation attempt can produce a classification case.',
    );
  }
  return attempt;
}

async function buildTransactionSnapshot(
  input: RecordClassificationCaseInput,
  attempt: { transactionId: string },
  db: ClassificationCaseDb,
  currency: string,
): Promise<{ transactionId: string; snapshot: Prisma.InputJsonValue }> {
  const transactionId = input.transactionId ?? attempt.transactionId;
  if (transactionId !== attempt.transactionId) {
    throw new ClassificationCaseError('CONFLICT', 'The transaction does not belong to the QBO attempt.');
  }
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      companyId: true,
      qboId: true,
      qboType: true,
      date: true,
      payee: true,
      memo: true,
      amount: true,
      bankAccount: true,
      revision: true,
    },
  });
  if (transaction === null || transaction.companyId !== input.companyId) {
    throw new ClassificationCaseError('NOT_FOUND', 'The transaction was not found in this company.');
  }
  if (!['Purchase', 'Deposit', 'JournalEntry'].includes(transaction.qboType)) {
    throw new ClassificationCaseError('INVALID_INPUT', 'The transaction type is not supported.');
  }
  if (input.context.qboType !== transaction.qboType) {
    throw new ClassificationCaseError('CONFLICT', 'Case context does not match the transaction type.');
  }
  const supplied = input.transactionSnapshot ?? {};
  const snapshot = boundedJsonObject({
    schemaVersion: boundedText(supplied.schemaVersion ?? 'classification-case/v1', 'Snapshot schema', 64),
    transactionId: transaction.id,
    transactionRevision: transaction.revision,
    qboType: transaction.qboType,
    qboId: boundedText(transaction.qboId, 'QBO transaction identifier', 120),
    date: transaction.date.toISOString(),
    amountCents: safeAmountCents(transaction.amount),
    currency,
    payee: boundedText(transaction.payee, 'Payee', 500),
    memo: transaction.memo === null ? null : boundedText(transaction.memo, 'Memo', 500),
    sourceAccountName: boundedText(transaction.bankAccount, 'Source account name', 500),
  }, 'Transaction snapshot');
  return { transactionId, snapshot };
}

function validateInput(input: RecordClassificationCaseInput): {
  action: ClassificationAction;
  actionFingerprint: string;
  originIntent: ClassificationOriginIntent;
  rationale: string;
  requiredEvidence: string[];
  examples: string[];
  counterexamples: string[];
  citations: ClassificationCitation[];
  reviewer: ClassificationReviewer;
  jurisdiction: string;
  currency: string;
  context: ClassificationCaseContext;
  provenance: ClassificationProvenance;
} {
  assertCompanyId(input.companyId);
  const parsedAction = classificationActionSchema.safeParse(input.action);
  if (!parsedAction.success) {
    throw new ClassificationCaseError('INVALID_INPUT', 'The classification action is invalid.');
  }
  const action = parsedAction.data;
  const actionFingerprint = classificationActionFingerprint(action);
  if (
    input.actionFingerprint !== undefined
    && (
      !FINGERPRINT.test(input.actionFingerprint)
      || input.actionFingerprint !== actionFingerprint
    )
  ) {
    throw new ClassificationCaseError('CONFLICT', 'The action fingerprint does not match the action.');
  }
  if (
    input.originIntent !== 'apply_once'
    && input.originIntent !== 'make_recurring'
    && input.originIntent !== 'auto_candidate'
  ) {
    throw new ClassificationCaseError('INVALID_INPUT', 'The classification origin intent is invalid.');
  }
  const reviewer = input.reviewer;
  if (
    reviewer === null
    || typeof reviewer !== 'object'
    || reviewer.decision !== 'approved'
  ) {
    throw new ClassificationCaseError('INVALID_INPUT', 'An approved reviewer record is required.');
  }
  const provenance = input.provenance;
  if (
    provenance === null
    || typeof provenance !== 'object'
    || provenance.source !== 'qbo_verified'
  ) {
    throw new ClassificationCaseError('INVALID_INPUT', 'QBO-verified provenance is required.');
  }
  const jurisdiction = input.jurisdiction === 'unknown'
    ? 'unknown'
    : boundedText(input.jurisdiction, 'Jurisdiction', 128);
  const currency = safeCurrency(input.currency);
  const context = input.context;
  if (
    context === null
    || typeof context !== 'object'
    || !['in', 'out', 'unknown'].includes(context.transactionDirection)
    || !['Purchase', 'Deposit', 'JournalEntry'].includes(context.qboType)
  ) {
    throw new ClassificationCaseError('INVALID_INPUT', 'The classification context is invalid.');
  }
  return {
    action,
    actionFingerprint,
    originIntent: input.originIntent,
    rationale: boundedText(input.rationale, 'Rationale', 2_000),
    requiredEvidence: boundedArray(input.requiredEvidence, 'Required evidence'),
    examples: boundedArray(input.examples, 'Examples'),
    counterexamples: boundedArray(input.counterexamples, 'Counterexamples'),
    citations: input.citations.length > MAX_CITATIONS
      ? (() => { throw new ClassificationCaseError('INVALID_INPUT', 'Citations exceed their bounded item limit.'); })()
      : input.citations.map((citation, index) => ({
          url: boundedText(citation.url, `Citations[${index}].url`, 2_048),
          title: boundedText(citation.title, `Citations[${index}].title`, 500),
          publisher: boundedText(citation.publisher, `Citations[${index}].publisher`, 500),
          retrievedAt: safeIsoDate(citation.retrievedAt, `Citations[${index}].retrievedAt`),
          claimSummary: boundedText(citation.claimSummary, `Citations[${index}].claimSummary`, 2_000),
        })),
    reviewer: {
      userId: reviewer.userId === null
        ? null
        : boundedText(reviewer.userId, 'Reviewer user identifier', 128),
      configVersion: boundedText(reviewer.configVersion, 'Reviewer config version', 128),
      decision: 'approved',
    },
    jurisdiction,
    currency,
    context: {
      transactionDirection: context.transactionDirection,
      qboType: context.qboType,
      sourceAccountName: context.sourceAccountName === null
        ? null
        : boundedText(context.sourceAccountName, 'Source account name', 500),
      businessPurpose: context.businessPurpose === null
        ? null
        : boundedText(context.businessPurpose, 'Business purpose', 500),
    },
    provenance: {
      source: 'qbo_verified',
      sourceId: boundedText(provenance.sourceId, 'Provenance source identifier', 128),
      actorId: provenance.actorId === null
        ? null
        : boundedText(provenance.actorId, 'Provenance actor identifier', 128),
      recordedAt: safeIsoDate(provenance.recordedAt, 'Provenance recordedAt'),
    },
  };
}

function dbTransaction<T>(
  db: ClassificationCaseDb,
  callback: (tx: ClassificationCaseDb) => Promise<T>,
): Promise<T> {
  const candidate = db as unknown as { $transaction?: unknown };
  if (typeof candidate.$transaction === 'function') {
    return (candidate.$transaction as <R>(fn: (tx: unknown) => Promise<R>) => Promise<R>)(
      (tx) => callback(tx as ClassificationCaseDb),
    );
  }
  return callback(db);
}

function ownsTransaction(db: ClassificationCaseDb): boolean {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === 'function';
}

/**
 * Persists one immutable case for one verified QBO attempt. The attempt's
 * globally unique requestId and the case's unique attempt FK make retries
 * idempotent even when two workers race to record the same outcome.
 */
export async function recordVerifiedClassificationCase(
  input: RecordClassificationCaseInput,
  db: ClassificationCaseDb = prisma,
): Promise<ClassificationCase> {
  const checked = validateInput(input);
  const canRecoverWithRootClient = ownsTransaction(db);
  let recoveryAttemptId: string | null = null;
  try {
    return await dbTransaction(db, async (tx) => {
      const attempt = await findAttempt(input, tx);
      recoveryAttemptId = attempt.id;
      const existing = await findCaseByAttempt(input.companyId, attempt.id, tx);
      if (existing !== null) {
        if (
          existing.transactionId !== attempt.transactionId
          || existing.actionFingerprint !== checked.actionFingerprint
        ) {
          throw new ClassificationCaseError(
            'CONFLICT',
            'The verified attempt already has a different immutable classification case.',
          );
        }
        return caseRow(existing);
      }
      const vendorIdentityId = input.vendorIdentityId ?? null;
      if (vendorIdentityId !== null) {
        const identity = await tx.vendorIdentity.findUnique({
          where: { companyId_id: { companyId: input.companyId, id: vendorIdentityId } },
          select: { id: true },
        });
        if (identity === null) {
          throw new ClassificationCaseError('NOT_FOUND', 'The vendor identity was not found in this company.');
        }
      }
      const built = await buildTransactionSnapshot(input, attempt, tx, checked.currency);
      const verifiedAt = attempt.updatedAt;
      const provenance = {
        ...checked.provenance,
        sourceId: attempt.id,
        recordedAt: verifiedAt.toISOString(),
      };
      const reviewer = checked.reviewer;
      const created = {
        companyId: input.companyId,
        transactionId: built.transactionId,
        vendorIdentityId,
        qboMutationAttemptId: attempt.id,
        action: asJson(checked.action),
        actionFingerprint: checked.actionFingerprint,
        originIntent: checked.originIntent,
        rationale: checked.rationale,
        requiredEvidence: asJson(checked.requiredEvidence),
        examples: asJson(checked.examples),
        counterexamples: asJson(checked.counterexamples),
        citations: asJson(checked.citations),
        reviewer: asJson(reviewer),
        jurisdiction: checked.jurisdiction,
        currency: checked.currency,
        context: asJson(checked.context),
        provenance: asJson(provenance),
        transactionSnapshot: built.snapshot,
        verifiedAt,
      } satisfies Prisma.ClassificationCaseUncheckedCreateInput;
      const row = await tx.classificationCase.create({
        data: created,
        include: caseInclude,
      });
      return caseRow(row as CaseRow);
    });
  } catch (error) {
    if (!isUniqueViolation(error) || recoveryAttemptId === null) throw error;
    // PostgreSQL aborts a transaction after a unique violation. A caller-owned
    // TransactionClient cannot safely re-query here; its root caller must
    // recover outside the failed transaction instead.
    if (!canRecoverWithRootClient) throw error;
    const raced = await findCaseByAttempt(input.companyId, recoveryAttemptId, db);
    if (raced === null) throw error;
    if (raced.actionFingerprint !== checked.actionFingerprint) {
      throw new ClassificationCaseError(
        'CONFLICT',
        'The verified attempt already has a different immutable classification case.',
      );
    }
    return caseRow(raced);
  }
}

export const createClassificationCase = recordVerifiedClassificationCase;
export const persistClassificationCase = recordVerifiedClassificationCase;

export async function getClassificationCaseByRequestId(
  companyId: string,
  requestId: string,
  db: ClassificationCaseDb = prisma,
): Promise<ClassificationCase | null> {
  assertCompanyId(companyId);
  const attempt = await db.qboMutationAttempt.findUnique({
    where: { requestId: assertIdentifier(requestId, 'QBO request identifier') },
    select: { id: true },
  });
  if (attempt === null) return null;
  return getClassificationCaseByAttempt(companyId, attempt.id, db);
}

export async function invalidateClassificationCase(
  companyId: string,
  caseId: string,
  reason: string,
  db: ClassificationCaseDb = prisma,
  invalidatedAt = new Date(),
): Promise<ClassificationCase> {
  assertCompanyId(companyId);
  const checkedCaseId = assertIdentifier(caseId, 'Case identifier');
  const normalizedReason = boundedText(reason, 'Invalidation reason', 500);
  try {
    return await dbTransaction(db, async (tx) => {
      const current = await findCaseById(companyId, checkedCaseId, tx);
      if (current === null) {
        throw new ClassificationCaseError('NOT_FOUND', 'The classification case was not found in this company.');
      }
      const existing = current.invalidation;
      if (existing !== undefined && existing !== null) {
        if (existing.reason !== normalizedReason) {
          throw new ClassificationCaseError('CONFLICT', 'The case already has a different invalidation event.');
        }
        return caseRow(current);
      }
      await tx.classificationCaseInvalidation.create({
        data: {
          companyId,
          classificationCaseId: current.id,
          reason: normalizedReason,
          invalidatedAt,
        },
      });
      const updated = await findCaseById(companyId, current.id, tx);
      if (updated === null) throw new ClassificationCaseError('NOT_FOUND', 'The classification case was not found.');
      return caseRow(updated);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findCaseById(companyId, checkedCaseId, db);
    if (raced?.invalidation === undefined || raced.invalidation === null) throw error;
    if (raced.invalidation.reason !== normalizedReason) {
      throw new ClassificationCaseError('CONFLICT', 'The case already has a different invalidation event.');
    }
    return caseRow(raced);
  }
}
