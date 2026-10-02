'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createCloud } = require('../src/cloud');
const { createEstimator } = require('../src/spend');
const { resolveKeyPage, DIRECT_KEY_PAGES } = require('../src/cloud/referral');
const { activeAnnouncements, loadBundledPrices } = require('../src/cloud/catalog');
const { catalogVersion, canonicalJson } = require('../src/cloud/jws');
const cloudRoutes = require('../src/routes/cloud');
const { startMockCloud } = require('./helpers/mockCloud');

const T0 = Date.UTC(2026, 9, 1);
const REMOTE = {
  providers: [{ id: 'bailian', name: '阿里云百炼', key_url_code: 'bailian' }],
  models: [
    { provider: 'bailian', service_type: 'video', id: 'wan9-t2v', label: '万相 9 文生视频' },
    { provider: 'bailian', service_type: 'text', id: 'qwen-max', label: '通义千问 Max' },
  ],
  prices: {
    version: 'cloud-2026-10-02', currency: 'CNY', sample: false, max_factor: 1.1,
    providers: { bailian: { video: { 'wan9-t2v': { per: 'second', price: 1 }, _default: { per: 'second', price: 2 } } } },
  },
  announcements: [
    { id: 'a1', level: 'info', title: '已上线', body: 'x', starts_at: '2026-09-01T00:00:00Z', ends_at: null },
    { id: 'a2', level: 'warn', title: '已结束', body: 'x', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-09-01T00:00:00Z' },
    { id: 'a3', level: 'info', title: '未开始', body: 'x', starts_at: '2026-11-01T00:00:00Z', ends_at: null },
  ],
};

async function setup() {
  let clock = T0;
  const now = () => clock;
  const mock = await startMockCloud({ now });
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  const cloud = createCloud({ config: { cloud: { base_url: mock.url } }, db, log: {}, now });
  return { mock, db, cloud, advance: (ms) => { clock += ms; } };
}

describe('catalog', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.mock.close(); });

  it('falls back to the bundled prices.json when there is no cache and no cloud', () => {
    ctx.mock.st.down = true;
    const c = ctx.cloud.catalog.getCatalog({ backgroundRefresh: false });
    const bundled = loadBundledPrices();
    assert.equal(c.source, 'bundled');
    assert.equal(c.version, bundled.version);
    assert.equal(c.sample_prices, false); // 内置价目已是百炼公开价（prices.sample === false）
    assert.ok(c.models.some((m) => m.provider === 'bailian' && m.service_type === 'video' && m.id === 'wan2.6-t2v'));
    assert.ok(!c.models.some((m) => m.id.startsWith('_')));
    assert.deepEqual(ctx.cloud.catalog.effectivePrices(), bundled);
  });

  it('fetches, verifies and caches the cloud catalog; models and prices come from the cloud afterwards', async () => {
    ctx.mock.st.catalog = { data: REMOTE };
    const r = await ctx.cloud.catalog.refresh();
    assert.deepEqual({ ok: r.ok, changed: r.changed }, { ok: true, changed: true });
    ctx.mock.st.down = true; // 之后离线也用缓存
    const c = ctx.cloud.catalog.getCatalog({ backgroundRefresh: false });
    assert.equal(c.source, 'cloud');
    assert.deepEqual(c.models.map((m) => m.id), ['wan9-t2v', 'qwen-max']);
    assert.equal(c.sample_prices, false);
    assert.deepEqual(c.announcements.map((a) => a.id), ['a1']);
    const est = createEstimator(ctx.cloud.catalog.effectivePrices()).estimate({ provider: 'bailian', kind: 'video', params: { model: 'wan9-t2v', duration: 10 } });
    assert.equal(est.estimate, 10);
    assert.equal(est.max, 11);
    assert.equal(est.price_version, 'cloud-2026-10-02');
  });

  it('uses since= so an unchanged catalog is not re-downloaded', async () => {
    ctx.mock.st.catalog = { data: REMOTE };
    await ctx.cloud.catalog.refresh();
    const again = await ctx.cloud.catalog.refresh();
    assert.deepEqual({ ok: again.ok, changed: again.changed }, { ok: true, changed: false });
  });

  it('rejects a catalog whose content does not match its version', async () => {
    const doc = ctx.mock.signCatalog(REMOTE);
    doc.catalog = { ...REMOTE, prices: { ...REMOTE.prices, providers: { bailian: { video: { _default: { per: 'second', price: 0.0001 } } } } } };
    ctx.mock.st.catalog = { raw: doc };
    const r = await ctx.cloud.catalog.refresh();
    assert.equal(r.reason, 'invalid');
    assert.equal(ctx.cloud.catalog.getCatalog({ backgroundRefresh: false }).source, 'bundled');
  });

  it('rejects a catalog signed by a different key', async () => {
    const evil = ctx.mock.newKeyPair();
    const version = catalogVersion(REMOTE);
    ctx.mock.st.catalog = { raw: { version, kid: 'k1', catalog: REMOTE, signature: ctx.mock.es256Sign({ alg: 'ES256', kid: 'k1' }, version, evil.privateKey) } };
    assert.equal((await ctx.cloud.catalog.refresh()).reason, 'invalid');
    assert.equal(ctx.cloud.catalog.getCatalog({ backgroundRefresh: false }).source, 'bundled');
  });

  it('rejects a signature that covers a different version', async () => {
    const other = ctx.mock.signCatalog({ ...REMOTE, announcements: [] });
    ctx.mock.st.catalog = { raw: { ...ctx.mock.signCatalog(REMOTE), signature: other.signature } };
    assert.equal((await ctx.cloud.catalog.refresh()).reason, 'invalid');
  });

  it('rejects structurally invalid catalogs even when correctly signed', async () => {
    ctx.mock.st.catalog = { data: { ...REMOTE, models: [{ provider: 'x', service_type: 'bogus', id: 'm' }] } };
    assert.equal((await ctx.cloud.catalog.refresh()).reason, 'invalid');
  });

  it('keeps the previous cache when a refresh fails or is invalid', async () => {
    ctx.mock.st.catalog = { data: REMOTE };
    await ctx.cloud.catalog.refresh();
    ctx.mock.st.down = true;
    assert.equal((await ctx.cloud.catalog.refresh()).reason, 'network');
    assert.equal(ctx.cloud.catalog.getCatalog({ backgroundRefresh: false }).source, 'cloud');
  });

  it('ignores a cache row that was edited on disk', async () => {
    ctx.mock.st.catalog = { data: REMOTE };
    await ctx.cloud.catalog.refresh();
    const row = JSON.parse(ctx.db.prepare("SELECT value FROM global_settings WHERE key='cloud.catalog_cache'").get().value);
    row.catalog.prices.providers.bailian.video._default.price = 0;
    ctx.db.prepare("UPDATE global_settings SET value=? WHERE key='cloud.catalog_cache'").run(JSON.stringify(row));
    assert.equal(ctx.cloud.catalog.getCatalog({ backgroundRefresh: false }).source, 'bundled');
  });

  it('refreshes in the background when the cache is stale', async () => {
    ctx.mock.st.catalog = { data: REMOTE };
    ctx.cloud.catalog.getCatalog(); // 无缓存：触发后台刷新
    await ctx.cloud.catalog.refresh(); // 与进行中的刷新合并
    assert.equal(ctx.cloud.catalog.getCatalog({ backgroundRefresh: false }).source, 'cloud');
    ctx.advance(7 * 3600_000);
    const before = ctx.mock.st.calls.filter((c) => c === 'GET /catalog').length;
    ctx.cloud.catalog.getCatalog();
    await ctx.cloud.catalog.refresh();
    assert.ok(ctx.mock.st.calls.filter((c) => c === 'GET /catalog').length > before);
  });

  it('filters announcements by their window', () => {
    assert.deepEqual(activeAnnouncements(REMOTE.announcements, T0).map((a) => a.id), ['a1']);
  });

  it('canonical JSON matches the cloud implementation', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  });
});

describe('catalog and referral routes', () => {
  let ctx; let server; let base;
  beforeEach(async () => {
    ctx = await setup();
    ctx.mock.st.catalog = { data: REMOTE };
    const app = express();
    app.use(express.json());
    const c = cloudRoutes(ctx.cloud, { error() {}, warn() {} });
    app.get('/catalog', c.catalog);
    app.post('/catalog/refresh', c.catalogRefresh);
    app.get('/referral/:provider', c.referral);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { server.close(); await ctx.mock.close(); });

  it('POST /catalog/refresh then GET /catalog serves the cloud data', async () => {
    const r = await (await fetch(`${base}/catalog/refresh`, { method: 'POST' })).json();
    assert.equal(r.data.refresh.ok, true);
    assert.equal(r.data.catalog.source, 'cloud');
    const g = await (await fetch(`${base}/catalog`)).json();
    assert.equal(g.data.models[0].id, 'wan9-t2v');
  });

  it('GET /referral/:provider returns direct pages when the cloud is a placeholder, 404 for unknown', async () => {
    const cloud = createCloud({ config: { cloud: {} }, db: ctx.db, log: {} });
    const app = express();
    app.get('/referral/:provider', cloudRoutes(cloud, {}).referral);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const b = `http://127.0.0.1:${s.address().port}`;
    assert.deepEqual((await (await fetch(`${b}/referral/bailian`)).json()).data, { url: DIRECT_KEY_PAGES.bailian, via: 'direct' });
    assert.equal((await fetch(`${b}/referral/unknown`)).status, 404);
    s.close();
  });
});

describe('referral key-page helper', () => {
  it('routes through the cloud /r/:code when configured, tagging the source', () => {
    const r = resolveKeyPage({ baseUrl: 'https://cloud.mytalekiln.com/', provider: 'Bailian' });
    assert.deepEqual(r, { url: 'https://cloud.mytalekiln.com/r/bailian?src=addkey', via: 'referral' });
  });

  it('keeps a base URL path prefix', () => {
    assert.equal(resolveKeyPage({ baseUrl: 'https://h.mytalekiln.com/api', provider: 'bailian' }).url, 'https://h.mytalekiln.com/api/r/bailian?src=addkey');
  });

  it('uses the official key page when the cloud is unset, a placeholder, or plain http', () => {
    for (const baseUrl of ['', 'https://cloud.talekiln.example', 'http://127.0.0.1:3000', 'ftp://x.com']) {
      assert.deepEqual(resolveKeyPage({ baseUrl, provider: 'bailian' }), { url: DIRECT_KEY_PAGES.bailian, via: 'direct' }, baseUrl);
    }
  });

  it('refuses malformed or unknown provider ids and never builds a URL from them', () => {
    for (const p of ['', '../x', 'a/b', 'https://evil.com', 'a b', 'x'.repeat(41)]) {
      assert.equal(resolveKeyPage({ baseUrl: 'https://cloud.mytalekiln.com', provider: p }), null, p);
    }
    assert.equal(resolveKeyPage({ baseUrl: '', provider: 'nope' }), null);
    assert.equal(resolveKeyPage({ baseUrl: '', provider: '__proto__' }), null);
  });

  it('sanitises src', () => {
    const r = resolveKeyPage({ baseUrl: 'https://cloud.mytalekiln.com', provider: 'bailian', src: 'a b&c=d' });
    assert.equal(new URL(r.url).searchParams.get('src'), 'abcd');
  });
});
