-- CreateTable
CREATE TABLE "ReferralClick" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "src" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralClick_code_createdAt_idx" ON "ReferralClick"("code", "createdAt");
