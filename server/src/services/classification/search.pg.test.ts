import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaClassificationSearchRepository,
  searchClassificationMemory,
} from './search.js';
import {
  findVendorIdentityByValue,
  mergeVendorIdentities,
} from './vendorIdentity.js';
import { classificationEmbeddingGeneration } from './embedding/recipe.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('classification search on PostgreSQL', () => {
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

  async function company(name: string) {
    const created = await db.company.create({
      data: {
        realmId: `search-${randomUUID()}`,
        legalName: `${name} Legal`,
        nickname: name,
      },
    });
    companyIds.add(created.id);
    return created;
  }

  async function fixtures(
    transactionDirection: 'in' | 'out' | 'unknown' = 'out',
    compositeTax = false,
  ) {
    const taxCalculation = compositeTax ? 'TaxInclusive' : 'TaxExcluded';
    const current = await company('Example Company Alpha');
    const foreign = await company('Example Company Beta');
    await db.company.update({
      where: { id: current.id },
      data: { taxSupportStatus: 'ready', taxUsingSalesTax: true },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: current.id,
        qboId: 'account-cogs',
        name: 'Inventory purchases',
        fullName: 'Cost of Goods Sold · Inventory purchases',
        classification: 'COGS',
      },
    });
    await db.qboTaxRate.createMany({
      data: compositeTax
        ? [
            {
              companyId: current.id,
              qboId: 'rate-gst-5',
              name: 'GST 5%',
              rateValue: 5,
            },
            {
              companyId: current.id,
              qboId: 'rate-pst-7',
              name: 'PST 7%',
              rateValue: 7,
            },
          ]
        : [{
            companyId: current.id,
            qboId: 'rate-hst-13',
            name: 'HST 13%',
            rateValue: 13,
          }],
    });
    const taxCode = await db.qboTaxCode.create({
      data: {
        companyId: current.id,
        qboId: 'tax-hst-13',
        name: 'HST ON 13%',
        active: true,
        taxable: true,
        purchaseTaxRateList: compositeTax
          ? [
              { taxRateQboId: 'rate-gst-5', taxTypeApplicable: 'TaxOnAmount' },
              { taxRateQboId: 'rate-pst-7', taxTypeApplicable: 'TaxOnAmount' },
            ]
          : [{ taxRateQboId: 'rate-hst-13', taxTypeApplicable: 'TaxOnAmount' }],
        combinedPurchaseRate: compositeTax ? 12 : 13,
      },
    });
    const tag = await db.tag.create({
      data: { companyId: current.id, name: 'Inventory', color: '#112233' },
    });
    const vendor = await db.vendorIdentity.create({
      data: {
        companyId: current.id,
        displayName: 'Samplewear Region',
        normalizedName: 'samplewear region',
      },
    });
    const alias = await db.vendorAlias.create({
      data: {
        companyId: current.id,
        vendorIdentityId: vendor.id,
        value: 'SAMPLEWEAR Exampletown Central',
        normalizedValue: 'samplewear exampletown central',
        source: 'user',
      },
    });
    const foreignVendor = await db.vendorIdentity.create({
      data: {
        companyId: foreign.id,
        displayName: 'Samplewear Personal Purchase',
        normalizedName: 'samplewear personal purchase',
      },
    });
    await db.vendorAlias.create({
      data: {
        companyId: foreign.id,
        vendorIdentityId: foreignVendor.id,
        value: 'SAMPLEWEAR Exampletown Central',
        normalizedValue: 'samplewear exampletown central',
        source: 'user',
      },
    });
    const rule = await db.rule.create({
      data: {
        companyId: current.id,
        matchText: 'Samplewear Regional Outlet',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation,
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
        revision: 2,
        originIntent: 'make_recurring',
      },
    });
    await db.ruleTag.create({ data: { ruleId: rule.id, tagId: tag.id } });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id, companyId: current.id, revision: 2, state: 'enabled',
        matchText: rule.matchText, category: account.name, categoryQboId: account.qboId,
        taxCalculation, taxCode: taxCode.name, taxCodeQboId: taxCode.qboId,
        tagIds: [tag.id], priority: 0, autoPost: false, originIntent: 'make_recurring',
      },
    });
    await db.rule.create({
      data: {
        companyId: current.id,
        matchText: 'Samplewear retired old rule',
        category: account.name,
        categoryQboId: account.qboId,
        enabled: false,
        retiredAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    const candidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: current.id,
        conditionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        schemaVersion: 'v2',
        configVersion: 'synthetic',
        matchText: 'Samplewear warehouse inventory',
        state: 'conflict',
        winningActionFingerprint: 'a'.repeat(64),
        categoryQboId: account.qboId,
        taxCalculation,
        taxCodeQboId: taxCode.qboId,
        evidenceCount: 3,
        conflictingEvidenceCount: 1,
      },
    });
    await db.autopilotRuleCandidate.create({
      data: {
        companyId: current.id,
        conditionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
        schemaVersion: 'v2',
        configVersion: 'synthetic',
        matchText: 'Samplewear gathering hidden',
        state: 'gathering',
      },
    });
    const transaction = await db.transaction.create({
      data: {
        companyId: current.id,
        qboId: `purchase-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '1',
        date: new Date('2026-06-15T00:00:00.000Z'),
        payee: 'Samplewear Eastgate',
        memo: 'Wholesale notebooks for resale',
        amount: '-113.00',
        bankAccount: 'Synthetic Bank',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation,
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
      },
    });
    const attempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: `search-${randomUUID()}`,
        operation: 'post',
        status: 'VERIFIED',
        expectedRevision: 0,
        expectedSyncToken: '1',
        requestHash: 'b'.repeat(64),
        requestPayload: {},
        beforeSnapshot: {},
      },
    });
    const classificationCase = await db.classificationCase.create({
      data: {
        companyId: current.id,
        transactionId: transaction.id,
        vendorIdentityId: vendor.id,
        qboMutationAttemptId: attempt.id,
        action: {
          categoryQboId: account.qboId,
          taxCalculation,
          taxCodeQboId: taxCode.qboId,
          tagIds: [tag.id],
        },
        actionFingerprint: 'c'.repeat(64),
        originIntent: 'apply_once',
        rationale: 'Ontario thirteen percent HST input tax credit on inventory.',
        requiredEvidence: ['Invoice showing Ontario ship-to location'],
        examples: ['Wholesale notebooks bought for resale'],
        counterexamples: ['Personal notebook purchase'],
        citations: [],
        reviewer: { userId: null, configVersion: 'synthetic', decision: 'approved' },
        jurisdiction: 'CA-ON',
        currency: 'CAD',
        context: {
          transactionDirection,
          qboType: 'Purchase',
          sourceAccountName: 'Synthetic Bank',
          businessPurpose: 'Inventory resale',
        },
        provenance: {
          source: 'qbo_verified',
          sourceId: attempt.requestId,
          actorId: null,
          recordedAt: '2026-06-15T00:00:00.000Z',
        },
        transactionSnapshot: {
          schemaVersion: 'classification-case/v1',
          transactionId: transaction.id,
          transactionRevision: 0,
          qboType: 'Purchase',
          qboId: transaction.qboId,
          date: '2026-06-15T00:00:00.000Z',
          amountCents: -11300,
          currency: 'CAD',
          payee: 'Samplewear Eastgate',
          memo: 'Wholesale notebooks for resale',
          sourceAccountName: 'Synthetic Bank',
        },
        verifiedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
    });
    return { current, foreign, account, taxCode, tag, alias, rule, candidate, classificationCase, transaction };
  }

  async function createObservation(input: {
    companyId: string;
    transactionId: string;
    sourceQboId?: string;
    sourceQboType?: string;
    sourceQboSyncToken?: string;
    payee?: string;
    memo?: string | null;
    observedAt?: Date;
  }) {
    return db.historicalClassificationObservation.create({
      data: {
        companyId: input.companyId,
        sourceTransactionId: input.transactionId,
        sourceQboType: input.sourceQboType ?? 'Purchase',
        sourceQboId: input.sourceQboId ?? `observation-${randomUUID()}`,
        sourceTransactionRevision: 1,
        sourceQboSyncToken: input.sourceQboSyncToken ?? '1',
        sourceStatus: 'POSTED',
        sourceUpdatedAt: new Date('2026-08-30T00:00:00.000Z'),
        observedAt: input.observedAt ?? new Date('2026-08-30T00:00:00.000Z'),
        transactionDate: new Date('2026-06-15T00:00:00.000Z'),
        payee: input.payee ?? 'Northwind Supplies Advisory',
        memo: input.memo ?? 'Historical inventory restock',
        amountCents: -11300n,
        currency: 'CAD',
        sourceAccountName: 'Synthetic Bank',
        categoryName: 'Inventory purchases',
        categoryQboId: 'observation-category-qbo-id',
        taxCalculation: 'TaxExcluded',
        taxCodeName: 'HST ON 13%',
        taxCodeQboId: 'observation-tax-qbo-id',
        tagNames: ['Inventory'],
      },
    });
  }

  it('loads display-only observations into lexical search, rehydration, and the corpus', async () => {
    const data = await fixtures();
    const observation = await createObservation({
      companyId: data.current.id, transactionId: data.transaction.id, sourceQboSyncToken: 'sync-secret',
    });
    const repository = new PrismaClassificationSearchRepository(db);
    const result = await searchClassificationMemory({
      query: 'northwind inventory', companyId: data.current.id,
      scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    const hit = result.hits.find((candidate) => candidate.sourceId === observation.id);
    expect(hit).toMatchObject({
      kind: 'historical_observation', advisory: true, executable: false, action: null,
      originIntent: null, verifiedAt: null, evidenceCount: 0,
      observation: expect.objectContaining({ sourceTransactionId: data.transaction.id }),
    });
    await expect(repository.rehydrate([data.current.id], [`historical_observation:${observation.id}`]))
      .resolves.toHaveLength(1);
    const corpus = await repository.documents(data.current.id);
    expect(corpus.documents).toContainEqual(expect.objectContaining({
      id: `historical_observation:${observation.id}`,
      kind: 'historical_observation', sourceId: observation.id,
    }));
    const document = corpus.documents.find(({ id }) => id === `historical_observation:${observation.id}`)!;
    expect(document.text).toContain('historical advisory observation');
    expect(document.text).not.toContain(observation.sourceQboId);
    expect(document.text).not.toContain(observation.sourceQboSyncToken);

    const selfExcluded = await searchClassificationMemory({
      query: 'northwind inventory', companyId: data.current.id,
      scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [data.current.id],
      excludeTransactionId: data.transaction.id,
    }, { repository, semantic: null });
    expect(selfExcluded.hits.map(({ sourceId }) => sourceId)).not.toContain(observation.id);

    await db.historicalClassificationObservation.delete({ where: { id: observation.id } });
    await expect(repository.rehydrate([data.current.id], [`historical_observation:${observation.id}`]))
      .resolves.toEqual([]);
  });

  it('keeps foreign observation identifiers redacted and ranks verified evidence above advisory history', async () => {
    const data = await fixtures();
    const currentObservation = await createObservation({
      companyId: data.current.id, transactionId: data.transaction.id, payee: 'Inventory Northwind Supplies',
    });
    const foreignTransaction = await db.transaction.create({
      data: {
        companyId: data.foreign.id, qboId: `foreign-observation-${randomUUID()}`, qboType: 'Purchase',
        qboSyncToken: 'foreign-sync', date: new Date('2026-06-15T00:00:00.000Z'),
        payee: 'Foreign Northwind Supplies', amount: '-10.00', bankAccount: 'Foreign Bank', status: 'POSTED',
      },
    });
    const foreignObservation = await createObservation({
      companyId: data.foreign.id, transactionId: foreignTransaction.id,
      sourceQboId: 'foreign-qbo-observation-id', payee: 'Foreign Northwind Supplies',
    });
    const repository = new PrismaClassificationSearchRepository(db);
    const ranked = await searchClassificationMemory({
      query: 'inventory', companyId: data.current.id, scope: 'current_company', mode: 'lexical',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(ranked.hits.findIndex(({ kind }) => kind === 'classification_case'))
      .toBeLessThan(ranked.hits.findIndex(({ sourceId }) => sourceId === currentObservation.id));

    const foreign = await searchClassificationMemory({
      query: 'northwind', companyId: data.current.id, scope: 'accessible_companies', mode: 'lexical',
      accessibleCompanyIds: [data.current.id, data.foreign.id],
    }, { repository, semantic: null });
    expect(foreign.hits.find(({ sourceId }) => sourceId === foreignObservation.id)).toMatchObject({
      companyRelation: 'foreign', advisory: true, executable: false, action: null,
      observation: {
        sourceTransactionId: 'redacted', sourceQboId: 'redacted', sourceQboSyncToken: 'redacted',
      },
    });
  });

  it('skips malformed legacy observations without failing unrelated lexical results', async () => {
    const data = await fixtures();
    await createObservation({
      companyId: data.current.id, transactionId: data.transaction.id, payee: 'Malformed Northwind', sourceQboType: 'Transfer',
    });
    const repository = new PrismaClassificationSearchRepository(db);
    await expect(searchClassificationMemory({
      query: 'northwind', companyId: data.current.id, scope: 'current_company', mode: 'lexical',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null })).resolves.toMatchObject({ status: 'no_match', hits: [] });
  });

  it('finds live aliases, rules, candidates, and case evidence while excluding inactive rows', async () => {
    const data = await fixtures();
    expect(await db.historicalClassificationObservation.count({
      where: { companyId: data.current.id },
    })).toBe(0);
    const repository = new PrismaClassificationSearchRepository(db);

    const aliasResult = await searchClassificationMemory({
      query: 'SAMPLEWEAR Exampletown Central',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id, data.foreign.id],
    }, { repository, semantic: null });
    expect(aliasResult.hits.map((candidate) => candidate.id))
      .toContain(`vendor_alias:${data.alias.id}`);
    expect(aliasResult.hits.every((candidate) => candidate.companyId === data.current.id)).toBe(true);

    const lexical = await searchClassificationMemory({
      query: 'Ontario thirteen percent inventory',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'lexical',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(lexical.hits.map((candidate) => candidate.id))
      .toContain(`classification_case:${data.classificationCase.id}`);

    const matchingContext = await searchClassificationMemory({
      query: 'Ontario thirteen percent inventory', companyId: data.current.id,
      scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [data.current.id],
      context: {
        transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: 'Synthetic Bank',
        currency: 'CAD', transactionPeriod: '2026-06', jurisdiction: 'CA-ON',
        taxCalculation: 'TaxExcluded',
      },
    }, { repository, semantic: null });
    expect(matchingContext.hits.map((candidate) => candidate.id))
      .toContain(`classification_case:${data.classificationCase.id}`);

    const mismatchingContext = await searchClassificationMemory({
      query: 'Ontario thirteen percent inventory', companyId: data.current.id,
      scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [data.current.id],
      context: {
        transactionDirection: 'in', qboType: 'Deposit', sourceAccountName: 'Savings',
        currency: 'USD', transactionPeriod: '2025-01', jurisdiction: 'US-CA',
        taxCalculation: 'NotApplicable',
      },
    }, { repository, semantic: null });
    expect(mismatchingContext.hits.map((candidate) => candidate.id))
      .not.toContain(`classification_case:${data.classificationCase.id}`);

    for (const context of [
      { transactionDirection: 'unknown' as const, jurisdiction: 'unknown' },
      { transactionDirection: 'unknown' as const, jurisdiction: null },
    ]) {
      const requestUnknown = await searchClassificationMemory({
        query: 'Ontario thirteen percent inventory', companyId: data.current.id,
        scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [data.current.id], context,
      }, { repository, semantic: null });
      expect(requestUnknown.hits.map((candidate) => candidate.id))
        .toContain(`classification_case:${data.classificationCase.id}`);
    }

    const unknownData = await fixtures('unknown');
    for (const transactionDirection of ['in', 'out'] as const) {
      const explicitUnknownDirection = await searchClassificationMemory({
        query: 'Ontario thirteen percent inventory', companyId: unknownData.current.id,
        scope: 'current_company', mode: 'lexical', accessibleCompanyIds: [unknownData.current.id],
        context: { transactionDirection },
      }, { repository, semantic: null });
      expect(explicitUnknownDirection.hits.map((candidate) => candidate.id))
        .toContain(`classification_case:${unknownData.classificationCase.id}`);
    }

    const activeOnly = await repository.search(
      [data.current.id],
      'Samplewear',
      100,
    );
    expect(activeOnly.map((candidate) => candidate.hit.id)).toEqual(expect.arrayContaining([
      `vendor_alias:${data.alias.id}`,
      `rule:${data.rule.id}`,
      `rule_candidate:${data.candidate.id}`,
      `classification_case:${data.classificationCase.id}`,
    ]));
    expect(activeOnly.some((candidate) => candidate.hit.vendorName === 'Samplewear retired old rule')).toBe(false);
    expect(activeOnly.some((candidate) => candidate.hit.vendorName === 'Samplewear gathering hidden')).toBe(false);
  });

  it('uses canonical substring, direction, and runtime fences for exact rule retrieval', async () => {
    const owner = await company('Canonical exact rules');
    const account = await db.qboAccount.create({
      data: {
        companyId: owner.id,
        qboId: 'canonical-expense',
        name: 'Canonical expense',
        fullName: 'Expenses · Canonical expense',
        classification: 'Expenses',
      },
    });
    const rule = await db.rule.create({
      data: {
        companyId: owner.id,
        matchText: 'Straße.Customer',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        direction: 'Purchase',
        canonicalVersion: 2,
        revision: 1,
      },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: owner.id,
        revision: 1,
        state: 'enabled',
        matchText: rule.matchText,
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'NotApplicable',
        taxCodeQboId: null,
        tagIds: [],
        priority: 0,
        autoPost: false,
        direction: 'Purchase',
        canonicalVersion: 2,
      },
    });
    const repository = new PrismaClassificationSearchRepository(db);
    const exactIds = async (qboType: 'Purchase' | 'Deposit') => (
      await repository.exact(
        [owner.id],
        'Payment at STRASSE.CUSTOMER #42',
        20,
        { qboType },
      )
    ).map((record) => record.hit.id);

    await db.company.update({ where: { id: owner.id }, data: { ruleRuntimeMode: 'bridge' } });
    expect(await exactIds('Purchase')).not.toContain(`rule:${rule.id}`);
    await db.company.update({ where: { id: owner.id }, data: { ruleRuntimeMode: 'paused' } });
    expect(await exactIds('Purchase')).not.toContain(`rule:${rule.id}`);
    await db.company.update({ where: { id: owner.id }, data: { ruleRuntimeMode: 'canonical' } });
    expect(await exactIds('Purchase')).toContain(`rule:${rule.id}`);
    expect(await exactIds('Deposit')).not.toContain(`rule:${rule.id}`);
  });

  it('validates canonical Deposit rule categories and tax codes against sales references', async () => {
    const owner = await company('Canonical Deposit rules');
    await db.company.update({
      where: { id: owner.id },
      data: {
        ruleRuntimeMode: 'canonical',
        taxSupportStatus: 'ready',
        taxUsingSalesTax: true,
      },
    });
    const account = await db.qboAccount.create({
      data: {
        companyId: owner.id,
        qboId: 'deposit-income',
        name: 'Service revenue',
        fullName: 'Income · Service revenue',
        classification: 'Income',
      },
    });
    await db.qboTaxRate.create({
      data: { companyId: owner.id, qboId: 'sales-rate', name: 'Sales 5%', rateValue: 5 },
    });
    const taxCode = await db.qboTaxCode.create({
      data: {
        companyId: owner.id,
        qboId: 'sales-tax',
        name: 'Sales tax',
        taxable: true,
        purchaseTaxRateList: [],
        salesTaxRateList: [{ taxRateQboId: 'sales-rate', taxTypeApplicable: 'TaxOnAmount' }],
      },
    });
    const rule = await db.rule.create({
      data: {
        companyId: owner.id,
        matchText: 'Customer receipt',
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'TaxInclusive',
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
        direction: 'Deposit',
        canonicalVersion: 2,
        revision: 1,
      },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: owner.id,
        revision: 1,
        state: 'enabled',
        matchText: rule.matchText,
        category: account.name,
        categoryQboId: account.qboId,
        taxCalculation: 'TaxInclusive',
        taxCode: taxCode.name,
        taxCodeQboId: taxCode.qboId,
        tagIds: [],
        priority: 0,
        autoPost: false,
        direction: 'Deposit',
        canonicalVersion: 2,
      },
    });
    const repository = new PrismaClassificationSearchRepository(db);
    const read = async () => (
      await repository.rehydrate([owner.id], [`rule:${rule.id}`], { qboType: 'Deposit' })
    )[0]?.hit;

    expect(await read()).toMatchObject({ action: expect.objectContaining({ taxCodeQboId: taxCode.qboId }) });
    await db.qboAccount.update({
      where: { companyId_qboId: { companyId: owner.id, qboId: account.qboId } },
      data: { classification: 'Expenses' },
    });
    expect(await read()).toMatchObject({ action: null, executable: false, advisory: true });
  });

  it('excludes selected case evidence after lexical search and semantic rehydration', async () => {
    const data = await fixtures();
    const repository = new PrismaClassificationSearchRepository(db);
    const createCase = async (label: string, date: string) => {
      const transaction = await db.transaction.create({
        data: {
          companyId: data.current.id,
          qboId: `purchase-${randomUUID()}`,
          qboType: 'Purchase',
          qboSyncToken: '1',
          date: new Date(date),
          payee: 'Synthetic Fuel',
          memo: 'Synthetic fuel purchase',
          amount: '-113.00',
          bankAccount: 'Synthetic Bank',
          category: data.account.name,
          categoryQboId: data.account.qboId,
          taxCalculation: 'TaxExcluded',
          taxCode: data.taxCode.name,
          taxCodeQboId: data.taxCode.qboId,
        },
      });
      const attempt = await db.qboMutationAttempt.create({
        data: {
          transactionId: transaction.id,
          requestId: `search-${label}-${randomUUID()}`,
          operation: 'post',
          status: 'VERIFIED',
          expectedRevision: 0,
          expectedSyncToken: '1',
          requestHash: 'd'.repeat(64),
          requestPayload: {},
          beforeSnapshot: {},
        },
      });
      const classificationCase = await db.classificationCase.create({
        data: {
          companyId: data.current.id,
          transactionId: transaction.id,
          vendorIdentityId: data.classificationCase.vendorIdentityId,
          qboMutationAttemptId: attempt.id,
          action: {
            categoryQboId: data.account.qboId,
            taxCalculation: 'TaxExcluded',
            taxCodeQboId: data.taxCode.qboId,
            tagIds: [data.tag.id],
          },
          actionFingerprint: randomUUID().replaceAll('-', '').padEnd(64, 'd'),
          originIntent: 'apply_once',
          rationale: 'Synthetic fuel purchase with verified business evidence.',
          requiredEvidence: ['Synthetic fuel receipt'],
          examples: ['Synthetic fuel purchase'],
          counterexamples: ['Personal vehicle fuel'],
          citations: [],
          reviewer: { userId: null, configVersion: 'synthetic', decision: 'approved' },
          jurisdiction: 'CA-ON',
          currency: 'CAD',
          context: {
            transactionDirection: 'out',
            qboType: 'Purchase',
            sourceAccountName: 'Synthetic Bank',
            businessPurpose: 'Fuel',
          },
          provenance: {
            source: 'qbo_verified',
            sourceId: attempt.requestId,
            actorId: null,
            recordedAt: date,
          },
          transactionSnapshot: {
            schemaVersion: 'classification-case/v1',
            transactionId: transaction.id,
            transactionRevision: 0,
            qboType: 'Purchase',
            qboId: transaction.qboId,
            date,
            amountCents: -11300,
            currency: 'CAD',
            payee: 'Synthetic Fuel',
            memo: 'Synthetic fuel purchase',
            sourceAccountName: 'Synthetic Bank',
          },
          verifiedAt: new Date(date),
        },
      });
      return { transaction, classificationCase };
    };
    const selected = await createCase('selected', '2025-02-04T00:00:00.000Z');
    const prior = await createCase('prior', '2025-02-02T00:00:00.000Z');

    const lexical = await searchClassificationMemory({
      query: 'synthetic fuel', companyId: data.current.id, scope: 'current_company', mode: 'lexical',
      limit: 20, accessibleCompanyIds: [data.current.id], excludeTransactionId: selected.transaction.id,
    }, { repository, semantic: null });
    expect(lexical.hits.map(({ sourceId }) => sourceId)).not.toContain(selected.classificationCase.id);
    expect(lexical.hits.map(({ sourceId }) => sourceId)).toContain(prior.classificationCase.id);

    const revision = (await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId: data.current.id }, orderBy: { revision: 'desc' },
    })).revision.toString();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1', fingerprintSalt: 'selected-case-exclusion',
    });
    const semantic = await searchClassificationMemory({
      query: 'synthetic fuel', companyId: data.current.id, scope: 'current_company', mode: 'semantic',
      limit: 20, accessibleCompanyIds: [data.current.id], excludeTransactionId: selected.transaction.id,
    }, {
      repository,
      semantic: {
        generation,
        client: {
          async embedDocuments() { throw new Error('not used'); },
          async embedQuery() { return Array.from({ length: 1024 }, () => 0); },
        },
        store: {
          async ensureAvailable() { return { available: true, reason: null }; },
          async healthMany() {
            return [{
              activeGeneration: generation.fingerprint,
              expectedGeneration: generation.fingerprint,
              expectedState: 'succeeded',
              embedded: 2, skipped: 0, backlog: 0, progress: 1,
              lastSuccessAt: '2026-08-31T00:00:00.000Z', lastError: null,
              latestAttemptGeneration: generation.fingerprint,
              latestAttemptState: 'succeeded',
              latestAttemptAt: '2026-08-31T00:00:00.000Z', latestAttemptError: null,
              currentCorpusRevision: revision, indexedCorpusRevision: revision,
              expectedCorpusRevision: revision, latestAttemptCorpusRevision: revision,
            }];
          },
          async search() {
            return [
              {
                documentId: `classification_case:${selected.classificationCase.id}`,
                companyId: data.current.id,
                kind: 'classification_case' as const,
                sourceId: selected.classificationCase.id,
                revisedAt: selected.classificationCase.verifiedAt.toISOString(),
                similarity: 0.99,
              },
              {
                documentId: `classification_case:${prior.classificationCase.id}`,
                companyId: data.current.id,
                kind: 'classification_case' as const,
                sourceId: prior.classificationCase.id,
                revisedAt: prior.classificationCase.verifiedAt.toISOString(),
                similarity: 0.98,
              },
            ];
          },
        },
      },
    });
    expect(semantic.hits.map(({ sourceId }) => sourceId)).not.toContain(selected.classificationCase.id);
    expect(semantic.hits.map(({ sourceId }) => sourceId)).toContain(prior.classificationCase.id);
  });

  it('keeps reviewed source names and aliases searchable while mapping hits to the final identity', async () => {
    const data = await fixtures();
    const source = await db.vendorIdentity.findFirstOrThrow({
      where: { companyId: data.current.id, normalizedName: 'samplewear region' },
    });
    const target = await db.vendorIdentity.create({
      data: {
        companyId: data.current.id,
        displayName: 'Examplegroup Region Canonical',
        normalizedName: 'examplegroup region canonical',
      },
    });
    await mergeVendorIdentities({
      companyId: data.current.id,
      sourceVendorIdentityId: source.id,
      targetVendorIdentityId: target.id,
      mergedBy: 'reviewer-search',
      reason: 'Reviewed duplicate Samplewear and Examplegroup vendor identities.',
    }, db);
    const repository = new PrismaClassificationSearchRepository(db);

    const exactSource = await searchClassificationMemory({
      query: 'Samplewear Region',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(exactSource.hits).toContainEqual(expect.objectContaining({
      id: `vendor_identity:${target.id}`,
      sourceId: target.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      action: null,
      provenance: expect.objectContaining({ sourceId: source.id }),
    }));
    expect(exactSource.hits.filter((hit) => hit.kind === 'vendor_identity')).toHaveLength(1);

    const exactTarget = await searchClassificationMemory({
      query: target.displayName,
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(exactTarget.hits.filter((hit) => hit.kind === 'vendor_identity')).toEqual([
      expect.objectContaining({
        id: `vendor_identity:${target.id}`,
        sourceId: target.id,
        vendorIdentityId: target.id,
        vendorName: target.displayName,
      }),
    ]);

    const exactAlias = await searchClassificationMemory({
      query: data.alias.value,
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(exactAlias.hits).toContainEqual(expect.objectContaining({
      id: `vendor_alias:${data.alias.id}`,
      sourceId: data.alias.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      action: null,
      provenance: expect.objectContaining({ sourceId: data.alias.id }),
    }));

    const lexical = await repository.search([data.current.id], 'Samplewear Region', 20);
    expect(lexical.map((record) => record.hit)).toContainEqual(expect.objectContaining({
      id: `vendor_identity:${target.id}`,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
    }));

    const corpus = await repository.documents(data.current.id);
    const identityDocuments = corpus.documents.filter((document) => (
      document.kind === 'vendor_identity'
      && (document.sourceId === source.id || document.sourceId === target.id)
    ));
    expect(identityDocuments).toHaveLength(1);
    expect(identityDocuments[0]).toMatchObject({
      id: `vendor_identity:${target.id}`,
      sourceId: target.id,
    });
    expect(identityDocuments[0]?.text).toContain(source.displayName);
    expect(corpus.documents.find((document) => document.id === `vendor_alias:${data.alias.id}`)?.text)
      .toContain(target.displayName);
  });

  it('preserves a merged source exact leg and provenance across exact, lexical, and hybrid search', async () => {
    const owner = await company('Merged Source Provenance');
    const source = await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Legacy Exact Provenance Needle',
        normalizedName: 'legacy exact provenance needle',
      },
    });
    const alias = await db.vendorAlias.create({
      data: {
        companyId: owner.id,
        vendorIdentityId: source.id,
        value: 'Historical Billing Key',
        normalizedValue: 'historical billing key',
        source: 'user',
      },
    });
    const target = await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Canonical Target Vendor',
        normalizedName: 'canonical target vendor',
      },
    });
    await mergeVendorIdentities({
      companyId: owner.id,
      sourceVendorIdentityId: source.id,
      targetVendorIdentityId: target.id,
      mergedBy: 'reviewer-provenance',
      reason: 'Reviewed source provenance regression fixture.',
    }, db);
    const repository = new PrismaClassificationSearchRepository(db);
    const query = source.displayName;

    const lexicalRecords = await repository.search([owner.id], query, 20);
    const identityRecord = lexicalRecords.find((record) => (
      record.hit.id === `vendor_identity:${target.id}`
    ));
    expect(identityRecord).toMatchObject({
      exactReasons: ['alias'],
      hit: {
        sourceId: target.id,
        vendorIdentityId: target.id,
        vendorName: target.displayName,
        provenance: { sourceId: source.id },
      },
    });

    const search = async (mode: 'exact' | 'lexical') => searchClassificationMemory({
      query,
      companyId: owner.id,
      scope: 'current_company',
      mode,
      accessibleCompanyIds: [owner.id],
    }, { repository, semantic: null });
    const exact = await search('exact');
    const lexical = await search('lexical');
    const exactHit = exact.hits.find((hit) => hit.id === `vendor_identity:${target.id}`);
    const lexicalHit = lexical.hits.find((hit) => hit.id === `vendor_identity:${target.id}`);
    expect(exactHit).toMatchObject({
      sourceId: target.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      matchedIn: expect.arrayContaining(['alias']),
      provenance: { sourceId: source.id },
    });
    expect(lexicalHit).toMatchObject({
      sourceId: target.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      matchedIn: expect.arrayContaining(['alias', 'lexical']),
      provenance: { sourceId: source.id },
    });
    expect(lexicalHit?.score).toBeCloseTo(2 / 61, 10);

    const revision = (await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId: owner.id },
      orderBy: { revision: 'desc' },
    })).revision.toString();
    const generation = classificationEmbeddingGeneration({
      baseUrl: 'https://api.voyageai.com/v1',
      fingerprintSalt: 'merged-source-provenance-test',
    });
    const hybrid = await searchClassificationMemory({
      query,
      companyId: owner.id,
      scope: 'current_company',
      mode: 'hybrid',
      accessibleCompanyIds: [owner.id],
    }, {
      repository,
      semantic: {
        generation,
        client: {
          async embedDocuments() { throw new Error('not used'); },
          async embedQuery() { return Array.from({ length: 1024 }, () => 0); },
        },
        store: {
          async ensureAvailable() { return { available: true, reason: null }; },
          async healthMany() {
            return [{
              activeGeneration: generation.fingerprint,
              expectedGeneration: generation.fingerprint,
              expectedState: 'succeeded',
              embedded: 1,
              skipped: 0,
              backlog: 0,
              progress: 1,
              lastSuccessAt: '2026-08-31T00:00:00.000Z',
              lastError: null,
              latestAttemptGeneration: generation.fingerprint,
              latestAttemptState: 'succeeded',
              latestAttemptAt: '2026-08-31T00:00:00.000Z',
              latestAttemptError: null,
              currentCorpusRevision: revision,
              indexedCorpusRevision: revision,
              expectedCorpusRevision: revision,
              latestAttemptCorpusRevision: revision,
            }];
          },
          async search() {
            return [{
              documentId: `vendor_identity:${target.id}`,
              companyId: owner.id,
              kind: 'vendor_identity' as const,
              sourceId: target.id,
              revisedAt: target.updatedAt.toISOString(),
              similarity: 0.95,
            }];
          },
        },
      },
    });
    const hybridHit = hybrid.hits.find((hit) => hit.id === `vendor_identity:${target.id}`);
    expect(hybridHit).toMatchObject({
      sourceId: target.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      matchedIn: expect.arrayContaining(['alias', 'lexical', 'semantic']),
      provenance: { sourceId: source.id },
    });
    expect(hybridHit?.score).toBeCloseTo(3 / 61, 10);

    const nonExact = await searchClassificationMemory({
      query: 'Legacy Provenance',
      companyId: owner.id,
      scope: 'current_company',
      mode: 'lexical',
      accessibleCompanyIds: [owner.id],
    }, { repository, semantic: null });
    expect(nonExact.hits.find((hit) => hit.id === `vendor_identity:${target.id}`)).toMatchObject({
      score: 1 / 61,
      provenance: { sourceId: target.id },
    });

    const exactAlias = await searchClassificationMemory({
      query: alias.value,
      companyId: owner.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [owner.id],
    }, { repository, semantic: null });
    expect(exactAlias.hits.find((hit) => hit.id === `vendor_alias:${alias.id}`)).toMatchObject({
      sourceId: alias.id,
      vendorIdentityId: target.id,
      vendorName: target.displayName,
      provenance: { sourceId: alias.id },
    });
  });

  it('bounds reviewed merge resolution to the bounded twenty-hop contract', async () => {
    const owner = await company('Bounded Merge Search');
    const chain = await Promise.all(Array.from({ length: 21 }, (_unused, index) => (
      db.vendorIdentity.create({
        data: {
          companyId: owner.id,
          displayName: `Merge Chain ${String(index).padStart(2, '0')}`,
          normalizedName: `merge chain ${String(index).padStart(2, '0')}`,
        },
      })
    )));
    for (let index = 0; index < chain.length - 1; index += 1) {
      await db.vendorIdentityMerge.create({
        data: {
          companyId: owner.id,
          sourceVendorIdentityId: chain[index]!.id,
          targetVendorIdentityId: chain[index + 1]!.id,
          mergedBy: 'reviewer-depth',
          reason: `Reviewed bounded merge hop ${index}.`,
        },
      });
    }
    const repository = new PrismaClassificationSearchRepository(db);

    await expect(findVendorIdentityByValue(owner.id, chain[0]!.displayName, db))
      .rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    const overDepth = await repository.exact([owner.id], chain[0]!.displayName, 20);
    expect(overDepth.filter((record) => record.hit.kind === 'vendor_identity')).toEqual([]);
    const withinBound = await repository.exact([owner.id], chain[1]!.displayName, 20);
    expect(withinBound.map((record) => record.hit)).toContainEqual(expect.objectContaining({
      id: `vendor_identity:${chain.at(-1)!.id}`,
      vendorIdentityId: chain.at(-1)!.id,
      vendorName: chain.at(-1)!.displayName,
    }));
  });

  it('reflects writes immediately and rehydration drops invalidated canonical records', async () => {
    const data = await fixtures();
    const repository = new PrismaClassificationSearchRepository(db);

    expect(await repository.search([data.current.id], 'new immediate alias', 20)).toHaveLength(0);
    const vendor = await db.vendorIdentity.findFirstOrThrow({ where: { companyId: data.current.id } });
    const created = await db.vendorAlias.create({
      data: {
        companyId: data.current.id,
        vendorIdentityId: vendor.id,
        value: 'New immediate alias',
        normalizedValue: 'new immediate alias',
        source: 'user',
      },
    });
    expect((await repository.search([data.current.id], 'new immediate alias', 20))
      .map((candidate) => candidate.hit.id)).toContain(`vendor_alias:${created.id}`);

    await db.classificationCaseInvalidation.create({
      data: {
        companyId: data.current.id,
        classificationCaseId: data.classificationCase.id,
        reason: 'Synthetic correction',
      },
    });
    await expect(repository.rehydrate(
      [data.current.id],
      [`classification_case:${data.classificationCase.id}`],
    )).resolves.toEqual([]);
  });

  it('keeps composite tax-inclusive rule and case actions executable', async () => {
    const data = await fixtures('out', true);
    const repository = new PrismaClassificationSearchRepository(db);
    await db.qboTaxCode.update({
      where: {
        companyId_qboId: {
          companyId: data.current.id,
          qboId: data.taxCode.qboId,
        },
      },
      data: { combinedPurchaseRate: null },
    });

    const cards = (await repository.rehydrate(
      [data.current.id],
      [`rule:${data.rule.id}`, `classification_case:${data.classificationCase.id}`],
    )).map((record) => record.hit);

    expect(cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `rule:${data.rule.id}`,
        action: expect.objectContaining({ taxCalculation: 'TaxInclusive' }),
      }),
      expect.objectContaining({
        id: `classification_case:${data.classificationCase.id}`,
        action: expect.objectContaining({ taxCalculation: 'TaxInclusive' }),
        executable: true,
        advisory: false,
      }),
    ]));

    await db.qboTaxRate.update({
      where: {
        companyId_qboId: {
          companyId: data.current.id,
          qboId: 'rate-pst-7',
        },
      },
      data: { rateValue: null },
    });
    const cardsWithNullRate = (await repository.rehydrate(
      [data.current.id],
      [`rule:${data.rule.id}`, `classification_case:${data.classificationCase.id}`],
    )).map((record) => record.hit);
    expect(cardsWithNullRate).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `rule:${data.rule.id}`, action: null }),
      expect.objectContaining({
        id: `classification_case:${data.classificationCase.id}`,
        action: null,
        executable: false,
      }),
    ]));
  });

  it('gates rule and case actions on current account, tax, tag, lifecycle, and tenant readiness', async () => {
    const data = await fixtures();
    const repository = new PrismaClassificationSearchRepository(db);
    const ids = [`rule:${data.rule.id}`, `classification_case:${data.classificationCase.id}`];
    const cards = async () => (await repository.rehydrate([data.current.id], ids))
      .map((record) => record.hit);

    await expect(cards()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids[0], action: expect.any(Object), advisory: true }),
      expect.objectContaining({ id: ids[1], action: expect.any(Object), executable: true, advisory: false }),
    ]));

    await db.qboAccount.update({
      where: { companyId_qboId: { companyId: data.current.id, qboId: data.account.qboId } },
      data: { active: false },
    });
    for (const card of await cards()) {
      expect(card).toMatchObject({ action: null, executable: false, advisory: true });
      expect(card.actionSummary).toMatchObject({ categoryName: data.account.name });
    }

    await db.qboAccount.update({
      where: { companyId_qboId: { companyId: data.current.id, qboId: data.account.qboId } },
      data: { active: true },
    });
    await db.qboTaxCode.update({
      where: { companyId_qboId: { companyId: data.current.id, qboId: data.taxCode.qboId } },
      data: { active: false },
    });
    for (const card of await cards()) {
      expect(card).toMatchObject({ action: null, executable: false, advisory: true });
      expect(card.actionSummary).toMatchObject({ taxCodeName: data.taxCode.name });
    }

    await db.qboTaxCode.update({
      where: { companyId_qboId: { companyId: data.current.id, qboId: data.taxCode.qboId } },
      data: { active: true },
    });
    await db.company.update({
      where: { id: data.current.id }, data: { taxSupportStatus: 'needs_setup' },
    });
    for (const card of await cards()) {
      expect(card).toMatchObject({ action: null, executable: false, advisory: true });
    }
    await db.company.update({
      where: { id: data.current.id }, data: { taxSupportStatus: 'ready' },
    });
    await db.tag.delete({ where: { id: data.tag.id } });
    for (const card of await cards()) {
      expect(card).toMatchObject({ action: null, executable: false, advisory: true });
    }

    const foreignAccount = await db.qboAccount.create({
      data: {
        companyId: data.foreign.id, qboId: 'foreign-account', name: 'Foreign category',
        fullName: 'Foreign category', classification: 'Expenses', active: true,
      },
    });
    const foreignRule = await db.rule.create({
      data: {
        companyId: data.foreign.id, matchText: 'Foreign readiness needle',
        category: foreignAccount.name, categoryQboId: foreignAccount.qboId,
        taxCalculation: 'NotApplicable', revision: 1,
      },
    });
    await db.ruleRevision.create({ data: {
      ruleId: foreignRule.id, companyId: data.foreign.id, revision: 1, state: 'enabled',
      matchText: foreignRule.matchText, category: foreignAccount.name, categoryQboId: null,
      taxCalculation: 'NotApplicable', priority: 0, autoPost: false,
    } });
    const foreign = await searchClassificationMemory({
      query: 'Foreign readiness needle', companyId: data.current.id, scope: 'accessible_companies',
      mode: 'exact', accessibleCompanyIds: [data.current.id, data.foreign.id],
    }, { repository, semantic: null });
    expect(foreign.hits).toContainEqual(expect.objectContaining({
      id: `rule:${foreignRule.id}`, companyRelation: 'foreign', action: null,
      executable: false, advisory: true,
      rationale: expect.stringContaining('Historical rule classification'),
    }));

    await db.rule.update({ where: { id: data.rule.id }, data: { revision: 99 } });
    await expect(repository.rehydrate([data.current.id], [`rule:${data.rule.id}`])).resolves.toEqual([]);
  });

  it('keeps deleted-account historical evidence readable but never executable', async () => {
    const data = await fixtures();
    await db.qboAccount.delete({
      where: { companyId_qboId: { companyId: data.current.id, qboId: data.account.qboId } },
    });
    const cards = await new PrismaClassificationSearchRepository(db).rehydrate(
      [data.current.id],
      [`rule:${data.rule.id}`, `classification_case:${data.classificationCase.id}`],
    );
    expect(cards.map((record) => record.hit)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: null, executable: false, advisory: true }),
      expect.objectContaining({ action: null, executable: false, advisory: true }),
    ]));
    expect(cards.every((record) => record.hit.actionSummary?.categoryName === data.account.name)).toBe(true);
  });

  it('keeps rule tags tenant-owned and searches immutable bounded case snapshots', async () => {
    const data = await fixtures();
    const foreignTag = await db.tag.create({
      data: {
        id: `foreign-tag-${randomUUID()}`,
        companyId: data.foreign.id,
        name: 'ForeignSecretTag',
        color: '#000000',
      },
    });
    await db.ruleTag.create({
      data: { ruleId: data.rule.id, tagId: foreignTag.id },
    });
    await db.transaction.update({
      where: { id: data.transaction.id },
      data: { payee: 'Mutated Live Payee', memo: 'MutatedSecretMemo' },
    });
    const repository = new PrismaClassificationSearchRepository(db);

    await expect(repository.search([data.current.id], 'ForeignSecretTag', 20))
      .resolves.toEqual([]);
    const immutable = await repository.search([data.current.id], 'Samplewear Eastgate', 20);
    expect(immutable.map((record) => record.hit.id))
      .toContain(`classification_case:${data.classificationCase.id}`);
    expect(await repository.search([data.current.id], 'MutatedSecretMemo', 20))
      .toEqual([]);
  });

  it('matches canonically equivalent Unicode rules and emits canonical aggregate order', async () => {
    const data = await fixtures();
    const decomposed = await db.rule.create({
      data: {
        companyId: data.current.id,
        matchText: 'Cafe\u0301 Inventory',
        category: 'Inventory purchases',
      },
    });
    const vendor = await db.vendorIdentity.create({
      data: { companyId: data.current.id, displayName: 'Aggregate Vendor', normalizedName: 'aggregate vendor' },
    });
    await db.vendorAlias.createMany({
      data: [
        { companyId: data.current.id, vendorIdentityId: vendor.id, value: 'Zulu alias', normalizedValue: 'zulu alias', source: 'user' },
        { companyId: data.current.id, vendorIdentityId: vendor.id, value: 'Alpha alias', normalizedValue: 'alpha alias', source: 'user' },
      ],
    });
    const [alphaTagId, zuluTagId] = [randomUUID(), randomUUID()].sort();
    const alphaTag = await db.tag.create({
      data: { id: alphaTagId!, companyId: data.current.id, name: 'Alpha tag', color: '#111111' },
    });
    const zuluTag = await db.tag.create({
      data: { id: zuluTagId!, companyId: data.current.id, name: 'Zulu tag', color: '#222222' },
    });
    const middleTags = Array.from({ length: 48 }, (_unused, index) => ({
      id: randomUUID(), companyId: data.current.id,
      name: `Middle tag ${String(index).padStart(2, '0')}`, color: '#333333',
    }));
    await db.tag.createMany({ data: middleTags });
    await db.ruleTag.create({ data: { ruleId: data.rule.id, tagId: zuluTag.id } });
    await db.ruleTag.create({ data: { ruleId: data.rule.id, tagId: alphaTag.id } });
    await db.ruleRevision.create({ data: {
      ruleId: data.rule.id, companyId: data.current.id, revision: 3, state: 'enabled',
      matchText: data.rule.matchText, category: data.account.name, categoryQboId: data.account.qboId,
      taxCalculation: 'TaxExcluded', taxCode: data.taxCode.name, taxCodeQboId: data.taxCode.qboId,
      tagIds: [zuluTag.id, ...middleTags.map((tag) => tag.id), alphaTag.id],
      priority: 0, autoPost: false,
      originIntent: 'make_recurring',
    } });
    await db.rule.update({ where: { id: data.rule.id }, data: { revision: 3 } });
    const observedAt = new Date('2026-08-31T00:00:00.000Z');
    const [alphaEvidenceId, zuluEvidenceId] = [randomUUID(), randomUUID()].sort();
    await db.autopilotRuleCandidateEvidence.create({
      data: {
        id: zuluEvidenceId!,
        companyId: data.current.id,
        candidateId: data.candidate.id,
        transactionId: data.transaction.id,
        inputRevision: 0,
        requestId: `aggregate-z-${randomUUID()}`,
        source: 'verified_outcome',
        actionFingerprint: 'e'.repeat(64),
        pattern: { value: 'Zulu pattern' },
        observedAt,
      },
    });
    await db.autopilotRuleCandidateEvidence.create({
      data: {
        id: alphaEvidenceId!,
        companyId: data.current.id,
        candidateId: data.candidate.id,
        transactionId: data.transaction.id,
        inputRevision: 0,
        requestId: `aggregate-a-${randomUUID()}`,
        source: 'verified_outcome',
        actionFingerprint: 'e'.repeat(64),
        pattern: { value: 'Alpha pattern' },
        observedAt,
      },
    });
    const repository = new PrismaClassificationSearchRepository(db);

    const exact = await searchClassificationMemory({
      query: 'Caf\u00e9 Inventory',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      accessibleCompanyIds: [data.current.id],
    }, { repository, semantic: null });
    expect(exact.hits.map((hit) => hit.id)).toContain(`rule:${decomposed.id}`);
    const identity = (await repository.rehydrate(
      [data.current.id],
      [`vendor_identity:${vendor.id}`],
    ))[0];
    expect(identity?.document?.text.indexOf('Alpha alias'))
      .toBeLessThan(identity?.document?.text.indexOf('Zulu alias') ?? -1);
    const rule = (await repository.rehydrate(
      [data.current.id],
      [`rule:${data.rule.id}`],
    ))[0];
    const expectedTagPairs = [
      [zuluTag.id, 'Zulu tag'],
      ...middleTags.map((tag) => [tag.id, tag.name]),
      [alphaTag.id, 'Alpha tag'],
    ];
    const actionTagIds = rule?.hit.action?.tagIds ?? [];
    const actionTagNames = rule?.hit.actionSummary?.tagNames ?? [];
    expect(actionTagIds.map((tagId, index) => [tagId, actionTagNames[index]]))
      .toEqual(expectedTagPairs);
    expect(rule?.document?.text.indexOf('Zulu tag'))
      .toBeLessThan(rule?.document?.text.indexOf('Alpha tag') ?? -1);
    const candidate = (await repository.rehydrate(
      [data.current.id],
      [`rule_candidate:${data.candidate.id}`],
    ))[0];
    expect(candidate?.document?.text.indexOf('Alpha pattern'))
      .toBeLessThan(candidate?.document?.text.indexOf('Zulu pattern') ?? -1);
  });

  it('bounds raw rule revision tag expansion before validating oversized and malformed actions', async () => {
    const data = await fixtures();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "RuleRevision" DROP CONSTRAINT "RuleRevision_tag_shape_check"',
      );
      let observedRuleSql = '';
      const intercepted = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === '$queryRaw') {
            return async (query: { strings?: readonly string[] }) => {
              const sql = query.strings?.join(' ') ?? '';
              if (sql.includes('FROM "Rule" rule')) observedRuleSql = sql;
              return target.$queryRaw(query as never);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const repository = new PrismaClassificationSearchRepository(intercepted as never);
      const invalidTagRationale = 'Historical rule action is unavailable because its tag IDs are invalid.';
      const cases: Array<{ label: string; tagIds: unknown }> = [
        { label: 'non-array', tagIds: 'not-an-array' },
        { label: 'duplicate', tagIds: [data.tag.id, data.tag.id] },
        { label: '51 items', tagIds: Array.from({ length: 51 }, () => randomUUID()) },
        { label: 'five thousand items', tagIds: Array.from({ length: 5_000 }, () => randomUUID()) },
      ];

      for (const [index, testCase] of cases.entries()) {
        const revision = index + 3;
        await tx.ruleRevision.create({ data: {
          ruleId: data.rule.id, companyId: data.current.id, revision, state: 'enabled',
          matchText: data.rule.matchText, category: data.account.name,
          categoryQboId: data.account.qboId, taxCalculation: 'TaxExcluded',
          taxCode: data.taxCode.name, taxCodeQboId: data.taxCode.qboId,
          tagIds: testCase.tagIds as never, priority: 0, autoPost: false,
          originIntent: 'make_recurring',
        } });
        await tx.rule.update({ where: { id: data.rule.id }, data: { revision } });
        const record = (await repository.rehydrate(
          [data.current.id],
          [`rule:${data.rule.id}`],
        ))[0];
        expect(record?.hit, testCase.label).toMatchObject({
          action: null,
          executable: false,
          advisory: true,
          rationale: invalidTagRationale,
        });
        expect(record?.hit.actionSummary?.tagNames ?? [], testCase.label).toHaveLength(0);
      }

      const safelyGuardedExpansions = observedRuleSql.match(
        /jsonb_array_elements(?:_text)?\(CASE WHEN jsonb_typeof\(revision\."tagIds"\) = 'array'\s+THEN CASE WHEN jsonb_array_length\(revision\."tagIds"\) <= 50\s+THEN revision\."tagIds" ELSE '\[\]'::jsonb END\s+ELSE '\[\]'::jsonb END/gu,
      ) ?? [];
      expect(safelyGuardedExpansions).toHaveLength(2);
      expect(observedRuleSql).toMatch(
        /AND CASE WHEN jsonb_typeof\(revision\."tagIds"\) = 'array'\s+THEN jsonb_array_length\(revision\."tagIds"\) <= 50 ELSE false END AS "tagsExist"/u,
      );

      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.ruleRevision.deleteMany({
        where: { companyId: data.current.id, ruleId: data.rule.id, revision: { gte: 3 } },
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      await tx.rule.update({ where: { id: data.rule.id }, data: { revision: 2 } });
      await tx.$executeRawUnsafe(
        'ALTER TABLE "RuleRevision" ADD CONSTRAINT "RuleRevision_tag_shape_check" '
        + 'CHECK (jsonb_typeof("tagIds") = \'array\' AND jsonb_array_length("tagIds") <= 50)',
      );
    });
  });

  it('paginates the complete embedding corpus beyond the former ten-thousand-row cap', async () => {
    const owner = await company('Large Corpus');
    await db.vendorIdentity.createMany({
      data: Array.from({ length: 10_001 }, (_unused, index) => ({
        companyId: owner.id,
        displayName: `Vendor ${String(index).padStart(5, '0')}`,
        normalizedName: `vendor ${String(index).padStart(5, '0')}`,
      })),
    });

    const corpus = await new PrismaClassificationSearchRepository(db).documents(owner.id);

    expect(corpus).toMatchObject({ totalDocuments: 10_001, skippedDocuments: 0 });
    expect(corpus.documents).toHaveLength(10_001);
  }, 120_000);

  it('rejects a corpus scan when a canonical write lands between keyset pages', async () => {
    const owner = await company('Changing Corpus');
    await db.vendorIdentity.createMany({
      data: Array.from({ length: 501 }, (_unused, index) => ({
        companyId: owner.id,
        displayName: `Changing Vendor ${String(index).padStart(3, '0')}`,
        normalizedName: `changing vendor ${String(index).padStart(3, '0')}`,
      })),
    });
    let documentPageQueries = 0;
    const intercepted = new Proxy(db, {
      get(target, property, receiver) {
        if (property === '$queryRaw') {
          return async (query: { strings?: readonly string[] }) => {
            const rows = await target.$queryRaw(query as never);
            if (
              query.strings?.join(' ').includes('canonical_documents')
              && ++documentPageQueries === 1
            ) {
              await db.vendorIdentity.create({
                data: {
                  companyId: owner.id,
                  displayName: 'Concurrent Page Write',
                  normalizedName: 'concurrent page write',
                },
              });
            }
            return rows;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new PrismaClassificationSearchRepository(intercepted).documents(owner.id))
      .rejects.toMatchObject({ code: 'COMPANY_UNAVAILABLE' });
    expect(documentPageQueries).toBe(1);
  });

  it('installs transactional revision triggers for every corpus source and joined dependency', async () => {
    const owner = await company('Corpus Trigger Coverage');
    const expected = [
      'classification_corpus_company_nickname',
      'classification_corpus_vendor_identity',
      'classification_corpus_vendor_identity_update',
      'classification_corpus_vendor_alias',
      'classification_corpus_vendor_alias_update',
      'classification_corpus_vendor_merge',
      'classification_corpus_vendor_merge_update',
      'classification_corpus_case',
      'classification_corpus_case_update',
      'classification_corpus_case_invalidation',
      'classification_corpus_case_invalidation_update',
      'classification_corpus_historical_observation',
      'classification_corpus_rule',
      'classification_corpus_rule_update',
      'classification_corpus_rule_revision',
      'classification_corpus_rule_revision_update',
      'classification_corpus_rule_tag',
      'classification_corpus_rule_tag_update',
      'classification_corpus_candidate',
      'classification_corpus_candidate_update',
      'classification_corpus_candidate_evidence',
      'classification_corpus_candidate_evidence_update',
      'classification_corpus_tag',
      'classification_corpus_tag_update',
      'classification_corpus_account',
      'classification_corpus_account_update',
      'classification_corpus_tax_code',
      'classification_corpus_tax_code_update',
      'classification_corpus_transaction',
    ].sort();
    const triggers = await db.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE 'classification_corpus_%'
      ORDER BY tgname ASC
    `;
    expect(triggers.map((row) => row.name).filter((name) => name !== 'classification_corpus_company_insert'))
      .toEqual(expected);
    const scopedColumns = new Map(triggers.map((trigger) => {
      const updateClause = trigger.definition.match(/UPDATE OF (.+?) ON /u)?.[1] ?? '';
      return [
        trigger.name,
        updateClause.split(',').map((column) => column.trim().replaceAll('"', '')).filter(Boolean),
      ];
    }));
    expect(scopedColumns.get('classification_corpus_vendor_identity_update')).toEqual(
      expect.arrayContaining(['id', 'companyId', 'displayName', 'normalizedName']),
    );
    expect(scopedColumns.get('classification_corpus_vendor_alias_update')).toEqual(
      expect.arrayContaining(['companyId', 'vendorIdentityId', 'value', 'normalizedValue', 'source']),
    );
    expect(scopedColumns.get('classification_corpus_vendor_merge_update')).toEqual(
      expect.arrayContaining(['companyId', 'sourceVendorIdentityId', 'targetVendorIdentityId']),
    );
    expect(scopedColumns.get('classification_corpus_company_nickname')).toEqual(
      expect.arrayContaining(['nickname', 'taxSupportStatus']),
    );
    expect(scopedColumns.get('classification_corpus_tag_update')).toEqual(
      expect.arrayContaining(['companyId', 'name']),
    );
    expect(scopedColumns.get('classification_corpus_account_update')).toEqual(
      expect.arrayContaining(['companyId', 'qboId', 'name', 'fullName', 'active']),
    );
    expect(scopedColumns.get('classification_corpus_tax_code_update')).toEqual(
      expect.arrayContaining([
        'companyId', 'qboId', 'name', 'active', 'taxable',
        'purchaseTaxRateList', 'combinedPurchaseRate',
      ]),
    );
    expect(scopedColumns.get('classification_corpus_transaction')).toEqual(
      expect.arrayContaining([
        'companyId', 'qboType', 'date', 'payee', 'memo', 'amount', 'bankAccount',
        'category', 'categoryQboId', 'taxCalculation', 'taxCode', 'taxCodeQboId',
      ]),
    );
    for (const trigger of triggers.filter((row) => row.definition.includes(' UPDATE '))) {
      expect(trigger.definition, trigger.name).toContain('WHEN (');
      expect(trigger.definition, trigger.name).toContain('IS DISTINCT FROM');
    }
    const before = await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId: owner.id }, orderBy: { revision: 'desc' },
    });
    await db.vendorIdentity.create({
      data: {
        companyId: owner.id,
        displayName: 'Trigger Mutation',
        normalizedName: 'trigger mutation',
      },
    });
    const after = await db.classificationCorpusRevision.findFirstOrThrow({
      where: { companyId: owner.id }, orderBy: { revision: 'desc' },
    });
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('does not append revisions for idempotent assignments on mutable corpus sources', async () => {
    const data = await fixtures();
    const identity = await db.vendorIdentity.findFirstOrThrow({
      where: { companyId: data.current.id },
    });
    const tag = await db.tag.create({
      data: { companyId: data.current.id, name: 'Stable tag', color: '#123456' },
    });
    await db.ruleTag.create({ data: { ruleId: data.rule.id, tagId: tag.id } });
    const account = await db.qboAccount.findFirstOrThrow({
      where: { companyId: data.current.id },
    });
    const taxCode = await db.qboTaxCode.findFirstOrThrow({
      where: { companyId: data.current.id },
    });
    const evidence = await db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: data.current.id,
        candidateId: data.candidate.id,
        transactionId: data.transaction.id,
        inputRevision: 0,
        requestId: `no-op-${randomUUID()}`,
        source: 'verified_outcome',
        actionFingerprint: 'f'.repeat(64),
        pattern: { payee: 'Stable evidence' },
      },
    });
    const revisionStats = () => db.classificationCorpusRevision.aggregate({
      where: { companyId: data.current.id },
      _count: { revision: true },
      _max: { revision: true },
    });
    const before = await revisionStats();

    await db.company.update({ where: { id: data.current.id }, data: { nickname: data.current.nickname } });
    await db.company.update({
      where: { id: data.current.id }, data: { taxSupportStatus: 'ready' },
    });
    await db.vendorIdentity.update({
      where: { id: identity.id }, data: { displayName: identity.displayName },
    });
    await db.rule.update({ where: { id: data.rule.id }, data: { matchText: data.rule.matchText } });
    await db.autopilotRuleCandidate.update({
      where: { id: data.candidate.id }, data: { matchText: data.candidate.matchText },
    });
    await db.$executeRaw`UPDATE "AutopilotRuleCandidateEvidence" SET "pattern" = "pattern" WHERE "id" = ${evidence.id}`;
    await db.tag.update({ where: { id: tag.id }, data: { name: tag.name } });
    await db.qboAccount.update({
      where: { id: account.id }, data: { name: account.name, active: account.active },
    });
    await db.qboTaxCode.update({ where: { id: taxCode.id }, data: {
      name: taxCode.name, active: taxCode.active, taxable: taxCode.taxable,
      purchaseTaxRateList: taxCode.purchaseTaxRateList as never,
      combinedPurchaseRate: taxCode.combinedPurchaseRate,
    } });
    await db.transaction.update({
      where: { id: data.transaction.id }, data: {
        qboType: data.transaction.qboType, date: data.transaction.date,
        payee: data.transaction.payee, memo: data.transaction.memo, amount: data.transaction.amount,
        bankAccount: data.transaction.bankAccount, category: data.transaction.category,
        categoryQboId: data.transaction.categoryQboId,
        taxCalculation: data.transaction.taxCalculation, taxCode: data.transaction.taxCode,
        taxCodeQboId: data.transaction.taxCodeQboId,
      },
    });
    await db.ruleTag.update({
      where: { ruleId_tagId: { ruleId: data.rule.id, tagId: tag.id } },
      data: { ruleId: data.rule.id },
    });

    expect(await revisionStats()).toEqual(before);

    await db.$executeRaw`UPDATE "Transaction" SET "payee" = 'Changed corpus payee' WHERE "id" = ${data.transaction.id}`;
    const afterRealChange = await revisionStats();
    expect(afterRealChange._count.revision).toBe(before._count.revision + 1);
    expect(afterRealChange._max.revision).toBeGreaterThan(before._max.revision);
  });

  it('invalidates both old and new rule owners on a cross-company RuleTag update', async () => {
    const data = await fixtures();
    const tag = await db.tag.create({
      data: { companyId: data.current.id, name: 'Movable tag', color: '#123456' },
    });
    const foreignRule = await db.rule.create({
      data: {
        companyId: data.foreign.id,
        matchText: 'Foreign movable rule',
        category: 'Foreign category',
      },
    });
    await db.ruleTag.create({ data: { ruleId: data.rule.id, tagId: tag.id } });
    const revision = async (companyId: string) => (
      await db.classificationCorpusRevision.findFirstOrThrow({
        where: { companyId }, orderBy: { revision: 'desc' },
      })
    ).revision;
    const beforeCurrent = await revision(data.current.id);
    const beforeForeign = await revision(data.foreign.id);

    await db.ruleTag.update({
      where: { ruleId_tagId: { ruleId: data.rule.id, tagId: tag.id } },
      data: { ruleId: foreignRule.id },
    });

    expect(await revision(data.current.id)).toBeGreaterThan(beforeCurrent);
    expect(await revision(data.foreign.id)).toBeGreaterThan(beforeForeign);
  });

  it('ignores unrelated high-churn fields but fences reference-readiness changes', async () => {
    const data = await fixtures();
    const latest = async () => (
      await db.classificationCorpusRevision.findFirstOrThrow({
        where: { companyId: data.current.id }, orderBy: { revision: 'desc' },
      })
    ).revision;
    const initial = await latest();

    await db.transaction.update({
      where: { id: data.transaction.id },
      data: { status: 'POSTING' },
    });
    expect(await latest()).toBe(initial);
    await db.transaction.update({
      where: { id: data.transaction.id },
      data: { payee: 'Corpus-affecting payee' },
    });
    const afterPayee = await latest();
    expect(afterPayee).toBeGreaterThan(initial);

    const account = await db.qboAccount.findFirstOrThrow({
      where: { companyId: data.current.id },
    });
    await db.qboAccount.update({ where: { id: account.id }, data: { active: false } });
    const afterActive = await latest();
    expect(afterActive).toBeGreaterThan(afterPayee);
    await db.qboAccount.update({ where: { id: account.id }, data: { name: 'Renamed corpus account' } });
    expect(await latest()).toBeGreaterThan(afterActive);
  });

  it('bounds oversized candidate evidence without dropping the lexical hit', async () => {
    const data = await fixtures();
    await db.autopilotRuleCandidateEvidence.create({
      data: {
        id: `candidate-evidence-${randomUUID()}`,
        companyId: data.current.id,
        candidateId: data.candidate.id,
        transactionId: data.transaction.id,
        inputRevision: 0,
        requestId: `candidate-search-${randomUUID()}`,
        source: 'verified_outcome',
        actionFingerprint: 'd'.repeat(64),
        pattern: { note: `BoundedEvidenceNeedle ${'x'.repeat(40_000)}` },
      },
    });
    const repository = new PrismaClassificationSearchRepository(db);

    const records = await repository.search([data.current.id], 'BoundedEvidenceNeedle', 20);
    expect(records.map((record) => record.hit.id)).toContain(`rule_candidate:${data.candidate.id}`);
    expect(records.find((record) => record.hit.id === `rule_candidate:${data.candidate.id}`)?.document)
      .toBeDefined();
  });

  it('retains exact aliases and active rules under saturated higher-score lexical noise', async () => {
    const data = await fixtures();
    await db.autopilotRuleCandidate.createMany({
      data: Array.from({ length: 60 }, (_unused, index) => ({
        companyId: data.current.id,
        conditionFingerprint: index.toString(16).padStart(64, '0'),
        schemaVersion: 'v2',
        configVersion: 'saturation',
        matchText: 'SAMPLEWEAR Exampletown Central SAMPLEWEAR Exampletown Central SAMPLEWEAR Exampletown Central',
        state: 'ready',
      })),
    });
    const exactRule = await db.rule.create({
      data: {
        companyId: data.current.id,
        matchText: 'SAMPLEWEAR Exampletown Central',
        category: 'Inventory purchases',
      },
    });

    const result = await searchClassificationMemory({
      query: 'SAMPLEWEAR Exampletown Central',
      companyId: data.current.id,
      scope: 'current_company',
      mode: 'exact',
      limit: 20,
      accessibleCompanyIds: [data.current.id],
    }, { repository: new PrismaClassificationSearchRepository(db), semantic: null });

    expect(result.hits.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      `vendor_alias:${data.alias.id}`,
      `rule:${exactRule.id}`,
    ]));
    expect(result.hits.every((candidate) => (
      candidate.matchedIn.includes('alias') || candidate.matchedIn.includes('rule')
    ))).toBe(true);
  });
});
