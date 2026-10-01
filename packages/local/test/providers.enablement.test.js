'use strict';
// providers.enabled: the single switch for which providers are visible (registry, queue, referral, catalog, help text).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviders, createRegistry, ERROR_CODES } = require('../src/providers');
const en = require('../src/providers/enablement');
const { resolveKeyPage } = require('../src/cloud/referral');
const { bundledCatalog, createCatalogService, loadBundledPrices } = require('../src/cloud/catalog');
const { buildQueueProviders } = require('../src/queue');
const { validateSpec } = require('../src/routes/aiTasks');
const { toView } = require('../src/queue/taskView');
const { loadConfig } = require('../src/config');

test.afterEach(() => en.resetEnabled());

test('default is bailian only, from config.yaml and from the code default', () => {
  assert.deepEqual(en.DEFAULT_ENABLED, ['bailian']);
  assert.deepEqual(loadConfig().providers.enabled, ['bailian']);
  assert.deepEqual(en.getEnabled(), ['bailian']);
});

test('configureEnabled validates: unknown ids, non-arrays and empty lists are rejected', () => {
  assert.throws(() => en.configureEnabled(['bailian', 'nope']), /未知服务商/);
  assert.throws(() => en.configureEnabled('bailian'), /数组/);
  assert.throws(() => en.configureEnabled([]), /至少/);
  assert.deepEqual(en.configureEnabled({ providers: { enabled: ['ark', 'ark', 'bailian'] } }), ['ark', 'bailian']);
  assert.deepEqual(en.configureEnabled({}), ['bailian']); // missing section -> default
});

test('registry and facade hide ark unless enabled, and the adapter is not even built', () => {
  const ark = { apiKey: 'ak-test', fetch: async () => { throw new Error('no network'); } };
  let p = createProviders({ bailian: { apiKey: 'sk-test' }, ark });
  assert.deepEqual(p.registry.list().map((x) => x.id), ['bailian']);
  assert.throws(() => p.registry.get('ark'), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
  en.configureEnabled(['bailian', 'ark']);
  p = createProviders({ bailian: { apiKey: 'sk-test' }, ark });
  assert.deepEqual(p.registry.list().map((x) => x.id), ['bailian', 'ark']);
  const reg = createRegistry(['ark']); // a pinned set overrides the live setting
  reg.register({ id: 'bailian', capabilities: {} });
  assert.deepEqual(reg.list(), []);
});

test('queue providers, /ai-tasks validation, console links and key pages follow the setting', () => {
  const mkq = () => buildQueueProviders({ db: null, storageDir: '/tmp/x', listConfigs: () => [] });
  assert.deepEqual(Object.keys(mkq()), ['bailian']);
  const spec = { kind: 'image', params: { prompt: 'x' } };
  const row = { id: 1, provider: 'ark', kind: 'image', state: 'failed', params: '{}' };
  assert.match(validateSpec({ ...spec, provider: 'ark' }), /bailian/);
  assert.equal(validateSpec({ ...spec, provider: 'bailian' }), null);
  assert.equal(toView(row).console_url, null);
  assert.equal(resolveKeyPage({ baseUrl: '', provider: 'ark' }), null);
  assert.equal(resolveKeyPage({ baseUrl: '', provider: 'bailian' }).via, 'direct');
  en.configureEnabled(['bailian', 'ark']);
  assert.deepEqual(Object.keys(mkq()), ['bailian', 'ark']);
  assert.equal(validateSpec({ ...spec, provider: 'ark' }), null);
  assert.equal(toView(row).console_url, 'https://console.volcengine.com/ark');
  assert.equal(resolveKeyPage({ baseUrl: '', provider: 'ark' }).url, 'https://console.volcengine.com/ark');
});

test('model catalog lists enabled providers only, prices stay for history', () => {
  const prices = loadBundledPrices();
  const svc = createCatalogService({ db: null, http: {}, bundledPrices: prices });
  assert.ok(bundledCatalog(prices).providers.some((m) => m.id === 'ark')); // raw data still has ark
  const shown = svc.getCatalog({ backgroundRefresh: false });
  assert.deepEqual([...new Set(shown.models.map((m) => m.provider))], ['bailian']);
  assert.deepEqual(shown.providers.map((x) => x.id), ['bailian']);
  assert.ok(shown.prices.providers.ark);
  en.configureEnabled(['bailian', 'ark']);
  assert.deepEqual(svc.getCatalog({ backgroundRefresh: false }).providers.map((x) => x.id), ['bailian', 'ark']);
});

test('help text names only the enabled providers', () => {
  assert.equal(en.enabledLabels(), '阿里云百炼');
  en.configureEnabled(['bailian', 'ark']);
  assert.equal(en.enabledLabels(), '阿里云百炼或火山方舟');
  assert.equal(en.providerForAlias('Volces'), 'ark');
  en.configureEnabled(['bailian']);
  assert.equal(en.providerForAlias('volces'), null);
  assert.equal(en.providerForAlias('dashscope'), 'bailian');
});
