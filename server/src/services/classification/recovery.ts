import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { CLASSIFICATION_ENVELOPE_VERSION } from '../categorizationEvidence.js';
import { reconcileVerifiedClassificationOutcomes } from './outcomeRecorder.js';

const COMPANIES_PER_TICK = 10;
interface RecoveryDependencies {
  db: Pick<PrismaClient, 'company'>;
  reconcile(companyId: string): Promise<number>;
}
interface RecoveryReport {
  examined: number;
  repaired: number;
  failed: number;
}

/** Repairs local immutable evidence only; this worker never reads or writes QuickBooks. */
export function createClassificationOutcomeRecoveryWorker(
  dependencies: RecoveryDependencies = {
    db: prisma,
    reconcile: reconcileVerifiedClassificationOutcomes,
  },
): () => Promise<RecoveryReport> {
  let afterCompanyId: string | null = null;
  let inFlight = false;
  return async () => {
    const report: RecoveryReport = { examined: 0, repaired: 0, failed: 0 };
    if (inFlight) return report;
    inFlight = true;
    try {
      const companies = await dependencies.db.company.findMany({
        where: {
          ...(afterCompanyId === null ? {} : { id: { gt: afterCompanyId } }),
          transactions: { some: { qboMutationAttempts: { some: {
            status: 'VERIFIED',
            operation: { in: ['recategorize', 'restore'] },
            ruleCandidateFoldedAt: null,
            classificationEnvelopeVersion: CLASSIFICATION_ENVELOPE_VERSION,
          } } } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: COMPANIES_PER_TICK,
      });
      // Advance past transient failures so one company cannot starve later ones.
      // A new process starts at the beginning and discovers the same durable work.
      afterCompanyId = companies.length === COMPANIES_PER_TICK
        ? companies.at(-1)!.id
        : null;
      for (const company of companies) {
        report.examined += 1;
        try {
          report.repaired += await dependencies.reconcile(company.id);
        } catch {
          report.failed += 1;
        }
      }
      return report;
    } finally {
      inFlight = false;
    }
  };
}

export const runClassificationOutcomeRecoveryTick = createClassificationOutcomeRecoveryWorker();
