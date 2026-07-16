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

import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { MOCK_REALM_BLUEBIRD, MOCK_REALM_HARBOR } from '../lib/qbo/mock.js';

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
