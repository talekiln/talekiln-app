'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sdk = require('../src');
const { toRegistryAdapter } = require('../src/bridge');
const { mockHttp } = require('../src/contract');

class ProviderError extends Error {
  constructor(code, detail, extra = {}) { super(detail || code); this.name = 'ProviderError'; this.code = code; this.provider = extra.provider || null; this.status = extra.status || null; }
}
const KEY = 'test-key-0123456789';
const plugin = sdk.loadPlugin(path.join(__dirname, '..', 'examples', 'acme'));
const make = (responder) => toRegistryAdapter(sdk.instantiate(plugin, { apiKey: KEY, fetch: mockHttp(responder) }), { ProviderError, secrets: [KEY] });

test('llm.chat is exposed as text.stream (delta + done); other names unchanged', async () => {
  const a = make({ status: 200, body: { text: 'hello', usage: { tokens: 3 } } });
  assert.deepEqual(Object.keys(a.capabilities).sort(), ['image.generate', 'text.stream', 'tts.synthesize', 'video.poll', 'video.submit']);
  const events = [];
  for await (const e of a.capabilities['text.stream']({ messages: [] })) events.push(e);
  assert.deepEqual(events, [{ type: 'delta', text: 'hello' }, { type: 'done', text: 'hello', usage: { tokens: 3 } }]);
  assert.equal(a.id, 'acme');
});

test('async-iterable llm.chat results pass through', async () => {
  const m = { ...plugin.manifest, capabilities: ['llm.chat'] };
  const inst = sdk.instantiate({
    manifest: m,
    createAdapter: () => ({
      capabilities: { async 'llm.chat'() { return (async function* () { yield { type: 'delta', text: 'a' }; yield { type: 'done', text: 'a' }; })(); } },
      mapError: () => new sdk.PluginError('UNKNOWN'),
    }),
  }, { apiKey: KEY });
  const a = toRegistryAdapter(inst, { ProviderError });
  const out = [];
  for await (const e of a.capabilities['text.stream']({})) out.push(e.type);
  assert.deepEqual(out, ['delta', 'done']);
});

test('PluginError becomes ProviderError with provider id; key scrubbed from detail', async () => {
  const a = make({ status: 401, body: { error: { code: 'invalid_api_key', message: `bad key ${KEY}` } } });
  await assert.rejects(() => a.capabilities['image.generate']({ prompt: 'x' }), (e) => {
    assert.equal(e.name, 'ProviderError');
    assert.equal(e.code, 'INVALID_API_KEY');
    assert.equal(e.provider, 'acme');
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('non-PluginError throws become UNKNOWN; text.stream errors surface on iteration', async () => {
  const m = { ...plugin.manifest, capabilities: ['llm.chat', 'image.generate'] };
  const inst = sdk.instantiate({
    manifest: m,
    createAdapter: () => ({
      capabilities: { async 'llm.chat'() { throw new TypeError(`boom ${KEY}`); }, async 'image.generate'() { throw new RangeError('x'); } },
      mapError: () => new sdk.PluginError('UNKNOWN'),
    }),
  }, { apiKey: KEY });
  const a = toRegistryAdapter(inst, { ProviderError, secrets: [KEY] });
  await assert.rejects(() => a.capabilities['image.generate']({}), (e) => e.code === 'UNKNOWN');
  await assert.rejects(async () => { for await (const _ of a.capabilities['text.stream']({})) { /* drain */ } }, (e) => e.code === 'UNKNOWN' && !e.message.includes(KEY));
});

test('video.poll failed task carries a ProviderError', async () => {
  const a = make({ status: 200, body: { state: 'failed', reason: 'rejected' } });
  const r = await a.capabilities['video.poll']({ taskId: 't' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error.name, 'ProviderError');
  assert.equal(r.error.code, 'TASK_FAILED');
});

test('probes keyed by host capability names', async () => {
  const a = make({ status: 400, body: { error: { message: 'empty' } } });
  assert.ok(a.probes['text.stream'] && a.probes['image.generate']);
  assert.deepEqual(await a.probes['image.generate']({}), { ok: true, costly: false });
});

test('requires the host ProviderError class', () => {
  assert.throws(() => toRegistryAdapter(sdk.instantiate(plugin, { apiKey: KEY }), {}), /ProviderError/);
});
