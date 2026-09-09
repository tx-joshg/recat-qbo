import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import { HttpError } from '../lib/http.js';
import { QboWriteSafetyError } from '../lib/qbo/writeSafety.js';
import { CategorizationError } from '../services/categorization.js';
import { McpCategorizationError } from '../services/mcp/categorization.js';
import { McpOperationError } from '../services/mcp/operations.js';
import { McpOperationExecutionError } from '../services/mcp/reconciliation.js';
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
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'COMPANY_UNAVAILABLE'
  | 'QBO_DISCONNECTED'
  | 'QBO_PERIOD_CLOSED'
  | 'QBO_TRANSACTION_LOCKED'
  | 'QBO_WRITE_SAFETY_UNAVAILABLE'
  | 'RATE_LIMITED';

const SAFE_MESSAGES: Record<SafeToolErrorCode, string> = {
  FORBIDDEN: 'This token does not have access to the requested data. Check its company role and try again.',
  NOT_FOUND: 'The requested record was not found or is unavailable.',
  INVALID_INPUT: 'Check the tool arguments and try again.',
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
  'INVALID_TRANSACTION_AMOUNT',
  'INVALID_TAX_CODE',
  'PRESERVE_SOURCE_ID_INVALID',
  'PRESERVE_SOURCE_SHAPE_INVALID',
  'PRESERVE_SOURCE_SYNC_TOKEN_INVALID',
  'PRESERVE_SOURCE_TAX_CALCULATION_INVALID',
  'PRESERVE_SOURCE_TOTAL_INVALID',
  'STALE_REVISION',
  'TAX_NOT_READY',
  'TAX_REQUIRES_PURCHASE',
  'UNBALANCED_TOTAL',
]);
const WRITEBACK_INVALID_CODES = new Set([
  'INVALID_ACCOUNT',
  'INVALID_STAGE',
  'INVALID_STATUS',
  'INVALID_TRANSACTION_AMOUNT',
  'QBO_PURCHASE_UNSUPPORTED',
  'QBO_STATE_DRIFT',
  'RECONCILE_NOT_ALLOWED',
  'STALE_QBO_BINDING',
  'STALE_REVISION',
  'STALE_STAGE',
  'TAX_CODE_UNAVAILABLE',
  'TAX_NOT_READY',
  'UNDO_PROOF_MISMATCH',
  'UNDO_PROOF_REQUIRED',
  'VERIFIED_POST_REQUIRED',
]);

function safeMutationCode(error: unknown): SafeToolErrorCode | null {
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
      default:
        return 'COMPANY_UNAVAILABLE';
    }
  }
  if (error instanceof McpUndoError) {
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
  if (error instanceof McpSchemaBoundsError) return 'INVALID_INPUT';
  if (error instanceof QboWriteSafetyError) return error.code;
  const mutationCode = safeMutationCode(error);
  if (mutationCode !== null) return mutationCode;
  if (!(error instanceof HttpError)) return 'COMPANY_UNAVAILABLE';
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
  const value = {
    error: {
      code,
      message: SAFE_MESSAGES[code],
      requestId: requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
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
