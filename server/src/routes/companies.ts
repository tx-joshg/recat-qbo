// Company routes — mounted at /api/companies. Connect/disconnect, settings
// patch, manual sync, chart of accounts, holding-account setup, sync log.
// Nested per-company data routers (transactions/tags/rules/...) are mounted
// separately in index.ts; this file owns the company resource itself.

import { Router } from 'express';
import { z } from 'zod';
import type { Company } from '@prisma/client';
import type {
  CompanyDto,
  PollInterval,
  QboAccountDto,
  QboDiagnosticCode,
  SyncLogDto,
} from '@recat/shared';
import { parseConnectRequest } from '../lib/connectRequest.js';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { classifyQboFailure } from '../lib/qbo/diagnostics.js';
import { hasIntuitCredentials, qboFactory, testCompanyConnection } from '../lib/qbo/factory.js';
import { requireInstanceAdmin, requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { syncCompany } from '../services/sync.js';
import { createOauthState } from './qboOauth.js';
import { teamRouter } from './team.js';

function jsonStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toPollInterval(n: number): PollInterval {
  return n === 5 || n === 10 || n === 30 || n === 60 ? n : 10;
}

export function toCompanyDto(c: Company): CompanyDto {
  return {
    id: c.id,
    realmId: c.realmId,
    legalName: c.legalName,
    nickname: c.nickname,
    env: c.env,
    syncMode: c.syncMode,
    pollIntervalMin: toPollInterval(c.pollIntervalMin),
    holdingAccountIds: jsonStringArray(c.holdingAccountIds),
    dryRun: c.dryRun,
    tagsRequired: c.tagsRequired,
    connectedAt: c.connectedAt.toISOString(),
    disconnectedAt: c.disconnectedAt?.toISOString() ?? null,
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
  };
}

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

const patchBody = z.object({
  nickname: z.string().trim().min(1).max(120).optional(),
  syncMode: z.enum(['polling', 'webhook']).optional(),
  pollIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(30), z.literal(60)]).optional(),
  holdingAccountIds: z.array(z.string().min(1)).min(1).optional(),
  dryRun: z.boolean().optional(),
  tagsRequired: z.boolean().optional(),
});

const holdingAccountsBody = z.object({ holdingAccountIds: z.array(z.string().min(1)).min(1) });

export const companiesRouter = Router();
companiesRouter.use(requireUser);

// Per-company team management (Team card) — nested here so index.ts stays
// untouched; teamRouter does its own withCompany + company-admin gating.
companiesRouter.use('/:companyId/team', teamRouter);

// Companies visible to the signed-in user: instance admins see every
// connected company; everyone else only the companies they have a
// membership in (per-company data reads are role-gated on their own routes).
companiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const companies = await prisma.company.findMany({
      where: {
        disconnectedAt: null,
        ...(user.isInstanceAdmin ? {} : { memberships: { some: { userId: user.id } } }),
      },
      orderBy: { connectedAt: 'asc' },
    });
    const body: CompanyDto[] = companies.map(toCompanyDto);
    res.json(body);
  }),
);

// Start a connect flow (instance admin — connecting a company is an
// instance-level act). The user's choices ride along:
//   GET /connect-url?mode=real|demo&env=sandbox|production
// mode=demo → the built-in fake consent page (no credentials needed, always
// available); mode=real (default) → the Intuit authorize URL, 400 with an
// actionable message when credentials are missing. The env choice is carried
// on the state token so the callback records exactly what the user picked.
// POST /connect is kept as the handoff §4 spelling of the same thing.
const connectHandler = asyncHandler(async (req, res) => {
  const body = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const input = {
    mode: body.mode ?? req.query.mode,
    env: body.env ?? req.query.env,
  };
  const parsed = parseConnectRequest(input, await hasIntuitCredentials());
  const state = createOauthState({ mode: parsed.mode, env: parsed.env });
  res.json({ url: qboFactory.authorizeUrl(state, parsed.mode) });
});
companiesRouter.get('/connect-url', requireInstanceAdmin, connectHandler);
companiesRouter.post('/connect', requireInstanceAdmin, connectHandler);

function qboDiagnosticStatus(code: QboDiagnosticCode): number {
  return code === 'COMPANY_DISCONNECTED' ? 409 : 502;
}

function qboDiagnosticMessage(code: QboDiagnosticCode): string {
  return code === 'COMPANY_DISCONNECTED'
    ? 'This company is disconnected from QuickBooks.'
    : 'QuickBooks connection test failed.';
}

companiesRouter.post(
  '/:companyId/test-connection',
  requireInstanceAdmin,
  withCompany({ allowDisconnected: true }),
  asyncHandler(async (req, res) => {
    try {
      res.json(await testCompanyConnection(scopedCompany(req).id));
    } catch (error) {
      const code = classifyQboFailure(error, 'company_info');
      throw new HttpError(qboDiagnosticStatus(code), qboDiagnosticMessage(code), code);
    }
  }),
);

companiesRouter.patch(
  '/:companyId',
  withCompany({ allowDisconnected: true }),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const patch = validate(patchBody)(req.body);

    const holdingChanged =
      patch.holdingAccountIds !== undefined &&
      JSON.stringify(patch.holdingAccountIds) !== JSON.stringify(jsonStringArray(company.holdingAccountIds));

    const updated = await prisma.company.update({
      where: { id: company.id },
      data: {
        ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
        ...(patch.syncMode !== undefined ? { syncMode: patch.syncMode } : {}),
        ...(patch.pollIntervalMin !== undefined ? { pollIntervalMin: patch.pollIntervalMin } : {}),
        ...(patch.holdingAccountIds !== undefined ? { holdingAccountIds: patch.holdingAccountIds } : {}),
        ...(patch.dryRun !== undefined ? { dryRun: patch.dryRun } : {}),
        ...(patch.tagsRequired !== undefined ? { tagsRequired: patch.tagsRequired } : {}),
      },
    });

    // Watching different holding accounts changes what the queue should hold —
    // kick a manual sync in the background.
    if (holdingChanged && updated.disconnectedAt === null) {
      void syncCompany(updated.id, 'manual').catch((err) =>
        console.error(`[companies] post-patch sync failed for ${updated.id}:`, err),
      );
    }

    res.json(toCompanyDto(updated));
  }),
);

// Disconnect: revoke tokens (best effort), keep all history. Instance admin
// only — disconnecting a company is an instance-level act, like connecting.
companiesRouter.delete(
  '/:companyId',
  requireInstanceAdmin,
  withCompany({ allowDisconnected: true }),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    await qboFactory.revoke(company.id);
    await prisma.company.update({
      where: { id: company.id },
      data: {
        disconnectedAt: company.disconnectedAt ?? new Date(),
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      },
    });
    res.json({ ok: true });
  }),
);

companiesRouter.post(
  '/:companyId/sync',
  withCompany(),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const result = await syncCompany(company.id, 'manual');
    const fresh = await prisma.company.findUnique({ where: { id: company.id } });
    res.json({
      ok: result.ok,
      message: result.message,
      lastSyncedAt: fresh?.lastSyncedAt?.toISOString() ?? null,
    });
  }),
);

companiesRouter.get(
  '/:companyId/accounts',
  withCompany({ allowDisconnected: true }),
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const accounts = await prisma.qboAccount.findMany({
      where: { companyId: company.id, active: true },
      orderBy: { fullName: 'asc' },
    });
    const body: QboAccountDto[] = accounts.map((a) => ({
      id: a.id,
      qboId: a.qboId,
      name: a.name,
      fullName: a.fullName,
      classification: a.classification,
      active: a.active,
    }));
    res.json(body);
  }),
);

// Setup wizard: candidate holding accounts with how many txns currently post
// there. Straight from QBO (a few queries in real mode — acceptable).
companiesRouter.get(
  '/:companyId/holding-account-options',
  withCompany(),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const client = await qboFactory.forCompany(company.id);
    const accounts = await client.listAccounts();
    const currentIds = jsonStringArray(company.holdingAccountIds);
    const candidates = accounts.filter(
      (a) => a.active && (/ask my accountant|uncategorized/i.test(a.name) || currentIds.includes(a.qboId)),
    );
    const candidateIds = new Set(candidates.map((c) => c.qboId));

    const counts = new Map<string, number>();
    if (candidateIds.size > 0) {
      const txns = await client.listTxnsInAccounts([...candidateIds]);
      for (const t of txns) {
        // Count each txn once per candidate account it posts to.
        const hit = new Set(t.lines.map((l) => l.accountQboId).filter((id) => candidateIds.has(id)));
        for (const id of hit) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }

    res.json(candidates.map((c) => ({ qboId: c.qboId, name: c.name, count: counts.get(c.qboId) ?? 0 })));
  }),
);

// Setup wizard step 4: save the watched holding accounts and run the initial
// sync (awaited — the wizard shows a spinner while this runs).
companiesRouter.post(
  '/:companyId/holding-accounts',
  withCompany(),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { holdingAccountIds } = validate(holdingAccountsBody)(req.body);
    await prisma.company.update({ where: { id: company.id }, data: { holdingAccountIds } });
    try {
      await syncCompany(company.id, 'initial');
    } catch (err) {
      throw new HttpError(
        502,
        `Initial sync failed: ${err instanceof Error ? err.message : String(err)}`,
        'INITIAL_SYNC_FAILED',
      );
    }
    const fresh = await prisma.company.findUnique({ where: { id: company.id } });
    if (!fresh) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
    res.json(toCompanyDto(fresh));
  }),
);

companiesRouter.get(
  '/:companyId/sync-log',
  withCompany({ allowDisconnected: true }),
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rows = await prisma.syncLog.findMany({
      where: { companyId: company.id },
      orderBy: { at: 'desc' },
      take: 20,
    });
    const body: SyncLogDto[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind as SyncLogDto['kind'],
      ok: r.ok,
      message: r.message,
      at: r.at.toISOString(),
    }));
    res.json(body);
  }),
);
