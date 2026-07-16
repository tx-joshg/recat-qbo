// Connect-url request validation: mode/env parsing and the actionable 400
// when the real flow is requested without Intuit credentials.

import { describe, expect, it } from 'vitest';
import { parseConnectRequest } from './connectRequest.js';
import { HttpError } from './http.js';

describe('parseConnectRequest', () => {
  it('defaults to the real flow with the instance default env', () => {
    expect(parseConnectRequest({}, true)).toEqual({ mode: 'real', env: null });
  });

  it('parses explicit mode + env choices', () => {
    expect(parseConnectRequest({ mode: 'real', env: 'production' }, true)).toEqual({
      mode: 'real',
      env: 'production',
    });
    expect(parseConnectRequest({ mode: 'real', env: 'sandbox' }, true)).toEqual({
      mode: 'real',
      env: 'sandbox',
    });
  });

  it('demo is always available — no credentials required, env ignored', () => {
    expect(parseConnectRequest({ mode: 'demo' }, false)).toEqual({ mode: 'demo', env: null });
    expect(parseConnectRequest({ mode: 'demo', env: 'production' }, false)).toEqual({
      mode: 'demo',
      env: null,
    });
  });

  it('real mode without credentials → 400 pointing at Settings', () => {
    try {
      parseConnectRequest({ mode: 'real' }, false);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(400);
      expect(httpErr.code).toBe('MISSING_CREDENTIALS');
      expect(httpErr.message).toContain('Intuit Client ID and Secret');
      expect(httpErr.message).toContain('Settings');
    }
  });

  it('rejects garbage mode/env values', () => {
    expect(() => parseConnectRequest({ mode: 'banana' }, true)).toThrow(/Invalid mode/);
    expect(() => parseConnectRequest({ mode: 'real', env: 'prod' }, true)).toThrow(/Invalid env/);
  });
});
