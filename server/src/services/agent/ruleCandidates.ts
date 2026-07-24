import { Prisma, type PrismaClient } from '@prisma/client';
import type { TaxCalculation } from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../../lib/qbo/purchaseTax.js';
import { validatePurchaseTaxDecision } from '../categorization.js';
import { normalizeRulePayee, ruleMatchesPayee } from '../suggestions.js';
import { lockCompanyRuleBoundary } from '../ruleBoundary.js';
import { agentDecisionSchema, isAllowedPurchaseAccount } from './decision.js';
import { verifierResultSchema } from './verifier.js';

export const MIN_RULE_CANDIDATE_EVIDENCE = 3;

export function normalizeCandidatePayee(payee: string): string {
  const withoutTrailingDescriptor = payee
    .normalize('NFKC')
    .replace(/(?:[#*·]\s*)[\p{L}\p{N}-]*\d[\p{L}\p{N}-]*\s*$/u, '')
    .replace(/\s+\d{4,}\s*$/u, '');
  return normalizeRulePayee(withoutTrailingDescriptor).slice(0, 120);
}

interface CandidateEvidence {
  runId: string;
  transactionId: string;
  matchText: string;
  normalizedPayee: string;
  category: string;
  categoryQboId: string;
  taxCalculation: string;
  taxCode: string;
  taxCodeQboId: string;
}

function transactionSnapshot(value: unknown): {
  payee: string;
  qboType: string;
  amount: number;
} | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.payee !== 'string' ||
    typeof snapshot.qboType !== 'string' ||
    typeof snapshot.amount !== 'number' ||
    !Number.isFinite(snapshot.amount)
  ) {
    return null;
  }
  return {
    payee: snapshot.payee,
    qboType: snapshot.qboType,
    amount: snapshot.amount,
  };
}

function evidenceFromRun(row: {
  id: string;
  decision: unknown;
  validation: unknown;
  verifier: unknown;
  transactionSnapshot: unknown;
  transaction: { id: string };
}): CandidateEvidence | null {
  const decision = agentDecisionSchema.safeParse(row.decision);
  const verifier = verifierResultSchema.safeParse(row.verifier);
  const snapshot = transactionSnapshot(row.transactionSnapshot);
  if (
    !decision.success ||
    decision.data.kind !== 'categorize' ||
    decision.data.lines.length !== 1 ||
    !verifier.success ||
    verifier.data.verdict !== 'agree' ||
    !snapshot ||
    snapshot.qboType !== 'Purchase' ||
    snapshot.amount >= 0
  ) {
    return null;
  }
  const validation =
    row.validation && typeof row.validation === 'object'
      ? (row.validation as Record<string, unknown>)
      : null;
  const resolved =
    validation?.ok === true && Array.isArray(validation.resolvedLines)
      ? validation.resolvedLines[0]
      : null;
  if (!resolved || typeof resolved !== 'object') return null;
  const line = resolved as Record<string, unknown>;
  if (
    typeof line.category !== 'string' ||
    typeof line.categoryQboId !== 'string' ||
    typeof line.taxCode !== 'string' ||
    typeof line.taxCodeQboId !== 'string'
  ) {
    return null;
  }
  const normalizedPayee = normalizeCandidatePayee(snapshot.payee);
  if (
    normalizedPayee.length < 3 ||
    /\b(payroll|salary|refund|reversal|wire|tax payment)\b/.test(normalizedPayee)
  ) {
    return null;
  }
  return {
    runId: row.id,
    transactionId: row.transaction.id,
    matchText: normalizedPayee.slice(0, 120),
    normalizedPayee,
    category: line.category,
    categoryQboId: line.categoryQboId,
    taxCalculation: decision.data.taxCalculation,
    taxCode: line.taxCode,
    taxCodeQboId: line.taxCodeQboId,
  };
}

function signature(value: CandidateEvidence): string {
  return [
    value.categoryQboId,
    value.taxCalculation,
    value.taxCodeQboId,
  ].join('\u0000');
}

/**
 * Recompute one conservative candidate from append-only verifier-agreed runs.
 * Conflicting evidence is surfaced and prevents activation.
 */
export async function refreshRuleCandidate(
  runId: string,
  db: PrismaClient,
): Promise<{ id: string } | null> {
  const seedRun = await db.agentRun.findUnique({
    where: { id: runId },
    include: {
      transaction: {
        select: { id: true },
      },
    },
  });
  if (!seedRun || seedRun.completedAt === null || seedRun.errorCode !== null) return null;
  const seed = evidenceFromRun(seedRun);
  if (!seed) return null;

  const recentRuns = await db.agentRun.findMany({
    where: {
      companyId: seedRun.companyId,
      candidatePayee: seed.normalizedPayee,
      completedAt: { not: null },
      errorCode: null,
      verifier: { not: Prisma.DbNull },
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    include: {
      transaction: {
        select: { id: true },
      },
    },
  });
  const samePayee = recentRuns
    .map(evidenceFromRun)
    .filter((value): value is CandidateEvidence => value?.normalizedPayee === seed.normalizedPayee);
  const matching = samePayee.filter((value) => signature(value) === signature(seed));
  const conflicting = samePayee.filter((value) => signature(value) !== signature(seed));
  const byTransaction = new Map<string, CandidateEvidence>();
  for (const value of matching) {
    if (!byTransaction.has(value.transactionId)) {
      byTransaction.set(value.transactionId, value);
    }
  }
  const evidence = [...byTransaction.values()];
  if (evidence.length < MIN_RULE_CANDIDATE_EVIDENCE) {
    const established = await db.ruleCandidate.findMany({
      where: {
        companyId: seedRun.companyId,
        normalizedPayee: seed.normalizedPayee,
        status: 'pending',
      },
      select: {
        id: true,
        matchText: true,
        categoryQboId: true,
        taxCalculation: true,
        taxCodeQboId: true,
      },
    });
    if (established.length === 0) return null;
    const rules = await db.rule.findMany({
      where: { companyId: seedRun.companyId },
      select: { id: true, matchText: true, priority: true },
    });
    for (const candidate of established) {
      const candidateSignature = [
        candidate.categoryQboId,
        candidate.taxCalculation,
        candidate.taxCodeQboId,
      ].join('\u0000');
      const newConflicts = samePayee
        .filter((value) => signature(value) !== candidateSignature)
        .map((value) => ({
          runId: value.runId,
          categoryQboId: value.categoryQboId,
          taxCalculation: value.taxCalculation,
          taxCodeQboId: value.taxCodeQboId,
        }));
      const ruleConflicts = rules
        .filter((rule) => ruleMatchesPayee(candidate.matchText, rule.matchText))
        .map((rule) => ({
          ruleId: rule.id,
          matchText: rule.matchText,
          priority: rule.priority,
        }));
      await db.ruleCandidate.update({
        where: { id: candidate.id },
        data: { conflicts: [...newConflicts, ...ruleConflicts] },
      });
    }
    return null;
  }

  const evidenceTxnIds = [...new Set(evidence.map((value) => value.transactionId))];
  const [invalidated, rules] = await Promise.all([
    db.auditEntry.count({
      where: {
        companyId: seedRun.companyId,
        txnId: { in: evidenceTxnIds },
        action: { in: ['reverted', 'superseded'] },
      },
    }),
    db.rule.findMany({
      where: { companyId: seedRun.companyId },
      select: {
        id: true,
        matchText: true,
        categoryQboId: true,
        taxCalculation: true,
        taxCodeQboId: true,
        priority: true,
      },
    }),
  ]);
  if (invalidated > 0) return null;
  const ruleConflicts = rules
    .filter((rule) => ruleMatchesPayee(seed.matchText, rule.matchText))
    .map((rule) => ({ ruleId: rule.id, matchText: rule.matchText, priority: rule.priority }));
  const conflicts = [
    ...conflicting.map((value) => ({
      runId: value.runId,
      categoryQboId: value.categoryQboId,
      taxCalculation: value.taxCalculation,
      taxCodeQboId: value.taxCodeQboId,
    })),
    ...ruleConflicts,
  ];
  const fingerprint = canonicalHash({
    companyId: seedRun.companyId,
    normalizedPayee: seed.normalizedPayee,
    categoryQboId: seed.categoryQboId,
    taxCalculation: seed.taxCalculation,
    taxCodeQboId: seed.taxCodeQboId,
  });
  const candidate = await db.ruleCandidate.upsert({
    where: { fingerprint },
    create: {
      companyId: seedRun.companyId,
      fingerprint,
      normalizedPayee: seed.normalizedPayee,
      matchText: seed.matchText,
      category: seed.category,
      categoryQboId: seed.categoryQboId,
      taxCalculation: seed.taxCalculation,
      taxCode: seed.taxCode,
      taxCodeQboId: seed.taxCodeQboId,
      evidenceCount: evidence.length,
      evidenceRunIds: evidence.map((value) => value.runId),
      conflicts,
    },
    update: {
      matchText: seed.matchText,
      evidenceCount: evidence.length,
      evidenceRunIds: evidence.map((value) => value.runId),
      conflicts,
    },
    select: { id: true },
  });
  return candidate;
}

export async function activateRuleCandidate(
  companyId: string,
  candidateId: string,
  userId: string,
  db: PrismaClient,
): Promise<{ candidateId: string; ruleId: string }> {
  return db.$transaction(async (tx) => {
    await lockCompanyRuleBoundary(tx, companyId);
    const candidate = await tx.ruleCandidate.findFirst({
      where: { id: candidateId, companyId },
    });
    if (!candidate) throw new Error('Rule candidate not found.');
    if (candidate.status !== 'pending') throw new Error('Rule candidate is no longer pending.');
    const evidenceRunIds = Array.isArray(candidate.evidenceRunIds)
      ? candidate.evidenceRunIds.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      candidate.evidenceCount < MIN_RULE_CANDIDATE_EVIDENCE ||
      evidenceRunIds.length < MIN_RULE_CANDIDATE_EVIDENCE
    ) {
      throw new Error('Rule candidate no longer has enough evidence.');
    }
    const evidenceRuns = await tx.agentRun.findMany({
      where: {
        id: { in: evidenceRunIds },
        companyId,
        completedAt: { not: null },
        errorCode: null,
      },
      select: { transactionId: true },
    });
    if (evidenceRuns.length !== evidenceRunIds.length) {
      throw new Error('Rule candidate evidence is incomplete.');
    }
    if (
      new Set(evidenceRuns.map((run) => run.transactionId)).size <
      MIN_RULE_CANDIDATE_EVIDENCE
    ) {
      throw new Error('Rule candidate evidence must cover distinct transactions.');
    }
    const invalidated = await tx.auditEntry.count({
      where: {
        companyId,
        txnId: { in: evidenceRuns.map((run) => run.transactionId) },
        action: { in: ['reverted', 'superseded'] },
      },
    });
    if (invalidated > 0) {
      throw new Error('A supporting transaction was later undone or corrected.');
    }
    const currentRuns = await tx.agentRun.findMany({
      where: {
        companyId,
        candidatePayee: candidate.normalizedPayee,
        completedAt: { not: null },
        errorCode: null,
        verifier: { not: Prisma.DbNull },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      include: {
        transaction: {
          select: { id: true },
        },
      },
    });
    const currentEvidence = currentRuns
      .map(evidenceFromRun)
      .filter(
        (value): value is CandidateEvidence =>
          value?.normalizedPayee === candidate.normalizedPayee,
      );
    if (
      currentEvidence.some(
        (value) =>
          value.categoryQboId !== candidate.categoryQboId ||
          value.taxCalculation !== candidate.taxCalculation ||
          value.taxCodeQboId !== candidate.taxCodeQboId,
      )
    ) {
      throw new Error('New conflicting verified evidence blocks activation.');
    }
    const [company, account] = await Promise.all([
      tx.company.findUnique({
        where: { id: companyId },
        select: { holdingAccountIds: true },
      }),
      tx.qboAccount.findFirst({
        where: { companyId, qboId: candidate.categoryQboId },
        select: {
          qboId: true,
          name: true,
          active: true,
          classification: true,
          accountType: true,
        },
      }),
    ]);
    const holdingAccountIds = Array.isArray(company?.holdingAccountIds)
      ? company.holdingAccountIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    if (!account || !isAllowedPurchaseAccount(account, holdingAccountIds)) {
      throw new Error('The candidate category account is no longer active or eligible.');
    }
    if (
      candidate.taxCalculation !== 'TaxInclusive' &&
      candidate.taxCalculation !== 'TaxExcluded' &&
      candidate.taxCalculation !== 'NotApplicable'
    ) {
      throw new Error('The candidate tax calculation is no longer valid.');
    }
    let currentTax;
    try {
      [currentTax] = await validatePurchaseTaxDecision(
        tx,
        companyId,
        'Purchase',
        candidate.taxCalculation as TaxCalculation,
        [candidate.taxCodeQboId],
      );
    } catch {
      throw new Error('The candidate purchase TaxCode is no longer active or eligible.');
    }
    if (!currentTax) {
      throw new Error('The candidate purchase TaxCode is no longer active or eligible.');
    }
    const existing = await tx.rule.findMany({
      where: { companyId },
      select: { id: true, matchText: true, priority: true },
    });
    if (
      existing.some(
        (rule) => ruleMatchesPayee(candidate.matchText, rule.matchText),
      )
    ) {
      throw new Error('An existing higher-priority rule already matches this payee.');
    }
    const priority = existing.reduce((max, rule) => Math.max(max, rule.priority), -1) + 1;
    const rule = await tx.rule.create({
      data: {
        companyId,
        priority,
        matchText: candidate.matchText,
        category: account.name,
        categoryQboId: candidate.categoryQboId,
        taxCalculation: candidate.taxCalculation,
        taxCode: currentTax.name,
        taxCodeQboId: candidate.taxCodeQboId,
        autoPost: false,
        createdById: userId,
      },
      select: { id: true },
    });
    await tx.ruleCandidate.update({
      where: { id: candidate.id },
      data: { status: 'activated', createdRuleId: rule.id },
    });
    await tx.company.update({
      where: { id: companyId },
      data: { agentReconcileToken: randomUUID() },
    });
    return { candidateId: candidate.id, ruleId: rule.id };
  });
}
