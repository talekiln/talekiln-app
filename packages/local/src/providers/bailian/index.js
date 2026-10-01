'use strict';
/**
 * 阿里云百炼 (DashScope) adapter. Phase-1 provider id: "bailian".
 *
 * Request shapes reused from services/imageClient.js (wan2.6-image, sync multimodal-generation)
 * and services/videoClient.js (video-synthesis async submit + /api/v1/tasks/{id} poll).
 *
 * Verified against a real cn-beijing workspace key on 2026-10-01 (recorded responses in
 * test/fixtures/bailian/live_*): compat-mode chat + SSE, wan2.6-t2i / wan2.6-image / z-image-turbo
 * image, CosyVoice (cosyvoice-v2, longxiaochun_v2) WebSocket protocol, invalid key, unknown model,
 * task-level FAILED, video success for wan2.6-t2v (720P) and wan2.2-kf2v-flash (480P)
 * (video_url expires after 24 h; download it promptly). Workspace keys (sk-ws-…) must use the workspace host for both HTTP and WebSocket.
 *
 * Still UNVERIFIED (cannot be triggered with a funded, fully-enabled key):
 *  - Arrearage / Model.AccessDenied strings (taken from the public error-code page, matched loosely).
 */
const { ProviderError, ERROR_CODES } = require('../errors');

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
const WS_PATH = '/api-ws/v1/inference/';
const MODELS_PATH = '/compatible-mode/v1/models';
const IMAGE_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';
const IMAGE2VIDEO_PATH = '/api/v1/services/aigc/image2video/video-synthesis';
const CHAT_PATH = '/compatible-mode/v1/chat/completions';

/** Map a DashScope failure (HTTP status + body code/message) to a unified ProviderError. */
function mapError(status, body, extra = {}) {
  const err = (body && typeof body.error === 'object' && body.error) || body || {};
  const vendorCode = String(err.code || err.type || '');
  const message = String(err.message || (typeof body === 'string' ? body : '') || '');
  const hay = `${vendorCode} ${message}`.toLowerCase();
  const opts = { provider: 'bailian', status, vendorCode: vendorCode || null, ...extra };
  let code;
  // Order matters: balance and key checks come before the generic 403/400 buckets.
  if (/arrearage|overdue|good standing|insufficient[_ ]?(quota|balance)|billing|欠费|余额/.test(hay)) {
    code = ERROR_CODES.INSUFFICIENT_BALANCE;
  } else if (status === 401 || /invalid[_ ]?api[_ ]?key|invalidapikey|incorrect api key|apikey/.test(hay)) {
    code = ERROR_CODES.INVALID_API_KEY;
  } else if (/model\.?(accessdenied|notfound)|model_not_found|modelnotfound|model not exist|unpurchased|access denied|accessdenied|not (been )?(activated|enabled|opened)|未开通/.test(hay) || status === 403 || status === 404) {
    code = ERROR_CODES.MODEL_NOT_ENABLED;
  } else if (status === 429 || /throttling|ratelimit|rate_limit|too many requests/.test(hay)) {
    code = ERROR_CODES.RATE_LIMITED;
  } else if (status === 400 || /invalidparameter|invalid_parameter|badrequest/.test(hay)) {
    code = ERROR_CODES.INVALID_PARAMS;
  } else {
    code = ERROR_CODES.UNKNOWN;
  }
  return new ProviderError(code, message || vendorCode || `HTTP ${status}`, opts);
}

function createBailianAdapter(cfg = {}) {
  const apiKey = cfg.apiKey;
  // Accept the console's DashScope / compatible-mode URLs as well as the bare host.
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '').replace(/\/(compatible-mode\/v1|api\/v1)$/, '');
  const wsUrl = cfg.wsUrl || base.replace(/^http/, 'ws') + WS_PATH;
  const doFetch = cfg.fetch || ((...a) => globalThis.fetch(...a));
  // `ws` rather than the global WebSocket: verified that DashScope never answers a close frame, so the
  // socket lingers about two minutes after each synthesis unless it is terminated.
  const WS = cfg.WebSocket || require('ws');
  const genId = cfg.idGenerator || (() => require('crypto').randomUUID());

  function authHeaders(extra) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || ''}`, ...extra };
  }

  async function request(path, { method = 'POST', body, headers, signal } = {}) {
    if (!apiKey) throw new ProviderError(ERROR_CODES.INVALID_API_KEY, '未配置 Key', { provider: 'bailian' });
    let res;
    try {
      res = await doFetch(base + path, {
        method,
        headers: authHeaders(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ProviderError(ERROR_CODES.NETWORK, e.message, { provider: 'bailian' });
    }
    return res;
  }

  async function readJson(res) {
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* leave null */ }
    if (!res.ok) throw mapError(res.status, data || raw);
    // DashScope sometimes returns HTTP 200 with {code, message}.
    if (data && data.code && !data.output) throw mapError(res.status, data);
    if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '非 JSON', { provider: 'bailian' });
    return data;
  }

  // ---- text.stream: OpenAI-compatible SSE (compatible-mode) -------------------------------
  async function* textStream({ model, messages, temperature, maxTokens, signal }) {
    const body = {
      model: model || 'qwen-plus',
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;
    const res = await request(CHAT_PATH, { body, signal });
    if (!res.ok) {
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { /* ignore */ }
      throw mapError(res.status, data || raw);
    }
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let usage;
    const handleLine = (line) => {
      line = line.trim();
      if (!line.startsWith('data:')) return null;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return null;
      let j;
      try { j = JSON.parse(payload); } catch (_) { return null; }
      if (j.error) throw mapError(res.status, j);
      if (j.usage) usage = j.usage;
      const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      return t || null;
    };
    for await (const chunk of res.body) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const t = handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (t) { full += t; yield { type: 'delta', text: t }; }
      }
    }
    const tail = handleLine(buf);
    if (tail) { full += tail; yield { type: 'delta', text: tail }; }
    yield { type: 'done', text: full, usage };
  }

  // ---- image.generate: sync multimodal-generation endpoint ---------------------------------
  // No reference images -> text-to-image (wan2.6-t2i). With references -> wan2.6-image edit mode,
  // which (verified) rejects enable_interleave=false unless the message carries 1-4 images.
  async function imageGenerate({ model, prompt, size, referenceImages, negativePrompt, signal }) {
    const refs = (referenceImages || []).filter(Boolean);
    const content = [{ text: prompt || '' }];
    const parameters = { prompt_extend: true, watermark: false, n: 1, size: size || '1280*720' };
    const useModel = model || (refs.length ? 'wan2.6-image' : 'wan2.6-t2i');
    if (useModel === 'wan2.6-image') {
      if (!refs.length) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, 'wan2.6-image 需要 1-4 张参考图', { provider: 'bailian' });
      for (const img of refs.slice(0, 4)) content.push({ image: img });
      parameters.enable_interleave = false;
      parameters.stream = false;
    } else {
      for (const img of refs.slice(0, 4)) content.push({ image: img });
    }
    if (negativePrompt) parameters.negative_prompt = negativePrompt;
    const body = { model: useModel, input: { messages: [{ role: 'user', content }] }, parameters };
    const res = await request(IMAGE_PATH, { body, signal });
    const data = await readJson(res);
    const urls = [];
    for (const c of (data.output && data.output.choices) || []) {
      for (const part of (c && c.message && c.message.content) || []) {
        if (part && part.image && (part.type === 'image' || !part.type)) urls.push(part.image);
      }
    }
    if (!urls.length) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回图片', { provider: 'bailian' });
    return { urls };
  }

  // ---- video.submit / video.poll (async task id) -------------------------------------------
  function buildVideoRequest(r) {
    const model = r.model || 'wan2.6-t2v';
    const dur = r.duration ? Number(r.duration) : 5;
    const img = r.imageUrl || r.firstFrameUrl;
    if (model === 'wan2.2-kf2v-flash') {
      const first = r.firstFrameUrl || r.imageUrl;
      const last = r.lastFrameUrl || first;
      if (!first) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, `${model} 需要首帧图`, { provider: 'bailian' });
      return { path: IMAGE2VIDEO_PATH, body: { model, input: { prompt: r.prompt || '', first_frame_url: first, last_frame_url: last }, parameters: { resolution: r.resolution || '480P', prompt_extend: true } } };
    }
    if (model === 'wan2.6-i2v-flash') {
      if (!img) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, `${model} 需要图片`, { provider: 'bailian' });
      return { path: VIDEO_PATH, body: { model, input: { prompt: r.prompt || '', img_url: img }, parameters: { resolution: r.resolution || '720P', prompt_extend: true, duration: dur, shot_type: 'multi' } } };
    }
    if (model === 'wan2.6-r2v-flash') {
      const refs = (r.referenceUrls || []).filter(Boolean).slice(0, 5);
      if (!refs.length) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, `${model} 需要参考图`, { provider: 'bailian' });
      return { path: VIDEO_PATH, body: { model, input: { prompt: r.prompt || '', reference_urls: refs }, parameters: { prompt_extend: true } } };
    }
    // default / wan2.6-t2v (text-to-video); other wan t2v models share this shape (UNVERIFIED for unlisted names)
    return { path: VIDEO_PATH, body: { model, input: { prompt: r.prompt || '' }, parameters: { size: r.size || '1280*720', prompt_extend: true, duration: dur, shot_type: 'multi' } } };
  }

  async function videoSubmit(r) {
    const { path, body } = buildVideoRequest(r);
    const res = await request(path, { body, headers: { 'X-DashScope-Async': 'enable' }, signal: r.signal });
    const data = await readJson(res);
    const taskId = data.output && data.output.task_id;
    if (!taskId) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回 task_id', { provider: 'bailian' });
    return { taskId };
  }

  async function videoPoll({ taskId, signal }) {
    if (!taskId) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, 'taskId 为空', { provider: 'bailian' });
    const res = await request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', signal });
    const data = await readJson(res);
    const out = data.output || {};
    switch (String(out.task_status || '').toUpperCase()) {
      case 'PENDING': return { status: 'pending' };
      case 'RUNNING': return { status: 'running' };
      case 'SUCCEEDED': {
        if (!out.video_url) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '成功但无 video_url', { provider: 'bailian' });
        // Verified: usage carries billed duration and resolution (t2v: size + SR, kf2v: SR only).
        const result = { status: 'succeeded', videoUrl: out.video_url };
        if (data.usage) result.usage = data.usage;
        if (out.actual_prompt) result.actualPrompt = out.actual_prompt;
        return result;
      }
      case 'FAILED':
      case 'CANCELED':
      case 'UNKNOWN': {
        // Task-level failures carry code/message inside output; map balance/access codes too.
        const e = out.code ? mapError(200, { code: out.code, message: out.message }) : null;
        const error = e && e.code !== ERROR_CODES.UNKNOWN
          ? e
          : new ProviderError(ERROR_CODES.TASK_FAILED, out.message || out.code || out.task_status, { provider: 'bailian', vendorCode: out.code });
        return { status: 'failed', error };
      }
      default:
        throw new ProviderError(ERROR_CODES.BAD_RESPONSE, `未知任务状态 ${out.task_status}`, { provider: 'bailian' });
    }
  }

  // ---- tts.synthesize: CosyVoice over WebSocket (message schema verified live, see live_tts_* fixtures) -----------------
  function ttsSynthesize({ model, text, voice, format, sampleRate, rate, pitch, volume, wordTimestamps, signal }) {
    return new Promise((resolve, reject) => {
      if (!apiKey) return reject(new ProviderError(ERROR_CODES.INVALID_API_KEY, '未配置 Key', { provider: 'bailian' }));
      if (!WS) return reject(new ProviderError(ERROR_CODES.NETWORK, '运行时无 WebSocket', { provider: 'bailian' }));
      const taskId = genId();
      const fmt = format || 'mp3';
      const chunks = [];
      const sentenceWords = new Map(); // sentence index -> latest words (events repeat and grow)
      let usage;
      let settled = false;
      let ws;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        try { if (ws) (typeof ws.terminate === 'function' ? ws.terminate() : ws.close()); } catch (_) { /* ignore */ }
        fn(v);
      };
      try {
        ws = new WS(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (e) {
        return reject(new ProviderError(ERROR_CODES.NETWORK, e.message, { provider: 'bailian' }));
      }
      if (signal) signal.addEventListener('abort', () => done(reject, new ProviderError(ERROR_CODES.NETWORK, 'aborted', { provider: 'bailian' })));
      const send = (o) => ws.send(JSON.stringify(o));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => send({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
          model: model || 'cosyvoice-v2',
          parameters: { text_type: 'PlainText', voice: voice || 'longxiaochun_v2', format: fmt, sample_rate: sampleRate || 22050, volume: volume ?? 50, rate: rate ?? 1, pitch: pitch ?? 1, ...(wordTimestamps ? { word_timestamp_enabled: true } : {}) },
          input: {},
        },
      });
      ws.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d !== 'string') { chunks.push(Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d)); return; }
        let m;
        try { m = JSON.parse(d); } catch (_) { return; }
        const event = m.header && m.header.event;
        if (event === 'task-started') {
          send({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text } } });
          send({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } });
        } else if (event === 'result-generated') {
          const out = m.payload && m.payload.output;
          const sentence = out && out.sentence;
          if (sentence && Array.isArray(sentence.words) && sentence.words.length) sentenceWords.set(sentence.index, sentence.words);
          if (m.payload && m.payload.usage) usage = m.payload.usage;
        } else if (event === 'task-finished') {
          if (!chunks.length) return done(reject, new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回音频', { provider: 'bailian' }));
          const result = { audio: Buffer.concat(chunks), format: fmt };
          if (wordTimestamps) {
            // Verified: begin_time/end_time are milliseconds from the start of the audio.
            result.words = [...sentenceWords.keys()].sort((a, b) => a - b).flatMap((k) => sentenceWords.get(k))
              .map((w) => ({ text: w.text, startMs: w.begin_time, endMs: w.end_time }));
          }
          const u = (m.payload && m.payload.usage) || usage;
          if (u) result.usage = u;
          done(resolve, result);
        } else if (event === 'task-failed') {
          done(reject, mapError(200, { code: m.header.error_code, message: m.header.error_message }));
        }
      };
      let opened = false;
      const onOpen = ws.onopen;
      ws.onopen = () => { opened = true; onOpen(); };
      // Verified: a bad key fails the handshake with no status or body visible to the client,
      // so probe the free models endpoint to tell an invalid key from a network failure.
      const handshakeFailed = (detail) => probeKey().then(
        (e) => done(reject, e || new ProviderError(ERROR_CODES.NETWORK, detail, { provider: 'bailian' })),
        () => done(reject, new ProviderError(ERROR_CODES.NETWORK, detail, { provider: 'bailian' })),
      );
      ws.onerror = (e) => {
        if (!opened) return void handshakeFailed((e && e.message) || 'websocket error');
        done(reject, new ProviderError(ERROR_CODES.NETWORK, (e && e.message) || 'websocket error', { provider: 'bailian' }));
      };
      ws.onclose = (e) => {
        if (settled) return;
        if (!opened) return void handshakeFailed(`closed ${e && e.code}`);
        // Verified: server closes with 1011 and the vendor message as reason after task-failed.
        done(reject, e && e.code === 1011 && e.reason ? mapError(200, { message: e.reason }) : new ProviderError(ERROR_CODES.NETWORK, `closed ${e && e.code}`, { provider: 'bailian' }));
      };
    });
  }

  /** Resolves to an INVALID_API_KEY error if the key is rejected, else null. */
  async function probeKey() {
    const res = await request(MODELS_PATH, { method: 'GET' });
    if (res.status === 401) {
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { /* ignore */ }
      return mapError(401, data || raw);
    }
    return null;
  }

  // ---- C05 connectivity probes: zero or near-zero cost, each verified against the real service ----
  // Resolve to { ok: true, costly: boolean } or reject with a ProviderError (key / model / balance ...).
  // UNVERIFIED: whether an account in arrears is rejected before parameter validation; if not,
  // image and video probes can pass for such an account and the first real call reports it.
  const probes = {
    // One-token chat: confirms key and that the chosen model is enabled (≈0.0001 元).
    async 'text.stream'({ model, signal } = {}) {
      const res = await request(CHAT_PATH, { body: { model: model || 'qwen-plus', messages: [{ role: 'user', content: '1' }], max_tokens: 1 }, signal });
      if (!res.ok) await readJson(res);
      return { ok: true, costly: true };
    },
    // Deliberately invalid size: the service checks key and model first, then rejects the size
    // with 400 InvalidParameter without generating anything.
    async 'image.generate'({ model, signal } = {}) {
      const body = { model: model || 'wan2.6-t2i', input: { messages: [{ role: 'user', content: [{ text: '1' }] }] }, parameters: { size: '1*1' } };
      return expectRejection(await request(IMAGE_PATH, { body, signal }), (st, d) => st === 400 && d && d.code === 'InvalidParameter');
    },
    // Without the async header the service answers 403 "does not support synchronous calls" after
    // checking key and model, so no task is created. (Bad parameters WITH the header do create a task.)
    async 'video.submit'({ model, signal } = {}) {
      const body = { model: model || 'wan2.6-t2v', input: { prompt: '1' } };
      return expectRejection(await request(VIDEO_PATH, { body, signal }), (st, d) => st === 403 && d && /synchronous/i.test(d.message || ''));
    },
    // One character of speech (≈0.0002 元).
    async 'tts.synthesize'({ model, voice, signal } = {}) {
      await ttsSynthesize({ model, voice, text: '好', signal });
      return { ok: true, costly: true };
    },
  };
  probes['video.poll'] = probes['video.submit'];

  async function expectRejection(res, isExpected) {
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (_) { /* ignore */ }
    if (isExpected(res.status, data)) return { ok: true, costly: false };
    if (!res.ok) throw mapError(res.status, data || raw);
    throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '探测请求意外成功', { provider: 'bailian' });
  }

  return {
    id: 'bailian',
    probes,
    label: '阿里云百炼',
    capabilities: {
      'text.stream': textStream,
      'image.generate': imageGenerate,
      'video.submit': videoSubmit,
      'video.poll': videoPoll,
      'tts.synthesize': ttsSynthesize,
    },
  };
}

module.exports = { createBailianAdapter, mapError };
