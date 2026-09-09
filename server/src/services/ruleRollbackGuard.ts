import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runRuleCutoverTransaction } from './ruleCutoverTransaction.js';
import {
  assertNoActiveRuleOperations,
  CANONICAL_RULE_VERSION,
} from './ruleCanonicalBackfill.js';

export interface RollbackGuardInput {
  companyId: string;
  apply: boolean;
  actor: string;
}

export interface RollbackGuardReport {
  companyId: string;
  applied: boolean;
  examinedCanonicalRules: number;
  wouldDisableRules: number;
  disabledRules: number;
  wouldClearRuleSuggestions: number;
  clearedRuleSuggestions: number;
  revisionsAppended: number;
  auditsAppended: number;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error(`${label} must be a nonblank value of at most 128 characters.`);
  }
  return normalized;
}

async function suggestionCount(tx: Prisma.TransactionClient, companyId: string): Promise<number> {
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

async function clearSuggestions(tx: Prisma.TransactionClient, companyId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE "Transaction"
       SET "suggestion" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "companyId" = ${companyId}
       AND "status" = 'PENDING'
       AND jsonb_typeof("suggestion") = 'object'
       AND "suggestion"->>'source' = 'rule'
  `;
}

export async function prepareRuleRollback(
  input: RollbackGuardInput,
  db: PrismaClient = prisma,
): Promise<RollbackGuardReport> {
  const companyId = requiredIdentifier(input.companyId, 'companyId');
  const actor = requiredIdentifier(input.actor, 'actor');
  return runRuleCutoverTransaction(db, companyId, async (tx) => {
    const company = await tx.company.findUnique({
      where: { id: companyId }, select: { ruleRuntimeMode: true },
    });
    if (company === null) throw new Error('Company was not found.');
    if (company.ruleRuntimeMode !== 'paused') {
      throw new Error('Rule rollback guard requires ruleRuntimeMode=paused.');
    }
    await assertNoActiveRuleOperations(tx, companyId);
    const rules = await tx.rule.findMany({
      where: { companyId, canonicalVersion: CANONICAL_RULE_VERSION },
      include: { ruleTags: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    const changing = rules.filter((rule) => rule.enabled || rule.autoPost);
    const pendingSuggestions = await suggestionCount(tx, companyId);
    if (input.apply) {
      for (const rule of changing) {
        const revision = rule.revision + 1;
        const repairReason = rule.repairReason ?? 'Rollback guard requires reviewed reactivation.';
        const updated = await tx.rule.updateMany({
          where: { id: rule.id, companyId, revision: rule.revision, canonicalVersion: CANONICAL_RULE_VERSION },
          data: {
            enabled: false,
            autoPost: false,
            repairReason,
            revision,
            updatedById: actor,
          },
        });
        if (updated.count !== 1) throw new Error(`Rule rollback CAS failed for ${rule.id}.`);
        await tx.ruleRevision.create({ data: {
          ruleId: rule.id,
          companyId,
          revision,
          state: 'disabled',
          matchField: rule.matchField,
          matchText: rule.matchText,
          category: rule.category,
          categoryQboId: rule.categoryQboId,
          taxCalculation: rule.taxCalculation,
          taxCode: rule.taxCode,
          taxCodeQboId: rule.taxCodeQboId,
          tagIds: rule.ruleTags.map(({ tagId }) => tagId).sort(),
          priority: rule.priority,
          autoPost: false,
          direction: rule.direction,
          canonicalVersion: CANONICAL_RULE_VERSION,
          repairReason,
          affectedJournalEntryCount: rule.affectedJournalEntryCount,
          originIntent: rule.originIntent,
          sourceCaseId: rule.sourceCaseId,
          sourceCandidateId: rule.sourceCandidateId,
          changedBy: actor,
          retiredAt: rule.retiredAt,
        } });
        await tx.auditEntry.create({ data: {
          companyId,
          actorId: null,
          actorLabel: actor,
          txnId: null,
          payee: `Rule: ${rule.id}`,
          amount: new Prisma.Decimal(0),
          action: 'rule-rollback-guarded',
          before: rule.enabled ? 'Enabled' : 'Disabled',
          after: 'Disabled',
          payload: { ruleId: rule.id, revision, reason: repairReason },
        } });
      }
    }
    const cleared = input.apply ? await clearSuggestions(tx, companyId) : 0;
    return {
      companyId,
      applied: input.apply,
      examinedCanonicalRules: rules.length,
      wouldDisableRules: changing.length,
      disabledRules: input.apply ? changing.length : 0,
      wouldClearRuleSuggestions: pendingSuggestions,
      clearedRuleSuggestions: cleared,
      revisionsAppended: input.apply ? changing.length : 0,
      auditsAppended: input.apply ? changing.length : 0,
    };
  });
}
