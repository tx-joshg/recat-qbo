-- Browser rule preparations use the same immutable envelope as MCP without
-- manufacturing token provenance. Existing writers remain valid because the
-- discriminator defaults to MCP and their token columns are unchanged.
ALTER TABLE "McpRuleOperation"
  ADD COLUMN "authKind" VARCHAR(16) NOT NULL DEFAULT 'mcp',
  ADD COLUMN "sessionId" TEXT,
  ALTER COLUMN "tokenId" DROP NOT NULL,
  ALTER COLUMN "tokenPrefix" DROP NOT NULL;

ALTER TABLE "McpRuleOperation"
  ADD CONSTRAINT "McpRuleOperation_authKind_check" CHECK (
    ("authKind" = 'mcp' AND "tokenId" IS NOT NULL AND "tokenPrefix" IS NOT NULL AND "sessionId" IS NULL)
    OR
    ("authKind" = 'session' AND "tokenId" IS NULL AND "tokenPrefix" IS NULL AND "sessionId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "McpRuleOperation_sessionId_companyId_idempotencyKey_key"
  ON "McpRuleOperation"("sessionId", "companyId", "idempotencyKey");
CREATE INDEX "McpRuleOperation_sessionId_createdAt_idx"
  ON "McpRuleOperation"("sessionId", "createdAt");

-- Extend the existing append-only trigger to cover the new immutable actor
-- attribution. Only the established commit receipt transition remains legal.
CREATE OR REPLACE FUNCTION "enforce_mcp_rule_operation_immutability"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'McpRuleOperation immutable fields cannot be changed';
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."authKind" IS DISTINCT FROM NEW."authKind"
    OR OLD."tokenId" IS DISTINCT FROM NEW."tokenId"
    OR OLD."tokenPrefix" IS DISTINCT FROM NEW."tokenPrefix"
    OR OLD."sessionId" IS DISTINCT FROM NEW."sessionId"
    OR OLD."userId" IS DISTINCT FROM NEW."userId"
    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"
    OR OLD."resourceType" IS DISTINCT FROM NEW."resourceType"
    OR OLD."resourceId" IS DISTINCT FROM NEW."resourceId"
    OR OLD."mutation" IS DISTINCT FROM NEW."mutation"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR OLD."inputHash" IS DISTINCT FROM NEW."inputHash"
    OR OLD."payload" IS DISTINCT FROM NEW."payload"
    OR OLD."payloadHash" IS DISTINCT FROM NEW."payloadHash"
    OR OLD."sourceRevision" IS DISTINCT FROM NEW."sourceRevision"
    OR OLD."proposedRevision" IS DISTINCT FROM NEW."proposedRevision"
    OR OLD."proposedSnapshotHash" IS DISTINCT FROM NEW."proposedSnapshotHash"
    OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
    OR OLD."retryOfId" IS DISTINCT FROM NEW."retryOfId"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR OLD."updatedAt" IS NOT DISTINCT FROM NEW."updatedAt"
    OR OLD."committedAt" IS NOT NULL
    OR OLD."commitResult" IS NOT NULL
    OR OLD."commitResultHash" IS NOT NULL
    OR NEW."committedAt" IS NULL
    OR NEW."commitResult" IS NULL
    OR NEW."commitResultHash" IS NULL
  THEN
    RAISE EXCEPTION 'McpRuleOperation immutable fields cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
