-- Additive Purchase tax staging and company reference cache.
ALTER TABLE "Company" ADD COLUMN "taxReferenceRefreshedAt" TIMESTAMP(3);

ALTER TABLE "Transaction"
  ADD COLUMN "taxCalculation" TEXT,
  ADD COLUMN "taxCode" TEXT,
  ADD COLUMN "taxCodeQboId" TEXT;

ALTER TABLE "SplitLine"
  ADD COLUMN "taxCode" TEXT,
  ADD COLUMN "taxCodeQboId" TEXT;

ALTER TABLE "Rule"
  ADD COLUMN "taxCalculation" TEXT,
  ADD COLUMN "taxCode" TEXT,
  ADD COLUMN "taxCodeQboId" TEXT;

CREATE TABLE "QboTaxCode" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "qboId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "taxable" BOOLEAN,
  "purchaseTaxRateList" JSONB,
  "salesTaxRateList" JSONB,
  "rawData" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QboTaxCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QboTaxRate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "qboId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "rateValue" DECIMAL(12,6),
  "rawData" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QboTaxRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QboTaxCode_companyId_qboId_key" ON "QboTaxCode"("companyId", "qboId");
CREATE UNIQUE INDEX "QboTaxRate_companyId_qboId_key" ON "QboTaxRate"("companyId", "qboId");

ALTER TABLE "QboTaxCode"
  ADD CONSTRAINT "QboTaxCode_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QboTaxRate"
  ADD CONSTRAINT "QboTaxRate_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
