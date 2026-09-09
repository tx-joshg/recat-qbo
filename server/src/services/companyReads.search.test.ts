import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  createCompanyReadService,
  getCompany,
  getClassificationCase,
  getRule,
  getRuleCandidate,
  getTransaction,
  listCategories,
  listCompanies,
  listRules,
  listRuleCandidates,
  listTags,
  listTaxCodes,
  listTransactions,
  listTransferCandidates,
  searchClassificationKnowledge,
  testRule,
  type CompanyReadDb,
} from './companyReads.js';
import {
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
} from './transferCandidates.js';
import { ClassificationSearchError } from './classification/search.js';

const SECRET = 'test-cursor-secret-at-least-16-characters';
const USER_ID = 'user-1';
const COMPANY_ID = 'company-1';

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANY_ID,
    realmId: 'realm-1',
    legalName: 'Acme Legal',
    nickname: 'Acme',
    env: 'production',
    syncMode: 'polling',
    pollIntervalMin: 10,
    holdingAccountIds: ['holding-1'],
    dryRun: true,
    tagsRequired: false,
    connectedAt: new Date('2026-01-01T00:00:00.000Z'),
    disconnectedAt: null,
    lastSyncedAt: new Date('2026-01-02T00:00:00.000Z'),
    accessToken: 'must-not-leak',
    refreshToken: 'must-not-leak',
    memberships: [{ role: 'categorizer' }],
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    companyId: COMPANY_ID,
    qboId: '1001',
    qboType: 'Purchase',
    qboSyncToken: 'must-not-leak',
    date: new Date('2026-01-03T00:00:00.000Z'),
    payee: 'Coffee Shop',
    memo: 'Team coffee',
    amount: -12.34,
    bankAccount: 'Checking',
    status: 'PENDING',
    revision: 2,
    category: null,
    categoryQboId: null,
    taxCalculation: null,
    taxCode: null,
    taxCodeQboId: null,
    suggestion: { category: 'Meals', categoryQboId: 'acct-1', source: 'rule', unsafe: 'drop' },
    errorCode: null,
    errorMessage: null,
    postedAt: null,
    postedByUserId: null,
    rawData: { secret: true },
    txnTags: [{ tagId: 'tag-1', other: 'drop' }],
    splitLines: [],
    qboMutationAttempts: [],
    ...overrides,
  };
}

function classificationHit(id: string) {
  return {
    id, sourceId: id, kind: 'classification_case' as const,
    companyId: COMPANY_ID, companyName: 'Acme', companyRelation: 'current' as const,
    executable: true, advisory: false, matchedIn: ['lexical'] as const, score: 1,
    vendorIdentityId: null, vendorName: 'Coffee',
    action: { categoryQboId: 'account-a', taxCalculation: 'NotApplicable' as const, taxCodeQboId: null, tagIds: [] },
    actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable' as const, taxCodeName: null, tagNames: [] },
    originIntent: 'apply_once' as const, evidenceCount: 1, conflictingEvidenceCount: 0,
    conflicts: [], provenance: { source: 'qbo_verified' as const, sourceId: id, actorId: null, recordedAt: '2026-01-01T00:00:00.000Z' },
    rationale: 'Verified.', examples: [], counterexamples: [], jurisdiction: 'unknown',
    currency: 'CAD', verifiedAt: '2026-01-01T00:00:00.000Z', ruleRevision: null,
  };
}

function historicalObservationHit(id: string) {
  return {
    id: `historical_observation:${id}`, sourceId: id, kind: 'historical_observation' as const,
    companyId: COMPANY_ID, companyName: 'Acme', companyRelation: 'current' as const,
    executable: false, advisory: true, matchedIn: ['observation'] as const, score: 1,
    vendorIdentityId: null, vendorName: 'Northwind', action: null,
    actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable' as const, taxCodeName: null, tagNames: [] },
    originIntent: null, evidenceCount: 0, conflictingEvidenceCount: 0, conflicts: [],
    provenance: { source: 'historical_observation' as const, sourceId: id, actorId: null, recordedAt: '2026-08-31T00:00:00.000Z' },
    rationale: null, examples: [], counterexamples: [], jurisdiction: null,
    currency: 'CAD', verifiedAt: null, ruleRevision: null,
    observation: {
      sourceTransactionId: 'transaction-history', sourceQboType: 'Purchase' as const,
      sourceQboId: 'purchase-history', sourceTransactionRevision: 1,
      sourceQboSyncToken: '1', sourceStatus: 'POSTED' as const,
      sourceUpdatedAt: '2026-08-31T00:00:00.000Z', observedAt: '2026-08-31T00:00:00.000Z',
    },
  };
}

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ id: USER_ID, isInstanceAdmin: false })),
      findMany: vi.fn(async () => []),
    },
    membership: {
      findUnique: vi.fn(async () => ({ role: 'categorizer' })),
      findMany: vi.fn(async () => [{ companyId: COMPANY_ID, role: 'categorizer' }]),
    },
    company: {
      findUnique: vi.fn(async () => company()),
      findMany: vi.fn(async () => []),
    },
    transaction: {
      findUnique: vi.fn(async () => transaction()),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    qboMutationAttempt: { findMany: vi.fn(async () => []) },
    qboAccount: { findMany: vi.fn(async () => []) },
    qboTaxCode: { findMany: vi.fn(async () => []) },
    tag: { findMany: vi.fn(async () => []) },
    rule: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    ruleRevision: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    autopilotRuleCandidate: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    autopilotRuleCandidateEvidence: { findMany: vi.fn(async () => []) },
    classificationCase: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => [{ revision: 0n }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  return db;
}

describe('classification search company reads', () => {
  beforeEach(() => vi.clearAllMocks());
  it('searches only refreshed memberships and preserves canonical foreign redaction', async () => {
    const db = makeDb();
    db.membership.findMany.mockResolvedValue([
      { companyId: COMPANY_ID, role: 'categorizer' },
      { companyId: 'company-2', role: 'viewer' },
    ]);
    const classificationSearch = vi.fn(async (input: Record<string, unknown>) => ({
      query: input.query,
      companyId: COMPANY_ID,
      scope: 'accessible_companies',
      mode: 'lexical',
      requestedMode: 'lexical',
      degraded: false,
      degradedReason: null,
      status: 'matched',
      noMatch: false,
      total: 1,
      hits: [{
        id: 'rule:foreign-rule',
        sourceId: 'foreign-rule',
        kind: 'rule',
        companyId: 'company-2',
        companyName: 'Foreign member company',
        companyRelation: 'foreign',
        executable: false,
        advisory: true,
        matchedIn: ['rule', 'lexical'],
        score: 1,
        vendorIdentityId: null,
        vendorName: 'Coffee',
        action: null,
        actionSummary: {
          categoryName: 'Meals',
          taxCalculation: 'NotApplicable',
          taxCodeName: null,
          tagNames: [],
        },
        originIntent: 'make_recurring',
        evidenceCount: 0,
        conflictingEvidenceCount: 0,
        conflicts: [],
        provenance: {
          source: 'rule',
          sourceId: 'foreign-rule',
          actorId: null,
          recordedAt: '2026-01-01T00:00:00.000Z',
        },
        rationale: null,
        examples: [],
        counterexamples: [],
        jurisdiction: null,
        currency: null,
        verifiedAt: null,
        ruleRevision: 1,
      }],
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    const result = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee',
      scope: 'accessible_companies',
      mode: 'lexical',
      limit: 10,
    });

    expect(classificationSearch).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      accessibleCompanyIds: [COMPANY_ID, 'company-2'],
    }));
    expect(result.items).toEqual([
      expect.objectContaining({
        companyRelation: 'foreign',
        executable: false,
        advisory: true,
        action: null,
        actionSummary: expect.objectContaining({ categoryName: 'Meals' }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/categoryQboId|taxCodeQboId|tagIds/);
  });

  it('returns an advisory observation through the existing company read page', async () => {
    const db = makeDb();
    const classificationSearch = vi.fn(async (input: Record<string, unknown>) => ({
      query: input.query,
      companyId: COMPANY_ID,
      scope: 'current_company' as const,
      mode: 'lexical' as const,
      requestedMode: 'lexical' as const,
      degraded: false,
      degradedReason: null,
      status: 'matched' as const,
      noMatch: false,
      total: 1,
      hits: [historicalObservationHit('observation-a')],
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    const page = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'northwind', mode: 'lexical', scope: 'current_company',
    });

    expect(page.items).toEqual([expect.objectContaining({
      kind: 'historical_observation', advisory: true, executable: false, action: null,
      originIntent: null, verifiedAt: null, evidenceCount: 0,
    })]);
    expect(classificationSearch).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID, scope: 'current_company',
    }));
  });

  it('keeps concurrent principals isolated with one hundred refreshed memberships', async () => {
    const db = makeDb();
    const secondUser = 'user-2';
    const secondCompany = 'company-b';
    const firstCompanies = [
      COMPANY_ID,
      ...Array.from({ length: 99 }, (_unused, index) => `company-a-${String(index).padStart(3, '0')}`),
    ].sort();
    db.user.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id, isInstanceAdmin: false,
    }));
    db.membership.findMany.mockImplementation(async (args: { where: { userId: string } }) => (
      args.where.userId === USER_ID
        ? firstCompanies.map((companyId) => ({ companyId, role: 'viewer' }))
        : [{ companyId: secondCompany, role: 'viewer' }]
    ));
    const classificationSearch = vi.fn(async (input: Record<string, unknown>) => ({
      result: {
        query: input.query, companyId: input.companyId, scope: 'accessible_companies' as const,
        mode: 'lexical' as const, requestedMode: 'lexical' as const,
        degraded: false, degradedReason: null, status: 'no_match' as const, noMatch: true,
        total: 0, hits: [],
      },
      fingerprint: `fingerprint-${String(input.companyId)}`,
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    await Promise.all([
      service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
        query: 'Coffee', scope: 'accessible_companies', mode: 'lexical', limit: 10,
      }),
      service.searchClassificationKnowledge(secondUser, secondCompany, {
        query: 'Tea', scope: 'accessible_companies', mode: 'lexical', limit: 10,
      }),
    ]);

    expect(classificationSearch).toHaveBeenCalledTimes(2);
    expect(classificationSearch).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID, accessibleCompanyIds: firstCompanies,
    }));
    expect(classificationSearch).toHaveBeenCalledWith(expect.objectContaining({
      companyId: secondCompany, accessibleCompanyIds: [secondCompany],
    }));
  });

  it('requires actual membership for accessible-company search even for an instance admin', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ id: USER_ID, isInstanceAdmin: true });
    db.membership.findMany.mockResolvedValue([]);
    const classificationSearch = vi.fn();
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee',
      scope: 'accessible_companies',
      mode: 'lexical',
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(classificationSearch).not.toHaveBeenCalled();
  });

  it('paginates one bounded canonical search population and binds cursors to its semantics', async () => {
    const db = makeDb();
    const classificationSearch = vi.fn(async (input: Record<string, unknown>) => ({
      query: input.query,
      companyId: COMPANY_ID,
      scope: 'current_company' as const,
      mode: 'lexical' as const,
      requestedMode: 'auto' as const,
      degraded: true,
      degradedReason: 'embedding_not_configured' as const,
      status: 'matched' as const,
      noMatch: false,
      total: 3,
      hits: [classificationHit('case-3'), classificationHit('case-2'), classificationHit('case-1')],
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    const first = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'auto', limit: 2,
    });
    const second = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'auto', limit: 2, cursor: first.nextCursor ?? undefined,
    });

    expect(first).toMatchObject({
      degraded: true,
      degradedReason: 'embedding_not_configured',
      items: [{ id: 'case-3' }, { id: 'case-2' }],
      total: 3,
    });
    expect(second).toMatchObject({ items: [{ id: 'case-1' }], nextCursor: null });
    expect(classificationSearch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: 'current_company', mode: 'auto', limit: 100,
      accessibleCompanyIds: [COMPANY_ID],
    }));
    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Different', mode: 'auto', cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(classificationSearch).toHaveBeenCalledTimes(2);
  });

  it('derives owned transaction context and excludes the selected transaction from canonical search', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(transaction({
      id: 'transaction-selected',
      amount: -12.34,
      bankAccount: 'Synthetic operating card',
      rawData: { CurrencyRef: { value: 'CAD' } },
      date: new Date('2026-08-30T00:00:00.000Z'),
      revision: 7,
    }));
    const classificationSearch = vi.fn(async (input: Record<string, unknown>) => ({
      query: input.query,
      companyId: COMPANY_ID,
      scope: 'current_company' as const,
      mode: 'lexical' as const,
      requestedMode: 'auto' as const,
      degraded: false,
      degradedReason: null,
      status: 'no_match' as const,
      noMatch: true,
      total: 0,
      hits: [],
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'synthetic fuel', mode: 'auto', transactionId: 'transaction-selected', limit: 20,
    });

    expect(classificationSearch).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      scope: 'current_company',
      mode: 'auto',
      excludeTransactionId: 'transaction-selected',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic operating card',
        currency: 'CAD',
        transactionPeriod: '2026-08',
      },
    }));
  });

  it('does not search when the selected transaction belongs to another company', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(transaction({
      id: 'transaction-selected',
      companyId: 'company-other',
    }));
    const classificationSearch = vi.fn();
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'synthetic fuel', mode: 'auto', transactionId: 'transaction-selected', limit: 20,
    })).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    expect(classificationSearch).not.toHaveBeenCalled();
  });

  it('translates explicit semantic unavailability without exposing its private reason', async () => {
    const db = makeDb();
    const classificationSearch = vi.fn().mockRejectedValue(
      new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error'),
    );
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'synthetic fuel', mode: 'semantic', limit: 20,
    })).rejects.toMatchObject({
      status: 503,
      code: 'SEMANTIC_UNAVAILABLE',
      message: 'Semantic classification search is unavailable.',
    });
  });

  it('rejects a search cursor reused with a different selected transaction', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(transaction({ revision: 7 }));
    const canonical = {
      query: 'Coffee', companyId: COMPANY_ID, scope: 'current_company' as const,
      mode: 'lexical' as const, requestedMode: 'lexical' as const,
      degraded: false, degradedReason: null, status: 'matched' as const, noMatch: false,
      total: 2, hits: [classificationHit('case-2'), classificationHit('case-1')],
    };
    const classificationSearch = vi.fn(async () => ({ result: canonical, fingerprint: 'a'.repeat(64) }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });
    const first = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'lexical', transactionId: 'transaction-selected', limit: 1,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'lexical', transactionId: 'transaction-other', limit: 1,
      cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(classificationSearch).toHaveBeenCalledTimes(1);
  });

  it('rejects a search cursor when the authoritative corpus fingerprint changes between pages', async () => {
    const db = makeDb();
    const baseResult = {
      query: 'Coffee', companyId: COMPANY_ID, scope: 'current_company' as const,
      mode: 'lexical' as const, requestedMode: 'lexical' as const,
      degraded: false, degradedReason: null, status: 'matched' as const, noMatch: false,
      total: 3, hits: [classificationHit('case-3'), classificationHit('case-2'), classificationHit('case-1')],
    };
    const classificationSearch = vi.fn()
      .mockResolvedValueOnce({ result: baseResult, fingerprint: 'a'.repeat(64) })
      .mockResolvedValueOnce({
        result: { ...baseResult, hits: [classificationHit('case-new'), ...baseResult.hits] },
        fingerprint: 'b'.repeat(64),
      });
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });
    const first = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'lexical', limit: 2,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', mode: 'lexical', limit: 2, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('binds search cursors to the refreshed membership set and requested page size', async () => {
    const db = makeDb();
    db.membership.findMany
      .mockResolvedValueOnce([{ companyId: COMPANY_ID }, { companyId: 'company-2' }])
      .mockResolvedValueOnce([{ companyId: COMPANY_ID }]);
    const canonical = {
      query: 'Coffee', companyId: COMPANY_ID, scope: 'accessible_companies' as const,
      mode: 'lexical' as const, requestedMode: 'lexical' as const,
      degraded: false, degradedReason: null, status: 'matched' as const, noMatch: false,
      total: 2, hits: [classificationHit('case-2'), classificationHit('case-1')],
    };
    const classificationSearch = vi.fn(async () => ({ result: canonical, fingerprint: 'a'.repeat(64) }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      classificationSearch: classificationSearch as never,
    });
    const first = await service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', scope: 'accessible_companies', mode: 'lexical', limit: 1,
    });

    await expect(service.searchClassificationKnowledge(USER_ID, COMPANY_ID, {
      query: 'Coffee', scope: 'accessible_companies', mode: 'lexical', limit: 1,
      cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(classificationSearch).toHaveBeenCalledTimes(1);
  });


});
