import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from './config';
import { effectiveRole } from './admin-roles';
import { ServiceError } from './errors';
import type { AdminRoleName, Repositories } from '../domain/repositories';

const AUDIENCE = 'talekiln-admin';

export interface AdminIdentity { accountId: string; email: string; role: AdminRoleName }

/** 管理后台独立认证：独立密钥 + aud，不接受普通用户访问令牌；每次请求回查账号仍是未禁用的管理员，并重新解析角色。 */
export class AdminAuthService {
  private dummy?: string;

  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(emailRaw: string, password: string) {
    const account = await this.repos.accounts.findByEmail(emailRaw.trim().toLowerCase());
    this.dummy ??= await bcrypt.hash('dummy-password', 4);
    const ok = await bcrypt.compare(password, account?.passwordHash ?? this.dummy);
    const role = account ? effectiveRole(account, await this.repos.adminRoles.find(account.id)) : null;
    if (!account || !ok || !role) throw new ServiceError('invalid_credentials');
    if (account.disabledAt) throw new ServiceError('account_disabled');
    const iat = Math.floor(this.now().getTime() / 1000);
    const token = await new SignJWT({ typ: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(AUDIENCE)
      .setSubject(account.id)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.cfg.adminTtlSeconds)
      .sign(this.cfg.adminSecret);
    return { token, expiresIn: this.cfg.adminTtlSeconds, admin: { id: account.id, email: account.email, role } };
  }

  async verify(token: string): Promise<AdminIdentity> {
    let sub: string;
    try {
      const { payload } = await jwtVerify(token, this.cfg.adminSecret, {
        algorithms: ['HS256'], audience: AUDIENCE, currentDate: this.now(),
      });
      sub = String(payload.sub);
    } catch {
      throw new ServiceError('invalid_token');
    }
    const account = await this.repos.accounts.findById(sub);
    if (!account || account.disabledAt) throw new ServiceError('forbidden');
    // 角色不放进令牌：降权/撤销立即生效
    const role = effectiveRole(account, await this.repos.adminRoles.find(account.id));
    if (!role) throw new ServiceError('forbidden');
    return { accountId: account.id, email: account.email, role };
  }
}
