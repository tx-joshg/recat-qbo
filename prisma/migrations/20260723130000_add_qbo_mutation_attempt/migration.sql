CREATE TABLE "QboMutationAttempt" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "decisionHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requestPath" TEXT,
  "requestBody" JSONB,
  "before" JSONB,
  "expected" JSONB,
  "response" JSONB,
  "verification" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QboMutationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QboMutationAttempt_requestId_key" ON "QboMutationAttempt"("requestId");
CREATE INDEX "QboMutationAttempt_transactionId_createdAt_idx"
  ON "QboMutationAttempt"("transactionId", "createdAt");

ALTER TABLE "QboMutationAttempt"
  ADD CONSTRAINT "QboMutationAttempt_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
