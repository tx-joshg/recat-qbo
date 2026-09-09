import { QboRateLimitError } from '../lib/qbo/types.js';
// Transaction routes — two routers:
//   companyTransactionsRouter  → /api/companies/:companyId/transactions (queue list)
//   transferCandidatesRouter   → /api/companies/:companyId/transfer-candidates
//   transactionActionsRouter   → /api/transactions (categorize/post/undo/retry/transfer/bulk-post)
// Action routes load the txn by id and scope everything through its companyId.
// Paths and shapes mirror client/src/lib/api.ts exactly (THE contract).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import {
  MAX_EXPECTED_TRANSACTION_REVISION,
  type ProviderActionabilityDisposition,
  type CategorizationMutationResult,
  type CommitCategorizationBody,
  type ManualStageCategorizationBody,
  type ReconcileCategorizationBody,
  type StageCategorizationBody,
  type TransactionDto,
  type TxnStatus,
  type UndoCategorizationBody,
} from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { effectiveRole, requireRole, requireUser, roleRank } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { getTaxReadiness } from '../services/tax/reference.js';
import { suggestForMany } from '../services/suggestions.js';
import { recordTransfer, transferCandidates } from '../services/transfers.js';
import {
  filterTransactionDtos,
  sortTransactionRows,
  transactionDtos,
  transactionReadInclude,
  type TransactionReadRow,
} from '../services/companyReads.js';
import {
  PROVIDER_ACTIONABILITY_DISPOSITIONS,
  assertTransactionProviderActionability,
  effectiveProviderActionabilityCounts,
  providerDispositionIsBlocked,
} from '../services/providerActionability.js';
import {
  MAX_ACTIONABILITY_REFRESH_LIMIT,
  refreshProviderActionability,
} from '../services/providerActionabilityRefresh.js';

export { transactionDtos } from '../services/companyReads.js';
import { stageCategorization } from '../services/categorization.js';
import { stageRuleSuggestion } from '../services/ruleSuggestionApplication.js';
import {
  isLiveReconciliationOwnedRequest,
  loadLiveReconciliationRequest,
  reconcileLiveMutation,
} from '../services/agent/liveReconciliation.js';
import {
  bulkPost,
  commitStagedCategorization,
  postTransaction,
  reconcileMutationAttempt,
  retryError,
  undoCategorization,
  undoPost,
  validateSplits,
  type Actor,
  type DurableMutationResult,
} from '../services/writeback.js';

type TxnRow = TransactionReadRow;

export function actorFor(user: User): Actor {
  return { id: user.id, label: user.name ?? user.email.split('@')[0] ?? user.email };
}

function requestUser(req: { user?: User }): User {
  if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  return req.user;
}

/**
 * Action routes are mounted at /api/transactions (no :companyId), so the
 * company gate runs per transaction: the caller's effective role in the txn's
 * company must be categorizer or better (instance admins pass everywhere).
 */
async function assertCategorizerFor(user: User, companyId: string): Promise<void> {
  const role = await effectiveRole(user, companyId);
  if (role === null || roleRank(role) < roleRank('categorizer')) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
}

async function assertAdminFor(user: User, companyId: string): Promise<void> {
  const role = await effectiveRole(user, companyId);
  if (role === null || roleRank(role) < roleRank('admin')) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
}

async function assertCategorizationRouteAccess(user: User, companyId: string): Promise<void> {
  const role = await effectiveRole(user, companyId);
  if (role === null) {
    throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  }
  if (roleRank(role) < roleRank('categorizer')) {
    throw new HttpError(403, 'You do not have permission to do that', 'FORBIDDEN');
  }
}

async function loadTxn(id: string): Promise<TxnRow> {
  const txn = await prisma.transaction.findUnique({ where: { id }, include: transactionReadInclude });
  if (!txn) throw new HttpError(404, 'Transaction not found', 'TXN_NOT_FOUND');
  return txn;
}

async function dtoById(id: string): Promise<TransactionDto> {
  const txn = await loadTxn(id);
  const [dto] = await transactionDtos(txn.companyId, [txn]);
  if (!dto) throw new HttpError(500, 'Could not build transaction');
  return dto;
}

// ---------------------------------------------------------------------------
// /api/companies/:companyId/transactions
// ---------------------------------------------------------------------------

const txnStatusSchema = z.enum(['PENDING', 'POSTING', 'POSTED', 'DRY_RUN', 'ERROR', 'SUPERSEDED', 'REVERTED']);

const listQuery = z.object({
  status: txnStatusSchema.optional(),
  providerDisposition: z.enum(PROVIDER_ACTIONABILITY_DISPOSITIONS as [ProviderActionabilityDisposition, ...ProviderActionabilityDisposition[]]).optional(),
  search: z.string().optional(),
  account: z.string().optional(),
  cursor: z.string().optional(),
  countOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

const actionabilityRefreshQuery = z.object({
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ACTIONABILITY_REFRESH_LIMIT).optional(),
});

export const companyTransactionsRouter = Router({ mergeParams: true });
companyTransactionsRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('categorizer'));

companyTransactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const query = validate(listQuery)(req.query);
    const supportsActionability = Boolean(
      (prisma as unknown as { transactionActionability?: unknown }).transactionActionability,
    );

    // Queue badge: pending local work belongs to the one queue unless QBO is
    // already known to lock it. UNKNOWN remains visible and every actual write
    // still performs a fresh provider check.
    const pendingWhere: Prisma.TransactionWhereInput = {
      companyId: company.id,
      status: { in: ['PENDING', 'ERROR'] as TxnStatus[] },
    };
    const providerCounts = supportsActionability
      ? effectiveProviderActionabilityCounts(
          await prisma.transaction.findMany({
            where: pendingWhere,
            select: {
              id: true,
              companyId: true,
              revision: true,
              qboSyncToken: true,
              qboType: true,
              qboId: true,
              date: true,
              providerActionability: true,
            },
          }),
        )
      : null;
    const totalPending = providerCounts?.total
      ?? await prisma.transaction.count({ where: pendingWhere });
    const actionableCount = providerCounts?.actionable ?? totalPending;
    const blockedCount = providerCounts?.blocked ?? 0;
    const pendingCount = supportsActionability
      ? Math.max(0, totalPending - blockedCount)
      : totalPending;
    if (query.countOnly) {
      res.json({
        transactions: [],
        nextCursor: null,
        pendingCount,
        ...(supportsActionability
          ? {
              actionableCount,
              blockedCount,
              unknownCount: providerCounts?.unknown ?? 0,
            }
          : {}),
      });
      return;
    }

    // Default reads power the interactive Queue and therefore return only
    // pending/error work plus in-flight posts so a refresh cannot hide an
    // operation before its terminal outcome. Explicit status reads remain
    // available to other surfaces and diagnostics, except SUPERSEDED which is
    // never interactive.
    // Prototype order: date ascending as entered.
    const queueWhere: Prisma.TransactionWhereInput = query.status === undefined
      ? {
          companyId: company.id,
          OR: [
            { status: { in: ['PENDING', 'ERROR', 'POSTING'] } },
            {
              status: 'POSTED',
              qboMutationAttempts: {
                some: {
                  operation: 'restore',
                  status: { in: ['PREPARED', 'RETRYABLE', 'COMMITTING', 'UNCERTAIN'] },
                },
              },
            },
          ],
        }
      : {
          companyId: company.id,
          status: query.status === 'SUPERSEDED' ? { in: [] } : query.status,
        };
    const rows = await prisma.transaction.findMany({
      where: queueWhere,
      include: transactionReadInclude,
      orderBy: { date: 'asc' },
    });
    // Same-date rows keep QBO entry order (ids are numeric strings — uuid
    // secondary sort would shuffle them run to run).
    sortTransactionRows(rows);
    let dtos = await transactionDtos(company.id, rows);

    if (query.search !== undefined && query.search.trim() !== '') {
      const accounts = await prisma.qboAccount.findMany({ where: { companyId: company.id } });
      const fullNameOf = new Map(accounts.map((a) => [a.name, a.fullName]));
      dtos = filterTransactionDtos(dtos, query, fullNameOf);
    } else {
      dtos = filterTransactionDtos(dtos, query);
    }
    if (query.status === undefined) {
      dtos = dtos.filter((dto) =>
        dto.status === 'PENDING'
        || dto.status === 'ERROR'
        || dto.status === 'POSTING'
        || (dto.status === 'POSTED' && dto.activeCategorizationAttempt?.operation === 'restore'),
      );
    }
    if (
      supportsActionability
      && query.status === undefined
      && query.providerDisposition === undefined
    ) {
      dtos = dtos.filter((dto) => !providerDispositionIsBlocked(
        dto.providerActionability?.disposition ?? 'UNKNOWN',
      ));
    }
    res.json({
      transactions: dtos,
      nextCursor: null,
      pendingCount,
      ...(supportsActionability
        ? {
            actionableCount,
            blockedCount,
            unknownCount: providerCounts?.unknown ?? 0,
          }
        : {}),
    });
  }),
);

/**
 * Refresh one bounded page of provider safety observations. This is a
 * read-only QBO operation; callers resume with nextCursor until complete.
 */
companyTransactionsRouter.post(
  '/actionability/refresh',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const user = requestUser(req);
    const query = validate(actionabilityRefreshQuery)(req.query);
    try {
      const result = await refreshProviderActionability(user.id, company.id, query);
      res.json(result);
    } catch (error) {
      if (error instanceof QboRateLimitError) {
        res.set('Retry-After', String(error.retryAfterSeconds));
        throw new HttpError(
          429,
          'QuickBooks is temporarily rate limited. Retry this status check.',
          'RATE_LIMITED',
        );
      }
      throw error;
    }
  }),
);

// ---------------------------------------------------------------------------
// /api/companies/:companyId/transfer-candidates
// ---------------------------------------------------------------------------

export const transferCandidatesRouter = Router({ mergeParams: true });
transferCandidatesRouter.use(requireUser, withCompany(), requireRole('categorizer'));

transferCandidatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const candidates = await transferCandidates(company.id);

    // The map holds both directions; keep each pair once.
    const pairIds: [string, string][] = [];
    const seen = new Set<string>();
    for (const [idA, idB] of candidates) {
      if (seen.has(idA) || seen.has(idB)) continue;
      seen.add(idA);
      seen.add(idB);
      pairIds.push([idA, idB]);
    }

    const ids = pairIds.flat();
    const rows = ids.length > 0
      ? await prisma.transaction.findMany({
          where: { id: { in: ids }, companyId: company.id },
          include: transactionReadInclude,
        })
      : [];
    const dtos = await transactionDtos(company.id, rows, candidates);
    const byId = new Map(dtos.map((d) => [d.id, d]));

    const pairs: { a: TransactionDto; b: TransactionDto }[] = [];
    for (const [idA, idB] of pairIds) {
      const first = byId.get(idA);
      const second = byId.get(idB);
      if (!first || !second) continue;
      const hasProviderIndex = first.providerActionability !== undefined
        || second.providerActionability !== undefined;
      if (
        hasProviderIndex
        && (first.providerActionability?.disposition !== 'WRITABLE'
          || second.providerActionability?.disposition !== 'WRITABLE')
      ) continue;
      // Money-out leg first, for a stable presentation.
      const [a, b] = first.amount < 0 ? [first, second] : [second, first];
      pairs.push({ a, b });
    }
    res.json(pairs);
  }),
);

// ---------------------------------------------------------------------------
// /api/transactions — actions
// ---------------------------------------------------------------------------

const splitSchema = z.object({
  // Signed, matching the txn's sign (validated against the txn in the handler);
  // a zero line is rejected outright.
  amount: z
    .number()
    .finite()
    .refine((a) => Math.abs(a) >= 0.005, { message: 'Every split needs a nonzero amount.' }),
  category: z.string().min(1),
  categoryQboId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).default([]),
  memo: z.string().optional(),
});

const categorizeBody = z.object({
  category: z.string().min(1).nullish(),
  categoryQboId: z.string().min(1).nullish(),
  splits: z.array(splitSchema).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
});

const transferBody = z.object({
  counterpartTxnId: z.string().uuid(),
}).strict();

const bulkPostBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

const transactionIdSchema = z.string().uuid();
const expectedRevisionSchema = z.number().int().min(0).max(MAX_EXPECTED_TRANSACTION_REVISION);
const qboReferenceSchema = z.string().trim().min(1).max(120);
const requestIdSchema = z.string().uuid();
const uniqueTagIdsSchema = z.array(z.string().uuid()).max(50)
  .refine((values) => new Set(values).size === values.length, 'Tag IDs must be unique.');

const stageCategorizationLineSchema: z.ZodType<ManualStageCategorizationBody['lines'][number]> = z.object({
  grossCents: z.number().refine(Number.isSafeInteger, 'Line cents must be a safe integer.'),
  categoryQboId: qboReferenceSchema,
  taxCodeQboId: qboReferenceSchema.nullable(),
  memo: z.string().max(500).optional(),
  tagIds: uniqueTagIdsSchema,
}).strict();

const manualStageCategorizationBodySchema = z.object({
  expectedRevision: expectedRevisionSchema,
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  lines: z.array(stageCategorizationLineSchema).min(1).max(20),
  tagIds: uniqueTagIdsSchema,
}).strict().superRefine((body, context) => {
  for (const [lineIndex, line] of body.lines.entries()) {
    if (body.taxCalculation === 'NotApplicable' && line.taxCodeQboId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'NotApplicable lines must use a null taxCodeQboId.',
        path: ['lines', lineIndex, 'taxCodeQboId'],
      });
    }
    if (body.taxCalculation !== 'NotApplicable' && line.taxCodeQboId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Taxed lines require a taxCodeQboId.',
        path: ['lines', lineIndex, 'taxCodeQboId'],
      });
    }
  }
});

const ruleActionV2Schema = z.object({
  version: z.literal(2),
  direction: z.enum(['Purchase', 'Deposit']),
  category: z.string().trim().min(1).max(500),
  categoryQboId: qboReferenceSchema,
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  taxCodeQboId: qboReferenceSchema.nullable(),
  tagIds: uniqueTagIdsSchema,
}).strict().superRefine((action, context) => {
  if (action.taxCalculation === 'NotApplicable' && action.taxCodeQboId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'NotApplicable rules cannot use a tax code.',
      path: ['taxCodeQboId'],
    });
  }
  if (action.taxCalculation !== 'NotApplicable' && action.taxCodeQboId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Taxed rules require a tax code.',
      path: ['taxCodeQboId'],
    });
  }
});

const ruleSuggestionStageBodySchema = z.object({
  expectedRevision: expectedRevisionSchema,
  ruleSuggestion: z.object({
    source: z.literal('rule'),
    version: z.literal(2),
    ruleId: z.string().trim().min(1).max(128),
    ruleRevision: z.number().int().min(1).max(MAX_EXPECTED_TRANSACTION_REVISION),
    action: ruleActionV2Schema,
    autoPost: z.boolean(),
  }).strict(),
}).strict();

const stageCategorizationBodySchema: z.ZodType<StageCategorizationBody> = z.union([
  ruleSuggestionStageBodySchema,
  manualStageCategorizationBodySchema,
]);

const commitCategorizationBodySchema: z.ZodType<CommitCategorizationBody> = z.object({
  expectedRevision: expectedRevisionSchema,
  requestId: requestIdSchema,
}).strict();

const reconcileCategorizationBodySchema: z.ZodType<ReconcileCategorizationBody> = z.object({
  requestId: requestIdSchema,
}).strict();

const undoCategorizationBodySchema: z.ZodType<UndoCategorizationBody> = z.object({
  requestId: requestIdSchema,
}).strict();

const safeCentsSchema = z.number().refine(Number.isSafeInteger, 'Cents must be a safe integer.');
const stageCategorizationResponseSchema = z.object({
  transactionId: z.string().uuid(),
  revision: z.number().int().min(1).max(MAX_EXPECTED_TRANSACTION_REVISION + 1),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  totals: z.object({
    subtotalCents: safeCentsSchema,
    taxCents: safeCentsSchema,
    totalCents: safeCentsSchema,
  }),
  lines: z.array(z.object({
    idx: z.number().int().min(0).max(19),
    subtotalCents: safeCentsSchema,
    taxCents: safeCentsSchema,
    totalCents: safeCentsSchema,
    categoryQboId: qboReferenceSchema,
    taxCodeQboId: qboReferenceSchema.nullable(),
    memo: z.string().max(500).nullable(),
    tagIds: uniqueTagIdsSchema,
  })).min(1).max(20),
  tagIds: uniqueTagIdsSchema,
});

function boundedStageCategorizationResponse(
  value: unknown,
  expectedTransactionId: string,
): z.infer<typeof stageCategorizationResponseSchema> {
  const parsed = stageCategorizationResponseSchema.parse(value);
  if (parsed.transactionId !== expectedTransactionId) {
    throw new HttpError(500, 'Internal server error');
  }
  return parsed;
}

interface CategorizationScope {
  transactionId: string;
  companyId: string;
}

async function loadCategorizationScope(untrustedId: string | undefined): Promise<CategorizationScope> {
  const transactionId = validate(transactionIdSchema)(untrustedId);
  const txn = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, companyId: true },
  });
  if (!txn) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  return { transactionId: txn.id, companyId: txn.companyId };
}

async function assertCompanyConnected(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { disconnectedAt: true },
  });
  if (!company) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  if (company.disconnectedAt !== null) {
    throw new HttpError(
      409,
      'This company is disconnected from QuickBooks.',
      'COMPANY_DISCONNECTED',
    );
  }
}

async function assertLegacyCategorizationAllowed(
  txn: Pick<
    TxnRow,
    | 'id'
    | 'companyId'
    | 'qboType'
    | 'taxCalculation'
    | 'taxCodeQboId'
    | 'splitLines'
    | 'qboMutationAttempts'
  >,
): Promise<void> {
  if (txn.qboType !== 'Purchase' && txn.qboType !== 'Deposit') return;
  const hasStagedMarker =
    txn.taxCalculation !== null ||
    txn.taxCodeQboId !== null ||
    txn.splitLines.some((line) => line.taxCodeQboId !== null);
  const durableAttempt =
    txn.qboMutationAttempts.length > 0
      ? txn.qboMutationAttempts[0]
      : await prisma.qboMutationAttempt.findFirst({
          where: { transactionId: txn.id },
          select: { id: true },
        });
  if (hasStagedMarker || durableAttempt) {
    throw new HttpError(
      409,
      txn.qboType === 'Purchase'
        ? 'Tax-ready Purchases must use staged categorization.'
        : 'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
  if (txn.qboType === 'Deposit') {
    const readiness = await getTaxReadiness(txn.companyId);
    if (readiness.salesStatus !== 'ready') return;
    throw new HttpError(
      409,
      'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
  const company = await prisma.company.findUnique({
    where: { id: txn.companyId },
    select: { taxSupportStatus: true, taxUsingSalesTax: true },
  });
  if (!company) throw new HttpError(404, 'Transaction not found', 'TRANSACTION_NOT_FOUND');
  if (company.taxSupportStatus === 'ready' && company.taxUsingSalesTax === true) {
    throw new HttpError(
      409,
      txn.qboType === 'Purchase'
        ? 'Tax-ready Purchases must use staged categorization.'
        : 'Tax-ready transactions must use staged categorization.',
      'TAX_AWARE_STAGING_REQUIRED',
    );
  }
}

async function assertAttemptScope(requestId: string, transactionId: string): Promise<void> {
  const attempt = await prisma.qboMutationAttempt.findUnique({
    where: { requestId },
    select: { transactionId: true },
  });
  if (!attempt || attempt.transactionId !== transactionId) {
    throw new HttpError(404, 'Mutation attempt not found', 'ATTEMPT_NOT_FOUND');
  }
}

const SAFE_SERVICE_ERRORS: Record<string, { status: number; message: string }> = {
  ATTEMPT_CORRUPT: { status: 500, message: 'Mutation state could not be verified.' },
  ATTEMPT_NOT_FOUND: { status: 404, message: 'Mutation attempt not found.' },
  COMPANY_DISCONNECTED: { status: 409, message: 'This company is disconnected from QuickBooks.' },
  DB_COMMIT_FAILED: {
    status: 409,
    message: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
  },
  ENTITY_BUSY: { status: 409, message: 'Another write is already in progress.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that.' },
  INVALID_ACCOUNT: { status: 400, message: 'One or more category accounts are unavailable for this company.' },
  INVALID_INPUT: { status: 400, message: 'The categorization request is invalid.' },
  INVALID_STAGE: { status: 409, message: 'The staged categorization is no longer valid.' },
  INVALID_STATUS: { status: 409, message: 'The transaction cannot be changed from its current status.' },
  INVALID_TAG: { status: 400, message: 'One or more tags are unavailable for this company.' },
  INVALID_TRANSACTION_AMOUNT: { status: 400, message: 'The transaction amount cannot be categorized safely.' },
  MUTATION_BLOCKED: {
    status: 409,
    message: 'This transaction has a prepared write that must be resumed or verified.',
  },
  PREWRITE_PERSISTENCE_FAILED: { status: 503, message: 'The prepared write was not sent. Retry with a new request.' },
  QBO_AMOUNT_UNSAFE: { status: 400, message: 'The transaction amount cannot be categorized safely.' },
  QBO_DEPOSIT_UNSUPPORTED: { status: 400, message: 'This transaction cannot use tax-aware Deposit writeback.' },
  QBO_ENTITY_UNSUPPORTED: { status: 400, message: 'This transaction type cannot use tax-aware writeback.' },
  QBO_PERIOD_CLOSED: { status: 409, message: 'QuickBooks has closed this accounting period.' },
  QBO_PURCHASE_UNSUPPORTED: { status: 400, message: 'This transaction cannot use tax-aware Purchase writeback.' },
  QBO_REFERENCE_MISSING: { status: 400, message: 'Required QuickBooks references are unavailable.' },
  QBO_STATE_DRIFT: { status: 409, message: 'The QuickBooks transaction changed. Reload before continuing.' },
  QBO_TRANSACTION_LOCKED: {
    status: 409,
    message: 'QuickBooks reports this transaction as cleared or reconciled.',
  },
  QBO_WRITE_SAFETY_UNAVAILABLE: {
    status: 503,
    message: 'QuickBooks write-safety status is unavailable.',
  },
  RECONCILE_NOT_ALLOWED: { status: 409, message: 'This mutation attempt does not require reconciliation.' },
  LIVE_RECONCILIATION_BINDING_MISMATCH: {
    status: 409,
    message: 'This live mutation is no longer bound to the current transaction state.',
  },
  REQUEST_ID_CONFLICT: { status: 409, message: 'This request ID belongs to a different mutation.' },
  RULE_SUGGESTION_BUSY: { status: 409, message: 'Rule state is changing. Retry this suggestion.' },
  STALE_REVISION: { status: 409, message: 'The transaction changed. Reload before continuing.' },
  STALE_RULE_SUGGESTION: {
    status: 409,
    message: 'This rule suggestion changed. Reload before continuing.',
  },
  SUPERSEDED: { status: 409, message: 'This transaction was already categorized in QuickBooks.' },
  TAX_AMOUNT_INVALID: { status: 400, message: 'The tax amount cannot be calculated safely.' },
  TAX_AMOUNT_SIGN_MISMATCH: { status: 400, message: 'Categorization lines do not match the transaction direction.' },
  UNDO_WINDOW_EXPIRED: { status: 409, message: 'The 30-day undo window is unavailable for this transaction.' },
  TAX_AWARE_STAGING_REQUIRED: {
    status: 409,
    message: 'Tax-ready transactions must use staged categorization.',
  },
  TAX_CODE_INACTIVE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_CODE_MALFORMED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_PURCHASE_ONLY: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_SALES_ONLY: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_CODE_UNAVAILABLE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_COMPANY_MISMATCH: { status: 400, message: 'A selected tax reference is unavailable for this company.' },
  TAX_NOT_READY: { status: 409, message: 'Tax references are not ready.' },
  TAX_RATE_INACTIVE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_RATE_MALFORMED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_RATE_UNAVAILABLE: { status: 400, message: 'A selected tax code is unavailable.' },
  TAX_RATE_UNSUPPORTED: { status: 400, message: 'A selected tax code is unsupported.' },
  TAX_REQUIRES_PURCHASE: { status: 400, message: 'Tax selection is unsupported for this transaction type.' },
  TAX_TREATMENT_AMBIGUOUS: { status: 400, message: 'A selected tax code is unsupported.' },
  TRANSFER_RECONCILIATION_REQUIRED: {
    status: 409,
    message:
      'The transfer may be partially recorded. Verify both transactions in QuickBooks before retrying.',
  },
  TRANSFER_RETRYABLE: {
    status: 409,
    message: 'The transfer was not sent. Retry this transfer.',
  },
  TRANSACTION_NOT_FOUND: { status: 404, message: 'Transaction not found.' },
  UNBALANCED_TOTAL: { status: 400, message: 'Categorization lines do not balance to the transaction total.' },
  VERIFIED_POST_REQUIRED: { status: 409, message: 'Undo requires a verified posted categorization.' },
};

function mappedServiceHttpError(error: unknown): HttpError | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string') {
    const safe = SAFE_SERVICE_ERRORS[code];
    if (safe) return new HttpError(safe.status, safe.message, code);
  }
  return null;
}

function throwMappedServiceError(error: unknown): never {
  const mapped = mappedServiceHttpError(error);
  if (mapped) throw mapped;
  throw error;
}

async function assertProviderWritable(companyId: string, transactionId: string): Promise<void> {
  try {
    await assertTransactionProviderActionability(companyId, transactionId);
  } catch (error) {
    throwMappedServiceError(error);
  }
}

const SAFE_OUTCOME_ERRORS: Partial<Record<
  DurableMutationResult['outcome'],
  { code: string; message: string }
>> = {
  IN_PROGRESS: {
    code: 'MUTATION_IN_PROGRESS',
    message: 'This prepared write is already in progress and will not be sent again.',
  },
  RETRYABLE: {
    code: 'RETRYABLE',
    message: 'The prepared write was not sent. Create a new request to retry.',
  },
  UNCERTAIN: {
    code: 'QBO_WRITE_UNCERTAIN',
    message: 'The QuickBooks write may have succeeded — verify in QuickBooks before retrying.',
  },
  REJECTED: {
    code: 'QBO_WRITE_REJECTED',
    message: 'QuickBooks rejected the prepared transaction. Correct it and prepare a new operation.',
  },
};

const OPERATION_RECONCILIATION_REQUIRED_ERROR = {
  code: 'OPERATION_RECONCILIATION_REQUIRED',
  message: 'QuickBooks rejected the write, but Recat could not persist that outcome. Reconcile this operation before continuing.',
};

function sendMutationResult(
  res: Response,
  result: DurableMutationResult,
  expected: { transactionId: string; requestId: string },
): void {
  if (
    result.transactionId !== expected.transactionId ||
    result.requestId !== expected.requestId
  ) {
    throw new HttpError(500, 'Mutation result identity could not be verified.');
  }
  const safe: CategorizationMutationResult = {
    transactionId: result.transactionId,
    requestId: result.requestId,
    ok: result.ok,
    status: result.status,
    outcome: result.outcome,
  };
  const reconciliationRequired = result.error?.code
    === OPERATION_RECONCILIATION_REQUIRED_ERROR.code;
  const safeError = reconciliationRequired
    ? OPERATION_RECONCILIATION_REQUIRED_ERROR
    : SAFE_OUTCOME_ERRORS[result.outcome];
  if (!result.ok && safeError) safe.error = safeError;
  const status = reconciliationRequired ? 409
    : result.outcome === 'IN_PROGRESS' ? 202
    : result.outcome === 'UNCERTAIN' || result.outcome === 'RETRYABLE' ? 409
      : result.outcome === 'REJECTED' ? 422
      : 200;
  res.status(status).json(safe);
}

async function resolveCategoryQboId(
  companyId: string,
  name: string,
  given: string | null | undefined,
): Promise<string | null> {
  // Never trust a client-supplied account id verbatim: it must be an active
  // account in THIS company's chart of accounts (defense in depth — a stray
  // id would otherwise be written straight to QBO on post).
  if (given) {
    const byId = await prisma.qboAccount.findFirst({ where: { companyId, qboId: given, active: true } });
    if (!byId) {
      throw new HttpError(
        400,
        `Category account '${given}' is not an active account for this company`,
        'BAD_CATEGORY_ACCOUNT',
      );
    }
    return given;
  }
  const acct = await prisma.qboAccount.findFirst({ where: { companyId, name, active: true } });
  return acct?.qboId ?? null;
}

export const transactionActionsRouter = Router();
transactionActionsRouter.use(requireUser);

transactionActionsRouter.post(
  '/:id/categorization/stage',
  asyncHandler(async (req, res) => {
    const body = validate(stageCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    await assertCategorizationRouteAccess(requestUser(req), scope.companyId);
    await assertCompanyConnected(scope.companyId);
    try {
      // Staging is Recat-local. The commit path performs a fresh QBO safety
      // check immediately before any provider write.
      const staged = 'ruleSuggestion' in body
        ? await stageRuleSuggestion({
            transactionId: scope.transactionId,
            companyId: scope.companyId,
            expectedRevision: body.expectedRevision,
            suggestion: body.ruleSuggestion,
          })
        : await stageCategorization({
            transactionId: scope.transactionId,
            companyId: scope.companyId,
            expectedRevision: body.expectedRevision,
            proposal: {
              taxCalculation: body.taxCalculation,
              lines: body.lines,
              tagIds: body.tagIds,
            },
          });
      res.json(boundedStageCategorizationResponse(staged, scope.transactionId));
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

transactionActionsRouter.post(
  '/:id/categorization/commit',
  asyncHandler(async (req, res) => {
    const body = validate(commitCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    const user = requestUser(req);
    await assertCategorizationRouteAccess(user, scope.companyId);
    try {
      const result = await commitStagedCategorization({
        transactionId: scope.transactionId,
        companyId: scope.companyId,
        expectedRevision: body.expectedRevision,
        requestId: body.requestId,
        actor: actorFor(user),
        captureManualApproval: true,
      });
      sendMutationResult(res, result, {
        transactionId: scope.transactionId,
        requestId: body.requestId,
      });
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

async function reconcileCategorizationRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const body = validate(reconcileCategorizationBodySchema)(req.body);
  const scope = await loadCategorizationScope(req.params.id);
  const user = requestUser(req);
  await assertCategorizationRouteAccess(user, scope.companyId);
  await assertCompanyConnected(scope.companyId);
  await assertAttemptScope(body.requestId, scope.transactionId);
  try {
    const actor = actorFor(user);
    const liveOwned = await isLiveReconciliationOwnedRequest(
      body.requestId,
      scope.companyId,
      scope.transactionId,
    );
    let result: DurableMutationResult;
    if (!liveOwned) {
      result = await reconcileMutationAttempt({
          requestId: body.requestId,
          actor,
        });
    } else {
      await assertAdminFor(user, scope.companyId);
      const live = await loadLiveReconciliationRequest(
        body.requestId,
        scope.companyId,
        scope.transactionId,
      );
      if (live === null) {
        throw new HttpError(
          409,
          'This live mutation is no longer bound to the current transaction state.',
          'LIVE_RECONCILIATION_BINDING_MISMATCH',
        );
      }
      result = await reconcileLiveMutation(live, { actor });
    }
    sendMutationResult(res, result, {
      transactionId: scope.transactionId,
      requestId: body.requestId,
    });
  } catch (error) {
    throwMappedServiceError(error);
  }
}

transactionActionsRouter.post(
  '/:id/categorization/reconcile',
  asyncHandler(reconcileCategorizationRequest),
);

transactionActionsRouter.post(
  '/:id/categorization/retry',
  asyncHandler(reconcileCategorizationRequest),
);

transactionActionsRouter.post(
  '/:id/categorization/undo',
  asyncHandler(async (req, res) => {
    const body = validate(undoCategorizationBodySchema)(req.body);
    const scope = await loadCategorizationScope(req.params.id);
    const user = requestUser(req);
    await assertCategorizationRouteAccess(user, scope.companyId);
    try {
      const result = await undoCategorization({
        transactionId: scope.transactionId,
        companyId: scope.companyId,
        requestId: body.requestId,
        actor: actorFor(user),
      });
      sendMutationResult(res, result, {
        transactionId: scope.transactionId,
        requestId: body.requestId,
      });
    } catch (error) {
      throwMappedServiceError(error);
    }
  }),
);

// Stage category/splits/tags locally — never writes to QBO.
transactionActionsRouter.post(
  '/:id/categorize',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const body = validate(categorizeBody)(req.body);
    const txn = await loadTxn(id);
    await assertCategorizerFor(requestUser(req), txn.companyId);
    await assertLegacyCategorizationAllowed(txn);
    if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
      throw new HttpError(400, `Cannot edit a transaction in status ${txn.status}`, 'BAD_STATUS');
    }
    const companyId = txn.companyId;
    // Draft categorization is Recat-local and remains available while a
    // cached provider observation is missing or stale.
    const amount = Number(txn.amount);
    const data: Prisma.TransactionUpdateInput = {};

    if (body.splits && body.splits.length > 0) {
      const splitCheck = validateSplits(amount, body.splits);
      if (!splitCheck.ok) {
        throw new HttpError(400, splitCheck.message ?? 'Split amounts must add up to the transaction amount.', 'BAD_SPLITS');
      }
      // Every split-line tag must belong to this company (same gate as txn tags).
      const splitTagIds = [...new Set(body.splits.flatMap((s) => s.tagIds))];
      if (splitTagIds.length > 0) {
        const owned = await prisma.tag.findMany({ where: { companyId, id: { in: splitTagIds } } });
        if (owned.length !== splitTagIds.length) {
          throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
        }
      }
      const lines: Prisma.SplitLineCreateWithoutTxnInput[] = [];
      for (const [i, s] of body.splits.entries()) {
        const qboId = await resolveCategoryQboId(companyId, s.category, s.categoryQboId);
        lines.push({
          idx: i, // array order IS the line order
          amount: s.amount,
          category: s.category,
          categoryQboId: qboId,
          memo: s.memo ?? null,
          tags: { create: [...new Set(s.tagIds)].map((tagId) => ({ tagId })) },
        });
      }
      // Replace the txn's split set: delete the existing lines (SplitLineTag
      // rows cascade), then create the new ones — one nested atomic update.
      data.splitLines = { deleteMany: {}, create: lines };
      data.category = null;
      data.categoryQboId = null;
    } else {
      if (body.splits === null) data.splitLines = { deleteMany: {} };
      if (body.category !== undefined) {
        if (body.category === null) {
          data.category = null;
          data.categoryQboId = null;
        } else {
          data.category = body.category;
          data.categoryQboId = await resolveCategoryQboId(companyId, body.category, body.categoryQboId);
          data.splitLines = { deleteMany: {} }; // single category replaces any staged splits
        }
      }
    }

    await prisma.transaction.update({ where: { id }, data });

    if (body.tagIds !== undefined) {
      const owned = await prisma.tag.findMany({ where: { companyId, id: { in: body.tagIds } } });
      if (owned.length !== new Set(body.tagIds).size) {
        throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
      }
      await prisma.txnTag.deleteMany({ where: { txnId: id } });
      for (const tagId of new Set(body.tagIds)) {
        await prisma.txnTag.create({ data: { txnId: id, tagId } });
      }
    }

    // Manual edits apply only explicit user choices. Complete rule actions
    // (including tags and tax) require revision-verified rule suggestion staging.

    res.json(await dtoById(id));
  }),
);

// Post to QuickBooks. Awaited (mock is instant, real is a couple of seconds)
// and the resulting DTO is returned so the client can treat it as completion.
transactionActionsRouter.post(
  '/:id/post',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const user = requestUser(req);
    const txn = await loadTxn(id); // 404 before the write-back service's plain Errors
    await assertCategorizerFor(user, txn.companyId);

    // postTransaction fetches current QBO state and enforces write safety at
    // the write boundary; a cached actionability observation is not a gate.
    let result;
    try {
      result = await postTransaction(id, actorFor(user));
    } catch (err) {
      const mapped = mappedServiceHttpError(err);
      if (mapped) throw mapped;
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'POST_FAILED');
    }
    if (!result.ok) {
      const mapped = mappedServiceHttpError(result.error);
      if (mapped) throw mapped;
      throw new HttpError(400, 'The transaction could not be posted.', 'POST_FAILED');
    }

    const dto = await dtoById(id);

    // 'Always file X as Y?' prompt: post succeeded, single category, and no
    // rule already covers this payee.
    let rulePromptEligible = false;
    if (
      result.ok &&
      (result.status === 'POSTED' || result.status === 'DRY_RUN') &&
      dto.category !== null &&
      (dto.splits === null || dto.splits.length === 0)
    ) {
      const [suggestion] = await suggestForMany(dto.companyId, [{
        payee: dto.payee,
        memo: dto.memo,
        amount: dto.amount,
        qboType: dto.qboType,
      }]);
      rulePromptEligible = suggestion?.source !== 'rule';
    }

    res.status(202).json({ ...dto, rulePromptEligible });
  }),
);

transactionActionsRouter.post(
  '/:id/undo',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const user = requestUser(req);
    const txn = await loadTxn(id);
    await assertCategorizerFor(user, txn.companyId);
    let result;
    try {
      result = await undoPost(id, actorFor(user));
    } catch (err) {
      const mapped = mappedServiceHttpError(err);
      if (mapped) throw mapped;
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'UNDO_FAILED');
    }
    if (!result.ok) {
      const mapped = mappedServiceHttpError(result.error);
      if (mapped) throw mapped;
      throw new HttpError(409, 'The QuickBooks undo could not be verified.', 'UNDO_FAILED');
    }
    res.json(await dtoById(id));
  }),
);

transactionActionsRouter.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const txn = await loadTxn(id);
    await assertCategorizerFor(requestUser(req), txn.companyId);
    try {
      // retryError refreshes the provider snapshot but only changes Recat
      // state; a cached actionability observation is not a gate.
      await retryError(id);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'RETRY_FAILED');
    }
    res.json(await dtoById(id));
  }),
);

transactionActionsRouter.post(
  '/:id/transfer',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const { counterpartTxnId } = validate(transferBody)(req.body);
    const user = requestUser(req);
    const txn = await loadTxn(id);
    await assertCategorizerFor(user, txn.companyId);
    await assertProviderWritable(txn.companyId, id);
    await assertProviderWritable(txn.companyId, counterpartTxnId);
    try {
      await recordTransfer(id, counterpartTxnId, actorFor(user));
    } catch (err) {
      const mapped = mappedServiceHttpError(err);
      if (mapped) throw mapped;
      throw new HttpError(
        400,
        'Transfer could not be recorded.',
        'TRANSFER_FAILED',
      );
    }
    res.json([await dtoById(id), await dtoById(counterpartTxnId)]);
  }),
);

transactionActionsRouter.post(
  '/bulk-post',
  asyncHandler(async (req, res) => {
    const { ids } = validate(bulkPostBody)(req.body);
    const user = requestUser(req);

    // Role gate BEFORE any write: categorizer+ in every company touched.
    const companyIds = await prisma.transaction.findMany({
      where: { id: { in: ids } },
      select: { companyId: true },
      distinct: ['companyId'],
    });
    for (const { companyId } of companyIds) {
      await assertCategorizerFor(user, companyId);
    }

    const results = await bulkPost(ids, actorFor(user));

    const rows = await prisma.transaction.findMany({
      where: { id: { in: ids } },
      include: transactionReadInclude,
    });
    const byCompany = new Map<string, TxnRow[]>();
    for (const row of rows) {
      const list = byCompany.get(row.companyId) ?? [];
      list.push(row);
      byCompany.set(row.companyId, list);
    }
    const transactions: TransactionDto[] = [];
    for (const [companyId, companyRows] of byCompany) {
      transactions.push(...(await transactionDtos(companyId, companyRows)));
    }

    res.json({
      results: results.map((r) => ({
        id: r.id,
        ok: r.ok,
        ...(r.error !== undefined ? { error: r.error.message } : {}),
      })),
      transactions,
    });
  }),
);
