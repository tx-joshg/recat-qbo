import { prisma } from '../../lib/prisma.js';
import { z } from 'zod';
import { QboDepositPreparationError } from '../../lib/qbo/depositTax.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import type { QboClient } from '../../lib/qbo/types.js';
import { assertQboWriteAllowed } from '../../lib/qbo/writeSafety.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import { moneyToCents } from '../tax/model.js';
import { writeAudit } from '../audit.js';
import {
  createPreparedOperation,
  hasValidMcpOperationIntegrity,
  McpOperationError,
  normalizeMcpOperationIdempotencyKey,
  type CreatePreparedOperationInput,
  type McpOperationRecord,
} from './operations.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  McpCategorizationError,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';

const TOOL_NAME = 'prepare_tax_refund';
const SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_REFERENCE = 120;
const MAX_WARNINGS = 8;
const MAX_WARNING = 500;
const MANUAL_REFUND_EXPIRY = '9999-12-31T23:59:59.999Z';

export interface PrepareMcpTaxRefundInput {
  companyId: string;
  transactionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  taxAgencyQboId: string;
  filedReturnRef: string;
  filingEvidenceSha256: string;
  suspenseAccountQboId: string;
  bankAccountQboId: string;
  refundDate: string;
  principalCents: number;
  interestCents?: number;
  interestAccountQboId?: string;
}

export interface PreparedMcpTaxRefundDto {
  operationId: string;
  expiresAt: string;
  capability: 'manual_required';
  preview: {
    action: 'record_gst_hst_refund';
    operatorPath: 'Sales Tax > Filed > Record refund';
    sourceDepositQboId: string;
    taxAgencyQboId: string;
    filedReturnRef: string;
    filingEvidenceSha256: string;
    suspenseAccountQboId: string;
    bankAccountQboId: string;
    refundDate: string;
    principalCents: number;
    interestCents: number;
    interestAccountQboId: string | null;
    totalBankCreditCents: number;
    existingDepositTreatment: 'replace_or_match_before_verification';
  };
  warnings: string[];
}

export interface CancelMcpTaxRefundInput {
  operationId: string;
  confirmNoQuickBooksAction: true;
}

export interface CancelledMcpTaxRefundDto {
  operationId: string;
  state: 'cancelled';
  cancelledAt: string;
}

export interface AcknowledgeMcpTaxRefundRecordedInput {
  operationId: string;
  confirmQuickBooksActionPerformed: true;
}

export interface AcknowledgedMcpTaxRefundRecordedDto {
  operationId: string;
  state: 'reconciliation_required';
  manualRecordedAt: string;
}

const taxRefundPreviewSchema = z.object({
  action: z.literal('record_gst_hst_refund'),
  operatorPath: z.literal('Sales Tax > Filed > Record refund'),
  sourceDepositQboId: z.string().min(1).max(MAX_REFERENCE),
  taxAgencyQboId: z.string().min(1).max(MAX_REFERENCE),
  filedReturnRef: z.string().min(1).max(MAX_REFERENCE),
  filingEvidenceSha256: z.string().regex(SHA256),
  suspenseAccountQboId: z.string().min(1).max(MAX_REFERENCE),
  bankAccountQboId: z.string().min(1).max(MAX_REFERENCE),
  refundDate: z.string().refine(isCalendarDate),
  principalCents: z.number().int().positive().refine(Number.isSafeInteger),
  interestCents: z.number().int().nonnegative().refine(Number.isSafeInteger),
  interestAccountQboId: z.string().min(1).max(MAX_REFERENCE).nullable(),
  totalBankCreditCents: z.number().int().positive().refine(Number.isSafeInteger),
  existingDepositTreatment: z.literal('replace_or_match_before_verification'),
}).strict().superRefine((preview, context) => {
  if (preview.totalBankCreditCents !== preview.principalCents + preview.interestCents) {
    context.addIssue({ code: 'custom', message: 'Refund total does not match its components.' });
  }
  if ((preview.interestCents > 0) !== (preview.interestAccountQboId !== null)) {
    context.addIssue({ code: 'custom', message: 'Interest account does not match interest amount.' });
  }
});

const taxRefundPayloadSchema = z.object({
  capability: z.literal('manual_required'),
  preview: taxRefundPreviewSchema,
  warnings: z.array(z.string().max(MAX_WARNING)).max(MAX_WARNINGS),
}).strict();

export type StoredMcpTaxRefundPayload = z.infer<typeof taxRefundPayloadSchema>;

export function validateMcpTaxRefundEnvelope(
  operation: McpOperationRecord,
): StoredMcpTaxRefundPayload {
  const parsed = taxRefundPayloadSchema.safeParse(operation.payload);
  if (
    !parsed.success
    || !hasValidMcpOperationIntegrity(operation)
    || operation.toolName !== TOOL_NAME
    || operation.kind !== 'tax_refund'
    || operation.qboType !== 'Deposit'
    || operation.sourceRevision !== operation.preparedRevision
    || parsed.data.preview.sourceDepositQboId !== operation.qboId
  ) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  return parsed.data;
}

export type McpTaxRefundErrorCode =
  | 'INVALID_INPUT'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_DEPOSIT'
  | 'SOURCE_NOT_PENDING'
  | 'SOURCE_ALREADY_PREPARED'
  | 'SOURCE_PREPARATION_CANCELLED'
  | 'SOURCE_ALREADY_RECORDED'
  | 'STALE_SOURCE'
  | 'QBO_SOURCE_CHANGED'
  | 'AMOUNT_MISMATCH'
  | 'SYSTEM_SUSPENSE_REQUIRED'
  | 'BANK_ACCOUNT_REQUIRED'
  | 'INTEREST_ACCOUNT_REQUIRED';

export class McpTaxRefundError extends Error {
  constructor(readonly code: McpTaxRefundErrorCode) {
    super('GST/HST refund preparation failed.');
    this.name = 'McpTaxRefundError';
  }
}

interface TaxRefundTransaction {
  id: string;
  companyId: string;
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  revision: number;
  status: string;
  amount: unknown;
  date: Date;
}

export interface McpTaxRefundDeps {
  authorize?: (
    principal: McpPrincipal,
    companyId: string,
    checkedAt: Date,
  ) => Promise<void>;
  loadTransaction?: (companyId: string, transactionId: string) => Promise<TaxRefundTransaction | null>;
  loadReplay?: (
    principal: McpPrincipal,
    transactionId: string,
    idempotencyKey: string,
  ) => Promise<McpOperationRecord | null>;
  loadSourcePreparation?: (
    companyId: string,
    transactionId: string,
  ) => Promise<McpOperationRecord | null>;
  getClient?: (companyId: string) => Promise<QboClient>;
  createOperation?: (
    input: CreatePreparedOperationInput,
    dependencies?: { now?: () => Date; expiresAt?: () => Date },
  ) => Promise<McpOperationRecord>;
  now?: () => Date;
}

export interface McpTaxRefundCancellationDeps {
  authorize?: (
    principal: McpPrincipal,
    companyId: string,
    checkedAt: Date,
  ) => Promise<void>;
  loadOperation?: (
    operationId: string,
  ) => Promise<McpOperationRecord>;
  cancelOperation?: (
    operationId: string,
    cancelledAt: Date,
  ) => Promise<{ count: number }>;
  now?: () => Date;
}

export async function cancelMcpTaxRefund(
  principal: McpPrincipal,
  input: CancelMcpTaxRefundInput,
  dependencies: McpTaxRefundCancellationDeps = {},
): Promise<CancelledMcpTaxRefundDto> {
  const now = dependencies.now?.() ?? new Date();
  if (
    !Number.isFinite(now.getTime())
    || typeof input?.operationId !== 'string'
    || input.operationId.trim().length === 0
    || input.operationId.length > MAX_REFERENCE
    || input.confirmNoQuickBooksAction !== true
  ) {
    throw new McpTaxRefundError('INVALID_INPUT');
  }

  const loadOperation = dependencies.loadOperation ?? (async (operationId) => {
    const found = await prisma.mcpOperation.findFirst({ where: { id: operationId } });
    if (found === null) throw new McpOperationError('OPERATION_NOT_FOUND');
    return found as McpOperationRecord;
  });
  const operation = await loadOperation(input.operationId);
  if (operation.kind !== 'tax_refund' || operation.toolName !== TOOL_NAME) {
    throw new McpOperationError('OPERATION_NOT_FOUND');
  }

  const authorize = dependencies.authorize ?? (async (actor, companyId, checkedAt) => {
    await assertCurrentMcpCategorizationAuthorization(
      prisma as unknown as McpCategorizationAuthorizationStore,
      actor,
      companyId,
      checkedAt,
    );
  });
  await authorizeRefundManagement(authorize, principal, operation.companyId, now);
  assertCanManageRefund(principal, operation);
  const payload = validateMcpTaxRefundEnvelope(operation);
  if (operation.cancelledAt !== null) return cancelledDto(operation.id, operation.cancelledAt);
  const correctingRecordedAttestation = operation.manualRecordedAt != null;
  if (correctingRecordedAttestation && !isRefundAdmin(principal, operation.companyId)) {
    throw new McpTaxRefundError('SOURCE_ALREADY_RECORDED');
  }

  const cancelOperation = dependencies.cancelOperation ?? (async (operationId, cancelledAt) => (
    prisma.$transaction(async (transaction) => {
      const updated = await transaction.mcpOperation.updateMany({
        where: {
          id: operationId,
          kind: 'tax_refund',
          cancelledAt: null,
          manualRecordedAt: operation.manualRecordedAt ?? null,
        },
        data: { cancelledAt },
      });
      if (updated.count === 1) {
        await writeAudit(transaction, refundAuditEntry(
          principal,
          operation,
          payload,
          correctingRecordedAttestation
            ? 'tax-refund-recording-corrected'
            : 'tax-refund-cancelled',
          correctingRecordedAttestation
            ? 'tax_refund_recorded_unverified'
            : 'tax_refund_prepared',
          'tax_refund_cancelled',
        ));
      }
      return updated;
    })
  ));
  const updated = await cancelOperation(operation.id, now);
  if (updated.count === 1) return cancelledDto(operation.id, now);

  const raced = await loadOperation(input.operationId);
  if (raced.cancelledAt !== null) return cancelledDto(raced.id, raced.cancelledAt);
  throw new McpOperationError('OPERATION_CONFLICT');
}

export interface McpTaxRefundAcknowledgementDeps {
  authorize?: McpTaxRefundCancellationDeps['authorize'];
  loadOperation?: McpTaxRefundCancellationDeps['loadOperation'];
  recordOperation?: (
    operationId: string,
    manualRecordedAt: Date,
  ) => Promise<{ count: number }>;
  now?: () => Date;
}

export async function acknowledgeMcpTaxRefundRecorded(
  principal: McpPrincipal,
  input: AcknowledgeMcpTaxRefundRecordedInput,
  dependencies: McpTaxRefundAcknowledgementDeps = {},
): Promise<AcknowledgedMcpTaxRefundRecordedDto> {
  const now = dependencies.now?.() ?? new Date();
  if (
    !Number.isFinite(now.getTime())
    || typeof input?.operationId !== 'string'
    || input.operationId.trim().length === 0
    || input.operationId.length > MAX_REFERENCE
    || input.confirmQuickBooksActionPerformed !== true
  ) {
    throw new McpTaxRefundError('INVALID_INPUT');
  }

  const loadOperation = dependencies.loadOperation ?? (async (operationId) => {
    const found = await prisma.mcpOperation.findFirst({ where: { id: operationId } });
    if (found === null) throw new McpOperationError('OPERATION_NOT_FOUND');
    return found as McpOperationRecord;
  });
  const operation = await loadOperation(input.operationId);
  if (operation.kind !== 'tax_refund' || operation.toolName !== TOOL_NAME) {
    throw new McpOperationError('OPERATION_NOT_FOUND');
  }
  const authorize = dependencies.authorize ?? (async (actor, companyId, checkedAt) => {
    await assertCurrentMcpCategorizationAuthorization(
      prisma as unknown as McpCategorizationAuthorizationStore,
      actor,
      companyId,
      checkedAt,
    );
  });
  await authorizeRefundManagement(authorize, principal, operation.companyId, now);
  assertCanManageRefund(principal, operation);
  const payload = validateMcpTaxRefundEnvelope(operation);
  if (operation.cancelledAt !== null) {
    throw new McpTaxRefundError('SOURCE_PREPARATION_CANCELLED');
  }
  if (operation.manualRecordedAt != null) {
    return acknowledgedDto(operation.id, operation.manualRecordedAt);
  }

  const recordOperation = dependencies.recordOperation ?? (async (operationId, recordedAt) => (
    prisma.$transaction(async (transaction) => {
      const updated = await transaction.mcpOperation.updateMany({
        where: {
          id: operationId,
          kind: 'tax_refund',
          cancelledAt: null,
          manualRecordedAt: null,
        },
        data: { manualRecordedAt: recordedAt },
      });
      if (updated.count === 1) {
        await writeAudit(transaction, refundAuditEntry(
          principal,
          operation,
          payload,
          'tax-refund-recorded',
          'tax_refund_prepared',
          'tax_refund_recorded_unverified',
        ));
      }
      return updated;
    })
  ));
  const updated = await recordOperation(operation.id, now);
  if (updated.count === 1) return acknowledgedDto(operation.id, now);

  const raced = await loadOperation(input.operationId);
  if (raced.manualRecordedAt != null) return acknowledgedDto(raced.id, raced.manualRecordedAt);
  throw new McpOperationError('OPERATION_CONFLICT');
}

export function canManageMcpTaxRefund(
  principal: McpPrincipal,
  operation: McpOperationRecord,
): boolean {
  const companyAdmin = principal.memberships.some((membership) => (
    membership.companyId === operation.companyId && membership.role === 'admin'
  ));
  return operation.userId === principal.userId
    || principal.isInstanceAdmin === true
    || companyAdmin;
}

function isRefundAdmin(principal: McpPrincipal, companyId: string): boolean {
  return principal.isInstanceAdmin === true || principal.memberships.some((membership) => (
    membership.companyId === companyId && membership.role === 'admin'
  ));
}

function assertCanManageRefund(
  principal: McpPrincipal,
  operation: McpOperationRecord,
): void {
  if (!canManageMcpTaxRefund(principal, operation)) {
    throw new McpOperationError('OPERATION_NOT_FOUND');
  }
}

function refundAuditEntry(
  principal: McpPrincipal,
  operation: McpOperationRecord,
  payload: StoredMcpTaxRefundPayload,
  action: 'tax-refund-cancelled' | 'tax-refund-recorded' | 'tax-refund-recording-corrected',
  before: string,
  after: string,
) {
  return {
    companyId: operation.companyId,
    actorId: principal.userId,
    actorLabel: `MCP ${principal.tokenPrefix}`,
    txnId: operation.transactionId,
    payee: 'Government of Canada GST/HST refund',
    amount: payload.preview.totalBankCreditCents / 100,
    action,
    before,
    after,
    payload: {
      operationId: operation.id,
      transition: action,
      tokenPrefix: principal.tokenPrefix,
    },
  } as const;
}

async function authorizeRefundManagement(
  authorize: NonNullable<McpTaxRefundCancellationDeps['authorize']>,
  principal: McpPrincipal,
  companyId: string,
  now: Date,
): Promise<void> {
  try {
    await authorize(principal, companyId, now);
  } catch (error) {
    if (
      error instanceof McpCategorizationError
      && (error.code === 'MCP_UNAUTHORIZED' || error.code === 'MCP_FORBIDDEN')
    ) {
      throw new McpOperationError('OPERATION_NOT_FOUND');
    }
    throw error;
  }
}

function cancelledDto(operationId: string, cancelledAt: Date): CancelledMcpTaxRefundDto {
  if (!Number.isFinite(cancelledAt.getTime())) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  return {
    operationId,
    state: 'cancelled',
    cancelledAt: cancelledAt.toISOString(),
  };
}

function acknowledgedDto(
  operationId: string,
  manualRecordedAt: Date,
): AcknowledgedMcpTaxRefundRecordedDto {
  if (!Number.isFinite(manualRecordedAt.getTime())) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  return {
    operationId,
    state: 'reconciliation_required',
    manualRecordedAt: manualRecordedAt.toISOString(),
  };
}

export async function prepareMcpTaxRefund(
  principal: McpPrincipal,
  input: PrepareMcpTaxRefundInput,
  dependencies: McpTaxRefundDeps = {},
): Promise<PreparedMcpTaxRefundDto> {
  const now = dependencies.now?.() ?? new Date();
  validateInput(input, now);
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) throw new McpTaxRefundError('INVALID_INPUT');

  const authorize = dependencies.authorize ?? (async (actor, companyId, checkedAt) => {
    await assertCurrentMcpCategorizationAuthorization(
      prisma as unknown as McpCategorizationAuthorizationStore,
      actor,
      companyId,
      checkedAt,
    );
  });
  await authorize(principal, input.companyId, now);

  const loadReplay = dependencies.loadReplay ?? (async (actor, transactionId, key) => (
    prisma.mcpOperation.findFirst({
      where: {
        tokenId: actor.tokenId,
        userId: actor.userId,
        toolName: TOOL_NAME,
        transactionId,
        idempotencyKey: key,
      },
    }) as Promise<McpOperationRecord | null>
  ));
  const replay = await loadReplay(principal, input.transactionId, idempotencyKey);
  if (replay !== null) return preparedReplayDto(replay, principal, input, idempotencyKey);

  const loadSourcePreparation = dependencies.loadSourcePreparation
    ?? (async (companyId, transactionId) => (
      prisma.mcpOperation.findFirst({
        where: { companyId, transactionId, kind: 'tax_refund', cancelledAt: null },
      }) as Promise<McpOperationRecord | null>
    ));
  const sourcePreparation = await loadSourcePreparation(input.companyId, input.transactionId);
  if (sourcePreparation !== null) {
    throw new McpTaxRefundError('SOURCE_ALREADY_PREPARED');
  }

  const loadTransaction = dependencies.loadTransaction ?? (async (companyId, transactionId) => (
    prisma.transaction.findFirst({ where: { id: transactionId, companyId } })
  ));
  const source = await loadTransaction(input.companyId, input.transactionId);
  if (source === null) throw new McpTaxRefundError('SOURCE_NOT_FOUND');
  if (source.qboType !== 'Deposit') throw new McpTaxRefundError('SOURCE_NOT_DEPOSIT');
  if (source.status !== 'PENDING') throw new McpTaxRefundError('SOURCE_NOT_PENDING');
  if (source.revision !== input.expectedRevision) throw new McpTaxRefundError('STALE_SOURCE');
  if (
    !Number.isFinite(source.date.getTime())
    || source.date.toISOString().slice(0, 10) !== input.refundDate
  ) {
    throw new McpTaxRefundError('QBO_SOURCE_CHANGED');
  }

  const client = await (dependencies.getClient ?? qboFactory.forCompany)(input.companyId);
  let capability;
  let accounts;
  let snapshot;
  let writeSafety;
  try {
    [capability, accounts, snapshot, writeSafety] = await Promise.all([
      client.probeTaxRefundCapability(),
      client.listAccounts(),
      client.fetchPreparedSnapshot('Deposit', source.qboId),
      client.fetchWriteSafety({
        qboType: 'Deposit',
        qboId: source.qboId,
        txnDate: input.refundDate,
        bankAccountQboId: input.bankAccountQboId,
      }),
    ]);
  } catch (error) {
    if (error instanceof QboDepositPreparationError) {
      throw new McpTaxRefundError('QBO_SOURCE_CHANGED');
    }
    throw error;
  }
  if (
    snapshot === null
    || !('depositToAccountQboId' in snapshot)
    || snapshot.qboId !== source.qboId
    || snapshot.syncToken !== source.qboSyncToken
    || snapshot.date !== input.refundDate
    || snapshot.depositToAccountQboId !== input.bankAccountQboId
  ) {
    throw new McpTaxRefundError('QBO_SOURCE_CHANGED');
  }
  assertQboWriteAllowed({
    qboType: 'Deposit',
    qboId: source.qboId,
    txnDate: input.refundDate,
    bankAccountQboId: input.bankAccountQboId,
  }, writeSafety);

  const suspense = accounts.find((account) => account.qboId === input.suspenseAccountQboId);
  if (
    suspense?.active !== true
    || suspense.accountSubType !== 'GlobalTaxSuspense'
  ) {
    throw new McpTaxRefundError('SYSTEM_SUSPENSE_REQUIRED');
  }
  const bank = accounts.find((account) => account.qboId === input.bankAccountQboId);
  if (bank?.active !== true || bank.classification !== 'Bank') {
    throw new McpTaxRefundError('BANK_ACCOUNT_REQUIRED');
  }

  const interestCents = input.interestCents ?? 0;
  if (interestCents > 0) {
    const interestAccount = accounts.find(
      (account) => account.qboId === input.interestAccountQboId,
    );
    if (interestAccount?.active !== true) {
      throw new McpTaxRefundError('INTEREST_ACCOUNT_REQUIRED');
    }
  }
  const totalBankCreditCents = input.principalCents + interestCents;
  if (
    moneyToCents(Number(source.amount)) !== totalBankCreditCents
    || snapshot.totalCents !== totalBankCreditCents
  ) {
    throw new McpTaxRefundError('AMOUNT_MISMATCH');
  }

  const preview: PreparedMcpTaxRefundDto['preview'] = {
    action: 'record_gst_hst_refund',
    operatorPath: 'Sales Tax > Filed > Record refund',
    sourceDepositQboId: source.qboId,
    taxAgencyQboId: input.taxAgencyQboId,
    filedReturnRef: input.filedReturnRef,
    filingEvidenceSha256: input.filingEvidenceSha256,
    suspenseAccountQboId: input.suspenseAccountQboId,
    bankAccountQboId: input.bankAccountQboId,
    refundDate: input.refundDate,
    principalCents: input.principalCents,
    interestCents,
    interestAccountQboId: input.interestAccountQboId ?? null,
    totalBankCreditCents,
    existingDepositTreatment: 'replace_or_match_before_verification',
  };
  const warnings = [
    'Manual QuickBooks Tax Centre action required; preparation does not post the refund.',
    'The existing Deposit must be replaced or matched before verification so cash is not duplicated.',
  ];
  const createOperation = dependencies.createOperation ?? createPreparedOperation;
  let operation: McpOperationRecord;
  try {
    operation = await createOperation({
      principal,
      companyId: input.companyId,
      transactionId: source.id,
      toolName: TOOL_NAME,
      kind: 'tax_refund',
      idempotencyKey,
      payload: { capability: capability.mode, preview, warnings },
      sourceRevision: source.revision,
      preparedRevision: source.revision,
      qboType: source.qboType,
      qboId: source.qboId,
      qboSyncToken: source.qboSyncToken,
      retryOfId: null,
    }, {
      now: () => now,
      expiresAt: () => new Date(MANUAL_REFUND_EXPIRY),
    });
  } catch (error) {
    if (error instanceof McpOperationError && error.code === 'OPERATION_CONFLICT') {
      const winner = await loadSourcePreparation(input.companyId, input.transactionId);
      if (winner !== null) throw new McpTaxRefundError('SOURCE_ALREADY_PREPARED');
    }
    throw error;
  }

  return {
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    capability: capability.mode,
    preview,
    warnings,
  };
}

function preparedReplayDto(
  operation: McpOperationRecord,
  principal: McpPrincipal,
  input: PrepareMcpTaxRefundInput,
  idempotencyKey: string,
): PreparedMcpTaxRefundDto {
  const payload = validateMcpTaxRefundEnvelope(operation);
  if (operation.cancelledAt !== null) {
    throw new McpTaxRefundError('SOURCE_PREPARATION_CANCELLED');
  }
  if (operation.manualRecordedAt != null) {
    throw new McpTaxRefundError('SOURCE_ALREADY_RECORDED');
  }
  const preview = payload.preview;
  const warnings = payload.warnings;
  const interestCents = input.interestCents ?? 0;
  const interestAccountQboId = input.interestAccountQboId ?? null;
  if (
    operation.tokenId !== principal.tokenId
    || operation.tokenPrefix !== principal.tokenPrefix
    || operation.userId !== principal.userId
    || operation.companyId !== input.companyId
    || operation.transactionId !== input.transactionId
    || operation.toolName !== TOOL_NAME
    || operation.kind !== 'tax_refund'
    || operation.idempotencyKey !== idempotencyKey
    || operation.sourceRevision !== input.expectedRevision
    || operation.preparedRevision !== input.expectedRevision
    || operation.qboType !== 'Deposit'
    || operation.retryOfId !== null
    || preview.taxAgencyQboId !== input.taxAgencyQboId
    || preview.filedReturnRef !== input.filedReturnRef
    || preview.filingEvidenceSha256 !== input.filingEvidenceSha256
    || preview.suspenseAccountQboId !== input.suspenseAccountQboId
    || preview.bankAccountQboId !== input.bankAccountQboId
    || preview.refundDate !== input.refundDate
    || preview.principalCents !== input.principalCents
    || preview.interestCents !== interestCents
    || preview.interestAccountQboId !== interestAccountQboId
    || preview.totalBankCreditCents !== input.principalCents + interestCents
    || preview.existingDepositTreatment !== 'replace_or_match_before_verification'
  ) {
    throw new McpOperationError('IDEMPOTENCY_CONFLICT');
  }
  if (!Number.isFinite(operation.expiresAt.getTime())) {
    throw new McpOperationError('OPERATION_CONFLICT');
  }
  return {
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    capability: payload.capability,
    preview,
    warnings,
  };
}

function validateInput(input: PrepareMcpTaxRefundInput, now: Date): void {
  const bounded = (value: unknown) => (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_REFERENCE
  );
  const safePositive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  const safeNonNegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const interestCents = input.interestCents ?? 0;
  if (
    !Number.isFinite(now.getTime())
    || !bounded(input.companyId)
    || !bounded(input.transactionId)
    || !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 0
    || !bounded(input.taxAgencyQboId)
    || !bounded(input.filedReturnRef)
    || !SHA256.test(input.filingEvidenceSha256)
    || !bounded(input.suspenseAccountQboId)
    || !bounded(input.bankAccountQboId)
    || !isCalendarDate(input.refundDate)
    || !safePositive(input.principalCents)
    || !safeNonNegative(interestCents)
    || (interestCents > 0 && !bounded(input.interestAccountQboId))
    || (interestCents === 0 && input.interestAccountQboId !== undefined)
  ) {
    throw new McpTaxRefundError('INVALID_INPUT');
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}
