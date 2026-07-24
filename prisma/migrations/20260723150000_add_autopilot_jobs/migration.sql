CREATE TYPE "AutopilotMode" AS ENUM ('off', 'shadow', 'live');
CREATE TYPE "AgentJobStatus" AS ENUM ('queued', 'running', 'retry', 'completed', 'failed', 'cancelled');

ALTER TABLE "Company"
  ADD COLUMN "autopilotMode" "AutopilotMode" NOT NULL DEFAULT 'off',
  ADD COLUMN "autopilotLiveConfirmedAt" TIMESTAMP(3);

CREATE TABLE "AgentJob" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "status" "AgentJobStatus" NOT NULL DEFAULT 'queued',
  "inputHash" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "toolSchemaVersion" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "mode" "AutopilotMode" NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "decision" JSONB,
  "toolTrace" JSONB,
  "validation" JSONB,
  "verification" JSONB,
  "turnCount" INTEGER NOT NULL DEFAULT 0,
  "toolCallCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentCompanyLease" (
  "companyId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentCompanyLease_pkey" PRIMARY KEY ("companyId")
);

CREATE UNIQUE INDEX "AgentJob_transactionId_key" ON "AgentJob"("transactionId");
CREATE INDEX "AgentJob_status_nextAttemptAt_idx" ON "AgentJob"("status", "nextAttemptAt");
CREATE INDEX "AgentJob_companyId_status_idx" ON "AgentJob"("companyId", "status");
CREATE INDEX "AgentJob_leaseExpiresAt_idx" ON "AgentJob"("leaseExpiresAt");
CREATE INDEX "AgentRun_jobId_startedAt_idx" ON "AgentRun"("jobId", "startedAt");
CREATE INDEX "AgentRun_companyId_startedAt_idx" ON "AgentRun"("companyId", "startedAt");
CREATE INDEX "AgentRun_transactionId_startedAt_idx" ON "AgentRun"("transactionId", "startedAt");
CREATE INDEX "AgentCompanyLease_leaseExpiresAt_idx" ON "AgentCompanyLease"("leaseExpiresAt");

ALTER TABLE "AgentJob"
  ADD CONSTRAINT "AgentJob_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentJob"
  ADD CONSTRAINT "AgentJob_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "AgentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCompanyLease"
  ADD CONSTRAINT "AgentCompanyLease_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
