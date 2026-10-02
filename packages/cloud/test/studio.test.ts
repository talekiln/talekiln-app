import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { loadConfig } from '../src/services/config';
import { AuditService } from '../src/services/audit.service';
import { AuthService } from '../src/services/auth.service';
import { ServiceError } from '../src/services/errors';
import { StudioService, generateInviteCode, seatUsage } from '../src/services/studio.service';
import { TokenService } from '../src/services/token.service';
import type { Repositories } from '../src/domain/repositories';

// P3-S 工作室版基础（云端）：仓储契约、席位超限、角色权限、邀请过期 / 邮箱匹配、后台席位调整、HTTP 与审计。
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
const cfg = (seats = 2) => loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', STUDIO_DEFAULT_SEAT_LIMIT: String(seats) } as NodeJS.ProcessEnv);
const code = (e: unknown) => (e instanceof ServiceError ? e.code : String(e));
const rejects = (p: Promise<unknown>, c: string, re?: RegExp) => assert.rejects(p, (e: unknown) => {
  assert.equal(code(e), c, e instanceof Error ? e.message : String(e));
  if (re) assert.match((e as Error).message, re);
  return true;
});

async function account(repos: Repositories, email: string) {
  return repos.accounts.create({ email, passwordHash: 'h', role: 'USER', plan: 'test' });
}

// ---------------------------------------------------------------------------
// 仓储契约（内存 / PostgreSQL）
// ---------------------------------------------------------------------------
test('工作室仓储：成员 (studioId, accountId) 唯一、按成员列工作室、邀请码唯一、级联', async () => {
  const r = await makeRepos();
  const s = await r.studios.create({ name: '甲工作室', ownerId: 'o1', seatLimit: 3, status: 'active' }, at(0));
  assert.equal(s.seatLimit, 3);
  assert.equal(s.status, 'active');
  const s2 = await r.studios.create({ name: '乙', ownerId: 'o2', seatLimit: 1, status: 'active' }, at(1));
  assert.deepEqual((await r.studios.list()).map((x) => x.name), ['甲工作室', '乙']);
  const upd = await r.studios.update(s.id, { seatLimit: 5, status: 'suspended', name: '甲' }, at(2));
  assert.equal(upd!.seatLimit, 5);
  assert.equal(upd!.status, 'suspended');
  assert.equal(upd!.updatedAt.getTime(), at(2).getTime());
  assert.equal(await r.studios.update('00000000-0000-4000-8000-000000000000', { seatLimit: 1 }, at(2)), null);

  const m1 = await r.studios.addMember({ studioId: s.id, accountId: 'o1', role: 'owner', status: 'active', joinedAt: at(0), removedAt: null }, at(0));
  assert.equal(m1.role, 'owner');
  await assert.rejects(r.studios.addMember({ studioId: s.id, accountId: 'o1', role: 'member', status: 'active', joinedAt: at(0), removedAt: null }, at(1)), '同一账号重复加入');
  await assert.rejects(r.studios.addMember({ studioId: '00000000-0000-4000-8000-000000000000', accountId: 'x', role: 'member', status: 'active', joinedAt: null, removedAt: null }, at(1)), '工作室不存在');
  const m2 = await r.studios.addMember({ studioId: s.id, accountId: 'u2', role: 'member', status: 'active', joinedAt: at(3), removedAt: null }, at(3));
  await r.studios.addMember({ studioId: s2.id, accountId: 'u2', role: 'member', status: 'active', joinedAt: at(3), removedAt: null }, at(4));
  assert.deepEqual((await r.studios.listMembers(s.id)).map((m) => m.accountId), ['o1', 'u2']);
  assert.deepEqual((await r.studios.listByMember('u2')).map((x) => x.id), [s.id, s2.id]);
  const rem = await r.studios.updateMember(m2.id, { status: 'removed', removedAt: at(5) }, at(5));
  assert.equal(rem!.status, 'removed');
  assert.deepEqual((await r.studios.listByMember('u2')).map((x) => x.id), [s2.id], '已移除的不算');
  assert.equal((await r.studios.findMember(s.id, 'u2'))!.status, 'removed');
  assert.equal(await r.studios.findMember(s.id, 'nobody'), null);

  const i1 = await r.studios.createInvite({ studioId: s.id, code: 'ABCD2345', email: null, role: 'member', createdBy: 'o1', expiresAt: at(DAY) }, at(6));
  assert.equal(i1.usedAt, null);
  await assert.rejects(r.studios.createInvite({ studioId: s.id, code: 'ABCD2345', email: null, role: 'member', createdBy: 'o1', expiresAt: at(DAY) }, at(7)), '邀请码重复');
  const i2 = await r.studios.createInvite({ studioId: s.id, code: 'WXYZ6789', email: 'a@x.com', role: 'admin', createdBy: 'o1', expiresAt: at(DAY) }, at(8));
  assert.deepEqual((await r.studios.listInvites(s.id)).map((i) => i.code), ['WXYZ6789', 'ABCD2345'], '新的在前');
  assert.equal((await r.studios.findInviteByCode('WXYZ6789'))!.email, 'a@x.com');
  assert.equal(await r.studios.findInviteByCode('nope'), null);
  const used = await r.studios.updateInvite(i1.id, { usedAt: at(9), usedById: 'u3' });
  assert.equal(used!.usedById, 'u3');
  assert.equal((await r.studios.findInvite(i2.id))!.role, 'admin');
});

// ---------------------------------------------------------------------------
// 服务：席位、角色、邀请
// ---------------------------------------------------------------------------
async function setup(seats = 2) {
  const repos = await makeRepos();
  let clock = T0;
  const audit = new AuditService(repos, () => clock);
  const svc = new StudioService(repos, cfg(seats), audit, () => clock);
  const owner = await account(repos, 'owner@example.com');
  const alice = await account(repos, 'alice@example.com');
  const bob = await account(repos, 'bob@example.com');
  const carol = await account(repos, 'carol@example.com');
  const actor = (a: { id: string }) => ({ accountId: a.id });
  return { repos, svc, owner, alice, bob, carol, actor, tick: (ms: number) => { clock = at(ms); } };
}

test('席位：占用 = 成员 + 待处理邀请；超限拒绝 seat_limit；撤销 / 过期后席位释放；后台不能把席位调到成员数以下', async () => {
  const { repos, svc, owner, alice, bob, carol, actor, tick } = await setup(2);
  const s = await svc.create(actor(owner), { name: '  工作室 A ' });
  assert.equal(s.name, '工作室 A');
  assert.equal(s.my_role, 'owner');
  assert.deepEqual(s.seats, { limit: 2, used: 1, pending: 0, available: 1 });
  const inv = await svc.invite(actor(owner), s.id, { role: 'member' });
  assert.match(inv.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal((await svc.get(s.id, owner.id)).seats.available, 0, '邀请占位');
  await rejects(svc.invite(actor(owner), s.id, {}), 'seat_limit', /席位已满/);
  // 撤销后可以再发
  await svc.revokeInvite(actor(owner), s.id, inv.id);
  const inv2 = await svc.invite(actor(owner), s.id, { email: 'Alice@Example.com', expiresInDays: 1 });
  assert.equal(inv2.email, 'alice@example.com');
  await rejects(svc.invite(actor(owner), s.id, { email: 'alice@example.com' }), 'conflict', /未处理的邀请/);
  await rejects(svc.invite(actor(owner), s.id, { email: 'bob@example.com' }), 'seat_limit');
  // 过期：席位释放，但码不能再用
  tick(DAY + 1);
  assert.equal((await svc.get(s.id, owner.id)).seats.available, 1);
  await rejects(svc.accept(actor(alice), { code: inv2.code }), 'bad_request', /过期/);
  const inv3 = await svc.invite(actor(owner), s.id, { email: 'alice@example.com', expiresInDays: 7 });
  await rejects(svc.accept(actor(bob), { code: inv3.code }), 'forbidden', /别的邮箱/);
  const acc = await svc.accept(actor(alice), { code: inv3.code.toLowerCase() });
  assert.equal(acc.member.role, 'member');
  assert.deepEqual(acc.studio.seats, { limit: 2, used: 2, pending: 0, available: 0 });
  await rejects(svc.accept(actor(alice), { code: inv3.code }), 'bad_request', /已被使用/);
  await rejects(svc.invite(actor(owner), s.id, { email: 'alice@example.com' }), 'conflict', /已是工作室成员/);
  // 满了之后别人拿着（后台加席位前签发的）码也进不来：先把席位调大签一份码，再调回去
  const big = await svc.adminSetSeatLimit(s.id, { seatLimit: 3 });
  assert.equal(big.seats.available, 1);
  const inv4 = await svc.invite(actor(owner), s.id, {});
  await rejects(svc.adminSetSeatLimit(s.id, { seatLimit: 1 }), 'bad_request', /不能低于/);
  await svc.adminSetSeatLimit(s.id, { seatLimit: 2 });
  await rejects(svc.accept(actor(bob), { code: inv4.code }), 'seat_limit');
  await svc.adminSetSeatLimit(s.id, { seatLimit: 3 });
  await svc.accept(actor(bob), { code: inv4.code });
  assert.deepEqual((await svc.mine(bob.id)).items.map((x) => x.id), [s.id]);
  assert.deepEqual((await svc.mine(carol.id)).items, []);
  // 审计：用户侧写操作都记了（含失败的超限）
  const audits = await repos.adminAudit.list({ limit: 100 });
  const actions = audits.map((a) => `${a.ok ? 'ok' : 'fail'} ${a.action}`);
  assert.ok(actions.includes('ok POST /studios'));
  assert.ok(actions.includes('fail POST /studios/:id/invites'));
  assert.ok(actions.includes('ok POST /studios/accept'));
  assert.ok(audits.every((a) => a.targetType === 'studios'));
  assert.equal(audits.find((a) => a.action === 'POST /studios')!.actorEmail, 'owner@example.com');
  assert.equal(audits.find((a) => a.action === 'POST /studios')!.targetId, s.id);
});

test('角色权限：member 只能看与退出；admin 可邀请、只能移除 member；owner 改角色、不能被移除；停用后拒绝写', async () => {
  const { svc, owner, alice, bob, carol, actor } = await setup(10);
  const s = await svc.create(actor(owner), { name: 'B' });
  const join = async (who: { id: string }, role: 'admin' | 'member') => svc.accept(actor(who), { code: (await svc.invite(actor(owner), s.id, { role })).code });
  await join(alice, 'admin');
  await join(bob, 'member');
  // 非成员
  await rejects(svc.get(s.id, carol.id), 'forbidden');
  await rejects(svc.invite(actor(carol), s.id, {}), 'forbidden');
  // member
  await rejects(svc.invite(actor(bob), s.id, {}), 'forbidden', /owner \/ admin/);
  await rejects(svc.removeMember(actor(bob), s.id, alice.id), 'forbidden', /只能退出自己/);
  await rejects(svc.setRole(actor(bob), s.id, alice.id, { role: 'member' }), 'forbidden');
  const bobView = await svc.get(s.id, bob.id);
  assert.equal(bobView.my_role, 'member');
  assert.deepEqual(bobView.invites, [], 'member 看不到邀请');
  assert.deepEqual(bobView.members.map((m) => [m.email, m.role]), [['owner@example.com', 'owner'], ['alice@example.com', 'admin'], ['bob@example.com', 'member']]);
  // admin
  const inv = await svc.invite(actor(alice), s.id, { role: 'member' });
  assert.equal((await svc.get(s.id, alice.id)).invites.length, 1);
  await svc.revokeInvite(actor(alice), s.id, inv.id);
  await rejects(svc.revokeInvite(actor(alice), s.id, inv.id + 'x'), 'not_found');
  await rejects(svc.removeMember(actor(alice), s.id, owner.id), 'forbidden', /所有者/);
  await rejects(svc.setRole(actor(alice), s.id, bob.id, { role: 'admin' }), 'forbidden', /owner/);
  await join(carol, 'admin');
  await rejects(svc.removeMember(actor(alice), s.id, carol.id), 'forbidden', /只能移除普通成员/);
  await svc.removeMember(actor(alice), s.id, bob.id);
  await rejects(svc.removeMember(actor(alice), s.id, bob.id), 'not_found');
  assert.deepEqual((await svc.mine(bob.id)).items, []);
  // owner
  await rejects(svc.setRole(actor(owner), s.id, owner.id, { role: 'member' }), 'forbidden', /所有者/);
  assert.equal((await svc.setRole(actor(owner), s.id, carol.id, { role: 'member' })).role, 'member');
  await assert.rejects(svc.setRole(actor(owner), s.id, carol.id, { role: 'owner' } as unknown), (e: unknown) => (e as Error).name === 'ZodError');
  await rejects(svc.removeMember(actor(owner), s.id, owner.id), 'forbidden', /所有者/);
  // 退出 + 被移除者重新接受邀请回到 active
  await svc.removeMember(actor(carol), s.id, carol.id);
  const back = await svc.accept(actor(carol), { code: (await svc.invite(actor(owner), s.id, { role: 'member' })).code });
  assert.equal(back.member.status, 'active');
  await svc.removeMember(actor(owner), s.id, alice.id);
  // 停用
  await svc.adminSetStatus(s.id, { status: 'suspended' });
  await rejects(svc.invite(actor(owner), s.id, {}), 'studio_suspended');
  await rejects(svc.setRole(actor(owner), s.id, carol.id, { role: 'admin' }), 'studio_suspended');
  assert.equal((await svc.get(s.id, owner.id)).status, 'suspended', '仍可查看');
  await rejects(svc.adminGet('00000000-0000-4000-8000-000000000000'), 'not_found');
  const list = await svc.adminList();
  assert.equal(list.length, 1);
  assert.equal(list[0].owner_email, 'owner@example.com');
  assert.equal(list[0].seats.used, 2);
  assert.equal((await svc.adminGet(s.id)).members.length, 4, '后台能看到已移除成员');
});

test('seatUsage / generateInviteCode 纯函数', () => {
  const studio = { id: 's', name: 'n', ownerId: 'o', seatLimit: 2, status: 'active' as const, createdAt: T0, updatedAt: T0 };
  const m = (status: 'active' | 'removed' | 'invited') => ({ id: 'm', studioId: 's', accountId: 'a', role: 'member' as const, status, joinedAt: null, removedAt: null, createdAt: T0, updatedAt: T0 });
  const i = (over: Partial<{ usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }>) => ({ id: 'i', studioId: 's', code: 'C', email: null, role: 'member' as const, createdBy: null, expiresAt: at(DAY), usedAt: null, usedById: null, revokedAt: null, createdAt: T0, ...over });
  assert.deepEqual(seatUsage(studio, [m('active'), m('active'), m('removed'), m('invited')], [i({}), i({ usedAt: T0 }), i({ revokedAt: T0 }), i({ expiresAt: at(-1) })], T0), { limit: 2, used: 2, pending: 1, available: 0 });
  assert.deepEqual(seatUsage({ ...studio, seatLimit: 5 }, [m('active')], [i({})], T0), { limit: 5, used: 1, pending: 1, available: 3 });
  assert.equal(generateInviteCode(Buffer.from([0, 1, 31, 32, 255])), 'AB9A9');
  assert.equal(generateInviteCode().length, 10);
});

// ---------------------------------------------------------------------------
// HTTP：用户令牌、后台只读 / 运营、审计
// ---------------------------------------------------------------------------
test('HTTP：用户接口凭访问令牌，席位超限 403 seat_limit；后台只读不能调席位、运营可以且进审计', async () => {
  const repos = await makeRepos();
  const config = cfg(1);
  const ADMIN = { email: 'root@example.com', password: 'test-root-pass-123' };
  await repos.accounts.create({ email: ADMIN.email, passwordHash: await bcrypt.hash(ADMIN.password, 4), role: 'ADMIN', plan: 'test' });
  const app = await NestFactory.create(createAppModule({ repos, config }), { logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const call = async (p: string, o: { token?: string; body?: unknown; method?: string } = {}) => {
    const res = await fetch(base + p, {
      method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  };
  try {
    const tokens = new TokenService(repos, config);
    const auth = new AuthService(repos, tokens, undefined, 4);
    const u1 = await auth.activate({ inviteCode: (await auth.createInvite(null)).code, email: 'u1@example.com', password: 'password1' });
    const u2 = await auth.activate({ inviteCode: (await auth.createInvite(null)).code, email: 'u2@example.com', password: 'password1' });
    assert.equal((await call('/studios/mine')).status, 401);
    const created = await call('/studios', { token: u1.accessToken, body: { name: '工作室 H' } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.seats.limit, 1);
    const sid = created.json.id as string;
    const mine = await call('/studios/mine', { token: u1.accessToken });
    assert.equal(mine.json.items[0].my_role, 'owner');
    const full = await call(`/studios/${sid}/invites`, { token: u1.accessToken, body: {} });
    assert.equal(full.status, 403);
    assert.equal(full.json.error, 'seat_limit');
    assert.equal((await call(`/studios/${sid}`, { token: u2.accessToken })).status, 403, '非成员');
    assert.equal((await call('/studios', { token: u1.accessToken, body: { name: '' } })).status, 400);

    const rootLogin = await call('/admin/auth/login', { body: ADMIN });
    const root = rootLogin.json.token as string;
    const mk = async (email: string, role: string) => {
      assert.equal((await call('/admin/admins', { token: root, body: { email, role, password: 'another-test-pass-1' } })).status, 201);
      return (await call('/admin/auth/login', { body: { email, password: 'another-test-pass-1' } })).json.token as string;
    };
    const ro = await mk('ro@example.com', 'READONLY');
    const op = await mk('op@example.com', 'OPERATOR');
    assert.equal((await call('/admin/studios')).status, 401);
    const list = await call('/admin/studios', { token: ro });
    assert.equal(list.status, 200);
    assert.equal(list.json[0].owner_email, 'u1@example.com');
    assert.equal((await call(`/admin/studios/${sid}/seats`, { token: ro, method: 'PUT', body: { seatLimit: 3 } })).status, 403);
    const seats = await call(`/admin/studios/${sid}/seats`, { token: op, method: 'PUT', body: { seatLimit: 3 } });
    assert.equal(seats.status, 200, JSON.stringify(seats.json));
    assert.equal(seats.json.seats.limit, 3);
    assert.equal((await call(`/admin/studios/${sid}/seats`, { token: op, method: 'PUT', body: { seatLimit: -1 } })).status, 400);
    assert.equal((await call(`/admin/studios/${sid}/status`, { token: op, method: 'PUT', body: { status: 'nope' } })).status, 400);
    // 加了席位后可以邀请并接受；接受后 u2 能看详情，member 看不到邀请列表
    const inv = await call(`/studios/${sid}/invites`, { token: u1.accessToken, body: { email: 'u2@example.com', role: 'admin' } });
    assert.equal(inv.status, 201, JSON.stringify(inv.json));
    const acc = await call('/studios/accept', { token: u2.accessToken, body: { code: inv.json.code } });
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    const detail = await call(`/studios/${sid}`, { token: u2.accessToken });
    assert.equal(detail.json.my_role, 'admin');
    assert.equal(detail.json.members.length, 2);
    const role = await call(`/studios/${sid}/members/${u2.account.id}/role`, { token: u1.accessToken, method: 'PUT', body: { role: 'member' } });
    assert.equal(role.status, 200);
    assert.equal(role.json.role, 'member');
    assert.equal((await call(`/studios/${sid}/members/${u2.account.id}`, { token: u2.accessToken, method: 'DELETE' })).status, 204);
    assert.equal((await call(`/admin/studios/${sid}`, { token: ro })).json.members.length, 2, '后台含已移除');
    const audit = await call('/admin/audit?targetType=studios', { token: root });
    assert.equal(audit.status, 200);
    const actions = (audit.json as { action: string; actorEmail: string | null; ok: boolean }[]).map((a) => a.action);
    assert.ok(actions.includes('PUT /admin/studios/:id/seats'), actions.join(','));
    assert.ok(actions.includes('POST /studios'));
    assert.ok(actions.includes('DELETE /studios/:id/members/:accountId'));
  } finally {
    await app.close();
  }
});
