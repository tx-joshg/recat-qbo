import type { QboDiagnosticCode } from '@recat/shared';
import { QboAuthError } from './types.js';

const MAX_OAUTH_BODY_LENGTH = 4096;

interface IntuitOAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
}

export type QboFailurePhase = 'oauth' | 'company_info';

export function classifyIntuitOAuthBody(
  _status: number,
  bodyText: string,
): QboDiagnosticCode {
  let body: IntuitOAuthErrorBody;
  try {
    const parsed: unknown = JSON.parse(bodyText.slice(0, MAX_OAUTH_BODY_LENGTH));
    if (typeof parsed !== 'object' || parsed === null) {
      return 'QBO_CONNECTION_FAILED';
    }
    body = parsed as IntuitOAuthErrorBody;
  } catch {
    return 'QBO_CONNECTION_FAILED';
  }

  const error = typeof body.error === 'string' ? body.error.toLowerCase() : '';
  const description =
    typeof body.error_description === 'string'
      ? body.error_description.toLowerCase()
      : '';

  if (error === 'invalid_client') return 'INVALID_CLIENT_CREDENTIALS';
  if (error === 'access_denied') return 'ACCESS_DENIED';
  if (error === 'invalid_grant') {
    if (
      description.includes('redirect_uri') ||
      description.includes('redirect uri')
    ) {
      return 'REDIRECT_URI_MISMATCH';
    }
    return 'AUTHORIZATION_EXPIRED';
  }

  return 'QBO_CONNECTION_FAILED';
}

export function classifyQboFailure(
  error: unknown,
  phase: QboFailurePhase,
): QboDiagnosticCode {
  if (error instanceof QboAuthError) return error.reason;
  if (error instanceof TypeError) return 'INTUIT_UNAVAILABLE';
  if (phase === 'company_info') return 'COMPANY_INFO_FAILED';
  return 'QBO_CONNECTION_FAILED';
}

export function qboFailureRedirect(
  appUrl: string,
  code: QboDiagnosticCode,
): string {
  const redirect = new URL('/setup', appUrl);
  redirect.searchParams.set('qbo_error', code);
  return redirect.toString();
}
