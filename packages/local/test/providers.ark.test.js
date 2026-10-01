'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProviders, ERROR_CODES, ProviderError } = require('../src/providers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'ark', n), 'utf8');

function mockFetch(route) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof route === 'function' ? route(url, init) : route;
    const body = r.body ?? '';
    const stream = r.sse
      ? new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode(body.slice(0, 40))); c.enqueue(e.encode(body.slice(40))); c.close(); } })
      : null;
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => body, body: stream };
  };
  f.calls = calls;
  return f;
}
const mk = (fetch, extra = {}) => createProviders({ ark: { apiKey: 'ark-test', fetch, idGenerator: () => 'rid-1', ...extra } });
const SPEECH = { appId: 'app1', accessToken: 'tok1' };

test('ark registers with all five capabilities', () => {
  const p = mk(mockFetch({ body: '{}' }));
  assert.deepEqual(p.registry.list()[0].capabilities.sort(), ['image.generate', 'text.stream', 'tts.synthesize', 'video.poll', 'video.submit']);
  assert.equal(p.registry.list()[0].id, 'ark');
});

test('text.stream yields deltas, done with usage, OpenAI-compatible request', async () => {
  const f = mockFetch({ body: fx('text_stream.sse'), sse: true });
  const events = [];
  for await (const ev of mk(f).text.stream('ark', { model: 'ep-123', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })) events.push(ev);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['你', '好']);
  assert.equal(events.at(-1).text, '你好');
  assert.equal(events.at(-1).usage.total_tokens, 5);
  const c = f.calls[0];
  assert.equal(c.url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(c.init.headers.Authorization, 'Bearer ark-test');
  assert.equal(c.body.model, 'ep-123');
  assert.equal(c.body.stream, true);
  assert.equal(c.body.max_tokens, 50);
});

test('image.generate builds Seedream request and parses urls', async () => {
  const f = mockFetch({ body: fx('image_ok.json') });
  const r = await mk(f).image.generate('ark', { prompt: 'cat', size: '2K', referenceImages: ['https://e.invalid/r.png'] });
  assert.deepEqual(r.urls, ['https://example.invalid/a.jpg']);
  const c = f.calls[0];
  assert.match(c.url, /\/api\/v3\/images\/generations$/);
  assert.equal(c.body.prompt, 'cat');
  assert.equal(c.body.size, '2K');
  assert.equal(c.body.image, 'https://e.invalid/r.png');
  assert.equal(c.body.response_format, 'url');
  assert.equal(c.body.watermark, false);
});

test('video.submit builds Seedance task and returns id', async () => {
  const f = mockFetch({ body: fx('video_submit.json') });
  const r = await mk(f).video.submit('ark', { prompt: 'run', imageUrl: 'https://e.invalid/f.png', lastFrameUrl: 'https://e.invalid/l.png', duration: 5, resolution: '720P' });
  assert.deepEqual(r, { taskId: 'cgt-2025-abc' });
  const c = f.calls[0];
  assert.match(c.url, /\/api\/v3\/contents\/generations\/tasks$/);
  assert.match(c.body.content[0].text, /^run .*--rs 720p.*--dur 5/);
  assert.deepEqual(c.body.content.slice(1).map((x) => x.role), ['first_frame', 'last_frame']);
});

test('video.poll maps statuses', async () => {
  const poll = (n) => mk(mockFetch({ body: fx(n) })).video.poll('ark', { taskId: 'cgt-2025-abc' });
  assert.equal((await poll('video_poll_queued.json')).status, 'pending');
  assert.equal((await poll('video_poll_running.json')).status, 'running');
  assert.deepEqual(await poll('video_poll_succeeded.json'), { status: 'succeeded', videoUrl: 'https://example.invalid/v.mp4' });
  const f = await poll('video_poll_failed.json');
  assert.equal(f.status, 'failed');
  assert.equal(f.error.code, ERROR_CODES.INSUFFICIENT_BALANCE);
  const f2 = mockFetch({ body: fx('video_poll_running.json') });
  await mk(f2).video.poll('ark', { taskId: 'a/b' });
  assert.match(f2.calls[0].url, /tasks\/a%2Fb$/);
  assert.equal(f2.calls[0].init.method, 'GET');
});

test('error mapping: distinct codes', async () => {
  const cases = [
    [401, 'err_invalid_key.json', ERROR_CODES.INVALID_API_KEY],
    [403, 'err_model_not_enabled.json', ERROR_CODES.MODEL_NOT_ENABLED],
    [403, 'err_insufficient_balance.json', ERROR_CODES.INSUFFICIENT_BALANCE],
    [429, 'err_rate_limit.json', ERROR_CODES.RATE_LIMITED],
  ];
  for (const [status, file, code] of cases) {
    const p = mk(mockFetch({ status, body: fx(file) }));
    await assert.rejects(() => p.image.generate('ark', { prompt: 'x' }), (e) => e instanceof ProviderError && e.code === code && e.provider === 'ark', file);
    await assert.rejects(async () => { for await (const _ of p.text.stream('ark', { messages: [] })); }, (e) => e.code === code, file);
  }
});

test('missing api key is a readable INVALID_API_KEY', async () => {
  const p = createProviders({ ark: { fetch: mockFetch({ body: '{}' }) } });
  await assert.rejects(() => p.image.generate('ark', { prompt: 'x' }), (e) => e.code === ERROR_CODES.INVALID_API_KEY);
});

test('tts.synthesize sends AppID/Token request and decodes base64', async () => {
  const f = mockFetch({ body: fx('tts_ok.json') });
  const r = await mk(f, { speech: SPEECH }).tts.synthesize('ark', { text: '你好', voice: 'v1', format: 'mp3' });
  assert.equal(r.audio.toString(), 'AUDIO');
  assert.equal(r.format, 'mp3');
  const c = f.calls[0];
  assert.equal(c.url, 'https://openspeech.bytedance.com/api/v1/tts');
  assert.equal(c.init.headers.Authorization, 'Bearer;tok1');
  assert.equal(c.body.app.appid, 'app1');
  assert.equal(c.body.app.token, 'tok1');
  assert.equal(c.body.audio.voice_type, 'v1');
  assert.equal(c.body.request.reqid, 'rid-1');
  assert.equal(c.body.request.operation, 'query');
});

test('tts.synthesize without AppID/Token fails readable, no network', async () => {
  const f = mockFetch({ body: fx('tts_ok.json') });
  for (const speech of [undefined, { appId: 'a' }, { accessToken: 't' }]) {
    await assert.rejects(() => mk(f, { speech }).tts.synthesize('ark', { text: 'x' }),
      (e) => e.code === ERROR_CODES.INVALID_API_KEY && /AppID/.test(e.message) && /Access Token/.test(e.message));
  }
  assert.equal(f.calls.length, 0);
});

test('tts.synthesize maps vendor failures', async () => {
  await assert.rejects(() => mk(mockFetch({ body: fx('tts_err_rate.json') }), { speech: SPEECH }).tts.synthesize('ark', { text: 'x' }),
    (e) => e.code === ERROR_CODES.RATE_LIMITED);
  await assert.rejects(() => mk(mockFetch({ status: 401, body: fx('tts_err_auth.json') }), { speech: SPEECH }).tts.synthesize('ark', { text: 'x' }),
    (e) => e.code === ERROR_CODES.INVALID_API_KEY);
});
