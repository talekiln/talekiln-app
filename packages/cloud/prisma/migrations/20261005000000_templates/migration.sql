-- P3-T：模板市场（模板与版本，版本带官方签名）

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Template_tier_check" CHECK ("tier" IN ('free', 'pro'))
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "packageUrl" TEXT,
    "sha256" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TemplateVersion_tier_check" CHECK ("tier" IN ('free', 'pro'))
);

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "TemplateVersion_published_publishedAt_idx" ON "TemplateVersion"("published", "publishedAt");

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
