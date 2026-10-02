'use strict';
/** Thin, route-free entry point. Business code: `const p = createProviders({...}); p.image.generate('bailian', req)`. */
const { createRegistry } = require('./registry');
const { createBailianAdapter } = require('./bailian');
const { createArkAdapter } = require('./ark');
const { CAPABILITIES } = require('./capabilities');
const enablement = require('./enablement');
const { ProviderError, ERROR_CODES } = require('./errors');
const pluginCurrent = require('../plugins/current');

/**
 * Keys are supplied by the caller (user settings); never read from or written to the repo.
 * @param {{bailian?: object, ark?: {apiKey:string, baseUrl?:string, fetch?:Function, speech?:{appId:string, accessToken:string, cluster?:string}}}} cfg
 *   Any other key is an installed plugin id (P3-P): `{ acme: { apiKey, baseUrl?, fetch? } }` builds that plugin's adapter
 *   through the SDK bridge when the plugin is loaded and switched on.
 * @param {{pluginHost?: object}} [opts] plugin host override (default: the process-wide one set by app.js)
 */
function createProviders(cfg = {}, { pluginHost = pluginCurrent.current() } = {}) {
  const registry = createRegistry();
  // Adapters are only built for enabled providers; hidden ones stay in the repo untouched.
  if (cfg.bailian && enablement.isEnabled('bailian')) registry.register(createBailianAdapter(cfg.bailian));
  if (cfg.ark && enablement.isEnabled('ark')) registry.register(createArkAdapter(cfg.ark));
  if (pluginHost) {
    for (const id of Object.keys(cfg)) {
      if (enablement.isBuiltin(id) || !cfg[id] || !pluginHost.isActive(id)) continue;
      registry.register(pluginHost.createAdapter(id, cfg[id]));
    }
  }
  const facade = { registry };
  for (const cap of CAPABILITIES) {
    const [ns, fn] = cap.split('.');
    facade[ns] = facade[ns] || {};
    // Promise capabilities never throw synchronously; text.stream is an async iterable (resolution errors throw eagerly).
    facade[ns][fn] = cap === 'text.stream'
      ? (providerId, req) => registry.call(providerId, cap, req)
      : (providerId, req) => Promise.resolve().then(() => registry.call(providerId, cap, req));
  }
  /** probe('bailian', 'image.generate', {model}) -> {ok, costly}; see registry.probe. */
  facade.probe = (providerId, capability, opts) => Promise.resolve().then(() => registry.probe(providerId, capability, opts));
  return facade;
}

module.exports = { createProviders, createRegistry, CAPABILITIES, enablement, ProviderError, ERROR_CODES };
