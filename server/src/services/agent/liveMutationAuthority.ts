import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { StageCategorizationInput } from '@recat/shared';
import type { EntityLeaseKey } from '../entityLease.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import { getLiveProviderBinding, LIVE_POLICY_VERSION } from './liveGates.js';
import { issueLiveWritePermit } from './liveWriteLimit.js';

export interface AutopilotWritebackAuthorityInput {
  readonly companyId: string;
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly owner: string;
}

export interface LiveMutationContext {
  readonly jobId: string;
  readonly companyId: string;
  readonly transactionId: string;
  readonly originalRevision: number;
  readonly configVersion: string;
  readonly attemptCount: number;
  readonly workerId: string;
  readonly owner: string;
  readonly entityKey: EntityLeaseKey;
}

export interface LiveTaxAuthority {
  readonly companyId: string;
  readonly status: string;
  readonly usingSalesTax: boolean | null;
  readonly refreshedAt: string | null;
  readonly codes: readonly unknown[];
  readonly rates: readonly unknown[];
}

export interface LiveMutationProof {
  readonly providerBinding: string;
  readonly taxAuthorityDigest: string;
}

interface AuthorityRow {
  readonly id: string;
  readonly payee: string;
  readonly memo: string | null;
}

interface TaxAuthorityRow {
  readonly taxSupportStatus: string;
  readonly taxUsingSalesTax: boolean | null;
  readonly taxReferenceRefreshedAt: Date | string | null;
}

interface TaxCodeAuthorityRow {
  readonly qboId: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly taxable: boolean | null;
  readonly purchaseTaxRateList: unknown;
  readonly salesTaxRateList: unknown;
  readonly sourceUpdatedAt: Date | string | null;
}

interface TaxRateAuthorityRow {
  readonly qboId: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly rateValue: string | number | { toString(): string };
  readonly sourceUpdatedAt: Date | string | null;
}

export class LiveMutationAuthorityError extends Error {
  readonly code = 'LIVE_AUTHORITY_DENIED';

  constructor() {
    super('Guarded live authority is unavailable.');
    this.name = 'LiveMutationAuthorityError';
  }
}

export function liveTaxAuthorityDigest(authority: LiveTaxAuthority): string {
  return createHash('sha256')
    .update(canonicalJson(authority), 'utf8')
    .digest('hex');
}

export async function assertLiveStageAuthority(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  proof: LiveMutationProof,
  input: StageCategorizationInput,
): Promise<void> {
  if (
    input.companyId !== context.companyId
    || input.transactionId !== context.transactionId
    || input.expectedRevision !== context.originalRevision
  ) throw new LiveMutationAuthorityError();
  await lockAndAssertReferenceAuthority(db, context, proof);
  await lockProviderSettings(db);
  const rows = await lockedAuthorityRows(
    db,
    context,
    proof.providerBinding,
    input.expectedRevision,
    null,
    null,
  );
  if (rows.length !== 1) throw new LiveMutationAuthorityError();
  await assertCurrentProviderBinding(db, context, proof);
}

export async function assertLiveCommitAuthority(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  proof: LiveMutationProof,
  input: AutopilotWritebackAuthorityInput,
): Promise<void> {
  if (
    input.companyId !== context.companyId
    || input.transactionId !== context.transactionId
    || input.expectedRevision !== context.originalRevision + 1
    || input.requestId !== context.jobId
    || input.owner !== context.owner
  ) throw new LiveMutationAuthorityError();
  await lockAndAssertReferenceAuthority(db, context, proof);
  await lockProviderSettings(db);
  const rows = await lockedAuthorityRows(
    db,
    context,
    proof.providerBinding,
    input.expectedRevision,
    input.requestId,
    'PREPARED',
  );
  if (rows.length !== 1) throw new LiveMutationAuthorityError();
  await assertCurrentProviderBinding(db, context, proof);
  await issueLiveWritePermit(db, {
    companyId: context.companyId,
    requestId: input.requestId,
  });
}

export async function assertLiveRetryAuthority(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  proof: LiveMutationProof,
  input: AutopilotWritebackAuthorityInput,
): Promise<void> {
  if (
    input.companyId !== context.companyId
    || input.transactionId !== context.transactionId
    || input.expectedRevision !== context.originalRevision + 1
    || input.requestId !== context.jobId
    || input.owner !== context.owner
  ) throw new LiveMutationAuthorityError();
  await lockAndAssertReferenceAuthority(db, context, proof);
  await lockProviderSettings(db);
  const rows = await lockedAuthorityRows(
    db,
    context,
    proof.providerBinding,
    input.expectedRevision,
    input.requestId,
    'RETRYABLE',
  );
  if (rows.length !== 1) throw new LiveMutationAuthorityError();
  await assertCurrentProviderBinding(db, context, proof);
  await issueLiveWritePermit(db, {
    companyId: context.companyId,
    requestId: input.requestId,
  });
}

async function lockedAuthorityRows(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  providerBinding: string,
  transactionRevision: number,
  ownRequestId: string | null,
  ownStatus: 'PREPARED' | 'RETRYABLE' | null,
): Promise<AuthorityRow[]> {
  const rows = await db.$queryRawUnsafe<AuthorityRow[]>(
    `SELECT job."id", txn."payee", txn."memo"
       FROM "AgentJob" job
       JOIN "Transaction" txn
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       JOIN "AgentCompanyConfig" config ON config."companyId" = job."companyId"
       JOIN "Company" company ON company."id" = job."companyId"
       JOIN "QboEntityLease" company_lease
         ON company_lease."companyId" = job."companyId"
        AND company_lease."qboType" = 'Company'
        AND company_lease."qboId" = job."companyId"
       JOIN "QboEntityLease" entity_lease
         ON entity_lease."companyId" = txn."companyId"
        AND entity_lease."qboType" = txn."qboType"
        AND entity_lease."qboId" = txn."qboId"
      WHERE job."id" = $1
        AND job."companyId" = $2
        AND job."transactionId" = $3
        AND job."revision" = $4
        AND job."configVersion" = $5
        AND job."attemptCount" = $6
        AND job."status" = 'running'
        AND job."lockOwner" = $7
        AND job."leaseExpiresAt" > clock_timestamp()
        AND txn."revision" = $8
        AND txn."status" = 'PENDING'
        AND txn."qboType" = $9
        AND txn."qboId" = $10
        AND NOT EXISTS (
          SELECT 1
            FROM "Transaction" counterpart
           WHERE counterpart."companyId" = txn."companyId"
             AND counterpart."id" <> txn."id"
             AND counterpart."status" = 'PENDING'
             AND counterpart."category" IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM "SplitLine" line WHERE line."txnId" = counterpart."id"
             )
             AND txn."amount" <> 0
             AND ABS(ABS(txn."amount") - ABS(counterpart."amount")) < 0.005
             AND SIGN(txn."amount") <> SIGN(counterpart."amount")
             AND counterpart."bankAccount" <> txn."bankAccount"
             AND counterpart."date" BETWEEN txn."date" - INTERVAL '3 days'
                                        AND txn."date" + INTERVAL '3 days'
        )
        AND config."mode" = 'shadow'
        AND config."configVersion" = $5
        AND config."liveRequested" = TRUE
        AND config."liveEnabledAt" IS NOT NULL
        AND config."livePausedAt" IS NULL
        AND config."liveAcceptedPolicyVersion" = $11
        AND config."liveAcceptedConfigVersion" = $5
        AND config."liveAcceptedProviderBinding" = $15
        AND company."disconnectedAt" IS NULL
        AND company."dryRun" = FALSE
        AND company_lease."owner" = $12
        AND company_lease."leaseExpiresAt" > clock_timestamp()
        AND entity_lease."owner" = $12
        AND entity_lease."leaseExpiresAt" > clock_timestamp()
        AND (
          (
            $13::text IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM "QboMutationAttempt" attempt
                JOIN "Transaction" attempt_txn
                  ON attempt_txn."id" = attempt."transactionId"
               WHERE attempt_txn."companyId" = txn."companyId"
                 AND attempt."status" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN')
            )
          )
          OR (
            $13::text IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM "QboMutationAttempt" own_attempt
               WHERE own_attempt."transactionId" = txn."id"
                 AND own_attempt."requestId" = $13
                 AND own_attempt."expectedRevision" = $8
                 AND own_attempt."status" = $14
            )
            AND NOT EXISTS (
              SELECT 1
                FROM "QboMutationAttempt" other_attempt
                JOIN "Transaction" other_txn
                  ON other_txn."id" = other_attempt."transactionId"
               WHERE other_txn."companyId" = txn."companyId"
                 AND other_attempt."status" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN')
                 AND other_attempt."requestId" <> $13
            )
          )
        )
      FOR SHARE OF job, txn, config, company, company_lease, entity_lease`,
    context.jobId,
    context.companyId,
    context.transactionId,
    context.originalRevision,
    context.configVersion,
    context.attemptCount,
    context.workerId,
    transactionRevision,
    context.entityKey.qboType,
    context.entityKey.qboId,
    LIVE_POLICY_VERSION,
    context.owner,
    ownRequestId,
    ownStatus,
    providerBinding,
  );
  // These deterministic vetoes apply at staging and every fresh-send boundary.
  // Keep source text local: callers receive only the existing authority denial.
  return rows.filter((row) => !/\b(payroll|salar(?:y|ies)|wages?|adp|gusto|paychex|ceridian|deel)\b/i.test(
    `${row.payee}\n${row.memo ?? ''}`,
  ));
}

async function lockAndAssertReferenceAuthority(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  proof: LiveMutationProof,
): Promise<void> {
  await lockCompanyMutationScope(db, context.companyId);
  const rows = await db.$queryRawUnsafe<TaxAuthorityRow[]>(
    `SELECT company."taxSupportStatus",
            company."taxUsingSalesTax",
            company."taxReferenceRefreshedAt"
       FROM "Company" company
      WHERE company."id" = $1
      FOR SHARE`,
    context.companyId,
  );
  const row = rows[0];
  if (row === undefined) throw new LiveMutationAuthorityError();
  const rates = await db.$queryRawUnsafe<TaxRateAuthorityRow[]>(
    `SELECT "qboId", "name", "description", "active",
            "rateValue"::text AS "rateValue", "sourceUpdatedAt"
       FROM "QboTaxRate"
      WHERE "companyId" = $1
      ORDER BY "qboId"
      FOR SHARE`,
    context.companyId,
  );
  const codes = await db.$queryRawUnsafe<TaxCodeAuthorityRow[]>(
    `SELECT "qboId", "name", "description", "active", "taxable",
            "purchaseTaxRateList", "salesTaxRateList", "sourceUpdatedAt"
       FROM "QboTaxCode"
      WHERE "companyId" = $1
      ORDER BY "qboId"
      FOR SHARE`,
    context.companyId,
  );
  const digest = liveTaxAuthorityDigest({
    companyId: context.companyId,
    status: row.taxSupportStatus,
    usingSalesTax: row.taxUsingSalesTax,
    refreshedAt: isoDate(row.taxReferenceRefreshedAt),
    codes: codes.map((code) => ({
      qboId: code.qboId,
      name: code.name,
      description: code.description,
      active: code.active,
      taxable: code.taxable,
      purchaseRates: purchaseRates(code.purchaseTaxRateList),
      salesRates: purchaseRates(code.salesTaxRateList),
      sourceUpdatedAt: isoDate(code.sourceUpdatedAt),
    })),
    rates: rates.map((rate) => ({
      qboId: rate.qboId,
      name: rate.name,
      description: rate.description,
      active: rate.active,
      rateValue: Number(rate.rateValue),
      sourceUpdatedAt: isoDate(rate.sourceUpdatedAt),
    })),
  });
  if (digest !== proof.taxAuthorityDigest) throw new LiveMutationAuthorityError();
}

async function assertCurrentProviderBinding(
  db: Prisma.TransactionClient,
  context: LiveMutationContext,
  proof: LiveMutationProof,
): Promise<void> {
  const providerBinding = await getLiveProviderBinding(context.companyId, db);
  if (providerBinding !== proof.providerBinding) throw new LiveMutationAuthorityError();
}

async function lockProviderSettings(db: Prisma.TransactionClient): Promise<void> {
  await db.$executeRawUnsafe('LOCK TABLE "AppConfig" IN SHARE MODE');
}

function purchaseRates(value: unknown): readonly {
  readonly taxRateQboId: string;
  readonly taxTypeApplicable: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      typeof entry !== 'object'
      || entry === null
      || !('taxRateQboId' in entry)
      || !('taxTypeApplicable' in entry)
      || typeof entry.taxRateQboId !== 'string'
      || typeof entry.taxTypeApplicable !== 'string'
    ) return [];
    return [{
      taxRateQboId: entry.taxRateQboId,
      taxTypeApplicable: entry.taxTypeApplicable,
    }];
  });
}

function isoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new LiveMutationAuthorityError();
  return date.toISOString();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
