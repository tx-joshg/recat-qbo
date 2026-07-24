-- Snapshot the sanitized transaction identity used by each run so later QBO
-- edits cannot rewrite historical evidence used for rule candidates.
ALTER TABLE "AgentRun" ADD COLUMN "transactionSnapshot" JSONB;
