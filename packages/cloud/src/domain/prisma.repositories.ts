import type { PrismaClient } from '@prisma/client';
import type { Repositories } from './repositories';

// Prisma 实现（需要真实 PostgreSQL 才能验证）。
export function createPrismaRepositories(db: PrismaClient): Repositories {
  return {
    accounts: {
      create: (a) => db.account.create({ data: a }),
      findById: (id) => db.account.findUnique({ where: { id } }),
      findByEmail: (email) => db.account.findUnique({ where: { email } }),
      delete: async (id) => { await db.account.delete({ where: { id } }); },
    },
    invites: {
      create: (i) => db.inviteCode.create({ data: i }),
      findByCode: (code) => db.inviteCode.findUnique({ where: { code } }),
      list: () => db.inviteCode.findMany({ orderBy: { createdAt: 'desc' } }),
      async consume(code, accountId, now) {
        // 条件更新：并发下只有一个请求能把 usedAt 从 NULL 改掉
        const r = await db.inviteCode.updateMany({
          where: { code, usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
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
  };
}
