'use strict';
/** Thin, route-free entry point. Business code: `const p = createProviders({...}); p.image.generate('bailian', req)`. */
const { createRegistry } = require('./registry');
const { createBailianAdapter } = require('./bailian');
const { CAPABILITIES, PHASE1_PROVIDERS } = require('./capabilities');
const { ProviderError, ERROR_CODES } = require('./errors');

/**
 * Keys are supplied by the caller (user settings); never read from or written to the repo.
 * @param {{bailian?: {apiKey:string, baseUrl?:string, fetch?:Function, WebSocket?:Function}}} cfg
 */
function createProviders(cfg = {}) {
  const registry = createRegistry();
  if (cfg.bailian) registry.register(createBailianAdapter(cfg.bailian));
  // ark: adapter lands in a later task; id is reserved in PHASE1_PROVIDERS.
  const facade = { registry };
  for (const cap of CAPABILITIES) {
    const [ns, fn] = cap.split('.');
    facade[ns] = facade[ns] || {};
    // Promise capabilities never throw synchronously; text.stream is an async iterable (resolution errors throw eagerly).
    facade[ns][fn] = cap === 'text.stream'
      ? (providerId, req) => registry.call(providerId, cap, req)
      : (providerId, req) => Promise.resolve().then(() => registry.call(providerId, cap, req));
  }
  return facade;
}

module.exports = { createProviders, createRegistry, CAPABILITIES, PHASE1_PROVIDERS, ProviderError, ERROR_CODES };
