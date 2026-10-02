'use strict';
/**
 * Contract test kit: run the standard case set against any plugin using mocked HTTP only (no network).
 *
 *   const { runContract, registerContract } = require('@talekiln/plugin-sdk/contract');
 *   registerContract(require('node:test'), plugin, spec);   // inside a *.test.js
 *   // or: const report = await runContract(plugin, spec);   // { results, passed, failed }
 *
 * spec = {
 *   apiKey: 'test-key-0123456789',                 // fake key; must never appear in any error text
 *   baseUrl?: string,
 *   requests: { [capability]: request },           // one valid input per declared capability
 *   success:  { [capability]: {status, body} },    // mocked 2xx reply per declared capability
 *   errors?:  { [ERROR_CODE]: {status, body} },    // mocked vendor error replies; each must map to that code
 *   errorCapability?: capability,                  // capability used for the error matrix (default: first declared non-poll)
 *   badResponse?: {status, body},                  // default {200, '<html>not json</html>'}
 *   skipBadResponse?: capability[],                // e.g. a tts that streams raw audio
 *   taskFailed?: {status, body},                   // video.poll reply of a failed task (returns failed status or throws TASK_FAILED)
 *   probe?: { [capability]: {status, body} },      // mocked reply for a successful probe
 * }
 * body may be a string or an object (JSON-encoded for you).
 */
const { VIDEO_STATUSES } = require('./constants');
const { ERROR_CODES } = require('./errors');
const { instantiate } = require('./adapter');

function reply(r) {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? {} : r.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text, json: async () => JSON.parse(text), body: null };
}

/** Recording fetch. `responder` is {status, body} | {throw: Error} | (url, init) => one of those. */
function mockHttp(responder) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === 'string' ? safeJson(init.body) : init.body });
    const r = typeof responder === 'function' ? responder(String(url), init) : responder;
    if (r && r.throw) throw r.throw;
    return reply(r);
  };
  f.calls = calls;
  return f;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

async function settle(cap, out) {
  const v = await out;
  if (cap === 'llm.chat' && v && typeof v[Symbol.asyncIterator] === 'function') {
    let text = '';
    let done = null;
    for await (const ev of v) {
      if (ev.type === 'delta') text += ev.text;
      if (ev.type === 'done') done = ev;
    }
    return { text: done && typeof done.text === 'string' ? done.text : text, usage: done && done.usage };
  }
  return v;
}

function checkResult(cap, r, assert) {
  switch (cap) {
    case 'llm.chat':
      assert.ok(r && typeof r.text === 'string' && r.text.length > 0, 'llm.chat must produce non-empty text');
      break;
    case 'image.generate':
      assert.ok(r && Array.isArray(r.urls) && r.urls.length > 0 && r.urls.every((u) => typeof u === 'string' && u), 'image.generate must return {urls: string[]} (non-empty)');
      break;
    case 'video.submit':
      assert.ok(r && typeof r.taskId === 'string' && r.taskId, 'video.submit must return {taskId}');
      break;
    case 'video.poll':
      assert.ok(r && VIDEO_STATUSES.includes(r.status), `video.poll status must be one of ${VIDEO_STATUSES.join('|')}`);
      if (r.status === 'succeeded') assert.ok(typeof r.videoUrl === 'string' && r.videoUrl, 'succeeded poll must carry videoUrl');
      break;
    case 'tts.synthesize':
      assert.ok(r && r.audio && r.audio.length > 0, 'tts.synthesize must return non-empty audio (Buffer)');
      assert.ok(typeof r.format === 'string' && r.format, 'tts.synthesize must return format');
      if (r.words !== undefined) {
        assert.ok(Array.isArray(r.words) && r.words.every((w) => typeof w.text === 'string' && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs >= w.startMs), 'words must be {text,startMs,endMs}[] with endMs >= startMs');
      }
      break;
    default:
      assert.fail(`unknown capability ${cap}`);
  }
}

function strictAssert() {
  const a = require('node:assert/strict');
  return a;
}

/** Build the case list: [{name, run: async () => void}] (throws on failure). */
function buildCases(plugin, spec, assert = strictAssert()) {
  const m = plugin.manifest;
  const apiKey = spec.apiKey;
  const mk = (responder, extra = {}) => {
    const fetch = mockHttp(responder);
    const inst = instantiate(plugin, { apiKey, baseUrl: spec.baseUrl, fetch, ...extra });
    return { fetch, inst };
  };
  const cases = [];
  const add = (name, run) => cases.push({ name, run });
  const noKey = (e) => {
    const blob = `${e && e.message} ${e && e.detail} ${e && e.stack}`;
    assert.ok(!blob.includes(apiKey), 'error text must not contain the API key');
  };
  const expectCode = async (promiseFn, code) => {
    let err = null;
    try { await promiseFn(); } catch (e) { err = e; }
    assert.ok(err, `expected error ${code}, call succeeded`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    noKey(err);
    return err;
  };

  add('manifest and adapter validate', () => {
    const { inst } = mk({ status: 200, body: {} });
    assert.equal(inst.id, m.name);
    assert.equal(typeof inst.adapter.mapError, 'function');
  });

  for (const cap of m.capabilities) {
    const req = spec.requests && spec.requests[cap];
    const ok = spec.success && spec.success[cap];
    add(`${cap}: success shape, https + permitted hosts only`, async () => {
      assert.ok(req && ok, `spec needs requests and success for ${cap}`);
      const { fetch, inst } = mk(ok);
      const r = await settle(cap, inst.adapter.capabilities[cap](req));
      checkResult(cap, r, assert);
      assert.ok(fetch.calls.length >= 1, 'must perform at least one HTTP call');
      for (const c of fetch.calls) assert.ok(c.url.startsWith('https://'), 'only https');
    });
    add(`${cap}: network failure maps to NETWORK without leaking the key`, async () => {
      const { inst } = mk({ throw: new Error(`ECONNRESET while calling vendor with ${apiKey}`) });
      await expectCode(() => settle(cap, inst.adapter.capabilities[cap](req)), ERROR_CODES.NETWORK);
    });
    if (!(spec.skipBadResponse || []).includes(cap)) {
      add(`${cap}: non-JSON 200 maps to BAD_RESPONSE`, async () => {
        const { inst } = mk(spec.badResponse || { status: 200, body: '<html>not json</html>' });
        await expectCode(() => settle(cap, inst.adapter.capabilities[cap](req)), ERROR_CODES.BAD_RESPONSE);
      });
    }
    add(`${cap}: missing key maps to INVALID_API_KEY and makes no HTTP call`, async () => {
      const fetch = mockHttp({ status: 200, body: {} });
      const inst = instantiate(plugin, { apiKey: '', baseUrl: spec.baseUrl, fetch });
      await expectCode(() => settle(cap, inst.adapter.capabilities[cap](req)), ERROR_CODES.INVALID_API_KEY);
      assert.equal(fetch.calls.length, 0);
    });
  }

  const errCap = spec.errorCapability || m.capabilities.find((c) => c !== 'video.poll') || m.capabilities[0];
  for (const [code, resp] of Object.entries(spec.errors || {})) {
    add(`error matrix ${code}: via ${errCap} and via mapError`, async () => {
      assert.ok(Object.prototype.hasOwnProperty.call(ERROR_CODES, code), `unknown code ${code} in spec.errors`);
      const { inst } = mk(resp);
      await expectCode(() => settle(errCap, inst.adapter.capabilities[errCap](spec.requests[errCap])), code);
      const direct = inst.adapter.mapError(resp.status, resp.body);
      assert.equal(direct.code, code);
      noKey(direct);
    });
  }

  add('mapError never throws and always returns a valid code', () => {
    const { inst } = mk({ status: 200, body: {} });
    for (const [status, body] of [[500, null], [500, 'x'], [0, undefined], [418, { error: 5 }], [400, { error: { code: {}, message: 7 } }]]) {
      const e = inst.adapter.mapError(status, body);
      assert.ok(e && Object.prototype.hasOwnProperty.call(ERROR_CODES, e.code), `invalid code for ${status}`);
    }
  });

  if (spec.taskFailed && m.capabilities.includes('video.poll')) {
    add('video.poll: failed task is reported as failed status or TASK_FAILED', async () => {
      const { inst } = mk(spec.taskFailed);
      let r = null;
      let err = null;
      try { r = await inst.adapter.capabilities['video.poll'](spec.requests['video.poll']); } catch (e) { err = e; }
      if (err) assert.equal(err.code, ERROR_CODES.TASK_FAILED);
      else assert.equal(r.status, 'failed');
    });
  }

  add('permissions: an undeclared host is rejected by the guarded fetch', async () => {
    const { inst } = mk({ status: 200, body: {} });
    // The ctx.fetch the plugin receives is the guarded one; emulate a rogue plugin through a probe plugin.
    const rogue = instantiate({
      manifest: m,
      createAdapter: (ctx) => ({ ...inst.adapter, capabilities: Object.fromEntries(m.capabilities.map((c) => [c, () => ctx.fetch('https://evil.invalid/x')])) }),
    }, { apiKey, fetch: mockHttp({ status: 200, body: {} }) });
    await expectCode(() => rogue.adapter.capabilities[m.capabilities[0]]({}), ERROR_CODES.NETWORK);
  });

  if (typeof (instantiate(plugin, { apiKey, fetch: mockHttp({ status: 200, body: {} }) }).adapter.probe) === 'function') {
    for (const cap of m.capabilities) {
      const resp = spec.probe && spec.probe[cap];
      if (!resp) continue;
      add(`${cap}: probe returns {ok, costly}`, async () => {
        const { inst } = mk(resp);
        const r = await inst.adapter.probe(cap, {});
        assert.ok(r && typeof r.ok === 'boolean' && typeof r.costly === 'boolean', 'probe must resolve {ok:boolean, costly:boolean}');
      });
    }
    if (spec.errors && spec.errors.INVALID_API_KEY) {
      add('probe: bad key rejects with INVALID_API_KEY', async () => {
        const { inst } = mk(spec.errors.INVALID_API_KEY);
        await expectCode(() => inst.adapter.probe(errCap, {}), ERROR_CODES.INVALID_API_KEY);
      });
    }
  }
  return cases;
}

async function runContract(plugin, spec, opts = {}) {
  const results = [];
  for (const c of buildCases(plugin, spec, opts.assert)) {
    try { await c.run(); results.push({ name: c.name, ok: true }); } catch (e) { results.push({ name: c.name, ok: false, error: e.message }); }
  }
  const failed = results.filter((r) => !r.ok).length;
  return { results, passed: results.length - failed, failed };
}

/** Register every case with node:test's `test` function. */
function registerContract(test, plugin, spec, opts = {}) {
  for (const c of buildCases(plugin, spec, opts.assert)) test(`${plugin.manifest.name} contract: ${c.name}`, c.run);
}

module.exports = { runContract, registerContract, buildCases, mockHttp };
