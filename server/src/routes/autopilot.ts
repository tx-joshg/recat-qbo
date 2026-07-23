import type { AgentJob, AgentRun, Company } from '@prisma/client';
import type {
  AgentJobDto,
  AgentJobStatus,
  AgentRunDto,
  AutopilotMode,
  AutopilotSummaryDto,
  RuleCandidateDto,
} from '@recat/shared';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { getCodexStatus } from '../services/ai/codexAuth.js';
import { testCodexConnection } from '../services/ai/provider.js';
import { writeAudit } from '../services/audit.js';
import { getInstanceSettings } from '../services/instanceSettings.js';
import {
  cancelJob,
  countValidatedShadowRuns,
  currentAgentInputHash,
  hasCurrentDeterministicRule,
  MIN_LIVE_SHADOW_RUNS,
} from '../services/agent/jobs.js';
import { reconcileAutopilotJobs } from '../services/agent/reconciliation.js';
import { activateRuleCandidate } from '../services/agent/ruleCandidates.js';
import { evaluateAutopilot } from '../services/agent/evaluation.js';

const ALL_STATUSES: AgentJobStatus[] = [
  'queued',
  'running',
  'retry',
  'completed',
  'failed',
  'cancelled',
];
export const AUTOPILOT_LIVE_CONFIRMATION = 'ENABLE LIVE AUTOPILOT';
const modeBody = z
  .object({
    mode: z.enum(['off', 'shadow', 'live']),
    confirmation: z.string().optional(),
  })
  .strict();

function scopedCompany(req: { company?: Company }): Company {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company;
}

function assertFreshCompanyReadiness(company: Company, mode: AutopilotMode): void {
  if (mode === 'off') return;
  if (company.disconnectedAt !== null) {
    throw new HttpError(
      409,
      'Reconnect QuickBooks before enabling autopilot.',
      'COMPANY_DISCONNECTED',
    );
  }
  if (company.taxSupportStatus !== 'ready') {
    throw new HttpError(
      409,
      'Refresh and verify Purchase tax support before enabling autopilot.',
      'AUTOPILOT_TAX_NOT_READY',
    );
  }
  if (mode !== 'live') return;
  if (env.DRY_RUN) {
    throw new HttpError(
      409,
      'Set deployment DRY_RUN=false before live mode.',
      'AUTOPILOT_LIVE_NOT_READY',
    );
  }
  if (company.dryRun) {
    throw new HttpError(
      409,
      'Turn off company dry-run mode before live mode.',
      'AUTOPILOT_LIVE_NOT_READY',
    );
  }
  if (company.tagsRequired) {
    throw new HttpError(
      409,
      'Live v1 cannot run while transaction tags are required.',
      'AUTOPILOT_LIVE_NOT_READY',
    );
  }
}

export function toAgentJobDto(row: AgentJob): AgentJobDto {
  return {
    id: row.id,
    transactionId: row.transactionId,
    companyId: row.companyId,
    status: row.status,
    inputHash: row.inputHash,
    attempt: row.attempt,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lockedAt: row.lockedAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAgentRunDto(row: AgentRun): AgentRunDto {
  return {
    id: row.id,
    jobId: row.jobId,
    transactionId: row.transactionId,
    companyId: row.companyId,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    toolSchemaVersion: row.toolSchemaVersion,
    inputHash: row.inputHash,
    mode: row.mode,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    ...(row.decision !== null ? { decision: row.decision } : {}),
    ...(row.toolTrace !== null ? { toolTrace: row.toolTrace } : {}),
    ...(row.validation !== null ? { validation: row.validation } : {}),
    ...(row.verification !== null ? { verification: row.verification } : {}),
    ...(row.verifier !== null ? { verifier: row.verifier } : {}),
    turnCount: row.turnCount,
    toolCallCount: row.toolCallCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).filter((item): item is string => typeof item === 'string');
}

async function summary(company: Company): Promise<AutopilotSummaryDto> {
  const settings = await getInstanceSettings();
  const [provider, grouped, lastRun, shadowValidated, openUncertainWrites] = await Promise.all([
    getCodexStatus(),
    prisma.agentJob.groupBy({
      by: ['status'],
      where: { companyId: company.id },
      _count: { _all: true },
    }),
    prisma.agentRun.findFirst({
      where: { companyId: company.id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    }),
    countValidatedShadowRuns(company.id, { provider: 'codex', model: settings.codexModel }),
    prisma.qboMutationAttempt.count({
      where: {
        transaction: { companyId: company.id, status: 'ERROR' },
        status: { in: ['UNCERTAIN', 'MISMATCH'] },
      },
    }),
  ]);
  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<
    AgentJobStatus,
    number
  >;
  for (const value of grouped) counts[value.status] = value._count._all;
  const providerConnected = provider.connected === true;
  const taxReady = company.taxSupportStatus === 'ready';
  const deploymentWritesEnabled = !env.DRY_RUN;
  const companyWritesEnabled = !company.dryRun;
  let fatalGate: string | null = null;
  if (company.disconnectedAt !== null) fatalGate = 'Reconnect QuickBooks before enabling autopilot.';
  else if (!providerConnected) fatalGate = 'Connect ChatGPT before enabling autopilot.';
  else if (!taxReady) fatalGate = 'Refresh and verify Purchase tax support first.';
  else if (!deploymentWritesEnabled) fatalGate = 'Set deployment DRY_RUN=false before live mode.';
  else if (!companyWritesEnabled) fatalGate = 'Turn off company dry-run mode before live mode.';
  else if (company.tagsRequired) fatalGate = 'Live v1 cannot run while transaction tags are required.';
  else if (openUncertainWrites > 0) {
    fatalGate = 'Resolve uncertain QuickBooks writes before live mode.';
  } else if (shadowValidated < MIN_LIVE_SHADOW_RUNS) {
    fatalGate = `Collect ${MIN_LIVE_SHADOW_RUNS} validated shadow runs before live mode.`;
  }
  return {
    mode: company.autopilotMode,
    readiness: {
      providerConnected,
      taxReady,
      deploymentWritesEnabled,
      companyWritesEnabled,
      shadowValidated,
      shadowRequired: MIN_LIVE_SHADOW_RUNS,
      openUncertainWrites,
      shadowReady:
        company.disconnectedAt === null &&
        providerConnected &&
        taxReady,
      liveReady: fatalGate === null,
      fatalGate,
    },
    counts,
    lastRun: lastRun ? toAgentRunDto(lastRun) : null,
  };
}

function summaryFallback(company: Company): AutopilotSummaryDto {
  return {
    mode: company.autopilotMode,
    readiness: {
      providerConnected: false,
      taxReady: company.taxSupportStatus === 'ready',
      deploymentWritesEnabled: !env.DRY_RUN,
      companyWritesEnabled: !company.dryRun,
      shadowValidated: 0,
      shadowRequired: MIN_LIVE_SHADOW_RUNS,
      openUncertainWrites: 0,
      shadowReady: false,
      liveReady: false,
      fatalGate: 'Refresh autopilot status before changing modes again.',
    },
    counts: Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<
      AgentJobStatus,
      number
    >,
    lastRun: null,
  };
}

export const autopilotRouter = Router({ mergeParams: true });
autopilotRouter.use(
  requireUser,
  withCompany({ allowDisconnected: true }),
  requireRole('categorizer'),
);

autopilotRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await summary(scopedCompany(req)));
  }),
);

autopilotRouter.patch(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const { mode, confirmation } = validate(modeBody)(req.body);
    const beforeSummary = mode === 'live' ? await summary(company) : null;
    if (mode !== 'off' && company.disconnectedAt !== null) {
      throw new HttpError(409, 'Reconnect QuickBooks before enabling autopilot.', 'COMPANY_DISCONNECTED');
    }
    if (mode === 'shadow' && company.taxSupportStatus !== 'ready') {
      throw new HttpError(
        409,
        'Refresh and verify Purchase tax support before enabling autopilot.',
        'AUTOPILOT_TAX_NOT_READY',
      );
    }
    const provider = mode === 'off' ? null : await getCodexStatus();
    if (provider && !provider.connected) {
      throw new HttpError(409, 'Connect ChatGPT before enabling autopilot.', 'AUTOPILOT_PROVIDER');
    }
    if (mode === 'live') {
      if (confirmation !== AUTOPILOT_LIVE_CONFIRMATION) {
        throw new HttpError(
          400,
          `Type "${AUTOPILOT_LIVE_CONFIRMATION}" to enable live autopilot.`,
          'AUTOPILOT_CONFIRMATION',
        );
      }
      if (!beforeSummary?.readiness.liveReady) {
        throw new HttpError(
          409,
          beforeSummary?.readiness.fatalGate ?? 'Live autopilot is not ready.',
          'AUTOPILOT_LIVE_NOT_READY',
        );
      }
      try {
        await testCodexConnection();
      } catch {
        throw new HttpError(
          409,
          'ChatGPT connection test failed. Reconnect and test it before live mode.',
          'AUTOPILOT_PROVIDER_TEST',
        );
      }
      const freshProvider = await getCodexStatus();
      if (!freshProvider.connected) {
        throw new HttpError(
          409,
          'ChatGPT disconnected during the live readiness check.',
          'AUTOPILOT_PROVIDER',
        );
      }
    }

    const activeSettings = mode === 'live' ? await getInstanceSettings() : null;
    const activeIdentity = activeSettings
      ? { provider: 'codex', model: activeSettings.codexModel }
      : null;
    const confirmedAt = mode === 'live' ? new Date() : null;
    const updated = await prisma.$transaction(async (tx) => {
      const fresh = await tx.company.findUnique({ where: { id: company.id } });
      if (!fresh) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
      assertFreshCompanyReadiness(fresh, mode);
      if (mode === 'live') {
        const [freshShadowValidated, freshOpenUncertainWrites] = await Promise.all([
          countValidatedShadowRuns(company.id, activeIdentity!, tx),
          tx.qboMutationAttempt.count({
            where: {
              transaction: { companyId: company.id, status: 'ERROR' },
              status: { in: ['UNCERTAIN', 'MISMATCH'] },
            },
          }),
        ]);
        if (freshOpenUncertainWrites > 0 || freshShadowValidated < MIN_LIVE_SHADOW_RUNS) {
          throw new HttpError(
            409,
            freshOpenUncertainWrites > 0
              ? 'Resolve uncertain QuickBooks writes before live mode.'
              : `Collect ${MIN_LIVE_SHADOW_RUNS} validated shadow runs before live mode.`,
            'AUTOPILOT_LIVE_NOT_READY',
          );
        }
      }
      const changed = await tx.company.updateMany({
        where: {
          id: company.id,
          ...(mode === 'off'
            ? {}
            : {
                disconnectedAt: null,
                taxSupportStatus: 'ready',
              }),
          ...(mode === 'live'
            ? {
                dryRun: false,
                tagsRequired: false,
              }
            : {}),
        },
        data: {
          autopilotMode: mode,
          autopilotLiveConfirmedAt: confirmedAt,
          agentReconcileToken: randomUUID(),
        },
      });
      if (changed.count !== 1) {
        throw new HttpError(
          409,
          'Autopilot readiness changed while enabling the mode. Refresh and try again.',
          'AUTOPILOT_LIVE_NOT_READY',
        );
      }
      const next = await tx.company.findUnique({ where: { id: company.id } });
      if (!next) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
      if (fresh.autopilotMode !== mode) {
        await writeAudit(tx, {
          companyId: company.id,
          actorId: req.user?.id,
          actorLabel: req.user?.name || req.user?.email || 'user',
          payee: 'Autopilot',
          amount: 0,
          action: 'autopilot',
          before: fresh.autopilotMode,
          after: mode,
        });
      }
      return next;
    });
    try {
      await reconcileAutopilotJobs(company.id);
    } catch (error) {
      console.error(`[autopilot] post-commit job reconciliation failed for ${company.id}:`, error);
    }
    try {
      res.json(await summary(updated));
    } catch (error) {
      console.error(`[autopilot] post-commit summary failed for ${company.id}:`, error);
      res.json({ ...(beforeSummary ?? summaryFallback(updated)), mode: updated.autopilotMode });
    }
  }),
);

autopilotRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rows = await prisma.agentJob.findMany({
      where: { companyId: company.id },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    res.json(rows.map(toAgentJobDto));
  }),
);

autopilotRouter.get(
  '/evaluation',
  asyncHandler(async (req, res) => {
    res.json(await evaluateAutopilot(scopedCompany(req).id, prisma));
  }),
);

autopilotRouter.get(
  '/rule-candidates',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const rows = await prisma.ruleCandidate.findMany({
      where: { companyId: company.id },
      orderBy: [{ status: 'asc' }, { evidenceCount: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    const body: RuleCandidateDto[] = rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      matchText: row.matchText,
      category: row.category,
      categoryQboId: row.categoryQboId,
      taxCalculation: row.taxCalculation as RuleCandidateDto['taxCalculation'],
      taxCode: row.taxCode,
      taxCodeQboId: row.taxCodeQboId,
      evidenceCount: row.evidenceCount,
      evidenceRunIds: stringArray(row.evidenceRunIds),
      conflicts: jsonArray(row.conflicts),
      status: row.status,
      createdRuleId: row.createdRuleId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    res.json(body);
  }),
);

autopilotRouter.post(
  '/rule-candidates/:candidateId/activate',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    const candidateId = req.params.candidateId;
    if (!candidateId) throw new HttpError(400, 'Missing candidate id.', 'BAD_REQUEST');
    try {
      res.json(
        await activateRuleCandidate(
          company.id,
          candidateId,
          req.user.id,
          prisma,
        ),
      );
    } catch (error) {
      throw new HttpError(
        409,
        error instanceof Error ? error.message : 'Rule candidate could not be activated.',
        'RULE_CANDIDATE_CONFLICT',
      );
    }
  }),
);

autopilotRouter.post(
  '/rule-candidates/:candidateId/dismiss',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const candidateId = req.params.candidateId;
    if (!candidateId) throw new HttpError(400, 'Missing candidate id.', 'BAD_REQUEST');
    const updated = await prisma.ruleCandidate.updateMany({
      where: {
        id: candidateId,
        companyId: company.id,
        status: 'pending',
      },
      data: { status: 'dismissed' },
    });
    if (updated.count !== 1) {
      throw new HttpError(409, 'Rule candidate is no longer pending.', 'RULE_CANDIDATE_STATE');
    }
    res.json({ ok: true });
  }),
);

autopilotRouter.get(
  '/runs/:runId',
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const row = await prisma.agentRun.findFirst({
      where: { id: req.params.runId, companyId: company.id },
    });
    if (!row) throw new HttpError(404, 'Autopilot run not found.', 'AGENT_RUN_NOT_FOUND');
    res.json(toAgentRunDto(row));
  }),
);

autopilotRouter.post(
  '/jobs/:jobId/retry',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    if (company.autopilotMode === 'off') {
      throw new HttpError(409, 'Enable shadow mode before retrying jobs.', 'AUTOPILOT_DISABLED');
    }
    if (company.disconnectedAt !== null || company.taxSupportStatus !== 'ready') {
      throw new HttpError(
        409,
        'Reconnect QuickBooks and refresh Purchase tax support before retrying jobs.',
        'AGENT_JOB_INELIGIBLE',
      );
    }
    const existing = await prisma.agentJob.findFirst({
      where: { id: req.params.jobId, companyId: company.id },
    });
    if (!existing) throw new HttpError(404, 'Autopilot job not found.', 'AGENT_JOB_NOT_FOUND');
    if (existing.status !== 'failed' && existing.status !== 'cancelled') {
      throw new HttpError(409, 'Only failed or cancelled jobs can be retried.', 'AGENT_JOB_STATE');
    }
    const eligible = await prisma.transaction.findFirst({
      where: {
        id: existing.transactionId,
        companyId: company.id,
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
    const inputHash =
      eligible &&
      !(await hasCurrentDeterministicRule(existing.transactionId))
        ? await currentAgentInputHash(existing.transactionId)
        : null;
    if (!eligible || !inputHash) {
      throw new HttpError(
        409,
        'This transaction is no longer eligible for autopilot.',
        'AGENT_JOB_INELIGIBLE',
      );
    }
    const updated = await prisma.agentJob.updateMany({
      where: {
        id: existing.id,
        companyId: company.id,
        status: existing.status,
        inputHash: existing.inputHash,
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
    if (updated.count !== 1) {
      throw new HttpError(409, 'The autopilot job changed before it could be retried.', 'AGENT_JOB_STATE');
    }
    const row = await prisma.agentJob.findFirst({
      where: { id: existing.id, companyId: company.id },
    });
    if (!row) throw new HttpError(404, 'Autopilot job not found.', 'AGENT_JOB_NOT_FOUND');
    res.json(toAgentJobDto(row));
  }),
);

autopilotRouter.post(
  '/jobs/:jobId/cancel',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const company = scopedCompany(req);
    const row = await prisma.agentJob.findFirst({
      where: { id: req.params.jobId, companyId: company.id },
    });
    if (!row) throw new HttpError(404, 'Autopilot job not found.', 'AGENT_JOB_NOT_FOUND');
    if (row.status === 'running') {
      throw new HttpError(
        409,
        'A running job cannot be cancelled because its accounting write may already be in flight.',
        'AGENT_JOB_RUNNING',
      );
    }
    if (!(await cancelJob(row.id, { code: 'AGENT_CANCELLED', message: 'Cancelled by an administrator.' }))) {
      throw new HttpError(409, 'This job is no longer cancellable.', 'AGENT_JOB_STATE');
    }
    const updated = await prisma.agentJob.findUnique({ where: { id: row.id } });
    if (!updated) throw new HttpError(404, 'Autopilot job not found.', 'AGENT_JOB_NOT_FOUND');
    res.json(toAgentJobDto(updated));
  }),
);
