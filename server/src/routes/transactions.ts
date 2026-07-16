// Transaction routes — two routers:
//   companyTransactionsRouter  → /api/companies/:companyId/transactions (queue list)
//   transferCandidatesRouter   → /api/companies/:companyId/transfer-candidates
//   transactionActionsRouter   → /api/transactions (categorize/post/undo/retry/transfer/bulk-post)
// Action routes load the txn by id and scope everything through its companyId.
// Paths and shapes mirror client/src/lib/api.ts exactly (THE contract).

import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import type { SuggestionDto, TransactionDto, TxnStatus } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { effectiveRole, requireRole, requireUser, roleRank } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { ruleSuggestion, suggestForMany, type RuleLike } from '../services/suggestions.js';
import { recordTransfer, transferCandidates } from '../services/transfers.js';
import {
  bulkPost,
  postTransaction,
  retryError,
  splitLineDtos,
  undoPost,
  validateSplits,
  type Actor,
} from '../services/writeback.js';

/** Every txn query in this file loads split lines (with their tags) so the DTO
 * boundary can translate the SplitLine relation back into SplitDto[]. */
const txnInclude = {
  txnTags: true,
  splitLines: { include: { tags: true }, orderBy: { idx: 'asc' as const } },
} satisfies Prisma.TransactionInclude;

type TxnRow = Prisma.TransactionGetPayload<{ include: typeof txnInclude }>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_WORDS: Record<TxnStatus, string> = {
  PENDING: 'pending',
  POSTING: 'posting',
  POSTED: 'posted',
  DRY_RUN: 'dry run',
  ERROR: 'error failed',
  SUPERSEDED: 'superseded',
  REVERTED: 'reverted',
};

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

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/**
 * Map DB rows to TransactionDto. Suggestions for PENDING txns are recomputed
 * live via suggestForMany (rules + history loaded ONCE for the whole page; no
 * AI calls from the list path) so rule edits reflect instantly in the queue.
 */
export async function transactionDtos(
  companyId: string,
  rows: TxnRow[],
  candidatesIn?: Map<string, string>,
): Promise<TransactionDto[]> {
  const candidates = candidatesIn ?? (await transferCandidates(companyId));
  const posterIds = [...new Set(rows.map((r) => r.postedByUserId).filter((v): v is string => v !== null))];
  const posters = posterIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: posterIds } } }) : [];
  const posterLabel = new Map(posters.map((u) => [u.id, u.name ?? u.email.split('@')[0] ?? u.email]));

  const pendingRows = rows.filter((r) => r.status === 'PENDING');
  const liveSuggestions = await suggestForMany(
    companyId,
    pendingRows.map((r) => ({ payee: r.payee, memo: r.memo, amount: Number(r.amount) })),
  );
  const liveSuggestionByTxnId = new Map(pendingRows.map((r, i) => [r.id, liveSuggestions[i] ?? null]));

  const out: TransactionDto[] = [];
  for (const r of rows) {
    const amount = Number(r.amount);
    // Live pipeline first (rule edits must reflect instantly); fall back to the
    // snapshot computed at sync time (covers seeded/demo history suggestions
    // and AI suggestions stored by refreshSuggestions).
    const suggestion: SuggestionDto | null =
      r.status === 'PENDING'
        ? ((liveSuggestionByTxnId.get(r.id) ?? null) ?? (r.suggestion as SuggestionDto | null))
        : null;
    out.push({
      id: r.id,
      companyId: r.companyId,
      qboId: r.qboId,
      qboType: r.qboType as TransactionDto['qboType'],
      date: r.date.toISOString(),
      payee: r.payee,
      memo: r.memo,
      amount,
      bankAccount: r.bankAccount,
      status: r.status,
      category: r.category,
      categoryQboId: r.categoryQboId,
      splits: splitLineDtos(r.splitLines),
      tagIds: r.txnTags.map((t) => t.tagId),
      suggestion,
      error:
        r.status === 'ERROR' && (r.errorCode !== null || r.errorMessage !== null)
          ? { code: r.errorCode ?? 'QBO_ERROR', message: r.errorMessage ?? 'Unknown error' }
          : null,
      postedAt: r.postedAt?.toISOString() ?? null,
      postedBy: r.postedByUserId !== null ? (posterLabel.get(r.postedByUserId) ?? null) : null,
      transferCandidateId: candidates.get(r.id) ?? null,
    });
  }
  return out;
}

async function loadTxn(id: string): Promise<TxnRow> {
  const txn = await prisma.transaction.findUnique({ where: { id }, include: txnInclude });
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
// Search (server-side, matching the prototype's client-side matcher)
// ---------------------------------------------------------------------------

function formatQueueDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`;
}

function haystack(dto: TransactionDto, fullNameOf: Map<string, string>): string {
  const abs = Math.abs(dto.amount).toFixed(2);
  const parts = [
    dto.payee,
    dto.memo ?? '',
    dto.bankAccount,
    formatQueueDate(dto.date),
    dto.category ?? '',
    dto.category !== null ? (fullNameOf.get(dto.category) ?? '') : '',
    ...(dto.splits ?? []).flatMap((s) => [s.category, fullNameOf.get(s.category) ?? '']),
    dto.suggestion?.category ?? '',
    dto.suggestion !== null ? (fullNameOf.get(dto.suggestion.category) ?? '') : '',
    STATUS_WORDS[dto.status],
    abs,
    `$${abs}`,
    `${dto.amount < 0 ? '-' : '+'}$${abs}`,
  ];
  return parts.join(' ').toLowerCase();
}

function matchesSearch(dto: TransactionDto, search: string, fullNameOf: Map<string, string>): boolean {
  const hay = haystack(dto, fullNameOf);
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .every((token) => hay.includes(token));
}

// ---------------------------------------------------------------------------
// /api/companies/:companyId/transactions
// ---------------------------------------------------------------------------

const txnStatusSchema = z.enum(['PENDING', 'POSTING', 'POSTED', 'DRY_RUN', 'ERROR', 'SUPERSEDED', 'REVERTED']);

const listQuery = z.object({
  status: txnStatusSchema.optional(),
  search: z.string().optional(),
  account: z.string().optional(),
  cursor: z.string().optional(),
  countOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export const companyTransactionsRouter = Router({ mergeParams: true });
companyTransactionsRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('categorizer'));

companyTransactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = req.company;
    if (!company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    const query = validate(listQuery)(req.query);

    // Queue badge: everything still waiting for a human (pending or errored).
    const pendingCount = await prisma.transaction.count({
      where: { companyId: company.id, status: { in: ['PENDING', 'ERROR'] } },
    });
    if (query.countOnly) {
      res.json({ transactions: [], nextCursor: null, pendingCount });
      return;
    }

    // The queue shows posted/dry-run/error rows too; only SUPERSEDED is hidden.
    // Prototype order: date ascending as entered.
    const rows = await prisma.transaction.findMany({
      where: { companyId: company.id, status: { not: 'SUPERSEDED' } },
      include: txnInclude,
      orderBy: { date: 'asc' },
    });
    // Same-date rows keep QBO entry order (ids are numeric strings — uuid
    // secondary sort would shuffle them run to run).
    rows.sort((a, b) => {
      const d = a.date.getTime() - b.date.getTime();
      if (d !== 0) return d;
      const an = Number(a.qboId);
      const bn = Number(b.qboId);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.qboId.localeCompare(b.qboId);
    });
    let dtos = await transactionDtos(company.id, rows);

    if (query.status !== undefined) dtos = dtos.filter((d) => d.status === query.status);
    if (query.account !== undefined && query.account !== '' && query.account !== 'all') {
      dtos = dtos.filter((d) => d.bankAccount === query.account);
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const accounts = await prisma.qboAccount.findMany({ where: { companyId: company.id } });
      const fullNameOf = new Map(accounts.map((a) => [a.name, a.fullName]));
      dtos = dtos.filter((d) => matchesSearch(d, query.search ?? '', fullNameOf));
    }

    res.json({ transactions: dtos, nextCursor: null, pendingCount });
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
      ? await prisma.transaction.findMany({ where: { id: { in: ids }, companyId: company.id }, include: txnInclude })
      : [];
    const dtos = await transactionDtos(company.id, rows, candidates);
    const byId = new Map(dtos.map((d) => [d.id, d]));

    const pairs: { a: TransactionDto; b: TransactionDto }[] = [];
    for (const [idA, idB] of pairIds) {
      const first = byId.get(idA);
      const second = byId.get(idB);
      if (!first || !second) continue;
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

const transferBody = z.object({ counterpartTxnId: z.string().min(1) });

const bulkPostBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

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

async function loadRuleLikes(companyId: string): Promise<RuleLike[]> {
  return prisma.rule.findMany({
    where: { companyId },
    select: { id: true, matchText: true, category: true, categoryQboId: true, priority: true, createdAt: true },
  });
}

export const transactionActionsRouter = Router();
transactionActionsRouter.use(requireUser);

// Stage category/splits/tags locally — never writes to QBO.
transactionActionsRouter.post(
  '/:id/categorize',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) throw new HttpError(400, 'Missing transaction id', 'BAD_REQUEST');
    const body = validate(categorizeBody)(req.body);
    const txn = await loadTxn(id);
    await assertCategorizerFor(requestUser(req), txn.companyId);
    if (txn.status !== 'PENDING' && txn.status !== 'ERROR') {
      throw new HttpError(400, `Cannot edit a transaction in status ${txn.status}`, 'BAD_STATUS');
    }
    const companyId = txn.companyId;
    const amount = Number(txn.amount);
    const data: Prisma.TransactionUpdateInput = {};
    let stagedCategory: string | null = null;

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
          stagedCategory = body.category;
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

    // Prototype behavior: accepting a rule's suggested category also applies
    // the rule's tags (merged into whatever is already staged).
    if (stagedCategory !== null) {
      const rules = await loadRuleLikes(companyId);
      const match = ruleSuggestion(txn.payee, rules);
      if (match?.ruleId !== undefined && match.category === stagedCategory) {
        const ruleTags = await prisma.ruleTag.findMany({ where: { ruleId: match.ruleId } });
        for (const rt of ruleTags) {
          await prisma.txnTag.upsert({
            where: { txnId_tagId: { txnId: id, tagId: rt.tagId } },
            create: { txnId: id, tagId: rt.tagId },
            update: {},
          });
        }
      }
    }

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

    let result;
    try {
      result = await postTransaction(id, actorFor(user));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'POST_FAILED');
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
      const rules = await loadRuleLikes(dto.companyId);
      rulePromptEligible = ruleSuggestion(dto.payee, rules) === null;
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
    try {
      await undoPost(id, actorFor(user));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'UNDO_FAILED');
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
    try {
      await recordTransfer(id, counterpartTxnId, actorFor(user));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err), 'TRANSFER_FAILED');
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

    const rows = await prisma.transaction.findMany({ where: { id: { in: ids } }, include: txnInclude });
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
