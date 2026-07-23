ALTER TABLE "Company"
  ADD COLUMN "taxUsingSalesTax" BOOLEAN,
  ADD COLUMN "taxSupportStatus" TEXT NOT NULL DEFAULT 'needs_setup',
  ADD COLUMN "taxSupportReason" TEXT;
