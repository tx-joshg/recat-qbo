import type { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type RuleWriteRetryDb = PrismaClient;

export async function markRuleWriteRetryPending(
  companyId: string,
  retryAt: Date,
  db: RuleWriteRetryDb = prisma,
): Promise<void> {
  await db.company.update({
    where: { id: companyId },
    data: { ruleWriteRetryAt: retryAt },
  });
}

export async function clearRuleWriteRetryPending(
  companyId: string,
  expectedRetryAt: Date | null,
  db: RuleWriteRetryDb = prisma,
): Promise<boolean> {
  if (expectedRetryAt === null) return false;
  const cleared = await db.company.updateMany({
    where: { id: companyId, ruleWriteRetryAt: expectedRetryAt },
    data: { ruleWriteRetryAt: null },
  });
  return cleared.count === 1;
}

export async function dueRuleWriteRetryCompanyIds(
  now = new Date(),
  db: RuleWriteRetryDb = prisma,
): Promise<string[]> {
  const rows = await db.company.findMany({
    where: {
      ruleWriteRetryAt: { lte: now },
      disconnectedAt: null,
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
