import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { createMemoryRepositories } from '../src/domain/memory.repositories';
import { configureApp } from '../src/http/setup';
import { loadConfig } from '../src/services/config';
import { RateLimiter } from '../src/services/rate-limiter';

// 测试口令仅存在于测试进程内存
const ADMIN = { email: 'ops@example.com', password: 'test-admin-pass-1' };

async function boot(env: Record<string, string> = {}) {
  const repos = createMemoryRepositories();
  const config = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
  await repos.accounts.create({ email: ADMIN.email, passwordHash: await bcrypt.hash(ADMIN.password, 4), role: 'ADMIN', plan: 'test' });
  const app = await NestFactory.create(createAppModule({ repos, config }), { logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  type Opts = { token?: string; body?: unknown; method?: string; raw?: string };
  const call = async (path: string, o: Opts = {}) => {
    const res = await fetch(base + path, {
      method: o.method ?? (o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如 zip 下载） */ }
    return { status: res.status, json, text, res };
  };
  const login = async () => (await call('/admin/auth/login', { body: ADMIN })).json.token as string;
  return { repos, config, call, login, close: () => app.close() };
}

test('管理后台认证：用户令牌、无令牌、非管理员均被拒；管理员可登录', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('/admin/invites')).status, 401);
    const inv = (await s.call('/admin/invites', { token: await s.login(), body: {} })).json[0];
    // 普通用户注册后拿到的访问令牌不能用于 /admin
    const act = await s.call('/auth/activate', { body: { inviteCode: inv.code, email: 'u@x.com', password: 'password1' } });
    assert.equal(act.status, 201);
    assert.equal((await s.call('/admin/invites', { token: act.json.accessToken })).status, 401);
    // 非管理员走管理员登录口
    assert.equal((await s.call('/admin/auth/login', { body: { email: 'u@x.com', password: 'password1' } })).status, 401);
    assert.equal((await s.call('/admin/auth/login', { body: { email: ADMIN.email, password: 'wrong-password' } })).status, 401);
    // 管理员令牌也不能当用户令牌用（不同密钥）
    assert.equal((await s.call('/devices', { token: await s.login() })).status, 401);
    assert.equal((await s.call('/admin/me', { token: await s.login() })).json.email, ADMIN.email);
  } finally { await s.close(); }
});

test('管理员登录有限流', async () => {
  const s = await boot();
  try {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await s.call('/admin/auth/login', { body: { email: ADMIN.email, password: 'bad-password' } })).status;
    assert.equal(last, 429);
  } finally { await s.close(); }
});

test('邀请码：批量创建、列表、吊销；吊销后不可激活；已用不可吊销', async () => {
  const s = await boot();
  try {
    const t = await s.login();
    const created = await s.call('/admin/invites', { token: t, body: { count: 3, plan: 'test', expiresInDays: 7 } });
    assert.equal(created.json.length, 3);
    assert.equal(new Set(created.json.map((i: any) => i.code)).size, 3);
    assert.equal((await s.call('/admin/invites', { token: t, body: { count: 201 } })).status, 400);

    const [a, b] = created.json;
    assert.equal((await s.call(`/admin/invites/${a.id}/revoke`, { token: t, method: 'POST' })).status, 204);
    const revoked = await s.call('/auth/activate', { body: { inviteCode: a.code, email: 'a@x.com', password: 'password1' } });
    assert.equal(revoked.status, 400);
    assert.equal(revoked.json.error, 'invalid_invite');

    assert.equal((await s.call('/auth/activate', { body: { inviteCode: b.code, email: 'b@x.com', password: 'password1' } })).status, 201);
    assert.equal((await s.call(`/admin/invites/${b.id}/revoke`, { token: t, method: 'POST' })).status, 400);
    assert.equal((await s.call('/admin/invites/nope/revoke', { token: t, method: 'POST' })).status, 404);

    const statuses = (await s.call('/admin/invites', { token: t })).json.map((i: any) => i.status).sort();
    assert.deepEqual(statuses, ['revoked', 'unused', 'used']);
    assert.equal((await s.call('/admin/invites?status=used', { token: t })).json.length, 1);
    assert.equal((await s.call('/admin/invites?status=bogus', { token: t })).status, 400);
  } finally { await s.close(); }
});

test('用户：禁用后无法登录/刷新/续期，启用后恢复；管理员不可被禁用；授权视图', async () => {
  const s = await boot();
  try {
    const t = await s.login();
    const inv = (await s.call('/admin/invites', { token: t, body: {} })).json[0];
    const dev = { fingerprint: 'fp-12345678', name: 'PC' };
    const act = (await s.call('/auth/activate', { body: { inviteCode: inv.code, email: 'u@x.com', password: 'password1', device: dev } })).json;
    const id = act.account.id;

    const users = (await s.call('/admin/users', { token: t })).json;
    assert.equal(users.length, 2);
    assert.equal(users.find((u: any) => u.id === id).deviceCount, 1);
    assert.equal(JSON.stringify(users).includes('passwordHash'), false, '不得泄露口令哈希');
    const detail = (await s.call(`/admin/users/${id}`, { token: t })).json;
    assert.deepEqual(detail.licence.entitlements.includes('export'), true);
    assert.equal(detail.licence.graceDays, 14);
    assert.equal(detail.devices[0].name, 'PC');

    assert.equal((await s.call(`/admin/users/${id}/disable`, { token: t, method: 'POST' })).status, 204);
    assert.equal((await s.call('/auth/login', { body: { email: 'u@x.com', password: 'password1' } })).json.error, 'account_disabled');
    assert.equal((await s.call('/auth/refresh', { body: { refreshToken: act.refreshToken } })).status, 401);
    const renew = await s.call('/licence/renew', { token: act.accessToken, method: 'POST' });
    assert.equal(renew.json.error, 'account_disabled');

    assert.equal((await s.call(`/admin/users/${id}/enable`, { token: t, method: 'POST' })).status, 204);
    const again = await s.call('/auth/login', { body: { email: 'u@x.com', password: 'password1', device: dev } });
    assert.equal(again.status, 200);
    assert.equal((await s.call('/licence/renew', { token: again.json.accessToken, method: 'POST' })).status, 200);

    const adminId = users.find((u: any) => u.role === 'ADMIN').id;
    assert.equal((await s.call(`/admin/users/${adminId}/disable`, { token: t, method: 'POST' })).status, 403);
  } finally { await s.close(); }
});

test('公告与模型目录：校验、保存、公开接口只返回启用项', async () => {
  const s = await boot();
  try {
    const t = await s.login();
    assert.equal((await s.call('/public/catalog')).json.length, 0);
    const bad = await s.call('/admin/catalog', { token: t, method: 'PUT', body: [{ id: 'a', kind: 'text', provider: 'bailian', name: 'A', price: -1, unit: '千字', enabled: true }] });
    assert.equal(bad.status, 400);
    const dup = { id: 'a', kind: 'text', provider: 'bailian', name: 'A', price: 1, unit: '千字', enabled: true };
    assert.equal((await s.call('/admin/catalog', { token: t, method: 'PUT', body: [dup, dup] })).status, 400);
    await s.call('/admin/catalog', { token: t, method: 'PUT', body: [dup, { ...dup, id: 'b', enabled: false }] });
    assert.equal((await s.call('/admin/catalog', { token: t })).json.length, 2);
    assert.deepEqual((await s.call('/public/catalog')).json.map((c: any) => c.id), ['a']);

    await s.call('/admin/announcements', { token: t, method: 'PUT', body: [
      { id: '1', title: '维护', body: '今晚维护', level: 'warn', active: true },
      { id: '2', title: '旧', body: '', level: 'info', active: false },
    ] });
    assert.deepEqual((await s.call('/public/announcements')).json.map((a: any) => a.id), ['1']);
    assert.equal((await s.call('/admin/announcements', { token: t, method: 'PUT', body: [{ id: '1', title: 'x', body: '', level: 'nope', active: true }] })).status, 400);
    assert.equal((await s.call('/admin/catalog', { token: 'bad', method: 'PUT', body: [] })).status, 401);
  } finally { await s.close(); }
});

const IID = 'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f60001';

test('统计：只接受白名单字段，提示词/Key 等多余字段整体拒绝且不入库', async () => {
  const s = await boot();
  try {
    const bad = [
      { installId: IID, events: [{ name: 'project_created', prompt: '一个关于猫的故事' }] },
      { installId: IID, events: [{ name: 'task_failed', code: ['sk', 'abcdefghijklmnopqrstuvwx'].join('-') }] }, // 非法码格式
      { installId: IID, email: 'a@b.com', events: [{ name: 'app_open' }] },
      { installId: IID, events: [{ name: 'custom_event' }] },
      { installId: 'short', events: [{ name: 'app_open' }] },
      { installId: IID, events: [] },
      { installId: IID, events: Array.from({ length: 51 }, () => ({ name: 'app_open' })) },
    ];
    for (const b of bad) assert.equal((await s.call('/telemetry', { body: b })).status, 400, JSON.stringify(b).slice(0, 60));
    assert.equal((await s.repos.telemetry.since('0000-00-00')).length, 0);
  } finally { await s.close(); }
});

test('统计：概览聚合 DAU、项目数、导出数、失败码', async () => {
  const s = await boot();
  try {
    const I2 = 'a1b2c3d4-e5f6-4789-a1b2-c3d4e5f60002';
    const send = (installId: string, events: unknown[]) => s.call('/telemetry', { body: { installId, appVersion: '1.2.8', events } });
    assert.equal((await send(IID, [{ name: 'app_open' }, { name: 'project_created' }, { name: 'export_done' },
      { name: 'export_failed', code: 'ENCODER_FAIL' }, { name: 'onboarding_step', step: 'connect_test' }])).status, 202);
    await send(I2, [{ name: 'app_open' }, { name: 'app_open' }, { name: 'export_failed', code: 'ENCODER_FAIL' },
      { name: 'task_failed', code: 'RATE_LIMIT' }, { name: 'connect_test', code: 'OK' }, { name: 'connect_test', code: 'AUTH_401' },
      { name: 'onboarding_step', step: 'connect_test' }]);
    const t = await s.login();
    assert.equal((await s.call('/admin/stats/overview')).status, 401);
    const o = (await s.call('/admin/stats/overview?days=7', { token: t })).json;
    assert.equal(o.series.length, 7);
    const today = o.series[6];
    assert.equal(today.dau, 2);
    assert.equal(today.projects, 1);
    assert.equal(today.exports, 1);
    assert.equal(today.failures, 4); // OK 的连接测试不算失败
    assert.deepEqual(o.failureCodes[0], { event: 'export_failed', code: 'ENCODER_FAIL', count: 2 });
    assert.equal(o.failureCodes.length, 3);
    assert.equal(o.onboarding[0].installs, 2);
    assert.equal(o.totals.accounts, 1);
    assert.equal(JSON.stringify(o).includes(IID), false, '概览不得返回安装标识');
  } finally { await s.close(); }
});

test('统计：接口限流', async () => {
  const s = await boot();
  try {
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await s.call('/telemetry', { body: { installId: IID, events: [{ name: 'app_open' }] } })).status;
    assert.equal(last, 429);
  } finally { await s.close(); }
});

const zipB64 = (n = 100) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(n, 1)]).toString('base64');

test('反馈：保存、脱敏文字、管理员下载诊断包与任务号', async () => {
  const s = await boot();
  try {
    const r = await s.call('/feedback', { body: {
      message: '导出失败 Authorization: Bearer abcdefghijklmnop1234 以及 ' + ['sk', 'abcdefghijklmnopqrstuv'].join('-'),
      taskId: 'task_123', contact: 'me@example.com', appVersion: '1.2.8', diagnostic: zipB64(),
    } });
    assert.equal(r.status, 201);
    const t = await s.login();
    assert.equal((await s.call('/admin/feedback')).status, 401);
    const list = (await s.call('/admin/feedback', { token: t })).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].taskId, 'task_123');
    assert.equal(list[0].diagnosticSize, 104);
    assert.equal(list[0].message.includes('abcdefghijklmnop1234'), false);
    assert.equal(list[0].message.includes('sk-abcdef'), false);
    assert.equal('diagnostic' in list[0], false, '列表不带包内容');
    const dl = await s.call(`/admin/feedback/${r.json.id}/diagnostic`, { token: t });
    assert.equal(dl.status, 200);
    assert.equal(dl.res.headers.get('content-type'), 'application/zip');
    assert.equal((await s.call('/admin/feedback/nope/diagnostic', { token: t })).status, 404);
  } finally { await s.close(); }
});

test('反馈：大小限制（解码后、整体请求体、文字长度）与格式校验', async () => {
  const s = await boot({ MAX_DIAGNOSTIC_BYTES: '5000', FEEDBACK_RATE_LIMIT: '100' });
  try {
    const post = (b: unknown) => s.call('/feedback', { body: b });
    assert.equal((await post({ message: 'x', diagnostic: zipB64(4900) })).status, 201);
    const big = await post({ message: 'x', diagnostic: zipB64(6000) });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'payload_too_large');
    assert.equal((await post({ message: 'x', diagnostic: Buffer.alloc(200).toString('base64') })).status, 400); // 非 zip
    assert.equal((await post({ message: 'x', diagnostic: '***not base64***' })).status, 400);
    assert.equal((await post({ message: 'x'.repeat(4001) })).status, 400);
    assert.equal((await post({ message: '  ' })).status, 400);
    assert.equal((await post({ message: 'x', extra: 1 })).status, 400);
    // 超过请求体上限：在解析阶段直接 413
    const huge = await s.call('/feedback', { raw: JSON.stringify({ message: 'x', diagnostic: 'A'.repeat(3_000_000) }) });
    assert.equal(huge.status, 413);
    // 其它路径的请求体上限更小
    const other = await s.call('/telemetry', { raw: JSON.stringify({ pad: 'A'.repeat(200_000) }) });
    assert.equal(other.status, 413);
  } finally { await s.close(); }
});

test('反馈：限流（每 IP 10 分钟 5 次）', async () => {
  const s = await boot();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await s.call('/feedback', { body: { message: `m${i}` } })).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  } finally { await s.close(); }
});

test('RateLimiter：窗口滑动后恢复', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  rl.hit('k', 2, 1000); rl.hit('k', 2, 1000);
  assert.throws(() => rl.hit('k', 2, 1000), /too many/);
  rl.hit('other', 2, 1000);
  t = 1001;
  rl.hit('k', 2, 1000);
});
