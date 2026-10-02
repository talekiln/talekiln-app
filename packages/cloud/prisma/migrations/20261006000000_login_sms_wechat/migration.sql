-- P2-C：短信验证码登录与微信扫码登录（账号加手机号 / 微信 openid，验证码与二维码票据表）

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "phone" TEXT,
ADD COLUMN "wechatOpenId" TEXT;

-- CreateTable
CREATE TABLE "SmsCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "scene" TEXT NOT NULL DEFAULT 'login',
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WechatQrTicket" (
    "ticket" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "openId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "WechatQrTicket_pkey" PRIMARY KEY ("ticket")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_phone_key" ON "Account"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Account_wechatOpenId_key" ON "Account"("wechatOpenId");

-- CreateIndex
CREATE INDEX "SmsCode_phone_scene_createdAt_idx" ON "SmsCode"("phone", "scene", "createdAt");

-- CreateIndex
CREATE INDEX "WechatQrTicket_expiresAt_idx" ON "WechatQrTicket"("expiresAt");
