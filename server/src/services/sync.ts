// Sync engine (specs §3).
//
// Per run: refresh the chart of accounts, pull holding-account transactions
// (full list for manual/initial/nightly, Change Data Capture deltas for
// poll/webhook), upsert on (companyId, qboType, qboId), mark txns that were
// fixed inside QuickBooks as SUPERSEDED, recompute suggestion snapshots, apply
// auto-post rules, and record a SyncLog row. QBO is always the source of truth.

import { Prisma } from '@prisma/client';
import type { SuggestionDto } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import type { QboTxn } from '../lib/qbo/types.js';
import { refreshSuggestions } from './suggestions.js';
import { postTransaction } from './writeback.js';

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

function buildMessage(created: number, dropped: number, autoPosted: number, accountCount: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new ${created === 1 ? 'transaction' : 'transactions'}`);
  if (dropped > 0) parts.push(`${dropped} dropped (categorized in QBO)`);
  if (autoPosted > 0) parts.push(`${autoPosted} auto-posted`);
  if (parts.length === 0) return `Chart of accounts refreshed — ${plural(accountCount, 'account')}`;
  return parts.join(', ');
}

/** SUPERSEDED + audit, atomically. Lazy audit import (other agent's module). */
async function supersedeTxn(
  txn: { id: string; companyId: string; payee: string; amount: Prisma.Decimal },
  holdingName: string,
): Promise<void> {
  const { writeAudit } = await import('./audit.js');
  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({ where: { id: txn.id }, data: { status: 'SUPERSEDED' } });
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
  });
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
      await prisma.transaction.upsert({
        where: { companyId_qboType_qboId: { companyId, qboType: t.qboType, qboId: t.qboId } },
        create: { companyId, qboId: t.qboId, qboType: t.qboType, status: 'PENDING', ...mirror },
        update: mirror,
      });
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
        await supersedeTxn(txn, holdingName);
        dropped += 1;
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
          await supersedeTxn(txn, holdingName);
          dropped += 1;
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
    for (const txn of pending) {
      const suggestion = txn.suggestion as unknown as SuggestionDto | null;
      if (!suggestion || suggestion.source !== 'rule' || !suggestion.ruleId) continue;
      const rule = rules.find((r) => r.id === suggestion.ruleId);
      if (!rule?.autoPost) continue;
      // A human is mid-flight on this txn (staged category/splits/tags) —
      // never auto-post over their work.
      if (txn.category !== null || txn._count.splitLines > 0 || txn.txnTags.length > 0) continue;
      // One bad rule/txn must never kill the sync: post each in its own
      // try/catch, log, note it in the SyncLog, and continue.
      try {
        // Stage the rule's category + tags, then post as 'system'.
        await prisma.transaction.update({
          where: { id: txn.id },
          data: { category: rule.category, categoryQboId: rule.categoryQboId },
        });
        for (const rt of rule.ruleTags) {
          await prisma.txnTag.upsert({
            where: { txnId_tagId: { txnId: txn.id, tagId: rt.tagId } },
            create: { txnId: txn.id, tagId: rt.tagId },
            update: {},
          });
        }
        const result = await postTransaction(txn.id, { id: null, label: 'system' }, { auto: true });
        if (result.ok) autoPosted += 1;
        else autoPostFailures.push(`${txn.payee}: ${result.error?.message ?? 'unknown error'}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync] auto-post failed for txn ${txn.id} (${txn.payee}):`, err);
        autoPostFailures.push(`${txn.payee}: ${msg}`);
      }
    }

    // ---- 7. bookkeeping ----
    await prisma.company.update({ where: { id: companyId }, data: { lastSyncedAt: startedAt } });
    let message = buildMessage(created, dropped, autoPosted, accounts.length);
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
