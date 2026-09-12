import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const observed = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('../lib/prisma.js', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  prisma.$on('query', (event) => { observed.queries.push(event.query); });
  return { prisma };
});
vi.mock('./instanceSettings.js', () => ({ getInstanceSettings: async () => ({ suggestionSource: 'off' }) }));
import { prisma } from '../lib/prisma.js';
import { suggestForMany } from './suggestions.js';
const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describePostgres('canonical suggestion reads on PostgreSQL', () => {
  const companies: string[] = [];
  afterEach(async () => { await prisma.company.deleteMany({ where: { id: { in: companies.splice(0) } } }); });
  afterAll(async () => { await prisma.$disconnect(); });
  async function fixture(count = 1) {
    const suffix = randomUUID();
    const company = await prisma.company.create({ data: { realmId: `read-${suffix}`, legalName: 'Synthetic read company', nickname: `read-${suffix}`, ruleRuntimeMode: 'canonical', holdingAccountIds: ['holding'] } });
    companies.push(company.id);
    await prisma.qboAccount.createMany({ data: ['expense', 'holding'].map((qboId) => ({ companyId: company.id, qboId, name: qboId, fullName: qboId, classification: 'Expenses', active: true })) });
    await prisma.rule.createMany({ data: Array.from({ length: count }, (_, index) => ({ id: `rule-${suffix}-${index}`, companyId: company.id, matchText: 'Synthetic vendor', category: 'expense', categoryQboId: 'expense', taxCalculation: 'NotApplicable', canonicalVersion: 2, direction: 'Purchase' as const, enabled: true, revision: 1, priority: index })) });
    const input = [{ payee: 'Synthetic vendor', qboType: 'Purchase', amount: -10 }];
    return { company, input };
  }
  it('serves a rule suggestion while the company mutation fence is held', async () => {
    const f = await fixture();
    let unlock!: () => void;
    const released = new Promise<void>((resolve) => { unlock = resolve; });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 880217))', f.company.id);
      markLocked(); await released;
    });
    await locked;
    const read = suggestForMany(f.company.id, f.input);
    try {
      const result = await Promise.race([read.then(() => 'read'), new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1_000))]);
      expect(result).toBe('read');
    } finally { unlock(); await holder; await read; }
  });
  it('omits invalid references without disabling a rule or writing policy from a read', async () => {
    const f = await fixture();
    await prisma.rule.updateMany({ where: { companyId: f.company.id }, data: { categoryQboId: 'holding' } });
    observed.queries.length = 0;
    expect(await suggestForMany(f.company.id, f.input)).toEqual([null]);
    expect(observed.queries.filter((query) => /^\s*(?:UPDATE|INSERT|DELETE)\b/iu.test(query))).toEqual([]);
    expect(await prisma.rule.findFirstOrThrow({ where: { companyId: f.company.id } })).toMatchObject({ enabled: true, reviewRequiredAt: null });
  });
  it('loads one reference snapshot for hundreds of rules and notices reference drift on the next read', async () => {
    const small = await fixture();
    observed.queries.length = 0;
    expect((await suggestForMany(small.company.id, small.input))[0]).toMatchObject({ source: 'rule', version: 2 });
    const smallCount = observed.queries.length;
    const large = await fixture(200);
    observed.queries.length = 0;
    expect((await suggestForMany(large.company.id, large.input))[0]).toMatchObject({ source: 'rule', version: 2 });
    expect(observed.queries.length).toBeLessThanOrEqual(smallCount + 1);
    expect(observed.queries.length).toBeLessThanOrEqual(12);
    await prisma.qboAccount.updateMany({ where: { companyId: large.company.id, qboId: 'expense' }, data: { active: false } });
    expect(await suggestForMany(large.company.id, large.input)).toEqual([null]);
  });
  it.each(['Purchase', 'Deposit'] as const)('revalidates %s category, tag and directional tax facts on each read', async (direction) => {
    const f = await fixture();
    await prisma.company.update({ where: { id: f.company.id }, data: { taxSupportStatus: 'ready', taxUsingSalesTax: true } });
    await prisma.qboAccount.updateMany({ where: { companyId: f.company.id, qboId: 'expense' }, data: { classification: direction === 'Purchase' ? 'Expenses' : 'Income' } });
    const tag = await prisma.tag.create({ data: { companyId: f.company.id, name: 'Synthetic accounting tag', color: '#334455' } });
    const rule = await prisma.rule.findFirstOrThrow({ where: { companyId: f.company.id } });
    await prisma.ruleTag.create({ data: { ruleId: rule.id, tagId: tag.id } });
    await prisma.qboTaxRate.create({ data: { companyId: f.company.id, qboId: 'rate', name: 'Synthetic six percent', rateValue: 6, active: true } });
    const rates = [{ taxRateQboId: 'rate', taxTypeApplicable: 'TaxOnAmount' }];
    await prisma.qboTaxCode.create({ data: { companyId: f.company.id, qboId: 'tax', name: 'Synthetic tax', active: true, taxable: true, purchaseTaxRateList: direction === 'Purchase' ? rates : [], salesTaxRateList: direction === 'Deposit' ? rates : [] } });
    await prisma.rule.update({ where: { id: rule.id }, data: { direction, taxCalculation: 'TaxExcluded', taxCodeQboId: 'tax' } });
    const input = [{ ...f.input[0], qboType: direction }];
    expect((await suggestForMany(f.company.id, input))[0]).toMatchObject({ action: { direction, taxCodeQboId: 'tax', tagIds: [tag.id] } });
    await prisma.qboTaxRate.updateMany({ where: { companyId: f.company.id }, data: { active: false } });
    expect(await suggestForMany(f.company.id, input)).toEqual([null]);
    await prisma.qboTaxRate.updateMany({ where: { companyId: f.company.id }, data: { active: true } });
    await prisma.qboTaxCode.updateMany({ where: { companyId: f.company.id }, data: { purchaseTaxRateList: direction === 'Purchase' ? [] : rates, salesTaxRateList: direction === 'Deposit' ? [] : rates } });
    expect(await suggestForMany(f.company.id, input)).toEqual([null]);
    expect(await prisma.rule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ enabled: true, revision: 1 });
  });

});
