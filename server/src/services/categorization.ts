import type {
  CategorizationProposal,
  StageCategorizationInput,
  StagedCategorization,
  TaxCalculation,
  TaxDisposition,
  TaxReadinessDto,
} from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  calculatePurchaseTransaction,
  calculateSalesTransaction,
  reconstructPurchaseTaxExcludedTransaction,
  reconstructSalesTaxExcludedTransaction,
} from '../lib/qbo/purchaseTax.js';
import { cachedSalesTaxReadiness } from './tax/reference.js';
import {
  EntityLeaseError,
  fenceEntityLeaseOwnership,
  withEntityLease,
  type EntityLeaseDb,
  type EntityLeaseFenceDb,
  type EntityLeaseKey,
} from './entityLease.js';
import {
  assertLiveStageAuthority,
  type LiveMutationContext,
  type LiveMutationProof,
} from './agent/liveMutationAuthority.js';

interface TransactionRow {
  id: string;
  companyId: string;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  amount: number | string | { toString(): string };
  status: string;
  revision: number;
  categoryQboId: string | null;
  taxCode: string | null;
  rawData: unknown;
}

interface AccountRow {
  qboId: string;
  name: string;
  fullName: string;
  active: boolean;
}

interface TagRow {
  id: string;
}

interface TaxCodeRow {
  qboId: string;
  name: string;
  active: boolean;
  taxable: boolean | null;
  purchaseTaxRateList: unknown;
  salesTaxRateList: unknown;
  combinedPurchaseRate?: number | string | { toString(): string } | null;
  combinedSalesRate: number | string | { toString(): string } | null;
}

interface TaxRateRow {
  qboId: string;
  name: string;
  active: boolean;
  rateValue: number | string | { toString(): string } | null;
}

interface CompanyTaxRow {
  id: string;
  taxSupportStatus: string;
  taxSupportReason: string | null;
  taxUsingSalesTax: boolean | null;
  taxReferenceRefreshedAt: Date | null;
}

interface ReloadedTransaction {
  id: string;
  revision: number;
  splitLines: {
    idx: number;
    categoryQboId: string | null;
    taxCodeQboId: string | null;
    memo: string | null;
    tags: { tagId: string }[];
  }[];
  txnTags: { tagId: string }[];
}

type WhereIn<T> = { in: T[] };
const ACTIVE_ATTEMPT_STATUSES = ['PREPARED', 'COMMITTING', 'UNCERTAIN'] as const;
const QBO_NOT_APPLICABLE_TAX_CODE = 'NON';

/** The complete external persistence seam used by staging. */
export interface CategorizationDb {
  transaction: {
    findFirst(args: {
      where: { id: string; companyId: string };
    }): Promise<TransactionRow | null>;
    updateMany(args: {
      where: {
        id: string;
        companyId: string;
        revision: number;
        status: 'PENDING';
        qboMutationAttempts: {
          none: { status: { in: readonly ['PREPARED', 'COMMITTING', 'UNCERTAIN'] } };
        };
      };
      data: {
        revision: number;
        category: null;
        categoryQboId: null;
        taxCalculation: TaxCalculation;
        taxCode: string | null;
        taxCodeQboId: string | null;
      };
    }): Promise<{ count: number }>;
    findUniqueOrThrow(args: {
      where: { id: string };
      include: {
        splitLines: {
          orderBy: { idx: 'asc' };
          include: { tags: true };
        };
        txnTags: true;
      };
    }): Promise<ReloadedTransaction>;
  };
  qboMutationAttempt: {
    findFirst(args: {
      where: {
        transactionId: string;
        status: { in: readonly ['PREPARED', 'COMMITTING', 'UNCERTAIN'] };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  company: {
    findUnique(args: { where: { id: string } }): Promise<CompanyTaxRow | null>;
  };
  qboAccount: {
    findMany(args: {
      where: { companyId: string; qboId: WhereIn<string>; active: true };
    }): Promise<AccountRow[]>;
  };
  tag: {
    findMany(args: {
      where: { companyId: string; id: WhereIn<string> };
    }): Promise<TagRow[]>;
  };
  qboTaxCode: {
    findMany(args: {
      where: { companyId: string; qboId?: WhereIn<string> };
    }): Promise<TaxCodeRow[]>;
  };
  qboTaxRate: {
    findMany(args: {
      where: {
        companyId: string;
        active?: true;
        rateValue?: { not: null };
      };
    }): Promise<TaxRateRow[]>;
  };
  splitLine: {
    deleteMany(args: { where: { txnId: string } }): Promise<{ count: number }>;
    createMany(args: {
      data: {
        txnId: string;
        idx: number;
        amount: number;
        category: string;
        categoryQboId: string;
        taxCode: string | null;
        taxCodeQboId: string | null;
        memo: string | null;
      }[];
    }): Promise<{ count: number }>;
    findMany(args: {
      where: { txnId: string };
      orderBy: { idx: 'asc' };
      select: { id: true; idx: true };
    }): Promise<{ id: string; idx: number }[]>;
  };
  splitLineTag: {
    createMany(args: {
      data: { splitLineId: string; tagId: string }[];
    }): Promise<{ count: number }>;
  };
  txnTag: {
    deleteMany(args: { where: { txnId: string } }): Promise<{ count: number }>;
    createMany(args: {
      data: { txnId: string; tagId: string }[];
    }): Promise<{ count: number }>;
  };
  $transaction<T>(callback: (tx: CategorizationDb) => Promise<T>): Promise<T>;
}

export interface CategorizationDeps {
  db: CategorizationDb;
  lease<T>(
    key: EntityLeaseKey,
    owner: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  fence(
    key: EntityLeaseKey,
    owner: string,
    tx: CategorizationDb,
  ): Promise<void>;
  invocationId(): string;
  /** Deterministic concurrency seam used only by the opt-in PostgreSQL race suite. */
  afterRevisionCas?(): Promise<void>;
}

export interface CategorizationStageReceipt {
  normalizedProposal: CategorizationProposal;
  sourceRevision: number;
  preparedRevision: number;
  qboType: string;
  qboId: string;
  qboSyncToken: string;
  staged: StagedCategorization;
}

export type CategorizationWorkflowDecision<T> =
  | { kind: 'continue' }
  | { kind: 'return'; value: T };

export interface CategorizationStagingWorkflow<T> {
  beforeValidation(
    tx: CategorizationDb,
    normalizedInput: StageCategorizationInput,
  ): Promise<CategorizationWorkflowDecision<T>>;
  afterStage(
    tx: CategorizationDb,
    receipt: CategorizationStageReceipt,
  ): Promise<T>;
}

export class CategorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CategorizationError';
  }
}

function activeMutationError(): CategorizationError {
  return new CategorizationError(
    'MUTATION_BLOCKED',
    'This transaction has a prepared write that must be resumed or verified.',
  );
}

const proposalLineSchema = z.object({
  grossCents: z.number().refine(Number.isSafeInteger, 'Line cents must be a safe integer.'),
  categoryQboId: z.string().trim().min(1).max(120),
  taxCodeQboId: z.string().trim().min(1).max(120).nullable().optional(),
  memo: z.string().max(500).optional(),
  tagIds: z.array(z.string().uuid()).max(50)
    .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.'),
}).strict();

const proposalSchema = z.object({
  taxDisposition: z.enum(['set', 'preserve_current']).default('set'),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  lines: z.array(proposalLineSchema).min(1).max(20),
  tagIds: z.array(z.string().uuid()).max(50)
    .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.'),
}).strict().superRefine((proposal, context) => {
  if (proposal.taxDisposition === 'preserve_current') {
    if (proposal.taxCalculation !== 'NotApplicable') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preserve-current requires NotApplicable tax calculation.',
        path: ['taxCalculation'],
      });
    }
    if (proposal.lines.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preserve-current requires exactly one line.',
        path: ['lines'],
      });
    }
    if (proposal.tagIds.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preserve-current cannot change transaction tags.',
        path: ['tagIds'],
      });
    }
    for (const [lineIndex, line] of proposal.lines.entries()) {
      if (line.taxCodeQboId == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Preserve-current requires an explicit source tax code.',
          path: ['lines', lineIndex, 'taxCodeQboId'],
        });
      }
      if (line.memo !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Preserve-current cannot change line memos.',
          path: ['lines', lineIndex, 'memo'],
        });
      }
      if (line.tagIds.length !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Preserve-current cannot change line tags.',
          path: ['lines', lineIndex, 'tagIds'],
        });
      }
    }
    return;
  }

  if (proposal.taxCalculation !== 'NotApplicable') return;
  for (const [lineIndex, line] of proposal.lines.entries()) {
    if (line.taxCodeQboId == null) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'NotApplicable lines must not select a tax code.',
      path: ['lines', lineIndex, 'taxCodeQboId'],
    });
  }
});

const inputSchema = z.object({
  transactionId: z.string().uuid(),
  companyId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  proposal: proposalSchema,
}).strict();

interface CalculatedLine {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

type NormalizedCategorizationProposal = CategorizationProposal & {
  taxDisposition: TaxDisposition;
};

interface ValidatedStage {
  input: Omit<StageCategorizationInput, 'proposal'> & {
    proposal: NormalizedCategorizationProposal;
  };
  transaction: TransactionRow;
  accountsById: Map<string, AccountRow>;
  taxCodesById: Map<string, TaxCodeRow>;
  calculatedLines: CalculatedLine[];
  totals: StagedCategorization['totals'];
}

function invalidInput(error: z.ZodError): CategorizationError {
  const detail = error.issues.map((issue) => issue.message).join(' ');
  return new CategorizationError('INVALID_INPUT', detail || 'Invalid categorization input.');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeSum(values: number[], code: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new CategorizationError(code, 'Categorization cents exceed the safe integer range.');
    }
  }
  return total;
}

function decimalToCents(value: TransactionRow['amount']): number {
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new CategorizationError('INVALID_TRANSACTION_AMOUNT', 'Transaction amount is not exact cents.');
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  const cents = sign * (whole * 100n + fraction);
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CategorizationError(
      'INVALID_TRANSACTION_AMOUNT',
      'Transaction amount exceeds the safe integer range.',
    );
  }
  return Number(cents);
}

interface PreserveCurrentSource {
  accountQboId: string;
  taxCodeQboId: string;
}

function exactRawMoneyCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  return Number.isSafeInteger(cents) && Math.abs(scaled - cents) <= 1e-7
    ? cents
    : null;
}

function preserveCurrentSource(
  transaction: TransactionRow,
  transactionCents: number,
  proposal: NormalizedCategorizationProposal,
): PreserveCurrentSource {
  const raw = transaction.rawData;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CategorizationError('INVALID_INPUT', 'Synchronized Purchase source is unavailable.');
  }
  const purchase = raw as Record<string, unknown>;
  const lines = purchase.Line;
  const totalCents = exactRawMoneyCents(purchase.TotalAmt);
  const credit = purchase.Credit === true;
  if (
    purchase.Id !== transaction.qboId
    || purchase.SyncToken !== transaction.qboSyncToken
    || purchase.GlobalTaxCalculation !== 'NotApplicable'
    || !Array.isArray(lines)
    || lines.length !== 1
    || totalCents === null
    || (credit ? Math.abs(totalCents) : -Math.abs(totalCents)) !== transactionCents
  ) {
    throw new CategorizationError(
      'INVALID_INPUT',
      'Synchronized Purchase identity, amount, tax mode, or single-line shape is not authoritative.',
    );
  }
  const line = lines[0];
  if (typeof line !== 'object' || line === null || Array.isArray(line)) {
    throw new CategorizationError('INVALID_INPUT', 'Synchronized Purchase line is unsupported.');
  }
  const rawLine = line as Record<string, unknown>;
  const detail = rawLine.AccountBasedExpenseLineDetail;
  const lineCents = exactRawMoneyCents(rawLine.Amount);
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    throw new CategorizationError('INVALID_INPUT', 'Synchronized Purchase line detail is unsupported.');
  }
  const expense = detail as Record<string, unknown>;
  const accountRef = expense.AccountRef;
  const taxCodeRef = expense.TaxCodeRef;
  const accountQboId = typeof accountRef === 'object' && accountRef !== null
    && !Array.isArray(accountRef) && typeof (accountRef as Record<string, unknown>).value === 'string'
    ? (accountRef as Record<string, unknown>).value as string
    : '';
  const taxCodeQboId = typeof taxCodeRef === 'object' && taxCodeRef !== null
    && !Array.isArray(taxCodeRef) && typeof (taxCodeRef as Record<string, unknown>).value === 'string'
    ? (taxCodeRef as Record<string, unknown>).value as string
    : '';
  const signedLineCents = lineCents === null
    ? null
    : credit ? Math.abs(lineCents) : -Math.abs(lineCents);
  if (
    typeof rawLine.Id !== 'string'
    || rawLine.Id.trim() === ''
    || rawLine.DetailType !== 'AccountBasedExpenseLineDetail'
    || accountQboId.trim() === ''
    || taxCodeQboId.trim() === ''
    || signedLineCents !== transactionCents
    || signedLineCents !== proposal.lines[0]!.grossCents
    || accountQboId === proposal.lines[0]!.categoryQboId
    || taxCodeQboId !== proposal.lines[0]!.taxCodeQboId
  ) {
    throw new CategorizationError(
      'INVALID_INPUT',
      'Synchronized Purchase line does not prove the exact source account, amount, identity, and tax code.',
    );
  }
  return { accountQboId, taxCodeQboId };
}

function assertSignedLines(
  transactionCents: number,
  proposal: CategorizationProposal,
  qboType: string,
): void {
  if (
    qboType === 'Deposit' &&
    (transactionCents <= 0 || proposal.lines.some((line) => line.grossCents <= 0))
  ) {
    throw new CategorizationError(
      'UNBALANCED_TOTAL',
      'Line totals must be nonzero, match the transaction direction, and balance exactly.',
    );
  }
  const transactionSign = Math.sign(transactionCents);
  const linesHaveWrongSign = proposal.lines.some(
    (line) => line.grossCents === 0 || Math.sign(line.grossCents) !== transactionSign,
  );
  if (linesHaveWrongSign) {
    throw new CategorizationError(
      'UNBALANCED_TOTAL',
      'Line totals must be nonzero, match the transaction direction, and balance exactly.',
    );
  }
}

function taxReadiness(company: CompanyTaxRow, codes: TaxCodeRow[]): Pick<TaxReadinessDto, 'status' | 'reason' | 'usingSalesTax'> {
  return {
    status: company.taxSupportStatus as TaxReadinessDto['status'],
    reason: company.taxSupportReason,
    usingSalesTax: company.taxUsingSalesTax,
  };
}

async function validateStage(
  untrustedInput: StageCategorizationInput,
  db: CategorizationDb,
): Promise<ValidatedStage> {
  const parsed = inputSchema.safeParse(untrustedInput);
  if (!parsed.success) throw invalidInput(parsed.error);
  const input = parsed.data;
  const { proposal } = input;

  const transaction = await db.transaction.findFirst({
    where: { id: input.transactionId, companyId: input.companyId },
  });
  if (!transaction) {
    throw new CategorizationError(
      'TRANSACTION_NOT_FOUND',
      'Transaction was not found for this company.',
    );
  }
  const transactionCents = decimalToCents(transaction.amount);
  assertSignedLines(transactionCents, proposal, transaction.qboType);
  let preservedSource: PreserveCurrentSource | null = null;
  if (proposal.taxDisposition === 'preserve_current') {
    if (transaction.qboType !== 'Purchase') {
      throw new CategorizationError(
        'INVALID_INPUT',
        'Preserve-current is supported only for Purchases.',
      );
    }
    preservedSource = preserveCurrentSource(transaction, transactionCents, proposal);
  }

  const accountIds = unique([
    ...proposal.lines.map((line) => line.categoryQboId),
    ...(preservedSource === null ? [] : [preservedSource.accountQboId]),
  ]);
  const tagIds = unique([
    ...proposal.tagIds,
    ...proposal.lines.flatMap((line) => line.tagIds),
  ]);
  const [accounts, tags] = await Promise.all([
    db.qboAccount.findMany({
      where: { companyId: input.companyId, qboId: { in: accountIds }, active: true },
    }),
    db.tag.findMany({
      where: { companyId: input.companyId, id: { in: tagIds } },
    }),
  ]);
  if (accounts.length !== accountIds.length) {
    throw new CategorizationError(
      'INVALID_ACCOUNT',
      'Every category account must be active and belong to the transaction company.',
    );
  }
  if (tags.length !== tagIds.length) {
    throw new CategorizationError(
      'INVALID_TAG',
      'Every tag must belong to the transaction company.',
    );
  }

  const accountsById = new Map(accounts.map((account) => [account.qboId, account]));
  let taxCodesById = new Map<string, TaxCodeRow>();
  let calculatedLines: CalculatedLine[];

  if (proposal.taxCalculation === 'NotApplicable') {
    if (preservedSource !== null) {
      const taxCodes = await db.qboTaxCode.findMany({
        where: {
          companyId: input.companyId,
          qboId: { in: [preservedSource.taxCodeQboId] },
        },
      });
      const preservedTaxCode = taxCodes[0] ?? (
        preservedSource.taxCodeQboId === QBO_NOT_APPLICABLE_TAX_CODE
          ? {
              qboId: QBO_NOT_APPLICABLE_TAX_CODE,
              name: QBO_NOT_APPLICABLE_TAX_CODE,
              active: true,
              taxable: false,
              purchaseTaxRateList: [],
              salesTaxRateList: [],
              combinedPurchaseRate: 0,
              combinedSalesRate: 0,
            }
          : null
      );
      if (
        taxCodes.length > 1
        || preservedTaxCode === null
        || preservedTaxCode.qboId !== preservedSource.taxCodeQboId
        || preservedTaxCode.active !== true
      ) {
        throw new CategorizationError(
          'INVALID_TAX_CODE',
          'The literal synchronized Purchase tax code must be active and belong to the company.',
        );
      }
      taxCodesById = new Map([[preservedTaxCode.qboId, preservedTaxCode]]);
    }
    calculatedLines = proposal.lines.map((line) => ({
      subtotalCents: line.grossCents,
      taxCents: 0,
      totalCents: line.grossCents,
    }));
  } else {
    if (transaction.qboType !== 'Purchase' && transaction.qboType !== 'Deposit') {
      throw new CategorizationError(
        'TAX_REQUIRES_PURCHASE',
        'Tax selection is unsupported for this transaction type.',
      );
    }
    if (proposal.lines.some((line) => line.taxCodeQboId == null)) {
      throw new CategorizationError(
        'INVALID_INPUT',
        'Every taxed line requires a taxCodeQboId.',
      );
    }

    const [company, taxCodes, taxRates] = await Promise.all([
      db.company.findUnique({ where: { id: input.companyId } }),
      db.qboTaxCode.findMany({
        where: { companyId: input.companyId },
      }),
      db.qboTaxRate.findMany({
        where: {
          companyId: input.companyId,
          active: true,
          rateValue: { not: null },
        },
      }),
    ]);
    if (!company) {
      throw new CategorizationError('TRANSACTION_NOT_FOUND', 'Transaction company was not found.');
    }
    const ready = transaction.qboType === 'Deposit'
      ? cachedSalesTaxReadiness(
          company.taxUsingSalesTax,
          taxCodes,
          company.taxSupportReason,
        ).status === 'ready'
      : taxReadiness(company, taxCodes).status === 'ready' && company.taxUsingSalesTax === true;
    if (!ready) {
      throw new CategorizationError(
        'TAX_NOT_READY',
        'Tax references are not ready.',
      );
    }

    const taxReference = {
      companyId: input.companyId,
      codes: taxCodes.map((code) => ({
        qboId: code.qboId,
        name: code.name,
        description: null,
        active: code.active,
        taxable: code.taxable,
        purchaseRates: code.purchaseTaxRateList as {
          taxRateQboId: string;
          taxTypeApplicable: string;
        }[],
        salesRates: code.salesTaxRateList as {
          taxRateQboId: string;
          taxTypeApplicable: string;
        }[],
        sourceUpdatedAt: null,
      })),
      rates: taxRates.filter((rate) => rate.rateValue !== null).map((rate) => ({
        qboId: rate.qboId,
        name: rate.name,
        description: null,
        active: rate.active,
        rateValue: Number(rate.rateValue),
        sourceUpdatedAt: null,
      })),
    };
    const taxLines = proposal.lines.map((line) => ({
      grossCents: line.grossCents,
      taxCodeQboId: line.taxCodeQboId!,
    }));
    const calculateTransaction = transaction.qboType === 'Deposit'
      ? calculateSalesTransaction
      : calculatePurchaseTransaction;
    const reconstructTaxExcluded = transaction.qboType === 'Deposit'
      ? reconstructSalesTaxExcludedTransaction
      : reconstructPurchaseTaxExcludedTransaction;
    const calculation = proposal.taxCalculation === 'TaxExcluded'
      ? reconstructTaxExcluded(
          {
            companyId: input.companyId,
            lines: taxLines,
          },
          taxReference,
        )
      : calculateTransaction(
          {
            companyId: input.companyId,
            taxCalculation: proposal.taxCalculation,
            lines: taxLines,
          },
          taxReference,
        );
    if (calculation === null) {
      throw new CategorizationError(
        'TAX_AMOUNT_INVALID',
        'Tax-exclusive line totals cannot be reconstructed uniquely.',
      );
    }
    if (!calculation.eligible) {
      throw new CategorizationError(
        calculation.reason,
        `Tax calculation failed${calculation.lineIndex === undefined
          ? ''
          : ` at line ${calculation.lineIndex + 1}`}.`,
      );
    }
    taxCodesById = new Map(taxCodes.map((code) => [code.qboId, code]));
    calculatedLines = calculation.lines.map((line) => {
      const totalCents = safeSum([line.netCents, line.taxCents], 'TAX_AMOUNT_INVALID');
      return {
        subtotalCents: line.netCents,
        taxCents: line.taxCents,
        totalCents,
      };
    });
  }

  const totals = {
    subtotalCents: safeSum(
      calculatedLines.map((line) => line.subtotalCents),
      'TAX_AMOUNT_INVALID',
    ),
    taxCents: safeSum(
      calculatedLines.map((line) => line.taxCents),
      'TAX_AMOUNT_INVALID',
    ),
    totalCents: safeSum(
      calculatedLines.map((line) => line.totalCents),
      'TAX_AMOUNT_INVALID',
    ),
  };
  if (totals.totalCents !== transactionCents) {
    throw new CategorizationError(
      'UNBALANCED_TOTAL',
      'Line totals must be nonzero, match the transaction direction, and balance exactly.',
    );
  }

  return {
    input,
    transaction,
    accountsById,
    taxCodesById,
    calculatedLines,
    totals,
  };
}

async function defaultCategorizationDeps(): Promise<CategorizationDeps> {
  const { prisma } = await import('../lib/prisma.js');
  return {
    db: prisma as unknown as CategorizationDb,
    lease: (key, owner, callback) => withEntityLease(key, owner, callback, {
      db: prisma as unknown as EntityLeaseDb,
    }),
    fence: (key, owner, tx) => fenceEntityLeaseOwnership(key, owner, {
      db: tx as unknown as EntityLeaseFenceDb,
    }),
    invocationId: randomUUID,
  };
}

export async function stageCategorizationWithWorkflow<T>(
  input: StageCategorizationInput,
  workflow: CategorizationStagingWorkflow<T>,
  deps?: CategorizationDeps,
): Promise<T> {
  const resolved = deps ?? (await defaultCategorizationDeps());
  return stageWithOwner(
    input,
    resolved.invocationId(),
    resolved,
    workflow,
  );
}

/**
 * Production-only guarded staging. Authority construction is not injectable:
 * the exact claimed job, leases, live configuration, provider binding, and tax
 * references are proven inside the same transaction as the first mutation.
 */
export async function stageGuardedLiveCategorization(
  input: StageCategorizationInput,
  context: LiveMutationContext,
  proof: LiveMutationProof,
): Promise<StagedCategorization> {
  const deps = await defaultCategorizationDeps();
  return stageWithOwner(
    input,
    context.owner,
    deps,
    {
      beforeValidation: async () => ({ kind: 'continue' }),
      afterStage: async (_tx, receipt) => receipt.staged,
    },
    { context, proof },
  );
}

async function stageWithOwner<T>(
  input: StageCategorizationInput,
  owner: string,
  deps: CategorizationDeps,
  workflow: CategorizationStagingWorkflow<T>,
  authority?: {
    readonly context: LiveMutationContext;
    readonly proof: LiveMutationProof;
  },
): Promise<T> {
  const {
    db,
    lease,
    fence,
    afterRevisionCas,
  } = deps;
  if (
    typeof owner !== 'string'
    || owner.trim() === ''
    || (authority !== undefined && owner !== authority.context.owner)
  ) {
    throw new CategorizationError('INVALID_INPUT', 'Invalid categorization input.');
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);
  const locator = await db.transaction.findFirst({
    where: {
      id: parsed.data.transactionId,
      companyId: parsed.data.companyId,
    },
  });
  if (!locator) {
    throw new CategorizationError(
      'TRANSACTION_NOT_FOUND',
      'Transaction was not found for this company.',
    );
  }

  const key = {
    companyId: locator.companyId,
    qboType: locator.qboType,
    qboId: locator.qboId,
  };
  return lease(key, owner, async () => db.$transaction(async (tx) => {
    // This must be the first statement in the staging transaction. PostgreSQL
    // holds the lease-row lock through commit, preventing expiry takeover from
    // crossing the local mutation boundary.
    await fence(key, owner, tx);
    if (authority !== undefined) {
      await assertLiveStageAuthority(
        tx as unknown as import('@prisma/client').Prisma.TransactionClient,
        authority.context,
        authority.proof,
        parsed.data,
      );
    }
    const decision = await workflow.beforeValidation(tx, parsed.data);
    if (decision.kind === 'return') return decision.value;

    // Reload every mutable fact after both the outer lease and transaction
    // fence are held, so validation and replacement share one snapshot/commit.
    const validated = await validateStage(parsed.data, tx);
    if (
      validated.transaction.companyId !== key.companyId ||
      validated.transaction.qboType !== key.qboType ||
      validated.transaction.qboId !== key.qboId
    ) {
      throw new EntityLeaseError();
    }
    const { proposal } = validated.input;
    if (proposal.taxDisposition === 'preserve_current') {
      const currentGraph = await tx.transaction.findUniqueOrThrow({
        where: { id: validated.input.transactionId },
        include: {
          splitLines: { orderBy: { idx: 'asc' }, include: { tags: true } },
          txnTags: true,
        },
      });
      if (
        currentGraph.txnTags.length !== 0
        || currentGraph.splitLines.some((line) => line.tags.length !== 0)
      ) {
        throw new CategorizationError(
          'INVALID_INPUT',
          'Preserve-current cannot replace a transaction that already has tags.',
        );
      }
    }
    const selectedTaxCodeIds = unique(
      proposal.lines.flatMap((line) => line.taxCodeQboId ?? []),
    );
    const transactionTaxCodeId =
      proposal.taxDisposition === 'preserve_current'
        ? selectedTaxCodeIds[0]!
        : proposal.taxCalculation !== 'NotApplicable' && selectedTaxCodeIds.length === 1
        ? selectedTaxCodeIds[0]!
        : null;
    const transactionTaxCode = proposal.taxDisposition === 'preserve_current'
      ? validated.taxCodesById.get(transactionTaxCodeId!)?.name ?? null
      : transactionTaxCodeId === null
        ? null
        : validated.taxCodesById.get(transactionTaxCodeId)?.name ?? null;

    const activeAttempt = await tx.qboMutationAttempt.findFirst({
      where: {
        transactionId: validated.input.transactionId,
        status: { in: ACTIVE_ATTEMPT_STATUSES },
      },
      select: { id: true },
    });
    if (activeAttempt) throw activeMutationError();

    const updated = await tx.transaction.updateMany({
      where: {
        id: validated.input.transactionId,
        companyId: validated.input.companyId,
        revision: validated.input.expectedRevision,
        status: 'PENDING',
        qboMutationAttempts: {
          none: { status: { in: ACTIVE_ATTEMPT_STATUSES } },
        },
      },
      data: {
        revision: validated.input.expectedRevision + 1,
        category: null,
        categoryQboId: null,
        taxCalculation: proposal.taxCalculation,
        taxCode: transactionTaxCode,
        taxCodeQboId: transactionTaxCodeId,
      },
    });
    if (updated.count !== 1) {
      const racedAttempt = await tx.qboMutationAttempt.findFirst({
        where: {
          transactionId: validated.input.transactionId,
          status: { in: ACTIVE_ATTEMPT_STATUSES },
        },
        select: { id: true },
      });
      if (racedAttempt) throw activeMutationError();
      throw new CategorizationError(
        'STALE_REVISION',
        'The pending categorization changed before this proposal could be staged.',
      );
    }
    await afterRevisionCas?.();

    await tx.splitLine.deleteMany({ where: { txnId: validated.input.transactionId } });
    await tx.splitLine.createMany({
      data: proposal.lines.map((line, idx) => {
        const account = validated.accountsById.get(line.categoryQboId)!;
        const taxCode = line.taxCodeQboId == null
          ? null
          : validated.taxCodesById.get(line.taxCodeQboId) ?? null;
        return {
          txnId: validated.input.transactionId,
          idx,
          amount: validated.calculatedLines[idx]!.totalCents / 100,
          category: account.fullName,
          categoryQboId: account.qboId,
          taxCode: proposal.taxDisposition === 'preserve_current'
            ? taxCode?.name ?? null
            : proposal.taxCalculation === 'NotApplicable' ? null : taxCode?.name ?? null,
          taxCodeQboId: proposal.taxDisposition === 'preserve_current'
            ? line.taxCodeQboId!
            : proposal.taxCalculation === 'NotApplicable' ? null : taxCode?.qboId ?? null,
          memo: line.memo ?? null,
        };
      }),
    });
    const createdLines = await tx.splitLine.findMany({
      where: { txnId: validated.input.transactionId },
      orderBy: { idx: 'asc' },
      select: { id: true, idx: true },
    });
    if (createdLines.length !== proposal.lines.length) {
      throw new Error('Staged split-line replacement was incomplete.');
    }
    const splitLineTags = createdLines.flatMap((line) =>
      unique(proposal.lines[line.idx]?.tagIds ?? []).map((tagId) => ({
        splitLineId: line.id,
        tagId,
      })),
    );
    if (splitLineTags.length > 0) {
      await tx.splitLineTag.createMany({ data: splitLineTags });
    }

    await tx.txnTag.deleteMany({ where: { txnId: validated.input.transactionId } });
    const tagIds = unique(proposal.tagIds);
    if (tagIds.length > 0) {
      await tx.txnTag.createMany({
        data: tagIds.map((tagId) => ({ txnId: validated.input.transactionId, tagId })),
      });
    }

    const reloaded = await tx.transaction.findUniqueOrThrow({
      where: { id: validated.input.transactionId },
      include: {
        splitLines: {
          orderBy: { idx: 'asc' },
          include: { tags: true },
        },
        txnTags: true,
      },
    });

    const staged: StagedCategorization = {
      transactionId: reloaded.id,
      revision: reloaded.revision,
      taxDisposition: proposal.taxDisposition,
      taxCalculation: proposal.taxCalculation,
      totals: validated.totals,
      lines: reloaded.splitLines.map((line) => ({
        idx: line.idx,
        subtotalCents: validated.calculatedLines[line.idx]!.subtotalCents,
        taxCents: validated.calculatedLines[line.idx]!.taxCents,
        totalCents: validated.calculatedLines[line.idx]!.totalCents,
        categoryQboId: line.categoryQboId!,
        taxCodeQboId: line.taxCodeQboId,
        memo: line.memo,
        tagIds: unique(proposal.lines[line.idx]?.tagIds ?? []),
      })),
      tagIds,
    };
    return workflow.afterStage(tx, {
      normalizedProposal: proposal,
      sourceRevision: validated.input.expectedRevision,
      preparedRevision: reloaded.revision,
      qboType: validated.transaction.qboType,
      qboId: validated.transaction.qboId,
      qboSyncToken: validated.transaction.qboSyncToken,
      staged,
    });
  }));
}

export async function stageCategorization(
  input: StageCategorizationInput,
  deps?: CategorizationDeps,
): Promise<StagedCategorization> {
  return stageCategorizationWithWorkflow(input, {
    beforeValidation: async () => ({ kind: 'continue' }),
    afterStage: async (_tx, receipt) => receipt.staged,
  }, deps);
}
