import { Prisma } from '@prisma/client';

export type RuleWithTags = Prisma.RuleGetPayload<{ include: { ruleTags: true } }>;

export interface RuleRevisionDb {
  ruleRevision: {
    create(args: { data: Prisma.RuleRevisionUncheckedCreateInput }): Promise<unknown>;
  };
}

export function ruleRevisionSnapshot(
  rule: RuleWithTags,
  changedBy: string | null,
): Prisma.RuleRevisionUncheckedCreateInput {
  const state = rule.retiredAt !== null
    ? 'retired'
    : rule.enabled
      ? 'enabled'
      : 'disabled';
  return {
    ruleId: rule.id,
    companyId: rule.companyId,
    revision: rule.revision,
    state,
    matchField: rule.matchField,
    matchText: rule.matchText,
    category: rule.category,
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation,
    taxCode: rule.taxCode,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: [...rule.ruleTags.map((ruleTag) => ruleTag.tagId)].sort(),
    priority: rule.priority,
    autoPost: rule.autoPost,
    direction: rule.direction,
    canonicalVersion: rule.canonicalVersion,
    repairReason: rule.repairReason,
    affectedJournalEntryCount: rule.affectedJournalEntryCount,
    originIntent: rule.originIntent,
    sourceCaseId: rule.sourceCaseId,
    sourceCandidateId: rule.sourceCandidateId,
    changedBy,
    retiredAt: rule.retiredAt,
  };
}

export async function appendRuleRevision(
  db: RuleRevisionDb,
  rule: RuleWithTags,
  changedBy: string | null,
  overrides: Partial<Prisma.RuleRevisionUncheckedCreateInput> = {},
): Promise<void> {
  await db.ruleRevision.create({
    data: { ...ruleRevisionSnapshot(rule, changedBy), ...overrides },
  });
}
