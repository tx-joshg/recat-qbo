import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  CategorizationProposal,
  RuleActionV2,
  StageCategorizationInput,
} from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import {
  categorizationSourceGrossCents,
  stageCategorizationWithWorkflow,
  type CategorizationDb,
  type CategorizationStagingWorkflow,
} from './categorization.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { withEntityLease, type EntityLeaseDb } from './entityLease.js';
import {
  proposalFromRuleAction,
  verifyRuleApplicationInsideStageTransaction,
  type VerifiedRuleApplication,
} from './ruleSuggestionApplication.js';
import {
  commitRuleAutoPostPreparation,
  hashStagedCategorization,
  reconcileRuleAutoPostPreparation,
} from './writeback.js';
import { hashRuleAutoPostValue } from './ruleAutoPostBinding.js';

const ACTIVE_PREPARATION_STATES = ['PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE'] as const;
const TERMINAL_PREPARATION_STATES = ['VERIFIED', 'DRY_RUN', 'REJECTED', 'CANCELLED'] as const;
const RECOVERY_LIMIT = 100;

export class RuleAutoPostError extends Error {
  constructor(readonly code:
    | 'STALE_RULE_AUTO_POST'
    | 'HUMAN_STAGE_EXISTS'
    | 'PREPARATION_NOT_FOUND'
    | 'MISSING_RULE_AUTO_POST_ATTEMPT') {
    super(code === 'HUMAN_STAGE_EXISTS'
      ? 'This transaction already has a human-owned staged categorization.'
      : code === 'PREPARATION_NOT_FOUND'
        ? 'Rule auto-post preparation was not found.'
        : code === 'MISSING_RULE_AUTO_POST_ATTEMPT'
          ? 'A started rule auto-post has no durable provider attempt and cannot be resent.'
        : 'Rule auto-post authority changed before staging.');
    this.name = 'RuleAutoPostError';
  }
}

export interface PrepareRuleAutoPostInput {
  companyId: string;
  transactionId: string;
  ruleId: string;
  ruleRevision: number;
}

export interface RecoveryReport {
  examined: number;
  completed: number;
  pending: number;
  failed: number;
}

interface RuleAutoPostCandidate {
  expectedRevision: number;
  grossCents: number;
  action: RuleActionV2;
}

interface PreparationRecord {
  id: string;
  companyId: string;
  transactionId: string;
  ruleId: string;
  ruleRevision: number;
  requestId: string;
  state: string;
  proposal: unknown;
  preparedRevision: number;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
}

interface RuleAutoPostDeps {
  id(): string;
  stage<T>(
    input: StageCategorizationInput,
    workflow: CategorizationStagingWorkflow<T>,
  ): Promise<T>;
  loadCandidate(input: PrepareRuleAutoPostInput): Promise<RuleAutoPostCandidate>;
  verify(
    tx: Parameters<typeof verifyRuleApplicationInsideStageTransaction>[0],
    input: PrepareRuleAutoPostInput,
  ): Promise<VerifiedRuleApplication | null>;
  commit(preparationId: string): Promise<{ outcome: string }>;
  reconcile(preparationId: string): Promise<{ outcome: string }>;
  loadPreparation(preparationId: string): Promise<PreparationRecord | null>;
  listRecoverable(companyId?: string): Promise<PreparationRecord[]>;
  loadAttemptStatus(requestId: string): Promise<string | null>;
  updatePreparationFromAttempt(preparationId: string): Promise<string>;
  cancelStale(preparationId: string): Promise<boolean>;
}

function proposalMatchesAction(proposal: unknown, action: RuleActionV2): boolean {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) return false;
  const record = proposal as Record<string, unknown>;
  const lines = record.lines;
  const tags = record.tagIds;
  if (!Array.isArray(lines) || lines.length !== 1 || !Array.isArray(tags)) return false;
  const line = lines[0];
  if (typeof line !== 'object' || line === null || Array.isArray(line)) return false;
  const lineRecord = line as Record<string, unknown>;
  const lineTags = lineRecord.tagIds;
  if (!Array.isArray(lineTags)) return false;
  const expectedTags = [...action.tagIds].sort();
  const actualTags = tags.filter((tag): tag is string => typeof tag === 'string').sort();
  const actualLineTags = lineTags.filter((tag): tag is string => typeof tag === 'string').sort();
  return record.taxCalculation === action.taxCalculation
    && lineRecord.categoryQboId === action.categoryQboId
    && (lineRecord.taxCodeQboId ?? null) === action.taxCodeQboId
    && hashRuleAutoPostValue(actualTags) === hashRuleAutoPostValue(expectedTags)
    && hashRuleAutoPostValue(actualLineTags) === hashRuleAutoPostValue(expectedTags);
}

async function cancelPermanentlyStaleRuleAutoPost(preparationId: string): Promise<boolean> {
  const preparation = await prisma.ruleAutoPostPreparation.findUnique({ where: { id: preparationId } });
  if (preparation === null) throw new RuleAutoPostError('PREPARATION_NOT_FOUND');
  if (preparation.qboType !== 'Purchase' && preparation.qboType !== 'Deposit') return false;
  return withEntityLease({
    companyId: preparation.companyId,
    qboType: preparation.qboType,
    qboId: preparation.qboId,
  }, randomUUID(), () => prisma.$transaction(async (tx) => {
    const current = await tx.ruleAutoPostPreparation.findUnique({ where: { id: preparationId } });
    if (current === null || (current.state !== 'PREPARED' && current.state !== 'RETRYABLE')) {
      return false;
    }
    const attempt = await tx.qboMutationAttempt.findUnique({
      where: { requestId: current.requestId },
      select: { id: true, status: true },
    });
    if (attempt !== null && attempt.status !== 'PREPARED' && attempt.status !== 'RETRYABLE') {
      return false;
    }
    const verified = await verifyRuleApplicationInsideStageTransaction(tx as unknown as CategorizationDb, {
      companyId: current.companyId,
      transactionId: current.transactionId,
      ruleId: current.ruleId,
      ruleRevision: current.ruleRevision,
      requireAutoPost: true,
      inspectWhilePaused: true,
    });
    const [company, transaction] = await Promise.all([
      tx.company.findUnique({
        where: { id: current.companyId },
        select: { ruleRuntimeMode: true },
      }),
      tx.transaction.findFirst({
        where: { id: current.transactionId, companyId: current.companyId },
        select: { revision: true, status: true, qboType: true, qboId: true, qboSyncToken: true },
      }),
    ]);
    if (company === null || (company.ruleRuntimeMode !== 'canonical' && company.ruleRuntimeMode !== 'paused')) {
      return false;
    }
    const stale = verified === null
      || verified.qboType !== current.qboType
      || !proposalMatchesAction(current.proposal, verified.action)
      || transaction === null
      || transaction.revision !== current.preparedRevision
      || transaction.status !== 'PENDING'
      || transaction.qboType !== current.qboType
      || transaction.qboId !== current.qboId
      || transaction.qboSyncToken !== current.qboSyncToken;
    if (!stale) return false;
    const now = new Date();
    const cancelled = await tx.ruleAutoPostPreparation.updateMany({
      where: { id: current.id, state: { in: ['PREPARED', 'RETRYABLE'] } },
      data: {
        state: 'CANCELLED',
        errorCode: 'RULE_AUTO_POST_STALE',
        errorMessage: 'Rule auto-post authority changed before any provider send.',
        completedAt: now,
      },
    });
    if (cancelled.count !== 1) return false;
    if (attempt !== null) {
      await tx.qboMutationAttempt.updateMany({
        where: { id: attempt.id, status: { in: ['PREPARED', 'RETRYABLE'] } },
        data: {
          status: 'FAILED',
          errorCode: 'RULE_AUTO_POST_STALE',
          errorMessage: 'Rule auto-post authority changed before any provider send.',
        },
      });
    }
    return true;
  }), { db: prisma as unknown as EntityLeaseDb });
}

function actionFromCandidate(rule: {
  direction: string | null;
  category: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  ruleTags: { tagId: string }[];
}): RuleActionV2 {
  if (
    (rule.direction !== 'Purchase' && rule.direction !== 'Deposit')
    || rule.categoryQboId === null
    || (
      rule.taxCalculation !== 'TaxInclusive'
      && rule.taxCalculation !== 'TaxExcluded'
      && rule.taxCalculation !== 'NotApplicable'
    )
    || (rule.taxCalculation === 'NotApplicable' ? rule.taxCodeQboId !== null : rule.taxCodeQboId === null)
  ) {
    throw new RuleAutoPostError('STALE_RULE_AUTO_POST');
  }
  return {
    version: 2,
    direction: rule.direction,
    category: rule.category,
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map(({ tagId }) => tagId).sort(),
  };
}

async function loadCandidate(input: PrepareRuleAutoPostInput): Promise<RuleAutoPostCandidate> {
  const [transaction, company, rule] = await Promise.all([
    prisma.transaction.findFirst({
      where: { id: input.transactionId, companyId: input.companyId },
      select: {
        revision: true,
        amount: true,
        qboId: true,
        qboType: true,
        rawData: true,
      },
    }),
    prisma.company.findUnique({
      where: { id: input.companyId },
      select: { holdingAccountIds: true },
    }),
    prisma.rule.findFirst({
      where: { id: input.ruleId, companyId: input.companyId },
      include: { ruleTags: true },
    }),
  ]);
  if (transaction === null || company === null || rule === null) {
    throw new RuleAutoPostError('STALE_RULE_AUTO_POST');
  }
  return {
    expectedRevision: transaction.revision,
    grossCents: categorizationSourceGrossCents(transaction, company.holdingAccountIds),
    action: actionFromCandidate(rule),
  };
}

async function transitionPreparationFromAttempt(preparationId: string): Promise<string> {
  const preparation = await prisma.ruleAutoPostPreparation.findUnique({ where: { id: preparationId } });
  if (preparation === null) throw new RuleAutoPostError('PREPARATION_NOT_FOUND');
  const attempt = await prisma.qboMutationAttempt.findUnique({
    where: { requestId: preparation.requestId },
    select: { status: true, errorCode: true, errorMessage: true },
  });
  if (attempt === null) return preparation.state;
  const target = attempt.status === 'VERIFIED'
    ? 'VERIFIED'
    : attempt.status === 'DRY_RUN'
      ? 'DRY_RUN'
      : attempt.status === 'REJECTED' || attempt.status === 'FAILED'
        ? 'REJECTED'
        : attempt.status === 'UNCHANGED'
          ? 'REJECTED'
        : attempt.status === 'UNCERTAIN'
          ? 'UNCERTAIN'
          : attempt.status === 'RETRYABLE'
            ? 'RETRYABLE'
            : attempt.status === 'COMMITTING'
              ? 'COMMITTING'
              : preparation.state;
  if (target === preparation.state) return target;
  await runCompanyMutationTransaction(prisma, preparation.companyId, async (tx) => {
    let current = await tx.ruleAutoPostPreparation.findUniqueOrThrow({ where: { id: preparationId } });
    const needsCommitBridge = current.state === 'PREPARED'
      && (target === 'VERIFIED' || target === 'REJECTED' || target === 'UNCERTAIN');
    if (needsCommitBridge) {
      current = await tx.ruleAutoPostPreparation.update({
        where: { id: preparationId },
        data: { state: 'COMMITTING', commitStartedAt: new Date() },
      });
    }
    const terminal = (TERMINAL_PREPARATION_STATES as readonly string[]).includes(target);
    await tx.ruleAutoPostPreparation.update({
      where: { id: preparationId },
      data: {
        state: target,
        errorCode: attempt.status === 'UNCHANGED' ? 'QBO_WRITE_NOT_APPLIED' : attempt.errorCode,
        errorMessage: attempt.status === 'UNCHANGED'
          ? 'QuickBooks readback proved the prepared write was not applied.'
          : attempt.errorMessage,
        ...(target === 'COMMITTING' && current.commitStartedAt === null
          ? { commitStartedAt: new Date() }
          : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
      },
    });
  });
  return target;
}

const defaultDeps: RuleAutoPostDeps = {
  id: randomUUID,
  stage: stageCategorizationWithWorkflow,
  loadCandidate,
  verify: (tx, input) => verifyRuleApplicationInsideStageTransaction(tx, {
    ...input,
    requireAutoPost: true,
  }),
  commit: commitRuleAutoPostPreparation,
  reconcile: reconcileRuleAutoPostPreparation,
  loadPreparation: (id) => prisma.ruleAutoPostPreparation.findUnique({ where: { id } }),
  listRecoverable: (companyId) => prisma.ruleAutoPostPreparation.findMany({
    where: {
      ...(companyId === undefined ? {} : { companyId }),
      state: { in: [...ACTIVE_PREPARATION_STATES] },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: RECOVERY_LIMIT,
  }),
  loadAttemptStatus: async (requestId) => (
    await prisma.qboMutationAttempt.findUnique({
      where: { requestId },
      select: { status: true },
    })
  )?.status ?? null,
  updatePreparationFromAttempt: transitionPreparationFromAttempt,
  cancelStale: cancelPermanentlyStaleRuleAutoPost,
};

type PrepareOutcome =
  | { kind: 'prepared'; preparationId: string }
  | { kind: 'stale' }
  | { kind: 'human-stage' };

function sameAction(left: RuleActionV2, right: RuleActionV2): boolean {
  return hashRuleAutoPostValue(left) === hashRuleAutoPostValue(right);
}

export async function prepareRuleAutoPost(
  input: PrepareRuleAutoPostInput,
  dependencies: Partial<RuleAutoPostDeps> = defaultDeps,
): Promise<{ preparationId: string }> {
  const deps: RuleAutoPostDeps = { ...defaultDeps, ...dependencies };
  const candidate = await deps.loadCandidate(input);
  const preparationId = deps.id();
  const requestId = preparationId;
  const proposal: CategorizationProposal = proposalFromRuleAction(
    candidate.action,
    candidate.grossCents,
  );
  const outcome = await deps.stage<PrepareOutcome>({
    transactionId: input.transactionId,
    companyId: input.companyId,
    expectedRevision: candidate.expectedRevision,
    proposal,
  }, {
    beforeValidation: async (tx) => {
      const db = tx as unknown as Prisma.TransactionClient;
      const existing = await db.ruleAutoPostPreparation.findFirst({
        where: {
          companyId: input.companyId,
          transactionId: input.transactionId,
          state: { in: [...ACTIVE_PREPARATION_STATES] },
        },
      });
      if (existing !== null) {
        return existing.ruleId === input.ruleId && existing.ruleRevision === input.ruleRevision
          ? { kind: 'return', value: { kind: 'prepared', preparationId: existing.id } }
          : { kind: 'return', value: { kind: 'stale' } };
      }
      const verified = await deps.verify(tx, input);
      if (
        verified === null
        || verified.qboType !== candidate.action.direction
        || !sameAction(verified.action, candidate.action)
      ) {
        return { kind: 'return', value: { kind: 'stale' } };
      }
      const [splitCount, tagCount, stagedTransaction] = await Promise.all([
        db.splitLine.count({ where: { txnId: input.transactionId } }),
        db.txnTag.count({ where: { txnId: input.transactionId } }),
        db.transaction.findFirst({
          where: { id: input.transactionId, companyId: input.companyId },
        }),
      ]);
      return splitCount !== 0
        || tagCount !== 0
        || (stagedTransaction !== null && (
          stagedTransaction.category !== null || stagedTransaction.categoryQboId !== null
        ))
        ? { kind: 'return', value: { kind: 'human-stage' } }
        : { kind: 'continue' };
    },
    afterStage: async (tx, receipt) => {
      const db = tx as unknown as Prisma.TransactionClient;
      await db.ruleAutoPostPreparation.create({
        data: {
          id: preparationId,
          companyId: input.companyId,
          transactionId: input.transactionId,
          ruleId: input.ruleId,
          ruleRevision: input.ruleRevision,
          inputHash: hashRuleAutoPostValue(input),
          proposal: receipt.normalizedProposal as unknown as Prisma.InputJsonValue,
          proposalHash: hashRuleAutoPostValue(receipt.normalizedProposal),
          stagedGraphHash: hashStagedCategorization(receipt.staged),
          sourceRevision: receipt.sourceRevision,
          preparedRevision: receipt.preparedRevision,
          qboType: receipt.qboType,
          qboId: receipt.qboId,
          qboSyncToken: receipt.qboSyncToken,
          requestId,
          state: 'PREPARED',
          diagnostics: { owner: 'system:rule-auto-post', actionVersion: 2 },
        },
      });
      return { kind: 'prepared', preparationId };
    },
  });
  if (outcome.kind === 'prepared') return { preparationId: outcome.preparationId };
  throw new RuleAutoPostError(
    outcome.kind === 'human-stage' ? 'HUMAN_STAGE_EXISTS' : 'STALE_RULE_AUTO_POST',
  );
}

export async function resumeRuleAutoPost(
  preparationId: string,
  dependencies: Partial<RuleAutoPostDeps> = defaultDeps,
): Promise<void> {
  const deps: RuleAutoPostDeps = { ...defaultDeps, ...dependencies };
  const preparation = await deps.loadPreparation(preparationId);
  if (preparation === null) throw new RuleAutoPostError('PREPARATION_NOT_FOUND');
  if ((TERMINAL_PREPARATION_STATES as readonly string[]).includes(preparation.state)) return;
  const attemptStatus = await deps.loadAttemptStatus(preparation.requestId);
  const started = preparation.state === 'COMMITTING' || preparation.state === 'UNCERTAIN';
  if (started && (attemptStatus === null || attemptStatus === 'PREPARED' || attemptStatus === 'RETRYABLE')) {
    throw new RuleAutoPostError('MISSING_RULE_AUTO_POST_ATTEMPT');
  }
  try {
    if (started || attemptStatus === 'COMMITTING' || attemptStatus === 'UNCERTAIN') {
      await deps.reconcile(preparationId);
    } else {
      await deps.commit(preparationId);
    }
  } catch (error) {
    try {
      if (await deps.cancelStale(preparationId)) return;
    } catch {
      // Preserve the causal commit/reconciliation failure; recovery retries cleanup.
    }
    throw error;
  }
  await deps.updatePreparationFromAttempt(preparationId);
}

export async function recoverRuleAutoPosts(
  companyId?: string,
  dependencies: Partial<RuleAutoPostDeps> = defaultDeps,
): Promise<RecoveryReport> {
  const deps: RuleAutoPostDeps = { ...defaultDeps, ...dependencies };
  const rows = await deps.listRecoverable(companyId);
  const report: RecoveryReport = { examined: rows.length, completed: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    try {
      await resumeRuleAutoPost(row.id, deps);
      const state = await deps.updatePreparationFromAttempt(row.id);
      if ((TERMINAL_PREPARATION_STATES as readonly string[]).includes(state)) report.completed += 1;
      else report.pending += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
