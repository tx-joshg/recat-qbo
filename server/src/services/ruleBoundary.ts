import type { Prisma } from '@prisma/client';

/**
 * Serialize rule mutations with autopilot's final staging check.
 *
 * A row lock is used instead of an in-process mutex so the guarantee holds
 * across every web/worker process sharing the database. Callers must hold the
 * lock until their surrounding transaction commits.
 */
export async function lockCompanyRuleBoundary(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "Company"
    WHERE "id" = ${companyId}
    FOR UPDATE
  `;
}
