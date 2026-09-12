import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyReadService, type CompanyReadDb } from './companyReads.js';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule affected-transaction PostgreSQL reads', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
    companyIds.clear();
    userIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seedCompany(label: string) {
    const company = await db.company.create({ data: {
      realmId: `affected-${label}-${randomUUID()}`,
      legalName: `${label} Legal`, nickname: label,
    } });
    const viewer = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } });
    companyIds.add(company.id);
    userIds.add(viewer.id);
    await db.membership.create({ data: { userId: viewer.id, companyId: company.id, role: 'viewer' } });
    const account = await db.qboAccount.create({ data: {
      companyId: company.id, qboId: `account-${label}`, name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    return { company, viewer, account };
  }

  async function seedRule(input: {
    companyId: string; accountQboId: string; matchText: string; priority: number;
    enabled?: boolean; retiredAt?: Date | null; createdAt?: Date;
    direction?: 'Purchase' | 'Deposit' | null;
  }) {
    const rule = await db.rule.create({ data: {
      companyId: input.companyId, matchText: input.matchText, priority: input.priority,
      category: 'Meals', categoryQboId: input.accountQboId, taxCalculation: 'NotApplicable',
      direction: input.direction === undefined ? 'Purchase' : input.direction, canonicalVersion: 2,
      enabled: input.retiredAt ? false : input.enabled ?? true, retiredAt: input.retiredAt ?? null, revision: 1,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    } });
    await db.ruleRevision.create({ data: {
      companyId: input.companyId, ruleId: rule.id, revision: 1,
      state: rule.retiredAt ? 'retired' : rule.enabled ? 'enabled' : 'disabled',
      matchText: input.matchText, priority: input.priority, category: 'Meals',
      categoryQboId: input.accountQboId, taxCalculation: 'NotApplicable', autoPost: false,
      direction: input.direction === undefined ? 'Purchase' : input.direction, canonicalVersion: 2,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.retiredAt === null || input.retiredAt === undefined ? {} : { retiredAt: input.retiredAt }),
    } });
    return rule;
  }

  async function seedTransaction(input: {
    companyId: string; label: string; payee: string; status: 'PENDING' | 'POSTED' | 'DRY_RUN'; date: Date;
    qboType?: 'Purchase' | 'Deposit' | 'JournalEntry';
  }) {
    return db.transaction.create({ data: {
      companyId: input.companyId, qboId: `affected-${input.label}-${randomUUID()}`,
      qboType: input.qboType ?? 'Purchase', qboSyncToken: '7', date: input.date, payee: input.payee,
      memo: `${input.label} memo`, amount: '-12.34', bankAccount: 'Operating', status: input.status,
    } });
  }

  it('paginates only current-company transactions matched by the current rule, with independent counts and winners', async () => {
    const current = await seedCompany('current');
    const foreign = await seedCompany('foreign');
    await db.membership.create({ data: { userId: current.viewer.id, companyId: foreign.company.id, role: 'viewer' } });
    const rule = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Coffee', priority: 1,
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
    });
    const winner = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Coffee Roasters', priority: 0,
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    const newestMatched = await seedTransaction({
      companyId: current.company.id, label: 'newest', payee: 'COFFEE ROASTERS', status: 'POSTED',
      date: new Date('2026-09-03T00:00:00.000Z'),
    });
    const pendingMatched = await seedTransaction({
      companyId: current.company.id, label: 'pending', payee: 'Coffee House', status: 'PENDING',
      date: new Date('2026-09-02T00:00:00.000Z'),
    });
    const dryRunMatched = await seedTransaction({
      companyId: current.company.id, label: 'dry-run', payee: 'Coffee Stand', status: 'DRY_RUN',
      date: new Date('2026-09-01T00:00:00.000Z'),
    });
    await seedTransaction({
      companyId: current.company.id, label: 'unmatched', payee: 'Tea House', status: 'POSTED',
      date: new Date('2026-09-04T00:00:00.000Z'),
    });
    const foreignMatched = await seedTransaction({
      companyId: foreign.company.id, label: 'foreign', payee: 'Coffee House', status: 'POSTED',
      date: new Date('2026-09-04T00:00:00.000Z'),
    });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'affected-read-pg-cursor-secret');

    const first = await reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'all', limit: 1,
    });
    expect(first).toMatchObject({ matchedCount: 3, pendingCount: 1, processedCount: 2 });
    expect(first.items).toEqual([expect.objectContaining({
      transactionId: newestMatched.id, status: 'POSTED', ruleWins: false, winningRuleId: winner.id,
      qboType: 'Purchase', qboId: newestMatched.qboId, amountCents: -1234,
    })]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'all', limit: 1, cursor: first.nextCursor!,
    });
    expect(second.items).toEqual([expect.objectContaining({
      transactionId: pendingMatched.id, status: 'PENDING', ruleWins: true, winningRuleId: rule.id,
    })]);
    expect([...first.items, ...second.items]).not.toContainEqual(expect.objectContaining({
      transactionId: foreignMatched.id,
    }));

    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'pending', limit: 10,
    })).resolves.toMatchObject({ items: [expect.objectContaining({ transactionId: pendingMatched.id })] });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'processed', limit: 10,
    })).resolves.toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ transactionId: newestMatched.id, status: 'POSTED' }),
      expect.objectContaining({ transactionId: dryRunMatched.id, status: 'DRY_RUN' }),
    ]) });
  });

  it('keeps disabled and retired current rules browseable', async () => {
    const current = await seedCompany('retained');
    const transaction = await seedTransaction({
      companyId: current.company.id, label: 'retained', payee: 'Archived Coffee', status: 'POSTED',
      date: new Date('2026-09-01T00:00:00.000Z'),
    });
    const disabled = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Coffee', priority: 0,
      enabled: false,
    });
    const retired = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Coffee', priority: 1,
      retiredAt: new Date('2026-09-01T01:00:00.000Z'),
    });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'affected-retained-pg-cursor-secret');

    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, disabled.id, { limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ transactionId: transaction.id })] });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, retired.id, { limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ transactionId: transaction.id })] });
  });

  it('uses literal Unicode matching and direction before choosing the newest equal-priority winner', async () => {
    const current = await seedCompany('canonical');
    const rule = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId,
      matchText: 'Café ß.', priority: 0, createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const winner = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId,
      matchText: 'CAFÉ SS.', priority: 0, createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, direction: 'Deposit',
      matchText: 'Café ß.', priority: 0, createdAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    const matched = await seedTransaction({
      companyId: current.company.id, label: 'purchase', payee: '  Cafe\u0301\t SS. branch  ',
      status: 'PENDING', date: new Date('2026-09-04T00:00:00.000Z'),
    });
    for (const qboType of ['Deposit', 'JournalEntry'] as const) {
      await seedTransaction({ companyId: current.company.id, label: qboType, qboType,
        payee: 'Café ß.', status: 'PENDING', date: new Date('2026-09-04T00:00:00.000Z') });
    }
    await seedTransaction({ companyId: current.company.id, label: 'punctuation',
      payee: 'Café SSx', status: 'PENDING', date: new Date('2026-09-04T00:00:00.000Z') });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'affected-canonical-pg-cursor-secret');
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {}))
      .resolves.toMatchObject({ matchedCount: 1, pendingCount: 1, processedCount: 0,
        items: [{ transactionId: matched.id, winningRuleId: winner.id, ruleWins: false }] });
  });

  it('binds affected cursors to actor, company, rule, filter, limit, and the rule lifecycle population', async () => {
    const current = await seedCompany('fence');
    const otherViewer = await db.user.create({ data: { email: `affected-other-${randomUUID()}@example.test` } });
    userIds.add(otherViewer.id);
    await db.membership.create({ data: { userId: otherViewer.id, companyId: current.company.id, role: 'viewer' } });
    const foreign = await seedCompany('fence-foreign');
    await db.membership.create({ data: { userId: current.viewer.id, companyId: foreign.company.id, role: 'viewer' } });
    const rule = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Coffee', priority: 0,
    });
    const otherRule = await seedRule({
      companyId: current.company.id, accountQboId: current.account.qboId, matchText: 'Tea', priority: 1,
    });
    await seedTransaction({
      companyId: current.company.id, label: 'first', payee: 'Coffee One', status: 'PENDING',
      date: new Date('2026-09-02T00:00:00.000Z'),
    });
    await seedTransaction({
      companyId: current.company.id, label: 'second', payee: 'Coffee Two', status: 'PENDING',
      date: new Date('2026-09-01T00:00:00.000Z'),
    });
    const reads = createCompanyReadService(db as unknown as CompanyReadDb, 'affected-fence-pg-cursor-secret');

    const page = await reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'pending', limit: 1,
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(reads.listRuleAffectedTransactions(otherViewer.id, current.company.id, rule.id, {
      status: 'pending', limit: 1, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, foreign.company.id, rule.id, {
      status: 'pending', limit: 1, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, otherRule.id, {
      status: 'pending', limit: 1, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'processed', limit: 1, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'pending', limit: 2, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    await db.ruleLifecycleRevision.upsert({
      where: { companyId: current.company.id }, create: { companyId: current.company.id, revision: 1n }, update: {},
    });
    await db.ruleLifecycleRevision.update({
      where: { companyId: current.company.id }, data: { revision: { increment: 1 } },
    });
    await expect(reads.listRuleAffectedTransactions(current.viewer.id, current.company.id, rule.id, {
      status: 'pending', limit: 1, cursor: page.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
