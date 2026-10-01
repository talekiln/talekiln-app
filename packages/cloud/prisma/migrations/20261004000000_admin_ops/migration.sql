-- P2-H：公告、版本灰度、管理员角色、审计日志

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "channel" TEXT NOT NULL DEFAULT 'all',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Announcement_level_check" CHECK ("level" IN ('info', 'warn', 'critical')),
    CONSTRAINT "Announcement_channel_check" CHECK ("channel" IN ('all', 'beta', 'stable'))
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "minVersion" TEXT,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Release_channel_check" CHECK ("channel" IN ('beta', 'stable')),
    CONSTRAINT "Release_rollout_check" CHECK ("rolloutPercent" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "AdminRole" (
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "AdminRole_role_check" CHECK ("role" IN ('ADMIN', 'OPERATOR', 'READONLY'))
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER NOT NULL,
    "detail" JSONB,
    "ip" TEXT,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_enabled_startsAt_idx" ON "Announcement"("enabled", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Release_version_channel_key" ON "Release"("version", "channel");

-- CreateIndex
CREATE INDEX "Release_channel_enabled_idx" ON "Release"("channel", "enabled");

-- CreateIndex
CREATE INDEX "AdminAudit_at_idx" ON "AdminAudit"("at");

-- CreateIndex
CREATE INDEX "AdminAudit_actorId_at_idx" ON "AdminAudit"("actorId", "at");

-- CreateIndex
CREATE INDEX "AdminAudit_targetType_targetId_idx" ON "AdminAudit"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
