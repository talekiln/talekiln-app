// 领域类型与仓储接口：业务逻辑只依赖这些接口，测试用内存实现，生产用 Prisma 实现。
export type Role = 'USER' | 'ADMIN';

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  plan: string;
  disabledAt: Date | null;
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
  revokedAt: Date | null;
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
  create(a: Omit<Account, 'id' | 'createdAt' | 'disabledAt'> & { disabledAt?: Date | null }): Promise<Account>;
  list(): Promise<Account[]>;
  setDisabled(id: string, at: Date | null): Promise<void>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  delete(id: string): Promise<void>;
}

export interface InviteRepository {
  create(i: { code: string; plan: string; createdBy: string | null; expiresAt: Date | null }): Promise<InviteCode>;
  findByCode(code: string): Promise<InviteCode | null>;
  list(): Promise<InviteCode[]>;
  findById(id: string): Promise<InviteCode | null>;
  /** 仅当邀请码未使用且未吊销时吊销，返回是否成功。 */
  revoke(id: string, now: Date): Promise<boolean>;
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

export interface SettingRepository {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface TelemetryRow {
  at: Date;
  day: string;
  installId: string;
  name: string;
  code: string | null;
  step: string | null;
}

export interface TelemetryRepository {
  addMany(rows: TelemetryRow[]): Promise<void>;
  /** 返回 day >= fromDay（含）的事件，day 为 YYYY-MM-DD（UTC）。 */
  since(fromDay: string): Promise<TelemetryRow[]>;
}

export interface FeedbackRecord {
  id: string;
  createdAt: Date;
  accountId: string | null;
  installId: string | null;
  contact: string | null;
  message: string;
  taskId: string | null;
  appVersion: string | null;
  diagnostic: Buffer | null;
  diagnosticSize: number;
}

export interface FeedbackRepository {
  create(f: Omit<FeedbackRecord, 'id' | 'createdAt'>): Promise<FeedbackRecord>;
  /** 列表不带诊断包内容。 */
  list(limit: number): Promise<Omit<FeedbackRecord, 'diagnostic'>[]>;
  findById(id: string): Promise<FeedbackRecord | null>;
}

export interface ReferralClick { id: string; code: string; src: string | null; createdAt: Date }

export interface ReferralClickRepository {
  create(c: { code: string; src: string | null; createdAt: Date }): Promise<ReferralClick>;
  countByCode(code: string): Promise<number>;
}

export const REPOS = Symbol('REPOS');
export interface Repositories {
  accounts: AccountRepository;
  invites: InviteRepository;
  devices: DeviceRepository;
  refreshTokens: RefreshTokenRepository;
  settings: SettingRepository;
  telemetry: TelemetryRepository;
  feedback: FeedbackRepository;
  referralClicks: ReferralClickRepository;
}
