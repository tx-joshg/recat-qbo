CREATE TABLE "RulePreparationRetry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "transactionId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" >= 0),
  "ruleId" TEXT NOT NULL,
  "ruleRevision" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'DONE', 'CANCELLED', 'EXHAUSTED')),
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 3),
  "dueAt" TIMESTAMP(3) NOT NULL,
  "claimToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RulePreparationRetry_binding_key" ON "RulePreparationRetry" ("companyId", "transactionId", "sourceRevision", "ruleId", "ruleRevision");
CREATE INDEX "RulePreparationRetry_state_dueAt_idx" ON "RulePreparationRetry" ("state", "dueAt");

-- Explicit authority changes cancel old deferred discoveries even if resumed
-- before the next scheduler tick. Existing preparations keep their own recovery.
CREATE FUNCTION cancel_deferred_rule_preparations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."ruleRuntimeMode" IS DISTINCT FROM OLD."ruleRuntimeMode" AND NEW."ruleRuntimeMode" <> 'canonical')
     OR (NEW."disconnectedAt" IS DISTINCT FROM OLD."disconnectedAt" AND NEW."disconnectedAt" IS NOT NULL)
     OR NEW."connectedAt" IS DISTINCT FROM OLD."connectedAt" THEN
    UPDATE "RulePreparationRetry" SET "state" = 'CANCELLED', "claimToken" = NULL
      WHERE "companyId" = NEW."id" AND "state" = 'PENDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Company_cancel_deferred_rule_preparations"
AFTER UPDATE OF "ruleRuntimeMode", "disconnectedAt", "connectedAt" ON "Company"
FOR EACH ROW EXECUTE FUNCTION cancel_deferred_rule_preparations();
