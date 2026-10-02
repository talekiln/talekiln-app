-- P3-P：插件注册表（登记、版本、审核、官方签名）

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "homepage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginVersion" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "fileHashes" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "packageUrl" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "signature" JSONB,
    "signedAt" TIMESTAMP(3),
    "signedBy" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginVersion_reviewStatus_check" CHECK ("reviewStatus" IN ('pending', 'approved', 'rejected'))
);

-- CreateTable
CREATE TABLE "PluginReview" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginReview_action_check" CHECK ("action" IN ('submit', 'approve', 'reject', 'sign'))
);

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_name_key" ON "Plugin"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PluginVersion_pluginId_version_key" ON "PluginVersion"("pluginId", "version");

-- CreateIndex
CREATE INDEX "PluginVersion_reviewStatus_createdAt_idx" ON "PluginVersion"("reviewStatus", "createdAt");

-- CreateIndex
CREATE INDEX "PluginVersion_hash_idx" ON "PluginVersion"("hash");

-- CreateIndex
CREATE INDEX "PluginReview_versionId_createdAt_idx" ON "PluginReview"("versionId", "createdAt");

-- AddForeignKey
ALTER TABLE "PluginVersion" ADD CONSTRAINT "PluginVersion_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginReview" ADD CONSTRAINT "PluginReview_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PluginVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
