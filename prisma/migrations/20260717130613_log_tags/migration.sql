-- CreateTable
CREATE TABLE "LogTag" (
    "companyId" TEXT NOT NULL,
    "qboKey" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "LogTag_pkey" PRIMARY KEY ("companyId","qboKey","tagId")
);

-- CreateIndex
CREATE INDEX "LogTag_companyId_qboKey_idx" ON "LogTag"("companyId", "qboKey");

-- AddForeignKey
ALTER TABLE "LogTag" ADD CONSTRAINT "LogTag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogTag" ADD CONSTRAINT "LogTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
