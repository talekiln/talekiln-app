'use strict';
/**
 * P3-P plugin host. At startup it scans <plugins dir>/*\/manifest.json, validates every manifest with the SDK,
 * verifies the ES256 package signature against the official JWKS (the catalogue/licence keys cached offline by
 * cloud/jwks.js), records each folder in installed_plugins and registers the loadable ones as providers.
 *
 * Trust rules (docs/phase3-plugins.md):
 *   official  signature valid under a key of the official JWKS   -> loads when its switch is on
 *   unsigned  no signature                                        -> loads only while the developer_mode setting is on
 *   invalid   tampered / unknown kid / missing or unlisted file  -> loads only while developer_mode is on
 * A plugin whose name equals a built-in provider id is never recorded. Plugin code runs in-process without a
 * sandbox (SDK README "Trust model"): the signature proves origin and integrity, not harmlessness.
 */
const fs = require('fs');
const path = require('path');
const sdk = require('@talekiln/plugin-sdk');
const { toRegistryAdapter } = require('@talekiln/plugin-sdk/bridge');
const { ProviderError } = require('../providers/errors');
const enablement = require('../providers/enablement');
const settings = require('../services/settingsService');
const store = require('./store');
const current = require('./current');

const { DEVELOPER_MODE_KEY } = settings;
const HOST_CAP = { 'llm.chat': 'text.stream' };
const hostCap = (c) => HOST_CAP[c] || c;

class PluginHostError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'PluginHostError'; this.code = code; this.status = status; }
}

/** <data dir>/plugins: config.plugins.dir (relative to the working directory) or ./data/plugins. */
function resolvePluginsDir(config, cwd = process.cwd()) {
  const p = config && config.plugins && config.plugins.dir;
  if (!p) return path.join(cwd, 'data', 'plugins');
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

const isInside = (root, p) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Drop a folder's modules from the require cache so a re-installed version is not served stale. */
function purgeRequireCache(dir) {
  const root = path.resolve(dir) + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
}

/**
 * @param {object} o
 * @param {object} o.db better-sqlite3 handle (installed_plugins + global_settings)
 * @param {object} [o.config] loaded config.yaml (plugins.dir)
 * @param {object} [o.log]
 * @param {{cachedKey: Function, getKey: Function}} [o.jwks] cloud/jwks.js provider; absent = every signed plugin is 'invalid' (unknown kid)
 * @param {{request: Function}} [o.cloudHttp] cloud/http.js client for the public plugin catalogue (review dates); absent = never synced
 * @param {string} [o.pluginsDir] overrides config.plugins.dir
 * @param {Function} [o.fetchImpl] fetch handed to plugins (tests inject a mock)
 * @param {Function} [o.onChange] called after the set of active plugins may have changed
 */
function createPluginHost({ db, config, log = {}, jwks = null, cloudHttp = null, pluginsDir, fetchImpl, onChange, now = () => new Date() } = {}) {
  const root = path.resolve(pluginsDir || resolvePluginsDir(config));
  const loaded = new Map(); // id -> { manifest, createAdapter, dir }
  const loadErrors = new Map(); // id -> message
  const verifications = new Map(); // id -> SignatureResult (reason for the UI, 'unknown kid' drives refreshKeys)
  const warn = (m, d) => { if (log.warn) log.warn(m, d); };
  const info = (m, d) => { if (log.info) log.info(m, d); };
  const iso = () => now().toISOString();

  const developerMode = () => settings.getDeveloperMode(db);
  const allowed = (row) => row.enabled && (row.signature_status === 'official' || developerMode());
  const keyResolver = (kid) => (jwks && typeof jwks.cachedKey === 'function' ? jwks.cachedKey(kid) : null);

  function changed() { if (onChange) { try { onChange(); } catch (e) { warn('plugin host onChange', { error: e && e.message }); } } }

  /** Validate + verify one folder without running code. Throws PluginHostError for unreadable/invalid manifests. */
  function inspect(dir) {
    let read;
    try { read = sdk.readPluginManifest(dir); } catch (e) {
      throw new PluginHostError('PLUGIN_INVALID', `插件包不合法：${e.message}`, 400);
    }
    const { manifest, raw } = read;
    if (Object.prototype.hasOwnProperty.call(enablement.KNOWN_PROVIDERS, manifest.name)) {
      throw new PluginHostError('PLUGIN_NAME_CONFLICT', `插件名 ${manifest.name} 与内置服务商冲突`, 409);
    }
    const verification = sdk.verifySignature(raw, read.root, keyResolver);
    return { dir: read.root, manifest, raw, verification };
  }

  function record(ins, patch = {}) {
    const row = store.upsertRow(db, {
      id: ins.manifest.name, name: ins.manifest.name, version: ins.manifest.version, dir: ins.dir, manifest: ins.raw,
      signature_status: ins.verification.status, signature_kid: ins.verification.kid, signature_hash: ins.verification.hash,
      permissions: [...ins.manifest.permissions], ...patch,
    }, iso());
    verifications.set(row.id, ins.verification);
    return row;
  }

  function unload(id) {
    const cur = loaded.get(id);
    if (cur) purgeRequireCache(cur.dir);
    loaded.delete(id);
  }

  /** Load (or unload) one row according to its switch, signature status and developer mode. */
  function activate(id) {
    const row = store.getRow(db, id);
    loadErrors.delete(id);
    if (!row || !allowed(row)) { unload(id); return false; }
    const cur = loaded.get(id);
    if (cur && cur.dir === row.dir && cur.version === row.version) return true;
    unload(id);
    try {
      const plugin = sdk.loadPlugin(row.dir);
      if (plugin.manifest.name !== id) throw new Error(`manifest name ${plugin.manifest.name} does not match ${id}`);
      loaded.set(id, { manifest: plugin.manifest, createAdapter: plugin.createAdapter, dir: row.dir, version: row.version });
      info('plugin loaded', { id, version: row.version, signature: row.signature_status });
      return true;
    } catch (e) {
      loadErrors.set(id, String((e && e.message) || e).slice(0, 500));
      warn('plugin load failed', { id, error: loadErrors.get(id) });
      return false;
    }
  }

  function activateAll() {
    for (const row of store.listRows(db)) activate(row.id);
    changed();
  }

  /** Startup scan: record every folder, forget rows whose folder vanished, then load what is allowed. Synchronous (offline keys only). */
  function scan() {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch (_) { dirs = []; }
    const seen = new Set();
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
      try {
        const ins = inspect(dir);
        if (seen.has(ins.manifest.name)) { warn('plugin skipped: duplicate name', { dir, id: ins.manifest.name }); continue; }
        seen.add(ins.manifest.name);
        record(ins);
      } catch (e) {
        warn('plugin skipped', { dir, error: e.message });
      }
    }
    for (const row of store.listRows(db)) {
      if (seen.has(row.id)) continue;
      if (isInside(root, row.dir) || !fs.existsSync(path.join(row.dir, 'manifest.json'))) {
        // folder removed by hand (or never copied): the row is stale
        unload(row.id);
        store.deleteRow(db, row.id);
        verifications.delete(row.id);
        continue;
      }
      try { record(inspect(row.dir)); } catch (e) { warn('plugin re-check failed', { id: row.id, error: e.message }); store.deleteRow(db, row.id); }
    }
    activateAll();
    return list();
  }

  /** Fetch the JWKS for signed plugins whose kid is not cached yet, re-verify them and load the ones that turn official. */
  async function refreshKeys() {
    if (!jwks || typeof jwks.getKey !== 'function') return { checked: 0, updated: 0 };
    let checked = 0;
    let updated = 0;
    for (const row of store.listRows(db)) {
      const v = verifications.get(row.id);
      if (!v || v.status !== 'invalid' || v.reason !== 'unknown kid' || !v.kid) continue;
      checked++;
      try { await jwks.getKey(v.kid); } catch (e) { warn('plugin key fetch failed', { id: row.id, kid: v.kid, error: e && e.message }); continue; }
      try {
        const ins = inspect(row.dir);
        const next = record(ins);
        if (next.signature_status !== row.signature_status) updated++;
      } catch (e) { warn('plugin re-check failed', { id: row.id, error: e.message }); }
    }
    if (updated) activateAll();
    return { checked, updated };
  }

  /**
   * Pull the cloud's public plugin catalogue (approved versions) and stamp the review date on installed plugins
   * whose fingerprint matches. Purely informational: it never changes a signature status or a switch.
   */
  async function refreshCatalog() {
    if (!cloudHttp || typeof cloudHttp.request !== 'function') return { matched: 0 };
    const cat = await cloudHttp.request('GET', '/plugins/catalog');
    const byHash = new Map();
    for (const p of (cat && Array.isArray(cat.plugins)) ? cat.plugins : []) {
      for (const v of Array.isArray(p.versions) ? p.versions : []) {
        if (typeof v.hash === 'string' && typeof v.reviewedAt === 'string') byHash.set(v.hash, v.reviewedAt);
      }
    }
    let matched = 0;
    for (const row of store.listRows(db)) {
      const reviewedAt = row.signature_hash ? byHash.get(row.signature_hash) : undefined;
      if (!reviewedAt) continue;
      matched++;
      if (row.reviewed_at !== reviewedAt) store.setReviewedAt(db, row.id, reviewedAt, iso());
    }
    return { matched };
  }

  /**
   * Copy a folder into the plugins dir and register it. Unsigned/invalid packages are refused unless developer
   * mode is on (the folder is never copied in that case).
   */
  function install(srcDir) {
    if (typeof srcDir !== 'string' || !srcDir.trim()) throw new PluginHostError('BAD_REQUEST', 'dir 必填', 400);
    const src = path.resolve(srcDir);
    let st;
    try { st = fs.statSync(src); } catch (_) { st = null; }
    if (!st || !st.isDirectory()) throw new PluginHostError('PLUGIN_INVALID', '找不到插件文件夹', 400);
    const ins = inspect(src);
    const id = ins.manifest.name;
    if (!ins.verification.ok && !developerMode()) {
      throw new PluginHostError('PLUGIN_SIGNATURE', `插件 ${id} ${ins.verification.status === 'unsigned' ? '未签名' : `签名无效（${ins.verification.reason}）`}，未开启开发者模式时不能安装`, 403);
    }
    const dest = path.join(root, id);
    if (path.resolve(ins.dir) !== dest) {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(ins.dir, tmp, { recursive: true, dereference: false, errorOnExist: false });
      unload(id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
    } else {
      unload(id);
    }
    const final = inspect(dest);
    const row = record(final, { enabled: true });
    activate(row.id);
    changed();
    return view(row);
  }

  function remove(id) {
    const row = store.getRow(db, id);
    if (!row) throw new PluginHostError('NOT_FOUND', '插件不存在', 404);
    unload(id);
    store.deleteRow(db, id);
    verifications.delete(id);
    loadErrors.delete(id);
    if (isInside(root, row.dir)) fs.rmSync(row.dir, { recursive: true, force: true });
    changed();
    return { id, removed: true };
  }

  function setEnabled(id, enabled) {
    if (!store.getRow(db, id)) throw new PluginHostError('NOT_FOUND', '插件不存在', 404);
    store.setEnabled(db, id, !!enabled, iso());
    activate(id);
    changed();
    return get(id);
  }

  function setDeveloperMode(on) {
    settings.setDeveloperMode(db, on === true);
    activateAll();
    return developerMode();
  }

  function view(row) {
    const m = row.manifest || {};
    const v = verifications.get(row.id);
    const permissions = Array.isArray(row.permissions) ? row.permissions : [];
    return {
      id: row.id, name: row.name, label: m.label || row.name, version: row.version, description: m.description || '', homepage: m.homepage || null,
      sdk_version: m.sdkVersion || null, dir: row.dir, source: 'plugin',
      capabilities: (m.capabilities || []).map(hostCap),
      permissions,
      hosts: permissions.filter((p) => p.startsWith('network:')).map((p) => p.slice(8)),
      needs_api_key: permissions.includes('secret:apiKey'),
      signature: { status: row.signature_status, kid: row.signature_kid, hash: row.signature_hash, reason: v ? v.reason : null },
      enabled: row.enabled, active: loaded.has(row.id),
      blocked_reason: row.enabled && !loaded.has(row.id)
        ? (loadErrors.get(row.id) ? `加载失败：${loadErrors.get(row.id)}` : (row.signature_status === 'official' ? null : '未签名或签名无效，需开启开发者模式'))
        : null,
      load_error: loadErrors.get(row.id) || null,
      installed_at: row.installed_at, updated_at: row.updated_at, reviewed_at: row.reviewed_at,
    };
  }

  function get(id) {
    const row = store.getRow(db, id);
    if (!row) throw new PluginHostError('NOT_FOUND', '插件不存在', 404);
    return view(row);
  }

  const list = () => store.listRows(db).map(view);
  const installedIds = () => store.listRows(db).map((r) => r.id);
  const activeIds = () => [...loaded.keys()];
  const isActive = (id) => loaded.has(id);

  /** Registry adapter for an active plugin; cfg = { apiKey?, baseUrl?, fetch? } from the user's saved AI config. */
  function createAdapter(id, cfg = {}) {
    const p = loaded.get(id);
    if (!p) throw new ProviderError('PROVIDER_NOT_AVAILABLE', String(id), { provider: id });
    const inst = sdk.instantiate({ manifest: p.manifest, createAdapter: p.createAdapter }, {
      apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, fetch: cfg.fetch || fetchImpl, log: { info() {}, warn() {}, error() {} },
    });
    return toRegistryAdapter(inst, { ProviderError, secrets: [cfg.apiKey].filter(Boolean) });
  }

  const host = {
    pluginsDir: root, PluginHostError,
    scan, refreshKeys, refreshCatalog, start: () => { scan(); return refreshKeys(); },
    install, remove, setEnabled, list, get, developerMode, setDeveloperMode,
    installedIds, activeIds, isActive, createAdapter,
    /** Detach from the process-wide hooks (tests). */
    dispose() {
      for (const id of activeIds()) unload(id);
      if (current.current() === host) current.set(null);
      enablement.registerPluginProviders(null);
    },
  };
  enablement.registerPluginProviders(activeIds);
  current.set(host);
  return host;
}

module.exports = { createPluginHost, resolvePluginsDir, PluginHostError, DEVELOPER_MODE_KEY, purgeRequireCache };
