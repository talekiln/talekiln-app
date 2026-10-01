'use strict';
// P2-G: an SDK plugin adapter registered into the existing registry through the bridge.
// Existing providers are untouched; the plugin id is pinned via createRegistry(enabledIds).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRegistry } = require('../src/providers/registry');
const { ProviderError, ERROR_CODES } = require('../src/providers/errors');
const sdk = require('../../plugin-sdk/src');
const { toRegistryAdapter } = require('../../plugin-sdk/src/bridge');
const { mockHttp } = require('../../plugin-sdk/src/contract');

const KEY = 'test-key-0123456789';
const plugin = sdk.loadPlugin(path.join(__dirname, '..', '..', 'plugin-sdk', 'examples', 'acme'));

function registryWith(responder) {
  const fetch = mockHttp(responder);
  const adapter = toRegistryAdapter(sdk.instantiate(plugin, { apiKey: KEY, fetch }), { ProviderError, secrets: [KEY] });
  const registry = createRegistry(['acme']).register(adapter);
  return { registry, fetch };
}

test('registry accepts the bridged adapter and lists its host-side capability names', () => {
  const { registry } = registryWith({ status: 200, body: {} });
  const [entry] = registry.list();
  assert.equal(entry.id, 'acme');
  assert.deepEqual(entry.capabilities.sort(), ['image.generate', 'text.stream', 'tts.synthesize', 'video.poll', 'video.submit']);
});

test('registry.call image.generate and text.stream work end to end over mocked HTTP', async () => {
  const img = registryWith({ status: 200, body: { data: [{ url: 'https://cdn.acme.example/a.png' }] } });
  assert.deepEqual(await img.registry.call('acme', 'image.generate', { prompt: 'x' }), { urls: ['https://cdn.acme.example/a.png'] });
  assert.equal(img.fetch.calls[0].init.headers.Authorization, `Bearer ${KEY}`);

  const chat = registryWith({ status: 200, body: { text: 'hi' } });
  const evs = [];
  for await (const e of chat.registry.call('acme', 'text.stream', { messages: [] })) evs.push(e.type);
  assert.deepEqual(evs, ['delta', 'done']);
});

test('errors surface as the host ProviderError with unified codes and no key', async () => {
  const { registry } = registryWith({ status: 403, body: { error: { code: 'arrears', message: `account in arrears ${KEY}` } } });
  await assert.rejects(() => registry.call('acme', 'image.generate', { prompt: 'x' }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, ERROR_CODES.INSUFFICIENT_BALANCE);
    assert.equal(e.provider, 'acme');
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('registry.probe goes through the plugin probe', async () => {
  const { registry } = registryWith({ status: 400, body: { error: { message: 'empty' } } });
  assert.deepEqual(await registry.probe('acme', 'image.generate'), { ok: true, costly: false });
});

test('a plugin id that is not enabled stays invisible (same rule as built-in providers)', () => {
  const adapter = toRegistryAdapter(sdk.instantiate(plugin, { apiKey: KEY }), { ProviderError });
  const registry = createRegistry(['bailian']).register(adapter);
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.get('acme'), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
});

test('plugin and host error codes stay in sync', () => {
  for (const code of Object.keys(sdk.ERROR_CODES)) assert.ok(ERROR_CODES[code], `host lacks ${code}`);
});
