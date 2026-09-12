CREATE TABLE "HistoricalClassificationObservation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sourceTransactionId" TEXT NOT NULL,
  "sourceQboType" VARCHAR(32) NOT NULL,
  "sourceQboId" VARCHAR(128) NOT NULL,
  "sourceTransactionRevision" INTEGER NOT NULL,
  "sourceQboSyncToken" VARCHAR(128) NOT NULL,
  "sourceStatus" "TxnStatus" NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionDate" TIMESTAMP(3) NOT NULL,
  "payee" VARCHAR(500) NOT NULL,
  "memo" VARCHAR(2000),
  "amountCents" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "sourceAccountName" VARCHAR(500) NOT NULL,
  "categoryName" VARCHAR(500) NOT NULL,
  "categoryQboId" VARCHAR(120) NOT NULL,
  "taxCalculation" VARCHAR(32) NOT NULL,
  "taxCodeName" VARCHAR(500),
  "taxCodeQboId" VARCHAR(120),
  "tagNames" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "HistoricalClassificationObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HistoricalClassificationObservation_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE,
  CONSTRAINT "HistoricalClassificationObservation_source_transaction_fkey"
    FOREIGN KEY ("companyId", "sourceTransactionId")
    REFERENCES "Transaction"("companyId", "id") ON DELETE RESTRICT,
  CONSTRAINT "HistoricalClassificationObservation_posted_check"
    CHECK ("sourceStatus" = 'POSTED'::"TxnStatus"),
  CONSTRAINT "HistoricalClassificationObservation_revision_check"
    CHECK ("sourceTransactionRevision" >= 0),
  CONSTRAINT "HistoricalClassificationObservation_identity_key"
    UNIQUE ("companyId", "sourceQboType", "sourceQboId",
            "sourceTransactionRevision", "sourceQboSyncToken")
);

CREATE INDEX "HistoricalClassificationObservation_company_observedAt_idx"
  ON "HistoricalClassificationObservation" ("companyId", "observedAt");
CREATE INDEX "HistoricalClassificationObservation_company_sourceTransactionId_idx"
  ON "HistoricalClassificationObservation" ("companyId", "sourceTransactionId");

CREATE TRIGGER classification_corpus_historical_observation
AFTER INSERT OR DELETE ON "HistoricalClassificationObservation"
FOR EACH ROW EXECUTE FUNCTION classification_corpus_append_company_id();
