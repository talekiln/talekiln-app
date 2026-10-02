'use strict';
/**
 * Test fixture: a standalone copy of packages/plugin-sdk/examples/acme (fictional vendor api.acme.example).
 * It does not require the SDK, like a real plugin that bundles its own copy: the host bridges errors by `code`.
 */
const ERROR_CODES = {
  INVALID_API_KEY: 'INVALID_API_KEY', MODEL_NOT_ENABLED: 'MODEL_NOT_ENABLED', INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  RATE_LIMITED: 'RATE_LIMITED', INVALID_PARAMS: 'INVALID_PARAMS', TASK_FAILED: 'TASK_FAILED', NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE', UNKNOWN: 'UNKNOWN',
};

class PluginError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail || String(code));
    this.name = 'PluginError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.UNKNOWN;
    this.detail = detail || '';
    this.status = extra.status || null;
    this.vendorCode = extra.vendorCode || null;
  }
}

const DEFAULT_BASE = 'https://api.acme.example';

function mapError(status, body, extra = {}) {
  const raw = body && typeof body === 'object' ? body : {};
  const err = raw.error && typeof raw.error === 'object' ? raw.error : raw;
  const vendorCode = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : (typeof body === 'string' ? body : '');
  const hay = `${vendorCode} ${message}`.toLowerCase();
  let code;
  if (/arrears|insufficient|balance/.test(hay)) code = ERROR_CODES.INSUFFICIENT_BALANCE;
  else if (status === 401 || /invalid.?api.?key/.test(hay)) code = ERROR_CODES.INVALID_API_KEY;
  else if (/model.*(not|access)/.test(hay) || status === 403 || status === 404) code = ERROR_CODES.MODEL_NOT_ENABLED;
  else if (status === 429) code = ERROR_CODES.RATE_LIMITED;
  else if (status === 400) code = ERROR_CODES.INVALID_PARAMS;
  else code = ERROR_CODES.UNKNOWN;
  return new PluginError(code, (message || vendorCode || `HTTP ${status}`).slice(0, 200), { status, vendorCode: vendorCode || null, ...extra });
}

function createAdapter(ctx) {
  const base = (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');

  async function request(path, { body, signal } = {}) {
    if (!ctx.apiKey) throw new PluginError(ERROR_CODES.INVALID_API_KEY, 'API key not configured');
    try {
      return await ctx.fetch(base + path, {
        method: 'POST', signal, body: JSON.stringify(body || {}),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
      });
    } catch (e) {
      if (e instanceof PluginError) throw e;
      throw new PluginError(ERROR_CODES.NETWORK, 'network request failed');
    }
  }

  async function json(res) {
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
    if (!res.ok) throw mapError(res.status, data || raw);
    if (!data || typeof data !== 'object') throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'not JSON');
    return data;
  }

  const capabilities = {
    async 'llm.chat'({ model, messages, temperature, maxTokens, signal }) {
      const d = await json(await request('/v1/chat', { body: { model: model || 'acme-chat-1', messages, temperature, max_tokens: maxTokens }, signal }));
      if (typeof d.text !== 'string') throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'no text');
      return { text: d.text, usage: d.usage };
    },
    async 'image.generate'({ model, prompt, size, referenceImages, signal }) {
      const d = await json(await request('/v1/images', { body: { model: model || 'acme-img-1', prompt, size, refs: referenceImages }, signal }));
      const urls = (Array.isArray(d.data) ? d.data : []).map((x) => x && x.url).filter(Boolean);
      if (!urls.length) throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'no image returned');
      return { urls };
    },
    async 'video.submit'({ model, prompt, imageUrl, duration, resolution, signal }) {
      const d = await json(await request('/v1/videos', { body: { model: model || 'acme-vid-1', prompt, image: imageUrl, duration, resolution }, signal }));
      if (!d.task_id) throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'no task id');
      return { taskId: String(d.task_id) };
    },
    async 'video.poll'({ taskId, signal }) {
      const d = await json(await request('/v1/videos/status', { body: { task_id: taskId }, signal }));
      const map = { queued: 'pending', running: 'running', done: 'succeeded', failed: 'failed' };
      const status = map[d.state];
      if (!status) throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'unknown task state');
      if (status === 'succeeded' && !d.video_url) throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'no video url');
      return {
        status, videoUrl: d.video_url, usage: d.usage,
        error: status === 'failed' ? new PluginError(ERROR_CODES.TASK_FAILED, String(d.reason || 'task failed').slice(0, 200)) : undefined,
      };
    },
    async 'tts.synthesize'({ model, text, voice, format, wordTimestamps, signal }) {
      const d = await json(await request('/v1/tts', { body: { model: model || 'acme-tts-1', text, voice, format: format || 'mp3', timestamps: !!wordTimestamps }, signal }));
      if (typeof d.audio_base64 !== 'string' || !d.audio_base64) throw new PluginError(ERROR_CODES.BAD_RESPONSE, 'no audio');
      const out = { audio: Buffer.from(d.audio_base64, 'base64'), format: d.format || format || 'mp3', usage: d.usage };
      if (wordTimestamps) out.words = (d.words || []).map((w) => ({ text: String(w.t), startMs: Number(w.s), endMs: Number(w.e) }));
      return out;
    },
  };

  async function probe(capability, { signal } = {}) {
    const path = { 'llm.chat': '/v1/chat', 'image.generate': '/v1/images', 'video.submit': '/v1/videos', 'video.poll': '/v1/videos/status', 'tts.synthesize': '/v1/tts' }[capability];
    const res = await request(path, { body: { probe: true }, signal });
    if (res.status === 400) return { ok: true, costly: false };
    await json(res);
    return { ok: true, costly: true };
  }

  return { capabilities, probe, mapError };
}

module.exports = { createAdapter, mapError };
