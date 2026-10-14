// Express request augmentation: req.user (set by requireUser, with the
// user's per-company memberships loaded) and req.company (set by withCompany).

import type { Company, Membership, User } from '../lib/db.js';

declare global {
  namespace Express {
    interface Request {
      user?: User & { memberships: Membership[] };
      company?: Company;
      /** The session was signed in through a demo-mode devLink — see requireUser. */
      sessionViaExposedLink?: boolean;
    }
  }
}

export {};
