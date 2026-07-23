// Sync engine (specs §3).
//
// Per run: refresh the chart of accounts, pull holding-account transactions
// (full list for manual/initial/nightly, Change Data Capture deltas for
// poll/webhook), upsert on (companyId, qboType, qboId), mark txns that were
// fixed inside QuickBooks as SUPERSEDED, recompute suggestion snapshots, apply
// auto-post rules, and record a SyncLog row. QBO is always the source of truth.

import { Prisma, type PrismaClient } from '@prisma/client';
import type { SuggestionDto } from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import type { QboTxn } from '../lib/qbo/types.js';
import {
  AGENT_COMPANY_LEASE_MS,
  acquireCompanyWriteLease,
  enqueueEligibleTransactions,
  releaseCompanyWriteLease,
} from './agent/jobs.js';
import { stageCategorization } from './categorization.js';
import { refreshSuggestions } from './suggestions.js';
import { createDeferredRetryScheduler } from './syncRetry.js';
import {
  clearRuleWriteRetryPending,
  markRuleWriteRetryPending,
} from './ruleWriteRetry.js';
import { refreshTaxReference } from './tax/reference.js';
import {
  completeSourcePurchaseTaxDefault,
  sourcePurchaseTaxSelection,
} from './tax/sourceDefault.js';
import { postTransaction } from './writeback.js';
import type { AuditInput } from './audit.js';

export type SyncKind = 'poll' | 'webhook' | 'manual' | 'nightly' | 'initial';

export interface SyncResult {
  ok: boolean;
  message: string;
}

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function buildMessage(
  created: number,
  dropped: number,
  autoPosted: number,
  accountCount: number,
  agentQueued = 0,
): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new ${created === 1 ? 'transaction' : 'transactions'}`);
  if (dropped > 0) parts.push(`${dropped} dropped (categorized in QBO)`);
  if (autoPosted > 0) parts.push(`${autoPosted} auto-posted`);
  if (agentQueued > 0) parts.push(`${agentQueued} autopilot ${agentQueued === 1 ? 'job' : 'jobs'} queued`);
  if (parts.length === 0) return `Chart of accounts refreshed — ${plural(accountCount, 'account')}`;
  return parts.join(', ');
}

interface SupersedeDeps {
  db: PrismaClient;
  audit(tx: Prisma.TransactionClient, entry: AuditInput): Promise<unknown>;
}

/**
 * SUPERSEDED + audit, atomically. An unresolved restore is deliberately left
 * in ERROR: absence from the holding account proves neither that the undo
 * landed nor that the original categorized state remained unchanged.
 */
export async function supersedeTxn(
  txn: { id: string; companyId: string; payee: string; amount: Prisma.Decimal },
  holdingName: string,
  suppliedDeps?: SupersedeDeps,
): Promise<boolean> {
  const deps: SupersedeDeps =
    suppliedDeps ??
    {
      db: prisma,
      audit: (await import('./audit.js')).writeAudit,
    };
  return deps.db.$transaction(async (tx) => {
    const unresolvedRestore = await tx.qboMutationAttempt.findFirst({
      where: {
        transactionId: txn.id,
        operation: 'restore',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      select: { id: true },
    });
    if (unresolvedRestore) return false;
    await tx.qboMutationAttempt.updateMany({
      where: {
        transactionId: txn.id,
        operation: 'recategorize',
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
      data: { status: 'RECONCILED' },
    });
    await tx.transaction.update({ where: { id: txn.id }, data: { status: 'SUPERSEDED' } });
    await deps.audit(tx, {
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
  });
}

/**
 * QBO's CDC window is 30 days — past ~25 we stop trusting deltas and fall back
 * to a full sweep rather than risk missing changes near the edge.
 */
const CDC_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;
const COMPANY_WRITE_LEASE_RENEW_MS = 30_000;
const RULE_WRITE_RETRY_MS = 30_000;

/**
 * Per-company in-flight mutex: manual, webhook, and poll syncs serialize
 * instead of interleaving their upserts and supersede sweeps.
 */
const inFlightSyncs = new Map<string, Promise<unknown>>();

export function syncCompany(companyId: string, kind: SyncKind): Promise<SyncResult> {
  const prev = inFlightSyncs.get(companyId) ?? Promise.resolve();
  const run = prev.then(
    () => runSyncCompany(companyId, kind),
    () => runSyncCompany(companyId, kind),
  );
  inFlightSyncs.set(companyId, run);
  run
    .catch(() => undefined)
    .finally(() => {
      if (inFlightSyncs.get(companyId) === run) inFlightSyncs.delete(companyId);
    });
  return run;
}

const deferredRuleSyncs = createDeferredRetryScheduler(
  (companyId) => syncCompany(companyId, 'poll'),
  {
    delayMs: RULE_WRITE_RETRY_MS,
    onError: (companyId, error) => {
      console.error(`[sync] deferred rule retry failed for ${companyId}:`, error);
    },
  },
);

async function runSyncCompany(companyId: string, kind: SyncKind): Promise<SyncResult> {
  const startedAt = new Date();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found`);

  try {
    const { qboFactory } = await import('../lib/qbo/factory.js');
    const client = await qboFactory.forCompany(companyId);

    // ---- 1. chart of accounts (reference data for pickers + name resolution) ----
    const accounts = await client.listAccounts();
    for (const a of accounts) {
      // Store the display path with ' · ' separators ("Expenses · Meals"),
      // converted from QBO's colon-style FullyQualifiedName.
      const fullName = a.fullName.split(':').join(' · ');
      await prisma.qboAccount.upsert({
        where: { companyId_qboId: { companyId, qboId: a.qboId } },
        create: {
          companyId,
          qboId: a.qboId,
          name: a.name,
          fullName,
          classification: a.classification,
          accountType: a.accountType,
          active: a.active,
        },
        update: {
          name: a.name,
          fullName,
          classification: a.classification,
          accountType: a.accountType,
          active: a.active,
        },
      });
    }

    // TaxCode/TaxRate are reference entities outside CDC. Keep their
    // company-scoped mirror warm without making a tax-reference outage block
    // the existing category-only sync path.
    await refreshTaxReference(companyId, {}, {
      db: prisma,
      getClient: async () => client,
      now: () => startedAt,
    }).catch((err) => {
      console.warn(`[sync] tax reference refresh failed for ${companyId}:`, err);
    });
    const sourceTaxCodes = await prisma.qboTaxCode.findMany({
      where: { companyId, active: true },
      select: {
        qboId: true,
        name: true,
        active: true,
        taxable: true,
        purchaseTaxRateList: true,
      },
    });

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
      const sourceTaxDefault = completeSourcePurchaseTaxDefault(
        sourcePurchaseTaxSelection(t.qboType, t.raw, holdingIds),
        sourceTaxCodes,
      );
      const row = await prisma.transaction.upsert({
        where: { companyId_qboType_qboId: { companyId, qboType: t.qboType, qboId: t.qboId } },
        create: {
          companyId,
          qboId: t.qboId,
          qboType: t.qboType,
          status: 'PENDING',
          ...mirror,
          ...(sourceTaxDefault ?? {}),
        },
        update: mirror,
      });
      if (sourceTaxDefault) {
        // Fill only an untouched, still-open tax decision. Human/rule/agent
        // staging and completed dry/live posts remain authoritative.
        await prisma.transaction.updateMany({
          where: {
            id: row.id,
            status: { in: ['PENDING', 'ERROR'] },
            taxCalculation: null,
            taxCodeQboId: null,
          },
          data: sourceTaxDefault,
        });
      }
      if (!existingKeys.has(`${t.qboType}:${t.qboId}`)) created += 1;
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
        if (await supersedeTxn(txn, holdingName)) dropped += 1;
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
          if (await supersedeTxn(txn, holdingName)) dropped += 1;
        }
      }
    }

    // ---- 5. suggestion snapshots for the queue ----
    await refreshSuggestions(companyId);

    // ---- 6. auto-post rules (respects dry-run via the write-back service) ----
    let autoPosted = 0;
    const autoPostFailures: string[] = [];
    const pending = await prisma.transaction.findMany({
      where: { companyId, status: 'PENDING' },
      include: { txnTags: true, _count: { select: { splitLines: true } } },
    });
    const rules = await prisma.rule.findMany({ where: { companyId }, include: { ruleTags: true } });
    const syncWriteOwner = `sync:${kind}:${companyId}:${randomUUID()}`;
    let writeLeaseHeld = false;
    let writeLeaseLost = false;
    let writeLeaseValidUntilMs = 0;
    let ruleWriteDeferred = false;
    let leaseRenewalTimer: NodeJS.Timeout | null = null;
    let leaseRenewalInFlight: Promise<void> | null = null;
    const revalidateWriteLease = async (): Promise<boolean> => {
      await leaseRenewalInFlight;
      if (writeLeaseLost || !writeLeaseHeld) return false;
      try {
        const renewed = await acquireCompanyWriteLease(companyId, syncWriteOwner);
        if (!renewed) {
          writeLeaseLost = true;
          return false;
        }
        writeLeaseValidUntilMs = Date.now() + AGENT_COMPANY_LEASE_MS;
        return true;
      } catch (error) {
        writeLeaseLost = true;
        console.error(`[sync] company write lease revalidation failed for ${companyId}:`, error);
        return false;
      }
    };
    const startLeaseHeartbeat = () => {
      if (leaseRenewalTimer) return;
      leaseRenewalTimer = setInterval(() => {
        if (leaseRenewalInFlight) return;
        let renewal!: Promise<void>;
        renewal = acquireCompanyWriteLease(companyId, syncWriteOwner)
          .then((renewed) => {
            if (!renewed) {
              writeLeaseLost = true;
            } else {
              writeLeaseValidUntilMs = Date.now() + AGENT_COMPANY_LEASE_MS;
            }
          })
          .catch((error) => {
            writeLeaseLost = true;
            console.error(`[sync] company write lease renewal failed for ${companyId}:`, error);
          })
          .finally(() => {
            if (leaseRenewalInFlight === renewal) leaseRenewalInFlight = null;
          });
        leaseRenewalInFlight = renewal;
        void renewal;
      }, COMPANY_WRITE_LEASE_RENEW_MS);
      leaseRenewalTimer.unref?.();
    };
    try {
      for (const txn of pending) {
        const suggestion = txn.suggestion as unknown as SuggestionDto | null;
        if (!suggestion || suggestion.source !== 'rule' || !suggestion.ruleId) continue;
        const rule = rules.find((r) => r.id === suggestion.ruleId);
        if (!rule?.autoPost) continue;
        // In a tax-ready company, a Purchase rule must carry a complete tax
        // decision before it can auto-post. Legacy category-only rules continue
        // suggesting but stop at the queue.
        if (
          txn.qboType === 'Purchase' &&
          company.taxSupportStatus === 'ready' &&
          (!rule.taxCalculation || !rule.taxCodeQboId)
        ) {
          continue;
        }
        // A human is mid-flight on this txn (staged category/splits/tags) —
        // never auto-post over their work.
        if (txn.category !== null || txn._count.splitLines > 0 || txn.txnTags.length > 0) continue;
        // Deterministic rule posting and autopilot share one company write
        // lease. If an agent owns it, defer rule writes until the next sync
        // rather than race two staging/posting paths.
        if (
          writeLeaseLost ||
          (writeLeaseHeld && Date.now() >= writeLeaseValidUntilMs)
        ) {
          ruleWriteDeferred = true;
          await markRuleWriteRetryPending(
            companyId,
            new Date(Date.now() + RULE_WRITE_RETRY_MS),
          );
          break;
        }
        const leaseAcquired = await acquireCompanyWriteLease(companyId, syncWriteOwner);
        if (!leaseAcquired) {
          ruleWriteDeferred = true;
          await markRuleWriteRetryPending(
            companyId,
            new Date(Date.now() + RULE_WRITE_RETRY_MS),
          );
          break;
        }
        writeLeaseHeld = true;
        writeLeaseValidUntilMs = Date.now() + AGENT_COMPANY_LEASE_MS;
        startLeaseHeartbeat();
        const freshCompany = await prisma.company.findUnique({
          where: { id: companyId },
          select: { disconnectedAt: true },
        });
        if (!freshCompany || freshCompany.disconnectedAt !== null) {
          break;
        }
        // One bad rule/txn must never kill the sync: post each in its own
        // try/catch, log, note it in the SyncLog, and continue.
        try {
          // Stage through the same company-scoped boundary as humans/agents.
          const staged = await stageCategorization(
            prisma,
            txn.id,
            {
              category: rule.category,
              categoryQboId: rule.categoryQboId,
              taxCalculation: rule.taxCalculation as 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable' | null,
              taxCode: rule.taxCode,
              taxCodeQboId: rule.taxCodeQboId,
              tagIds: rule.ruleTags.map((ruleTag) => ruleTag.tagId),
            },
            {
              actor: { id: null, label: 'system' },
              source: 'rule',
              expectedUpdatedAt: txn.updatedAt,
            },
          );
          const result = await postTransaction(
            txn.id,
            { id: null, label: 'system' },
            {
              auto: true,
              expectedUpdatedAt: staged.updatedAt,
              canWrite: revalidateWriteLease,
            },
          );
          if (result.ok) autoPosted += 1;
          else autoPostFailures.push(`${txn.payee}: ${result.error?.message ?? 'unknown error'}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[sync] auto-post failed for txn ${txn.id} (${txn.payee}):`, err);
          autoPostFailures.push(`${txn.payee}: ${msg}`);
        }
      }
    } finally {
      if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
      await leaseRenewalInFlight;
      if (writeLeaseHeld) {
        await releaseCompanyWriteLease(companyId, syncWriteOwner);
      }
    }
    if (ruleWriteDeferred) {
      deferredRuleSyncs.schedule(companyId);
    } else {
      await clearRuleWriteRetryPending(companyId, company.ruleWriteRetryAt);
    }

    // ---- 7. enqueue durable autopilot work after deterministic rules ----
    // Enqueueing is local-only and already excludes every current rule match.
    // Always perform it even when a competing writer deferred rule auto-posts;
    // webhook-only companies may not receive another sync to repair omissions.
    let agentQueued = 0;
    try {
      const enqueued = await enqueueEligibleTransactions(companyId);
      agentQueued = enqueued.created + enqueued.reset;
    } catch (err) {
      console.error(`[sync] autopilot enqueue failed for company ${companyId}:`, err);
      autoPostFailures.push(
        `autopilot enqueue: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ---- 8. bookkeeping ----
    await prisma.company.update({ where: { id: companyId }, data: { lastSyncedAt: startedAt } });
    let message = buildMessage(created, dropped, autoPosted, accounts.length, agentQueued);
    if (autoPostFailures.length > 0) {
      message += ` — ${plural(autoPostFailures.length, 'auto-post failure')} (${autoPostFailures[0]})`;
    }
    await prisma.syncLog.create({ data: { companyId, kind, ok: true, message } });
    return { ok: true, message };
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
