import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitRuleChange, prepareRuleChange, type RuleChangePrincipal } from './ruleChanges.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-08-31T12:00:00.000Z');

describePostgres('session rule lifecycle PostgreSQL behavior', () => {
  let db: PrismaClient;
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } }); });
  afterAll(async () => { await db?.$disconnect(); });

  async function seed() {
    const suffix = randomUUID();
    const user = await db.user.create({ data: { email: `rule-session-${suffix}@example.invalid` } });
    const company = await db.company.create({ data: {
      realmId: `rule-session-${suffix}`, legalName: 'Session Rule Fixture', nickname: suffix.slice(0, 8),
      taxSupportStatus: 'ready', taxUsingSalesTax: true,
      ruleRuntimeMode: 'canonical',
    } });
    await db.membership.create({ data: { userId: user.id, companyId: company.id, role: 'categorizer' } });
    const session = await db.session.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(NOW.getTime() + 3_600_000) } });
    const otherSession = await db.session.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(NOW.getTime() + 3_600_000) } });
    const account = await db.qboAccount.create({ data: {
      companyId: company.id, qboId: `expense-${suffix}`, name: 'Fuel', fullName: 'Expenses · Fuel', classification: 'Expenses',
    } });
    const principal: RuleChangePrincipal = { kind: 'session', sessionId: session.id, userId: user.id };
    return { user, company, session, otherSession, account, principal };
  }

  async function prepared(fixture: Awaited<ReturnType<typeof seed>>) {
    const idempotencyKey = `create-${randomUUID()}`;
    const result = await prepareRuleChange(fixture.principal, {
      companyId: fixture.company.id, mutation: 'create', expectedRevision: 0, idempotencyKey,
      proposal: {
        matchText: 'Synthetic fuel merchant', direction: 'Purchase', categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [],
        autoPost: false,
      },
    }, { db, now: () => NOW });
    return { result, idempotencyKey };
  }

  function createInput(fixture: Awaited<ReturnType<typeof seed>>, idempotencyKey: string, retryOfId?: string) {
    return {
      companyId: fixture.company.id,
      mutation: 'create' as const,
      expectedRevision: 0,
      idempotencyKey,
      ...(retryOfId === undefined ? {} : { retryOfId }),
      proposal: {
        matchText: 'Synthetic fuel merchant', direction: 'Purchase' as const, categoryQboId: fixture.account.qboId,
        taxCalculation: 'NotApplicable' as const, taxCodeQboId: null, tagIds: [],
        autoPost: false as const,
      },
    };
  }

  it('binds ownership to one real session and commits canonical readback', async () => {
    const fixture = await seed();
    const { result, idempotencyKey } = await prepared(fixture);
    const other: RuleChangePrincipal = { kind: 'session', sessionId: fixture.otherSession.id, userId: fixture.user.id };
    await expect(commitRuleChange(other, {
      companyId: fixture.company.id, operationId: result.operationId, idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) })).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });

    const committed = await commitRuleChange(fixture.principal, {
      companyId: fixture.company.id, operationId: result.operationId, idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 2_000) });
    expect(committed).toMatchObject({ status: 'COMMITTED', rule: { revision: 1, autoPost: false } });
    await expect(db.mcpRuleOperation.findUnique({ where: { id: result.operationId } })).resolves.toMatchObject({
      authKind: 'session', sessionId: fixture.session.id, tokenId: null, tokenPrefix: null,
    });
  });

  it('rejects commit after logout or categorizer-role drift without writing policy', async () => {
    const loggedOut = await seed();
    const first = await prepared(loggedOut);
    await db.session.delete({ where: { id: loggedOut.session.id } });
    await expect(commitRuleChange(loggedOut.principal, {
      companyId: loggedOut.company.id, operationId: first.result.operationId, idempotencyKey: first.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(db.rule.count({ where: { companyId: loggedOut.company.id } })).resolves.toBe(0);

    const drifted = await seed();
    const second = await prepared(drifted);
    await db.membership.update({
      where: { userId_companyId: { userId: drifted.user.id, companyId: drifted.company.id } }, data: { role: 'viewer' },
    });
    await expect(commitRuleChange(drifted.principal, {
      companyId: drifted.company.id, operationId: second.result.operationId, idempotencyKey: second.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(db.rule.count({ where: { companyId: drifted.company.id } })).resolves.toBe(0);
  });

  it('requires an actual current company membership even for an instance admin session', async () => {
    const fixture = await seed();
    await db.user.update({ where: { id: fixture.user.id }, data: { isInstanceAdmin: true } });
    await db.membership.delete({
      where: { userId_companyId: { userId: fixture.user.id, companyId: fixture.company.id } },
    });

    await expect(prepared(fixture)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(db.mcpRuleOperation.count({ where: { companyId: fixture.company.id } })).resolves.toBe(0);
  });

  it('keeps session attribution immutable after logout cleanup', async () => {
    const fixture = await seed();
    const { result } = await prepared(fixture);
    await db.session.delete({ where: { id: fixture.session.id } });
    await expect(db.mcpRuleOperation.findUnique({ where: { id: result.operationId } })).resolves.toMatchObject({
      authKind: 'session', sessionId: fixture.session.id, userId: fixture.user.id,
    });
    await expect(db.mcpRuleOperation.update({ where: { id: result.operationId }, data: { sessionId: fixture.otherSession.id } }))
      .rejects.toThrow('McpRuleOperation immutable fields cannot be changed');
  });

  it('rejects a foreign route company and disconnect or session-expiry drift without writes', async () => {
    const foreign = await seed();
    const first = await prepared(foreign);
    const otherCompany = await db.company.create({ data: {
      realmId: `rule-session-other-${randomUUID()}`, legalName: 'Other company', nickname: randomUUID().slice(0, 8),
    } });
    await db.membership.create({ data: {
      userId: foreign.user.id, companyId: otherCompany.id, role: 'categorizer',
    } });
    await expect(commitRuleChange(foreign.principal, {
      companyId: otherCompany.id, operationId: first.result.operationId, idempotencyKey: first.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await db.company.update({ where: { id: foreign.company.id }, data: { disconnectedAt: NOW } });
    await expect(commitRuleChange(foreign.principal, {
      companyId: foreign.company.id, operationId: first.result.operationId, idempotencyKey: first.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 2_000) })).rejects.toMatchObject({ code: 'COMPANY_DISCONNECTED' });
    await expect(db.rule.count({ where: { companyId: foreign.company.id } })).resolves.toBe(0);

    const expired = await seed();
    const second = await prepared(expired);
    await db.session.update({ where: { id: expired.session.id }, data: { expiresAt: NOW } });
    await expect(commitRuleChange(expired.principal, {
      companyId: expired.company.id, operationId: second.result.operationId, idempotencyKey: second.idempotencyKey,
    }, { db, now: () => new Date(NOW.getTime() + 1_000) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(db.rule.count({ where: { companyId: expired.company.id } })).resolves.toBe(0);
  });

  it('serializes same-session concurrent prepare and commit into one rule and one replay', async () => {
    const fixture = await seed();
    const idempotencyKey = `session-concurrent-${randomUUID()}`;
    const input = createInput(fixture, idempotencyKey);
    const [first, second] = await Promise.all([
      prepareRuleChange(fixture.principal, input, { db, now: () => NOW }),
      prepareRuleChange(fixture.principal, input, { db, now: () => NOW }),
    ]);
    expect(second.operationId).toBe(first.operationId);

    const committed = await Promise.all([
      commitRuleChange(fixture.principal, {
        companyId: fixture.company.id, operationId: first.operationId, idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) }),
      commitRuleChange(fixture.principal, {
        companyId: fixture.company.id, operationId: first.operationId, idempotencyKey,
      }, { db, now: () => new Date(NOW.getTime() + 1_000) }),
    ]);
    expect(committed.map(({ status }) => status).sort()).toEqual(['COMMITTED', 'REPLAYED']);
    await expect(db.rule.count({ where: { companyId: fixture.company.id } })).resolves.toBe(1);
    await expect(db.mcpRuleOperation.count({ where: {
      authKind: 'session', sessionId: fixture.session.id, companyId: fixture.company.id, idempotencyKey,
    } })).resolves.toBe(1);
  });

  it('retries an expired session create with a new key and the exact parent resource identity', async () => {
    const fixture = await seed();
    const firstKey = `session-expired-${randomUUID()}`;
    const first = await prepareRuleChange(
      fixture.principal, createInput(fixture, firstKey), { db, now: () => NOW },
    );
    const retryAt = new Date(NOW.getTime() + 16 * 60 * 1_000);
    await expect(commitRuleChange(fixture.principal, {
      companyId: fixture.company.id, operationId: first.operationId, idempotencyKey: firstKey,
    }, { db, now: () => retryAt })).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });

    const retryKey = `session-retry-${randomUUID()}`;
    const retry = await prepareRuleChange(
      fixture.principal,
      createInput(fixture, retryKey, first.operationId),
      { db, now: () => retryAt },
    );
    expect(retry.ruleId).toBe(first.ruleId);
    const committed = await commitRuleChange(fixture.principal, {
      companyId: fixture.company.id, operationId: retry.operationId, idempotencyKey: retryKey,
    }, { db, now: () => new Date(retryAt.getTime() + 1_000) });
    expect(committed).toMatchObject({ status: 'COMMITTED', ruleId: first.ruleId });
  });
});
