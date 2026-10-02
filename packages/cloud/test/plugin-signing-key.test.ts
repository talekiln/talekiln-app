import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { loadConfig, parseRetiredKeys } from '../src/services/config';
import { buildJwks, pluginSigningKeyInfo } from '../src/services/signing-keys';
import { pluginSigningPayload, signPluginPayload, verifyPluginPayload } from '../src/services/plugin-signing';

// P3-P 插件签名密钥：私钥只在云端服务器上（PLUGIN_SIGNING_PRIVATE_KEY_PEM），与许可证密钥分开；JWKS 同时发布许可证密钥、
// 插件签名密钥和退役的插件签名公钥。所有密钥都在测试运行时临时生成，不落盘。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require(resolve(__dirname, '../../plugin-sdk/src')) as {
  listPluginFiles(dir: string): { files: string[]; symlinks: string[] };
  hashFiles(dir: string, files: string[]): Record<string, string>;
  verifySignature(manifest: Record<string, unknown>, dir: string, keys: unknown): { ok: boolean; status: string; reason: string | null; kid: string | null; hash: string | null };
};

/** 像 .env 里那样写：换行转义成 \n。 */
const envPem = (pem: string) => pem.trim().replace(/\n/g, '\\n');
function p256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey, publicKey,
    privatePem: envPem(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    publicPem: envPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}
const BASE = { JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LICENCE_KEY_ID: 'lic-test' };
const env = (o: Record<string, string> = {}) => ({ ...BASE, ...o }) as NodeJS.ProcessEnv;
const retiredEnv = (pem: string, ids: string) => ({ PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM: pem, PLUGIN_SIGNING_RETIRED_KEY_IDS: ids }) as NodeJS.ProcessEnv;
const pubJwk = (k: KeyObject) => createPublicKey(k).export({ format: 'jwk' });

const ADMIN = { email: 'root@example.com', password: 'test-root-pass-123' };
const PW = 'another-test-pass-1';
const SHA = 'b'.repeat(64);

function makePluginDir(name = 'acme', version = '0.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-signing-key-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'index.js'), "module.exports = { createAdapter() { return { capabilities: {} }; } };\n");
  writeFileSync(join(dir, 'lib', 'helper.js'), 'module.exports = {};\n');
  const manifest: Record<string, unknown> = {
    name, version, sdkVersion: '1.0.0', label: 'Acme', homepage: 'https://plugins.acme.example/',
    capabilities: ['llm.chat'], permissions: ['network:api.acme.example', 'secret:apiKey'], entry: 'index.js',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const { files } = sdk.listPluginFiles(dir);
  return { dir, manifest: { ...manifest, files }, fileHashes: sdk.hashFiles(dir, files) };
}

async function boot(e: NodeJS.ProcessEnv) {
  const repos = await makeRepos();
  const config = loadConfig(e);
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
    return { status: res.status, json, text };
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
// 配置
// ---------------------------------------------------------------------------
test('loadConfig：没有独立密钥时回退许可证密钥（生产环境告警）；有则独立、kid 默认 plg-1 且不能与许可证 kid 相同；PEM/曲线/kid 校验', () => {
  const lic = p256();
  const plg = p256();

  // 回退：插件签名用许可证密钥，JWKS 只有一把
  const fb = loadConfig(env({ LICENCE_PRIVATE_KEY_PEM: lic.privatePem }));
  assert.equal(fb.pluginSigningDedicated, false);
  assert.equal(fb.pluginSigningKeyId, 'lic-test');
  assert.equal(fb.pluginSigningPrivateKey, fb.licencePrivateKey);
  assert.deepEqual(fb.pluginRetiredKeys, []);
  assert.deepEqual(buildJwks(fb).keys.map((k) => k.kid), ['lic-test']);
  assert.deepEqual(pluginSigningKeyInfo(fb), { kid: 'lic-test', alg: 'ES256', dedicated: false, licenceKid: 'lic-test', retiredKids: [], jwksPath: '/.well-known/licence-jwks.json' });
  // 没配私钥时 PLUGIN_SIGNING_KEY_ID 不生效（否则 JWKS 里没有这个 kid，签出去验不过）
  assert.equal(loadConfig(env({ LICENCE_PRIVATE_KEY_PEM: lic.privatePem, PLUGIN_SIGNING_KEY_ID: 'plg-9' })).pluginSigningKeyId, 'lic-test');

  // 独立密钥
  const both = { LICENCE_PRIVATE_KEY_PEM: lic.privatePem, PLUGIN_SIGNING_PRIVATE_KEY_PEM: plg.privatePem };
  const ded = loadConfig(env(both));
  assert.equal(ded.pluginSigningDedicated, true);
  assert.equal(ded.pluginSigningKeyId, 'plg-1', '默认 kid');
  assert.deepEqual(pubJwk(ded.pluginSigningPrivateKey), pubJwk(plg.privateKey));
  assert.deepEqual(pubJwk(ded.licencePrivateKey), pubJwk(lic.privateKey));
  assert.notDeepEqual(pubJwk(ded.pluginSigningPrivateKey), pubJwk(ded.licencePrivateKey));
  const jwks = buildJwks(ded);
  assert.deepEqual(jwks.keys.map((k) => [k.kid, k.alg, k.use, k.kty, k.crv]), [['lic-test', 'ES256', 'sig', 'EC', 'P-256'], ['plg-1', 'ES256', 'sig', 'EC', 'P-256']]);
  assert.ok(jwks.keys.every((k) => (k as Record<string, unknown>).d === undefined), 'JWKS 不得含私钥分量');
  assert.deepEqual(jwks.keys[1].x, pubJwk(plg.privateKey).x);
  assert.equal(loadConfig(env({ ...both, PLUGIN_SIGNING_KEY_ID: 'plg-2026.10' })).pluginSigningKeyId, 'plg-2026.10');
  assert.throws(() => loadConfig(env({ ...both, PLUGIN_SIGNING_KEY_ID: 'lic-test' })), /不能与 LICENCE_KEY_ID 相同/);
  assert.throws(() => loadConfig(env({ ...both, PLUGIN_SIGNING_KEY_ID: 'bad kid!' })), /PLUGIN_SIGNING_KEY_ID/);
  assert.throws(() => loadConfig(env({ ...both, PLUGIN_SIGNING_PRIVATE_KEY_PEM: 'not a pem' })), /PLUGIN_SIGNING_PRIVATE_KEY_PEM 无法读取/);
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => loadConfig(env({ ...both, PLUGIN_SIGNING_PRIVATE_KEY_PEM: envPem(p384) })), /P-256/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => loadConfig(env({ ...both, PLUGIN_SIGNING_PRIVATE_KEY_PEM: envPem(rsa) })), /P-256/);
  assert.throws(() => loadConfig(env({ ...both, LICENCE_KEY_ID: 'has space' })), /LICENCE_KEY_ID/);

  // 生产环境：没有插件密钥只告警不拦；配了就安静；没有许可证密钥仍然拒绝启动
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  try {
    const prod = loadConfig(env({ NODE_ENV: 'production', LICENCE_PRIVATE_KEY_PEM: lic.privatePem }));
    assert.equal(prod.pluginSigningDedicated, false);
    assert.ok(warns.some((w) => /PLUGIN_SIGNING_PRIVATE_KEY_PEM/.test(w) && /tencent-deploy/.test(w)), '回退时提示按 runbook 生成独立密钥');
    warns.length = 0;
    loadConfig(env({ NODE_ENV: 'production', ...both }));
    assert.equal(warns.length, 0);
    assert.throws(() => loadConfig(env({ NODE_ENV: 'production' })), /LICENCE_PRIVATE_KEY_PEM/);
  } finally { console.warn = orig; }
});

test('退役公钥：; 分隔的 SPKI PEM 与 , 分隔的 kid 一一对应；数量/重复/私钥/曲线校验；kid 不能与在用密钥重复；回退模式也能带', () => {
  const a = p256();
  const b = p256();
  const list = parseRetiredKeys(retiredEnv(`${a.publicPem};${b.publicPem}`, ' plg-0, plg-1 '));
  assert.deepEqual(list.map((r) => r.kid), ['plg-0', 'plg-1']);
  assert.deepEqual(list[0].publicKey.export({ format: 'jwk' }), a.publicKey.export({ format: 'jwk' }));
  assert.deepEqual(list[1].publicKey.export({ format: 'jwk' }), b.publicKey.export({ format: 'jwk' }));
  assert.equal(list[0].publicKey.type, 'public');
  assert.deepEqual(parseRetiredKeys({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(parseRetiredKeys(retiredEnv('', '')), []);
  assert.throws(() => parseRetiredKeys(retiredEnv(a.publicPem, 'plg-0,plg-1')), /数量不一致/);
  assert.throws(() => parseRetiredKeys(retiredEnv(`${a.publicPem};${b.publicPem}`, 'plg-0,plg-0')), /重复/);
  assert.throws(() => parseRetiredKeys(retiredEnv(a.privatePem, 'plg-0')), /私钥/);
  assert.throws(() => parseRetiredKeys(retiredEnv('garbage', 'plg-0')), /不是合法的公钥/);
  assert.throws(() => parseRetiredKeys(retiredEnv(a.publicPem, 'bad kid!')), /PLUGIN_SIGNING_RETIRED_KEY_IDS/);
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => parseRetiredKeys(retiredEnv(envPem(p384), 'plg-0')), /P-256/);

  const lic = p256();
  const plg = p256();
  const full = { LICENCE_PRIVATE_KEY_PEM: lic.privatePem, PLUGIN_SIGNING_PRIVATE_KEY_PEM: plg.privatePem, PLUGIN_SIGNING_KEY_ID: 'plg-2', ...retiredEnv(`${a.publicPem};${b.publicPem}`, 'plg-0,plg-1') } as Record<string, string>;
  const cfg = loadConfig(env(full));
  assert.deepEqual(buildJwks(cfg).keys.map((k) => k.kid), ['lic-test', 'plg-2', 'plg-0', 'plg-1'], '许可证、在用插件密钥、退役公钥，kid 互不相同');
  assert.deepEqual(buildJwks(cfg).keys.map((k) => [k.use, k.alg]), Array(4).fill(['sig', 'ES256']));
  assert.deepEqual(pluginSigningKeyInfo(cfg), { kid: 'plg-2', alg: 'ES256', dedicated: true, licenceKid: 'lic-test', retiredKids: ['plg-0', 'plg-1'], jwksPath: '/.well-known/licence-jwks.json' });
  assert.throws(() => loadConfig(env({ ...full, PLUGIN_SIGNING_RETIRED_KEY_IDS: 'plg-0,plg-2' })), /与在用密钥重复/);
  assert.throws(() => loadConfig(env({ ...full, PLUGIN_SIGNING_RETIRED_KEY_IDS: 'lic-test,plg-1' })), /与在用密钥重复/);
  // 还没配独立密钥、但已有退役公钥（例如先退役了一把旧密钥）也允许
  const fb = loadConfig(env({ LICENCE_PRIVATE_KEY_PEM: lic.privatePem, ...retiredEnv(a.publicPem, 'plg-0') }));
  assert.deepEqual(buildJwks(fb).keys.map((k) => k.kid), ['lic-test', 'plg-0']);
  assert.equal(fb.pluginSigningDedicated, false);
});

// ---------------------------------------------------------------------------
// HTTP：JWKS 发布全部公钥；签名用插件密钥；signing-key 只对 ADMIN；退役密钥的旧签名仍验得过；换钥后可重签
// ---------------------------------------------------------------------------
test('注册表用独立的插件密钥签名并报告 kid；JWKS 含许可证/插件/退役三把；signing-key 仅 ADMIN 且不含私钥；旧 kid 签名仍可验、可重签', async () => {
  const lic = p256();
  const plg = p256();
  const old = p256(); // 轮换前的插件签名密钥：私钥只在本测试里用来模拟"以前签出去的包"
  const s = await boot(env({
    LICENCE_PRIVATE_KEY_PEM: lic.privatePem,
    PLUGIN_SIGNING_PRIVATE_KEY_PEM: plg.privatePem, PLUGIN_SIGNING_KEY_ID: 'plg-test',
    PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM: old.publicPem, PLUGIN_SIGNING_RETIRED_KEY_IDS: 'plg-old',
  }));
  try {
    const ro = await s.makeAdmin('ro@example.com', 'READONLY');
    const op = await s.makeAdmin('op@example.com', 'OPERATOR');

    // JWKS：三把公钥，kid 各异，没有私钥分量
    const jwksRes = await s.call('/.well-known/licence-jwks.json');
    assert.equal(jwksRes.status, 200);
    const jwks = jwksRes.json as { keys: Record<string, unknown>[] };
    assert.deepEqual(jwks.keys.map((k) => k.kid), ['lic-test', 'plg-test', 'plg-old']);
    for (const k of jwks.keys) {
      assert.deepEqual([k.use, k.alg, k.kty, k.crv], ['sig', 'ES256', 'EC', 'P-256']);
      assert.equal(k.d, undefined);
    }
    assert.equal(jwks.keys[1].x, pubJwk(plg.privateKey).x);
    assert.equal(jwks.keys[2].x, old.publicKey.export({ format: 'jwk' }).x);

    // signing-key：无令牌 401，只读/运营 403，ADMIN 200；返回体没有任何密钥材料
    assert.equal((await s.call('/admin/plugins/signing-key')).status, 401);
    assert.equal((await s.call('/admin/plugins/signing-key', { token: ro })).status, 403);
    assert.equal((await s.call('/admin/plugins/signing-key', { token: op })).status, 403);
    const key = await s.call('/admin/plugins/signing-key', { token: s.root });
    assert.equal(key.status, 200, key.text);
    assert.deepEqual(key.json, { kid: 'plg-test', alg: 'ES256', dedicated: true, licenceKid: 'lic-test', retiredKids: ['plg-old'], jwksPath: '/.well-known/licence-jwks.json' });
    assert.doesNotMatch(key.text, /PRIVATE|BEGIN|"d"|"x"|"y"/);
    // 'signing-key' 不会被当成 :id
    assert.equal((await s.call('/admin/plugins/signing-key', { token: ro })).json.error, 'forbidden');

    // 目录的 kid 分工：插件目录报插件 kid，模型目录（许可证密钥签）仍是许可证 kid
    assert.equal((await s.call('/plugins/catalog')).json.kid, 'plg-test');
    assert.equal((await s.call('/catalog')).json.kid, 'lic-test');

    // 登记 -> 通过 -> 签名：kid = plg-test，且确实是插件密钥签的（许可证公钥验不过）
    const p = makePluginDir();
    const submission = { manifest: p.manifest, fileHashes: p.fileHashes, packageUrl: 'https://dl.example/acme-0.1.0.zip', sha256: SHA };
    const created = await s.call('/admin/plugins', { token: op, body: submission });
    assert.equal(created.status, 201, created.text);
    const v = created.json;
    assert.equal(v.kid, null);
    assert.equal((await s.call(`/admin/plugins/${v.id}/approve`, { token: op, body: { notes: '核对过指纹' } })).status, 200);
    assert.equal((await s.call(`/admin/plugins/${v.id}/sign`, { token: op, body: {} })).status, 403, '运营不能签名');
    const signed = await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: { notes: '首签' } });
    assert.equal(signed.status, 200, signed.text);
    assert.deepEqual([signed.json.signature.alg, signed.json.signature.kid, signed.json.kid], ['ES256', 'plg-test', 'plg-test']);
    assert.deepEqual(signed.json.signedManifest, { ...p.manifest, signature: signed.json.signature });
    const again = await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: {} });
    assert.equal(again.status, 409);
    assert.match(again.json.message, /plg-test/);
    const payload = pluginSigningPayload(p.manifest, p.fileHashes);
    assert.ok(verifyPluginPayload(payload, signed.json.signature, plg.publicKey));
    assert.equal(verifyPluginPayload(payload, signed.json.signature, lic.publicKey), false, '不是许可证密钥签的');
    assert.equal(verifyPluginPayload(payload, signed.json.signature, old.publicKey), false);

    // 作者把 signedManifest 写回包里 -> SDK 用公开的 JWKS 验出 official（新 kid）
    const cat = (await s.call('/plugins/catalog')).json;
    const cv = cat.plugins[0].versions[0];
    assert.deepEqual([cv.signed, cv.kid], [true, 'plg-test']);
    writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify(cv.manifest, null, 2));
    const r = sdk.verifySignature(cv.manifest, p.dir, jwks);
    assert.deepEqual([r.ok, r.status, r.kid, r.hash], [true, 'official', 'plg-test', v.hash]);
    // 客户端 JWKS 缓存里还没有新 kid：invalid（unknown kid），拉到新 JWKS 后才变 official（本地宿主的 refreshKeys 做这件事）
    const stale = { keys: jwks.keys.filter((k) => k.kid !== 'plg-test') };
    assert.deepEqual([sdk.verifySignature(cv.manifest, p.dir, stale).status, sdk.verifySignature(cv.manifest, p.dir, stale).reason], ['invalid', 'unknown kid']);

    // 退役密钥：轮换前签出去的包，靠 JWKS 里的退役公钥继续验得过；从 JWKS 拿掉退役公钥就验不过（这就是"作废只能换钥"）
    const legacy = makePluginDir('legacy', '1.0.0');
    const oldSig = signPluginPayload(pluginSigningPayload(legacy.manifest, legacy.fileHashes), old.privateKey, 'plg-old');
    const legacyManifest = { ...legacy.manifest, signature: oldSig };
    writeFileSync(join(legacy.dir, 'manifest.json'), JSON.stringify(legacyManifest, null, 2));
    const lr = sdk.verifySignature(legacyManifest, legacy.dir, jwks);
    assert.deepEqual([lr.ok, lr.status, lr.kid], [true, 'official', 'plg-old']);
    const withoutOld = { keys: jwks.keys.filter((k) => k.kid !== 'plg-old') };
    assert.deepEqual([sdk.verifySignature(legacyManifest, legacy.dir, withoutOld).status, sdk.verifySignature(legacyManifest, legacy.dir, withoutOld).reason], ['invalid', 'unknown kid']);

    // 换钥后重签：登记 legacy，模拟它曾用 plg-old 签过，当前 kid 不同所以允许再签，签完 kid 变成 plg-test
    const lc = await s.call('/admin/plugins', { token: s.root, body: { ...submission, manifest: legacy.manifest, fileHashes: legacy.fileHashes } });
    assert.equal(lc.status, 201, lc.text);
    assert.equal((await s.call(`/admin/plugins/${lc.json.id}/approve`, { token: s.root, body: {} })).status, 200);
    await s.repos.plugins.setSignature(lc.json.id, { signature: oldSig, signedAt: new Date('2026-09-01T00:00:00Z'), signedBy: 'old-admin' }, new Date('2026-09-01T00:00:00Z'));
    assert.equal((await s.call(`/admin/plugins/${lc.json.id}`, { token: ro })).json.kid, 'plg-old');
    const resigned = await s.call(`/admin/plugins/${lc.json.id}/sign`, { token: s.root, body: { notes: '轮换后重签' } });
    assert.equal(resigned.status, 200, resigned.text);
    assert.equal(resigned.json.kid, 'plg-test');
    assert.ok(verifyPluginPayload(pluginSigningPayload(legacy.manifest, legacy.fileHashes), resigned.json.signature, plg.publicKey));
    const detail = (await s.call(`/admin/plugins/${lc.json.id}`, { token: ro })).json;
    assert.deepEqual(detail.reviews.map((x: any) => x.action), ['submit', 'approve', 'sign']);

    // 审计：签名动作记录了 ADMIN 与对象；越权签名记 403
    const audit = (await s.call('/admin/audit?limit=200', { token: s.root })).json as any[];
    const sg = audit.filter((a) => a.action === 'POST /admin/plugins/:id/sign');
    assert.ok(sg.some((a) => a.ok && a.actorEmail === ADMIN.email && a.targetId === v.id));
    assert.ok(sg.some((a) => a.ok && a.targetId === lc.json.id && a.detail?.body?.notes === '轮换后重签'));
    assert.ok(sg.some((a) => !a.ok && a.status === 403 && a.actorEmail === 'op@example.com'));
    assert.equal(audit.some((a) => a.action.startsWith('GET ')), false, 'signing-key 等读接口不进审计');
  } finally { await s.close(); }
});

test('回退模式（没配 PLUGIN_SIGNING_PRIVATE_KEY_PEM）：签名 kid 等于许可证 kid，signing-key 报 dedicated=false', async () => {
  const lic = p256();
  const s = await boot(env({ LICENCE_PRIVATE_KEY_PEM: lic.privatePem }));
  try {
    const key = await s.call('/admin/plugins/signing-key', { token: s.root });
    assert.deepEqual(key.json, { kid: 'lic-test', alg: 'ES256', dedicated: false, licenceKid: 'lic-test', retiredKids: [], jwksPath: '/.well-known/licence-jwks.json' });
    assert.deepEqual((await s.call('/.well-known/licence-jwks.json')).json.keys.map((k: any) => k.kid), ['lic-test']);
    const p = makePluginDir();
    const v = (await s.call('/admin/plugins', { token: s.root, body: { manifest: p.manifest, fileHashes: p.fileHashes, packageUrl: 'https://dl.example/a.zip', sha256: SHA } })).json;
    await s.call(`/admin/plugins/${v.id}/approve`, { token: s.root, body: {} });
    const signed = await s.call(`/admin/plugins/${v.id}/sign`, { token: s.root, body: {} });
    assert.equal(signed.json.kid, 'lic-test');
    assert.ok(verifyPluginPayload(pluginSigningPayload(p.manifest, p.fileHashes), signed.json.signature, lic.publicKey));
  } finally { await s.close(); }
});
