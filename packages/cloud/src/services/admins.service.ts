import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ADMIN_ROLES, effectiveRole } from './admin-roles';
import { ServiceError } from './errors';
import type { AdminRoleName, Repositories } from '../domain/repositories';

export const grantSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(ADMIN_ROLES),
  /** 邮箱尚无账号时必填：创建新账号的初始口令。 */
  password: z.string().min(12).max(200).optional(),
});
export const roleSchema = z.object({ role: z.enum(ADMIN_ROLES) });

export interface AdminView {
  accountId: string;
  email: string;
  role: AdminRoleName;
  /** true = 没有 AdminRole 记录，靠 Account.role = ADMIN 继承而来。 */
  legacy: boolean;
  disabled: boolean;
  grantedBy: string | null;
  since: Date;
}

/** 管理员与角色。规则：至少保留一个未禁用的 ADMIN；角色不进令牌，改动立即生效。 */
export class AdminsService {
  constructor(
    private readonly repos: Repositories,
    private readonly now: () => Date = () => new Date(),
    private readonly bcryptRounds = 12,
  ) {}

  async list(): Promise<AdminView[]> {
    const [accounts, rows] = await Promise.all([this.repos.accounts.list(), this.repos.adminRoles.list()]);
    const byId = new Map(rows.map((r) => [r.accountId, r]));
    const out: AdminView[] = [];
    for (const a of accounts) {
      const row = byId.get(a.id) ?? null;
      const role = effectiveRole(a, row);
      if (!role) continue;
      out.push({
        accountId: a.id, email: a.email, role, legacy: !row, disabled: !!a.disabledAt,
        grantedBy: row?.grantedBy ?? null, since: row?.createdAt ?? a.createdAt,
      });
    }
    return out.sort((x, y) => x.since.getTime() - y.since.getTime() || x.email.localeCompare(y.email));
  }

  /** 授予角色：邮箱已有账号则直接授予；否则用 password 新建账号。 */
  async grant(actorId: string, input: unknown): Promise<AdminView> {
    const b = grantSchema.parse(input);
    const email = b.email.trim().toLowerCase();
    let account = await this.repos.accounts.findByEmail(email);
    if (account) {
      if (effectiveRole(account, await this.repos.adminRoles.find(account.id))) {
        throw new ServiceError('conflict', '该账号已经是管理员，请直接修改角色');
      }
    } else {
      if (!b.password) throw new ServiceError('bad_request', '该邮箱尚无账号，需要提供初始口令（至少 12 位）');
      account = await this.repos.accounts.create({
        email, passwordHash: await bcrypt.hash(b.password, this.bcryptRounds), role: 'USER', plan: 'free',
      });
    }
    await this.repos.adminRoles.set(account.id, b.role, actorId, this.now());
    return this.view(account.id);
  }

  async setRole(actorId: string, accountId: string, input: unknown): Promise<AdminView> {
    const { role } = roleSchema.parse(input);
    const cur = await this.current(accountId);
    if (cur.role === 'ADMIN' && role !== 'ADMIN') await this.assertNotLastAdmin(accountId);
    await this.repos.adminRoles.set(accountId, role, actorId, this.now());
    return this.view(accountId);
  }

  /** 撤销管理员身份（账号本身保留）。 */
  async remove(accountId: string): Promise<void> {
    const cur = await this.current(accountId);
    if (cur.role === 'ADMIN') await this.assertNotLastAdmin(accountId);
    await this.repos.adminRoles.remove(accountId);
    const account = await this.repos.accounts.findById(accountId);
    if (account?.role === 'ADMIN') await this.repos.accounts.setRole(accountId, 'USER');
  }

  private async current(accountId: string): Promise<AdminView> {
    const v = (await this.list()).find((x) => x.accountId === accountId);
    if (!v) throw new ServiceError('not_found');
    return v;
  }

  private async view(accountId: string) { return this.current(accountId); }

  /** 目标是 ADMIN 且是仅剩的未禁用 ADMIN 时拒绝降级/撤销。 */
  private async assertNotLastAdmin(accountId: string) {
    const others = (await this.list()).filter((x) => x.role === 'ADMIN' && !x.disabled && x.accountId !== accountId);
    if (others.length === 0) throw new ServiceError('conflict', '必须至少保留一个可用的 ADMIN');
  }
}
