import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  activateRuleCandidateInTransaction,
  getRuleCandidate,
} from './ruleCandidates.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('canonical rule candidate readiness on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) await db.company.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture(taxCalculation: 'TaxInclusive' | 'NotApplicable' = 'NotApplicable') {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `candidate-${suffix}`,
        legalName: 'Canonical Candidate Legal',
        nickname: 'Canonical Candidate',
        ruleRuntimeMode: 'canonical',
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    companyIds.add(company.id);
    const account = await db.qboAccount.create({
      data: {
        companyId: company.id,
        qboId: `income-${suffix}`,
        name: 'Service revenue',
        fullName: 'Income · Service revenue',
        classification: 'Income',
      },
    });
    let taxCodeQboId: string | null = null;
    if (taxCalculation === 'TaxInclusive') {
      await db.qboTaxRate.create({
        data: { companyId: company.id, qboId: `rate-${suffix}`, name: 'Sales 5%', rateValue: 5 },
      });
      const taxCode = await db.qboTaxCode.create({
        data: {
          companyId: company.id,
          qboId: `tax-${suffix}`,
          name: 'Sales tax',
          taxable: true,
          purchaseTaxRateList: [],
          salesTaxRateList: [{ taxRateQboId: `rate-${suffix}`, taxTypeApplicable: 'TaxOnAmount' }],
        },
      });
      taxCodeQboId = taxCode.qboId;
    }
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: company.id,
        conditionFingerprint: 'a'.repeat(64),
        schemaVersion: 'rule-candidate-v1',
        configVersion: 'verified-writeback-v1',
        matchText: 'customer receipt',
        state: 'ready',
        winningActionFingerprint: 'b'.repeat(64),
        categoryQboId: account.qboId,
        taxCalculation,
        taxCodeQboId,
        evidenceCount: 3,
        conflictingEvidenceCount: 0,
      },
    });
    return { company, account, candidate };
  }

  async function durableEvidence(input: Awaited<ReturnType<typeof fixture>>) {
    for (let index = 0; index < 3; index += 1) {
      const requestId = `candidate-request-${randomUUID()}`;
      const transaction = await db.transaction.create({
        data: {
          companyId: input.company.id,
          qboId: `deposit-${randomUUID()}`,
          qboType: 'Deposit',
          qboSyncToken: '1',
          date: new Date('2026-09-01T00:00:00.000Z'),
          payee: input.candidate.matchText,
          amount: 100,
          bankAccount: 'Checking',
          status: 'POSTED',
          revision: 0,
        },
      });
      await db.qboMutationAttempt.create({
        data: {
          transactionId: transaction.id,
          requestId,
          operation: 'recategorize',
          status: 'VERIFIED',
          expectedRevision: 0,
          expectedSyncToken: '1',
          requestHash: 'c'.repeat(64),
          requestPayload: {},
          beforeSnapshot: {},
        },
      });
      await db.autopilotRuleCandidateEvidence.create({
        data: {
          companyId: input.company.id,
          candidateId: input.candidate.id,
          transactionId: transaction.id,
          inputRevision: 0,
          requestId,
          source: 'user',
          actionFingerprint: input.candidate.winningActionFingerprint!,
          pattern: {},
        },
      });
    }
  }

  it('uses Deposit sales-tax readiness instead of Purchase tax references', async () => {
    const data = await fixture('TaxInclusive');

    expect(await getRuleCandidate(data.company.id, data.candidate.id, db)).toMatchObject({
      state: 'ready',
      staleReasons: [],
      canActivate: true,
    });
  });

  it('only treats executable canonical rules in the same direction as overlap', async () => {
    const data = await fixture();
    const ruleData = (overrides: Record<string, unknown>) => ({
      companyId: data.company.id,
      matchText: 'customer',
      category: data.account.name,
      categoryQboId: data.account.qboId,
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      direction: 'Deposit' as const,
      canonicalVersion: 2,
      ...overrides,
    });
    await db.rule.createMany({
      data: [
        ruleData({ direction: 'Purchase' }),
        ruleData({ canonicalVersion: null }),
        ruleData({ reviewRequiredAt: new Date(), reviewReason: 'Held for review' }),
        ruleData({ repairReason: 'Missing reference' }),
        ruleData({ enabled: false, retiredAt: new Date() }),
      ],
    });

    expect((await getRuleCandidate(data.company.id, data.candidate.id, db)).staleReasons)
      .not.toContain('An existing rule overlaps this payee condition.');

    await db.rule.create({ data: ruleData({}) });
    expect((await getRuleCandidate(data.company.id, data.candidate.id, db)).staleReasons)
      .toContain('An existing rule overlaps this payee condition.');
  });

  it('fails readiness closed while canonical rule execution is paused', async () => {
    const data = await fixture();
    await db.company.update({ where: { id: data.company.id }, data: { ruleRuntimeMode: 'paused' } });

    expect(await getRuleCandidate(data.company.id, data.candidate.id, db)).toMatchObject({
      state: 'stale',
      canActivate: false,
      staleReasons: expect.arrayContaining(['Rule execution is paused for canonical migration.']),
    });
  });

  it('persists the derived direction and canonical marker when activating', async () => {
    const data = await fixture();
    await durableEvidence(data);

    const activated = await db.$transaction((tx) => activateRuleCandidateInTransaction(
      tx,
      data.company.id,
      data.candidate.id,
      { id: randomUUID(), label: 'Candidate reviewer' },
      { skipReconciliation: true },
    ));

    expect(activated.rule).toMatchObject({
      direction: 'Deposit',
      canonicalVersion: 2,
      enabled: true,
      retiredAt: null,
    });
    await expect(db.ruleRevision.findUniqueOrThrow({
      where: {
        companyId_ruleId_revision: {
          companyId: data.company.id,
          ruleId: activated.rule.id,
          revision: activated.rule.revision,
        },
      },
    })).resolves.toMatchObject({
      direction: 'Deposit',
      canonicalVersion: 2,
      state: 'enabled',
    });
  });
});
