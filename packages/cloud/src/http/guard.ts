import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AdminAuthService } from '../services/admin-auth.service';
import { ServiceError } from '../services/errors';
import { TokenService, type AccessClaims } from '../services/token.service';

export type AuthedRequest = { headers: Record<string, string | undefined>; auth?: AccessClaims; ip?: string };
export type AdminRequest = AuthedRequest & { admin?: { accountId: string; email: string } };

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new ServiceError('invalid_token');
    req.auth = await this.tokens.verifyAccess(m[1]);
    return true;
  }
}

/** 管理后台守卫：只接受 /admin/auth/login 签发的管理员令牌（独立密钥与 aud）。 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly admins: AdminAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new ServiceError('invalid_token');
    req.admin = await this.admins.verify(m[1]);
    return true;
  }
}
