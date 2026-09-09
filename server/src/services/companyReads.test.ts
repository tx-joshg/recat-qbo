import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  createCompanyReadService,
  getCompany,
  getTransaction,
  listCategories,
  listCompanies,
  listRules,
  listTags,
  listTaxCodes,
  listTransactions,
  listTransferCandidates,
  type CompanyReadDb,
} from './companyReads.js';
import {
  MAX_TRANSFER_DISCOVERY_TRANSACTIONS,
} from './transferCandidates.js';

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

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ id: USER_ID, isInstanceAdmin: false })),
      findMany: vi.fn(async () => []),
    },
    membership: {
      findUnique: vi.fn(async () => ({ role: 'categorizer' })),
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
    rule: { findMany: vi.fn(async () => []) },
  };
  return db;
}

describe('company read services', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes proven Purchase source gross separately from the mirrored net without raw QBO data', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(transaction({
      amount: -100,
      rawData: {
        Id: '1001', SyncToken: '1', TxnDate: '2026-01-03',
        PaymentType: 'Cash', AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive', TotalAmt: 112,
        Line: [{ Id: '1', Amount: 100, DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding-1' }, TaxCodeRef: { value: 'tax-1' }, TaxInclusiveAmt: 112 } }],
        TxnTaxDetail: { TotalTax: 12 },
      },
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);
    const result = await service.getTransaction(USER_ID, COMPANY_ID, 'txn-1');
    expect(result).toMatchObject({ amount: -100, sourceGrossCents: -11200 });
    expect(result).not.toHaveProperty('rawData');
  });

  it('omits source gross when the raw Purchase belongs to a different provider transaction', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(transaction({
      amount: -100,
      rawData: {
        Id: 'different-purchase', SyncToken: '1', TxnDate: '2026-01-03',
        PaymentType: 'Cash', AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive', TotalAmt: 112,
        Line: [{ Id: '1', Amount: 100, DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: 'holding-1' }, TaxCodeRef: { value: 'tax-1' }, TaxInclusiveAmt: 112 } }],
        TxnTaxDetail: { TotalTax: 12 },
      },
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);
    const result = await service.getTransaction(USER_ID, COMPANY_ID, 'txn-1');
    expect(result).not.toHaveProperty('sourceGrossCents');
    expect(result).not.toHaveProperty('rawData');
  });

  it('exports every bounded read operation', () => {
    expect([
      createCompanyReadService,
      listCompanies,
      getCompany,
      listTransactions,
      getTransaction,
      listCategories,
      listTaxCodes,
      listTags,
      listRules,
      listTransferCandidates,
    ]).toHaveLength(10);
  });

  it('refreshes the current user and membership on every call, and hides a guessed company', async () => {
    const db = makeDb();
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await expect(service.getCompany(USER_ID, COMPANY_ID)).resolves.toMatchObject({ id: COMPANY_ID });
    db.membership.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.getCompany(USER_ID, COMPANY_ID)).rejects.toMatchObject({
      status: 404,
      code: 'COMPANY_NOT_FOUND',
    });

    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(db.membership.findUnique).toHaveBeenCalledTimes(2);
  });

  it('lets a freshly loaded instance admin read any existing company without membership', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ id: USER_ID, isInstanceAdmin: true });
    db.membership.findUnique.mockRejectedValue(new Error('membership must not be queried'));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await expect(service.getCompany(USER_ID, COMPANY_ID)).resolves.toMatchObject({ id: COMPANY_ID });
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });

  it('lets viewers list and get non-queue transactions while hiding queue-only statuses', async () => {
    const db = makeDb();
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    db.transaction.findMany.mockResolvedValue([
      transaction({ id: 'pending', status: 'PENDING' }),
      transaction({ id: 'posting', status: 'POSTING' }),
      transaction({ id: 'error', status: 'ERROR' }),
      transaction({ id: 'posted', status: 'POSTED' }),
      transaction({ id: 'dry-run', status: 'DRY_RUN' }),
      transaction({ id: 'reverted', status: 'REVERTED' }),
    ]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    const page = await service.listTransactions(USER_ID, COMPANY_ID);
    expect(page.items.map((item) => item.id)).toEqual(['posted', 'dry-run', 'reverted']);

    db.transaction.findUnique.mockResolvedValueOnce(transaction({ id: 'posted', status: 'POSTED' }));
    await expect(service.getTransaction(USER_ID, COMPANY_ID, 'posted')).resolves.toMatchObject({
      id: 'posted',
      status: 'POSTED',
    });
    db.transaction.findUnique.mockResolvedValueOnce(transaction({ id: 'pending', status: 'PENDING' }));
    await expect(service.getTransaction(USER_ID, COMPANY_ID, 'pending')).rejects.toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  it('still restricts viewer category, rule, and transfer reads but permits tax codes and tags', async () => {
    const db = makeDb();
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    const getTaxReadiness = vi.fn(async () => ({
      status: 'ready' as const,
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-01-01T00:00:00.000Z',
      taxCodes: [],
    }));
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      SECRET,
      { getTaxReadiness },
    );

    for (const read of [
      () => service.listCategories(USER_ID, COMPANY_ID),
      () => service.listRules(USER_ID, COMPANY_ID),
      () => service.listTransferCandidates(USER_ID, COMPANY_ID),
    ]) {
      await expect(read()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    await expect(service.listTaxCodes(USER_ID, COMPANY_ID)).resolves.toMatchObject({ items: [], nextCursor: null });
    await expect(service.listTags(USER_ID, COMPANY_ID)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('returns current tax readiness and only active eligible purchase codes before paging', async () => {
    const db = makeDb();
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    const getTaxReadiness = vi.fn(async () => ({
      status: 'needs_setup' as const,
      reason: 'Tax setup is incomplete',
      usingSalesTax: false,
      refreshedAt: '2026-01-05T00:00:00.000Z',
      taxCodes: [
        { qboId: 'A', name: 'Inactive', active: false, taxable: true, combinedPurchaseRate: 5 },
        { qboId: 'B', name: 'Broken taxable', active: true, taxable: true, combinedPurchaseRate: null },
        { qboId: 'C', name: 'Eligible taxable', active: true, taxable: true, combinedPurchaseRate: 5 },
        { qboId: 'D', name: 'Eligible exempt', active: true, taxable: false, combinedPurchaseRate: null },
      ],
    }));
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      SECRET,
      { getTaxReadiness },
    );

    await expect(service.listTaxCodes(USER_ID, COMPANY_ID)).resolves.toEqual({
      status: 'needs_setup',
      reason: 'Tax setup is incomplete',
      usingSalesTax: false,
      refreshedAt: '2026-01-05T00:00:00.000Z',
      items: [
        { qboId: 'C', name: 'Eligible taxable', active: true, taxable: true, combinedPurchaseRate: 5 },
        { qboId: 'D', name: 'Eligible exempt', active: true, taxable: false, combinedPurchaseRate: null },
      ],
      nextCursor: null,
    });
    expect(getTaxReadiness).toHaveBeenCalledWith(COMPANY_ID);
    expect(db.qboTaxCode.findMany).not.toHaveBeenCalled();
  });

  it('enforces default 20, accepts 1 and 100, and rejects 101 before querying data', async () => {
    const db = makeDb();
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await service.listCompanies(USER_ID);
    expect(db.company.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: DEFAULT_READ_LIMIT + 1 }));
    await service.listCompanies(USER_ID, { limit: 1 });
    expect(db.company.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }));
    await service.listCompanies(USER_ID, { limit: MAX_READ_LIMIT });
    expect(db.company.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: MAX_READ_LIMIT + 1 }));
    const calls = db.company.findMany.mock.calls.length;
    await expect(service.listCompanies(USER_ID, { limit: 101 })).rejects.toMatchObject({ status: 400 });
    expect(db.company.findMany).toHaveBeenCalledTimes(calls);
  });

  it('includes each company current effective role and never selects encrypted credentials', async () => {
    const db = makeDb();
    db.company.findMany
      .mockResolvedValueOnce([company({ memberships: [{ role: 'viewer' }] })])
      .mockResolvedValueOnce([company({ memberships: [{ role: 'admin' }] })]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await expect(service.listCompanies(USER_ID)).resolves.toMatchObject({
      items: [{ id: COMPANY_ID, role: 'viewer' }],
    });
    await expect(service.listCompanies(USER_ID)).resolves.toMatchObject({
      items: [{ id: COMPANY_ID, role: 'admin' }],
    });
    const query = db.company.findMany.mock.calls[0]?.[0];
    expect(query).toHaveProperty('select');
    expect(JSON.stringify(query)).not.toMatch(/accessToken|refreshToken|tokenExpiresAt/);

    db.user.findUnique.mockResolvedValue({ id: USER_ID, isInstanceAdmin: true });
    db.company.findMany.mockResolvedValue([company()]);
    await expect(service.listCompanies(USER_ID)).resolves.toMatchObject({
      items: [{ id: COMPANY_ID, role: 'admin' }],
    });
  });

  it('authenticates cursors and binds them to the user, company, and filters', async () => {
    const db = makeDb();
    db.transaction.findMany.mockResolvedValueOnce([
      transaction({ id: 'txn-1', date: new Date('2026-01-01T00:00:00.000Z') }),
      transaction({ id: 'txn-2', date: new Date('2026-01-02T00:00:00.000Z') }),
    ]).mockResolvedValueOnce([
      { id: 'txn-2', date: new Date('2026-01-02T00:00:00.000Z') },
    ]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);
    const first = await service.listTransactions(USER_ID, COMPANY_ID, { limit: 1, status: 'PENDING' });
    expect(first.nextCursor).toEqual(expect.any(String));

    const cursor = first.nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    await expect(
      service.listTransactions(USER_ID, COMPANY_ID, { limit: 1, status: 'PENDING', cursor: tampered }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    await expect(
      service.listTransactions(USER_ID, COMPANY_ID, { limit: 1, status: 'ERROR', cursor }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    await expect(
      service.listTransactions(USER_ID, 'company-2', { limit: 1, status: 'PENDING', cursor }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    await expect(
      service.listTransactions('user-2', COMPANY_ID, { limit: 1, status: 'PENDING', cursor }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });

  it('strictly bounds transaction strings and calendar dates', async () => {
    const db = makeDb();
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);
    const invalid = [
      { search: 'x'.repeat(201) },
      { account: 'x'.repeat(121) },
      { startDate: '2026-1-01' },
      { startDate: '2026-02-30' },
      { startDate: '2026-02-02', endDate: '2026-02-01' },
      { status: 'UNKNOWN' },
    ];
    for (const input of invalid) {
      await expect(
        service.listTransactions(USER_ID, COMPANY_ID, input as never),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    }
    expect(db.transaction.findMany).not.toHaveBeenCalled();
  });

  it('always excludes explicit SUPERSEDED status to match the HTTP queue', async () => {
    const db = makeDb();
    db.transaction.findMany.mockResolvedValue([
      transaction({ id: 'superseded', status: 'SUPERSEDED' }),
    ]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      transferCandidates: async () => new Map(),
    });

    await expect(
      service.listTransactions(USER_ID, COMPANY_ID, { status: 'SUPERSEDED' }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('returns scoped not-found for direct SUPERSEDED gets for viewers and admins', async () => {
    const db = makeDb();
    db.transaction.findUnique.mockResolvedValue(
      transaction({ id: 'superseded', status: 'SUPERSEDED' }),
    );
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      transferCandidates: async () => new Map(),
    });

    await expect(
      service.getTransaction(USER_ID, COMPANY_ID, 'superseded'),
    ).rejects.toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' });

    db.user.findUnique.mockResolvedValue({ id: USER_ID, isInstanceAdmin: true });
    await expect(
      service.getTransaction(USER_ID, COMPANY_ID, 'superseded'),
    ).rejects.toMatchObject({ status: 404, code: 'TRANSACTION_NOT_FOUND' });
  });

  it('returns no cursor for an exactly full terminal transaction page using safe lookahead only', async () => {
    const db = makeDb();
    db.transaction.findMany
      .mockResolvedValueOnce([
        transaction({ id: 'txn-1', date: new Date('2026-01-01T00:00:00.000Z') }),
        transaction({ id: 'txn-2', date: new Date('2026-01-02T00:00:00.000Z') }),
      ])
      .mockResolvedValueOnce([]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      transferCandidates: async () => new Map(),
    });

    await expect(service.listTransactions(USER_ID, COMPANY_ID, { limit: 2 })).resolves.toMatchObject({
      items: [{ id: 'txn-1' }, { id: 'txn-2' }],
      nextCursor: null,
    });
    expect(db.transaction.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        companyId: COMPANY_ID,
        status: { not: 'SUPERSEDED' },
        OR: [
          { date: { gt: new Date('2026-01-02T00:00:00.000Z') } },
          { date: new Date('2026-01-02T00:00:00.000Z'), id: { gt: 'txn-2' } },
        ],
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: { id: true, date: true },
      take: 1,
    });
  });

  it('returns a cursor for an exactly full page when lightweight lookahead finds a later row', async () => {
    const db = makeDb();
    db.transaction.findMany
      .mockResolvedValueOnce([
        transaction({ id: 'txn-1', date: new Date('2026-01-01T00:00:00.000Z') }),
        transaction({ id: 'txn-2', date: new Date('2026-01-02T00:00:00.000Z') }),
      ])
      .mockResolvedValueOnce([
        { id: 'txn-3', date: new Date('2026-01-03T00:00:00.000Z') },
      ]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      transferCandidates: async () => new Map(),
    });

    const page = await service.listTransactions(USER_ID, COMPANY_ID, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(db.transaction.findMany.mock.calls[1])).not.toMatch(
      /qboMutationAttempts|verification|include/,
    );
  });

  it('returns empty bounded pages for every list service and a scoped 404 for missing transactions', async () => {
    const db = makeDb();
    db.company.findUnique.mockResolvedValue(company());
    db.transaction.findUnique.mockResolvedValue(null);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await expect(service.listCompanies(USER_ID)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(service.listTransactions(USER_ID, COMPANY_ID)).resolves.toEqual({
      items: [],
      nextCursor: null,
      pendingCount: 0,
    });
    for (const read of [
      service.listCategories,
      service.listTags,
      service.listRules,
      service.listTransferCandidates,
    ]) {
      await expect(read(USER_ID, COMPANY_ID)).resolves.toEqual({ items: [], nextCursor: null });
    }
    await expect(service.listTaxCodes(USER_ID, COMPANY_ID)).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    await expect(service.getTransaction(USER_ID, COMPANY_ID, 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  it('normalizes every resource without leaking company secrets or raw QBO transaction fields', async () => {
    const db = makeDb();
    db.company.findMany.mockResolvedValue([company()]);
    db.transaction.findMany
      .mockResolvedValueOnce([transaction()])
      .mockResolvedValueOnce([
        transaction({ id: 'out', amount: -50, bankAccount: 'Checking' }),
        transaction({
          id: 'in',
          qboId: '1002',
          amount: 50,
          bankAccount: 'Visa',
          date: new Date('2026-01-04T00:00:00.000Z'),
        }),
      ]);
    db.qboAccount.findMany.mockResolvedValue([{
      id: 'account-row',
      qboId: 'acct-1',
      name: 'Meals',
      fullName: 'Expenses · Meals',
      classification: 'Expenses',
      active: true,
      unsafe: 'drop',
    }]);
    db.qboTaxCode.findMany.mockResolvedValue([{
      id: 'tax-row',
      qboId: 'tax-standard',
      name: 'Standard tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: 5,
      purchaseTaxRateList: [{ secret: true }],
    }]);
    db.tag.findMany.mockResolvedValue([{
      id: 'tag-1',
      companyId: COMPANY_ID,
      name: 'Office',
      color: '#fff',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      _count: { txnTags: 3 },
      unsafe: 'drop',
    }]);
    db.rule.findMany.mockResolvedValue([{
      id: 'rule-1',
      companyId: COMPANY_ID,
      priority: 0,
      matchText: 'Coffee',
      category: 'Meals',
      categoryQboId: 'acct-1',
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      autoPost: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      createdById: 'private',
      ruleTags: [{ tagId: 'tag-1' }],
    }]);
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      SECRET,
      {
        transferCandidates: async () => new Map([
          ['out', 'in'],
          ['in', 'out'],
        ]),
      },
    );

    const results = await Promise.all([
      service.listCompanies(USER_ID),
      service.listTransactions(USER_ID, COMPANY_ID),
      service.listCategories(USER_ID, COMPANY_ID),
      service.listTaxCodes(USER_ID, COMPANY_ID),
      service.listTags(USER_ID, COMPANY_ID),
      service.listRules(USER_ID, COMPANY_ID),
      service.listTransferCandidates(USER_ID, COMPANY_ID),
    ]);
    const json = JSON.stringify(results);
    expect(json).not.toMatch(/accessToken|refreshToken|qboSyncToken|rawData|purchaseTaxRateList|createdById|unsafe/);
    expect(results.map((result) => result.items.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('projects rule review state and activation provenance through bounded reads', async () => {
    const db = makeDb();
    db.rule.findMany.mockResolvedValue([{
      id: 'rule-1',
      companyId: COMPANY_ID,
      priority: 0,
      matchText: 'Coffee',
      category: 'Meals',
      categoryQboId: 'acct-1',
      taxCalculation: null,
      taxCode: null,
      taxCodeQboId: null,
      autoPost: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      reviewRequiredAt: new Date('2026-01-02T00:00:00.000Z'),
      reviewReason: 'Verified outcomes now conflict with this learned rule.',
      ruleTags: [],
      candidateOrigin: {
        id: 'candidate-1',
        evidenceCount: 5,
        activationEvidenceCount: 3,
        schemaVersion: 'schema-v1',
        configVersion: 'config-v2',
        unsafe: 'drop',
      },
    }]);
    db.qboAccount.findMany.mockResolvedValue([{ qboId: 'acct-1', active: true }]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await expect(service.listRules(USER_ID, COMPANY_ID)).resolves.toMatchObject({
      items: [{
        reviewRequiredAt: '2026-01-02T00:00:00.000Z',
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
        origin: {
          candidateId: 'candidate-1',
          evidenceCount: 3,
          schemaVersion: 'schema-v1',
          configVersion: 'config-v2',
        },
      }],
    });
    expect(db.rule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        ruleTags: { select: { tagId: true } },
        candidateOrigin: true,
      },
    }));
  });

  it('uses live suggestions and complete transfer candidates in transaction DTOs', async () => {
    const db = makeDb();
    db.transaction.findMany.mockResolvedValue([
      transaction({ id: 'txn-1', suggestion: null }),
    ]);
    const suggestForMany = vi.fn(async () => [{
      category: 'Live meals',
      categoryQboId: 'live-account',
      source: 'rule' as const,
      ruleId: 'live-rule',
    }]);
    const transferCandidates = vi.fn(async () => new Map([['txn-1', 'txn-2']]));
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      SECRET,
      { suggestForMany, transferCandidates },
    );

    await expect(service.listTransactions(USER_ID, COMPANY_ID)).resolves.toMatchObject({
      items: [{
        id: 'txn-1',
        suggestion: { category: 'Live meals', ruleId: 'live-rule' },
        transferCandidateId: 'txn-2',
      }],
    });
  });

  it('adds bounded latest verification summaries to list and get reads without raw verification data', async () => {
    const db = makeDb();
    const rows = [
      transaction({
        id: 'verified',
        status: 'POSTED',
        qboMutationAttempts: [{
          transactionId: 'verified',
          status: 'VERIFIED',
          verification: { outcome: 'VERIFIED', status: 'POSTED', responseSnapshot: { unsafe: true } },
        }],
      }),
      transaction({
        id: 'dry',
        status: 'DRY_RUN',
        qboMutationAttempts: [{
          transactionId: 'dry',
          status: 'DRY_RUN',
          verification: { outcome: 'DRY_RUN', status: 'DRY_RUN', requestPayload: { unsafe: true } },
        }],
      }),
      transaction({
        id: 'failed',
        status: 'ERROR',
        qboMutationAttempts: [{
          transactionId: 'failed',
          status: 'RETRYABLE',
          verification: { outcome: 'RETRYABLE', message: 'private provider detail' },
        }],
      }),
      transaction({
        id: 'unknown',
        status: 'POSTED',
        qboMutationAttempts: [{
          transactionId: 'unknown',
          status: 'SOMETHING_NEW',
          verification: { outcome: 'FUTURE_VALUE', secret: 'drop' },
        }],
      }),
    ];
    db.transaction.findMany.mockResolvedValue(rows);
    db.transaction.findUnique.mockResolvedValue(rows[0]);
    db.qboMutationAttempt.findMany.mockRejectedValue(new Error('standalone attempt history query is forbidden'));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, {
      transferCandidates: async () => new Map(),
    });

    const page = await service.listTransactions(USER_ID, COMPANY_ID);
    expect(page.items.map((item) => ({
      id: item.id,
      verification: item.verification,
    }))).toEqual([
      {
        id: 'verified',
        verification: { status: 'verified', outcome: 'VERIFIED', summary: 'QuickBooks write verified.' },
      },
      {
        id: 'dry',
        verification: { status: 'dry-run', outcome: 'DRY_RUN', summary: 'Dry run only; nothing was sent.' },
      },
      {
        id: 'failed',
        verification: { status: 'failed', outcome: 'RETRYABLE', summary: 'Write did not complete.' },
      },
      {
        id: 'unknown',
        verification: { status: 'unknown', outcome: null, summary: 'Verification status is unavailable.' },
      },
    ]);
    await expect(service.getTransaction(USER_ID, COMPANY_ID, 'verified')).resolves.toMatchObject({
      verification: { status: 'verified', outcome: 'VERIFIED' },
    });
    expect(JSON.stringify(page)).not.toMatch(/unsafe|private provider detail|secret|responseSnapshot|requestPayload/);
    expect(db.qboMutationAttempt.findMany).not.toHaveBeenCalled();
    expect(db.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        qboMutationAttempts: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { status: true, verification: true },
        },
      }),
      take: 20,
    }));
  });

  it('marks rules valid only when batched current account, tax, and tag references remain usable', async () => {
    const db = makeDb();
    db.rule.findMany.mockResolvedValue([
      {
        id: 'valid-rule',
        companyId: COMPANY_ID,
        priority: 0,
        matchText: 'Coffee',
        category: 'Meals',
        categoryQboId: 'account-valid',
        taxCalculation: 'TaxExcluded',
        taxCode: 'Standard tax',
        taxCodeQboId: 'tax-valid',
        autoPost: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ruleTags: [{ tagId: 'tag-valid' }],
      },
      {
        id: 'invalid-rule',
        companyId: COMPANY_ID,
        priority: 1,
        matchText: 'Fuel',
        category: 'Vehicle',
        categoryQboId: 'account-missing',
        taxCalculation: 'TaxInclusive',
        taxCode: 'Old tax',
        taxCodeQboId: 'tax-ineligible',
        autoPost: false,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        ruleTags: [{ tagId: 'tag-missing' }],
      },
    ]);
    db.qboAccount.findMany.mockResolvedValue([
      { qboId: 'account-valid', active: true },
    ]);
    db.tag.findMany.mockResolvedValue([{ id: 'tag-valid' }]);
    const getTaxReadiness = vi.fn(async () => ({
      status: 'ready' as const,
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-01-01T00:00:00.000Z',
      taxCodes: [
        { qboId: 'tax-valid', name: 'Standard tax', active: true, taxable: true, combinedPurchaseRate: 5 },
        { qboId: 'tax-ineligible', name: 'Old tax', active: false, taxable: true, combinedPurchaseRate: 5 },
      ],
    }));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET, { getTaxReadiness });

    await expect(service.listRules(USER_ID, COMPANY_ID)).resolves.toMatchObject({
      items: [
        { id: 'valid-rule', valid: true, invalidReasons: [] },
        {
          id: 'invalid-rule',
          valid: false,
          invalidReasons: [
            'Category account is missing or inactive.',
            'Tax code is missing or ineligible.',
            'One or more tags no longer exist.',
          ],
        },
      ],
    });
    expect(db.qboAccount.findMany).toHaveBeenCalledTimes(1);
    expect(db.tag.findMany).toHaveBeenCalledTimes(1);
    expect(getTaxReadiness).toHaveBeenCalledTimes(1);
  });

  it('paginates a complete candidate set with more than 101 pairs', async () => {
    const db = makeDb();
    const rows = Array.from({ length: 150 }, (_, pairIndex) => {
      const amount = pairIndex + 1;
      return [
        transaction({
          id: `out-${String(pairIndex).padStart(3, '0')}`,
          qboId: `out-${pairIndex}`,
          amount: -amount,
          bankAccount: 'Checking',
        }),
        transaction({
          id: `in-${String(pairIndex).padStart(3, '0')}`,
          qboId: `in-${pairIndex}`,
          amount,
          bankAccount: 'Visa',
        }),
      ];
    }).flat();
    db.transaction.findMany.mockImplementation(async (args: { take?: number }) =>
      args.take === undefined ? rows : rows.slice(0, args.take));
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    const first = await service.listTransferCandidates(USER_ID, COMPANY_ID, { limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listTransferCandidates(USER_ID, COMPANY_ID, {
      limit: 100,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(50);
    expect(second.nextCursor).toBeNull();
    const discoveryCalls = db.transaction.findMany.mock.calls
      .map(([args]) => args)
      .filter((args) => (
        args as Record<string, any>
      ).select?.amount === true);
    expect(discoveryCalls).toHaveLength(2);
    for (const call of discoveryCalls) {
      expect(call).toMatchObject({
        take: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1,
        select: { id: true, amount: true, bankAccount: true, date: true },
      });
    }
  });

  it('uses the same fixed complete-discovery bound for list, get, and candidate reads', async () => {
    const db = makeDb();
    db.transaction.findMany.mockImplementation(async (args: Record<string, any>) =>
      args.select?.amount === true ? [] : []);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    await service.listTransactions(USER_ID, COMPANY_ID, { limit: 1 });
    await service.getTransaction(USER_ID, COMPANY_ID, 'txn-1');
    await service.listTransferCandidates(USER_ID, COMPANY_ID, { limit: 1 });

    const discoveryCalls = db.transaction.findMany.mock.calls
      .map(([args]) => args as Record<string, any>)
      .filter((args) => args.select?.amount === true);
    expect(discoveryCalls).toHaveLength(3);
    expect(discoveryCalls.every(
      (args) => args.take === MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1,
    )).toBe(true);
  });

  it('fails every transfer-enriched read safely when complete discovery exceeds its cap', async () => {
    const db = makeDb();
    const overflowRows = Array.from(
      { length: MAX_TRANSFER_DISCOVERY_TRANSACTIONS + 1 },
      (_, index) => ({
        id: `overflow-${index}`,
        amount: index % 2 === 0 ? -10 : 10,
        bankAccount: index % 2 === 0 ? 'Checking' : 'Visa',
        date: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    db.transaction.findMany.mockImplementation(async (args: Record<string, any>) =>
      args.select?.amount === true ? overflowRows : [transaction()]);
    const service = createCompanyReadService(db as unknown as CompanyReadDb, SECRET);

    for (const read of [
      () => service.listTransactions(USER_ID, COMPANY_ID, { limit: 1 }),
      () => service.getTransaction(USER_ID, COMPANY_ID, 'txn-1'),
      () => service.listTransferCandidates(USER_ID, COMPANY_ID, { limit: 1 }),
    ]) {
      await expect(read()).rejects.toMatchObject({
        code: 'COMPANY_UNAVAILABLE',
      });
    }
  });

  it('has a read-only static dependency graph', () => {
    const source = readFileSync(new URL('./companyReads.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/writeback|recordTransfer|qbo\/factory|qbo\/real|qbo\/mock|services\/transfers/);
  });
});
