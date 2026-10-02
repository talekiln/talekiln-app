'use strict';
/**
 * Bridge: SDK adapter -> host registry adapter (packages/local/src/providers/registry.js shape):
 *   { id, label, capabilities: { 'text.stream' | ... }, probes }
 *
 * - `llm.chat` becomes `text.stream`. The plugin may return Promise<{text, usage?}> (bridged to one delta + done)
 *   or an async iterable of {type:'delta'|'done'} events (passed through).
 * - PluginError (or any thrown error) becomes the host's ProviderError; the host class is injected so this file
 *   has no dependency on the host. API key values listed in `secrets` are scrubbed from error text.
 * - Nothing here changes existing providers; wire a plugin by `registry.register(toRegistryAdapter(...))`.
 */
const { ERROR_CODES } = require('./errors');

const HOST_NAME = Object.freeze({ 'llm.chat': 'text.stream' });
const hostName = (cap) => HOST_NAME[cap] || cap;

function makeRedactor(secrets) {
  const list = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 4);
  return (text) => list.reduce((t, s) => String(t).split(s).join('***'), String(text == null ? '' : text));
}

/**
 * @param {{adapter: object, manifest: object, id?: string, label?: string}} instance result of instantiate()
 * @param {{ProviderError: Function, secrets?: string[]}} opts
 */
function toRegistryAdapter(instance, { ProviderError, secrets } = {}) {
  if (typeof ProviderError !== 'function') throw new TypeError('ProviderError class is required');
  const { adapter, manifest } = instance;
  const id = instance.id || manifest.name;
  const redact = makeRedactor(secrets);

  function toProviderError(e) {
    if (e && e.name === 'ProviderError') return e;
    const code = e && typeof e.code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, e.code) ? e.code : ERROR_CODES.UNKNOWN;
    const detail = redact((e && (e.detail || e.message)) || 'plugin error');
    return new ProviderError(code, detail, { provider: id, status: (e && e.status) || null, vendorCode: (e && e.vendorCode) || null });
  }

  const wrapAsync = (cap, fn) => async (req) => {
    let out;
    try { out = await fn(req || {}); } catch (e) { throw toProviderError(e); }
    if (cap === 'video.poll' && out && out.error) out = { ...out, error: toProviderError(out.error) };
    return out;
  };

  async function* chatStream(fn, req) {
    let out;
    try { out = await fn(req || {}); } catch (e) { throw toProviderError(e); }
    if (out && typeof out[Symbol.asyncIterator] === 'function') {
      try { yield* out; } catch (e) { throw toProviderError(e); }
      return;
    }
    const text = out && typeof out.text === 'string' ? out.text : '';
    if (text) yield { type: 'delta', text };
    yield { type: 'done', text, ...(out && out.usage ? { usage: out.usage } : {}) };
  }

  const capabilities = {};
  const probes = {};
  for (const cap of manifest.capabilities) {
    const fn = adapter.capabilities[cap];
    capabilities[hostName(cap)] = cap === 'llm.chat' ? (req) => chatStream(fn, req) : wrapAsync(cap, fn);
    if (typeof adapter.probe === 'function') {
      probes[hostName(cap)] = async (opts) => {
        try { return await adapter.probe(cap, opts || {}); } catch (e) { throw toProviderError(e); }
      };
    }
  }
  return { id, label: instance.label || manifest.label || id, capabilities, probes };
}

module.exports = { toRegistryAdapter, hostName };
