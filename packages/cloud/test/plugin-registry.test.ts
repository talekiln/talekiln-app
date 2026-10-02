import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { loadConfig } from '../src/services/config';
import { ROLE_PERMISSIONS, can } from '../src/services/admin-roles';
import { pluginHash, pluginSigningPayload, signPluginPayload, verifyPluginPayload } from '../src/services/plugin-signing';
import { pluginManifestSchema, pluginSubmitSchema } from '../src/services/plugin-registry.service';

// 插件 SDK 是公开的 MIT 包（packages/plugin-sdk）；云端镜像不含它，所以这里用相对路径加载，只为交叉校验算法一致。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require(resolve(__dirname, '../../plugin-sdk/src')) as {
  listPluginFiles(dir: string): { files: string[]; symlinks: string[] };
  hashFiles(dir: string, files: string[]): Record<string, string>;
  signingPayload(manifest: Record<string, unknown>, hashes: Record<string, string>): string;
  payloadHash(payload: string): string;
  verifySignature(manifest: Record<string, unknown>, dir: string, keys: unknown): { ok: boolean; status: string; reason: string | null; kid: string | null; hash: string | null };
  validateManifest(m: unknown): { ok: boolean; errors: string[] };
};

const ADMIN = { email: 'root@example.com', password: 'test-root-pass-123' };
const PW = 'another-test-pass-1';
const SHA = 'a'.repeat(64);

/** 临时插件目录（代码从不被执行）：返回未签名 manifest、文件列表与哈希。 */
function makePluginDir(name = 'acme', version = '0.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-registry-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'index.js'), "module.exports = { createAdapter() { return { capabilities: {} }; } };\n");
  writeFileSync(join(dir, 'lib', 'helper.js'), 'module.exports = {};\n');
  const manifest: Record<string, unknown> = {
    name, version, sdkVersion: '1.0.0', label: 'Acme', homepage: 'https://plugins.acme.example/',
    capabilities: ['llm.chat', 'image.generate'], permissions: ['network:api.acme.example', 'secret:apiKey'], entry: 'index.js',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const { files } = sdk.listPluginFiles(dir);
  const fileHashes = sdk.hashFiles(dir, files);
  return { dir, manifest: { ...manifest, files }, fileHashes, files };
}

async function boot() {
  const repos = await makeRepos();
  const config = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LICENCE_KEY_ID: 'lic-test' } as NodeJS.ProcessEnv);
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

// ---------------------------------------------------------------------------
// 纯函数：签名算法与 SDK 一致
// ---------------------------------------------------------------------------
test('签名载荷与指纹和 SDK 完全一致；云端签出的签名 SDK 能验、改文件后验不过', () => {
  const p = makePluginDir();
  const payload = pluginSigningPayload(p.manifest, p.fileHashes);
  assert.equal(payload, sdk.signingPayload(p.manifest, p.fileHashes));
  assert.equal(pluginHash(payload), sdk.payloadHash(payload));
  // signature 字段不参与载荷
  assert.equal(pluginSigningPayload({ ...p.manifest, signature: { alg: 'ES256', kid: 'x', value: 'y' } }, p.fileHashes), payload);

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sig = signPluginPayload(payload, privateKey, 'k-test');
  assert.equal(sig.alg, 'ES256');
  assert.equal(sig.kid, 'k-test');
  assert.match(sig.value, /^[A-Za-z0-9_-]{80,}$/);
  assert.ok(verifyPluginPayload(payload, sig, publicKey));
  assert.ok(verifyPluginPayload(payload, sig, privateKey), '私钥对象也能用于验证（取其公钥）');
  assert.equal(verifyPluginPayload(payload + ' ', sig, publicKey), false);
  assert.equal(verifyPluginPayload(payload, { ...sig, value: 'AAAA' }, publicKey), false);

  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k-test', alg: 'ES256', use: 'sig' };
  const signedManifest = { ...p.manifest, signature: sig };
  writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify(signedManifest));
  assert.ok(sdk.validateManifest(signedManifest).ok);
  const r = sdk.verifySignature(signedManifest, p.dir, { keys: [jwk] });
  assert.deepEqual([r.ok, r.status, r.kid, r.hash], [true, 'official', 'k-test', pluginHash(payload)]);
  appendFileSync(join(p.dir, 'lib', 'helper.js'), '// changed\n');
  assert.deepEqual([sdk.verifySignature(signedManifest, p.dir, { keys: [jwk] }).status, sdk.verifySignature(signedManifest, p.dir, { keys: [jwk] }).reason], ['invalid', 'bad signature']);
});

test('manifest 与提交体校验：形状与 SDK 规则一致，fileHashes 必须与 files 一一对应', () => {
  const p = makePluginDir();
  const ok = pluginSubmitSchema.safeParse({ manifest: p.manifest, fileHashes: p.fileHashes, packageUrl: 'https://dl.example/acme-0.1.0.zip', sha256: SHA });
  assert.ok(ok.success, JSON.stringify(ok.success ? null : ok.error.issues));
  const bad = (m: Record<string, unknown>) => pluginManifestSchema.safeParse(m).success === false;
  assert.ok(bad({ ...p.manifest, name: 'Acme' }), '大写名');
  assert.ok(bad({ ...p.manifest, version: '1.0' }), '非 semver');
  assert.ok(bad({ ...p.manifest, capabilities: [] }), '空能力');
  assert.ok(bad({ ...p.manifest, capabilities: ['video.submit'] }), 'video 成对');
  assert.ok(bad({ ...p.manifest, capabilities: ['llm.chat', 'llm.chat'] }), '重复能力');
  assert.ok(bad({ ...p.manifest, capabilities: ['magic'] }), '未知能力');
  assert.ok(bad({ ...p.manifest, permissions: ['secret:apiKey'] }), '缺 network');
  assert.ok(bad({ ...p.manifest, permissions: ['network:https://x.com'] }), '带 scheme');
  assert.ok(bad({ ...p.manifest, permissions: ['network:*'] }), '裸通配');
  assert.ok(bad({ ...p.manifest, permissions: ['network:a.example', 'fs:read'] }), '未知权限');
  assert.ok(bad({ ...p.manifest, entry: '../index.js' }), 'entry 出目录');
  assert.ok(bad({ ...p.manifest, files: ['lib/helper.js'] }), 'files 缺 entry');
  assert.ok(bad({ ...p.manifest, files: ['index.js', '../x.js'] }), '非法路径');
  assert.ok(bad({ ...p.manifest, files: ['index.js', 'index.js'] }), '重复文件');
  assert.ok(bad({ ...p.manifest, extra: 1 }), '未知字段');
  assert.ok(bad({ ...p.manifest, signature: { alg: 'ES256', kid: 'k', value: 'A'.repeat(30) } }), '提交体不能自带签名');
  const { files: _f, ...noFiles } = p.manifest;
  assert.ok(bad(noFiles), '必须列出 files');
  // 与 SDK 的判断一致（SDK 还会比对宿主 sdkVersion，这里不比）
  for (const m of [{ ...p.manifest, name: 'Acme' }, { ...p.manifest, permissions: ['secret:apiKey'] }, { ...p.manifest, files: ['index.js', '../x.js'] }]) {
    assert.equal(sdk.validateManifest(m).ok, false);
  }
  assert.ok(sdk.validateManifest(p.manifest).ok);

  const sub = (o: Record<string, unknown>) => pluginSubmitSchema.safeParse({ manifest: p.manifest, fileHashes: p.fileHashes, packageUrl: 'https://dl.example/a.zip', sha256: SHA, ...o }).success;
  assert.equal(sub({ fileHashes: { 'index.js': p.fileHashes['index.js'] } }), false, '少一个文件的哈希');
  assert.equal(sub({ fileHashes: { ...p.fileHashes, 'extra.js': SHA } }), false, '多一个文件的哈希');
  assert.equal(sub({ fileHashes: { ...p.fileHashes, 'index.js': 'xyz' } }), false, '哈希格式');
  assert.equal(sub({ packageUrl: 'http://dl.example/a.zip' }), false, '必须 https');
  assert.equal(sub({ packageUrl: 'not a url' }), false);
  assert.equal(sub({ sha256: 'ABC' }), false);
  assert.equal(sub({ notes: 'x'.repeat(2001) }), false);
});

test('角色：审核归 OPERATOR 以上，签名只有 ADMIN', () => {
  assert.ok(can('OPERATOR', 'plugins:review') && !can('OPERATOR', 'plugins:sign'));
  assert.ok(!can('READONLY', 'plugins:review') && !can('READONLY', 'plugins:sign'));
  assert.ok(can('ADMIN', 'plugins:review') && can('ADMIN', 'plugins:sign'));
  assert.deepEqual([...ROLE_PERMISSIONS.READONLY], ['read']);
});

// ---------------------------------------------------------------------------
// 仓储契约（内存与 PostgreSQL 一致）
// ---------------------------------------------------------------------------
test('插件仓储：按名 upsert、(插件, 版本) 唯一、筛选与排序、审核/签名字段、审核记录按时间升序', async () => {
  const r = await makeRepos();
  const T0 = new Date('2026-10-01T00:00:00.000Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const p = makePluginDir();
  const a = await r.plugins.upsertPlugin({ name: 'acme', label: 'Acme', homepage: null }, at(0));
  const a2 = await r.plugins.upsertPlugin({ name: 'acme', label: 'Acme 2', homepage: 'https://a.example/' }, at(5));
  assert.equal(a2.id, a.id);
  assert.deepEqual([a2.label, a2.homepage, a2.createdAt.getTime()], ['Acme 2', 'https://a.example/', at(0).getTime()]);
  const b = await r.plugins.upsertPlugin({ name: 'beta', label: 'Beta', homepage: null }, at(1));
  assert.deepEqual((await r.plugins.listPlugins()).map((x) => x.name), ['acme', 'beta']);
  assert.equal((await r.plugins.findPluginByName('acme'))!.id, a.id);
  assert.equal(await r.plugins.findPluginByName('nope'), null);

  const base = { pluginId: a.id, manifest: p.manifest, fileHashes: p.fileHashes, hash: 'h'.repeat(64), packageUrl: 'https://dl.example/a.zip', sha256: SHA, submittedBy: 'u1' };
  const v1 = await r.plugins.createVersion({ ...base, version: '0.1.0' }, at(10));
  assert.deepEqual([v1.pluginName, v1.reviewStatus, v1.signature, v1.reviewedAt, v1.signedAt], ['acme', 'pending', null, null, null]);
  assert.deepEqual(v1.manifest, p.manifest);
  assert.deepEqual(v1.fileHashes, p.fileHashes);
  await assert.rejects(r.plugins.createVersion({ ...base, version: '0.1.0' }, at(11)), '同插件同版本重复');
  const v2 = await r.plugins.createVersion({ ...base, version: '0.2.0' }, at(20));
  const bv = await r.plugins.createVersion({ ...base, pluginId: b.id, version: '0.1.0' }, at(30));
  await assert.rejects(r.plugins.createVersion({ ...base, pluginId: '00000000-0000-4000-8000-000000000000', version: '9.9.9' }, at(31)), '插件不存在');
  assert.deepEqual((await r.plugins.listVersions({ limit: 10 })).map((x) => x.id), [bv.id, v2.id, v1.id], '新的在前');
  assert.deepEqual((await r.plugins.listVersions({ pluginId: a.id, limit: 10 })).map((x) => x.version), ['0.2.0', '0.1.0']);
  assert.equal((await r.plugins.listVersions({ limit: 1 })).length, 1);

  const ap = await r.plugins.setReview(v1.id, { reviewStatus: 'approved', reviewedAt: at(40), reviewedBy: 'adm' }, at(40));
  assert.deepEqual([ap!.reviewStatus, ap!.reviewedAt!.getTime(), ap!.reviewedBy, ap!.updatedAt.getTime()], ['approved', at(40).getTime(), 'adm', at(40).getTime()]);
  assert.deepEqual((await r.plugins.listVersions({ reviewStatus: 'approved', limit: 10 })).map((x) => x.id), [v1.id]);
  assert.deepEqual((await r.plugins.listVersions({ reviewStatus: 'pending', limit: 10 })).map((x) => x.id), [bv.id, v2.id]);
  assert.equal(await r.plugins.setReview('00000000-0000-4000-8000-000000000000', { reviewStatus: 'approved', reviewedAt: at(0), reviewedBy: null }, at(0)), null);

  const sig = { alg: 'ES256' as const, kid: 'lic-1', value: 'A'.repeat(86) };
  const sg = await r.plugins.setSignature(v1.id, { signature: sig, signedAt: at(50), signedBy: 'adm' }, at(50));
  assert.deepEqual(sg!.signature, sig);
  assert.equal(sg!.signedAt!.getTime(), at(50).getTime());
  assert.deepEqual((await r.plugins.findVersion(v1.id))!.signature, sig);
  const cleared = await r.plugins.setSignature(v1.id, { signature: null, signedAt: null, signedBy: null }, at(51));
  assert.equal(cleared!.signature, null);
  assert.equal(await r.plugins.setSignature('00000000-0000-4000-8000-000000000000', { signature: null, signedAt: null, signedBy: null }, at(0)), null);
  assert.equal(await r.plugins.findVersion('00000000-0000-4000-8000-000000000000'), null);

  await r.plugins.addReview({ versionId: v1.id, action: 'submit', notes: '首次提交', actorId: 'u1', actorEmail: 'u1@x.com', createdAt: at(10) });
  await r.plugins.addReview({ versionId: v1.id, action: 'approve', notes: '', actorId: 'adm', actorEmail: 'adm@x.com', createdAt: at(40) });
  await r.plugins.addReview({ versionId: v2.id, action: 'submit', notes: '', actorId: 'u1', actorEmail: 'u1@x.com', createdAt: at(20) });
  assert.deepEqual((await r.plugins.listReviews(v1.id)).map((x) => [x.action, x.notes]), [['submit', '首次提交'], ['approve', '']]);
  assert.equal((await r.plugins.listReviews(bv.id)).length, 0);
});

// ---------------------------------------------------------------------------
// HTTP：登记 -> 审核 -> 签名 -> 公开目录；角色与审计
// ---------------------------------------------------------------------------
test('注册表接口：角色门禁、登记校验、审核与签名状态机、公开目录只含已通过版本、签名可被 SDK 用 JWKS 验证', async () => {
  const s = await boot();
  try {
    const p = makePluginDir();
    const submission = { manifest: p.manifest, fileHashes: p.fileHashes, packageUrl: 'https://dl.example/acme-0.1.0.zip', sha256: SHA, notes: '社区提交' };
    const ro = await s.makeAdmin('ro@example.com', 'READONLY');
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');

    // 公开目录无需令牌，初始为空
    const empty = await s.call('/plugins/catalog');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.plugins, []);
    assert.equal(empty.json.kid, 'lic-test');
    // 门禁：只读不能登记；无令牌 401；读列表只读可以
    assert.equal((await s.call('/admin/plugins', { token: ro, body: submission })).status, 403);
    assert.equal((await s.call('/admin/plugins', { body: submission })).status, 401);
    assert.equal((await s.call('/admin/plugins', { token: ro })).status, 200);
    // 校验失败 400
    assert.equal((await s.call('/admin/plugins', { token: op, body: { ...submission, sha256: 'nope' } })).status, 400);
    assert.equal((await s.call('/admin/plugins', { token: op, body: { ...submission, manifest: { ...p.manifest, permissions: ['secret:apiKey'] } } })).status, 400);
    assert.equal((await s.call('/admin/plugins', { token: op, body: {} })).status, 400);

    // 登记
    const created = await s.call('/admin/plugins', { token: op, body: submission });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const v = created.json;
    assert.deepEqual([v.name, v.version, v.label, v.reviewStatus, v.signature, v.signedManifest], ['acme', '0.1.0', 'Acme', 'pending', null, null]);
    assert.equal(v.hash, sdk.payloadHash(sdk.signingPayload(p.manifest, p.fileHashes)), '指纹与 SDK 算出的一致');
    assert.equal((await s.call('/admin/plugins', { token: op, body: submission })).status, 409, '同版本重复登记');
    const detail = (await s.call(`/admin/plugins/${v.id}`, { token: ro })).json;
    assert.deepEqual(detail.reviews.map((x: any) => [x.action, x.notes, x.actorEmail]), [['submit', '社区提交', 'op@example.com']]);
    assert.equal((await s.call('/admin/plugins/00000000-0000-4000-8000-000000000000', { token: ro })).status, 404);
    assert.deepEqual((await s.call('/admin/plugins?status=pending', { token: ro })).json.map((x: any) => x.id), [v.id]);
    assert.deepEqual((await s.call('/admin/plugins?status=approved', { token: ro })).json, []);
    assert.equal((await s.call('/admin/plugins?status=weird', { token: ro })).status, 400);

    // 未审核不能签名；只读不能审核；运营不能签名（越权写会进审计）
    assert.equal((await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: {} })).status, 409);
    assert.equal((await s.call(`/admin/plugins/${v.id}/approve`, { token: ro, body: {} })).status, 403);
    assert.equal((await s.call(`/admin/plugins/${v.id}/approve`, { token: op, body: { notes: '看过代码' } })).status, 200);
    assert.equal((await s.call(`/admin/plugins/${v.id}/approve`, { token: op, body: {} })).status, 409, '重复通过');
    assert.equal((await s.call(`/admin/plugins/${v.id}/sign`, { token: op, body: {} })).status, 403);
    // 通过但未签名：目录里列出但 signed=false
    let cat = (await s.call('/plugins/catalog')).json;
    assert.equal(cat.plugins.length, 1);
    assert.deepEqual([cat.plugins[0].name, cat.plugins[0].versions[0].signed, cat.plugins[0].versions[0].kid], ['acme', false, null]);
    assert.deepEqual(cat.plugins[0].versions[0].manifest, p.manifest);

    // ADMIN 签名
    const signed = await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: { notes: '签名' } });
    assert.equal(signed.status, 200, JSON.stringify(signed.json));
    assert.deepEqual([signed.json.signature.alg, signed.json.signature.kid, signed.json.reviewStatus], ['ES256', 'lic-test', 'approved']);
    assert.ok(signed.json.signedAt && signed.json.signedBy);
    assert.deepEqual(signed.json.signedManifest, { ...p.manifest, signature: signed.json.signature });
    assert.equal((await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: {} })).status, 409, '同一密钥不重复签');
    // 目录：带签名 manifest、哈希、审核日期
    cat = (await s.call('/plugins/catalog')).json;
    const cv = cat.plugins[0].versions[0];
    assert.deepEqual([cv.signed, cv.kid, cv.hash, cv.version, cv.packageUrl, cv.sha256], [true, 'lic-test', v.hash, '0.1.0', submission.packageUrl, SHA]);
    assert.deepEqual(cv.manifest, signed.json.signedManifest);
    assert.ok(cv.reviewedAt && cv.signedAt);
    assert.deepEqual(cv.capabilities, ['llm.chat', 'image.generate']);
    assert.match(String((await s.call('/plugins/catalog')).headers.get('cache-control')), /max-age/);

    // 发布者把 signedManifest 写回包里 -> SDK 用官方 JWKS 验出 official，指纹与登记一致
    const jwks = (await s.call('/.well-known/licence-jwks.json')).json;
    assert.equal(jwks.keys[0].kid, 'lic-test');
    writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify(cv.manifest, null, 2));
    const r = sdk.verifySignature(cv.manifest, p.dir, jwks);
    assert.deepEqual([r.ok, r.status, r.kid, r.hash], [true, 'official', 'lic-test', v.hash]);
    assert.ok(verifyPluginPayload(pluginSigningPayload(cv.manifest, p.fileHashes), cv.manifest.signature, createPublicKey(s.config.licencePrivateKey)));
    // 换一把密钥（不是官方 JWKS 里的）验不过；改文件验不过
    const stranger = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }), kid: 'lic-test' };
    assert.deepEqual([sdk.verifySignature(cv.manifest, p.dir, [stranger]).status, sdk.verifySignature(cv.manifest, p.dir, [stranger]).reason], ['invalid', 'bad signature']);
    appendFileSync(join(p.dir, 'index.js'), '// tampered\n');
    assert.equal(sdk.verifySignature(cv.manifest, p.dir, jwks).status, 'invalid');

    // 驳回已签名版本：撤出目录（签名本身无法撤回，文档说明）；再通过又回来
    assert.equal((await s.call(`/admin/plugins/${v.id}/reject`, { token: op, body: { notes: '发现问题' } })).status, 200);
    assert.deepEqual((await s.call('/plugins/catalog')).json.plugins, []);
    assert.equal((await s.call(`/admin/plugins/${v.id}/reject`, { token: op, body: {} })).status, 409);
    assert.equal((await s.call(`/admin/plugins/${v.id}/approve`, { token: s.root, body: {} })).status, 200);
    assert.equal((await s.call('/plugins/catalog')).json.plugins[0].versions[0].signed, true, '签名保留');
    assert.equal((await s.call('/admin/plugins/00000000-0000-4000-8000-000000000000/approve', { token: op, body: {} })).status, 404);

    // 第二个版本：目录按插件分组
    const p2 = makePluginDir('acme', '0.2.0');
    assert.equal((await s.call('/admin/plugins', { token: s.root, body: { ...submission, manifest: p2.manifest, fileHashes: p2.fileHashes } })).status, 201);
    const other = makePluginDir('zeta', '1.0.0');
    const z = (await s.call('/admin/plugins', { token: s.root, body: { ...submission, manifest: other.manifest, fileHashes: other.fileHashes } })).json;
    await s.call(`/admin/plugins/${z.id}/approve`, { token: s.root, body: {} });
    cat = (await s.call('/plugins/catalog')).json;
    assert.deepEqual(cat.plugins.map((x: any) => [x.name, x.versions.map((y: any) => y.version)]), [['acme', ['0.1.0']], ['zeta', ['1.0.0']]]);
    assert.equal((await s.call('/admin/plugins', { token: ro })).json.length, 3);

    // 审计：登记、通过、签名、驳回都记；越权签名记 403；读不记；对象类型 plugins
    const audit = (await s.call('/admin/audit?limit=200', { token: s.root })).json as any[];
    const find = (action: string, pred: (a: any) => boolean = () => true) => audit.filter((a) => a.action === action && pred(a));
    const subs = find('POST /admin/plugins', (a) => a.ok && a.targetId === v.id);
    assert.equal(subs.length, 1, '新建记录的 id 作对象');
    assert.deepEqual([subs[0].targetType, subs[0].actorEmail, subs[0].status], ['plugins', 'op@example.com', 201]);
    assert.equal(find('POST /admin/plugins', (a) => a.ok).length, 3);
    assert.ok(find('POST /admin/plugins', (a) => !a.ok && a.status === 400).length >= 3);
    assert.equal(find('POST /admin/plugins', (a) => !a.ok && a.status === 409).length, 1);
    const sg = find('POST /admin/plugins/:id/sign');
    assert.ok(sg.some((a) => a.ok && a.actorEmail === ADMIN.email && a.targetId === v.id));
    assert.ok(sg.some((a) => !a.ok && a.status === 403 && a.actorEmail === 'op@example.com'), '运营越权签名被记录');
    assert.ok(sg.some((a) => !a.ok && a.status === 409));
    assert.equal(find('POST /admin/plugins/:id/approve', (a) => a.ok && a.detail?.body?.notes === '看过代码').length, 1);
    assert.equal(find('POST /admin/plugins/:id/reject', (a) => a.ok)[0].targetId, v.id);
    assert.equal(audit.some((a) => a.action.startsWith('GET ')), false);
  } finally { await s.close(); }
});
