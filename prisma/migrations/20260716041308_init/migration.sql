-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'categorizer', 'viewer');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('PENDING', 'POSTING', 'POSTED', 'DRY_RUN', 'ERROR', 'SUPERSEDED', 'REVERTED');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('polling', 'webhook');

-- CreateEnum
CREATE TYPE "QboEnv" AS ENUM ('sandbox', 'production');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'categorizer',
    "invitePending" BOOLEAN NOT NULL DEFAULT false,
    "dashboardLayout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "env" "QboEnv" NOT NULL DEFAULT 'sandbox',
    "syncMode" "SyncMode" NOT NULL DEFAULT 'polling',
    "pollIntervalMin" INTEGER NOT NULL DEFAULT 10,
    "holdingAccountIds" JSONB NOT NULL DEFAULT '[]',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "tagsRequired" BOOLEAN NOT NULL DEFAULT false,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "qboType" TEXT NOT NULL,
    "qboSyncToken" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payee" TEXT NOT NULL,
    "memo" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankAccount" TEXT NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'PENDING',
    "category" TEXT,
    "categoryQboId" TEXT,
    "splits" JSONB,
    "suggestion" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxnTag" (
    "txnId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TxnTag_pkey" PRIMARY KEY ("txnId","tagId")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "matchField" TEXT NOT NULL DEFAULT 'payee',
    "matchText" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "categoryQboId" TEXT,
    "autoPost" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleTag" (
    "ruleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "RuleTag_pkey" PRIMARY KEY ("ruleId","tagId")
);

-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "txnId" TEXT,
    "payee" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "action" TEXT NOT NULL,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "accountType" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Company_realmId_key" ON "Company"("realmId");

-- CreateIndex
CREATE INDEX "Transaction_companyId_status_idx" ON "Transaction"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_companyId_qboType_qboId_key" ON "Transaction"("companyId", "qboType", "qboId");

-- CreateIndex
CREATE INDEX "AuditEntry_companyId_at_idx" ON "AuditEntry"("companyId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "QboAccount_companyId_qboId_key" ON "QboAccount"("companyId", "qboId");

-- CreateIndex
CREATE INDEX "SyncLog_companyId_at_idx" ON "SyncLog"("companyId", "at");

-- AddForeignKey
ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TxnTag" ADD CONSTRAINT "TxnTag_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TxnTag" ADD CONSTRAINT "TxnTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleTag" ADD CONSTRAINT "RuleTag_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleTag" ADD CONSTRAINT "RuleTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QboAccount" ADD CONSTRAINT "QboAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
