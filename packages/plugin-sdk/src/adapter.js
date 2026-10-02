'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CAPABILITIES } = require('./constants');
const { ERROR_CODES, PluginError } = require('./errors');
const { validateManifest, allowedHosts, hostAllowed } = require('./manifest');

/**
 * Adapter shape returned by a plugin's `createAdapter(ctx)`:
 *   { capabilities: { 'llm.chat'?: fn, 'image.generate'?: fn, ... },
 *     probe?: (capability, opts) => Promise<{ok, costly}>,
 *     mapError: (status, body, extra?) => PluginError,
 *     label?: string }
 * The adapter id is always manifest.name.
 */
function validateAdapter(adapter, manifest) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['adapter must be an object'] };
  const caps = adapter.capabilities;
  if (!caps || typeof caps !== 'object') errors.push('adapter.capabilities must be an object');
  else {
    for (const k of Object.keys(caps)) {
      if (!CAPABILITIES.includes(k)) errors.push(`unknown capability implemented: ${k}`);
      else if (typeof caps[k] !== 'function') errors.push(`capability ${k} must be a function`);
      else if (!manifest.capabilities.includes(k)) errors.push(`capability ${k} implemented but not declared in manifest`);
    }
    for (const k of manifest.capabilities) {
      if (typeof caps[k] !== 'function') errors.push(`capability ${k} declared in manifest but not implemented`);
    }
  }
  if (typeof adapter.mapError !== 'function') errors.push('adapter.mapError must be a function');
  if (adapter.probe !== undefined && typeof adapter.probe !== 'function') errors.push('adapter.probe must be a function when present');
  return { ok: errors.length === 0, errors };
}

/**
 * fetch wrapper enforcing the manifest's network permissions: https only, host must match a `network:` entry.
 * NOTE: this guards the fetch the host hands to the plugin. Plugins run in-process, so it is a declared-permission
 * check, not a sandbox (see packages/plugin-sdk/README.md "Trust model").
 */
function createGuardedFetch(fetchImpl, manifest, onRequest) {
  const hosts = allowedHosts(manifest);
  return async function guardedFetch(url, init) {
    let u;
    try { u = new URL(String(url)); } catch { throw new PluginError(ERROR_CODES.INVALID_PARAMS, 'invalid url'); }
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname, hosts)) {
      throw new PluginError(ERROR_CODES.NETWORK, `network permission denied for host ${u.hostname}`);
    }
    if (onRequest) onRequest(u);
    return fetchImpl(String(url), { ...(init || {}), redirect: 'error' });
  };
}

/**
 * Read and validate manifest.json only. Runs no plugin code, so a host can verify the signature
 * (see signing.js) before loadPlugin() requires the entry file.
 */
function readPluginManifest(dir) {
  const root = fs.realpathSync(dir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch (e) {
    throw new Error(`cannot read manifest.json in ${dir}: ${e.message}`);
  }
  const v = validateManifest(raw);
  if (!v.ok) throw new Error(`invalid manifest: ${v.errors.join('; ')}`);
  return { root, manifest: v.manifest, raw };
}

/** Read and validate a plugin folder (manifest.json + entry). Requires the entry file; does not call createAdapter(). */
function loadPlugin(dir) {
  const { root, manifest } = readPluginManifest(dir);
  const v = { manifest };
  const entryPath = fs.realpathSync(path.join(root, v.manifest.entry));
  if (entryPath !== root && !entryPath.startsWith(root + path.sep)) throw new Error('entry escapes the plugin folder');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(entryPath);
  if (!mod || typeof mod.createAdapter !== 'function') throw new Error('entry must export createAdapter(ctx)');
  return { manifest: v.manifest, createAdapter: mod.createAdapter };
}

/**
 * Build the adapter for a loaded plugin (or {manifest, createAdapter} made in code).
 * @param {{manifest: object, createAdapter: Function}} plugin
 * @param {{apiKey?: string, baseUrl?: string, fetch?: Function, log?: object}} cfg
 */
function instantiate(plugin, cfg = {}) {
  const v = validateManifest(plugin.manifest);
  if (!v.ok) throw new Error(`invalid manifest: ${v.errors.join('; ')}`);
  const manifest = v.manifest;
  const hostFetch = cfg.fetch || ((...a) => globalThis.fetch(...a));
  const ctx = Object.freeze({
    apiKey: manifest.permissions.includes('secret:apiKey') ? cfg.apiKey : undefined,
    baseUrl: cfg.baseUrl,
    fetch: createGuardedFetch(hostFetch, manifest, cfg.onRequest),
    log: cfg.log || { info() {}, warn() {}, error() {} },
  });
  const adapter = plugin.createAdapter(ctx);
  const a = validateAdapter(adapter, manifest);
  if (!a.ok) throw new Error(`invalid adapter: ${a.errors.join('; ')}`);
  return { manifest, adapter, id: manifest.name, label: manifest.label || adapter.label || manifest.name };
}

module.exports = { validateAdapter, createGuardedFetch, readPluginManifest, loadPlugin, instantiate };
