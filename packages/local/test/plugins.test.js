'use strict';
// P3-P: plugin host (scan / verify / developer mode / install / remove), provider wiring and the /plugins routes.
// Signing keys are generated per run; the fixture plugin is a standalone copy of the SDK example (fictional vendor).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const sdk = require('@talekiln/plugin-sdk');
const { mockHttp } = require('@talekiln/plugin-sdk/contract');
const { createPluginHost, resolvePluginsDir } = require('../src/plugins');
const pluginCurrent = require('../src/plugins/current');
const en = require('../src/providers/enablement');
const { createProviders, ERROR_CODES } = require('../src/providers');
const { validateSpec } = require('../src/routes/aiTasks');
const pluginRoutes = require('../src/routes/plugins');
const { createJwksProvider } = require('../src/cloud/jwks');
const { setGlobalSetting } = require('../src/services/settingsService');
const { createAiTaskStore, createAiTaskQueue, buildQueueProviders, withDownloads } = require('../src/queue');

const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'acme');
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '32_installed_plugins.sql'), 'utf8');
const AI_TASKS = fs.readFileSync(path.join(__dirname, '..', 'migrations', '23_ai_tasks.sql'), 'utf8');
const KEY = 'test-key-0123456789';
const log = { info() {}, warn() {}, error() {} };

function keyPair(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

/** Copy the fixture somewhere, optionally rename it and sign it. Returns the folder. */
function makePlugin(base, { name = 'acme', sign = null, kid = 'k1', tamper = false } = {}) {
  const dir = path.join(base, name);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const mp = path.join(dir, 'manifest.json');
  let manifest = { ...JSON.parse(fs.readFileSync(mp, 'utf8')), name };
  if (sign) manifest = sdk.signManifest(manifest, dir, sign, { kid }).manifest;
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  if (tamper) fs.appendFileSync(path.join(dir, 'index.js'), '\n// tampered\n');
  return dir;
}

function setup({ keys = [], http = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-'));
  const pluginsDir = path.join(base, 'data', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  db.exec(MIGRATION);
  db.exec(AI_TASKS);
  if (keys.length) setGlobalSetting(db, 'cloud.jwks', { keys });
  const jwks = createJwksProvider({ db, http: http || { request: async () => { throw new Error('offline'); } } });
  const changes = [];
  const host = createPluginHost({ db, log, jwks, cloudHttp: http, pluginsDir, fetchImpl: mockHttp({ status: 200, body: {} }), onChange: () => changes.push(1) });
  return { base, pluginsDir, db, host, changes, src: path.join(base, 'src') };
}

async function serve(host) {
  const h = pluginRoutes(host, log);
  const app = express();
  app.use(express.json());
  app.get('/plugins', h.list);
  app.post('/plugins/install', h.install);
  app.get('/plugins/:id', h.get);
  app.post('/plugins/:id/enable', h.enable);
  app.post('/plugins/:id/disable', h.disable);
  app.delete('/plugins/:id', h.remove);
  app.get('/settings/developer-mode', h.getDeveloperMode);
  app.put('/settings/developer-mode', h.putDeveloperMode);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close() };
}

describe('plugin host', () => {
  afterEach(() => { const h = pluginCurrent.current(); if (h) h.dispose(); en.resetEnabled(); });

  it('resolves the plugins dir from config.plugins.dir or ./data/plugins', () => {
    assert.equal(resolvePluginsDir({}, '/w'), path.join('/w', 'data', 'plugins'));
    assert.equal(resolvePluginsDir({ plugins: { dir: 'x/plugins' } }, '/w'), path.join('/w', 'x', 'plugins'));
    assert.equal(resolvePluginsDir({ plugins: { dir: '/abs/plugins' } }, '/w'), '/abs/plugins');
  });

  it('scan: an officially signed plugin is recorded, loaded and becomes an available provider', async () => {
    const k = keyPair('k1');
    const t = setup({ keys: [k.jwk] });
    makePlugin(t.pluginsDir, { sign: k.privateKey });
    const [p] = t.host.scan();
    assert.equal(p.id, 'acme');
    assert.equal(p.version, '0.1.0');
    assert.equal(p.label, 'Acme（测试夹具）');
    assert.deepEqual(p.signature, { status: 'official', kid: 'k1', hash: p.signature.hash, reason: null });
    assert.match(p.signature.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.capabilities, ['text.stream', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize']);
    assert.deepEqual(p.hosts, ['api.acme.example']);
    assert.equal(p.needs_api_key, true);
    assert.deepEqual([p.enabled, p.active, p.blocked_reason, p.reviewed_at], [true, true, null, null]);
    assert.ok(p.installed_at);
    assert.ok(t.changes.length >= 1);

    // provider wiring: enablement, /ai-tasks validation, registry and a real call over mocked HTTP
    assert.deepEqual(en.availableProviders(), ['bailian', 'acme']);
    assert.equal(en.isProviderAvailable('acme'), true);
    assert.deepEqual(en.getEnabled(), ['bailian'], 'built-in list is untouched (wizard, catalog)');
    assert.equal(validateSpec({ provider: 'acme', kind: 'image', params: { prompt: 'x' } }), null);
    assert.match(validateSpec({ provider: 'nope', kind: 'image', params: { prompt: 'x' } }), /bailian \/ acme/);
    const fetchMock = mockHttp({ status: 200, body: { data: [{ url: 'https://cdn.acme.example/a.png' }] } });
    const providers = createProviders({ bailian: { apiKey: 'sk-test' }, acme: { apiKey: KEY, fetch: fetchMock } });
    assert.deepEqual(providers.registry.list().map((x) => x.id), ['bailian', 'acme']);
    assert.deepEqual(await providers.image.generate('acme', { prompt: 'x' }), { urls: ['https://cdn.acme.example/a.png'] });
    assert.equal(fetchMock.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    const bad = createProviders({ acme: { apiKey: KEY, fetch: mockHttp({ status: 401, body: { error: { message: `nope ${KEY}` } } }) } });
    await assert.rejects(() => bad.image.generate('acme', { prompt: 'x' }), (e) => e.code === ERROR_CODES.INVALID_API_KEY && e.provider === 'acme' && !e.message.includes(KEY));
    // a plugin that is not configured is simply absent from that facade
    assert.throws(() => createProviders({ bailian: { apiKey: 'sk-test' } }).registry.get('acme'), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
  });

  it('unsigned plugin: recorded but not loaded until developer mode is on; switching it off unloads again', () => {
    const t = setup();
    makePlugin(t.pluginsDir);
    const [p] = t.host.scan();
    assert.equal(p.signature.status, 'unsigned');
    assert.equal(p.signature.reason, 'no signature');
    assert.match(p.signature.hash, /^[0-9a-f]{64}$/, 'content fingerprint even when unsigned');
    assert.deepEqual([p.enabled, p.active], [true, false]);
    assert.match(p.blocked_reason, /开发者模式/);
    assert.deepEqual(en.availableProviders(), ['bailian']);
    assert.equal(t.host.developerMode(), false);
    assert.equal(t.host.setDeveloperMode(true), true);
    assert.equal(t.host.get('acme').active, true);
    assert.deepEqual(en.availableProviders(), ['bailian', 'acme']);
    t.host.setDeveloperMode(false);
    assert.equal(t.host.get('acme').active, false);
    assert.equal(en.isProviderAvailable('acme'), false);
  });

  it('tampered file -> invalid signature, never loaded outside developer mode; rejected manifests and name clashes are skipped', () => {
    const k = keyPair('k1');
    const t = setup({ keys: [k.jwk] });
    makePlugin(t.pluginsDir, { sign: k.privateKey, tamper: true });
    makePlugin(t.pluginsDir, { name: 'bailian', sign: k.privateKey }); // clashes with a built-in id
    const broken = path.join(t.pluginsDir, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{"name":"broken"}');
    const list = t.host.scan();
    assert.deepEqual(list.map((p) => p.id), ['acme']);
    assert.deepEqual([list[0].signature.status, list[0].signature.reason, list[0].active], ['invalid', 'bad signature', false]);
    assert.deepEqual(en.availableProviders(), ['bailian']);
    t.host.setDeveloperMode(true);
    assert.equal(t.host.get('acme').active, true);
    assert.deepEqual(en.availableProviders(), ['bailian', 'acme'], 'a plugin can never shadow bailian');
  });

  it('unknown kid: invalid offline, re-verified after the JWKS is fetched', async () => {
    const k2 = keyPair('k2');
    const calls = [];
    const http = { request: async (m, p) => { calls.push(`${m} ${p}`); return { keys: [k2.jwk] }; } };
    const t = setup({ http });
    makePlugin(t.pluginsDir, { sign: k2.privateKey, kid: 'k2' });
    const [p] = t.host.scan();
    assert.deepEqual([p.signature.status, p.signature.reason, p.signature.kid, p.active], ['invalid', 'unknown kid', 'k2', false]);
    assert.deepEqual(await t.host.refreshKeys(), { checked: 1, updated: 1 });
    assert.deepEqual(calls, ['GET /.well-known/licence-jwks.json']);
    const after = t.host.get('acme');
    assert.deepEqual([after.signature.status, after.active], ['official', true]);
    assert.deepEqual(await t.host.refreshKeys(), { checked: 0, updated: 0 }, 'nothing left to check');
    // next scan uses the cached key: stays official without network
    t.host.dispose();
    const again = createPluginHost({ db: t.db, log, jwks: createJwksProvider({ db: t.db, http: { request: async () => { throw new Error('offline'); } } }), pluginsDir: t.pluginsDir });
    assert.equal(again.scan()[0].signature.status, 'official');
  });

  it('official JWKS with several keys (licence, dedicated plugin key, retired plugin key): any listed kid verifies, unlisted ones stay invalid', () => {
    // The cloud publishes the licence key plus the dedicated plugin signing key (and retired plugin keys) in one JWKS.
    const lic = keyPair('lic-1');
    const plg = keyPair('plg-1');
    const old = keyPair('plg-0');
    const gone = keyPair('plg-gone'); // rotated out AND removed from the JWKS: its signatures are no longer trusted
    const t = setup({ keys: [lic.jwk, plg.jwk, old.jwk] });
    makePlugin(t.pluginsDir, { name: 'acme', sign: plg.privateKey, kid: 'plg-1' });
    makePlugin(t.pluginsDir, { name: 'beta', sign: old.privateKey, kid: 'plg-0' });
    makePlugin(t.pluginsDir, { name: 'gamma', sign: lic.privateKey, kid: 'lic-1' });
    makePlugin(t.pluginsDir, { name: 'delta', sign: gone.privateKey, kid: 'plg-gone' });
    makePlugin(t.pluginsDir, { name: 'epsilon', sign: gone.privateKey, kid: 'plg-1' }); // claims the new kid but was not signed by it
    const byName = Object.fromEntries(t.host.scan().map((p) => [p.name, p]));
    assert.deepEqual([byName.acme.signature.status, byName.acme.signature.kid, byName.acme.active], ['official', 'plg-1', true]);
    assert.deepEqual([byName.beta.signature.status, byName.beta.signature.kid, byName.beta.active], ['official', 'plg-0', true]);
    assert.deepEqual([byName.gamma.signature.status, byName.gamma.signature.kid, byName.gamma.active], ['official', 'lic-1', true]);
    assert.deepEqual([byName.delta.signature.status, byName.delta.signature.reason, byName.delta.active], ['invalid', 'unknown kid', false]);
    assert.deepEqual([byName.epsilon.signature.status, byName.epsilon.signature.reason, byName.epsilon.active], ['invalid', 'bad signature', false]);
    assert.deepEqual(en.availableProviders().filter((id) => ['acme', 'beta', 'gamma', 'delta', 'epsilon'].includes(id)).sort(), ['acme', 'beta', 'gamma']);
  });

  it('catalogue sync: the review date of a matching fingerprint is stamped on the installed plugin; nothing else changes', async () => {
    const k = keyPair('k1');
    const calls = [];
    const catalog = { plugins: [] };
    const http = { request: async (m, p) => { calls.push(`${m} ${p}`); if (p === '/plugins/catalog') return catalog; return { keys: [k.jwk] }; } };
    const t = setup({ keys: [k.jwk], http });
    makePlugin(t.pluginsDir, { sign: k.privateKey, kid: 'k1' });
    const [p] = t.host.scan();
    assert.equal(p.reviewed_at, null);
    assert.deepEqual(await t.host.refreshCatalog(), { matched: 0 }, 'empty catalogue');
    catalog.plugins = [
      { name: 'other', versions: [{ hash: 'f'.repeat(64), reviewedAt: '2026-09-01T00:00:00.000Z' }] },
      { name: 'acme', versions: [{ hash: p.signature.hash, reviewedAt: '2026-10-01T12:00:00.000Z', signed: true }, { hash: 'e'.repeat(64), reviewedAt: '2026-10-02T00:00:00.000Z' }] },
    ];
    assert.deepEqual(await t.host.refreshCatalog(), { matched: 1 });
    assert.deepEqual(calls, ['GET /plugins/catalog', 'GET /plugins/catalog']);
    const after = t.host.get('acme');
    assert.deepEqual([after.reviewed_at, after.signature.status, after.enabled, after.active], ['2026-10-01T12:00:00.000Z', 'official', true, true]);
    // survives a rescan; a host without a cloud client is a no-op; a malformed catalogue matches nothing
    assert.equal(t.host.scan()[0].reviewed_at, '2026-10-01T12:00:00.000Z');
    t.host.dispose();
    const offline = createPluginHost({ db: t.db, log, pluginsDir: t.pluginsDir });
    assert.deepEqual(await offline.refreshCatalog(), { matched: 0 });
    offline.dispose();
    const weird = createPluginHost({ db: t.db, log, cloudHttp: { request: async () => ({ plugins: 'nope' }) }, pluginsDir: t.pluginsDir });
    assert.deepEqual(await weird.refreshCatalog(), { matched: 0 });
    assert.equal(weird.scan()[0].reviewed_at, '2026-10-01T12:00:00.000Z', 'a bad catalogue never clears a known date');
  });

  it('switches persist across scans; a folder removed by hand drops its row; a stale load is replaced on upgrade', () => {
    const k = keyPair('k1');
    const t = setup({ keys: [k.jwk] });
    const dir = makePlugin(t.pluginsDir, { sign: k.privateKey });
    t.host.scan();
    t.host.setEnabled('acme', false);
    assert.deepEqual([t.host.get('acme').enabled, t.host.get('acme').active], [false, false]);
    assert.equal(en.isProviderAvailable('acme'), false);
    t.host.scan();
    assert.equal(t.host.get('acme').enabled, false, 're-scan keeps the switch off');
    t.host.setEnabled('acme', true);
    assert.equal(t.host.get('acme').active, true);
    assert.throws(() => t.host.setEnabled('nope', true), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    // upgrade in place: new version is signed and replaces the loaded module
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'index.js'), fs.readFileSync(path.join(dir, 'index.js'), 'utf8').replace("'acme-img-1'", "'acme-img-2'"));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(sdk.signManifest({ ...m, version: '0.2.0' }, dir, k.privateKey, { kid: 'k1' }).manifest));
    t.host.scan();
    assert.deepEqual([t.host.get('acme').version, t.host.get('acme').signature.status, t.host.get('acme').active], ['0.2.0', 'official', true]);
    const f = mockHttp({ status: 200, body: { data: [{ url: 'https://cdn.acme.example/b.png' }] } });
    return createProviders({ acme: { apiKey: KEY, fetch: f } }).image.generate('acme', { prompt: 'x' }).then(() => {
      assert.equal(JSON.parse(f.calls[0].init.body).model, 'acme-img-2', 'fresh code, not the require-cached old module');
      fs.rmSync(dir, { recursive: true });
      assert.deepEqual(t.host.scan(), []);
      assert.equal(en.isProviderAvailable('acme'), false);
    });
  });

  it('routes: list, install from a folder (copied into the plugins dir), enable/disable, delete, developer mode', async () => {
    const k = keyPair('k1');
    const t = setup({ keys: [k.jwk] });
    t.host.scan();
    const s = await serve(t.host);
    try {
      let r = await s.call('GET', '/plugins');
      assert.deepEqual(r.body.data, { items: [], developer_mode: false, plugins_dir: t.pluginsDir });

      const srcSigned = makePlugin(t.src, { sign: k.privateKey });
      r = await s.call('POST', '/plugins/install', { dir: srcSigned });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.id, 'acme');
      assert.equal(r.body.data.dir, path.join(t.pluginsDir, 'acme'));
      assert.ok(fs.existsSync(path.join(t.pluginsDir, 'acme', 'index.js')), 'copied into the plugins dir');
      assert.deepEqual([r.body.data.signature.status, r.body.data.active], ['official', true]);
      assert.equal(en.isProviderAvailable('acme'), true);

      r = await s.call('GET', '/plugins/acme');
      assert.equal(r.body.data.version, '0.1.0');
      assert.equal((await s.call('GET', '/plugins/nope')).status, 404);

      r = await s.call('POST', '/plugins/acme/disable');
      assert.deepEqual([r.body.data.enabled, r.body.data.active], [false, false]);
      assert.equal(en.isProviderAvailable('acme'), false);
      r = await s.call('POST', '/plugins/acme/enable');
      assert.deepEqual([r.body.data.enabled, r.body.data.active], [true, true]);

      // unsigned package: refused unless developer mode; invalid folder / missing dir / name clash
      const srcUnsigned = makePlugin(path.join(t.base, 'src2'), { name: 'beta' });
      r = await s.call('POST', '/plugins/install', { dir: srcUnsigned });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'PLUGIN_SIGNATURE');
      assert.ok(r.body.error.action, 'error table action attached');
      assert.ok(!fs.existsSync(path.join(t.pluginsDir, 'beta')), 'nothing copied');
      assert.equal((await s.call('POST', '/plugins/install', {})).status, 400);
      assert.equal((await s.call('POST', '/plugins/install', { dir: path.join(t.base, 'missing') })).body.error.code, 'PLUGIN_INVALID');
      fs.mkdirSync(path.join(t.base, 'empty'));
      assert.equal((await s.call('POST', '/plugins/install', { dir: path.join(t.base, 'empty') })).body.error.code, 'PLUGIN_INVALID');
      const clash = makePlugin(path.join(t.base, 'src3'), { name: 'ark', sign: k.privateKey });
      r = await s.call('POST', '/plugins/install', { dir: clash });
      assert.deepEqual([r.status, r.body.error.code], [409, 'PLUGIN_NAME_CONFLICT']);

      r = await s.call('PUT', '/settings/developer-mode', { developer_mode: true });
      assert.equal(r.body.data.developer_mode, true);
      assert.equal((await s.call('GET', '/settings/developer-mode')).body.data.developer_mode, true);
      assert.equal((await s.call('PUT', '/settings/developer-mode', { developer_mode: 'yes' })).status, 400);
      r = await s.call('POST', '/plugins/install', { dir: srcUnsigned });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.data.id, r.body.data.signature.status, r.body.data.active], ['beta', 'unsigned', true]);
      assert.deepEqual(en.availableProviders(), ['bailian', 'acme', 'beta']);
      r = await s.call('GET', '/plugins');
      assert.deepEqual(r.body.data.items.map((p) => p.id), ['acme', 'beta']);

      r = await s.call('DELETE', '/plugins/beta');
      assert.deepEqual(r.body.data, { id: 'beta', removed: true });
      assert.ok(!fs.existsSync(path.join(t.pluginsDir, 'beta')));
      assert.equal((await s.call('DELETE', '/plugins/beta')).status, 404);
      assert.deepEqual(en.availableProviders(), ['bailian', 'acme']);
      r = await s.call('PUT', '/settings/developer-mode', { developer_mode: false });
      assert.deepEqual(r.body.data.items.map((p) => [p.id, p.active]), [['acme', true]]);
    } finally { s.close(); }
  });

  it('queue: an active plugin gets a queue provider and runs an image task with the saved config key', async () => {
    const k = keyPair('k1');
    const t = setup({ keys: [k.jwk] });
    makePlugin(t.pluginsDir, { sign: k.privateKey });
    t.host.scan();
    const configs = { image: [{ id: 1, provider: 'acme', service_type: 'image', api_key: KEY, base_url: '', is_active: true, default_model: 'acme-img-9', model: [] }] };
    const fetchMock = mockHttp({ status: 200, body: { data: [{ url: 'https://cdn.acme.example/a.png' }] } });
    const storageDir = path.join(t.base, 'storage');
    const raw = buildQueueProviders({ db: t.db, storageDir, listConfigs: (type) => configs[type] || [], createProviders: (cfg) => createProviders({ ...cfg, acme: { ...cfg.acme, fetch: fetchMock } }) });
    assert.deepEqual(Object.keys(raw), ['bailian', 'acme']);
    const downloader = { download: async (url) => ({ sha256: 'x'.repeat(64), size: 1, path: `blobs/xx/${path.basename(url)}` }) };
    const store = createAiTaskStore(t.db);
    const queue = createAiTaskQueue({ store, providers: withDownloads(raw, downloader) });
    const { task } = store.enqueue({ idempotencyKey: 'i1', provider: 'acme', kind: 'image', params: { prompt: 'hi' } });
    for (let i = 0; i < 6; i++) await queue.tick();
    const row = store.get(task.id);
    assert.equal(row.state, 'succeeded', row.error_message);
    assert.equal(JSON.parse(row.result).files[0].url, 'https://cdn.acme.example/a.png');
    assert.equal(JSON.parse(fetchMock.calls[0].init.body).model, 'acme-img-9', 'default model from the saved config');
    assert.equal(fetchMock.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    // switched off: the queue provider stays but the registry refuses -> readable failure, no crash
    t.host.setEnabled('acme', false);
    const { task: t2 } = store.enqueue({ idempotencyKey: 'i2', provider: 'acme', kind: 'image', params: { prompt: 'hi' } });
    for (let i = 0; i < 6; i++) await queue.tick();
    assert.equal(store.get(t2.id).state, 'failed');
    assert.equal(store.get(t2.id).error_code, ERROR_CODES.PROVIDER_NOT_AVAILABLE);
  });

  it('enablement helpers: plugins extend but never shadow built-ins; reset clears the hook', () => {
    en.registerPluginProviders(() => ['acme', 'bailian', 'ark', 7]);
    assert.deepEqual(en.activePluginIds(), ['acme']);
    assert.deepEqual(en.availableProviders(), ['bailian', 'acme']);
    assert.equal(en.isProviderAvailable('ark'), false, 'ark is hidden unless enabled, even if a plugin claims the id');
    assert.equal(en.isBuiltin('ark') && !en.isBuiltin('acme'), true);
    en.registerPluginProviders(() => { throw new Error('boom'); });
    assert.deepEqual(en.availableProviders(), ['bailian']);
    en.resetEnabled();
    en.registerPluginProviders(() => ['acme']);
    en.resetEnabled();
    assert.deepEqual(en.availableProviders(), ['bailian']);
  });
});
