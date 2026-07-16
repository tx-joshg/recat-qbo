-- AlterTable
ALTER TABLE "Rule" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- Preserve current newest-first matching: older rules get higher priority numbers.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "companyId" ORDER BY "createdAt" DESC) - 1 AS pos
  FROM "Rule"
)
UPDATE "Rule" r SET "priority" = o.pos FROM ordered o WHERE r.id = o.id;

-- CreateTable
CREATE TABLE "Membership" (
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("userId","companyId")
);

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (added after data mapping below needs the old column)
ALTER TABLE "User" ADD COLUMN "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Data migration: instance-wide roles become per-company memberships in every
-- connected company; admins become instance admins.
UPDATE "User" SET "isInstanceAdmin" = true WHERE "role" = 'admin';
INSERT INTO "Membership" ("userId", "companyId", "role")
SELECT u.id, c.id, u."role" FROM "User" u CROSS JOIN "Company" c
ON CONFLICT DO NOTHING;

ALTER TABLE "User" DROP COLUMN "role";
