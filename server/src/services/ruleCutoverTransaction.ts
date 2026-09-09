import { Prisma, type PrismaClient } from '@prisma/client';
import { runSerializableTransaction } from '../lib/serializableTransaction.js';

const CUTOVER_LOCK_DEADLINE_MS = 30_000;
const CUTOVER_LOCK_RETRY_MS = 25;

class RuleCutoverFenceBusyError extends Error {
  constructor() {
    super('Rule cutover could not acquire a consistent database fence within 30 seconds.');
  }
}

function isPostgresLockUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const metadata = JSON.stringify(error.meta ?? {});
    return error.code === 'P2010'
      && (metadata.includes('55P03') || /could not obtain lock/iu.test(metadata));
  }
  return error instanceof Error && /could not obtain lock|55P03/iu.test(error.message);
}

async function acquireCutoverFences(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  try {
    // These one-time cutover commands read and write across the rule graph.
    // LOCK is deliberately the first transaction statement: as a utility
    // command it does not acquire an MVCC snapshot. NOWAIT aborts this attempt
    // rather than waiting, so the eventual successful attempt has fenced all
    // relevant DML before its first SERIALIZABLE snapshot is established.
    await tx.$executeRawUnsafe(`
      LOCK TABLE
        "Company", "Rule", "RuleTag", "RuleRevision", "RuleCanonicalMigration",
        "RuleAutoPostPreparation", "McpRuleOperation", "QboAccount", "QboTaxRate",
        "QboTaxCode", "Tag", "Transaction", "QboMutationAttempt", "AuditEntry"
      IN SHARE ROW EXCLUSIVE MODE NOWAIT
    `);
  } catch (error) {
    if (isPostgresLockUnavailable(error)) throw new RuleCutoverFenceBusyError();
    throw error;
  }
  const rows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 880217)) AS "locked"`,
    companyId,
  );
  if (rows[0]?.locked !== true) throw new RuleCutoverFenceBusyError();
}

export async function runRuleCutoverTransaction<TResult>(
  db: PrismaClient,
  companyId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<TResult>,
): Promise<TResult> {
  const deadline = Date.now() + CUTOVER_LOCK_DEADLINE_MS;
  while (true) {
    try {
      return await runSerializableTransaction<Prisma.TransactionClient, TResult>(
        db,
        async (tx) => {
          await acquireCutoverFences(tx, companyId);
          return callback(tx);
        },
      );
    } catch (error) {
      if (!(error instanceof RuleCutoverFenceBusyError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, CUTOVER_LOCK_RETRY_MS));
    }
  }
}
