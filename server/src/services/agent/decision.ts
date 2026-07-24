import type { PrismaClient } from '@prisma/client';
import type { TaxCalculation } from '@recat/shared';
import { z } from 'zod';
import { validatePurchaseTaxDecision } from '../categorization.js';
import { isTransferPair } from '../transfers.js';
import { validateSplits } from '../writeback.js';

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const money = z
  .number()
  .finite()
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, {
    message: 'Amounts may have at most two decimal places.',
  });
const evidence = z.array(boundedText(500)).max(20);

export const categorizeDecisionSchema = z
  .object({
    kind: z.literal('categorize'),
    taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
    lines: z
      .array(
        z
          .object({
            grossAmount: money,
            categoryQboId: boundedText(120),
            taxCodeQboId: boundedText(120).nullable(),
            memo: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    rationale: boundedText(2_000),
    evidence,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const transferDecisionSchema = z
  .object({
    kind: z.literal('transfer'),
    counterpartTransactionId: boundedText(120),
    rationale: boundedText(2_000),
    evidence,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const skipDecisionSchema = z
  .object({
    kind: z.literal('skip'),
    reasonCode: z.string().trim().min(1).max(100).regex(/^[A-Z0-9_]+$/),
    rationale: boundedText(2_000),
    requestedContext: z.array(boundedText(100)).max(10).optional(),
  })
  .strict();

export const agentDecisionSchema = z.discriminatedUnion('kind', [
  categorizeDecisionSchema,
  transferDecisionSchema,
  skipDecisionSchema,
]);

export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type CategorizeAgentDecision = z.infer<typeof categorizeDecisionSchema>;

export function parseAgentDecision(value: unknown): AgentDecision {
  return agentDecisionSchema.parse(value);
}

export interface DecisionValidationContext {
  companyId: string;
  transactionId: string;
  expectedUpdatedAt: Date;
}

export interface DecisionValidationReport {
  ok: boolean;
  code: string;
  message: string;
  checkedAt: string;
  transactionUpdatedAt?: string;
  resolvedLines?: {
    grossAmount: number;
    categoryQboId: string;
    category: string;
    taxCodeQboId: string;
    taxCode: string;
    memo?: string;
  }[];
  transferCounterpartId?: string;
}

function holdingIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function isAllowedPurchaseAccount(account: {
  active: boolean;
  qboId: string;
  classification: string;
  accountType: string | null;
}, companyHoldingIds: readonly string[]): boolean {
  if (!account.active || companyHoldingIds.includes(account.qboId)) return false;
  const classification = account.classification.toLowerCase();
  const accountType = account.accountType?.toLowerCase() ?? '';
  if (['bank', 'creditcard', 'income', 'revenue', 'equity'].includes(classification)) return false;
  if (
    accountType.includes('bank') ||
    accountType.includes('credit card') ||
    accountType.includes('accounts receivable') ||
    accountType.includes('accounts payable')
  ) {
    return false;
  }
  return true;
}

function report(ok: boolean, code: string, message: string): DecisionValidationReport {
  return { ok, code, message, checkedAt: new Date().toISOString() };
}

function isPayrollLike(payee: string, memo: string | null): boolean {
  return /\b(payroll|salary|wages?|adp|gusto|paychex|ceridian|deel)\b/i.test(
    `${payee}\n${memo ?? ''}`,
  );
}

/** Deterministic host validation. Model confidence never bypasses this code. */
export async function validateAgentDecision(
  db: PrismaClient,
  context: DecisionValidationContext,
  decision: AgentDecision,
): Promise<DecisionValidationReport> {
  const txn = await db.transaction.findFirst({
    where: { id: context.transactionId, companyId: context.companyId },
    include: {
      company: true,
      splitLines: { select: { id: true } },
      txnTags: { select: { tagId: true } },
    },
  });
  if (!txn) return report(false, 'AGENT_TXN_NOT_FOUND', 'The bound transaction no longer exists.');
  if (txn.updatedAt.getTime() !== context.expectedUpdatedAt.getTime()) {
    return report(
      false,
      'AGENT_STALE_INPUT',
      'The transaction changed after agent inference began.',
    );
  }
  if (txn.status !== 'PENDING') {
    return report(false, 'AGENT_TXN_STATUS', `Transaction status is ${txn.status}, not PENDING.`);
  }
  if (
    txn.category !== null ||
    txn.taxCalculation !== null ||
    txn.taxCode !== null ||
    txn.taxCodeQboId !== null ||
    txn.splitLines.length > 0 ||
    txn.txnTags.length > 0
  ) {
    return report(false, 'AGENT_HUMAN_STAGED', 'Human or rule staging appeared after this run began.');
  }
  if (txn.qboType !== 'Purchase') {
    return report(false, 'AGENT_ENTITY_UNSUPPORTED', 'Autopilot v1 supports Purchase only.');
  }
  if (Number(txn.amount) >= 0) {
    return report(
      false,
      'AGENT_REFUND_REVIEW_REQUIRED',
      'Purchase refunds and credits require human review in autopilot v1.',
    );
  }
  if (decision.kind === 'skip') {
    return {
      ...report(true, 'AGENT_SKIP', decision.rationale),
      transactionUpdatedAt: txn.updatedAt.toISOString(),
    };
  }
  if (decision.kind === 'transfer') {
    const counterpart = await db.transaction.findFirst({
      where: {
        id: decision.counterpartTransactionId,
        companyId: context.companyId,
        status: 'PENDING',
      },
      select: { id: true, amount: true, bankAccount: true, date: true },
    });
    if (
      !counterpart ||
      counterpart.id === txn.id ||
      !isTransferPair(
        {
          id: txn.id,
          amount: Number(txn.amount),
          bankAccount: txn.bankAccount,
          date: txn.date,
        },
        {
          id: counterpart.id,
          amount: Number(counterpart.amount),
          bankAccount: counterpart.bankAccount,
          date: counterpart.date,
        },
      )
    ) {
      return report(false, 'AGENT_TRANSFER_INVALID', 'The proposed transfer counterpart is no longer valid.');
    }
    return {
      ...report(true, 'AGENT_VALID', 'Transfer decision passed deterministic validation.'),
      transactionUpdatedAt: txn.updatedAt.toISOString(),
      transferCounterpartId: counterpart.id,
    };
  }
  if (isPayrollLike(txn.payee, txn.memo)) {
    return report(
      false,
      'AGENT_PAYROLL_REVIEW_REQUIRED',
      'Payroll-like purchases require human review in autopilot v1.',
    );
  }
  const nearby = await db.transaction.findMany({
    where: {
      companyId: context.companyId,
      id: { not: txn.id },
      status: 'PENDING',
      category: null,
      splitLines: { none: {} },
      date: {
        gte: new Date(txn.date.getTime() - 3 * 24 * 60 * 60 * 1000),
        lte: new Date(txn.date.getTime() + 3 * 24 * 60 * 60 * 1000),
      },
    },
    select: { id: true, amount: true, bankAccount: true, date: true },
  });
  const current = {
    id: txn.id,
    amount: Number(txn.amount),
    bankAccount: txn.bankAccount,
    date: txn.date,
  };
  if (
    nearby.some((candidate) =>
      isTransferPair(current, {
        id: candidate.id,
        amount: Number(candidate.amount),
        bankAccount: candidate.bankAccount,
        date: candidate.date,
      }),
    )
  ) {
    return report(
      false,
      'AGENT_TRANSFER_REVIEW_REQUIRED',
      'A current transfer counterpart requires human review in autopilot v1.',
    );
  }

  const splitCheck = validateSplits(
    Number(txn.amount),
    decision.lines.map((line) => ({ amount: line.grossAmount })),
  );
  if (!splitCheck.ok) {
    return report(false, 'AGENT_GROSS_MISMATCH', splitCheck.message ?? 'Line gross does not reconcile.');
  }
  const ids = [...new Set(decision.lines.map((line) => line.categoryQboId))];
  const accounts = await db.qboAccount.findMany({
    where: { companyId: context.companyId, qboId: { in: ids } },
    select: {
      qboId: true,
      name: true,
      fullName: true,
      active: true,
      classification: true,
      accountType: true,
    },
  });
  const byId = new Map(accounts.map((account) => [account.qboId, account]));
  const companyHoldingIds = holdingIds(txn.company.holdingAccountIds);
  for (const id of ids) {
    const account = byId.get(id);
    if (!account || !isAllowedPurchaseAccount(account, companyHoldingIds)) {
      return report(
        false,
        'AGENT_ACCOUNT_INVALID',
        `Account ${id} is unavailable, disallowed, or belongs to another company.`,
      );
    }
  }

  let codes;
  try {
    codes = await validatePurchaseTaxDecision(
      db,
      context.companyId,
      txn.qboType,
      decision.taxCalculation as TaxCalculation,
      decision.lines.map((line) => line.taxCodeQboId),
    );
  } catch (err) {
    return report(
      false,
      'AGENT_TAX_INVALID',
      err instanceof Error ? err.message : 'The tax decision is invalid.',
    );
  }
  return {
    ...report(true, 'AGENT_VALID', 'Categorization passed deterministic validation.'),
    transactionUpdatedAt: txn.updatedAt.toISOString(),
    resolvedLines: decision.lines.map((line, index) => {
      const account = byId.get(line.categoryQboId)!;
      const code = codes[index]!;
      return {
        grossAmount: line.grossAmount,
        categoryQboId: account.qboId,
        category: account.name,
        taxCodeQboId: code.qboId,
        taxCode: code.name,
        ...(line.memo !== undefined ? { memo: line.memo } : {}),
      };
    }),
  };
}
