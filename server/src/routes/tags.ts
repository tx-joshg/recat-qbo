// Tag CRUD — /api/companies/:companyId/tags (categorizer+). Tags are
// Recat-local (never written to QBO), so a disconnected company keeps them.

import { Router } from 'express';
import { z } from 'zod';
import type { Company } from '@prisma/client';
import type { TagDto } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';

const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().min(1).max(32),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: z.string().trim().min(1).max(32).optional(),
});

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

async function loadTag(companyId: string, id: string | undefined) {
  if (!id) throw new HttpError(400, 'Missing tag id', 'BAD_REQUEST');
  const tag = await prisma.tag.findUnique({ where: { id } });
  if (!tag || tag.companyId !== companyId) throw new HttpError(404, 'Tag not found', 'TAG_NOT_FOUND');
  return tag;
}

function toTagDto(tag: { id: string; companyId: string; name: string; color: string }, usageCount?: number): TagDto {
  return {
    id: tag.id,
    companyId: tag.companyId,
    name: tag.name,
    color: tag.color,
    ...(usageCount !== undefined ? { usageCount } : {}),
  };
}

export const tagsRouter = Router({ mergeParams: true });
tagsRouter.use(requireUser, withCompany({ allowDisconnected: true }));

// Listing is viewer-allowed: the Reports screen's tag-filter pills (and
// group-by-tag output, already viewer-visible) need tag names/colors.
// All writes below stay categorizer+.
tagsRouter.get(
  '/',
  requireRole('viewer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const tags = await prisma.tag.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { txnTags: true } } },
    });
    const body: TagDto[] = tags.map((t) => toTagDto(t, t._count.txnTags));
    res.json(body);
  }),
);

tagsRouter.post(
  '/',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { name, color } = validate(createBody)(req.body);
    const existing = await prisma.tag.findFirst({ where: { companyId: company.id, name } });
    if (existing) throw new HttpError(409, 'A tag with that name already exists', 'TAG_EXISTS');
    const tag = await prisma.tag.create({ data: { companyId: company.id, name, color } });
    res.status(201).json(toTagDto(tag, 0));
  }),
);

tagsRouter.patch(
  '/:id',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const tag = await loadTag(company.id, req.params.id);
    const patch = validate(patchBody)(req.body);
    const updated = await prisma.tag.update({
      where: { id: tag.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
      },
      include: { _count: { select: { txnTags: true } } },
    });
    res.json(toTagDto(updated, updated._count.txnTags));
  }),
);

// Cascade removes TxnTag/RuleTag rows (schema onDelete: Cascade).
tagsRouter.delete(
  '/:id',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const tag = await loadTag(company.id, req.params.id);
    await prisma.tag.delete({ where: { id: tag.id } });
    res.json({ ok: true });
  }),
);
