import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ServiceError } from './errors';
import { DeviceService } from './device.service';
import type { TokenPair, TokenService } from './token.service';
import type { Account, InviteCode, Repositories } from '../domain/repositories';

export interface DeviceInfo { fingerprint: string; name: string }

export interface AuthResult extends TokenPair {
  account: { id: string; email: string; role: string; plan: string };
  device: { id: string; name: string } | null;
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
    const invite = await this.repos.invites.findByCode(input.inviteCode.trim());
    if (!invite || invite.revokedAt) throw new ServiceError('invalid_invite');
    if (await this.repos.accounts.findByEmail(email)) throw new ServiceError('email_taken');
    let account: Account;
    try {
      account = await this.repos.accounts.create({
        email, passwordHash: await this.hash(input.password), role: 'USER', plan: invite.plan,
      });
    } catch (e) {
      // 仅唯一键冲突（Prisma P2002 / 内存实现）才是邮箱占用；其他数据库故障不应被伪装成 email_taken
      const code = (e as { code?: string }).code;
      if (code === 'P2002' || (e as Error).message?.startsWith('unique:')) throw new ServiceError('email_taken');
      throw e;
    }
    // 先建账号再原子抢码；抢不到（已被用/过期/并发）则回滚账号
    const won = await this.repos.invites.consume(invite.code, account.id, this.now());
    if (!won) {
      await this.repos.accounts.delete(account.id);
      throw new ServiceError('invalid_invite');
    }
    return this.start(account, input.device);
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

  private async start(account: Account, info?: DeviceInfo): Promise<AuthResult> {
    let device = null;
    if (info) {
      device = await this.devices.register(account.id, info);
    }
    const pair = await this.tokens.issue(account, device?.id ?? null);
    return {
      ...pair,
      account: { id: account.id, email: account.email, role: account.role, plan: account.plan },
      device: device ? { id: device.id, name: device.name } : null,
    };
  }
}
