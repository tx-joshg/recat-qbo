// Transfer detection + recording.
//
// Detection (handoff §2): among uncategorized PENDING txns, a pair with equal
// |amount|, opposite sign, different bank accounts, and dates ≤ 3 days apart is
// presented as a transfer candidate.
//
// Recording (v1 decision): rather than creating a separate QBO Transfer entity
// AND leaving the two source txns in the holding account (which would double
// the books), we recategorize each txn's holding line to the OTHER txn's bank
// account — which is exactly what a transfer is in double-entry: the checking
// withdrawal's line posts to the credit-card account and vice versa. The two
// existing entities become the two legs; no extra Transfer entity is created.

import type { PrismaClient, Prisma } from '@prisma/client';
import type { AuditAction, TxnStatus } from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import type { QboClient, QboTxn } from '../lib/qbo/types.js';
import type { Actor } from './writeback.js';

// ---------------------------------------------------------------------------
// Pure pairing logic (unit-tested)
// ---------------------------------------------------------------------------

export interface PairableTxn {
  id: string;
  /** signed; + = money in */
  amount: number;
  bankAccount: string;
  date: Date;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export function isTransferPair(a: PairableTxn, b: PairableTxn): boolean {
  return (
    a.amount !== 0 &&
    Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) < 0.005 &&
    Math.sign(a.amount) !== Math.sign(b.amount) &&
    a.bankAccount !== b.bankAccount &&
    Math.abs(a.date.getTime() - b.date.getTime()) <= THREE_DAYS_MS
  );
}

/**
 * Greedy pairing in date order; each txn pairs at most once. The returned map
 * contains both directions (txnId → counterpartId and back).
 */
export function pairTransfers(txns: PairableTxn[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a || used.has(a.id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b || used.has(b.id)) continue;
      if (isTransferPair(a, b)) {
        pairs.set(a.id, b.id);
        pairs.set(b.id, a.id);
        used.add(a.id);
        used.add(b.id);
        break;
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** txnId → counterpart txnId, among uncategorized PENDING txns. */
export async function transferCandidates(companyId: string): Promise<Map<string, string>> {
  const rows = await prisma.transaction.findMany({
    // Uncategorized = no single category staged AND no split lines staged.
    where: { companyId, status: 'PENDING', category: null, splitLines: { none: {} } },
    select: { id: true, amount: true, bankAccount: true, date: true },
  });
  const pairable: PairableTxn[] = rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    bankAccount: r.bankAccount,
    date: r.date,
  }));
  return pairTransfers(pairable);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

interface AuditEntryInput {
  companyId: string;
  actorId?: string | null;
  actorLabel: string;
  txnId?: string;
  payee: string;
  amount: number;
  action: AuditAction;
  before: string;
  after: string;
  payload?: unknown;
}

type AuditFn = (txOrPrisma: Prisma.TransactionClient | PrismaClient, entry: AuditEntryInput) => Promise<unknown>;

export interface CounterpartAccountLike {
  qboId: string;
  name: string;
  active: boolean;
}

/**
 * Resolve a transfer leg's counterpart bank account by display name. Only
 * active accounts count, and an ambiguous name fails loudly — guessing here
 * would move money to the wrong ledger account. (Pure; unit-tested.)
 */
export function pickCounterpartAccount(
  accounts: CounterpartAccountLike[],
  name: string,
): CounterpartAccountLike {
  const matches = accounts.filter((a) => a.active && a.name === name);
  const first = matches[0];
  if (!first) {
    throw new Error(`Bank account "${name}" not found in the chart of accounts — re-sync first.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Bank account "${name}" is ambiguous — ${matches.length} active accounts share that name. Rename one in QuickBooks and re-sync.`,
    );
  }
  return first;
}

async function firstHoldingName(companyId: string, holdingIds: string[]): Promise<string> {
  const first = holdingIds[0];
  if (!first) return 'Holding account';
  const row = await prisma.qboAccount.findFirst({ where: { companyId, qboId: first } });
  return row?.name ?? 'Holding account';
}

export async function recordTransfer(
  txnId: string,
  counterpartId: string,
  actor: Actor,
): Promise<{ status: TxnStatus }> {
  if (txnId === counterpartId) throw new Error('A transaction cannot be its own transfer counterpart.');

  const [a, b] = await Promise.all([
    prisma.transaction.findUnique({ where: { id: txnId }, include: { company: true } }),
    prisma.transaction.findUnique({ where: { id: counterpartId }, include: { company: true } }),
  ]);
  if (!a || !b) throw new Error('Transfer transaction not found');
  if (a.companyId !== b.companyId) throw new Error('Transfer legs must belong to the same company');
  if (a.status !== 'PENDING' || b.status !== 'PENDING') {
    throw new Error('Both transactions must be pending to record a transfer');
  }
  const pairA: PairableTxn = { id: a.id, amount: Number(a.amount), bankAccount: a.bankAccount, date: a.date };
  const pairB: PairableTxn = { id: b.id, amount: Number(b.amount), bankAccount: b.bankAccount, date: b.date };
  if (!isTransferPair(pairA, pairB)) {
    throw new Error('These transactions do not look like the two legs of one transfer');
  }

  const company = a.company;
  const from = pairA.amount < 0 ? a : b; // money left this account
  const to = pairA.amount < 0 ? b : a; // and arrived here
  // env is imported lazily so the pure pairing helpers above stay importable
  // without a fully configured environment (unit tests).
  const { env } = await import('../env.js');
  const dryRun = company.dryRun || env.DRY_RUN;
  const holdingIds = jsonStringArray(company.holdingAccountIds);
  const { qboFactory } = await import('../lib/qbo/factory.js');
  const client: QboClient = await qboFactory.forCompany(company.id);
  const { writeAudit } = await import('./audit.js');
  const audit: AuditFn = writeAudit;
  const status: TxnStatus = dryRun ? 'DRY_RUN' : 'POSTED';
  const now = new Date();

  // Each leg's holding line is recategorized to the OTHER leg's bank account.
  interface Leg {
    txn: typeof a;
    counterpartTxnId: string;
    targetBankName: string;
  }
  const legA: Leg = { txn: a, counterpartTxnId: b.id, targetBankName: (a.id === from.id ? to : from).bankAccount };
  const legB: Leg = { txn: b, counterpartTxnId: a.id, targetBankName: (b.id === from.id ? to : from).bankAccount };

  // Post ONE leg completely — QBO write, then status + audit committed in one
  // DB transaction — before the next leg starts. There is no way to make the
  // two QBO writes atomic, so we never pretend they are: if leg B fails, leg A
  // stays honestly posted and leg B lands in ERROR.
  const postLeg = async (leg: Leg): Promise<void> => {
    const candidates = await prisma.qboAccount.findMany({
      where: { companyId: company.id, name: leg.targetBankName },
      select: { qboId: true, name: true, active: true },
    });
    const target = pickCounterpartAccount(candidates, leg.targetBankName);

    // Fresh read even in dry-run — the audit payload must be the exact QBO
    // payload that would be sent, current SyncToken included.
    const fresh = await client.fetchTxn(leg.txn.qboType as QboTxn['qboType'], leg.txn.qboId);
    const holdingLine = fresh?.lines.find((l) => holdingIds.includes(l.accountQboId));
    if (!fresh || !holdingLine) {
      throw new Error(`"${leg.txn.payee}" was already categorized inside QuickBooks — re-sync and try again.`);
    }
    const before = holdingLine.accountName;

    // Amount from the fresh read (the holding-line sum as QBO sees it NOW),
    // not from our possibly-stale mirror.
    const splits = [{ amount: fresh.amount, accountQboId: target.qboId, memo: leg.txn.memo ?? undefined }];
    const payload = {
      qboType: leg.txn.qboType,
      qboId: leg.txn.qboId,
      syncToken: fresh.syncToken,
      splits,
      counterpartTxnId: leg.counterpartTxnId,
      dryRun,
    };

    let newSyncToken: string | null = null;
    if (!dryRun) {
      const result = await client.recategorize(fresh, splits);
      newSyncToken = result.newSyncToken;
    }

    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: leg.txn.id },
        data: {
          status,
          postedAt: now,
          postedByUserId: actor.id,
          errorCode: null,
          errorMessage: null,
          ...(newSyncToken !== null ? { qboSyncToken: newSyncToken } : {}),
        },
      });
      await audit(tx, {
        companyId: company.id,
        actorId: actor.id,
        actorLabel: actor.label,
        txnId: leg.txn.id,
        payee: leg.txn.payee,
        amount: fresh.amount,
        action: 'transfer',
        before,
        after: `Transfer to ${to.bankAccount}`,
        payload,
      });
    });
  };

  await postLeg(legA); // throws with nothing written if it fails
  try {
    await postLeg(legB);
  } catch (err) {
    // Leg A is already posted and committed. Be honest about it: mark leg B
    // ERROR (with audit) and surface a message that says exactly what state
    // the books are in.
    const message = err instanceof Error ? err.message : String(err);
    const holdingName = await firstHoldingName(company.id, holdingIds);
    await prisma
      .$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: legB.txn.id },
          data: { status: 'ERROR', errorCode: 'TRANSFER_LEG_FAILED', errorMessage: message },
        });
        await audit(tx, {
          companyId: company.id,
          actorId: actor.id,
          actorLabel: actor.label,
          txnId: legB.txn.id,
          payee: legB.txn.payee,
          amount: Number(legB.txn.amount),
          action: 'error',
          before: holdingName,
          after: `Transfer to ${to.bankAccount}`,
          payload: { counterpartTxnId: legA.txn.id, dryRun, error: message },
        });
      })
      .catch((markErr) => console.error(`[transfers] could not mark leg B ${legB.txn.id} as ERROR:`, markErr));
    throw new Error(
      `The first transfer leg ("${legA.txn.payee}") posted, but the second leg ("${legB.txn.payee}") failed: ${message}`,
    );
  }

  return { status };
}
