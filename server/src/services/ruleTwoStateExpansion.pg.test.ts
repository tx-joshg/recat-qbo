import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;
const migrationPath = fileURLToPath(new URL(
  '../../../prisma/migrations/20260904090000_expand_two_state_rules/migration.sql',
  import.meta.url,
));
const HASH = 'a'.repeat(64);

describePostgres('two-state rule bridge schema expansion', () => {
  let db: PrismaClient;
  const companyIds = new Set<string>();

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL! } } });
  });

  afterEach(async () => {
    if (companyIds.size > 0) {
      await db.$executeRawUnsafe(
        'DELETE FROM "RuleAutoPostPreparation" WHERE "companyId" = ANY($1::text[])',
        [...companyIds],
      ).catch(() => undefined);
      await db.company.deleteMany({ where: { id: { in: [...companyIds] } } });
    }
    companyIds.clear();
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createLegacyCompany(label: string) {
    const suffix = randomUUID();
    const company = await db.company.create({ data: {
      realmId: `two-state-${label}-${suffix}`,
      legalName: `Two State ${label} Legal`,
      nickname: `Two State ${label}`,
    } });
    companyIds.add(company.id);
    return { company, suffix };
  }

  async function insertLegacyRule(companyId: string, suffix: string): Promise<string> {
    const ruleId = `two-state-rule-${suffix}`;
    await db.$executeRaw`
      INSERT INTO "Rule" (
        "id", "companyId", "matchText", "category", "categoryQboId",
        "taxCalculation", "taxCode", "taxCodeQboId", "autoPost", "updatedAt"
      ) VALUES (
        ${ruleId}, ${companyId}, 'Legacy vendor', 'Meals', 'account-meals',
        'NotApplicable', NULL, NULL, false, CURRENT_TIMESTAMP
      )
    `;
    return ruleId;
  }

  async function insertPreparation(input: {
    id?: string;
    companyId: string;
    transactionId?: string;
    requestId?: string;
    state?: string;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    const transactionId = input.transactionId ?? randomUUID();
    const requestId = input.requestId ?? randomUUID();
    await db.$executeRaw`
      INSERT INTO "RuleAutoPostPreparation" (
        "id", "companyId", "transactionId", "ruleId", "ruleRevision",
        "inputHash", "proposal", "proposalHash", "stagedGraphHash", "sourceRevision",
        "preparedRevision", "qboType", "qboId", "qboSyncToken", "requestId",
        "state", "diagnostics", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${input.companyId}, ${transactionId}, ${randomUUID()}, 3, ${HASH},
        ${JSON.stringify({ version: 2, direction: 'Purchase', lines: [] })}::jsonb,
        ${HASH}, ${HASH}, 7, 8, 'Purchase', 'qbo-transaction', 'qbo-sync-token',
        ${requestId}, ${input.state ?? 'PREPARED'}, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;
    return id;
  }

  it('keeps rolling old-binary Company and Rule insert/update shapes valid', async () => {
    const { company, suffix } = await createLegacyCompany('old-writer');
    const ruleId = await insertLegacyRule(company.id, suffix);

    await db.$executeRaw`
      UPDATE "Rule"
         SET "matchText" = 'Legacy vendor updated',
             "category" = 'Legacy meals updated',
             "autoPost" = true,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${ruleId}
    `;

    const companies = await db.$queryRaw<Array<{ ruleRuntimeMode: string }>>`
      SELECT "ruleRuntimeMode" FROM "Company" WHERE "id" = ${company.id}
    `;
    const rules = await db.$queryRaw<Array<{
      revision: number;
      priority: number;
      matchText: string;
      category: string;
      autoPost: boolean;
      direction: string | null;
      canonicalVersion: number | null;
      repairReason: string | null;
      affectedJournalEntryCount: number | null;
    }>>`
      SELECT "revision", "priority", "matchText", "category", "autoPost",
             "direction", "canonicalVersion", "repairReason",
             "affectedJournalEntryCount"
        FROM "Rule"
       WHERE "id" = ${ruleId}
    `;
    const revisions = await db.$queryRaw<Array<{
      revision: number;
      direction: string | null;
      canonicalVersion: number | null;
      repairReason: string | null;
      affectedJournalEntryCount: number | null;
    }>>`
      SELECT "revision", "direction", "canonicalVersion", "repairReason",
             "affectedJournalEntryCount"
        FROM "RuleRevision"
       WHERE "companyId" = ${company.id} AND "ruleId" = ${ruleId}
    `;

    expect(companies).toEqual([{ ruleRuntimeMode: 'legacy' }]);
    expect(rules).toEqual([{
      revision: 0,
      priority: 0,
      matchText: 'Legacy vendor updated',
      category: 'Legacy meals updated',
      autoPost: true,
      direction: null,
      canonicalVersion: null,
      repairReason: null,
      affectedJournalEntryCount: null,
    }]);
    expect(revisions).toEqual([{
      revision: 0,
      direction: null,
      canonicalVersion: null,
      repairReason: null,
      affectedJournalEntryCount: null,
    }]);
  });

  it('contains no behavioral backfill, pointer advance, state flip, reorder, or suggestion clearing', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    const topLevelSql = migration.replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/g, '');

    expect(topLevelSql).not.toMatch(/\bUPDATE\s+"Rule"\b/i);
    expect(topLevelSql).not.toMatch(/\bUPDATE\s+"RuleRevision"\b/i);
    expect(topLevelSql).not.toMatch(/\bUPDATE\s+"Transaction"\b/i);
    expect(topLevelSql).not.toMatch(/\bDELETE\s+FROM\s+"Rule(?:Revision|CanonicalMigration)?"\b/i);
    expect(topLevelSql).not.toMatch(/\bINSERT\s+INTO\s+"Rule(?:Revision|CanonicalMigration|AutoPostPreparation)"\b/i);
    expect(topLevelSql).not.toMatch(/ALTER\s+TABLE\s+"Rule"[\s\S]*ALTER\s+COLUMN\s+"(?:revision|enabled|priority|retiredAt)"/i);
    expect(topLevelSql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*"priority"/i);
    expect(migration).not.toMatch(/vendor(?:Identity)?KeyVersion|normalizedNameV2|normalizedValueV2/i);
  });

  it('keeps retired history readable, append-only, and legacy rule mutations accepted', async () => {
    const { company, suffix } = await createLegacyCompany('history');
    const ruleId = await insertLegacyRule(company.id, suffix);
    await db.$executeRaw`
      INSERT INTO "RuleRevision" (
        "id", "ruleId", "companyId", "revision", "state", "matchText",
        "category", "priority", "autoPost", "retiredAt"
      ) VALUES (
        ${randomUUID()}, ${ruleId}, ${company.id}, 1, 'retired', 'Legacy retired vendor',
        'Meals', 0, false, CURRENT_TIMESTAMP
      )
    `;

    const retired = await db.$queryRaw<Array<{ state: string; direction: string | null }>>`
      SELECT "state", "direction"
        FROM "RuleRevision"
       WHERE "companyId" = ${company.id} AND "ruleId" = ${ruleId} AND "revision" = 1
    `;
    const mutationConstraint = await db.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = '"McpRuleOperation"'::regclass
         AND conname = 'McpRuleOperation_mutation_check'
    `;

    expect(retired).toEqual([{ state: 'retired', direction: null }]);
    expect(mutationConstraint[0]?.definition).toContain("'reorder'");
    expect(mutationConstraint[0]?.definition).toContain("'retire'");
    await expect(db.$executeRaw`
      UPDATE "RuleRevision" SET "changedBy" = 'rewritten' WHERE "ruleId" = ${ruleId}
    `).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`
      DELETE FROM "RuleRevision" WHERE "ruleId" = ${ruleId}
    `).rejects.toThrow(/append-only/);
  });

  it('permits nullable canonical fields but rejects invalid directions, versions, and counts', async () => {
    const { company, suffix } = await createLegacyCompany('constraints');
    const ruleId = await insertLegacyRule(company.id, suffix);

    await db.$executeRaw`
      UPDATE "Rule"
         SET "direction" = 'Purchase', "canonicalVersion" = 2,
             "repairReason" = 'Journal Entry exposure', "affectedJournalEntryCount" = 2
       WHERE "id" = ${ruleId}
    `;
    await expect(db.$executeRawUnsafe(
      'UPDATE "Rule" SET "direction" = \'JournalEntry\' WHERE "id" = $1',
      ruleId,
    )).rejects.toThrow();
    await expect(db.$executeRaw`
      UPDATE "Rule" SET "canonicalVersion" = 0 WHERE "id" = ${ruleId}
    `).rejects.toThrow(/canonicalVersion/i);
    await expect(db.$executeRaw`
      UPDATE "Rule" SET "affectedJournalEntryCount" = -1 WHERE "id" = ${ruleId}
    `).rejects.toThrow(/affectedJournalEntryCount/i);
    await expect(db.$executeRaw`
      INSERT INTO "RuleRevision" (
        "id", "ruleId", "companyId", "revision", "state", "matchText",
        "category", "priority", "autoPost", "direction", "canonicalVersion",
        "affectedJournalEntryCount"
      ) VALUES (
        ${randomUUID()}, ${ruleId}, ${company.id}, 2, 'disabled', 'Vendor',
        'Meals', 0, false, 'Deposit', 2, -1
      )
    `).rejects.toThrow(/affectedJournalEntryCount/i);
  });

  it('records each canonical migration version exactly once per company rule', async () => {
    const { company, suffix } = await createLegacyCompany('marker');
    const ruleId = await insertLegacyRule(company.id, suffix);
    const insertMarker = (id: string, canonicalVersion: number) => db.$executeRaw`
      INSERT INTO "RuleCanonicalMigration" (
        "id", "companyId", "ruleId", "canonicalVersion", "sourceRevision",
        "canonicalRevision", "completedAt"
      ) VALUES (${id}, ${company.id}, ${ruleId}, ${canonicalVersion}, 0, 1, CURRENT_TIMESTAMP)
    `;

    await insertMarker(randomUUID(), 2);
    await expect(insertMarker(randomUUID(), 2)).rejects.toThrow(/23505|already exists/i);
    await expect(insertMarker(randomUUID(), 0)).rejects.toThrow(/version/i);
    await db.$executeRaw`
      INSERT INTO "RuleCanonicalMigration" (
        "id", "companyId", "ruleId", "canonicalVersion", "sourceRevision",
        "canonicalRevision", "completedAt"
      ) VALUES (${randomUUID()}, ${company.id}, ${ruleId}, 3, 2, 2, CURRENT_TIMESTAMP)
    `.then(
      () => { throw new Error('same source/canonical revision unexpectedly accepted'); },
      (error: unknown) => expect(String(error)).toMatch(/revision/i),
    );
  });

  it('keeps canonical migration markers append-only except for company erasure', async () => {
    const { company, suffix } = await createLegacyCompany('marker-append-only');
    const ruleId = await insertLegacyRule(company.id, suffix);
    const markerId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "RuleCanonicalMigration" (
        "id", "companyId", "ruleId", "canonicalVersion", "sourceRevision",
        "canonicalRevision", "completedAt"
      ) VALUES (${markerId}, ${company.id}, ${ruleId}, 2, 0, 1, CURRENT_TIMESTAMP)
    `;

    await expect(db.$executeRaw`
      UPDATE "RuleCanonicalMigration" SET "canonicalVersion" = 3 WHERE "id" = ${markerId}
    `).rejects.toThrow(/append-only/i);
    await expect(db.$executeRaw`
      DELETE FROM "RuleCanonicalMigration" WHERE "id" = ${markerId}
    `).rejects.toThrow(/append-only/i);

    await db.company.delete({ where: { id: company.id } });
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
        FROM "RuleCanonicalMigration"
       WHERE "id" = ${markerId}
    `;
    expect(rows).toEqual([{ count: 0 }]);
  });

  it('enforces unique active preparations and unique write request identities', async () => {
    const { company } = await createLegacyCompany('preparation-unique');
    const transactionId = randomUUID();
    const firstId = await insertPreparation({ companyId: company.id, transactionId });

    await expect(insertPreparation({ companyId: company.id, transactionId }))
      .rejects.toThrow(/23505|already exists/i);

    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'DRY_RUN', "completedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${firstId}
    `;
    const requestId = randomUUID();
    await insertPreparation({ companyId: company.id, transactionId, requestId });
    await expect(insertPreparation({ companyId: company.id, requestId }))
      .rejects.toThrow(/23505|already exists/i);
  });

  it('protects core preparation authority while allowing diagnostics and valid state advances', async () => {
    const { company } = await createLegacyCompany('preparation-state');
    const preparationId = await insertPreparation({ companyId: company.id });

    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'RETRYABLE', "errorCode" = 'PRE_SEND_RETRY',
             "errorMessage" = 'Safe to resume', "diagnostics" = '{"attempt":1}'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'COMMITTING', "commitStartedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    // Legal only when Task 8 proves the failure occurred before provider send.
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'RETRYABLE', "diagnostics" = '{"providerSent":false}'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'COMMITTING',
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'UNCERTAIN', "diagnostics" = '{"reconcile":true}'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    // Legal only when reconciliation proves the provider entity is unchanged;
    // Task 8 owns that evidence check, while storage permits the recovery edge.
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'RETRYABLE', "diagnostics" = '{"provider":"unchanged"}'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'COMMITTING',
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;
    await db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'VERIFIED', "completedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `;

    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "proposal" = '{"tampered":true}'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/immutable core fields/i);
    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "inputHash" = ${'b'.repeat(64)},
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/immutable core fields/i);
    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'RETRYABLE',
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/state transition/i);
    await expect(db.$executeRaw`
      DELETE FROM "RuleAutoPostPreparation" WHERE "id" = ${preparationId}
    `).rejects.toThrow(/immutable core fields/i);
  });

  it('rejects state skips, invalid diagnostics, and malformed envelope hashes', async () => {
    const { company } = await createLegacyCompany('preparation-invalid');
    const preparationId = await insertPreparation({ companyId: company.id });

    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "state" = 'VERIFIED', "commitStartedAt" = CURRENT_TIMESTAMP,
             "completedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/state transition/i);
    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "commitStartedAt" = CURRENT_TIMESTAMP,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/timestamp|commitStartedAt/i);
    await expect(db.$executeRaw`
      UPDATE "RuleAutoPostPreparation"
         SET "diagnostics" = '[]'::jsonb,
             "updatedAt" = "updatedAt" + interval '1 millisecond'
       WHERE "id" = ${preparationId}
    `).rejects.toThrow(/diagnostics/i);
    await expect(db.$executeRaw`
      INSERT INTO "RuleAutoPostPreparation" (
        "id", "companyId", "transactionId", "ruleId", "ruleRevision",
        "inputHash", "proposal", "proposalHash", "stagedGraphHash", "sourceRevision",
        "preparedRevision", "qboType", "qboId", "qboSyncToken", "requestId",
        "state", "diagnostics", "createdAt", "updatedAt"
      ) VALUES (
        ${randomUUID()}, ${company.id}, ${randomUUID()}, ${randomUUID()}, 1, ${HASH},
        '{}'::jsonb, 'NOT-A-HASH', ${HASH}, 0, 1, 'Purchase', 'qbo', 'sync',
        ${randomUUID()}, 'PREPARED', '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).rejects.toThrow(/proposalHash/i);
  });

  it('does not introduce a unique priority constraint', async () => {
    const indexes = await db.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
       WHERE indrelid = '"Rule"'::regclass AND indisunique
    `;

    expect(indexes.map(({ definition }) => definition).join('\n')).not.toMatch(/priority/i);
  });

  it('retains preparations against direct deletion but removes them during company erasure', async () => {
    const { company } = await createLegacyCompany('preparation-cascade');
    const preparationId = await insertPreparation({ companyId: company.id });

    await expect(db.$executeRaw`
      DELETE FROM "RuleAutoPostPreparation" WHERE "id" = ${preparationId}
    `).rejects.toThrow(/immutable core fields/i);
    await db.company.delete({ where: { id: company.id } });

    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
        FROM "RuleAutoPostPreparation"
       WHERE "id" = ${preparationId}
    `;
    expect(rows).toEqual([{ count: 0 }]);
  });
});
