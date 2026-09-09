BEGIN;

-- Close the rolling-install gap: no Company/Rule/RuleRevision writer can
-- commit between the initial snapshot and trigger installation.
LOCK TABLE "Company", "Rule", "RuleRevision" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "RuleLifecycleRevision" (
    "companyId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "RuleLifecycleRevision_pkey" PRIMARY KEY ("companyId"),
    CONSTRAINT "RuleLifecycleRevision_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION rule_lifecycle_initialize_company()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "RuleLifecycleRevision" ("companyId", "revision")
  VALUES (NEW."id", 0)
  ON CONFLICT ("companyId") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_lifecycle_company_insert
AFTER INSERT ON "Company"
FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_initialize_company();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_company_ids(company_ids TEXT[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  target_company_id TEXT;
BEGIN
  FOR target_company_id IN
    SELECT DISTINCT candidate
      FROM unnest(company_ids) AS candidate
     WHERE candidate IS NOT NULL
     ORDER BY candidate
  LOOP
    INSERT INTO "RuleLifecycleRevision" ("companyId", "revision")
    SELECT target_company_id, 1
     WHERE EXISTS (
       SELECT 1 FROM "Company" WHERE "id" = target_company_id
     )
    ON CONFLICT ("companyId") DO UPDATE
      SET "revision" = "RuleLifecycleRevision"."revision" + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_new_rule_companies()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    SELECT DISTINCT "companyId" FROM new_rule_rows ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_insert
AFTER INSERT ON "Rule"
REFERENCING NEW TABLE AS new_rule_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_new_rule_companies();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_old_rule_companies()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    SELECT DISTINCT "companyId" FROM old_rule_rows ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_delete
AFTER DELETE ON "Rule"
REFERENCING OLD TABLE AS old_rule_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_old_rule_companies();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_rule_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY[OLD."companyId", NEW."companyId"]);
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_update
AFTER UPDATE OF "id", "companyId", "revision", "enabled", "retiredAt", "priority", "createdAt", "reviewRequiredAt", "reviewReason" ON "Rule"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."revision", OLD."enabled", OLD."retiredAt", OLD."priority", OLD."createdAt", OLD."reviewRequiredAt", OLD."reviewReason")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."revision", NEW."enabled", NEW."retiredAt", NEW."priority", NEW."createdAt", NEW."reviewRequiredAt", NEW."reviewReason")
)
EXECUTE FUNCTION rule_lifecycle_bump_rule_update();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_new_rule_revision_companies()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    SELECT DISTINCT "companyId" FROM new_rule_revision_rows ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_revision_insert
AFTER INSERT ON "RuleRevision"
REFERENCING NEW TABLE AS new_rule_revision_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_new_rule_revision_companies();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_old_rule_revision_companies()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY(
    SELECT DISTINCT "companyId" FROM old_rule_revision_rows ORDER BY "companyId"
  ));
  RETURN NULL;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_revision_delete
AFTER DELETE ON "RuleRevision"
REFERENCING OLD TABLE AS old_rule_revision_rows
FOR EACH STATEMENT EXECUTE FUNCTION rule_lifecycle_bump_old_rule_revision_companies();

CREATE OR REPLACE FUNCTION rule_lifecycle_bump_rule_revision_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rule_lifecycle_bump_company_ids(ARRAY[OLD."companyId", NEW."companyId"]);
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_lifecycle_rule_revision_update
AFTER UPDATE ON "RuleRevision"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION rule_lifecycle_bump_rule_revision_update();

INSERT INTO "RuleLifecycleRevision" ("companyId", "revision")
SELECT "id", 0 FROM "Company"
ON CONFLICT ("companyId") DO NOTHING;

COMMIT;
