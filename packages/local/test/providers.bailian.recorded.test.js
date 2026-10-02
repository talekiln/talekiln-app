'use strict';
// Contract tests replaying responses recorded from the real 百炼 service (cn-beijing workspace key,
// 2026-10-01). Fixtures are files named live_* under fixtures/bailian; signed URLs were replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProviders, ERROR_CODES } = require('../src/providers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'bailian', n), 'utf8');

function mockFetch(route) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof route === 'function' ? route(url, init) : route;
    const body = r.body ?? '';
    const stream = r.sse ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }) : null;
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => body, body: stream };
  };
  f.calls = calls;
  return f;
}
const WS_BASE = 'https://ws-example.cn-beijing.maas.aliyuncs.com';
const mk = (fetch, extra = {}) => createProviders({ bailian: { apiKey: 'sk-test', baseUrl: WS_BASE, fetch, ...extra } });

/** Fake WebSocket replaying a recorded event script; `mode` simulates handshake failure or a 1011 close. */
function fakeWS(script, mode) {
  class FakeWS {
    constructor(url, opts) {
      FakeWS.last = this; this.url = url; this.opts = opts; this.sent = [];
      queueMicrotask(() => {
        if (mode === 'handshake-fail') { this.onerror({ message: 'Received network error or non-101 status code.' }); this.onclose({ code: 1006 }); return; }
        this.onopen();
      });
    }
    send(s) {
      const m = JSON.parse(s); this.sent.push(m);
      if (m.header.action !== 'run-task') return;
      setTimeout(() => {
        for (const ev of script) this.onmessage({ data: typeof ev === 'string' ? Buffer.from(ev.slice(4)) : JSON.stringify(ev) });
        if (mode === 'close-1011') this.onclose({ code: 1011, reason: script.at(-1).header.error_message });
      }, 0);
    }
    close() {}
  }
  return FakeWS;
}

test('workspace base URL: console URLs are normalised and WebSocket uses the same host', async () => {
  for (const baseUrl of [WS_BASE, `${WS_BASE}/api/v1`, `${WS_BASE}/compatible-mode/v1/`]) {
    const f = mockFetch({ body: fx('live_image_t2i.json') });
    const WS = fakeWS(JSON.parse(fx('live_tts_events.json')));
    const p = createProviders({ bailian: { apiKey: 'sk-test', baseUrl, fetch: f, WebSocket: WS } });
    await p.image.generate('bailian', { prompt: 'x' });
    assert.equal(f.calls[0].url, `${WS_BASE}/api/v1/services/aigc/multimodal-generation/generation`);
    await p.tts.synthesize('bailian', { text: '你好' });
    assert.equal(WS.last.url, 'wss://ws-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/');
  }
});

test('text.stream parses recorded compat-mode SSE (null role chunk, usage-only chunk)', async () => {
  const events = [];
  for await (const ev of mk(mockFetch({ body: fx('live_text_stream.sse'), sse: true })).text.stream('bailian', { messages: [] })) events.push(ev);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['好的', '！']);
  assert.equal(events.at(-1).text, '好的！');
  assert.equal(events.at(-1).usage.total_tokens, 16);
});

test('image.generate: text-to-image defaults to wan2.6-t2i without interleave flags', async () => {
  const f = mockFetch({ body: fx('live_image_t2i.json') });
  const r = await mk(f).image.generate('bailian', { prompt: '橘猫', size: '1024*1024' });
  assert.deepEqual(r.urls, ['https://example.invalid/t2i.png']);
  assert.equal(f.calls[0].body.model, 'wan2.6-t2i');
  assert.equal(f.calls[0].body.parameters.enable_interleave, undefined);
  assert.deepEqual(f.calls[0].body.input.messages[0].content, [{ text: '橘猫' }]);
});

test('image.generate: reference images switch to wan2.6-image edit mode (max 4)', async () => {
  const f = mockFetch({ body: fx('live_image_t2i.json') });
  const refs = ['a', 'b', 'c', 'd', 'e'].map((x) => `https://e.invalid/${x}.png`);
  await mk(f).image.generate('bailian', { prompt: '改成黑猫', referenceImages: refs });
  const b = f.calls[0].body;
  assert.equal(b.model, 'wan2.6-image');
  assert.equal(b.parameters.enable_interleave, false);
  assert.equal(b.input.messages[0].content.length, 5);
  await assert.rejects(() => mk(f).image.generate('bailian', { model: 'wan2.6-image', prompt: 'x' }), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
});

test('image.generate: z-image-turbo response (untyped image part plus text part)', async () => {
  const r = await mk(mockFetch({ body: fx('live_image_zimage.json') })).image.generate('bailian', { model: 'z-image-turbo', prompt: 'x' });
  assert.deepEqual(r.urls, ['https://example.invalid/z.png']);
});

test('recorded errors map to unified codes', async () => {
  const cases = [
    [401, 'live_err_invalid_key.json', ERROR_CODES.INVALID_API_KEY],
    [404, 'live_err_model_not_exist.json', ERROR_CODES.MODEL_NOT_ENABLED],
    [400, 'live_err_image_needs_refs.json', ERROR_CODES.INVALID_PARAMS],
  ];
  for (const [status, file, code] of cases) {
    await assert.rejects(() => mk(mockFetch({ status, body: fx(file) })).image.generate('bailian', { prompt: 'x' }), (e) => e.code === code && Boolean(e.vendorCode));
  }
  for (const [status, file, code] of [[401, 'live_err_compat_invalid_key.json', ERROR_CODES.INVALID_API_KEY], [404, 'live_err_compat_model_not_found.json', ERROR_CODES.MODEL_NOT_ENABLED]]) {
    await assert.rejects(async () => { for await (const _ of mk(mockFetch({ status, body: fx(file) })).text.stream('bailian', { messages: [] })); }, (e) => e.code === code);
  }
});

test('video: recorded submit, task-level FAILED and UNKNOWN (expired or bogus id)', async () => {
  assert.equal((await mk(mockFetch({ body: fx('live_video_submit.json') })).video.submit('bailian', { prompt: 'x' })).taskId, '065273ca-891e-4e7f-adf9-0be682e1dbb4');
  const failed = await mk(mockFetch({ body: fx('live_video_poll_failed.json') })).video.poll('bailian', { taskId: 't' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(failed.error.message, /size is not supported/);
  const unknown = await mk(mockFetch({ body: fx('live_video_poll_unknown.json') })).video.poll('bailian', { taskId: 't' });
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.error.code, ERROR_CODES.TASK_FAILED);
});

test('tts: recorded CosyVoice session (result-generated sentence events interleaved with audio)', async () => {
  const WS = fakeWS(JSON.parse(fx('live_tts_events.json')));
  const r = await mk(mockFetch({ body: '{}' }), { WebSocket: WS }).tts.synthesize('bailian', { text: '你好' });
  assert.equal(r.audio.toString(), 'ID3-audio-2');
  const run = WS.last.sent[0];
  assert.equal(run.payload.model, 'cosyvoice-v2');
  assert.equal(run.payload.parameters.voice, 'longxiaochun_v2');
});

test('tts: recorded task-failed events map to codes', async () => {
  const bad = (file, mode) => mk(mockFetch({ body: '{}' }), { WebSocket: fakeWS(JSON.parse(fx(file)), mode) }).tts.synthesize('bailian', { text: 'x' });
  await assert.rejects(() => bad('live_tts_bad_voice.json'), (e) => e.code === ERROR_CODES.INVALID_PARAMS);
  await assert.rejects(() => bad('live_tts_model_not_exist.json', 'close-1011'), (e) => e.code === ERROR_CODES.MODEL_NOT_ENABLED);
});

test('tts: handshake failure is told apart by probing the key', async () => {
  const ws = fakeWS([], 'handshake-fail');
  const badKey = mockFetch({ status: 401, body: fx('live_err_compat_invalid_key.json') });
  await assert.rejects(() => mk(badKey, { WebSocket: ws }).tts.synthesize('bailian', { text: 'x' }), (e) => e.code === ERROR_CODES.INVALID_API_KEY);
  assert.match(badKey.calls[0].url, /\/compatible-mode\/v1\/models$/);
  assert.equal(badKey.calls[0].init.method, 'GET');
  const keyOk = mockFetch({ body: '{"data":[]}' });
  await assert.rejects(() => mk(keyOk, { WebSocket: ws }).tts.synthesize('bailian', { text: 'x' }), (e) => e.code === ERROR_CODES.NETWORK);
  const offline = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(() => mk(offline, { WebSocket: ws }).tts.synthesize('bailian', { text: 'x' }), (e) => e.code === ERROR_CODES.NETWORK);
});

test('video: recorded real t2v and kf2v runs (submit, running, succeeded with usage)', async () => {
  for (const [name, path] of [['live_video_t2v.json', /video-generation\/video-synthesis$/], ['live_video_kf2v.json', /image2video\/video-synthesis$/]]) {
    const rec = JSON.parse(fx(name));
    const sub = mockFetch({ body: JSON.stringify(rec.submit) });
    const req = name.includes('kf2v') ? { model: 'wan2.2-kf2v-flash', firstFrameUrl: 'https://e.invalid/f.png', prompt: 'x' } : { prompt: 'x', duration: 5 };
    const { taskId } = await mk(sub).video.submit('bailian', req);
    assert.equal(taskId, rec.submit.output.task_id);
    assert.match(sub.calls[0].url, path);
    assert.equal((await mk(mockFetch({ body: JSON.stringify(rec.running) })).video.poll('bailian', { taskId })).status, 'running');
    const ok = await mk(mockFetch({ body: JSON.stringify(rec.succeeded) })).video.poll('bailian', { taskId });
    assert.equal(ok.status, 'succeeded');
    assert.match(ok.videoUrl, /^https:\/\/example\.invalid\//);
    assert.equal(ok.usage.duration, 5);
    assert.ok(ok.usage.SR);
  }
});
