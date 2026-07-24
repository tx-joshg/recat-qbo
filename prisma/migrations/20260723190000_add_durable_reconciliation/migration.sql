-- Durable follow-up markers prevent process restarts from losing mode-change
-- job reconciliation or deterministic rule writes deferred by the company
-- write lease.

ALTER TABLE "Company"
  ADD COLUMN "agentReconcileToken" TEXT,
  ADD COLUMN "ruleWriteRetryAt" TIMESTAMP(3);

CREATE INDEX "Company_agentReconcileToken_idx"
  ON "Company"("agentReconcileToken");

CREATE INDEX "Company_ruleWriteRetryAt_idx"
  ON "Company"("ruleWriteRetryAt");
