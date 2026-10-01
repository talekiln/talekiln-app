'use strict';
/**
 * 云端 HTTP 客户端（最薄一层）：base URL 来自配置，fetch 可注入（测试用）。
 * 错误统一成 CloudError：network=true 表示没连上（离线宽限的判断依据），否则带 status 与云端 error 码。
 */

const DEFAULT_BASE_URL = 'https://cloud.talekiln.example'; // 占位，上线前在 config.yaml cloud.base_url 配置

class CloudError extends Error {
  constructor(code, { status = 0, network = false, message } = {}) {
    super(message || code);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.network = network;
  }
}

function parseBaseUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u;
  } catch (_) { /* fallthrough */ }
  return null;
}

/** 占位域名（.example/.invalid/.test）视为未配置。 */
function isConfiguredBaseUrl(raw) {
  const u = parseBaseUrl(raw);
  if (!u) return false;
  return !/\.(example|invalid|test)$/i.test(u.hostname);
}

function resolveBaseUrl(cfg, env = process.env) {
  return String((env.TALEKILN_CLOUD_URL || (cfg && cfg.cloud && cfg.cloud.base_url) || DEFAULT_BASE_URL)).trim();
}

function createCloudHttp({ getBaseUrl, fetchImpl, timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));

  async function request(method, pathname, { body, token, query } = {}) {
    const base = getBaseUrl();
    if (!isConfiguredBaseUrl(base)) throw new CloudError('cloud_not_configured');
    const root = parseBaseUrl(base);
    const url = new URL(String(pathname).replace(/^\//, ''), root.href.endsWith('/') ? root.href : root.href + '/');
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // 云端 API 不应重定向；防止带着令牌被带到别处
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new CloudError('network', { network: true, message: e && e.name === 'TimeoutError' ? 'timeout' : 'network error' });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
    if (!res.ok) {
      const code = (json && typeof json.error === 'string' && json.error) || (res.status >= 500 ? 'server_error' : 'http_error');
      throw new CloudError(code, { status: res.status });
    }
    return json;
  }

  return { request, getBaseUrl };
}

module.exports = { CloudError, createCloudHttp, isConfiguredBaseUrl, resolveBaseUrl, parseBaseUrl, DEFAULT_BASE_URL };
