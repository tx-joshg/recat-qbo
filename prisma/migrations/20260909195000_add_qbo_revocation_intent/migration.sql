CREATE TABLE "QboTokenRevocation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "realmId" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  CONSTRAINT "QboTokenRevocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QboTokenRevocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "QboTokenRevocation_companyId_idx" ON "QboTokenRevocation"("companyId");
CREATE INDEX "QboTokenRevocation_leaseExpiresAt_createdAt_idx" ON "QboTokenRevocation"("leaseExpiresAt", "createdAt");
