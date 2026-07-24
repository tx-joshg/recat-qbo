import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { revokeStoredQboRefreshToken } from '../lib/qbo/factory.js';
import {
  acquireCompanyWriteLease,
  releaseCompanyWriteLease,
} from './agent/jobs.js';

type DisconnectDb = Pick<PrismaClient, 'company'>;

export interface PendingQboDisconnect {
  disconnectedAt: Date;
  realmId: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
}

export interface QboDisconnectDeps {
  db: DisconnectDb;
  acquireLease(companyId: string, owner: string): Promise<boolean>;
  releaseLease(companyId: string, owner: string): Promise<void>;
  revoke(disconnect: PendingQboDisconnect): Promise<void>;
}

const defaultDeps: QboDisconnectDeps = {
  db: prisma,
  acquireLease: (companyId, owner) => acquireCompanyWriteLease(companyId, owner),
  releaseLease: (companyId, owner) => releaseCompanyWriteLease(companyId, owner),
  revoke: (disconnect) =>
    disconnect.refreshToken
      ? revokeStoredQboRefreshToken(disconnect.realmId, disconnect.refreshToken)
      : Promise.resolve(),
};

/**
 * Finish a previously requested disconnect once no serialized accounting
 * write owns the company. The disconnected marker is durable, so the
 * scheduler can resume this cleanup after a request timeout or process crash.
 */
export async function finishPendingQboDisconnect(
  companyId: string,
  deps: QboDisconnectDeps = defaultDeps,
): Promise<boolean> {
  const owner = `disconnect:${randomUUID()}`;
  if (!(await deps.acquireLease(companyId, owner))) return false;
  try {
    const company = await deps.db.company.findUnique({
      where: { id: companyId },
      select: {
        disconnectedAt: true,
        realmId: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiresAt: true,
      },
    });
    if (!company || company.disconnectedAt === null) return true;
    const disconnect: PendingQboDisconnect = {
      ...company,
      disconnectedAt: company.disconnectedAt,
    };
    if (company.accessToken || company.refreshToken || company.tokenExpiresAt) {
      // Revoke exactly the credential snapshot read under this cleanup pass.
      // If OAuth reconnects before the guarded clear, its new token and null
      // disconnected marker do not match and remain untouched.
      await deps.revoke(disconnect);
      await deps.db.company.updateMany({
        where: {
          id: companyId,
          disconnectedAt: disconnect.disconnectedAt,
          accessToken: company.accessToken,
          refreshToken: company.refreshToken,
          tokenExpiresAt: company.tokenExpiresAt,
        },
        data: {
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
        },
      });
    }
    return true;
  } finally {
    await deps.releaseLease(companyId, owner);
  }
}

/** Retry every incomplete disconnect; one busy company does not block others. */
export async function sweepPendingQboDisconnects(
  deps: QboDisconnectDeps = defaultDeps,
): Promise<{ pending: number; completed: number }> {
  const companies = await deps.db.company.findMany({
    where: {
      disconnectedAt: { not: null },
      OR: [
        { accessToken: { not: null } },
        { refreshToken: { not: null } },
        { tokenExpiresAt: { not: null } },
      ],
    },
    select: { id: true },
  });
  let completed = 0;
  for (const company of companies) {
    if (await finishPendingQboDisconnect(company.id, deps)) completed += 1;
  }
  return { pending: companies.length - completed, completed };
}
