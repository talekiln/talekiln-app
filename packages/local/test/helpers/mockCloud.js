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
