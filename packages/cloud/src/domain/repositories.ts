// 领域类型与仓储接口：业务逻辑只依赖这些接口，测试用内存实现，生产用 Prisma 实现。
export type Role = 'USER' | 'ADMIN';

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  plan: string;
  createdAt: Date;
}

export interface InviteCode {
  id: string;
  code: string;
  plan: string;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  usedById: string | null;
}

export interface Device {
  id: string;
  accountId: string;
  fingerprint: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface RefreshTokenRecord {
  id: string;
  familyId: string;
  accountId: string;
  deviceId: string | null;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface AccountRepository {
  create(a: Omit<Account, 'id' | 'createdAt'>): Promise<Account>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  delete(id: string): Promise<void>;
}

export interface InviteRepository {
  create(i: { code: string; plan: string; createdBy: string | null; expiresAt: Date | null }): Promise<InviteCode>;
  findByCode(code: string): Promise<InviteCode | null>;
  list(): Promise<InviteCode[]>;
  /** 原子地标记使用：仅当 usedAt 为空且未过期时成功，返回是否抢到。 */
  consume(code: string, accountId: string, now: Date): Promise<boolean>;
}

export interface DeviceRepository {
  upsert(accountId: string, fingerprint: string, name: string): Promise<Device>;
  findById(id: string): Promise<Device | null>;
  listByAccount(accountId: string): Promise<Device[]>;
  touch(id: string, now: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<void>;
}

export interface RefreshTokenRepository {
  create(t: Omit<RefreshTokenRecord, 'id' | 'createdAt' | 'usedAt' | 'revokedAt'>): Promise<RefreshTokenRecord>;
  findByHash(hash: string): Promise<RefreshTokenRecord | null>;
  /** 原子地标记已使用：仅当 usedAt 与 revokedAt 均为空时成功。 */
  markUsed(id: string, now: Date): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeAllForAccount(accountId: string, now: Date): Promise<void>;
}

export const REPOS = Symbol('REPOS');
export interface Repositories {
  accounts: AccountRepository;
  invites: InviteRepository;
  devices: DeviceRepository;
  refreshTokens: RefreshTokenRepository;
}
