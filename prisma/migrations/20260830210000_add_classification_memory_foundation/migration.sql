-- Classification memory foundation (Task 2).
--
-- Forward assumptions:
--   * this migration is additive; existing Rule rows are retained in place;
--   * pre-memory rules have no origin/source and are represented by one
--     enabled revision at revision 0;
--   * existing nullable tax/category references remain nullable in the
--     historical revision so the migration never invents a QBO identifier;
--   * the application writes only bounded, allow-listed JSON snapshots.
--
-- Rollback assumptions:
--   * Prisma has no generated down migration for this change. A rollback must
--     first stop writers, export/drop the new memory tables and triggers, and
--     then remove only the lifecycle columns after restoring the old binary;
--   * deleting the new tables loses classification memory and is intentionally
--     not attempted automatically. Existing Rule and autoPost values survive
--     a rollback because this migration never rewrites them.

-- Existing rows receive safe lifecycle defaults. In particular, autoPost is
-- never changed or reinterpreted by this migration.
ALTER TABLE "Rule"
    ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "originIntent" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "sourceCaseId" TEXT,
    ADD COLUMN IF NOT EXISTS "sourceCandidateId" TEXT,
    ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "updatedById" VARCHAR(128);

-- Retain the database default so an older binary can continue creating rules
-- safely while this additive migration and the new application roll out.

-- Existing candidate evidence predates explicit tenant columns. Derive the
-- tenant from its candidate, then fail closed if any legacy transaction points
-- at another company instead of silently re-homing evidence.
ALTER TABLE "AutopilotRuleCandidateEvidence"
    ADD COLUMN IF NOT EXISTS "companyId" TEXT;
UPDATE "AutopilotRuleCandidateEvidence" evidence
SET "companyId" = candidate."companyId"
FROM "AutopilotRuleCandidate" candidate
WHERE candidate."id" = evidence."candidateId"
  AND evidence."companyId" IS NULL;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "AutopilotRuleCandidateEvidence" evidence
        JOIN "AutopilotRuleCandidate" candidate ON candidate."id" = evidence."candidateId"
        JOIN "Transaction" transaction ON transaction."id" = evidence."transactionId"
        WHERE evidence."companyId" IS NULL
           OR evidence."companyId" <> candidate."companyId"
           OR evidence."companyId" <> transaction."companyId"
    ) THEN
        RAISE EXCEPTION 'Legacy rule candidate evidence crosses company scope';
    END IF;
END
$$;
ALTER TABLE "AutopilotRuleCandidateEvidence"
    ALTER COLUMN "companyId" SET NOT NULL;

-- Composite identities are used by child foreign keys to prove that a pair
-- of IDs belongs to the same company. The columns are redundant with each
-- primary key, but are deliberate tenant-boundary constraints.
CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_companyId_id_key"
    ON "Transaction"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Rule_companyId_id_key"
    ON "Rule"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "AutopilotRuleCandidate_companyId_id_key"
    ON "AutopilotRuleCandidate"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "QboMutationAttempt_transactionId_id_key"
    ON "QboMutationAttempt"("transactionId", "id");

CREATE INDEX IF NOT EXISTS "Rule_companyId_enabled_retiredAt_idx"
    ON "Rule"("companyId", "enabled", "retiredAt");

CREATE TABLE IF NOT EXISTS "VendorIdentity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "qboVendorId" VARCHAR(120),
    "displayName" VARCHAR(500) NOT NULL,
    "normalizedName" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VendorAlias" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vendorIdentityId" TEXT NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "normalizedValue" VARCHAR(500) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VendorIdentityMerge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceVendorIdentityId" TEXT NOT NULL,
    "targetVendorIdentityId" TEXT NOT NULL,
    "mergedBy" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorIdentityMerge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClassificationCase" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "vendorIdentityId" TEXT,
    "qboMutationAttemptId" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "actionFingerprint" CHAR(64) NOT NULL,
    "originIntent" VARCHAR(32) NOT NULL,
    "rationale" VARCHAR(2000) NOT NULL,
    "requiredEvidence" JSONB NOT NULL DEFAULT '[]',
    "examples" JSONB NOT NULL DEFAULT '[]',
    "counterexamples" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "reviewer" JSONB NOT NULL,
    "jurisdiction" VARCHAR(128) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "context" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "transactionSnapshot" JSONB NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClassificationCaseInvalidation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "classificationCaseId" TEXT NOT NULL,
    "invalidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationCaseInvalidation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RuleRevision" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'enabled',
    "matchField" VARCHAR(64) NOT NULL DEFAULT 'payee',
    "matchText" VARCHAR(500) NOT NULL,
    "category" VARCHAR(500) NOT NULL,
    "categoryQboId" VARCHAR(120),
    "taxCalculation" VARCHAR(32),
    "taxCode" VARCHAR(500),
    "taxCodeQboId" VARCHAR(120),
    "tagIds" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL,
    "autoPost" BOOLEAN NOT NULL,
    "originIntent" VARCHAR(32),
    "sourceCaseId" TEXT,
    "sourceCandidateId" TEXT,
    "changedBy" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "RuleRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VendorIdentity_companyId_id_key"
    ON "VendorIdentity"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorIdentity_companyId_normalizedName_key"
    ON "VendorIdentity"("companyId", "normalizedName");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorIdentity_companyId_qboVendorId_key"
    ON "VendorIdentity"("companyId", "qboVendorId");
CREATE INDEX IF NOT EXISTS "VendorIdentity_companyId_qboVendorId_idx"
    ON "VendorIdentity"("companyId", "qboVendorId");

CREATE UNIQUE INDEX IF NOT EXISTS "VendorAlias_companyId_id_key"
    ON "VendorAlias"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorAlias_companyId_normalizedValue_key"
    ON "VendorAlias"("companyId", "normalizedValue");
CREATE INDEX IF NOT EXISTS "VendorAlias_companyId_vendorIdentityId_idx"
    ON "VendorAlias"("companyId", "vendorIdentityId");
CREATE INDEX IF NOT EXISTS "VendorAlias_companyId_normalizedValue_idx"
    ON "VendorAlias"("companyId", "normalizedValue");

CREATE UNIQUE INDEX IF NOT EXISTS "VendorIdentityMerge_companyId_id_key"
    ON "VendorIdentityMerge"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorIdentityMerge_companyId_sourceVendorIdentityId_key"
    ON "VendorIdentityMerge"("companyId", "sourceVendorIdentityId");
CREATE INDEX IF NOT EXISTS "VendorIdentityMerge_companyId_targetVendorIdentityId_idx"
    ON "VendorIdentityMerge"("companyId", "targetVendorIdentityId");

CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationCase_qboMutationAttemptId_key"
    ON "ClassificationCase"("qboMutationAttemptId");
CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationCase_companyId_id_key"
    ON "ClassificationCase"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationCase_transactionId_qboMutationAttemptId_key"
    ON "ClassificationCase"("transactionId", "qboMutationAttemptId");
CREATE INDEX IF NOT EXISTS "ClassificationCase_companyId_verifiedAt_idx"
    ON "ClassificationCase"("companyId", "verifiedAt");
CREATE INDEX IF NOT EXISTS "ClassificationCase_companyId_transactionId_idx"
    ON "ClassificationCase"("companyId", "transactionId");
CREATE INDEX IF NOT EXISTS "ClassificationCase_companyId_vendorIdentityId_verifiedAt_idx"
    ON "ClassificationCase"("companyId", "vendorIdentityId", "verifiedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationCaseInvalidation_companyId_id_key"
    ON "ClassificationCaseInvalidation"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationCaseInvalidation_company_case_key"
    ON "ClassificationCaseInvalidation"("companyId", "classificationCaseId");
CREATE INDEX IF NOT EXISTS "ClassificationCaseInvalidation_companyId_invalidatedAt_idx"
    ON "ClassificationCaseInvalidation"("companyId", "invalidatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "RuleRevision_companyId_id_key"
    ON "RuleRevision"("companyId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "RuleRevision_companyId_ruleId_revision_key"
    ON "RuleRevision"("companyId", "ruleId", "revision");
CREATE INDEX IF NOT EXISTS "RuleRevision_companyId_state_createdAt_idx"
    ON "RuleRevision"("companyId", "state", "createdAt");
CREATE INDEX IF NOT EXISTS "RuleRevision_companyId_ruleId_revision_idx"
    ON "RuleRevision"("companyId", "ruleId", "revision");

CREATE INDEX IF NOT EXISTS "AutopilotRuleCandidateEvidence_companyId_active_idx"
    ON "AutopilotRuleCandidateEvidence"("companyId", "active");

ALTER TABLE "AutopilotRuleCandidateEvidence"
    DROP CONSTRAINT IF EXISTS "AutopilotRuleCandidateEvidence_candidateId_fkey",
    DROP CONSTRAINT IF EXISTS "AutopilotRuleCandidateEvidence_transactionId_fkey";

-- Add constraints one by one so a pre-release image that already created one
-- of these objects can safely converge without duplicate-constraint errors.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorIdentity"'::regclass
          AND conname = 'VendorIdentity_companyId_fkey'
    ) THEN
        ALTER TABLE "VendorIdentity"
            ADD CONSTRAINT "VendorIdentity_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorAlias"'::regclass
          AND conname = 'VendorAlias_companyId_fkey'
    ) THEN
        ALTER TABLE "VendorAlias"
            ADD CONSTRAINT "VendorAlias_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorAlias"'::regclass
          AND conname = 'VendorAlias_companyId_vendorIdentityId_fkey'
    ) THEN
        ALTER TABLE "VendorAlias"
            ADD CONSTRAINT "VendorAlias_companyId_vendorIdentityId_fkey"
            FOREIGN KEY ("companyId", "vendorIdentityId")
            REFERENCES "VendorIdentity"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorIdentityMerge"'::regclass
          AND conname = 'VendorIdentityMerge_companyId_fkey'
    ) THEN
        ALTER TABLE "VendorIdentityMerge"
            ADD CONSTRAINT "VendorIdentityMerge_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorIdentityMerge"'::regclass
          AND conname = 'VendorIdentityMerge_companyId_sourceVendorIdentityId_fkey'
    ) THEN
        ALTER TABLE "VendorIdentityMerge"
            ADD CONSTRAINT "VendorIdentityMerge_companyId_sourceVendorIdentityId_fkey"
            FOREIGN KEY ("companyId", "sourceVendorIdentityId")
            REFERENCES "VendorIdentity"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"VendorIdentityMerge"'::regclass
          AND conname = 'VendorIdentityMerge_companyId_targetVendorIdentityId_fkey'
    ) THEN
        ALTER TABLE "VendorIdentityMerge"
            ADD CONSTRAINT "VendorIdentityMerge_companyId_targetVendorIdentityId_fkey"
            FOREIGN KEY ("companyId", "targetVendorIdentityId")
            REFERENCES "VendorIdentity"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCase"'::regclass
          AND conname = 'ClassificationCase_companyId_fkey'
    ) THEN
        ALTER TABLE "ClassificationCase"
            ADD CONSTRAINT "ClassificationCase_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCase"'::regclass
          AND conname = 'ClassificationCase_companyId_transactionId_fkey'
    ) THEN
        ALTER TABLE "ClassificationCase"
            ADD CONSTRAINT "ClassificationCase_companyId_transactionId_fkey"
            FOREIGN KEY ("companyId", "transactionId")
            REFERENCES "Transaction"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCaseInvalidation"'::regclass
          AND conname = 'ClassificationCaseInvalidation_companyId_fkey'
    ) THEN
        ALTER TABLE "ClassificationCaseInvalidation"
            ADD CONSTRAINT "ClassificationCaseInvalidation_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCaseInvalidation"'::regclass
          AND conname = 'ClassificationCaseInvalidation_company_case_fkey'
    ) THEN
        ALTER TABLE "ClassificationCaseInvalidation"
            ADD CONSTRAINT "ClassificationCaseInvalidation_company_case_fkey"
            FOREIGN KEY ("companyId", "classificationCaseId")
            REFERENCES "ClassificationCase"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCase"'::regclass
          AND conname = 'ClassificationCase_companyId_vendorIdentityId_fkey'
    ) THEN
        ALTER TABLE "ClassificationCase"
            ADD CONSTRAINT "ClassificationCase_companyId_vendorIdentityId_fkey"
            FOREIGN KEY ("companyId", "vendorIdentityId")
            REFERENCES "VendorIdentity"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"ClassificationCase"'::regclass
          AND conname = 'ClassificationCase_transactionId_qboMutationAttemptId_fkey'
    ) THEN
        ALTER TABLE "ClassificationCase"
            ADD CONSTRAINT "ClassificationCase_transactionId_qboMutationAttemptId_fkey"
            FOREIGN KEY ("transactionId", "qboMutationAttemptId")
            REFERENCES "QboMutationAttempt"("transactionId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"RuleRevision"'::regclass
          AND conname = 'RuleRevision_companyId_fkey'
    ) THEN
        ALTER TABLE "RuleRevision"
            ADD CONSTRAINT "RuleRevision_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"RuleRevision"'::regclass
          AND conname = 'RuleRevision_companyId_ruleId_fkey'
    ) THEN
        ALTER TABLE "RuleRevision"
            ADD CONSTRAINT "RuleRevision_companyId_ruleId_fkey"
            FOREIGN KEY ("companyId", "ruleId") REFERENCES "Rule"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"Rule"'::regclass
          AND conname = 'Rule_companyId_sourceCaseId_fkey'
    ) THEN
        ALTER TABLE "Rule"
            ADD CONSTRAINT "Rule_companyId_sourceCaseId_fkey"
            FOREIGN KEY ("companyId", "sourceCaseId")
            REFERENCES "ClassificationCase"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"Rule"'::regclass
          AND conname = 'Rule_companyId_sourceCandidateId_fkey'
    ) THEN
        ALTER TABLE "Rule"
            ADD CONSTRAINT "Rule_companyId_sourceCandidateId_fkey"
            FOREIGN KEY ("companyId", "sourceCandidateId")
            REFERENCES "AutopilotRuleCandidate"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"RuleRevision"'::regclass
          AND conname = 'RuleRevision_companyId_sourceCaseId_fkey'
    ) THEN
        ALTER TABLE "RuleRevision"
            ADD CONSTRAINT "RuleRevision_companyId_sourceCaseId_fkey"
            FOREIGN KEY ("companyId", "sourceCaseId")
            REFERENCES "ClassificationCase"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"RuleRevision"'::regclass
          AND conname = 'RuleRevision_companyId_sourceCandidateId_fkey'
    ) THEN
        ALTER TABLE "RuleRevision"
            ADD CONSTRAINT "RuleRevision_companyId_sourceCandidateId_fkey"
            FOREIGN KEY ("companyId", "sourceCandidateId")
            REFERENCES "AutopilotRuleCandidate"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"AutopilotRuleCandidateEvidence"'::regclass
          AND conname = 'AutopilotRuleCandidateEvidence_companyId_fkey'
    ) THEN
        ALTER TABLE "AutopilotRuleCandidateEvidence"
            ADD CONSTRAINT "AutopilotRuleCandidateEvidence_companyId_fkey"
            FOREIGN KEY ("companyId") REFERENCES "Company"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"AutopilotRuleCandidateEvidence"'::regclass
          AND conname = 'AutopilotRuleCandidateEvidence_companyId_candidateId_fkey'
    ) THEN
        ALTER TABLE "AutopilotRuleCandidateEvidence"
            ADD CONSTRAINT "AutopilotRuleCandidateEvidence_companyId_candidateId_fkey"
            FOREIGN KEY ("companyId", "candidateId")
            REFERENCES "AutopilotRuleCandidate"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = '"AutopilotRuleCandidateEvidence"'::regclass
          AND conname = 'AutopilotRuleCandidateEvidence_companyId_transactionId_fkey'
    ) THEN
        ALTER TABLE "AutopilotRuleCandidateEvidence"
            ADD CONSTRAINT "AutopilotRuleCandidateEvidence_companyId_transactionId_fkey"
            FOREIGN KEY ("companyId", "transactionId")
            REFERENCES "Transaction"("companyId", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Existing rules get one immutable historical version. The INSERT is
-- idempotent for a repaired/replayed migration and retains each rule's exact
-- autoPost value and current tags. Legacy null QBO references remain null.
INSERT INTO "RuleRevision" (
    "id", "ruleId", "companyId", "revision", "state", "matchField",
    "matchText", "category", "categoryQboId", "taxCalculation", "taxCode",
    "taxCodeQboId", "tagIds", "priority", "autoPost", "originIntent",
    "sourceCaseId", "sourceCandidateId", "changedBy", "createdAt", "retiredAt"
)
SELECT
    'rule-revision-' || rule."id",
    rule."id",
    rule."companyId",
    COALESCE(rule."revision", 0),
    'enabled',
    COALESCE(rule."matchField", 'payee'),
    rule."matchText",
    rule."category",
    rule."categoryQboId",
    rule."taxCalculation",
    rule."taxCode",
    rule."taxCodeQboId",
    COALESCE((
        SELECT jsonb_agg(tag."tagId" ORDER BY tag."tagId")
        FROM "RuleTag" tag
        WHERE tag."ruleId" = rule."id"
    ), '[]'::jsonb),
    rule."priority",
    rule."autoPost",
    rule."originIntent",
    rule."sourceCaseId",
    rule."sourceCandidateId",
    rule."createdById",
    rule."createdAt",
    rule."retiredAt"
FROM "Rule" rule
WHERE NOT EXISTS (
    SELECT 1 FROM "RuleRevision" revision
    WHERE revision."companyId" = rule."companyId"
      AND revision."ruleId" = rule."id"
      AND revision."revision" = COALESCE(rule."revision", 0)
)
ON CONFLICT ("companyId", "ruleId", "revision") DO NOTHING;

-- These checks intentionally validate shape and storage bounds, while the
-- service performs the full public contract validation (including NFC key
-- derivation and per-field limits that PostgreSQL cannot express portably).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorIdentity"'::regclass AND conname = 'VendorIdentity_nonempty_check') THEN
        ALTER TABLE "VendorIdentity" ADD CONSTRAINT "VendorIdentity_nonempty_check"
            CHECK (length(btrim("displayName")) > 0 AND length("normalizedName") > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorAlias"'::regclass AND conname = 'VendorAlias_source_check') THEN
        ALTER TABLE "VendorAlias" ADD CONSTRAINT "VendorAlias_source_check"
            CHECK ("source" IN ('qbo', 'user', 'import', 'inferred'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorAlias"'::regclass AND conname = 'VendorAlias_nonempty_check') THEN
        ALTER TABLE "VendorAlias" ADD CONSTRAINT "VendorAlias_nonempty_check"
            CHECK (length(btrim("value")) > 0 AND length("normalizedValue") > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorIdentityMerge"'::regclass AND conname = 'VendorIdentityMerge_distinct_check') THEN
        ALTER TABLE "VendorIdentityMerge" ADD CONSTRAINT "VendorIdentityMerge_distinct_check"
            CHECK ("sourceVendorIdentityId" <> "targetVendorIdentityId");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"VendorIdentityMerge"'::regclass AND conname = 'VendorIdentityMerge_audit_check') THEN
        ALTER TABLE "VendorIdentityMerge" ADD CONSTRAINT "VendorIdentityMerge_audit_check"
            CHECK (length(btrim("mergedBy")) > 0 AND length(btrim("reason")) > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ClassificationCase"'::regclass AND conname = 'ClassificationCase_originIntent_check') THEN
        ALTER TABLE "ClassificationCase" ADD CONSTRAINT "ClassificationCase_originIntent_check"
            CHECK ("originIntent" IN ('apply_once', 'make_recurring', 'auto_candidate'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ClassificationCase"'::regclass AND conname = 'ClassificationCase_fingerprint_check') THEN
        ALTER TABLE "ClassificationCase" ADD CONSTRAINT "ClassificationCase_fingerprint_check"
            CHECK ("actionFingerprint" ~ '^[0-9a-fA-F]{64}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ClassificationCase"'::regclass AND conname = 'ClassificationCase_snapshot_shape_check') THEN
        ALTER TABLE "ClassificationCase" ADD CONSTRAINT "ClassificationCase_snapshot_shape_check"
            CHECK (
                jsonb_typeof("action") = 'object'
                AND jsonb_typeof("reviewer") = 'object'
                AND jsonb_typeof("context") = 'object'
                AND jsonb_typeof("provenance") = 'object'
                AND jsonb_typeof("transactionSnapshot") = 'object'
                AND jsonb_typeof("requiredEvidence") = 'array'
                AND jsonb_typeof("examples") = 'array'
                AND jsonb_typeof("counterexamples") = 'array'
                AND jsonb_typeof("citations") = 'array'
                AND jsonb_array_length("requiredEvidence") <= 20
                AND jsonb_array_length("examples") <= 20
                AND jsonb_array_length("counterexamples") <= 20
                AND jsonb_array_length("citations") <= 10
                AND octet_length(convert_to("transactionSnapshot"::text, 'UTF8')) <= 32768
            );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ClassificationCase"'::regclass AND conname = 'ClassificationCase_currency_check') THEN
        ALTER TABLE "ClassificationCase" ADD CONSTRAINT "ClassificationCase_currency_check"
            CHECK ("currency" ~ '^[A-Z]{3}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ClassificationCaseInvalidation"'::regclass AND conname = 'ClassificationCaseInvalidation_reason_check') THEN
        ALTER TABLE "ClassificationCaseInvalidation" ADD CONSTRAINT "ClassificationCaseInvalidation_reason_check"
            CHECK (length(btrim("reason")) > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Rule"'::regclass AND conname = 'Rule_retirement_check') THEN
        ALTER TABLE "Rule" ADD CONSTRAINT "Rule_retirement_check"
            CHECK ("retiredAt" IS NULL OR "enabled" = false);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"RuleRevision"'::regclass AND conname = 'RuleRevision_state_check') THEN
        ALTER TABLE "RuleRevision" ADD CONSTRAINT "RuleRevision_state_check"
            CHECK ("state" IN ('enabled', 'disabled', 'retired'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"RuleRevision"'::regclass AND conname = 'RuleRevision_tag_shape_check') THEN
        ALTER TABLE "RuleRevision" ADD CONSTRAINT "RuleRevision_tag_shape_check"
            CHECK (jsonb_typeof("tagIds") = 'array' AND jsonb_array_length("tagIds") <= 50);
    END IF;
END
$$;

-- Database enforcement complements the service's create-only API. The
-- trigger also protects direct SQL and Prisma update/delete calls.
CREATE OR REPLACE FUNCTION "prevent_classification_memory_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- A tenant erasure legitimately cascades through immutable history. During
    -- that cascade the Company row is already invisible to this trigger. Any
    -- direct child delete (including a direct Rule delete) still sees it and
    -- remains forbidden.
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM "Company" company WHERE company."id" = OLD."companyId"
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "prevent_classification_memory_deletion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Company" company WHERE company."id" = OLD."companyId"
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% must be retired or retained, not deleted', TG_TABLE_NAME;
    RETURN NULL;
END;
$$;

-- A deferred insert trigger is the compatibility fence for an older binary
-- running during a rolling migration. Current writers append revision zero
-- explicitly, but an old writer knows only the legacy Rule columns. Deferral
-- lets nested RuleTag inserts finish before the fallback snapshot is built.
CREATE OR REPLACE FUNCTION "capture_initial_rule_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO "RuleRevision" (
        "id", "ruleId", "companyId", "revision", "state", "matchField",
        "matchText", "category", "categoryQboId", "taxCalculation", "taxCode",
        "taxCodeQboId", "tagIds", "priority", "autoPost", "originIntent",
        "sourceCaseId", "sourceCandidateId", "changedBy", "createdAt", "retiredAt"
    )
    SELECT
        'rule-revision-' || NEW."id",
        NEW."id",
        NEW."companyId",
        0,
        CASE
            WHEN NEW."retiredAt" IS NOT NULL THEN 'retired'
            WHEN NEW."enabled" THEN 'enabled'
            ELSE 'disabled'
        END,
        NEW."matchField",
        NEW."matchText",
        NEW."category",
        NEW."categoryQboId",
        NEW."taxCalculation",
        NEW."taxCode",
        NEW."taxCodeQboId",
        COALESCE((
            SELECT jsonb_agg(tag."tagId" ORDER BY tag."tagId")
            FROM "RuleTag" tag
            WHERE tag."ruleId" = NEW."id"
        ), '[]'::jsonb),
        NEW."priority",
        NEW."autoPost",
        NEW."originIntent",
        NEW."sourceCaseId",
        NEW."sourceCandidateId",
        COALESCE(NEW."updatedById", NEW."createdById"),
        NEW."createdAt",
        NEW."retiredAt"
    WHERE NOT EXISTS (
        SELECT 1 FROM "RuleRevision" revision
        WHERE revision."companyId" = NEW."companyId"
          AND revision."ruleId" = NEW."id"
          AND revision."revision" = 0
    )
    ON CONFLICT ("companyId", "ruleId", "revision") DO NOTHING;
    RETURN NEW;
END;
$$;

-- Canonical names and aliases occupy one exact-key namespace. Separate table
-- indexes cannot enforce this cross-table invariant, so both trigger paths
-- take the same transaction-scoped key lock before checking the other table.
CREATE OR REPLACE FUNCTION "enforce_vendor_exact_key_namespace"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    exact_key TEXT;
BEGIN
    IF TG_TABLE_NAME = 'VendorIdentity' THEN
        exact_key := NEW."normalizedName";
    ELSE
        exact_key := NEW."normalizedValue";
    END IF;
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW."companyId" || chr(31) || exact_key, 880218)
    );
    IF TG_TABLE_NAME = 'VendorIdentity' AND EXISTS (
        SELECT 1 FROM "VendorAlias" alias
        WHERE alias."companyId" = NEW."companyId"
          AND alias."normalizedValue" = exact_key
    ) THEN
        RAISE EXCEPTION 'Vendor exact key is already claimed by an alias'
            USING ERRCODE = '23505', CONSTRAINT = 'Vendor_exact_key_namespace_key';
    END IF;
    IF TG_TABLE_NAME = 'VendorAlias' AND EXISTS (
        SELECT 1 FROM "VendorIdentity" identity
        WHERE identity."companyId" = NEW."companyId"
          AND identity."normalizedName" = exact_key
    ) THEN
        RAISE EXCEPTION 'Vendor exact key is already claimed by an identity'
            USING ERRCODE = '23505', CONSTRAINT = 'Vendor_exact_key_namespace_key';
    END IF;
    RETURN NEW;
END;
$$;

-- Merge writers share the normal company mutation fence. The recursive check
-- is also a database backstop for direct SQL so reciprocal concurrent inserts
-- cannot commit a cycle even when they bypass the service.
CREATE OR REPLACE FUNCTION "enforce_vendor_merge_acyclic"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."companyId", 880217));
    IF NEW."sourceVendorIdentityId" = NEW."targetVendorIdentityId" OR EXISTS (
        WITH RECURSIVE targets("id") AS (
            SELECT NEW."targetVendorIdentityId"
            UNION
            SELECT merge."targetVendorIdentityId"
            FROM "VendorIdentityMerge" merge
            JOIN targets ON targets."id" = merge."sourceVendorIdentityId"
            WHERE merge."companyId" = NEW."companyId"
        )
        SELECT 1 FROM targets WHERE "id" = NEW."sourceVendorIdentityId"
    ) THEN
        RAISE EXCEPTION 'Vendor identity merge would create a cycle'
            USING ERRCODE = '23514', CONSTRAINT = 'VendorIdentityMerge_acyclic_check';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "VendorIdentity" identity
        JOIN "VendorAlias" alias
          ON alias."companyId" = identity."companyId"
         AND alias."normalizedValue" = identity."normalizedName"
    ) THEN
        RAISE EXCEPTION 'Existing vendor canonical and alias keys overlap';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS "VendorIdentity_exact_key_namespace" ON "VendorIdentity";
CREATE TRIGGER "VendorIdentity_exact_key_namespace"
    BEFORE INSERT OR UPDATE ON "VendorIdentity"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_vendor_exact_key_namespace"();

DROP TRIGGER IF EXISTS "VendorAlias_exact_key_namespace" ON "VendorAlias";
CREATE TRIGGER "VendorAlias_exact_key_namespace"
    BEFORE INSERT OR UPDATE ON "VendorAlias"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_vendor_exact_key_namespace"();

DROP TRIGGER IF EXISTS "VendorIdentityMerge_acyclic" ON "VendorIdentityMerge";
CREATE TRIGGER "VendorIdentityMerge_acyclic"
    BEFORE INSERT OR UPDATE ON "VendorIdentityMerge"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_vendor_merge_acyclic"();

DROP TRIGGER IF EXISTS "Rule_capture_initial_revision" ON "Rule";
CREATE CONSTRAINT TRIGGER "Rule_capture_initial_revision"
    AFTER INSERT ON "Rule"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "capture_initial_rule_revision"();

DROP TRIGGER IF EXISTS "VendorIdentity_no_delete" ON "VendorIdentity";
CREATE TRIGGER "VendorIdentity_no_delete"
    BEFORE DELETE ON "VendorIdentity"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_deletion"();

DROP TRIGGER IF EXISTS "Rule_no_delete" ON "Rule";
CREATE TRIGGER "Rule_no_delete"
    BEFORE DELETE ON "Rule"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_deletion"();

DROP TRIGGER IF EXISTS "VendorAlias_append_only" ON "VendorAlias";
CREATE TRIGGER "VendorAlias_append_only"
    BEFORE UPDATE OR DELETE ON "VendorAlias"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_mutation"();

DROP TRIGGER IF EXISTS "VendorIdentityMerge_append_only" ON "VendorIdentityMerge";
CREATE TRIGGER "VendorIdentityMerge_append_only"
    BEFORE UPDATE OR DELETE ON "VendorIdentityMerge"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_mutation"();

DROP TRIGGER IF EXISTS "ClassificationCase_append_only" ON "ClassificationCase";
CREATE TRIGGER "ClassificationCase_append_only"
    BEFORE UPDATE OR DELETE ON "ClassificationCase"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_mutation"();

DROP TRIGGER IF EXISTS "ClassificationCaseInvalidation_append_only" ON "ClassificationCaseInvalidation";
CREATE TRIGGER "ClassificationCaseInvalidation_append_only"
    BEFORE UPDATE OR DELETE ON "ClassificationCaseInvalidation"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_mutation"();

DROP TRIGGER IF EXISTS "RuleRevision_append_only" ON "RuleRevision";
CREATE TRIGGER "RuleRevision_append_only"
    BEFORE UPDATE OR DELETE ON "RuleRevision"
    FOR EACH ROW
    EXECUTE FUNCTION "prevent_classification_memory_mutation"();
