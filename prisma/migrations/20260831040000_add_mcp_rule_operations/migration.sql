-- Rule lifecycle mutations are local policy changes, not transaction-scoped
-- QBO writes, so they use a dedicated resource-bound preparation envelope.
CREATE TABLE "McpRuleOperation" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(12) NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "resourceType" VARCHAR(32) NOT NULL,
    "resourceId" TEXT NOT NULL,
    "mutation" VARCHAR(32) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "proposedRevision" INTEGER NOT NULL,
    "proposedSnapshotHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "retryOfId" TEXT,
    "committedAt" TIMESTAMP(3),
    "commitResult" JSONB,
    "commitResultHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpRuleOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "McpRuleOperation_resourceType_check"
        CHECK ("resourceType" IN ('rule', 'rule_order', 'rule_candidate')),
    CONSTRAINT "McpRuleOperation_mutation_check"
        CHECK ("mutation" IN (
            'create', 'update', 'enable', 'disable', 'reorder', 'retire',
            'activate_candidate', 'dismiss_candidate'
        )),
    CONSTRAINT "McpRuleOperation_revision_check"
        CHECK (
            "sourceRevision" >= 0
            AND "proposedRevision" = "sourceRevision" + 1
        ),
    CONSTRAINT "McpRuleOperation_inputHash_check"
        CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "McpRuleOperation_payloadHash_check"
        CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "McpRuleOperation_proposedSnapshotHash_check"
        CHECK ("proposedSnapshotHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "McpRuleOperation_commitReceipt_check"
        CHECK (
            ("committedAt" IS NULL AND "commitResult" IS NULL AND "commitResultHash" IS NULL)
            OR
            ("committedAt" IS NOT NULL AND "commitResult" IS NOT NULL AND "commitResultHash" ~ '^[0-9a-f]{64}$')
        )
);

CREATE UNIQUE INDEX "McpRuleOperation_retryOfId_key"
    ON "McpRuleOperation"("retryOfId");
CREATE UNIQUE INDEX "McpRuleOperation_tokenId_companyId_idempotencyKey_key"
    ON "McpRuleOperation"("tokenId", "companyId", "idempotencyKey");
CREATE INDEX "McpRuleOperation_tokenId_createdAt_idx"
    ON "McpRuleOperation"("tokenId", "createdAt");
CREATE INDEX "McpRuleOperation_userId_createdAt_idx"
    ON "McpRuleOperation"("userId", "createdAt");
CREATE INDEX "McpRuleOperation_companyId_resourceType_resourceId_idx"
    ON "McpRuleOperation"("companyId", "resourceType", "resourceId");

-- No foreign keys are intentional: deletion of a company, user, token, rule,
-- or candidate must never erase or block deletion because of provenance.
-- The only legal update atomically records the first canonical commit receipt.
CREATE FUNCTION "enforce_mcp_rule_operation_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD."committedAt" IS NULL
       AND OLD."commitResult" IS NULL
       AND OLD."commitResultHash" IS NULL
       AND NEW."committedAt" IS NOT NULL
       AND NEW."commitResult" IS NOT NULL
       AND NEW."commitResultHash" IS NOT NULL
       AND ROW(
           NEW."id", NEW."tokenId", NEW."tokenPrefix", NEW."userId",
           NEW."companyId", NEW."resourceType", NEW."resourceId",
           NEW."mutation", NEW."idempotencyKey", NEW."inputHash",
           NEW."payload", NEW."payloadHash", NEW."sourceRevision",
           NEW."proposedRevision", NEW."proposedSnapshotHash",
           NEW."expiresAt", NEW."retryOfId", NEW."createdAt"
       ) IS NOT DISTINCT FROM ROW(
           OLD."id", OLD."tokenId", OLD."tokenPrefix", OLD."userId",
           OLD."companyId", OLD."resourceType", OLD."resourceId",
           OLD."mutation", OLD."idempotencyKey", OLD."inputHash",
           OLD."payload", OLD."payloadHash", OLD."sourceRevision",
           OLD."proposedRevision", OLD."proposedSnapshotHash",
           OLD."expiresAt", OLD."retryOfId", OLD."createdAt"
       )
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'McpRuleOperation immutable fields cannot be changed';
    RETURN NULL;
END;
$$;

CREATE TRIGGER "McpRuleOperation_immutable"
    BEFORE UPDATE OR DELETE ON "McpRuleOperation"
    FOR EACH ROW
    EXECUTE FUNCTION "enforce_mcp_rule_operation_immutability"();
