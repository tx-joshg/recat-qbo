ALTER TABLE "QboMutationAttempt"
    ADD COLUMN "classificationEnvelopeVersion" INTEGER,
    ADD COLUMN "classificationEnvelopeHash" VARCHAR(64);

ALTER TABLE "QboMutationAttempt"
    ADD CONSTRAINT "QboMutationAttempt_classification_envelope_check"
    CHECK (
      (
        "classificationEnvelopeVersion" IS NULL
        AND "classificationEnvelopeHash" IS NULL
      )
      OR (
        "classificationEnvelopeVersion" = 2
        AND "classificationEnvelopeHash" ~ '^[0-9a-f]{64}$'
      )
    );
