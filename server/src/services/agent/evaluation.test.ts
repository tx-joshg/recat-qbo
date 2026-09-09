import { describe, expect, it } from 'vitest';
import {
  evaluateShadowRunAgainstOutcome,
  getShadowEvidenceSummary,
  type EvaluationDb,
  type VerifiedCategorizationOutcome,
} from './evaluation.js';
import type { AgentDecision } from './core/decision.js';
import { buildAgentSnapshot } from './core/snapshot.js';
import { verifyAgentDecision } from './core/verifier.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const TRANSACTION_ID = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '00000000-0000-4000-8000-000000000003';
const JOB_ID = '00000000-0000-4000-8000-000000000004';
const TAG_ID = '00000000-0000-4000-8000-000000000005';
const CONFIG_VERSION = 'config-current';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function proposal(categoryQboId = 'expense-generic') {
  return {
    kind: 'proposal' as const,
    taxCalculation: 'TaxInclusive' as const,
    lines: [{
      grossCents: -1_050,
      categoryQboId,
      taxCodeQboId: 'tax-generic',
      memo: 'Prepared purchase',
      tagIds: [TAG_ID],
    }],
    tagIds: [TAG_ID],
    confidence: 0.9,
    evidence: [{ kind: 'category' as const, qboId: categoryQboId }],
    rationale: 'Matched a verified accounting pattern.',
  };
}

function validOutcome(
  operation: VerifiedCategorizationOutcome['operation'] = 'posted',
): VerifiedCategorizationOutcome {
  return {
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    inputRevision: 1,
    requestId: 'request-generic',
    operation,
    candidateContext: null,
    proposal: operation === 'posted'
      ? {
          taxCalculation: 'TaxInclusive',
          lines: [{
            idx: 0,
            subtotalCents: -1_000,
            taxCents: -50,
            totalCents: -1_050,
            categoryQboId: 'expense-generic',
            taxCodeQboId: 'tax-generic',
            memo: 'Prepared purchase',
            tagIds: [TAG_ID],
          }],
          tagIds: [TAG_ID],
        }
      : null,
  };
}

type RunRow = {
  id: string;
  jobId: string;
  companyId: string;
  transactionId: string;
  revision: number;
  configVersion: string;
  attemptCount: number;
  status: string;
  decision: unknown;
  verification: unknown;
  verifierKind: string;
  completedAt: Date | null;
};

class FakeEvaluationDb implements EvaluationDb {
  config = {
    companyId: COMPANY_ID,
    configVersion: CONFIG_VERSION,
    evidenceThreshold: 50,
  };

  transactionRows = [{ id: TRANSACTION_ID, revision: 1, status: 'POSTED' }];

  runs: RunRow[] = [{
    id: RUN_ID,
    jobId: JOB_ID,
    companyId: COMPANY_ID,
    transactionId: TRANSACTION_ID,
    revision: 1,
    configVersion: CONFIG_VERSION,
    attemptCount: 1,
    status: 'verified',
    decision: proposal(),
    verification: {
      diagnosticCode: 'AGENT_RUN_VERIFIED',
      verificationMode: 'distinct_model',
      turns: 2,
      toolCalls: 1,
    },
    verifierKind: 'distinct_model',
    completedAt: new Date(),
  }];

  agentCompanyConfig = {
    findUnique: async ({ where }: { where: { companyId: string } }) =>
      where.companyId === this.config.companyId ? this.config : null,
  };

  agentRun = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      this.runs.filter((run) => Object.entries(where).every(([key, value]) => {
        if (value === undefined) return true;
        if (
          key === 'completedAt'
          && typeof value === 'object'
          && value !== null
          && 'gte' in value
          && value.gte instanceof Date
          && 'lte' in value
          && value.lte instanceof Date
        ) {
          return run.completedAt !== null
            && run.completedAt >= value.gte
            && run.completedAt <= value.lte;
        }
        return run[key as keyof RunRow] === value;
      })),
    update: async ({ where, data }: {
      where: { id: string };
      data: { verification: unknown };
    }) => {
      const run = this.runs.find((candidate) => candidate.id === where.id);
      if (!run) throw new Error('run missing');
      run.verification = structuredClone(data.verification);
      return run;
    },
  };

  transaction = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.transactionRows.find((candidate) => candidate.id === where.id);
      return row === undefined ? null : { ...row, companyId: COMPANY_ID };
    },
    findMany: async ({ where }: { where: { companyId: string } }) =>
      where.companyId === COMPANY_ID ? this.transactionRows : [],
  };

  async $transaction<T>(callback: (tx: EvaluationDb) => Promise<T>): Promise<T> {
    const before = structuredClone(this.runs);
    try {
      return await callback(this);
    } catch (error) {
      this.runs = before;
      throw error;
    }
  }
}

describe('shadow evidence evaluation', () => {
  it('counts an agreeing verified run only for its exact revision and current config', async () => {
    const db = new FakeEvaluationDb();

    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toEqual({
      eligibleRuns: 1,
      agreements: 1,
      disagreements: 0,
      threshold: 50,
      thresholdMet: false,
    });
  });

  it('excludes otherwise eligible evidence completed outside the rolling 30-day window', async () => {
    const db = new FakeEvaluationDb();
    db.runs[0]!.completedAt = new Date('2026-06-29T11:59:59.999Z');

    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db, now: () => NOW })).toMatchObject({
      eligibleRuns: 0,
      agreements: 0,
      disagreements: 0,
      thresholdMet: false,
    });
  });

  it('excludes otherwise eligible evidence completed after the captured window upper bound', async () => {
    const db = new FakeEvaluationDb();
    db.runs[0]!.completedAt = new Date('2026-07-29T12:00:00.001Z');

    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db, now: () => NOW })).toMatchObject({
      eligibleRuns: 0,
      agreements: 0,
      disagreements: 0,
      thresholdMet: false,
    });
  });

  it('treats a valid differing proposal as disagreement evidence', async () => {
    const db = new FakeEvaluationDb();
    db.runs[0]!.decision = proposal('expense-other');

    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toMatchObject({
      eligibleRuns: 1,
      agreements: 0,
      disagreements: 1,
    });
  });

  it('scores a deterministically verified TaxExcluded total against staged final totals', async () => {
    const db = new FakeEvaluationDb();
    const ruleId = '00000000-0000-4000-8000-000000000007';
    const decision: AgentDecision = {
      ...proposal(),
      taxCalculation: 'TaxExcluded',
      lines: [{ ...proposal().lines[0]!, grossCents: -1_050 }],
      evidence: [{ kind: 'rule', id: ruleId }],
    };
    const verified = verifyAgentDecision(buildAgentSnapshot({
      transaction: { id: TRANSACTION_ID, revision: 1 },
      date: '2026-07-29',
      signedAmountCents: -1_050,
      currency: 'CAD',
      sourceAccount: { displayName: 'Generic account', type: 'BANK' },
      payee: 'Generic supplier',
      candidateCategories: [{ qboId: 'expense-generic', name: 'Generic expense' }],
      tax: {
        status: 'ready',
        supportedCalculationModes: ['TaxExcluded'],
        eligibleReferences: [{ qboId: 'tax-generic', label: 'Generic tax' }],
      },
      tags: [{ id: TAG_ID, name: 'Generic tag' }],
      rules: [{
        id: ruleId,
        ruleRevision: 1,
        priority: 1,
        matchField: 'payee',
        matchText: 'generic',
        action: {
          version: 2,
          direction: 'Purchase',
          category: 'Generic expense',
          categoryQboId: 'expense-generic',
          taxCalculation: 'TaxExcluded',
          taxCodeQboId: 'tax-generic',
          tagIds: [],
        },
        autoPost: false,
      }],
      similarVerifiedTransactions: [],
      featureVersion: 'feature-v1',
      configurationVersion: CONFIG_VERSION,
    }), decision);
    expect(verified).toMatchObject({ ok: true, code: 'AGENT_DECISION_VERIFIED' });
    if (!verified.ok) throw new Error('expected verified decision');
    db.runs[0]!.decision = verified.decision;
    const outcome = validOutcome();
    outcome.proposal!.taxCalculation = 'TaxExcluded';

    await evaluateShadowRunAgainstOutcome(outcome, { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toMatchObject({
      eligibleRuns: 1,
      agreements: 1,
    });
  });

  it('ignores stale outcomes before they can invalidate current-revision evidence', async () => {
    const db = new FakeEvaluationDb();
    db.runs[0]!.revision = 2;
    db.transactionRows[0]!.revision = 2;
    await evaluateShadowRunAgainstOutcome({
      ...validOutcome(),
      inputRevision: 2,
      requestId: 'request-current',
    }, { db });
    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(1);

    await evaluateShadowRunAgainstOutcome({
      ...validOutcome('reverted'),
      inputRevision: 1,
      requestId: 'request-stale',
    }, { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toMatchObject({
      eligibleRuns: 1,
      agreements: 1,
    });
  });

  it.each([
    ['same-model verification', { verifierKind: 'same_model' }],
    ['abstention', { status: 'abstain' }],
    ['failed retry attempt', { status: 'failed' }],
    ['unfinished run', { completedAt: null }],
    ['unverified deterministic result', {
      verification: {
        diagnosticCode: 'AGENT_RUN_REVIEW_UNVERIFIED',
        verificationMode: 'distinct_model',
      },
    }],
  ])('excludes %s', async (_label, change) => {
    const db = new FakeEvaluationDb();
    Object.assign(db.runs[0]!, change);

    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);
  });

  it('excludes malformed and abstaining decisions instead of counting them as disagreements', async () => {
    for (const decision of [
      { kind: 'proposal', lines: [] },
      { kind: 'abstain', reasonCode: 'INSUFFICIENT_CONTEXT', rationale: 'Need more context.' },
    ]) {
      const db = new FakeEvaluationDb();
      db.runs[0]!.decision = decision;

      await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

      expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);
    }
  });

  it('rechecks the current transaction revision and posted status at summary time', async () => {
    const db = new FakeEvaluationDb();
    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    db.transactionRows[0]!.revision = 2;
    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);

    db.transactionRows[0]!.revision = 1;
    db.transactionRows[0]!.status = 'PENDING';
    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);
  });

  it('invalidates prior evidence on a verified revert or corrected post', async () => {
    const db = new FakeEvaluationDb();
    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });
    db.transactionRows[0]!.status = 'PENDING';
    await evaluateShadowRunAgainstOutcome(validOutcome('reverted'), { db });

    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);

    db.runs[0]!.revision = 2;
    db.transactionRows[0]!.revision = 2;
    db.transactionRows[0]!.status = 'POSTED';
    await evaluateShadowRunAgainstOutcome({
      ...validOutcome(),
      inputRevision: 2,
      requestId: 'request-correction',
    }, { db });
    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(1);
  });

  it('excludes evidence after configuration changes and uses the configured threshold', async () => {
    const db = new FakeEvaluationDb();
    db.config.evidenceThreshold = 25;
    await evaluateShadowRunAgainstOutcome(validOutcome(), { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toMatchObject({
      eligibleRuns: 1,
      threshold: 25,
      thresholdMet: false,
    });

    db.config.configVersion = 'config-replaced';
    expect((await getShadowEvidenceSummary(COMPANY_ID, { db })).eligibleRuns).toBe(0);
  });

  it('normalizes split order, tag order, and Unicode memo representation', async () => {
    const db = new FakeEvaluationDb();
    const secondTag = '00000000-0000-4000-8000-000000000006';
    const first = proposal();
    first.lines = [
      {
        ...first.lines[0]!,
        grossCents: -700,
        memo: 'Café',
        tagIds: [secondTag, TAG_ID],
      },
      {
        ...first.lines[0]!,
        grossCents: -350,
        categoryQboId: 'expense-other',
        tagIds: [],
      },
    ];
    first.tagIds = [secondTag, TAG_ID];
    db.runs[0]!.decision = first;
    const outcome = validOutcome();
    outcome.proposal!.lines = [
      {
        ...outcome.proposal!.lines[0]!,
        idx: 1,
        totalCents: -350,
        subtotalCents: -350,
        taxCents: 0,
        categoryQboId: 'expense-other',
        memo: 'Prepared purchase',
        tagIds: [],
      },
      {
        ...outcome.proposal!.lines[0]!,
        idx: 0,
        totalCents: -700,
        subtotalCents: -650,
        taxCents: -50,
        memo: 'Cafe\u0301',
        tagIds: [TAG_ID, secondTag],
      },
    ];
    outcome.proposal!.tagIds = [TAG_ID, secondTag];

    await evaluateShadowRunAgainstOutcome(outcome, { db });

    expect(await getShadowEvidenceSummary(COMPANY_ID, { db })).toMatchObject({
      eligibleRuns: 1,
      agreements: 1,
    });
  });
});
