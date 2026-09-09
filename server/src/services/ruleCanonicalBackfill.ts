import type { RuleDirection, RuleRuntimeMode, TaxCalculation } from '@recat/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runRuleCutoverTransaction } from './ruleCutoverTransaction.js';
import { normalizeRuleMatchText } from './ruleMatching.js';
import { getTaxReadinessInTransaction, type TaxReadinessQueryDb } from './tax/reference.js';

export const CANONICAL_RULE_VERSION = 2;

export interface LegacyRulePlanningInput {
  id: string;
  priority: number;
  createdAt: Date;
  enabled: boolean;
  autoPost: boolean;
  retiredAt: Date | null;
  reviewRequiredAt: Date | null;
  matchText: string;
  category: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCode: string | null;
  taxCodeQboId: string | null;
  account: {
    qboId: string;
    name: string;
    active: boolean;
    classification: string;
    holding: boolean;
  } | null;
  taxCodeReference: {
    qboId: string;
    name: string;
    active: boolean;
    usablePurchase: boolean;
    usableSales: boolean;
  } | null;
  tagIds: string[];
  validTagIds: string[];
  journalEntryCount: number;
}

export interface CanonicalRulePlan {
  priority: number;
  matchText: string;
  direction: RuleDirection | null;
  enabled: boolean;
  autoPost: boolean;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  repairReason: string | null;
  affectedJournalEntryCount: number;
}

function inferredDirection(input: LegacyRulePlanningInput): RuleDirection | null {
  if (input.retiredAt !== null) return null;
  if (input.account === null || !input.account.active || input.account.holding) return null;
  if (input.account.qboId !== input.categoryQboId) return null;
  if (input.account.classification === 'Expenses' || input.account.classification === 'COGS') {
    return 'Purchase';
  }
  if (input.account.classification === 'Income') return 'Deposit';
  return null;
}

function categoryIsValid(input: LegacyRulePlanningInput): boolean {
  return input.account !== null
    && input.account.active
    && !input.account.holding
    && input.account.qboId === input.categoryQboId
    && input.account.name === input.category
    && (
      input.account.classification === 'Expenses'
      || input.account.classification === 'COGS'
      || input.account.classification === 'Income'
    );
}

function validTaxCalculation(value: string | null): value is TaxCalculation {
  return value === 'NotApplicable' || value === 'TaxInclusive' || value === 'TaxExcluded';
}

function taxIsValid(input: LegacyRulePlanningInput, direction: RuleDirection | null): boolean {
  if (!validTaxCalculation(input.taxCalculation)) return false;
  if (input.taxCalculation === 'NotApplicable') {
    return input.taxCodeQboId === null && input.taxCode === null;
  }
  if (direction === null || input.taxCodeQboId === null || input.taxCodeReference === null) return false;
  if (
    !input.taxCodeReference.active
    || input.taxCodeReference.qboId !== input.taxCodeQboId
    || input.taxCodeReference.name !== input.taxCode
  ) return false;
  return direction === 'Purchase'
    ? input.taxCodeReference.usablePurchase
    : input.taxCodeReference.usableSales;
}

function tagsAreValid(input: LegacyRulePlanningInput): boolean {
  const actual = [...new Set(input.tagIds)].sort();
  const valid = [...new Set(input.validTagIds)].sort();
  return actual.length === input.tagIds.length
    && actual.length === valid.length
    && actual.every((tagId, index) => tagId === valid[index]);
}

function boundedReason(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  return reasons.join(' ').slice(0, 500);
}

export function planCanonicalRule(
  input: LegacyRulePlanningInput,
  priority: number,
): CanonicalRulePlan {
  const matchText = normalizeRuleMatchText(input.matchText);
  const direction = inferredDirection(input);
  const reasons: string[] = [];
  if (input.retiredAt !== null) {
    reasons.push('Retired rule requires reviewed reactivation.');
  } else if (direction === null) {
    reasons.push('Rule direction could not be inferred from a valid category.');
  }
  if (
    !categoryIsValid(input)
  ) reasons.push('Category reference is missing, inactive, holding, or incompatible.');
  if (matchText.length === 0) reasons.push('Rule match text is empty after canonical normalization.');
  if (!taxIsValid(input, direction)) reasons.push('Tax action is invalid for the inferred direction.');
  if (!tagsAreValid(input)) reasons.push('Rule tag reference is missing or invalid.');
  if (input.reviewRequiredAt !== null) reasons.push('Rule requires explicit review.');
  if (input.journalEntryCount > 0) {
    reasons.push(`Rule matches ${input.journalEntryCount} unsupported Journal Entry transaction(s).`);
  }
  const repairReason = boundedReason(reasons);
  const enabled = input.enabled && repairReason === null;
  return {
    priority,
    matchText,
    direction,
    enabled,
    autoPost: enabled ? input.autoPost : false,
    taxCalculation: input.taxCalculation,
    taxCodeQboId: input.taxCodeQboId,
    repairReason,
    affectedJournalEntryCount: input.journalEntryCount,
  };
}

export function rankLegacyRules<T extends Pick<LegacyRulePlanningInput, 'id' | 'priority' | 'createdAt'>>(
  rules: readonly T[],
): Array<{ rule: T; priority: number }> {
  return [...rules]
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const createdAt = right.createdAt.getTime() - left.createdAt.getTime();
      if (createdAt !== 0) return createdAt;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    })
    .map((rule, priority) => ({ rule, priority }));
}

export interface CanonicalBackfillReport {
  runtimeModeBefore: RuleRuntimeMode;
  runtimeModeAfter: RuleRuntimeMode;
  activated: boolean;
  companyId: string;
  applied: boolean;
  canonicalVersion: number;
  examinedRules: number;
  wouldMigrateRules: number;
  migratedRules: number;
  alreadyMigratedRules: number;
  disabledRules: number;
  journalEntryHeldRules: number;
  wouldClearRuleSuggestions: number;
  clearedRuleSuggestions: number;
  wouldAppendRevisions: number;
  appendedRevisions: number;
  wouldCreateMarkers: number;
  createdMarkers: number;
  proposals: CanonicalBackfillProposal[];
}

export interface CanonicalBackfillProposal {
  ruleId: string;
  sourceRevision: number;
  canonicalRevision: number;
  priority: number;
  direction: RuleDirection | null;
  enabled: boolean;
  autoPost: boolean;
  repairReason: string | null;
}

export interface CanonicalBackfillInput {
  /** Explicit operator opt-in: validate, backfill, and activate in the same fenced transaction. */
  activate?: boolean;
  companyId: string;
  apply: boolean;
  actor: string;
}

type BackfillDb = PrismaClient;

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error(`${label} must be a nonblank value of at most 128 characters.`);
  }
  return normalized;
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

type CanonicalRuleWithHistory = Prisma.RuleGetPayload<{
  include: { ruleTags: true; canonicalMigrations: true; revisions: true };
}>;

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function liveRuleMatchesRevision(
  rule: CanonicalRuleWithHistory,
  revision: CanonicalRuleWithHistory['revisions'][number],
): boolean {
  const liveTags = rule.ruleTags.map(({ tagId }) => tagId).sort();
  const revisionTags = stringArray(revision.tagIds).sort();
  return revision.ruleId === rule.id
    && revision.companyId === rule.companyId
    && revision.revision === rule.revision
    && revision.state === (rule.enabled ? 'enabled' : 'disabled')
    && revision.matchField === rule.matchField
    && revision.matchText === rule.matchText
    && revision.category === rule.category
    && revision.categoryQboId === rule.categoryQboId
    && revision.taxCalculation === rule.taxCalculation
    && revision.taxCode === rule.taxCode
    && revision.taxCodeQboId === rule.taxCodeQboId
    && revision.priority === rule.priority
    && revision.autoPost === rule.autoPost
    && revision.direction === rule.direction
    && revision.canonicalVersion === rule.canonicalVersion
    && revision.repairReason === rule.repairReason
    && revision.affectedJournalEntryCount === rule.affectedJournalEntryCount
    && revision.originIntent === rule.originIntent
    && revision.sourceCaseId === rule.sourceCaseId
    && revision.sourceCandidateId === rule.sourceCandidateId
    && sameDate(revision.retiredAt, rule.retiredAt)
    && liveTags.length === revisionTags.length
    && liveTags.every((tagId, index) => tagId === revisionTags[index]);
}

async function pendingRuleSuggestionCount(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::integer AS "count"
      FROM "Transaction"
     WHERE "companyId" = ${companyId}
       AND "status" = 'PENDING'
       AND jsonb_typeof("suggestion") = 'object'
       AND "suggestion"->>'source' = 'rule'
  `;
  return rows[0]?.count ?? 0;
}

async function clearPendingRuleSuggestions(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "Transaction"
       SET "suggestion" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "companyId" = ${companyId}
       AND "status" = 'PENDING'
       AND jsonb_typeof("suggestion") = 'object'
       AND "suggestion"->>'source' = 'rule'
  `;
}

export async function assertNoActiveRuleOperations(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ ruleOperations: number; autoPosts: number }>>`
    SELECT
      (SELECT count(*)::integer
         FROM "McpRuleOperation"
        WHERE "companyId" = ${companyId}
          AND "committedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP) AS "ruleOperations",
      (SELECT count(*)::integer
         FROM "RuleAutoPostPreparation"
        WHERE "companyId" = ${companyId}
          AND "state" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE')) AS "autoPosts"
  `;
  if ((rows[0]?.ruleOperations ?? 0) > 0 || (rows[0]?.autoPosts ?? 0) > 0) {
    throw new Error('Rule cutover requires all prepared rule operations and auto-posts to be drained.');
  }
}

export async function backfillCanonicalRules(
  input: CanonicalBackfillInput,
  db: BackfillDb = prisma,
): Promise<CanonicalBackfillReport> {
  const companyId = requiredIdentifier(input.companyId, 'companyId');
  const actor = requiredIdentifier(input.actor, 'actor');
  return runRuleCutoverTransaction(db, companyId, async (tx) => {
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { ruleRuntimeMode: true, holdingAccountIds: true },
    });
    if (company === null) throw new Error('Company was not found.');
    if (!input.activate && company.ruleRuntimeMode !== 'paused') {
      throw new Error('Canonical rule backfill requires ruleRuntimeMode=paused.');
    }
    await assertNoActiveRuleOperations(tx, companyId);
    if (input.activate) {
      const active = await tx.transaction.count({ where: { companyId, OR: [
        { status: 'POSTING' },
        { qboMutationAttempts: { some: { status: { in: ['PREPARED', 'COMMITTING', 'UNCERTAIN'] } } } },
      ] } });
      if (active > 0) throw new Error('Canonical activation requires in-flight writes to be resolved.');
    }
    const finish = async (
      report: Omit<CanonicalBackfillReport, 'runtimeModeBefore' | 'runtimeModeAfter' | 'activated'>,
    ): Promise<CanonicalBackfillReport> => {
      const activated = Boolean(input.activate && input.apply && company.ruleRuntimeMode !== 'canonical');
      if (activated) {
        const updated = await tx.company.updateMany({
          where: { id: companyId, ruleRuntimeMode: company.ruleRuntimeMode },
          data: { ruleRuntimeMode: 'canonical' },
        });
        if (updated.count !== 1) throw new Error('Canonical activation lost its company mode binding.');
      }
      return { ...report, runtimeModeBefore: company.ruleRuntimeMode,
        runtimeModeAfter: activated ? 'canonical' : company.ruleRuntimeMode, activated };
    };

    const rules = await tx.rule.findMany({
      where: { companyId },
      include: {
        ruleTags: true,
        canonicalMigrations: { where: { canonicalVersion: CANONICAL_RULE_VERSION } },
        revisions: { where: { canonicalVersion: CANONICAL_RULE_VERSION } },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    const marked = rules.filter((rule) => rule.canonicalMigrations.length === 1);
    if (marked.length !== 0 && marked.length !== rules.length) {
      throw new Error('Canonical rule backfill found a partially migrated company.');
    }
    if (rules.some((rule) => rule.canonicalMigrations.length > 1)) {
      throw new Error('Canonical rule backfill marker state is invalid.');
    }
    if (marked.length === rules.length && rules.length > 0) {
      for (const rule of rules) {
        const marker = rule.canonicalMigrations[0]!;
        if (rule.canonicalVersion !== CANONICAL_RULE_VERSION || rule.revision < marker.canonicalRevision) {
          throw new Error('Canonical rule backfill marker does not match the live rule pointer.');
        }
        const markerRevision = rule.revisions.find(
          (revision) => revision.revision === marker.canonicalRevision,
        );
        const liveRevision = rule.revisions.find(
          (revision) => revision.revision === rule.revision,
        );
        if (markerRevision === undefined || liveRevision === undefined || !liveRuleMatchesRevision(rule, liveRevision)) {
          throw new Error('Canonical rule backfill history does not match the live rule pointer.');
        }
      }
    }
    if (marked.length === 0 && rules.some((rule) => rule.canonicalVersion !== null)) {
      throw new Error('Canonical rule backfill found an unmarked canonical rule.');
    }

    const suggestionCount = await pendingRuleSuggestionCount(tx, companyId);
    if (marked.length === rules.length && rules.length > 0) {
      const cleared = input.apply
        ? await clearPendingRuleSuggestions(tx, companyId)
        : 0;
      return finish({
        companyId, applied: input.apply, canonicalVersion: CANONICAL_RULE_VERSION,
        examinedRules: rules.length, wouldMigrateRules: 0, migratedRules: 0,
        alreadyMigratedRules: rules.length, disabledRules: rules.filter((rule) => !rule.enabled).length,
        journalEntryHeldRules: rules.filter((rule) => (rule.affectedJournalEntryCount ?? 0) > 0).length,
        wouldClearRuleSuggestions: suggestionCount, clearedRuleSuggestions: cleared,
        wouldAppendRevisions: 0, appendedRevisions: 0,
        wouldCreateMarkers: 0, createdMarkers: 0,
        proposals: [],
      });
    }

    const [accounts, taxReadiness, tags, journalCounts] = await Promise.all([
      tx.qboAccount.findMany({ where: { companyId } }),
      getTaxReadinessInTransaction(companyId, tx as unknown as TaxReadinessQueryDb),
      tx.tag.findMany({ where: { companyId }, select: { id: true } }),
      tx.$queryRaw<Array<{ ruleId: string; count: number }>>`
        SELECT rule."id" AS "ruleId", count(transaction."id")::integer AS "count"
          FROM "Rule" rule
          LEFT JOIN "Transaction" transaction
            ON transaction."companyId" = rule."companyId"
           AND transaction."qboType" = 'JournalEntry'
           AND rule_match_key(rule."matchText") <> ''
           AND position(rule_match_key(rule."matchText") IN rule_match_key(transaction."payee")) > 0
         WHERE rule."companyId" = ${companyId}
         GROUP BY rule."id"
      `,
    ]);
    const accountByQboId = new Map(accounts.map((account) => [account.qboId, account]));
    const purchaseTaxIds = new Set(
      taxReadiness.status === 'ready' ? taxReadiness.taxCodes.map((taxCode) => taxCode.qboId) : [],
    );
    const salesTaxIds = new Set(
      taxReadiness.salesStatus === 'ready'
        ? taxReadiness.salesTaxCodes.map((taxCode) => taxCode.qboId)
        : [],
    );
    const taxCodeNameByQboId = new Map([
      ...(taxReadiness.status === 'ready' ? taxReadiness.taxCodes : []),
      ...(taxReadiness.salesStatus === 'ready' ? taxReadiness.salesTaxCodes : []),
    ].map((taxCode) => [taxCode.qboId, taxCode.name]));
    const validTagIds = new Set(tags.map(({ id }) => id));
    const journalCountByRule = new Map(journalCounts.map((row) => [row.ruleId, row.count]));
    const holdingAccountIds = new Set(stringArray(company.holdingAccountIds));
    const ranked = rankLegacyRules(rules);
    const plans = ranked.map(({ rule, priority }) => {
      const account = rule.categoryQboId === null ? null : accountByQboId.get(rule.categoryQboId) ?? null;
      const taxCode = rule.taxCodeQboId === null
        ? null
        : {
            qboId: rule.taxCodeQboId,
            active: purchaseTaxIds.has(rule.taxCodeQboId) || salesTaxIds.has(rule.taxCodeQboId),
            usablePurchase: purchaseTaxIds.has(rule.taxCodeQboId),
            usableSales: salesTaxIds.has(rule.taxCodeQboId),
          };
      const tagIds = rule.ruleTags.map(({ tagId }) => tagId).sort();
      return {
        rule,
        plan: planCanonicalRule({
          id: rule.id,
          priority: rule.priority,
          createdAt: rule.createdAt,
          enabled: rule.enabled,
          autoPost: rule.autoPost,
          retiredAt: rule.retiredAt,
          reviewRequiredAt: rule.reviewRequiredAt,
          matchText: rule.matchText,
          category: rule.category,
          categoryQboId: rule.categoryQboId,
          taxCalculation: rule.taxCalculation,
          taxCode: rule.taxCode,
          taxCodeQboId: rule.taxCodeQboId,
          account: account === null ? null : {
            qboId: account.qboId,
            name: account.name,
            active: account.active,
            classification: account.classification,
            holding: holdingAccountIds.has(account.qboId),
          },
          taxCodeReference: taxCode === null ? null : {
            ...taxCode,
            name: taxCodeNameByQboId.get(taxCode.qboId) ?? '',
          },
          tagIds,
          validTagIds: tagIds.filter((tagId) => validTagIds.has(tagId)),
          journalEntryCount: journalCountByRule.get(rule.id) ?? 0,
        }, priority),
      };
    });
    const proposals = plans.map(({ rule, plan }) => ({
      ruleId: rule.id,
      sourceRevision: rule.revision,
      canonicalRevision: rule.revision + 1,
      priority: plan.priority,
      direction: plan.direction,
      enabled: plan.enabled,
      autoPost: plan.autoPost,
      repairReason: plan.repairReason,
    }));

    if (input.apply) {
      for (const { rule, plan } of plans) {
        const canonicalRevision = rule.revision + 1;
        await tx.ruleRevision.create({ data: {
          ruleId: rule.id,
          companyId,
          revision: canonicalRevision,
          state: plan.enabled ? 'enabled' : 'disabled',
          matchField: 'payee',
          matchText: plan.matchText,
          category: rule.category,
          categoryQboId: rule.categoryQboId,
          taxCalculation: plan.taxCalculation,
          taxCode: rule.taxCode,
          taxCodeQboId: plan.taxCodeQboId,
          tagIds: rule.ruleTags.map(({ tagId }) => tagId).sort(),
          priority: plan.priority,
          autoPost: plan.autoPost,
          direction: plan.direction,
          canonicalVersion: CANONICAL_RULE_VERSION,
          repairReason: plan.repairReason,
          affectedJournalEntryCount: plan.affectedJournalEntryCount,
          originIntent: rule.originIntent,
          sourceCaseId: rule.sourceCaseId,
          sourceCandidateId: rule.sourceCandidateId,
          changedBy: actor,
          retiredAt: rule.retiredAt,
        } });
        await tx.ruleCanonicalMigration.create({ data: {
          companyId,
          ruleId: rule.id,
          canonicalVersion: CANONICAL_RULE_VERSION,
          sourceRevision: rule.revision,
          canonicalRevision,
        } });
        const updated = await tx.rule.updateMany({
          where: { id: rule.id, companyId, revision: rule.revision, canonicalVersion: null },
          data: {
            priority: plan.priority,
            matchText: plan.matchText,
            enabled: plan.enabled,
            autoPost: plan.autoPost,
            direction: plan.direction,
            canonicalVersion: CANONICAL_RULE_VERSION,
            repairReason: plan.repairReason,
            affectedJournalEntryCount: plan.affectedJournalEntryCount,
            taxCalculation: plan.taxCalculation,
            taxCode: rule.taxCode,
            taxCodeQboId: plan.taxCodeQboId,
            revision: canonicalRevision,
            updatedById: actor,
          },
        });
        if (updated.count !== 1) throw new Error(`Canonical rule CAS failed for ${rule.id}.`);
      }
    }
    const cleared = input.apply ? await clearPendingRuleSuggestions(tx, companyId) : 0;
    return finish({
      companyId,
      applied: input.apply,
      canonicalVersion: CANONICAL_RULE_VERSION,
      examinedRules: rules.length,
      wouldMigrateRules: plans.length,
      migratedRules: input.apply ? plans.length : 0,
      alreadyMigratedRules: 0,
      disabledRules: plans.filter(({ plan }) => !plan.enabled).length,
      journalEntryHeldRules: plans.filter(({ plan }) => plan.affectedJournalEntryCount > 0).length,
      wouldClearRuleSuggestions: suggestionCount,
      clearedRuleSuggestions: cleared,
      wouldAppendRevisions: plans.length,
      appendedRevisions: input.apply ? plans.length : 0,
      wouldCreateMarkers: plans.length,
      createdMarkers: input.apply ? plans.length : 0,
      proposals,
    });
  });
}
