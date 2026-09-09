import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  RuleCandidateDto,
  RuleCandidateEvidenceDto,
  RuleCandidateState,
  TaxCalculation,
} from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { RULE_CANDIDATE_EVIDENCE_THRESHOLD } from './agent/ruleCandidates.js';
import {
  rebuildRuleCandidates,
  reconcileRuleCandidateBeforeActivation,
} from './agent/ruleCandidatePersistence.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { appendRuleRevision } from './ruleRevisionHistory.js';
import { cachedTaxCodeSupport, cachedTaxRates } from './tax/cache.js';

type CandidateDb = PrismaClient | Prisma.TransactionClient;

export class RuleCandidateError extends Error {
  constructor(
    public readonly code:
      | 'CANDIDATE_NOT_FOUND'
      | 'CANDIDATE_NOT_READY'
      | 'CANDIDATE_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'RuleCandidateError';
  }
}

interface CandidateActor {
  id: string;
  label: string;
}

interface CandidateReadiness {
  category: string | null;
  direction: 'Purchase' | 'Deposit' | null;
  ruleRuntimeMode: 'legacy' | 'bridge' | 'paused' | 'canonical';
  taxCode: string | null;
  tagIds: string[];
  staleReasons: string[];
}

const RULE_CANDIDATE_PROVENANCE_LIMIT = 50;

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))].sort()
    : [];
}

async function readiness(
  db: CandidateDb,
  candidate: {
    companyId: string;
    configVersion: string;
    matchText: string;
    categoryQboId: string | null;
    taxCalculation: string | null;
    taxCodeQboId: string | null;
    tagIds: Prisma.JsonValue;
    activatedRuleId: string | null;
  },
): Promise<CandidateReadiness> {
  const tagIds = stringArray(candidate.tagIds);
  const [account, config, company] = await Promise.all([
    candidate.categoryQboId === null
      ? null
      : db.qboAccount.findFirst({
          where: {
            companyId: candidate.companyId,
            qboId: candidate.categoryQboId,
            active: true,
            classification: { in: ['Income', 'COGS', 'Expenses'] },
          },
          select: { name: true, classification: true },
        }),
    db.agentCompanyConfig.findUnique({
      where: { companyId: candidate.companyId },
      select: { configVersion: true },
    }),
    db.company.findUnique({
      where: { id: candidate.companyId },
      select: { taxSupportStatus: true, taxUsingSalesTax: true, ruleRuntimeMode: true },
    }),
  ]);
  const direction = account?.classification === 'Income'
    ? 'Deposit'
    : account?.classification === 'COGS' || account?.classification === 'Expenses'
      ? 'Purchase'
      : null;
  const ruleRuntimeMode = company?.ruleRuntimeMode ?? 'paused';
  const [taxCode, taxRateRows, ownedTags, hasOverlap] = await Promise.all([
    candidate.taxCodeQboId === null
      ? null
      : db.qboTaxCode.findFirst({
          where: {
            companyId: candidate.companyId,
            qboId: candidate.taxCodeQboId,
            active: true,
          },
          select: {
            name: true,
            active: true,
            taxable: true,
            purchaseTaxRateList: true,
            salesTaxRateList: true,
          },
        }),
    candidate.taxCodeQboId === null
      ? []
      : db.qboTaxRate.findMany({
          where: { companyId: candidate.companyId },
          select: {
            qboId: true,
            name: true,
            description: true,
            active: true,
            rateValue: true,
            sourceUpdatedAt: true,
          },
        }),
    db.tag.count({ where: { companyId: candidate.companyId, id: { in: tagIds } } }),
    hasOverlappingRule(db, candidate, direction, ruleRuntimeMode),
  ]);
  const reasons: string[] = [];
  if (account === null) reasons.push('The category reference is no longer active.');
  const taxDirection = ruleRuntimeMode === 'canonical' && direction === 'Deposit'
    ? 'sales'
    : 'purchase';
  const taxCodeUsable = taxCode !== null
    && direction !== null
    && cachedTaxCodeSupport(taxCode, cachedTaxRates(taxRateRows), taxDirection).supported;
  if (
    candidate.taxCalculation !== 'TaxInclusive'
    && candidate.taxCalculation !== 'TaxExcluded'
    && candidate.taxCalculation !== 'NotApplicable'
  ) {
    reasons.push('The tax calculation is no longer valid.');
  } else if (
    candidate.taxCalculation === 'NotApplicable'
      ? candidate.taxCodeQboId !== null
      : !taxCodeUsable
  ) {
    reasons.push('The tax reference is no longer active.');
  }
  if (
    candidate.taxCalculation !== 'NotApplicable'
    && (
      company?.taxSupportStatus !== 'ready'
      || company.taxUsingSalesTax !== true
    )
  ) {
    reasons.push('Company tax readiness changed after this evidence was collected.');
  }
  if (
    ruleRuntimeMode !== 'canonical'
    && (candidate.taxCalculation === 'TaxInclusive'
      || candidate.taxCalculation === 'TaxExcluded')
  ) {
    reasons.push(
      'Taxed candidates cannot activate until normal rules reproduce the same QBO tax write.',
    );
  }
  if (ownedTags !== tagIds.length) reasons.push('One or more tags are no longer available.');
  const currentConfigVersion = config?.configVersion ?? 'verified-writeback-v1';
  if (currentConfigVersion !== candidate.configVersion) {
    reasons.push('Autopilot configuration changed after this evidence was collected.');
  }
  if (hasOverlap) {
    reasons.push('An existing rule overlaps this payee condition.');
  }
  if (ruleRuntimeMode === 'paused') {
    reasons.push('Rule execution is paused for canonical migration.');
  }
  return {
    category: account?.name ?? null,
    direction,
    ruleRuntimeMode,
    taxCode: taxCode?.name ?? null,
    tagIds,
    staleReasons: reasons,
  };
}

async function hasOverlappingRule(
  db: CandidateDb,
  candidate: {
    companyId: string;
    matchText: string;
    activatedRuleId: string | null;
  },
  direction: 'Purchase' | 'Deposit' | null,
  ruleRuntimeMode: 'legacy' | 'bridge' | 'paused' | 'canonical',
): Promise<boolean> {
  if (ruleRuntimeMode === 'paused' || (ruleRuntimeMode === 'canonical' && direction === null)) {
    return false;
  }
  const needle = candidate.matchText;
  const activatedRuleFilter = candidate.activatedRuleId === null
    ? Prisma.empty
    : Prisma.sql`AND rule."id" <> ${candidate.activatedRuleId}`;
  const eligibleRule = ruleRuntimeMode === 'canonical'
    ? Prisma.sql`
        AND rule."reviewRequiredAt" IS NULL
        AND rule."repairReason" IS NULL
        AND rule."canonicalVersion" = 2
        AND rule."direction"::text = ${direction}
        AND rule_match_key(rule."matchText") <> ''
        AND (
          position(rule_match_key(rule."matchText") IN rule_match_key(${needle})) > 0
          OR position(rule_match_key(${needle}) IN rule_match_key(rule."matchText")) > 0
        )
      `
    : Prisma.sql`
        AND trim(rule."matchText") <> ''
        AND (
          strpos(lower(trim(rule."matchText")), ${needle.trim().toLowerCase()}) > 0
          OR strpos(${needle.trim().toLowerCase()}, lower(trim(rule."matchText"))) > 0
        )
      `;
  const rows = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`
      SELECT rule."id"
      FROM "Rule" rule
      WHERE rule."companyId" = ${candidate.companyId}
        AND rule."enabled" = true
        AND rule."retiredAt" IS NULL
        AND rule."matchField" = 'payee'
        ${activatedRuleFilter}
        ${eligibleRule}
      LIMIT 1
    `,
  );
  return rows.length > 0;
}

type CandidateRow = Prisma.AutopilotRuleCandidateGetPayload<{
  include: {
    evidence: {
      where: { active: true; polarity: 'positive' };
      orderBy: { observedAt: 'desc' };
      select: { transactionId: true; source: true; observedAt: true };
    };
  };
}>;

function evidenceDto(
  row: CandidateRow['evidence'][number],
): RuleCandidateEvidenceDto {
  const source =
    row.source === 'autopilot' || row.source === 'mcp' ? row.source : 'user';
  return {
    transactionId: row.transactionId,
    source,
    observedAt: row.observedAt.toISOString(),
  };
}

async function toDto(db: CandidateDb, candidate: CandidateRow): Promise<RuleCandidateDto> {
  const [checked, sourceRows] = await Promise.all([
    readiness(db, candidate),
    db.autopilotRuleCandidateEvidence.groupBy({
      by: ['source'],
      where: { candidateId: candidate.id, active: true, polarity: 'positive' },
      _count: { _all: true },
    }),
  ]);
  const provenance = { user: 0, autopilot: 0, mcp: 0 };
  for (const row of sourceRows) {
    const source =
      row.source === 'autopilot' || row.source === 'mcp' ? row.source : 'user';
    provenance[source] += row._count._all;
  }
  const exposedState: RuleCandidateState =
    candidate.state === 'ready' && checked.staleReasons.length > 0
      ? 'stale'
      : candidate.state === 'ready'
        || candidate.state === 'conflict'
        || candidate.state === 'dismissed'
        || candidate.state === 'activated'
        ? candidate.state
        : 'stale';
  return {
    id: candidate.id,
    companyId: candidate.companyId,
    state: exposedState,
    matchField: 'payee',
    matchText: candidate.matchText,
    category: checked.category,
    categoryQboId: candidate.categoryQboId,
    taxCalculation: candidate.taxCalculation as TaxCalculation | null,
    taxCode: checked.taxCode,
    taxCodeQboId: candidate.taxCodeQboId,
    tagIds: checked.tagIds,
    evidenceCount: candidate.evidenceCount,
    conflictingEvidenceCount: candidate.conflictingEvidenceCount,
    evidenceThreshold: RULE_CANDIDATE_EVIDENCE_THRESHOLD,
    schemaVersion: candidate.schemaVersion,
    configVersion: candidate.configVersion,
    staleReasons: checked.staleReasons,
    canActivate:
      candidate.state === 'ready'
      && candidate.evidenceCount >= RULE_CANDIDATE_EVIDENCE_THRESHOLD
      && candidate.conflictingEvidenceCount === 0
      && checked.staleReasons.length === 0,
    activatedRuleId: candidate.activatedRuleId,
    provenance,
    evidence: candidate.evidence.map(evidenceDto),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

const candidateInclude = {
  evidence: {
    where: { active: true, polarity: 'positive' },
    orderBy: { observedAt: 'desc' },
    take: RULE_CANDIDATE_PROVENANCE_LIMIT,
    select: { transactionId: true, source: true, observedAt: true },
  },
} satisfies Prisma.AutopilotRuleCandidateInclude;

export async function listRuleCandidates(
  companyId: string,
  options: { cursor?: string; limit?: number } = {},
  db: PrismaClient = prisma,
): Promise<{ candidates: RuleCandidateDto[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  await rebuildRuleCandidates(companyId, { db });
  if (options.cursor !== undefined) {
    const cursor = await db.autopilotRuleCandidate.findFirst({
      where: { id: options.cursor, companyId },
      select: { id: true },
    });
    if (cursor === null) {
      throw new RuleCandidateError('CANDIDATE_NOT_FOUND', 'Rule candidate cursor not found.');
    }
  }
  const rows = await db.autopilotRuleCandidate.findMany({
    where: {
      companyId,
      state: { in: ['ready', 'conflict'] },
    },
    include: candidateInclude,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
  });
  const page = rows.slice(0, limit);
  return {
    candidates: await Promise.all(page.map((row) => toDto(db, row))),
    nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
  };
}

export async function getRuleCandidate(
  companyId: string,
  candidateId: string,
  db: PrismaClient = prisma,
): Promise<RuleCandidateDto> {
  const candidate = await db.autopilotRuleCandidate.findFirst({
    where: { id: candidateId, companyId },
    include: candidateInclude,
  });
  if (candidate === null) {
    throw new RuleCandidateError('CANDIDATE_NOT_FOUND', 'Rule candidate not found.');
  }
  return toDto(db, candidate);
}

async function lockCompanyAndCandidate(
  tx: Prisma.TransactionClient,
  companyId: string,
  candidateId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`
      SELECT candidate."id"
      FROM "AutopilotRuleCandidate" candidate
      WHERE candidate."companyId" = ${companyId} AND candidate."id" = ${candidateId}
      FOR UPDATE OF candidate
    `,
  );
  if (rows.length !== 1) {
    throw new RuleCandidateError('CANDIDATE_NOT_FOUND', 'Rule candidate not found.');
  }
}

async function assertDurableEvidence(
  tx: Prisma.TransactionClient,
  candidate: Prisma.AutopilotRuleCandidateGetPayload<Record<string, never>>,
): Promise<void> {
  const conflicting = await tx.autopilotRuleCandidateEvidence.count({
    where: {
      candidateId: candidate.id,
      active: true,
      OR: [
        { polarity: 'negative' },
        {
          polarity: 'positive',
          actionFingerprint: { not: candidate.winningActionFingerprint ?? '' },
        },
      ],
    },
  });
  if (conflicting > 0) {
    throw new RuleCandidateError(
      'CANDIDATE_STALE',
      'The candidate no longer has a single agreeing action.',
    );
  }
  const evidence = await tx.autopilotRuleCandidateEvidence.findMany({
    where: {
      candidateId: candidate.id,
      active: true,
      polarity: 'positive',
      actionFingerprint: candidate.winningActionFingerprint ?? '',
    },
    include: {
      transaction: {
        select: { companyId: true, status: true, revision: true },
      },
    },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    distinct: ['transactionId'],
    take: RULE_CANDIDATE_PROVENANCE_LIMIT,
  });
  if (evidence.length < RULE_CANDIDATE_EVIDENCE_THRESHOLD) {
    throw new RuleCandidateError(
      'CANDIDATE_STALE',
      'The candidate no longer has three agreeing current outcomes.',
    );
  }
  const attempts = await tx.qboMutationAttempt.findMany({
    where: { requestId: { in: evidence.map((row) => row.requestId) } },
    select: {
      requestId: true,
      transactionId: true,
      operation: true,
      status: true,
      expectedRevision: true,
    },
  });
  const byRequest = new Map(attempts.map((attempt) => [attempt.requestId, attempt]));
  const validTransactionIds = new Set(evidence.flatMap((row) => {
    const attempt = byRequest.get(row.requestId);
    const invalid =
      row.transaction.companyId !== candidate.companyId
      || row.transaction.status !== 'POSTED'
      || row.transaction.revision !== row.inputRevision
      || attempt?.transactionId !== row.transactionId
      || attempt.operation !== 'recategorize'
      || attempt.status !== 'VERIFIED'
      || attempt.expectedRevision !== row.inputRevision;
    return invalid ? [] : [row.transactionId];
  }));
  if (validTransactionIds.size < RULE_CANDIDATE_EVIDENCE_THRESHOLD) {
    throw new RuleCandidateError(
      'CANDIDATE_STALE',
      'One or more verified outcomes are no longer current.',
    );
  }
}

/** Read-only activation preflight for two-phase callers. It deliberately does
 * not reconcile or mutate candidate evidence during preparation. */
export async function validateRuleCandidateActivationInTransaction(
  tx: Prisma.TransactionClient,
  companyId: string,
  candidateId: string,
): Promise<void> {
  const candidate = await tx.autopilotRuleCandidate.findFirst({
    where: { id: candidateId, companyId },
  });
  if (candidate === null) {
    throw new RuleCandidateError('CANDIDATE_NOT_FOUND', 'Rule candidate not found.');
  }
  if (
    candidate.state !== 'ready'
    || candidate.evidenceCount < RULE_CANDIDATE_EVIDENCE_THRESHOLD
    || candidate.conflictingEvidenceCount !== 0
    || candidate.winningActionFingerprint === null
  ) {
    throw new RuleCandidateError('CANDIDATE_NOT_READY', 'Rule candidate is not ready to activate.');
  }
  await assertDurableEvidence(tx, candidate);
  const checked = await readiness(tx, candidate);
  if (checked.staleReasons.length > 0 || checked.category === null || checked.direction === null) {
    throw new RuleCandidateError(
      'CANDIDATE_STALE',
      checked.staleReasons[0] ?? 'Rule candidate is stale.',
    );
  }
}

export async function dismissRuleCandidate(
  companyId: string,
  candidateId: string,
  actor: CandidateActor,
  db: PrismaClient = prisma,
): Promise<RuleCandidateDto> {
  await runCompanyMutationTransaction(db, companyId, async (tx) => {
    await dismissRuleCandidateInTransaction(tx, companyId, candidateId, actor);
  });
  return getRuleCandidate(companyId, candidateId, db);
}

export async function dismissRuleCandidateInTransaction(
  tx: Prisma.TransactionClient,
  companyId: string,
  candidateId: string,
  actor: CandidateActor,
): Promise<Prisma.AutopilotRuleCandidateGetPayload<Record<string, never>>> {
  await lockCompanyAndCandidate(tx, companyId, candidateId);
  const candidate = await tx.autopilotRuleCandidate.findUniqueOrThrow({
    where: { id: candidateId },
  });
  if (candidate.state === 'activated') {
    throw new RuleCandidateError('CANDIDATE_NOT_READY', 'An activated candidate cannot be dismissed.');
  }
  if (candidate.state !== 'dismissed') {
    await tx.autopilotRuleCandidate.update({
      where: { id: candidate.id },
      data: {
        state: 'dismissed',
        dismissedAt: new Date(),
        dismissedByUserId: actor.id,
      },
    });
    await tx.auditEntry.create({
      data: {
        companyId,
        actorId: actor.id,
        actorLabel: actor.label,
        payee: candidate.matchText,
        amount: 0,
        action: 'rule-candidate-dismissed',
        before: 'Rule candidate',
        after: 'Dismissed',
        payload: {
          candidateId: candidate.id,
          evidenceCount: candidate.evidenceCount,
          schemaVersion: candidate.schemaVersion,
          configVersion: candidate.configVersion,
        },
      },
    });
  }
  return tx.autopilotRuleCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
}

export interface ActivateRuleCandidateOptions {
  ruleId?: string;
  priority?: number;
  initialRevision?: number;
  skipReconciliation?: boolean;
}

export async function reconcileRuleCandidateActivationInTransaction(
  tx: Prisma.TransactionClient,
  companyId: string,
  candidateId: string,
): Promise<{ saturated: boolean }> {
  await lockCompanyAndCandidate(tx, companyId, candidateId);
  const candidate = await tx.autopilotRuleCandidate.findUniqueOrThrow({
    where: { id: candidateId },
  });
  const reconciliation = await reconcileRuleCandidateBeforeActivation(tx, candidate);
  return { saturated: reconciliation.saturated };
}

export async function activateRuleCandidateInTransaction(
  tx: Prisma.TransactionClient,
  companyId: string,
  candidateId: string,
  actor: CandidateActor,
  options: ActivateRuleCandidateOptions = {},
): Promise<{
  candidate: Prisma.AutopilotRuleCandidateGetPayload<Record<string, never>>;
  rule: Prisma.RuleGetPayload<{ include: { ruleTags: true } }>;
}> {
  await lockCompanyAndCandidate(tx, companyId, candidateId);
  let candidate = await tx.autopilotRuleCandidate.findUniqueOrThrow({
    where: { id: candidateId },
  });
  if (options.skipReconciliation !== true) {
    const reconciliation = await reconcileRuleCandidateBeforeActivation(tx, candidate);
    if (reconciliation.saturated) {
      throw new RuleCandidateError(
        'CANDIDATE_STALE',
        'Too many verified outcomes are waiting to be reconciled. Refresh and try again.',
      );
    }
    candidate = await tx.autopilotRuleCandidate.findUniqueOrThrow({
      where: { id: candidateId },
    });
  }
  if (
    candidate.state !== 'ready'
    || candidate.evidenceCount < RULE_CANDIDATE_EVIDENCE_THRESHOLD
    || candidate.conflictingEvidenceCount !== 0
    || candidate.winningActionFingerprint === null
  ) {
    throw new RuleCandidateError('CANDIDATE_NOT_READY', 'Rule candidate is not ready to activate.');
  }
  await assertDurableEvidence(tx, candidate);
  const checked = await readiness(tx, candidate);
  if (checked.staleReasons.length > 0 || checked.category === null || checked.direction === null) {
    throw new RuleCandidateError('CANDIDATE_STALE', checked.staleReasons[0] ?? 'Rule candidate is stale.');
  }
  const priority = options.priority ?? await tx.rule.aggregate({
    where: { companyId, enabled: true, retiredAt: null },
    _min: { priority: true },
  }).then(({ _min }) => _min.priority === null ? 0 : _min.priority - 1);
  const rule = await tx.rule.create({
    data: {
      ...(options.ruleId ? { id: options.ruleId } : {}),
      companyId,
      priority,
      matchField: 'payee',
      matchText: candidate.matchText,
      category: checked.category,
      categoryQboId: candidate.categoryQboId,
      taxCalculation: candidate.taxCalculation,
      taxCode: checked.taxCode,
      taxCodeQboId: candidate.taxCodeQboId,
      autoPost: false,
      ...(checked.ruleRuntimeMode === 'canonical'
        ? { direction: checked.direction, canonicalVersion: 2 }
        : {}),
      revision: options.initialRevision ?? 0,
      originIntent: 'auto_candidate',
      sourceCandidateId: candidate.id,
      createdById: actor.id,
      updatedById: actor.id,
      ruleTags: {
        create: checked.tagIds.map((tagId) => ({ tagId })),
      },
    },
    include: { ruleTags: true },
  });
  await appendRuleRevision(tx, rule, actor.id);
  const activated = await tx.autopilotRuleCandidate.update({
    where: { id: candidate.id },
    data: {
      state: 'activated',
      activatedAt: new Date(),
      activatedByUserId: actor.id,
      activationEvidenceCount: candidate.evidenceCount,
      activationActionFingerprint: candidate.winningActionFingerprint,
      activatedRuleId: rule.id,
    },
  });
  await tx.auditEntry.create({
    data: {
      companyId,
      actorId: actor.id,
      actorLabel: actor.label,
      payee: candidate.matchText,
      amount: 0,
      action: 'rule-candidate-activated',
      before: 'Rule candidate',
      after: checked.category,
      payload: {
        candidateId: candidate.id,
        ruleId: rule.id,
        evidenceCount: candidate.evidenceCount,
        actionFingerprint: candidate.winningActionFingerprint,
        schemaVersion: candidate.schemaVersion,
        configVersion: candidate.configVersion,
        autoPost: false,
      },
    },
  });
  return { candidate: activated, rule };
}

export async function activateRuleCandidate(
  companyId: string,
  candidateId: string,
  actor: CandidateActor,
  db: PrismaClient = prisma,
): Promise<RuleCandidateDto> {
  const error = await runCompanyMutationTransaction(db, companyId, async (tx) => {
    try {
      await activateRuleCandidateInTransaction(tx, companyId, candidateId, actor);
    } catch (caught) {
      if (caught instanceof RuleCandidateError) return caught;
      throw caught;
    }
    return null;
  });
  if (error !== null) throw error;
  return getRuleCandidate(companyId, candidateId, db);
}
