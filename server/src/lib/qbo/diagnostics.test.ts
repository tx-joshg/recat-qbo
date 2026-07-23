import { describe, expect, it } from 'vitest';
import {
  classifyIntuitOAuthBody,
  classifyQboFailure,
  qboFailureRedirect,
} from './diagnostics.js';

describe('classifyIntuitOAuthBody', () => {
  it('classifies invalid client credentials without exposing upstream detail', () => {
    expect(
      classifyIntuitOAuthBody(
        401,
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'bad secret SECRET_SENTINEL',
        }),
      ),
    ).toBe('INVALID_CLIENT_CREDENTIALS');
  });

  it('classifies an expired authorization code', () => {
    expect(
      classifyIntuitOAuthBody(
        400,
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'authorization code expired',
        }),
      ),
    ).toBe('AUTHORIZATION_EXPIRED');
  });

  it('classifies a redirect URI mismatch before generic invalid grants', () => {
    expect(
      classifyIntuitOAuthBody(
        400,
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'redirect_uri mismatch',
        }),
      ),
    ).toBe('REDIRECT_URI_MISMATCH');
  });

  it('maps unknown and malformed responses to the generic diagnostic', () => {
    expect(classifyIntuitOAuthBody(500, '{"error":')).toBe('QBO_CONNECTION_FAILED');
    expect(classifyIntuitOAuthBody(418, JSON.stringify({ error: 'unexpected' }))).toBe(
      'QBO_CONNECTION_FAILED',
    );
  });
});

describe('classifyQboFailure', () => {
  it('maps fetch and network failures to Intuit unavailable', () => {
    expect(classifyQboFailure(new TypeError('fetch failed'), 'oauth')).toBe(
      'INTUIT_UNAVAILABLE',
    );
  });

  it('maps unknown errors to the generic diagnostic', () => {
    expect(classifyQboFailure(new Error('unexpected'), 'oauth')).toBe(
      'QBO_CONNECTION_FAILED',
    );
  });

  it('maps an otherwise generic company-info failure to its specific diagnostic', () => {
    expect(classifyQboFailure(new Error('unexpected'), 'company_info')).toBe(
      'COMPANY_INFO_FAILED',
    );
  });
});

describe('qboFailureRedirect', () => {
  it('builds a sanitized setup redirect', () => {
    const redirect = qboFailureRedirect(
      'https://recat.example',
      'INVALID_CLIENT_CREDENTIALS',
    );

    expect(redirect).toBe(
      'https://recat.example/setup?qbo_error=INVALID_CLIENT_CREDENTIALS',
    );
    expect(redirect).not.toContain('SECRET_SENTINEL');
  });
});
