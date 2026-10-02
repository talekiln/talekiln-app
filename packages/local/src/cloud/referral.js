'use strict';
/**
 * C07 本地辅助：给「添加 Key」向导生成打开平台密钥页的地址。
 * 云端已配置：走云端 /r/:code（记录点击后由云端 302 到白名单内的推广链接）。
 * 云端未配置：直接用内置的官方密钥页，不带任何推广参数。
 * 目标地址从不来自调用方输入。
 */
const { isConfiguredBaseUrl, parseBaseUrl } = require('./http');

const { KNOWN_PROVIDERS, isEnabled } = require('../providers/enablement');

// Official key pages per known provider; only enabled providers resolve (see providers/enablement.js).
const DIRECT_KEY_PAGES = Object.fromEntries(Object.values(KNOWN_PROVIDERS).map((m) => [m.id, m.keyPageUrl]));
const CODE_RE = /^[a-z0-9_-]{1,40}$/;

function resolveKeyPage({ baseUrl, provider, src = 'addkey' }) {
  const code = String(provider || '').toLowerCase();
  if (!CODE_RE.test(code) || !isEnabled(code)) return null;
  if (isConfiguredBaseUrl(baseUrl)) {
    const root = parseBaseUrl(baseUrl);
    if (root.protocol === 'https:') {
      const u = new URL(`r/${code}`, root.href.endsWith('/') ? root.href : root.href + '/');
      u.searchParams.set('src', String(src).replace(/[^a-z0-9_.-]/gi, '').slice(0, 40) || 'addkey');
      return { url: u.toString(), via: 'referral' };
    }
  }
  const direct = Object.prototype.hasOwnProperty.call(DIRECT_KEY_PAGES, code) ? DIRECT_KEY_PAGES[code] : null;
  return direct ? { url: direct, via: 'direct' } : null;
}

module.exports = { resolveKeyPage, DIRECT_KEY_PAGES };
