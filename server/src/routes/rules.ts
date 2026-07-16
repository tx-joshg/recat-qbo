// Rule CRUD — /api/companies/:companyId/rules (categorizer+).
// Suggestions are recomputed live in the queue list, so a rule edit is
// visible on the very next fetch with no explicit refresh step.

import { Router } from 'express';
import { z } from 'zod';
import type { Company, Prisma } from '@prisma/client';
import type { RuleDto, RuleTestConflict, RuleTestMatch, RuleTestResult, TxnStatus } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { ruleSuggestion, type RuleLike } from '../services/suggestions.js';

type RuleRow = Prisma.RuleGetPayload<{ include: { ruleTags: true } }>;

const createBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(200),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
});

const patchBody = z.object({
  matchText: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const orderBody = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

const testBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  /** Where the draft would sit in the match order — top (default) always wins. */
  priorityTop: z.boolean().optional().default(true),
});

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

function toRuleDto(rule: RuleRow): RuleDto {
  return {
    id: rule.id,
    companyId: rule.companyId,
    priority: rule.priority,
    matchField: 'payee',
    matchText: rule.matchText,
    category: rule.category,
    categoryQboId: rule.categoryQboId,
    tagIds: rule.ruleTags.map((rt) => rt.tagId),
    autoPost: rule.autoPost,
    createdAt: rule.createdAt.toISOString(),
  };
}

async function resolveCategoryQboId(
  companyId: string,
  category: string,
  given: string | null | undefined,
): Promise<string | null> {
  if (given) return given;
  const acct = await prisma.qboAccount.findFirst({ where: { companyId, name: category, active: true } });
  return acct?.qboId ?? null;
}

async function assertTagsBelong(companyId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const owned = await prisma.tag.count({ where: { companyId, id: { in: tagIds } } });
  if (owned !== new Set(tagIds).size) {
    throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
  }
}

async function loadRule(companyId: string, id: string | undefined): Promise<RuleRow> {
  if (!id) throw new HttpError(400, 'Missing rule id', 'BAD_REQUEST');
  const rule = await prisma.rule.findUnique({ where: { id }, include: { ruleTags: true } });
  if (!rule || rule.companyId !== companyId) throw new HttpError(404, 'Rule not found', 'RULE_NOT_FOUND');
  return rule;
}

export const rulesRouter = Router({ mergeParams: true });
rulesRouter.use(requireUser, requireRole('categorizer'), withCompany({ allowDisconnected: true }));

rulesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    // Priority order — lowest number first (the match order). Client renders as-is.
    const rules = await prisma.rule.findMany({
      where: { companyId: company.id },
      include: { ruleTags: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    const body: RuleDto[] = rules.map(toRuleDto);
    res.json(body);
  }),
);

rulesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const body = validate(createBody)(req.body);
    const tagIds = [...new Set(body.tagIds ?? [])];
    await assertTagsBelong(company.id, tagIds);
    const user = req.user;

    // New rules go to the TOP of the match order: min(priority) - 1. Gaps are
    // fine (lowest number wins); this avoids renumbering every row on create.
    const agg = await prisma.rule.aggregate({ where: { companyId: company.id }, _min: { priority: true } });
    const priority = agg._min.priority === null ? 0 : agg._min.priority - 1;

    const rule = await prisma.rule.create({
      data: {
        companyId: company.id,
        matchField: 'payee',
        matchText: body.matchText,
        category: body.category,
        categoryQboId: await resolveCategoryQboId(company.id, body.category, body.categoryQboId),
        autoPost: body.autoPost ?? false,
        priority,
        createdById: user?.id ?? null,
        ruleTags: { create: tagIds.map((tagId) => ({ tagId })) },
      },
      include: { ruleTags: true },
    });
    res.status(201).json(toRuleDto(rule));
  }),
);

// Dry-run a DRAFT rule (not saved): case-insensitive 'payee contains' against
// the company's transactions (PENDING + POSTED/DRY_RUN, capped at the 200
// newest). For each hit we report whether the draft would win — placed at top
// priority (the default for new rules) it always beats existing rules — plus
// which existing rule currently wins that payee, and every existing rule that
// overlaps any matched payee (conflicts).
rulesRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const body = validate(testBody)(req.body);
    const needle = body.matchText.toLowerCase();

    const [txns, existingRules] = await Promise.all([
      prisma.transaction.findMany({
        where: { companyId: company.id, status: { in: ['PENDING', 'POSTED', 'DRY_RUN'] } },
        select: { id: true, payee: true, date: true, amount: true, status: true },
        orderBy: { date: 'desc' },
        take: 200,
      }),
      prisma.rule.findMany({
        where: { companyId: company.id },
        select: { id: true, matchText: true, category: true, categoryQboId: true, priority: true, createdAt: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    const matches: RuleTestMatch[] = txns
      .filter((t) => t.payee.toLowerCase().includes(needle))
      .map((t) => {
        const existingWinner = ruleSuggestion(t.payee, existingRules);
        return {
          txnId: t.id,
          payee: t.payee,
          date: t.date.toISOString(),
          amount: Number(t.amount),
          status: t.status as TxnStatus,
          // At top priority the draft always wins; otherwise only unclaimed payees.
          wouldWin: body.priorityTop || existingWinner === null,
          currentWinner: existingWinner?.winnerMatchText ?? null,
        };
      });

    const ruleMatches = (rule: RuleLike, payee: string): boolean => {
      const match = rule.matchText.trim().toLowerCase();
      return match.length > 0 && payee.toLowerCase().includes(match);
    };
    const conflicts: RuleTestConflict[] = existingRules
      .filter((rule) => matches.some((m) => ruleMatches(rule, m.payee)))
      .map((rule) => ({
        ruleId: rule.id,
        matchText: rule.matchText,
        category: rule.category,
        priority: rule.priority,
      }));

    const result: RuleTestResult = {
      matches,
      pendingCount: matches.filter((m) => m.status === 'PENDING').length,
      postedCount: matches.filter((m) => m.status === 'POSTED' || m.status === 'DRY_RUN').length,
      conflicts,
    };
    res.json(result);
  }),
);

// Persist a full match order: ids[0] becomes priority 0 (topmost — wins first),
// ids[1] priority 1, and so on. The id set must exactly match the company's rules.
rulesRouter.put(
  '/order',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { ids } = validate(orderBody)(req.body);
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'Duplicate rule ids in order', 'BAD_ORDER');
    }
    const existing = await prisma.rule.findMany({ where: { companyId: company.id }, select: { id: true } });
    const existingIds = new Set(existing.map((r) => r.id));
    if (existingIds.size !== ids.length || ids.some((id) => !existingIds.has(id))) {
      throw new HttpError(400, 'Order must contain exactly the ids of every rule in this company', 'BAD_ORDER');
    }
    await prisma.$transaction(
      ids.map((id, index) => prisma.rule.update({ where: { id }, data: { priority: index } })),
    );
    const rules = await prisma.rule.findMany({
      where: { companyId: company.id },
      include: { ruleTags: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    const body: RuleDto[] = rules.map(toRuleDto);
    res.json(body);
  }),
);

rulesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rule = await loadRule(company.id, req.params.id);
    const patch = validate(patchBody)(req.body);

    const category = patch.category ?? rule.category;
    const categoryQboId =
      patch.category !== undefined || patch.categoryQboId !== undefined
        ? await resolveCategoryQboId(company.id, category, patch.categoryQboId)
        : rule.categoryQboId;

    if (patch.tagIds !== undefined) {
      const tagIds = [...new Set(patch.tagIds)];
      await assertTagsBelong(company.id, tagIds);
      await prisma.ruleTag.deleteMany({ where: { ruleId: rule.id } });
      for (const tagId of tagIds) {
        await prisma.ruleTag.create({ data: { ruleId: rule.id, tagId } });
      }
    }

    const updated = await prisma.rule.update({
      where: { id: rule.id },
      data: {
        ...(patch.matchText !== undefined ? { matchText: patch.matchText } : {}),
        category,
        categoryQboId,
        ...(patch.autoPost !== undefined ? { autoPost: patch.autoPost } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      },
      include: { ruleTags: true },
    });
    res.json(toRuleDto(updated));
  }),
);

rulesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rule = await loadRule(company.id, req.params.id);
    await prisma.rule.delete({ where: { id: rule.id } });
    res.json({ ok: true });
  }),
);
