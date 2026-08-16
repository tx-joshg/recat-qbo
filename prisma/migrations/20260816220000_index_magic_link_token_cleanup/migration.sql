-- Supports the per-user cleanup that runs on every magic-link issuance:
--   DELETE ... WHERE "userId" = $1 AND ("usedAt" IS NOT NULL OR "expiresAt" < now())
-- The endpoint is publicly reachable, so without this each anonymous request
-- forced a sequential scan of the token table.
CREATE INDEX "MagicLinkToken_userId_expiresAt_idx" ON "MagicLinkToken"("userId", "expiresAt");
