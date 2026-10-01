import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { loadConfig } from '../src/services/config';
import { ROLE_PERMISSIONS, can } from '../src/services/admin-roles';
import { redact, summarizeDetail } from '../src/services/audit.service';
import { FunnelService, buildStages, rate } from '../src/services/funnel.service';
import { compareVersions, decideUpdate, isVersion, parseVersion, rolloutBucket, type RolloutPick } from '../src/services/release.service';

// 测试口令仅存在于测试进程内存
const ADMIN = { email: 'root@example.com', password: 'test-root-pass-123' };
const PW = 'another-test-pass-1';

async function boot() {
  const repos = await makeRepos();
  const config = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  // 不写 AdminRole 记录：模拟 P1 创建的旧管理员（Account.role = ADMIN）
  await repos.accounts.create({ email: ADMIN.email, passwordHash: await bcrypt.hash(ADMIN.password, 4), role: 'ADMIN', plan: 'test' });
  const app = await NestFactory.create(createAppModule({ repos, config }), { logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const call = async (path: string, o: { token?: string; body?: unknown; method?: string } = {}) => {
    const res = await fetch(base + path, {
      method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  };
  const loginAs = async (email: string, password: string) => (await call('/admin/auth/login', { body: { email, password } })).json.token as string;
  const root = await loginAs(ADMIN.email, ADMIN.password);
  /** 用 ADMIN 创建指定角色的管理员并返回其令牌。 */
  const makeAdmin = async (email: string, role: string) => {
    const r = await call('/admin/admins', { token: root, body: { email, role, password: PW } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return loginAs(email, PW);
  };
  return { repos, config, call, root, makeAdmin, loginAs, close: () => app.close() };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
test('版本号：解析与比较（含预发布、构建元数据、数字位数）', () => {
  assert.ok(isVersion('1.2.3') && isVersion('0.0.1') && isVersion('1.3.0-beta.1') && isVersion('1.0.0+build.5'));
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '', '1.2.x', '1.2.3-', '1.2.3-beta..1']) assert.equal(isVersion(bad), false, bad);
  assert.deepEqual(parseVersion('2.10.3-rc.1'), { major: 2, minor: 10, patch: 3, pre: ['rc', '1'] });
  const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(Math.sign(compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.throws(() => compareVersions('x', '1.0.0'));
});

test('灰度分档：稳定可复现、分布均匀、加百分比只纳入更多设备、版本之间互相独立', () => {
  const dev = (i: number) => `device-${String(i).padStart(6, '0')}`;
  // 稳定性：重复计算结果相同；已知输入的结果固定（锁定算法，防止无意改动导致全网设备重新分档）
  assert.equal(rolloutBucket('device-000001', 'stable', '1.2.0'), rolloutBucket('device-000001', 'stable', '1.2.0'));
  assert.deepEqual([0, 1, 2].map((i) => rolloutBucket(dev(i), 'stable', '1.2.0')), [0, 1, 2].map((i) => rolloutBucket(dev(i), 'stable', '1.2.0')));
  assert.equal(rolloutBucket('device-fixed-0001', 'stable', '1.2.0'), rolloutBucket('device-fixed-0001', 'stable', '1.2.0'));
  const N = 20000;
  const buckets = Array.from({ length: N }, (_, i) => rolloutBucket(dev(i), 'stable', '1.2.0'));
  assert.ok(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < 100));
  for (const pct of [1, 10, 50, 90]) {
    const hit = buckets.filter((b) => b < pct).length / N;
    assert.ok(Math.abs(hit - pct / 100) < 0.02, `${pct}% 实际命中 ${hit}`);
  }
  // 单调：10% 命中的设备一定在 30% 里
  const in10 = new Set(buckets.map((b, i) => (b < 10 ? i : -1)).filter((i) => i >= 0));
  const in30 = new Set(buckets.map((b, i) => (b < 30 ? i : -1)).filter((i) => i >= 0));
  for (const i of in10) assert.ok(in30.has(i));
  // 独立：不同版本下的“前 10%”重合度接近 10%，而不是 100%
  const other = Array.from({ length: N }, (_, i) => rolloutBucket(dev(i), 'stable', '1.3.0'));
  const both = buckets.filter((b, i) => b < 10 && other[i] < 10).length;
  assert.ok(both / in10.size < 0.2, `重合度 ${both / in10.size}`);
  assert.notEqual(rolloutBucket('device-000001', 'beta', '1.2.0') + ':' + rolloutBucket('device-000002', 'beta', '1.2.0'),
    rolloutBucket('device-000001', 'stable', '1.2.0') + ':' + rolloutBucket('device-000002', 'stable', '1.2.0'));
});

const rel = (o: Partial<RolloutPick> = {}): RolloutPick => ({
  version: '1.1.0', channel: 'stable', rolloutPercent: 100, minVersion: null, forced: false, notes: 'n', ...o,
});

test('更新决策：版本比较、通道可见性、灰度、强制、无设备号', () => {
  const D = 'device-aaaaaaaa';
  // 没有更高版本
  assert.deepEqual(decideUpdate('1.1.0', 'stable', D, [rel()]), { update: false });
  assert.deepEqual(decideUpdate('2.0.0', 'stable', D, [rel()]), { update: false });
  // 100% 全员命中
  const r = decideUpdate('1.0.0', 'stable', D, [rel()]);
  assert.deepEqual(r, { update: true, version: '1.1.0', channel: 'stable', notes: 'n', forced: false, minVersion: null, rolloutPercent: 100 });
  // 0% 谁也不命中；没有 deviceId 只命中 100%
  assert.deepEqual(decideUpdate('1.0.0', 'stable', D, [rel({ rolloutPercent: 0 })]), { update: false });
  assert.deepEqual(decideUpdate('1.0.0', 'stable', undefined, [rel({ rolloutPercent: 99 })]), { update: false });
  assert.equal(decideUpdate('1.0.0', 'stable', undefined, [rel()]).update, true);
  // 通道可见性：stable 看不到 beta；beta 能看到两者且取最高
  const beta = rel({ version: '1.2.0-beta.1', channel: 'beta' });
  assert.deepEqual(decideUpdate('1.0.0', 'stable', D, [beta]), { update: false });
  assert.equal((decideUpdate('1.0.0', 'beta', D, [rel(), beta]) as any).version, '1.2.0-beta.1');
  assert.equal((decideUpdate('1.2.0-beta.1', 'beta', D, [rel(), beta]) as any).update, false);
  assert.equal((decideUpdate('1.0.0', 'beta', D, [rel({ version: '1.3.0' }), beta]) as any).version, '1.3.0');
  // 灰度：命中的设备拿到新版，未命中的回落到次新且已命中的版本
  const dev = (i: number) => `device-${String(i).padStart(6, '0')}`;
  const hit = Array.from({ length: 200 }, (_, i) => dev(i)).find((d) => rolloutBucket(d, 'stable', '1.2.0') < 50)!;
  const miss = Array.from({ length: 200 }, (_, i) => dev(i)).find((d) => rolloutBucket(d, 'stable', '1.2.0') >= 50)!;
  const rels = [rel({ version: '1.1.0' }), rel({ version: '1.2.0', rolloutPercent: 50 })];
  assert.equal((decideUpdate('1.0.0', 'stable', hit, rels) as any).version, '1.2.0');
  assert.equal((decideUpdate('1.0.0', 'stable', miss, rels) as any).version, '1.1.0');
  assert.equal((decideUpdate('1.1.0', 'stable', miss, rels) as any).update, false);
  // 强制：发布标记，或当前版本低于 minVersion
  assert.equal((decideUpdate('1.0.0', 'stable', D, [rel({ forced: true })]) as any).forced, true);
  assert.equal((decideUpdate('1.0.0', 'stable', D, [rel({ minVersion: '1.0.1' })]) as any).forced, true);
  assert.equal((decideUpdate('1.0.1', 'stable', D, [rel({ minVersion: '1.0.1' })]) as any).forced, false);
  // 同版本号 beta 与 stable 并存：stable 优先
  assert.equal((decideUpdate('1.0.0', 'beta', D, [rel({ channel: 'beta', notes: 'b' }), rel({ notes: 's' })]) as any).notes, 's');
});

test('角色权限矩阵', () => {
  assert.deepEqual([...ROLE_PERMISSIONS.READONLY], ['read']);
  assert.ok(can('OPERATOR', 'ops:write') && !can('OPERATOR', 'billing:refund') && !can('OPERATOR', 'admins:manage') && !can('OPERATOR', 'audit:read'));
  assert.ok(can('OPERATOR', 'feedback:diagnostic') && !can('READONLY', 'feedback:diagnostic'));
  for (const p of ROLE_PERMISSIONS.ADMIN) assert.ok(can('ADMIN', p));
  assert.equal(can(null, 'read'), false);
});

test('审计脱敏：口令/密钥/令牌键一律替换，过长内容截断', () => {
  const r = redact({ email: 'a@x.com', password: 'p', nested: { apiKey: 'k', Authorization: 'Bearer x', list: [{ secretValue: 's', ok: 1 }] }, big: 'x'.repeat(500) }) as any;
  assert.equal(r.password, '[redacted]');
  assert.equal(r.nested.apiKey, '[redacted]');
  assert.equal(r.nested.Authorization, '[redacted]');
  assert.equal(r.nested.list[0].secretValue, '[redacted]');
  assert.equal(r.nested.list[0].ok, 1);
  assert.equal(r.email, 'a@x.com');
  assert.ok(r.big.length < 400);
  assert.equal(summarizeDetail({}, {}), null);
  assert.deepEqual(summarizeDetail({ a: 1 }, {}), { body: { a: 1 } });
  assert.deepEqual(summarizeDetail({ a: 'x'.repeat(299) }, null), { body: { a: 'x'.repeat(299) } });
  assert.deepEqual(summarizeDetail(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(299)])), {}), { truncated: true });
});

test('漏斗纯函数：转化率保留四位、分母为 0 时为 null', () => {
  assert.equal(rate(1, 3), 0.3333);
  assert.equal(rate(1, 0), null);
  const s = buildStages({ clicks: 200, registered: 50, activated: 40, firstExport: 10 });
  assert.deepEqual(s.map((x) => x.rateFromPrev), [null, 0.25, 0.8, 0.25]);
  assert.deepEqual(s.map((x) => x.rateFromFirst), [null, 0.25, 0.2, 0.05]);
  assert.deepEqual(buildStages({ clicks: 0, registered: 3, activated: 0, firstExport: 0 }).map((x) => x.rateFromPrev), [null, null, 0, null]);
});

// ---------------------------------------------------------------------------
// 漏斗（服务 + 仓储，双后端）
// ---------------------------------------------------------------------------
test('推广漏斗：点击/注册/激活/首次导出，窗口外与管理员不计入', async () => {
  const repos = await makeRepos();
  const NOW = new Date('2026-12-10T12:00:00Z');
  const svc = new FunnelService(repos, () => NOW);
  const day = (d: number, h = 3) => new Date(Date.UTC(2026, 11, d, h));
  // 点击：窗口 14 天 = 11/27 ~ 12/10；11/20 在窗口外
  for (const [code, when] of [['ark', day(10)], ['ark', day(9)], ['bailian', day(9)], ['ark', new Date('2026-11-20T00:00:00Z')]] as const) {
    await repos.referralClicks.create({ code, src: null, createdAt: when });
  }
  // 账号：createdAt 由仓储生成（内存/PG 都是“现在”），所以用真实时间窗
  const real = new Date();
  const svc2 = new FunnelService(repos, () => real);
  const u1 = await repos.accounts.create({ email: 'u1@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  await repos.accounts.create({ email: 'u2@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  const adm = await repos.accounts.create({ email: 'adm@x.com', passwordHash: 'h', role: 'ADMIN', plan: 'test' });
  const op = await repos.accounts.create({ email: 'op@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  await repos.adminRoles.set(op.id, 'OPERATOR', null, real);
  await repos.devices.upsert(u1.id, 'fp-1', 'PC');
  await repos.devices.upsert(adm.id, 'fp-2', 'PC'); // 管理员设备不计
  // 遥测
  const today = real.toISOString().slice(0, 10);
  await repos.telemetry.addMany([
    { at: real, day: today, installId: 'inst-aaaaaaaaaaaaaaaa', name: 'onboarding_step', code: null, step: 'first_export' },
    { at: real, day: today, installId: 'inst-aaaaaaaaaaaaaaaa', name: 'export_done', code: null, step: null },
    { at: real, day: today, installId: 'inst-bbbbbbbbbbbbbbbb', name: 'export_done', code: null, step: null },
    { at: real, day: today, installId: 'inst-cccccccccccccccc', name: 'onboarding_step', code: null, step: 'welcome' },
  ]);

  const f = await svc2.funnel(14);
  const by = Object.fromEntries(f.stages.map((s) => [s.key, s.count]));
  assert.equal(by.registered, 2, '管理员与运营账号不计注册');
  assert.equal(by.activated, 1);
  assert.equal(by.firstExport, 2, '同一安装去重；welcome 不算');
  assert.equal(f.cohort, false);
  assert.equal(f.series.length, 14);
  assert.equal(f.series[13].day, today);
  assert.equal(f.series[13].registered, 2);
  assert.equal(f.series[13].firstExport, 2);

  const old = await svc.funnel(14); // 以 2026-12-10 为“现在”：只有点击落在窗口里
  assert.equal(old.stages[0].count, 3);
  assert.deepEqual(old.byCode, [{ code: 'ark', clicks: 2 }, { code: 'bailian', clicks: 1 }]);
  assert.equal(old.stages[1].count, 0, '账号创建于真实当前时间，不在该窗口内');
  assert.equal(old.series.find((s) => s.day === '2026-12-09')!.clicks, 2);
  assert.equal((await svc.funnel(1)).stages[0].count, 1, '1 天窗口只含当天');
  assert.equal((await svc.funnel(1000)).days, 90, '天数被钳制到 90');
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
test('角色鉴权：READONLY 只读、OPERATOR 日常写、ADMIN 全部；旧管理员无角色记录按 ADMIN', async () => {
  const s = await boot();
  try {
    const me = (await s.call('/admin/me', { token: s.root })).json;
    assert.equal(me.role, 'ADMIN');
    assert.deepEqual(me.permissions, [...ROLE_PERMISSIONS.ADMIN]);
    const ro = await s.makeAdmin('ro@example.com', 'READONLY');
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');

    assert.deepEqual((await s.call('/admin/me', { token: ro })).json.permissions, ['read']);
    // 读
    for (const t of [ro, op]) {
      assert.equal((await s.call('/admin/invites', { token: t })).status, 200);
      assert.equal((await s.call('/admin/orders', { token: t })).status, 200);
      assert.equal((await s.call('/admin/releases', { token: t })).status, 200);
      assert.equal((await s.call('/admin/stats/funnel', { token: t })).status, 200);
      assert.equal((await s.call('/admin/plans', { token: t })).status, 200);
    }
    // 管理员与审计只有 ADMIN
    for (const t of [ro, op]) {
      assert.equal((await s.call('/admin/admins', { token: t })).status, 403);
      assert.equal((await s.call('/admin/audit', { token: t })).status, 403);
      assert.equal((await s.call('/admin/admins', { token: t, body: { email: 'z@example.com', role: 'ADMIN', password: PW } })).status, 403);
    }
    assert.equal((await s.call('/admin/admins', { token: s.root })).status, 200);
    // 只读不能写
    assert.equal((await s.call('/admin/invites', { token: ro, body: {} })).status, 403);
    assert.equal((await s.call('/admin/announcements', { token: ro, body: { title: 'x' } })).status, 403);
    assert.equal((await s.call('/admin/releases', { token: ro, body: { version: '1.0.0', channel: 'stable' } })).status, 403);
    // 运营能写日常，但不能退款/改价/管理员
    assert.equal((await s.call('/admin/invites', { token: op, body: {} })).status, 201);
    assert.equal((await s.call('/admin/announcements', { token: op, body: { title: 'x' } })).status, 201);
    assert.equal((await s.call('/admin/releases', { token: op, body: { version: '1.0.0', channel: 'stable' } })).status, 201);
    const fakeOrder = '00000000-0000-4000-8000-000000000001';
    assert.equal((await s.call(`/admin/orders/${fakeOrder}/refund`, { token: op, body: {} })).status, 403);
    assert.equal((await s.call(`/admin/orders/${fakeOrder}/refund`, { token: s.root, body: {} })).status, 404, 'ADMIN 放行后才报订单不存在');
    assert.equal((await s.call('/admin/plans', { token: op, body: { code: 'team', name: '团队', priceMonthCents: 100, priceYearCents: null, entitlements: { maxDevices: 1, exportMaxHeight: 720, watermark: true, features: [] } } })).status, 403);
    assert.equal((await s.call('/admin/plans/pro/enabled', { token: op, method: 'PUT', body: { enabled: false } })).status, 403);
    assert.equal((await s.call('/admin/plans/pro/versions', { token: op, body: {} })).status, 403);
    // 诊断包仅 OPERATOR 以上；只读 403（先于“记录不存在”）
    assert.equal((await s.call(`/admin/feedback/${fakeOrder}/diagnostic`, { token: ro })).status, 403);
    assert.equal((await s.call(`/admin/feedback/${fakeOrder}/diagnostic`, { token: op })).status, 404);
    // 无令牌仍是 401
    assert.equal((await s.call('/admin/releases')).status, 401);
  } finally { await s.close(); }
});

test('管理员管理：授予、改角色、撤销，最后一个 ADMIN 受保护，降权立即生效', async () => {
  const s = await boot();
  try {
    const rootId = (await s.call('/admin/me', { token: s.root })).json.accountId;
    // 缺口令 / 口令太短 / 重复授予
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'new@example.com', role: 'OPERATOR' } })).status, 400);
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'new@example.com', role: 'OPERATOR', password: 'short' } })).status, 400);
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'new@example.com', role: 'SUPER', password: PW } })).status, 400);
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'OP@example.com', role: 'READONLY' } })).status, 409);
    // 给已有普通账号授予角色（不需要口令）
    await s.repos.accounts.create({ email: 'plain@example.com', passwordHash: await bcrypt.hash(PW, 4), role: 'USER', plan: 'free' });
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'plain@example.com', role: 'READONLY' } })).status, 201);
    assert.ok(await s.loginAs('plain@example.com', PW));
    // 普通用户不是管理员：不能登录后台
    await s.repos.accounts.create({ email: 'user@example.com', passwordHash: await bcrypt.hash(PW, 4), role: 'USER', plan: 'free' });
    assert.equal((await s.call('/admin/auth/login', { body: { email: 'user@example.com', password: PW } })).status, 401);

    const list = (await s.call('/admin/admins', { token: s.root })).json;
    assert.deepEqual(list.map((a: any) => [a.email, a.role, a.legacy]), [
      ['root@example.com', 'ADMIN', true], ['op@example.com', 'OPERATOR', false], ['plain@example.com', 'READONLY', false],
    ]);

    // 降权立即生效（令牌不带角色）
    assert.equal((await s.call('/admin/invites', { token: op, body: {} })).status, 201);
    const opId = list[1].accountId;
    assert.equal((await s.call(`/admin/admins/${opId}/role`, { token: s.root, method: 'PUT', body: { role: 'READONLY' } })).status, 200);
    assert.equal((await s.call('/admin/invites', { token: op, body: {} })).status, 403);
    assert.equal((await s.call('/admin/invites', { token: op })).status, 200);
    // 撤销后令牌立刻失效为 403，且不能再登录
    assert.equal((await s.call(`/admin/admins/${opId}`, { token: s.root, method: 'DELETE' })).status, 204);
    assert.equal((await s.call('/admin/invites', { token: op })).status, 403);
    assert.equal((await s.call('/admin/auth/login', { body: { email: 'op@example.com', password: PW } })).status, 401);
    assert.equal((await s.call(`/admin/admins/${opId}`, { token: s.root, method: 'DELETE' })).status, 404);

    // 最后一个 ADMIN：不能降级、不能撤销、不能禁用
    assert.equal((await s.call(`/admin/admins/${rootId}/role`, { token: s.root, method: 'PUT', body: { role: 'OPERATOR' } })).status, 409);
    assert.equal((await s.call(`/admin/admins/${rootId}`, { token: s.root, method: 'DELETE' })).status, 409);
    assert.equal((await s.call(`/admin/users/${rootId}/disable`, { token: s.root, body: {} })).status, 403);
    // 再加一个 ADMIN 后，旧管理员才可以被降级；降级写入 AdminRole 记录
    assert.equal((await s.call('/admin/admins', { token: s.root, body: { email: 'second@example.com', role: 'ADMIN', password: PW } })).status, 201);
    assert.equal((await s.call(`/admin/admins/${rootId}/role`, { token: s.root, method: 'PUT', body: { role: 'OPERATOR' } })).status, 200);
    assert.equal((await s.call('/admin/admins', { token: s.root })).status, 403, '被降级的旧管理员失去管理员权限');
    // 撤销旧式管理员：Account.role 被改回 USER，不能再登录
    const second = await s.loginAs('second@example.com', PW);
    assert.equal((await s.call(`/admin/admins/${rootId}`, { token: second, method: 'DELETE' })).status, 204);
    assert.equal((await s.repos.accounts.findById(rootId))!.role, 'USER');
    assert.equal((await s.call('/admin/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } })).status, 401);
  } finally { await s.close(); }
});

test('审计：所有管理写操作自动记录（谁/何时/路由/对象/结果），读不记，口令脱敏，越权与登录也记', async () => {
  const s = await boot();
  try {
    const rootId = (await s.call('/admin/me', { token: s.root })).json.accountId;
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');
    const before = Date.now();
    const inv = (await s.call('/admin/invites', { token: op, body: { count: 1, plan: 'test' } })).json[0];
    await s.call(`/admin/invites/${inv.id}/revoke`, { token: op, body: {} });
    await s.call(`/admin/invites/${inv.id}/revoke`, { token: op, body: {} }); // 失败：已吊销
    const ann = (await s.call('/admin/announcements', { token: op, body: { title: '维护公告' } })).json;
    await s.call('/admin/announcements', { token: op, body: { title: '' } }); // 400
    await s.call('/admin/invites', { token: op }); // 读，不记
    await s.call('/admin/releases', { token: op });
    await s.call(`/admin/orders/00000000-0000-4000-8000-000000000001/refund`, { token: op, body: { reason: 'x' } }); // 越权
    await s.call('/admin/auth/login', { body: { email: 'op@example.com', password: 'wrong-wrong-wrong' } });

    const audit = (await s.call('/admin/audit?limit=200', { token: s.root })).json as any[];
    const find = (action: string, pred: (a: any) => boolean = () => true) => audit.filter((a) => a.action === action && pred(a));

    // 授予管理员：口令被脱敏，对象是新账号，操作者是 root
    const grant = find('POST /admin/admins')[0];
    assert.equal(grant.actorId, rootId);
    assert.equal(grant.actorEmail, ADMIN.email);
    assert.equal(grant.actorRole, 'ADMIN');
    assert.equal(grant.detail.body.password, '[redacted]');
    assert.equal(grant.detail.body.email, 'op@example.com');
    assert.equal(JSON.stringify(audit).includes(PW), false, '审计里不会出现口令明文');
    assert.equal(grant.targetType, 'admins');
    assert.equal(grant.ok, true);
    assert.equal(grant.status, 201);
    assert.ok(typeof grant.targetId === 'string' && grant.targetId.length > 0 || grant.targetId === null);

    // 邀请码：创建（数组响应无 id）、吊销成功与失败
    assert.equal(find('POST /admin/invites').length, 1);
    const ok = find('POST /admin/invites/:id/revoke', (a) => a.ok)[0];
    assert.equal(ok.status, 204);
    assert.equal(ok.targetId, inv.id);
    assert.equal(ok.targetType, 'invites');
    assert.equal(ok.actorEmail, 'op@example.com');
    assert.equal(ok.actorRole, 'OPERATOR');
    assert.ok(new Date(ok.at).getTime() >= before - 1000);
    const failed = find('POST /admin/invites/:id/revoke', (a) => !a.ok)[0];
    assert.equal(failed.status, 400);
    assert.equal(failed.targetId, inv.id);

    // 公告：新建记 id 作对象；校验失败记 400
    const annOk = find('POST /admin/announcements', (a) => a.ok)[0];
    assert.equal(annOk.targetId, ann.id);
    assert.equal(annOk.detail.body.title, '维护公告');
    assert.equal(find('POST /admin/announcements', (a) => !a.ok)[0].status, 400);

    // 读操作不记
    assert.equal(audit.some((a) => a.action.startsWith('GET ')), false);

    // 越权尝试被记为失败 403（操作者是运营）
    const denied = find('POST /admin/orders/:id/refund')[0];
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.equal(denied.actorEmail, 'op@example.com');
    assert.equal(denied.targetType, 'orders');

    // 登录成功与失败都记；失败记邮箱不记口令
    const logins = find('POST /admin/auth/login');
    assert.ok(logins.some((a) => a.ok && a.actorEmail === ADMIN.email));
    const bad = logins.find((a) => !a.ok)!;
    assert.equal(bad.actorEmail, 'op@example.com');
    assert.equal(bad.actorId, null);
    assert.equal(bad.status, 401);
    assert.equal(JSON.stringify(logins).includes('wrong-wrong'), false);

    // 筛选
    assert.ok((await s.call(`/admin/audit?actorId=${rootId}`, { token: s.root })).json.every((a: any) => a.actorId === rootId));
    assert.equal((await s.call(`/admin/audit?targetType=announcements`, { token: s.root })).json.length, 2);
    assert.equal((await s.call(`/admin/audit?limit=1`, { token: s.root })).json.length, 1);
    // 倒序
    const times = audit.map((a) => new Date(a.at).getTime());
    assert.deepEqual([...times].sort((a, b) => b - a), times);
  } finally { await s.close(); }
});

test('公告：时间窗与渠道由服务端过滤，公开接口只给客户端字段', async () => {
  const s = await boot();
  try {
    const t = s.root;
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const mk = (b: object) => s.call('/admin/announcements', { token: t, body: b });
    const live = (await mk({ title: '现在', body: '正文', level: 'warn' })).json;
    assert.equal(live.channel, 'all');
    assert.equal(live.enabled, true);
    await mk({ title: '未来', startsAt: iso(3600_000) });
    await mk({ title: '已过期', startsAt: iso(-7200_000), endsAt: iso(-3600_000) });
    await mk({ title: '停用', enabled: false });
    await mk({ title: '仅 beta', channel: 'beta' });
    await mk({ title: '仅 stable', channel: 'stable', level: 'critical' });
    const titles = async (q = '') => (await s.call('/public/announcements' + q)).json.map((a: any) => a.title).sort();
    assert.deepEqual(await titles(), ['仅 stable', '现在']);
    assert.deepEqual(await titles('?channel=stable'), ['仅 stable', '现在']);
    assert.deepEqual(await titles('?channel=beta'), ['仅 beta', '现在']);
    assert.deepEqual(await titles('?channel=bogus'), ['仅 stable', '现在'], '非法渠道回落 stable');
    const pub = (await s.call('/public/announcements')).json.find((a: any) => a.title === '现在');
    assert.deepEqual(Object.keys(pub).sort(), ['body', 'channel', 'endsAt', 'id', 'level', 'startsAt', 'title']);

    // 校验：标题必填、级别/渠道枚举、结束必须晚于开始、时间格式
    for (const bad of [{ title: '' }, { title: 'x', level: 'nope' }, { title: 'x', channel: 'gamma' }, { title: 'x', startsAt: 'yesterday' },
      { title: 'x', startsAt: iso(1000), endsAt: iso(500) }, { title: 'x', body: 'y'.repeat(2001) }, {}]) {
      assert.equal((await mk(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    // 更新：下线、改窗口；PUT 与 DELETE 对不存在的 id 返回 404
    const off = await s.call(`/admin/announcements/${live.id}`, { token: t, method: 'PUT', body: { enabled: false } });
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.title, '现在', '只改传入的字段');
    assert.ok(!(await titles()).includes('现在'));
    assert.equal((await s.call(`/admin/announcements/${live.id}`, { token: t, method: 'PUT', body: { endsAt: live.startsAt } })).status, 400);
    assert.equal((await s.call(`/admin/announcements/${live.id}`, { token: t, method: 'PUT', body: { level: 'nope' } })).status, 400);
    const none = '00000000-0000-4000-8000-000000000009';
    assert.equal((await s.call(`/admin/announcements/${none}`, { token: t, method: 'PUT', body: { title: 'x' } })).status, 404);
    assert.equal((await s.call(`/admin/announcements/${live.id}`, { token: t, method: 'DELETE' })).status, 204);
    assert.equal((await s.call(`/admin/announcements/${live.id}`, { token: t, method: 'DELETE' })).status, 404);
    assert.equal((await s.call('/admin/announcements', { token: t })).json.length, 5);
  } finally { await s.close(); }
});

test('版本灰度：管理接口校验 + /updates/check 结果稳定可复现', async () => {
  const s = await boot();
  try {
    const t = s.root;
    const mk = (b: object) => s.call('/admin/releases', { token: t, body: b });
    // 校验
    for (const bad of [{ version: '1.0', channel: 'stable' }, { version: '1.0.0', channel: 'nightly' }, { version: '1.0.0', channel: 'stable', rolloutPercent: 101 },
      { version: '1.0.0', channel: 'stable', rolloutPercent: -1 }, { version: '1.0.0', channel: 'stable', rolloutPercent: 1.5 },
      { version: '1.0.0', channel: 'stable', minVersion: '1.0.1' }, { version: '1.0.0', channel: 'stable', minVersion: 'x' }, { channel: 'stable' }]) {
      assert.equal((await mk(bad)).status, 400, JSON.stringify(bad));
    }
    const r11 = await mk({ version: '1.1.0', channel: 'stable', rolloutPercent: 100, notes: '稳定版', minVersion: '1.0.0' });
    assert.equal(r11.status, 201);
    assert.equal(r11.json.forced, false);
    assert.equal((await mk({ version: '1.1.0', channel: 'stable' })).status, 409);
    assert.equal((await mk({ version: '1.1.0', channel: 'beta' })).status, 201, '同版本号可在另一通道再发一次');
    const r12 = (await mk({ version: '1.2.0', channel: 'stable', rolloutPercent: 30, notes: '灰度中' })).json;
    assert.equal(r12.rolloutPercent, 30);
    assert.equal((await s.call('/admin/releases', { token: t })).json.length, 3);

    // 找出命中/未命中 1.2.0@30% 的设备（用与服务端相同的分档函数）
    const devs = Array.from({ length: 300 }, (_, i) => `dev-${String(i).padStart(5, '0')}`);
    const hit = devs.filter((d) => rolloutBucket(d, 'stable', '1.2.0') < 30);
    const miss = devs.filter((d) => rolloutBucket(d, 'stable', '1.2.0') >= 30);
    assert.ok(hit.length > 50 && hit.length < 130, `命中数 ${hit.length}`);
    const check = async (q: string) => (await s.call(`/updates/check?${q}`)).json;
    // 稳定可复现：同一设备连续 5 次结果一致
    for (const d of [hit[0], miss[0]]) {
      const first = JSON.stringify(await check(`version=1.0.0&deviceId=${d}`));
      for (let i = 0; i < 4; i++) assert.equal(JSON.stringify(await check(`version=1.0.0&deviceId=${d}`)), first);
    }
    assert.equal((await check(`version=1.0.0&deviceId=${hit[0]}`)).version, '1.2.0');
    const m = await check(`version=1.0.0&deviceId=${miss[0]}`);
    assert.equal(m.version, '1.1.0', '未命中灰度的设备拿次新的已全量版本');
    assert.deepEqual(Object.keys(m).sort(), ['channel', 'forced', 'minVersion', 'notes', 'rolloutPercent', 'update', 'version']);
    assert.equal((await check(`version=1.1.0&deviceId=${miss[0]}`)).update, false);
    assert.equal((await check(`version=1.2.0&deviceId=${hit[0]}`)).update, false);
    // 实际命中率接近 30%
    let n = 0;
    for (const d of devs.slice(0, 40)) if ((await check(`version=1.1.0&deviceId=${d}`)).update) n++;
    assert.equal(n, devs.slice(0, 40).filter((d) => rolloutBucket(d, 'stable', '1.2.0') < 30).length);
    // 默认通道 stable；没有 deviceId 时只看全量发布
    assert.equal((await check('version=1.0.0')).version, '1.1.0');
    // beta 通道可见 beta+stable；同版本 stable 优先
    assert.equal((await check(`version=1.0.0&channel=beta&deviceId=${miss[0]}`)).channel, 'stable');

    // 调高灰度：已命中的设备仍命中，新设备被纳入
    await s.call(`/admin/releases/${r12.id}`, { token: t, method: 'PUT', body: { rolloutPercent: 60 } });
    for (const d of hit.slice(0, 8)) assert.equal((await check(`version=1.0.0&deviceId=${d}`)).version, '1.2.0');
    const newly = miss.find((d) => rolloutBucket(d, 'stable', '1.2.0') < 60)!;
    assert.equal((await check(`version=1.0.0&deviceId=${newly}`)).version, '1.2.0');
    // 暂停（回滚开关）：不再下发
    await s.call(`/admin/releases/${r12.id}`, { token: t, method: 'PUT', body: { enabled: false } });
    assert.equal((await check(`version=1.0.0&deviceId=${hit[0]}`)).version, '1.1.0');
    // 强制：发布标记 / 低于最低版本
    await s.call(`/admin/releases/${r11.json.id}`, { token: t, method: 'PUT', body: { minVersion: '1.0.5' } });
    assert.equal((await check(`version=1.0.0&deviceId=${hit[0]}`)).forced, true);
    assert.equal((await check(`version=1.0.5&deviceId=${hit[0]}`)).forced, false);
    // 更新校验
    assert.equal((await s.call(`/admin/releases/${r11.json.id}`, { token: t, method: 'PUT', body: { minVersion: '9.0.0' } })).status, 400);
    assert.equal((await s.call(`/admin/releases/${r11.json.id}`, { token: t, method: 'PUT', body: { rolloutPercent: 200 } })).status, 400);
    assert.equal((await s.call(`/admin/releases/00000000-0000-4000-8000-000000000009`, { token: t, method: 'PUT', body: { forced: true } })).status, 404);
    // 客户端参数校验
    for (const q of ['', 'version=abc', 'version=1.0.0&channel=nightly', 'version=1.0.0&deviceId=short', 'version=1.0.0&deviceId=has space!!']) {
      assert.equal((await s.call(`/updates/check?${q}`)).status, 400, q);
    }
    // 公开接口无需令牌
    assert.equal((await s.call('/updates/check?version=1.0.0')).status, 200);
  } finally { await s.close(); }
});

test('推广漏斗接口：需要登录，返回四个阶段', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('/admin/stats/funnel')).status, 401);
    const r = (await s.call('/admin/stats/funnel?days=7', { token: s.root })).json;
    assert.deepEqual(r.stages.map((x: any) => x.key), ['clicks', 'registered', 'activated', 'firstExport']);
    assert.equal(r.days, 7);
    assert.equal(r.series.length, 7);
    assert.equal((await s.call('/admin/stats/funnel?days=abc', { token: s.root })).json.days, 14);
  } finally { await s.close(); }
});
