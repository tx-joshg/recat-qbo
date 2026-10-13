// Background jobs: polling sync loop, nightly reconcile, daily digest, and the
// stuck-POSTING sweep (boot + every tick).
// A single 60-second ticker drives them; per-company syncs never overlap
// (in-flight set) and the dailies are guarded by a last-run date, claimed in
// the database, so they fire once per day even across several instances.

import { env } from '../env.js';
import { isSmtpConfigured, sendMail } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../services/audit.js';
import {
  runAgentTick,
  startAgentScheduler,
  stopAgentScheduler,
} from '../services/agent/scheduler.js';
import { syncCompany, type SyncKind } from '../services/sync.js';
import { runAttachmentCleanup } from '../services/attachments/cleanup.js';
import { recoverStuckAttachmentOperations } from '../services/attachments/operations.js';
import { runReceiptTick as processReceiptTick } from '../services/receipts/worker.js';
import { resolvePublicUrl } from '../services/publicUrl.js';
import { sweepQboTokenRevocations } from '../services/qboTokenRevocation.js';

const TICK_MS = 60_000;
const NIGHTLY_HOUR = 2;
const STUCK_POSTING_MS = 5 * 60 * 1000;
const SLACK_TIMEOUT_MS = 10_000;

let ticker: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();
let lastNightlyDate = '';
let lastDigestDate = '';
let receiptTickInFlight = false;

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
      const swept = await prisma.$transaction(async (tx) => {
        // Re-check the status in the write itself: the post may have finished
        // (or another instance swept it) between the read above and now.
        const moved = await tx.transaction.updateMany({
          where: { id: txn.id, status: 'POSTING', updatedAt: { lt: cutoff } },
          data: { status: 'ERROR', errorCode: 'STUCK_POSTING', errorMessage: STUCK_POSTING_MESSAGE },
        });
        if (moved.count === 0) return false;
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
        return true;
      });
      if (!swept) continue;
      console.warn(`[jobs] stuck POSTING txn ${txn.id} (${txn.payee}) moved to ERROR`);
    } catch (err) {
      console.error(`[jobs] could not sweep stuck POSTING txn ${txn.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Once-a-day claims — the in-process date guards stop a single process from
// repeating a daily job, but several app instances sharing one database would
// each run it. The run is claimed with one atomic upsert on AppConfig and
// marked done when it finishes. A claim whose instance died before finishing
// is reclaimable once its 15-minute lease runs out, so a crash does not skip
// the day.
// ---------------------------------------------------------------------------

export type DailyRunClaim = 'claimed' | 'done' | 'busy';

export async function claimDailyRun(job: 'nightly' | 'digest', day: string): Promise<DailyRunClaim> {
  const key = `jobs.lastRun.${job}`;
  const claimed = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "AppConfig" ("key", "value", "encrypted", "updatedAt")
    VALUES (${key}, ${`${day}|running`}, false, now())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "updatedAt" = now()
      WHERE split_part("AppConfig"."value", '|', 1) <> ${day}
         OR (
           split_part("AppConfig"."value", '|', 2) = 'running'
           AND "AppConfig"."updatedAt" < now() - interval '15 minutes'
         )
    RETURNING "key"`;
  if (claimed.length === 1) return 'claimed';
  const row = await prisma.appConfig.findUnique({ where: { key } });
  return row?.value === `${day}|running` ? 'busy' : 'done';
}

export async function completeDailyRun(job: 'nightly' | 'digest', day: string): Promise<void> {
  await prisma.appConfig.updateMany({
    where: { key: `jobs.lastRun.${job}`, value: `${day}|running` },
    data: { value: `${day}|done` },
  });
}

/**
 * Runs `work` at most once per day across instances. Returns true once the
 * day's run is settled here (ran, or another instance already finished it);
 * false while another instance holds the claim, so the caller tries again on
 * a later tick.
 */
async function runDailyOnce(
  job: 'nightly' | 'digest',
  day: string,
  work: () => Promise<void>,
): Promise<boolean> {
  const claim = await claimDailyRun(job, day);
  if (claim === 'busy') return false;
  if (claim === 'claimed') {
    await work();
    await completeDailyRun(job, day);
  }
  return true;
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

// ---------------------------------------------------------------------------
// Nightly reconcile (02:00 server time) — full sweep catches txns fixed
// directly inside QuickBooks (SUPERSEDED detection).
// ---------------------------------------------------------------------------

async function nightlyTick(now: Date): Promise<void> {
  if (now.getHours() !== NIGHTLY_HOUR || lastNightlyDate === dateKey(now)) return;
  const settled = await runDailyOnce('nightly', dateKey(now), async () => {
    const companies = await prisma.company.findMany({ where: { disconnectedAt: null } });
    for (const c of companies) runSync(c.id, 'nightly');
  });
  if (settled) lastNightlyDate = dateKey(now);
}

// ---------------------------------------------------------------------------
// Daily digest (env.DIGEST_HOUR)
// ---------------------------------------------------------------------------

async function digestTick(now: Date): Promise<void> {
  if (now.getHours() !== env.DIGEST_HOUR || lastDigestDate === dateKey(now)) return;
  if (await runDailyOnce('digest', dateKey(now), sendDigest)) lastDigestDate = dateKey(now);
}

async function sendDigest(): Promise<void> {
  const companies = await prisma.company.findMany({ where: { disconnectedAt: null } });
  const lines: string[] = [];
  for (const c of companies) {
    const count = await prisma.transaction.count({ where: { companyId: c.id, status: 'PENDING' } });
    if (count > 0) {
      lines.push(`${count} transaction${count === 1 ? '' : 's'} waiting in ${c.nickname}`);
    }
  }
  if (lines.length === 0) return;

  const text = `${lines.join('\n')}\n\nCategorize them: ${await resolvePublicUrl()}`;

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
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch (err) {
      console.error('[jobs] digest Slack notification failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------

export async function runReceiptTick(): Promise<void> {
  if (receiptTickInFlight) return;
  receiptTickInFlight = true;
  try {
    await processReceiptTick();
  } finally {
    receiptTickInFlight = false;
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  try {
    await sweepQboTokenRevocations();
  } catch {
    console.error('[jobs] disconnect revocation recovery failed');
  }
  try {
    await recoverStuckAttachmentOperations({ now });
  } catch {
    console.error('[jobs] attachment recovery failed');
  }
  try {
    await runAttachmentCleanup({ now });
  } catch {
    console.error('[jobs] attachment cleanup failed');
  }
  try {
    await sweepStuckPosting();
    await pollTick(now);
    await nightlyTick(now);
    await digestTick(now);
  } catch (err) {
    console.error('[jobs] scheduler tick failed:', err);
  }
  try {
    await runAgentTick();
  } catch {
    console.error('[jobs] agent scheduler tick failed');
  }
  try {
    await runReceiptTick();
  } catch {
    console.error('[jobs] receipt scheduler tick failed');
  }
}

export function startJobs(): void {
  if (ticker !== null) return;
  startAgentScheduler();
  sweepQboTokenRevocations().catch(() => console.error('[jobs] boot disconnect revocation recovery failed'));
  // Boot sweep: recover anything a previous process left mid-post.
  sweepStuckPosting().catch((err) => console.error('[jobs] boot stuck-POSTING sweep failed:', err));
  recoverStuckAttachmentOperations()
    .catch(() => console.error('[jobs] attachment recovery failed'));
  runAttachmentCleanup().catch(() => console.error('[jobs] attachment cleanup failed'));
  runAgentTick().catch(() => console.error('[jobs] boot agent scheduler tick failed'));
  runReceiptTick().catch(() => console.error('[jobs] boot receipt scheduler tick failed'));
  ticker = setInterval(() => void tick(), TICK_MS);
  // Node should still exit cleanly if the server is stopped.
  ticker.unref();
  console.log(
    `[jobs] scheduler started — polling every ${TICK_MS / 1000}s, nightly reconcile at ${String(NIGHTLY_HOUR).padStart(2, '0')}:00, digest at ${String(env.DIGEST_HOUR).padStart(2, '0')}:00`,
  );
}

export function stopJobs(): void {
  stopAgentScheduler();
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}
