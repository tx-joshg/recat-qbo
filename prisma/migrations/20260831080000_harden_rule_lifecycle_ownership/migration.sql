BEGIN;

-- Do not allow a fence owner change to carry the old owner's cursor token.
-- The lock closes the rolling gap between dropping and recreating the trigger.
LOCK TABLE "RuleLifecycleRevision" IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER rule_lifecycle_revision_stamp ON "RuleLifecycleRevision";

CREATE TRIGGER rule_lifecycle_revision_stamp
BEFORE INSERT OR UPDATE ON "RuleLifecycleRevision"
FOR EACH ROW EXECUTE FUNCTION rule_lifecycle_stamp_generation();

-- The insert/delete wrappers call the central definer helper. Run every
-- wrapper as its fixed-path owner so revoking direct helper access does not
-- remove ordinary application table writes.
ALTER FUNCTION rule_lifecycle_initialize_company() SECURITY DEFINER;
ALTER FUNCTION rule_lifecycle_initialize_company() SET search_path = pg_catalog, public;
ALTER FUNCTION rule_lifecycle_bump_new_rule_companies() SECURITY DEFINER;
ALTER FUNCTION rule_lifecycle_bump_new_rule_companies() SET search_path = pg_catalog, public;
ALTER FUNCTION rule_lifecycle_bump_old_rule_companies() SECURITY DEFINER;
ALTER FUNCTION rule_lifecycle_bump_old_rule_companies() SET search_path = pg_catalog, public;
ALTER FUNCTION rule_lifecycle_bump_new_rule_revision_companies() SECURITY DEFINER;
ALTER FUNCTION rule_lifecycle_bump_new_rule_revision_companies() SET search_path = pg_catalog, public;
ALTER FUNCTION rule_lifecycle_bump_old_rule_revision_companies() SECURITY DEFINER;
ALTER FUNCTION rule_lifecycle_bump_old_rule_revision_companies() SET search_path = pg_catalog, public;

-- These helpers run only through database-owned triggers. Application roles
-- need table privileges for ordinary writes, not direct access to definer code.
REVOKE EXECUTE ON FUNCTION rule_lifecycle_stamp_generation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_company_ids(TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_changed_rule_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_changed_rule_revision_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_initialize_company() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_new_rule_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_old_rule_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_new_rule_revision_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rule_lifecycle_bump_old_rule_revision_companies() FROM PUBLIC;

COMMIT;
