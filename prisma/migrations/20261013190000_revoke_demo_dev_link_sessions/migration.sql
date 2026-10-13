-- Marks magic links returned in a response body (the demo-mode devLink), the
-- sessions they mint, and the MCP tokens those sessions create, so all three
-- stop working once a real company connects.
ALTER TABLE "MagicLinkToken" ADD COLUMN "exposed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "viaExposedLink" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "McpToken" ADD COLUMN "viaExposedSession" BOOLEAN NOT NULL DEFAULT false;

-- Rows that already exist cannot say how they were minted, and timestamps do
-- not settle it: a devLink issued during the demo window could be consumed
-- after real books connected, and reconnecting a company does not move its
-- connectedAt. So every existing credential is treated as possibly exposed.
-- Nothing changes while the instance stays demo-only; once a real company is
-- connected, each user signs in again and re-creates MCP tokens once.
UPDATE "MagicLinkToken" SET "exposed" = true WHERE "usedAt" IS NULL;
UPDATE "Session" SET "viaExposedLink" = true;
UPDATE "McpToken" SET "viaExposedSession" = true WHERE "revokedAt" IS NULL;
