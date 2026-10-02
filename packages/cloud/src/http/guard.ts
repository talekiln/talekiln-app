import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAuthService, type AdminIdentity } from '../services/admin-auth.service';
import { can, type Permission } from '../services/admin-roles';
import { AuditService } from '../services/audit.service';
import { ServiceError } from '../services/errors';
import { TokenService, type AccessClaims } from '../services/token.service';

export type AuthedRequest = { headers: Record<string, string | undefined>; auth?: AccessClaims; ip?: string };
export type AdminRequest = AuthedRequest & {
  admin?: AdminIdentity;
  method?: string;
  route?: { path?: string };
  path?: string;
  params?: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
};

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

export const REQUIRE_KEY = 'admin:permission';
/** 声明接口所需的后台权限（见 services/admin-roles.ts）。 */
export const Require = (perm: Permission) => SetMetadata(REQUIRE_KEY, perm);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function auditContext(req: AdminRequest) {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    routePath: req.route?.path ?? req.path ?? '',
    params: req.params ?? {},
    body: req.body,
    query: req.query,
    ip: req.ip ?? null,
  };
}

/**
 * 管理后台守卫：只接受 /admin/auth/login 签发的管理员令牌（独立密钥与 aud），
 * 每次请求回查账号与角色，再按 @Require 声明的权限放行。
 * 未声明时：读（GET/HEAD）需要 read，写需要 ops:write。越权的写尝试会记入审计。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(AdminAuthService) private readonly admins: AdminAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new ServiceError('invalid_token');
    const admin = await this.admins.verify(m[1]);
    req.admin = admin;
    const method = (req.method ?? 'GET').toUpperCase();
    const perm = this.reflector.get<Permission | undefined>(REQUIRE_KEY, ctx.getHandler())
      ?? (SAFE_METHODS.has(method) ? 'read' : 'ops:write');
    if (!can(admin.role, perm)) {
      if (!SAFE_METHODS.has(method)) {
        await this.audit.record({ id: admin.accountId, email: admin.email, role: admin.role }, auditContext(req), false, 403);
      }
      throw new ServiceError('forbidden', `需要权限 ${perm}`);
    }
    return true;
  }
}
