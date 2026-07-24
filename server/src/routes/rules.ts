// Rule CRUD — /api/companies/:companyId/rules (categorizer+).
// Suggestions are recomputed live in the queue list, so a rule edit is
// visible on the very next fetch with no explicit refresh step.

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Company, Prisma, PrismaClient } from '@prisma/client';
import type { RuleDto, RuleTestConflict, RuleTestMatch, RuleTestResult, TaxCalculation, TxnStatus } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  ruleMatchesPayee,
  ruleSuggestion,
  type RuleLike,
} from '../services/suggestions.js';
import { StagingError, validatePurchaseTaxDecision } from '../services/categorization.js';
import { lockCompanyRuleBoundary } from '../services/ruleBoundary.js';

type RuleRow = Prisma.RuleGetPayload<{ include: { ruleTags: true } }>;
type RuleDb = PrismaClient | Prisma.TransactionClient;

const createBody = z.object({
  matchText: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(200),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']).nullish(),
  taxCode: z.string().min(1).nullish(),
  taxCodeQboId: z.string().min(1).nullish(),
});

const patchBody = z.object({
  matchText: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  categoryQboId: z.string().min(1).nullish(),
  tagIds: z.array(z.string().min(1)).optional(),
  autoPost: z.boolean().optional(),
  priority: z.number().int().optional(),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']).nullish(),
  taxCode: z.string().min(1).nullish(),
  taxCodeQboId: z.string().min(1).nullish(),
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
    taxCalculation: rule.taxCalculation as TaxCalculation | null,
    taxCode: rule.taxCode,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map((rt) => rt.tagId),
    autoPost: rule.autoPost,
    createdAt: rule.createdAt.toISOString(),
  };
}

async function resolveCategoryQboId(
  db: RuleDb,
  companyId: string,
  category: string,
  given: string | null | undefined,
): Promise<string | null> {
  if (given) return given;
  const acct = await db.qboAccount.findFirst({ where: { companyId, name: category, active: true } });
  return acct?.qboId ?? null;
}

async function assertTagsBelong(db: RuleDb, companyId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const owned = await db.tag.count({ where: { companyId, id: { in: tagIds } } });
  if (owned !== new Set(tagIds).size) {
    throw new HttpError(400, 'One or more tags do not belong to this company', 'BAD_TAGS');
  }
}

async function validatedRuleTax(
  db: RuleDb,
  companyId: string,
  taxCalculation: TaxCalculation | null,
  taxCodeQboId: string | null,
): Promise<{ taxCalculation: TaxCalculation | null; taxCode: string | null; taxCodeQboId: string | null }> {
  try {
    const codes = await validatePurchaseTaxDecision(
      db,
      companyId,
      'Purchase',
      taxCalculation,
      [taxCodeQboId],
    );
    return {
      taxCalculation,
      taxCode: codes[0]?.name ?? null,
      taxCodeQboId: codes[0]?.qboId ?? null,
    };
  } catch (err) {
    if (err instanceof StagingError) throw new HttpError(400, err.message, err.code);
    throw err;
  }
}

async function loadRule(db: RuleDb, companyId: string, id: string | undefined): Promise<RuleRow> {
  if (!id) throw new HttpError(400, 'Missing rule id', 'BAD_REQUEST');
  const rule = await db.rule.findUnique({ where: { id }, include: { ruleTags: true } });
  if (!rule || rule.companyId !== companyId) throw new HttpError(404, 'Rule not found', 'RULE_NOT_FOUND');
  return rule;
}

async function markAutopilotRulesChanged(
  db: RuleDb,
  companyId: string,
): Promise<void> {
  await db.company.update({
    where: { id: companyId },
    data: { agentReconcileToken: randomUUID() },
  });
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
    const user = req.user;
    const rule = await prisma.$transaction(async (tx) => {
      await lockCompanyRuleBoundary(tx, company.id);
      await assertTagsBelong(tx, company.id, tagIds);
      const tax = await validatedRuleTax(
        tx,
        company.id,
        (body.taxCalculation ?? null) as TaxCalculation | null,
        body.taxCodeQboId ?? null,
      );
      // New rules go to the top of the match order. The shared company lock
      // also makes this priority allocation deterministic across requests.
      const agg = await tx.rule.aggregate({
        where: { companyId: company.id },
        _min: { priority: true },
      });
      const priority = agg._min.priority === null ? 0 : agg._min.priority - 1;
      const rule = await tx.rule.create({
        data: {
          companyId: company.id,
          matchField: 'payee',
          matchText: body.matchText,
          category: body.category,
          categoryQboId: await resolveCategoryQboId(
            tx,
            company.id,
            body.category,
            body.categoryQboId,
          ),
          ...tax,
          autoPost: body.autoPost ?? false,
          priority,
          createdById: user?.id ?? null,
          ruleTags: { create: tagIds.map((tagId) => ({ tagId })) },
        },
        include: { ruleTags: true },
      });
      await markAutopilotRulesChanged(tx, company.id);
      return rule;
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
      .filter((t) => ruleMatchesPayee(t.payee, body.matchText))
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

    const conflicts: RuleTestConflict[] = existingRules
      .filter((rule) => matches.some((m) => ruleMatchesPayee(m.payee, rule.matchText)))
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
    const rules = await prisma.$transaction(async (tx) => {
      await lockCompanyRuleBoundary(tx, company.id);
      const existing = await tx.rule.findMany({
        where: { companyId: company.id },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((rule) => rule.id));
      if (existingIds.size !== ids.length || ids.some((id) => !existingIds.has(id))) {
        throw new HttpError(
          400,
          'Order must contain exactly the ids of every rule in this company',
          'BAD_ORDER',
        );
      }
      await Promise.all(
        ids.map((id, index) =>
          tx.rule.update({ where: { id }, data: { priority: index } }),
        ),
      );
      await markAutopilotRulesChanged(tx, company.id);
      return tx.rule.findMany({
        where: { companyId: company.id },
        include: { ruleTags: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      });
    });
    const body: RuleDto[] = rules.map(toRuleDto);
    res.json(body);
  }),
);

rulesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const patch = validate(patchBody)(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      await lockCompanyRuleBoundary(tx, company.id);
      const rule = await loadRule(tx, company.id, req.params.id);
      const category = patch.category ?? rule.category;
      const categoryQboId =
        patch.category !== undefined || patch.categoryQboId !== undefined
          ? await resolveCategoryQboId(tx, company.id, category, patch.categoryQboId)
          : rule.categoryQboId;
      const tax = await validatedRuleTax(
        tx,
        company.id,
        (patch.taxCalculation !== undefined
          ? patch.taxCalculation
          : rule.taxCalculation) as TaxCalculation | null,
        patch.taxCodeQboId !== undefined ? patch.taxCodeQboId : rule.taxCodeQboId,
      );

      if (patch.tagIds !== undefined) {
        const tagIds = [...new Set(patch.tagIds)];
        await assertTagsBelong(tx, company.id, tagIds);
        await tx.ruleTag.deleteMany({ where: { ruleId: rule.id } });
        if (tagIds.length > 0) {
          await tx.ruleTag.createMany({
            data: tagIds.map((tagId) => ({ ruleId: rule.id, tagId })),
          });
        }
      }

      const updated = await tx.rule.update({
        where: { id: rule.id },
        data: {
          ...(patch.matchText !== undefined ? { matchText: patch.matchText } : {}),
          category,
          categoryQboId,
          ...tax,
          ...(patch.autoPost !== undefined ? { autoPost: patch.autoPost } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        },
        include: { ruleTags: true },
      });
      await markAutopilotRulesChanged(tx, company.id);
      return updated;
    });
    res.json(toRuleDto(updated));
  }),
);

rulesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    await prisma.$transaction(async (tx) => {
      await lockCompanyRuleBoundary(tx, company.id);
      const rule = await loadRule(tx, company.id, req.params.id);
      await tx.rule.delete({ where: { id: rule.id } });
      await markAutopilotRulesChanged(tx, company.id);
    });
    res.json({ ok: true });
  }),
);
