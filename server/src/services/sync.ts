// Sync engine (specs §3).
//
// Per run: refresh the chart of accounts, pull holding-account transactions
// (full list for manual/initial/nightly, Change Data Capture deltas for
// poll/webhook), upsert on (companyId, qboType, qboId), mark txns that were
// fixed inside QuickBooks as SUPERSEDED, recompute suggestion snapshots, gate
// auto-post rules, and record a SyncLog row. QBO is always the source of truth.

import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { QboAccountInfo, QboTxn } from '../lib/qbo/types.js';
import {
  EntityLeaseError,
  fenceEntityLeaseOwnerships,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';
import { refreshSuggestions } from './suggestions.js';
import {
  ensureUnknownProviderActionability,
  type ProviderActionabilityDb,
} from './providerActionability.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { disableRuleForSafetyInTransaction } from './ruleSafetyTransition.js';
import { validateExistingRuleAction } from './rules.js';
import { RuleSuggestionApplicationError } from './ruleSuggestionApplication.js';
import { rememberBusyRulePreparation, type DeferredRuleCandidate } from './rulePreparationRetry.js';
import { compareRuleWinner, ruleMatches } from './ruleMatching.js';
import {
  prepareRuleAutoPost,
  recoverRuleAutoPosts,
  resumeRuleAutoPost,
  type RecoveryReport,
} from './ruleAutoPost.js';

export type SyncKind = 'poll' | 'webhook' | 'manual' | 'nightly' | 'initial';

export interface SyncResult {
  ok: boolean;
  message: string;
  mirror?: {
    created: number;
    refreshed: number;
    stale: number;
    busy: number;
    contended: number;
  };
}

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function buildMessage(created: number, dropped: number, autoPosted: number, accountCount: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new ${created === 1 ? 'transaction' : 'transactions'}`);
  if (dropped > 0) parts.push(`${dropped} dropped (categorized in QBO)`);
  if (autoPosted > 0) parts.push(`${autoPosted} auto-posted`);
  if (parts.length === 0) return `Chart of accounts refreshed — ${plural(accountCount, 'account')}`;
  return parts.join(', ');
}

export interface SyncMutationDeps {
  lease<T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  fence(
    key: EntityLeaseKey,
    owner: string,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  owner(): string;
}

const defaultSyncMutationDeps: SyncMutationDeps = {
  lease: (key, owner, callback) =>
    withEntityLease(key, owner, callback, {
      db: prisma as unknown as EntityLeaseDb,
    }),
  fence: (key, owner, tx) =>
    fenceEntityLeaseOwnerships([key], owner, {
      db: tx as unknown as EntityLeaseFenceDb,
    }),
  owner: randomUUID,
};

const ACTIVE_MUTATION_STATUSES = [
  'PREPARED',
  'COMMITTING',
  'UNCERTAIN',
] as const;

function entityKey(
  companyId: string,
  value: { qboType: string; qboId: string },
): EntityLeaseKey {
  return { companyId, qboType: value.qboType, qboId: value.qboId };
}

function isEntityBusy(error: unknown): boolean {
  return error instanceof EntityLeaseError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === 'ENTITY_BUSY'
    );
}

async function withSyncEntityLease<T>(
  key: EntityLeaseKey,
  dependencies: SyncMutationDeps,
  callback: (owner: string) => Promise<T>,
): Promise<T | null> {
  const owner = dependencies.owner();
  try {
    return await dependencies.lease(
      key,
      owner,
      () => callback(owner),
    );
  } catch (error) {
    if (isEntityBusy(error)) return null;
    throw error;
  }
}

export type MirroredTransactionRefreshOutcome =
  | 'refreshed'
  | 'stale'
  | 'busy'
  | 'contended'
  | 'not_found'
  | 'missing_in_qbo'
  | 'not_in_holding';

export interface MirroredTransactionRefreshResult {
  transactionId: string;
  outcome: MirroredTransactionRefreshOutcome;
}

/**
 * Refresh one already-mirrored holding transaction from QBO.
 *
 * This is intentionally narrower than syncCompany: it does not enumerate the
 * chart, tax references, or every holding transaction. It is the safe refresh
 * path immediately before a governed categorization prepare when a stored QBO
 * source snapshot needs to be current.
 */
export async function refreshMirroredTransaction(
  companyId: string,
  transactionId: string,
  mutationDependencies: SyncMutationDeps = defaultSyncMutationDeps,
): Promise<MirroredTransactionRefreshResult> {
  const [company, current] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId } }),
    prisma.transaction.findUnique({ where: { id: transactionId } }),
  ]);
  if (company === null || current === null || current.companyId !== companyId) {
    return { transactionId, outcome: 'not_found' };
  }

  const { qboFactory } = await import('../lib/qbo/factory.js');
  const client = await qboFactory.forCompany(companyId);
  const fresh = await client.fetchTxn(current.qboType as QboTxn['qboType'], current.qboId);
  if (fresh === null) return { transactionId, outcome: 'missing_in_qbo' };

  const holdingIds = jsonStringArray(company.holdingAccountIds);
  if (!fresh.lines.some((line) => holdingIds.includes(line.accountQboId))) {
    return { transactionId, outcome: 'not_in_holding' };
  }
  if (isStaleProviderToken(fresh.syncToken, current.qboSyncToken)) {
    return { transactionId, outcome: 'stale' };
  }

  const key = entityKey(companyId, current);
  const mutation = await withSyncEntityLease(
    key,
    mutationDependencies,
    async (owner) => prisma.$transaction(async (tx) => {
      await mutationDependencies.fence(key, owner, tx);
      const updated = await tx.transaction.updateMany({
        where: {
          id: current.id,
          companyId,
          revision: current.revision,
          qboSyncToken: current.qboSyncToken,
          qboMutationAttempts: { none: { status: { in: [...ACTIVE_MUTATION_STATUSES] } } },
        },
        data: {
          qboSyncToken: fresh.syncToken,
          date: new Date(fresh.date),
          payee: fresh.payee,
          memo: fresh.memo ?? null,
          amount: fresh.amount,
          bankAccount: fresh.bankAccount,
          rawData: fresh.raw as Prisma.InputJsonValue,
        },
      });
      if (updated.count === 1) {
        await ensureUnknownProviderActionability(
          {
            id: current.id,
            companyId,
            revision: current.revision,
            qboSyncToken: fresh.syncToken,
            qboType: fresh.qboType,
            qboId: fresh.qboId,
            date: new Date(fresh.date),
          },
          tx as unknown as ProviderActionabilityDb,
        );
      }
      return updated.count === 1 ? 'refreshed' as const : 'contended' as const;
    }),
  );
  return { transactionId, outcome: mutation ?? 'busy' };
}

function syncTokenOrder(
  left: string,
  right: string,
): number | null {
  if (left === right) return 0;
  if (!/^\d+$/u.test(left) || !/^\d+$/u.test(right)) return null;
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : 1;
}

function isStaleProviderToken(
  incoming: string,
  current: string,
): boolean {
  const order = syncTokenOrder(incoming, current);
  return order === null || order < 0;
}

/** SUPERSEDED + audit, atomically. Lazy audit import (other agent's module). */
async function supersedeTxn(
  txn: {
    id: string;
    companyId: string;
    qboType: string;
    qboId: string;
    qboSyncToken: string;
    revision: number;
    payee: string;
    amount: Prisma.Decimal | number;
  },
  holdingName: string,
  dependencies: SyncMutationDeps,
): Promise<boolean> {
  const { writeAudit } = await import('./audit.js');
  const key = {
    companyId: txn.companyId,
    qboType: txn.qboType,
    qboId: txn.qboId,
  };
  const superseded = await withSyncEntityLease(
    key,
    dependencies,
    async (owner) => prisma.$transaction(async (tx) => {
      await dependencies.fence(key, owner, tx);
      const updated = await tx.transaction.updateMany({
        where: {
          id: txn.id,
          status: { in: ['PENDING', 'ERROR'] },
          revision: txn.revision,
          qboSyncToken: txn.qboSyncToken,
          qboMutationAttempts: {
            none: { status: { in: [...ACTIVE_MUTATION_STATUSES] } },
          },
        },
        data: { status: 'SUPERSEDED' },
      });
      if (updated.count !== 1) return false;
      await writeAudit(tx, {
        companyId: txn.companyId,
        actorId: null,
        actorLabel: 'system',
        txnId: txn.id,
        payee: txn.payee,
        amount: Number(txn.amount),
        action: 'superseded',
        before: holdingName,
        after: 'fixed inside QuickBooks',
      });
      return true;
    }),
  );
  return superseded ?? false;
}

/**
 * QBO's CDC window is 30 days — past ~25 we stop trusting deltas and fall back
 * to a full sweep rather than risk missing changes near the edge.
 */
const CDC_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

/**
 * Per-company in-flight mutex: manual, webhook, and poll syncs serialize
 * instead of interleaving their upserts and supersede sweeps.
 */
const inFlightSyncs = new Map<string, Promise<unknown>>();

/**
 * Replaces the company account cache as one authoritative snapshot. Any
 * enabled canonical rule whose category disappeared, became inactive, or no
 * longer belongs to its declared direction is disabled inside the same
 * company mutation fence before sync can emit rule-backed work.
 */
export async function replaceAccountReferenceCache(
  companyId: string,
  accounts: readonly QboAccountInfo[],
  db: PrismaClient = prisma,
): Promise<void> {
  await runCompanyMutationTransaction(db, companyId, async (tx) => {
    for (const account of accounts) {
      const fullName = account.fullName.split(':').join(' · ');
      await tx.qboAccount.upsert({
        where: { companyId_qboId: { companyId, qboId: account.qboId } },
        create: {
          companyId,
          qboId: account.qboId,
          name: account.name,
          fullName,
          classification: account.classification,
          accountType: account.accountType,
          active: account.active,
        },
        update: {
          name: account.name,
          fullName,
          classification: account.classification,
          accountType: account.accountType,
          active: account.active,
        },
      });
    }
    const accountIds = accounts.map(({ qboId }) => qboId);
    await tx.qboAccount.updateMany({
      where: accountIds.length > 0
        ? { companyId, qboId: { notIn: accountIds } }
        : { companyId },
      data: { active: false },
    });

    const currentAccounts = new Map(accounts.map((account) => [account.qboId, account]));
    const rules = await tx.rule.findMany({
      where: { companyId, canonicalVersion: { not: null }, enabled: true },
      select: { id: true, revision: true, direction: true, categoryQboId: true },
    });
    for (const rule of rules) {
      const account = rule.categoryQboId === null
        ? undefined
        : currentAccounts.get(rule.categoryQboId);
      const valid = account?.active === true && (
        (rule.direction === 'Purchase'
          && (account.classification === 'Expenses' || account.classification === 'COGS'))
        || (rule.direction === 'Deposit' && account.classification === 'Income')
      );
      if (!valid) {
        await disableRuleForSafetyInTransaction(tx, {
          companyId,
          ruleId: rule.id,
          expectedRevision: rule.revision,
          reason: `Category reference ${rule.categoryQboId ?? 'missing'} is unavailable for this rule direction.`,
          actor: 'system:account-reference-refresh',
        });
      }
    }
  });
}

async function suppressLegacyRuleRuntime(
  companyId: string,
  validateCanonicalRules: boolean,
): Promise<void> {
  await runCompanyMutationTransaction(prisma, companyId, async (tx) => {
    if (validateCanonicalRules) {
      const rules = await tx.rule.findMany({
        where: { companyId, canonicalVersion: { not: null }, enabled: true },
        include: { ruleTags: true, candidateOrigin: true },
      });
      for (const rule of rules) {
        let failure: string | null = null;
        if (rule.direction === null) {
          failure = 'Rule direction is missing.';
        } else if (rule.reviewRequiredAt !== null || rule.repairReason !== null) {
          failure = rule.repairReason ?? rule.reviewReason ?? 'Rule requires reviewed repair.';
        } else {
          try {
            await validateExistingRuleAction(tx, companyId, rule);
          } catch (error) {
            failure = error instanceof Error ? error.message : 'Rule action validation failed.';
          }
        }
        if (failure !== null) {
          await disableRuleForSafetyInTransaction(tx, {
            companyId,
            ruleId: rule.id,
            expectedRevision: rule.revision,
            reason: `Canonical runtime validation failed: ${failure}`.slice(0, 500),
            actor: 'system:canonical-runtime-validation',
          });
        }
      }
    }
    await tx.transaction.updateMany({
      where: {
        companyId,
        status: 'PENDING',
        suggestion: { path: ['source'], equals: 'rule' },
      },
      data: { suggestion: Prisma.DbNull },
    });
  });
}

async function currentRuleRuntimeMode(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { ruleRuntimeMode: true },
  });
  if (company === null) throw new Error(`Company ${companyId} not found`);
  return company.ruleRuntimeMode;
}

function permitsLegacySuggestions(mode: string): boolean {
  return mode === 'legacy' || mode === 'bridge';
}

interface CanonicalRuleAutoPostCandidate {
  transactionId: string;
  sourceRevision: number;
  ruleId: string;
  ruleRevision: number;
}

interface CanonicalRuleAutoPostDeps {
  rememberBusy(input: DeferredRuleCandidate): Promise<void>;
  recover(companyId: string): Promise<RecoveryReport>;
  prepare(input: {
    companyId: string;
    transactionId: string;
    ruleId: string;
    ruleRevision: number;
  }): Promise<{ preparationId: string }>;
  resume(preparationId: string): Promise<void>;
  loadState(preparationId: string): Promise<string | null>;
  listCandidates(companyId: string): Promise<CanonicalRuleAutoPostCandidate[]>;
}

async function listCanonicalRuleAutoPostCandidates(
  companyId: string,
): Promise<CanonicalRuleAutoPostCandidate[]> {
  const [transactions, rules] = await Promise.all([
    prisma.transaction.findMany({
      where: { companyId, status: 'PENDING' },
      select: { id: true, qboType: true, payee: true, revision: true },
    }),
    prisma.rule.findMany({
      where: {
        companyId,
        enabled: true,
        retiredAt: null,
        reviewRequiredAt: null,
        reviewReason: null,
        repairReason: null,
        canonicalVersion: 2,
      },
      select: {
        id: true,
        revision: true,
        matchText: true,
        direction: true,
        priority: true,
        createdAt: true,
        autoPost: true,
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
  ]);
  return transactions.flatMap((transaction) => {
    const winner = rules
      .filter((rule) => ruleMatches(
        { matchText: rule.matchText, direction: rule.direction },
        { description: transaction.payee, type: transaction.qboType },
      ))
      .sort(compareRuleWinner)[0];
    return winner === undefined || !winner.autoPost ? [] : [{
      transactionId: transaction.id,
      sourceRevision: transaction.revision,
      ruleId: winner.id,
      ruleRevision: winner.revision,
    }];
  });
}

const defaultCanonicalRuleAutoPostDeps: CanonicalRuleAutoPostDeps = {
  rememberBusy: rememberBusyRulePreparation,
  recover: recoverRuleAutoPosts,
  prepare: prepareRuleAutoPost,
  resume: resumeRuleAutoPost,
  loadState: async (preparationId) => (
    await prisma.ruleAutoPostPreparation.findUnique({
      where: { id: preparationId },
      select: { state: true },
    })
  )?.state ?? null,
  listCandidates: listCanonicalRuleAutoPostCandidates,
};

export async function runCanonicalRuleAutoPosts(
  companyId: string,
  dependencies: Partial<CanonicalRuleAutoPostDeps> = defaultCanonicalRuleAutoPostDeps,
): Promise<{ recovered: number; autoPosted: number; failed: number }> {
  const deps = { ...defaultCanonicalRuleAutoPostDeps, ...dependencies };
  const recovery = await deps.recover(companyId);
  let autoPosted = 0;
  let failed = recovery.failed;
  for (const candidate of await deps.listCandidates(companyId)) {
    let prepared: { preparationId: string };
    try {
      const { sourceRevision: _sourceRevision, ...authority } = candidate;
      prepared = await deps.prepare({ companyId, ...authority });
    } catch (error) {
      if ((error instanceof EntityLeaseError && error.code === 'ENTITY_BUSY')
        || (error instanceof RuleSuggestionApplicationError && error.code === 'RULE_SUGGESTION_BUSY')) {
        try {
          await deps.rememberBusy({ companyId, ...candidate });
        } catch (persistError) {
          const errorCode = persistError instanceof Prisma.PrismaClientKnownRequestError
            && /^P[0-9]{4}$/.test(persistError.code) ? persistError.code : 'UNKNOWN';
          console.warn('[sync] rule preparation retry could not be recorded', { errorCode });
        }
      }
      failed += 1;
      continue;
    }
    try {
      await deps.resume(prepared.preparationId);
      const state = await deps.loadState(prepared.preparationId);
      if (state === 'VERIFIED' || state === 'DRY_RUN') autoPosted += 1;
      else if (state === 'REJECTED' || state === 'CANCELLED') failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { recovered: recovery.completed, autoPosted, failed };
}

export function syncCompany(
  companyId: string,
  kind: SyncKind,
  mutationDependencies: SyncMutationDeps = defaultSyncMutationDeps,
): Promise<SyncResult> {
  const prev = inFlightSyncs.get(companyId) ?? Promise.resolve();
  const run = prev.then(
    () => runSyncCompany(companyId, kind, mutationDependencies),
    () => runSyncCompany(companyId, kind, mutationDependencies),
  );
  inFlightSyncs.set(companyId, run);
  run
    .catch(() => undefined)
    .finally(() => {
      if (inFlightSyncs.get(companyId) === run) inFlightSyncs.delete(companyId);
    });
  return run;
}

async function runSyncCompany(
  companyId: string,
  kind: SyncKind,
  mutationDependencies: SyncMutationDeps,
): Promise<SyncResult> {
  const startedAt = new Date();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);

  try {
    const { qboFactory } = await import('../lib/qbo/factory.js');
    const client = await qboFactory.forCompany(companyId);

    // ---- 1. chart of accounts (reference data for pickers + name resolution) ----
    const accounts = await client.listAccounts();
    await replaceAccountReferenceCache(companyId, accounts);

    // Tax references are auxiliary to transaction sync. Their own service
    // persists a safe not-ready diagnostic on failure; preserve the successful
    // transaction sync while surfacing that state in this run's message.
    let taxDiagnostic: string | null = null;
    try {
      const { refreshTaxReference } = await import('./tax/reference.js');
      await refreshTaxReference(companyId);
    } catch {
      taxDiagnostic = 'Tax reference refresh failed.';
    }

    const holdingIds = jsonStringArray(company.holdingAccountIds);
    const firstHoldingId = holdingIds[0];
    const holdingName = accounts.find((a) => a.qboId === firstHoldingId)?.name ?? 'Holding account';
    const inHolding = (t: QboTxn): boolean => t.lines.some((l) => holdingIds.includes(l.accountQboId));

    // ---- 2. pull transactions ----
    // CDC only for fresh poll/webhook deltas; anything else — including a
    // lastSyncedAt older than the CDC window or a CDC call that throws — falls
    // back to the full sweep for this run.
    const cdcEligible =
      (kind === 'poll' || kind === 'webhook') &&
      company.lastSyncedAt !== null &&
      Date.now() - company.lastSyncedAt.getTime() < CDC_MAX_AGE_MS;
    let holdingTxns: QboTxn[] = [];
    let movedOut: QboTxn[] = []; // changed entities that no longer post to holding
    let deletedQboIds: { qboType: string; qboId: string }[] = [];
    let fullSweep = true;

    if (cdcEligible && company.lastSyncedAt) {
      try {
        const changed = await client.changedSince(company.lastSyncedAt.toISOString());
        holdingTxns = changed.txns.filter(inHolding);
        movedOut = changed.txns.filter((t) => !inHolding(t));
        deletedQboIds = changed.deletedQboIds;
        fullSweep = false;
      } catch (err) {
        console.warn(`[sync] CDC failed for ${companyId} — falling back to full sweep:`, err);
      }
    }
    if (fullSweep) {
      // A partial/failed page fetch inside listTxnsInAccounts throws (never a
      // truncated list), so SUPERSEDED detection below only ever runs against
      // a complete sweep.
      holdingTxns = await client.listTxnsInAccounts(holdingIds);
      movedOut = [];
      deletedQboIds = [];
    }

    // ---- 3. upsert (idempotent — CDC events can be late or duplicated, and
    // concurrent runs must not race a findUnique+create pair) ----
    const existingKeys = new Set(
      (
        await prisma.transaction.findMany({
          where: { companyId },
          select: { qboType: true, qboId: true },
        })
      ).map((t) => `${t.qboType}:${t.qboId}`),
    );
    let created = 0;
    const mirrorStats = { created: 0, refreshed: 0, stale: 0, busy: 0, contended: 0 };
    for (const t of holdingTxns) {
      // Refresh the QBO mirror on every sync (fresh SyncToken + raw JSON);
      // local categorization state (status/category/splits/tags) is untouched.
      const mirror = {
        qboSyncToken: t.syncToken,
        date: new Date(t.date),
        payee: t.payee,
        memo: t.memo ?? null,
        amount: t.amount,
        bankAccount: t.bankAccount,
        rawData: t.raw as Prisma.InputJsonValue,
      };
      const key = entityKey(companyId, t);
      const mutation = await withSyncEntityLease(
        key,
        mutationDependencies,
        async (owner) => prisma.$transaction(async (tx) => {
          await mutationDependencies.fence(key, owner, tx);
          const current = await tx.transaction.findUnique({
            where: {
              companyId_qboType_qboId: {
                companyId,
                qboType: t.qboType,
                qboId: t.qboId,
              },
            },
            select: {
              id: true,
              revision: true,
              qboSyncToken: true,
            },
          });
          if (current === null) {
            const mirrored = await tx.transaction.upsert({
              where: {
                companyId_qboType_qboId: {
                  companyId,
                  qboType: t.qboType,
                  qboId: t.qboId,
                },
              },
              create: {
                companyId,
                qboId: t.qboId,
                qboType: t.qboType,
                status: 'PENDING',
                ...mirror,
              },
              update: mirror,
              select: {
                id: true,
                companyId: true,
                revision: true,
                qboSyncToken: true,
                qboType: true,
                qboId: true,
                date: true,
              },
            });
            await ensureUnknownProviderActionability(
              mirrored,
              tx as unknown as ProviderActionabilityDb,
            );
            return { created: true, outcome: 'created' as const };
          }
          if (isStaleProviderToken(t.syncToken, current.qboSyncToken)) {
            return { created: false, outcome: 'stale' as const };
          }
          const updated = await tx.transaction.updateMany({
            where: {
              id: current.id,
              revision: current.revision,
              qboSyncToken: current.qboSyncToken,
              qboMutationAttempts: {
                none: { status: { in: [...ACTIVE_MUTATION_STATUSES] } },
              },
            },
            data: mirror,
          });
          if (updated.count === 1) {
            await ensureUnknownProviderActionability(
              {
                id: current.id,
                companyId,
                revision: current.revision,
                qboSyncToken: t.syncToken,
                qboType: t.qboType,
                qboId: t.qboId,
                date: new Date(t.date),
              },
              tx as unknown as ProviderActionabilityDb,
            );
          }
          return { created: false, outcome: updated.count === 1 ? 'refreshed' as const : 'contended' as const };
        }),
      );
      if (mutation === null) {
        mirrorStats.busy += 1;
        continue;
      }
      if (mutation?.created && !existingKeys.has(`${t.qboType}:${t.qboId}`)) {
        created += 1;
      }
      if (mutation.outcome === 'created') mirrorStats.created += 1;
      if (mutation.outcome === 'refreshed') mirrorStats.refreshed += 1;
      if (mutation.outcome === 'stale') mirrorStats.stale += 1;
      if (mutation.outcome === 'contended') mirrorStats.contended += 1;
    }

    // ---- 4. superseded detection: fixed (or deleted) inside QuickBooks ----
    let dropped = 0;
    if (fullSweep) {
      const seen = new Set(holdingTxns.map((t) => `${t.qboType}:${t.qboId}`));
      const open = await prisma.transaction.findMany({
        where: { companyId, status: { in: ['PENDING', 'ERROR'] } },
      });
      for (const txn of open) {
        if (seen.has(`${txn.qboType}:${txn.qboId}`)) continue;
        if (await supersedeTxn(txn, holdingName, mutationDependencies)) {
          dropped += 1;
        }
      }
    } else {
      const gone = [
        ...movedOut.map((t) => ({ qboType: t.qboType as string, qboId: t.qboId })),
        ...deletedQboIds,
      ];
      for (const g of gone) {
        const txn = await prisma.transaction.findUnique({
          where: { companyId_qboType_qboId: { companyId, qboType: g.qboType, qboId: g.qboId } },
        });
        if (txn && (txn.status === 'PENDING' || txn.status === 'ERROR')) {
          if (await supersedeTxn(txn, holdingName, mutationDependencies)) {
            dropped += 1;
          }
        }
      }
    }

    // ---- 5. suggestion snapshots for the queue ----
    // Keep legacy suggestion snapshots out of the canonical runtime. Its reads
    // derive complete actions from the current immutable rule revisions.
    let ruleRuntimeMode = await currentRuleRuntimeMode(companyId);
    if (permitsLegacySuggestions(ruleRuntimeMode)) {
      await refreshSuggestions(companyId);
      // A sync may span the operator's pause/backfill boundary. Re-read after
      // the legacy writer completes and erase anything it created if the mode
      // changed while the run was in flight.
      ruleRuntimeMode = await currentRuleRuntimeMode(companyId);
      if (!permitsLegacySuggestions(ruleRuntimeMode)) {
        await suppressLegacyRuleRuntime(companyId, ruleRuntimeMode === 'canonical');
      }
    } else {
      await suppressLegacyRuleRuntime(companyId, ruleRuntimeMode === 'canonical');
      if (ruleRuntimeMode === 'canonical') {
        // AI/history remain non-authoritative hints. Complete rule proofs are
        // derived from current revisions on reads, never stored by this path.
        await refreshSuggestions(companyId, { includeRuleSuggestions: false });
        ruleRuntimeMode = await currentRuleRuntimeMode(companyId);
      }
    }

    // ---- 6. auto-post rules ----
    // The bridge auto-post path snapshots mutable, category-only rule data and
    // cannot hold the company safety fence through the QuickBooks write. Keep
    // it fail-closed outside the durable, revision-bound canonical path.
    const autoPostReport = ruleRuntimeMode === 'canonical'
      ? await runCanonicalRuleAutoPosts(companyId)
      : { autoPosted: 0, failed: 0 };
    const { autoPosted } = autoPostReport;

    // ---- 7. bookkeeping ----
    await prisma.company.update({ where: { id: companyId }, data: { lastSyncedAt: startedAt } });
    let message = buildMessage(created, dropped, autoPosted, accounts.length);
    if (taxDiagnostic) message += ` — ${taxDiagnostic}`;
    if (autoPostReport.failed > 0) {
      message += ` — ${plural(autoPostReport.failed, 'auto-post failure')}`;
    }
    await prisma.syncLog.create({ data: { companyId, kind, ok: true, message } });
    return { ok: true, message, mirror: mirrorStats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.syncLog
      .create({ data: { companyId, kind, ok: false, message } })
      .catch(() => undefined);
    // The setup wizard needs the initial sync to fail loudly; scheduled syncs
    // report through the sync log instead of crashing the scheduler.
    if (kind === 'initial') throw err;
    return { ok: false, message };
  }
}
