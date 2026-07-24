-- Persist the normalized merchant identity used by rule-candidate evidence.
-- Existing runs remain null: historical JSON is intentionally not reinterpreted
-- during migration, while every new run writes the canonical value.
ALTER TABLE "AgentRun" ADD COLUMN "candidatePayee" TEXT;

CREATE INDEX "AgentRun_companyId_candidatePayee_completedAt_idx"
  ON "AgentRun"("companyId", "candidatePayee", "completedAt");
