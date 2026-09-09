import { Prisma } from '@prisma/client';
import { parseActionTagIds } from './classification/actionTagIds.js';
import { appendRuleRevision } from './ruleRevisionHistory.js';

export interface DisableRuleForSafetyInput {
  companyId: string;
  ruleId: string;
  expectedRevision?: number;
  reason: string;
  actor: string;
  preserveTagIds?: string[];
  /** Trusted event time supplied by deterministic evidence-folding callers. */
  occurredAt?: Date;
}

export interface DisableRuleForSafetyResult {
  changed: boolean;
  revision: number;
}

function boundedText(value: string, limit: number, label: string): string {
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || normalized.length > limit) {
    throw new Error(`${label} must be a nonblank value of at most ${limit} characters.`);
  }
  return normalized;
}

function preservedTags(input: string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const normalized = input.map((tagId) => boundedText(tagId, 128, 'tagId')).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('preserveTagIds must contain unique identifiers.');
  }
  return normalized;
}

async function clearPendingRuleSuggestions(
  tx: Prisma.TransactionClient,
  companyId: string,
  ruleId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Transaction"
       SET "suggestion" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "companyId" = ${companyId}
       AND "status" = 'PENDING'
       AND jsonb_typeof("suggestion") = 'object'
       AND "suggestion"->>'source' = 'rule'
       AND "suggestion"->>'ruleId' = ${ruleId}
  `;
}

export async function disableRuleForSafetyInTransaction(
  tx: Prisma.TransactionClient,
  input: DisableRuleForSafetyInput,
): Promise<DisableRuleForSafetyResult> {
  const companyId = boundedText(input.companyId, 128, 'companyId');
  const ruleId = boundedText(input.ruleId, 128, 'ruleId');
  const reason = boundedText(input.reason, 500, 'reason');
  const actor = boundedText(input.actor, 128, 'actor');
  const explicitTagIds = preservedTags(input.preserveTagIds);
  const current = await tx.rule.findFirst({
    where: { id: ruleId, companyId },
    include: { ruleTags: true },
  });
  if (current === null) throw new Error('Rule was not found.');
  if (
    !current.enabled
    && !current.autoPost
    && current.repairReason === reason
    && current.reviewReason === reason
    && current.reviewRequiredAt !== null
  ) {
    await clearPendingRuleSuggestions(tx, companyId, ruleId);
    return { changed: false, revision: current.revision };
  }
  if (current.retiredAt !== null) {
    await clearPendingRuleSuggestions(tx, companyId, ruleId);
    return { changed: false, revision: current.revision };
  }
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
    throw new Error('Rule revision changed.');
  }

  let revisionTagIds: Prisma.InputJsonValue | undefined = explicitTagIds;
  if (current.reviewRequiredAt !== null || current.repairReason !== null) {
    const heldRevision = await tx.ruleRevision.findUnique({
      where: {
        companyId_ruleId_revision: {
          companyId,
          ruleId,
          revision: current.revision,
        },
      },
      select: { tagIds: true },
    });
    if (heldRevision === null) {
      throw new Error('Held rule tag provenance is unavailable.');
    }
    if (explicitTagIds === undefined) {
      revisionTagIds = heldRevision.tagIds as Prisma.InputJsonValue;
    } else {
      const priorTagIds = parseActionTagIds(heldRevision.tagIds);
      if (priorTagIds === null) {
        throw new Error('Held rule tag provenance is invalid.');
      }
      revisionTagIds = [...new Set([...priorTagIds, ...explicitTagIds])].sort();
    }
  }

  const now = input.occurredAt ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('occurredAt must be a valid date.');
  const updatedCount = await tx.rule.updateMany({
    where: { id: ruleId, companyId, revision: current.revision },
    data: {
      enabled: false,
      autoPost: false,
      repairReason: reason,
      reviewRequiredAt: now,
      reviewReason: reason,
      revision: { increment: 1 },
      updatedById: actor,
    },
  });
  if (updatedCount.count !== 1) throw new Error('Rule safety transition lost its revision race.');
  const updated = await tx.rule.findFirstOrThrow({
    where: { id: ruleId, companyId },
    include: { ruleTags: true },
  });
  await appendRuleRevision(tx, updated, actor, {
    state: 'disabled',
    ...(revisionTagIds === undefined ? {} : { tagIds: revisionTagIds }),
  });
  await tx.auditEntry.create({ data: {
    companyId,
    actorId: null,
    actorLabel: actor,
    txnId: null,
    payee: `Rule: ${ruleId}`,
    amount: new Prisma.Decimal(0),
    action: 'rule-disabled-for-safety',
    before: current.enabled ? 'Enabled' : 'Disabled',
    after: 'Disabled',
    payload: {
      ruleId,
      revision: updated.revision,
      reason,
      preservedTagIds: revisionTagIds ?? updated.ruleTags.map(({ tagId }) => tagId).sort(),
    },
  } });
  await clearPendingRuleSuggestions(tx, companyId, ruleId);
  return { changed: true, revision: updated.revision };
}
