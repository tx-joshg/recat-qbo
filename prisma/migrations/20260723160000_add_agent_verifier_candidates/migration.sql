CREATE TYPE "RuleCandidateStatus" AS ENUM ('pending', 'activated', 'dismissed');

ALTER TABLE "AgentRun" ADD COLUMN "verifier" JSONB;

CREATE TABLE "RuleCandidate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "normalizedPayee" TEXT NOT NULL,
  "matchText" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "categoryQboId" TEXT NOT NULL,
  "taxCalculation" TEXT NOT NULL,
  "taxCode" TEXT NOT NULL,
  "taxCodeQboId" TEXT NOT NULL,
  "evidenceCount" INTEGER NOT NULL,
  "evidenceRunIds" JSONB NOT NULL,
  "conflicts" JSONB NOT NULL,
  "status" "RuleCandidateStatus" NOT NULL DEFAULT 'pending',
  "createdRuleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuleCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuleCandidate_fingerprint_key" ON "RuleCandidate"("fingerprint");
CREATE INDEX "RuleCandidate_companyId_status_idx" ON "RuleCandidate"("companyId", "status");
CREATE INDEX "RuleCandidate_companyId_normalizedPayee_idx" ON "RuleCandidate"("companyId", "normalizedPayee");

ALTER TABLE "RuleCandidate"
  ADD CONSTRAINT "RuleCandidate_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
