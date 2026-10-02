'use strict';
/**
 * 火山方舟 (Ark) adapter. Phase-1 provider id: "ark".
 *
 * Capabilities: text.stream (Doubao, OpenAI-compatible SSE), image.generate (Seedream),
 * video.submit/video.poll (Seedance async task), tts.synthesize (火山语音 / Volcengine speech).
 *
 * DESIGN CHOICE (TTS): speech is registered as capability `tts.synthesize` under provider "ark"
 * (not a separate "volc-speech" id) so PHASE1_PROVIDERS ('bailian','ark') stays unchanged and the UI
 * shows one "火山引擎" provider. Credentials differ though: Ark uses `apiKey` (Bearer), speech uses
 * `speech: { appId, accessToken, cluster? }`. Missing speech creds yield a readable INVALID_API_KEY
 * error without touching the network; other capabilities do not need them.
 *
 * Verification status (WebFetch of docs.volcengine.com returns only page summaries, no JSON bodies):
 *  - VERIFIED (summary level + existing repo code in services/videoClient.js): base
 *    https://ark.cn-beijing.volces.com/api/v3; POST /contents/generations/tasks, GET .../tasks/{id};
 *    content[] with text + image_url{role:first_frame|last_frame}; Seedream POST /images/generations with
 *    model/prompt/size/response_format/watermark/image, response data[].url; error names AuthenticationError,
 *    ModelNotOpen, AccountOverdueError, RateLimit*; TTS body fields app{appid,token,cluster}, user{uid},
 *    audio{voice_type,encoding,speed_ratio}, request{reqid,text,operation}, response code 3000 + base64 data.
 *  - UNVERIFIED (from memory, needs a real key): exact vendor error code strings beyond those above;
 *    video duration/resolution passed as `--dur/--rs/--wm` text flags (newer API versions accept top-level
 *    fields); TTS endpoint https://openspeech.bytedance.com/api/v1/tts, `Authorization: Bearer;{token}`
 *    (semicolon, not space), TTS error codes 3001..3050; default model/voice names (may be renamed by the
 *    vendor); task statuses queued|running|succeeded|failed|cancelled|expired.
 */
const { ProviderError, ERROR_CODES } = require('../errors');

const PROVIDER = 'ark';
const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts';

/** Map an Ark failure (HTTP status + body {error:{code,message}}) to a unified ProviderError. */
function mapError(status, body, extra = {}) {
  const err = (body && typeof body.error === 'object' && body.error) || body || {};
  const vendorCode = String(err.code || err.type || '');
  const message = String(err.message || (typeof body === 'string' ? body : '') || '');
  const hay = `${vendorCode} ${message}`.toLowerCase();
  const opts = { provider: PROVIDER, status, vendorCode: vendorCode || null, ...extra };
  let code;
  if (/accountoverdue|overdue|arrear|insufficient[_ ]?(balance|fund)|欠费|余额/.test(hay)) {
    code = ERROR_CODES.INSUFFICIENT_BALANCE;
  } else if (status === 401 || /authenticationerror|invalid[_ ]?api[_ ]?key|api key.*(invalid|incorrect|not)/.test(hay)) {
    code = ERROR_CODES.INVALID_API_KEY;
  } else if (/modelnotopen|invalidendpointormodel|notfound|model.*not.*(open|activated|enabled|exist)|未开通|accessdenied/.test(hay) || status === 403 || status === 404) {
    code = ERROR_CODES.MODEL_NOT_ENABLED;
  } else if (status === 429 || /ratelimit|rate_limit|quotaexceeded|setlimitexceeded|too many requests|servertoobusy/.test(hay)) {
    code = ERROR_CODES.RATE_LIMITED;
  } else if (status === 400 || /invalidparameter|badrequest|missingparameter/.test(hay)) {
    code = ERROR_CODES.INVALID_PARAMS;
  } else {
    code = ERROR_CODES.UNKNOWN;
  }
  return new ProviderError(code, message || vendorCode || `HTTP ${status}`, opts);
}

/** Map a speech (openspeech) failure. UNVERIFIED code table; matched loosely on code + message. */
function mapSpeechError(status, body) {
  const b = (body && typeof body === 'object') ? body : {};
  const vendorCode = String(b.code != null ? b.code : (b.error && b.error.code) || '');
  const message = String(b.message || b.Message || (b.error && b.error.message) || (typeof body === 'string' ? body : '') || '');
  const hay = `${vendorCode} ${message}`.toLowerCase();
  const opts = { provider: PROVIDER, status, vendorCode: vendorCode || null };
  let code;
  if (/arrear|overdue|insufficient|balance|欠费|余额/.test(hay)) code = ERROR_CODES.INSUFFICIENT_BALANCE;
  else if (status === 401 || /invalid auth token|authenticat|invalid token|appid/.test(hay)) code = ERROR_CODES.INVALID_API_KEY;
  else if (/not granted|not (been )?(open|activated|authorized)|voice.*not.*(found|exist)|3050|3040|未开通|无权限/.test(hay) || status === 403 || status === 404) code = ERROR_CODES.MODEL_NOT_ENABLED;
  else if (status === 429 || /3003|3005|concurren|rate|too many|busy|qps/.test(hay)) code = ERROR_CODES.RATE_LIMITED;
  else if (status === 400 || /3001|3010|invalid|param|too long/.test(hay)) code = ERROR_CODES.INVALID_PARAMS;
  else code = ERROR_CODES.UNKNOWN;
  return new ProviderError(code, message || vendorCode || `HTTP ${status}`, opts);
}

function createArkAdapter(cfg = {}) {
  const apiKey = cfg.apiKey;
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const speech = cfg.speech || {};
  const ttsUrl = speech.url || DEFAULT_TTS_URL;
  const doFetch = cfg.fetch || ((...a) => globalThis.fetch(...a));
  const genId = cfg.idGenerator || (() => require('crypto').randomUUID());

  async function request(path, { method = 'POST', body, signal } = {}) {
    if (!apiKey) throw new ProviderError(ERROR_CODES.INVALID_API_KEY, '未配置 Key', { provider: PROVIDER });
    try {
      return await doFetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ProviderError(ERROR_CODES.NETWORK, e.message, { provider: PROVIDER });
    }
  }

  async function readJson(res) {
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* leave null */ }
    if (!res.ok) throw mapError(res.status, data || raw);
    if (data && data.error && !data.status) throw mapError /* task bodies carry error + status */(res.status, data);
    if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '非 JSON', { provider: PROVIDER });
    return data;
  }

  // ---- text.stream: Doubao via OpenAI-compatible /chat/completions SSE --------------------
  async function* textStream({ model, messages, temperature, maxTokens, signal }) {
    const body = {
      model: model || 'doubao-seed-1-6-250615', // default name UNVERIFIED; endpoint ids (ep-...) also accepted
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;
    const res = await request('/chat/completions', { body, signal });
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
      return t || null; // reasoning_content deltas (thinking models) are intentionally skipped
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

  // ---- image.generate: Seedream POST /images/generations ---------------------------------
  async function imageGenerate({ model, prompt, size, referenceImages, signal }) {
    const body = {
      model: model || 'doubao-seedream-4-0-250828', // default name UNVERIFIED
      prompt: prompt || '',
      response_format: 'url',
      watermark: false,
    };
    if (size) body.size = size; // e.g. "2K" or "2048x2048"
    const refs = (referenceImages || []).filter(Boolean).slice(0, 10);
    if (refs.length) body.image = refs.length === 1 ? refs[0] : refs;
    const data = await readJson(await request('/images/generations', { body, signal }));
    const urls = (data.data || []).map((d) => d && d.url).filter(Boolean);
    if (!urls.length) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回图片', { provider: PROVIDER });
    return { urls };
  }

  // ---- video.submit / video.poll: Seedance async task ------------------------------------
  async function videoSubmit(r) {
    const flags = [];
    if (r.resolution) flags.push(`--rs ${String(r.resolution).toLowerCase()}`);
    flags.push(`--dur ${r.duration ? Number(r.duration) : 5}`);
    flags.push('--wm false');
    const content = [{ type: 'text', text: `${r.prompt || ''} ${flags.join(' ')}`.trim() }];
    const first = r.firstFrameUrl || r.imageUrl;
    if (first) content.push({ type: 'image_url', image_url: { url: first }, role: 'first_frame' });
    if (r.lastFrameUrl) content.push({ type: 'image_url', image_url: { url: r.lastFrameUrl }, role: 'last_frame' });
    for (const u of (r.referenceUrls || []).filter(Boolean).slice(0, 4)) {
      content.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' });
    }
    const body = { model: r.model || 'doubao-seedance-1-0-pro-250528', content }; // default name UNVERIFIED
    const data = await readJson(await request('/contents/generations/tasks', { body, signal: r.signal }));
    if (!data.id) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回任务 id', { provider: PROVIDER });
    return { taskId: data.id };
  }

  async function videoPoll({ taskId, signal }) {
    if (!taskId) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, 'taskId 为空', { provider: PROVIDER });
    const data = await readJson(await request(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', signal }));
    switch (String(data.status || '').toLowerCase()) {
      case 'queued': return { status: 'pending' };
      case 'running': return { status: 'running' };
      case 'succeeded': {
        const url = data.content && data.content.video_url;
        if (!url) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '成功但无 video_url', { provider: PROVIDER });
        return { status: 'succeeded', videoUrl: url };
      }
      case 'failed':
      case 'cancelled':
      case 'expired': {
        const e = data.error ? mapError(200, { error: data.error }) : null;
        const error = e && e.code !== ERROR_CODES.UNKNOWN
          ? e
          : new ProviderError(ERROR_CODES.TASK_FAILED, (data.error && data.error.message) || data.status, { provider: PROVIDER, vendorCode: data.error && data.error.code });
        return { status: 'failed', error };
      }
      default:
        throw new ProviderError(ERROR_CODES.BAD_RESPONSE, `未知任务状态 ${data.status}`, { provider: PROVIDER });
    }
  }

  // ---- tts.synthesize: Volcengine speech HTTP (non-streaming) ----------------------------
  async function ttsSynthesize({ model, text, voice, format, sampleRate, rate, pitch, volume, signal }) {
    if (!speech.appId || !speech.accessToken) {
      throw new ProviderError(ERROR_CODES.INVALID_API_KEY, '火山语音 AppID / Access Token 未配置，请在设置中填写（控制台：语音技术 → 应用管理）', { provider: PROVIDER });
    }
    const fmt = format || 'mp3';
    const body = {
      app: { appid: speech.appId, token: speech.accessToken, cluster: model || speech.cluster || 'volcano_tts' },
      user: { uid: speech.uid || 'talekiln' },
      audio: {
        voice_type: voice || 'zh_female_vv_uranus_bigtts', // default voice UNVERIFIED; must be enabled for the AppID
        encoding: fmt,
        rate: sampleRate || 24000,
        speed_ratio: rate ?? 1.0,
        volume_ratio: volume ?? 1.0,
        pitch_ratio: pitch ?? 1.0,
      },
      request: { reqid: genId(), text, text_type: 'plain', operation: 'query' },
    };
    let res;
    try {
      res = await doFetch(ttsUrl, {
        method: 'POST',
        // Volcengine speech requires "Bearer;" (semicolon) before the token. UNVERIFIED against live service.
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${speech.accessToken}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ProviderError(ERROR_CODES.NETWORK, e.message, { provider: PROVIDER });
    }
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* leave null */ }
    if (!res.ok) throw mapSpeechError(res.status, data || raw);
    if (!data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '非 JSON', { provider: PROVIDER });
    if (Number(data.code) !== 3000) throw mapSpeechError(res.status, data);
    if (!data.data) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '未返回音频', { provider: PROVIDER });
    return { audio: Buffer.from(data.data, 'base64'), format: fmt };
  }

  // ---- C05 connectivity probes (same contract as bailian: resolve {ok, costly} or throw) ------
  // UNVERIFIED: written without an Ark key. The image probe relies on Ark validating key and model
  // before the size parameter (true for 百炼, assumed here); the video probe only lists tasks, so it
  // checks the key but not whether the Seedance model is enabled (modelChecked: false).
  const probes = {
    // One-token chat (near zero cost).
    async 'text.stream'({ model, signal } = {}) {
      const body = { model: model || 'doubao-seed-1-6-250615', messages: [{ role: 'user', content: '1' }], max_tokens: 1 };
      await readJson(await request('/chat/completions', { body, signal }));
      return { ok: true, costly: true };
    },
    // Deliberately invalid size: expect 400 InvalidParameter with nothing generated.
    async 'image.generate'({ model, signal } = {}) {
      const body = { model: model || 'doubao-seedream-4-0-250828', prompt: '1', size: '1x1', response_format: 'url' };
      const res = await request('/images/generations', { body, signal });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { /* ignore */ }
      const e = !res.ok ? mapError(res.status, data || raw) : null;
      if (e && e.code === ERROR_CODES.INVALID_PARAMS) return { ok: true, costly: false };
      if (e) throw e;
      throw new ProviderError(ERROR_CODES.BAD_RESPONSE, '探测请求意外成功', { provider: PROVIDER });
    },
    // List one task: confirms the key without creating anything.
    async 'video.submit'({ signal } = {}) {
      await readJson(await request('/contents/generations/tasks?page_num=1&page_size=1', { method: 'GET', signal }));
      return { ok: true, costly: false, modelChecked: false };
    },
    // One character of speech (near zero cost); missing AppID / token fails without network.
    async 'tts.synthesize'({ model, voice, signal } = {}) {
      await ttsSynthesize({ model, voice, text: '好', signal });
      return { ok: true, costly: true };
    },
  };
  probes['video.poll'] = probes['video.submit'];

  return {
    id: PROVIDER,
    label: '火山方舟',
    probes,
    capabilities: {
      'text.stream': textStream,
      'image.generate': imageGenerate,
      'video.submit': videoSubmit,
      'video.poll': videoPoll,
      'tts.synthesize': ttsSynthesize,
    },
  };
}

module.exports = { createArkAdapter, mapError, mapSpeechError };
