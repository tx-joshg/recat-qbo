import { Prisma } from '@prisma/client';
import type {
  CategorizationProposal,
  RuleActionV2,
  RuleSuggestionDto,
  StageCategorizationInput,
  StagedCategorization,
} from '@recat/shared';
import {
  categorizationSourceGrossCents,
  stageCategorizationWithWorkflow,
  type CategorizationDb,
  type CategorizationStagingWorkflow,
} from './categorization.js';
import { prisma } from '../lib/prisma.js';
import { compareRuleWinner, ruleMatches } from './ruleMatching.js';
import {
  RuleServiceError,
  validateExistingRuleAction,
  type RuleRow,
} from './rules.js';
import { disableRuleForSafetyInTransaction } from './ruleSafetyTransition.js';

const REFERENCE_DRIFT_REASON = 'The rule category, tax code, or tag references became unavailable.';

export class RuleSuggestionApplicationError extends Error {
  constructor(
    readonly code: 'STALE_RULE_SUGGESTION' | 'RULE_SUGGESTION_BUSY' = 'STALE_RULE_SUGGESTION',
  ) {
    super(code === 'RULE_SUGGESTION_BUSY'
      ? 'Rule state is changing. Retry this suggestion.'
      : 'This rule suggestion changed. Reload before continuing.');
    this.name = 'RuleSuggestionApplicationError';
  }
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('meta' in error && typeof error.meta === 'object' && error.meta !== null
    && 'code' in error.meta && typeof error.meta.code === 'string') {
    return error.meta.code;
  }
  return 'code' in error && typeof error.code === 'string' ? error.code : null;
}

export async function acquireRuleSuggestionApplicationFence(
  tx: RuleVerificationDb,
  companyId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${companyId}, 880217)) AS "locked"
  `);
  if (rows[0]?.locked !== true) {
    throw new RuleSuggestionApplicationError('RULE_SUGGESTION_BUSY');
  }
  try {
    const companies = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
        FROM "Company"
       WHERE "id" = ${companyId}
       FOR SHARE NOWAIT
    `);
    if (companies.length !== 1) throw new RuleSuggestionApplicationError();
  } catch (error) {
    if (postgresCode(error) === '55P03') {
      throw new RuleSuggestionApplicationError('RULE_SUGGESTION_BUSY');
    }
    throw error;
  }
}

export interface StageRuleSuggestionInput {
  transactionId: string;
  companyId: string;
  expectedRevision: number;
  suggestion: RuleSuggestionDto;
}

type RuleVerificationDb = Prisma.TransactionClient;

export interface StageRuleSuggestionDeps {
  stage<T>(
    input: StageCategorizationInput,
    workflow: CategorizationStagingWorkflow<T>,
  ): Promise<T>;
  validateRuleAction(
    tx: RuleVerificationDb,
    companyId: string,
    rule: RuleRow,
  ): ReturnType<typeof validateExistingRuleAction>;
  disableRuleForSafety(
    tx: RuleVerificationDb,
    input: Parameters<typeof disableRuleForSafetyInTransaction>[1],
  ): ReturnType<typeof disableRuleForSafetyInTransaction>;
  acquireFence(tx: RuleVerificationDb, companyId: string): Promise<void>;
  loadSourceGrossCents(transactionId: string, companyId: string): Promise<number>;
}

const defaultDeps: StageRuleSuggestionDeps = {
  stage: stageCategorizationWithWorkflow,
  validateRuleAction: validateExistingRuleAction,
  disableRuleForSafety: disableRuleForSafetyInTransaction,
  acquireFence: acquireRuleSuggestionApplicationFence,
  loadSourceGrossCents: async (transactionId, companyId) => {
    const transaction = await prisma.transaction.findFirst({
      where: { id: transactionId, companyId },
      select: { amount: true, qboId: true, qboType: true, rawData: true },
    });
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { holdingAccountIds: true },
    });
    if (transaction === null || company === null) throw new RuleSuggestionApplicationError();
    return categorizationSourceGrossCents(transaction, company.holdingAccountIds);
  },
};

type VerificationResult =
  | { kind: 'staged'; staged: StagedCategorization }
  | { kind: 'stale' };

export function proposalFromRuleAction(
  action: RuleActionV2,
  grossCents: number,
): CategorizationProposal {
  return {
    taxCalculation: action.taxCalculation,
    lines: [{
      grossCents,
      categoryQboId: action.categoryQboId,
      taxCodeQboId: action.taxCodeQboId,
      tagIds: [...action.tagIds],
    }],
    tagIds: [...action.tagIds],
  };
}

export function actionFromVerified(
  resolved: Awaited<ReturnType<typeof validateExistingRuleAction>>,
): RuleActionV2 {
  return {
    version: 2,
    direction: resolved.direction,
    category: resolved.categoryName,
    categoryQboId: resolved.action.categoryQboId,
    taxCalculation: resolved.action.taxCalculation,
    taxCodeQboId: resolved.action.taxCodeQboId,
    tagIds: [...resolved.action.tagIds],
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAction(left: RuleActionV2, right: RuleActionV2): boolean {
  return left.version === right.version
    && left.direction === right.direction
    && left.category === right.category
    && left.categoryQboId === right.categoryQboId
    && left.taxCalculation === right.taxCalculation
    && left.taxCodeQboId === right.taxCodeQboId
    && sameStrings(left.tagIds, right.tagIds);
}

function eligibleRule(rule: RuleRow): boolean {
  return rule.enabled
    && rule.retiredAt === null
    && rule.reviewRequiredAt === null
    && rule.reviewReason === null
    && rule.repairReason === null
    && rule.canonicalVersion === 2
    && (rule.direction === 'Purchase' || rule.direction === 'Deposit');
}

export interface RuleApplicationAuthorityInput {
  companyId: string;
  transactionId: string;
  ruleId: string;
  ruleRevision: number;
  requireAutoPost: boolean;
  /** Reuses exact authority checks while paused only to retire provably unsent stale work. */
  inspectWhilePaused?: boolean;
}

export interface VerifiedRuleApplication {
  action: RuleActionV2;
  autoPost: boolean;
  qboType: 'Purchase' | 'Deposit';
}

export async function verifyRuleApplicationInsideStageTransaction(
  rawTx: CategorizationDb,
  input: RuleApplicationAuthorityInput,
  deps: Pick<StageRuleSuggestionDeps, 'validateRuleAction' | 'disableRuleForSafety' | 'acquireFence'> = defaultDeps,
): Promise<VerifiedRuleApplication | null> {
  const tx = rawTx as unknown as RuleVerificationDb;
  await deps.acquireFence(tx, input.companyId);
  const [company, transaction, rows] = await Promise.all([
    tx.company.findUnique({
      where: { id: input.companyId },
      select: { ruleRuntimeMode: true },
    }),
    tx.transaction.findFirst({
      where: { id: input.transactionId, companyId: input.companyId },
      select: { id: true, qboType: true, payee: true },
    }),
    tx.rule.findMany({
      where: { companyId: input.companyId, enabled: true, retiredAt: null },
      include: { ruleTags: true, candidateOrigin: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
  ]);
  const runtimeEligible = company?.ruleRuntimeMode === 'canonical'
    || (input.inspectWhilePaused === true && company?.ruleRuntimeMode === 'paused');
  if (!runtimeEligible || transaction === null) return null;
  const winner = rows
    .filter(eligibleRule)
    .filter((rule) => ruleMatches(
      { matchText: rule.matchText, direction: rule.direction },
      { description: transaction.payee, type: transaction.qboType },
    ))
    .sort(compareRuleWinner)[0];
  if (
    winner === undefined
    || winner.id !== input.ruleId
    || winner.revision !== input.ruleRevision
    || (input.requireAutoPost && !winner.autoPost)
  ) return null;

  let resolved: Awaited<ReturnType<typeof validateExistingRuleAction>>;
  try {
    resolved = await deps.validateRuleAction(tx, input.companyId, winner);
  } catch (error) {
    if (!(error instanceof RuleServiceError)) throw error;
    await deps.disableRuleForSafety(tx, {
      companyId: input.companyId,
      ruleId: winner.id,
      expectedRevision: winner.revision,
      reason: REFERENCE_DRIFT_REASON,
      actor: 'system:rule-suggestion-apply',
      preserveTagIds: winner.ruleTags.map(({ tagId }) => tagId),
    });
    return null;
  }
  if (transaction.qboType !== 'Purchase' && transaction.qboType !== 'Deposit') return null;
  return {
    action: actionFromVerified(resolved),
    autoPost: winner.autoPost,
    qboType: transaction.qboType,
  };
}

async function verifyInsideStageTransaction(
  rawTx: CategorizationDb,
  input: StageRuleSuggestionInput,
  deps: StageRuleSuggestionDeps,
): Promise<boolean> {
  const verified = await verifyRuleApplicationInsideStageTransaction(rawTx, {
    companyId: input.companyId,
    transactionId: input.transactionId,
    ruleId: input.suggestion.ruleId,
    ruleRevision: input.suggestion.ruleRevision,
    requireAutoPost: false,
  }, deps);
  return verified !== null
    && input.suggestion.autoPost === verified.autoPost
    && input.suggestion.action.direction === verified.qboType
    && sameAction(input.suggestion.action, verified.action);
}

export async function stageRuleSuggestion(
  input: StageRuleSuggestionInput,
  dependencies: Partial<StageRuleSuggestionDeps> = defaultDeps,
): Promise<StagedCategorization> {
  const deps: StageRuleSuggestionDeps = { ...defaultDeps, ...dependencies };
  const grossCents = await deps.loadSourceGrossCents(input.transactionId, input.companyId);
  const outcome = await deps.stage<VerificationResult>(
    {
      transactionId: input.transactionId,
      companyId: input.companyId,
      expectedRevision: input.expectedRevision,
      proposal: proposalFromRuleAction(input.suggestion.action, grossCents),
    },
    {
      beforeValidation: async (tx) => (
        await verifyInsideStageTransaction(tx, input, deps)
          ? { kind: 'continue' }
          : { kind: 'return', value: { kind: 'stale' } }
      ),
      afterStage: async (_tx, receipt) => ({ kind: 'staged', staged: receipt.staged }),
    },
  );
  if (outcome.kind === 'staged') return outcome.staged;
  // This throw happens after the staging transaction commits, preserving any
  // safety-disable revision/audit while guaranteeing no partial stage occurred.
  throw new RuleSuggestionApplicationError();
}
