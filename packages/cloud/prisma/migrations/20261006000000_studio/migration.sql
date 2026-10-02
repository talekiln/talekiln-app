-- P3-S：工作室版基础（工作室、成员、席位、邀请）。不含任何价格字段：席位定价待定。

-- CreateTable
CREATE TABLE "Studio" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "seatLimit" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Studio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Studio_status_check" CHECK ("status" IN ('active', 'suspended')),
    CONSTRAINT "Studio_seatLimit_check" CHECK ("seatLimit" >= 0)
);

-- CreateTable
CREATE TABLE "StudioMember" (
    "id" TEXT NOT NULL,
    "studioId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joinedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioMember_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StudioMember_role_check" CHECK ("role" IN ('owner', 'admin', 'member')),
    CONSTRAINT "StudioMember_status_check" CHECK ("status" IN ('invited', 'active', 'removed'))
);

-- CreateTable
CREATE TABLE "StudioInvite" (
    "id" TEXT NOT NULL,
    "studioId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioInvite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StudioInvite_role_check" CHECK ("role" IN ('admin', 'member'))
);

-- CreateIndex
CREATE INDEX "Studio_ownerId_idx" ON "Studio"("ownerId");
CREATE UNIQUE INDEX "StudioMember_studioId_accountId_key" ON "StudioMember"("studioId", "accountId");
CREATE INDEX "StudioMember_accountId_status_idx" ON "StudioMember"("accountId", "status");
CREATE UNIQUE INDEX "StudioInvite_code_key" ON "StudioInvite"("code");
CREATE INDEX "StudioInvite_studioId_usedAt_revokedAt_idx" ON "StudioInvite"("studioId", "usedAt", "revokedAt");

-- AddForeignKey
ALTER TABLE "StudioMember" ADD CONSTRAINT "StudioMember_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "Studio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioInvite" ADD CONSTRAINT "StudioInvite_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "Studio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
