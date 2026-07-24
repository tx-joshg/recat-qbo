import { Prisma, type AutopilotMode, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import {
  activeAgentVersionIdentity,
  enqueueEligibleTransactions,
  type AgentVersionIdentity,
} from './jobs.js';

type ReconciliationDb = PrismaClient | Prisma.TransactionClient;
const RECONCILIATION_BATCH_SIZE = 50;

export async function markAutopilotReconciliationPending(
  companyId: string,
  db: ReconciliationDb = prisma,
): Promise<string> {
  const token = randomUUID();
  await db.company.update({
    where: { id: companyId },
    data: { agentReconcileToken: token },
  });
  return token;
}

/**
 * Reconcile the durable job queue to the current mode. The pending marker is
 * cleared only after the idempotent queue operation succeeds and only if the
 * exact mode/token generation observed by this invocation is still current.
 */
export async function reconcileAutopilotJobs(
  companyId: string,
  db: ReconciliationDb = prisma,
): Promise<boolean> {
  const client = db as PrismaClient;
  if (typeof client.$transaction === 'function') {
    let expectedMode: AutopilotMode | null = null;
    let expectedToken: string | null = null;
    let expectedIdentity: AgentVersionIdentity | null = null;
    let afterTransactionId: string | undefined;
    for (;;) {
      const outcome = await client.$transaction(
        async (tx) => {
          // Lock only one bounded page at a time. Mode transitions serialize
          // on this row, while large queues make durable forward progress
          // instead of repeatedly rolling back one oversized transaction.
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "Company" WHERE "id" = ${companyId} FOR UPDATE`,
          );
          const company = await tx.company.findUnique({
            where: { id: companyId },
            select: { autopilotMode: true, agentReconcileToken: true },
          });
          if (!company?.agentReconcileToken) {
            return { done: true, cleared: false, nextCursor: null };
          }
          if (expectedToken === null) {
            expectedMode = company.autopilotMode;
            expectedToken = company.agentReconcileToken;
            // The instance-wide model and the company reconciliation token
            // must be observed under the same company-row generation. A
            // concurrent model change updates this marker after changing the
            // setting, so it either lands entirely before this snapshot or
            // leaves a newer marker for the next reconciliation pass.
            expectedIdentity = await activeAgentVersionIdentity();
          } else if (
            company.autopilotMode !== expectedMode ||
            company.agentReconcileToken !== expectedToken
          ) {
            return { done: true, cleared: false, nextCursor: null };
          }

          if (company.autopilotMode === 'off') {
            await tx.agentJob.updateMany({
              where: { companyId, status: { in: ['queued', 'retry'] } },
              data: {
                status: 'cancelled',
                lockedAt: null,
                lockOwner: null,
                leaseExpiresAt: null,
                lastErrorCode: 'AGENT_DISABLED',
                lastErrorMessage: 'Autopilot was disabled by an administrator.',
              },
            });
          } else {
            const page = await enqueueEligibleTransactions(companyId, tx, {
              identity: expectedIdentity!,
              requeueCompletedShadow: company.autopilotMode === 'live',
              batchSize: RECONCILIATION_BATCH_SIZE,
              ...(afterTransactionId ? { afterTransactionId } : {}),
            });
            if (page.nextCursor) {
              return { done: false, cleared: false, nextCursor: page.nextCursor };
            }
          }

          // A generation change that observes a running owner must remain
          // pending. That job deliberately keeps its old input hash until it
          // finishes; a later sweep can then replace or requeue it.
          const running = await tx.agentJob.count({
            where: { companyId, status: 'running' },
          });
          if (running > 0) {
            return { done: true, cleared: false, nextCursor: null };
          }

          const cleared = await tx.company.updateMany({
            where: {
              id: companyId,
              autopilotMode: company.autopilotMode,
              agentReconcileToken: company.agentReconcileToken,
            },
            data: { agentReconcileToken: null },
          });
          return { done: true, cleared: cleared.count === 1, nextCursor: null };
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      if (outcome.done) return outcome.cleared;
      afterTransactionId = outcome.nextCursor ?? undefined;
    }
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { autopilotMode: true, agentReconcileToken: true },
  });
  if (!company || !company.agentReconcileToken) return false;

  const mode: AutopilotMode = company.autopilotMode;
  const token = company.agentReconcileToken;
  const identity = await activeAgentVersionIdentity();
  if (mode === 'off') {
    await db.agentJob.updateMany({
      where: { companyId, status: { in: ['queued', 'retry'] } },
      data: {
        status: 'cancelled',
        lockedAt: null,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_DISABLED',
        lastErrorMessage: 'Autopilot was disabled by an administrator.',
      },
    });
  } else {
    await enqueueEligibleTransactions(companyId, db, {
      identity,
      requeueCompletedShadow: mode === 'live',
    });
  }

  const running = await db.agentJob.count({
    where: { companyId, status: 'running' },
  });
  if (running > 0) return false;

  const cleared = await db.company.updateMany({
    where: { id: companyId, autopilotMode: mode, agentReconcileToken: token },
    data: { agentReconcileToken: null },
  });
  return cleared.count === 1;
}

export async function requestAutopilotReconciliation(
  companyId: string,
  db: ReconciliationDb = prisma,
): Promise<boolean> {
  await markAutopilotReconciliationPending(companyId, db);
  return reconcileAutopilotJobs(companyId, db);
}

export async function sweepPendingAutopilotReconciliations(
  db: ReconciliationDb = prisma,
): Promise<number> {
  const companies = await db.company.findMany({
    where: { agentReconcileToken: { not: null } },
    select: { id: true },
  });
  let reconciled = 0;
  for (const company of companies) {
    try {
      if (await reconcileAutopilotJobs(company.id, db)) reconciled += 1;
    } catch (error) {
      console.error(`[agent] durable job reconciliation failed for ${company.id}:`, error);
    }
  }
  return reconciled;
}
