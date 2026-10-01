'use strict';
/**
 * 账号会话与许可证（B05）。
 * - refresh token 与许可证 JWT 只存系统密钥存储（secrets），访问令牌只在内存。
 * - 许可证每次读取都用缓存的云端公钥验签；离线时按 exp + graceDays 判断可用性。
 * - refresh 并发合并成一次（刷新令牌轮换，重复使用会被云端判定为重放并吊销整个家族）。
 */
const crypto = require('crypto');
const os = require('os');
const { getGlobalSetting, setGlobalSetting } = require('../services/settingsService');
const secrets = require('../secrets');
const { verifyEs256, peekHeader } = require('./jws');
const { createJwksProvider } = require('./jwks');

const REF_RT = 'cloud:refresh_token';
const REF_LIC = 'cloud:licence';
const SESSION_KEY = 'cloud.session';
const DEVICE_KEY = 'cloud.device';
const ISSUER = 'talekiln-cloud';
const DAY = 86400_000;

class AccountError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AccountError';
    this.code = code;
  }
}

function createAccountService({ db, http, log = {}, now = () => Date.now(), getStore = () => secrets.getSecretStore() } = {}) {
  const jwks = createJwksProvider({ db, http });
  let access = null; // { token, expiresAt }
  let refreshing = null;
  let endedReason = null; // 'expired' | 'logout' | null：会话是怎么结束的

  const loadSession = () => getGlobalSetting(db, SESSION_KEY, null);
  const saveSession = (s) => setGlobalSetting(db, SESSION_KEY, s);

  function deviceInfo() {
    let d = getGlobalSetting(db, DEVICE_KEY, null);
    if (!d || !d.fingerprint) {
      d = { fingerprint: `fp-${crypto.randomUUID()}` };
      setGlobalSetting(db, DEVICE_KEY, d);
    }
    let host = 'PC';
    try { host = os.hostname() || 'PC'; } catch (_) { /* ignore */ }
    return { fingerprint: d.fingerprint, name: `${host} (${os.platform()})`.slice(0, 100) };
  }

  function clearSession(reason) {
    const store = getStore();
    try { store.delete(REF_RT); store.delete(REF_LIC); } catch (_) { /* ignore */ }
    setGlobalSetting(db, SESSION_KEY, null);
    access = null;
    endedReason = reason || null;
  }

  function setAccess(pair) {
    access = { token: pair.accessToken, expiresAt: now() + Math.max(0, Number(pair.expiresIn) || 0) * 1000 };
  }

  async function doRefresh() {
    const store = getStore();
    const rt = store.get(REF_RT);
    if (!rt) throw new AccountError('NOT_LOGGED_IN');
    try {
      const r = await http.request('POST', '/auth/refresh', { body: { refreshToken: rt } });
      store.set(REF_RT, r.refreshToken); // 先落盘新令牌再用，避免崩溃后旧令牌失效
      setAccess(r);
      return access.token;
    } catch (e) {
      if (e && e.code === 'cloud_not_configured') throw e;
      if (e && (e.network || e.status >= 500)) throw e; // 离线/云端故障：保留会话，走宽限
      if (e && e.name === 'CloudError') {
        clearSession('expired');
        throw new AccountError('SESSION_EXPIRED');
      }
      throw e;
    }
  }

  function ensureAccess(force = false) {
    if (!force && access && access.expiresAt - now() > 30_000) return Promise.resolve(access.token);
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** 带访问令牌调用云端；访问令牌过期（401 invalid_token）时刷新后重试一次。 */
  async function authed(fn) {
    let token = await ensureAccess();
    try {
      return await fn(token);
    } catch (e) {
      if (e && e.name === 'CloudError' && e.status === 401 && e.code === 'invalid_token') {
        access = null;
        token = await ensureAccess(true);
        return fn(token);
      }
      throw e;
    }
  }

  async function verifyLicence(token, session, { online = false } = {}) {
    const header = peekHeader(token);
    if (!header || !header.kid) return null;
    let jwk = jwks.cachedKey(header.kid);
    if (!jwk && online) jwk = await jwks.getKey(header.kid);
    if (!jwk) return null;
    try {
      const { payload } = verifyEs256(token, jwk);
      const c = JSON.parse(payload.toString('utf8'));
      if (c.iss !== ISSUER) return null;
      if (session && ((c.sub && c.sub !== session.account.id) || (c.did && session.device_id && c.did !== session.device_id))) return null;
      if (!Number.isFinite(c.exp)) return null;
      return c;
    } catch (_) {
      return null;
    }
  }

  async function syncLicence() {
    const session = loadSession();
    if (!session) throw new AccountError('NOT_LOGGED_IN');
    const r = await authed((t) => http.request('POST', '/licence/renew', { token: t }));
    const claims = await verifyLicence(r.licence, session, { online: true });
    if (!claims) throw new AccountError('LICENCE_INVALID', '云端返回的许可证无法验证');
    getStore().set(REF_LIC, r.licence);
    saveSession({ ...loadSession(), last_sync_at: now(), last_sync_error: null });
    return claims;
  }

  /** 离线可用性：exp 前 valid，exp 之后 graceDays 天内 grace，其后 expired。时钟回拨不会延长。 */
  function licenceView(claims, session) {
    if (!claims) return { state: 'none', verified: false, entitlements: [] };
    const seen = Math.max(now(), (session && session.max_seen_ms) || 0);
    const exp = claims.exp * 1000;
    const graceMs = (Number.isFinite(claims.graceDays) ? claims.graceDays : 0) * DAY;
    const state = seen < exp ? 'valid' : seen < exp + graceMs ? 'grace' : 'expired';
    return {
      state,
      verified: true,
      plan: claims.plan || null,
      entitlements: Array.isArray(claims.entitlements) ? claims.entitlements : [],
      expires_at: new Date(exp).toISOString(),
      grace_until: new Date(exp + graceMs).toISOString(),
      days_left: Math.max(0, Math.ceil(((state === 'valid' ? exp : exp + graceMs) - seen) / DAY)),
    };
  }

  function needsSync(claims) {
    if (!claims) return true;
    const ttl = (claims.exp - (claims.iat || claims.exp)) * 1000;
    return claims.exp * 1000 - now() < Math.max(ttl / 2, 0);
  }

  async function status({ sync = false, force = false } = {}) {
    let session = loadSession();
    const store = getStore();
    const loggedIn = !!(session && store.has(REF_RT));
    let offline = false;
    let claims = null;
    if (loggedIn) {
      const lic = store.get(REF_LIC);
      claims = lic ? await verifyLicence(lic, session) : null;
      if ((sync && needsSync(claims)) || force) {
        try {
          claims = await syncLicence();
        } catch (e) {
          if (e && e.name === 'AccountError' && e.code === 'SESSION_EXPIRED') {
            /* 会话已被清掉，下面按未登录返回 */
          } else if (e && (e.network || e.status >= 500 || e.code === 'cloud_not_configured')) {
            offline = true;
            if (loadSession()) saveSession({ ...loadSession(), last_sync_error: e.network ? 'network' : (e.code || 'error') });
          } else {
            log.warn && log.warn('licence sync failed', { code: e && e.code });
            offline = true;
          }
        }
        session = loadSession();
      }
    }
    if (!session || !store.has(REF_RT)) {
      return {
        logged_in: false, session: endedReason === 'expired' ? 'expired' : 'none', account: null, entitled: false, offline,
        licence: { state: 'none', verified: false, entitlements: [] }, last_sync_at: null,
      };
    }
    if (now() > (session.max_seen_ms || 0) + 60_000) {
      session = { ...session, max_seen_ms: now() };
      saveSession(session);
    }
    const licence = licenceView(claims || (store.get(REF_LIC) ? await verifyLicence(store.get(REF_LIC), session) : null), session);
    return {
      logged_in: true,
      session: 'active',
      account: { email: session.account.email, plan: session.account.plan, role: session.account.role },
      entitled: licence.state === 'valid' || licence.state === 'grace',
      offline: offline || !!session.last_sync_error,
      licence,
      last_sync_at: session.last_sync_at ? new Date(session.last_sync_at).toISOString() : null,
    };
  }

  async function startSession(path, body) {
    const store = getStore();
    const r = await http.request('POST', path, { body: { ...body, device: deviceInfo() } });
    clearSession(null); // 换号登录时清掉上一个账号的许可证
    try {
      store.set(REF_RT, r.refreshToken);
    } catch (e) {
      // 无法安全落盘就不登录；通知云端作废刚签发的令牌
      await http.request('POST', '/auth/logout', { body: { refreshToken: r.refreshToken } }).catch(() => {});
      throw e;
    }
    setAccess(r);
    endedReason = null;
    saveSession({ account: r.account, device_id: r.device ? r.device.id : null, last_sync_at: null, last_sync_error: null, max_seen_ms: now() });
    try {
      await syncLicence();
    } catch (e) {
      log.warn && log.warn('licence sync after login failed', { code: e && e.code });
      const s = loadSession();
      if (s) saveSession({ ...s, last_sync_error: (e && e.network) ? 'network' : ((e && e.code) || 'error') });
    }
    return status();
  }

  const register = ({ inviteCode, email, password }) => startSession('/auth/activate', { inviteCode, email, password });
  const login = ({ email, password }) => startSession('/auth/login', { email, password });

  async function logout() {
    const rt = getStore().get(REF_RT);
    if (rt) {
      try { await http.request('POST', '/auth/logout', { body: { refreshToken: rt } }); } catch (_) { /* 离线也要能退出 */ }
    }
    clearSession('logout');
    return status();
  }

  return { register, login, logout, status, authed, ensureAccess };
}

module.exports = { createAccountService, AccountError, REF_RT, REF_LIC };
