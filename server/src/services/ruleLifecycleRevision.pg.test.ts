import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('rule lifecycle revision PostgreSQL fence', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    companyIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fence(companyId: string): Promise<bigint> {
    const rows = await db.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision"
        FROM "RuleLifecycleRevision"
       WHERE "companyId" = ${companyId}
    `;
    return rows[0]?.revision ?? -1n;
  }

  async function generationLast(): Promise<bigint> {
    const rows = await db.$queryRaw<Array<{ last_value: bigint }>>`
      SELECT last_value FROM "RuleLifecycleGeneration_seq"
    `;
    return rows[0]?.last_value ?? -1n;
  }

  async function createRule(companyId: string, suffix: string) {
    return db.rule.create({ data: {
      id: `fence-rule-${suffix}`,
      companyId,
      matchText: 'Fence vendor',
      category: 'Meals',
      priority: 10,
    } });
  }

  it('initializes a fresh generation fence for every newly created company', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-fence-${suffix}`,
      legalName: 'Lifecycle Fence Legal',
      nickname: 'Lifecycle Fence',
    } });
    companyIds.add(company.id);

    const rows = await db.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision"
        FROM "RuleLifecycleRevision"
       WHERE "companyId" = ${company.id}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.revision).toBeGreaterThan(0n);
  });

  it('re-stamps direct fence updates and inserts instead of accepting a reused token', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-direct-stamp-${suffix}`,
      legalName: 'Lifecycle Direct Stamp Legal',
      nickname: 'Lifecycle Direct Stamp',
    } });
    companyIds.add(company.id);
    const initialized = await fence(company.id);

    await db.ruleLifecycleRevision.update({
      where: { companyId: company.id }, data: { revision: initialized },
    });
    const afterUpdate = await fence(company.id);
    expect(afterUpdate).toBeGreaterThan(initialized);

    await db.ruleLifecycleRevision.delete({ where: { companyId: company.id } });
    await db.ruleLifecycleRevision.create({
      data: { companyId: company.id, revision: initialized },
    });
    expect(await fence(company.id)).toBeGreaterThan(afterUpdate);
  });

  it('re-stamps direct fence ownership changes instead of carrying a company token across owners', async () => {
    const suffix = randomUUID();
    const [companyA, companyB] = await Promise.all(['a', 'b'].map((label) => db.company.create({
      data: {
        realmId: `lifecycle-owner-stamp-${label}-${suffix}`,
        legalName: `Lifecycle Owner Stamp ${label.toUpperCase()} Legal`,
        nickname: `Lifecycle Owner Stamp ${label.toUpperCase()}`,
      },
    })));
    companyIds.add(companyA.id);
    companyIds.add(companyB.id);
    const original = await fence(companyA.id);
    await db.ruleLifecycleRevision.delete({ where: { companyId: companyB.id } });

    await db.$executeRaw`
      UPDATE "RuleLifecycleRevision"
         SET "companyId" = ${companyB.id}
       WHERE "companyId" = ${companyA.id}
    `;
    const moved = await fence(companyB.id);
    await db.$executeRaw`
      UPDATE "RuleLifecycleRevision"
         SET "companyId" = ${companyA.id}
       WHERE "companyId" = ${companyB.id}
    `;

    expect(moved).toBeGreaterThan(original);
    expect(await fence(companyA.id)).toBeGreaterThan(moved);
  });

  it('allows ordinary trigger writes without exposing lifecycle SECURITY DEFINER helpers', async () => {
    const suffix = randomUUID();
    const roleName = `lifecycle_app_${suffix.replaceAll('-', '')}`;
    const company = await db.company.create({ data: {
      realmId: `lifecycle-privilege-${suffix}`,
      legalName: 'Lifecycle Privilege Legal',
      nickname: 'Lifecycle Privilege',
    } });
    companyIds.add(company.id);
    const rule = await createRule(company.id, suffix);
    const before = await fence(company.id);

    await db.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN`);
    try {
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
      await db.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${roleName}"`);
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`);
        await tx.$executeRaw`UPDATE "Rule" SET "priority" = 11 WHERE "id" = ${rule.id}`;
        await tx.$executeRaw`
          INSERT INTO "Rule" ("id", "companyId", "matchText", "category", "priority", "updatedAt")
          VALUES (${`restricted-role-rule-${suffix}`}, ${company.id}, 'Restricted role', 'Meals', 12, CURRENT_TIMESTAMP)
        `;
      });
      expect(await fence(company.id)).toBeGreaterThan(before);

      const privileges = await db.$queryRawUnsafe<Array<{
        stamp: boolean;
        bump: boolean;
        rule_update: boolean;
        revision_update: boolean;
        company_insert: boolean;
        rule_insert: boolean;
        rule_delete: boolean;
        revision_insert: boolean;
        revision_delete: boolean;
      }>>(`
        SELECT has_function_privilege('${roleName}', 'public.rule_lifecycle_stamp_generation()', 'EXECUTE') AS stamp,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_company_ids(text[])', 'EXECUTE') AS bump,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_changed_rule_companies()', 'EXECUTE') AS rule_update,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_changed_rule_revision_companies()', 'EXECUTE') AS revision_update,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_initialize_company()', 'EXECUTE') AS company_insert,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_new_rule_companies()', 'EXECUTE') AS rule_insert,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_old_rule_companies()', 'EXECUTE') AS rule_delete,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_new_rule_revision_companies()', 'EXECUTE') AS revision_insert,
               has_function_privilege('${roleName}', 'public.rule_lifecycle_bump_old_rule_revision_companies()', 'EXECUTE') AS revision_delete
      `);
      expect(privileges).toEqual([{
        stamp: false,
        bump: false,
        rule_update: false,
        revision_update: false,
        company_insert: false,
        rule_insert: false,
        rule_delete: false,
        revision_insert: false,
        revision_delete: false,
      }]);

      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`);
        await tx.$executeRaw`SELECT rule_lifecycle_bump_company_ids(ARRAY[${company.id}]::text[])`;
      })).rejects.toThrow(/permission denied for function rule_lifecycle_bump_company_ids/);
    } finally {
      await db.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${roleName}"`);
    }
  });

  it('bumps the company fence when a rolling old writer inserts a Rule directly', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-old-writer-${suffix}`,
      legalName: 'Lifecycle Old Writer Legal',
      nickname: 'Lifecycle Old Writer',
    } });
    companyIds.add(company.id);
    const ruleId = `legacy-rule-${suffix}`;

    await db.$executeRaw`
      INSERT INTO "Rule" ("id", "companyId", "matchText", "category", "updatedAt")
      VALUES (${ruleId}, ${company.id}, 'Legacy vendor', 'Meals', CURRENT_TIMESTAMP)
    `;

    expect(await fence(company.id)).toBeGreaterThan(0n);
    await expect(db.ruleRevision.findUnique({
      where: { companyId_ruleId_revision: { companyId: company.id, ruleId, revision: 0 } },
    })).resolves.not.toBeNull();
  });

  it('ignores unrelated/no-op Rule updates and bumps every lifecycle-visible Rule field', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-fields-${suffix}`,
      legalName: 'Lifecycle Fields Legal',
      nickname: 'Lifecycle Fields',
    } });
    companyIds.add(company.id);
    const rule = await db.rule.create({ data: {
      companyId: company.id,
      matchText: 'Original vendor',
      category: 'Meals',
      priority: 10,
    } });
    let expected = await fence(company.id);

    await db.rule.update({ where: { id: rule.id }, data: { matchText: 'Unrelated vendor edit' } });
    expect(await fence(company.id)).toBe(expected);

    await db.rule.update({ where: { id: rule.id }, data: { priority: 11 } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { revision: 1 } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { enabled: false } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      retiredAt: new Date('2026-08-31T01:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      createdAt: new Date('2026-08-30T01:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: {
      reviewRequiredAt: new Date('2026-08-31T02:00:00.000Z'),
    } });
    expect(await fence(company.id)).toBe(++expected);
    await db.rule.update({ where: { id: rule.id }, data: { reviewReason: 'References changed.' } });
    expect(await fence(company.id)).toBe(++expected);

    await db.$executeRaw`UPDATE "Rule" SET "direction" = 'Purchase' WHERE "id" = ${rule.id}`;
    expect(await fence(company.id)).toBe(++expected);
    await db.$executeRaw`UPDATE "Rule" SET "canonicalVersion" = 2 WHERE "id" = ${rule.id}`;
    expect(await fence(company.id)).toBe(++expected);
    await db.$executeRaw`UPDATE "Rule" SET "repairReason" = 'Review direction' WHERE "id" = ${rule.id}`;
    expect(await fence(company.id)).toBe(++expected);
    await db.$executeRaw`UPDATE "Rule" SET "affectedJournalEntryCount" = 2 WHERE "id" = ${rule.id}`;
    expect(await fence(company.id)).toBe(++expected);
  });

  it('fences RuleRevision changes and direct deletes without losing immutable history protections', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-history-${suffix}`,
      legalName: 'Lifecycle History Legal',
      nickname: 'Lifecycle History',
    } });
    companyIds.add(company.id);
    const rule = await createRule(company.id, suffix);
    let expected = await fence(company.id);

    await db.ruleRevision.create({ data: {
      companyId: company.id,
      ruleId: rule.id,
      revision: 7,
      state: 'enabled',
      matchText: 'Historical snapshot',
      category: 'Meals',
      priority: 10,
      autoPost: false,
    } });
    expect(await fence(company.id)).toBe(++expected);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.$executeRaw`UPDATE "RuleRevision" SET "changedBy" = "changedBy" WHERE "id" = ${`rule-revision-${rule.id}`}`;
      expect(await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `).toEqual([{ revision: expected }]);
      await tx.$executeRaw`UPDATE "RuleRevision" SET "changedBy" = 'legacy-writer' WHERE "id" = ${`rule-revision-${rule.id}`}`;
      expect(await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `).toEqual([{ revision: ++expected }]);
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Rule" DISABLE TRIGGER "Rule_no_delete"');
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.delete({ where: { id: rule.id } });
      const rows = await tx.$queryRaw<Array<{ revision: bigint }>>`
        SELECT "revision" FROM "RuleLifecycleRevision" WHERE "companyId" = ${company.id}
      `;
      expect(rows[0]?.revision).toBeGreaterThan(expected);
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "Rule" ENABLE TRIGGER "Rule_no_delete"');
    });
  });

  it('removes the lifecycle fence only with its owning company cascade', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-cascade-${suffix}`,
      legalName: 'Lifecycle Cascade Legal',
      nickname: 'Lifecycle Cascade',
    } });
    companyIds.add(company.id);
    await createRule(company.id, suffix);

    await db.company.delete({ where: { id: company.id } });

    expect(await fence(company.id)).toBe(-1n);
  });

  it('acquires Rule lifecycle fences in sorted order across concurrent multi-company writes without deadlock', async () => {
    const suffix = randomUUID();
    const companies = await Promise.all(['a', 'b'].map((label) => db.company.create({ data: {
      realmId: `lifecycle-concurrency-${label}-${suffix}`,
      legalName: `Lifecycle Concurrency ${label.toUpperCase()} Legal`,
      nickname: `Lifecycle Concurrency ${label.toUpperCase()}`,
    } })));
    companies.forEach((company) => companyIds.add(company.id));
    const [companyA, companyB] = companies;
    const ruleA1 = await createRule(companyA!.id, `${suffix}-writer-a-00`);
    const ruleB1 = await createRule(companyB!.id, `${suffix}-writer-a-99`);
    const ruleB2 = await createRule(companyB!.id, `${suffix}-writer-b-00`);
    const ruleA2 = await createRule(companyA!.id, `${suffix}-writer-b-99`);
    const beforeA = await fence(companyA!.id);
    const beforeB = await fence(companyB!.id);
    const sequenceBefore = await generationLast();
    const writerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    const writerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    let audit: Array<{ writer: string; surface: string; companyId: string }> = [];

    try {
      await db.$executeRawUnsafe(`
        CREATE TABLE "RuleLifecycleOrderAudit" (
          "ordinal" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "writer" TEXT NOT NULL,
          "surface" TEXT NOT NULL,
          "companyId" TEXT NOT NULL
        )
      `);
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_rule_source_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE writer_id TEXT := current_setting('recat.lifecycle_test_writer', true);
        BEGIN
          IF COALESCE(writer_id, '') <> '' THEN
            INSERT INTO "RuleLifecycleOrderAudit" ("writer", "surface", "companyId")
            VALUES (writer_id, 'source', NEW."companyId");
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER aa_rule_lifecycle_source_audit
        AFTER UPDATE ON "Rule"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_rule_source_audit()
      `);
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_fence_order_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE writer_id TEXT := current_setting('recat.lifecycle_test_writer', true);
        BEGIN
          IF COALESCE(writer_id, '') <> '' THEN
            INSERT INTO "RuleLifecycleOrderAudit" ("writer", "surface", "companyId")
            VALUES (writer_id, 'fence', NEW."companyId");
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER rule_lifecycle_fence_order_audit
        AFTER UPDATE ON "RuleLifecycleRevision"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_fence_order_audit()
      `);
      await db.$executeRawUnsafe('CREATE SEQUENCE "RuleLifecycleRuleTestBarrier_seq" CACHE 1');
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_rule_test_barrier()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          arrivals BIGINT;
          deadline TIMESTAMPTZ := clock_timestamp() + interval '2 seconds';
        BEGIN
          IF current_setting('recat.lifecycle_test_barrier', true) = 'rule'
             AND COALESCE(current_setting('recat.lifecycle_test_barrier_seen', true), '') <> 'rule' THEN
            PERFORM set_config('recat.lifecycle_test_barrier_seen', 'rule', true);
            PERFORM nextval('"RuleLifecycleRuleTestBarrier_seq"'::regclass);
            LOOP
              SELECT last_value INTO arrivals FROM "RuleLifecycleRuleTestBarrier_seq";
              EXIT WHEN arrivals >= 2;
              IF clock_timestamp() >= deadline THEN
                RAISE EXCEPTION 'Rule lifecycle test barrier timed out';
              END IF;
              PERFORM pg_sleep(0.01);
            END LOOP;
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER zz_rule_lifecycle_test_barrier
        AFTER UPDATE ON "Rule"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_rule_test_barrier()
      `);
      await Promise.all([
        writerA.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_barrier = 'rule'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_writer = 'writer-a'");
          await tx.rule.updateMany({
            where: { id: { in: [ruleA1.id, ruleB1.id] } },
            data: { priority: { increment: 1 } },
          });
        }),
        writerB.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_barrier = 'rule'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_writer = 'writer-b'");
          await tx.rule.updateMany({
            where: { id: { in: [ruleB2.id, ruleA2.id] } },
            data: { priority: { increment: 1 } },
          });
        }),
      ]);
      audit = await db.$queryRaw<Array<{
        writer: string;
        surface: string;
        companyId: string;
      }>>`
        SELECT "writer", "surface", "companyId"
          FROM "RuleLifecycleOrderAudit"
         ORDER BY "ordinal"
      `;
    } finally {
      await Promise.all([writerA.$disconnect(), writerB.$disconnect()]);
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS zz_rule_lifecycle_test_barrier ON "Rule"');
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS aa_rule_lifecycle_source_audit ON "Rule"');
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS rule_lifecycle_fence_order_audit ON "RuleLifecycleRevision"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_rule_test_barrier()');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_rule_source_audit()');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_fence_order_audit()');
      await db.$executeRawUnsafe('DROP SEQUENCE IF EXISTS "RuleLifecycleRuleTestBarrier_seq"');
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS "RuleLifecycleOrderAudit"');
    }

    // PostgreSQL does not promise row-trigger order for a multi-row UPDATE;
    // assert the source set, then assert the lifecycle fence order separately.
    expect(audit.filter((row) => row.writer === 'writer-a' && row.surface === 'source')
      .map((row) => row.companyId).sort()).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-b' && row.surface === 'source')
      .map((row) => row.companyId).sort()).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-a' && row.surface === 'fence')
      .map((row) => row.companyId)).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-b' && row.surface === 'fence')
      .map((row) => row.companyId)).toEqual([companyA!.id, companyB!.id].sort());
    expect(await fence(companyA!.id)).toBeGreaterThan(beforeA);
    expect(await fence(companyB!.id)).toBeGreaterThan(beforeB);
    expect(await generationLast()).toBe(sequenceBefore + 4n);
  });

  it('acquires RuleRevision lifecycle fences in sorted order across concurrent multi-company writes without deadlock', async () => {
    const suffix = randomUUID();
    const companies = await Promise.all(['a', 'b'].map((label) => db.company.create({ data: {
      realmId: `lifecycle-revision-concurrency-${label}-${suffix}`,
      legalName: `Lifecycle Revision Concurrency ${label.toUpperCase()} Legal`,
      nickname: `Lifecycle Revision Concurrency ${label.toUpperCase()}`,
    } })));
    companies.forEach((company) => companyIds.add(company.id));
    const [companyA, companyB] = companies;
    const ruleA1 = await createRule(companyA!.id, `${suffix}-revision-writer-a-00`);
    const ruleB1 = await createRule(companyB!.id, `${suffix}-revision-writer-a-99`);
    const ruleB2 = await createRule(companyB!.id, `${suffix}-revision-writer-b-00`);
    const ruleA2 = await createRule(companyA!.id, `${suffix}-revision-writer-b-99`);
    const beforeA = await fence(companyA!.id);
    const beforeB = await fence(companyB!.id);
    const sequenceBefore = await generationLast();
    const writerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    const writerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
    let audit: Array<{ writer: string; surface: string; companyId: string }> = [];

    try {
      await db.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await db.$executeRawUnsafe(`
        CREATE TABLE "RuleLifecycleOrderAudit" (
          "ordinal" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "writer" TEXT NOT NULL,
          "surface" TEXT NOT NULL,
          "companyId" TEXT NOT NULL
        )
      `);
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_revision_source_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE writer_id TEXT := current_setting('recat.lifecycle_test_writer', true);
        BEGIN
          IF COALESCE(writer_id, '') <> '' THEN
            INSERT INTO "RuleLifecycleOrderAudit" ("writer", "surface", "companyId")
            VALUES (writer_id, 'source', NEW."companyId");
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER aa_rule_revision_lifecycle_source_audit
        AFTER UPDATE ON "RuleRevision"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_revision_source_audit()
      `);
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_fence_order_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE writer_id TEXT := current_setting('recat.lifecycle_test_writer', true);
        BEGIN
          IF COALESCE(writer_id, '') <> '' THEN
            INSERT INTO "RuleLifecycleOrderAudit" ("writer", "surface", "companyId")
            VALUES (writer_id, 'fence', NEW."companyId");
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER rule_lifecycle_fence_order_audit
        AFTER UPDATE ON "RuleLifecycleRevision"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_fence_order_audit()
      `);
      await db.$executeRawUnsafe('CREATE SEQUENCE "RuleLifecycleRuleRevisionTestBarrier_seq" CACHE 1');
      await db.$executeRawUnsafe(`
        CREATE FUNCTION rule_lifecycle_rule_revision_test_barrier()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          arrivals BIGINT;
          deadline TIMESTAMPTZ := clock_timestamp() + interval '2 seconds';
        BEGIN
          IF current_setting('recat.lifecycle_test_barrier', true) = 'revision'
             AND COALESCE(current_setting('recat.lifecycle_test_barrier_seen', true), '') <> 'revision' THEN
            PERFORM set_config('recat.lifecycle_test_barrier_seen', 'revision', true);
            PERFORM nextval('"RuleLifecycleRuleRevisionTestBarrier_seq"'::regclass);
            LOOP
              SELECT last_value INTO arrivals FROM "RuleLifecycleRuleRevisionTestBarrier_seq";
              EXIT WHEN arrivals >= 2;
              IF clock_timestamp() >= deadline THEN
                RAISE EXCEPTION 'RuleRevision lifecycle test barrier timed out';
              END IF;
              PERFORM pg_sleep(0.01);
            END LOOP;
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER zz_rule_revision_lifecycle_test_barrier
        AFTER UPDATE ON "RuleRevision"
        FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_rule_revision_test_barrier()
      `);
      await Promise.all([
        writerA.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
          await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_tidscan = off');
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_barrier = 'revision'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_writer = 'writer-a'");
          await tx.ruleRevision.updateMany({
            where: { ruleId: { in: [ruleA1.id, ruleB1.id] }, revision: 0 },
            data: { changedBy: 'legacy-bulk-writer-a' },
          });
        }),
        writerB.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
          await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_tidscan = off');
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_barrier = 'revision'");
          await tx.$executeRawUnsafe("SET LOCAL recat.lifecycle_test_writer = 'writer-b'");
          await tx.ruleRevision.updateMany({
            where: { ruleId: { in: [ruleB2.id, ruleA2.id] }, revision: 0 },
            data: { changedBy: 'legacy-bulk-writer-b' },
          });
        }),
      ]);
      audit = await db.$queryRaw<Array<{
        writer: string;
        surface: string;
        companyId: string;
      }>>`
        SELECT "writer", "surface", "companyId"
          FROM "RuleLifecycleOrderAudit"
         ORDER BY "ordinal"
      `;
    } finally {
      await Promise.all([writerA.$disconnect(), writerB.$disconnect()]);
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS zz_rule_revision_lifecycle_test_barrier ON "RuleRevision"');
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS aa_rule_revision_lifecycle_source_audit ON "RuleRevision"');
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS rule_lifecycle_fence_order_audit ON "RuleLifecycleRevision"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_rule_revision_test_barrier()');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_revision_source_audit()');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS rule_lifecycle_fence_order_audit()');
      await db.$executeRawUnsafe('DROP SEQUENCE IF EXISTS "RuleLifecycleRuleRevisionTestBarrier_seq"');
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS "RuleLifecycleOrderAudit"');
      await db.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    }

    // Transition-table and row-trigger iteration order is deliberately not a
    // PostgreSQL contract; only the sorted fence acquisition order is one.
    expect(audit.filter((row) => row.writer === 'writer-a' && row.surface === 'source')
      .map((row) => row.companyId).sort()).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-b' && row.surface === 'source')
      .map((row) => row.companyId).sort()).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-a' && row.surface === 'fence')
      .map((row) => row.companyId)).toEqual([companyA!.id, companyB!.id].sort());
    expect(audit.filter((row) => row.writer === 'writer-b' && row.surface === 'fence')
      .map((row) => row.companyId)).toEqual([companyA!.id, companyB!.id].sort());
    expect(await fence(companyA!.id)).toBeGreaterThan(beforeA);
    expect(await fence(companyB!.id)).toBeGreaterThan(beforeB);
    expect(await generationLast()).toBe(sequenceBefore + 4n);
  });

  it('fences both owners when a direct legacy repair changes a Rule company or ID', async () => {
    const suffix = randomUUID();
    const source = await db.company.create({ data: {
      realmId: `lifecycle-owner-source-${suffix}`,
      legalName: 'Lifecycle Owner Source Legal',
      nickname: 'Lifecycle Owner Source',
    } });
    const target = await db.company.create({ data: {
      realmId: `lifecycle-owner-target-${suffix}`,
      legalName: 'Lifecycle Owner Target Legal',
      nickname: 'Lifecycle Owner Target',
    } });
    companyIds.add(source.id);
    companyIds.add(target.id);
    const rule = await createRule(source.id, suffix);
    const sourceBefore = await fence(source.id);
    const targetBefore = await fence(target.id);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.update({ where: { id: rule.id }, data: { companyId: target.id } });
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });

    expect(await fence(source.id)).toBeGreaterThan(sourceBefore);
    expect(await fence(target.id)).toBeGreaterThan(targetBefore);
    const targetAfterMove = await fence(target.id);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.rule.update({ where: { id: rule.id }, data: { id: `${rule.id}-moved` } });
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });
    expect(await fence(target.id)).toBeGreaterThan(targetAfterMove);
  });

  it('bumps each affected company once for a material multi-Rule UPDATE statement', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-bulk-${suffix}`,
      legalName: 'Lifecycle Bulk Legal',
      nickname: 'Lifecycle Bulk',
    } });
    companyIds.add(company.id);
    const first = await createRule(company.id, `${suffix}-first`);
    const second = await createRule(company.id, `${suffix}-second`);
    const before = await fence(company.id);

    await db.rule.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { priority: { increment: 1 } },
    });

    expect(await fence(company.id)).toBe(before + 1n);
  });

  it('bumps each affected company once for a material multi-RuleRevision UPDATE statement', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-revision-bulk-${suffix}`,
      legalName: 'Lifecycle Revision Bulk Legal',
      nickname: 'Lifecycle Revision Bulk',
    } });
    companyIds.add(company.id);
    const first = await createRule(company.id, `${suffix}-first`);
    const second = await createRule(company.id, `${suffix}-second`);
    const before = await fence(company.id);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" DISABLE TRIGGER "RuleRevision_append_only"');
      await tx.ruleRevision.updateMany({
        where: { ruleId: { in: [first.id, second.id] }, revision: 0 },
        data: { changedBy: 'legacy-bulk-repair' },
      });
      await tx.$executeRawUnsafe('ALTER TABLE "RuleRevision" ENABLE TRIGGER "RuleRevision_append_only"');
    });

    expect(await fence(company.id)).toBe(before + 1n);
  });

  it('self-heals a deleted fence with a generation newer than every prior token', async () => {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `lifecycle-self-heal-${suffix}`,
      legalName: 'Lifecycle Self Heal Legal',
      nickname: 'Lifecycle Self Heal',
    } });
    companyIds.add(company.id);
    const rule = await createRule(company.id, suffix);
    const beforeDelete = await fence(company.id);
    await db.ruleLifecycleRevision.delete({ where: { companyId: company.id } });

    await db.rule.update({ where: { id: rule.id }, data: { priority: 11 } });

    expect(await fence(company.id)).toBeGreaterThan(beforeDelete);
  });
});
