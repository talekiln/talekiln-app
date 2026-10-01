-- AlterTable
ALTER TABLE "Account" ADD COLUMN "disabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InviteCode" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "step" TEXT,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT,
    "installId" TEXT,
    "contact" TEXT,
    "message" TEXT NOT NULL,
    "taskId" TEXT,
    "appVersion" TEXT,
    "diagnostic" BYTEA,
    "diagnosticSize" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryEvent_day_name_idx" ON "TelemetryEvent"("day", "name");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
