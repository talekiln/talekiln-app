import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './errors';
import { PLAN_ENTITLEMENTS } from './licence.service';
import type { AppConfig } from './config';
import type { Account, InviteCode, Repositories } from '../domain/repositories';

export const catalogSchema = z.array(z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(['text', 'image', 'video', 'tts']),
  provider: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  price: z.number().min(0).max(1_000_000),
  unit: z.string().min(1).max(20),
  enabled: z.boolean(),
})).max(200).refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'id 不能重复');

export type CatalogEntry = z.infer<typeof catalogSchema>[number];

export type InviteStatus = 'unused' | 'used' | 'expired' | 'revoked';

export function inviteStatus(i: InviteCode, now: Date): InviteStatus {
  if (i.usedAt) return 'used';
  if (i.revokedAt) return 'revoked';
  if (i.expiresAt && i.expiresAt <= now) return 'expired';
  return 'unused';
}

export const MAX_BATCH = 200;

export class AdminService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---- 邀请码 ----
  async createInvites(adminId: string, opts: { plan?: string; expiresInDays?: number; count?: number }) {
    const count = opts.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw new ServiceError('bad_request', `count 需在 1..${MAX_BATCH}`);
    const expiresAt = opts.expiresInDays ? new Date(this.now().getTime() + opts.expiresInDays * 86400_000) : null;
    const out: InviteCode[] = [];
    for (let n = 0; n < count; n++) {
      // 随机码（72 位熵）；极小概率撞唯一键时重试
      for (let attempt = 0; ; attempt++) {
        try {
          out.push(await this.repos.invites.create({
            code: randomBytes(9).toString('base64url').toUpperCase(),
            plan: opts.plan ?? 'test', createdBy: adminId, expiresAt,
          }));
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
    }
    return out.map((i) => this.inviteView(i));
  }

  async listInvites(status?: InviteStatus) {
    const all = (await this.repos.invites.list()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const views = all.map((i) => this.inviteView(i));
    return status ? views.filter((v) => v.status === status) : views;
  }

  async revokeInvite(id: string) {
    const inv = await this.repos.invites.findById(id);
    if (!inv) throw new ServiceError('not_found');
    if (!(await this.repos.invites.revoke(id, this.now()))) throw new ServiceError('bad_request', '邀请码已使用或已吊销');
  }

  private inviteView(i: InviteCode) {
    return {
      id: i.id, code: i.code, plan: i.plan, createdAt: i.createdAt, expiresAt: i.expiresAt,
      usedAt: i.usedAt, usedById: i.usedById, revokedAt: i.revokedAt, status: inviteStatus(i, this.now()),
    };
  }

  // ---- 用户 ----
  async listUsers() {
    const accounts = (await this.repos.accounts.list()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.all(accounts.map(async (a) => {
      const devices = await this.repos.devices.listByAccount(a.id);
      const seen = devices.map((d) => d.lastSeenAt?.getTime() ?? 0);
      return {
        ...this.accountView(a),
        deviceCount: devices.filter((d) => !d.revokedAt).length,
        lastSeenAt: seen.length && Math.max(...seen) ? new Date(Math.max(...seen)) : null,
      };
    }));
  }

  async getUser(id: string) {
    const a = await this.repos.accounts.findById(id);
    if (!a) throw new ServiceError('not_found');
    const devices = await this.repos.devices.listByAccount(id);
    return {
      ...this.accountView(a),
      devices: devices.map((d) => ({
        id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt,
      })),
      // 授权视图：与 /licence/renew 签发的内容一致（不含令牌本身）
      licence: {
        plan: a.plan,
        entitlements: [...(PLAN_ENTITLEMENTS[a.plan] ?? [])],
        validDays: this.cfg.licenceTtlSeconds / 86400,
        graceDays: this.cfg.graceDays,
        renewable: !a.disabledAt,
      },
    };
  }

  async setDisabled(id: string, disabled: boolean) {
    const a = await this.repos.accounts.findById(id);
    if (!a) throw new ServiceError('not_found');
    if (a.role === 'ADMIN' || (await this.repos.adminRoles.find(id))) throw new ServiceError('forbidden', '不能禁用管理员账号');
    const now = this.now();
    await this.repos.accounts.setDisabled(id, disabled ? now : null);
    if (disabled) await this.repos.refreshTokens.revokeAllForAccount(id, now);
  }

  private accountView(a: Account) {
    return {
      id: a.id, email: a.email, role: a.role, plan: a.plan, createdAt: a.createdAt, disabledAt: a.disabledAt,
      disabled: !!a.disabledAt,
    };
  }

  // ---- 模型目录（公告已迁到 AnnouncementService）----
  async getCatalog(): Promise<CatalogEntry[]> {
    return (await this.repos.settings.get<CatalogEntry[]>('catalog')) ?? [];
  }
  async setCatalog(input: unknown): Promise<CatalogEntry[]> {
    const v = catalogSchema.parse(input);
    await this.repos.settings.set('catalog', v);
    return v;
  }
  /** 客户端可见：只含启用项。 */
  async publicCatalog() { return (await this.getCatalog()).filter((c) => c.enabled); }
}
