import { prisma } from '../../lib/prisma.js';
import { parseAgentDecision } from './core/decision.js';

const DEFAULT_EVIDENCE_THRESHOLD = 50;
const MIN_EVIDENCE_THRESHOLD = 25;
const MAX_EVIDENCE_THRESHOLD = 1000;
/** Live readiness uses one rolling 30-day window for all shadow evidence. */
export const LIVE_EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface VerifiedCategorizationProposal {
  taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
  lines: {
    idx: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    categoryQboId: string;
    taxCodeQboId: string | null;
    memo: string | null;
    tagIds: string[];
  }[];
  tagIds: string[];
}

export interface VerifiedCategorizationOutcome {
  companyId: string;
  transactionId: string;
  inputRevision: number;
  requestId: string;
  operation: 'posted' | 'reverted';
  proposal: VerifiedCategorizationProposal | null;
  candidateContext: {
    schemaVersion: 'rule-candidate-v1';
    matchField: 'payee';
    matchText: string;
    conditionFingerprint: string;
    configVersion: string;
    source: 'user' | 'autopilot' | 'mcp';
  } | null;
  decisionContext?: import('../categorizationEvidence.js').NormalizedCategorizationDecisionContext;
}

export interface EvaluationRunRow {
  id: string;
  companyId: string;
  transactionId: string;
  revision: number;
  configVersion: string;
  status: string;
  decision: unknown;
  verification: unknown;
  verifierKind: string;
  completedAt: Date | null;
}

export interface EvaluationDb {
  agentCompanyConfig: {
    findUnique(args: {
      where: { companyId: string };
    }): Promise<{
      companyId: string;
      configVersion: string;
      evidenceThreshold: number;
    } | null>;
  };
  agentRun: {
    findMany(args: {
      where: {
        companyId?: string;
        transactionId?: string;
        revision?: number;
        configVersion?: string;
        status?: string;
        verifierKind?: string;
        completedAt?: { gte: Date; lte: Date };
      };
    }): Promise<EvaluationRunRow[]>;
    update(args: {
      where: { id: string };
      data: { verification: unknown };
    }): Promise<unknown>;
  };
  transaction: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; companyId: true; revision: true; status: true };
    }): Promise<{
      id: string;
      companyId: string;
      revision: number;
      status: string;
    } | null>;
    findMany(args: {
      where: { companyId: string };
      select: { id: true; revision: true; status: true };
    }): Promise<{ id: string; revision: number; status: string }[]>;
  };
  $transaction<T>(
    callback: (tx: EvaluationDb) => Promise<T>,
    options?: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

export interface EvaluationDeps {
  db: EvaluationDb;
  now?: () => Date;
}

export type EvaluationQueryDb = Pick<
  EvaluationDb,
  'agentCompanyConfig' | 'agentRun' | 'transaction'
>;

export interface ShadowEvidenceSummary {
  eligibleRuns: number;
  agreements: number;
  disagreements: number;
  threshold: number;
  thresholdMet: boolean;
}

export interface LiveEvidenceWindow {
  completedSince: Date;
  completedThrough: Date;
}

export function liveEvidenceWindow(completedThrough: Date): LiveEvidenceWindow {
  return {
    completedSince: new Date(completedThrough.getTime() - LIVE_EVIDENCE_WINDOW_MS),
    completedThrough,
  };
}

const defaultDeps: EvaluationDeps = {
  db: prisma as unknown as EvaluationDb,
};

interface EvidenceEvaluation {
  state: 'eligible' | 'invalidated';
  outcomeRequestId: string;
  inputRevision: number;
  agreement?: boolean;
  invalidationReason?: 'corrected' | 'reverted';
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function verificationWith(
  current: unknown,
  evidenceEvaluation: EvidenceEvaluation,
): Record<string, unknown> {
  return {
    ...(runtimeRecord(current) ?? {}),
    evidenceEvaluation,
  };
}

function staticEvidenceEligible(run: EvaluationRunRow): boolean {
  const verification = runtimeRecord(run.verification);
  return (
    run.status === 'verified'
    && run.completedAt !== null
    && run.verifierKind === 'distinct_model'
    && verification?.diagnosticCode === 'AGENT_RUN_VERIFIED'
    && verification.verificationMode === 'distinct_model'
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedDecision(value: unknown): unknown {
  let decision;
  try {
    decision = parseAgentDecision({ decision: value });
  } catch {
    return null;
  }
  if (decision.kind !== 'proposal') return null;
  const lines = decision.lines.map((line) => ({
    grossCents: line.grossCents,
    categoryQboId: line.categoryQboId,
    taxCodeQboId: line.taxCodeQboId,
    memo: line.memo === null ? null : line.memo.normalize('NFC'),
    tagIds: sortedUnique(line.tagIds),
  }));
  return {
    taxCalculation: decision.taxCalculation,
    lines: lines.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))),
    tagIds: sortedUnique(decision.tagIds),
  };
}

function normalizedOutcome(proposal: VerifiedCategorizationProposal): unknown {
  const lines = proposal.lines.map((line) => ({
    grossCents: line.totalCents,
    categoryQboId: line.categoryQboId,
    taxCodeQboId: line.taxCodeQboId,
    memo: line.memo === null ? null : line.memo.normalize('NFC'),
    tagIds: sortedUnique(line.tagIds),
  }));
  return {
    taxCalculation: proposal.taxCalculation,
    lines: lines.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))),
    tagIds: sortedUnique(proposal.tagIds),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function agreements(run: EvaluationRunRow, proposal: VerifiedCategorizationProposal): boolean {
  const decision = normalizedDecision(run.decision);
  return decision !== null && canonicalJson(decision) === canonicalJson(normalizedOutcome(proposal));
}

/**
 * Atomically replaces evidence markings for one transaction outcome. Repeated
 * delivery of the same verified outcome is idempotent, while a later verified
 * post or revert invalidates every earlier marking before adding new evidence.
 */
export async function evaluateShadowRunAgainstOutcome(
  outcome: VerifiedCategorizationOutcome,
  deps: EvaluationDeps = defaultDeps,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { id: outcome.transactionId },
      select: {
        id: true,
        companyId: true,
        revision: true,
        status: true,
      },
    });
    const expectedStatus = outcome.operation === 'posted' ? 'POSTED' : 'PENDING';
    if (
      transaction === null
      || transaction.companyId !== outcome.companyId
      || transaction.revision !== outcome.inputRevision
      || transaction.status !== expectedStatus
    ) {
      return;
    }
    const existingRuns = await tx.agentRun.findMany({
      where: {
        companyId: outcome.companyId,
        transactionId: outcome.transactionId,
      },
    });
    const invalidationReason = outcome.operation === 'reverted' ? 'reverted' : 'corrected';
    for (const run of existingRuns) {
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          verification: verificationWith(run.verification, {
            state: 'invalidated',
            outcomeRequestId: outcome.requestId,
            inputRevision: outcome.inputRevision,
            invalidationReason,
          }),
        },
      });
    }

    if (outcome.operation === 'reverted' || outcome.proposal === null) return;
    const config = await tx.agentCompanyConfig.findUnique({
      where: { companyId: outcome.companyId },
    });
    if (config === null) return;

    const candidates = existingRuns.filter((run) =>
      run.revision === outcome.inputRevision
      && run.configVersion === config.configVersion
      && staticEvidenceEligible(run)
      && normalizedDecision(run.decision) !== null);
    for (const run of candidates) {
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          verification: verificationWith(run.verification, {
            state: 'eligible',
            outcomeRequestId: outcome.requestId,
            inputRevision: outcome.inputRevision,
            agreement: agreements(run, outcome.proposal),
          }),
        },
      });
    }
  }, { isolationLevel: 'RepeatableRead' });
}

function threshold(value: number): number {
  return Number.isInteger(value)
    && value >= MIN_EVIDENCE_THRESHOLD
    && value <= MAX_EVIDENCE_THRESHOLD
    ? value
    : DEFAULT_EVIDENCE_THRESHOLD;
}

export async function getShadowEvidenceSummary(
  companyId: string,
  deps: EvaluationDeps = defaultDeps,
  window = liveEvidenceWindow(deps.now?.() ?? new Date()),
): Promise<ShadowEvidenceSummary> {
  return deps.db.$transaction(
    (tx) => getShadowEvidenceSummaryInTransaction(companyId, tx, window),
    { isolationLevel: 'RepeatableRead' },
  );
}

export async function getShadowEvidenceSummaryInTransaction(
  companyId: string,
  db: EvaluationQueryDb,
  window = liveEvidenceWindow(new Date()),
): Promise<ShadowEvidenceSummary> {
  const config = await db.agentCompanyConfig.findUnique({ where: { companyId } });
  const required = threshold(config?.evidenceThreshold ?? DEFAULT_EVIDENCE_THRESHOLD);
  if (config === null) {
    return {
      eligibleRuns: 0,
      agreements: 0,
      disagreements: 0,
      threshold: required,
      thresholdMet: false,
    };
  }
  const [runs, transactions] = await Promise.all([
    db.agentRun.findMany({
      where: {
        companyId,
        configVersion: config.configVersion,
        status: 'verified',
        verifierKind: 'distinct_model',
        completedAt: {
          gte: window.completedSince,
          lte: window.completedThrough,
        },
      },
    }),
    db.transaction.findMany({
      where: { companyId },
      select: { id: true, revision: true, status: true },
    }),
  ]);
  const currentRevisions = new Map(transactions.map((transaction) =>
    [transaction.id, {
      revision: transaction.revision,
      status: transaction.status,
    }]));
  const evidence = runs.flatMap((run) => {
    if (!staticEvidenceEligible(run)) return [];
    if (normalizedDecision(run.decision) === null) return [];
    const current = currentRevisions.get(run.transactionId);
    if (current?.revision !== run.revision || current.status !== 'POSTED') return [];
    const evaluation = runtimeRecord(runtimeRecord(run.verification)?.evidenceEvaluation);
    if (
      evaluation?.state !== 'eligible'
      || evaluation.inputRevision !== run.revision
      || typeof evaluation.agreement !== 'boolean'
    ) {
      return [];
    }
    return [evaluation.agreement];
  });
  const agreementCount = evidence.filter(Boolean).length;
  return {
    eligibleRuns: evidence.length,
    agreements: agreementCount,
    disagreements: evidence.length - agreementCount,
    threshold: required,
    thresholdMet: evidence.length >= required,
  };
}
