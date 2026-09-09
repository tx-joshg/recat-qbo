import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  ClassificationAction,
  RuleDirection,
  RuleMutationKind,
  RuleMutationPreview,
  RuleMutationResult,
  RuleOriginIntent,
  TaxCalculation,
} from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import type { McpPrincipal } from '../../mcp/auth.js';
import {
  CLASSIFICATION_SAFE_ERROR_MESSAGES,
  parseRuleMutationPreview,
  parseRuleMutationResult,
} from '../classification/contracts.js';
import { parseActionTagIds } from '../classification/actionTagIds.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import {
  createRuleInTransaction,
  loadCompanyRule,
  nextRulePriorityInTransaction,
  readCanonicalRuleRevision,
  resolveRuleAction,
  reviewRuleInTransaction,
  RuleServiceError,
  setRuleEnabledInTransaction,
  testRuleCondition,
  updateRuleInTransaction,
  validateSourceCase,
  type RuleActor,
  type RuleRow,
  type RuleTransaction,
  type UpdateRuleInput,
} from '../rules.js';
import {
  activateRuleCandidateInTransaction,
  dismissRuleCandidateInTransaction,
  getRuleCandidate,
  reconcileRuleCandidateActivationInTransaction,
  RuleCandidateError,
  validateRuleCandidateActivationInTransaction,
} from '../ruleCandidates.js';
import {
  createPreparedRuleOperation,
  hasValidMcpRuleOperationIntegrity,
  hashOperationPayload,
  loadOwnedRuleOperation,
  normalizeMcpOperationIdempotencyKey,
  type McpOperationJsonObject,
  type McpRuleOperationRecord,
  type RuleOperationPrincipal,
} from './operations.js';
import {
  assertCurrentMcpCategorizationAuthorization,
  type McpCategorizationAuthorizationStore,
} from './categorization.js';

const RULE_MUTATIONS = new Set<RuleMutationKind>([
  'create',
  'update',
  'review',
  'enable',
  'disable',
  'activate_candidate',
  'dismiss_candidate',
]);
const MAX_REVISION = 2_147_483_646;
const AUTO_POST_ELEVATION_WARNING = 'Enabling auto-post affects matching pending transactions.';

export interface RuleChangeProposal {
  matchText?: string;
  direction?: RuleDirection;
  categoryQboId?: string;
  taxCalculation?: TaxCalculation;
  taxCodeQboId?: string | null;
  tagIds?: string[];
  autoPost?: boolean;
  sourceCaseId?: string | null;
  reviewReason?: string;
}

export interface PrepareMcpRuleChangeInput {
  companyId: string;
  mutation: RuleMutationKind;
  ruleId?: string;
  candidateId?: string;
  expectedRevision: number;
  idempotencyKey: string;
  retryOfId?: string;
  proposal?: RuleChangeProposal;
}

export interface CommitMcpRuleChangeInput {
  operationId: string;
  idempotencyKey: string;
  companyId?: string;
}

export interface McpRuleChangeDependencies {
  db?: PrismaClient;
  now?: () => Date;
}

export type RuleChangePrincipal = RuleOperationPrincipal;
export type PrepareRuleChangeInput = PrepareMcpRuleChangeInput;
export type CommitRuleChangeInput = CommitMcpRuleChangeInput;

interface RuleChangeAuthorizationStore extends McpCategorizationAuthorizationStore {
  session: {
    findFirst(args: {
      where: { id: string; userId: string; expiresAt: { gt: Date } };
      select: { id: true; user: { select: { isInstanceAdmin: true } } };
    }): Promise<{ id: string; user: { isInstanceAdmin: boolean } } | null>;
  };
}

export type McpRuleChangeErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'COMPANY_DISCONNECTED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RULE_CHANGES_READ_ONLY'
  | 'STALE_REVISION'
  | 'OPERATION_EXPIRED'
  | 'OPERATION_CORRUPT'
  | 'IDEMPOTENCY_CONFLICT';

const ERROR_MESSAGES: Readonly<Record<McpRuleChangeErrorCode, string>> = {
  UNAUTHORIZED: 'Rule operation credential is no longer authorized.',
  FORBIDDEN: 'Current company role cannot change rules.',
  COMPANY_DISCONNECTED: 'This company is disconnected from QuickBooks.',
  INVALID_INPUT: CLASSIFICATION_SAFE_ERROR_MESSAGES.INVALID_INPUT,
  NOT_FOUND: CLASSIFICATION_SAFE_ERROR_MESSAGES.NOT_FOUND,
  CONFLICT: CLASSIFICATION_SAFE_ERROR_MESSAGES.CONFLICT,
  RULE_CHANGES_READ_ONLY: 'Rule changes are currently read-only for this company. Ask an administrator to complete the rule migration or resume rule editing.',
  STALE_REVISION: CLASSIFICATION_SAFE_ERROR_MESSAGES.STALE_REVISION,
  OPERATION_EXPIRED: 'Prepared rule change expired.',
  OPERATION_CORRUPT: 'Prepared rule change failed integrity validation.',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with the prepared rule change.',
};

export class McpRuleChangeError extends Error {
  constructor(readonly code: McpRuleChangeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpRuleChangeError';
  }
}

interface NormalizedRuleChangeRequest {
  companyId: string;
  mutation: RuleMutationKind;
  ruleId: string | null;
  candidateId: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  retryOfId: string | null;
  proposal: RuleChangeProposal;
}

interface PreparedPlan {
  resourceType: 'rule' | 'rule_candidate';
  resourceId: string;
  ruleId: string | null;
  candidateId: string | null;
  originIntent: RuleOriginIntent;
  currentRevision: number;
  proposedRevision: number;
  condition: { matchField: 'payee'; matchText: string };
  direction: RuleDirection | null;
  action: ClassificationAction | null;
  categoryName: string;
  taxCodeName: string | null;
  priority: number;
  autoPost: boolean;
  snapshot: McpOperationJsonObject;
  warnings: string[];
}

interface StoredRuleChangePayload extends McpOperationJsonObject {
  request: McpOperationJsonObject;
  plan: McpOperationJsonObject;
  preview: McpOperationJsonObject;
}

function fail(code: McpRuleChangeErrorCode): never {
  throw new McpRuleChangeError(code);
}

function normalizedId(value: unknown, required: boolean): string | null {
  if (value == null && !required) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail('INVALID_INPUT');
  return value;
}

function normalizeRequest(input: PrepareMcpRuleChangeInput): NormalizedRuleChangeRequest {
  const companyId = normalizedId(input.companyId, true)!;
  if (!RULE_MUTATIONS.has(input.mutation)) fail('INVALID_INPUT');
  if (
    !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 0
    || input.expectedRevision > MAX_REVISION
  ) fail('INVALID_INPUT');
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) fail('INVALID_INPUT');
  const ruleId = normalizedId(input.ruleId, false);
  const candidateId = normalizedId(input.candidateId, false);
  const retryOfId = normalizedId(input.retryOfId, false);
  const proposal = input.proposal ?? {};
  if (proposal === null || Array.isArray(proposal) || typeof proposal !== 'object') {
    fail('INVALID_INPUT');
  }
  const requiresRule = ['update', 'review', 'enable', 'disable'].includes(input.mutation);
  const requiresCandidate = ['activate_candidate', 'dismiss_candidate'].includes(input.mutation);
  if (
    (requiresRule !== (ruleId !== null))
    || (requiresCandidate !== (candidateId !== null))
    || (input.mutation === 'create' && (ruleId !== null || candidateId !== null))
  ) fail('INVALID_INPUT');
  return {
    companyId,
    mutation: input.mutation,
    ruleId,
    candidateId,
    expectedRevision: input.expectedRevision,
    idempotencyKey,
    retryOfId,
    proposal: structuredClone(proposal),
  };
}

function requestJson(request: NormalizedRuleChangeRequest): McpOperationJsonObject {
  return JSON.parse(JSON.stringify(request)) as McpOperationJsonObject;
}

function isSessionPrincipal(
  principal: RuleOperationPrincipal,
): principal is Extract<RuleOperationPrincipal, { kind: 'session' }> {
  return principal.kind === 'session';
}

function operationOwner(principal: RuleOperationPrincipal): Record<string, unknown> {
  return isSessionPrincipal(principal)
    ? { authKind: 'session', sessionId: principal.sessionId, userId: principal.userId }
    : { authKind: 'mcp', tokenId: principal.tokenId, userId: principal.userId };
}

async function assertCurrentRuleAuthorization(
  store: RuleChangeAuthorizationStore,
  principal: RuleOperationPrincipal,
  companyId: string,
  checkedAt: Date,
): Promise<void> {
  if (!isSessionPrincipal(principal)) {
    await assertCurrentMcpCategorizationAuthorization(store, principal as McpPrincipal, companyId, checkedAt);
    return;
  }
  const session = await store.session.findFirst({
    where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: checkedAt } },
    select: { id: true, user: { select: { isInstanceAdmin: true } } },
  });
  if (session === null) fail('UNAUTHORIZED');
  const membership = await store.membership.findUnique({
    where: { userId_companyId: { userId: principal.userId, companyId } },
    select: { role: true },
  });
  if (membership?.role !== 'categorizer' && membership?.role !== 'admin') fail('FORBIDDEN');
  const company = await store.company.findUnique({ where: { id: companyId } });
  if (company === null || company.disconnectedAt !== null) fail('COMPANY_DISCONNECTED');
}

async function lockRuleAuthorizationRows(
  tx: RuleTransaction,
  principal: RuleOperationPrincipal,
  companyId: string,
): Promise<void> {
  if (isSessionPrincipal(principal)) {
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${principal.sessionId} AND "userId" = ${principal.userId} FOR SHARE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "McpToken" WHERE "id" = ${principal.tokenId} AND "userId" = ${principal.userId} FOR SHARE`;
  }
  await tx.$queryRaw`SELECT "userId" FROM "Membership" WHERE "userId" = ${principal.userId} AND "companyId" = ${companyId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR SHARE`;
}

async function lockRuleRuntime(tx: RuleTransaction, companyId: string): Promise<string | null> {
  // Hold the durable gate through commit, including against operator SQL that
  // does not acquire the application advisory lock. Follow the company-first
  // lock order before authorization, operation, or live rule rows.
  const rows = await tx.$queryRaw<Array<{ ruleRuntimeMode: string }>>`
    SELECT "ruleRuntimeMode" FROM "Company" WHERE "id" = ${companyId} FOR SHARE
  `;
  return rows[0]?.ruleRuntimeMode ?? null;
}

function assertCanonicalRuleRuntime(runtime: string | null): void {
  if (runtime !== 'canonical') fail('RULE_CHANGES_READ_ONLY');
}

function actor(principal: RuleOperationPrincipal): RuleActor {
  return {
    id: principal.userId,
    label: isSessionPrincipal(principal) ? 'Browser session' : `MCP ${principal.tokenPrefix}`,
  };
}

function deterministicRuleId(principal: RuleOperationPrincipal, request: NormalizedRuleChangeRequest): string {
  const hex = hashOperationPayload({
    owner: isSessionPrincipal(principal) ? `session:${principal.sessionId}` : `mcp:${principal.tokenId}`,
    companyId: request.companyId,
    idempotencyKey: request.idempotencyKey,
  });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function storedRuleAction(rule: RuleRow): ClassificationAction | null {
  const tagIds = parseActionTagIds(rule.ruleTags.map(({ tagId }) => tagId));
  if (
    rule.categoryQboId === null
    || tagIds === null
    || (
      rule.taxCalculation !== 'TaxInclusive'
      && rule.taxCalculation !== 'TaxExcluded'
      && rule.taxCalculation !== 'NotApplicable'
    )
    || ((rule.taxCalculation === 'NotApplicable') !== (rule.taxCodeQboId === null))
  ) return null;
  return {
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: tagIds.sort(),
  };
}

function existingAction(rule: RuleRow): ClassificationAction {
  const action = storedRuleAction(rule);
  if (action === null) fail('INVALID_INPUT');
  return action;
}

function storedCandidateAction(candidate: {
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  tagIds: Prisma.JsonValue;
}): ClassificationAction | null {
  const tagIds = parseActionTagIds(candidate.tagIds);
  if (
    candidate.categoryQboId === null
    || tagIds === null
    || (
      candidate.taxCalculation !== 'TaxInclusive'
      && candidate.taxCalculation !== 'TaxExcluded'
      && candidate.taxCalculation !== 'NotApplicable'
    )
    || ((candidate.taxCalculation === 'NotApplicable') !== (candidate.taxCodeQboId === null))
  ) return null;
  return {
    categoryQboId: candidate.categoryQboId,
    taxCalculation: candidate.taxCalculation,
    taxCodeQboId: candidate.taxCodeQboId,
    tagIds: tagIds.sort(),
  };
}

function requireNoUnexpectedProposal(
  proposal: RuleChangeProposal,
  allowed: readonly (keyof RuleChangeProposal)[],
): void {
  const allowedSet = new Set<string>(allowed);
  if (Object.keys(proposal).some((key) => !allowedSet.has(key))) fail('INVALID_INPUT');
}

async function buildPlan(
  tx: RuleTransaction,
  principal: RuleOperationPrincipal,
  request: NormalizedRuleChangeRequest,
  resourceIdOverride?: string,
): Promise<PreparedPlan> {
  try {
    if (request.mutation === 'create') {
      requireNoUnexpectedProposal(request.proposal, [
        'matchText', 'direction', 'categoryQboId', 'taxCalculation', 'taxCodeQboId',
        'tagIds', 'autoPost', 'sourceCaseId',
      ]);
      const proposal = request.proposal;
      if (
        typeof proposal.matchText !== 'string'
        || (proposal.direction !== 'Purchase' && proposal.direction !== 'Deposit')
        || typeof proposal.categoryQboId !== 'string'
        || proposal.taxCalculation === undefined
        || !Array.isArray(proposal.tagIds)
        || proposal.autoPost !== false
      ) fail('INVALID_INPUT');
      const resolved = await resolveRuleAction(tx, request.companyId, {
        direction: proposal.direction,
        categoryQboId: proposal.categoryQboId,
        taxCalculation: proposal.taxCalculation,
        taxCodeQboId: proposal.taxCodeQboId ?? null,
        tagIds: proposal.tagIds,
      });
      await validateSourceCase(tx, request.companyId, proposal.sourceCaseId);
      const priority = await nextRulePriorityInTransaction(tx, request.companyId);
      const resourceId = resourceIdOverride ?? deterministicRuleId(principal, request);
      const collision = await tx.rule.findUnique({ where: { id: resourceId }, select: { id: true } });
      if (collision !== null) fail('CONFLICT');
      return {
        resourceType: 'rule', resourceId, ruleId: resourceId, candidateId: null,
        originIntent: 'make_recurring', currentRevision: 0, proposedRevision: 1,
        condition: { matchField: 'payee', matchText: proposal.matchText.trim() },
        direction: resolved.direction,
        action: resolved.action, categoryName: resolved.categoryName,
        taxCodeName: resolved.taxCodeName, priority,
        autoPost: false,
        snapshot: {
          ruleId: resourceId,
          condition: { matchField: 'payee', matchText: proposal.matchText.trim() },
          direction: resolved.direction,
          action: JSON.parse(JSON.stringify(resolved.action)) as McpOperationJsonObject,
          priority,
          autoPost: false,
          originIntent: 'make_recurring',
          sourceCaseId: proposal.sourceCaseId ?? null,
          enabled: true,
        },
        warnings: [],
      };
    }

    if (request.mutation === 'dismiss_candidate') {
      requireNoUnexpectedProposal(request.proposal, []);
      const candidate = await tx.autopilotRuleCandidate.findFirst({
        where: { id: request.candidateId!, companyId: request.companyId },
      });
      if (candidate === null) fail('NOT_FOUND');
      if (request.expectedRevision !== 0) fail('STALE_REVISION');
      if (candidate.state === 'activated') fail('CONFLICT');
      const action = storedCandidateAction(candidate);
      const [category, taxCode] = await Promise.all([
        candidate.categoryQboId === null
          ? null
          : tx.qboAccount.findFirst({
              where: { companyId: request.companyId, qboId: candidate.categoryQboId },
              select: { name: true },
            }),
        candidate.taxCodeQboId === null
          ? null
          : tx.qboTaxCode.findFirst({
              where: { companyId: request.companyId, qboId: candidate.taxCodeQboId },
              select: { name: true },
            }),
      ]);
      return {
        resourceType: 'rule_candidate', resourceId: candidate.id, ruleId: null,
        candidateId: candidate.id, originIntent: 'auto_candidate',
        currentRevision: 0, proposedRevision: 1,
        condition: { matchField: 'payee', matchText: candidate.matchText },
        direction: null, action: null, categoryName: category?.name ?? 'Unavailable category',
        taxCodeName: taxCode?.name ?? null, priority: 0, autoPost: false,
        snapshot: {
          candidateId: candidate.id,
          candidateUpdatedAt: candidate.updatedAt.toISOString(),
          evidenceCount: candidate.evidenceCount,
          conflictingEvidenceCount: candidate.conflictingEvidenceCount,
          action: action === null
            ? null
            : JSON.parse(JSON.stringify(action)) as McpOperationJsonObject,
          ruleId: null,
          state: 'dismissed',
        },
        warnings: action === null ? ['Stored legacy action is non-executable.'] : [],
      };
    }

    if (request.mutation === 'activate_candidate') {
      requireNoUnexpectedProposal(request.proposal, []);
      const candidate = await getRuleCandidate(
        request.companyId,
        request.candidateId!,
        tx as unknown as PrismaClient,
      );
      if (request.expectedRevision !== 0) fail('STALE_REVISION');
      if (!candidate.canActivate) fail('CONFLICT');
      if (candidate.state === 'activated') fail('CONFLICT');
      if (
        candidate.categoryQboId === null
        || candidate.category === null
        || candidate.taxCalculation === null
        || !Array.isArray(candidate.tagIds)
      ) fail('CONFLICT');
      const resolved = await resolveRuleAction(tx, request.companyId, {
        categoryQboId: candidate.categoryQboId,
        taxCalculation: candidate.taxCalculation,
        taxCodeQboId: candidate.taxCodeQboId,
        tagIds: candidate.tagIds,
      });
      await validateRuleCandidateActivationInTransaction(
        tx,
        request.companyId,
        candidate.id,
      );
      const priority = await nextRulePriorityInTransaction(tx, request.companyId);
      const ruleId = deterministicRuleId(principal, request);
      return {
        resourceType: 'rule_candidate', resourceId: candidate.id, ruleId,
        candidateId: candidate.id, originIntent: 'auto_candidate',
        currentRevision: 0, proposedRevision: 1,
        condition: { matchField: 'payee', matchText: candidate.matchText },
        direction: resolved.direction,
        action: resolved.action, categoryName: resolved.categoryName,
        taxCodeName: resolved.taxCodeName, priority, autoPost: false,
        snapshot: {
          candidateId: candidate.id,
          candidateUpdatedAt: candidate.updatedAt,
          evidenceCount: candidate.evidenceCount,
          conflictingEvidenceCount: candidate.conflictingEvidenceCount,
          direction: resolved.direction,
          action: JSON.parse(JSON.stringify(resolved.action)) as McpOperationJsonObject,
          ruleId,
          state: 'activated',
        },
        warnings: [],
      };
    }

    const editableFields: readonly (keyof RuleChangeProposal)[] = [
      'matchText', 'direction', 'categoryQboId', 'taxCalculation', 'taxCodeQboId',
      'tagIds', 'autoPost',
    ];
    requireNoUnexpectedProposal(
      request.proposal,
      request.mutation === 'update'
        ? editableFields
        : request.mutation === 'review'
          ? [...editableFields, 'reviewReason']
          : [],
    );
    const rule = await loadCompanyRule(
      tx,
      request.companyId,
      request.ruleId!,
      { includeRetired: request.mutation === 'review' },
    );
    if (rule.revision !== request.expectedRevision) fail('STALE_REVISION');
    const patch = request.proposal;
    if (request.mutation === 'disable') {
      if (!rule.enabled) fail('CONFLICT');
      const action = rule.direction === null ? null : storedRuleAction(rule);
      return {
        resourceType: 'rule', resourceId: rule.id, ruleId: rule.id, candidateId: null,
        originIntent: rule.originIntent as RuleOriginIntent,
        currentRevision: rule.revision, proposedRevision: rule.revision + 1,
        condition: { matchField: 'payee', matchText: rule.matchText },
        direction: rule.direction,
        action, categoryName: rule.category, taxCodeName: rule.taxCode,
        priority: rule.priority, autoPost: rule.autoPost,
        snapshot: {
          ruleId: rule.id,
          condition: { matchField: 'payee', matchText: rule.matchText },
          direction: rule.direction,
          action: action === null
            ? null
            : JSON.parse(JSON.stringify(action)) as McpOperationJsonObject,
          ruleUpdatedAt: rule.updatedAt.toISOString(),
          priority: rule.priority,
          autoPost: rule.autoPost,
          enabled: false,
        },
        warnings: action === null ? ['Stored legacy action is non-executable.'] : [],
      };
    }
    const base = existingAction(rule);
    if (request.mutation === 'update' && Object.keys(patch).length === 0) fail('INVALID_INPUT');
    if (
      request.mutation === 'review'
      && patch.reviewReason !== undefined
      && (typeof patch.reviewReason !== 'string' || patch.reviewReason.trim() === '')
    ) fail('INVALID_INPUT');
    if (rule.autoPost === false && patch.autoPost === true) {
      if (Object.keys(patch).some((key) => key !== 'autoPost')) fail('INVALID_INPUT');
    }
    const resolved = await resolveRuleAction(tx, request.companyId, {
      ...(patch.direction !== undefined
        ? { direction: patch.direction }
        : rule.direction !== null
          ? { direction: rule.direction }
          : {}),
      categoryQboId: patch.categoryQboId ?? base.categoryQboId,
      taxCalculation: patch.taxCalculation ?? base.taxCalculation,
      taxCodeQboId: patch.taxCodeQboId !== undefined ? patch.taxCodeQboId : base.taxCodeQboId,
      tagIds: patch.tagIds ?? base.tagIds,
    });
    const priority = rule.priority;
    if (request.mutation === 'enable' && rule.enabled) fail('CONFLICT');
    const enabled = request.mutation === 'enable'
      ? true
      : request.mutation === 'review'
        ? false
        : rule.enabled;
    return {
      resourceType: 'rule', resourceId: rule.id, ruleId: rule.id, candidateId: null,
      originIntent: rule.originIntent as RuleOriginIntent,
      currentRevision: rule.revision, proposedRevision: rule.revision + 1,
      condition: {
        matchField: 'payee',
        matchText: patch.matchText?.trim() ?? rule.matchText,
      },
      direction: resolved.direction,
      action: resolved.action, categoryName: resolved.categoryName,
      taxCodeName: resolved.taxCodeName, priority,
      autoPost: patch.autoPost ?? rule.autoPost,
      snapshot: {
        ruleId: rule.id,
        condition: { matchField: 'payee', matchText: patch.matchText?.trim() ?? rule.matchText },
        direction: resolved.direction,
        action: JSON.parse(JSON.stringify(resolved.action)) as McpOperationJsonObject,
        priority,
        autoPost: patch.autoPost ?? rule.autoPost,
        enabled,
        reviewReason: patch.reviewReason ?? null,
      },
      warnings: rule.autoPost === false && patch.autoPost === true
        ? [AUTO_POST_ELEVATION_WARNING]
        : [],
    };
  } catch (error) {
    if (error instanceof McpRuleChangeError) throw error;
    if (error instanceof RuleServiceError) {
      fail(error.code);
    }
    if (error instanceof RuleCandidateError) {
      fail(error.code === 'CANDIDATE_NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT');
    }
    throw error;
  }
}

async function buildPreviewBasis(
  tx: RuleTransaction,
  plan: PreparedPlan,
): Promise<Omit<RuleMutationPreview, 'operationId' | 'expiresAt' | 'preparationDigest'>> {
  const mutation = plan.snapshot.mutation as RuleMutationKind;
  const tested = await testRuleCondition(
    tx,
    plan.snapshot.companyId as string,
    plan.condition.matchText,
    {
      direction: plan.direction,
      excludeRuleId: mutation === 'create' || mutation === 'activate_candidate'
        ? undefined
        : plan.ruleId ?? undefined,
    },
  );
  const autoPostElevation = plan.warnings.includes(AUTO_POST_ELEVATION_WARNING);
  const winnerImpact = autoPostElevation
    ? await exactWinnerImpact(tx, plan)
    : null;
  return {
    companyId: plan.snapshot.companyId as string,
    ruleId: plan.ruleId,
    candidateId: plan.candidateId,
    mutation: plan.snapshot.mutation as RuleMutationKind,
    originIntent: plan.originIntent,
    currentRevision: plan.currentRevision,
    proposedRevision: plan.proposedRevision,
    condition: plan.condition,
    direction: plan.direction,
    action: plan.action,
    categoryName: plan.categoryName,
    taxCodeName: plan.taxCodeName,
    autoPost: plan.autoPost,
    affectedPendingCount: winnerImpact?.pendingCount ?? tested.pendingCount,
    affectedProcessedCount: winnerImpact?.processedCount ?? tested.processedCount,
    sampleTransactions: winnerImpact?.samples ?? tested.samples,
    conflicts: tested.conflicts,
    warnings: plan.warnings,
  };
}

async function exactWinnerImpact(
  tx: RuleTransaction,
  plan: PreparedPlan,
): Promise<{
  pendingCount: number;
  processedCount: number;
  samples: RuleMutationPreview['sampleTransactions'];
}> {
  if (plan.ruleId === null || plan.snapshot.enabled !== true) {
    return { pendingCount: 0, processedCount: 0, samples: [] };
  }
  const target = await tx.rule.findFirst({
    where: { id: plan.ruleId, companyId: plan.snapshot.companyId as string },
    select: { createdAt: true },
  });
  if (target === null) fail('CONFLICT');
  if (plan.direction === null) {
    return { pendingCount: 0, processedCount: 0, samples: [] };
  }
  const companyId = plan.snapshot.companyId as string;
  const winningWhere = Prisma.sql`
    t."companyId" = ${companyId}
    AND t."status" IN ('PENDING', 'POSTED', 'DRY_RUN')
    AND t."qboType" = ${plan.direction}
    AND position(rule_match_key(${plan.condition.matchText}) IN rule_match_key(t."payee")) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM "Rule" r
      WHERE r."companyId" = ${companyId}
        AND r."id" <> ${plan.ruleId}
        AND r."enabled" = true
        AND r."retiredAt" IS NULL
        AND r."direction" = t."qboType"::"RuleDirection"
        AND rule_match_key(r."matchText") <> ''
        AND position(rule_match_key(r."matchText") IN rule_match_key(t."payee")) > 0
        AND (
          r."priority" < ${plan.priority}
          OR (r."priority" = ${plan.priority} AND r."createdAt" > ${target.createdAt})
          OR (r."priority" = ${plan.priority} AND r."createdAt" = ${target.createdAt} AND r."id" < ${plan.ruleId})
        )
    )
  `;
  const counts = await tx.$queryRaw<Array<{ pendingCount: number; processedCount: number }>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE t."status" = 'PENDING')::int AS "pendingCount",
      COUNT(*) FILTER (WHERE t."status" IN ('POSTED', 'DRY_RUN'))::int AS "processedCount"
    FROM "Transaction" t
    WHERE ${winningWhere}
  `);
  const rows = await tx.$queryRaw<Array<{
    id: string;
    payee: string;
    date: Date;
    amount: Prisma.Decimal;
    status: 'PENDING' | 'POSTED' | 'DRY_RUN';
  }>>(Prisma.sql`
    SELECT t."id", t."payee", t."date", t."amount", t."status"
    FROM "Transaction" t
    WHERE ${winningWhere}
    ORDER BY t."date" DESC, t."id" DESC
    LIMIT 20
  `);
  return {
    pendingCount: counts[0]?.pendingCount ?? 0,
    processedCount: counts[0]?.processedCount ?? 0,
    samples: rows.map((row) => ({
      transactionId: row.id,
      payee: row.payee,
      date: row.date.toISOString(),
      amountCents: Math.round(Number(row.amount) * 100),
      status: row.status,
    })),
  };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') fail('OPERATION_CORRUPT');
  return value as Record<string, unknown>;
}

function previewFromOperation(operation: McpRuleOperationRecord): RuleMutationPreview {
  const payload = payloadRecord(operation.payload);
  const basis = payloadRecord(payload.preview);
  return parseRuleMutationPreview({
    ...basis,
    operationId: operation.id,
    expiresAt: operation.expiresAt.toISOString(),
    preparationDigest: hashOperationPayload({
      operationId: operation.id,
      inputHash: operation.inputHash,
      proposedSnapshotHash: operation.proposedSnapshotHash,
    }),
  });
}

function preparedResult(operation: McpRuleOperationRecord): RuleMutationResult {
  const preview = previewFromOperation(operation);
  return parseRuleMutationResult({
    ok: true,
    operationId: operation.id,
    companyId: operation.companyId,
    mutation: operation.mutation,
    originIntent: preview.originIntent,
    status: 'PREPARED',
    ruleId: preview.ruleId,
    revision: preview.proposedRevision,
    rule: null,
    candidate: null,
    preview,
    error: null,
  });
}

export async function prepareRuleChange(
  principal: RuleOperationPrincipal,
  input: PrepareMcpRuleChangeInput,
  dependencies: McpRuleChangeDependencies = {},
): Promise<RuleMutationResult> {
  const db = dependencies.db ?? prisma;
  const now = dependencies.now ?? (() => new Date());
  const request = normalizeRequest(input);
  const checkedAt = now();
  if (Number.isNaN(checkedAt.getTime())) fail('INVALID_INPUT');
  await assertCurrentRuleAuthorization(
    db as unknown as RuleChangeAuthorizationStore,
    principal,
    request.companyId,
    checkedAt,
  );
  return db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, request.companyId);
    const runtime = await lockRuleRuntime(tx, request.companyId);
    await lockRuleAuthorizationRows(tx, principal, request.companyId);
    await assertCurrentRuleAuthorization(
      tx as unknown as RuleChangeAuthorizationStore,
      principal,
      request.companyId,
      checkedAt,
    );
    const existing = await tx.mcpRuleOperation.findFirst({
      where: {
        ...operationOwner(principal),
        companyId: request.companyId,
        idempotencyKey: request.idempotencyKey,
      },
    });
    if (existing !== null) {
      if (
        !hasValidMcpRuleOperationIntegrity(existing as McpRuleOperationRecord)
        || hashOperationPayload(payloadRecord(existing.payload).request) !== hashOperationPayload(requestJson(request))
      ) fail('IDEMPOTENCY_CONFLICT');
      if (existing.commitResult !== null) {
        const committed = parseRuleMutationResult(existing.commitResult);
        return parseRuleMutationResult({ ...committed, status: 'REPLAYED', preview: null });
      }
      assertCanonicalRuleRuntime(runtime);
      return preparedResult(existing as McpRuleOperationRecord);
    }
    assertCanonicalRuleRuntime(runtime);
    let retryParent: McpRuleOperationRecord | null = null;
    if (request.retryOfId !== null) {
      retryParent = await tx.mcpRuleOperation.findFirst({
        where: {
          id: request.retryOfId,
          ...operationOwner(principal),
        },
      }) as McpRuleOperationRecord | null;
      if (retryParent === null) fail('NOT_FOUND');
      if (
        retryParent.commitResult !== null
        || retryParent.expiresAt.getTime() > checkedAt.getTime()
      ) fail('INVALID_INPUT');
    }
    const plan = await buildPlan(
      tx,
      principal,
      request,
      request.mutation === 'create' ? retryParent?.resourceId : undefined,
    );
    plan.snapshot.companyId = request.companyId;
    plan.snapshot.mutation = request.mutation;
    const preview = await buildPreviewBasis(tx, plan);
    const payload: StoredRuleChangePayload = {
      request: requestJson(request),
      plan: JSON.parse(JSON.stringify(plan)) as McpOperationJsonObject,
      preview: JSON.parse(JSON.stringify(preview)) as McpOperationJsonObject,
    };
    const operation = await createPreparedRuleOperation({
      principal,
      companyId: request.companyId,
      resourceType: plan.resourceType,
      resourceId: plan.resourceId,
      mutation: request.mutation,
      idempotencyKey: request.idempotencyKey,
      payload,
      sourceRevision: plan.currentRevision,
      proposedRevision: plan.proposedRevision,
      proposedSnapshotHash: hashOperationPayload(plan.snapshot),
      retryOfId: request.retryOfId,
    }, { store: tx, now: () => checkedAt });
    return preparedResult(operation);
  }, { maxWait: 30_000, timeout: 30_000 });
}

function requestFromOperation(operation: McpRuleOperationRecord): NormalizedRuleChangeRequest {
  const request = payloadRecord(payloadRecord(operation.payload).request);
  return normalizeRequest(request as unknown as PrepareMcpRuleChangeInput);
}

async function executePlan(
  tx: RuleTransaction,
  principal: RuleOperationPrincipal,
  request: NormalizedRuleChangeRequest,
  plan: PreparedPlan,
): Promise<{ rule: RuleMutationResult['rule']; candidate: RuleMutationResult['candidate'] }> {
  const changedBy = actor(principal);
  let rule: { id: string; revision: number } | null = null;
  let candidate: RuleMutationResult['candidate'] = null;
  switch (request.mutation) {
    case 'create': {
      if (plan.action === null) fail('OPERATION_CORRUPT');
      rule = await createRuleInTransaction(tx, request.companyId, changedBy, {
        id: plan.ruleId!,
        matchText: plan.condition.matchText,
        direction: plan.direction ?? fail('OPERATION_CORRUPT'),
        ...plan.action,
        priority: plan.priority,
        autoPost: false,
        originIntent: 'make_recurring',
        sourceCaseId: request.proposal.sourceCaseId ?? null,
        initialRevision: plan.proposedRevision,
      });
      break;
    }
    case 'update':
      rule = await updateRuleInTransaction(
        tx,
        request.companyId,
        request.ruleId!,
        request.expectedRevision,
        changedBy,
        request.proposal as UpdateRuleInput,
      );
      break;
    case 'review':
      rule = await reviewRuleInTransaction(
        tx,
        request.companyId,
        request.ruleId!,
        request.expectedRevision,
        changedBy,
        request.proposal as UpdateRuleInput,
        request.proposal.reviewReason ?? 'Reviewed and saved.',
      );
      break;
    case 'enable':
    case 'disable':
      rule = await setRuleEnabledInTransaction(
        tx,
        request.companyId,
        request.ruleId!,
        request.expectedRevision,
        request.mutation === 'enable',
        changedBy,
      );
      break;
    case 'activate_candidate': {
      const activated = await activateRuleCandidateInTransaction(
        tx,
        request.companyId,
        request.candidateId!,
        { id: principal.userId, label: changedBy.label },
        {
          ruleId: plan.ruleId!,
          priority: plan.priority,
          initialRevision: plan.proposedRevision,
          skipReconciliation: true,
        },
      );
      rule = activated.rule;
      candidate = {
        candidateId: request.candidateId!,
        state: 'activated',
        ruleId: activated.rule.id,
      };
      break;
    }
    case 'dismiss_candidate':
      await dismissRuleCandidateInTransaction(
        tx,
        request.companyId,
        request.candidateId!,
        { id: principal.userId, label: changedBy.label },
      );
      candidate = { candidateId: request.candidateId!, state: 'dismissed', ruleId: null };
      break;
  }
  return {
    rule: rule === null
      ? null
      : await readCanonicalRuleRevision(tx, request.companyId, rule.id, rule.revision),
    candidate,
  };
}

async function persistCandidateReconciliationBeforeCommit(
  db: PrismaClient,
  principal: RuleOperationPrincipal,
  loaded: McpRuleOperationRecord,
  idempotencyKey: string,
  checkedAt: Date,
): Promise<void> {
  const reconciliation = await db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, loaded.companyId);
    const runtime = await lockRuleRuntime(tx, loaded.companyId);
    await lockRuleAuthorizationRows(tx, principal, loaded.companyId);
    await tx.$queryRaw`SELECT "id" FROM "McpRuleOperation" WHERE "id" = ${loaded.id} FOR UPDATE`;
    const operation = await tx.mcpRuleOperation.findFirst({
      where: { id: loaded.id, ...operationOwner(principal) },
    }) as McpRuleOperationRecord | null;
    if (operation === null) fail('NOT_FOUND');
    if (!hasValidMcpRuleOperationIntegrity(operation)) fail('OPERATION_CORRUPT');
    if (operation.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT');
    if (operation.commitResult !== null) return { saturated: false };
    if (operation.expiresAt.getTime() <= checkedAt.getTime()) fail('OPERATION_EXPIRED');
    await assertCurrentRuleAuthorization(
      tx as unknown as RuleChangeAuthorizationStore,
      principal,
      operation.companyId,
      checkedAt,
    );
    assertCanonicalRuleRuntime(runtime);
    const request = requestFromOperation(operation);
    if (request.mutation !== 'activate_candidate') return { saturated: false };
    try {
      return await reconcileRuleCandidateActivationInTransaction(
        tx,
        request.companyId,
        request.candidateId!,
      );
    } catch (error) {
      if (error instanceof RuleCandidateError) {
        fail(error.code === 'CANDIDATE_NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT');
      }
      throw error;
    }
  }, { maxWait: 30_000, timeout: 30_000 });
  if (reconciliation.saturated) fail('CONFLICT');
}

export async function commitRuleChange(
  principal: RuleOperationPrincipal,
  input: CommitMcpRuleChangeInput,
  dependencies: McpRuleChangeDependencies = {},
): Promise<RuleMutationResult> {
  const db = dependencies.db ?? prisma;
  const now = dependencies.now ?? (() => new Date());
  const idempotencyKey = normalizeMcpOperationIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey === null) fail('INVALID_INPUT');
  const loaded = await loadOwnedRuleOperation(input.operationId, principal, { store: db });
  if (input.companyId !== undefined && input.companyId !== loaded.companyId) fail('NOT_FOUND');
  const checkedAt = now();
  if (Number.isNaN(checkedAt.getTime())) fail('INVALID_INPUT');
  await assertCurrentRuleAuthorization(
    db as unknown as RuleChangeAuthorizationStore,
    principal,
    loaded.companyId,
    checkedAt,
  );
  if (loaded.mutation === 'activate_candidate') {
    await persistCandidateReconciliationBeforeCommit(
      db,
      principal,
      loaded,
      idempotencyKey,
      checkedAt,
    );
  }
  return db.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, loaded.companyId);
    const runtime = await lockRuleRuntime(tx, loaded.companyId);
    await lockRuleAuthorizationRows(tx, principal, loaded.companyId);
    await tx.$queryRaw`SELECT "id" FROM "McpRuleOperation" WHERE "id" = ${loaded.id} FOR UPDATE`;
    const operation = await tx.mcpRuleOperation.findFirst({
      where: { id: loaded.id, ...operationOwner(principal) },
    }) as McpRuleOperationRecord | null;
    if (operation === null) fail('NOT_FOUND');
    if (!hasValidMcpRuleOperationIntegrity(operation)) fail('OPERATION_CORRUPT');
    if (operation.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT');
    if (operation.commitResult !== null) {
      const committed = parseRuleMutationResult(operation.commitResult);
      return parseRuleMutationResult({ ...committed, status: 'REPLAYED' });
    }
    if (operation.expiresAt.getTime() <= checkedAt.getTime()) fail('OPERATION_EXPIRED');
    await assertCurrentRuleAuthorization(
      tx as unknown as RuleChangeAuthorizationStore,
      principal,
      operation.companyId,
      checkedAt,
    );
    assertCanonicalRuleRuntime(runtime);
    const request = requestFromOperation(operation);
    const plan = await buildPlan(
      tx,
      principal,
      request,
      request.mutation === 'create' ? operation.resourceId : undefined,
    );
    plan.snapshot.companyId = request.companyId;
    plan.snapshot.mutation = request.mutation;
    if (
      operation.sourceRevision !== plan.currentRevision
      || operation.proposedRevision !== plan.proposedRevision
      || operation.resourceType !== plan.resourceType
      || operation.resourceId !== plan.resourceId
      || operation.proposedSnapshotHash !== hashOperationPayload(plan.snapshot)
    ) fail('CONFLICT');
    const changed = await executePlan(tx, principal, request, plan);
    const preview = previewFromOperation(operation);
    const result = parseRuleMutationResult({
      ok: true,
      operationId: operation.id,
      companyId: operation.companyId,
      mutation: operation.mutation,
      originIntent: plan.originIntent,
      status: 'COMMITTED',
      ruleId: changed.rule?.ruleId ?? null,
      revision: changed.rule?.revision ?? null,
      rule: changed.rule,
      candidate: changed.candidate,
      preview,
      error: null,
    });
    await tx.mcpRuleOperation.update({
      where: { id: operation.id },
      data: {
        committedAt: checkedAt,
        commitResult: result as unknown as Prisma.InputJsonValue,
        commitResultHash: hashOperationPayload(result),
      },
    });
    return result;
  }, { maxWait: 30_000, timeout: 30_000 });
}

export function prepareMcpRuleChange(
  principal: McpPrincipal,
  input: PrepareMcpRuleChangeInput,
  dependencies: McpRuleChangeDependencies = {},
): Promise<RuleMutationResult> {
  return prepareRuleChange({ ...principal, kind: 'mcp' }, input, dependencies);
}

export function commitMcpRuleChange(
  principal: McpPrincipal,
  input: CommitMcpRuleChangeInput,
  dependencies: McpRuleChangeDependencies = {},
): Promise<RuleMutationResult> {
  return commitRuleChange({ ...principal, kind: 'mcp' }, input, dependencies);
}
