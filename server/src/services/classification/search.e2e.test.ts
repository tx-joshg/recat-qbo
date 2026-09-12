import { readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyReadService } from '../companyReads.js';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from '../agent/evaluation.js';
import { recordVerifiedRuleCandidateOutcome } from '../agent/ruleCandidatePersistence.js';
import { candidateContextFor } from '../agent/ruleCandidates.js';
import {
  commitRuleChange,
  prepareRuleChange,
  type RuleChangePrincipal,
} from '../ruleChanges.js';
import {
  ClassificationSearchError,
  PrismaClassificationSearchRepository,
  searchClassificationMemory,
} from './search.js';
import { createVoyageEmbeddingClient } from './embedding/client.js';
import { classificationEmbeddingGeneration } from './embedding/recipe.js';
import { reconcileClassificationEmbeddings } from './embedding/reconciler.js';
import { PgClassificationVectorStore } from './embedding/vectorStore.js';
import { qboFactory } from '../../lib/qbo/factory.js';
import { RealQboClient } from '../../lib/qbo/real.js';
import {
  startDeterministicEmbeddingFixture,
  type AccountingTopic,
  type DeterministicEmbeddingFixture,
} from '../../test/deterministicEmbeddingFixture.js';
import {
  installClassificationSearchIsolation,
  type ClassificationSearchIsolation,
} from '../../test/classificationSearchIsolation.js';
import {
  createDisposablePgvectorDatabase,
  resetDisposablePgvectorDatabase,
  type DisposablePgvectorDatabase,
} from '../../test/disposablePgvectorDatabase.js';

describe('classification memory deterministic end-to-end fixture', () => {
  const fixtures: DeterministicEmbeddingFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  it('maps fixed accounting topics to stable literal unit vectors', async () => {
    const fixture = await startDeterministicEmbeddingFixture('a');
    fixtures.push(fixture);
    const client = createVoyageEmbeddingClient({
        fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, 'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0' } }),
      apiKey: 'synthetic-local-only',
      baseUrl: fixture.baseUrl,
      batchSize: 8,
      timeoutMs: 2_000,
    });

    const vectors = await client.embedDocuments([
      'Fleet propellant expenditure',
      'Owner gift-card reimbursement',
      'Wholesale stock for resale goods',
      'Team lunch at a restaurant',
    ]);

    expect(vectors.map((vector) => vector.findIndex((component) => component === 1)))
      .toEqual([0, 1, 2, 3]);
    expect(vectors.every((vector) => vector.reduce((sum, value) => sum + value * value, 0) === 1))
      .toBe(true);
    expect(fixture.requests).toEqual([{
      method: 'POST',
      path: '/v1/embeddings',
      inputType: 'document',
      inputs: [
        'Fleet propellant expenditure',
        'Owner gift-card reimbursement',
        'Wholesale stock for resale goods',
        'Team lunch at a restaurant',
      ],
      topics: ['fuel', 'personal', 'inventory', 'meals'],
    }]);
  });
});

const CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL = process.env.TEST_PGVECTOR_DATABASE_URL;
const describeClassificationSearchTest = CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL ? describe.sequential : describe.skip;
let classificationSearchTestDatabaseUrl: string | null = null;
const NOW = new Date('2026-09-01T12:00:00.000Z');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordedTopic(
  fixture: DeterministicEmbeddingFixture,
  input: string,
): AccountingTopic | undefined {
  for (const request of fixture.requests) {
    const index = request.inputs.indexOf(input);
    if (index >= 0) return request.topics[index];
  }
  return undefined;
}

function newClient(): PrismaClient {
  if (classificationSearchTestDatabaseUrl === null) throw new Error('Classification search test disposable database is unavailable.');
  return new PrismaClient({ datasources: { db: { url: classificationSearchTestDatabaseUrl } } });
}

async function createVerifiedCase(
  db: PrismaClient,
  input: {
    companyId: string;
    transactionId: string;
    vendorIdentityId: string;
    categoryQboId: string;
    rationale: string;
    examples: string[];
    counterexamples: string[];
    jurisdiction?: string;
  },
) {
  const transaction = await db.transaction.findUniqueOrThrow({ where: { id: input.transactionId } });
  const requestId = `classification-search-test-${randomUUID()}`;
  const attempt = await db.qboMutationAttempt.create({
    data: {
      transactionId: transaction.id,
      requestId,
      operation: 'recategorize',
      status: 'VERIFIED',
      expectedRevision: transaction.revision,
      expectedSyncToken: transaction.qboSyncToken,
      requestHash: digest(requestId),
      requestPayload: {},
      beforeSnapshot: {},
      verification: { outcome: 'VERIFIED', status: 'POSTED' },
    },
  });
  const action = {
    categoryQboId: input.categoryQboId,
    taxCalculation: 'NotApplicable',
    taxCodeQboId: null,
    tagIds: [],
  } as const;
  return db.classificationCase.create({
    data: {
      companyId: input.companyId,
      transactionId: transaction.id,
      vendorIdentityId: input.vendorIdentityId,
      qboMutationAttemptId: attempt.id,
      action,
      actionFingerprint: digest(JSON.stringify(action)),
      originIntent: 'apply_once',
      rationale: input.rationale,
      requiredEvidence: ['Synthetic receipt and fleet purpose'],
      examples: input.examples,
      counterexamples: input.counterexamples,
      citations: [],
      reviewer: { userId: null, configVersion: 'classification-search-test-e2e-v1', decision: 'approved' },
      jurisdiction: input.jurisdiction ?? 'CA-BC',
      currency: 'CAD',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic operating card',
        businessPurpose: input.rationale,
      },
      provenance: {
        source: 'qbo_verified',
        sourceId: requestId,
        actorId: null,
        recordedAt: NOW.toISOString(),
      },
      transactionSnapshot: {
        schemaVersion: 'classification-case/v1',
        transactionId: transaction.id,
        transactionRevision: transaction.revision,
        qboType: transaction.qboType,
        qboId: transaction.qboId,
        date: transaction.date.toISOString(),
        amountCents: Number(transaction.amount) * 100,
        currency: 'CAD',
        payee: transaction.payee,
        memo: transaction.memo,
        sourceAccountName: transaction.bankAccount,
      },
      verifiedAt: NOW,
    },
  });
}

async function seedSearchCompany(db: PrismaClient, nickname = 'Classification search test Current') {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `classification-search-test-${suffix}@example.invalid` } });
  const company = await db.company.create({
    data: {
      realmId: `classification-search-test-${suffix}`,
      legalName: `${nickname} Legal`,
      nickname,
      ruleRuntimeMode: 'canonical',
      taxSupportStatus: 'ready',
      taxUsingSalesTax: true,
    },
  });
  await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
  const session = await db.session.create({
    data: {
      userId: user.id,
      tokenHash: digest(`session-${suffix}`),
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    },
  });
  const [fuelAccount, personalAccount] = await Promise.all([
    db.qboAccount.create({ data: {
      companyId: company.id, qboId: `fuel-${suffix}`, name: 'Fleet fuel',
      fullName: 'Expenses · Fleet fuel', classification: 'Expenses',
    } }),
    db.qboAccount.create({ data: {
      companyId: company.id, qboId: `personal-${suffix}`, name: 'Owner reimbursement',
      fullName: 'Expenses · Owner reimbursement', classification: 'Expenses',
    } }),
  ]);
  const vendor = await db.vendorIdentity.create({
    data: {
      companyId: company.id,
      displayName: 'ExampleFuel Mobility',
      normalizedName: 'examplefuel mobility',
    },
  });
  const alias = await db.vendorAlias.create({
    data: {
      companyId: company.id,
      vendorIdentityId: vendor.id,
      value: 'EXAMPLEFUEL 00001 EXAMPLETOWN',
      normalizedValue: 'examplefuel 00001 exampletown',
      source: 'user',
    },
  });
  const transactions = await Promise.all([
    db.transaction.create({ data: {
      companyId: company.id, qboId: `fuel-txn-${suffix}`, qboType: 'Purchase',
      qboSyncToken: '1', date: new Date('2026-08-20T00:00:00.000Z'),
      payee: 'ExampleFuel Fleet Pump', memo: 'Fleet propellant expenditure', amount: '-88.00',
      bankAccount: 'Synthetic operating card', status: 'POSTED', revision: 1,
    } }),
    db.transaction.create({ data: {
      companyId: company.id, qboId: `personal-txn-${suffix}`, qboType: 'Purchase',
      qboSyncToken: '1', date: new Date('2026-08-21T00:00:00.000Z'),
      payee: 'ExampleFuel Convenience Counter', memo: 'Owner gift-card reimbursement', amount: '-25.00',
      bankAccount: 'Synthetic operating card', status: 'POSTED', revision: 1,
    } }),
  ]);
  const fuelCase = await createVerifiedCase(db, {
    companyId: company.id,
    transactionId: transactions[0].id,
    vendorIdentityId: vendor.id,
    categoryQboId: fuelAccount.qboId,
    rationale: 'Fleet propellant expenditure supported by a pump receipt and business mileage.',
    examples: ['Work-truck motor fuel purchase'],
    counterexamples: ['Store merchandise without a pump receipt'],
  });
  const personalCase = await createVerifiedCase(db, {
    companyId: company.id,
    transactionId: transactions[1].id,
    vendorIdentityId: vendor.id,
    categoryQboId: personalAccount.qboId,
    rationale: 'Owner gift-card reimbursement was not a fleet expense.',
    examples: ['Personal convenience purchase'],
    counterexamples: ['Fleet propellant purchase with mileage evidence'],
  });
  const candidate = await db.autopilotRuleCandidate.create({
    data: {
      companyId: company.id,
      conditionFingerprint: digest(`candidate-${suffix}`),
      schemaVersion: 'classification-rule-v2',
      configVersion: 'classification-search-test-e2e-v1',
      matchText: 'ExampleFuel',
      state: 'conflict',
      winningActionFingerprint: fuelCase.actionFingerprint,
      categoryQboId: fuelAccount.qboId,
      taxCalculation: 'NotApplicable',
      tagIds: [],
      evidenceCount: 1,
      conflictingEvidenceCount: 1,
    },
  });
  await Promise.all([
    db.autopilotRuleCandidateEvidence.create({ data: {
      companyId: company.id, candidateId: candidate.id, transactionId: transactions[0].id,
      inputRevision: 1, requestId: `candidate-positive-${suffix}`, source: 'verified_outcome',
      polarity: 'positive', actionFingerprint: fuelCase.actionFingerprint,
      pattern: { payee: 'ExampleFuel', topic: 'fleet propellant' }, observedAt: NOW,
    } }),
    db.autopilotRuleCandidateEvidence.create({ data: {
      companyId: company.id, candidateId: candidate.id, transactionId: transactions[1].id,
      inputRevision: 1, requestId: `candidate-negative-${suffix}`, source: 'verified_outcome',
      polarity: 'negative', actionFingerprint: personalCase.actionFingerprint,
      pattern: { payee: 'ExampleFuel', topic: 'owner gift card' }, observedAt: NOW,
    } }),
  ]);
  const principal: RuleChangePrincipal = {
    kind: 'session', sessionId: session.id, userId: user.id,
  };
  return {
    user, company, session, principal, fuelAccount, personalAccount, vendor, alias,
    transactions, fuelCase, personalCase, candidate,
  };
}

async function seedForeignExampleFuel(db: PrismaClient, userId: string) {
  const suffix = randomUUID();
  const company = await db.company.create({
    data: {
      realmId: `classification-search-test-foreign-${suffix}`, legalName: 'Classification search test Foreign Legal',
      nickname: 'Classification search test Foreign', taxSupportStatus: 'ready', taxUsingSalesTax: true,
    },
  });
  await db.membership.create({ data: { userId, companyId: company.id, role: 'viewer' } });
  const account = await db.qboAccount.create({ data: {
    companyId: company.id, qboId: `foreign-fuel-${suffix}`, name: 'Foreign fleet fuel',
    fullName: 'Expenses · Foreign fleet fuel', classification: 'Expenses',
  } });
  const vendor = await db.vendorIdentity.create({ data: {
    companyId: company.id, displayName: 'ExampleFuel Foreign Fleet', normalizedName: 'examplefuel foreign fleet',
  } });
  await db.vendorAlias.create({ data: {
    companyId: company.id, vendorIdentityId: vendor.id,
    value: 'EXAMPLEFUEL FOREIGN 900', normalizedValue: 'examplefuel foreign 900', source: 'user',
  } });
  const transaction = await db.transaction.create({ data: {
    companyId: company.id, qboId: `foreign-txn-${suffix}`, qboType: 'Purchase', qboSyncToken: '1',
    date: NOW, payee: 'ExampleFuel Foreign Pump', memo: 'Fleet propellant expenditure',
    amount: '-50.00', bankAccount: 'Foreign card', status: 'POSTED', revision: 1,
  } });
  const classificationCase = await createVerifiedCase(db, {
    companyId: company.id, transactionId: transaction.id, vendorIdentityId: vendor.id,
    categoryQboId: account.qboId, rationale: 'Foreign fleet propellant expenditure.',
    examples: ['Foreign work-truck motor fuel'], counterexamples: [],
  });
  return { company, account, vendor, transaction, classificationCase };
}

async function seedReadyCandidate(
  db: PrismaClient,
  seeded: Awaited<ReturnType<typeof seedSearchCompany>>,
  options: { pendingReconciliation?: boolean } = {},
) {
  if (options.pendingReconciliation === true) {
    const suffix = randomUUID();
    const payee = `ExampleFuel Repair ${suffix.slice(0, 8)}`;
    const context = candidateContextFor(payee, 'verified-writeback-v1', 'mcp');
    if (context === null) throw new Error('Classification search test reconciliation candidate context is invalid.');
    const proposal: VerifiedCategorizationProposal = {
      taxCalculation: 'NotApplicable',
      lines: [{
        idx: 0, subtotalCents: -4500, taxCents: 0, totalCents: -4500,
        categoryQboId: seeded.fuelAccount.qboId, taxCodeQboId: null,
        memo: null, tagIds: [],
      }],
      tagIds: [],
    };
    const transactions = [];
    for (const index of [0, 1, 2, 3]) {
      const transaction = await db.transaction.create({ data: {
        companyId: seeded.company.id,
        qboId: `repair-candidate-${index}-${suffix}`,
        qboType: 'Purchase', qboSyncToken: '1', date: NOW,
        payee, memo: 'Fleet propellant expenditure', amount: '-45.00',
        bankAccount: 'Synthetic operating card', status: 'POSTED', revision: 1,
      } });
      const requestId = `repair-evidence-${index}-${suffix}`;
      const requestPayload = {
        ruleCandidateFold: { version: 1 },
        categorizationEvidence: { version: 1, proposal },
        ruleCandidateEvidence: { version: 1, ...context },
      } satisfies Prisma.InputJsonObject;
      await db.qboMutationAttempt.create({ data: {
        transactionId: transaction.id, requestId, operation: 'recategorize', status: 'VERIFIED',
        expectedRevision: 1, expectedSyncToken: '1', requestHash: digest(requestId),
        requestPayload, beforeSnapshot: {}, verification: { outcome: 'VERIFIED' },
      } });
      if (index < 3) {
        const outcome: VerifiedCategorizationOutcome = {
          companyId: seeded.company.id, transactionId: transaction.id,
          inputRevision: 1, requestId, operation: 'posted', proposal, candidateContext: context,
        };
        await recordVerifiedRuleCandidateOutcome(outcome, { db, now: () => NOW });
      }
      transactions.push(transaction);
    }
    const candidate = await db.autopilotRuleCandidate.findFirstOrThrow({
      where: {
        companyId: seeded.company.id,
        conditionFingerprint: context.conditionFingerprint,
        configVersion: context.configVersion,
      },
    });
    return { candidate, transactions };
  }
  const suffix = randomUUID();
  const candidate = await db.autopilotRuleCandidate.create({
    data: {
      companyId: seeded.company.id,
      conditionFingerprint: digest(`ready-candidate-${suffix}`),
      schemaVersion: 'classification-rule-v2',
      configVersion: 'verified-writeback-v1',
      matchText: `ExampleFuel Ready ${suffix.slice(0, 8)}`,
      state: 'ready',
      winningActionFingerprint: seeded.fuelCase.actionFingerprint,
      categoryQboId: seeded.fuelAccount.qboId,
      taxCalculation: 'NotApplicable',
      tagIds: [],
      evidenceCount: 3,
      conflictingEvidenceCount: 0,
    },
  });
  const transactions = [];
  for (const index of [0, 1, 2]) {
    const transaction = await db.transaction.create({ data: {
      companyId: seeded.company.id,
      qboId: `ready-candidate-${index}-${suffix}`,
      qboType: 'Purchase', qboSyncToken: '1', date: NOW,
      payee: candidate.matchText, memo: 'Fleet propellant expenditure',
      amount: '-45.00', bankAccount: 'Synthetic operating card',
      status: 'POSTED', revision: 1,
    } });
    const requestId = `ready-evidence-${index}-${suffix}`;
    await db.qboMutationAttempt.create({ data: {
      transactionId: transaction.id, requestId, operation: 'recategorize', status: 'VERIFIED',
      expectedRevision: 1, expectedSyncToken: '1', requestHash: digest(requestId),
      requestPayload: {}, beforeSnapshot: {}, verification: { outcome: 'VERIFIED' },
    } });
    await db.autopilotRuleCandidateEvidence.create({ data: {
      companyId: seeded.company.id, candidateId: candidate.id, transactionId: transaction.id,
      inputRevision: 1, requestId, source: 'verified_outcome', polarity: 'positive',
      actionFingerprint: seeded.fuelCase.actionFingerprint,
      pattern: { payee: candidate.matchText, topic: 'fleet propellant' }, observedAt: NOW,
    } });
    await db.autopilotRuleCandidateFold.create({ data: {
      requestId, companyId: seeded.company.id, transactionId: transaction.id,
      operation: 'recategorize', processedAt: NOW,
    } });
    transactions.push(transaction);
  }
  return { candidate, transactions };
}

function createRuleInput(
  seeded: Awaited<ReturnType<typeof seedSearchCompany>>,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    companyId: seeded.company.id,
    mutation: 'create' as const,
    expectedRevision: 0,
    idempotencyKey,
    proposal: {
      matchText: `ExampleFuel ${idempotencyKey.slice(-8)}`,
      categoryQboId: seeded.fuelAccount.qboId,
      taxCalculation: 'NotApplicable' as const,
      taxCodeQboId: null,
      tagIds: [] as string[],
      direction: 'Purchase' as const,
      autoPost: false as const,
      sourceCaseId: seeded.fuelCase.id,
      ...overrides,
    },
  };
}

async function publishEmbeddings(
  db: PrismaClient,
  companyId: string,
  fixture: DeterministicEmbeddingFixture,
  salt: string,
) {
  const repository = new PrismaClassificationSearchRepository(db);
  const store = new PgClassificationVectorStore(db);
  const generation = classificationEmbeddingGeneration({ baseUrl: fixture.baseUrl, fingerprintSalt: salt });
  await expect(store.ensureAvailable()).resolves.toEqual({ available: true, reason: null });
  const attempt = await store.beginAttempt({ companyId, fingerprint: generation.fingerprint });
  const corpus = await repository.documents(companyId, attempt.targetRevision);
  const result = await reconcileClassificationEmbeddings({
    companyId,
    documents: corpus.documents,
    totalDocuments: corpus.totalDocuments,
    skippedDocuments: corpus.skippedDocuments,
    generation,
    client: createVoyageEmbeddingClient({
        fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, 'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0' } }),
      apiKey: 'synthetic-local-only', baseUrl: fixture.baseUrl, batchSize: 32, timeoutMs: 2_000,
    }),
    store,
    targetRevision: attempt.targetRevision,
    attemptToken: attempt.token,
  });
  expect(result).toMatchObject({ status: 'published', backlog: 0, error: null });
  return { repository, store, generation, corpus };
}

function semanticDependencies(
  db: PrismaClient,
  fixture: DeterministicEmbeddingFixture,
  salt: string,
) {
  const generation = classificationEmbeddingGeneration({ baseUrl: fixture.baseUrl, fingerprintSalt: salt });
  return {
    repository: new PrismaClassificationSearchRepository(db),
    semantic: {
      generation,
      client: createVoyageEmbeddingClient({
        fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, 'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0' } }),
        apiKey: 'synthetic-local-only', baseUrl: fixture.baseUrl, batchSize: 32, timeoutMs: 500,
      }),
      store: new PgClassificationVectorStore(db),
    },
  };
}

interface FaultBoundary {
  model: string;
  method: string;
  occurrence?: number;
}

function faultInjectedClient(db: PrismaClient, boundary: FaultBoundary): PrismaClient {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (callback: (transaction: unknown) => unknown, options?: unknown) => (
          (target.$transaction as unknown as (
            work: (transaction: unknown) => unknown,
            options?: unknown,
          ) => Promise<unknown>)(async (transaction) => {
            let calls = 0;
            const faultedTransaction = new Proxy(transaction as object, {
              get(transactionTarget, modelProperty, transactionReceiver) {
                const model = Reflect.get(transactionTarget, modelProperty, transactionReceiver) as unknown;
                if (modelProperty !== boundary.model || model === null || typeof model !== 'object') {
                  return typeof model === 'function'
                    ? model.bind(transactionTarget)
                    : model;
                }
                return new Proxy(model, {
                  get(modelTarget, methodProperty, modelReceiver) {
                    const method = Reflect.get(modelTarget, methodProperty, modelReceiver) as unknown;
                    if (methodProperty !== boundary.method || typeof method !== 'function') {
                      return typeof method === 'function' ? method.bind(modelTarget) : method;
                    }
                    return async (...arguments_: unknown[]) => {
                      const result = await method.apply(modelTarget, arguments_);
                      calls += 1;
                      if (calls === (boundary.occurrence ?? 1)) {
                        throw new Error(`classification-search-test-simulated-crash:${boundary.model}.${boundary.method}`);
                      }
                      return result;
                    };
                  },
                });
              },
            });
            return callback(faultedTransaction);
          }, options)
        );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

function crashBeforeTransaction(db: PrismaClient, occurrence: number): PrismaClient {
  let calls = 0;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (...arguments_: unknown[]) => {
          calls += 1;
          if (calls === occurrence) {
            throw new Error(`classification-search-test-simulated-crash:$transaction.${occurrence}`);
          }
          return (target.$transaction as unknown as (...args: unknown[]) => Promise<unknown>)(
            ...arguments_,
          );
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

async function durablePolicySnapshot(db: PrismaClient, companyId: string, operationId: string) {
  const [rules, revisions, audits, candidates, evidence, receipt] = await Promise.all([
    db.rule.findMany({
      where: { companyId },
      select: {
        id: true, priority: true, revision: true, enabled: true, retiredAt: true,
        sourceCandidateId: true, autoPost: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.ruleRevision.findMany({
      where: { companyId },
      select: {
        id: true, ruleId: true, revision: true, state: true, priority: true,
        sourceCandidateId: true, autoPost: true,
      },
      orderBy: [{ ruleId: 'asc' }, { revision: 'asc' }],
    }),
    db.auditEntry.findMany({
      where: { companyId },
      select: { id: true, action: true, payload: true, at: true },
      orderBy: { id: 'asc' },
    }),
    db.autopilotRuleCandidate.findMany({
      where: { companyId },
      select: {
        id: true, state: true, evidenceCount: true, conflictingEvidenceCount: true,
        dismissedAt: true, dismissedByUserId: true, activatedAt: true,
        activatedByUserId: true, activationEvidenceCount: true,
        activationActionFingerprint: true, activatedRuleId: true, updatedAt: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.autopilotRuleCandidateEvidence.findMany({
      where: { companyId },
      select: {
        id: true, candidateId: true, transactionId: true, active: true, polarity: true,
        actionFingerprint: true, invalidatedAt: true, invalidationReason: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.mcpRuleOperation.findUniqueOrThrow({
      where: { id: operationId },
      select: { id: true, committedAt: true, commitResult: true, commitResultHash: true, updatedAt: true },
    }),
  ]);
  return { rules, revisions, audits, candidates, evidence, receipt };
}

async function activationRecoverySnapshot(
  db: PrismaClient,
  companyId: string,
  candidateId: string,
  operationIds: string[],
  requestIds: string[],
) {
  const [candidate, evidence, folds, attempts, rules, revisions, audits, operations] =
    await Promise.all([
      db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: candidateId },
        select: {
          id: true, state: true, evidenceCount: true, conflictingEvidenceCount: true,
          winningActionFingerprint: true, activatedRuleId: true,
          activationEvidenceCount: true, activationActionFingerprint: true,
        },
      }),
      db.autopilotRuleCandidateEvidence.findMany({
        where: { candidateId },
        select: {
          requestId: true, transactionId: true, polarity: true, actionFingerprint: true,
          active: true, invalidatedAt: true, invalidationReason: true,
        },
        orderBy: { requestId: 'asc' },
      }),
      db.autopilotRuleCandidateFold.findMany({
        where: { companyId, requestId: { in: requestIds } },
        select: { requestId: true, transactionId: true, operation: true },
        orderBy: { requestId: 'asc' },
      }),
      db.qboMutationAttempt.findMany({
        where: { transaction: { companyId }, requestId: { in: requestIds } },
        select: {
          requestId: true, transactionId: true, status: true, operation: true,
          ruleCandidateFoldedAt: true,
        },
        orderBy: { requestId: 'asc' },
      }),
      db.rule.findMany({
        where: { companyId },
        select: {
          id: true, priority: true, revision: true, enabled: true, sourceCandidateId: true,
          autoPost: true,
        },
        orderBy: { id: 'asc' },
      }),
      db.ruleRevision.findMany({
        where: { companyId },
        select: { ruleId: true, revision: true, state: true, sourceCandidateId: true, autoPost: true },
        orderBy: [{ ruleId: 'asc' }, { revision: 'asc' }],
      }),
      db.auditEntry.findMany({
        where: { companyId },
        select: { action: true, payload: true },
        orderBy: { id: 'asc' },
      }),
      db.mcpRuleOperation.findMany({
        where: { id: { in: operationIds } },
        select: {
          id: true, idempotencyKey: true, resourceId: true,
          committedAt: true, commitResult: true, commitResultHash: true,
        },
        orderBy: { id: 'asc' },
      }),
    ]);
  return {
    reconciliation: { candidate, evidence, folds, attempts },
    policy: { rules, revisions, audits, operations },
  };
}

describeClassificationSearchTest('classification memory deterministic PostgreSQL end-to-end', () => {
  const clients: PrismaClient[] = [];
  const fixtures: DeterministicEmbeddingFixture[] = [];
  const safetyGuards: ClassificationSearchIsolation[] = [];
  let disposable: DisposablePgvectorDatabase;

  beforeAll(async () => {
    disposable = await createDisposablePgvectorDatabase(CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL!);
    classificationSearchTestDatabaseUrl = disposable.databaseUrl;
  }, 60_000);

  afterAll(async () => {
    classificationSearchTestDatabaseUrl = null;
    await disposable?.destroy();
  });

  const client = () => {
    const db = newClient();
    clients.push(db);
    return db;
  };

  afterEach(async () => {
    const cleanup = newClient();
    try {
      await resetDisposablePgvectorDatabase(cleanup);
    } finally {
      await Promise.allSettled(clients.splice(0).map((db) => db.$disconnect()));
      await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()));
      safetyGuards.splice(0).forEach((guard) => guard.restore());
      await cleanup.$disconnect();
    }
  }, 60_000);

  it('uses a unique fully migrated pgvector database instead of the configured anchor', async () => {
    const db = client();
    const anchorName = decodeURIComponent(new URL(CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL!).pathname.slice(1));
    const [database, migrations, vector] = await Promise.all([
      db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`,
      db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
      db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM pg_extension WHERE extname = 'vector'`,
    ]);
    expect(database[0]?.name).toBe(disposable.databaseName);
    expect(database[0]?.name).not.toBe(anchorName);
    expect(disposable.databaseName).toMatch(/^recat_search_test_[0-9]+_[0-9a-f]{12}$/u);
    expect(migrations[0]?.count).toBe(BigInt(readdirSync(new URL('../../../../prisma/migrations', import.meta.url), { withFileTypes: true }).filter(entry => entry.isDirectory()).length));
    expect(vector[0]?.count).toBe(1n);
  });

  it('reports a failed disposable database drop and retries until absence is verified', async () => {
    let dropAttempts = 0;
    const retryable = await createDisposablePgvectorDatabase(CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL!, {
      async runMigrations() {},
      async dropDatabase({ defaultDrop }) {
        dropAttempts += 1;
        if (dropAttempts === 1) throw new Error('classification-search-test-simulated-drop-failure');
        await defaultDrop();
      },
    });
    const admin = new PrismaClient({
      datasources: { db: { url: CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL! } },
    });
    const exists = async () => (await admin.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM pg_database WHERE datname = ${retryable.databaseName}
      ) AS present
    `)[0]?.present;
    try {
      await expect(retryable.destroy()).rejects.toThrow('classification-search-test-simulated-drop-failure');
      await expect(exists()).resolves.toBe(true);
      await retryable.destroy();
      expect(dropAttempts).toBe(2);
      await expect(exists()).resolves.toBe(false);
    } finally {
      await retryable.destroy();
      await admin.$disconnect();
    }
  }, 60_000);

  it('reports both initialization and cleanup failures with the exact database target', async () => {
    let leakedDatabaseName: string | null = null;
    let unexpectedlyCreated: DisposablePgvectorDatabase | null = null;
    const admin = new PrismaClient({
      datasources: { db: { url: CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL! } },
    });
    const attempt = createDisposablePgvectorDatabase(CLASSIFICATION_SEARCH_TEST_DATABASE_ANCHOR_URL!, {
      async runMigrations() {
        throw new Error('classification-search-test-simulated-migration-failure');
      },
      async dropDatabase({ databaseName }) {
        leakedDatabaseName = databaseName;
        throw new Error('classification-search-test-simulated-initialization-drop-failure');
      },
    }).then((database) => {
      unexpectedlyCreated = database;
      return database;
    });
    try {
      await expect(attempt).rejects.toSatisfy((error: unknown) => (
        error instanceof AggregateError
        && error.message.includes(leakedDatabaseName ?? 'missing-database-name')
        && error.errors.some((entry) => (
          entry instanceof Error && entry.message === 'classification-search-test-simulated-migration-failure'
        ))
        && error.errors.some((entry) => (
          entry instanceof Error && entry.message === 'classification-search-test-simulated-initialization-drop-failure'
        ))
      ));
      expect(leakedDatabaseName).toMatch(/^recat_search_test_[0-9]+_[0-9a-f]{12}$/u);
    } finally {
      let unexpectedDestroyError: unknown = null;
      if (unexpectedlyCreated !== null) {
        try {
          await unexpectedlyCreated.destroy();
        } catch (error) {
          unexpectedDestroyError = error;
        }
      }
      if (leakedDatabaseName !== null) {
        if (!/^recat_search_test_[0-9]+_[0-9a-f]{12}$/u.test(leakedDatabaseName)) {
          throw new Error('Unsafe Classification search test leaked database name.');
        }
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${leakedDatabaseName}" WITH (FORCE)`);
        const rows = await admin.$queryRaw<Array<{ present: boolean }>>`
          SELECT EXISTS(
            SELECT 1 FROM pg_database WHERE datname = ${leakedDatabaseName}
          ) AS present
        `;
        expect(rows[0]?.present).toBe(false);
      }
      await admin.$disconnect();
      if (unexpectedDestroyError !== null && leakedDatabaseName === null) {
        throw unexpectedDestroyError;
      }
    }
  }, 60_000);

  it('cleans users, sessions, and immutable envelopes from an untracked partial seed', async () => {
    const db = client();
    const seeded = await seedSearchCompany(db, 'Classification search test Untracked Partial Seed');
    const idempotencyKey = `untracked-seed-${randomUUID()}`;
    await prepareRuleChange(
      seeded.principal,
      createRuleInput(seeded, idempotencyKey),
      { db, now: () => NOW },
    );
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(1);
    expect(await db.company.count()).toBe(1);
    expect(await db.mcpRuleOperation.count()).toBe(1);

    await resetDisposablePgvectorDatabase(db);

    expect(await db.user.count()).toBe(0);
    expect(await db.session.count()).toBe(0);
    expect(await db.company.count()).toBe(0);
    expect(await db.mcpRuleOperation.count()).toBe(0);
  }, 60_000);

  it('proves exact, semantic-only, hybrid RRF, re-embed, cutover, tenancy, and endpoint-down degradation', async () => {
    const db = client();
    const current = await seedSearchCompany(db);
    const foreign = await seedForeignExampleFuel(db, current.user.id);
    const nonMember = await seedForeignExampleFuel(db, current.user.id);
    await db.membership.delete({
      where: {
        userId_companyId: { userId: current.user.id, companyId: nonMember.company.id },
      },
    });
    const releaseA = await startDeterministicEmbeddingFixture('a');
    fixtures.push(releaseA);
    const saltA = 'classification-search-test-model-release-a';
    const firstPublication = await publishEmbeddings(db, current.company.id, releaseA, saltA);
    await publishEmbeddings(db, foreign.company.id, releaseA, saltA);
    await publishEmbeddings(db, nonMember.company.id, releaseA, saltA);

    const documentTopic = (documentId: string) => {
      const document = firstPublication.corpus.documents.find(({ id }) => id === documentId);
      if (document === undefined) throw new Error(`Missing Classification search test document ${documentId}`);
      return document.chunks.map(({ text }) => recordedTopic(releaseA, text));
    };
    expect(documentTopic(`classification_case:${current.fuelCase.id}`)).toEqual(['fuel']);
    expect(documentTopic(`classification_case:${current.personalCase.id}`)).toEqual(['personal']);
    expect(documentTopic(`vendor_identity:${current.vendor.id}`)).toEqual(['unknown']);
    expect(documentTopic(`vendor_alias:${current.alias.id}`)).toEqual(['unknown']);

    const exact = await searchClassificationMemory({
      query: current.alias.value, companyId: current.company.id, scope: 'current_company',
      mode: 'exact', accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null });
    expect(exact.hits).toContainEqual(expect.objectContaining({
      id: `vendor_alias:${current.alias.id}`, matchedIn: expect.arrayContaining(['alias']),
    }));

    const semanticOnlyQuery = 'settle a road-trip refuelling stop for the work truck';
    const lexical = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'lexical', accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null });
    expect(lexical.hits.map(({ id }) => id)).not.toContain(`classification_case:${current.fuelCase.id}`);
    const semantic = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    expect(semantic.hits).toContainEqual(expect.objectContaining({
      id: `classification_case:${current.fuelCase.id}`, matchedIn: expect.arrayContaining(['semantic']),
    }));
    expect(semantic.hits.map(({ id }) => id)).not.toContain(
      `classification_case:${current.personalCase.id}`,
    );

    const personal = await searchClassificationMemory({
      query: 'owner gift-card reimbursement for personal convenience',
      companyId: current.company.id, scope: 'current_company', mode: 'semantic',
      accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    expect(personal.hits).toContainEqual(expect.objectContaining({
      id: `classification_case:${current.personalCase.id}`,
      matchedIn: expect.arrayContaining(['semantic']),
    }));
    expect(personal.hits.map(({ id }) => id)).not.toContain(
      `classification_case:${current.fuelCase.id}`,
    );

    const hybrid = await searchClassificationMemory({
      query: current.alias.value, companyId: current.company.id, scope: 'current_company',
      mode: 'hybrid', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    expect(hybrid.hits).toContainEqual(expect.objectContaining({
      id: `vendor_alias:${current.alias.id}`,
      matchedIn: expect.arrayContaining(['alias', 'lexical', 'semantic']),
    }));

    const accessible = await searchClassificationMemory({
      query: 'ExampleFuel fleet propellant', companyId: current.company.id,
      scope: 'accessible_companies', mode: 'hybrid',
      accessibleCompanyIds: [current.company.id, foreign.company.id],
    }, semanticDependencies(db, releaseA, saltA));
    const foreignHits = accessible.hits.filter(({ companyId }) => companyId === foreign.company.id);
    expect(foreignHits.length).toBeGreaterThan(0);
    expect(foreignHits.every((hit) => hit.companyRelation === 'foreign'
      && hit.advisory && !hit.executable && hit.action === null)).toBe(true);
    await expect(searchClassificationMemory({
      query: 'ExampleFuel', companyId: foreign.company.id, scope: 'current_company', mode: 'exact',
      accessibleCompanyIds: [current.company.id],
    }, { repository: firstPublication.repository, semantic: null }))
      .rejects.toBeInstanceOf(ClassificationSearchError);

    const readDb = client();
    const reads = createCompanyReadService(readDb as never, 'classification-search-test-tenant-cursor-secret', {
      classificationSearch: (input) => searchClassificationMemory(
        input,
        semanticDependencies(readDb, releaseA, saltA),
      ),
    });
    const authorized = await reads.searchClassificationKnowledge(
      current.user.id,
      current.company.id,
      { query: 'fleet propellant', scope: 'accessible_companies', mode: 'hybrid', limit: 100 },
    );
    const authorizedForeign = authorized.items.filter(({ companyId }) => companyId === foreign.company.id);
    expect(authorizedForeign.length).toBeGreaterThan(0);
    expect(authorizedForeign.every((hit) => hit.companyRelation === 'foreign'
      && hit.advisory && !hit.executable && hit.action === null)).toBe(true);
    expect(JSON.stringify(authorizedForeign)).not.toContain(foreign.account.qboId);
    expect(authorized.items.map(({ companyId }) => companyId)).not.toContain(nonMember.company.id);

    const denial = async (companyId: string) => {
      try {
        await reads.searchClassificationKnowledge(current.user.id, companyId, {
          query: 'fleet propellant', mode: 'semantic', limit: 20,
        });
        return null;
      } catch (error) {
        const row = error as { status?: number; code?: string; message?: string };
        return { status: row.status, code: row.code, message: row.message };
      }
    };
    expect(await denial(nonMember.company.id)).toEqual(await denial(randomUUID()));

    const requestsBeforeEdit = releaseA.requests.length;
    await db.vendorIdentity.update({
      where: { id: current.vendor.id },
      data: { displayName: 'ExampleFuel Fleet Energy', normalizedName: 'examplefuel fleet energy' },
    });
    const edited = await publishEmbeddings(db, current.company.id, releaseA, saltA);
    const editRequests = releaseA.requests.slice(requestsBeforeEdit).flatMap(({ inputs }) => inputs);
    expect(editRequests.some((text) => text.includes('ExampleFuel Fleet Energy'))).toBe(true);
    expect(editRequests.length).toBeGreaterThan(0);
    expect(editRequests.length).toBeLessThan(edited.corpus.totalDocuments);

    const releaseB = await startDeterministicEmbeddingFixture('b');
    fixtures.push(releaseB);
    const saltB = 'classification-search-test-model-release-b';
    const generationB = classificationEmbeddingGeneration({ baseUrl: releaseB.baseUrl, fingerprintSalt: saltB });
    const buildingStore = new PgClassificationVectorStore(db);
    await buildingStore.beginAttempt({ companyId: current.company.id, fingerprint: generationB.fingerprint });
    await expect(searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB))).rejects.toMatchObject({ code: 'SEMANTIC_UNAVAILABLE' });
    const duringCutover = await searchClassificationMemory({
      query: 'ExampleFuel', companyId: current.company.id, scope: 'current_company',
      mode: 'auto', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(duringCutover).toMatchObject({
      mode: 'lexical', degraded: true, degradedReason: 'semantic_unavailable',
    });

    const oldFingerprint = edited.generation.fingerprint;
    const cutover = await publishEmbeddings(db, current.company.id, releaseB, saltB);
    expect(cutover.generation.fingerprint).not.toBe(oldFingerprint);
    const oldRows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "ClassificationEmbeddingGeneration"
      WHERE "companyId" = ${current.company.id} AND "fingerprint" = ${oldFingerprint}
    `;
    expect(oldRows[0]?.count).toBe(0n);
    const afterCutover = await searchClassificationMemory({
      query: semanticOnlyQuery, companyId: current.company.id, scope: 'current_company',
      mode: 'semantic', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(afterCutover.hits.map(({ id }) => id)).toContain(`classification_case:${current.fuelCase.id}`);

    await releaseB.close();
    const endpointDown = await searchClassificationMemory({
      query: 'ExampleFuel', companyId: current.company.id, scope: 'current_company',
      mode: 'auto', accessibleCompanyIds: [current.company.id],
    }, semanticDependencies(db, releaseB, saltB));
    expect(endpointDown).toMatchObject({
      mode: 'lexical', requestedMode: 'auto', degraded: true,
      degradedReason: 'semantic_error', status: 'matched',
    });
  }, 60_000);

  it('runs the isolated ExampleFuel suggestion flow with restart readback and zero accounting-provider writes', async () => {
    let db = client();
    const seeded = await seedSearchCompany(db, 'Classification search test Restart');
    const endpoint = await startDeterministicEmbeddingFixture('a');
    fixtures.push(endpoint);
    const safety = installClassificationSearchIsolation(new URL(endpoint.baseUrl).origin);
    safetyGuards.push(safety);
    await expect(qboFactory.forCompany('classification-search-test-deny-proof')).rejects.toThrow(
      'classification-search-test-unexpected-qbo-factory-call',
    );
    await expect(qboFactory.exchangeCode('classification-search-test-deny-proof', 'classification-search-test-deny-proof', 'demo'))
      .rejects.toThrow('classification-search-test-unexpected-qbo-factory-call');
    await expect(RealQboClient.prototype.recategorize.call(
      {} as RealQboClient,
      {} as never,
      [],
    )).rejects.toThrow('classification-search-test-unexpected-qbo-mutation');
    await expect(fetch('https://classification-search-test-external.invalid/deny-proof')).rejects.toThrow(
      'classification-search-test-unexpected-network:fetch',
    );
    expect(() => httpRequest('http://classification-search-test-external.invalid/deny-proof'))
      .toThrow('classification-search-test-unexpected-network:http');
    const deniedCounts = safety.counts();
    expect(deniedCounts.qboFactory).toBe(2);
    expect(Object.keys(deniedCounts.qboMutations)).toHaveLength(14);
    expect(Object.entries(deniedCounts.qboMutations).filter(([, count]) => count !== 0))
      .toEqual([['RealQboClient.recategorize', 1]]);
    expect(deniedCounts.network).toEqual({ fetch: 1, http: 1, https: 0 });
    safety.reset();
    const salt = 'classification-search-test-restart-model';
    await publishEmbeddings(db, seeded.company.id, endpoint, salt);
    const beforeAttempts = await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    });
    const transactionProjection = {
      id: true, qboSyncToken: true, revision: true, status: true,
      categoryQboId: true, taxCalculation: true, taxCodeQboId: true,
    } as const;
    const beforeTransactions = await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    });

    const unfamiliar = await searchClassificationMemory({
      query: 'EXAMPLEFUEL 00002 SAMPLEVILLE road-trip refuelling',
      companyId: seeded.company.id, scope: 'current_company', mode: 'hybrid',
      accessibleCompanyIds: [seeded.company.id],
    }, semanticDependencies(db, endpoint, salt));
    expect(unfamiliar.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `classification_case:${seeded.fuelCase.id}`,
        rationale: expect.stringContaining('Fleet propellant'), evidenceCount: 1,
        counterexamples: ['Store merchandise without a pump receipt'],
      }),
      expect.objectContaining({
        id: `rule_candidate:${seeded.candidate.id}`,
        advisory: true, executable: false, conflictingEvidenceCount: 1,
        rationale: 'Verified outcomes disagree for this candidate.',
        conflicts: [expect.objectContaining({
          reason: 'Verified outcomes disagree for this rule candidate.', evidenceCount: 1,
        })],
      }),
    ]));

    const idempotencyKey = `classification-search-test-recurring-${randomUUID()}`;
    const prepared = await prepareRuleChange(seeded.principal, {
      companyId: seeded.company.id, mutation: 'create', expectedRevision: 0, idempotencyKey,
      proposal: {
        matchText: 'ExampleFuel', categoryQboId: seeded.fuelAccount.qboId,
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
        direction: 'Purchase', autoPost: false, sourceCaseId: seeded.fuelCase.id,
      },
    }, { db, now: () => NOW });
    expect(prepared).toMatchObject({
      status: 'PREPARED', originIntent: 'make_recurring',
      preview: { autoPost: false, action: { categoryQboId: seeded.fuelAccount.qboId } },
    });
    expect(await db.rule.count({ where: { companyId: seeded.company.id } })).toBe(0);
    const committed = await commitRuleChange(seeded.principal, {
      companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    expect(committed).toMatchObject({
      status: 'COMMITTED', rule: { state: 'enabled', autoPost: false, sourceCaseId: seeded.fuelCase.id },
    });
    await publishEmbeddings(db, seeded.company.id, endpoint, salt);

    expect(endpoint.requests.length).toBeGreaterThan(0);
    expect(endpoint.requests.every(({ method, path }) => method === 'POST' && path === '/v1/embeddings')).toBe(true);
    expect(await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    })).toBe(beforeAttempts);
    expect(await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    })).toEqual(beforeTransactions);

    await db.$disconnect();
    db = client();
    const reads = createCompanyReadService(
      db as never,
      'classification-search-test-restart-cursor-secret',
      {
        classificationSearch: (input) => searchClassificationMemory(
          input,
          semanticDependencies(db, endpoint, salt),
        ),
      },
    );
    const [caseReadback, ruleReadback, revisionPage, candidateReadback, searchReadback] = await Promise.all([
      reads.getClassificationCase(seeded.user.id, seeded.company.id, seeded.fuelCase.id),
      reads.getRule(seeded.user.id, seeded.company.id, committed.ruleId!),
      reads.listRuleRevisions(seeded.user.id, seeded.company.id, committed.ruleId!, { limit: 20 }),
      reads.getRuleCandidate(seeded.user.id, seeded.company.id, seeded.candidate.id),
      reads.searchClassificationKnowledge(seeded.user.id, seeded.company.id, {
        query: 'road-trip refuelling', mode: 'semantic', limit: 20,
      }),
    ]);
    expect(caseReadback).toMatchObject({ id: seeded.fuelCase.id, invalidatedAt: null });
    expect(ruleReadback).toMatchObject({
      state: 'enabled',
      revision: { ruleId: committed.ruleId, revision: 1, autoPost: false, valid: true },
    });
    expect(revisionPage.items.map(({ revision }) => revision).sort()).toEqual([0, 1]);
    expect(candidateReadback).toMatchObject({
      id: seeded.candidate.id, state: 'conflict', evidenceCount: 1, conflictingEvidenceCount: 1,
    });
    expect(searchReadback.items.map(({ id }) => id)).toContain(`classification_case:${seeded.fuelCase.id}`);
    expect(await db.qboMutationAttempt.count({
      where: { transaction: { companyId: seeded.company.id } },
    })).toBe(beforeAttempts);
    expect(await db.transaction.findMany({
      where: { companyId: seeded.company.id }, select: transactionProjection, orderBy: { id: 'asc' },
    })).toEqual(beforeTransactions);
    const finalCounts = safety.counts();
    expect(finalCounts.qboFactory).toBe(0);
    expect(Object.keys(finalCounts.qboMutations)).toHaveLength(14);
    expect(Object.values(finalCounts.qboMutations).every((count) => count === 0)).toBe(true);
    expect(finalCounts.network).toEqual({ fetch: 0, http: 0, https: 0 });
  }, 60_000);

  it('recovers rule prepare and commit at every durable boundary without partial policy or order state', async () => {
    const prepareDb = client();
    const prepareSeed = await seedSearchCompany(prepareDb, 'Classification search test Prepare Recovery');
    const prepareKey = `prepare-crash-${randomUUID()}`;
    const prepareRequest = createRuleInput(prepareSeed, prepareKey);
    await expect(prepareRuleChange(
      prepareSeed.principal,
      prepareRequest,
      {
        db: faultInjectedClient(prepareDb, { model: 'mcpRuleOperation', method: 'createMany' }),
        now: () => NOW,
      },
    )).rejects.toThrow('classification-search-test-simulated-crash:mcpRuleOperation.createMany');
    expect(await prepareDb.mcpRuleOperation.count({
      where: { companyId: prepareSeed.company.id, idempotencyKey: prepareKey },
    })).toBe(0);
    expect(await prepareDb.rule.count({ where: { companyId: prepareSeed.company.id } })).toBe(0);
    const preparedAfterRestart = await prepareRuleChange(
      prepareSeed.principal,
      prepareRequest,
      { db: client(), now: () => new Date(NOW.getTime() + 1_000) },
    );
    expect(preparedAfterRestart.status).toBe('PREPARED');
    expect(await prepareDb.mcpRuleOperation.count({
      where: { companyId: prepareSeed.company.id, idempotencyKey: prepareKey },
    })).toBe(1);
    expect(await prepareDb.rule.count({ where: { companyId: prepareSeed.company.id } })).toBe(0);

    const commitBoundaries: FaultBoundary[] = [
      { model: 'rule', method: 'create' },
      { model: 'ruleRevision', method: 'create' },
      { model: 'auditEntry', method: 'create' },
      { model: 'mcpRuleOperation', method: 'update' },
    ];
    for (const boundary of commitBoundaries) {
      const db = client();
      const seeded = await seedSearchCompany(db, `Classification search test ${boundary.model}`);
      const idempotencyKey = `commit-${boundary.model}-${randomUUID()}`;
      const request = createRuleInput(seeded, idempotencyKey);
      const prepared = await prepareRuleChange(seeded.principal, request, { db, now: () => NOW });

      await expect(commitRuleChange(seeded.principal, {
        companyId: seeded.company.id,
        operationId: prepared.operationId,
        idempotencyKey,
      }, {
        db: faultInjectedClient(db, boundary),
        now: () => new Date(NOW.getTime() + 1_000),
      })).rejects.toThrow(`classification-search-test-simulated-crash:${boundary.model}.${boundary.method}`);

      expect(await db.rule.count({ where: { id: prepared.ruleId! } }), boundary.model).toBe(0);
      expect(await db.ruleRevision.count({ where: { ruleId: prepared.ruleId! } }), boundary.model).toBe(0);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, payload: { path: ['ruleId'], equals: prepared.ruleId! } },
      }), boundary.model).toBe(0);
      expect(await db.mcpRuleOperation.findUniqueOrThrow({ where: { id: prepared.operationId } }))
        .toMatchObject({ committedAt: null, commitResult: null });

      const restarted = client();
      const committed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: restarted, now: () => new Date(NOW.getTime() + 2_000) });
      const replayed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 3_000) });
      expect(committed.status, boundary.model).toBe('COMMITTED');
      expect(replayed.status, boundary.model).toBe('REPLAYED');
      expect(await db.rule.count({ where: { id: prepared.ruleId! } }), boundary.model).toBe(1);
      expect(await db.ruleRevision.count({ where: { ruleId: prepared.ruleId! } }), boundary.model).toBe(2);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, action: 'rule-created' },
      }), boundary.model).toBe(1);
    }

    const expiryDb = client();
    const expirySeed = await seedSearchCompany(expiryDb, 'Classification search test Expiry');
    const expiryKey = `expiry-${randomUUID()}`;
    const expiryInput = createRuleInput(expirySeed, expiryKey);
    const expired = await prepareRuleChange(expirySeed.principal, expiryInput, { db: expiryDb, now: () => NOW });
    const retryAt = new Date(NOW.getTime() + 16 * 60 * 1_000);
    await expect(commitRuleChange(expirySeed.principal, {
      companyId: expirySeed.company.id, operationId: expired.operationId, idempotencyKey: expiryKey,
    }, { db: expiryDb, now: () => retryAt })).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(await expiryDb.rule.count({ where: { id: expired.ruleId! } })).toBe(0);
    expect(await expiryDb.mcpRuleOperation.findUniqueOrThrow({ where: { id: expired.operationId } }))
      .toMatchObject({ committedAt: null, commitResult: null });
    const retryKey = `expiry-retry-${randomUUID()}`;
    const retry = await prepareRuleChange(expirySeed.principal, {
      ...expiryInput, idempotencyKey: retryKey, retryOfId: expired.operationId,
    }, { db: client(), now: () => retryAt });
    expect(retry.ruleId).toBe(expired.ruleId);
    await expect(commitRuleChange(expirySeed.principal, {
      companyId: expirySeed.company.id, operationId: retry.operationId, idempotencyKey: retryKey,
    }, { db: client(), now: () => new Date(retryAt.getTime() + 1_000) }))
      .resolves.toMatchObject({ status: 'COMMITTED', ruleId: expired.ruleId });

    const conflictDb = client();
    const conflictSeed = await seedSearchCompany(conflictDb, 'Classification search test Candidate Conflict');
    await expect(prepareRuleChange(conflictSeed.principal, {
      companyId: conflictSeed.company.id,
      mutation: 'activate_candidate',
      candidateId: conflictSeed.candidate.id,
      expectedRevision: 0,
      idempotencyKey: `candidate-conflict-${randomUUID()}`,
    }, { db: conflictDb, now: () => NOW })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await conflictDb.rule.count({ where: { companyId: conflictSeed.company.id } })).toBe(0);

    const historyDb = client();
    const historySeed = await seedSearchCompany(historyDb, 'Classification search test History');
    const createKey = `history-create-${randomUUID()}`;
    const historyPrepared = await prepareRuleChange(
      historySeed.principal,
      createRuleInput(historySeed, createKey),
      { db: historyDb, now: () => NOW },
    );
    const historyCreated = await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id,
      operationId: historyPrepared.operationId,
      idempotencyKey: createKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 1_000) });
    const staleKey = `history-stale-${randomUUID()}`;
    const stalePrepared = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: staleKey, proposal: { matchText: 'Prepared stale ExampleFuel' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 2_000) });
    const updateKey = `history-update-${randomUUID()}`;
    const currentUpdate = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: updateKey, proposal: { matchText: 'Current ExampleFuel' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 3_000) });
    await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: currentUpdate.operationId, idempotencyKey: updateKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 4_000) });
    await expect(commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: stalePrepared.operationId, idempotencyKey: staleKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 5_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'update', ruleId: historyCreated.ruleId!,
      expectedRevision: 1, idempotencyKey: `known-stale-${randomUUID()}`,
      proposal: { matchText: 'Known stale ExampleFuel' },
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 6_000) }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    const disableKey = `history-disable-${randomUUID()}`;
    const disablePrepared = await prepareRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, mutation: 'disable', ruleId: historyCreated.ruleId!,
      expectedRevision: 2, idempotencyKey: disableKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 7_000) });
    await commitRuleChange(historySeed.principal, {
      companyId: historySeed.company.id, operationId: disablePrepared.operationId, idempotencyKey: disableKey,
    }, { db: historyDb, now: () => new Date(NOW.getTime() + 8_000) });
    const revisions = await historyDb.ruleRevision.findMany({
      where: { ruleId: historyCreated.ruleId! }, select: { id: true, revision: true },
      orderBy: { revision: 'asc' },
    });
    expect(revisions.map(({ revision }) => revision)).toEqual([0, 1, 2, 3]);
    await expect(historyDb.ruleRevision.update({
      where: { id: revisions[1]!.id }, data: { matchText: 'Mutated history' },
    })).rejects.toThrow('RuleRevision is append-only');
    await expect(historyDb.ruleRevision.delete({ where: { id: revisions[1]!.id } }))
      .rejects.toThrow('RuleRevision is append-only');
    expect(await historyDb.ruleRevision.count({ where: { ruleId: historyCreated.ruleId! } })).toBe(4);

  }, 120_000);

  it.each(['reorder', 'retire'])('rejects obsolete %s authority without changing policy or receipts', async mutation => {
    const db = client();
    const seeded = await seedSearchCompany(db, 'Classification search test Obsolete authority');
    const createKey = `obsolete-create-${randomUUID()}`;
    const prepared = await prepareRuleChange(seeded.principal, createRuleInput(seeded, createKey), { db, now: () => NOW });
    await commitRuleChange(seeded.principal, {
      companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey: createKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) });
    const before = await durablePolicySnapshot(db, seeded.company.id, prepared.operationId);
    const idempotencyKey = `obsolete-${mutation}-${randomUUID()}`;
    await expect(prepareRuleChange(seeded.principal, {
      companyId: seeded.company.id, mutation: mutation as never, expectedRevision: 1, idempotencyKey,
      proposal: { orderIds: [prepared.ruleId!] },
    }, { db, now: () => new Date(NOW.getTime() + 2_000) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await durablePolicySnapshot(db, seeded.company.id, prepared.operationId)).toEqual(before);
    expect(await db.mcpRuleOperation.count({ where: { companyId: seeded.company.id, idempotencyKey } })).toBe(0);
  }, 60_000);

  it('persists candidate reconciliation before policy and recovers a crash between transactions', async () => {
    const db = client();
    const seeded = await seedSearchCompany(db, 'Classification search test Reconciliation Boundary');
    const ready = await seedReadyCandidate(db, seeded, {
      pendingReconciliation: true,
    });
    const requestIds = (await db.qboMutationAttempt.findMany({
      where: { transactionId: { in: ready.transactions.map(({ id }) => id) } },
      select: { requestId: true },
      orderBy: { requestId: 'asc' },
    })).map(({ requestId }) => requestId);
    expect(requestIds).toHaveLength(4);

    const idempotencyKey = `activate-reconciliation-crash-${randomUUID()}`;
    const request = {
      companyId: seeded.company.id,
      mutation: 'activate_candidate' as const,
      candidateId: ready.candidate.id,
      expectedRevision: 0,
      idempotencyKey,
    };
    const prepared = await prepareRuleChange(seeded.principal, request, { db, now: () => NOW });
    const before = await activationRecoverySnapshot(
      db,
      seeded.company.id,
      ready.candidate.id,
      [prepared.operationId],
      requestIds,
    );
    expect(before.reconciliation.candidate).toMatchObject({
      state: 'ready', evidenceCount: 3, conflictingEvidenceCount: 0,
      activatedRuleId: null, activationEvidenceCount: null, activationActionFingerprint: null,
    });
    expect(before.reconciliation.evidence).toHaveLength(3);
    expect(before.reconciliation.folds).toHaveLength(3);
    expect(before.reconciliation.attempts).toHaveLength(4);
    const initiallyFolded = before.reconciliation.attempts.filter(({ ruleCandidateFoldedAt }) => (
      ruleCandidateFoldedAt !== null
    ));
    expect(initiallyFolded).toHaveLength(3);
    expect(before.reconciliation.evidence.map(({ requestId }) => requestId))
      .toEqual(initiallyFolded.map(({ requestId }) => requestId));
    expect(before.reconciliation.folds.map(({ requestId }) => requestId))
      .toEqual(initiallyFolded.map(({ requestId }) => requestId));
    expect(before.reconciliation.evidence.every((row) => (
      row.active
      && row.polarity === 'positive'
      && row.actionFingerprint === ready.candidate.winningActionFingerprint
      && row.invalidatedAt === null
      && row.invalidationReason === null
    ))).toBe(true);
    expect(before.policy).toMatchObject({
      rules: [], revisions: [], audits: [],
      operations: [{ id: prepared.operationId, committedAt: null, commitResult: null, commitResultHash: null }],
    });

    await expect(commitRuleChange(seeded.principal, {
      companyId: seeded.company.id,
      operationId: prepared.operationId,
      idempotencyKey,
    }, {
      db: crashBeforeTransaction(db, 2),
      now: () => new Date(NOW.getTime() + 1_000),
    })).rejects.toThrow('classification-search-test-simulated-crash:$transaction.2');

    const afterReconciliation = await activationRecoverySnapshot(
      db,
      seeded.company.id,
      ready.candidate.id,
      [prepared.operationId],
      requestIds,
    );
    expect(afterReconciliation.reconciliation.candidate).toMatchObject({
      state: 'ready', evidenceCount: 4, conflictingEvidenceCount: 0,
      activatedRuleId: null, activationEvidenceCount: null, activationActionFingerprint: null,
    });
    expect(afterReconciliation.reconciliation.evidence).toHaveLength(4);
    expect(afterReconciliation.reconciliation.folds).toHaveLength(4);
    expect(afterReconciliation.reconciliation.attempts).toHaveLength(4);
    expect(afterReconciliation.reconciliation.evidence.map(({ requestId }) => requestId))
      .toEqual(requestIds);
    expect(afterReconciliation.reconciliation.folds.map(({ requestId }) => requestId))
      .toEqual(requestIds);
    expect(afterReconciliation.reconciliation.attempts.every(({ ruleCandidateFoldedAt }) => (
      ruleCandidateFoldedAt !== null
    ))).toBe(true);
    expect(afterReconciliation.reconciliation.attempts.every((row) => (
      row.status === 'VERIFIED' && row.operation === 'recategorize'
    ))).toBe(true);
    expect(afterReconciliation.reconciliation.evidence.every((row) => (
      row.active
      && row.polarity === 'positive'
      && row.actionFingerprint === ready.candidate.winningActionFingerprint
      && row.invalidatedAt === null
      && row.invalidationReason === null
    ))).toBe(true);
    expect(afterReconciliation.policy).toEqual(before.policy);

    await expect(commitRuleChange(seeded.principal, {
      companyId: seeded.company.id,
      operationId: prepared.operationId,
      idempotencyKey,
    }, {
      db: client(),
      now: () => new Date(NOW.getTime() + 2_000),
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await activationRecoverySnapshot(
      db,
      seeded.company.id,
      ready.candidate.id,
      [prepared.operationId],
      requestIds,
    )).toEqual(afterReconciliation);

    const recoveredKey = `activate-reconciliation-reprepare-${randomUUID()}`;
    const recovered = await prepareRuleChange(seeded.principal, {
      ...request,
      idempotencyKey: recoveredKey,
    }, {
      db: client(),
      now: () => new Date(NOW.getTime() + 3_000),
    });
    expect(recovered).toMatchObject({
      status: 'PREPARED',
      preview: { candidateId: ready.candidate.id, affectedProcessedCount: 4 },
    });
    expect(recovered.operationId).not.toBe(prepared.operationId);
    const committed = await commitRuleChange(seeded.principal, {
      companyId: seeded.company.id,
      operationId: recovered.operationId,
      idempotencyKey: recoveredKey,
    }, {
      db: client(),
      now: () => new Date(NOW.getTime() + 4_000),
    });
    const replayed = await commitRuleChange(seeded.principal, {
      companyId: seeded.company.id,
      operationId: recovered.operationId,
      idempotencyKey: recoveredKey,
    }, {
      db: client(),
      now: () => new Date(NOW.getTime() + 5_000),
    });
    expect([committed.status, replayed.status]).toEqual(['COMMITTED', 'REPLAYED']);

    const final = await activationRecoverySnapshot(
      db,
      seeded.company.id,
      ready.candidate.id,
      [prepared.operationId, recovered.operationId],
      requestIds,
    );
    expect(final.reconciliation.candidate).toMatchObject({
      state: 'activated', evidenceCount: 4, conflictingEvidenceCount: 0,
      activatedRuleId: recovered.ruleId, activationEvidenceCount: 4,
      activationActionFingerprint: ready.candidate.winningActionFingerprint,
    });
    expect(final.reconciliation.evidence).toHaveLength(4);
    expect(final.reconciliation.folds).toHaveLength(4);
    expect(final.reconciliation.attempts.every(({ ruleCandidateFoldedAt }) => (
      ruleCandidateFoldedAt !== null
    ))).toBe(true);
    expect(final.policy.rules).toEqual([expect.objectContaining({
      id: recovered.ruleId, priority: 0, revision: 1, enabled: true,
      sourceCandidateId: ready.candidate.id, autoPost: false,
    })]);
    expect(final.policy.revisions).toEqual([
      expect.objectContaining({ ruleId: recovered.ruleId, revision: 0, autoPost: false }),
      expect.objectContaining({ ruleId: recovered.ruleId, revision: 1, autoPost: false }),
    ]);
    expect(final.policy.audits).toEqual([
      expect.objectContaining({ action: 'rule-candidate-activated' }),
    ]);
    expect(final.policy.operations.find(({ id }) => id === prepared.operationId)).toMatchObject({
      committedAt: null, commitResult: null, commitResultHash: null,
    });
    expect(final.policy.operations.find(({ id }) => id === recovered.operationId)).toMatchObject({
      committedAt: new Date(NOW.getTime() + 4_000),
      commitResult: expect.objectContaining({ status: 'COMMITTED' }),
      commitResultHash: expect.any(String),
    });
  }, 120_000);

  it('recovers candidate activation and dismissal at every applicable durable boundary', async () => {
    const activationBoundaries: FaultBoundary[] = [
      { model: 'rule', method: 'create', occurrence: 1 },
      { model: 'ruleRevision', method: 'create', occurrence: 1 },
      { model: 'autopilotRuleCandidate', method: 'update', occurrence: 1 },
      { model: 'auditEntry', method: 'create', occurrence: 1 },
      { model: 'mcpRuleOperation', method: 'update', occurrence: 1 },
    ];
    for (const boundary of activationBoundaries) {
      const db = client();
      const label = `activate-${boundary.model}`;
      const seeded = await seedSearchCompany(db, `Classification search test ${label}`);
      const ready = await seedReadyCandidate(db, seeded);
      const idempotencyKey = `${label}-${randomUUID()}`;
      const request = {
        companyId: seeded.company.id, mutation: 'activate_candidate' as const,
        candidateId: ready.candidate.id, expectedRevision: 0, idempotencyKey,
      };
      const prepared = await prepareRuleChange(seeded.principal, request, { db, now: () => NOW });
      const before = await durablePolicySnapshot(db, seeded.company.id, prepared.operationId);

      await expect(commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, {
        db: faultInjectedClient(db, boundary),
        now: () => new Date(NOW.getTime() + 1_000),
      }), label).rejects.toThrow(`classification-search-test-simulated-crash:${boundary.model}.${boundary.method}`);
      expect(await durablePolicySnapshot(db, seeded.company.id, prepared.operationId), label).toEqual(before);

      const reprepared = await prepareRuleChange(
        seeded.principal, request, { db: client(), now: () => new Date(NOW.getTime() + 2_000) },
      );
      expect(reprepared, label).toMatchObject({ status: 'PREPARED', operationId: prepared.operationId });
      const committed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 3_000) });
      const replayed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 4_000) });
      expect([committed.status, replayed.status], label).toEqual(['COMMITTED', 'REPLAYED']);
      expect(await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: ready.candidate.id },
      }), label).toMatchObject({
        state: 'activated', activatedRuleId: prepared.ruleId, activationEvidenceCount: 3,
      });
      expect(await db.rule.findUniqueOrThrow({ where: { id: prepared.ruleId! } }), label)
        .toMatchObject({ sourceCandidateId: ready.candidate.id, autoPost: false, revision: 1 });
      expect(await db.ruleRevision.findMany({
        where: { ruleId: prepared.ruleId! }, select: { revision: true }, orderBy: { revision: 'asc' },
      }), label).toEqual([{ revision: 0 }, { revision: 1 }]);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, action: 'rule-candidate-activated' },
      }), label).toBe(1);
      expect(await db.autopilotRuleCandidateEvidence.count({
        where: { candidateId: ready.candidate.id, active: true },
      }), label).toBe(3);
    }

    const dismissalBoundaries: FaultBoundary[] = [
      { model: 'autopilotRuleCandidate', method: 'update', occurrence: 1 },
      { model: 'auditEntry', method: 'create', occurrence: 1 },
      { model: 'mcpRuleOperation', method: 'update', occurrence: 1 },
    ];
    for (const boundary of dismissalBoundaries) {
      const db = client();
      const label = `dismiss-${boundary.model}`;
      const seeded = await seedSearchCompany(db, `Classification search test ${label}`);
      const idempotencyKey = `${label}-${randomUUID()}`;
      const request = {
        companyId: seeded.company.id, mutation: 'dismiss_candidate' as const,
        candidateId: seeded.candidate.id, expectedRevision: 0, idempotencyKey,
      };
      const prepared = await prepareRuleChange(seeded.principal, request, { db, now: () => NOW });
      const before = await durablePolicySnapshot(db, seeded.company.id, prepared.operationId);

      await expect(commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, {
        db: faultInjectedClient(db, boundary),
        now: () => new Date(NOW.getTime() + 1_000),
      }), label).rejects.toThrow(`classification-search-test-simulated-crash:${boundary.model}.${boundary.method}`);
      expect(await durablePolicySnapshot(db, seeded.company.id, prepared.operationId), label).toEqual(before);

      const reprepared = await prepareRuleChange(
        seeded.principal, request, { db: client(), now: () => new Date(NOW.getTime() + 2_000) },
      );
      expect(reprepared, label).toMatchObject({ status: 'PREPARED', operationId: prepared.operationId });
      const committed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 3_000) });
      const replayed = await commitRuleChange(seeded.principal, {
        companyId: seeded.company.id, operationId: prepared.operationId, idempotencyKey,
      }, { db: client(), now: () => new Date(NOW.getTime() + 4_000) });
      expect([committed.status, replayed.status], label).toEqual(['COMMITTED', 'REPLAYED']);
      expect(await db.autopilotRuleCandidate.findUniqueOrThrow({
        where: { id: seeded.candidate.id },
      }), label).toMatchObject({ state: 'dismissed', activatedRuleId: null });
      expect(await db.rule.count({ where: { companyId: seeded.company.id } }), label).toBe(0);
      expect(await db.ruleRevision.count({ where: { companyId: seeded.company.id } }), label).toBe(0);
      expect(await db.auditEntry.count({
        where: { companyId: seeded.company.id, action: 'rule-candidate-dismissed' },
      }), label).toBe(1);
      expect(await db.autopilotRuleCandidateEvidence.count({
        where: { candidateId: seeded.candidate.id, active: true },
      }), label).toBe(2);
    }
  }, 120_000);
});
