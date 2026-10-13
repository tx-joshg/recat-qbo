-- Marks magic links returned in a response body (the demo-mode devLink) and
-- the sessions they minted, so both stop working once a real company connects.
ALTER TABLE "MagicLinkToken" ADD COLUMN "exposed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "viaExposedLink" BOOLEAN NOT NULL DEFAULT false;

-- Sessions that already exist cannot say how they were minted. Any created
-- while no real company was connected may have come from a devLink, so treat
-- them as exposed: they keep working while the instance stays demo-only and
-- are revoked on first use after real books connect. Reconnects only move
-- connectedAt later, which flags more sessions, never fewer. The realm ids are
-- the demo realms (MOCK_REALM_IDS in shared/src/index.ts).
UPDATE "Session" SET "viaExposedLink" = true
WHERE "createdAt" < COALESCE(
  (SELECT MIN("connectedAt") FROM "Company"
   WHERE "disconnectedAt" IS NULL
     AND "realmId" NOT IN ('9341002287640001', '4471889011230002')),
  'infinity'::timestamp
);
