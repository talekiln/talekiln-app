import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ServiceError } from './errors';
import { DeviceService } from './device.service';
import type { TokenPair, TokenService } from './token.service';
import type { Account, InviteCode, Repositories } from '../domain/repositories';

export interface DeviceInfo { fingerprint: string; name: string }

export interface AuthResult extends TokenPair {
  /** phone 仅短信登录的账号有；邮箱密码账号为 null（P2-C 之前的客户端忽略该字段即可）。 */
  account: { id: string; email: string; role: string; plan: string; phone: string | null };
  device: { id: string; name: string } | null;
}

/** 唯一键冲突（Prisma P2002 / 内存实现 unique:xxx）；其他数据库故障不应被伪装成业务错误。 */
export function isUniqueError(e: unknown, field?: string): boolean {
  const code = (e as { code?: string }).code;
  const msg = (e as Error).message ?? '';
  if (code === 'P2002') {
    const target = (e as { meta?: { target?: unknown } }).meta?.target;
    return !field || !Array.isArray(target) || target.includes(field);
  }
  return field ? msg === `unique:${field}` : msg.startsWith('unique:');
}

const normEmail = (e: string) => e.trim().toLowerCase();

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly tokens: TokenService,
    private readonly now: () => Date = () => new Date(),
    private readonly bcryptRounds = 12,
    /** 注入后登录/激活带设备时也走设备数上限；不注入则每次按仓储与当前时钟自建一个。 */
    private readonly devices: DeviceService = new DeviceService(repos, now),
  ) {}

  hash(password: string) { return bcrypt.hash(password, this.bcryptRounds); }

  /** 管理员创建邀请码（随机、不可猜测）。 */
  async createInvite(adminId: string | null, opts: { plan?: string; expiresInDays?: number } = {}): Promise<InviteCode> {
    const code = randomBytes(9).toString('base64url').toUpperCase();
    const expiresAt = opts.expiresInDays
      ? new Date(this.now().getTime() + opts.expiresInDays * 86400_000)
      : null;
    return this.repos.invites.create({ code, plan: opts.plan ?? 'test', createdBy: adminId, expiresAt });
  }

  listInvites() { return this.repos.invites.list(); }

  /** 邀请码激活：创建账号并原子消耗邀请码（一码一用）。 */
  async activate(input: { inviteCode: string; email: string; password: string; device?: DeviceInfo }): Promise<AuthResult> {
    const email = normEmail(input.email);
    const invite = await this.checkInvite(input.inviteCode);
    if (await this.repos.accounts.findByEmail(email)) throw new ServiceError('email_taken');
    const account = await this.createWithInvite(invite, { email, passwordHash: await this.hash(input.password) }, 'email_taken');
    return this.start(account, input.device);
  }

  /** 邀请码存在且未吊销（是否已用 / 过期在 consume 时原子判定）。 */
  async checkInvite(inviteCode: string): Promise<InviteCode> {
    const invite = await this.repos.invites.findByCode(inviteCode.trim());
    if (!invite || invite.revokedAt) throw new ServiceError('invalid_invite');
    return invite;
  }

  /**
   * 用邀请码建账号（邮箱密码激活与 P2-C 短信 / 微信首次登录共用）：
   * 先建账号再原子抢码；抢不到（已被用 / 过期 / 并发）则回滚账号。
   * 唯一键冲突映射为 takenCode（邮箱 / 手机号 / openid 被占用），其他故障原样抛出。
   */
  async createWithInvite(
    invite: InviteCode,
    fields: { email: string; passwordHash: string; phone?: string | null; wechatOpenId?: string | null },
    takenCode: 'email_taken' | 'conflict',
  ): Promise<Account> {
    let account: Account;
    try {
      account = await this.repos.accounts.create({ ...fields, role: 'USER', plan: invite.plan });
    } catch (e) {
      if (isUniqueError(e)) throw new ServiceError(takenCode);
      throw e;
    }
    const won = await this.repos.invites.consume(invite.code, account.id, this.now());
    if (!won) {
      await this.repos.accounts.delete(account.id);
      throw new ServiceError('invalid_invite');
    }
    return account;
  }

  /** 无口令账号（短信 / 微信）的占位口令哈希：随机值哈希后丢弃，密码登录永远比不上。 */
  async unusablePasswordHash(): Promise<string> {
    return this.hash(randomBytes(32).toString('base64url'));
  }

  async login(input: { email: string; password: string; device?: DeviceInfo }): Promise<AuthResult> {
    const account = await this.repos.accounts.findByEmail(normEmail(input.email));
    // 账号不存在时也做一次哈希比较，降低计时差异
    const ok = await bcrypt.compare(input.password, account?.passwordHash ?? (await this.dummyHash()));
    if (!account || !ok) throw new ServiceError('invalid_credentials');
    if (account.disabledAt) throw new ServiceError('account_disabled');
    return this.start(account, input.device);
  }

  private dummy?: Promise<string>;
  private dummyHash() { return (this.dummy ??= this.hash('dummy-password')); }

  refresh(refreshToken: string) { return this.tokens.rotate(refreshToken); }
  logout(refreshToken: string) { return this.tokens.logout(refreshToken); }

  /** 登录成功后的统一收尾：设备登记（含设备数上限）+ 签发令牌。短信 / 微信登录也走这里，返回体一致。 */
  async start(account: Account, info?: DeviceInfo): Promise<AuthResult> {
    let device = null;
    if (info) {
      device = await this.devices.register(account.id, info);
    }
    const pair = await this.tokens.issue(account, device?.id ?? null);
    return {
      ...pair,
      account: { id: account.id, email: account.email, role: account.role, plan: account.plan, phone: account.phone ?? null },
      device: device ? { id: device.id, name: device.name } : null,
    };
  }
}
