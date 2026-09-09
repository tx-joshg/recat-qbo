-- Provider actionability is a read-only index.  It must not be represented by
-- Transaction.status, which is Recat's local mutation lifecycle.
CREATE TYPE "ProviderActionability" AS ENUM (
  'UNKNOWN',
  'WRITABLE',
  'BLOCKED_CLEARED',
  'BLOCKED_RECONCILED',
  'BLOCKED_PERIOD_CLOSED',
  'UNAVAILABLE'
);

CREATE TABLE "TransactionActionability" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "disposition" "ProviderActionability" NOT NULL DEFAULT 'UNKNOWN',
  "checkedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL,
  "qboSyncToken" VARCHAR(128) NOT NULL,
  "qboType" VARCHAR(32) NOT NULL,
  "qboId" VARCHAR(128) NOT NULL,
  "txnDate" DATE NOT NULL,
  "bankAccountQboId" VARCHAR(128),
  "bookCloseDate" DATE,
  "cleared" BOOLEAN,
  "reconciled" BOOLEAN,
  "unavailableCode" VARCHAR(64),
  "unavailableReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TransactionActionability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TransactionActionability_transactionId_key"
ON "TransactionActionability"("transactionId");

CREATE INDEX "TransactionActionability_companyId_disposition_checkedAt_idx"
ON "TransactionActionability"("companyId", "disposition", "checkedAt");

CREATE INDEX "TransactionActionability_companyId_transactionId_revision_qboSyncToken_idx"
ON "TransactionActionability"("companyId", "transactionId", "revision", "qboSyncToken");

ALTER TABLE "TransactionActionability"
ADD CONSTRAINT "TransactionActionability_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TransactionActionability"
ADD CONSTRAINT "TransactionActionability_transactionId_fkey"
FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing mirrors have no trustworthy provider observation.  Seed the index
-- with the current identity and UNKNOWN so queue selectors fail closed until a
-- bounded refresh records an actual safety read.
INSERT INTO "TransactionActionability" (
  "id", "companyId", "transactionId", "disposition", "checkedAt",
  "revision", "qboSyncToken", "qboType", "qboId", "txnDate",
  "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), txn."companyId", txn."id", 'UNKNOWN', NULL,
  txn."revision", txn."qboSyncToken", txn."qboType", txn."qboId",
  txn."date"::date, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Transaction" AS txn;
