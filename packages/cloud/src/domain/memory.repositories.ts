import { randomUUID } from 'node:crypto';
import type {
  Account, Device, InviteCode, RefreshTokenRecord, Repositories,
} from './repositories';

// 内存实现：仅用于测试（单线程 JS 下每个方法体天然原子）。
export function createMemoryRepositories(): Repositories {
  const accounts = new Map<string, Account>();
  const invites = new Map<string, InviteCode>();
  const devices = new Map<string, Device>();
  const tokens = new Map<string, RefreshTokenRecord>();

  return {
    accounts: {
      async create(a) {
        for (const x of accounts.values()) if (x.email === a.email) throw new Error('unique:email');
        const rec: Account = { ...a, id: randomUUID(), createdAt: new Date() };
        accounts.set(rec.id, rec);
        return { ...rec };
      },
      async findById(id) { const r = accounts.get(id); return r ? { ...r } : null; },
      async findByEmail(email) {
        for (const x of accounts.values()) if (x.email === email) return { ...x };
        return null;
      },
      async delete(id) { accounts.delete(id); },
    },
    invites: {
      async create(i) {
        for (const x of invites.values()) if (x.code === i.code) throw new Error('unique:code');
        const rec: InviteCode = { ...i, id: randomUUID(), createdAt: new Date(), usedAt: null, usedById: null };
        invites.set(rec.id, rec);
        return { ...rec };
      },
      async findByCode(code) {
        for (const x of invites.values()) if (x.code === code) return { ...x };
        return null;
      },
      async list() { return [...invites.values()].map((x) => ({ ...x })); },
      async consume(code, accountId, now) {
        for (const x of invites.values()) {
          if (x.code !== code) continue;
          if (x.usedAt || (x.expiresAt && x.expiresAt <= now)) return false;
          x.usedAt = now;
          x.usedById = accountId;
          return true;
        }
        return false;
      },
    },
    devices: {
      async upsert(accountId, fingerprint, name) {
        for (const x of devices.values()) {
          if (x.accountId === accountId && x.fingerprint === fingerprint) {
            x.name = name;
            return { ...x };
          }
        }
        const rec: Device = {
          id: randomUUID(), accountId, fingerprint, name,
          createdAt: new Date(), lastSeenAt: null, revokedAt: null,
        };
        devices.set(rec.id, rec);
        return { ...rec };
      },
      async findById(id) { const r = devices.get(id); return r ? { ...r } : null; },
      async listByAccount(accountId) {
        return [...devices.values()].filter((d) => d.accountId === accountId).map((d) => ({ ...d }));
      },
      async touch(id, now) { const d = devices.get(id); if (d) d.lastSeenAt = now; },
      async revoke(id, now) { const d = devices.get(id); if (d) d.revokedAt = now; },
    },
    refreshTokens: {
      async create(t) {
        const rec: RefreshTokenRecord = { ...t, id: randomUUID(), createdAt: new Date(), usedAt: null, revokedAt: null };
        tokens.set(rec.id, rec);
        return { ...rec };
      },
      async findByHash(hash) {
        for (const x of tokens.values()) if (x.tokenHash === hash) return { ...x };
        return null;
      },
      async markUsed(id, now) {
        const t = tokens.get(id);
        if (!t || t.usedAt || t.revokedAt) return false;
        t.usedAt = now;
        return true;
      },
      async revokeFamily(familyId, now) {
        for (const t of tokens.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = now;
      },
      async revokeAllForAccount(accountId, now) {
        for (const t of tokens.values()) if (t.accountId === accountId && !t.revokedAt) t.revokedAt = now;
      },
    },
  };
}
