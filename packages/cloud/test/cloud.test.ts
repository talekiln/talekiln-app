import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importJWK, SignJWT } from 'jose';
import { makeRepos } from './helpers/repos';
import { AuthService } from '../src/services/auth.service';
import { loadConfig } from '../src/services/config';
import { DeviceService } from '../src/services/device.service';
import { LicenceService } from '../src/services/licence.service';
import { TokenService } from '../src/services/token.service';
import { ServiceError } from '../src/services/errors';

async function setup() {
  const repos = await makeRepos();
  let t = Date.parse('2026-10-01T00:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const cfg = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const tokens = new TokenService(repos, cfg, clock.now);
  const auth = new AuthService(repos, tokens, clock.now, 4); // 低成本轮数，仅测试
  const devices = new DeviceService(repos, clock.now);
  const licences = new LicenceService(repos, cfg, clock.now);
  return { repos, clock, cfg, tokens, auth, devices, licences };
}
const dev = { fingerprint: 'fp-12345678', name: 'My PC' };
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e) => e instanceof ServiceError && e.code === code);

test('邀请码一码一用', async () => {
  const { auth } = await setup();
  const invite = await auth.createInvite('admin');
  const ok = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' });
  assert.equal(ok.account.email, 'a@x.com');
  await rejects(auth.activate({ inviteCode: invite.code, email: 'b@x.com', password: 'password1' }), 'invalid_invite');
  await rejects(auth.activate({ inviteCode: 'NOPE', email: 'c@x.com', password: 'password1' }), 'invalid_invite');
});

test('邀请码并发激活只有一个成功，失败者不留账号', async () => {
  const { auth, repos } = await setup();
  const invite = await auth.createInvite('admin');
  const results = await Promise.allSettled([
    auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' }),
    auth.activate({ inviteCode: invite.code, email: 'b@x.com', password: 'password1' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const survivors = [await repos.accounts.findByEmail('a@x.com'), await repos.accounts.findByEmail('b@x.com')];
  assert.equal(survivors.filter(Boolean).length, 1);
});

test('同邮箱并发激活：唯一键冲突映射为 email_taken，仅一个账号；非唯一键故障不被伪装', async () => {
  const { auth, repos } = await setup();
  const i1 = await auth.createInvite('admin');
  const i2 = await auth.createInvite('admin');
  const rs = await Promise.allSettled([
    auth.activate({ inviteCode: i1.code, email: 'same@x.com', password: 'password1' }),
    auth.activate({ inviteCode: i2.code, email: 'same@x.com', password: 'password1' }),
  ]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(lost.reason instanceof ServiceError && lost.reason.code === 'email_taken');
  assert.equal((await repos.accounts.list()).length, 1);

  const i3 = await auth.createInvite('admin');
  const broken = { ...repos, accounts: { ...repos.accounts, create: async () => { throw new Error('connection reset'); } } };
  const auth2 = new AuthService(broken, new TokenService(broken, loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv)), undefined, 4);
  await assert.rejects(auth2.activate({ inviteCode: i3.code, email: 'z@x.com', password: 'password1' }), /connection reset/);
});

test('过期邀请码不可用；密码登录', async () => {
  const { auth, clock } = await setup();
  const invite = await auth.createInvite('admin', { expiresInDays: 1 });
  clock.advance(2 * 86400_000);
  await rejects(auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' }), 'invalid_invite');
  const i2 = await auth.createInvite('admin');
  await auth.activate({ inviteCode: i2.code, email: 'A@x.com', password: 'password1' });
  const r = await auth.login({ email: 'a@X.com', password: 'password1', device: dev });
  assert.ok(r.device);
  await rejects(auth.login({ email: 'a@x.com', password: 'wrong-pass' }), 'invalid_credentials');
  await rejects(auth.login({ email: 'nobody@x.com', password: 'password1' }), 'invalid_credentials');
});

test('刷新令牌轮换；重放旧令牌吊销整个家族', async () => {
  const { auth, repos } = await setup();
  const invite = await auth.createInvite('admin');
  const first = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1', device: dev });
  const second = await auth.refresh(first.refreshToken);
  const third = await auth.refresh(second.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  // 重放最早的令牌 -> 检测到重用
  await rejects(auth.refresh(first.refreshToken), 'token_reuse');
  // 家族内最新令牌也被吊销
  await rejects(auth.refresh(third.refreshToken), 'token_reuse');
  // 另一次登录是独立家族，不受影响
  const other = await auth.login({ email: 'a@x.com', password: 'password1', device: dev });
  await auth.refresh(other.refreshToken);
  assert.ok(await repos.refreshTokens.findByHash('0'.repeat(64)) === null);
});

test('并发使用同一刷新令牌：只有一个成功，家族被吊销', async () => {
  const { auth } = await setup();
  const invite = await auth.createInvite('admin');
  const first = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' });
  const rs = await Promise.allSettled([auth.refresh(first.refreshToken), auth.refresh(first.refreshToken)]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
});

test('刷新令牌过期被拒；登出吊销', async () => {
  const { auth, clock } = await setup();
  const invite = await auth.createInvite('admin');
  const first = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' });
  await auth.logout(first.refreshToken);
  await rejects(auth.refresh(first.refreshToken), 'token_reuse');
  const again = await auth.login({ email: 'a@x.com', password: 'password1' });
  clock.advance(31 * 86400_000);
  await rejects(auth.refresh(again.refreshToken), 'invalid_token');
});

test('许可证：公钥可验证，claims 正确，篡改失败', async () => {
  const { auth, licences, tokens, clock, cfg } = await setup();
  const invite = await auth.createInvite('admin');
  const r = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1', device: dev });
  const claims = await tokens.verifyAccess(r.accessToken);
  const { licence, graceDays } = await licences.renew(claims.accountId, claims.deviceId);
  assert.equal(graceDays, 14);

  // 客户端视角：只拿 JWKS 公钥
  const jwks = licences.jwks();
  assert.equal(jwks.keys.length, 1);
  assert.equal((jwks.keys[0] as Record<string, unknown>).d, undefined, 'JWKS 不得含私钥');
  const pub = await importJWK(jwks.keys[0], 'ES256');
  const { payload, protectedHeader } = await jwtVerify(licence, pub, { currentDate: clock.now(), algorithms: ['ES256'] });
  assert.equal(protectedHeader.kid, cfg.licenceKeyId);
  assert.equal(payload.sub, r.account.id);
  assert.equal(payload.did, r.device!.id);
  assert.equal(payload.graceDays, 14);
  assert.ok((payload.entitlements as string[]).includes('pro-models'));
  assert.ok(payload.exp! > Math.floor(clock.now().getTime() / 1000));

  // 篡改 payload（提权/延期）
  const [h, p, s] = licence.split('.');
  const forged = { ...JSON.parse(Buffer.from(p, 'base64url').toString()), exp: 4102444800, plan: 'enterprise' };
  const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
  await assert.rejects(jwtVerify(tampered, pub, { currentDate: clock.now() }));
  // 他人密钥签发的令牌
  const evil = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const fake = await new SignJWT({ entitlements: ['x'] }).setProtectedHeader({ alg: 'ES256' })
    .setExpirationTime('1h').sign(evil);
  await assert.rejects(jwtVerify(fake, pub));
  // alg=none / 过期
  await assert.rejects(licences.verify(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`));
  clock.advance(8 * 86400_000);
  await assert.rejects(licences.verify(licence));
  await licences.verify(licence, { ignoreExpiry: true }); // 宽限期由客户端判断
});

test('许可证续期需要有效设备；吊销设备后拒绝', async () => {
  const { auth, licences, devices, tokens } = await setup();
  const invite = await auth.createInvite('admin');
  const noDev = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' });
  const c0 = await tokens.verifyAccess(noDev.accessToken);
  await rejects(licences.renew(c0.accountId, c0.deviceId), 'device_required');
  const d = await devices.register(c0.accountId, dev);
  await licences.renew(c0.accountId, d.id);
  await devices.revoke(c0.accountId, d.id);
  await rejects(licences.renew(c0.accountId, d.id), 'device_revoked');
  // 别人的设备
  const i2 = await auth.createInvite('admin');
  const other = await auth.activate({ inviteCode: i2.code, email: 'b@x.com', password: 'password1' });
  await rejects(licences.renew(other.account.id, d.id), 'device_required');
});

test('访问令牌：篡改/他人密钥签名被拒', async () => {
  const { auth, tokens } = await setup();
  const invite = await auth.createInvite('admin');
  const r = await auth.activate({ inviteCode: invite.code, email: 'a@x.com', password: 'password1' });
  await tokens.verifyAccess(r.accessToken);
  await rejects(tokens.verifyAccess(r.accessToken + 'x'), 'invalid_token');
});
