import type { AgentJob, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { canonicalHash } from '../../lib/qbo/purchaseTax.js';
import { getInstanceSettings } from '../instanceSettings.js';
import { ruleSuggestion } from '../suggestions.js';
import { AGENT_VERIFIER_PROMPT_VERSION } from './verifier.js';

export const AGENT_PROMPT_VERSION = 'recat-autopilot-v2';
export const AGENT_RUN_PROMPT_VERSION =
  `${AGENT_PROMPT_VERSION}+${AGENT_VERIFIER_PROMPT_VERSION}`;
export const AGENT_TOOL_SCHEMA_VERSION = 'recat-tools-v1';
export const MIN_LIVE_SHADOW_RUNS = 10;
export const AGENT_JOB_LEASE_MS = 2 * 60 * 1000;
export const AGENT_COMPANY_LEASE_MS = 2 * 60 * 1000;
export const AGENT_COMPANY_LEASE_RENEW_MS = 30 * 1000;

type JobsDb = PrismaClient;
type QueueDb = PrismaClient | Prisma.TransactionClient;
type ShadowEvidenceDb = Pick<PrismaClient, 'agentRun'>;

export interface AgentVersionIdentity {
  provider: string;
  model: string;
}

export async function activeAgentVersionIdentity(): Promise<AgentVersionIdentity> {
  const settings = await getInstanceSettings();
  return { provider: 'codex', model: settings.codexModel };
}

export function validatedShadowEvidenceWhere(
  companyId: string,
  identity: AgentVersionIdentity,
): Prisma.AgentRunWhereInput {
  return {
    companyId,
    provider: identity.provider,
    model: identity.model,
    promptVersion: AGENT_RUN_PROMPT_VERSION,
    toolSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
    mode: 'shadow',
    completedAt: { not: null },
    errorCode: null,
    validation: { path: ['ok'], equals: true },
    decision: { path: ['kind'], equals: 'categorize' },
    verifier: { path: ['verdict'], equals: 'agree' },
  };
}

export async function countValidatedShadowRuns(
  companyId: string,
  identity: AgentVersionIdentity,
  db: ShadowEvidenceDb = prisma,
): Promise<number> {
  const rows = await db.agentRun.findMany({
    where: validatedShadowEvidenceWhere(companyId, identity),
    distinct: ['transactionId'],
    select: { transactionId: true },
  });
  return rows.length;
}

interface HashableTransaction {
  qboId: string;
  qboType: string;
  qboSyncToken: string;
  date: Date;
  payee: string;
  memo: string | null;
  amount: unknown;
  bankAccount: string;
  rawData: unknown;
}

interface HashableAccount {
  qboId: string;
  name: string;
  fullName: string;
  active: boolean;
  classification: string;
  accountType: string | null;
}

interface HashableTaxCode {
  qboId: string;
  name: string;
  description: string | null;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
}

function originalLineShape(rawData: unknown): unknown[] {
  if (!rawData || typeof rawData !== 'object') return [];
  const lines = (rawData as { Line?: unknown }).Line;
  if (!Array.isArray(lines)) return [];
  return lines.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const line = value as {
      Id?: unknown;
      Amount?: unknown;
      Description?: unknown;
      DetailType?: unknown;
      AccountBasedExpenseLineDetail?: {
        AccountRef?: { value?: unknown };
        TaxCodeRef?: { value?: unknown };
        TaxInclusiveAmt?: unknown;
      };
    };
    return {
      id: line.Id,
      amount: line.Amount,
      description: line.Description,
      detailType: line.DetailType,
      accountQboId: line.AccountBasedExpenseLineDetail?.AccountRef?.value,
      taxCodeQboId: line.AccountBasedExpenseLineDetail?.TaxCodeRef?.value,
      taxInclusiveAmount: line.AccountBasedExpenseLineDetail?.TaxInclusiveAmt,
    };
  });
}

export function agentInputHash(
  txn: HashableTransaction,
  accounts: HashableAccount[],
  taxCodes: HashableTaxCode[],
  holdingAccountQboIds: string[] = [],
  identity: AgentVersionIdentity = { provider: 'codex', model: 'gpt-5.6-luna' },
): string {
  return canonicalHash({
    runIdentity: {
      provider: identity.provider,
      model: identity.model,
      promptVersion: AGENT_RUN_PROMPT_VERSION,
      toolSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
    },
    transaction: {
      qboId: txn.qboId,
      qboType: txn.qboType,
      qboSyncToken: txn.qboSyncToken,
      date: txn.date.toISOString(),
      payee: txn.payee,
      memo: txn.memo,
      amount: String(txn.amount),
      bankAccount: txn.bankAccount,
      originalLines: originalLineShape(txn.rawData),
    },
    holdingAccountQboIds: [...new Set(holdingAccountQboIds)].sort(),
    accounts: accounts
      .map((account) => ({
        qboId: account.qboId,
        name: account.name,
        fullName: account.fullName,
        active: account.active,
        classification: account.classification,
        accountType: account.accountType,
      }))
      .sort((a, b) => a.qboId.localeCompare(b.qboId)),
    taxCodes: taxCodes
      .map((code) => ({
        qboId: code.qboId,
        name: code.name,
        description: code.description,
        active: code.active,
        taxable: code.taxable,
        purchaseTaxRateList: code.purchaseTaxRateList,
      }))
      .sort((a, b) => a.qboId.localeCompare(b.qboId)),
  });
}

export async function currentAgentInputHash(
  transactionId: string,
  db: JobsDb = prisma,
  identity?: AgentVersionIdentity,
): Promise<string | null> {
  const txn = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { company: { select: { holdingAccountIds: true } } },
  });
  if (!txn) return null;
  const [accounts, taxCodes] = await Promise.all([
    db.qboAccount.findMany({
      where: { companyId: txn.companyId },
      select: {
        qboId: true,
        name: true,
        fullName: true,
        active: true,
        classification: true,
        accountType: true,
      },
    }),
    db.qboTaxCode.findMany({
      where: { companyId: txn.companyId },
      select: {
        qboId: true,
        name: true,
        description: true,
        active: true,
        taxable: true,
        purchaseTaxRateList: true,
      },
    }),
  ]);
  const holdingAccountQboIds = Array.isArray(txn.company.holdingAccountIds)
    ? txn.company.holdingAccountIds.filter((value): value is string => typeof value === 'string')
    : [];
  return agentInputHash(
    txn,
    accounts,
    taxCodes,
    holdingAccountQboIds,
    identity ?? (await activeAgentVersionIdentity()),
  );
}

/** Read current rules rather than the transaction's eventually refreshed suggestion snapshot. */
export async function hasCurrentDeterministicRule(
  transactionId: string,
  db: JobsDb = prisma,
): Promise<boolean> {
  const txn = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { companyId: true, payee: true },
  });
  if (!txn) return false;
  const rules = await db.rule.findMany({
    where: { companyId: txn.companyId },
    select: {
      id: true,
      matchText: true,
      category: true,
      categoryQboId: true,
      priority: true,
      createdAt: true,
      taxCalculation: true,
      taxCode: true,
      taxCodeQboId: true,
    },
  });
  return ruleSuggestion(txn.payee, rules) !== null;
}

export async function isCurrentAgentTransactionEligible(
  transactionId: string,
  companyId: string,
  db: JobsDb = prisma,
): Promise<boolean> {
  const txn = await db.transaction.findFirst({
    where: {
      id: transactionId,
      companyId,
      status: 'PENDING',
      qboType: 'Purchase',
      amount: { lt: 0 },
      category: null,
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      txnTags: { none: {} },
      splitLines: { none: {} },
    },
    select: { id: true },
  });
  return txn !== null;
}

export interface EnqueueResult {
  created: number;
  reset: number;
  unchanged: number;
  eligible: number;
  /** Present only for bounded reconciliation scans. */
  nextCursor?: string | null;
}

export interface EnqueueOptions {
  /** Exact provider/model identity used for every hash in this scan. */
  identity?: AgentVersionIdentity;
  /**
   * Queue same-input completed jobs whose latest completed run was shadow.
   * Live activation uses this idempotently so a failed enqueue can be retried
   * without rerunning jobs which have already completed in live mode.
  */
  requeueCompletedShadow?: boolean;
  /**
   * Bound one durable reconciliation transaction. The cursor is the last
   * transaction id scanned, including rule-covered rows.
   */
  batchSize?: number;
  afterTransactionId?: string;
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export async function enqueueEligibleTransactions(
  companyId: string,
  db: QueueDb = prisma,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company ${companyId} not found.`);
  if (
    company.autopilotMode === 'off' ||
    company.disconnectedAt !== null ||
    company.taxSupportStatus !== 'ready'
  ) {
    return { created: 0, reset: 0, unchanged: 0, eligible: 0 };
  }
  const identity = options.identity ?? (await activeAgentVersionIdentity());

  const batchSize =
    options.batchSize === undefined
      ? undefined
      : Math.max(1, Math.min(250, Math.floor(options.batchSize)));
  const [eligiblePage, accounts, taxCodes, rules] = await Promise.all([
    db.transaction.findMany({
      where: {
        companyId,
        ...(options.afterTransactionId ? { id: { gt: options.afterTransactionId } } : {}),
        status: 'PENDING',
        qboType: 'Purchase',
        amount: { lt: 0 },
        category: null,
        taxCalculation: null,
        taxCode: null,
        taxCodeQboId: null,
        txnTags: { none: {} },
        splitLines: { none: {} },
      },
      ...(batchSize === undefined
        ? {}
        : {
            orderBy: { id: 'asc' as const },
            take: batchSize + 1,
          }),
    }),
    db.qboAccount.findMany({
      where: { companyId },
      select: {
        qboId: true,
        name: true,
        fullName: true,
        active: true,
        classification: true,
        accountType: true,
      },
    }),
    db.qboTaxCode.findMany({
      where: { companyId },
      select: {
        qboId: true,
        name: true,
        description: true,
        active: true,
        taxable: true,
        purchaseTaxRateList: true,
      },
    }),
    db.rule.findMany({
      where: { companyId },
      select: {
        id: true,
        matchText: true,
        category: true,
        categoryQboId: true,
        priority: true,
        createdAt: true,
        taxCalculation: true,
        taxCode: true,
        taxCodeQboId: true,
      },
    }),
  ]);
  const hasMore = batchSize !== undefined && eligiblePage.length > batchSize;
  const eligibleRows =
    batchSize === undefined ? eligiblePage : eligiblePage.slice(0, batchSize);
  const nextCursor =
    batchSize === undefined
      ? undefined
      : hasMore
        ? eligibleRows[eligibleRows.length - 1]?.id ?? null
        : null;
  const ruleCoveredIds = eligibleRows
    .filter((txn) => ruleSuggestion(txn.payee, rules) !== null)
    .map((txn) => txn.id);
  if (ruleCoveredIds.length > 0) {
    await db.agentJob.updateMany({
      where: {
        transactionId: { in: ruleCoveredIds },
        status: { in: ['queued', 'retry'] },
      },
      data: {
        status: 'cancelled',
        lockedAt: null,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_RULE_COVERED',
        lastErrorMessage: 'A current deterministic rule now covers this transaction.',
      },
    });
  }
  const ruleCovered = new Set(ruleCoveredIds);
  const transactions = eligibleRows.filter(
    (txn) =>
      !ruleCovered.has(txn.id) &&
      txn.taxCalculation == null &&
      txn.taxCode == null &&
      txn.taxCodeQboId == null,
  );

  let created = 0;
  let reset = 0;
  let unchanged = 0;
  for (const txn of transactions) {
    const holdingAccountQboIds = Array.isArray(company.holdingAccountIds)
      ? company.holdingAccountIds.filter((value): value is string => typeof value === 'string')
      : [];
    const inputHash = agentInputHash(
      txn,
      accounts,
      taxCodes,
      holdingAccountQboIds,
      identity,
    );
    let existing = await db.agentJob.findUnique({ where: { transactionId: txn.id } });
    if (!existing) {
      try {
        await db.agentJob.create({
          data: {
            transactionId: txn.id,
            companyId,
            inputHash,
            status: 'queued',
          },
        });
        created += 1;
        continue;
      } catch (err) {
        if (!isPrismaUniqueError(err)) throw err;
        existing = await db.agentJob.findUnique({ where: { transactionId: txn.id } });
        if (!existing) throw err;
      }
    }
    const completedShadow =
      options.requeueCompletedShadow &&
      existing.inputHash === inputHash &&
      existing.status === 'completed' &&
      (await db.agentRun.findFirst({
        where: {
          jobId: existing.id,
          inputHash,
          completedAt: { not: null },
        },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        select: { mode: true },
      }))?.mode === 'shadow';
    const sameInputRetryable =
      existing.inputHash === inputHash &&
      (completedShadow ||
        ((existing.status === 'cancelled' || existing.status === 'failed') &&
          (existing.lastErrorCode === 'AGENT_DISABLED' ||
            existing.lastErrorCode === 'AGENT_AUTH' ||
            existing.lastErrorCode === 'AGENT_PROVIDER_CHANGED' ||
            existing.lastErrorCode === 'AGENT_LIVE_EVIDENCE_REQUIRED' ||
            existing.lastErrorCode === 'AGENT_INELIGIBLE' ||
            existing.lastErrorCode === 'AGENT_STALE_INPUT' ||
            existing.lastErrorCode === 'AGENT_RULE_COVERED')));
    if (sameInputRetryable) {
      const requeued = await db.agentJob.updateMany({
        where: {
          id: existing.id,
          inputHash: existing.inputHash,
          status: existing.status,
        },
        data: {
          status: 'queued',
          attempt: 0,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (requeued.count === 1) reset += 1;
      else unchanged += 1;
      continue;
    }
    if (existing.inputHash === inputHash) {
      unchanged += 1;
      continue;
    }
    // Never invalidate an active owner's lease. It will observe the changed
    // input hash and cancel its own claim; the next enqueue pass can then
    // install the replacement hash.
    if (existing.status === 'running') {
      unchanged += 1;
      continue;
    }
    const replaced = await db.agentJob.updateMany({
      where: {
        id: existing.id,
        inputHash: existing.inputHash,
        status: existing.status,
      },
      data: {
        inputHash,
        status: 'queued',
        attempt: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (replaced.count === 1) reset += 1;
    else unchanged += 1;
  }
  return {
    created,
    reset,
    unchanged,
    eligible: transactions.length,
    ...(batchSize !== undefined ? { nextCursor } : {}),
  };
}

export async function claimNextJob(
  workerId: string,
  now = new Date(),
  db: JobsDb = prisma,
): Promise<AgentJob | null> {
  for (let raceAttempt = 0; raceAttempt < 5; raceAttempt += 1) {
    const candidate = await db.agentJob.findFirst({
      where: {
        status: { in: ['queued', 'retry'] },
        nextAttemptAt: { lte: now },
        company: {
          autopilotMode: { in: ['shadow', 'live'] },
          disconnectedAt: null,
          taxSupportStatus: 'ready',
        },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) return null;
    const leaseExpiresAt = new Date(now.getTime() + AGENT_JOB_LEASE_MS);
    const claimed = await db.agentJob.updateMany({
      where: {
        id: candidate.id,
        inputHash: candidate.inputHash,
        status: candidate.status,
        nextAttemptAt: { lte: now },
        company: {
          autopilotMode: { in: ['shadow', 'live'] },
          disconnectedAt: null,
          taxSupportStatus: 'ready',
        },
      },
      data: {
        status: 'running',
        attempt: { increment: 1 },
        lockedAt: now,
        lockOwner: workerId,
        leaseExpiresAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (claimed.count === 1) {
      return db.agentJob.findUnique({ where: { id: candidate.id } });
    }
  }
  return null;
}

export async function renewJobLease(
  jobId: string,
  workerId: string,
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    where: {
      id: jobId,
      status: 'running',
      lockOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: { leaseExpiresAt: new Date(now.getTime() + AGENT_JOB_LEASE_MS) },
  });
  return result.count === 1;
}

export async function completeJob(
  jobId: string,
  workerId: string,
  inputHash: string,
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    where: {
      id: jobId,
      inputHash,
      status: 'running',
      lockOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: {
      status: 'completed',
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  return result.count === 1;
}

export async function retryJob(
  jobId: string,
  workerId: string,
  inputHash: string,
  error: { code: string; message: string },
  nextAttemptAt: Date,
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    where: {
      id: jobId,
      inputHash,
      status: 'running',
      lockOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: {
      status: 'retry',
      nextAttemptAt,
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: error.code,
      lastErrorMessage: error.message.slice(0, 500),
    },
  });
  return result.count === 1;
}

export async function failJob(
  jobId: string,
  workerId: string,
  inputHash: string,
  error: { code: string; message: string },
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    where: {
      id: jobId,
      inputHash,
      status: 'running',
      lockOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: {
      status: 'failed',
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: error.code,
      lastErrorMessage: error.message.slice(0, 500),
    },
  });
  return result.count === 1;
}

export async function cancelJob(
  jobId: string,
  reason: { code: string; message: string },
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    // A running job may already be inside the non-interruptible accounting
    // write boundary. Only its owning worker may transition that claim.
    where: { id: jobId, status: { in: ['queued', 'retry'] } },
    data: {
      status: 'cancelled',
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: reason.code,
      lastErrorMessage: reason.message.slice(0, 500),
    },
  });
  return result.count === 1;
}

export async function cancelClaimedJob(
  jobId: string,
  workerId: string,
  inputHash: string,
  reason: { code: string; message: string },
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const result = await db.agentJob.updateMany({
    where: {
      id: jobId,
      inputHash,
      status: 'running',
      lockOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: {
      status: 'cancelled',
      lockedAt: null,
      lockOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: reason.code,
      lastErrorMessage: reason.message.slice(0, 500),
    },
  });
  return result.count === 1;
}

export async function acquireCompanyWriteLease(
  companyId: string,
  owner: string,
  now = new Date(),
  db: JobsDb = prisma,
): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + AGENT_COMPANY_LEASE_MS);
  const updated = await db.agentCompanyLease.updateMany({
    where: {
      companyId,
      OR: [{ owner }, { leaseExpiresAt: { lte: now } }],
    },
    data: { owner, leaseExpiresAt },
  });
  if (updated.count === 1) return true;
  try {
    await db.agentCompanyLease.create({ data: { companyId, owner, leaseExpiresAt } });
    return true;
  } catch (err) {
    if (isPrismaUniqueError(err)) return false;
    throw err;
  }
}

export async function releaseCompanyWriteLease(
  companyId: string,
  owner: string,
  db: JobsDb = prisma,
): Promise<void> {
  await db.agentCompanyLease.deleteMany({ where: { companyId, owner } });
}

export class CompanyWriteLeaseBusyError extends Error {
  constructor(readonly companyId: string) {
    super('Another accounting write is already active for this company.');
    this.name = 'CompanyWriteLeaseBusyError';
  }
}

interface CompanyWriteLeaseBoundaryDeps {
  acquire(companyId: string, owner: string): Promise<boolean>;
  release(companyId: string, owner: string): Promise<void>;
}

export interface CompanyWriteLeaseGuard {
  /**
   * False as soon as any renewal fails. Long-running operations must check
   * this before starting each subsequent accounting write.
   */
  canContinue(): boolean;
}

const defaultWriteBoundaryDeps: CompanyWriteLeaseBoundaryDeps = {
  acquire: (companyId, owner) => acquireCompanyWriteLease(companyId, owner),
  release: (companyId, owner) => releaseCompanyWriteLease(companyId, owner),
};

/**
 * Hold every requested company write lease for one accounting operation.
 * Sorted acquisition prevents cross-company bulk requests from deadlocking.
 */
export async function withCompanyWriteLeases<T>(
  companyIds: readonly string[],
  owner: string,
  action: (guard: CompanyWriteLeaseGuard) => Promise<T>,
  deps: CompanyWriteLeaseBoundaryDeps = defaultWriteBoundaryDeps,
): Promise<T> {
  const acquired: string[] = [];
  let renewalTimer: NodeJS.Timeout | null = null;
  let renewalInFlight: Promise<void> | null = null;
  let leaseLost: string | null = null;
  const validUntilByCompany = new Map<string, number>();

  const renew = (): void => {
    if (renewalInFlight || leaseLost !== null) return;
    let current!: Promise<void>;
    current = (async () => {
      for (const companyId of acquired) {
        if (!(await deps.acquire(companyId, owner))) {
          leaseLost = companyId;
          console.error(`[accounting-write] lost company lease ${companyId} during renewal`);
          return;
        }
        validUntilByCompany.set(companyId, Date.now() + AGENT_COMPANY_LEASE_MS);
      }
    })()
      .catch((error) => {
        leaseLost = acquired[0] ?? 'unknown';
        console.error('[accounting-write] company lease renewal failed:', error);
      })
      .finally(() => {
        if (renewalInFlight === current) renewalInFlight = null;
      });
    renewalInFlight = current;
    void current;
  };

  try {
    for (const companyId of [...new Set(companyIds)].sort()) {
      if (!(await deps.acquire(companyId, owner))) {
        throw new CompanyWriteLeaseBusyError(companyId);
      }
      acquired.push(companyId);
      validUntilByCompany.set(companyId, Date.now() + AGENT_COMPANY_LEASE_MS);
    }
    if (acquired.length > 0) {
      renewalTimer = setInterval(renew, AGENT_COMPANY_LEASE_RENEW_MS);
      renewalTimer.unref?.();
    }
    const result = await action({
      canContinue: () =>
        leaseLost === null &&
        acquired.every(
          (companyId) => Date.now() < (validUntilByCompany.get(companyId) ?? 0),
        ),
    });
    await renewalInFlight;
    // The action may already have committed an irreversible QuickBooks write.
    // Never replace its honest result with a synthetic "busy" failure after
    // the fact; the renewal path has already logged the lost serialization.
    return result;
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    await renewalInFlight;
    for (const companyId of acquired.reverse()) {
      await deps.release(companyId, owner).catch((error) => {
        console.error(`[accounting-write] failed to release company lease ${companyId}:`, error);
      });
    }
  }
}

export async function sweepExpiredAgentLeases(
  now = new Date(),
  db: JobsDb = prisma,
): Promise<{ jobsRecovered: number; companyLeasesRemoved: number }> {
  const [jobs, leases] = await db.$transaction([
    db.agentJob.updateMany({
      where: {
        status: 'running',
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: 'retry',
        nextAttemptAt: now,
        lockedAt: null,
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_LEASE_EXPIRED',
        lastErrorMessage: 'Worker lease expired; the job is eligible for recovery.',
      },
    }),
    db.agentCompanyLease.deleteMany({ where: { leaseExpiresAt: { lte: now } } }),
  ]);
  return { jobsRecovered: jobs.count, companyLeasesRemoved: leases.count };
}

/**
 * A running job deliberately keeps ownership of its input hash. Once that
 * owner exits with AGENT_STALE_INPUT, install the current hash durably even
 * for webhook-only companies that have no polling sync to revisit the row.
 */
export async function requeueStaleAgentJobs(
  db: JobsDb = prisma,
  enqueue: (
    companyId: string,
    db: JobsDb,
  ) => Promise<{ created: number; reset: number; unchanged: number; eligible: number }> =
    enqueueEligibleTransactions,
): Promise<{ companiesScanned: number; jobsQueued: number; jobsRetired: number }> {
  const rows = await db.agentJob.findMany({
    where: {
      status: 'cancelled',
      lastErrorCode: 'AGENT_STALE_INPUT',
      company: {
        autopilotMode: { in: ['shadow', 'live'] },
        disconnectedAt: null,
        taxSupportStatus: 'ready',
      },
    },
    select: { id: true, companyId: true },
  });
  const companyIds = [...new Set(rows.map((row) => row.companyId))];
  let jobsQueued = 0;
  let jobsRetired = 0;
  for (const companyId of companyIds) {
    const result = await enqueue(companyId, db);
    jobsQueued += result.created + result.reset;
    const originalIds = rows
      .filter((row) => row.companyId === companyId)
      .map((row) => row.id);
    // Any row from the original recovery snapshot that remains stale after a
    // successful eligibility scan is no longer queueable (for example it was
    // staged, posted, or gained a deterministic rule). Retire only those
    // snapshotted IDs so a concurrently-created stale cancellation waits for
    // the next complete scan instead of being terminalized accidentally.
    const retired = await db.agentJob.updateMany({
      where: {
        id: { in: originalIds },
        status: 'cancelled',
        lastErrorCode: 'AGENT_STALE_INPUT',
      },
      data: {
        lastErrorCode: 'AGENT_INELIGIBLE',
        lastErrorMessage:
          'The transaction is no longer eligible after its decision inputs changed.',
      },
    });
    jobsRetired += retired.count;
  }
  return { companiesScanned: companyIds.length, jobsQueued, jobsRetired };
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}
