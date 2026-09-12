-- Permit the explicit reviewed repair operation without rewriting immutable
-- operation history. Legacy reorder/retire receipts remain valid stored data;
-- current application boundaries reject new requests for those operations.
BEGIN;

ALTER TABLE "McpRuleOperation"
    DROP CONSTRAINT "McpRuleOperation_mutation_check",
    ADD CONSTRAINT "McpRuleOperation_mutation_check"
        CHECK ("mutation" IN (
            'create', 'update', 'review', 'enable', 'disable', 'reorder', 'retire',
            'activate_candidate', 'dismiss_candidate'
        ));

COMMIT;
