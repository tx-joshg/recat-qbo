-- Tenant-local revision events fence semantic generations from canonical
-- writes without serializing writers on one shared state row. Events append
-- between cutovers; successful publication compacts them to its fenced event.
-- pgvector and its derived tables remain optional.
CREATE TABLE "ClassificationCorpusRevision" (
    "revision" BIGSERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassificationCorpusRevision_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "ClassificationCorpusRevision_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ClassificationCorpusRevision_companyId_revision_idx"
  ON "ClassificationCorpusRevision"("companyId", "revision" DESC);

INSERT INTO "ClassificationCorpusRevision" ("companyId")
SELECT "id" FROM "Company";

CREATE OR REPLACE FUNCTION classification_corpus_create_company_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_company_insert
AFTER INSERT ON "Company"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_create_company_revision();

CREATE OR REPLACE FUNCTION classification_corpus_append_company_id()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_company_id TEXT;
  new_company_id TEXT;
  lock_company_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_company_id := OLD."companyId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_company_id := NEW."companyId"; END IF;

  FOR lock_company_id IN
    SELECT DISTINCT candidate FROM unnest(ARRAY[old_company_id, new_company_id]) candidate
    WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_company_id, 1481988));
  END LOOP;

  IF old_company_id IS NOT NULL THEN
    INSERT INTO "ClassificationCorpusRevision" ("companyId")
    SELECT old_company_id WHERE EXISTS (
      SELECT 1 FROM "Company" WHERE "id" = old_company_id
    );
  END IF;
  IF new_company_id IS NOT NULL AND new_company_id IS DISTINCT FROM old_company_id THEN
    INSERT INTO "ClassificationCorpusRevision" ("companyId")
    SELECT new_company_id WHERE EXISTS (
      SELECT 1 FROM "Company" WHERE "id" = new_company_id
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION classification_corpus_append_company_nickname()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW."id", 1481988));
  INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_company_nickname
AFTER UPDATE OF "nickname", "taxSupportStatus" ON "Company"
FOR EACH ROW WHEN (
  OLD."nickname" IS DISTINCT FROM NEW."nickname"
  OR OLD."taxSupportStatus" IS DISTINCT FROM NEW."taxSupportStatus"
)
EXECUTE FUNCTION classification_corpus_append_company_nickname();

-- Direct documents plus every joined source whose value or eligibility can
-- affect the bounded corpus. Database triggers cover every writer, including
-- rolling or legacy application processes.
CREATE TRIGGER classification_corpus_vendor_identity
AFTER INSERT OR DELETE ON "VendorIdentity"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_identity_update
AFTER UPDATE OF "id", "companyId", "displayName", "normalizedName" ON "VendorIdentity"
FOR EACH ROW WHEN (
  OLD."id" IS DISTINCT FROM NEW."id"
  OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."displayName" IS DISTINCT FROM NEW."displayName"
  OR OLD."normalizedName" IS DISTINCT FROM NEW."normalizedName"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_alias
AFTER INSERT OR DELETE ON "VendorAlias"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_alias_update
AFTER UPDATE OF "companyId", "vendorIdentityId", "value", "normalizedValue", "source" ON "VendorAlias"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."vendorIdentityId" IS DISTINCT FROM NEW."vendorIdentityId"
  OR OLD."value" IS DISTINCT FROM NEW."value"
  OR OLD."normalizedValue" IS DISTINCT FROM NEW."normalizedValue"
  OR OLD."source" IS DISTINCT FROM NEW."source"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_merge
AFTER INSERT OR DELETE ON "VendorIdentityMerge"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_vendor_merge_update
AFTER UPDATE OF "companyId", "sourceVendorIdentityId", "targetVendorIdentityId" ON "VendorIdentityMerge"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."sourceVendorIdentityId" IS DISTINCT FROM NEW."sourceVendorIdentityId"
  OR OLD."targetVendorIdentityId" IS DISTINCT FROM NEW."targetVendorIdentityId"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case
AFTER INSERT OR DELETE ON "ClassificationCase"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case_update
AFTER UPDATE OF "id", "companyId", "transactionId", "vendorIdentityId", "action", "originIntent", "rationale", "requiredEvidence", "examples", "counterexamples", "citations", "reviewer", "jurisdiction", "currency", "context", "provenance", "transactionSnapshot", "verifiedAt" ON "ClassificationCase"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."transactionId", OLD."vendorIdentityId", OLD."action", OLD."originIntent", OLD."rationale", OLD."requiredEvidence", OLD."examples", OLD."counterexamples", OLD."citations", OLD."reviewer", OLD."jurisdiction", OLD."currency", OLD."context", OLD."provenance", OLD."transactionSnapshot", OLD."verifiedAt")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."transactionId", NEW."vendorIdentityId", NEW."action", NEW."originIntent", NEW."rationale", NEW."requiredEvidence", NEW."examples", NEW."counterexamples", NEW."citations", NEW."reviewer", NEW."jurisdiction", NEW."currency", NEW."context", NEW."provenance", NEW."transactionSnapshot", NEW."verifiedAt")
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case_invalidation
AFTER INSERT OR DELETE ON "ClassificationCaseInvalidation"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_case_invalidation_update
AFTER UPDATE OF "companyId", "classificationCaseId" ON "ClassificationCaseInvalidation"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."classificationCaseId" IS DISTINCT FROM NEW."classificationCaseId"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule
AFTER INSERT OR DELETE ON "Rule"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule_update
AFTER UPDATE OF "id", "companyId", "matchText", "category", "categoryQboId", "taxCalculation", "taxCode", "taxCodeQboId", "enabled", "revision", "originIntent", "retiredAt", "reviewRequiredAt", "reviewReason" ON "Rule"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."matchText", OLD."category", OLD."categoryQboId", OLD."taxCalculation", OLD."taxCode", OLD."taxCodeQboId", OLD."enabled", OLD."revision", OLD."originIntent", OLD."retiredAt", OLD."reviewRequiredAt", OLD."reviewReason")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."matchText", NEW."category", NEW."categoryQboId", NEW."taxCalculation", NEW."taxCode", NEW."taxCodeQboId", NEW."enabled", NEW."revision", NEW."originIntent", NEW."retiredAt", NEW."reviewRequiredAt", NEW."reviewReason")
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule_revision
AFTER INSERT OR DELETE ON "RuleRevision"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_rule_revision_update
AFTER UPDATE ON "RuleRevision"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate
AFTER INSERT OR DELETE ON "AutopilotRuleCandidate"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate_update
AFTER UPDATE OF "id", "companyId", "matchText", "state", "categoryQboId", "taxCalculation", "taxCodeQboId", "tagIds", "evidenceCount", "conflictingEvidenceCount" ON "AutopilotRuleCandidate"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."matchText", OLD."state", OLD."categoryQboId", OLD."taxCalculation", OLD."taxCodeQboId", OLD."tagIds", OLD."evidenceCount", OLD."conflictingEvidenceCount")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."matchText", NEW."state", NEW."categoryQboId", NEW."taxCalculation", NEW."taxCodeQboId", NEW."tagIds", NEW."evidenceCount", NEW."conflictingEvidenceCount")
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate_evidence
AFTER INSERT OR DELETE ON "AutopilotRuleCandidateEvidence"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_candidate_evidence_update
AFTER UPDATE OF "id", "companyId", "candidateId", "transactionId", "pattern", "active", "observedAt" ON "AutopilotRuleCandidateEvidence"
FOR EACH ROW WHEN (
  ROW(OLD."id", OLD."companyId", OLD."candidateId", OLD."transactionId", OLD."pattern", OLD."active", OLD."observedAt")
  IS DISTINCT FROM
  ROW(NEW."id", NEW."companyId", NEW."candidateId", NEW."transactionId", NEW."pattern", NEW."active", NEW."observedAt")
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tag
AFTER INSERT OR DELETE ON "Tag"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tag_update
AFTER UPDATE OF "companyId", "name" ON "Tag"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."name" IS DISTINCT FROM NEW."name"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_account
AFTER INSERT OR DELETE ON "QboAccount"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_account_update
AFTER UPDATE OF "companyId", "qboId", "name", "fullName", "active" ON "QboAccount"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."qboId" IS DISTINCT FROM NEW."qboId"
  OR OLD."name" IS DISTINCT FROM NEW."name"
  OR OLD."fullName" IS DISTINCT FROM NEW."fullName"
  OR OLD."active" IS DISTINCT FROM NEW."active"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tax_code
AFTER INSERT OR DELETE ON "QboTaxCode"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_tax_code_update
AFTER UPDATE OF "companyId", "qboId", "name", "active", "taxable", "purchaseTaxRateList", "combinedPurchaseRate" ON "QboTaxCode"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."qboId" IS DISTINCT FROM NEW."qboId"
  OR OLD."name" IS DISTINCT FROM NEW."name"
  OR OLD."active" IS DISTINCT FROM NEW."active"
  OR OLD."taxable" IS DISTINCT FROM NEW."taxable"
  OR OLD."purchaseTaxRateList" IS DISTINCT FROM NEW."purchaseTaxRateList"
  OR OLD."combinedPurchaseRate" IS DISTINCT FROM NEW."combinedPurchaseRate"
) EXECUTE FUNCTION classification_corpus_append_company_id();
CREATE TRIGGER classification_corpus_transaction
AFTER UPDATE OF "companyId", "qboType", "date", "payee", "memo", "amount", "bankAccount", "category", "categoryQboId", "taxCalculation", "taxCode", "taxCodeQboId" ON "Transaction"
FOR EACH ROW WHEN (
  OLD."companyId" IS DISTINCT FROM NEW."companyId"
  OR OLD."qboType" IS DISTINCT FROM NEW."qboType"
  OR OLD."date" IS DISTINCT FROM NEW."date"
  OR OLD."payee" IS DISTINCT FROM NEW."payee"
  OR OLD."memo" IS DISTINCT FROM NEW."memo"
  OR OLD."amount" IS DISTINCT FROM NEW."amount"
  OR OLD."bankAccount" IS DISTINCT FROM NEW."bankAccount"
  OR OLD."category" IS DISTINCT FROM NEW."category"
  OR OLD."categoryQboId" IS DISTINCT FROM NEW."categoryQboId"
  OR OLD."taxCalculation" IS DISTINCT FROM NEW."taxCalculation"
  OR OLD."taxCode" IS DISTINCT FROM NEW."taxCode"
  OR OLD."taxCodeQboId" IS DISTINCT FROM NEW."taxCodeQboId"
) EXECUTE FUNCTION classification_corpus_append_company_id();

-- RuleTag has no companyId column. Resolve the owning rule; a cascade after
-- rule deletion needs no second event because the Rule trigger already wrote
-- the durable revision.
CREATE OR REPLACE FUNCTION classification_corpus_append_rule_tag()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_owner_company_id TEXT;
  new_owner_company_id TEXT;
  lock_company_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "companyId" INTO old_owner_company_id FROM "Rule" WHERE "id" = OLD."ruleId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "companyId" INTO new_owner_company_id FROM "Rule" WHERE "id" = NEW."ruleId";
  END IF;
  FOR lock_company_id IN
    SELECT DISTINCT candidate
    FROM unnest(ARRAY[old_owner_company_id, new_owner_company_id]) candidate
    WHERE candidate IS NOT NULL ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(lock_company_id, 1481988));
    INSERT INTO "ClassificationCorpusRevision" ("companyId") VALUES (lock_company_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_corpus_rule_tag
AFTER INSERT OR DELETE ON "RuleTag"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_rule_tag();
CREATE TRIGGER classification_corpus_rule_tag_update
AFTER UPDATE OF "ruleId", "tagId" ON "RuleTag"
FOR EACH ROW WHEN (
  OLD."ruleId" IS DISTINCT FROM NEW."ruleId"
  OR OLD."tagId" IS DISTINCT FROM NEW."tagId"
) EXECUTE FUNCTION classification_corpus_append_rule_tag();
