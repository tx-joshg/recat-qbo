import type { PrismaClient } from '@prisma/client';

export interface OriginalPurchaseLineContext {
  lineId: string | null;
  amount: number | null;
  description: string | null;
  detailType: string | null;
  accountQboId: string | null;
  taxCodeQboId: string | null;
  taxInclusiveAmount: number | null;
}

export interface AgentToolContext {
  schemaVersion: 'recat-agent-context-v1';
  companyId: string;
  transactionId: string;
  expectedUpdatedAt: Date;
  transaction: {
    id: string;
    qboType: string;
    qboSyncToken: string;
    date: string;
    payee: string;
    memo: string | null;
    amount: number;
    bankAccount: string;
  };
  holdingAccountQboIds: string[];
  originalLines: OriginalPurchaseLineContext[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function sanitizeOriginalPurchaseLines(rawData: unknown): OriginalPurchaseLineContext[] {
  if (!rawData || typeof rawData !== 'object') return [];
  const values = (rawData as { Line?: unknown }).Line;
  if (!Array.isArray(values)) return [];
  return values.slice(0, 100).map((value) => {
    const line = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const detail =
      line.AccountBasedExpenseLineDetail &&
      typeof line.AccountBasedExpenseLineDetail === 'object'
        ? (line.AccountBasedExpenseLineDetail as Record<string, unknown>)
        : {};
    const accountRef =
      detail.AccountRef && typeof detail.AccountRef === 'object'
        ? (detail.AccountRef as Record<string, unknown>)
        : {};
    const taxCodeRef =
      detail.TaxCodeRef && typeof detail.TaxCodeRef === 'object'
        ? (detail.TaxCodeRef as Record<string, unknown>)
        : {};
    return {
      lineId: nullableString(line.Id),
      amount: nullableNumber(line.Amount),
      description: nullableString(line.Description),
      detailType: nullableString(line.DetailType),
      accountQboId: nullableString(accountRef.value),
      taxCodeQboId: nullableString(taxCodeRef.value),
      taxInclusiveAmount: nullableNumber(detail.TaxInclusiveAmt),
    };
  });
}

export async function loadAgentToolContext(
  db: PrismaClient,
  companyId: string,
  transactionId: string,
): Promise<AgentToolContext> {
  const txn = await db.transaction.findFirst({
    where: { id: transactionId, companyId },
    select: {
      id: true,
      qboType: true,
      qboSyncToken: true,
      date: true,
      payee: true,
      memo: true,
      amount: true,
      bankAccount: true,
      updatedAt: true,
      rawData: true,
      company: { select: { holdingAccountIds: true } },
    },
  });
  if (!txn) throw new Error('Bound autopilot transaction was not found.');
  return {
    schemaVersion: 'recat-agent-context-v1',
    companyId,
    transactionId,
    expectedUpdatedAt: txn.updatedAt,
    transaction: {
      id: txn.id,
      qboType: txn.qboType,
      qboSyncToken: txn.qboSyncToken,
      date: txn.date.toISOString(),
      payee: txn.payee,
      memo: txn.memo,
      amount: Number(txn.amount),
      bankAccount: txn.bankAccount,
    },
    holdingAccountQboIds: strings(txn.company.holdingAccountIds),
    originalLines: sanitizeOriginalPurchaseLines(txn.rawData),
  };
}
