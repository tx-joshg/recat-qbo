ALTER TABLE "AgentCompanyConfig" ADD COLUMN "schedulingGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentJob" ADD COLUMN "schedulingGeneration" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "AgentJob_companyId_transactionId_revision_configVersion_key";
CREATE UNIQUE INDEX "AgentJob_scheduling_intent_key"
ON "AgentJob" ("companyId", "transactionId", "revision", "configVersion", "schedulingGeneration");
