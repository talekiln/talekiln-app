'use strict';
/** 测试用云端模拟：真实 HTTP 服务（走完整 fetch 路径），行为对齐 packages/cloud 的接口。 */
const http = require('http');
const crypto = require('crypto');
const { canonicalJson } = require('../../src/cloud/jws');

const b64u = (b) => Buffer.from(b).toString('base64url');

function es256Sign(headerObj, payloadBuf, privateKey) {
  const h = b64u(JSON.stringify(headerObj));
  const p = b64u(payloadBuf);
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(sig)}`;
}

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' } };
}

async function startMockCloud({ now }) {
  const keys = newKeyPair();
  const st = {
    down: false, accessTtlSec: 60, licenceTtlSec: 7 * 86400, graceDays: 14,
    invite: 'GOOD-INVITE', account: null, calls: [], keys,
    access: new Map(), refresh: new Map(), revokedFamilies: new Set(), n: 0,
    catalog: null, // { data, version?, signature? } 由测试设置
    // P2-C：loginProviders=false 模拟云端未接入适配器（503）；smsCode 为当前有效验证码；qr 为票据状态
    loginProviders: true, smsCode: null, smsSends: 0, qr: new Map(),
  };

  function pair(accountId, family) {
    const accessToken = `at-${++st.n}`;
    const refreshToken = `rt-${++st.n}`;
    st.access.set(accessToken, { accountId, exp: now() + st.accessTtlSec * 1000 });
    st.refresh.set(refreshToken, { accountId, family, used: false });
    return { accessToken, refreshToken, expiresIn: st.accessTtlSec };
  }
  function authResult(family) {
    return { ...pair(st.account.id, family), account: { id: st.account.id, email: st.account.email, role: 'USER', plan: 'test' }, device: { id: 'dev-1', name: 'PC' } };
  }
  function signLicence() {
    const iat = Math.floor(now() / 1000);
    const payload = { iss: 'talekiln-cloud', sub: st.account.id, did: 'dev-1', plan: 'test', entitlements: ['generate', 'export'], graceDays: st.graceDays, iat, exp: iat + st.licenceTtlSec };
    return es256Sign({ alg: 'ES256', kid: 'k1', typ: 'JWT' }, JSON.stringify(payload), keys.privateKey);
  }
  function signCatalog(data) {
    const version = 'c-' + crypto.createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 16);
    return { version, kid: 'k1', signature: es256Sign({ alg: 'ES256', kid: 'k1' }, version, keys.privateKey), issued_at: new Date(now()).toISOString(), catalog: data };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (st.down) return req.socket.destroy();
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      st.calls.push(`${req.method} ${url.pathname}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'POST /auth/activate') {
        if (body.inviteCode !== st.invite) return send(400, { error: 'invalid_invite' });
        if (st.account) return send(409, { error: 'email_taken' });
        if (!body.password || body.password.length < 8) return send(400, { error: 'bad_request' });
        st.account = { id: 'acc-1', email: String(body.email).toLowerCase(), password: body.password };
        return send(201, authResult(`fam-${++st.n}`));
      }
      if (route === 'POST /auth/login') {
        if (!st.account || st.account.email !== String(body.email).toLowerCase() || st.account.password !== body.password) return send(401, { error: 'invalid_credentials' });
        return send(200, authResult(`fam-${++st.n}`));
      }
      if (route === 'POST /auth/refresh') {
        const rec = st.refresh.get(body.refreshToken);
        if (!rec) return send(401, { error: 'invalid_token' });
        if (rec.used || st.revokedFamilies.has(rec.family)) { st.revokedFamilies.add(rec.family); return send(401, { error: 'token_reuse' }); }
        rec.used = true;
        return send(200, pair(rec.accountId, rec.family));
      }
      if (route === 'POST /auth/logout') {
        const rec = st.refresh.get(body.refreshToken);
        if (rec) st.revokedFamilies.add(rec.family);
        return send(204);
      }
      if (route === 'POST /licence/renew') {
        const a = bearer && st.access.get(bearer[1]);
        if (!a || a.exp <= now()) return send(401, { error: 'invalid_token' });
        const licence = signLicence();
        return send(200, { licence, expiresAt: null, graceDays: st.graceDays });
      }
      if (route === 'GET /.well-known/licence-jwks.json') return send(200, { keys: [keys.jwk] });
      // ---- P2-C 短信 / 微信（对齐 packages/cloud 的 LoginController）
      if (route === 'POST /auth/sms/send') {
        if (!st.loginProviders) return send(503, { error: 'sms_unavailable' });
        if (!/^1[3-9]\d{9}$/.test(String(body.phone || ''))) return send(400, { error: 'bad_request' });
        if (st.smsSends++ > 0 && st.lastSmsAt && now() - st.lastSmsAt < 60_000) return send(429, { error: 'rate_limited' });
        st.lastSmsAt = now();
        st.smsCode = { phone: body.phone, code: '246810', attempts: 0 };
        return send(200, { sent: true, phone: '138****8000', expires_in: 300, resend_after: 60, provider: 'mock', debug_code: '246810' });
      }
      if (route === 'POST /auth/sms/login') {
        if (!st.loginProviders) return send(503, { error: 'sms_unavailable' });
        if (!st.smsCode || st.smsCode.phone !== body.phone) return send(400, { error: 'code_expired' });
        if (st.smsCode.code !== body.code) return send(401, { error: 'invalid_code' });
        if (!st.account || st.account.phone !== body.phone) {
          if (!body.inviteCode) return send(400, { error: 'invite_required' });
          if (body.inviteCode !== st.invite) return send(400, { error: 'invalid_invite' });
          st.account = { id: 'acc-1', email: `sms-${body.phone}@placeholder.talekiln.invalid`, phone: body.phone, password: null };
        }
        st.smsCode = null;
        const r = authResult(`fam-${++st.n}`);
        return send(200, { ...r, account: { ...r.account, phone: st.account.phone } });
      }
      if (route === 'POST /auth/wechat/qr') {
        if (!st.loginProviders) return send(503, { error: 'wechat_unavailable' });
        const ticket = `tk-${++st.n}-abcdefgh`;
        st.qr.set(ticket, { status: 'pending', openId: null });
        return send(201, { ticket, qr_url: `talekiln://wechat-mock/confirm?state=${ticket}`, expires_in: 300, poll_interval: 2, provider: 'mock', simulated: true });
      }
      const qrm = /^\/auth\/wechat\/qr\/([^/]+)(\/confirm)?$/.exec(url.pathname);
      if (qrm && (req.method === 'GET' || qrm[2])) {
        const t = st.qr.get(qrm[1]);
        if (!t) return send(404, { error: 'not_found' });
        if (qrm[2]) { t.status = body.scanOnly ? 'scanned' : 'confirmed'; t.openId = body.openId || 'mock-openid-1'; }
        const isNew = !(st.account && st.account.wechatOpenId === t.openId);
        return send(200, { status: t.status, expires_in: 300, ...(t.status === 'confirmed' ? { new_account: isNew } : {}) });
      }
      if (route === 'POST /auth/wechat/login') {
        if (!st.loginProviders) return send(503, { error: 'wechat_unavailable' });
        const t = st.qr.get(body.ticket);
        if (!t) return send(404, { error: 'not_found' });
        if (t.status === 'expired') return send(410, { error: 'qr_expired' });
        if (t.status !== 'confirmed') return send(400, { error: 'bad_request' });
        if (!st.account || st.account.wechatOpenId !== t.openId) {
          if (!body.inviteCode) return send(400, { error: 'invite_required' });
          if (body.inviteCode !== st.invite) return send(400, { error: 'invalid_invite' });
          st.account = { id: 'acc-1', email: 'wx-0123456789abcdef@placeholder.talekiln.invalid', wechatOpenId: t.openId, password: null };
        }
        t.status = 'expired';
        const r = authResult(`fam-${++st.n}`);
        return send(200, { ...r, account: { ...r.account, phone: null } });
      }
      if (route === 'GET /catalog') {
        if (!st.catalog) return send(404, { error: 'not_found' });
        const doc = st.catalog.raw || signCatalog(st.catalog.data);
        if (url.searchParams.get('since') === doc.version) return send(200, { version: doc.version, unchanged: true });
        return send(200, doc);
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    st, signCatalog, es256Sign, newKeyPair,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
  };
}

module.exports = { startMockCloud, es256Sign, newKeyPair };
