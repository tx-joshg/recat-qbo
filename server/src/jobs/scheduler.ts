// Background jobs: polling sync loop, nightly reconcile, daily digest, and the
// stuck-POSTING sweep (boot + every tick).
// A single 60-second ticker drives them; per-company syncs never overlap
// (in-flight set) and the dailies are guarded by a last-run date so they fire
// exactly once per day even though the ticker runs every minute.

import { env } from '../env.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isSmtpConfigured, sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import {
  requeueStaleAgentJobs,
  sweepExpiredAgentLeases,
} from '../services/agent/jobs.js';
import { sweepPendingAutopilotReconciliations } from '../services/agent/reconciliation.js';
import { runAgentWorkerBatch } from '../services/agent/worker.js';
import { writeAudit } from '../services/audit.js';
import { sweepPendingQboDisconnects } from '../services/qboDisconnect.js';
import { dueRuleWriteRetryCompanyIds } from '../services/ruleWriteRetry.js';
import {
  syncCompany,
  type SyncKind,
} from '../services/sync.js';

const TICK_MS = 60_000;
const NIGHTLY_HOUR = 2;
const STUCK_POSTING_MS = 5 * 60 * 1000;

let ticker: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();
let lastNightlyDate = '';
let lastDigestDate = '';
const agentWorkerId = `${hostname()}:${process.pid}:${randomUUID()}`;
let agentWorkerInFlight = false;

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Run one sync for a company unless one is already in flight for it. */
function runSync(companyId: string, kind: SyncKind): void {
  if (inFlight.has(companyId)) return;
  inFlight.add(companyId);
  syncCompany(companyId, kind)
    .catch((err) => console.error(`[jobs] ${kind} sync failed for ${companyId}:`, err))
    .finally(() => inFlight.delete(companyId));
}

// ---------------------------------------------------------------------------
// Stuck-POSTING sweep — a crash/restart mid-post leaves a txn in POSTING with
// no way to know whether QuickBooks accepted the write. Anything sitting in
// POSTING for over 5 minutes moves to ERROR with an explicit "go verify"
// message (+ audit), so nothing silently rots in a transient state.
// ---------------------------------------------------------------------------

const STUCK_POSTING_MESSAGE = 'Server restarted mid-post — verify this transaction in QuickBooks, then retry.';

export async function sweepStuckPosting(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_POSTING_MS);
  const stuck = await prisma.transaction.findMany({
    where: { status: 'POSTING', updatedAt: { lt: cutoff } },
  });
  for (const txn of stuck) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: txn.id },
          data: { status: 'ERROR', errorCode: 'STUCK_POSTING', errorMessage: STUCK_POSTING_MESSAGE },
        });
        await writeAudit(tx, {
          companyId: txn.companyId,
          actorId: null,
          actorLabel: 'system',
          txnId: txn.id,
          payee: txn.payee,
          amount: Number(txn.amount),
          action: 'error',
          before: 'POSTING (stuck)',
          after: STUCK_POSTING_MESSAGE,
        });
      });
      console.warn(`[jobs] stuck POSTING txn ${txn.id} (${txn.payee}) moved to ERROR`);
    } catch (err) {
      console.error(`[jobs] could not sweep stuck POSTING txn ${txn.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function pollTick(now: Date): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { syncMode: 'polling', disconnectedAt: null },
  });
  for (const c of companies) {
    const intervalMs = Math.max(c.pollIntervalMin, 1) * 60_000;
    const due = c.lastSyncedAt === null || now.getTime() - c.lastSyncedAt.getTime() >= intervalMs;
    if (due) runSync(c.id, 'poll');
  }
}

async function deferredRuleWriteTick(now: Date): Promise<void> {
  const companyIds = await dueRuleWriteRetryCompanyIds(now);
  for (const companyId of companyIds) runSync(companyId, 'poll');
}

// ---------------------------------------------------------------------------
// Nightly reconcile (02:00 server time) — full sweep catches txns fixed
// directly inside QuickBooks (SUPERSEDED detection).
// ---------------------------------------------------------------------------

async function nightlyTick(now: Date): Promise<void> {
  if (now.getHours() !== NIGHTLY_HOUR || lastNightlyDate === dateKey(now)) return;
  lastNightlyDate = dateKey(now);
  const companies = await prisma.company.findMany({ where: { disconnectedAt: null } });
  for (const c of companies) runSync(c.id, 'nightly');
}

// ---------------------------------------------------------------------------
// Daily digest (env.DIGEST_HOUR)
// ---------------------------------------------------------------------------

async function digestTick(now: Date): Promise<void> {
  if (now.getHours() !== env.DIGEST_HOUR || lastDigestDate === dateKey(now)) return;
  lastDigestDate = dateKey(now);

  const companies = await prisma.company.findMany({ where: { disconnectedAt: null } });
  const lines: string[] = [];
  for (const c of companies) {
    const count = await prisma.transaction.count({ where: { companyId: c.id, status: 'PENDING' } });
    if (count > 0) {
      lines.push(`${count} transaction${count === 1 ? '' : 's'} waiting in ${c.nickname}`);
    }
  }
  if (lines.length === 0) return;

  const text = `${lines.join('\n')}\n\nCategorize them: ${env.APP_URL}`;

  // Email every active (non-pending-invite) user. Skip silently without SMTP —
  // the console-fallback mailer would just be log noise every morning.
  if (await isSmtpConfigured()) {
    const users = await prisma.user.findMany({ where: { invitePending: false } });
    for (const user of users) {
      try {
        await sendMail({ to: user.email, subject: 'Recat daily digest', text });
      } catch (err) {
        console.error(`[jobs] digest email to ${user.email} failed:`, err);
      }
    }
  }

  if (env.SLACK_WEBHOOK_URL !== '') {
    try {
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error('[jobs] digest Slack notification failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const now = new Date();
  try {
    await sweepStuckPosting();
    await sweepExpiredAgentLeases(now);
    await sweepPendingQboDisconnects();
    await requeueStaleAgentJobs();
    await sweepPendingAutopilotReconciliations();
    if (!agentWorkerInFlight) {
      agentWorkerInFlight = true;
      void runAgentWorkerBatch(agentWorkerId)
        .catch((err) => console.error('[jobs] autopilot worker failed:', err))
        .finally(() => {
          agentWorkerInFlight = false;
        });
    }
    await deferredRuleWriteTick(now);
    await pollTick(now);
    await nightlyTick(now);
    await digestTick(now);
  } catch (err) {
    console.error('[jobs] scheduler tick failed:', err);
  }
}

export function startJobs(): void {
  if (ticker !== null) return;
  // Boot sweep: recover anything a previous process left mid-post.
  sweepStuckPosting().catch((err) => console.error('[jobs] boot stuck-POSTING sweep failed:', err));
  sweepExpiredAgentLeases().catch((err) =>
    console.error('[jobs] boot agent-lease sweep failed:', err),
  );
  sweepPendingQboDisconnects().catch((err) =>
    console.error('[jobs] boot QuickBooks disconnect sweep failed:', err),
  );
  requeueStaleAgentJobs().catch((err) =>
    console.error('[jobs] boot stale-agent-job recovery failed:', err),
  );
  sweepPendingAutopilotReconciliations().catch((err) =>
    console.error('[jobs] boot autopilot reconciliation failed:', err),
  );
  dueRuleWriteRetryCompanyIds()
    .then((companyIds) => {
      for (const companyId of companyIds) runSync(companyId, 'poll');
    })
    .catch((err) => console.error('[jobs] boot deferred-rule recovery failed:', err));
  agentWorkerInFlight = true;
  void runAgentWorkerBatch(agentWorkerId)
    .catch((err) => console.error('[jobs] boot autopilot worker failed:', err))
    .finally(() => {
      agentWorkerInFlight = false;
    });
  ticker = setInterval(() => void tick(), TICK_MS);
  // Node should still exit cleanly if the server is stopped.
  ticker.unref();
  console.log(
    `[jobs] scheduler started — polling every ${TICK_MS / 1000}s, nightly reconcile at ${String(NIGHTLY_HOUR).padStart(2, '0')}:00, digest at ${String(env.DIGEST_HOUR).padStart(2, '0')}:00`,
  );
}

export function stopJobs(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}
