'use strict';
/**
 * B06 目录（模型/价格/公告）：联网拉取并缓存，失败回退缓存，再回退内置 prices.json。
 * 接受云端目录的条件：version 等于内容哈希、ES256 签名校验通过（公钥来自云端 JWKS）、结构合法。
 * 价格表会驱动花费上限估算，所以任何一条不满足都不采用。
 */
const fs = require('fs');
const path = require('path');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const { verifyEs256, peekHeader, catalogVersion } = require('./jws');
const { createJwksProvider } = require('./jwks');
const { isEnabled } = require('../providers/enablement');

const CACHE_KEY = 'cloud.catalog_cache';
const BUNDLED_PRICES_PATH = path.join(__dirname, '..', '..', 'configs', 'prices.json');
const SERVICE_TYPES = ['text', 'image', 'video', 'tts'];

function loadBundledPrices(file = BUNDLED_PRICES_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 内置兜底目录：模型清单由价格表里的条目推出。 */
function bundledCatalog(prices) {
  const providers = [];
  const models = [];
  for (const [pid, kinds] of Object.entries(prices.providers || {})) {
    providers.push({ id: pid, name: pid });
    for (const [kind, table] of Object.entries(kinds || {})) {
      if (!SERVICE_TYPES.includes(kind)) continue;
      for (const id of Object.keys(table || {})) {
        if (id.startsWith('_')) continue;
        models.push({ provider: pid, service_type: kind, id, label: id });
      }
    }
  }
  return { providers, models, prices, announcements: [] };
}

function validCatalog(c) {
  return !!c && typeof c === 'object'
    && Array.isArray(c.providers) && Array.isArray(c.models) && Array.isArray(c.announcements)
    && c.prices && typeof c.prices === 'object' && typeof c.prices.version === 'string'
    && c.prices.providers && typeof c.prices.providers === 'object'
    && c.models.every((m) => m && typeof m.id === 'string' && typeof m.provider === 'string' && SERVICE_TYPES.includes(m.service_type));
}

/** Providers not enabled (providers.enabled) never show up in the model catalog; prices stay for history/estimates. */
function visibleOnly(list) {
  return (list || []).filter((x) => x && isEnabled(x.provider || x.id));
}

function activeAnnouncements(list, nowMs) {
  return (list || []).filter((a) => {
    const s = a.starts_at ? Date.parse(a.starts_at) : -Infinity;
    const e = a.ends_at ? Date.parse(a.ends_at) : Infinity;
    return nowMs >= s && nowMs < e;
  });
}

function createCatalogService({ db, http, log = {}, now = () => Date.now(), bundledPrices, ttlMs = 6 * 3600_000 } = {}) {
  const jwks = createJwksProvider({ db, http });
  const bundled = () => bundledPrices || loadBundledPrices();

  /** 读缓存并复核哈希（防本地库被改）；不合格视为无缓存。 */
  function readCache() {
    const c = getGlobalSetting(db, CACHE_KEY, null);
    if (!c || !validCatalog(c.catalog) || c.version !== catalogVersion(c.catalog)) return null;
    return c;
  }

  async function refresh() {
    const cached = readCache();
    let res;
    try {
      res = await http.request('GET', '/catalog', { query: { since: cached && cached.version } });
    } catch (e) {
      return { ok: false, reason: e.network ? 'network' : (e.code || 'error') };
    }
    if (res && res.unchanged && cached && res.version === cached.version) {
      setGlobalSetting(db, CACHE_KEY, { ...cached, fetched_at: now() });
      return { ok: true, changed: false, version: cached.version };
    }
    try {
      if (!res || !validCatalog(res.catalog)) throw new Error('bad shape');
      if (res.version !== catalogVersion(res.catalog)) throw new Error('version mismatch');
      const header = peekHeader(res.signature);
      if (!header || !header.kid) throw new Error('no kid');
      const jwk = await jwks.getKey(header.kid);
      const { payload } = verifyEs256(res.signature, jwk);
      if (payload.toString('utf8') !== res.version) throw new Error('signature does not cover version');
    } catch (e) {
      log.warn && log.warn('catalog rejected', { reason: e && e.message });
      return { ok: false, reason: 'invalid' };
    }
    setGlobalSetting(db, CACHE_KEY, { version: res.version, catalog: res.catalog, issued_at: res.issued_at || null, fetched_at: now() });
    return { ok: true, changed: true, version: res.version };
  }

  let inflight = null;
  function refreshOnce() {
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  /** 同步返回当前最佳目录；缓存过期时在后台刷新（不阻塞界面）。 */
  function getCatalog({ backgroundRefresh = true } = {}) {
    const c = readCache();
    if (backgroundRefresh && (!c || now() - (c.fetched_at || 0) > ttlMs)) refreshOnce().catch(() => {});
    if (c) {
      return {
        source: 'cloud', version: c.version, sample_prices: c.catalog.prices.sample !== false,
        fetched_at: new Date(c.fetched_at || 0).toISOString(),
        providers: visibleOnly(c.catalog.providers), models: visibleOnly(c.catalog.models), prices: c.catalog.prices,
        announcements: activeAnnouncements(c.catalog.announcements, now()),
      };
    }
    const prices = bundled();
    const b = bundledCatalog(prices);
    return { source: 'bundled', version: prices.version || null, sample_prices: prices.sample !== false, fetched_at: null, ...b, providers: visibleOnly(b.providers), models: visibleOnly(b.models) };
  }

  /** 供花费估算器使用：已验证的云端价格表，否则内置。 */
  function effectivePrices() {
    const c = readCache();
    return c ? c.catalog.prices : bundled();
  }

  return { refresh: refreshOnce, getCatalog, effectivePrices };
}

module.exports = { createCatalogService, loadBundledPrices, bundledCatalog, activeAnnouncements, validCatalog };
