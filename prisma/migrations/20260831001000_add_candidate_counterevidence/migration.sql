ALTER TABLE "AutopilotRuleCandidateEvidence"
    ADD COLUMN "polarity" TEXT NOT NULL DEFAULT 'positive';

ALTER TABLE "AutopilotRuleCandidateEvidence"
    ADD CONSTRAINT "AutopilotRuleCandidateEvidence_polarity_check"
    CHECK ("polarity" IN ('positive', 'negative'));

DROP INDEX "AutopilotRuleCandidateEvidence_requestId_key";

CREATE UNIQUE INDEX "AutopilotRuleCandidateEvidence_requestId_candidateId_key"
    ON "AutopilotRuleCandidateEvidence"("requestId", "candidateId");
