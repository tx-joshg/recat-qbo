import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getClassificationCaseByRequestId,
  invalidateClassificationCase,
  recordVerifiedClassificationCase,
  type ClassificationCaseDb,
  type RecordClassificationCaseInput,
} from './cases.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

const ACTION = {
  categoryQboId: 'category-synthetic',
  taxCalculation: 'NotApplicable' as const,
  taxCodeQboId: null,
  tagIds: [],
};

describePostgres('classification cases on PostgreSQL', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    const ids = [...companyIds];
    companyIds.clear();
    if (ids.length > 0) {
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const company = await db.company.create({
      data: {
        realmId: `classification-case-${randomUUID()}`,
        legalName: 'Synthetic Classification Company',
        nickname: 'Synthetic Classification',
      },
    });
    companyIds.add(company.id);
    const transaction = await db.transaction.create({
      data: {
        companyId: company.id,
        qboId: `txn-${randomUUID()}`,
        qboType: 'Purchase',
        qboSyncToken: '0',
        date: new Date('2026-08-30T00:00:00.000Z'),
        payee: '  Synthetic   Vendor  ',
        memo: 'Synthetic memo',
        amount: '-12.34',
        bankAccount: 'Synthetic operating account',
        rawData: { privateProviderPayload: 'must not be copied' },
      },
    });
    const attempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: transaction.id,
        requestId: `request-${randomUUID()}`,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: transaction.revision,
        expectedSyncToken: transaction.qboSyncToken,
        requestHash: 'synthetic-request-hash',
        requestPayload: { privateRequest: 'must not be copied' },
        beforeSnapshot: { privateBefore: 'must not be copied' },
        responseSnapshot: { privateResponse: 'must not be copied' },
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
      },
    });
    const identity = await db.vendorIdentity.create({
      data: {
        companyId: company.id,
        qboVendorId: `vendor-${randomUUID()}`,
        displayName: 'Synthetic Vendor',
        normalizedName: 'synthetic vendor',
      },
    });
    const input: RecordClassificationCaseInput = {
      companyId: company.id,
      transactionId: transaction.id,
      qboMutationAttemptId: attempt.id,
      vendorIdentityId: identity.id,
      action: ACTION,
      originIntent: 'apply_once',
      rationale: 'Synthetic verified decision.',
      requiredEvidence: ['Synthetic receipt'],
      examples: ['Synthetic invoice'],
      counterexamples: [],
      citations: [],
      reviewer: {
        userId: null,
        configVersion: 'synthetic-config',
        decision: 'approved',
      },
      jurisdiction: 'unknown',
      currency: 'CAD',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic operating account',
        businessPurpose: null,
      },
      provenance: {
        source: 'qbo_verified',
        sourceId: attempt.id,
        actorId: null,
        recordedAt: attempt.updatedAt.toISOString(),
      },
    };
    return { company, transaction, attempt, identity, input };
  }

  function racingDb(
    delegate: 'classificationCase' | 'classificationCaseInvalidation',
  ): ClassificationCaseDb {
    let arrivals = 0;
    let release!: () => void;
    const bothAtInsert = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForBoth = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothAtInsert;
    };
    return {
      classificationCase: db.classificationCase,
      classificationCaseInvalidation: db.classificationCaseInvalidation,
      qboMutationAttempt: db.qboMutationAttempt,
      transaction: db.transaction,
      vendorIdentity: db.vendorIdentity,
      $transaction: async (callback: (tx: ClassificationCaseDb) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          const classificationCase = delegate === 'classificationCase'
            ? new Proxy(tx.classificationCase, {
                get(target, property, receiver) {
                  if (property !== 'create') return Reflect.get(target, property, receiver);
                  return async (args: Parameters<typeof tx.classificationCase.create>[0]) => {
                    await waitForBoth();
                    return tx.classificationCase.create(args);
                  };
                },
              })
            : tx.classificationCase;
          const classificationCaseInvalidation = delegate === 'classificationCaseInvalidation'
            ? new Proxy(tx.classificationCaseInvalidation, {
                get(target, property, receiver) {
                  if (property !== 'create') return Reflect.get(target, property, receiver);
                  return async (args: Parameters<typeof tx.classificationCaseInvalidation.create>[0]) => {
                    await waitForBoth();
                    return tx.classificationCaseInvalidation.create(args);
                  };
                },
              })
            : tx.classificationCaseInvalidation;
          return callback({
            classificationCase,
            classificationCaseInvalidation,
            qboMutationAttempt: tx.qboMutationAttempt,
            transaction: tx.transaction,
            vendorIdentity: tx.vendorIdentity,
          });
        }),
    } as ClassificationCaseDb;
  }

  it('records an allow-listed bounded snapshot and replays by QBO request id', async () => {
    const value = await fixture();
    const first = await recordVerifiedClassificationCase(value.input, db);
    const replay = await recordVerifiedClassificationCase({
      ...value.input,
      qboMutationAttemptId: undefined,
      requestId: value.attempt.requestId,
    }, db);
    expect(replay.id).toBe(first.id);
    await expect(db.classificationCase.count({
      where: { qboMutationAttemptId: value.attempt.id },
    })).resolves.toBe(1);
    expect(first.action).toEqual(ACTION);
    expect(await getClassificationCaseByRequestId(
      value.company.id,
      value.attempt.requestId,
      db,
    )).toMatchObject({ id: first.id, qboMutationAttemptId: value.attempt.id });
    const stored = await db.classificationCase.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.transactionSnapshot).toMatchObject({
      transactionId: value.transaction.id,
      amountCents: -1234,
      payee: 'Synthetic   Vendor',
    });
    expect(JSON.stringify(stored.transactionSnapshot)).not.toContain('privateProviderPayload');
    expect(JSON.stringify(stored.transactionSnapshot)).not.toContain('privateRequest');
    expect(JSON.stringify(stored.transactionSnapshot)).not.toContain('privateResponse');
  });

  it('returns the winning case and invalidation when two PostgreSQL transactions race', async () => {
    const value = await fixture();
    const caseRaceDb = racingDb('classificationCase');
    const [first, second] = await Promise.all([
      recordVerifiedClassificationCase(value.input, caseRaceDb),
      recordVerifiedClassificationCase(value.input, caseRaceDb),
    ]);
    expect(second.id).toBe(first.id);
    await expect(db.classificationCase.count({
      where: { companyId: value.company.id, qboMutationAttemptId: value.attempt.id },
    })).resolves.toBe(1);

    const invalidationRaceDb = racingDb('classificationCaseInvalidation');
    const invalidatedAt = new Date('2026-08-31T00:00:00.000Z');
    const [invalidatedFirst, invalidatedSecond] = await Promise.all([
      invalidateClassificationCase(
        value.company.id,
        first.id,
        'Synthetic concurrent correction',
        invalidationRaceDb,
        invalidatedAt,
      ),
      invalidateClassificationCase(
        value.company.id,
        first.id,
        'Synthetic concurrent correction',
        invalidationRaceDb,
        invalidatedAt,
      ),
    ]);
    expect(invalidatedSecond).toEqual(invalidatedFirst);
    await expect(db.classificationCaseInvalidation.count({
      where: { companyId: value.company.id, classificationCaseId: first.id },
    })).resolves.toBe(1);
  });

  it('requires a verified attempt and rejects a vendor identity from another company', async () => {
    const value = await fixture();
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: { status: 'PENDING' },
    });
    await expect(recordVerifiedClassificationCase(value.input, db)).rejects.toMatchObject({
      code: 'NOT_VERIFIED',
    });
    await db.qboMutationAttempt.update({
      where: { id: value.attempt.id },
      data: { status: 'VERIFIED' },
    });
    const other = await db.company.create({
      data: {
        realmId: `classification-other-${randomUUID()}`,
        legalName: 'Synthetic Other Company',
        nickname: 'Synthetic Other',
      },
    });
    companyIds.add(other.id);
    const foreign = await db.vendorIdentity.create({
      data: {
        companyId: other.id,
        displayName: 'Foreign Vendor',
        normalizedName: 'foreign vendor',
      },
    });
    await expect(recordVerifiedClassificationCase({
      ...value.input,
      vendorIdentityId: foreign.id,
    }, db)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not reveal the state of a QBO attempt owned by another company', async () => {
    const local = await fixture();
    const foreign = await fixture();
    await db.qboMutationAttempt.update({
      where: { id: foreign.attempt.id },
      data: { status: 'PENDING' },
    });

    await expect(recordVerifiedClassificationCase({
      ...foreign.input,
      companyId: local.company.id,
    }, db)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(recordVerifiedClassificationCase({
      ...foreign.input,
      companyId: local.company.id,
      qboMutationAttemptId: undefined,
      requestId: foreign.attempt.requestId,
    }, db)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('blocks direct case mutation and records invalidation as a separate append-only event', async () => {
    const value = await fixture();
    const created = await recordVerifiedClassificationCase(value.input, db);
    await expect(db.classificationCase.update({
      where: { id: created.id },
      data: { rationale: 'attempted rewrite' },
    })).rejects.toThrow(/append-only/u);
    await expect(db.classificationCase.delete({ where: { id: created.id } }))
      .rejects.toThrow(/append-only/u);

    const correctionAttempt = await db.qboMutationAttempt.create({
      data: {
        transactionId: value.transaction.id,
        requestId: `request-${randomUUID()}`,
        operation: 'recategorize',
        status: 'VERIFIED',
        expectedRevision: value.transaction.revision,
        expectedSyncToken: value.transaction.qboSyncToken,
        requestHash: 'synthetic-correction-hash',
        requestPayload: {},
        beforeSnapshot: {},
        verification: { outcome: 'VERIFIED', status: 'POSTED' },
      },
    });
    const corrected = await recordVerifiedClassificationCase({
      ...value.input,
      qboMutationAttemptId: correctionAttempt.id,
      action: { ...ACTION, categoryQboId: 'category-corrected' },
      rationale: 'Synthetic corrected decision.',
      provenance: {
        ...value.input.provenance,
        sourceId: correctionAttempt.id,
        recordedAt: correctionAttempt.updatedAt.toISOString(),
      },
    }, db);
    expect(corrected.id).not.toBe(created.id);

    const invalidated = await invalidateClassificationCase(
      value.company.id,
      created.id,
      'Synthetic correction',
      db,
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(invalidated).toMatchObject({
      id: created.id,
      invalidatedAt: '2026-08-31T00:00:00.000Z',
      invalidationReason: 'Synthetic correction',
    });
    await expect(db.classificationCase.count({
      where: { companyId: value.company.id, transactionId: value.transaction.id },
    })).resolves.toBe(2);
    const event = await db.classificationCaseInvalidation.findUniqueOrThrow({
      where: { companyId_classificationCaseId: { companyId: value.company.id, classificationCaseId: created.id } },
    });
    await expect(db.classificationCaseInvalidation.update({
      where: { id: event.id },
      data: { reason: 'attempted rewrite' },
    })).rejects.toThrow(/append-only/u);
  });

  it('enforces tenant scope for aliases, merge audits, rule revisions, and candidate evidence', async () => {
    const local = await fixture();
    const foreign = await fixture();
    const localCase = await recordVerifiedClassificationCase(local.input, db);
    const foreignCase = await recordVerifiedClassificationCase(foreign.input, db);

    await db.vendorAlias.create({
      data: {
        companyId: local.company.id,
        vendorIdentityId: local.identity.id,
        value: 'Shared synthetic alias',
        normalizedValue: 'shared synthetic alias',
        source: 'user',
      },
    });
    await expect(db.vendorAlias.create({
      data: {
        companyId: local.company.id,
        vendorIdentityId: foreign.identity.id,
        value: 'Foreign synthetic alias',
        normalizedValue: 'foreign synthetic alias',
        source: 'user',
      },
    })).rejects.toThrow();
    await expect(db.vendorAlias.create({
      data: {
        companyId: foreign.company.id,
        vendorIdentityId: foreign.identity.id,
        value: 'Shared synthetic alias',
        normalizedValue: 'shared synthetic alias',
        source: 'user',
      },
    })).resolves.toMatchObject({ companyId: foreign.company.id });

    await expect(db.vendorIdentityMerge.create({
      data: {
        companyId: local.company.id,
        sourceVendorIdentityId: local.identity.id,
        targetVendorIdentityId: foreign.identity.id,
        mergedBy: 'reviewer-synthetic',
        reason: 'Synthetic cross-tenant attempt.',
      },
    })).rejects.toThrow();
    const localTarget = await db.vendorIdentity.create({
      data: {
        companyId: local.company.id,
        displayName: 'Synthetic canonical vendor',
        normalizedName: 'synthetic canonical vendor',
      },
    });
    const merge = await db.vendorIdentityMerge.create({
      data: {
        companyId: local.company.id,
        sourceVendorIdentityId: local.identity.id,
        targetVendorIdentityId: localTarget.id,
        mergedBy: 'reviewer-synthetic',
        reason: 'Reviewed synthetic duplicate records.',
      },
    });
    await expect(db.vendorIdentityMerge.update({
      where: { id: merge.id },
      data: { reason: 'Attempted rewrite.' },
    })).rejects.toThrow(/append-only/u);

    const localCandidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: local.company.id,
        conditionFingerprint: `condition-${randomUUID()}`,
        schemaVersion: 'rule-candidate-v1',
        configVersion: 'synthetic-config',
        matchText: 'synthetic vendor',
      },
    });
    const foreignCandidate = await db.autopilotRuleCandidate.create({
      data: {
        companyId: foreign.company.id,
        conditionFingerprint: `condition-${randomUUID()}`,
        schemaVersion: 'rule-candidate-v1',
        configVersion: 'synthetic-config',
        matchText: 'synthetic vendor',
      },
    });
    await expect(db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: local.company.id,
        candidateId: localCandidate.id,
        transactionId: local.transaction.id,
        inputRevision: local.transaction.revision,
        requestId: `evidence-${randomUUID()}`,
        source: 'user',
        actionFingerprint: 'a'.repeat(64),
        pattern: {},
      },
    })).resolves.toMatchObject({
      companyId: local.company.id,
      candidateId: localCandidate.id,
      transactionId: local.transaction.id,
    });
    await expect(db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: local.company.id,
        candidateId: localCandidate.id,
        transactionId: foreign.transaction.id,
        inputRevision: foreign.transaction.revision,
        requestId: `evidence-${randomUUID()}`,
        source: 'user',
        actionFingerprint: 'b'.repeat(64),
        pattern: {},
      },
    })).rejects.toThrow();
    await expect(db.autopilotRuleCandidateEvidence.create({
      data: {
        companyId: local.company.id,
        candidateId: foreignCandidate.id,
        transactionId: local.transaction.id,
        inputRevision: local.transaction.revision,
        requestId: `evidence-${randomUUID()}`,
        source: 'user',
        actionFingerprint: 'c'.repeat(64),
        pattern: {},
      },
    })).rejects.toThrow();

    const rule = await db.rule.create({
      data: {
        companyId: local.company.id,
        matchText: 'Synthetic Vendor',
        category: 'Synthetic expense',
        categoryQboId: 'category-synthetic',
        priority: 0,
        autoPost: false,
      },
    });
    const revisionData = {
      ruleId: rule.id,
      companyId: local.company.id,
      revision: 1,
      state: 'enabled',
      matchField: 'payee',
      matchText: rule.matchText,
      category: rule.category,
      categoryQboId: rule.categoryQboId,
      tagIds: [],
      priority: rule.priority,
      autoPost: rule.autoPost,
    };
    const revision = await db.ruleRevision.create({
      data: {
        ...revisionData,
        sourceCaseId: localCase.id,
        sourceCandidateId: localCandidate.id,
      },
    });
    await expect(db.ruleRevision.create({
      data: { ...revisionData, revision: 2, sourceCaseId: foreignCase.id },
    })).rejects.toThrow();
    await expect(db.ruleRevision.create({
      data: { ...revisionData, revision: 3, sourceCandidateId: foreignCandidate.id },
    })).rejects.toThrow();
    await expect(db.ruleRevision.update({
      where: { id: revision.id },
      data: { state: 'disabled' },
    })).rejects.toThrow(/append-only/u);
  });

  it('keeps the pre-memory rule insert shape valid during a rolling migration', async () => {
    const company = await db.company.create({
      data: {
        realmId: `classification-legacy-writer-${randomUUID()}`,
        legalName: 'Synthetic Legacy Writer Company',
        nickname: 'Synthetic Legacy Writer',
      },
    });
    companyIds.add(company.id);
    const ruleId = `legacy-writer-rule-${randomUUID()}`;
    const tag = await db.tag.create({
      data: {
        companyId: company.id,
        name: 'Synthetic legacy tag',
        color: '#123456',
      },
    });

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Rule" (
          "id", "companyId", "priority", "matchField", "matchText",
          "category", "autoPost", "createdAt"
        ) VALUES (
          ${ruleId}, ${company.id}, 0, 'payee', 'Synthetic Legacy Vendor',
          'Synthetic expense', false, CURRENT_TIMESTAMP
        )
      `;
      await tx.ruleTag.create({ data: { ruleId, tagId: tag.id } });
    });
    await expect(db.rule.findUniqueOrThrow({ where: { id: ruleId } }))
      .resolves.toMatchObject({ enabled: true, revision: 0 });
    await expect(db.ruleRevision.findMany({
      where: { companyId: company.id, ruleId },
    })).resolves.toEqual([
      expect.objectContaining({
        revision: 0,
        state: 'enabled',
        autoPost: false,
        tagIds: [tag.id],
      }),
    ]);
  });

  it('allows immutable memory to leave only through a whole-company cascade', async () => {
    const value = await fixture();
    const created = await recordVerifiedClassificationCase(value.input, db);
    await invalidateClassificationCase(value.company.id, created.id, 'Synthetic tenant erasure', db);
    const rule = await db.rule.create({
      data: {
        companyId: value.company.id,
        matchText: 'Synthetic Vendor',
        category: 'Synthetic expense',
        priority: 0,
      },
    });
    await db.ruleRevision.create({
      data: {
        ruleId: rule.id,
        companyId: value.company.id,
        revision: 1,
        state: 'enabled',
        matchText: rule.matchText,
        category: rule.category,
        tagIds: [],
        priority: rule.priority,
        autoPost: rule.autoPost,
      },
    });

    await expect(db.rule.delete({ where: { id: rule.id } }))
      .rejects.toThrow(/retired or retained/u);
    await expect(db.company.delete({ where: { id: value.company.id } }))
      .resolves.toMatchObject({ id: value.company.id });
    companyIds.delete(value.company.id);
    await expect(db.classificationCase.count({ where: { companyId: value.company.id } }))
      .resolves.toBe(0);
    await expect(db.ruleRevision.count({ where: { companyId: value.company.id } }))
      .resolves.toBe(0);
  });
});
