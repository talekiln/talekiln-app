import { z } from 'zod';
import type { AdminAuditRecord, AdminRoleName, Repositories } from '../domain/repositories';

const SECRET_KEY = /pass(word)?|secret|token|key|authorization|sign|credential/i;
const MAX_DETAIL_CHARS = 4000;
const MAX_DEPTH = 5;

/** 递归脱敏：键名像口令/密钥/令牌的值一律替换，防止审计日志变成泄密点。 */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 300) return `${v.slice(0, 300)}…`;
  return v;
}

export function summarizeDetail(body: unknown, query: unknown): unknown {
  const d: Record<string, unknown> = {};
  if (body && typeof body === 'object' && Object.keys(body).length) d.body = redact(body);
  if (query && typeof query === 'object' && Object.keys(query).length) d.query = redact(query);
  if (!Object.keys(d).length) return null;
  return JSON.stringify(d).length > MAX_DETAIL_CHARS ? { truncated: true } : d;
}

export interface AuditContext {
  method: string;
  /** Express 路由模板，如 /admin/orders/:id/refund。 */
  routePath: string;
  params: Record<string, unknown>;
  body: unknown;
  query: unknown;
  ip: string | null;
}

export interface AuditActor { id: string | null; email: string | null; role: AdminRoleName | null }

export const auditQuery = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().max(200).optional(),
  targetType: z.string().max(60).optional(),
  targetId: z.string().max(100).optional(),
  before: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(100),
});

/** 审计：管理写操作由拦截器自动记录，登录与越权尝试也记。写审计失败只记日志，不影响业务结果。 */
export class AuditService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  async record(actor: AuditActor, ctx: AuditContext, ok: boolean, status: number, createdId?: string | null): Promise<void> {
    try {
      const m = /^\/(?:admin\/)?([a-z-]+)/.exec(ctx.routePath); // /admin/<对象> 或用户侧 /<对象>（P3-S 工作室操作也进审计）
      const p = ctx.params;
      const fromParams = [p.id, p.code, p.accountId].find((x) => typeof x === 'string') as string | undefined;
      await this.repos.adminAudit.add({
        at: this.now(), actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
        action: `${ctx.method} ${ctx.routePath}`.slice(0, 200),
        targetType: m ? m[1] : null,
        targetId: (fromParams ?? createdId ?? null)?.slice(0, 100) ?? null,
        ok, status, detail: summarizeDetail(ctx.body, ctx.query), ip: ctx.ip,
      });
    } catch (e) {
      console.error('[cloud] 写入审计日志失败', (e as Error).message);
    }
  }

  list(query: unknown): Promise<AdminAuditRecord[]> {
    return this.repos.adminAudit.list(auditQuery.parse(query));
  }
}
