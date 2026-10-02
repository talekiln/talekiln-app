// P2-C 登录：短信验证码 / 微信扫码（模拟适配器）。服务层用内存仓储（或 TEST_DATABASE_URL 下的 PostgreSQL），HTTP 层起真实 Nest 应用。
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { makeRepos } from './helpers/repos';
import { createAppModule } from '../src/app.module';
import { configureApp } from '../src/http/setup';
import { AuthService } from '../src/services/auth.service';
import { AuditService } from '../src/services/audit.service';
import { loadConfig } from '../src/services/config';
import { LoginService, normalizePhone, PLACEHOLDER_EMAIL_DOMAIN, SMS_MAX_ATTEMPTS } from '../src/services/login.service';
import { RateLimiter } from '../src/services/rate-limiter';
import { TokenService } from '../src/services/token.service';
import { ServiceError } from '../src/services/errors';
import { MockSmsProvider, MockWechatQrProvider } from '../src/login/providers';
import { createLoginProviders } from '../src/login/registry';

const MIN = 60_000;
const PHONE = '13800138000';
const dev = { fingerprint: 'fp-12345678', name: 'My PC' };
const rejects = (p: Promise<unknown>, code: string, msg?: RegExp) =>
  assert.rejects(p, (e) => e instanceof ServiceError && e.code === code && (!msg || msg.test(e.message)));

async function setup(opts: { env?: Record<string, string>; sms?: boolean; wechat?: boolean } = {}) {
  const repos = await makeRepos();
  let t = Date.parse('2026-10-01T00:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const cfg = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', ...opts.env } as NodeJS.ProcessEnv);
  const tokens = new TokenService(repos, cfg, clock.now);
  const auth = new AuthService(repos, tokens, clock.now, 4);
  const sms = new MockSmsProvider(() => {});
  const wechat = new MockWechatQrProvider();
  const providers = { sms: opts.sms === false ? null : sms, wechat: opts.wechat === false ? null : wechat };
  const limiter = new RateLimiter(() => t);
  const audit = new AuditService(repos, clock.now);
  const login = new LoginService(repos, auth, providers, cfg, limiter, audit, clock.now);
  return { repos, clock, cfg, auth, sms, wechat, login, limiter };
}

test('手机号规范化：接受 +86 / 86 / 空格 / 连字符，拒绝非大陆号码', () => {
  assert.equal(normalizePhone('+86 138 0013 8000'), PHONE);
  assert.equal(normalizePhone('86-13800138000'), PHONE);
  assert.equal(normalizePhone('008613800138000'), PHONE);
  for (const bad of ['12345678901', '1380013800', '', 'abc', '+1 415 555 0100']) {
    assert.throws(() => normalizePhone(bad), (e: unknown) => e instanceof ServiceError && e.code === 'bad_request');
  }
});

test('短信：发码写日志、测试环境回 debug_code；新手机号首登需邀请码且不消耗验证码；登录后返回体与 /auth/login 一致', async () => {
  const { login, auth, sms, repos } = await setup();
  const sent = await login.sendSmsCode({ phone: PHONE, ip: '1.1.1.1' });
  assert.equal(sent.sent, true);
  assert.equal(sent.phone, '138****8000');
  assert.match(sent.debug_code!, /^\d{6}$/);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].code, sent.debug_code);

  // 没邀请码：invite_required，验证码保留
  await rejects(login.smsLogin({ phone: PHONE, code: sent.debug_code!, ip: null }), 'invite_required');
  // 邀请码无效：invalid_invite，验证码仍保留
  await rejects(login.smsLogin({ phone: PHONE, code: sent.debug_code!, inviteCode: 'NOPE', ip: null }), 'invalid_invite');
  const invite = await auth.createInvite('admin', { plan: 'pro' });
  const r = await login.smsLogin({ phone: PHONE, code: sent.debug_code!, inviteCode: invite.code, device: dev, ip: null });
  assert.ok(r.accessToken && r.refreshToken && r.expiresIn > 0);
  assert.equal(r.account.phone, PHONE);
  assert.equal(r.account.plan, 'pro');
  assert.equal(r.account.email, `sms-${PHONE}@${PLACEHOLDER_EMAIL_DOMAIN}`);
  assert.equal(r.device?.name, dev.name);
  // 邀请码已消耗
  assert.ok((await repos.invites.findByCode(invite.code))!.usedAt);
  // 占位邮箱不能用密码登录
  await rejects(auth.login({ email: r.account.email, password: 'anything-at-all' }), 'invalid_credentials');
  // 验证码一次性
  await rejects(login.smsLogin({ phone: PHONE, code: sent.debug_code!, ip: null }), 'code_expired');
  // 审计里记了登录方式
  const audits = await repos.adminAudit.list({ limit: 10 });
  const ok = audits.find((a) => a.ok && a.action === 'POST /auth/sms/login');
  assert.ok(ok);
  assert.equal(ok!.actorId, r.account.id);
  assert.deepEqual((ok!.detail as { body: { method: string; phone: string } }).body, { method: 'sms', phone: '138****8000' });
  assert.ok(audits.some((a) => !a.ok && a.status === 400 && a.action === 'POST /auth/sms/login'));
});

test('短信：老用户再次登录不需要邀请码；重复手机号不会建第二个账号；停用账号拒绝', async () => {
  const { login, auth, repos, clock } = await setup();
  const invite = await auth.createInvite('admin');
  const s1 = await login.sendSmsCode({ phone: PHONE, ip: null });
  const first = await login.smsLogin({ phone: PHONE, code: s1.debug_code!, inviteCode: invite.code, ip: null });
  clock.advance(MIN + 1);
  const s2 = await login.sendSmsCode({ phone: '+86 138 0013 8000', ip: null });
  const again = await login.smsLogin({ phone: '13800138000', code: s2.debug_code!, ip: null });
  assert.equal(again.account.id, first.account.id);
  assert.equal((await repos.accounts.list()).length, 1);

  await repos.accounts.setDisabled(first.account.id, clock.now());
  clock.advance(MIN + 1);
  const s3 = await login.sendSmsCode({ phone: PHONE, ip: null });
  await rejects(login.smsLogin({ phone: PHONE, code: s3.debug_code!, ip: null }), 'account_disabled');
});

test('短信：验证码 5 分钟过期；错 5 次作废；新码顶掉旧码', async () => {
  const { login, auth, clock } = await setup();
  const invite = await auth.createInvite('admin');
  const s1 = await login.sendSmsCode({ phone: PHONE, ip: null });
  clock.advance(5 * MIN + 1);
  await rejects(login.smsLogin({ phone: PHONE, code: s1.debug_code!, inviteCode: invite.code, ip: null }), 'code_expired');

  const s2 = await login.sendSmsCode({ phone: PHONE, ip: null });
  const wrong = s2.debug_code === '000000' ? '111111' : '000000';
  for (let i = 1; i < SMS_MAX_ATTEMPTS; i++) {
    await rejects(login.smsLogin({ phone: PHONE, code: wrong, inviteCode: invite.code, ip: null }), 'invalid_code', /验证码错误$/);
  }
  await rejects(login.smsLogin({ phone: PHONE, code: wrong, inviteCode: invite.code, ip: null }), 'invalid_code', /次数过多/);
  // 作废后正确的码也不行
  await rejects(login.smsLogin({ phone: PHONE, code: s2.debug_code!, inviteCode: invite.code, ip: null }), 'code_expired');

  clock.advance(MIN + 1);
  const s3 = await login.sendSmsCode({ phone: PHONE, ip: null });
  clock.advance(MIN + 1);
  const s4 = await login.sendSmsCode({ phone: PHONE, ip: null });
  // 旧码被顶掉：对新码而言它只是一个错误的码
  if (s3.debug_code !== s4.debug_code) {
    await rejects(login.smsLogin({ phone: PHONE, code: s3.debug_code!, inviteCode: invite.code, ip: null }), 'invalid_code');
  }
  const r = await login.smsLogin({ phone: PHONE, code: s4.debug_code!, inviteCode: invite.code, ip: null });
  assert.equal(r.account.phone, PHONE);
});

test('短信限频：每手机号 1 分钟 1 次、每小时 5 次；每 IP 每小时 30 次', async () => {
  const { login, clock } = await setup();
  await login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' });
  await rejects(login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' }), 'rate_limited');
  clock.advance(MIN + 1);
  await login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' });
  for (let i = 0; i < 3; i++) { clock.advance(MIN + 1); await login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' }); }
  clock.advance(MIN + 1);
  await rejects(login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' }), 'rate_limited'); // 第 6 次 / 小时
  // 换手机号不受影响，但 IP 窗口共用
  await login.sendSmsCode({ phone: '13900139000', ip: '9.9.9.9' });
  clock.advance(60 * MIN + 1);
  await login.sendSmsCode({ phone: PHONE, ip: '9.9.9.9' });

  // IP 限制：30 次 / 小时
  const { login: l2, clock: c2 } = await setup();
  for (let i = 0; i < 30; i++) {
    await l2.sendSmsCode({ phone: `139${String(10000000 + i).padStart(8, '0')}`, ip: '8.8.8.8' });
    c2.advance(1000);
  }
  await rejects(l2.sendSmsCode({ phone: '13700137000', ip: '8.8.8.8' }), 'rate_limited');
  await l2.sendSmsCode({ phone: '13700137000', ip: '8.8.4.4' });
});

test('微信扫码：状态机 pending -> scanned -> confirmed，过期与一票一用，首登需邀请码，同一 openid 只有一个账号', async () => {
  const { login, auth, repos, clock } = await setup();
  const qr = await login.createWechatQr({ ip: null });
  assert.match(qr.qr_url, /^talekiln:\/\/wechat-mock\//);
  assert.equal(qr.simulated, true);
  assert.equal((await login.wechatQrStatus(qr.ticket)).status, 'pending');
  await rejects(login.wechatLogin({ ticket: qr.ticket, ip: null }), 'bad_request');

  assert.equal((await login.simulateConfirm(qr.ticket, { scanOnly: true })).status, 'scanned');
  const confirmed = await login.simulateConfirm(qr.ticket, { openId: 'wx-user-1' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.new_account, true);
  // 重复确认幂等
  assert.equal((await login.simulateConfirm(qr.ticket, { openId: 'wx-user-1' })).status, 'confirmed');

  await rejects(login.wechatLogin({ ticket: qr.ticket, ip: null }), 'invite_required');
  const invite = await auth.createInvite('admin');
  const r = await login.wechatLogin({ ticket: qr.ticket, inviteCode: invite.code, device: dev, ip: null });
  assert.match(r.account.email, new RegExp(`^wx-[0-9a-f]{16}@${PLACEHOLDER_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`));
  assert.equal(r.account.phone, null);
  assert.equal((await repos.accounts.findByWechatOpenId('wx-user-1'))!.id, r.account.id);
  // 一票一用
  await rejects(login.wechatLogin({ ticket: qr.ticket, ip: null }), 'qr_expired');
  assert.equal((await login.wechatQrStatus(qr.ticket)).status, 'expired');

  // 第二次扫码：老用户，不要邀请码，不建新账号
  const qr2 = await login.createWechatQr({ ip: null });
  const c2 = await login.simulateConfirm(qr2.ticket, { openId: 'wx-user-1' });
  assert.equal(c2.new_account, false);
  const r2 = await login.wechatLogin({ ticket: qr2.ticket, ip: null });
  assert.equal(r2.account.id, r.account.id);
  assert.equal((await repos.accounts.list()).length, 1);

  // 过期：pending 的票据到期后 expired，确认与登录都拒绝
  const qr3 = await login.createWechatQr({ ip: null });
  clock.advance(qr3.expires_in * 1000 + 1);
  assert.equal((await login.wechatQrStatus(qr3.ticket)).status, 'expired');
  await rejects(login.simulateConfirm(qr3.ticket), 'qr_expired');
  await rejects(login.wechatLogin({ ticket: qr3.ticket, ip: null }), 'qr_expired');
  await rejects(login.wechatQrStatus('does-not-exist'), 'not_found');

  // 回调路径（真实适配器的入口）：code 换 openid 并确认票据
  const qr4 = await login.createWechatQr({ ip: null });
  const cb = await login.wechatCallback({ code: 'abc', state: qr4.ticket });
  assert.equal(cb.status, 'confirmed');
  assert.equal((await repos.wechatQr.findByTicket(qr4.ticket))!.openId, 'mock-openid-abc');
});

test('适配器未接入：短信 / 微信接口抛 503 错误码；模拟确认接口在非模拟适配器下 404；生产环境默认 none', async () => {
  const none = await setup({ sms: false, wechat: false });
  await rejects(none.login.sendSmsCode({ phone: PHONE, ip: null }), 'sms_unavailable');
  await rejects(none.login.smsLogin({ phone: PHONE, code: '123456', ip: null }), 'sms_unavailable');
  await rejects(none.login.createWechatQr({ ip: null }), 'wechat_unavailable');
  await rejects(none.login.wechatLogin({ ticket: 'ticket-1234', ip: null }), 'wechat_unavailable');
  await rejects(none.login.simulateConfirm('ticket-1234'), 'not_found');

  const base = { JWT_ACCESS_SECRET: 'x'.repeat(40), LICENCE_PRIVATE_KEY_PEM: none.cfg.licencePrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const prod = loadConfig({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
  assert.equal(prod.smsProvider, 'none');
  assert.equal(prod.wechatProvider, 'none');
  assert.equal(prod.loginDebug, false);
  assert.deepEqual(createLoginProviders(prod), { sms: null, wechat: null });
  const devCfg = loadConfig({ ...base, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(devCfg.smsProvider, 'mock');
  assert.ok(createLoginProviders(devCfg).sms?.name === 'mock');
  assert.throws(() => loadConfig({ ...base, SMS_PROVIDER: 'aliyun' } as NodeJS.ProcessEnv), /SMS_PROVIDER/);

  // 生产 + mock：验证码仍写日志，但接口不回 debug_code
  const prodMock = await setup({ env: { NODE_ENV: 'production', LICENCE_PRIVATE_KEY_PEM: base.LICENCE_PRIVATE_KEY_PEM } });
  const sent = await prodMock.login.sendSmsCode({ phone: PHONE, ip: null });
  assert.equal(sent.debug_code, undefined);
  assert.equal(prodMock.sms.sent.length, 1);
});

// ---------------------------------------------------------------- HTTP

async function boot(opts: { env?: Record<string, string>; providers?: { sms: MockSmsProvider | null; wechat: MockWechatQrProvider | null } } = {}) {
  const repos = await makeRepos();
  const config = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test', ...opts.env } as NodeJS.ProcessEnv);
  const sms = new MockSmsProvider(() => {});
  const providers = opts.providers ?? { sms, wechat: new MockWechatQrProvider() };
  const app = await NestFactory.create(createAppModule({ repos, config, loginProviders: providers }), { logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const call = async (path: string, o: { body?: unknown; method?: string } = {}) => {
    const res = await fetch(base + path, {
      method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json' },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 空应答 */ }
    return { status: res.status, json };
  };
  const auth = new AuthService(repos, new TokenService(repos, config), undefined, 4);
  return { repos, call, sms, auth, close: () => app.close() };
}

test('HTTP：短信发码 / 登录、微信二维码轮询与模拟确认、状态码与错误码', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('/auth/sms/send', { body: { phone: 'nope' } })).status, 400);
    const sent = await s.call('/auth/sms/send', { body: { phone: PHONE } });
    assert.equal(sent.status, 200);
    assert.match(sent.json.debug_code, /^\d{6}$/);
    assert.equal((await s.call('/auth/sms/send', { body: { phone: PHONE } })).status, 429);

    const noInvite = await s.call('/auth/sms/login', { body: { phone: PHONE, code: sent.json.debug_code } });
    assert.equal(noInvite.status, 400);
    assert.equal(noInvite.json.error, 'invite_required');
    const wrong = await s.call('/auth/sms/login', { body: { phone: PHONE, code: '000000', inviteCode: 'X' } });
    assert.equal(wrong.status, sent.json.debug_code === '000000' ? 400 : 401);
    const invite = await s.auth.createInvite(null);
    const ok = await s.call('/auth/sms/login', { body: { phone: PHONE, code: sent.json.debug_code, inviteCode: invite.code, device: dev } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(Object.keys(ok.json).sort(), ['accessToken', 'account', 'device', 'expiresIn', 'refreshToken']);
    assert.equal(ok.json.account.phone, PHONE);
    // 刷新令牌能用（与 /auth/login 同一套签发）
    assert.equal((await s.call('/auth/refresh', { body: { refreshToken: ok.json.refreshToken } })).status, 200);

    const qr = await s.call('/auth/wechat/qr', { method: 'POST' });
    assert.equal(qr.status, 201);
    assert.ok(qr.json.ticket && qr.json.qr_url && qr.json.simulated === true);
    assert.equal((await s.call(`/auth/wechat/qr/${qr.json.ticket}`)).json.status, 'pending');
    assert.equal((await s.call('/auth/wechat/qr/unknown-ticket')).status, 404);
    const confirmed = await s.call(`/auth/wechat/qr/${qr.json.ticket}/confirm`, { body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.status, 'confirmed');
    assert.equal(confirmed.json.new_account, true);
    const poll = await s.call(`/auth/wechat/qr/${qr.json.ticket}`);
    assert.deepEqual([poll.json.status, poll.json.new_account], ['confirmed', true]);
    const need = await s.call('/auth/wechat/login', { body: { ticket: qr.json.ticket } });
    assert.equal(need.json.error, 'invite_required');
    const i2 = await s.auth.createInvite(null);
    const wx = await s.call('/auth/wechat/login', { body: { ticket: qr.json.ticket, inviteCode: i2.code, device: dev } });
    assert.equal(wx.status, 200, JSON.stringify(wx.json));
    assert.equal(wx.json.account.phone, null);
    const reuse = await s.call('/auth/wechat/login', { body: { ticket: qr.json.ticket } });
    assert.equal(reuse.status, 410);
    assert.equal(reuse.json.error, 'qr_expired');
  } finally {
    await s.close();
  }
});

test('HTTP：未配置适配器时 503（sms_unavailable / wechat_unavailable），模拟确认接口 404；现有邮箱密码登录不受影响', async () => {
  const s = await boot({ providers: { sms: null, wechat: null } });
  try {
    const send = await s.call('/auth/sms/send', { body: { phone: PHONE } });
    assert.equal(send.status, 503);
    assert.equal(send.json.error, 'sms_unavailable');
    const qr = await s.call('/auth/wechat/qr', { method: 'POST' });
    assert.equal(qr.status, 503);
    assert.equal(qr.json.error, 'wechat_unavailable');
    assert.equal((await s.call('/auth/wechat/qr/some-ticket-1234/confirm', { body: {} })).status, 404);

    const invite = await s.auth.createInvite(null);
    const act = await s.call('/auth/activate', { body: { inviteCode: invite.code, email: 'a@x.com', password: 'password1' } });
    assert.equal(act.status, 201);
    assert.equal(act.json.account.phone, null);
    assert.equal((await s.call('/auth/login', { body: { email: 'a@x.com', password: 'password1' } })).status, 200);
  } finally {
    await s.close();
  }
});
