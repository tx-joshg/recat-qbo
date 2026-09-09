BEGIN;

LOCK TABLE "Company", "Rule", "RuleRevision", "RuleLifecycleRevision"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE "RuleLifecycleGeneration_seq"
  AS BIGINT
  NO CYCLE
  CACHE 1;

SELECT setval(
  '"RuleLifecycleGeneration_seq"'::regclass,
  GREATEST(COALESCE(MAX("revision"), 0), 1),
  COALESCE(MAX("revision"), 0) >= 1
)
FROM "RuleLifecycleRevision";

CREATE OR REPLACE FUNCTION rule_lifecycle_stamp_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."revision" := nextval('public."RuleLifecycleGeneration_seq"'::regclass);
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_lifecycle_revision_stamp
BEFORE INSERT OR UPDATE OF "revision" ON "RuleLifecycleRevision"
FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_stamp_generation();

ALTER TABLE "RuleLifecycleRevision" ALTER COLUMN "revision" DROP DEFAULT;

-- Invalidate every pre-sequence cursor and make the cutover values unique.
UPDATE "RuleLifecycleRevision" SET "revision" = "revision";

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_company_ids(company_ids TEXT[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_company_id TEXT;
BEGIN
  FOR target_company_id IN
    SELECT DISTINCT candidate
      FROM unnest(company_ids) AS candidate
     WHERE candidate IS NOT NULL
     ORDER BY candidate
  LOOP
    UPDATE "RuleLifecycleRevision"
       SET "revision" = "revision"
     WHERE "companyId" = target_company_id;

    IF NOT FOUND THEN
      INSERT INTO "RuleLifecycleRevision" ("companyId", "revision")
      SELECT target_company_id, 0
       WHERE EXISTS (
         SELECT 1 FROM "Company" WHERE "id" = target_company_id
       )
      ON CONFLICT ("companyId") DO UPDATE
        SET "revision" = "RuleLifecycleRevision"."revision";
    END IF;
  END LOOP;
END;
$$;

DROP TRIGGER rule_lifecycle_rule_update ON "Rule";
DROP FUNCTION rule_lifecycle_bump_rule_update();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_changed_rule_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    WITH old_changed AS (
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason"
        FROM old_rule_rows
      EXCEPT
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason"
        FROM new_rule_rows
    ),
    new_changed AS (
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason"
        FROM new_rule_rows
      EXCEPT
      SELECT "id", "companyId", "revision", "enabled", "retiredAt", "priority",
             "createdAt", "reviewRequiredAt", "reviewReason"
        FROM old_rule_rows
    )
    SELECT "companyId" FROM old_changed
    UNION
    SELECT "companyId" FROM new_changed
    ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_update
AFTER UPDATE ON "Rule"
REFERENCING OLD TABLE AS old_rule_rows NEW TABLE AS new_rule_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_changed_rule_companies();

DROP TRIGGER rule_lifecycle_rule_revision_update ON "RuleRevision";
DROP FUNCTION rule_lifecycle_bump_rule_revision_update();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_changed_rule_revision_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    WITH old_changed AS (
      SELECT * FROM old_rule_revision_rows
      EXCEPT
      SELECT * FROM new_rule_revision_rows
    ),
    new_changed AS (
      SELECT * FROM new_rule_revision_rows
      EXCEPT
      SELECT * FROM old_rule_revision_rows
    )
    SELECT "companyId" FROM old_changed
    UNION
    SELECT "companyId" FROM new_changed
    ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_revision_update
AFTER UPDATE ON "RuleRevision"
REFERENCING OLD TABLE AS old_rule_revision_rows NEW TABLE AS new_rule_revision_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_changed_rule_revision_companies();

COMMIT;
