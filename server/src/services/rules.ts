import { Prisma, type PrismaClient } from '@prisma/client';
import {
  isUsableTaxCodeDto,
  isUsableSalesTaxCodeDto,
  type ClassificationAction,
  type ClassificationConflict,
  type RuleMutationSample,
  type RuleDirection,
  type RuleMutationResult,
  type RuleDto,
  type RuleTestConflict,
  type RuleTestMatch,
  type RuleTestResult,
  type TaxCalculation,
  type TaxReadinessDto,
  type TxnStatus,
} from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { parseActionTagIds } from './classification/actionTagIds.js';
import { parseRuleRevision } from './classification/contracts.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { appendRuleRevision } from './ruleRevisionHistory.js';
import { compareRuleWinner, ruleMatches } from './ruleMatching.js';
import {
  getTaxReadinessInTransaction,
  type TaxReadinessQueryDb,
} from './tax/reference.js';

export type RuleRow = Prisma.RuleGetPayload<{
  include: { ruleTags: true; candidateOrigin: true };
}>;
export type RuleTransaction = Prisma.TransactionClient;
type RuleDb = PrismaClient | Prisma.TransactionClient;

export interface RuleActor {
  id: string | null;
  label: string;
}

export function toRuleDto(rule: RuleRow): RuleDto {
  return {
    id: rule.id,
    companyId: rule.companyId,
    priority: rule.priority,
    matchField: 'payee',
    matchText: rule.matchText,
    category: rule.category,
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation as RuleDto['taxCalculation'],
    taxCode: rule.taxCode,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map(({ tagId }) => tagId),
    autoPost: rule.autoPost,
    createdAt: rule.createdAt.toISOString(),
    reviewRequiredAt: rule.reviewRequiredAt?.toISOString() ?? null,
    reviewReason: rule.reviewReason,
    origin: rule.candidateOrigin
      ? {
          candidateId: rule.candidateOrigin.id,
          evidenceCount:
            rule.candidateOrigin.activationEvidenceCount
            ?? rule.candidateOrigin.evidenceCount,
          schemaVersion: rule.candidateOrigin.schemaVersion,
          configVersion: rule.candidateOrigin.configVersion,
        }
      : null,
  };
}

export async function resolveCategoryReference(
  db: RuleDb,
  companyId: string,
  categoryName: string,
  givenQboId?: string | null,
): Promise<string> {
  const account = await db.qboAccount.findFirst({
    where: givenQboId
      ? {
          companyId,
          qboId: givenQboId,
          active: true,
          classification: { in: ['Income', 'COGS', 'Expenses'] },
        }
      : {
          companyId,
          name: categoryName,
          active: true,
          classification: { in: ['Income', 'COGS', 'Expenses'] },
        },
    select: { qboId: true },
  });
  if (account === null) {
    throw new RuleServiceError('NOT_FOUND', 'Category reference was not found.');
  }
  return account.qboId;
}

export interface RuleActionInput {
  direction?: RuleDirection;
  categoryQboId: string;
  taxCalculation: TaxCalculation;
  taxCodeQboId: string | null;
  tagIds: string[];
}

export interface CreateRuleInput extends RuleActionInput {
  id?: string;
  matchText: string;
  priority: number;
  autoPost: boolean;
  originIntent: 'make_recurring' | 'auto_candidate' | null;
  sourceCaseId?: string | null;
  sourceCandidateId?: string | null;
  initialRevision?: number;
}

export interface UpdateRuleInput {
  direction?: RuleDirection;
  matchText?: string;
  categoryQboId?: string;
  taxCalculation?: TaxCalculation;
  taxCodeQboId?: string | null;
  tagIds?: string[];
  priority?: number;
  autoPost?: boolean;
}

export class RuleServiceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'STALE_REVISION',
    message: string,
  ) {
    super(message);
    this.name = 'RuleServiceError';
  }
}

function invalid(message: string): never {
  throw new RuleServiceError('INVALID_INPUT', message);
}

function safeText(value: string, limit: number, field: string): string {
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length === 0
    || normalized.length > limit
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) invalid(`${field} is invalid.`);
  return normalized;
}

function safePriority(value: number): number {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    invalid('Rule priority is invalid.');
  }
  return value;
}

function normalizeActionTagIds(value: unknown): string[] {
  const tagIds = parseActionTagIds(value);
  if (tagIds === null) invalid('Rule tag identifiers are invalid.');
  return [...tagIds].sort();
}

export async function validateSourceCase(
  tx: RuleDb,
  companyId: string,
  sourceCaseId: string | null | undefined,
): Promise<void> {
  if (sourceCaseId == null) return;
  const source = await tx.classificationCase.findFirst({
    where: {
      id: sourceCaseId,
      companyId,
      invalidation: null,
      qboMutationAttempt: { status: 'VERIFIED' },
    },
    select: { id: true },
  });
  if (source === null) {
    throw new RuleServiceError('NOT_FOUND', 'Rule source case was not found.');
  }
}

/** Request-local reference snapshot; never reused across reads or authority checks. */
export interface RuleActionReferenceSnapshot {
  holdingAccountIds: unknown;
  categories: ReadonlyMap<string, { name: string; classification: string }>;
  tagIds: ReadonlySet<string>;
  taxReadiness: TaxReadinessDto | null;
}

export async function loadRuleActionReferenceSnapshot(
  tx: RuleDb,
  companyId: string,
  holdingAccountIds: unknown,
  needsTax: boolean,
): Promise<RuleActionReferenceSnapshot> {
  const [categories, tags, taxReadiness] = await Promise.all([
    tx.qboAccount.findMany({
      where: { companyId, active: true, classification: { in: ['Income', 'COGS', 'Expenses'] } },
      select: { qboId: true, name: true, classification: true },
    }),
    tx.tag.findMany({ where: { companyId }, select: { id: true } }),
    needsTax ? getTaxReadinessInTransaction(companyId, tx as unknown as TaxReadinessQueryDb) : null,
  ]);
  return {
    holdingAccountIds,
    categories: new Map(categories.map((category) => [category.qboId, category])),
    tagIds: new Set(tags.map(({ id }) => id)),
    taxReadiness,
  };
}

export async function resolveRuleAction(
  tx: RuleDb,
  companyId: string,
  input: RuleActionInput,
  references?: RuleActionReferenceSnapshot,
): Promise<{
  action: ClassificationAction;
  direction: RuleDirection;
  categoryName: string;
  taxCodeName: string | null;
}> {
  const categoryQboId = safeText(input.categoryQboId, 120, 'Category');
  const tagIds = normalizeActionTagIds(input.tagIds);
  const [category, company] = references === undefined ? await Promise.all([
    tx.qboAccount.findFirst({
      where: {
        companyId,
        qboId: categoryQboId,
        active: true,
        classification: { in: ['Income', 'COGS', 'Expenses'] },
      },
      select: { name: true, classification: true },
    }),
    tx.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { holdingAccountIds: true },
    }),
  ]) : [references.categories.get(categoryQboId) ?? null, { holdingAccountIds: references.holdingAccountIds }];
  if (category === null) {
    throw new RuleServiceError('NOT_FOUND', 'Category reference was not found.');
  }
  const holdingAccountIds = Array.isArray(company.holdingAccountIds)
    ? company.holdingAccountIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (holdingAccountIds.includes(categoryQboId)) {
    throw new RuleServiceError('CONFLICT', 'Holding accounts cannot be used as rule categories.');
  }
  const inferredDirection: RuleDirection = category.classification === 'Income'
    ? 'Deposit'
    : 'Purchase';
  const direction = input.direction ?? inferredDirection;
  if (direction !== 'Purchase' && direction !== 'Deposit') {
    invalid('Rule direction is invalid.');
  }
  if (
    (direction === 'Purchase' && category.classification !== 'Expenses' && category.classification !== 'COGS')
    || (direction === 'Deposit' && category.classification !== 'Income')
  ) {
    throw new RuleServiceError('CONFLICT', 'Category reference is incompatible with the rule direction.');
  }
  const ownedTags = references === undefined ? await tx.tag.count({
    where: { companyId, id: { in: tagIds } },
  }) : tagIds.filter((id) => references.tagIds.has(id)).length;
  if (ownedTags !== tagIds.length) {
    throw new RuleServiceError('NOT_FOUND', 'Rule tag reference was not found.');
  }

  let taxCodeName: string | null = null;
  let taxCodeQboId: string | null = null;
  if (input.taxCalculation === 'NotApplicable') {
    if (input.taxCodeQboId !== null) invalid('NotApplicable rules cannot select a tax code.');
  } else if (
    input.taxCalculation === 'TaxInclusive'
    || input.taxCalculation === 'TaxExcluded'
  ) {
    taxCodeQboId = safeText(input.taxCodeQboId ?? '', 120, 'Tax code');
    const readiness = references === undefined
      ? await getTaxReadinessInTransaction(companyId, tx as unknown as TaxReadinessQueryDb)
      : references.taxReadiness;
    if (readiness === null) throw new RuleServiceError('CONFLICT', 'Tax reference is not ready.');
    const status = direction === 'Purchase' ? readiness.status : readiness.salesStatus;
    const codes = direction === 'Purchase' ? readiness.taxCodes : readiness.salesTaxCodes;
    const usable = direction === 'Purchase' ? isUsableTaxCodeDto : isUsableSalesTaxCodeDto;
    const taxCode = codes.find((row) =>
      row.qboId === taxCodeQboId
      && row.taxable === true
      && usable(row));
    if (status !== 'ready' || taxCode === undefined) {
      throw new RuleServiceError('CONFLICT', 'Tax reference is not ready.');
    }
    taxCodeName = taxCode.name;
  } else {
    invalid('Tax calculation is invalid.');
  }

  return {
    action: {
      categoryQboId,
      taxCalculation: input.taxCalculation,
      taxCodeQboId,
      tagIds,
    },
    direction,
    categoryName: category.name,
    taxCodeName,
  };
}

export async function loadCompanyRule(
  tx: RuleDb,
  companyId: string,
  ruleId: string,
  options: { includeRetired?: boolean } = {},
): Promise<RuleRow> {
  const rule = await tx.rule.findFirst({
    where: { id: ruleId, companyId },
    include: { ruleTags: true, candidateOrigin: true },
  });
  if (rule === null || (!options.includeRetired && rule.retiredAt !== null)) {
    throw new RuleServiceError('NOT_FOUND', 'Rule was not found.');
  }
  return rule;
}

function ruleActionInput(rule: RuleRow): RuleActionInput {
  if (
    rule.categoryQboId === null
    || (
      rule.taxCalculation !== 'TaxInclusive'
      && rule.taxCalculation !== 'TaxExcluded'
      && rule.taxCalculation !== 'NotApplicable'
    )
  ) invalid('Rule does not contain a canonical executable action.');
  return {
    ...(rule.direction !== null ? { direction: rule.direction } : {}),
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map(({ tagId }) => tagId),
  };
}

function patchedRuleActionInput(
  rule: RuleRow,
  patch: UpdateRuleInput,
): RuleActionInput {
  const categoryQboId = patch.categoryQboId ?? rule.categoryQboId;
  if (categoryQboId === null) invalid('Rule category requires reviewed repair.');
  const taxCalculation = patch.taxCalculation ?? rule.taxCalculation;
  if (
    taxCalculation !== 'TaxInclusive'
    && taxCalculation !== 'TaxExcluded'
    && taxCalculation !== 'NotApplicable'
  ) invalid('Rule tax calculation requires reviewed repair.');
  return {
    ...(patch.direction !== undefined
      ? { direction: patch.direction }
      : rule.direction !== null
        ? { direction: rule.direction }
        : {}),
    categoryQboId,
    taxCalculation,
    taxCodeQboId: patch.taxCodeQboId !== undefined ? patch.taxCodeQboId : rule.taxCodeQboId,
    tagIds: patch.tagIds ?? rule.ruleTags.map(({ tagId }) => tagId),
  };
}

export async function validateExistingRuleAction(
  tx: RuleDb,
  companyId: string,
  rule: RuleRow,
  references?: RuleActionReferenceSnapshot,
): ReturnType<typeof resolveRuleAction> {
  return resolveRuleAction(tx, companyId, ruleActionInput(rule), references);
}

export async function assertPriorityAvailable(
  tx: RuleDb,
  companyId: string,
  priority: number,
  excludingRuleId?: string,
): Promise<void> {
  const conflict = await tx.rule.findFirst({
    where: {
      companyId,
      enabled: true,
      retiredAt: null,
      priority,
      ...(excludingRuleId ? { id: { not: excludingRuleId } } : {}),
    },
    select: { id: true },
  });
  if (conflict !== null) {
    throw new RuleServiceError('CONFLICT', 'Rule priority conflicts with an active rule.');
  }
}

export async function nextRulePriorityInTransaction(
  tx: Pick<RuleTransaction, 'rule'>,
  companyId: string,
): Promise<number> {
  const aggregate = await tx.rule.aggregate({
    where: { companyId },
    _max: { priority: true },
  });
  const currentMax = aggregate._max.priority;
  if (currentMax === null) return 0;
  return safePriority(currentMax + 1);
}

export async function createRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  actor: RuleActor,
  input: CreateRuleInput,
): Promise<RuleRow> {
  const matchText = safeText(input.matchText, 200, 'Rule condition');
  const priority = safePriority(input.priority);
  const resolved = await resolveRuleAction(tx, companyId, input);
  await validateSourceCase(tx, companyId, input.sourceCaseId);
  if (input.originIntent === 'make_recurring' && input.autoPost) {
    invalid('Recurring rules must start with autoPost disabled.');
  }
  if (input.originIntent === 'auto_candidate' && input.autoPost) {
    invalid('Candidate rules must start with autoPost disabled.');
  }
  await assertPriorityAvailable(tx, companyId, priority);
  const revision = input.initialRevision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) invalid('Initial revision is invalid.');
  const created = await tx.rule.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      companyId,
      matchField: 'payee',
      matchText,
      category: resolved.categoryName,
      categoryQboId: resolved.action.categoryQboId,
      taxCalculation: resolved.action.taxCalculation,
      taxCode: resolved.taxCodeName,
      taxCodeQboId: resolved.action.taxCodeQboId,
      direction: resolved.direction,
      priority,
      autoPost: input.autoPost,
      canonicalVersion: 2,
      revision,
      originIntent: input.originIntent,
      sourceCaseId: input.sourceCaseId ?? null,
      sourceCandidateId: input.sourceCandidateId ?? null,
      createdById: actor.id,
      updatedById: actor.id,
      ruleTags: { create: resolved.action.tagIds.map((tagId) => ({ tagId })) },
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, created, actor.id);
  await auditRule(tx, actor, created, 'rule-created', 'Created');
  return created;
}

export async function updateRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  actor: RuleActor,
  patch: UpdateRuleInput,
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  const resolved = await resolveRuleAction(tx, companyId, patchedRuleActionInput(current, patch));
  const priority = patch.priority === undefined
    ? current.priority
    : safePriority(patch.priority);
  if (priority !== current.priority) {
    await assertPriorityAvailable(tx, companyId, priority, current.id);
  }
  if (current.autoPost === false && patch.autoPost === true) {
    if (
      !current.enabled
      || current.reviewRequiredAt !== null
      || current.repairReason !== null
      || current.retiredAt !== null
    ) {
      throw new RuleServiceError(
        'CONFLICT',
        'Auto-post cannot be enabled until the rule is reviewed and Enabled.',
      );
    }
    const keys = Object.keys(patch).filter((key) => key !== 'autoPost');
    if (keys.length > 0) invalid('autoPost elevation must be a standalone rule change.');
  }
  if (patch.matchText === undefined && Object.keys(patch).length === 0) {
    invalid('Rule update is empty.');
  }
  if (patch.tagIds !== undefined) {
    await tx.ruleTag.deleteMany({ where: { ruleId: current.id } });
    await tx.ruleTag.createMany({
      data: resolved.action.tagIds.map((tagId) => ({ ruleId: current.id, tagId })),
    });
  }
  let heldRevisionTagIds: Prisma.InputJsonValue | undefined;
  if (
    patch.tagIds === undefined
    && (current.reviewRequiredAt !== null || current.repairReason !== null)
  ) {
    const heldRevision = await tx.ruleRevision.findUnique({
      where: {
        companyId_ruleId_revision: {
          companyId,
          ruleId: current.id,
          revision: current.revision,
        },
      },
      select: { tagIds: true },
    });
    if (heldRevision === null) {
      throw new RuleServiceError(
        'CONFLICT',
        'Held rule tag provenance is unavailable; explicitly set rule tags before saving.',
      );
    }
    heldRevisionTagIds = heldRevision.tagIds as Prisma.InputJsonValue;
  }
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      ...(patch.matchText !== undefined
        ? { matchText: safeText(patch.matchText, 200, 'Rule condition') }
        : {}),
      category: resolved.categoryName,
      categoryQboId: resolved.action.categoryQboId,
      taxCalculation: resolved.action.taxCalculation,
      taxCode: resolved.taxCodeName,
      taxCodeQboId: resolved.action.taxCodeQboId,
      direction: resolved.direction,
      priority,
      ...(patch.autoPost !== undefined ? { autoPost: patch.autoPost } : {}),
      canonicalVersion: 2,
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(
    tx,
    updated,
    actor.id,
    heldRevisionTagIds === undefined ? {} : { tagIds: heldRevisionTagIds },
  );
  await auditRule(tx, actor, updated, 'rule-updated', 'Updated');
  return updated;
}

export async function setRuleEnabledInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  enabled: boolean,
  actor: RuleActor,
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  if (enabled) {
    if (
      current.direction === null
      || current.reviewRequiredAt !== null
      || current.repairReason !== null
    ) {
      throw new RuleServiceError('CONFLICT', 'Rule requires Review and save before it can be enabled.');
    }
    await validateExistingRuleAction(tx, companyId, current);
  }
  if (current.enabled === enabled) {
    throw new RuleServiceError('CONFLICT', 'Rule already has the requested state.');
  }
  if (enabled) await assertPriorityAvailable(tx, companyId, current.priority, current.id);
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      enabled,
      ...(!enabled ? { autoPost: false } : {}),
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(
    tx,
    actor,
    updated,
    enabled ? 'rule-enabled' : 'rule-disabled',
    enabled ? 'Enabled' : 'Disabled',
  );
  return updated;
}

export async function reviewRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  actor: RuleActor,
  patch: UpdateRuleInput = {},
  reason = 'Reviewed and saved.',
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId, { includeRetired: true });
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  if (patch.autoPost === true) invalid('Review and save cannot enable auto-post.');
  if (patch.priority !== undefined) invalid('Review and save cannot change rule priority.');
  const reviewedReason = safeText(reason, 500, 'Review reason');
  const currentRevision = await tx.ruleRevision.findUnique({
    where: {
      companyId_ruleId_revision: {
        companyId,
        ruleId: current.id,
        revision: current.revision,
      },
    },
    select: { tagIds: true },
  });
  const preservedTagIds = parseActionTagIds(currentRevision?.tagIds);
  const liveTagIds = new Set(current.ruleTags.map(({ tagId }) => tagId));
  const unavailableTagIds = (preservedTagIds ?? [])
    .filter((tagId) => !liveTagIds.has(tagId));
  if (
    patch.tagIds === undefined
    && (preservedTagIds === null || unavailableTagIds.length > 0)
  ) {
    throw new RuleServiceError(
      'CONFLICT',
      'Review and save must explicitly acknowledge unavailable rule tags.',
    );
  }
  const resolved = await resolveRuleAction(tx, companyId, patchedRuleActionInput(current, patch));
  if (patch.tagIds !== undefined) {
    await tx.ruleTag.deleteMany({ where: { ruleId: current.id } });
    await tx.ruleTag.createMany({
      data: resolved.action.tagIds.map((tagId) => ({ ruleId: current.id, tagId })),
    });
  }
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      enabled: false,
      autoPost: false,
      retiredAt: null,
      reviewRequiredAt: null,
      reviewReason: null,
      repairReason: null,
      direction: resolved.direction,
      canonicalVersion: 2,
      ...(patch.matchText !== undefined
        ? { matchText: safeText(patch.matchText, 200, 'Rule condition') }
        : {}),
      category: resolved.categoryName,
      categoryQboId: resolved.action.categoryQboId,
      taxCalculation: resolved.action.taxCalculation,
      taxCode: resolved.taxCodeName,
      taxCodeQboId: resolved.action.taxCodeQboId,
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(
    tx,
    actor,
    updated,
    'rule-reviewed',
    'Reviewed and kept Disabled',
    { reason: reviewedReason },
  );
  return updated;
}

export async function retireRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  actor: RuleActor,
  retiredAt = new Date(),
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      enabled: false,
      autoPost: false,
      retiredAt,
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(tx, actor, updated, 'rule-retired', 'Retired');
  return updated;
}

export async function reorderRulesInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ids: string[],
  expectedRevision: number,
  actor: RuleActor,
): Promise<RuleRow[]> {
  if (ids.length === 0 || new Set(ids).size !== ids.length) invalid('Rule order is invalid.');
  const existing = await tx.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
  });
  const existingIds = new Set(existing.map(({ id }) => id));
  if (existingIds.size !== ids.length || ids.some((id) => !existingIds.has(id))) {
    throw new RuleServiceError('CONFLICT', 'Order must contain the exact active rule set.');
  }
  if (Math.max(...existing.map(({ revision }) => revision)) !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule order revision changed.');
  }
  for (const [priority, id] of ids.entries()) {
    const current = existing.find((row) => row.id === id)!;
    if (current.priority === priority) continue;
    const updated = await tx.rule.update({
      where: { id },
      data: { priority, revision: { increment: 1 }, updatedById: actor.id },
      include: { ruleTags: true, candidateOrigin: true },
    });
    await appendRuleRevision(tx, updated, actor.id);
    await auditRule(tx, actor, updated, 'rule-reordered', `Priority ${priority}`);
  }
  return tx.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

async function auditRule(
  tx: RuleTransaction,
  actor: RuleActor,
  rule: RuleRow,
  action: string,
  after: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      companyId: rule.companyId,
      actorId: actor.id,
      actorLabel: actor.label,
      payee: rule.matchText,
      amount: 0,
      action,
      before: 'Rule',
      after,
      payload: { ruleId: rule.id, revision: rule.revision, ...payload },
    },
  });
}

export async function readCanonicalRuleRevision(
  tx: RuleDb,
  companyId: string,
  ruleId: string,
  revision?: number,
): Promise<NonNullable<RuleMutationResult['rule']>> {
  const row = await tx.ruleRevision.findFirst({
    where: { companyId, ruleId, ...(revision === undefined ? {} : { revision }) },
    orderBy: { revision: 'desc' },
  });
  if (row === null) throw new RuleServiceError('NOT_FOUND', 'Rule revision was not found.');
  const tagIds = parseActionTagIds(row.tagIds);
  const action = (
    row.categoryQboId !== null
    && tagIds !== null
    && (
      row.taxCalculation === 'TaxInclusive'
      || row.taxCalculation === 'TaxExcluded'
      || row.taxCalculation === 'NotApplicable'
    )
    && ((row.taxCalculation === 'NotApplicable') === (row.taxCodeQboId === null))
  ) ? {
      categoryQboId: row.categoryQboId,
      taxCalculation: row.taxCalculation,
      taxCodeQboId: row.taxCodeQboId,
      tagIds: tagIds.sort(),
    } : null;
  const historical = parseRuleRevision({
    id: row.id,
    ruleId: row.ruleId,
    companyId: row.companyId,
    revision: row.revision,
    state: row.state,
    condition: { matchField: 'payee', matchText: row.matchText },
    direction: row.direction,
    action,
    categoryName: row.category,
    taxCodeName: row.taxCode,
    priority: row.priority,
    autoPost: row.autoPost,
    originIntent: row.originIntent,
    sourceCaseId: row.sourceCaseId,
    sourceCandidateId: row.sourceCandidateId,
    changedBy: row.changedBy,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
    canonicalVersion: row.canonicalVersion,
    repairReason: row.repairReason,
    affectedJournalEntryCount: row.affectedJournalEntryCount,
  });
  const { categoryName, priority: _priority, retiredAt, canonicalVersion: _canonicalVersion,
    action: historicalAction, state, ...snapshot } = historical;
  const direction = historical.direction;
  return {
    ...snapshot,
    state: state === 'enabled' && retiredAt === null ? 'enabled' : 'disabled',
    action: historicalAction === null || direction === null ? null : {
      version: 2,
      direction,
      category: categoryName,
      categoryQboId: historicalAction.categoryQboId,
      taxCalculation: historicalAction.taxCalculation,
      taxCodeQboId: historicalAction.taxCodeQboId,
      tagIds: historicalAction.tagIds,
    },
  };
}

/** Preview a complete direction-scoped rule without changing execution state. */
export async function testRuleCondition(
  db: RuleDb,
  companyId: string,
  matchText: string,
  options: { direction: RuleDirection | null; excludeRuleId?: string },
): Promise<{
  samples: RuleMutationSample[];
  pendingCount: number;
  processedCount: number;
  conflicts: ClassificationConflict[];
  legacy: RuleTestResult;
}> {
  const needle = safeText(matchText, 200, 'Rule condition');
  const direction = options.direction;
  if (direction === null) {
    return {
      samples: [], pendingCount: 0, processedCount: 0, conflicts: [],
      legacy: { matches: [], pendingCount: 0, processedCount: 0, conflicts: [] },
    };
  }
  const [transactions, existingRules, counts] = await Promise.all([
    db.$queryRaw<Array<{
      id: string;
      qboType: string;
      payee: string;
      date: Date;
      amount: Prisma.Decimal;
      status: 'PENDING' | 'POSTED' | 'DRY_RUN';
    }>>(Prisma.sql`
      SELECT txn."id", txn."qboType", txn."payee",
        txn."date", txn."amount", txn."status"
      FROM "Transaction" txn
      WHERE txn."companyId" = ${companyId}
        AND txn."qboType" = ${direction}
        AND txn."status" IN ('PENDING', 'POSTED', 'DRY_RUN')
        AND position(rule_match_key(${needle}) IN rule_match_key(txn."payee")) > 0
      ORDER BY txn."date" DESC, txn."id" DESC
      LIMIT 200
    `),
    db.rule.findMany({
      where: {
        companyId,
        enabled: true,
        retiredAt: null,
        direction,
        ...(options.excludeRuleId ? { id: { not: options.excludeRuleId } } : {}),
      },
      include: { ruleTags: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
    db.$queryRaw<Array<{ pendingCount: number; processedCount: number }>>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE txn."status" = 'PENDING')::int AS "pendingCount",
        COUNT(*) FILTER (WHERE txn."status" IN ('POSTED', 'DRY_RUN'))::int AS "processedCount"
      FROM "Transaction" txn
      WHERE txn."companyId" = ${companyId}
        AND txn."qboType" = ${direction}
        AND txn."status" IN ('PENDING', 'POSTED', 'DRY_RUN')
        AND position(rule_match_key(${needle}) IN rule_match_key(txn."payee")) > 0
    `),
  ]);
  const matched = transactions;
  const legacyMatches: RuleTestMatch[] = matched.map((transaction) => {
    const existingWinner = existingRules
      .filter((rule) => ruleMatches(
        { matchText: rule.matchText, direction: rule.direction },
        { description: transaction.payee, type: transaction.qboType },
      ))
      .sort(compareRuleWinner)[0];
    return {
      txnId: transaction.id,
      payee: transaction.payee,
      date: transaction.date.toISOString(),
      amount: Number(transaction.amount),
      status: transaction.status as TxnStatus,
      wouldWin: existingWinner === undefined,
      currentWinner: existingWinner?.matchText ?? null,
    };
  });
  const overlaps = existingRules.filter((rule) => matched.some((transaction) => ruleMatches(
    { matchText: rule.matchText, direction: rule.direction },
    { description: transaction.payee, type: transaction.qboType },
  )));
  const legacyConflicts: RuleTestConflict[] = overlaps.map((rule) => ({
    ruleId: rule.id,
    matchText: rule.matchText,
    category: rule.category,
    priority: rule.priority,
  }));
  const conflicts: ClassificationConflict[] = overlaps.slice(0, 20).map((rule) => {
    const action: ClassificationAction | null = rule.categoryQboId !== null
      && (
        rule.taxCalculation === 'TaxInclusive'
        || rule.taxCalculation === 'TaxExcluded'
        || rule.taxCalculation === 'NotApplicable'
      )
      && parseActionTagIds(rule.ruleTags.map(({ tagId }) => tagId)) !== null
      ? {
          categoryQboId: rule.categoryQboId,
          taxCalculation: rule.taxCalculation,
          taxCodeQboId: rule.taxCodeQboId,
          tagIds: rule.ruleTags.map(({ tagId }) => tagId).sort(),
        }
      : null;
    return {
      id: `rule:${rule.id}`,
      companyId,
      sourceId: rule.id,
      kind: 'rule',
      reason: 'An active rule overlaps a matching transaction.',
      action,
      actionSummary: action === null ? null : {
        categoryName: rule.category,
        taxCalculation: action.taxCalculation,
        taxCodeName: rule.taxCode,
        tagNames: [],
      },
      evidenceCount: 0,
    };
  });
  const samples: RuleMutationSample[] = matched.slice(0, 20).map((transaction) => ({
    transactionId: transaction.id,
    payee: transaction.payee,
    date: transaction.date.toISOString(),
    amountCents: Math.round(Number(transaction.amount) * 100),
    status: transaction.status,
  }));
  const pendingCount = counts[0]?.pendingCount ?? 0;
  const processedCount = counts[0]?.processedCount ?? 0;
  return {
    samples,
    pendingCount,
    processedCount,
    conflicts,
    legacy: {
      matches: legacyMatches,
      pendingCount,
      processedCount,
      conflicts: legacyConflicts,
    },
  };
}

export async function listRules(companyId: string, db: RuleDb = prisma): Promise<RuleRow[]> {
  return db.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createRule(
  companyId: string,
  actor: RuleActor,
  input: Omit<CreateRuleInput, 'priority' | 'initialRevision'>,
  db: PrismaClient = prisma,
): Promise<RuleRow> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    const priority = await nextRulePriorityInTransaction(tx, companyId);
    return createRuleInTransaction(tx, companyId, actor, {
      ...input,
      priority,
      initialRevision: 0,
    });
  });
}

export function testRule(
  companyId: string,
  matchText: string,
  direction: RuleDirection,
  db: RuleDb = prisma,
): Promise<RuleTestResult> {
  return testRuleCondition(db, companyId, matchText, { direction })
    .then(({ legacy }) => legacy);
}

export async function updateRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
  patch: UpdateRuleInput,
  db: PrismaClient = prisma,
): Promise<RuleRow> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await loadCompanyRule(tx, companyId, ruleId);
    return updateRuleInTransaction(tx, companyId, ruleId, current.revision, actor, patch);
  });
}

export async function reorderRules(
  companyId: string,
  ids: string[],
  actor: RuleActor,
  db: PrismaClient = prisma,
): Promise<RuleRow[]> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await tx.rule.findMany({
      where: { companyId, enabled: true, retiredAt: null },
      select: { revision: true },
    });
    return reorderRulesInTransaction(
      tx,
      companyId,
      ids,
      Math.max(...current.map(({ revision }) => revision)),
      actor,
    );
  });
}

export async function retireRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
  db: PrismaClient = prisma,
): Promise<void> {
  await runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await loadCompanyRule(tx, companyId, ruleId);
    await retireRuleInTransaction(tx, companyId, ruleId, current.revision, actor);
  });
}
