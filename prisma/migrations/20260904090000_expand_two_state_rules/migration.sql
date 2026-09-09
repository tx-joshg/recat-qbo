BEGIN;

-- Expand storage only. This migration intentionally contains no canonical
-- backfill, live Rule pointer update, lifecycle transition, priority rewrite,
-- suggestion invalidation, or runtime-mode switch. Task 4 owns those writes.
CREATE TYPE "RuleRuntimeMode" AS ENUM ('legacy', 'bridge', 'paused', 'canonical');
CREATE TYPE "RuleDirection" AS ENUM ('Purchase', 'Deposit');

ALTER TABLE "Company"
  ADD COLUMN "ruleRuntimeMode" "RuleRuntimeMode" NOT NULL DEFAULT 'legacy';

ALTER TABLE "Rule"
  ADD COLUMN "direction" "RuleDirection",
  ADD COLUMN "canonicalVersion" INTEGER,
  ADD COLUMN "repairReason" VARCHAR(500),
  ADD COLUMN "affectedJournalEntryCount" INTEGER,
  ADD CONSTRAINT "Rule_canonicalVersion_check"
    CHECK ("canonicalVersion" IS NULL OR "canonicalVersion" >= 1),
  ADD CONSTRAINT "Rule_affectedJournalEntryCount_check"
    CHECK ("affectedJournalEntryCount" IS NULL OR "affectedJournalEntryCount" >= 0);

ALTER TABLE "RuleRevision"
  ADD COLUMN "direction" "RuleDirection",
  ADD COLUMN "canonicalVersion" INTEGER,
  ADD COLUMN "repairReason" VARCHAR(500),
  ADD COLUMN "affectedJournalEntryCount" INTEGER,
  ADD CONSTRAINT "RuleRevision_canonicalVersion_check"
    CHECK ("canonicalVersion" IS NULL OR "canonicalVersion" >= 1),
  ADD CONSTRAINT "RuleRevision_affectedJournalEntryCount_check"
    CHECK ("affectedJournalEntryCount" IS NULL OR "affectedJournalEntryCount" >= 0);

CREATE TABLE "RuleCanonicalMigration" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "canonicalRevision" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RuleCanonicalMigration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleCanonicalMigration_version_check"
    CHECK ("canonicalVersion" >= 1),
  CONSTRAINT "RuleCanonicalMigration_revision_check"
    CHECK ("sourceRevision" >= 0 AND "canonicalRevision" = "sourceRevision" + 1),
  CONSTRAINT "RuleCanonicalMigration_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuleCanonicalMigration_companyId_ruleId_fkey"
    FOREIGN KEY ("companyId", "ruleId") REFERENCES "Rule"("companyId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RuleCanonicalMigration_companyId_ruleId_canonicalVersion_key"
  ON "RuleCanonicalMigration"("companyId", "ruleId", "canonicalVersion");
CREATE INDEX "RuleCanonicalMigration_companyId_completedAt_idx"
  ON "RuleCanonicalMigration"("companyId", "completedAt");

CREATE OR REPLACE FUNCTION prevent_rule_canonical_migration_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $canonical_marker_append_only$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM "Company" company WHERE company."id" = OLD."companyId"
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RuleCanonicalMigration is append-only';
END;
$canonical_marker_append_only$;

CREATE TRIGGER "RuleCanonicalMigration_append_only"
  BEFORE UPDATE OR DELETE ON "RuleCanonicalMigration"
  FOR EACH ROW EXECUTE FUNCTION prevent_rule_canonical_migration_mutation();

-- This envelope is system-owned by construction: it has no actor, session, or
-- token columns and does not reuse or weaken McpOperation/McpRuleOperation.
-- Its scalar bindings survive independently; QBO write authority remains
-- exclusively in QboMutationAttempt, located by the immutable requestId.
CREATE TABLE "RuleAutoPostPreparation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "ruleRevision" INTEGER NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "proposal" JSONB NOT NULL,
  "proposalHash" CHAR(64) NOT NULL,
  "stagedGraphHash" CHAR(64) NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "preparedRevision" INTEGER NOT NULL,
  "qboType" VARCHAR(32) NOT NULL,
  "qboId" VARCHAR(128) NOT NULL,
  "qboSyncToken" VARCHAR(128) NOT NULL,
  "requestId" VARCHAR(128) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'PREPARED',
  "diagnostics" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(1000),
  "commitStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RuleAutoPostPreparation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleAutoPostPreparation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuleAutoPostPreparation_ruleRevision_check"
    CHECK ("ruleRevision" >= 0),
  CONSTRAINT "RuleAutoPostPreparation_revision_check"
    CHECK ("sourceRevision" >= 0 AND "preparedRevision" = "sourceRevision" + 1),
  CONSTRAINT "RuleAutoPostPreparation_inputHash_check"
    CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RuleAutoPostPreparation_proposalHash_check"
    CHECK ("proposalHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RuleAutoPostPreparation_stagedGraphHash_check"
    CHECK ("stagedGraphHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RuleAutoPostPreparation_proposal_check"
    CHECK (jsonb_typeof("proposal") = 'object'),
  CONSTRAINT "RuleAutoPostPreparation_qboType_check"
    CHECK ("qboType" IN ('Purchase', 'Deposit')),
  CONSTRAINT "RuleAutoPostPreparation_binding_check"
    CHECK (
      btrim("companyId") <> ''
      AND btrim("transactionId") <> ''
      AND btrim("ruleId") <> ''
      AND btrim("qboId") <> ''
      AND btrim("qboSyncToken") <> ''
      AND btrim("requestId") <> ''
    ),
  CONSTRAINT "RuleAutoPostPreparation_state_check"
    CHECK ("state" IN (
      'PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE',
      'VERIFIED', 'DRY_RUN', 'REJECTED', 'CANCELLED'
    )),
  CONSTRAINT "RuleAutoPostPreparation_diagnostics_check"
    CHECK (jsonb_typeof("diagnostics") = 'object'),
  CONSTRAINT "RuleAutoPostPreparation_timestamp_check"
    CHECK (
      "updatedAt" >= "createdAt"
      AND ("commitStartedAt" IS NULL OR "commitStartedAt" >= "createdAt")
      AND (
        "completedAt" IS NULL
        OR "completedAt" >= COALESCE("commitStartedAt", "createdAt")
      )
      AND (
        ("state" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE') AND "completedAt" IS NULL)
        OR
        ("state" IN ('VERIFIED', 'DRY_RUN', 'REJECTED', 'CANCELLED') AND "completedAt" IS NOT NULL)
      )
      AND (
        "state" NOT IN ('COMMITTING', 'UNCERTAIN', 'VERIFIED', 'REJECTED')
        OR "commitStartedAt" IS NOT NULL
      )
      AND ("state" <> 'PREPARED' OR "commitStartedAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "RuleAutoPostPreparation_requestId_key"
  ON "RuleAutoPostPreparation"("requestId");
CREATE UNIQUE INDEX "RuleAutoPostPreparation_active_transaction_key"
  ON "RuleAutoPostPreparation"("companyId", "transactionId")
  WHERE "state" IN ('PREPARED', 'COMMITTING', 'UNCERTAIN', 'RETRYABLE');
CREATE INDEX "RuleAutoPostPreparation_companyId_transactionId_idx"
  ON "RuleAutoPostPreparation"("companyId", "transactionId");
CREATE INDEX "RuleAutoPostPreparation_companyId_state_updatedAt_idx"
  ON "RuleAutoPostPreparation"("companyId", "state", "updatedAt");

CREATE OR REPLACE FUNCTION enforce_rule_auto_post_preparation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $preparation_immutability$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Company" company WHERE company."id" = OLD."companyId"
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'RuleAutoPostPreparation immutable core fields cannot be changed';
  END IF;

  IF ROW(
    NEW."id", NEW."companyId", NEW."transactionId", NEW."ruleId",
    NEW."ruleRevision", NEW."inputHash", NEW."proposal", NEW."proposalHash",
    NEW."stagedGraphHash", NEW."sourceRevision", NEW."preparedRevision",
    NEW."qboType", NEW."qboId", NEW."qboSyncToken", NEW."requestId",
    NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."companyId", OLD."transactionId", OLD."ruleId",
    OLD."ruleRevision", OLD."inputHash", OLD."proposal", OLD."proposalHash",
    OLD."stagedGraphHash", OLD."sourceRevision", OLD."preparedRevision",
    OLD."qboType", OLD."qboId", OLD."qboSyncToken", OLD."requestId",
    OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'RuleAutoPostPreparation immutable core fields cannot be changed';
  END IF;

  IF (OLD."commitStartedAt" IS NOT NULL AND NEW."commitStartedAt" IS DISTINCT FROM OLD."commitStartedAt")
     OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
     OR NEW."updatedAt" < OLD."updatedAt"
  THEN
    RAISE EXCEPTION 'RuleAutoPostPreparation lifecycle timestamps cannot move backward';
  END IF;

  IF OLD."state" IS DISTINCT FROM NEW."state" AND NOT (
    (OLD."state" = 'PREPARED' AND NEW."state" IN ('COMMITTING', 'RETRYABLE', 'DRY_RUN', 'CANCELLED'))
    OR (OLD."state" = 'RETRYABLE' AND NEW."state" IN ('COMMITTING', 'CANCELLED'))
    -- COMMITTING -> RETRYABLE is valid only when Task 8 proves no provider
    -- send occurred; this storage fence permits the evidence-backed edge.
    OR (OLD."state" = 'COMMITTING' AND NEW."state" IN ('VERIFIED', 'DRY_RUN', 'REJECTED', 'RETRYABLE', 'UNCERTAIN'))
    -- UNCERTAIN -> RETRYABLE is valid only after reconciliation proves that
    -- the provider entity is unchanged and therefore safe to restage.
    OR (OLD."state" = 'UNCERTAIN' AND NEW."state" IN ('VERIFIED', 'REJECTED', 'RETRYABLE'))
  ) THEN
    RAISE EXCEPTION 'RuleAutoPostPreparation state transition from % to % is not allowed',
      OLD."state", NEW."state";
  END IF;

  RETURN NEW;
END;
$preparation_immutability$;

CREATE TRIGGER "RuleAutoPostPreparation_immutable"
  BEFORE UPDATE OR DELETE ON "RuleAutoPostPreparation"
  FOR EACH ROW EXECUTE FUNCTION enforce_rule_auto_post_preparation_immutability();

-- Preserve the rolling old-writer fallback while making all newly introduced
-- canonical fields visible in the automatically captured revision zero.
CREATE OR REPLACE FUNCTION "capture_initial_rule_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $capture_initial$
BEGIN
  INSERT INTO "RuleRevision" (
    "id", "ruleId", "companyId", "revision", "state", "matchField",
    "matchText", "category", "categoryQboId", "taxCalculation", "taxCode",
    "taxCodeQboId", "tagIds", "priority", "autoPost", "originIntent",
    "sourceCaseId", "sourceCandidateId", "changedBy", "createdAt", "retiredAt",
    "direction", "canonicalVersion", "repairReason", "affectedJournalEntryCount"
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
    NEW."retiredAt",
    NEW."direction",
    NEW."canonicalVersion",
    NEW."repairReason",
    NEW."affectedJournalEntryCount"
  WHERE NOT EXISTS (
    SELECT 1 FROM "RuleRevision" revision
     WHERE revision."companyId" = NEW."companyId"
       AND revision."ruleId" = NEW."id"
       AND revision."revision" = 0
  )
  ON CONFLICT ("companyId", "ruleId", "revision") DO NOTHING;
  RETURN NEW;
END;
$capture_initial$;

-- Extend the constant-state lifecycle fingerprint. The fixed search path,
-- SECURITY DEFINER ownership, sorted company acquisition, and revoked direct
-- execution remain identical to the hardened predecessor.
CREATE OR REPLACE FUNCTION rule_lifecycle_bump_changed_rule_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $lifecycle_fingerprint$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    WITH old_changed AS (
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason", "direction",
             "canonicalVersion", "repairReason", "affectedJournalEntryCount"
        FROM old_rule_rows
      EXCEPT
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason", "direction",
             "canonicalVersion", "repairReason", "affectedJournalEntryCount"
        FROM new_rule_rows
    ),
    new_changed AS (
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason", "direction",
             "canonicalVersion", "repairReason", "affectedJournalEntryCount"
        FROM new_rule_rows
      EXCEPT
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason", "direction",
             "canonicalVersion", "repairReason", "affectedJournalEntryCount"
        FROM old_rule_rows
    )
    SELECT "companyId" FROM old_changed
    UNION
    SELECT "companyId" FROM new_changed
    ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$lifecycle_fingerprint$;

REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_changed_rule_companies() FROM PUBLIC;

-- Canonical fields are also classification-corpus-visible. Recreate only the
-- enumerating trigger; its existing append helper and ownership are unchanged.
DROP TRIGGER classification_corpus_rule_update ON "Rule";
CREATE TRIGGER classification_corpus_rule_update
AFTER UPDATE OF "id", "companyId", "matchText", "category", "categoryQboId", "taxCalculation", "taxCode", "taxCodeQboId", "enabled", "revision", "originIntent", "retiredAt", "reviewRequiredAt", "reviewReason", "direction", "canonicalVersion", "repairReason", "affectedJournalEntryCount" ON "Rule"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."matchText", OLD."category", OLD."categoryQboId", OLD."taxCalculation", OLD."taxCode", OLD."taxCodeQboId", OLD."enabled", OLD."revision", OLD."originIntent", OLD."retiredAt", OLD."reviewRequiredAt", OLD."reviewReason", OLD."direction", OLD."canonicalVersion", OLD."repairReason", OLD."affectedJournalEntryCount")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."matchText", NEW."category", NEW."categoryQboId", NEW."taxCalculation", NEW."taxCode", NEW."taxCodeQboId", NEW."enabled", NEW."revision", NEW."originIntent", NEW."retiredAt", NEW."reviewRequiredAt", NEW."reviewReason", NEW."direction", NEW."canonicalVersion", NEW."repairReason", NEW."affectedJournalEntryCount")
) EXECUTE FUNCTION classification_corpus_append_company_id();

-- BEGIN GENERATED UNICODE 16.0 DEFAULT CASE FOLD
-- GENERATED — DO NOT EDIT BY HAND.
-- Unicode 16.0.0 CaseFolding status C+F, Turkic T excluded.
-- Entries: 1557; canonical SHA-256: 3665d2456dc5fa6295527b8fe486e5a100cd898ab02585ec09b6db4b4244ab50.
-- Regenerate: python3 scripts/generate-unicode-case-fold.py --write-sql prisma/migrations/20260904090000_expand_two_state_rules/migration.sql
-- Verify: python3 scripts/generate-unicode-case-fold.py --check-sql prisma/migrations/20260904090000_expand_two_state_rules/migration.sql
CREATE OR REPLACE FUNCTION rule_unicode_case_fold_16_0(input_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $casefold$
  SELECT COALESCE(
    string_agg(
      CASE ascii(scalar_value)
        WHEN 65 THEN U&'\0061'
        WHEN 66 THEN U&'\0062'
        WHEN 67 THEN U&'\0063'
        WHEN 68 THEN U&'\0064'
        WHEN 69 THEN U&'\0065'
        WHEN 70 THEN U&'\0066'
        WHEN 71 THEN U&'\0067'
        WHEN 72 THEN U&'\0068'
        WHEN 73 THEN U&'\0069'
        WHEN 74 THEN U&'\006A'
        WHEN 75 THEN U&'\006B'
        WHEN 76 THEN U&'\006C'
        WHEN 77 THEN U&'\006D'
        WHEN 78 THEN U&'\006E'
        WHEN 79 THEN U&'\006F'
        WHEN 80 THEN U&'\0070'
        WHEN 81 THEN U&'\0071'
        WHEN 82 THEN U&'\0072'
        WHEN 83 THEN U&'\0073'
        WHEN 84 THEN U&'\0074'
        WHEN 85 THEN U&'\0075'
        WHEN 86 THEN U&'\0076'
        WHEN 87 THEN U&'\0077'
        WHEN 88 THEN U&'\0078'
        WHEN 89 THEN U&'\0079'
        WHEN 90 THEN U&'\007A'
        WHEN 181 THEN U&'\03BC'
        WHEN 192 THEN U&'\00E0'
        WHEN 193 THEN U&'\00E1'
        WHEN 194 THEN U&'\00E2'
        WHEN 195 THEN U&'\00E3'
        WHEN 196 THEN U&'\00E4'
        WHEN 197 THEN U&'\00E5'
        WHEN 198 THEN U&'\00E6'
        WHEN 199 THEN U&'\00E7'
        WHEN 200 THEN U&'\00E8'
        WHEN 201 THEN U&'\00E9'
        WHEN 202 THEN U&'\00EA'
        WHEN 203 THEN U&'\00EB'
        WHEN 204 THEN U&'\00EC'
        WHEN 205 THEN U&'\00ED'
        WHEN 206 THEN U&'\00EE'
        WHEN 207 THEN U&'\00EF'
        WHEN 208 THEN U&'\00F0'
        WHEN 209 THEN U&'\00F1'
        WHEN 210 THEN U&'\00F2'
        WHEN 211 THEN U&'\00F3'
        WHEN 212 THEN U&'\00F4'
        WHEN 213 THEN U&'\00F5'
        WHEN 214 THEN U&'\00F6'
        WHEN 216 THEN U&'\00F8'
        WHEN 217 THEN U&'\00F9'
        WHEN 218 THEN U&'\00FA'
        WHEN 219 THEN U&'\00FB'
        WHEN 220 THEN U&'\00FC'
        WHEN 221 THEN U&'\00FD'
        WHEN 222 THEN U&'\00FE'
        WHEN 223 THEN U&'\0073\0073'
        WHEN 256 THEN U&'\0101'
        WHEN 258 THEN U&'\0103'
        WHEN 260 THEN U&'\0105'
        WHEN 262 THEN U&'\0107'
        WHEN 264 THEN U&'\0109'
        WHEN 266 THEN U&'\010B'
        WHEN 268 THEN U&'\010D'
        WHEN 270 THEN U&'\010F'
        WHEN 272 THEN U&'\0111'
        WHEN 274 THEN U&'\0113'
        WHEN 276 THEN U&'\0115'
        WHEN 278 THEN U&'\0117'
        WHEN 280 THEN U&'\0119'
        WHEN 282 THEN U&'\011B'
        WHEN 284 THEN U&'\011D'
        WHEN 286 THEN U&'\011F'
        WHEN 288 THEN U&'\0121'
        WHEN 290 THEN U&'\0123'
        WHEN 292 THEN U&'\0125'
        WHEN 294 THEN U&'\0127'
        WHEN 296 THEN U&'\0129'
        WHEN 298 THEN U&'\012B'
        WHEN 300 THEN U&'\012D'
        WHEN 302 THEN U&'\012F'
        WHEN 304 THEN U&'\0069\0307'
        WHEN 306 THEN U&'\0133'
        WHEN 308 THEN U&'\0135'
        WHEN 310 THEN U&'\0137'
        WHEN 313 THEN U&'\013A'
        WHEN 315 THEN U&'\013C'
        WHEN 317 THEN U&'\013E'
        WHEN 319 THEN U&'\0140'
        WHEN 321 THEN U&'\0142'
        WHEN 323 THEN U&'\0144'
        WHEN 325 THEN U&'\0146'
        WHEN 327 THEN U&'\0148'
        WHEN 329 THEN U&'\02BC\006E'
        WHEN 330 THEN U&'\014B'
        WHEN 332 THEN U&'\014D'
        WHEN 334 THEN U&'\014F'
        WHEN 336 THEN U&'\0151'
        WHEN 338 THEN U&'\0153'
        WHEN 340 THEN U&'\0155'
        WHEN 342 THEN U&'\0157'
        WHEN 344 THEN U&'\0159'
        WHEN 346 THEN U&'\015B'
        WHEN 348 THEN U&'\015D'
        WHEN 350 THEN U&'\015F'
        WHEN 352 THEN U&'\0161'
        WHEN 354 THEN U&'\0163'
        WHEN 356 THEN U&'\0165'
        WHEN 358 THEN U&'\0167'
        WHEN 360 THEN U&'\0169'
        WHEN 362 THEN U&'\016B'
        WHEN 364 THEN U&'\016D'
        WHEN 366 THEN U&'\016F'
        WHEN 368 THEN U&'\0171'
        WHEN 370 THEN U&'\0173'
        WHEN 372 THEN U&'\0175'
        WHEN 374 THEN U&'\0177'
        WHEN 376 THEN U&'\00FF'
        WHEN 377 THEN U&'\017A'
        WHEN 379 THEN U&'\017C'
        WHEN 381 THEN U&'\017E'
        WHEN 383 THEN U&'\0073'
        WHEN 385 THEN U&'\0253'
        WHEN 386 THEN U&'\0183'
        WHEN 388 THEN U&'\0185'
        WHEN 390 THEN U&'\0254'
        WHEN 391 THEN U&'\0188'
        WHEN 393 THEN U&'\0256'
        WHEN 394 THEN U&'\0257'
        WHEN 395 THEN U&'\018C'
        WHEN 398 THEN U&'\01DD'
        WHEN 399 THEN U&'\0259'
        WHEN 400 THEN U&'\025B'
        WHEN 401 THEN U&'\0192'
        WHEN 403 THEN U&'\0260'
        WHEN 404 THEN U&'\0263'
        WHEN 406 THEN U&'\0269'
        WHEN 407 THEN U&'\0268'
        WHEN 408 THEN U&'\0199'
        WHEN 412 THEN U&'\026F'
        WHEN 413 THEN U&'\0272'
        WHEN 415 THEN U&'\0275'
        WHEN 416 THEN U&'\01A1'
        WHEN 418 THEN U&'\01A3'
        WHEN 420 THEN U&'\01A5'
        WHEN 422 THEN U&'\0280'
        WHEN 423 THEN U&'\01A8'
        WHEN 425 THEN U&'\0283'
        WHEN 428 THEN U&'\01AD'
        WHEN 430 THEN U&'\0288'
        WHEN 431 THEN U&'\01B0'
        WHEN 433 THEN U&'\028A'
        WHEN 434 THEN U&'\028B'
        WHEN 435 THEN U&'\01B4'
        WHEN 437 THEN U&'\01B6'
        WHEN 439 THEN U&'\0292'
        WHEN 440 THEN U&'\01B9'
        WHEN 444 THEN U&'\01BD'
        WHEN 452 THEN U&'\01C6'
        WHEN 453 THEN U&'\01C6'
        WHEN 455 THEN U&'\01C9'
        WHEN 456 THEN U&'\01C9'
        WHEN 458 THEN U&'\01CC'
        WHEN 459 THEN U&'\01CC'
        WHEN 461 THEN U&'\01CE'
        WHEN 463 THEN U&'\01D0'
        WHEN 465 THEN U&'\01D2'
        WHEN 467 THEN U&'\01D4'
        WHEN 469 THEN U&'\01D6'
        WHEN 471 THEN U&'\01D8'
        WHEN 473 THEN U&'\01DA'
        WHEN 475 THEN U&'\01DC'
        WHEN 478 THEN U&'\01DF'
        WHEN 480 THEN U&'\01E1'
        WHEN 482 THEN U&'\01E3'
        WHEN 484 THEN U&'\01E5'
        WHEN 486 THEN U&'\01E7'
        WHEN 488 THEN U&'\01E9'
        WHEN 490 THEN U&'\01EB'
        WHEN 492 THEN U&'\01ED'
        WHEN 494 THEN U&'\01EF'
        WHEN 496 THEN U&'\006A\030C'
        WHEN 497 THEN U&'\01F3'
        WHEN 498 THEN U&'\01F3'
        WHEN 500 THEN U&'\01F5'
        WHEN 502 THEN U&'\0195'
        WHEN 503 THEN U&'\01BF'
        WHEN 504 THEN U&'\01F9'
        WHEN 506 THEN U&'\01FB'
        WHEN 508 THEN U&'\01FD'
        WHEN 510 THEN U&'\01FF'
        WHEN 512 THEN U&'\0201'
        WHEN 514 THEN U&'\0203'
        WHEN 516 THEN U&'\0205'
        WHEN 518 THEN U&'\0207'
        WHEN 520 THEN U&'\0209'
        WHEN 522 THEN U&'\020B'
        WHEN 524 THEN U&'\020D'
        WHEN 526 THEN U&'\020F'
        WHEN 528 THEN U&'\0211'
        WHEN 530 THEN U&'\0213'
        WHEN 532 THEN U&'\0215'
        WHEN 534 THEN U&'\0217'
        WHEN 536 THEN U&'\0219'
        WHEN 538 THEN U&'\021B'
        WHEN 540 THEN U&'\021D'
        WHEN 542 THEN U&'\021F'
        WHEN 544 THEN U&'\019E'
        WHEN 546 THEN U&'\0223'
        WHEN 548 THEN U&'\0225'
        WHEN 550 THEN U&'\0227'
        WHEN 552 THEN U&'\0229'
        WHEN 554 THEN U&'\022B'
        WHEN 556 THEN U&'\022D'
        WHEN 558 THEN U&'\022F'
        WHEN 560 THEN U&'\0231'
        WHEN 562 THEN U&'\0233'
        WHEN 570 THEN U&'\2C65'
        WHEN 571 THEN U&'\023C'
        WHEN 573 THEN U&'\019A'
        WHEN 574 THEN U&'\2C66'
        WHEN 577 THEN U&'\0242'
        WHEN 579 THEN U&'\0180'
        WHEN 580 THEN U&'\0289'
        WHEN 581 THEN U&'\028C'
        WHEN 582 THEN U&'\0247'
        WHEN 584 THEN U&'\0249'
        WHEN 586 THEN U&'\024B'
        WHEN 588 THEN U&'\024D'
        WHEN 590 THEN U&'\024F'
        WHEN 837 THEN U&'\03B9'
        WHEN 880 THEN U&'\0371'
        WHEN 882 THEN U&'\0373'
        WHEN 886 THEN U&'\0377'
        WHEN 895 THEN U&'\03F3'
        WHEN 902 THEN U&'\03AC'
        WHEN 904 THEN U&'\03AD'
        WHEN 905 THEN U&'\03AE'
        WHEN 906 THEN U&'\03AF'
        WHEN 908 THEN U&'\03CC'
        WHEN 910 THEN U&'\03CD'
        WHEN 911 THEN U&'\03CE'
        WHEN 912 THEN U&'\03B9\0308\0301'
        WHEN 913 THEN U&'\03B1'
        WHEN 914 THEN U&'\03B2'
        WHEN 915 THEN U&'\03B3'
        WHEN 916 THEN U&'\03B4'
        WHEN 917 THEN U&'\03B5'
        WHEN 918 THEN U&'\03B6'
        WHEN 919 THEN U&'\03B7'
        WHEN 920 THEN U&'\03B8'
        WHEN 921 THEN U&'\03B9'
        WHEN 922 THEN U&'\03BA'
        WHEN 923 THEN U&'\03BB'
        WHEN 924 THEN U&'\03BC'
        WHEN 925 THEN U&'\03BD'
        WHEN 926 THEN U&'\03BE'
        WHEN 927 THEN U&'\03BF'
        WHEN 928 THEN U&'\03C0'
        WHEN 929 THEN U&'\03C1'
        WHEN 931 THEN U&'\03C3'
        WHEN 932 THEN U&'\03C4'
        WHEN 933 THEN U&'\03C5'
        WHEN 934 THEN U&'\03C6'
        WHEN 935 THEN U&'\03C7'
        WHEN 936 THEN U&'\03C8'
        WHEN 937 THEN U&'\03C9'
        WHEN 938 THEN U&'\03CA'
        WHEN 939 THEN U&'\03CB'
        WHEN 944 THEN U&'\03C5\0308\0301'
        WHEN 962 THEN U&'\03C3'
        WHEN 975 THEN U&'\03D7'
        WHEN 976 THEN U&'\03B2'
        WHEN 977 THEN U&'\03B8'
        WHEN 981 THEN U&'\03C6'
        WHEN 982 THEN U&'\03C0'
        WHEN 984 THEN U&'\03D9'
        WHEN 986 THEN U&'\03DB'
        WHEN 988 THEN U&'\03DD'
        WHEN 990 THEN U&'\03DF'
        WHEN 992 THEN U&'\03E1'
        WHEN 994 THEN U&'\03E3'
        WHEN 996 THEN U&'\03E5'
        WHEN 998 THEN U&'\03E7'
        WHEN 1000 THEN U&'\03E9'
        WHEN 1002 THEN U&'\03EB'
        WHEN 1004 THEN U&'\03ED'
        WHEN 1006 THEN U&'\03EF'
        WHEN 1008 THEN U&'\03BA'
        WHEN 1009 THEN U&'\03C1'
        WHEN 1012 THEN U&'\03B8'
        WHEN 1013 THEN U&'\03B5'
        WHEN 1015 THEN U&'\03F8'
        WHEN 1017 THEN U&'\03F2'
        WHEN 1018 THEN U&'\03FB'
        WHEN 1021 THEN U&'\037B'
        WHEN 1022 THEN U&'\037C'
        WHEN 1023 THEN U&'\037D'
        WHEN 1024 THEN U&'\0450'
        WHEN 1025 THEN U&'\0451'
        WHEN 1026 THEN U&'\0452'
        WHEN 1027 THEN U&'\0453'
        WHEN 1028 THEN U&'\0454'
        WHEN 1029 THEN U&'\0455'
        WHEN 1030 THEN U&'\0456'
        WHEN 1031 THEN U&'\0457'
        WHEN 1032 THEN U&'\0458'
        WHEN 1033 THEN U&'\0459'
        WHEN 1034 THEN U&'\045A'
        WHEN 1035 THEN U&'\045B'
        WHEN 1036 THEN U&'\045C'
        WHEN 1037 THEN U&'\045D'
        WHEN 1038 THEN U&'\045E'
        WHEN 1039 THEN U&'\045F'
        WHEN 1040 THEN U&'\0430'
        WHEN 1041 THEN U&'\0431'
        WHEN 1042 THEN U&'\0432'
        WHEN 1043 THEN U&'\0433'
        WHEN 1044 THEN U&'\0434'
        WHEN 1045 THEN U&'\0435'
        WHEN 1046 THEN U&'\0436'
        WHEN 1047 THEN U&'\0437'
        WHEN 1048 THEN U&'\0438'
        WHEN 1049 THEN U&'\0439'
        WHEN 1050 THEN U&'\043A'
        WHEN 1051 THEN U&'\043B'
        WHEN 1052 THEN U&'\043C'
        WHEN 1053 THEN U&'\043D'
        WHEN 1054 THEN U&'\043E'
        WHEN 1055 THEN U&'\043F'
        WHEN 1056 THEN U&'\0440'
        WHEN 1057 THEN U&'\0441'
        WHEN 1058 THEN U&'\0442'
        WHEN 1059 THEN U&'\0443'
        WHEN 1060 THEN U&'\0444'
        WHEN 1061 THEN U&'\0445'
        WHEN 1062 THEN U&'\0446'
        WHEN 1063 THEN U&'\0447'
        WHEN 1064 THEN U&'\0448'
        WHEN 1065 THEN U&'\0449'
        WHEN 1066 THEN U&'\044A'
        WHEN 1067 THEN U&'\044B'
        WHEN 1068 THEN U&'\044C'
        WHEN 1069 THEN U&'\044D'
        WHEN 1070 THEN U&'\044E'
        WHEN 1071 THEN U&'\044F'
        WHEN 1120 THEN U&'\0461'
        WHEN 1122 THEN U&'\0463'
        WHEN 1124 THEN U&'\0465'
        WHEN 1126 THEN U&'\0467'
        WHEN 1128 THEN U&'\0469'
        WHEN 1130 THEN U&'\046B'
        WHEN 1132 THEN U&'\046D'
        WHEN 1134 THEN U&'\046F'
        WHEN 1136 THEN U&'\0471'
        WHEN 1138 THEN U&'\0473'
        WHEN 1140 THEN U&'\0475'
        WHEN 1142 THEN U&'\0477'
        WHEN 1144 THEN U&'\0479'
        WHEN 1146 THEN U&'\047B'
        WHEN 1148 THEN U&'\047D'
        WHEN 1150 THEN U&'\047F'
        WHEN 1152 THEN U&'\0481'
        WHEN 1162 THEN U&'\048B'
        WHEN 1164 THEN U&'\048D'
        WHEN 1166 THEN U&'\048F'
        WHEN 1168 THEN U&'\0491'
        WHEN 1170 THEN U&'\0493'
        WHEN 1172 THEN U&'\0495'
        WHEN 1174 THEN U&'\0497'
        WHEN 1176 THEN U&'\0499'
        WHEN 1178 THEN U&'\049B'
        WHEN 1180 THEN U&'\049D'
        WHEN 1182 THEN U&'\049F'
        WHEN 1184 THEN U&'\04A1'
        WHEN 1186 THEN U&'\04A3'
        WHEN 1188 THEN U&'\04A5'
        WHEN 1190 THEN U&'\04A7'
        WHEN 1192 THEN U&'\04A9'
        WHEN 1194 THEN U&'\04AB'
        WHEN 1196 THEN U&'\04AD'
        WHEN 1198 THEN U&'\04AF'
        WHEN 1200 THEN U&'\04B1'
        WHEN 1202 THEN U&'\04B3'
        WHEN 1204 THEN U&'\04B5'
        WHEN 1206 THEN U&'\04B7'
        WHEN 1208 THEN U&'\04B9'
        WHEN 1210 THEN U&'\04BB'
        WHEN 1212 THEN U&'\04BD'
        WHEN 1214 THEN U&'\04BF'
        WHEN 1216 THEN U&'\04CF'
        WHEN 1217 THEN U&'\04C2'
        WHEN 1219 THEN U&'\04C4'
        WHEN 1221 THEN U&'\04C6'
        WHEN 1223 THEN U&'\04C8'
        WHEN 1225 THEN U&'\04CA'
        WHEN 1227 THEN U&'\04CC'
        WHEN 1229 THEN U&'\04CE'
        WHEN 1232 THEN U&'\04D1'
        WHEN 1234 THEN U&'\04D3'
        WHEN 1236 THEN U&'\04D5'
        WHEN 1238 THEN U&'\04D7'
        WHEN 1240 THEN U&'\04D9'
        WHEN 1242 THEN U&'\04DB'
        WHEN 1244 THEN U&'\04DD'
        WHEN 1246 THEN U&'\04DF'
        WHEN 1248 THEN U&'\04E1'
        WHEN 1250 THEN U&'\04E3'
        WHEN 1252 THEN U&'\04E5'
        WHEN 1254 THEN U&'\04E7'
        WHEN 1256 THEN U&'\04E9'
        WHEN 1258 THEN U&'\04EB'
        WHEN 1260 THEN U&'\04ED'
        WHEN 1262 THEN U&'\04EF'
        WHEN 1264 THEN U&'\04F1'
        WHEN 1266 THEN U&'\04F3'
        WHEN 1268 THEN U&'\04F5'
        WHEN 1270 THEN U&'\04F7'
        WHEN 1272 THEN U&'\04F9'
        WHEN 1274 THEN U&'\04FB'
        WHEN 1276 THEN U&'\04FD'
        WHEN 1278 THEN U&'\04FF'
        WHEN 1280 THEN U&'\0501'
        WHEN 1282 THEN U&'\0503'
        WHEN 1284 THEN U&'\0505'
        WHEN 1286 THEN U&'\0507'
        WHEN 1288 THEN U&'\0509'
        WHEN 1290 THEN U&'\050B'
        WHEN 1292 THEN U&'\050D'
        WHEN 1294 THEN U&'\050F'
        WHEN 1296 THEN U&'\0511'
        WHEN 1298 THEN U&'\0513'
        WHEN 1300 THEN U&'\0515'
        WHEN 1302 THEN U&'\0517'
        WHEN 1304 THEN U&'\0519'
        WHEN 1306 THEN U&'\051B'
        WHEN 1308 THEN U&'\051D'
        WHEN 1310 THEN U&'\051F'
        WHEN 1312 THEN U&'\0521'
        WHEN 1314 THEN U&'\0523'
        WHEN 1316 THEN U&'\0525'
        WHEN 1318 THEN U&'\0527'
        WHEN 1320 THEN U&'\0529'
        WHEN 1322 THEN U&'\052B'
        WHEN 1324 THEN U&'\052D'
        WHEN 1326 THEN U&'\052F'
        WHEN 1329 THEN U&'\0561'
        WHEN 1330 THEN U&'\0562'
        WHEN 1331 THEN U&'\0563'
        WHEN 1332 THEN U&'\0564'
        WHEN 1333 THEN U&'\0565'
        WHEN 1334 THEN U&'\0566'
        WHEN 1335 THEN U&'\0567'
        WHEN 1336 THEN U&'\0568'
        WHEN 1337 THEN U&'\0569'
        WHEN 1338 THEN U&'\056A'
        WHEN 1339 THEN U&'\056B'
        WHEN 1340 THEN U&'\056C'
        WHEN 1341 THEN U&'\056D'
        WHEN 1342 THEN U&'\056E'
        WHEN 1343 THEN U&'\056F'
        WHEN 1344 THEN U&'\0570'
        WHEN 1345 THEN U&'\0571'
        WHEN 1346 THEN U&'\0572'
        WHEN 1347 THEN U&'\0573'
        WHEN 1348 THEN U&'\0574'
        WHEN 1349 THEN U&'\0575'
        WHEN 1350 THEN U&'\0576'
        WHEN 1351 THEN U&'\0577'
        WHEN 1352 THEN U&'\0578'
        WHEN 1353 THEN U&'\0579'
        WHEN 1354 THEN U&'\057A'
        WHEN 1355 THEN U&'\057B'
        WHEN 1356 THEN U&'\057C'
        WHEN 1357 THEN U&'\057D'
        WHEN 1358 THEN U&'\057E'
        WHEN 1359 THEN U&'\057F'
        WHEN 1360 THEN U&'\0580'
        WHEN 1361 THEN U&'\0581'
        WHEN 1362 THEN U&'\0582'
        WHEN 1363 THEN U&'\0583'
        WHEN 1364 THEN U&'\0584'
        WHEN 1365 THEN U&'\0585'
        WHEN 1366 THEN U&'\0586'
        WHEN 1415 THEN U&'\0565\0582'
        WHEN 4256 THEN U&'\2D00'
        WHEN 4257 THEN U&'\2D01'
        WHEN 4258 THEN U&'\2D02'
        WHEN 4259 THEN U&'\2D03'
        WHEN 4260 THEN U&'\2D04'
        WHEN 4261 THEN U&'\2D05'
        WHEN 4262 THEN U&'\2D06'
        WHEN 4263 THEN U&'\2D07'
        WHEN 4264 THEN U&'\2D08'
        WHEN 4265 THEN U&'\2D09'
        WHEN 4266 THEN U&'\2D0A'
        WHEN 4267 THEN U&'\2D0B'
        WHEN 4268 THEN U&'\2D0C'
        WHEN 4269 THEN U&'\2D0D'
        WHEN 4270 THEN U&'\2D0E'
        WHEN 4271 THEN U&'\2D0F'
        WHEN 4272 THEN U&'\2D10'
        WHEN 4273 THEN U&'\2D11'
        WHEN 4274 THEN U&'\2D12'
        WHEN 4275 THEN U&'\2D13'
        WHEN 4276 THEN U&'\2D14'
        WHEN 4277 THEN U&'\2D15'
        WHEN 4278 THEN U&'\2D16'
        WHEN 4279 THEN U&'\2D17'
        WHEN 4280 THEN U&'\2D18'
        WHEN 4281 THEN U&'\2D19'
        WHEN 4282 THEN U&'\2D1A'
        WHEN 4283 THEN U&'\2D1B'
        WHEN 4284 THEN U&'\2D1C'
        WHEN 4285 THEN U&'\2D1D'
        WHEN 4286 THEN U&'\2D1E'
        WHEN 4287 THEN U&'\2D1F'
        WHEN 4288 THEN U&'\2D20'
        WHEN 4289 THEN U&'\2D21'
        WHEN 4290 THEN U&'\2D22'
        WHEN 4291 THEN U&'\2D23'
        WHEN 4292 THEN U&'\2D24'
        WHEN 4293 THEN U&'\2D25'
        WHEN 4295 THEN U&'\2D27'
        WHEN 4301 THEN U&'\2D2D'
        WHEN 5112 THEN U&'\13F0'
        WHEN 5113 THEN U&'\13F1'
        WHEN 5114 THEN U&'\13F2'
        WHEN 5115 THEN U&'\13F3'
        WHEN 5116 THEN U&'\13F4'
        WHEN 5117 THEN U&'\13F5'
        WHEN 7296 THEN U&'\0432'
        WHEN 7297 THEN U&'\0434'
        WHEN 7298 THEN U&'\043E'
        WHEN 7299 THEN U&'\0441'
        WHEN 7300 THEN U&'\0442'
        WHEN 7301 THEN U&'\0442'
        WHEN 7302 THEN U&'\044A'
        WHEN 7303 THEN U&'\0463'
        WHEN 7304 THEN U&'\A64B'
        WHEN 7305 THEN U&'\1C8A'
        WHEN 7312 THEN U&'\10D0'
        WHEN 7313 THEN U&'\10D1'
        WHEN 7314 THEN U&'\10D2'
        WHEN 7315 THEN U&'\10D3'
        WHEN 7316 THEN U&'\10D4'
        WHEN 7317 THEN U&'\10D5'
        WHEN 7318 THEN U&'\10D6'
        WHEN 7319 THEN U&'\10D7'
        WHEN 7320 THEN U&'\10D8'
        WHEN 7321 THEN U&'\10D9'
        WHEN 7322 THEN U&'\10DA'
        WHEN 7323 THEN U&'\10DB'
        WHEN 7324 THEN U&'\10DC'
        WHEN 7325 THEN U&'\10DD'
        WHEN 7326 THEN U&'\10DE'
        WHEN 7327 THEN U&'\10DF'
        WHEN 7328 THEN U&'\10E0'
        WHEN 7329 THEN U&'\10E1'
        WHEN 7330 THEN U&'\10E2'
        WHEN 7331 THEN U&'\10E3'
        WHEN 7332 THEN U&'\10E4'
        WHEN 7333 THEN U&'\10E5'
        WHEN 7334 THEN U&'\10E6'
        WHEN 7335 THEN U&'\10E7'
        WHEN 7336 THEN U&'\10E8'
        WHEN 7337 THEN U&'\10E9'
        WHEN 7338 THEN U&'\10EA'
        WHEN 7339 THEN U&'\10EB'
        WHEN 7340 THEN U&'\10EC'
        WHEN 7341 THEN U&'\10ED'
        WHEN 7342 THEN U&'\10EE'
        WHEN 7343 THEN U&'\10EF'
        WHEN 7344 THEN U&'\10F0'
        WHEN 7345 THEN U&'\10F1'
        WHEN 7346 THEN U&'\10F2'
        WHEN 7347 THEN U&'\10F3'
        WHEN 7348 THEN U&'\10F4'
        WHEN 7349 THEN U&'\10F5'
        WHEN 7350 THEN U&'\10F6'
        WHEN 7351 THEN U&'\10F7'
        WHEN 7352 THEN U&'\10F8'
        WHEN 7353 THEN U&'\10F9'
        WHEN 7354 THEN U&'\10FA'
        WHEN 7357 THEN U&'\10FD'
        WHEN 7358 THEN U&'\10FE'
        WHEN 7359 THEN U&'\10FF'
        WHEN 7680 THEN U&'\1E01'
        WHEN 7682 THEN U&'\1E03'
        WHEN 7684 THEN U&'\1E05'
        WHEN 7686 THEN U&'\1E07'
        WHEN 7688 THEN U&'\1E09'
        WHEN 7690 THEN U&'\1E0B'
        WHEN 7692 THEN U&'\1E0D'
        WHEN 7694 THEN U&'\1E0F'
        WHEN 7696 THEN U&'\1E11'
        WHEN 7698 THEN U&'\1E13'
        WHEN 7700 THEN U&'\1E15'
        WHEN 7702 THEN U&'\1E17'
        WHEN 7704 THEN U&'\1E19'
        WHEN 7706 THEN U&'\1E1B'
        WHEN 7708 THEN U&'\1E1D'
        WHEN 7710 THEN U&'\1E1F'
        WHEN 7712 THEN U&'\1E21'
        WHEN 7714 THEN U&'\1E23'
        WHEN 7716 THEN U&'\1E25'
        WHEN 7718 THEN U&'\1E27'
        WHEN 7720 THEN U&'\1E29'
        WHEN 7722 THEN U&'\1E2B'
        WHEN 7724 THEN U&'\1E2D'
        WHEN 7726 THEN U&'\1E2F'
        WHEN 7728 THEN U&'\1E31'
        WHEN 7730 THEN U&'\1E33'
        WHEN 7732 THEN U&'\1E35'
        WHEN 7734 THEN U&'\1E37'
        WHEN 7736 THEN U&'\1E39'
        WHEN 7738 THEN U&'\1E3B'
        WHEN 7740 THEN U&'\1E3D'
        WHEN 7742 THEN U&'\1E3F'
        WHEN 7744 THEN U&'\1E41'
        WHEN 7746 THEN U&'\1E43'
        WHEN 7748 THEN U&'\1E45'
        WHEN 7750 THEN U&'\1E47'
        WHEN 7752 THEN U&'\1E49'
        WHEN 7754 THEN U&'\1E4B'
        WHEN 7756 THEN U&'\1E4D'
        WHEN 7758 THEN U&'\1E4F'
        WHEN 7760 THEN U&'\1E51'
        WHEN 7762 THEN U&'\1E53'
        WHEN 7764 THEN U&'\1E55'
        WHEN 7766 THEN U&'\1E57'
        WHEN 7768 THEN U&'\1E59'
        WHEN 7770 THEN U&'\1E5B'
        WHEN 7772 THEN U&'\1E5D'
        WHEN 7774 THEN U&'\1E5F'
        WHEN 7776 THEN U&'\1E61'
        WHEN 7778 THEN U&'\1E63'
        WHEN 7780 THEN U&'\1E65'
        WHEN 7782 THEN U&'\1E67'
        WHEN 7784 THEN U&'\1E69'
        WHEN 7786 THEN U&'\1E6B'
        WHEN 7788 THEN U&'\1E6D'
        WHEN 7790 THEN U&'\1E6F'
        WHEN 7792 THEN U&'\1E71'
        WHEN 7794 THEN U&'\1E73'
        WHEN 7796 THEN U&'\1E75'
        WHEN 7798 THEN U&'\1E77'
        WHEN 7800 THEN U&'\1E79'
        WHEN 7802 THEN U&'\1E7B'
        WHEN 7804 THEN U&'\1E7D'
        WHEN 7806 THEN U&'\1E7F'
        WHEN 7808 THEN U&'\1E81'
        WHEN 7810 THEN U&'\1E83'
        WHEN 7812 THEN U&'\1E85'
        WHEN 7814 THEN U&'\1E87'
        WHEN 7816 THEN U&'\1E89'
        WHEN 7818 THEN U&'\1E8B'
        WHEN 7820 THEN U&'\1E8D'
        WHEN 7822 THEN U&'\1E8F'
        WHEN 7824 THEN U&'\1E91'
        WHEN 7826 THEN U&'\1E93'
        WHEN 7828 THEN U&'\1E95'
        WHEN 7830 THEN U&'\0068\0331'
        WHEN 7831 THEN U&'\0074\0308'
        WHEN 7832 THEN U&'\0077\030A'
        WHEN 7833 THEN U&'\0079\030A'
        WHEN 7834 THEN U&'\0061\02BE'
        WHEN 7835 THEN U&'\1E61'
        WHEN 7838 THEN U&'\0073\0073'
        WHEN 7840 THEN U&'\1EA1'
        WHEN 7842 THEN U&'\1EA3'
        WHEN 7844 THEN U&'\1EA5'
        WHEN 7846 THEN U&'\1EA7'
        WHEN 7848 THEN U&'\1EA9'
        WHEN 7850 THEN U&'\1EAB'
        WHEN 7852 THEN U&'\1EAD'
        WHEN 7854 THEN U&'\1EAF'
        WHEN 7856 THEN U&'\1EB1'
        WHEN 7858 THEN U&'\1EB3'
        WHEN 7860 THEN U&'\1EB5'
        WHEN 7862 THEN U&'\1EB7'
        WHEN 7864 THEN U&'\1EB9'
        WHEN 7866 THEN U&'\1EBB'
        WHEN 7868 THEN U&'\1EBD'
        WHEN 7870 THEN U&'\1EBF'
        WHEN 7872 THEN U&'\1EC1'
        WHEN 7874 THEN U&'\1EC3'
        WHEN 7876 THEN U&'\1EC5'
        WHEN 7878 THEN U&'\1EC7'
        WHEN 7880 THEN U&'\1EC9'
        WHEN 7882 THEN U&'\1ECB'
        WHEN 7884 THEN U&'\1ECD'
        WHEN 7886 THEN U&'\1ECF'
        WHEN 7888 THEN U&'\1ED1'
        WHEN 7890 THEN U&'\1ED3'
        WHEN 7892 THEN U&'\1ED5'
        WHEN 7894 THEN U&'\1ED7'
        WHEN 7896 THEN U&'\1ED9'
        WHEN 7898 THEN U&'\1EDB'
        WHEN 7900 THEN U&'\1EDD'
        WHEN 7902 THEN U&'\1EDF'
        WHEN 7904 THEN U&'\1EE1'
        WHEN 7906 THEN U&'\1EE3'
        WHEN 7908 THEN U&'\1EE5'
        WHEN 7910 THEN U&'\1EE7'
        WHEN 7912 THEN U&'\1EE9'
        WHEN 7914 THEN U&'\1EEB'
        WHEN 7916 THEN U&'\1EED'
        WHEN 7918 THEN U&'\1EEF'
        WHEN 7920 THEN U&'\1EF1'
        WHEN 7922 THEN U&'\1EF3'
        WHEN 7924 THEN U&'\1EF5'
        WHEN 7926 THEN U&'\1EF7'
        WHEN 7928 THEN U&'\1EF9'
        WHEN 7930 THEN U&'\1EFB'
        WHEN 7932 THEN U&'\1EFD'
        WHEN 7934 THEN U&'\1EFF'
        WHEN 7944 THEN U&'\1F00'
        WHEN 7945 THEN U&'\1F01'
        WHEN 7946 THEN U&'\1F02'
        WHEN 7947 THEN U&'\1F03'
        WHEN 7948 THEN U&'\1F04'
        WHEN 7949 THEN U&'\1F05'
        WHEN 7950 THEN U&'\1F06'
        WHEN 7951 THEN U&'\1F07'
        WHEN 7960 THEN U&'\1F10'
        WHEN 7961 THEN U&'\1F11'
        WHEN 7962 THEN U&'\1F12'
        WHEN 7963 THEN U&'\1F13'
        WHEN 7964 THEN U&'\1F14'
        WHEN 7965 THEN U&'\1F15'
        WHEN 7976 THEN U&'\1F20'
        WHEN 7977 THEN U&'\1F21'
        WHEN 7978 THEN U&'\1F22'
        WHEN 7979 THEN U&'\1F23'
        WHEN 7980 THEN U&'\1F24'
        WHEN 7981 THEN U&'\1F25'
        WHEN 7982 THEN U&'\1F26'
        WHEN 7983 THEN U&'\1F27'
        WHEN 7992 THEN U&'\1F30'
        WHEN 7993 THEN U&'\1F31'
        WHEN 7994 THEN U&'\1F32'
        WHEN 7995 THEN U&'\1F33'
        WHEN 7996 THEN U&'\1F34'
        WHEN 7997 THEN U&'\1F35'
        WHEN 7998 THEN U&'\1F36'
        WHEN 7999 THEN U&'\1F37'
        WHEN 8008 THEN U&'\1F40'
        WHEN 8009 THEN U&'\1F41'
        WHEN 8010 THEN U&'\1F42'
        WHEN 8011 THEN U&'\1F43'
        WHEN 8012 THEN U&'\1F44'
        WHEN 8013 THEN U&'\1F45'
        WHEN 8016 THEN U&'\03C5\0313'
        WHEN 8018 THEN U&'\03C5\0313\0300'
        WHEN 8020 THEN U&'\03C5\0313\0301'
        WHEN 8022 THEN U&'\03C5\0313\0342'
        WHEN 8025 THEN U&'\1F51'
        WHEN 8027 THEN U&'\1F53'
        WHEN 8029 THEN U&'\1F55'
        WHEN 8031 THEN U&'\1F57'
        WHEN 8040 THEN U&'\1F60'
        WHEN 8041 THEN U&'\1F61'
        WHEN 8042 THEN U&'\1F62'
        WHEN 8043 THEN U&'\1F63'
        WHEN 8044 THEN U&'\1F64'
        WHEN 8045 THEN U&'\1F65'
        WHEN 8046 THEN U&'\1F66'
        WHEN 8047 THEN U&'\1F67'
        WHEN 8064 THEN U&'\1F00\03B9'
        WHEN 8065 THEN U&'\1F01\03B9'
        WHEN 8066 THEN U&'\1F02\03B9'
        WHEN 8067 THEN U&'\1F03\03B9'
        WHEN 8068 THEN U&'\1F04\03B9'
        WHEN 8069 THEN U&'\1F05\03B9'
        WHEN 8070 THEN U&'\1F06\03B9'
        WHEN 8071 THEN U&'\1F07\03B9'
        WHEN 8072 THEN U&'\1F00\03B9'
        WHEN 8073 THEN U&'\1F01\03B9'
        WHEN 8074 THEN U&'\1F02\03B9'
        WHEN 8075 THEN U&'\1F03\03B9'
        WHEN 8076 THEN U&'\1F04\03B9'
        WHEN 8077 THEN U&'\1F05\03B9'
        WHEN 8078 THEN U&'\1F06\03B9'
        WHEN 8079 THEN U&'\1F07\03B9'
        WHEN 8080 THEN U&'\1F20\03B9'
        WHEN 8081 THEN U&'\1F21\03B9'
        WHEN 8082 THEN U&'\1F22\03B9'
        WHEN 8083 THEN U&'\1F23\03B9'
        WHEN 8084 THEN U&'\1F24\03B9'
        WHEN 8085 THEN U&'\1F25\03B9'
        WHEN 8086 THEN U&'\1F26\03B9'
        WHEN 8087 THEN U&'\1F27\03B9'
        WHEN 8088 THEN U&'\1F20\03B9'
        WHEN 8089 THEN U&'\1F21\03B9'
        WHEN 8090 THEN U&'\1F22\03B9'
        WHEN 8091 THEN U&'\1F23\03B9'
        WHEN 8092 THEN U&'\1F24\03B9'
        WHEN 8093 THEN U&'\1F25\03B9'
        WHEN 8094 THEN U&'\1F26\03B9'
        WHEN 8095 THEN U&'\1F27\03B9'
        WHEN 8096 THEN U&'\1F60\03B9'
        WHEN 8097 THEN U&'\1F61\03B9'
        WHEN 8098 THEN U&'\1F62\03B9'
        WHEN 8099 THEN U&'\1F63\03B9'
        WHEN 8100 THEN U&'\1F64\03B9'
        WHEN 8101 THEN U&'\1F65\03B9'
        WHEN 8102 THEN U&'\1F66\03B9'
        WHEN 8103 THEN U&'\1F67\03B9'
        WHEN 8104 THEN U&'\1F60\03B9'
        WHEN 8105 THEN U&'\1F61\03B9'
        WHEN 8106 THEN U&'\1F62\03B9'
        WHEN 8107 THEN U&'\1F63\03B9'
        WHEN 8108 THEN U&'\1F64\03B9'
        WHEN 8109 THEN U&'\1F65\03B9'
        WHEN 8110 THEN U&'\1F66\03B9'
        WHEN 8111 THEN U&'\1F67\03B9'
        WHEN 8114 THEN U&'\1F70\03B9'
        WHEN 8115 THEN U&'\03B1\03B9'
        WHEN 8116 THEN U&'\03AC\03B9'
        WHEN 8118 THEN U&'\03B1\0342'
        WHEN 8119 THEN U&'\03B1\0342\03B9'
        WHEN 8120 THEN U&'\1FB0'
        WHEN 8121 THEN U&'\1FB1'
        WHEN 8122 THEN U&'\1F70'
        WHEN 8123 THEN U&'\1F71'
        WHEN 8124 THEN U&'\03B1\03B9'
        WHEN 8126 THEN U&'\03B9'
        WHEN 8130 THEN U&'\1F74\03B9'
        WHEN 8131 THEN U&'\03B7\03B9'
        WHEN 8132 THEN U&'\03AE\03B9'
        WHEN 8134 THEN U&'\03B7\0342'
        WHEN 8135 THEN U&'\03B7\0342\03B9'
        WHEN 8136 THEN U&'\1F72'
        WHEN 8137 THEN U&'\1F73'
        WHEN 8138 THEN U&'\1F74'
        WHEN 8139 THEN U&'\1F75'
        WHEN 8140 THEN U&'\03B7\03B9'
        WHEN 8146 THEN U&'\03B9\0308\0300'
        WHEN 8147 THEN U&'\03B9\0308\0301'
        WHEN 8150 THEN U&'\03B9\0342'
        WHEN 8151 THEN U&'\03B9\0308\0342'
        WHEN 8152 THEN U&'\1FD0'
        WHEN 8153 THEN U&'\1FD1'
        WHEN 8154 THEN U&'\1F76'
        WHEN 8155 THEN U&'\1F77'
        WHEN 8162 THEN U&'\03C5\0308\0300'
        WHEN 8163 THEN U&'\03C5\0308\0301'
        WHEN 8164 THEN U&'\03C1\0313'
        WHEN 8166 THEN U&'\03C5\0342'
        WHEN 8167 THEN U&'\03C5\0308\0342'
        WHEN 8168 THEN U&'\1FE0'
        WHEN 8169 THEN U&'\1FE1'
        WHEN 8170 THEN U&'\1F7A'
        WHEN 8171 THEN U&'\1F7B'
        WHEN 8172 THEN U&'\1FE5'
        WHEN 8178 THEN U&'\1F7C\03B9'
        WHEN 8179 THEN U&'\03C9\03B9'
        WHEN 8180 THEN U&'\03CE\03B9'
        WHEN 8182 THEN U&'\03C9\0342'
        WHEN 8183 THEN U&'\03C9\0342\03B9'
        WHEN 8184 THEN U&'\1F78'
        WHEN 8185 THEN U&'\1F79'
        WHEN 8186 THEN U&'\1F7C'
        WHEN 8187 THEN U&'\1F7D'
        WHEN 8188 THEN U&'\03C9\03B9'
        WHEN 8486 THEN U&'\03C9'
        WHEN 8490 THEN U&'\006B'
        WHEN 8491 THEN U&'\00E5'
        WHEN 8498 THEN U&'\214E'
        WHEN 8544 THEN U&'\2170'
        WHEN 8545 THEN U&'\2171'
        WHEN 8546 THEN U&'\2172'
        WHEN 8547 THEN U&'\2173'
        WHEN 8548 THEN U&'\2174'
        WHEN 8549 THEN U&'\2175'
        WHEN 8550 THEN U&'\2176'
        WHEN 8551 THEN U&'\2177'
        WHEN 8552 THEN U&'\2178'
        WHEN 8553 THEN U&'\2179'
        WHEN 8554 THEN U&'\217A'
        WHEN 8555 THEN U&'\217B'
        WHEN 8556 THEN U&'\217C'
        WHEN 8557 THEN U&'\217D'
        WHEN 8558 THEN U&'\217E'
        WHEN 8559 THEN U&'\217F'
        WHEN 8579 THEN U&'\2184'
        WHEN 9398 THEN U&'\24D0'
        WHEN 9399 THEN U&'\24D1'
        WHEN 9400 THEN U&'\24D2'
        WHEN 9401 THEN U&'\24D3'
        WHEN 9402 THEN U&'\24D4'
        WHEN 9403 THEN U&'\24D5'
        WHEN 9404 THEN U&'\24D6'
        WHEN 9405 THEN U&'\24D7'
        WHEN 9406 THEN U&'\24D8'
        WHEN 9407 THEN U&'\24D9'
        WHEN 9408 THEN U&'\24DA'
        WHEN 9409 THEN U&'\24DB'
        WHEN 9410 THEN U&'\24DC'
        WHEN 9411 THEN U&'\24DD'
        WHEN 9412 THEN U&'\24DE'
        WHEN 9413 THEN U&'\24DF'
        WHEN 9414 THEN U&'\24E0'
        WHEN 9415 THEN U&'\24E1'
        WHEN 9416 THEN U&'\24E2'
        WHEN 9417 THEN U&'\24E3'
        WHEN 9418 THEN U&'\24E4'
        WHEN 9419 THEN U&'\24E5'
        WHEN 9420 THEN U&'\24E6'
        WHEN 9421 THEN U&'\24E7'
        WHEN 9422 THEN U&'\24E8'
        WHEN 9423 THEN U&'\24E9'
        WHEN 11264 THEN U&'\2C30'
        WHEN 11265 THEN U&'\2C31'
        WHEN 11266 THEN U&'\2C32'
        WHEN 11267 THEN U&'\2C33'
        WHEN 11268 THEN U&'\2C34'
        WHEN 11269 THEN U&'\2C35'
        WHEN 11270 THEN U&'\2C36'
        WHEN 11271 THEN U&'\2C37'
        WHEN 11272 THEN U&'\2C38'
        WHEN 11273 THEN U&'\2C39'
        WHEN 11274 THEN U&'\2C3A'
        WHEN 11275 THEN U&'\2C3B'
        WHEN 11276 THEN U&'\2C3C'
        WHEN 11277 THEN U&'\2C3D'
        WHEN 11278 THEN U&'\2C3E'
        WHEN 11279 THEN U&'\2C3F'
        WHEN 11280 THEN U&'\2C40'
        WHEN 11281 THEN U&'\2C41'
        WHEN 11282 THEN U&'\2C42'
        WHEN 11283 THEN U&'\2C43'
        WHEN 11284 THEN U&'\2C44'
        WHEN 11285 THEN U&'\2C45'
        WHEN 11286 THEN U&'\2C46'
        WHEN 11287 THEN U&'\2C47'
        WHEN 11288 THEN U&'\2C48'
        WHEN 11289 THEN U&'\2C49'
        WHEN 11290 THEN U&'\2C4A'
        WHEN 11291 THEN U&'\2C4B'
        WHEN 11292 THEN U&'\2C4C'
        WHEN 11293 THEN U&'\2C4D'
        WHEN 11294 THEN U&'\2C4E'
        WHEN 11295 THEN U&'\2C4F'
        WHEN 11296 THEN U&'\2C50'
        WHEN 11297 THEN U&'\2C51'
        WHEN 11298 THEN U&'\2C52'
        WHEN 11299 THEN U&'\2C53'
        WHEN 11300 THEN U&'\2C54'
        WHEN 11301 THEN U&'\2C55'
        WHEN 11302 THEN U&'\2C56'
        WHEN 11303 THEN U&'\2C57'
        WHEN 11304 THEN U&'\2C58'
        WHEN 11305 THEN U&'\2C59'
        WHEN 11306 THEN U&'\2C5A'
        WHEN 11307 THEN U&'\2C5B'
        WHEN 11308 THEN U&'\2C5C'
        WHEN 11309 THEN U&'\2C5D'
        WHEN 11310 THEN U&'\2C5E'
        WHEN 11311 THEN U&'\2C5F'
        WHEN 11360 THEN U&'\2C61'
        WHEN 11362 THEN U&'\026B'
        WHEN 11363 THEN U&'\1D7D'
        WHEN 11364 THEN U&'\027D'
        WHEN 11367 THEN U&'\2C68'
        WHEN 11369 THEN U&'\2C6A'
        WHEN 11371 THEN U&'\2C6C'
        WHEN 11373 THEN U&'\0251'
        WHEN 11374 THEN U&'\0271'
        WHEN 11375 THEN U&'\0250'
        WHEN 11376 THEN U&'\0252'
        WHEN 11378 THEN U&'\2C73'
        WHEN 11381 THEN U&'\2C76'
        WHEN 11390 THEN U&'\023F'
        WHEN 11391 THEN U&'\0240'
        WHEN 11392 THEN U&'\2C81'
        WHEN 11394 THEN U&'\2C83'
        WHEN 11396 THEN U&'\2C85'
        WHEN 11398 THEN U&'\2C87'
        WHEN 11400 THEN U&'\2C89'
        WHEN 11402 THEN U&'\2C8B'
        WHEN 11404 THEN U&'\2C8D'
        WHEN 11406 THEN U&'\2C8F'
        WHEN 11408 THEN U&'\2C91'
        WHEN 11410 THEN U&'\2C93'
        WHEN 11412 THEN U&'\2C95'
        WHEN 11414 THEN U&'\2C97'
        WHEN 11416 THEN U&'\2C99'
        WHEN 11418 THEN U&'\2C9B'
        WHEN 11420 THEN U&'\2C9D'
        WHEN 11422 THEN U&'\2C9F'
        WHEN 11424 THEN U&'\2CA1'
        WHEN 11426 THEN U&'\2CA3'
        WHEN 11428 THEN U&'\2CA5'
        WHEN 11430 THEN U&'\2CA7'
        WHEN 11432 THEN U&'\2CA9'
        WHEN 11434 THEN U&'\2CAB'
        WHEN 11436 THEN U&'\2CAD'
        WHEN 11438 THEN U&'\2CAF'
        WHEN 11440 THEN U&'\2CB1'
        WHEN 11442 THEN U&'\2CB3'
        WHEN 11444 THEN U&'\2CB5'
        WHEN 11446 THEN U&'\2CB7'
        WHEN 11448 THEN U&'\2CB9'
        WHEN 11450 THEN U&'\2CBB'
        WHEN 11452 THEN U&'\2CBD'
        WHEN 11454 THEN U&'\2CBF'
        WHEN 11456 THEN U&'\2CC1'
        WHEN 11458 THEN U&'\2CC3'
        WHEN 11460 THEN U&'\2CC5'
        WHEN 11462 THEN U&'\2CC7'
        WHEN 11464 THEN U&'\2CC9'
        WHEN 11466 THEN U&'\2CCB'
        WHEN 11468 THEN U&'\2CCD'
        WHEN 11470 THEN U&'\2CCF'
        WHEN 11472 THEN U&'\2CD1'
        WHEN 11474 THEN U&'\2CD3'
        WHEN 11476 THEN U&'\2CD5'
        WHEN 11478 THEN U&'\2CD7'
        WHEN 11480 THEN U&'\2CD9'
        WHEN 11482 THEN U&'\2CDB'
        WHEN 11484 THEN U&'\2CDD'
        WHEN 11486 THEN U&'\2CDF'
        WHEN 11488 THEN U&'\2CE1'
        WHEN 11490 THEN U&'\2CE3'
        WHEN 11499 THEN U&'\2CEC'
        WHEN 11501 THEN U&'\2CEE'
        WHEN 11506 THEN U&'\2CF3'
        WHEN 42560 THEN U&'\A641'
        WHEN 42562 THEN U&'\A643'
        WHEN 42564 THEN U&'\A645'
        WHEN 42566 THEN U&'\A647'
        WHEN 42568 THEN U&'\A649'
        WHEN 42570 THEN U&'\A64B'
        WHEN 42572 THEN U&'\A64D'
        WHEN 42574 THEN U&'\A64F'
        WHEN 42576 THEN U&'\A651'
        WHEN 42578 THEN U&'\A653'
        WHEN 42580 THEN U&'\A655'
        WHEN 42582 THEN U&'\A657'
        WHEN 42584 THEN U&'\A659'
        WHEN 42586 THEN U&'\A65B'
        WHEN 42588 THEN U&'\A65D'
        WHEN 42590 THEN U&'\A65F'
        WHEN 42592 THEN U&'\A661'
        WHEN 42594 THEN U&'\A663'
        WHEN 42596 THEN U&'\A665'
        WHEN 42598 THEN U&'\A667'
        WHEN 42600 THEN U&'\A669'
        WHEN 42602 THEN U&'\A66B'
        WHEN 42604 THEN U&'\A66D'
        WHEN 42624 THEN U&'\A681'
        WHEN 42626 THEN U&'\A683'
        WHEN 42628 THEN U&'\A685'
        WHEN 42630 THEN U&'\A687'
        WHEN 42632 THEN U&'\A689'
        WHEN 42634 THEN U&'\A68B'
        WHEN 42636 THEN U&'\A68D'
        WHEN 42638 THEN U&'\A68F'
        WHEN 42640 THEN U&'\A691'
        WHEN 42642 THEN U&'\A693'
        WHEN 42644 THEN U&'\A695'
        WHEN 42646 THEN U&'\A697'
        WHEN 42648 THEN U&'\A699'
        WHEN 42650 THEN U&'\A69B'
        WHEN 42786 THEN U&'\A723'
        WHEN 42788 THEN U&'\A725'
        WHEN 42790 THEN U&'\A727'
        WHEN 42792 THEN U&'\A729'
        WHEN 42794 THEN U&'\A72B'
        WHEN 42796 THEN U&'\A72D'
        WHEN 42798 THEN U&'\A72F'
        WHEN 42802 THEN U&'\A733'
        WHEN 42804 THEN U&'\A735'
        WHEN 42806 THEN U&'\A737'
        WHEN 42808 THEN U&'\A739'
        WHEN 42810 THEN U&'\A73B'
        WHEN 42812 THEN U&'\A73D'
        WHEN 42814 THEN U&'\A73F'
        WHEN 42816 THEN U&'\A741'
        WHEN 42818 THEN U&'\A743'
        WHEN 42820 THEN U&'\A745'
        WHEN 42822 THEN U&'\A747'
        WHEN 42824 THEN U&'\A749'
        WHEN 42826 THEN U&'\A74B'
        WHEN 42828 THEN U&'\A74D'
        WHEN 42830 THEN U&'\A74F'
        WHEN 42832 THEN U&'\A751'
        WHEN 42834 THEN U&'\A753'
        WHEN 42836 THEN U&'\A755'
        WHEN 42838 THEN U&'\A757'
        WHEN 42840 THEN U&'\A759'
        WHEN 42842 THEN U&'\A75B'
        WHEN 42844 THEN U&'\A75D'
        WHEN 42846 THEN U&'\A75F'
        WHEN 42848 THEN U&'\A761'
        WHEN 42850 THEN U&'\A763'
        WHEN 42852 THEN U&'\A765'
        WHEN 42854 THEN U&'\A767'
        WHEN 42856 THEN U&'\A769'
        WHEN 42858 THEN U&'\A76B'
        WHEN 42860 THEN U&'\A76D'
        WHEN 42862 THEN U&'\A76F'
        WHEN 42873 THEN U&'\A77A'
        WHEN 42875 THEN U&'\A77C'
        WHEN 42877 THEN U&'\1D79'
        WHEN 42878 THEN U&'\A77F'
        WHEN 42880 THEN U&'\A781'
        WHEN 42882 THEN U&'\A783'
        WHEN 42884 THEN U&'\A785'
        WHEN 42886 THEN U&'\A787'
        WHEN 42891 THEN U&'\A78C'
        WHEN 42893 THEN U&'\0265'
        WHEN 42896 THEN U&'\A791'
        WHEN 42898 THEN U&'\A793'
        WHEN 42902 THEN U&'\A797'
        WHEN 42904 THEN U&'\A799'
        WHEN 42906 THEN U&'\A79B'
        WHEN 42908 THEN U&'\A79D'
        WHEN 42910 THEN U&'\A79F'
        WHEN 42912 THEN U&'\A7A1'
        WHEN 42914 THEN U&'\A7A3'
        WHEN 42916 THEN U&'\A7A5'
        WHEN 42918 THEN U&'\A7A7'
        WHEN 42920 THEN U&'\A7A9'
        WHEN 42922 THEN U&'\0266'
        WHEN 42923 THEN U&'\025C'
        WHEN 42924 THEN U&'\0261'
        WHEN 42925 THEN U&'\026C'
        WHEN 42926 THEN U&'\026A'
        WHEN 42928 THEN U&'\029E'
        WHEN 42929 THEN U&'\0287'
        WHEN 42930 THEN U&'\029D'
        WHEN 42931 THEN U&'\AB53'
        WHEN 42932 THEN U&'\A7B5'
        WHEN 42934 THEN U&'\A7B7'
        WHEN 42936 THEN U&'\A7B9'
        WHEN 42938 THEN U&'\A7BB'
        WHEN 42940 THEN U&'\A7BD'
        WHEN 42942 THEN U&'\A7BF'
        WHEN 42944 THEN U&'\A7C1'
        WHEN 42946 THEN U&'\A7C3'
        WHEN 42948 THEN U&'\A794'
        WHEN 42949 THEN U&'\0282'
        WHEN 42950 THEN U&'\1D8E'
        WHEN 42951 THEN U&'\A7C8'
        WHEN 42953 THEN U&'\A7CA'
        WHEN 42955 THEN U&'\0264'
        WHEN 42956 THEN U&'\A7CD'
        WHEN 42960 THEN U&'\A7D1'
        WHEN 42966 THEN U&'\A7D7'
        WHEN 42968 THEN U&'\A7D9'
        WHEN 42970 THEN U&'\A7DB'
        WHEN 42972 THEN U&'\019B'
        WHEN 42997 THEN U&'\A7F6'
        WHEN 43888 THEN U&'\13A0'
        WHEN 43889 THEN U&'\13A1'
        WHEN 43890 THEN U&'\13A2'
        WHEN 43891 THEN U&'\13A3'
        WHEN 43892 THEN U&'\13A4'
        WHEN 43893 THEN U&'\13A5'
        WHEN 43894 THEN U&'\13A6'
        WHEN 43895 THEN U&'\13A7'
        WHEN 43896 THEN U&'\13A8'
        WHEN 43897 THEN U&'\13A9'
        WHEN 43898 THEN U&'\13AA'
        WHEN 43899 THEN U&'\13AB'
        WHEN 43900 THEN U&'\13AC'
        WHEN 43901 THEN U&'\13AD'
        WHEN 43902 THEN U&'\13AE'
        WHEN 43903 THEN U&'\13AF'
        WHEN 43904 THEN U&'\13B0'
        WHEN 43905 THEN U&'\13B1'
        WHEN 43906 THEN U&'\13B2'
        WHEN 43907 THEN U&'\13B3'
        WHEN 43908 THEN U&'\13B4'
        WHEN 43909 THEN U&'\13B5'
        WHEN 43910 THEN U&'\13B6'
        WHEN 43911 THEN U&'\13B7'
        WHEN 43912 THEN U&'\13B8'
        WHEN 43913 THEN U&'\13B9'
        WHEN 43914 THEN U&'\13BA'
        WHEN 43915 THEN U&'\13BB'
        WHEN 43916 THEN U&'\13BC'
        WHEN 43917 THEN U&'\13BD'
        WHEN 43918 THEN U&'\13BE'
        WHEN 43919 THEN U&'\13BF'
        WHEN 43920 THEN U&'\13C0'
        WHEN 43921 THEN U&'\13C1'
        WHEN 43922 THEN U&'\13C2'
        WHEN 43923 THEN U&'\13C3'
        WHEN 43924 THEN U&'\13C4'
        WHEN 43925 THEN U&'\13C5'
        WHEN 43926 THEN U&'\13C6'
        WHEN 43927 THEN U&'\13C7'
        WHEN 43928 THEN U&'\13C8'
        WHEN 43929 THEN U&'\13C9'
        WHEN 43930 THEN U&'\13CA'
        WHEN 43931 THEN U&'\13CB'
        WHEN 43932 THEN U&'\13CC'
        WHEN 43933 THEN U&'\13CD'
        WHEN 43934 THEN U&'\13CE'
        WHEN 43935 THEN U&'\13CF'
        WHEN 43936 THEN U&'\13D0'
        WHEN 43937 THEN U&'\13D1'
        WHEN 43938 THEN U&'\13D2'
        WHEN 43939 THEN U&'\13D3'
        WHEN 43940 THEN U&'\13D4'
        WHEN 43941 THEN U&'\13D5'
        WHEN 43942 THEN U&'\13D6'
        WHEN 43943 THEN U&'\13D7'
        WHEN 43944 THEN U&'\13D8'
        WHEN 43945 THEN U&'\13D9'
        WHEN 43946 THEN U&'\13DA'
        WHEN 43947 THEN U&'\13DB'
        WHEN 43948 THEN U&'\13DC'
        WHEN 43949 THEN U&'\13DD'
        WHEN 43950 THEN U&'\13DE'
        WHEN 43951 THEN U&'\13DF'
        WHEN 43952 THEN U&'\13E0'
        WHEN 43953 THEN U&'\13E1'
        WHEN 43954 THEN U&'\13E2'
        WHEN 43955 THEN U&'\13E3'
        WHEN 43956 THEN U&'\13E4'
        WHEN 43957 THEN U&'\13E5'
        WHEN 43958 THEN U&'\13E6'
        WHEN 43959 THEN U&'\13E7'
        WHEN 43960 THEN U&'\13E8'
        WHEN 43961 THEN U&'\13E9'
        WHEN 43962 THEN U&'\13EA'
        WHEN 43963 THEN U&'\13EB'
        WHEN 43964 THEN U&'\13EC'
        WHEN 43965 THEN U&'\13ED'
        WHEN 43966 THEN U&'\13EE'
        WHEN 43967 THEN U&'\13EF'
        WHEN 64256 THEN U&'\0066\0066'
        WHEN 64257 THEN U&'\0066\0069'
        WHEN 64258 THEN U&'\0066\006C'
        WHEN 64259 THEN U&'\0066\0066\0069'
        WHEN 64260 THEN U&'\0066\0066\006C'
        WHEN 64261 THEN U&'\0073\0074'
        WHEN 64262 THEN U&'\0073\0074'
        WHEN 64275 THEN U&'\0574\0576'
        WHEN 64276 THEN U&'\0574\0565'
        WHEN 64277 THEN U&'\0574\056B'
        WHEN 64278 THEN U&'\057E\0576'
        WHEN 64279 THEN U&'\0574\056D'
        WHEN 65313 THEN U&'\FF41'
        WHEN 65314 THEN U&'\FF42'
        WHEN 65315 THEN U&'\FF43'
        WHEN 65316 THEN U&'\FF44'
        WHEN 65317 THEN U&'\FF45'
        WHEN 65318 THEN U&'\FF46'
        WHEN 65319 THEN U&'\FF47'
        WHEN 65320 THEN U&'\FF48'
        WHEN 65321 THEN U&'\FF49'
        WHEN 65322 THEN U&'\FF4A'
        WHEN 65323 THEN U&'\FF4B'
        WHEN 65324 THEN U&'\FF4C'
        WHEN 65325 THEN U&'\FF4D'
        WHEN 65326 THEN U&'\FF4E'
        WHEN 65327 THEN U&'\FF4F'
        WHEN 65328 THEN U&'\FF50'
        WHEN 65329 THEN U&'\FF51'
        WHEN 65330 THEN U&'\FF52'
        WHEN 65331 THEN U&'\FF53'
        WHEN 65332 THEN U&'\FF54'
        WHEN 65333 THEN U&'\FF55'
        WHEN 65334 THEN U&'\FF56'
        WHEN 65335 THEN U&'\FF57'
        WHEN 65336 THEN U&'\FF58'
        WHEN 65337 THEN U&'\FF59'
        WHEN 65338 THEN U&'\FF5A'
        WHEN 66560 THEN U&'\+010428'
        WHEN 66561 THEN U&'\+010429'
        WHEN 66562 THEN U&'\+01042A'
        WHEN 66563 THEN U&'\+01042B'
        WHEN 66564 THEN U&'\+01042C'
        WHEN 66565 THEN U&'\+01042D'
        WHEN 66566 THEN U&'\+01042E'
        WHEN 66567 THEN U&'\+01042F'
        WHEN 66568 THEN U&'\+010430'
        WHEN 66569 THEN U&'\+010431'
        WHEN 66570 THEN U&'\+010432'
        WHEN 66571 THEN U&'\+010433'
        WHEN 66572 THEN U&'\+010434'
        WHEN 66573 THEN U&'\+010435'
        WHEN 66574 THEN U&'\+010436'
        WHEN 66575 THEN U&'\+010437'
        WHEN 66576 THEN U&'\+010438'
        WHEN 66577 THEN U&'\+010439'
        WHEN 66578 THEN U&'\+01043A'
        WHEN 66579 THEN U&'\+01043B'
        WHEN 66580 THEN U&'\+01043C'
        WHEN 66581 THEN U&'\+01043D'
        WHEN 66582 THEN U&'\+01043E'
        WHEN 66583 THEN U&'\+01043F'
        WHEN 66584 THEN U&'\+010440'
        WHEN 66585 THEN U&'\+010441'
        WHEN 66586 THEN U&'\+010442'
        WHEN 66587 THEN U&'\+010443'
        WHEN 66588 THEN U&'\+010444'
        WHEN 66589 THEN U&'\+010445'
        WHEN 66590 THEN U&'\+010446'
        WHEN 66591 THEN U&'\+010447'
        WHEN 66592 THEN U&'\+010448'
        WHEN 66593 THEN U&'\+010449'
        WHEN 66594 THEN U&'\+01044A'
        WHEN 66595 THEN U&'\+01044B'
        WHEN 66596 THEN U&'\+01044C'
        WHEN 66597 THEN U&'\+01044D'
        WHEN 66598 THEN U&'\+01044E'
        WHEN 66599 THEN U&'\+01044F'
        WHEN 66736 THEN U&'\+0104D8'
        WHEN 66737 THEN U&'\+0104D9'
        WHEN 66738 THEN U&'\+0104DA'
        WHEN 66739 THEN U&'\+0104DB'
        WHEN 66740 THEN U&'\+0104DC'
        WHEN 66741 THEN U&'\+0104DD'
        WHEN 66742 THEN U&'\+0104DE'
        WHEN 66743 THEN U&'\+0104DF'
        WHEN 66744 THEN U&'\+0104E0'
        WHEN 66745 THEN U&'\+0104E1'
        WHEN 66746 THEN U&'\+0104E2'
        WHEN 66747 THEN U&'\+0104E3'
        WHEN 66748 THEN U&'\+0104E4'
        WHEN 66749 THEN U&'\+0104E5'
        WHEN 66750 THEN U&'\+0104E6'
        WHEN 66751 THEN U&'\+0104E7'
        WHEN 66752 THEN U&'\+0104E8'
        WHEN 66753 THEN U&'\+0104E9'
        WHEN 66754 THEN U&'\+0104EA'
        WHEN 66755 THEN U&'\+0104EB'
        WHEN 66756 THEN U&'\+0104EC'
        WHEN 66757 THEN U&'\+0104ED'
        WHEN 66758 THEN U&'\+0104EE'
        WHEN 66759 THEN U&'\+0104EF'
        WHEN 66760 THEN U&'\+0104F0'
        WHEN 66761 THEN U&'\+0104F1'
        WHEN 66762 THEN U&'\+0104F2'
        WHEN 66763 THEN U&'\+0104F3'
        WHEN 66764 THEN U&'\+0104F4'
        WHEN 66765 THEN U&'\+0104F5'
        WHEN 66766 THEN U&'\+0104F6'
        WHEN 66767 THEN U&'\+0104F7'
        WHEN 66768 THEN U&'\+0104F8'
        WHEN 66769 THEN U&'\+0104F9'
        WHEN 66770 THEN U&'\+0104FA'
        WHEN 66771 THEN U&'\+0104FB'
        WHEN 66928 THEN U&'\+010597'
        WHEN 66929 THEN U&'\+010598'
        WHEN 66930 THEN U&'\+010599'
        WHEN 66931 THEN U&'\+01059A'
        WHEN 66932 THEN U&'\+01059B'
        WHEN 66933 THEN U&'\+01059C'
        WHEN 66934 THEN U&'\+01059D'
        WHEN 66935 THEN U&'\+01059E'
        WHEN 66936 THEN U&'\+01059F'
        WHEN 66937 THEN U&'\+0105A0'
        WHEN 66938 THEN U&'\+0105A1'
        WHEN 66940 THEN U&'\+0105A3'
        WHEN 66941 THEN U&'\+0105A4'
        WHEN 66942 THEN U&'\+0105A5'
        WHEN 66943 THEN U&'\+0105A6'
        WHEN 66944 THEN U&'\+0105A7'
        WHEN 66945 THEN U&'\+0105A8'
        WHEN 66946 THEN U&'\+0105A9'
        WHEN 66947 THEN U&'\+0105AA'
        WHEN 66948 THEN U&'\+0105AB'
        WHEN 66949 THEN U&'\+0105AC'
        WHEN 66950 THEN U&'\+0105AD'
        WHEN 66951 THEN U&'\+0105AE'
        WHEN 66952 THEN U&'\+0105AF'
        WHEN 66953 THEN U&'\+0105B0'
        WHEN 66954 THEN U&'\+0105B1'
        WHEN 66956 THEN U&'\+0105B3'
        WHEN 66957 THEN U&'\+0105B4'
        WHEN 66958 THEN U&'\+0105B5'
        WHEN 66959 THEN U&'\+0105B6'
        WHEN 66960 THEN U&'\+0105B7'
        WHEN 66961 THEN U&'\+0105B8'
        WHEN 66962 THEN U&'\+0105B9'
        WHEN 66964 THEN U&'\+0105BB'
        WHEN 66965 THEN U&'\+0105BC'
        WHEN 68736 THEN U&'\+010CC0'
        WHEN 68737 THEN U&'\+010CC1'
        WHEN 68738 THEN U&'\+010CC2'
        WHEN 68739 THEN U&'\+010CC3'
        WHEN 68740 THEN U&'\+010CC4'
        WHEN 68741 THEN U&'\+010CC5'
        WHEN 68742 THEN U&'\+010CC6'
        WHEN 68743 THEN U&'\+010CC7'
        WHEN 68744 THEN U&'\+010CC8'
        WHEN 68745 THEN U&'\+010CC9'
        WHEN 68746 THEN U&'\+010CCA'
        WHEN 68747 THEN U&'\+010CCB'
        WHEN 68748 THEN U&'\+010CCC'
        WHEN 68749 THEN U&'\+010CCD'
        WHEN 68750 THEN U&'\+010CCE'
        WHEN 68751 THEN U&'\+010CCF'
        WHEN 68752 THEN U&'\+010CD0'
        WHEN 68753 THEN U&'\+010CD1'
        WHEN 68754 THEN U&'\+010CD2'
        WHEN 68755 THEN U&'\+010CD3'
        WHEN 68756 THEN U&'\+010CD4'
        WHEN 68757 THEN U&'\+010CD5'
        WHEN 68758 THEN U&'\+010CD6'
        WHEN 68759 THEN U&'\+010CD7'
        WHEN 68760 THEN U&'\+010CD8'
        WHEN 68761 THEN U&'\+010CD9'
        WHEN 68762 THEN U&'\+010CDA'
        WHEN 68763 THEN U&'\+010CDB'
        WHEN 68764 THEN U&'\+010CDC'
        WHEN 68765 THEN U&'\+010CDD'
        WHEN 68766 THEN U&'\+010CDE'
        WHEN 68767 THEN U&'\+010CDF'
        WHEN 68768 THEN U&'\+010CE0'
        WHEN 68769 THEN U&'\+010CE1'
        WHEN 68770 THEN U&'\+010CE2'
        WHEN 68771 THEN U&'\+010CE3'
        WHEN 68772 THEN U&'\+010CE4'
        WHEN 68773 THEN U&'\+010CE5'
        WHEN 68774 THEN U&'\+010CE6'
        WHEN 68775 THEN U&'\+010CE7'
        WHEN 68776 THEN U&'\+010CE8'
        WHEN 68777 THEN U&'\+010CE9'
        WHEN 68778 THEN U&'\+010CEA'
        WHEN 68779 THEN U&'\+010CEB'
        WHEN 68780 THEN U&'\+010CEC'
        WHEN 68781 THEN U&'\+010CED'
        WHEN 68782 THEN U&'\+010CEE'
        WHEN 68783 THEN U&'\+010CEF'
        WHEN 68784 THEN U&'\+010CF0'
        WHEN 68785 THEN U&'\+010CF1'
        WHEN 68786 THEN U&'\+010CF2'
        WHEN 68944 THEN U&'\+010D70'
        WHEN 68945 THEN U&'\+010D71'
        WHEN 68946 THEN U&'\+010D72'
        WHEN 68947 THEN U&'\+010D73'
        WHEN 68948 THEN U&'\+010D74'
        WHEN 68949 THEN U&'\+010D75'
        WHEN 68950 THEN U&'\+010D76'
        WHEN 68951 THEN U&'\+010D77'
        WHEN 68952 THEN U&'\+010D78'
        WHEN 68953 THEN U&'\+010D79'
        WHEN 68954 THEN U&'\+010D7A'
        WHEN 68955 THEN U&'\+010D7B'
        WHEN 68956 THEN U&'\+010D7C'
        WHEN 68957 THEN U&'\+010D7D'
        WHEN 68958 THEN U&'\+010D7E'
        WHEN 68959 THEN U&'\+010D7F'
        WHEN 68960 THEN U&'\+010D80'
        WHEN 68961 THEN U&'\+010D81'
        WHEN 68962 THEN U&'\+010D82'
        WHEN 68963 THEN U&'\+010D83'
        WHEN 68964 THEN U&'\+010D84'
        WHEN 68965 THEN U&'\+010D85'
        WHEN 71840 THEN U&'\+0118C0'
        WHEN 71841 THEN U&'\+0118C1'
        WHEN 71842 THEN U&'\+0118C2'
        WHEN 71843 THEN U&'\+0118C3'
        WHEN 71844 THEN U&'\+0118C4'
        WHEN 71845 THEN U&'\+0118C5'
        WHEN 71846 THEN U&'\+0118C6'
        WHEN 71847 THEN U&'\+0118C7'
        WHEN 71848 THEN U&'\+0118C8'
        WHEN 71849 THEN U&'\+0118C9'
        WHEN 71850 THEN U&'\+0118CA'
        WHEN 71851 THEN U&'\+0118CB'
        WHEN 71852 THEN U&'\+0118CC'
        WHEN 71853 THEN U&'\+0118CD'
        WHEN 71854 THEN U&'\+0118CE'
        WHEN 71855 THEN U&'\+0118CF'
        WHEN 71856 THEN U&'\+0118D0'
        WHEN 71857 THEN U&'\+0118D1'
        WHEN 71858 THEN U&'\+0118D2'
        WHEN 71859 THEN U&'\+0118D3'
        WHEN 71860 THEN U&'\+0118D4'
        WHEN 71861 THEN U&'\+0118D5'
        WHEN 71862 THEN U&'\+0118D6'
        WHEN 71863 THEN U&'\+0118D7'
        WHEN 71864 THEN U&'\+0118D8'
        WHEN 71865 THEN U&'\+0118D9'
        WHEN 71866 THEN U&'\+0118DA'
        WHEN 71867 THEN U&'\+0118DB'
        WHEN 71868 THEN U&'\+0118DC'
        WHEN 71869 THEN U&'\+0118DD'
        WHEN 71870 THEN U&'\+0118DE'
        WHEN 71871 THEN U&'\+0118DF'
        WHEN 93760 THEN U&'\+016E60'
        WHEN 93761 THEN U&'\+016E61'
        WHEN 93762 THEN U&'\+016E62'
        WHEN 93763 THEN U&'\+016E63'
        WHEN 93764 THEN U&'\+016E64'
        WHEN 93765 THEN U&'\+016E65'
        WHEN 93766 THEN U&'\+016E66'
        WHEN 93767 THEN U&'\+016E67'
        WHEN 93768 THEN U&'\+016E68'
        WHEN 93769 THEN U&'\+016E69'
        WHEN 93770 THEN U&'\+016E6A'
        WHEN 93771 THEN U&'\+016E6B'
        WHEN 93772 THEN U&'\+016E6C'
        WHEN 93773 THEN U&'\+016E6D'
        WHEN 93774 THEN U&'\+016E6E'
        WHEN 93775 THEN U&'\+016E6F'
        WHEN 93776 THEN U&'\+016E70'
        WHEN 93777 THEN U&'\+016E71'
        WHEN 93778 THEN U&'\+016E72'
        WHEN 93779 THEN U&'\+016E73'
        WHEN 93780 THEN U&'\+016E74'
        WHEN 93781 THEN U&'\+016E75'
        WHEN 93782 THEN U&'\+016E76'
        WHEN 93783 THEN U&'\+016E77'
        WHEN 93784 THEN U&'\+016E78'
        WHEN 93785 THEN U&'\+016E79'
        WHEN 93786 THEN U&'\+016E7A'
        WHEN 93787 THEN U&'\+016E7B'
        WHEN 93788 THEN U&'\+016E7C'
        WHEN 93789 THEN U&'\+016E7D'
        WHEN 93790 THEN U&'\+016E7E'
        WHEN 93791 THEN U&'\+016E7F'
        WHEN 125184 THEN U&'\+01E922'
        WHEN 125185 THEN U&'\+01E923'
        WHEN 125186 THEN U&'\+01E924'
        WHEN 125187 THEN U&'\+01E925'
        WHEN 125188 THEN U&'\+01E926'
        WHEN 125189 THEN U&'\+01E927'
        WHEN 125190 THEN U&'\+01E928'
        WHEN 125191 THEN U&'\+01E929'
        WHEN 125192 THEN U&'\+01E92A'
        WHEN 125193 THEN U&'\+01E92B'
        WHEN 125194 THEN U&'\+01E92C'
        WHEN 125195 THEN U&'\+01E92D'
        WHEN 125196 THEN U&'\+01E92E'
        WHEN 125197 THEN U&'\+01E92F'
        WHEN 125198 THEN U&'\+01E930'
        WHEN 125199 THEN U&'\+01E931'
        WHEN 125200 THEN U&'\+01E932'
        WHEN 125201 THEN U&'\+01E933'
        WHEN 125202 THEN U&'\+01E934'
        WHEN 125203 THEN U&'\+01E935'
        WHEN 125204 THEN U&'\+01E936'
        WHEN 125205 THEN U&'\+01E937'
        WHEN 125206 THEN U&'\+01E938'
        WHEN 125207 THEN U&'\+01E939'
        WHEN 125208 THEN U&'\+01E93A'
        WHEN 125209 THEN U&'\+01E93B'
        WHEN 125210 THEN U&'\+01E93C'
        WHEN 125211 THEN U&'\+01E93D'
        WHEN 125212 THEN U&'\+01E93E'
        WHEN 125213 THEN U&'\+01E93F'
        WHEN 125214 THEN U&'\+01E940'
        WHEN 125215 THEN U&'\+01E941'
        WHEN 125216 THEN U&'\+01E942'
        WHEN 125217 THEN U&'\+01E943'
        ELSE scalar_value
      END,
      '' ORDER BY ordinal
    ),
    ''
  )
  FROM unnest(string_to_array(input_value, NULL))
       WITH ORDINALITY AS characters(scalar_value, ordinal);
$casefold$;
-- END GENERATED UNICODE 16.0 DEFAULT CASE FOLD

CREATE OR REPLACE FUNCTION rule_match_key(input_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $rule_match_key$
DECLARE
  normalized_value text;
  spaced_value text;
  collapsed_value text;
BEGIN
  normalized_value := normalize(input_value, NFC);
  spaced_value := translate(
    normalized_value,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
      || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
      || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
      || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
      || chr(12288) || chr(65279),
    repeat(' ', 25)
  );
  collapsed_value := btrim(regexp_replace(spaced_value, ' +', ' ', 'g'), ' ');
  RETURN normalize(rule_unicode_case_fold_16_0(collapsed_value), NFC);
END;
$rule_match_key$;

COMMENT ON FUNCTION rule_match_key(text) IS
  'Recat rule match key: NFC, exact ECMAScript whitespace trim/collapse, Unicode 16.0.0 default CaseFolding C+F (Turkic T excluded; 1557 entries; sha256 3665d2456dc5fa6295527b8fe486e5a100cd898ab02585ec09b6db4b4244ab50), NFC.';

CREATE OR REPLACE FUNCTION rule_match_key_contract()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $rule_match_contract$
  SELECT '{
    "unicodeVersion": "16.0.0",
    "mappingEntryCount": 1557,
    "mappingSha256": "3665d2456dc5fa6295527b8fe486e5a100cd898ab02585ec09b6db4b4244ab50",
    "statuses": "C+F",
    "turkic": false,
    "normalization": "NFC -> ECMAScript whitespace trim/collapse -> default case fold -> NFC"
  }'::jsonb;
$rule_match_contract$;

COMMIT;
