import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { RuleLifecycleFilter, RuleLifecyclePageDto } from '@recat/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompanyReadService,
  type CompanyReadDb,
} from './companyReads.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule lifecycle collection PostgreSQL reads', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
    companyIds.clear();
    userIds.clear();
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seedRule(
    companyId: string,
    userId: string,
    accountQboId: string,
    input: {
      id?: string;
      matchText: string;
      priority: number;
      state: 'enabled' | 'disabled' | 'retired';
      createdAt?: Date;
    },
  ) {
    const retiredAt = input.state === 'retired' ? new Date('2026-08-30T03:00:00.000Z') : null;
    const rule = await db.rule.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        companyId,
        matchText: input.matchText,
        category: 'Meals',
        categoryQboId: accountQboId,
        direction: input.state === 'retired' ? null : 'Purchase',
        canonicalVersion: 2,
        taxCalculation: 'NotApplicable',
        enabled: input.state === 'enabled',
        retiredAt,
        revision: 1,
        priority: input.priority,
        originIntent: 'make_recurring',
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    await db.ruleRevision.create({
      data: {
        companyId,
        ruleId: rule.id,
        revision: 1,
        state: input.state,
        matchText: input.matchText,
        category: 'Meals',
        categoryQboId: accountQboId,
        direction: input.state === 'retired' ? null : 'Purchase',
        canonicalVersion: 2,
        taxCalculation: 'NotApplicable',
        priority: input.priority,
        autoPost: false,
        originIntent: 'make_recurring',
        changedBy: userId,
        retiredAt,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      },
    });
    return rule;
  }

  async function listLifecycle(
    service: ReturnType<typeof createCompanyReadService>,
    userId: string,
    companyId: string,
    input: { state: RuleLifecycleFilter; limit: number; cursor?: string },
  ): Promise<RuleLifecyclePageDto> {
    return service.listRuleLifecycle(userId, companyId, input);
  }

  it('rediscovers disabled and retired rules through explicit company-scoped filters', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({
      data: {
        realmId: `lifecycle-${suffix}`,
        legalName: 'Lifecycle Legal',
        nickname: 'Lifecycle',
        disconnectedAt: new Date('2026-08-31T00:00:00.000Z'),
      },
    });
    const foreign = await db.company.create({
      data: { realmId: `foreign-${suffix}`, legalName: 'Foreign Legal', nickname: 'Foreign' },
    });
    companyIds.add(company.id);
    companyIds.add(foreign.id);
    const user = await db.user.create({ data: { email: `lifecycle-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
    await db.qboAccount.createMany({ data: [company.id, foreign.id].map((companyId) => ({
      companyId, qboId: 'account-meals', name: 'Meals', fullName: 'Expenses · Meals', classification: 'Expenses',
    })) });
    const enabled = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Enabled vendor', priority: 0, state: 'enabled',
    });
    const disabled = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Disabled vendor', priority: 1, state: 'disabled',
    });
    const retired = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Retired vendor', priority: 2, state: 'retired',
    });
    await seedRule(foreign.id, user.id, 'account-meals', {
      matchText: 'Foreign vendor', priority: -1, state: 'disabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-pg-cursor-secret',
    );

    const [enabledPage, disabledPage, allPage] = await Promise.all([
      listLifecycle(service, user.id, company.id, { state: 'enabled', limit: 10 }),
      listLifecycle(service, user.id, company.id, { state: 'disabled', limit: 10 }),
      listLifecycle(service, user.id, company.id, { state: 'all', limit: 10 }),
    ]);

    expect(enabledPage.runtimeMode).toBe('legacy');
    expect(enabledPage.items.map((item) => item.revision.ruleId)).toEqual([enabled.id]);
    expect(disabledPage.items).toEqual([
      expect.objectContaining({ state: 'disabled', revision: expect.objectContaining({
        ruleId: disabled.id, state: 'disabled', revision: 1, valid: true,
      }) }),
      expect.objectContaining({ state: 'disabled', revision: expect.objectContaining({
        ruleId: retired.id, state: 'disabled', revision: 1, action: null, valid: false,
      }) }),
    ]);
    expect(allPage.items.map((item) => item.revision.ruleId)).toEqual([
      enabled.id, disabled.id, retired.id,
    ]);
    await expect(service.listRuleRevisions(user.id, company.id, retired.id)).resolves.toMatchObject({
      items: [expect.objectContaining({ revision: 1, state: 'retired' }),
        expect.objectContaining({ revision: 0, state: 'retired' })],
    });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'retired' as RuleLifecycleFilter, limit: 10,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('binds deterministic pagination to the exact actor, tenant, filter, limit, and population', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `paging-${suffix}`, legalName: 'Paging Legal', nickname: 'Paging',
      disconnectedAt: new Date('2026-08-31T00:00:00.000Z'),
    } });
    const foreign = await db.company.create({ data: {
      realmId: `paging-foreign-${suffix}`, legalName: 'Paging Foreign Legal', nickname: 'Paging Foreign',
    } });
    companyIds.add(company.id);
    companyIds.add(foreign.id);
    const user = await db.user.create({ data: { email: `paging-${suffix}@example.test` } });
    const otherUser = await db.user.create({ data: { email: `paging-other-${suffix}@example.test` } });
    userIds.add(user.id);
    userIds.add(otherUser.id);
    await db.membership.createMany({ data: [
      { userId: user.id, companyId: company.id, role: 'categorizer' },
      { userId: user.id, companyId: foreign.id, role: 'categorizer' },
      { userId: otherUser.id, companyId: company.id, role: 'categorizer' },
    ] });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    const newest = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Newest', priority: 0, state: 'disabled',
      createdAt: new Date('2026-08-30T03:00:00.000Z'),
    });
    const older = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Older', priority: 0, state: 'disabled',
      createdAt: new Date('2026-08-30T02:00:00.000Z'),
    });
    const laterPriority = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Later priority', priority: 1, state: 'disabled',
      createdAt: new Date('2026-08-30T04:00:00.000Z'),
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-paging-cursor-secret',
    );

    await expect(listLifecycle(service, user.id, company.id, {
      state: 'unknown' as RuleLifecycleFilter, limit: 1,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const first = await listLifecycle(service, user.id, company.id, { state: 'disabled', limit: 1 });
    expect(first.items.map((item) => item.revision.ruleId)).toEqual([newest.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor ?? '';

    const second = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    });
    expect(second.items.map((item) => item.revision.ruleId)).toEqual([older.id]);

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: tampered,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 2, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, otherUser.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(listLifecycle(service, user.id, foreign.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    await db.rule.update({
      where: { id: laterPriority.id },
      data: { priority: 2, revision: 2 },
    });
    await db.ruleRevision.create({ data: {
      companyId: company.id, ruleId: laterPriority.id, revision: 2, state: 'disabled',
      matchText: 'Later priority', category: 'Meals', categoryQboId: 'account-meals',
      taxCalculation: 'NotApplicable', priority: 2, autoPost: false,
      originIntent: 'make_recurring', changedBy: user.id,
    } });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('uses the rule ID as the deterministic final tie-break for equal creation times', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `tie-${suffix}`, legalName: 'Tie Legal', nickname: 'Tie',
    } });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `tie-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: company.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    const createdAt = new Date('2026-08-30T03:00:00.000Z');
    await seedRule(company.id, user.id, 'account-meals', {
      id: `rule-b-${suffix}`, matchText: 'B vendor', priority: 0, state: 'disabled', createdAt,
    });
    await seedRule(company.id, user.id, 'account-meals', {
      id: `rule-a-${suffix}`, matchText: 'A vendor', priority: 0, state: 'disabled', createdAt,
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-tie-cursor-secret',
    );

    const first = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1,
    });
    const second = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    });

    expect(first.items[0]?.revision.ruleId).toBe(`rule-a-${suffix}`);
    expect(second.items[0]?.revision.ruleId).toBe(`rule-b-${suffix}`);
  });

  it('invalidates pagination for isolated lifecycle and review drift', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `drift-${suffix}`, legalName: 'Drift Legal', nickname: 'Drift',
    } });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `drift-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: company.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    const firstRule = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'First', priority: 0, state: 'enabled',
    });
    const laterRule = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Later', priority: 1, state: 'enabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-drift-cursor-secret',
    );

    const lifecyclePage = await listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1,
    });
    expect(lifecyclePage.items[0]?.revision.ruleId).toBe(firstRule.id);
    await db.rule.update({ where: { id: laterRule.id }, data: { enabled: false } });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1, cursor: lifecyclePage.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    await db.rule.update({ where: { id: laterRule.id }, data: { enabled: true } });
    const reviewPage = await listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1,
    });
    await db.rule.update({ where: { id: laterRule.id }, data: {
      reviewRequiredAt: new Date('2026-08-31T04:00:00.000Z'),
      reviewReason: 'Reference changed.',
    } });
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'all', limit: 1, cursor: reviewPage.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('invalidates pagination when immutable RuleRevision history changes without changing Rule', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `history-drift-${suffix}`, legalName: 'History Drift Legal', nickname: 'History Drift',
    } });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `history-drift-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: company.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'First', priority: 0, state: 'disabled',
    });
    const laterRule = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Later', priority: 1, state: 'disabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-history-drift-cursor-secret',
    );
    const first = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1,
    });

    await db.ruleRevision.create({ data: {
      companyId: company.id, ruleId: laterRule.id, revision: 99, state: 'disabled',
      matchText: 'Historical only', category: 'Meals', categoryQboId: 'account-meals',
      taxCalculation: 'NotApplicable', priority: 1, autoPost: false,
      originIntent: 'make_recurring', changedBy: user.id,
    } });

    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rejects a stale cursor after its Company is deleted and recreated with the same ID and rules', async () => {
    const suffix = randomUUID();
    const companyId = `recreated-company-${suffix}`;
    const companyData = {
      id: companyId,
      realmId: `recreated-realm-${suffix}`,
      legalName: 'Recreated Legal',
      nickname: 'Recreated',
    };
    await db.company.create({ data: companyData });
    companyIds.add(companyId);
    const user = await db.user.create({ data: { email: `recreated-${suffix}@example.test` } });
    userIds.add(user.id);
    const createdAt = new Date('2026-08-30T03:00:00.000Z');
    const seedIdenticalPopulation = async () => {
      await db.membership.create({ data: {
        userId: user.id, companyId, role: 'categorizer',
      } });
      await db.qboAccount.create({ data: {
        companyId, qboId: 'account-meals', name: 'Meals',
        fullName: 'Expenses · Meals', classification: 'Expenses',
      } });
      await seedRule(companyId, user.id, 'account-meals', {
        id: `recreated-rule-a-${suffix}`, matchText: 'First', priority: 0,
        state: 'disabled', createdAt,
      });
      await seedRule(companyId, user.id, 'account-meals', {
        id: `recreated-rule-b-${suffix}`, matchText: 'Second', priority: 1,
        state: 'disabled', createdAt,
      });
    };
    await seedIdenticalPopulation();
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-company-recreation-secret',
    );
    const first = await listLifecycle(service, user.id, companyId, {
      state: 'disabled', limit: 1,
    });
    const beforeDelete = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId }, select: { revision: true },
    });

    await db.company.delete({ where: { id: companyId } });
    await db.company.create({ data: companyData });
    await seedIdenticalPopulation();
    const afterRecreate = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId }, select: { revision: true },
    });

    expect(afterRecreate.revision).toBeGreaterThan(beforeDelete.revision);
    await expect(listLifecycle(service, user.id, companyId, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rejects a stale cursor after its fence is moved to another company and back without a revision write', async () => {
    const suffix = randomUUID();
    const [companyA, companyB] = await Promise.all(['a', 'b'].map((label) => db.company.create({
      data: {
        realmId: `fence-owner-${label}-${suffix}`,
        legalName: `Fence Owner ${label.toUpperCase()} Legal`,
        nickname: `Fence Owner ${label.toUpperCase()}`,
      },
    })));
    companyIds.add(companyA.id);
    companyIds.add(companyB.id);
    const user = await db.user.create({ data: { email: `fence-owner-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: companyA.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: companyA.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    await seedRule(companyA.id, user.id, 'account-meals', {
      matchText: 'First', priority: 0, state: 'disabled',
    });
    await seedRule(companyA.id, user.id, 'account-meals', {
      matchText: 'Second', priority: 1, state: 'disabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-fence-owner-secret',
    );
    const first = await listLifecycle(service, user.id, companyA.id, {
      state: 'disabled', limit: 1,
    });
    const original = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId: companyA.id }, select: { revision: true },
    });
    await db.ruleLifecycleRevision.delete({ where: { companyId: companyB.id } });

    await db.$executeRaw`
      UPDATE "RuleLifecycleRevision"
         SET "companyId" = ${companyB.id}
       WHERE "companyId" = ${companyA.id}
    `;
    const moved = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId: companyB.id }, select: { revision: true },
    });
    await db.$executeRaw`
      UPDATE "RuleLifecycleRevision"
         SET "companyId" = ${companyA.id}
       WHERE "companyId" = ${companyB.id}
    `;
    const returned = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId: companyA.id }, select: { revision: true },
    });

    expect(moved.revision).toBeGreaterThan(original.revision);
    expect(returned.revision).toBeGreaterThan(moved.revision);
    await expect(listLifecycle(service, user.id, companyA.id, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('fails closed on a deleted fence and never revives its stale cursor after self-heal', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `self-heal-${suffix}`, legalName: 'Self Heal Legal', nickname: 'Self Heal',
    } });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `self-heal-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: company.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'First', priority: 0, state: 'disabled',
    });
    const laterRule = await seedRule(company.id, user.id, 'account-meals', {
      matchText: 'Second', priority: 1, state: 'disabled',
    });
    const service = createCompanyReadService(
      db as unknown as CompanyReadDb,
      'rule-lifecycle-self-heal-secret',
    );
    const first = await listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1,
    });
    const beforeDelete = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId: company.id }, select: { revision: true },
    });
    await db.ruleLifecycleRevision.delete({ where: { companyId: company.id } });

    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'COMPANY_UNAVAILABLE' });

    for (const priority of [2, 1, 2, 1, 2, 1]) {
      await db.rule.update({ where: { id: laterRule.id }, data: { priority } });
    }
    const afterSelfHeal = await db.ruleLifecycleRevision.findUniqueOrThrow({
      where: { companyId: company.id }, select: { revision: true },
    });
    expect(afterSelfHeal.revision).toBeGreaterThan(beforeDelete.revision);
    await expect(listLifecycle(service, user.id, company.id, {
      state: 'disabled', limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('keeps lifecycle reads bounded and set-based across thousands of rules', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `bounded-${suffix}`, legalName: 'Bounded Legal', nickname: 'Bounded',
    } });
    companyIds.add(company.id);
    const user = await db.user.create({ data: { email: `bounded-${suffix}@example.test` } });
    userIds.add(user.id);
    await db.membership.create({ data: {
      userId: user.id, companyId: company.id, role: 'categorizer',
    } });
    await db.qboAccount.create({ data: {
      companyId: company.id, qboId: 'account-meals', name: 'Meals',
      fullName: 'Expenses · Meals', classification: 'Expenses',
    } });
    const createdAt = new Date('2026-08-30T03:00:00.000Z');
    const rules = Array.from({ length: 10_001 }, (_, index) => ({
      id: `bounded-${suffix}-${String(index).padStart(5, '0')}`,
      companyId: company.id,
      matchText: `Vendor ${index}`,
      category: 'Meals',
      categoryQboId: 'account-meals',
      taxCalculation: 'NotApplicable',
      enabled: false,
      revision: 0,
      priority: index,
      originIntent: 'make_recurring',
      createdAt,
    }));
    const revisions = rules.map((rule) => ({
      id: `revision-${rule.id}`,
      companyId: company.id,
      ruleId: rule.id,
      revision: 0,
      state: 'disabled',
      matchText: rule.matchText,
      category: 'Meals',
      categoryQboId: 'account-meals',
      taxCalculation: 'NotApplicable',
      priority: rule.priority,
      autoPost: false,
      originIntent: 'make_recurring',
      changedBy: user.id,
      createdAt,
    }));
    await db.$transaction(async (tx) => {
      await tx.rule.createMany({ data: rules.slice(0, 1) });
      await tx.ruleRevision.createMany({ data: revisions.slice(0, 1) });
    });

    const measuredDb = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL! } },
      log: [{ emit: 'event', level: 'query' }],
    });
    let countQueries = false;
    let queryCount = 0;
    measuredDb.$on('query', () => { if (countQueries) queryCount += 1; });
    const service = createCompanyReadService(
      measuredDb as unknown as CompanyReadDb,
      'rule-lifecycle-bounded-cursor-secret',
    );
    try {
      const smallStartedAt = performance.now();
      countQueries = true;
      const smallPopulation = await listLifecycle(service, user.id, company.id, {
        state: 'disabled', limit: 1,
      });
      countQueries = false;
      const smallElapsedMs = performance.now() - smallStartedAt;
      const smallPopulationQueryCount = queryCount;
      queryCount = 0;

      // Bulk fixture creation fires all lifecycle triggers; keep its budget
      // separate from the unchanged measured read latency assertions below.
      await db.$transaction(async (tx) => {
        await tx.rule.createMany({ data: rules.slice(1) });
        await tx.ruleRevision.createMany({ data: revisions.slice(1) });
      }, { timeout: 60_000 });

      const largeStartedAt = performance.now();
      countQueries = true;
      const one = await listLifecycle(service, user.id, company.id, {
        state: 'disabled', limit: 1,
      });
      countQueries = false;
      const largeElapsedMs = performance.now() - largeStartedAt;
      const oneQueryCount = queryCount;
      queryCount = 0;

      countQueries = true;
      const hundred = await listLifecycle(service, user.id, company.id, {
        state: 'disabled', limit: 100,
      });
      countQueries = false;
      const hundredQueryCount = queryCount;

      expect(smallPopulation.items).toHaveLength(1);
      expect(one.items).toHaveLength(1);
      expect(hundred.items).toHaveLength(100);
      expect(JSON.stringify(hundred).length).toBeLessThan(250_000);
      // Prisma/PostgreSQL may skip one transaction bookkeeping query for the
      // single-row seed, so compare the populated reads directly and keep a
      // small absolute ceiling for both database sizes.
      expect(Math.abs(oneQueryCount - smallPopulationQueryCount)).toBeLessThanOrEqual(1);
      expect(Math.abs(hundredQueryCount - oneQueryCount)).toBeLessThanOrEqual(1);
      expect(smallPopulationQueryCount).toBeLessThanOrEqual(11);
      expect(hundredQueryCount).toBeLessThanOrEqual(11);
      expect(smallElapsedMs).toBeLessThan(5_000);
      expect(largeElapsedMs).toBeLessThan(5_000);

      type PlanNode = {
        'Node Type': string;
        'Actual Rows'?: number;
        'Relation Name'?: string;
        Plans?: PlanNode[];
      };
      const planNodes = (root: PlanNode): PlanNode[] => [
        root,
        ...(root.Plans ?? []).flatMap(planNodes),
      ];
      const fenceExplain = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `;
      const fencePlan = fenceExplain[0]?.['QUERY PLAN'][0]?.Plan;
      expect(fencePlan).toBeDefined();
      const fenceNodes = planNodes(fencePlan!);
      expect(fenceNodes.map((node) => node['Node Type'])).not.toContain('Aggregate');
      expect(fenceNodes.flatMap((node) => node['Relation Name'] ?? [])).toEqual([
        'RuleLifecycleRevision',
      ]);
      expect(fencePlan?.['Actual Rows']).toBe(1);

      const pageExplain = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT "id", "priority", "createdAt"
          FROM "Rule"
         WHERE "companyId" = ${company.id}
           AND "enabled" = false
           AND "retiredAt" IS NULL
         ORDER BY "priority" ASC, "createdAt" DESC, "id" ASC
         LIMIT 101
      `;
      const pagePlan = pageExplain[0]?.['QUERY PLAN'][0]?.Plan;
      expect(pagePlan?.['Node Type']).toBe('Limit');
      expect(pagePlan?.['Actual Rows']).toBe(101);
      expect(planNodes(pagePlan!).map((node) => node['Node Type'])).not.toContain('Aggregate');
      console.info('[rule-lifecycle-scale]', {
        rules: rules.length,
        smallElapsedMs: Number(smallElapsedMs.toFixed(2)),
        largeElapsedMs: Number(largeElapsedMs.toFixed(2)),
        queryCounts: [smallPopulationQueryCount, oneQueryCount, hundredQueryCount],
        fenceNodeTypes: fenceNodes.map((node) => node['Node Type']),
        pageRoot: pagePlan?.['Node Type'],
        pageRows: pagePlan?.['Actual Rows'],
      });

      const cursor = one.nextCursor ?? '';
      await db.rule.update({
        where: { id: rules.at(-1)!.id },
        data: { reviewRequiredAt: new Date('2026-08-31T05:00:00.000Z') },
      });
      await expect(listLifecycle(service, user.id, company.id, {
        state: 'disabled', limit: 1, cursor,
      })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    } finally {
      countQueries = false;
      await measuredDb.$disconnect();
    }
  }, 90_000);
});
