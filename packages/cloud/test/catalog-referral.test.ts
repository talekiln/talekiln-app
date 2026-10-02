import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactVerify, importJWK } from 'jose';
import { makeRepos } from './helpers/repos';
import { CatalogService, DEFAULT_CATALOG, canonicalJson, catalogVersion } from '../src/services/catalog.service';
import { loadConfig } from '../src/services/config';
import { LicenceService } from '../src/services/licence.service';
import { ReferralService, assertAllowedTarget, loadReferralConfig } from '../src/services/referral.service';
import { ServiceError } from '../src/services/errors';

const cfg = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;

test('目录：版本是内容哈希，签名可用 JWKS 公钥验证，since 命中返回 unchanged', async () => {
  const svc = new CatalogService(cfg, DEFAULT_CATALOG, () => new Date('2026-10-01T00:00:00Z'));
  const r = await svc.get();
  assert.equal(r.version, catalogVersion(r.catalog));
  assert.equal(r.catalog!.prices.sample, true);
  const jwk = new LicenceService(await makeRepos(), cfg).jwks().keys[0];
  const { payload } = await compactVerify(r.signature!, await importJWK(jwk, 'ES256'));
  assert.equal(new TextDecoder().decode(payload), r.version);
  assert.deepEqual(await svc.get(r.version), { version: r.version, unchanged: true });
  assert.ok((await svc.get('c-stale')).catalog);
});

test('目录：内容变化则版本变化；键序不影响版本；非法目录被拒', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const changed = { ...DEFAULT_CATALOG, announcements: [{ id: 'a1', level: 'info' as const, title: 't', body: 'b', starts_at: null, ends_at: null }] };
  assert.notEqual(new CatalogService(cfg, changed).version, new CatalogService(cfg).version);
  assert.throws(() => new CatalogService(cfg, { ...DEFAULT_CATALOG, models: [{ provider: 'x', service_type: 'bad', id: 'a', label: 'b' }] } as never));
});

test('推广：已知码记录点击并返回配置目标；未知码 404；src 被清洗', async () => {
  const repos = await makeRepos();
  const svc = new ReferralService(loadReferralConfig(env()), repos.referralClicks);
  assert.equal(await svc.resolve('ARK', 'addkey'), 'https://console.volcengine.com/ark');
  assert.equal(await repos.referralClicks.countByCode('ark'), 1);
  await svc.resolve('ark', '<script>');
  assert.equal(await repos.referralClicks.countByCode('ark'), 2);
  for (const bad of ['nope', '__proto__', 'constructor', 'https://evil.example', '../x', '']) {
    await assert.rejects(svc.resolve(bad), (e) => e instanceof ServiceError && e.code === 'not_found');
  }
});

test('推广：目标必须 https、无凭据、主机命中白名单（无开放重定向）', () => {
  const hosts = new Set(['console.volcengine.com']);
  assert.ok(assertAllowedTarget('https://console.volcengine.com/ark?ref=1', hosts));
  assert.throws(() => assertAllowedTarget('http://console.volcengine.com/', hosts), /https/);
  assert.throws(() => assertAllowedTarget('https://evil.example/', hosts), /白名单/);
  assert.throws(() => assertAllowedTarget('https://console.volcengine.com.evil.example/', hosts), /白名单/);
  assert.throws(() => assertAllowedTarget('https://console.volcengine.com@evil.example/', hosts), /白名单|用户名/);
  assert.throws(() => assertAllowedTarget('https://user:pw@console.volcengine.com/', hosts), /用户名/);
  assert.throws(() => assertAllowedTarget('javascript:alert(1)', hosts));
});

test('推广配置：REFERRAL_LINKS 覆盖需在白名单内，否则启动失败', () => {
  const ok = loadReferralConfig(env({ REFERRAL_LINKS: '{"ark":"https://console.volcengine.com/ark?ref=abc"}' }));
  assert.match(ok.links.get('ark')!, /ref=abc/);
  assert.throws(() => loadReferralConfig(env({ REFERRAL_LINKS: '{"ark":"https://evil.example/"}' })), /白名单/);
  const extended = loadReferralConfig(env({
    REFERRAL_ALLOWED_HOSTS: 'partner.example.com', REFERRAL_LINKS: '{"p":"https://partner.example.com/x"}',
  }));
  assert.ok(extended.links.has('p'));
  assert.throws(() => loadReferralConfig(env({ REFERRAL_LINKS: '{"Bad Code":"https://console.volcengine.com/"}' })), /推广码/);
});

test('推广：点击记录失败不阻断跳转', async () => {
  const svc = new ReferralService(loadReferralConfig(env()), {
    create: async () => { throw new Error('db down'); }, countByCode: async () => 0, between: async () => [],
  });
  const orig = console.error;
  console.error = () => {};
  try { assert.ok(await svc.resolve('bailian')); } finally { console.error = orig; }
});
