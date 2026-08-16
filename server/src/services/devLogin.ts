// devLink policy — whether magic-link URLs may be returned in API responses.
//
// Allowed when EITHER:
//  - the deployer opted in explicitly (ALLOW_DEV_LOGIN=true), or
//  - no REAL (non-demo-realm) company is currently connected.
//
// Rationale: an instance holding only demo companies contains nothing
// sensitive, so the friction-free one-click sign-in is safe; the moment real
// books attach, magic links must go through email (or the server log) only.
// The lock is evaluated per request — connecting a real company locks it
// immediately, disconnecting the last real company unlocks it again.

import { env, localAdminConfig } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from '../lib/qbo/mock.js';

/**
 * A configured local admin password marks this as a real deployment (Umbrel
 * passes its generated ${APP_PASSWORD}), not a dev machine. Unauthenticated
 * endpoints must then never mint accounts or hand sign-in links back in
 * response bodies: the admin address is published (the manifest's
 * defaultUsername), so a response-body link is an account takeover, not a
 * convenience. The wizard's password-gated setup route is the only bootstrap,
 * and issued links still reach the operator via the server log.
 *
 * ALLOW_DEV_LOGIN=true overrides, for development against a local-admin .env.
 */
export function localAdminLockdown(): boolean {
  return localAdminConfig.enabled && !env.ALLOW_DEV_LOGIN;
}

export async function devLoginAllowed(): Promise<boolean> {
  if (env.ALLOW_DEV_LOGIN) return true;
  const realCompanies = await prisma.company.count({
    where: {
      disconnectedAt: null,
      realmId: { notIn: [MOCK_REALM_HARBOR, MOCK_REALM_BLUEBIRD] },
    },
  });
  return realCompanies === 0;
}
