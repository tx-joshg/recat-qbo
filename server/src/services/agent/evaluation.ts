import { Prisma, type PrismaClient } from '@prisma/client';
import { agentDecisionSchema } from './decision.js';
import { verifierResultSchema } from './verifier.js';

interface EvaluationRow {
  decision: unknown;
  validation: unknown;
  verifier: unknown;
  turnCount: number;
  toolCallCount: number;
  transactionSnapshot: unknown;
  transaction: {
    payee: string;
    amount: unknown;
    categoryQboId: string | null;
    taxCalculation: string | null;
    taxCodeQboId: string | null;
    splitLines: Array<{
      amount: unknown;
      categoryQboId: string | null;
      taxCodeQboId: string | null;
    }>;
  };
}

function evaluatedInput(row: EvaluationRow): { payee: string; amount: unknown } {
  if (row.transactionSnapshot && typeof row.transactionSnapshot === 'object') {
    const snapshot = row.transactionSnapshot as Record<string, unknown>;
    if (
      typeof snapshot.payee === 'string' &&
      typeof snapshot.amount === 'number' &&
      Number.isFinite(snapshot.amount)
    ) {
      return { payee: snapshot.payee, amount: snapshot.amount };
    }
  }
  return { payee: row.transaction.payee, amount: row.transaction.amount };
}

interface Metric {
  comparable: number;
  exact: number;
}

interface Slice {
  total: number;
  skipped: number;
  rejected: number;
}

export interface AutopilotEvaluationReport {
  schemaVersion: 'recat-autopilot-evaluation-v1';
  totalRuns: number;
  category: Metric;
  taxCode: Metric;
  splits: Metric;
  grossPreserved: Metric;
  skipped: number;
  validationRejected: number;
  verifierDisagreed: number;
  usage: {
    totalTurns: number;
    totalToolCalls: number;
    averageTurns: number;
    averageToolCalls: number;
  };
  slices: {
    transfer: Slice;
    payroll: Slice;
    refund: Slice;
    largeDeposit: Slice;
  };
  qboWrites: 0;
}

function emptyMetric(): Metric {
  return { comparable: 0, exact: 0 };
}

function emptySlice(): Slice {
  return { total: 0, skipped: 0, rejected: 0 };
}

function cents(value: unknown): number {
  return Math.round(Number(value) * 100);
}

function validationOk(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === true);
}

function addSlice(slice: Slice, skipped: boolean, rejected: boolean): void {
  slice.total += 1;
  if (skipped) slice.skipped += 1;
  if (rejected) slice.rejected += 1;
}

function splitSignature(
  values: Array<{ amount: unknown; categoryQboId: string | null; taxCodeQboId: string | null }>,
): string {
  return values
    .map((line) => `${cents(line.amount)}:${line.categoryQboId ?? ''}:${line.taxCodeQboId ?? ''}`)
    .sort()
    .join('|');
}

export function buildAutopilotEvaluation(
  rows: EvaluationRow[],
): AutopilotEvaluationReport {
  const report: AutopilotEvaluationReport = {
    schemaVersion: 'recat-autopilot-evaluation-v1',
    totalRuns: rows.length,
    category: emptyMetric(),
    taxCode: emptyMetric(),
    splits: emptyMetric(),
    grossPreserved: emptyMetric(),
    skipped: 0,
    validationRejected: 0,
    verifierDisagreed: 0,
    usage: {
      totalTurns: 0,
      totalToolCalls: 0,
      averageTurns: 0,
      averageToolCalls: 0,
    },
    slices: {
      transfer: emptySlice(),
      payroll: emptySlice(),
      refund: emptySlice(),
      largeDeposit: emptySlice(),
    },
    qboWrites: 0,
  };

  for (const row of rows) {
    report.usage.totalTurns += row.turnCount;
    report.usage.totalToolCalls += row.toolCallCount;
    const parsed = agentDecisionSchema.safeParse(row.decision);
    const decision = parsed.success ? parsed.data : null;
    const skipped = decision?.kind === 'skip';
    const rejected = !validationOk(row.validation);
    if (skipped) report.skipped += 1;
    if (rejected) report.validationRejected += 1;
    const verifier = verifierResultSchema.safeParse(row.verifier);
    if (verifier.success && verifier.data.verdict !== 'agree') report.verifierDisagreed += 1;

    const input = evaluatedInput(row);
    const payee = input.payee.toLowerCase();
    if (decision?.kind === 'transfer') addSlice(report.slices.transfer, skipped, rejected);
    if (/\b(payroll|deel|salary|wage)\b/.test(payee)) {
      addSlice(report.slices.payroll, skipped, rejected);
    }
    if (Number(input.amount) > 0 || /\b(refund|reversal)\b/.test(payee)) {
      addSlice(report.slices.refund, skipped, rejected);
    }
    if (Number(input.amount) >= 5_000) {
      addSlice(report.slices.largeDeposit, skipped, rejected);
    }
    if (!decision || decision.kind !== 'categorize') continue;

    const decisionGross = decision.lines.reduce((sum, line) => sum + cents(line.grossAmount), 0);
    report.grossPreserved.comparable += 1;
    if (decisionGross === cents(input.amount)) report.grossPreserved.exact += 1;

    const targetSplits = row.transaction.splitLines;
    if (targetSplits.length > 0) {
      report.splits.comparable += 1;
      if (
        splitSignature(targetSplits) ===
        splitSignature(
          decision.lines.map((line) => ({
            amount: line.grossAmount,
            categoryQboId: line.categoryQboId,
            taxCodeQboId: line.taxCodeQboId,
          })),
        )
      ) {
        report.splits.exact += 1;
      }
    } else if (row.transaction.categoryQboId) {
      report.category.comparable += 1;
      if (
        decision.lines.length === 1 &&
        decision.lines[0]?.categoryQboId === row.transaction.categoryQboId
      ) {
        report.category.exact += 1;
      }
    }

    if (row.transaction.taxCalculation && row.transaction.taxCodeQboId) {
      report.taxCode.comparable += 1;
      if (
        decision.taxCalculation === row.transaction.taxCalculation &&
        decision.lines.every(
          (line) => line.taxCodeQboId === row.transaction.taxCodeQboId,
        )
      ) {
        report.taxCode.exact += 1;
      }
    }
  }
  if (rows.length > 0) {
    report.usage.averageTurns = report.usage.totalTurns / rows.length;
    report.usage.averageToolCalls = report.usage.totalToolCalls / rows.length;
  }
  return report;
}

/**
 * Aggregate-only reader. It has no QBO client dependency and cannot stage,
 * post, or alter transactions.
 */
export async function evaluateAutopilot(
  companyId: string,
  db: PrismaClient,
): Promise<AutopilotEvaluationReport> {
  const rows = await db.agentRun.findMany({
    where: {
      companyId,
      mode: 'shadow',
      completedAt: { not: null },
      decision: { not: Prisma.DbNull },
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    take: 5_000,
    select: {
      decision: true,
      validation: true,
      verifier: true,
      turnCount: true,
      toolCallCount: true,
      transactionSnapshot: true,
      transaction: {
        select: {
          payee: true,
          amount: true,
          categoryQboId: true,
          taxCalculation: true,
          taxCodeQboId: true,
          splitLines: {
            select: { amount: true, categoryQboId: true, taxCodeQboId: true },
          },
        },
      },
    },
  });
  return buildAutopilotEvaluation(rows as unknown as EvaluationRow[]);
}
