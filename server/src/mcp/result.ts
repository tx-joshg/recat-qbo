import { McpRuleChangeError } from '../services/mcp/rules.js';
import { RuleCandidateError } from '../services/ruleCandidates.js';
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import {
  QboRateLimitError,
  QBO_RATE_LIMIT_MIN_RETRY_SECONDS,
  QBO_RATE_LIMIT_MAX_RETRY_SECONDS,
} from '../lib/qbo/types.js';
import { HttpError } from '../lib/http.js';
import { QboWriteSafetyError } from '../lib/qbo/writeSafety.js';
import { CategorizationError } from '../services/categorization.js';
import { McpCategorizationError } from '../services/mcp/categorization.js';
import { McpOperationError } from '../services/mcp/operations.js';
import { McpOperationExecutionError } from '../services/mcp/reconciliation.js';
import { McpTaxRefundError } from '../services/mcp/taxRefund.js';
import { McpUndoError } from '../services/mcp/undo.js';
import { McpTransferExecutionError } from '../services/mcp/transfers.js';
import { TransferExecutionError } from '../services/transferExecution.js';
import { TransferOperationError } from '../services/transferOperations.js';
import { WritebackLifecycleError } from '../services/writeback.js';
import { AttachmentError } from '../services/attachments/types.js';
import { ReceiptError } from '../services/receipts/types.js';
import { McpSchemaBoundsError } from './schemaBounds.js';

const MAX_REQUEST_ID_LENGTH = 128;

export type SafeToolErrorCode =
  | 'FORBIDDEN'
  | 'TAX_REFUND_ALREADY_PREPARED'
  | 'TAX_REFUND_PREPARATION_CANCELLED'
  | 'TAX_REFUND_ALREADY_RECORDED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'RULE_CHANGES_READ_ONLY'
  | 'OPERATION_RECONCILIATION_REQUIRED'
  | 'RESPONSE_TOO_LARGE'
  | 'SEMANTIC_UNAVAILABLE'
  | 'COMPANY_UNAVAILABLE'
  | 'QBO_DISCONNECTED'
  | 'QBO_PERIOD_CLOSED'
  | 'QBO_TRANSACTION_LOCKED'
  | 'QBO_WRITE_SAFETY_UNAVAILABLE'
  | 'RATE_LIMITED';

const SAFE_MESSAGES: Record<SafeToolErrorCode, string> = {
  FORBIDDEN: 'This token does not have access to the requested data. Check its company role and try again.',
  TAX_REFUND_ALREADY_PREPARED: 'A tax refund preparation already reserves this source. Review the existing operation before preparing another.',
  TAX_REFUND_PREPARATION_CANCELLED: 'This tax refund preparation was cancelled and cannot be used. Review its state before creating a new preparation.',
  TAX_REFUND_ALREADY_RECORDED: 'This refund is already marked as recorded. Review the existing operation; only an administrator can correct that attestation.',
  NOT_FOUND: 'The requested record was not found or is unavailable.',
  INVALID_INPUT: 'Check the tool arguments and try again.',
  RULE_CHANGES_READ_ONLY: 'Rule changes are currently read-only for this company. Ask an administrator to complete the rule migration or resume rule editing.',
  OPERATION_RECONCILIATION_REQUIRED: 'This operation requires reconciliation before it can continue.',
  RESPONSE_TOO_LARGE: 'The response exceeds the size limit. For list tools, request fewer items with limit. For single records, use the web app. For mutations, inspect the operation status before retrying.',
  SEMANTIC_UNAVAILABLE: 'Semantic classification search is unavailable.',
  COMPANY_UNAVAILABLE: 'The company data is temporarily unavailable. Try again later.',
  QBO_DISCONNECTED: 'QuickBooks is disconnected for this company. Reconnect it before retrying.',
  QBO_PERIOD_CLOSED: 'QuickBooks has closed this accounting period.',
  QBO_TRANSACTION_LOCKED: 'QuickBooks reports this transaction as cleared or reconciled.',
  QBO_WRITE_SAFETY_UNAVAILABLE: 'QuickBooks write-safety status is unavailable.',
  RATE_LIMITED: 'Too many requests were made. Wait briefly and try again.',
};

export const SAFE_INVALID_INPUT_MESSAGE = SAFE_MESSAGES.INVALID_INPUT;

export function toolSuccess<T extends JSONObject>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const CATEGORIZATION_INVALID_CODES = new Set([
  'INVALID_ACCOUNT',
  'INVALID_INPUT',
  'INVALID_TAG',
  'INVALID_TAX_CODE',
  'INVALID_TRANSACTION_AMOUNT',
  'PRESERVE_SOURCE_ID_INVALID',
  'PRESERVE_SOURCE_SHAPE_INVALID',
  'PRESERVE_SOURCE_SYNC_TOKEN_INVALID',
  'PRESERVE_SOURCE_TAX_CALCULATION_INVALID',
  'PRESERVE_SOURCE_TOTAL_INVALID',
  'STALE_REVISION',
  'TAX_AMOUNT_INVALID',
  'TAX_AMOUNT_SIGN_MISMATCH',
  'TAX_CODE_INACTIVE',
  'TAX_CODE_MALFORMED',
  'TAX_CODE_PURCHASE_ONLY',
  'TAX_CODE_SALES_ONLY',
  'TAX_CODE_UNAVAILABLE',
  'TAX_COMPANY_MISMATCH',
  'TAX_NOT_READY',
  'TAX_RATE_INACTIVE',
  'TAX_RATE_MALFORMED',
  'TAX_RATE_UNAVAILABLE',
  'TAX_RATE_UNSUPPORTED',
  'TAX_REQUIRES_PURCHASE',
  'TAX_TREATMENT_AMBIGUOUS',
  'UNBALANCED_TOTAL',
]);
const WRITEBACK_INVALID_CODES = new Set([
  'INVALID_ACCOUNT',
  'INVALID_STAGE',
  'INVALID_STATUS',
  'INVALID_TRANSACTION_AMOUNT',
  'QBO_DEPOSIT_UNSUPPORTED',
  'QBO_PURCHASE_UNSUPPORTED',
  'QBO_STATE_DRIFT',
  'RECONCILE_NOT_ALLOWED',
  'STALE_QBO_BINDING',
  'STALE_REVISION',
  'STALE_STAGE',
  'TAX_AMOUNT_INVALID',
  'TAX_AMOUNT_SIGN_MISMATCH',
  'TAX_CODE_INACTIVE',
  'TAX_CODE_MALFORMED',
  'TAX_CODE_PURCHASE_ONLY',
  'TAX_CODE_SALES_ONLY',
  'TAX_CODE_UNAVAILABLE',
  'TAX_COMPANY_MISMATCH',
  'TAX_NOT_READY',
  'TAX_RATE_INACTIVE',
  'TAX_RATE_MALFORMED',
  'TAX_RATE_UNAVAILABLE',
  'TAX_RATE_UNSUPPORTED',
  'TAX_TREATMENT_AMBIGUOUS',
  'UNDO_PROOF_MISMATCH',
  'UNDO_PROOF_REQUIRED',
  'VERIFIED_POST_REQUIRED',
]);

function safeMutationCode(error: unknown): SafeToolErrorCode | null {
  if (error instanceof McpTaxRefundError) {
    if (error.code === 'SOURCE_ALREADY_PREPARED') return 'TAX_REFUND_ALREADY_PREPARED';
    if (error.code === 'SOURCE_PREPARATION_CANCELLED') return 'TAX_REFUND_PREPARATION_CANCELLED';
    if (error.code === 'SOURCE_ALREADY_RECORDED') return 'TAX_REFUND_ALREADY_RECORDED';
    return error.code === 'SOURCE_NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT';
  }

  if (error instanceof McpRuleChangeError) {
    if (error.code === 'RULE_CHANGES_READ_ONLY') return 'RULE_CHANGES_READ_ONLY';
    return error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT';
  }
  if (error instanceof RuleCandidateError) {
    return error.code === 'CANDIDATE_NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT';
  }
  if (error instanceof ReceiptError) {
    if (error.code === 'RECEIPT_FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'RECEIPT_NOT_FOUND') return 'NOT_FOUND';
    if (
      error.code === 'RECEIPT_INVALID_INPUT'
      || error.code === 'RECEIPT_TYPE_UNSUPPORTED'
      || error.code === 'RECEIPT_IDEMPOTENCY_CONFLICT'
      || error.code === 'RECEIPT_STALE'
    ) return 'INVALID_INPUT';
    return 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof AttachmentError) {
    if (error.code === 'ATTACHMENT_FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'ATTACHMENT_NOT_FOUND') return 'NOT_FOUND';
    if (
      error.code === 'ATTACHMENT_INVALID_INPUT'
      || error.code === 'ATTACHMENT_TOO_LARGE'
      || error.code === 'ATTACHMENT_TYPE_UNSUPPORTED'
      || error.code === 'ATTACHMENT_MIME_MISMATCH'
      || error.code === 'IDEMPOTENCY_CONFLICT'
    ) {
      return 'INVALID_INPUT';
    }
    return 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof McpTransferExecutionError) {
    switch (error.code) {
      case 'OPERATION_NOT_FOUND':
        return 'NOT_FOUND';
      case 'OPERATION_EXPIRED':
      case 'OPERATION_CANCELLED':
      case 'IDEMPOTENCY_CONFLICT':
      case 'RETRY_NOT_ALLOWED':
        return 'INVALID_INPUT';
      case 'OPERATION_CORRUPT':
        return 'OPERATION_RECONCILIATION_REQUIRED';
      default:
        return 'COMPANY_UNAVAILABLE';
    }
  }
  if (error instanceof TransferOperationError) {
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'TRANSACTION_NOT_FOUND') return 'NOT_FOUND';
    if (error.code === 'COMPANY_DISCONNECTED') return 'QBO_DISCONNECTED';
    if (
      error.code === 'INVALID_INPUT'
      || error.code === 'INVALID_TRANSFER_PAIR'
      || error.code === 'STALE_REVISION'
      || error.code === 'INVALID_STATUS'
      || error.code === 'TARGET_ACCOUNT_INVALID'
      || error.code === 'ACTIVE_ATTEMPT'
      || error.code === 'STALE_QBO_BINDING'
      || error.code === 'STALE_QBO_AMOUNT'
      || error.code === 'IDEMPOTENCY_CONFLICT'
    ) {
      return 'INVALID_INPUT';
    }
    return 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof TransferExecutionError) {
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    if (error.code === 'OPERATION_NOT_FOUND') return 'NOT_FOUND';
    if (
      error.code === 'INVALID_INPUT'
      || error.code === 'OPERATION_EXPIRED'
      || error.code === 'STALE_REVISION'
      || error.code === 'STALE_QBO_BINDING'
      || error.code === 'QBO_STATE_DRIFT'
    ) {
      return 'INVALID_INPUT';
    }
    return 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof McpCategorizationError) {
    switch (error.code) {
      case 'MCP_UNAUTHORIZED':
      case 'MCP_FORBIDDEN':
        return 'FORBIDDEN';
      case 'COMPANY_DISCONNECTED':
        return 'QBO_DISCONNECTED';
      default:
        return 'COMPANY_UNAVAILABLE';
    }
  }
  if (error instanceof McpOperationError) {
    switch (error.code) {
      case 'OPERATION_NOT_FOUND':
        return 'NOT_FOUND';
      case 'OPERATION_INVALID_INPUT':
      case 'IDEMPOTENCY_CONFLICT':
        return 'INVALID_INPUT';
      default:
        return 'COMPANY_UNAVAILABLE';
    }
  }
  if (error instanceof McpOperationExecutionError) {
    switch (error.code) {
      case 'OPERATION_NOT_FOUND':
        return 'NOT_FOUND';
      case 'OPERATION_EXPIRED':
      case 'OPERATION_CANCELLED':
      case 'IDEMPOTENCY_CONFLICT':
      case 'RETRY_NOT_ALLOWED':
        return 'INVALID_INPUT';
      case 'OPERATION_CORRUPT':
        return 'OPERATION_RECONCILIATION_REQUIRED';
      default:
        return 'COMPANY_UNAVAILABLE';
    }
  }
  if (error instanceof McpUndoError) {
    if (error.code === 'OPERATION_CORRUPT') return 'OPERATION_RECONCILIATION_REQUIRED';
    return error.code === 'UNDO_NOT_ALLOWED'
      ? 'INVALID_INPUT'
      : 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof CategorizationError) {
    if (error.code === 'TRANSACTION_NOT_FOUND') return 'NOT_FOUND';
    if (CATEGORIZATION_INVALID_CODES.has(error.code)) return 'INVALID_INPUT';
    return 'COMPANY_UNAVAILABLE';
  }
  if (error instanceof WritebackLifecycleError) {
    if (
      error.code === 'QBO_PERIOD_CLOSED'
      || error.code === 'QBO_TRANSACTION_LOCKED'
      || error.code === 'QBO_WRITE_SAFETY_UNAVAILABLE'
    ) {
      return error.code;
    }
    if (error.code === 'FORBIDDEN') return 'FORBIDDEN';
    if (
      error.code === 'TRANSACTION_NOT_FOUND'
      || error.code === 'ATTEMPT_NOT_FOUND'
    ) {
      return 'NOT_FOUND';
    }
    if (error.code === 'COMPANY_DISCONNECTED') return 'QBO_DISCONNECTED';
    if (WRITEBACK_INVALID_CODES.has(error.code)) return 'INVALID_INPUT';
    return 'COMPANY_UNAVAILABLE';
  }
  return null;
}

function safeCode(error: unknown): SafeToolErrorCode {
  if (error instanceof QboRateLimitError) return 'RATE_LIMITED';
  if (error instanceof McpSchemaBoundsError) {
    if (error.code === 'OUTPUT_BYTES') return 'RESPONSE_TOO_LARGE';
    if (error.code === 'OUTPUT_SERIALIZATION') return 'COMPANY_UNAVAILABLE';
    return 'INVALID_INPUT';
  }
  if (error instanceof QboWriteSafetyError) return error.code;
  const mutationCode = safeMutationCode(error);
  if (mutationCode !== null) return mutationCode;
  if (!(error instanceof HttpError)) return 'COMPANY_UNAVAILABLE';
  if (error.code === 'SEMANTIC_UNAVAILABLE') return 'SEMANTIC_UNAVAILABLE';
  if (error.code === 'COMPANY_UNAVAILABLE') return 'COMPANY_UNAVAILABLE';
  if (error.code === 'QBO_DISCONNECTED') return 'QBO_DISCONNECTED';
  switch (error.status) {
    case 400:
      return 'INVALID_INPUT';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'COMPANY_UNAVAILABLE';
  }
}

export function safeToolFailure(
  error: unknown,
  requestId: string,
): CallToolResult {
  const code = safeCode(error);
  const retryAfterSeconds = error instanceof QboRateLimitError
    ? safeRetryAfterSeconds(error.retryAfterSeconds)
    : undefined;
  const value = {
    error: {
      code,
      message: SAFE_MESSAGES[code],
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      requestId: requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeRetryAfterSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  return Math.min(QBO_RATE_LIMIT_MAX_RETRY_SECONDS, Math.max(QBO_RATE_LIMIT_MIN_RETRY_SECONDS, value));
}

export function safeInvalidToolFailure(requestId: string): CallToolResult {
  const value = {
    error: {
      code: 'INVALID_INPUT',
      message: SAFE_INVALID_INPUT_MESSAGE,
      requestId: requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function isSafeToolFailure(
  value: unknown,
  requestId: string,
): boolean {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const structured = result.structuredContent;
  if (structured === null || typeof structured !== 'object') return false;
  const error = (structured as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  const code = candidate.code;
  return (
    typeof code === 'string' &&
    Object.hasOwn(SAFE_MESSAGES, code) &&
    candidate.message === SAFE_MESSAGES[code as SafeToolErrorCode] &&
    candidate.requestId === requestId.slice(0, MAX_REQUEST_ID_LENGTH)
  );
}
