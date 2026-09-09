import type { Company, Prisma } from '@prisma/client';
import { HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import type {
  QboRevocationCapability,
} from '../lib/qbo/types.js';
import { runSerializableTransaction } from '../lib/serializableTransaction.js';
import { processQboTokenRevocation } from './qboTokenRevocation.js';

export interface CompanySettingsPatch {
  nickname?: string;
  syncMode?: 'polling' | 'webhook';
  pollIntervalMin?: 5 | 10 | 30 | 60;
  holdingAccountIds?: string[];
  dryRun?: boolean;
  tagsRequired?: boolean;
  retainAttachmentFiles?: boolean;
  attachmentQuotaBytes?: bigint | null;
  attachmentRetentionDays?: number | null;
}

export interface CompanyLiveAuthorityDeps {
  now(): Date;
  withSerializableTransaction<T>(
    callback: (db: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface DisconnectedCompany {
  company: Company;
  revoke: QboRevocationCapability;
}

const defaultDeps: CompanyLiveAuthorityDeps = {
  now: () => new Date(),
  withSerializableTransaction: (callback) =>
    runSerializableTransaction(prisma, callback),
};

const policyPause = {
  liveAcceptedPolicyVersion: null,
  liveAcceptedConfigVersion: null,
  liveAcceptedProviderBinding: null,
  livePauseCode: 'LIVE_POLICY_NOT_ACCEPTED',
  livePauseMessage: 'Live mode is paused: The current live policy must be accepted.',
} as const;

const disconnectPause = {
  liveAcceptedPolicyVersion: null,
  liveAcceptedConfigVersion: null,
  liveAcceptedProviderBinding: null,
  livePauseCode: 'QBO_DISCONNECTED',
  livePauseMessage: 'Live mode is paused: QuickBooks is disconnected.',
} as const;

function captureRevocationCapability(id: string | null): QboRevocationCapability {
  return async () => {
    if (id === null) return;
    try {
      await processQboTokenRevocation(id);
    } catch {
      // Local authority is already gone; a failed drain remains recoverable.
    }
  };
}

/**
 * Applies authority-relevant company settings and their live pause in one
 * retryable serializable transaction. Requested intent is deliberately not
 * changed; an administrator must renew acceptance after a dry-run transition.
 */
export async function updateCompanySettingsWithLiveAuthority(
  companyId: string,
  patch: CompanySettingsPatch,
  deps: CompanyLiveAuthorityDeps = defaultDeps,
): Promise<Company> {
  const pausedAt = deps.now();
  return deps.withSerializableTransaction(async (db) => {
    const current = await db.company.findUnique({ where: { id: companyId } });
    if (current === null) {
      throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    }
    const dryRunChanged = patch.dryRun !== undefined && patch.dryRun !== current.dryRun;
    const updated = await db.company.update({
      where: { id: companyId },
      data: patch,
    });
    if (dryRunChanged) {
      await db.agentCompanyConfig.updateMany({
        where: { companyId, liveRequested: true },
        data: {
          ...policyPause,
          livePausedAt: pausedAt,
        },
      });
    }
    return updated;
  });
}

/**
 * Quarantines the encrypted token snapshot, disconnects QBO, and invalidates
 * requested live authority atomically. The opaque capability and boot recovery
 * invoke the same bounded best-effort attempt only after commit.
 */
export async function disconnectCompanyWithLiveAuthority(
  companyId: string,
  deps: CompanyLiveAuthorityDeps = defaultDeps,
): Promise<DisconnectedCompany> {
  const disconnectedAt = deps.now();
  return deps.withSerializableTransaction(async (db) => {
    const current = await db.company.findUnique({ where: { id: companyId } });
    if (current === null) {
      throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    }
    const revocation = current.refreshToken === null
      ? await db.qboTokenRevocation.findFirst({ where: { companyId }, select: { id: true } })
      : await db.qboTokenRevocation.create({ data: {
          companyId, realmId: current.realmId, encryptedRefreshToken: current.refreshToken,
        }, select: { id: true } });
    const revoke = captureRevocationCapability(revocation?.id ?? null);
    const updated = await db.company.update({
      where: { id: companyId },
      data: {
        disconnectedAt: current.disconnectedAt ?? disconnectedAt,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      },
    });
    await db.agentCompanyConfig.updateMany({
      where: { companyId, liveRequested: true },
      data: {
        ...disconnectPause,
        livePausedAt: disconnectedAt,
      },
    });
    return { company: updated, revoke };
  });
}
