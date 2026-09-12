ALTER TABLE "McpOperation"
    DROP CONSTRAINT "McpOperation_kind_check";

ALTER TABLE "McpOperation"
    ADD CONSTRAINT "McpOperation_kind_check"
    CHECK ("kind" IN ('categorization', 'transfer', 'undo', 'tax_refund'));

ALTER TABLE "McpOperation"
    ADD COLUMN "manualRecordedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "McpOperation_tax_refund_source_key"
    ON "McpOperation" ("companyId", "transactionId")
    WHERE "kind" = 'tax_refund' AND "cancelledAt" IS NULL;

CREATE OR REPLACE FUNCTION "enforce_mcp_operation_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
           (
               OLD."cancelledAt" IS NULL
               AND NEW."cancelledAt" IS NOT NULL
               AND OLD."manualRecordedAt" IS NOT DISTINCT FROM NEW."manualRecordedAt"
           )
           OR (
               OLD."manualRecordedAt" IS NULL
               AND NEW."manualRecordedAt" IS NOT NULL
               AND OLD."cancelledAt" IS NULL
               AND NEW."cancelledAt" IS NULL
           )
       )
       AND ROW(
           NEW."id", NEW."tokenId", NEW."tokenPrefix", NEW."userId",
           NEW."companyId", NEW."transactionId", NEW."toolName", NEW."kind",
           NEW."idempotencyKey", NEW."inputHash", NEW."payload", NEW."payloadHash",
           NEW."sourceRevision", NEW."preparedRevision", NEW."qboType", NEW."qboId",
           NEW."qboSyncToken", NEW."expiresAt", NEW."retryOfId", NEW."createdAt"
       ) IS NOT DISTINCT FROM ROW(
           OLD."id", OLD."tokenId", OLD."tokenPrefix", OLD."userId",
           OLD."companyId", OLD."transactionId", OLD."toolName", OLD."kind",
           OLD."idempotencyKey", OLD."inputHash", OLD."payload", OLD."payloadHash",
           OLD."sourceRevision", OLD."preparedRevision", OLD."qboType", OLD."qboId",
           OLD."qboSyncToken", OLD."expiresAt", OLD."retryOfId", OLD."createdAt"
       )
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'McpOperation immutable fields cannot be changed';
    RETURN NULL;
END;
$$;
