'use strict';
const { CAPABILITIES } = require('./capabilities');
const enablement = require('./enablement');
const { ProviderError, ERROR_CODES } = require('./errors');

/**
 * Adapter shape: { id, label, capabilities: { 'text.stream': fn, ... }, probes?: { 'text.stream': fn, ... } }.
 * Adapters of providers that are not enabled (providers/enablement.js) may be registered but are never listed
 * or resolvable. `enabledIds` pins a fixed set; by default the live process-wide setting is read on every call
 * (built-in providers.enabled plus active plugins, see enablement.availableProviders).
 */
function createRegistry(enabledIds) {
  const adapters = new Map();
  const phase1 = { includes: (id) => (enabledIds ? enabledIds.includes(id) : enablement.isProviderAvailable(id)) };
  return {
    register(adapter) {
      if (!adapter || !adapter.id || !adapter.capabilities || typeof adapter.capabilities !== 'object') {
        throw new TypeError('invalid provider adapter');
      }
      for (const k of Object.keys(adapter.capabilities)) {
        if (!CAPABILITIES.includes(k)) throw new TypeError(`unknown capability: ${k}`);
      }
      adapters.set(adapter.id, adapter);
      return this;
    },
    list() {
      return [...adapters.values()]
        .filter((a) => phase1.includes(a.id))
        .map((a) => ({ id: a.id, label: a.label || a.id, capabilities: Object.keys(a.capabilities) }));
    },
    get(id) {
      const a = adapters.get(id);
      if (!a || !phase1.includes(id)) {
        throw new ProviderError(ERROR_CODES.PROVIDER_NOT_AVAILABLE, String(id));
      }
      return a;
    },
    /**
     * Connectivity test for one capability (C05): resolves { ok, costly } or rejects with a
     * ProviderError whose code tells key / model / balance problems apart.
     */
    probe(providerId, capability, opts) {
      const a = this.get(providerId);
      const fn = a.probes && a.probes[capability];
      if (typeof fn !== 'function') {
        return Promise.reject(new ProviderError(ERROR_CODES.CAPABILITY_NOT_SUPPORTED, `${providerId}:${capability} 无连通测试`));
      }
      return Promise.resolve().then(() => fn(opts || {}));
    },
    /** Call by capability: registry.call('bailian', 'image.generate', req) */
    call(providerId, capability, req) {
      const a = this.get(providerId);
      const fn = a.capabilities[capability];
      if (typeof fn !== 'function') {
        throw new ProviderError(ERROR_CODES.CAPABILITY_NOT_SUPPORTED, `${providerId}:${capability}`);
      }
      return fn(req || {});
    },
  };
}

module.exports = { createRegistry };
