import { CallHandler, ExecutionContext, HttpException, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, mergeMap, Observable } from 'rxjs';
import { ZodError } from 'zod';
import { auditContext, type AdminRequest } from './guard';
import { errorStatus } from './filter';
import { AuditService } from '../services/audit.service';
import { ServiceError } from '../services/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTTP_CODE_KEY = '__httpCode__'; // @nestjs/common 的 @HttpCode 元数据键

function failureStatus(e: unknown): number {
  if (e instanceof ServiceError) return errorStatus(e.code);
  if (e instanceof ZodError) return 400;
  if (e instanceof HttpException) return e.getStatus();
  return 500;
}

/**
 * 管理写操作审计：挂在管理控制器上，所有非读方法（POST/PUT/PATCH/DELETE）自动记录
 * “谁（账号、角色）、何时、做了什么（路由）、对象（路径参数或新建记录的 id）、结果与脱敏后的请求摘要”。
 * 新增管理接口无需任何额外代码即被审计。读操作不记。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const method = (req.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method) || !req.admin) return next.handle();
    const actor = { id: req.admin.accountId, email: req.admin.email, role: req.admin.role };
    const okStatus = (Reflect.getMetadata(HTTP_CODE_KEY, ctx.getHandler()) as number | undefined) ?? (method === 'POST' ? 201 : 200);
    // 响应发出前先写完审计（在 mergeMap/catchError 里 await），调用方拿到响应时日志已落库
    return next.handle().pipe(
      mergeMap(async (value) => {
        const id = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : null;
        await this.audit.record(actor, auditContext(req), true, okStatus, id);
        return value;
      }),
      catchError(async (e) => {
        await this.audit.record(actor, auditContext(req), false, failureStatus(e));
        throw e;
      }),
    );
  }
}
