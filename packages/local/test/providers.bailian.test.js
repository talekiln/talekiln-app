'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProviders, createRegistry, ERROR_CODES, ProviderError } = require('../src/providers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'bailian', n), 'utf8');

/** Mock fetch: routes = [{match(url, init)->bool, status, body, sse}] ; records calls. */
function mockFetch(route) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof route === 'function' ? route(url, init) : route;
    const body = r.body ?? '';
    const stream = r.sse
      ? new ReadableStream({ start(c) { const e = new TextEncoder(); const s = body; c.enqueue(e.encode(s.slice(0, 40))); c.enqueue(e.encode(s.slice(40))); c.close(); } })
      : null;
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => body, body: stream };
  };
  f.calls = calls;
  return f;
}
const mk = (fetch, extra = {}) => createProviders({ bailian: { apiKey: 'sk-test', fetch, ...extra } });

// ---- registry ------------------------------------------------------------------------------
test('registry exposes only phase-1 providers and hides others', () => {
  const reg = createRegistry();
  reg.register({ id: 'bailian', capabilities: { 'image.generate': async () => ({ urls: [] }) } });
  reg.register({ id: 'openai', capabilities: { 'image.generate': async () => ({ urls: [] }) } });
  assert.deepEqual(reg.list().map((p) => p.id), ['bailian']);
  assert.throws(() => reg.get('openai'), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
  assert.throws(() => reg.call('bailian', 'video.poll', {}), (e) => e.code === ERROR_CODES.CAPABILITY_NOT_SUPPORTED);
  assert.throws(() => reg.register({ id: 'x', capabilities: { 'bogus.cap': () => 1 } }), TypeError);
});

test('facade calls by capability', async () => {
  const f = mockFetch({ body: fx('image_ok.json') });
  const p = mk(f);
  assert.deepEqual(p.registry.list()[0].capabilities.sort(), ['image.generate', 'text.stream', 'tts.synthesize', 'video.poll', 'video.submit']);
  await p.image.generate('bailian', { prompt: 'x' });
  await assert.rejects(() => p.image.generate('kling', { prompt: 'x' }), (e) => e.code === ERROR_CODES.PROVIDER_NOT_AVAILABLE);
});

// ---- text.stream ---------------------------------------------------------------------------
test('text.stream yields deltas then done with usage', async () => {
  const f = mockFetch({ body: fx('text_stream.sse'), sse: true });
  const p = mk(f);
  const events = [];
  for await (const ev of p.text.stream('bailian', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 })) events.push(ev);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['你', '好']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, '你好');
  assert.equal(done.usage.total_tokens, 5);
  const c = f.calls[0];
  assert.match(c.url, /\/compatible-mode\/v1\/chat\/completions$/);
  assert.equal(c.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(c.body.stream, true);
  assert.equal(c.body.model, 'qwen-plus');
});

test('text.stream maps compat-mode invalid key error', async () => {
  const p = mk(mockFetch({ status: 401, body: fx('err_compat_invalid_key.json') }));
  await assert.rejects(async () => { for await (const _ of p.text.stream('bailian', { messages: [] })); },
    (e) => e instanceof ProviderError && e.code === ERROR_CODES.INVALID_API_KEY);
});

// ---- image.generate ------------------------------------------------------------------------
test('image.generate builds wan request and parses url', async () => {
  const f = mockFetch({ body: fx('image_ok.json') });
  const r = await mk(f).image.generate('bailian', { prompt: 'cat', size: '1280*720', referenceImages: ['https://e.invalid/r.png'], negativePrompt: 'blur' });
  assert.deepEqual(r.urls, ['https://example.invalid/a.png']);
  const c = f.calls[0];
  assert.match(c.url, /\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/);
  assert.equal(c.body.model, 'wan2.6-image');
  assert.deepEqual(c.body.input.messages[0].content, [{ text: 'cat' }, { image: 'https://e.invalid/r.png' }]);
  assert.equal(c.body.parameters.negative_prompt, 'blur');
  assert.equal(c.body.parameters.stream, false);
});

// ---- video.submit / poll -------------------------------------------------------------------
test('video.submit sends async header and returns taskId', async () => {
  const f = mockFetch({ body: fx('video_submit.json') });
  const r = await mk(f).video.submit('bailian', { prompt: 'run', duration: 5 });
  assert.equal(r.taskId, 'task-123');
  assert.equal(f.calls[0].init.headers['X-DashScope-Async'], 'enable');
  assert.match(f.calls[0].url, /video-generation\/video-synthesis$/);
  assert.equal(f.calls[0].body.model, 'wan2.6-t2v');
});

test('video.submit i2v / kf2v / validation', async () => {
  const f = mockFetch({ body: fx('video_submit.json') });
  const p = mk(f);
  await p.video.submit('bailian', { model: 'wan2.2-kf2v-flash', firstFrameUrl: 'https://e.invalid/a.png' });
  assert.match(f.calls[0].url, /image2video\/video-synthesis$/);
  assert.equal(f.calls[0].body.input.last_frame_url, 'https://e.invalid/a.png');
  await assert.rejects(() => p.video.submit('bailian', { model: 'wan2.6-i2v-flash', prompt: 'x' }), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
});

test('video.poll maps statuses', async () => {
  const run = (name) => mk(mockFetch({ body: fx(name) })).video.poll('bailian', { taskId: 'task-123' });
  assert.equal((await run('video_poll_running.json')).status, 'running');
  const ok = await run('video_poll_succeeded.json');
  assert.deepEqual(ok, { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' });
  const bad = await run('video_poll_failed.json');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.code, ERROR_CODES.INVALID_PARAMS);
  const f = mockFetch({ body: fx('video_poll_running.json') });
  await mk(f).video.poll('bailian', { taskId: 'task-123' });
  assert.equal(f.calls[0].init.method, 'GET');
  assert.match(f.calls[0].url, /\/api\/v1\/tasks\/task-123$/);
});

// ---- tts.synthesize ------------------------------------------------------------------------
function fakeWS(eventsFile) {
  const script = JSON.parse(fx(eventsFile));
  const sent = [];
  class FakeWS {
    constructor(url, opts) {
      FakeWS.last = this; this.url = url; this.opts = opts; this.sent = sent;
      queueMicrotask(() => this.onopen && this.onopen());
    }
    send(s) {
      const m = JSON.parse(s); sent.push(m);
      if (m.header.action === 'run-task') {
        setTimeout(() => script.forEach((ev) => this.onmessage({
          data: typeof ev === 'string' ? Buffer.from(ev.slice(4)) : JSON.stringify(ev),
        })), 0);
      }
    }
    close() {}
  }
  return FakeWS;
}

test('tts.synthesize runs CosyVoice protocol and concatenates audio', async () => {
  const WS = fakeWS('tts_events.json');
  const p = createProviders({ bailian: { apiKey: 'sk-test', WebSocket: WS, idGenerator: () => 'tid-1' } });
  const r = await p.tts.synthesize('bailian', { text: '你好', voice: 'longxiaochun_v2' });
  assert.equal(r.audio.toString(), 'ID3-audio-2');
  assert.equal(r.format, 'mp3');
  assert.equal(WS.last.opts.headers.Authorization, 'Bearer sk-test');
  const actions = WS.last.sent.map((m) => m.header.action);
  assert.deepEqual(actions, ['run-task', 'continue-task', 'finish-task']);
  assert.ok(WS.last.sent.every((m) => m.header.task_id === 'tid-1'));
  assert.equal(WS.last.sent[0].payload.parameters.voice, 'longxiaochun_v2');
  assert.equal(WS.last.sent[1].payload.input.text, '你好');
});

test('tts.synthesize maps task-failed to readable code', async () => {
  const p = createProviders({ bailian: { apiKey: 'sk-test', WebSocket: fakeWS('tts_events_failed.json') } });
  await assert.rejects(() => p.tts.synthesize('bailian', { text: 'x' }), (e) => e.code === ERROR_CODES.INSUFFICIENT_BALANCE);
});

// ---- error mapping -------------------------------------------------------------------------
test('error mapping: invalid key / model not enabled / insufficient balance are distinct', async () => {
  const cases = [
    [401, 'err_invalid_key.json', ERROR_CODES.INVALID_API_KEY],
    [403, 'err_model_not_enabled.json', ERROR_CODES.MODEL_NOT_ENABLED],
    [400, 'err_insufficient_balance.json', ERROR_CODES.INSUFFICIENT_BALANCE],
  ];
  const seen = new Set();
  for (const [status, file, code] of cases) {
    const p = mk(mockFetch({ status, body: fx(file) }));
    for (const call of [
      () => p.image.generate('bailian', { prompt: 'x' }),
      () => p.video.submit('bailian', { prompt: 'x' }),
      () => p.video.poll('bailian', { taskId: 't' }),
    ]) {
      await assert.rejects(call, (e) => {
        assert.equal(e.code, code);
        assert.equal(e.provider, 'bailian');
        assert.match(e.message, /[一-龥]/); // readable Chinese message
        return true;
      });
    }
    seen.add(code);
  }
  assert.equal(seen.size, 3);
});

test('error mapping: HTTP 200 with code body, network failure, missing key', async () => {
  await assert.rejects(() => mk(mockFetch({ body: fx('err_insufficient_balance.json') })).image.generate('bailian', { prompt: 'x' }),
    (e) => e.code === ERROR_CODES.INSUFFICIENT_BALANCE);
  const boom = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => mk(boom).video.submit('bailian', { prompt: 'x' }), (e) => e.code === ERROR_CODES.NETWORK);
  const noKey = createProviders({ bailian: { fetch: mockFetch({ body: '{}' }) } });
  await assert.rejects(() => noKey.image.generate('bailian', { prompt: 'x' }), (e) => e.code === ERROR_CODES.INVALID_API_KEY);
});
