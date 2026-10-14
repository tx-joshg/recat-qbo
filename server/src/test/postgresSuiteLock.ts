import type { PrismaClient } from '../lib/db.js';

const AGENT_JOB_SUITE_LOCK = 728_202_603;

/**
 * Holds a transaction-scoped advisory lock on a dedicated Prisma connection.
 * Opt-in PostgreSQL suites that exercise the global agent claimer use the same
 * key so their fixtures cannot be claimed by another concurrently running file.
 */
export async function acquireAgentJobSuiteLock(
  client: PrismaClient,
): Promise<() => Promise<void>> {
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquiredResolve: (() => void) | undefined;
  let acquiredReject: ((error: unknown) => void) | undefined;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const transaction = client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(${AGENT_JOB_SUITE_LOCK})`,
    );
    acquiredResolve?.();
    await released;
  }, { maxWait: 60_000, timeout: 60_000 });
  void transaction.catch((error: unknown) => {
    acquiredReject?.(error);
  });
  await acquired;

  return async () => {
    release?.();
    await transaction;
  };
}
