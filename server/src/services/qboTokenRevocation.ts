import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { QboRevocationSource } from '../lib/qbo/types.js';

const CLAIM_MS = 60_000;
const BATCH_SIZE = 25;

interface RevocationDeps {
  db: Pick<PrismaClient, 'qboTokenRevocation'>;
  now(): Date;
  revoke(source: QboRevocationSource): Promise<void>;
}

const defaultDeps: RevocationDeps = {
  db: prisma,
  now: () => new Date(),
  revoke: async (source) => {
    const { revokeCapturedQboToken } = await import('../lib/qbo/factory.js');
    await revokeCapturedQboToken(source);
  },
};

/** A completed best-effort attempt consumes only its own quarantined snapshot. */
export async function processQboTokenRevocation(
  id: string,
  deps: RevocationDeps = defaultDeps,
): Promise<void> {
  const record = await deps.db.qboTokenRevocation.findUnique({
    where: { id }, include: { company: { select: { disconnectedAt: true } } },
  });
  if (record === null) return;
  if (record.company.disconnectedAt === null) {
    await deps.db.qboTokenRevocation.deleteMany({ where: { id } });
    return;
  }
  const now = deps.now();
  const owner = randomUUID();
  const claimed = await deps.db.qboTokenRevocation.updateMany({
    where: {
      id,
      company: { disconnectedAt: { not: null } },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + CLAIM_MS) },
  });
  if (claimed.count !== 1) return;
  try {
    await deps.revoke({ realmId: record.realmId, refreshToken: record.encryptedRefreshToken });
  } catch {
    // Preserve current best-effort behavior: ordinary failures are not retried.
  } finally {
    await deps.db.qboTokenRevocation.deleteMany({ where: { id, leaseOwner: owner } });
  }
}

/** Boot and periodic recovery cover a process lost before its captured attempt. */
export async function sweepQboTokenRevocations(deps: RevocationDeps = defaultDeps): Promise<void> {
  const records = await deps.db.qboTokenRevocation.findMany({
    where: { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: deps.now() } }] },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });
  for (const record of records) await processQboTokenRevocation(record.id, deps);
}
