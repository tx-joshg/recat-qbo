import { describe, expect, it } from 'vitest';
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
import { safeToolFailure, toolSuccess } from './result.js';
import { McpSchemaBoundsError } from './schemaBounds.js';

describe('MCP tool results', () => {
  it('gives bounded-output failures a safe actionable response', () => {
    const result = safeToolFailure(new McpSchemaBoundsError('OUTPUT_BYTES', 'PRIVATE_SIZE_SENTINEL'), 'request-size');
    expect(result.structuredContent).toMatchObject({ error: {
      code: 'RESPONSE_TOO_LARGE',
      message: expect.stringContaining('limit'),
    } });
    expect(JSON.stringify(result)).toContain('operation status');
    expect(JSON.stringify(result)).toContain('web app');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SIZE_SENTINEL');
  });

  it('does not blame tool arguments for an unserializable server response', () => {
    const result = safeToolFailure(new McpSchemaBoundsError('OUTPUT_SERIALIZATION', 'PRIVATE_SERIALIZATION_SENTINEL'), 'request-size');
    expect(result.structuredContent).toMatchObject({ error: { code: 'COMPANY_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SERIALIZATION_SENTINEL');
  });

  it('maps attachment failures without exposing private detail', () => {
    const forbidden = safeToolFailure(
      new AttachmentError(
        'ATTACHMENT_FORBIDDEN',
        'private attachment filename sentinel.pdf',
      ),
      'request-attachment',
    );
    const missing = safeToolFailure(
      new AttachmentError(
        'ATTACHMENT_NOT_FOUND',
        'private provider id sentinel',
      ),
      'request-attachment',
    );

    expect(forbidden.structuredContent).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(missing.structuredContent).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(JSON.stringify([forbidden, missing])).not.toContain('sentinel');
  });

  it.each([
    ['RECEIPT_FORBIDDEN', 'FORBIDDEN'],
    ['RECEIPT_NOT_FOUND', 'NOT_FOUND'],
    ['RECEIPT_INVALID_INPUT', 'INVALID_INPUT'],
    ['RECEIPT_TYPE_UNSUPPORTED', 'INVALID_INPUT'],
    ['RECEIPT_IDEMPOTENCY_CONFLICT', 'INVALID_INPUT'],
    ['RECEIPT_STALE', 'INVALID_INPUT'],
  ] as const)('maps %s without exposing receipt detail', (receiptCode, safeCode) => {
    const result = safeToolFailure(
      new ReceiptError(receiptCode, 'SENTINEL_PRIVATE_RECEIPT_DETAIL'),
      'request-receipt',
    );

    expect(result.structuredContent).toMatchObject({
      error: { code: safeCode },
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE_RECEIPT_DETAIL');
  });

  it('returns matching text and structured content', () => {
    const result = toolSuccess({ items: [{ id: 'company-a' }] });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '{"items":[{"id":"company-a"}]}' }],
      structuredContent: { items: [{ id: 'company-a' }] },
    });
  });

  it.each([
    [new HttpError(403, 'PRIVATE_PROVIDER_SENTINEL', 'SOME_PROVIDER_CODE'), 'FORBIDDEN'],
    [new HttpError(404, 'PRIVATE_ID_SENTINEL', 'TRANSACTION_NOT_FOUND'), 'NOT_FOUND'],
    [new HttpError(400, 'PRIVATE_CURSOR_SENTINEL', 'INVALID_CURSOR'), 'INVALID_INPUT'],
    [new HttpError(503, 'PRIVATE_COMPANY_SENTINEL', 'COMPANY_UNAVAILABLE'), 'COMPANY_UNAVAILABLE'],
    [new HttpError(409, 'PRIVATE_QBO_SENTINEL', 'QBO_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new HttpError(429, 'PRIVATE_RATE_SENTINEL', 'ANY_CODE'), 'RATE_LIMITED'],
    [new QboWriteSafetyError('QBO_PERIOD_CLOSED', 'PRIVATE_CLOSE_SENTINEL'), 'QBO_PERIOD_CLOSED'],
    [new QboWriteSafetyError('QBO_TRANSACTION_LOCKED', 'PRIVATE_LOCK_SENTINEL'), 'QBO_TRANSACTION_LOCKED'],
    [new QboWriteSafetyError('QBO_WRITE_SAFETY_UNAVAILABLE', 'PRIVATE_SAFETY_SENTINEL'), 'QBO_WRITE_SAFETY_UNAVAILABLE'],
  ])('maps an expected failure to stable safe code %s', (error, code) => {
    const result = safeToolFailure(error, 'request-safe');

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code,
          message: expect.any(String),
          requestId: 'request-safe',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it('maps unexpected details to the approved company-unavailable fallback', () => {
    const hidden = safeToolFailure(
      new Error('TOKEN_SENTINEL stack trace'),
      'request-internal',
    );
    expect(JSON.stringify(hidden)).not.toContain('TOKEN_SENTINEL');
    expect(hidden.structuredContent).toEqual({
      error: {
        code: 'COMPANY_UNAVAILABLE',
        message: 'The company data is temporarily unavailable. Try again later.',
        requestId: 'request-internal',
      },
    });
  });

  it.each([
    [new McpCategorizationError('MCP_UNAUTHORIZED'), 'FORBIDDEN'],
    [new McpCategorizationError('MCP_FORBIDDEN'), 'FORBIDDEN'],
    [new McpCategorizationError('COMPANY_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new McpCategorizationError('ENTITY_BUSY'), 'COMPANY_UNAVAILABLE'],
    [new McpOperationError('OPERATION_INVALID_INPUT'), 'INVALID_INPUT'],
    [new McpOperationError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpOperationError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpOperationError('OPERATION_CONFLICT'), 'COMPANY_UNAVAILABLE'],
    [new McpOperationExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpOperationExecutionError('OPERATION_EXPIRED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('OPERATION_CANCELLED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('RETRY_NOT_ALLOWED'), 'INVALID_INPUT'],
    [new McpOperationExecutionError('OPERATION_CORRUPT'), 'COMPANY_UNAVAILABLE'],
    [new McpTransferExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new McpTransferExecutionError('IDEMPOTENCY_CONFLICT'), 'INVALID_INPUT'],
    [new McpTransferExecutionError('OPERATION_CORRUPT'), 'COMPANY_UNAVAILABLE'],
    [new TransferOperationError('FORBIDDEN'), 'FORBIDDEN'],
    [new TransferOperationError('TRANSACTION_NOT_FOUND'), 'NOT_FOUND'],
    [new TransferOperationError('COMPANY_DISCONNECTED'), 'QBO_DISCONNECTED'],
    [new TransferOperationError('INVALID_TRANSFER_PAIR'), 'INVALID_INPUT'],
    [new TransferExecutionError('FORBIDDEN'), 'FORBIDDEN'],
    [new TransferExecutionError('OPERATION_NOT_FOUND'), 'NOT_FOUND'],
    [new TransferExecutionError('OPERATION_EXPIRED'), 'INVALID_INPUT'],
    [new McpUndoError('UNDO_NOT_ALLOWED'), 'INVALID_INPUT'],
    [new McpUndoError('OPERATION_CORRUPT'), 'COMPANY_UNAVAILABLE'],
    [
      new CategorizationError(
        'TRANSACTION_NOT_FOUND',
        'PRIVATE_CATEGORY_NOT_FOUND_SENTINEL',
      ),
      'NOT_FOUND',
    ],
    ...[
      'INVALID_TAX_CODE',
      'PRESERVE_SOURCE_ID_INVALID',
      'PRESERVE_SOURCE_SHAPE_INVALID',
      'PRESERVE_SOURCE_SYNC_TOKEN_INVALID',
      'PRESERVE_SOURCE_TAX_CALCULATION_INVALID',
      'PRESERVE_SOURCE_TOTAL_INVALID',
    ].map((code) => [new CategorizationError(code, 'PRIVATE_SOURCE_DETAILS'), 'INVALID_INPUT']),
    [
      new CategorizationError(
        'INVALID_ACCOUNT',
        'PRIVATE_CATEGORY_INPUT_SENTINEL',
      ),
      'INVALID_INPUT',
    ],
    [
      new CategorizationError(
        'MUTATION_BLOCKED',
        'PRIVATE_CATEGORY_BUSY_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'FORBIDDEN',
        'PRIVATE_WRITE_FORBIDDEN_SENTINEL',
      ),
      'FORBIDDEN',
    ],
    [
      new WritebackLifecycleError(
        'TRANSACTION_NOT_FOUND',
        'PRIVATE_WRITE_NOT_FOUND_SENTINEL',
      ),
      'NOT_FOUND',
    ],
    [
      new WritebackLifecycleError(
        'COMPANY_DISCONNECTED',
        'PRIVATE_WRITE_DISCONNECTED_SENTINEL',
      ),
      'QBO_DISCONNECTED',
    ],
    [
      new WritebackLifecycleError(
        'STALE_REVISION',
        'PRIVATE_WRITE_INPUT_SENTINEL',
      ),
      'INVALID_INPUT',
    ],
    [
      new WritebackLifecycleError(
        'ATTEMPT_CORRUPT',
        'PRIVATE_WRITE_CORRUPT_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'QBO_PERIOD_CLOSED',
        'PRIVATE_WRITE_CLOSE_SENTINEL',
      ),
      'QBO_PERIOD_CLOSED',
    ],
    [
      new WritebackLifecycleError(
        'QBO_TRANSACTION_LOCKED',
        'PRIVATE_WRITE_LOCK_SENTINEL',
      ),
      'QBO_TRANSACTION_LOCKED',
    ],
    [
      new WritebackLifecycleError(
        'QBO_WRITE_SAFETY_UNAVAILABLE',
        'PRIVATE_WRITE_SAFETY_SENTINEL',
      ),
      'QBO_WRITE_SAFETY_UNAVAILABLE',
    ],
    [
      new WritebackLifecycleError(
        'PRIVATE_UNKNOWN_CODE',
        'PRIVATE_WRITE_UNKNOWN_SENTINEL',
      ),
      'COMPANY_UNAVAILABLE',
    ],
  ])('maps an MCP mutation failure to fixed safe code %s', (error, code) => {
    const result = safeToolFailure(error, 'request-mutation');

    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        message: expect.any(String),
        requestId: 'request-mutation',
      },
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});
