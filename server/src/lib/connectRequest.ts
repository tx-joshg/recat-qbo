// Parse + validate the connect flow's user choices (mode, env) from the
// connect-url request. Pure — unit-testable without express or prisma.

import { HttpError } from './http.js';

export interface ConnectRequestInput {
  mode?: unknown;
  env?: unknown;
}

export interface ParsedConnectRequest {
  mode: 'real' | 'demo';
  /** Only meaningful for the real flow; null = instance default. */
  env: 'sandbox' | 'production' | null;
}

/**
 * mode defaults to 'real' (the product path); 'demo' is always available on
 * every instance — it needs no credentials. The real flow requires Intuit
 * credentials and 400s with an actionable message when they're missing.
 */
export function parseConnectRequest(
  input: ConnectRequestInput,
  hasCredentials: boolean,
): ParsedConnectRequest {
  const mode = input.mode === undefined || input.mode === '' ? 'real' : input.mode;
  if (mode !== 'real' && mode !== 'demo') {
    throw new HttpError(400, "Invalid mode — use 'real' or 'demo'.", 'BAD_REQUEST');
  }
  const envChoice = input.env === undefined || input.env === '' ? null : input.env;
  if (envChoice !== null && envChoice !== 'sandbox' && envChoice !== 'production') {
    throw new HttpError(400, "Invalid env — use 'sandbox' or 'production'.", 'BAD_REQUEST');
  }
  if (mode === 'real' && !hasCredentials) {
    throw new HttpError(
      400,
      'Add your Intuit Client ID and Secret first — Settings → QuickBooks API access.',
      'MISSING_CREDENTIALS',
    );
  }
  return { mode, env: mode === 'demo' ? null : envChoice };
}
