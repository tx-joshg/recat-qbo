import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { QboAuthError, QboHttpError, QboRequestTimeout } from '../lib/qbo/types.js';

export function reportReadFailure(
  error: unknown,
  operation: 'profit_and_loss' | 'balance_sheet' | 'transaction_log' | 'dashboard',
): HttpError {
  const requestId = randomUUID();
  console.error(`[read:${operation}] requestId=${requestId}`, readDiagnostics(error));
  if (operation === 'dashboard') {
    return new HttpError(503, 'Dashboard data is temporarily unavailable.', 'DASHBOARD_UNAVAILABLE', requestId);
  }
  if (error instanceof QboRequestTimeout) {
    return new HttpError(504, 'QuickBooks did not respond before this report request timed out.', 'QBO_REPORT_TIMEOUT', requestId);
  }
  if (error instanceof QboAuthError) {
    return new HttpError(503, 'QuickBooks access needs attention before this report can be loaded.', 'QBO_REPORT_AUTH', requestId);
  }
  if (error instanceof QboHttpError && [400, 404, 405, 501].includes(error.status)) {
    return new HttpError(422, 'QuickBooks cannot provide this report with the selected options.', 'QBO_REPORT_UNSUPPORTED', requestId);
  }
  if (error instanceof QboHttpError) {
    return new HttpError(502, 'QuickBooks could not provide this report right now.', 'QBO_REPORT_UNAVAILABLE', requestId);
  }
  return new HttpError(503, 'Report data is temporarily unavailable.', 'REPORT_UNAVAILABLE', requestId);
}

// Fixed diagnostic vocabulary avoids copying provider bodies, query text, or arbitrary error properties.
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'QboAuthError', 'QboRequestTimeout',
  'QboHttpError', 'QboHttpNotFoundError', 'QboObjectNotFoundError', 'QboRateLimitError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError', 'PrismaClientValidationError', 'PrismaClientRustPanicError',
]);
const PRISMA_CODES = new Set([
  'P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1017',
  'P2002', 'P2003', 'P2024', 'P2025', 'P2034',
]);
function readDiagnostics(error: unknown): { errorName: string; errorCode?: string; httpStatus?: number } {
  let name: unknown;
  let code: unknown;
  try {
    if (typeof error === 'object' && error !== null) {
      name = (error as { name?: unknown }).name;
      code = (error as { code?: unknown }).code;
    }
  } catch { /* Unknown diagnostic getters must not replace the original read failure. */ }
  const errorName = typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'UnknownError';
  const diagnostics: { errorName: string; errorCode?: string; httpStatus?: number } = { errorName };
  if (errorName.startsWith('Prisma') && typeof code === 'string' && PRISMA_CODES.has(code)) {
    diagnostics.errorCode = code;
  }
  if (error instanceof QboHttpError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    diagnostics.httpStatus = error.status;
  }
  return diagnostics;
}
