'use strict';
// C05 connectivity probes, replaying responses recorded from the real 百炼 service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProviders, ERROR_CODES } = require('../src/providers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'bailian', n), 'utf8');
function mockFetch(status, body) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { ok: status < 400, status, text: async () => body, body: null };
  };
  f.calls = calls;
  return f;
}
const mk = (fetch, extra) => createProviders({ bailian: { apiKey: 'sk-test', fetch, ...extra } });

test('image probe: expected 400 on a 1*1 size means key and model are fine, nothing generated', async () => {
  const f = mockFetch(400, fx('live_probe_image_bad_size.json'));
  assert.deepEqual(await mk(f).probe('bailian', 'image.generate'), { ok: true, costly: false });
  assert.equal(f.calls[0].body.parameters.size, '1*1');
  assert.equal(f.calls[0].body.model, 'wan2.6-t2i');
});

test('video probe: sync call without the async header is denied after key and model checks; no task', async () => {
  const f = mockFetch(403, fx('live_probe_video_sync_denied.json'));
  assert.deepEqual(await mk(f).probe('bailian', 'video.submit', { model: 'wan2.6-i2v-flash' }), { ok: true, costly: false });
  assert.equal(f.calls[0].init.headers['X-DashScope-Async'], undefined);
  assert.equal(f.calls[0].body.model, 'wan2.6-i2v-flash');
});

test('probes surface key / model / balance problems with distinct codes', async () => {
  const cases = [
    [401, 'live_err_invalid_key.json', ERROR_CODES.INVALID_API_KEY],
    [404, 'live_err_model_not_exist.json', ERROR_CODES.MODEL_NOT_ENABLED],
    [403, 'err_model_not_enabled.json', ERROR_CODES.MODEL_NOT_ENABLED],
    [400, 'err_insufficient_balance.json', ERROR_CODES.INSUFFICIENT_BALANCE],
  ];
  for (const cap of ['image.generate', 'video.submit']) {
    for (const [status, file, code] of cases) {
      await assert.rejects(() => mk(mockFetch(status, fx(file))).probe('bailian', cap), (e) => e.code === code, `${cap} ${file}`);
    }
  }
  await assert.rejects(() => mk(mockFetch(200, fx('live_image_t2i.json'))).probe('bailian', 'image.generate'), (e) => e.code === ERROR_CODES.BAD_RESPONSE);
});

test('text probe sends a one-token chat and maps compat errors', async () => {
  const f = mockFetch(200, '{"choices":[{"message":{"content":"1"}}]}');
  assert.deepEqual(await mk(f).probe('bailian', 'text.stream', { model: 'qwen-flash' }), { ok: true, costly: true });
  assert.equal(f.calls[0].body.max_tokens, 1);
  assert.equal(f.calls[0].body.model, 'qwen-flash');
  await assert.rejects(() => mk(mockFetch(401, fx('live_err_compat_invalid_key.json'))).probe('bailian', 'text.stream'), (e) => e.code === ERROR_CODES.INVALID_API_KEY);
  await assert.rejects(() => mk(mockFetch(404, fx('live_err_compat_model_not_found.json'))).probe('bailian', 'text.stream'), (e) => e.code === ERROR_CODES.MODEL_NOT_ENABLED);
});

test('unknown provider or capability without a probe', async () => {
  await assert.rejects(() => mk(mockFetch(200, '{}')).probe('kling', 'text.stream'), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
  const p = createProviders({ bailian: { apiKey: 'sk-test', fetch: mockFetch(200, '{}') } });
  delete p.registry.get('bailian').probes['tts.synthesize'];
  await assert.rejects(() => p.probe('bailian', 'tts.synthesize'), (e) => e.code === ERROR_CODES.CAPABILITY_NOT_SUPPORTED);
});

// ---- Ark (mock-only: no Ark key yet; response shapes follow the existing ark fixtures) ----------
const mkArk = (fetch, extra) => createProviders({ ark: { apiKey: 'ak-test', fetch, ...extra } });
const arkErr = (code, message) => JSON.stringify({ error: { code, message, type: 'BadRequest' } });

test('ark probes: image invalid size counts as ok; key / model / balance errors stay distinct', async () => {
  const f = mockFetch(400, arkErr('InvalidParameter', 'size is invalid'));
  assert.deepEqual(await mkArk(f).probe('ark', 'image.generate'), { ok: true, costly: false });
  assert.equal(f.calls[0].body.size, '1x1');
  for (const [status, code, msg, want] of [
    [401, 'AuthenticationError', 'The API key is invalid', ERROR_CODES.INVALID_API_KEY],
    [404, 'ModelNotOpen', 'model not open', ERROR_CODES.MODEL_NOT_ENABLED],
    [403, 'AccountOverdueError', 'account overdue', ERROR_CODES.INSUFFICIENT_BALANCE],
  ]) {
    await assert.rejects(() => mkArk(mockFetch(status, arkErr(code, msg))).probe('ark', 'image.generate'), (e) => e.code === want);
  }
});

test('ark probes: text one-token chat, video lists tasks without creating one', async () => {
  const t = mockFetch(200, '{"choices":[{"message":{"content":"1"}}]}');
  assert.deepEqual(await mkArk(t).probe('ark', 'text.stream'), { ok: true, costly: true });
  assert.match(t.calls[0].url, /\/chat\/completions$/);
  assert.equal(t.calls[0].body.max_tokens, 1);
  const v = mockFetch(200, '{"items":[],"total":0}');
  assert.deepEqual(await mkArk(v).probe('ark', 'video.submit'), { ok: true, costly: false, modelChecked: false });
  assert.equal(v.calls[0].init.method, 'GET');
  await assert.rejects(() => mkArk(mockFetch(401, arkErr('AuthenticationError', 'invalid'))).probe('ark', 'video.submit'), (e) => e.code === ERROR_CODES.INVALID_API_KEY);
});

test('ark tts probe: missing speech credentials fail without a request', async () => {
  const f = mockFetch(200, '{}');
  await assert.rejects(() => mkArk(f).probe('ark', 'tts.synthesize'), (e) => e.code === ERROR_CODES.INVALID_API_KEY && /AppID/.test(e.message));
  assert.equal(f.calls.length, 0);
});
