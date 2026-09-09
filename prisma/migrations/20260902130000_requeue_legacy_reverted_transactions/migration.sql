-- A verified restore returns a transaction to the categorization queue.
-- REVERTED is retained in immutable attempt verification and Audit history,
-- but is not a valid resting state for the mutable Transaction projection.
UPDATE "Transaction"
SET "status" = 'PENDING',
    "postedAt" = NULL,
    "postedByUserId" = NULL,
    "errorCode" = NULL,
    "errorMessage" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'REVERTED';
