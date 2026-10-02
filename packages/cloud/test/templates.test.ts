import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { compactVerify, importJWK } from 'jose';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { loadConfig } from '../src/services/config';
import { LicenceService } from '../src/services/licence.service';
import { ServiceError } from '../src/services/errors';
import { TemplateService, catalogItem, manifestSchema, manifestSha256, templateDigest } from '../src/services/template.service';
import type { TemplateManifest } from '../src/services/template.service';

// P3-T 模板市场（云端）：清单校验、摘要与签名、仓储契约、公开目录、管理接口鉴权与审计。
const LOCAL_TEMPLATES = path.join(__dirname, '..', '..', 'local', 'templates');
const builtin = (id: string): TemplateManifest => JSON.parse(readFileSync(path.join(LOCAL_TEMPLATES, id, 'manifest.json'), 'utf8'));
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const ADMIN = { email: 'root@example.com', password: 'test-root-pass-123' };
const PW = 'another-test-pass-1';
const cfg = () => loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);

function minimal(over: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id: 'tpl-min', name: '最小模板', version: '0.1.0', genre: 'test', tier: 'free', description: '',
    style: { name: '测试', prompt: '测试风格' },
    character_slots: [{ id: 'a', name: '甲' }],
    shots: [{ title: '一', duration_ms: 3000, prompt_template: '{{a}} 在 {{scene}}', character_slots: ['a'], scene_slot: '街头', lines: [{ kind: 'dialogue', speaker: 'a', text: '你好' }] }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 清单与摘要
// ---------------------------------------------------------------------------
test('清单校验：本地内置模板全部通过；常见错误被拒绝', () => {
  for (const id of ['official-guofeng-drama', 'official-product-seeding', 'official-knowledge-explainer']) {
    const r = manifestSchema.safeParse(builtin(id));
    assert.ok(r.success, id + ' ' + (r.success ? '' : JSON.stringify(r.error.issues)));
    assert.equal(r.data.id, id);
  }
  const paths = (m: unknown) => { const r = manifestSchema.safeParse(m); return r.success ? [] : r.error.issues.map((i) => i.path.join('.')); };
  assert.ok(paths(minimal({ id: 'Bad Id' })).includes('id'));
  assert.ok(paths(minimal({ tier: 'gold' as 'free' })).includes('tier'));
  assert.ok(paths(minimal({ version: '1' })).includes('version'));
  assert.ok(paths(minimal({ shots: [{ ...minimal().shots[0], duration_ms: 0 }] })).includes('shots.0.duration_ms'));
  assert.ok(paths(minimal({ shots: [{ ...minimal().shots[0], prompt_template: '{{ghost}}' }] })).includes('shots.0.prompt_template'));
  assert.ok(paths(minimal({ shots: [{ ...minimal().shots[0], character_slots: [] }] })).includes('shots.0.character_slots'));
  assert.ok(paths(minimal({ character_slots: [{ id: 'a', name: '甲' }, { id: 'a', name: '乙' }] })).includes('character_slots.1.id'));
  assert.ok(paths(minimal({ character_slots: [{ id: 'scene', name: '甲' }] })).includes('character_slots.0.id'));
  assert.ok(paths(minimal({ shots: [{ ...minimal().shots[0], lines: [{ kind: 'dialogue', speaker: 'zz', text: 'x' }] }] })).includes('shots.0.lines.0.speaker'));
  assert.ok(paths(minimal({ shots: [] })).includes('shots'));
  assert.ok(paths('nope').length > 0);
  // 未知字段（含 signature）会被剥掉，所以存库的清单就是签名覆盖的清单
  const parsed = manifestSchema.parse({ ...minimal(), signature: 'x.y.z', extra: 1 } as unknown);
  assert.equal((parsed as Record<string, unknown>).signature, undefined);
  assert.equal((parsed as Record<string, unknown>).extra, undefined);
});

test('摘要算法与本地端一致：忽略键序与 signature，不同内容不同摘要', () => {
  const m = minimal();
  const shuffled = JSON.parse(JSON.stringify({ shots: m.shots, style: m.style, id: m.id, character_slots: m.character_slots, name: m.name, version: m.version, genre: m.genre, tier: m.tier, description: m.description }));
  assert.equal(manifestSha256(m), manifestSha256(shuffled));
  assert.equal(templateDigest({ ...m, signature: 'abc' }), templateDigest(m));
  assert.notEqual(templateDigest({ ...m, name: '改名' }), templateDigest(m));
  assert.match(templateDigest(m), /^tpl-[0-9a-f]{64}$/);
  // 本地 packages/local/src/templates/schema.js 的 templateDigest 必须给出同一个值（客户端用它验签）
  const localSchema = createRequire(__filename)(path.join(LOCAL_TEMPLATES, '..', 'src', 'templates', 'schema.js')) as { templateDigest: (m: unknown) => string };
  for (const id of ['official-guofeng-drama', 'official-product-seeding']) {
    const parsed = manifestSchema.parse(builtin(id));
    assert.equal(localSchema.templateDigest(parsed), templateDigest(parsed), id);
    assert.equal(localSchema.templateDigest(builtin(id)), templateDigest(builtin(id)), id + ' raw');
  }
});

// ---------------------------------------------------------------------------
// 仓储契约（内存 / PostgreSQL）
// ---------------------------------------------------------------------------
test('模板仓储：id 唯一、版本 (templateId, version) 唯一、发布列表与级联删除', async () => {
  const r = await makeRepos();
  const t = await r.templates.create({ id: 'tpl-a', name: 'A', genre: 'g', tier: 'free', description: '' }, at(0));
  assert.equal(t.createdAt.getTime(), at(0).getTime());
  await assert.rejects(r.templates.create({ id: 'tpl-a', name: 'A2', genre: 'g', tier: 'free', description: '' }, at(1)));
  await r.templates.create({ id: 'tpl-b', name: 'B', genre: 'g', tier: 'pro', description: 'b' }, at(2));
  assert.deepEqual((await r.templates.list()).map((x) => x.id), ['tpl-a', 'tpl-b']);
  const upd = await r.templates.update('tpl-a', { name: 'A!', tier: 'pro' }, at(5));
  assert.equal(upd!.name, 'A!');
  assert.equal(upd!.tier, 'pro');
  assert.equal(upd!.updatedAt.getTime(), at(5).getTime());
  assert.equal(await r.templates.update('nope', { name: 'x' }, at(5)), null);

  const base = { templateId: 'tpl-a', manifest: { id: 'tpl-a', v: 1 }, packageUrl: null, sha256: 'ab', signature: 'h.p.s', kid: 'k1', tier: 'free' as const };
  const v1 = await r.templates.addVersion({ ...base, version: '1.0.0' }, at(10));
  assert.equal(v1.published, false);
  assert.equal(v1.publishedAt, null);
  assert.deepEqual(v1.manifest, { id: 'tpl-a', v: 1 });
  await assert.rejects(r.templates.addVersion({ ...base, version: '1.0.0' }, at(11)), '同模板同版本重复');
  await assert.rejects(r.templates.addVersion({ ...base, templateId: 'nope', version: '1.0.0' }, at(11)), '模板不存在');
  const v2 = await r.templates.addVersion({ ...base, version: '1.1.0', manifest: { id: 'tpl-a', v: 2 } }, at(12));
  const vb = await r.templates.addVersion({ ...base, templateId: 'tpl-b', version: '0.1.0', tier: 'pro' }, at(13));
  assert.deepEqual((await r.templates.listVersions('tpl-a')).map((v) => v.version), ['1.1.0', '1.0.0'], '新建的在前');
  assert.equal((await r.templates.findVersion(v1.id))!.version, '1.0.0');
  assert.equal(await r.templates.findVersion('00000000-0000-4000-8000-000000000000'), null);

  assert.deepEqual(await r.templates.listPublished(), []);
  const p1 = await r.templates.setPublished(v1.id, true, at(20));
  assert.equal(p1!.published, true);
  assert.equal(p1!.publishedAt!.getTime(), at(20).getTime());
  await r.templates.setPublished(vb.id, true, at(21));
  await r.templates.setPublished(v2.id, true, at(22));
  assert.deepEqual((await r.templates.listPublished()).map((v) => v.version), ['1.1.0', '0.1.0', '1.0.0'], 'publishedAt 新的在前');
  const un = await r.templates.setPublished(v2.id, false, at(23));
  assert.equal(un!.published, false);
  assert.equal(un!.publishedAt, null);
  assert.deepEqual((await r.templates.listPublished()).map((v) => v.version), ['0.1.0', '1.0.0']);
  assert.equal(await r.templates.setPublished('00000000-0000-4000-8000-000000000000', true, at(0)), null);

  assert.equal(await r.templates.delete('tpl-a'), true);
  assert.equal(await r.templates.delete('tpl-a'), false);
  assert.deepEqual(await r.templates.listVersions('tpl-a'), [], '级联删除版本');
  assert.equal(await r.templates.findVersion(v1.id), null);
  assert.equal((await r.templates.listPublished()).length, 1);
});

// ---------------------------------------------------------------------------
// 服务：签名、目录
// ---------------------------------------------------------------------------
test('服务：新增版本即签名（客户端用 JWKS 可验），目录只含每个模板最近发布的版本', async () => {
  const repos = await makeRepos();
  const config = cfg();
  let clock = T0;
  const svc = new TemplateService(repos, config, () => clock);
  const licences = new LicenceService(repos, config);

  await svc.create({ id: 'official-guofeng-drama', name: '占位', genre: 'x' });
  await assert.rejects(svc.create({ id: 'official-guofeng-drama', name: '重复', genre: 'x' }), (e: unknown) => e instanceof ServiceError && e.code === 'conflict');
  await assert.rejects(svc.create({ id: 'Bad', name: 'x', genre: 'x' }), 'zod');
  const m = builtin('official-guofeng-drama');
  await assert.rejects(svc.addVersion('nope', { manifest: m }), (e: unknown) => e instanceof ServiceError && e.code === 'not_found');
  await assert.rejects(svc.addVersion('official-guofeng-drama', { manifest: { ...m, id: 'other-id' } }), (e: unknown) => e instanceof ServiceError && e.code === 'bad_request' && /不一致/.test(e.message));
  await assert.rejects(svc.addVersion('official-guofeng-drama', { manifest: { ...m, tier: 'vip' } }), (e: unknown) => e instanceof ServiceError && e.code === 'bad_request' && /tier/.test(e.message));

  const v = await svc.addVersion('official-guofeng-drama', { manifest: { ...m, signature: 'should-be-dropped' } });
  assert.equal(v.version, '1.0.0');
  assert.equal(v.kid, config.licenceKeyId);
  assert.equal(v.tier, 'free');
  assert.equal(v.sha256, manifestSha256(m));
  assert.equal((v.manifest as Record<string, unknown>).signature, undefined);
  // 模板元数据同步成清单里的值
  const t = await svc.get('official-guofeng-drama');
  assert.equal(t.name, m.name);
  assert.equal(t.genre, 'guofeng');
  assert.equal(t.versions.length, 1);
  // 验签：JWKS 公钥 + 载荷 = 'tpl-' + sha256
  const pub = await importJWK(licences.jwks().keys[0], 'ES256');
  const { payload, protectedHeader } = await compactVerify(v.signature, pub);
  assert.equal(protectedHeader.kid, config.licenceKeyId);
  assert.equal(new TextDecoder().decode(payload), templateDigest(v.manifest));
  assert.equal(new TextDecoder().decode(payload), 'tpl-' + v.sha256);
  await assert.rejects(svc.addVersion('official-guofeng-drama', { manifest: m }), (e: unknown) => e instanceof ServiceError && e.code === 'conflict');

  // 目录
  assert.deepEqual((await svc.catalog()).items, []);
  clock = at(1000);
  await svc.publish('official-guofeng-drama', v.id);
  const c1 = await svc.catalog();
  assert.equal(c1.items.length, 1);
  assert.equal(c1.items[0].id, 'official-guofeng-drama');
  assert.equal(c1.items[0].version, '1.0.0');
  assert.equal(c1.items[0].published_at, at(1000).toISOString());
  assert.equal(c1.items[0].manifest.signature, v.signature);
  assert.equal(templateDigest(c1.items[0].manifest), 'tpl-' + v.sha256, '目录里的清单（含 signature）算出同一摘要');
  // 第二个版本发布后目录只剩它；下架后回到 1.0.0
  const v2 = await svc.addVersion('official-guofeng-drama', { manifest: { ...m, version: '1.0.1', name: '国风短剧 · 错嫁（修订）' }, packageUrl: 'https://cdn.example.com/p.lytpl' });
  clock = at(2000);
  await svc.publish('official-guofeng-drama', v2.id);
  const c2 = await svc.catalog();
  assert.equal(c2.items.length, 1);
  assert.equal(c2.items[0].version, '1.0.1');
  assert.equal(c2.items[0].packageUrl, 'https://cdn.example.com/p.lytpl');
  await svc.unpublish('official-guofeng-drama', v2.id);
  assert.equal((await svc.catalog()).items[0].version, '1.0.0');
  await assert.rejects(svc.publish('official-product-seeding', v2.id), (e: unknown) => e instanceof ServiceError && e.code === 'not_found', '版本不属于该模板');
  // 第二个模板 + 删除
  await svc.create({ id: 'official-product-seeding', name: 'x', genre: 'x', tier: 'pro' });
  const vs = await svc.addVersion('official-product-seeding', { manifest: builtin('official-product-seeding') });
  await svc.publish('official-product-seeding', vs.id);
  assert.deepEqual((await svc.catalog()).items.map((i) => i.id), ['official-product-seeding', 'official-guofeng-drama']);
  assert.equal((await svc.list()).length, 2);
  await svc.remove('official-product-seeding');
  await assert.rejects(svc.remove('official-product-seeding'), (e: unknown) => e instanceof ServiceError && e.code === 'not_found');
  assert.deepEqual((await svc.catalog()).items.map((i) => i.id), ['official-guofeng-drama']);
  assert.equal(catalogItem(v).manifest.signature, v.signature);
});

// ---------------------------------------------------------------------------
// HTTP：公开目录、管理接口的角色与审计
// ---------------------------------------------------------------------------
async function boot() {
  const repos = await makeRepos();
  const config = cfg();
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
    return { status: res.status, json, headers: res.headers };
  };
  const loginAs = async (email: string, password: string) => (await call('/admin/auth/login', { body: { email, password } })).json.token as string;
  const root = await loginAs(ADMIN.email, ADMIN.password);
  const makeAdmin = async (email: string, role: string) => {
    const r = await call('/admin/admins', { token: root, body: { email, role, password: PW } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return loginAs(email, PW);
  };
  return { repos, config, call, root, makeAdmin, close: () => app.close() };
}

test('HTTP：只读不能写、运营可管理模板、公开目录无需登录且签名可验、写操作进审计', async () => {
  const s = await boot();
  try {
    const ro = await s.makeAdmin('ro@example.com', 'READONLY');
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');
    const m = builtin('official-knowledge-explainer');
    const body = { id: m.id, name: m.name, genre: m.genre, tier: m.tier, description: m.description };

    assert.equal((await s.call('/admin/templates')).status, 401);
    assert.equal((await s.call('/admin/templates', { token: ro })).status, 200);
    assert.equal((await s.call('/admin/templates', { token: ro, body })).status, 403);
    const created = await s.call('/admin/templates', { token: op, body });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.tier, 'pro');
    assert.equal((await s.call('/admin/templates', { token: op, body })).status, 409);
    assert.equal((await s.call('/admin/templates', { token: op, body: { id: 'Bad Id', name: 'x', genre: 'x' } })).status, 400);

    const bad = await s.call(`/admin/templates/${m.id}/versions`, { token: op, body: { manifest: { ...m, shots: [] } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /shots/);
    const ver = await s.call(`/admin/templates/${m.id}/versions`, { token: op, body: { manifest: m } });
    assert.equal(ver.status, 201, JSON.stringify(ver.json));
    assert.equal(ver.json.published, false);
    assert.equal((await s.call(`/admin/templates/${m.id}/versions`, { token: ro, body: { manifest: m } })).status, 403);

    // 未发布：公开目录为空
    const empty = await s.call('/templates/catalog');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.items, []);
    assert.equal(empty.headers.get('cache-control'), 'no-store');

    assert.equal((await s.call(`/admin/templates/${m.id}/versions/${ver.json.id}/publish`, { token: ro, body: {} })).status, 403);
    const pub = await s.call(`/admin/templates/${m.id}/versions/${ver.json.id}/publish`, { token: op, body: {} });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.equal(pub.json.published, true);
    assert.equal((await s.call(`/admin/templates/${m.id}/versions/00000000-0000-4000-8000-000000000000/publish`, { token: op, body: {} })).status, 404);

    // 公开目录（无令牌）+ 用 JWKS 验签
    const cat = await s.call('/templates/catalog');
    assert.equal(cat.status, 200);
    assert.equal(cat.json.items.length, 1);
    const item = cat.json.items[0];
    assert.equal(item.id, m.id);
    assert.equal(item.tier, 'pro');
    assert.equal(item.manifest.shots.length, 7);
    assert.equal(typeof item.manifest.signature, 'string');
    const jwks = (await s.call('/.well-known/licence-jwks.json')).json;
    const pubKey = await importJWK(jwks.keys[0], 'ES256');
    const { payload, protectedHeader } = await compactVerify(item.manifest.signature, pubKey);
    assert.equal(protectedHeader.kid, item.kid);
    assert.equal(new TextDecoder().decode(payload), templateDigest(item.manifest));
    assert.equal(new TextDecoder().decode(payload), 'tpl-' + item.sha256);

    const got = await s.call(`/admin/templates/${m.id}`, { token: ro });
    assert.equal(got.status, 200);
    assert.equal(got.json.versions.length, 1);
    assert.equal((await s.call(`/admin/templates/${m.id}`, { token: op, method: 'PUT', body: { description: '改简介' } })).json.description, '改简介');
    assert.equal((await s.call(`/admin/templates/${m.id}/versions/${ver.json.id}/unpublish`, { token: op, body: {} })).json.published, false);
    assert.deepEqual((await s.call('/templates/catalog')).json.items, []);
    assert.equal((await s.call(`/admin/templates/${m.id}`, { token: ro, method: 'DELETE' })).status, 403);
    assert.equal((await s.call(`/admin/templates/${m.id}`, { token: op, method: 'DELETE' })).status, 204);
    assert.equal((await s.call(`/admin/templates/${m.id}`, { token: op })).status, 404);

    // 审计：模板写操作自动记录（含被拒绝的越权写）
    const audit = (await s.call('/admin/audit?limit=200', { token: s.root })).json as any[];
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes('POST /admin/templates'), actions.join(','));
    assert.ok(actions.includes('POST /admin/templates/:id/versions'));
    assert.ok(actions.includes('POST /admin/templates/:id/versions/:vid/publish'));
    assert.ok(actions.includes('DELETE /admin/templates/:id'));
    assert.ok(audit.some((a) => a.action === 'POST /admin/templates' && a.ok && a.targetId === m.id));
    assert.ok(audit.some((a) => a.action === 'POST /admin/templates' && !a.ok && a.status === 403 && a.actorEmail === 'ro@example.com'));
    assert.ok(!actions.includes('GET /admin/templates'), '读不记审计');
  } finally { await s.close(); }
});
