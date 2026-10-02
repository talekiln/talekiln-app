import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { createAppModule } from '../src/app.module';
import { makeRepos } from './helpers/repos';
import { configureApp } from '../src/http/setup';
import { createProviders } from '../src/payments/registry';
import { SandboxProvider } from '../src/payments/sandbox.provider';
import { loadConfig } from '../src/services/config';
import { PlanService } from '../src/services/plan.service';

const ADMIN = { email: 'ops@example.com', password: 'test-admin-pass-1' };
const USER = { email: 'buyer@example.com', password: 'test-user-pass-1' };

async function boot() {
  const repos = await makeRepos();
  const config = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  await new PlanService(repos).ensureSeeded();
  await repos.accounts.create({ email: ADMIN.email, passwordHash: await bcrypt.hash(ADMIN.password, 4), role: 'ADMIN', plan: 'test' });
  await repos.accounts.create({ email: USER.email, passwordHash: await bcrypt.hash(USER.password, 4), role: 'USER', plan: 'free' });
  await repos.accounts.create({ email: 'other@example.com', passwordHash: await bcrypt.hash(USER.password, 4), role: 'USER', plan: 'free' });
  const app = await NestFactory.create(createAppModule({ repos, config }), { logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const call = async (path: string, o: { token?: string; body?: unknown; method?: string; raw?: string; form?: string } = {}) => {
    const res = await fetch(base + path, {
      method: o.method ?? (o.body !== undefined || o.raw !== undefined || o.form !== undefined ? 'POST' : 'GET'),
      headers: {
        'content-type': o.form !== undefined ? 'application/x-www-form-urlencoded' : 'application/json',
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      body: o.form ?? o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 纯文本应答 */ }
    return { status: res.status, json, text, res };
  };
  const userToken = async (email = USER.email) => (await call('/auth/login', { body: { email, password: USER.password } })).json.accessToken as string;
  const adminToken = async () => (await call('/admin/auth/login', { body: ADMIN })).json.token as string;
  // 与应用内同一密钥派生，用来构造“支付平台发来的”已签名回调
  const sandbox = (name: 'wechat' | 'alipay') =>
    createProviders({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, config.accessSecret).get(name) as SandboxProvider;
  return { repos, call, userToken, adminToken, sandbox, close: () => app.close() };
}

test('HTTP：/plans 公开；下单需登录；回调（重复/伪造）；/subscription；订单隔离', async () => {
  const s = await boot();
  try {
    const plans = await s.call('/plans');
    assert.equal(plans.status, 200);
    assert.deepEqual(plans.json.find((p: any) => p.code === 'pro').prices, { month: 3900, year: 29900 });

    assert.equal((await s.call('/orders', { body: { planCode: 'pro', period: 'month', provider: 'wechat' } })).status, 401);
    assert.equal((await s.call('/subscription')).status, 401);
    const token = await s.userToken();
    assert.equal((await s.call('/subscription', { token })).json.plan, 'free');
    assert.equal((await s.call('/orders', { token, body: { planCode: 'pro', period: 'day', provider: 'wechat' } })).status, 400);

    const created = await s.call('/orders', { token, body: { planCode: 'pro', period: 'month', provider: 'wechat' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.amountCents, 3900);
    assert.match(created.json.codeUrl, /^sandbox:\/\/wechat\//);
    const orderId = created.json.id as string;
    const outTradeNo = created.json.outTradeNo as string;

    // 伪造的回调：验签失败 -> 400 + 微信格式应答，不开通
    const forged = { ...s.sandbox('wechat').buildNotify({ outTradeNo, amountCents: 3900 }), amount_cents: 1 };
    const bad = await s.call('/payments/notify/wechat', { body: forged });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'FAIL');
    assert.equal((await s.call('/subscription', { token })).json.plan, 'free');

    // 真实回调：重复投递两次，都应答 SUCCESS，只生效一次
    const good = s.sandbox('wechat').buildNotify({ outTradeNo, amountCents: 3900 });
    const r1 = await s.call('/payments/notify/wechat', { body: good });
    const r2 = await s.call('/payments/notify/wechat', { body: good });
    assert.deepEqual([r1.status, r1.json.code, r2.status, r2.json.code], [200, 'SUCCESS', 200, 'SUCCESS']);
    const sub = await s.call('/subscription', { token });
    assert.equal(sub.json.plan, 'pro');
    assert.equal(sub.json.subscription.active, true);
    assert.equal(sub.json.entitlements.maxDevices, 3);

    assert.equal((await s.call(`/orders/${orderId}`, { token })).json.status, 'PAID');
    assert.equal((await s.call('/orders', { token })).json.length, 1);
    const other = await s.userToken('other@example.com');
    assert.equal((await s.call(`/orders/${orderId}`, { token: other })).status, 404);
    assert.equal((await s.call('/orders', { token: other })).json.length, 0);

    // 支付宝：表单编码的回调也能被解析（沙箱要求字段齐全，这里只验证 form 通路不报 500）
    const ali = await s.call('/payments/notify/alipay', { form: 'notify_id=1&out_trade_no=x' });
    assert.equal(ali.status, 400);
    assert.equal(ali.text, 'fail');
    assert.equal((await s.call('/payments/notify/unionpay', { body: {} })).status, 503);

    // 设备数上限经 HTTP 生效：专业版 3 台，第 4 台 403 device_limit
    for (let i = 1; i <= 3; i++) {
      assert.equal((await s.call('/devices', { token, body: { fingerprint: `fp-device-${i}`, name: `PC${i}` } })).status, 201);
    }
    const fourth = await s.call('/devices', { token, body: { fingerprint: 'fp-device-4', name: 'PC4' } });
    assert.equal(fourth.status, 403);
    assert.equal(fourth.json.error, 'device_limit');
  } finally { await s.close(); }
});

test('HTTP：管理侧订单/退款/发票/套餐接口，需要管理员令牌', async () => {
  const s = await boot();
  try {
    const user = await s.userToken();
    for (const path of ['/admin/orders', '/admin/refunds', '/admin/invoices', '/admin/plans']) {
      assert.equal((await s.call(path)).status, 401, path);
      assert.equal((await s.call(path, { token: user })).status, 401, `${path} 用户令牌不可用`);
    }
    const admin = await s.adminToken();
    const o = (await s.call('/orders', { token: user, body: { planCode: 'pro', period: 'year', provider: 'alipay' } })).json;
    await s.call('/payments/notify/alipay', { body: s.sandbox('alipay').buildNotify({ outTradeNo: o.outTradeNo, amountCents: 29900 }) });

    const list = await s.call('/admin/orders?status=PAID', { token: admin });
    assert.equal(list.json.length, 1);
    assert.equal((await s.call('/admin/orders?status=BOGUS', { token: admin })).status, 400);
    const detail = await s.call(`/admin/orders/${o.id}`, { token: admin });
    assert.equal(detail.json.payment.amountCents, 29900);
    assert.equal(detail.json.planCode, 'pro');
    assert.equal(detail.json.refundQuote.refundCents, 29900);

    // 用户申请开票，管理员开具
    const inv = await s.call(`/orders/${o.id}/invoice`, { token: user, body: { title: '某某公司', email: 'fin@x.com' } });
    assert.equal(inv.status, 201);
    assert.equal((await s.call('/admin/invoices?status=REQUESTED', { token: admin })).json.length, 1);
    assert.equal((await s.call(`/admin/invoices/${inv.json.id}/issue`, { token: admin, body: { invoiceNo: 'FP-1' } })).json.status, 'ISSUED');
    // 已开具的发票阻止退款，作废后可退
    assert.equal((await s.call(`/admin/orders/${o.id}/refund`, { token: admin, body: {} })).status, 409);
    assert.equal((await s.call(`/admin/invoices/${inv.json.id}/void`, { token: admin, body: {} })).json.status, 'VOID');
    const refund = await s.call(`/admin/orders/${o.id}/refund`, { token: admin, body: { reason: '测试退款' } });
    assert.equal(refund.status, 200);
    assert.equal(refund.json.refund.status, 'SUCCESS');
    assert.ok(refund.json.refund.amountCents > 29000 && refund.json.refund.amountCents <= 29900);
    assert.equal((await s.call('/admin/refunds', { token: admin })).json.length, 1);
    assert.equal((await s.call('/subscription', { token: user })).json.plan, 'free');

    // 套餐：新增版本即改价；非法价格被拒；上下架
    const bad = await s.call('/admin/plans/pro/versions', {
      token: admin, body: { priceMonthCents: 0, priceYearCents: 1, entitlements: { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: [] } },
    });
    assert.equal(bad.status, 400);
    const v2 = await s.call('/admin/plans/pro/versions', {
      token: admin, body: { priceMonthCents: 4900, priceYearCents: 39900, entitlements: { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['generate'] } },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.json.version, 2);
    assert.equal((await s.call('/plans')).json.find((p: any) => p.code === 'pro').prices.month, 4900);
    assert.equal((await s.call('/admin/plans/nope/versions', { token: admin, body: v2.json })).status, 404);
    assert.equal((await s.call('/admin/plans/pro/enabled', { token: admin, method: 'PUT', body: { enabled: false } })).status, 204);
    assert.equal((await s.call('/plans')).json.some((p: any) => p.code === 'pro'), false);
  } finally { await s.close(); }
});
