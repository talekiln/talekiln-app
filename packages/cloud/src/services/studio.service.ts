import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config';
import { AuditService } from './audit.service';
import { ServiceError } from './errors';
import type { Repositories, StudioInviteRecord, StudioMemberRecord, StudioRecord, StudioRole } from '../domain/repositories';

/**
 * P3-S 工作室版基础（云端）：工作室、成员、席位、邀请。
 *
 * 云端只管「谁在哪个工作室、什么角色、席位占用」；共享角色库与模板在对象存储（MinIO）的 shared/<studio_id>/ 前缀下，
 * 由本机服务凭这里返回的身份读写（docs/phase3-studio.md）。
 *
 * 席位（计费占位）：seatLimit 由后台管理员设置，将来由订阅驱动；**席位定价待定**，这里没有任何价格字段。
 * 占用 = active 成员数 + 未过期、未使用、未撤销的邀请数（邀请先占位，避免超发）；超限返回 seat_limit（403）。
 *
 * 权限：owner 可做一切（除移除自己）；admin 可邀请 / 撤销邀请 / 移除 member；member 只能查看和退出；
 * 改角色只有 owner 能做，且不能改 owner 自己。suspended 的工作室拒绝一切写操作（studio_suspended）。
 */
export const STUDIO_ROLES: StudioRole[] = ['owner', 'admin', 'member'];
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1
const DEFAULT_INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 90;
const MAX_SEATS = 1000;

export const studioCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export const inviteCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  role: z.enum(['admin', 'member']).default('member'),
  expiresInDays: z.coerce.number().int().min(1).max(MAX_INVITE_DAYS).default(DEFAULT_INVITE_DAYS),
});
export const acceptSchema = z.object({ code: z.string().trim().min(4).max(32) });
export const roleSchema = z.object({ role: z.enum(['admin', 'member']) });
export const seatSchema = z.object({ seatLimit: z.coerce.number().int().min(0).max(MAX_SEATS) });
export const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export function generateInviteCode(bytes = randomBytes(10)): string {
  let out = '';
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return out;
}

export interface SeatUsage {
  limit: number;
  /** active 成员数。 */
  used: number;
  /** 未过期、未使用、未撤销的邀请数（已占位）。 */
  pending: number;
  /** limit - used - pending，不小于 0。 */
  available: number;
}

export const inviteIsOpen = (i: StudioInviteRecord, now: Date) => !i.usedAt && !i.revokedAt && i.expiresAt.getTime() > now.getTime();

export function seatUsage(studio: StudioRecord, members: StudioMemberRecord[], invites: StudioInviteRecord[], now: Date): SeatUsage {
  const used = members.filter((m) => m.status === 'active').length;
  const pending = invites.filter((i) => inviteIsOpen(i, now)).length;
  return { limit: studio.seatLimit, used, pending, available: Math.max(0, studio.seatLimit - used - pending) };
}

const ROLE_RANK: Record<StudioRole, number> = { owner: 0, admin: 1, member: 2 };
/** 展示顺序：owner、admin、member，同角色按加入时间。 */
export const sortMembers = (ms: StudioMemberRecord[]) => [...ms].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0) || a.accountId.localeCompare(b.accountId));

const isUnique = (e: unknown) => {
  const msg = e instanceof Error ? e.message : '';
  return msg.startsWith('unique:') || (e as { code?: string }).code === 'P2002';
};

export interface StudioActor { accountId: string; email?: string | null; ip?: string | null }

export class StudioService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly audit: AuditService | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- 审计（用户侧操作也记：工作室是多人共享的对象） ----------

  private async log(actor: StudioActor, action: string, studioId: string | null, ok: boolean, status: number, body?: unknown) {
    if (!this.audit) return;
    let email = actor.email ?? null;
    if (email === null) { try { email = (await this.repos.accounts.findById(actor.accountId))?.email ?? null; } catch { email = null; } }
    await this.audit.record(
      { id: actor.accountId, email, role: null },
      { method: action.split(' ')[0], routePath: action.split(' ')[1] ?? action, params: studioId ? { id: studioId } : {}, body: body ?? null, query: null, ip: actor.ip ?? null },
      ok, status,
    );
  }

  // ---------- 读取 ----------

  private async studioOr404(id: string) {
    const s = await this.repos.studios.findById(id);
    if (!s) throw new ServiceError('not_found', '工作室不存在');
    return s;
  }

  /** 活跃成员身份；不是成员（或已移除）抛 forbidden。 */
  private async membership(studioId: string, accountId: string) {
    const m = await this.repos.studios.findMember(studioId, accountId);
    if (!m || m.status !== 'active') throw new ServiceError('forbidden', '你不是该工作室的成员');
    return m;
  }

  private requireRole(m: StudioMemberRecord, roles: StudioRole[], what: string) {
    if (!roles.includes(m.role)) throw new ServiceError('forbidden', `${what}需要 ${roles.join(' / ')} 角色`);
  }

  private requireActive(s: StudioRecord) {
    if (s.status !== 'active') throw new ServiceError('studio_suspended', '工作室已被停用，只能查看');
  }

  private async emailsOf(ids: string[]) {
    const out = new Map<string, string | null>();
    await Promise.all([...new Set(ids)].map(async (id) => {
      const a = await this.repos.accounts.findById(id);
      out.set(id, a ? a.email : null);
    }));
    return out;
  }

  private async summary(s: StudioRecord, viewerId?: string) {
    const members = await this.repos.studios.listMembers(s.id);
    const invites = await this.repos.studios.listInvites(s.id);
    const me = viewerId ? members.find((m) => m.accountId === viewerId && m.status === 'active') ?? null : null;
    return { ...s, seats: seatUsage(s, members, invites, this.now()), my_role: me ? me.role : null };
  }

  /** 我所在的工作室（active 成员）：本机服务拿它当工作室身份。 */
  async mine(accountId: string) {
    const list = await this.repos.studios.listByMember(accountId);
    return { items: await Promise.all(list.map((s) => this.summary(s, accountId))), issued_at: this.now().toISOString() };
  }

  /** 工作室详情：成员（带邮箱）、席位；owner / admin 还能看到未处理的邀请。 */
  async get(studioId: string, accountId: string) {
    const s = await this.studioOr404(studioId);
    const me = await this.membership(studioId, accountId);
    const members = await this.repos.studios.listMembers(studioId);
    const invites = await this.repos.studios.listInvites(studioId);
    const emails = await this.emailsOf(members.map((m) => m.accountId));
    const now = this.now();
    const canManage = me.role === 'owner' || me.role === 'admin';
    return {
      ...s,
      my_role: me.role,
      seats: seatUsage(s, members, invites, now),
      members: sortMembers(members.filter((m) => m.status !== 'removed')).map((m) => ({
        account_id: m.accountId, email: emails.get(m.accountId) ?? null, role: m.role, status: m.status, joined_at: m.joinedAt ? m.joinedAt.toISOString() : null,
      })),
      invites: canManage ? invites.filter((i) => inviteIsOpen(i, now)).map((i) => this.inviteView(i)) : [],
    };
  }

  private inviteView(i: StudioInviteRecord) {
    return { id: i.id, code: i.code, email: i.email, role: i.role, expires_at: i.expiresAt.toISOString(), created_at: i.createdAt.toISOString() };
  }

  // ---------- 写操作 ----------

  /** 创建工作室：创建者成为 owner（占 1 个席位）；seatLimit 用配置的默认值（计费占位）。 */
  async create(actor: StudioActor, input: unknown) {
    const b = studioCreateSchema.parse(input);
    const now = this.now();
    const s = await this.repos.studios.create({ name: b.name, ownerId: actor.accountId, seatLimit: this.cfg.studioDefaultSeatLimit, status: 'active' }, now);
    await this.repos.studios.addMember({ studioId: s.id, accountId: actor.accountId, role: 'owner', status: 'active', joinedAt: now, removedAt: null }, now);
    await this.log(actor, 'POST /studios', s.id, true, 201, { name: b.name });
    return this.summary(s, actor.accountId);
  }

  /** 邀请：owner / admin；席位（含未处理邀请）满了拒绝 seat_limit；邮箱已是成员拒绝 conflict。 */
  async invite(actor: StudioActor, studioId: string, input: unknown) {
    const b = inviteCreateSchema.parse(input);
    const s = await this.studioOr404(studioId);
    const me = await this.membership(studioId, actor.accountId);
    this.requireRole(me, ['owner', 'admin'], '邀请成员');
    this.requireActive(s);
    const now = this.now();
    const members = await this.repos.studios.listMembers(studioId);
    const invites = await this.repos.studios.listInvites(studioId);
    if (b.email) {
      const acc = await this.repos.accounts.findByEmail(b.email);
      if (acc && members.some((m) => m.accountId === acc.id && m.status === 'active')) throw new ServiceError('conflict', '该邮箱已是工作室成员');
      if (invites.some((i) => inviteIsOpen(i, now) && i.email === b.email)) throw new ServiceError('conflict', '该邮箱已有未处理的邀请');
    }
    const seats = seatUsage(s, members, invites, now);
    if (seats.available <= 0) {
      await this.log(actor, 'POST /studios/:id/invites', studioId, false, 403, { email: b.email ?? null, role: b.role });
      throw new ServiceError('seat_limit', `席位已满（${seats.used} 人 + ${seats.pending} 份待处理邀请 / 上限 ${seats.limit}），请先调整席位数或撤销多余邀请`);
    }
    let rec: StudioInviteRecord | null = null;
    for (let attempt = 0; attempt < 5 && !rec; attempt++) {
      try {
        rec = await this.repos.studios.createInvite({
          studioId, code: generateInviteCode(), email: b.email ?? null, role: b.role, createdBy: actor.accountId,
          expiresAt: new Date(now.getTime() + b.expiresInDays * 86_400_000),
        }, now);
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
    if (!rec) throw new ServiceError('conflict', '生成邀请码失败，请重试');
    await this.log(actor, 'POST /studios/:id/invites', studioId, true, 201, { email: b.email ?? null, role: b.role, expiresInDays: b.expiresInDays });
    return this.inviteView(rec);
  }

  async revokeInvite(actor: StudioActor, studioId: string, inviteId: string) {
    const s = await this.studioOr404(studioId);
    const me = await this.membership(studioId, actor.accountId);
    this.requireRole(me, ['owner', 'admin'], '撤销邀请');
    this.requireActive(s);
    const inv = await this.repos.studios.findInvite(inviteId);
    if (!inv || inv.studioId !== studioId) throw new ServiceError('not_found', '邀请不存在');
    if (inv.usedAt) throw new ServiceError('conflict', '邀请已被接受，撤销无效；请改为移除成员');
    if (!inv.revokedAt) await this.repos.studios.updateInvite(inviteId, { revokedAt: this.now() });
    await this.log(actor, 'DELETE /studios/:id/invites/:inviteId', studioId, true, 204, { inviteId });
  }

  /**
   * 接受邀请：码有效（未过期 / 未使用 / 未撤销）、邮箱匹配（指定了邮箱时）、工作室 active、席位未满。
   * 曾被移除的成员重新接受会把原记录改回 active。
   */
  async accept(actor: StudioActor, input: unknown) {
    const b = acceptSchema.parse(input);
    const now = this.now();
    const inv = await this.repos.studios.findInviteByCode(b.code.toUpperCase());
    if (!inv || !inviteIsOpen(inv, now)) {
      await this.log(actor, 'POST /studios/accept', inv ? inv.studioId : null, false, 400);
      throw new ServiceError('bad_request', !inv ? '邀请码不存在' : inv.usedAt ? '邀请码已被使用' : inv.revokedAt ? '邀请已撤销' : '邀请已过期');
    }
    if (inv.email) {
      const acc = await this.repos.accounts.findById(actor.accountId);
      if (!acc || acc.email.toLowerCase() !== inv.email.toLowerCase()) throw new ServiceError('forbidden', '这份邀请发给了别的邮箱');
    }
    const s = await this.studioOr404(inv.studioId);
    this.requireActive(s);
    const members = await this.repos.studios.listMembers(s.id);
    const existing = members.find((m) => m.accountId === actor.accountId);
    if (existing && existing.status === 'active') throw new ServiceError('conflict', '你已经是该工作室的成员');
    // 自己这份邀请已经占了一个位，所以只看 active 成员数
    if (members.filter((m) => m.status === 'active').length >= s.seatLimit) {
      await this.log(actor, 'POST /studios/accept', s.id, false, 403);
      throw new ServiceError('seat_limit', '工作室席位已满，请联系所有者调整席位数');
    }
    let member: StudioMemberRecord;
    if (existing) member = (await this.repos.studios.updateMember(existing.id, { role: inv.role, status: 'active', joinedAt: now, removedAt: null }, now))!;
    else {
      try {
        member = await this.repos.studios.addMember({ studioId: s.id, accountId: actor.accountId, role: inv.role, status: 'active', joinedAt: now, removedAt: null }, now);
      } catch (e) {
        if (isUnique(e)) throw new ServiceError('conflict', '你已经是该工作室的成员');
        throw e;
      }
    }
    await this.repos.studios.updateInvite(inv.id, { usedAt: now, usedById: actor.accountId });
    await this.log(actor, 'POST /studios/accept', s.id, true, 200, { role: inv.role });
    return { studio: await this.summary(s, actor.accountId), member: { account_id: member.accountId, role: member.role, status: member.status } };
  }

  /** 移除成员：owner 可移除任何人（除自己）；admin 只能移除 member；任何人可退出（owner 除外）。 */
  async removeMember(actor: StudioActor, studioId: string, targetAccountId: string) {
    const s = await this.studioOr404(studioId);
    const me = await this.membership(studioId, actor.accountId);
    this.requireActive(s);
    const target = await this.repos.studios.findMember(studioId, targetAccountId);
    if (!target || target.status !== 'active') throw new ServiceError('not_found', '成员不存在');
    if (target.role === 'owner') throw new ServiceError('forbidden', '不能移除所有者；转让所有权尚未支持');
    const self = target.accountId === actor.accountId;
    if (!self) {
      if (me.role === 'member') throw new ServiceError('forbidden', '成员只能退出自己');
      if (me.role === 'admin' && target.role !== 'member') throw new ServiceError('forbidden', '管理员只能移除普通成员');
    }
    await this.repos.studios.updateMember(target.id, { status: 'removed', removedAt: this.now() }, this.now());
    await this.log(actor, 'DELETE /studios/:id/members/:accountId', studioId, true, 204, { accountId: targetAccountId, self });
  }

  /** 改角色（admin <-> member）：只有 owner；不能改 owner。 */
  async setRole(actor: StudioActor, studioId: string, targetAccountId: string, input: unknown) {
    const b = roleSchema.parse(input);
    const s = await this.studioOr404(studioId);
    const me = await this.membership(studioId, actor.accountId);
    this.requireRole(me, ['owner'], '调整成员角色');
    this.requireActive(s);
    const target = await this.repos.studios.findMember(studioId, targetAccountId);
    if (!target || target.status !== 'active') throw new ServiceError('not_found', '成员不存在');
    if (target.role === 'owner') throw new ServiceError('forbidden', '不能改变所有者的角色');
    const m = (await this.repos.studios.updateMember(target.id, { role: b.role }, this.now()))!;
    await this.log(actor, 'PUT /studios/:id/members/:accountId/role', studioId, true, 200, { accountId: targetAccountId, role: b.role });
    return { account_id: m.accountId, role: m.role, status: m.status };
  }

  // ---------- 后台（AdminGuard + AuditInterceptor 记审计） ----------

  /** 全部工作室（含席位占用与所有者邮箱）。 */
  async adminList() {
    const list = await this.repos.studios.list();
    const emails = await this.emailsOf(list.map((s) => s.ownerId));
    return Promise.all(list.map(async (s) => ({ ...(await this.summary(s)), owner_email: emails.get(s.ownerId) ?? null })));
  }

  async adminGet(studioId: string) {
    const s = await this.studioOr404(studioId);
    const members = await this.repos.studios.listMembers(studioId);
    const invites = await this.repos.studios.listInvites(studioId);
    const emails = await this.emailsOf([s.ownerId, ...members.map((m) => m.accountId)]);
    const now = this.now();
    return {
      ...s, owner_email: emails.get(s.ownerId) ?? null, seats: seatUsage(s, members, invites, now),
      members: members.map((m) => ({ account_id: m.accountId, email: emails.get(m.accountId) ?? null, role: m.role, status: m.status, joined_at: m.joinedAt?.toISOString() ?? null, removed_at: m.removedAt?.toISOString() ?? null })),
      invites: invites.map((i) => ({ ...this.inviteView(i), used_at: i.usedAt?.toISOString() ?? null, revoked_at: i.revokedAt?.toISOString() ?? null, open: inviteIsOpen(i, now) })),
    };
  }

  /** 调整席位数（计费占位：将来由订阅驱动）。不能低于当前 active 成员数。 */
  async adminSetSeatLimit(studioId: string, input: unknown) {
    const b = seatSchema.parse(input);
    const s = await this.studioOr404(studioId);
    const used = (await this.repos.studios.listMembers(studioId)).filter((m) => m.status === 'active').length;
    if (b.seatLimit < used) throw new ServiceError('bad_request', `席位数不能低于当前成员数（${used}）；请先移除成员`);
    return this.summary((await this.repos.studios.update(s.id, { seatLimit: b.seatLimit }, this.now()))!);
  }

  async adminSetStatus(studioId: string, input: unknown) {
    const b = statusSchema.parse(input);
    const s = await this.studioOr404(studioId);
    return this.summary((await this.repos.studios.update(s.id, { status: b.status }, this.now()))!);
  }
}
