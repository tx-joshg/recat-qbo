import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildAutopilotEvaluation, evaluateAutopilot } from './evaluation.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    decision: {
      kind: 'categorize',
      taxCalculation: 'TaxInclusive',
      lines: [{ grossAmount: -29, categoryQboId: 'software', taxCodeQboId: 'gst' }],
      rationale: 'History.',
      evidence: ['history'],
      confidence: 0.98,
    },
    validation: { ok: true },
    verifier: { verdict: 'agree', rationale: 'Consistent.' },
    turnCount: 2,
    toolCallCount: 1,
    transaction: {
      payee: 'Webflow',
      amount: -29,
      categoryQboId: 'software',
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'gst',
      splitLines: [],
    },
    ...overrides,
  };
}

describe('autopilot evaluation', () => {
  it('keeps category, tax, split, gross, rejection, and high-risk slices separate', () => {
    const split = row({
      decision: {
        kind: 'categorize',
        taxCalculation: 'TaxExcluded',
        lines: [
          { grossAmount: -70, categoryQboId: 'cogs', taxCodeQboId: 'gst' },
          { grossAmount: -30, categoryQboId: 'freight', taxCodeQboId: 'gst' },
        ],
        rationale: 'Invoice lines.',
        evidence: ['memo'],
        confidence: 0.9,
      },
      transaction: {
        payee: 'Supplier',
        amount: -100,
        categoryQboId: null,
        taxCalculation: 'TaxExcluded',
        taxCodeQboId: 'gst',
        splitLines: [
          { amount: -30, categoryQboId: 'freight', taxCodeQboId: 'gst' },
          { amount: -70, categoryQboId: 'cogs', taxCodeQboId: 'gst' },
        ],
      },
    });
    const skippedPayroll = row({
      decision: {
        kind: 'skip',
        reasonCode: 'PAYROLL_REVIEW',
        rationale: 'Payroll needs review.',
      },
      validation: { ok: false },
      verifier: { verdict: 'disagree', rationale: 'Not enough evidence.' },
      transaction: {
        payee: 'DEEL PAYROLL',
        amount: -9_000,
        categoryQboId: null,
        taxCalculation: null,
        taxCodeQboId: null,
        splitLines: [],
      },
    });

    expect(buildAutopilotEvaluation([row(), split, skippedPayroll])).toMatchObject({
      totalRuns: 3,
      category: { comparable: 1, exact: 1 },
      taxCode: { comparable: 2, exact: 2 },
      splits: { comparable: 1, exact: 1 },
      grossPreserved: { comparable: 2, exact: 2 },
      skipped: 1,
      validationRejected: 1,
      verifierDisagreed: 1,
      usage: { totalTurns: 6, totalToolCalls: 3, averageTurns: 2, averageToolCalls: 1 },
      slices: { payroll: { total: 1, skipped: 1, rejected: 1 } },
      qboWrites: 0,
    });
  });

  it('evaluates risk slices and gross preservation against the immutable run input', () => {
    const historical = row({
      transactionSnapshot: {
        payee: 'DEEL PAYROLL',
        qboType: 'Purchase',
        amount: -9_000,
      },
      transaction: {
        payee: 'Edited vendor',
        amount: -29,
        categoryQboId: 'software',
        taxCalculation: 'TaxInclusive',
        taxCodeQboId: 'gst',
        splitLines: [],
      },
    });

    expect(buildAutopilotEvaluation([historical])).toMatchObject({
      grossPreserved: { comparable: 1, exact: 0 },
      slices: {
        payroll: { total: 1, skipped: 0, rejected: 0 },
        largeDeposit: { total: 0, skipped: 0, rejected: 0 },
      },
    });
  });

  it('counts only large money-in transactions as large deposits', () => {
    const deposit = row({
      transactionSnapshot: {
        payee: 'Customer receipt',
        qboType: 'Deposit',
        amount: 9_000,
      },
      decision: {
        kind: 'skip',
        reasonCode: 'ENTITY_UNSUPPORTED',
        rationale: 'Deposits require review.',
      },
    });

    expect(buildAutopilotEvaluation([deposit])).toMatchObject({
      slices: {
        largeDeposit: { total: 1, skipped: 1, rejected: 0 },
      },
    });
  });

  it('is read-only by construction and scopes the aggregate query to one company', async () => {
    const findMany = vi.fn(async () => [row()]);
    const qboPost = vi.fn();
    const db = { agentRun: { findMany }, qboPost } as unknown as PrismaClient;

    await expect(evaluateAutopilot('co-1', db)).resolves.toMatchObject({
      totalRuns: 1,
      qboWrites: 0,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          mode: 'shadow',
          completedAt: { not: null },
        }),
        select: expect.objectContaining({ transactionSnapshot: true }),
      }),
    );
    expect(qboPost).not.toHaveBeenCalled();
  });
});
