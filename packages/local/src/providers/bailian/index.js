'use strict';
/**
 * 阿里云百炼 (DashScope) adapter. Phase-1 provider id: "bailian".
 *
 * Request shapes reused from services/imageClient.js (wan2.6-image, sync multimodal-generation)
 * and services/videoClient.js (video-synthesis async submit + /api/v1/tasks/{id} poll).
 *
 * UNCERTAIN (not verifiable without a real key / full docs; marked "UNVERIFIED" below):
 *  - CosyVoice WebSocket message JSON (help.aliyun.com page reachable but omits the JSON schema;
 *    shapes below come from the public DashScope SDK protocol as recalled).
 *  - Exact vendor error code strings for arrearage / model access (matched loosely on code + message).
 *  - Default model names (qwen-plus, wan2.6-image, wan2.6-t2v, cosyvoice-v2) may be renamed by the vendor.
 */
const { ProviderError, ERROR_CODES } = require('../errors');

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
const DEFAULT_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
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
  } else if (/model\.?(accessdenied|notfound)|model_not_found|modelnotfound|access denied|accessdenied|not (been )?(activated|enabled|opened)|未开通/.test(hay) || status === 403 || status === 404) {
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
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const wsUrl = cfg.wsUrl || DEFAULT_WS;
  const doFetch = cfg.fetch || ((...a) => globalThis.fetch(...a));
  const WS = cfg.WebSocket || globalThis.WebSocket;
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

  // ---- image.generate: wan2.6-image sync endpoint (shape from imageClient.js) -------------
  async function imageGenerate({ model, prompt, size, referenceImages, negativePrompt, signal }) {
    const content = [{ text: prompt || '' }];
    for (const img of (referenceImages || []).filter(Boolean).slice(0, 10)) content.push({ image: img });
    const parameters = {
      prompt_extend: true,
      watermark: false,
      n: 1,
      // wan2.6-image: enable_interleave=false requires stream=false; we use sync (non-SSE) only.
      enable_interleave: false,
      stream: false,
      size: size || '1280*720',
    };
    if (negativePrompt) parameters.negative_prompt = negativePrompt;
    const body = { model: model || 'wan2.6-image', input: { messages: [{ role: 'user', content }] }, parameters };
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
        return { status: 'succeeded', videoUrl: out.video_url };
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

  // ---- tts.synthesize: CosyVoice over WebSocket (UNVERIFIED message schema) -----------------
  function ttsSynthesize({ model, text, voice, format, sampleRate, rate, pitch, volume, signal }) {
    return new Promise((resolve, reject) => {
      if (!apiKey) return reject(new ProviderError(ERROR_CODES.INVALID_API_KEY, '未配置 Key', { provider: 'bailian' }));
      if (!WS) return reject(new ProviderError(ERROR_CODES.NETWORK, '运行时无 WebSocket', { provider: 'bailian' }));
      const taskId = genId();
      const fmt = format || 'mp3';
      const chunks = [];
      let settled = false;
      let ws;
      const done = (fn, v) => { if (settled) return; settled = true; try { ws && ws.close(); } catch (_) { /* ignore */ } fn(v); };
      try {
        // Node >=22 global (undici) WebSocket accepts {headers}; pass a `WebSocket` impl (e.g. ws) via cfg otherwise.
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
          parameters: { text_type: 'PlainText', voice: voice || 'longxiaochun_v2', format: fmt, sample_rate: sampleRate || 22050, volume: volume ?? 50, rate: rate ?? 1, pitch: pitch ?? 1 },
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
        } else if (event === 'task-finished') {
          if (!chunks.length) return done(reject, new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回音频', { provider: 'bailian' }));
          done(resolve, { audio: Buffer.concat(chunks), format: fmt });
        } else if (event === 'task-failed') {
          done(reject, mapError(200, { code: m.header.error_code, message: m.header.error_message }));
        }
      };
      ws.onerror = (e) => done(reject, new ProviderError(ERROR_CODES.NETWORK, (e && e.message) || 'websocket error', { provider: 'bailian' }));
      ws.onclose = (e) => {
        // Handshake rejections (401/403) surface as close/error without a body; best-effort map.
        const c = e && e.code;
        if (!settled) done(reject, c === 1006 ? new ProviderError(ERROR_CODES.NETWORK, '连接被关闭（可能是 Key 无效，UNVERIFIED）', { provider: 'bailian' }) : new ProviderError(ERROR_CODES.NETWORK, `closed ${c}`, { provider: 'bailian' }));
      };
    });
  }

  return {
    id: 'bailian',
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
