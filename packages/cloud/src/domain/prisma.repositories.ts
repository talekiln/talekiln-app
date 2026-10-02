import type { Prisma, PrismaClient } from '@prisma/client';
import type { Repositories } from './repositories';

// Prisma 实现（需要真实 PostgreSQL 才能验证）。
export function createPrismaRepositories(db: PrismaClient): Repositories {
  return {
    accounts: {
      create: (a) => db.account.create({ data: a }),
      list: () => db.account.findMany({ orderBy: { createdAt: 'desc' } }),
      setDisabled: async (id, at) => { await db.account.update({ where: { id }, data: { disabledAt: at } }); },
      findById: (id) => db.account.findUnique({ where: { id } }),
      findByEmail: (email) => db.account.findUnique({ where: { email } }),
      delete: async (id) => { await db.account.delete({ where: { id } }); },
    },
    invites: {
      create: (i) => db.inviteCode.create({ data: i }),
      findByCode: (code) => db.inviteCode.findUnique({ where: { code } }),
      list: () => db.inviteCode.findMany({ orderBy: { createdAt: 'desc' } }),
      findById: (id) => db.inviteCode.findUnique({ where: { id } }),
      async revoke(id, now) {
        const r = await db.inviteCode.updateMany({ where: { id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        return r.count === 1;
      },
      async consume(code, accountId, now) {
        // 条件更新：并发下只有一个请求能把 usedAt 从 NULL 改掉
        const r = await db.inviteCode.updateMany({
          where: { code, usedAt: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          data: { usedAt: now, usedById: accountId },
        });
        return r.count === 1;
      },
    },
    devices: {
      upsert: (accountId, fingerprint, name) =>
        db.device.upsert({
          where: { accountId_fingerprint: { accountId, fingerprint } },
          create: { accountId, fingerprint, name },
          update: { name },
        }),
      findById: (id) => db.device.findUnique({ where: { id } }),
      listByAccount: (accountId) => db.device.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
      touch: async (id, now) => { await db.device.update({ where: { id }, data: { lastSeenAt: now } }); },
      revoke: async (id, now) => { await db.device.update({ where: { id }, data: { revokedAt: now } }); },
    },
    refreshTokens: {
      create: (t) => db.refreshToken.create({ data: t }),
      findByHash: (tokenHash) => db.refreshToken.findUnique({ where: { tokenHash } }),
      async markUsed(id, now) {
        const r = await db.refreshToken.updateMany({
          where: { id, usedAt: null, revokedAt: null },
          data: { usedAt: now },
        });
        return r.count === 1;
      },
      async revokeFamily(familyId, now) {
        await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
      },
      async revokeAllForAccount(accountId, now) {
        await db.refreshToken.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } });
      },
    },
    settings: {
      async get<T>(key: string) {
        const r = await db.setting.findUnique({ where: { key } });
        return r ? (r.value as T) : null;
      },
      async set(key, value) {
        const v = value as Prisma.InputJsonValue;
        await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
      },
    },
    telemetry: {
      async addMany(rows) { await db.telemetryEvent.createMany({ data: rows }); },
      since: (fromDay) => db.telemetryEvent.findMany({
        where: { day: { gte: fromDay } },
        select: { at: true, day: true, installId: true, name: true, code: true, step: true },
      }),
    },
    feedback: {
      create: async (f) => {
        const r = await db.feedback.create({ data: { ...f, diagnostic: f.diagnostic ? new Uint8Array(f.diagnostic) : null } });
        return { ...r, diagnostic: r.diagnostic ? Buffer.from(r.diagnostic) : null };
      },
      list: (limit) => db.feedback.findMany({
        orderBy: { createdAt: 'desc' }, take: limit,
        select: { id: true, createdAt: true, accountId: true, installId: true, contact: true, message: true, taskId: true, appVersion: true, diagnosticSize: true },
      }),
      async findById(id) {
        const r = await db.feedback.findUnique({ where: { id } });
        return r ? { ...r, diagnostic: r.diagnostic ? Buffer.from(r.diagnostic) : null } : null;
      },
    },
    referralClicks: {
      create: (c) => db.referralClick.create({ data: c }),
      countByCode: (code) => db.referralClick.count({ where: { code } }),
    },
  };
}
