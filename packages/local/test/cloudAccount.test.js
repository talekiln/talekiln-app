'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const secrets = require('../src/secrets');
const { createCloud } = require('../src/cloud');
const { localTokenGuard } = require('../src/utils/localToken');
const cloudRoutes = require('../src/routes/cloud');
const { getGlobalSetting } = require('../src/services/settingsService');
const { startMockCloud, es256Sign, newKeyPair } = require('./helpers/mockCloud');

const DAY = 86400_000;
const T0 = Date.UTC(2026, 9, 1);
const REGISTER = { inviteCode: 'GOOD-INVITE', email: 'A@Example.com', password: 'password1' };

async function setup(t = {}) {
  let clock = T0;
  const now = () => clock;
  const mock = await startMockCloud({ now });
  Object.assign(mock.st, t);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);
  const store = new secrets.FileSecretStore({ cipher: secrets.createAesCipher(crypto.randomBytes(32)) });
  secrets.setSecretStore(store);
  const cloud = createCloud({ config: { cloud: { base_url: mock.url } }, db, log: {}, now });
  return { mock, db, store, cloud, advance: (ms) => { clock += ms; }, setNow: (v) => { clock = v; } };
}

describe('account session', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.mock.close(); secrets.setSecretStore(null); });

  it('register stores the refresh token only in the secret store and returns a valid licence', async () => {
    const s = await ctx.cloud.account.register(REGISTER);
    assert.equal(s.logged_in, true);
    assert.equal(s.account.email, 'a@example.com');
    assert.equal(s.licence.state, 'valid');
    assert.equal(s.licence.verified, true);
    assert.equal(s.entitled, true);
    assert.ok(ctx.store.has('cloud:refresh_token'));
    // 库里不得出现任何令牌明文
    const dump = JSON.stringify(db2rows(ctx.db));
    for (const secret of ctx.store.knownSecrets()) assert.ok(!dump.includes(secret), 'secret leaked into sqlite');
    assert.ok(!dump.includes('at-'), 'access token persisted');
    assert.ok(!JSON.stringify(s).includes('rt-'));
  });

  it('login with bad credentials leaves no session', async () => {
    await ctx.cloud.account.register(REGISTER);
    await ctx.cloud.account.logout();
    await assert.rejects(ctx.cloud.account.login({ email: 'a@example.com', password: 'nope-nope' }), (e) => e.code === 'invalid_credentials');
    const s = await ctx.cloud.account.status();
    assert.equal(s.logged_in, false);
    const ok = await ctx.cloud.account.login({ email: 'a@example.com', password: 'password1' });
    assert.equal(ok.logged_in, true);
  });

  it('refreshes the access token when expired, rotating and persisting the refresh token', async () => {
    await ctx.cloud.account.register(REGISTER);
    const rt1 = ctx.store.get('cloud:refresh_token');
    ctx.advance(2 * 60_000); // access token 60s 过期
    const seen = [];
    await ctx.cloud.account.authed(async (tok) => { seen.push(tok); });
    const rt2 = ctx.store.get('cloud:refresh_token');
    assert.notEqual(rt1, rt2);
    assert.equal(ctx.mock.st.calls.filter((c) => c === 'POST /auth/refresh').length, 1);
    await ctx.cloud.account.authed(async (tok) => { seen.push(tok); }); // 仍有效，不再刷新
    assert.equal(ctx.mock.st.calls.filter((c) => c === 'POST /auth/refresh').length, 1);
    assert.equal(seen[0], seen[1]);
  });

  it('coalesces concurrent refreshes so the rotated token is not replayed', async () => {
    await ctx.cloud.account.register(REGISTER);
    ctx.advance(2 * 60_000);
    await Promise.all([1, 2, 3, 4].map(() => ctx.cloud.account.authed(async () => {})));
    assert.equal(ctx.mock.st.calls.filter((c) => c === 'POST /auth/refresh').length, 1);
    assert.equal((await ctx.cloud.account.status()).logged_in, true);
  });

  it('retries once with a fresh token when the server rejects the access token', async () => {
    await ctx.cloud.account.register(REGISTER);
    ctx.mock.st.access.clear(); // 服务端丢了访问令牌，本地以为还有效
    const s = await ctx.cloud.account.status({ force: true });
    assert.equal(s.logged_in, true);
    assert.equal(s.licence.state, 'valid');
    assert.equal(ctx.mock.st.calls.filter((c) => c === 'POST /auth/refresh').length, 1);
  });

  it('a revoked refresh token ends the session and tells the UI it expired', async () => {
    await ctx.cloud.account.register(REGISTER);
    ctx.advance(2 * 60_000);
    ctx.mock.st.refresh.clear();
    const s = await ctx.cloud.account.status({ force: true });
    assert.equal(s.logged_in, false);
    assert.equal(s.session, 'expired');
    assert.equal(ctx.store.has('cloud:refresh_token'), false);
    assert.equal(ctx.store.has('cloud:licence'), false);
  });

  it('logout works offline and wipes local secrets', async () => {
    await ctx.cloud.account.register(REGISTER);
    ctx.mock.st.down = true;
    const s = await ctx.cloud.account.logout();
    assert.equal(s.logged_in, false);
    assert.equal(ctx.store.has('cloud:refresh_token'), false);
  });

  it('refuses to log in when secrets cannot be stored safely, and revokes the new token', async () => {
    secrets.setSecretStore(new secrets.UnavailableSecretStore());
    await assert.rejects(ctx.cloud.account.register(REGISTER), (e) => e.code === 'SECRET_STORE_UNAVAILABLE');
    assert.equal((await ctx.cloud.account.status()).logged_in, false);
    assert.ok(ctx.mock.st.revokedFamilies.size >= 1 || ctx.mock.st.calls.includes('POST /auth/logout'));
  });
});

describe('offline grace', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); await ctx.cloud.account.register(REGISTER); });
  afterEach(async () => { await ctx.mock.close(); secrets.setSecretStore(null); });

  it('uses the cached licence while the cloud is unreachable: valid, then grace, then expired', async () => {
    ctx.mock.st.down = true;
    ctx.advance(3 * DAY);
    let s = await ctx.cloud.account.status({ sync: true });
    assert.equal(s.licence.state, 'valid');
    assert.equal(s.entitled, true);
    ctx.advance(5 * DAY); // 总 8 天：已过 7 天有效期，进入宽限
    s = await ctx.cloud.account.status({ sync: true });
    assert.equal(s.licence.state, 'grace');
    assert.equal(s.entitled, true);
    assert.equal(s.offline, true);
    assert.ok(s.licence.days_left >= 1 && s.licence.days_left <= 14);
    ctx.advance(14 * DAY); // 总 22 天 > 7 + 14
    s = await ctx.cloud.account.status({ sync: true });
    assert.equal(s.licence.state, 'expired');
    assert.equal(s.entitled, false);
    assert.equal(s.logged_in, true, '过期不等于登出，联网后可续期');
  });

  it('renews when back online and recovers from grace', async () => {
    ctx.mock.st.down = true;
    ctx.advance(8 * DAY);
    assert.equal((await ctx.cloud.account.status({ sync: true })).licence.state, 'grace');
    ctx.mock.st.down = false;
    const s = await ctx.cloud.account.status({ sync: true });
    assert.equal(s.licence.state, 'valid');
    assert.equal(s.offline, false);
  });

  it('renews early only when the licence is past half of its lifetime', async () => {
    const renews = () => ctx.mock.st.calls.filter((c) => c === 'POST /licence/renew').length;
    const before = renews();
    ctx.advance(1 * DAY);
    await ctx.cloud.account.status({ sync: true });
    assert.equal(renews(), before);
    ctx.advance(3 * DAY); // 4 天 > 7 天的一半
    await ctx.cloud.account.status({ sync: true });
    assert.equal(renews(), before + 1);
  });

  it('rolling the clock back does not extend an expired licence', async () => {
    ctx.mock.st.down = true;
    ctx.advance(30 * DAY);
    await ctx.cloud.account.status();
    assert.equal((await ctx.cloud.account.status()).licence.state, 'expired');
    ctx.setNow(T0 + 1 * DAY);
    assert.equal((await ctx.cloud.account.status()).licence.state, 'expired');
  });

  it('rejects a licence signed by another key or for another device', async () => {
    const evil = newKeyPair();
    const iat = Math.floor(T0 / 1000);
    const forged = es256Sign({ alg: 'ES256', kid: 'k1' }, JSON.stringify({ iss: 'talekiln-cloud', sub: 'acc-1', did: 'dev-1', graceDays: 99, iat, exp: iat + 9e6, entitlements: ['all'] }), evil.privateKey);
    ctx.store.set('cloud:licence', forged);
    let s = await ctx.cloud.account.status();
    assert.equal(s.licence.state, 'none');
    assert.equal(s.entitled, false);
    const other = es256Sign({ alg: 'ES256', kid: 'k1' }, JSON.stringify({ iss: 'talekiln-cloud', sub: 'acc-1', did: 'dev-OTHER', graceDays: 14, iat, exp: iat + 9e6 }), ctx.mock.st.keys.privateKey);
    ctx.store.set('cloud:licence', other);
    s = await ctx.cloud.account.status();
    assert.equal(s.licence.state, 'none');
  });

  it('does not count a tampered payload', async () => {
    const [h, p, sig] = ctx.store.get('cloud:licence').split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.exp += 365 * 86400;
    ctx.store.set('cloud:licence', `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`);
    assert.equal((await ctx.cloud.account.status()).licence.state, 'none');
  });
});

describe('local account routes', () => {
  let ctx; let server; let base;
  const TOKEN = 'unit-test-local-token';
  beforeEach(async () => {
    ctx = await setup();
    const app = express();
    app.use(localTokenGuard(TOKEN));
    app.use(express.json());
    const c = cloudRoutes(ctx.cloud, { error() {}, warn() {} });
    app.post('/api/v1/account/register', c.register);
    app.post('/api/v1/account/login', c.login);
    app.post('/api/v1/account/logout', c.logout);
    app.get('/api/v1/account/status', c.status);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  afterEach(async () => { server.close(); await ctx.mock.close(); secrets.setSecretStore(null); });
  const call = (method, path, body, token = TOKEN) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Talekiln-Token': token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  it('requires the local token on every account route', async () => {
    for (const [m, p] of [['GET', '/account/status'], ['POST', '/account/login'], ['POST', '/account/logout'], ['POST', '/account/register']]) {
      assert.equal((await call(m, p, {}, null)).status, 401, p);
      assert.equal((await call(m, p, {}, 'wrong')).status, 401, p);
    }
  });

  it('register -> status -> logout through the API, never echoing tokens', async () => {
    const reg = await call('POST', '/account/register', { invite_code: 'GOOD-INVITE', email: 'u@example.com', password: 'password1' });
    assert.equal(reg.status, 200);
    assert.equal(reg.json.data.logged_in, true);
    assert.equal(reg.json.data.configured, true);
    assert.ok(!/rt-|at-|eyJ/.test(JSON.stringify(reg.json)), 'no tokens in response');
    assert.equal((await call('GET', '/account/status')).json.data.account.email, 'u@example.com');
    assert.equal((await call('POST', '/account/logout')).json.data.logged_in, false);
  });

  it('maps cloud failures to stable Chinese error states', async () => {
    const bad = await call('POST', '/account/register', { invite_code: 'WRONG', email: 'u@example.com', password: 'password1' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_INVITE');
    assert.match(bad.json.error.message, /邀请码/);
    const short = await call('POST', '/account/register', { invite_code: 'GOOD-INVITE', email: 'u@example.com', password: 'short' });
    assert.equal(short.json.error.code, 'BAD_REQUEST');
    await call('POST', '/account/register', { invite_code: 'GOOD-INVITE', email: 'u@example.com', password: 'password1' });
    await call('POST', '/account/logout');
    const dup = await call('POST', '/account/register', { invite_code: 'GOOD-INVITE', email: 'u@example.com', password: 'password1' });
    assert.equal(dup.json.error.code, 'EMAIL_TAKEN');
    const wrong = await call('POST', '/account/login', { email: 'u@example.com', password: 'wrong-pass' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');
    ctx.mock.st.down = true;
    const down = await call('POST', '/account/login', { email: 'u@example.com', password: 'password1' });
    assert.equal(down.status, 503);
    assert.equal(down.json.error.code, 'CLOUD_UNREACHABLE');
    const missing = await call('POST', '/account/login', { email: 'u@example.com' });
    assert.equal(missing.status, 400);
  });

  it('reports CLOUD_NOT_CONFIGURED for the placeholder base URL', async () => {
    const cloud = createCloud({ config: { cloud: {} }, db: ctx.db, log: {} });
    const app = express();
    app.use(express.json());
    app.post('/login', cloudRoutes(cloud, {}).login);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'password1' }) });
    s.close();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'CLOUD_NOT_CONFIGURED');
  });

  it('keeps passwords out of the settings table', async () => {
    await call('POST', '/account/register', { invite_code: 'GOOD-INVITE', email: 'u@example.com', password: 'password1' });
    assert.ok(!JSON.stringify(db2rows(ctx.db)).includes('password1'));
    assert.equal(getGlobalSetting(ctx.db, 'cloud.session').account.email, 'u@example.com');
  });
});

// P2-C：短信验证码 / 微信扫码经本地透传
describe('local sms / wechat login routes (P2-C)', () => {
  let ctx; let server; let base;
  const TOKEN = 'unit-test-local-token';
  const PHONE = '13800138000';
  beforeEach(async () => {
    ctx = await setup();
    const app = express();
    app.use(localTokenGuard(TOKEN));
    app.use(express.json());
    const c = cloudRoutes(ctx.cloud, { error() {}, warn() {} });
    app.post('/api/v1/account/sms/send', c.smsSend);
    app.post('/api/v1/account/sms/login', c.smsLogin);
    app.post('/api/v1/account/wechat/qr', c.wechatQr);
    app.get('/api/v1/account/wechat/qr/:ticket', c.wechatQrStatus);
    app.post('/api/v1/account/wechat/qr/:ticket/confirm', c.wechatConfirm);
    app.post('/api/v1/account/wechat/login', c.wechatLogin);
    app.get('/api/v1/account/status', c.status);
    app.post('/api/v1/account/logout', c.logout);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });
  afterEach(async () => { server.close(); await ctx.mock.close(); secrets.setSecretStore(null); });
  const call = (method, path, body, token = TOKEN) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Talekiln-Token': token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  it('sms: send -> invite required on first login -> login; status carries phone and login_method; no tokens echoed', async () => {
    assert.equal((await call('POST', '/account/sms/send', {})).status, 400);
    const sent = await call('POST', '/account/sms/send', { phone: PHONE });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.data.debug_code, '246810');
    const need = await call('POST', '/account/sms/login', { phone: PHONE, code: '246810' });
    assert.equal(need.status, 400);
    assert.equal(need.json.error.code, 'INVITE_REQUIRED');
    const wrong = await call('POST', '/account/sms/login', { phone: PHONE, code: '000000', invite_code: 'GOOD-INVITE' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'INVALID_CODE');
    const ok = await call('POST', '/account/sms/login', { phone: PHONE, code: '246810', invite_code: 'GOOD-INVITE' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.logged_in, true);
    assert.equal(ok.json.data.account.phone, PHONE);
    assert.equal(ok.json.data.account.login_method, 'sms');
    assert.ok(!/rt-|at-/.test(JSON.stringify(ok.json)), 'no tokens in response');
    assert.ok(ctx.store.has('cloud:refresh_token'));
    const st = await call('GET', '/account/status');
    assert.equal(st.json.data.account.login_method, 'sms');
    // 验证码一次性
    const again = await call('POST', '/account/sms/login', { phone: PHONE, code: '246810' });
    assert.equal(again.json.error.code, 'CODE_EXPIRED');
    // 限频映射
    const limited = await call('POST', '/account/sms/send', { phone: PHONE });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'CLOUD_RATE_LIMITED');
  });

  it('wechat: qr -> poll -> simulated confirm -> invite required -> login; reuse is QR_EXPIRED; unknown ticket 404', async () => {
    const qr = await call('POST', '/account/wechat/qr', {});
    assert.equal(qr.status, 200);
    const { ticket } = qr.json.data;
    assert.ok(ticket && qr.json.data.qr_url && qr.json.data.simulated === true);
    assert.equal((await call('GET', `/account/wechat/qr/${ticket}`)).json.data.status, 'pending');
    assert.equal((await call('GET', '/account/wechat/qr/nope')).json.error.code, 'NOT_FOUND');
    const scanned = await call('POST', `/account/wechat/qr/${ticket}/confirm`, { scan_only: true });
    assert.equal(scanned.json.data.status, 'scanned');
    const confirmed = await call('POST', `/account/wechat/qr/${ticket}/confirm`, {});
    assert.deepEqual([confirmed.json.data.status, confirmed.json.data.new_account], ['confirmed', true]);
    const need = await call('POST', '/account/wechat/login', { ticket });
    assert.equal(need.json.error.code, 'INVITE_REQUIRED');
    const ok = await call('POST', '/account/wechat/login', { ticket, invite_code: 'GOOD-INVITE' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.account.login_method, 'wechat');
    assert.equal(ok.json.data.account.phone, null);
    const reuse = await call('POST', '/account/wechat/login', { ticket });
    assert.equal(reuse.status, 410);
    assert.equal(reuse.json.error.code, 'QR_EXPIRED');
  });

  it('maps cloud 503 (adapter not configured) to LOGIN_METHOD_UNAVAILABLE', async () => {
    ctx.mock.st.loginProviders = false;
    const sms = await call('POST', '/account/sms/send', { phone: PHONE });
    assert.equal(sms.status, 503);
    assert.equal(sms.json.error.code, 'LOGIN_METHOD_UNAVAILABLE');
    const qr = await call('POST', '/account/wechat/qr', {});
    assert.equal(qr.status, 503);
    assert.equal(qr.json.error.code, 'LOGIN_METHOD_UNAVAILABLE');
  });
});

function db2rows(db) {
  return db.prepare('SELECT key, value FROM global_settings').all();
}
