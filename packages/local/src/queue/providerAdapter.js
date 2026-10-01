'use strict';
/**
 * Glue between the capability facades (src/providers: image.generate, video.submit/poll,
 * tts.synthesize) and the queue's provider interface (submit/poll[/download][/lookupByKey]).
 *
 * Credentials are resolved from the user's saved AI configs and the secret store on every call
 * (so config edits apply without a restart) and only ever live in memory inside this module.
 * Nothing here logs, stores or returns a key.
 *
 * Task kinds: 'video' (real async vendor task), 'image' and 'tts' (synchronous vendor calls).
 * A synchronous call completes inside submit(); its outcome is encoded in the vendor task id as
 * `sync:<base64url json>` (the id is written durably right after submit), so poll() simply decodes
 * it and a crash between submit and poll cannot lose a paid result. TTS audio is written to the
 * content-addressed store first and only its reference travels in the id.
 *
 * lookupByKey is not provided: neither vendor API accepts a client idempotency key, so an uncertain
 * submit stays SUBMIT_UNCERTAIN (never resubmitted) by design.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ProviderError, ERROR_CODES } = require('../providers/errors');
const { blobPath } = require('./download');

const KINDS = Object.freeze(['image', 'video', 'tts']);
const SERVICE_TYPES = { image: ['image', 'storyboard_image'], video: ['video'], tts: ['tts'] };
const { KNOWN_PROVIDERS, getEnabled } = require('../providers/enablement');
// Config-provider names per queue provider; single source is providers/enablement.js.
const PROVIDER_ALIASES = Object.fromEntries(Object.values(KNOWN_PROVIDERS).map((m) => [m.id, [...m.aliases]]));
const SYNC_PREFIX = 'sync:';

const encodeSync = (obj) => SYNC_PREFIX + Buffer.from(JSON.stringify(obj)).toString('base64url');
const decodeSync = (id) => JSON.parse(Buffer.from(String(id).slice(SYNC_PREFIX.length), 'base64url').toString('utf8'));

/** Task params minus internal metadata (`_project`, ...), which never reach a vendor. */
function vendorParams(task) {
  let p = {};
  try { p = task.params ? JSON.parse(task.params) : {}; } catch (_) { /* ignore */ }
  const out = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function parseSettings(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s) || {}; } catch (_) { return {}; }
}

/** First active config (list order: default, priority) for a queue provider and kind. */
function pickConfig(listConfigs, provider, kind) {
  const names = PROVIDER_ALIASES[provider] || [provider];
  for (const type of SERVICE_TYPES[kind] || []) {
    for (const c of listConfigs(type) || []) {
      if (c.is_active === false) continue;
      if (names.includes(String(c.provider || '').toLowerCase())) return c;
    }
  }
  return null;
}

/**
 * Any active config of the same provider that holds a key, regardless of service type. One 百炼 key serves
 * text, image, video and CosyVoice, so a user who only saved the text config (the onboarding wizard does)
 * can still run image/video/tts tasks. Returns null for ark tts, whose speech token is a separate credential.
 */
function pickSharedKeyConfig(listConfigs, provider, kind) {
  if (provider === 'ark' && kind === 'tts') return null;
  const names = PROVIDER_ALIASES[provider] || [provider];
  for (const type of ['text', 'image', 'storyboard_image', 'video', 'tts']) {
    for (const c of listConfigs(type) || []) {
      if (c.is_active === false || !c.api_key) continue;
      if (names.includes(String(c.provider || '').toLowerCase())) return c;
    }
  }
  return null;
}

/**
 * The saved default model may not fit the request (wan2.6-image only edits with references; the first-frame and
 * image-to-video models need an image; the text-to-video model is the fallback). Returns undefined to let the
 * adapter pick by request shape. An explicit params.model is never touched.
 */
function modelFitsRequest(provider, kind, model, params) {
  if (provider !== 'bailian' || !model) return model;
  if (kind === 'image') {
    const hasRefs = Array.isArray(params.referenceImages) && params.referenceImages.some(Boolean);
    return model === 'wan2.6-image' && !hasRefs ? undefined : model;
  }
  if (kind === 'video') {
    const hasImage = !!(params.firstFrameUrl || params.imageUrl);
    if (!hasImage && (model === 'wan2.2-kf2v-flash' || model === 'wan2.6-i2v-flash')) return undefined;
    if (hasImage && model === 'wan2.6-t2v') return 'wan2.2-kf2v-flash';
    return model;
  }
  return model;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_INLINE_BYTES = 10 * 1024 * 1024; // DashScope limit for base64 image input
const MEDIA_FIELDS = ['referenceImages', 'referenceUrls', 'imageUrl', 'firstFrameUrl', 'lastFrameUrl'];

/** Content-addressed blobs carry no extension, so look at the magic bytes first. */
function sniffMime(b) {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'image/png';
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 11 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Local images (saved character references, first frames) cannot be fetched by the vendor. Values that are not
 * http(s)/data/oss URLs are resolved below the storage dir (relative path, /static/<rel>, or an absolute path inside it)
 * and inlined as data: URIs. Unresolvable values are left alone so the vendor error stays visible.
 */
function inlineLocalMedia(params, storageDir) {
  const conv = (v) => {
    if (typeof v !== 'string' || !v || /^(https?:|data:|oss:)/i.test(v)) return v;
    const rel = v.startsWith('/static/') ? v.slice('/static/'.length) : v;
    const root = path.resolve(storageDir);
    const abs = path.resolve(root, rel);
    const within = path.relative(root, abs);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) return v; // never read outside the storage dir
    let st;
    try { st = fs.statSync(abs); } catch (_) { return v; }
    if (!st.isFile()) return v;
    if (st.size > MAX_INLINE_BYTES) throw new ProviderError(ERROR_CODES.INVALID_PARAMS, `本地图片超过 10MB，无法内联：${path.basename(abs)}`);
    const buf = fs.readFileSync(abs);
    return `data:${sniffMime(buf) || MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`;
  };
  const out = { ...params };
  for (const k of MEDIA_FIELDS) {
    if (Array.isArray(out[k])) out[k] = out[k].map(conv);
    else if (out[k] != null) out[k] = conv(out[k]);
  }
  return out;
}

function facadeConfigFor(provider, config) {
  const apiKey = config.api_key || '';
  const baseUrl = config.base_url || undefined;
  if (provider === 'ark') {
    const s = parseSettings(config.settings);
    const out = { apiKey, baseUrl };
    if (config.service_type === 'tts') {
      // Volcengine speech: the saved Key is the Access Token; app id / cluster live in settings.
      out.speech = { appId: s.app_id || s.appId, accessToken: apiKey, cluster: s.cluster };
    }
    return out;
  }
  return { apiKey, baseUrl };
}

function defaultModel(config) {
  if (!config) return undefined;
  if (config.default_model) return config.default_model;
  return Array.isArray(config.model) && config.model.length ? config.model[0] : undefined;
}

/**
 * @param {object} o
 * @param {string} o.storageDir
 * @param {(serviceType:string)=>object[]} o.listConfigs  configs with plaintext api_key (in memory only)
 * @param {Function} [o.createProviders]  src/providers createProviders (injectable for tests)
 */
function createQueueProvider(provider, { storageDir, listConfigs, createProviders = require('../providers').createProviders }) {
  function resolve(kind) {
    const own = pickConfig(listConfigs, provider, kind);
    const config = own && own.api_key ? own : pickSharedKeyConfig(listConfigs, provider, kind);
    const shared = config !== own;
    if (!config || !config.api_key) {
      throw new ProviderError(ERROR_CODES.INVALID_API_KEY, `未配置 ${provider} 的 ${kind} 服务或 Key`, { provider });
    }
    return { config, shared, facade: createProviders({ [provider]: facadeConfigFor(provider, config) }) };
  }

  async function writeBlob(buf) {
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const dest = blobPath(storageDir, sha256);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
    }
    return { sha256, size: buf.length, path: path.relative(storageDir, dest).split(path.sep).join('/') };
  }

  return {
    async submit(task) {
      const kind = task.kind;
      if (!KINDS.includes(kind)) throw new ProviderError(ERROR_CODES.CAPABILITY_NOT_SUPPORTED, `kind ${kind}`, { provider });
      const { config, shared, facade } = resolve(kind);
      let params = vendorParams(task);
      // A borrowed config (other service type, same key) never lends its model name.
      if (!params.model && !shared) {
        const m = modelFitsRequest(provider, kind, defaultModel(config), params);
        if (m) params.model = m;
      }
      if (kind === 'image' || kind === 'video') params = inlineLocalMedia(params, storageDir);
      if (kind === 'video') {
        const r = await facade.video.submit(provider, params);
        if (!r || !r.taskId) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'missing video task id', { provider });
        return { vendorTaskId: r.taskId };
      }
      if (kind === 'image') {
        const r = await facade.image.generate(provider, params);
        if (!r || !Array.isArray(r.urls) || !r.urls.length) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'no image urls', { provider });
        return { vendorTaskId: encodeSync({ urls: r.urls }) };
      }
      const r = await facade.tts.synthesize(provider, params);
      if (!r || !r.audio || !r.audio.length) throw new ProviderError(ERROR_CODES.BAD_RESPONSE, 'empty audio', { provider });
      const out = { format: r.format || params.format || 'mp3', ...(await writeBlob(Buffer.from(r.audio))) };
      if (Array.isArray(r.words)) out.words = r.words.length ? { ...(await writeBlob(Buffer.from(JSON.stringify(r.words)))), count: r.words.length } : { count: 0 };
      return { vendorTaskId: encodeSync(out) };
    },

    async poll(task) {
      const id = String(task.vendor_task_id || '');
      if (id.startsWith(SYNC_PREFIX)) {
        let res;
        try { res = decodeSync(id); } catch (_) { return { status: 'failed', errorCode: ERROR_CODES.BAD_RESPONSE, errorMessage: 'unreadable synchronous result' }; }
        return { status: 'succeeded', result: res };
      }
      if (task.kind !== 'video') return { status: 'failed', errorCode: ERROR_CODES.BAD_RESPONSE, errorMessage: `unexpected vendor id for ${task.kind}` };
      const { facade } = resolve('video');
      const r = await facade.video.poll(provider, { taskId: id });
      if (r.status === 'succeeded') return { status: 'succeeded', result: { url: r.videoUrl } };
      if (r.status === 'failed') {
        const e = r.error;
        return { status: 'failed', errorCode: e && e.code, errorMessage: e && e.message };
      }
      return { status: 'running' };
    },
  };
}

/**
 * Provider map for createApp({ queueProviders }): one queue provider per enabled provider id (providers.enabled).
 * Providers are always present; a missing config/key surfaces as a readable INVALID_API_KEY task error.
 */
function buildQueueProviders({ db, storageDir, listConfigs, createProviders, providers = getEnabled() }) {
  const list = listConfigs || ((type) => require('../services/aiConfigService').listConfigsInternal(db, type));
  const out = {};
  for (const p of providers) out[p] = createQueueProvider(p, { storageDir, listConfigs: list, createProviders });
  return out;
}

module.exports = { KINDS, createQueueProvider, buildQueueProviders, pickConfig, pickSharedKeyConfig, modelFitsRequest, inlineLocalMedia, vendorParams, PROVIDER_ALIASES };
