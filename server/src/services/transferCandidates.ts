import type { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http.js';
import {
  actionabilityObservationFromRow,
  effectiveProviderDisposition,
  transactionIdentityFromRow,
} from './providerActionability.js';

export interface PairableTxn {
  id: string;
  amount: number;
  bankAccount: string;
  date: Date;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_TRANSFER_DISCOVERY_TRANSACTIONS = 10_000;

export class TransferDiscoveryOverflowError extends HttpError {
  constructor() {
    super(
      503,
      'Transfer candidate discovery exceeded its safe limit',
      'COMPANY_UNAVAILABLE',
    );
    this.name = 'TransferDiscoveryOverflowError';
  }
}

export interface PairTransferStats {
  heapPushes: number;
  heapPops: number;
  queueShifts: number;
}

export function isTransferPair(a: PairableTxn, b: PairableTxn): boolean {
  return (
    a.amount !== 0 &&
    Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) < 0.005 &&
    Math.sign(a.amount) !== Math.sign(b.amount) &&
    a.bankAccount !== b.bankAccount &&
    Math.abs(a.date.getTime() - b.date.getTime()) <= THREE_DAYS_MS
  );
}

interface HeapEntry {
  bankAccount: string;
  txn: PairableTxn;
}

function earlier(first: HeapEntry, second: HeapEntry): boolean {
  return (
    first.txn.date.getTime() < second.txn.date.getTime() ||
    (first.txn.date.getTime() === second.txn.date.getTime() && first.txn.id < second.txn.id)
  );
}

class BankQueueIndex {
  private readonly queues = new Map<string, { rows: PairableTxn[]; head: number }>();
  private readonly heap: HeapEntry[] = [];

  constructor(private readonly stats?: PairTransferStats) {}

  add(txn: PairableTxn): void {
    const queue = this.queues.get(txn.bankAccount);
    if (queue) {
      queue.rows.push(txn);
      return;
    }
    this.queues.set(txn.bankAccount, { rows: [txn], head: 0 });
    this.push({ bankAccount: txn.bankAccount, txn });
  }

  takeFuture(
    excludedBank: string,
    currentIndex: number,
    maximumDate: number,
    used: Set<string>,
    orderOf: Map<string, number>,
  ): PairableTxn | null {
    let excluded: HeapEntry | null = null;
    let matched: PairableTxn | null = null;
    while (this.heap.length > 0) {
      const entry = this.pop();
      if (!entry) break;
      const queue = this.queues.get(entry.bankAccount);
      if (!queue || queue.rows[queue.head]?.id !== entry.txn.id) continue;
      while (
        queue.rows[queue.head] &&
        ((orderOf.get(queue.rows[queue.head]!.id) ?? -1) <= currentIndex ||
          used.has(queue.rows[queue.head]!.id))
      ) {
        queue.head += 1;
        if (this.stats) this.stats.queueShifts += 1;
      }
      const head = queue.rows[queue.head];
      if (!head) {
        this.queues.delete(entry.bankAccount);
        continue;
      }
      const current = { bankAccount: entry.bankAccount, txn: head };
      if (head.id !== entry.txn.id) {
        this.push(current);
        continue;
      }
      if (head.date.getTime() > maximumDate) {
        this.push(current);
        break;
      }
      if (entry.bankAccount === excludedBank) {
        excluded = current;
        continue;
      }
      matched = head;
      queue.head += 1;
      if (this.stats) this.stats.queueShifts += 1;
      const next = queue.rows[queue.head];
      if (next) this.push({ bankAccount: entry.bankAccount, txn: next });
      else this.queues.delete(entry.bankAccount);
      break;
    }
    if (excluded) this.push(excluded);
    return matched;
  }

  private push(entry: HeapEntry): void {
    if (this.stats) this.stats.heapPushes += 1;
    this.heap.push(entry);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.heap[parent];
      if (!parentEntry || !earlier(entry, parentEntry)) break;
      this.heap[index] = parentEntry;
      index = parent;
    }
    this.heap[index] = entry;
  }

  private pop(): HeapEntry | undefined {
    const first = this.heap[0];
    if (!first) return undefined;
    if (this.stats) this.stats.heapPops += 1;
    const last = this.heap.pop();
    if (this.heap.length === 0 || !last) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let child = left;
      if (
        right < this.heap.length &&
        this.heap[right] &&
        this.heap[left] &&
        earlier(this.heap[right]!, this.heap[left]!)
      ) child = right;
      const childEntry = this.heap[child];
      if (!childEntry || !earlier(childEntry, last)) break;
      this.heap[index] = childEntry;
      index = child;
    }
    this.heap[index] = last;
    return first;
  }
}

export function pairTransfers(
  txns: PairableTxn[],
  stats?: PairTransferStats,
): Map<string, string> {
  const matched = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...txns].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
  );
  const orderOf = new Map(sorted.map((txn, index) => [txn.id, index]));
  const buckets = new Map<number, { positive: BankQueueIndex; negative: BankQueueIndex }>();
  for (const txn of sorted) {
    if (txn.amount === 0) continue;
    const cents = Math.round(Math.abs(txn.amount) * 100);
    let bucket = buckets.get(cents);
    if (!bucket) {
      bucket = { positive: new BankQueueIndex(stats), negative: new BankQueueIndex(stats) };
      buckets.set(cents, bucket);
    }
    const own = txn.amount > 0 ? bucket.positive : bucket.negative;
    own.add(txn);
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const txn = sorted[index];
    if (!txn || txn.amount === 0 || used.has(txn.id)) continue;
    const cents = Math.round(Math.abs(txn.amount) * 100);
    const bucket = buckets.get(cents);
    if (!bucket) continue;
    const opposite = txn.amount > 0 ? bucket.negative : bucket.positive;
    const counterpart = opposite.takeFuture(
      txn.bankAccount,
      index,
      txn.date.getTime() + THREE_DAYS_MS,
      used,
      orderOf,
    );
    if (!counterpart) continue;
    used.add(txn.id);
    used.add(counterpart.id);
    matched.set(counterpart.id, txn.id);
    matched.set(txn.id, counterpart.id);
  }
  const pairs = new Map<string, string>();
  for (const txn of sorted) {
    if (pairs.has(txn.id)) continue;
    const counterpart = matched.get(txn.id);
    if (!counterpart) continue;
    pairs.set(txn.id, counterpart);
    pairs.set(counterpart, txn.id);
  }
  return pairs;
}

type CandidateDb = Pick<PrismaClient, 'transaction'> & { transactionActionability?: unknown };

export async function transferCandidates(
  companyId: string,
  db: CandidateDb = prisma,
): Promise<Map<string, string>> {
  // Production always has the delegate after migrate-deploy. The fallback is
  // retained for small legacy unit-test adapters only.
  const supportsActionability = Boolean(db.transactionActionability);
  const rows = await db.transaction.findMany({
    where: { companyId, status: 'PENDING', category: null, splitLines: { none: {} } },
    select: {
      id: true,
      companyId: true,
      revision: true,
      qboSyncToken: true,
      qboType: true,
      qboId: true,
      amount: true,
      bankAccount: true,
      date: true,
      ...(supportsActionability ? { providerActionability: true } : {}),
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    take: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1,
  });
  if (rows.length > MAX_TRANSFER_DISCOVERY_TRANSACTIONS) {
    throw new TransferDiscoveryOverflowError();
  }
  const writableRows = supportsActionability
    ? rows.filter((row) => effectiveProviderDisposition(
        actionabilityObservationFromRow(
          (row as unknown as { providerActionability?: unknown }).providerActionability,
        ),
        transactionIdentityFromRow(row),
      ) === 'WRITABLE')
    : rows;
  return pairTransfers(writableRows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    bankAccount: row.bankAccount,
    date: row.date,
  })));
}
