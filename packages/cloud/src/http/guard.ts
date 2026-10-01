import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ServiceError } from '../services/errors';
import { TokenService, type AccessClaims } from '../services/token.service';

export type AuthedRequest = { headers: Record<string, string | undefined>; auth?: AccessClaims };

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

export function requireAdmin(req: AuthedRequest): AccessClaims {
  if (req.auth?.role !== 'ADMIN') throw new ServiceError('forbidden');
  return req.auth;
}
