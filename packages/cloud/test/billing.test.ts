import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepos } from './helpers/repos';
import { createProviders } from '../src/payments/registry';
import { SandboxProvider } from '../src/payments/sandbox.provider';
import { AuthService } from '../src/services/auth.service';
import { DAY_MS } from '../src/services/billing-math';
import { defaultPlanSeeds } from '../src/services/billing.config';
import { BillingService } from '../src/services/billing.service';
import { loadConfig } from '../src/services/config';
import { DeviceService } from '../src/services/device.service';
import { EntitlementService } from '../src/services/entitlement.service';
import { ServiceError } from '../src/services/errors';
import { LicenceService } from '../src/services/licence.service';
import { PlanService } from '../src/services/plan.service';
import { TokenService } from '../src/services/token.service';
import type { OrderRecord } from '../src/domain/repositories';

const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e) => e instanceof ServiceError && e.code === code, `expected ServiceError(${code})`);

async function setup(opts: { seeds?: ReturnType<typeof defaultPlanSeeds>; env?: Record<string, string> } = {}) {
  const repos = await makeRepos();
  let t = Date.parse('2026-10-01T00:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; }, set: (iso: string) => { t = Date.parse(iso); } };
  const cfg = loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(40), NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const providers = createProviders({ NODE_ENV: 'test', ...opts.env } as NodeJS.ProcessEnv, cfg.accessSecret, clock.now);
  const plans = new PlanService(repos);
  await plans.ensureSeeded(opts.seeds);
  const ent = new EntitlementService(repos, clock.now);
  const billing = new BillingService(repos, providers, { notifyBaseUrl: 'https://pay.example.test', orderTtlMinutes: 30 }, clock.now, ent);
  const devices = new DeviceService(repos, clock.now, ent);
  const tokens = new TokenService(repos, cfg, clock.now);
  const auth = new AuthService(repos, tokens, clock.now, 4, devices);
  const licences = new LicenceService(repos, cfg, clock.now, ent);
  const wechat = providers.names().includes('wechat') ? (providers.get('wechat') as SandboxProvider) : (null as never);
  const alipay = providers.names().includes('alipay') ? (providers.get('alipay') as SandboxProvider) : (null as never);
  let n = 0;
  const user = (plan = 'free') => repos.accounts.create({ email: `u${++n}@x.com`, passwordHash: 'h', role: 'USER', plan });
  const buy = async (accountId: string, o: { period?: 'month' | 'year'; provider?: 'wechat' | 'alipay'; planCode?: string } = {}) =>
    billing.createOrder(accountId, { planCode: o.planCode ?? 'pro', period: o.period ?? 'month', provider: o.provider ?? 'wechat' });
  const notifyOf = (o: OrderRecord, extra: Partial<Parameters<SandboxProvider['buildNotify']>[0]> = {}) =>
    ((o.provider === 'wechat' ? wechat : alipay).buildNotify({ outTradeNo: o.outTradeNo, amountCents: o.amountCents, ...extra }));
  const send = (o: OrderRecord, body: unknown, provider = o.provider) => billing.handleNotify(provider, { headers: {}, rawBody: JSON.stringify(body), body });
  const pay = (o: OrderRecord) => {
    const p = o.provider === 'wechat' ? wechat : alipay;
    return send(o, p.simulatePay(o.outTradeNo));
  };
  return { repos, clock, cfg, providers, plans, ent, billing, devices, tokens, auth, licences, wechat, alipay, user, buy, notifyOf, send, pay };
}

test('套餐：播种幂等，价格与权益来自数据库，可用环境变量覆盖初始价', async () => {
  const s = await setup();
  await s.plans.ensureSeeded();
  const pub = await s.plans.listPublic();
  assert.deepEqual(pub.map((p) => p.code).sort(), ['free', 'pro']);
  const pro = pub.find((p) => p.code === 'pro')!;
  assert.deepEqual(pro.prices, { month: 3900, year: 29900 });
  assert.equal(pro.entitlements.maxDevices, 3);
  assert.equal(pro.entitlements.watermark, false);
  const free = pub.find((p) => p.code === 'free')!;
  assert.deepEqual(free.prices, { month: null, year: null });
  assert.deepEqual([free.entitlements.maxDevices, free.entitlements.exportMaxHeight, free.entitlements.watermark], [1, 720, true]);
  assert.equal((await s.repos.plans.list()).every((x) => x.versions.length === 1), true, '重复播种不产生新版本');

  const s2 = await setup({ seeds: defaultPlanSeeds({ PLAN_PRO_PRICE_MONTH_CENTS: '4900' } as NodeJS.ProcessEnv) });
  assert.equal((await s2.plans.listPublic()).find((p) => p.code === 'pro')!.prices.month, 4900);
  assert.throws(() => defaultPlanSeeds({ PLAN_PRO_PRICE_MONTH_CENTS: '39.5' } as NodeJS.ProcessEnv));
});

test('改价 = 新版本：老订单金额不变，新订单用新价；套餐可下架', async () => {
  const s = await setup();
  const a = await s.user();
  const o1 = await s.buy(a.id);
  assert.equal(o1.amountCents, 3900);
  await s.plans.addVersion('pro', {
    priceMonthCents: 4900, priceYearCents: 29900,
    entitlements: { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['generate'] },
  });
  const o2 = await s.buy(a.id);
  assert.equal(o2.amountCents, 4900);
  assert.equal((await s.repos.orders.findById(o1.id))!.amountCents, 3900);
  assert.notEqual(o1.planVersionId, o2.planVersionId);
  const y = await s.buy(a.id, { period: 'year', provider: 'alipay' });
  assert.equal(y.amountCents, 29900);
  await s.plans.setEnabled('pro', false);
  await rejects(s.buy(a.id), 'not_found');
  assert.deepEqual((await s.plans.listPublic()).map((p) => p.code), ['free']);
});

test('下单：免费套餐/未知套餐/渠道未启用/下游失败', async () => {
  const s = await setup();
  const a = await s.user();
  await rejects(s.buy(a.id, { planCode: 'free' }), 'bad_request');
  await rejects(s.buy(a.id, { planCode: 'nope' }), 'not_found');
  await assert.rejects(s.billing.createOrder(a.id, { planCode: 'pro', period: 'week', provider: 'wechat' }));
  const o = await s.buy(a.id);
  assert.equal(o.status, 'PENDING');
  assert.match(o.outTradeNo, /^TK\d{14}[0-9a-f]{10}$/);
  assert.match(o.codeUrl!, /^sandbox:\/\/wechat\/pay\?/);
  assert.equal(o.expiresAt.getTime() - o.createdAt.getTime(), 30 * 60_000);
  await s.repos.accounts.setDisabled(a.id, s.clock.now());
  await rejects(s.buy(a.id), 'account_disabled');

  // 生产默认不启用任何渠道；live 为未实现占位，下单明确失败并关单
  const none = await setup({ env: { NODE_ENV: 'production' } });
  await rejects(none.buy((await none.user()).id), 'provider_unavailable');
  const live = await setup({ env: { PAYMENT_MODE: 'live' } });
  const u = await live.user();
  await rejects(live.buy(u.id), 'provider_unavailable');
  assert.equal((await live.repos.orders.listByAccount(u.id))[0].status, 'CLOSED');
  assert.throws(() => createProviders({ NODE_ENV: 'production', PAYMENT_MODE: 'sandbox' } as NodeJS.ProcessEnv, 'x'.repeat(32)));
});

test('支付回调：开通订阅、权益变专业版、应答格式', async () => {
  const s = await setup();
  const a = await s.user();
  assert.equal((await s.ent.resolve(a.id)).planCode, 'free');
  const o = await s.buy(a.id);
  const r = await s.pay(o);
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(JSON.parse(r.ack.body), { code: 'SUCCESS', message: 'OK' });
  assert.equal(r.ack.status, 200);
  const paid = (await s.repos.orders.findById(o.id))!;
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.periodEnd!.toISOString(), '2026-11-01T00:00:00.000Z');
  const sub = await s.billing.subscription(a.id);
  assert.equal(sub.plan, 'pro');
  assert.equal(sub.source, 'subscription');
  assert.equal(sub.subscription!.active, true);
  assert.equal(sub.entitlements.maxDevices, 3);
  // 支付宝应答是纯文本 success
  const o2 = await s.buy((await s.user()).id, { provider: 'alipay', period: 'year' });
  const r2 = await s.pay(o2);
  assert.equal(r2.ack.body, 'success');
  assert.equal((await s.repos.orders.findById(o2.id))!.periodEnd!.toISOString(), '2027-10-01T00:00:00.000Z');
});

test('重复回调幂等：同一回调到达多次，只生效一次', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  const body = s.wechat.simulatePay(o.outTradeNo);
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) outcomes.push((await s.send(o, body)).outcome);
  assert.deepEqual(outcomes, ['applied', 'duplicate_notify', 'duplicate_notify', 'duplicate_notify', 'duplicate_notify']);
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal((await s.repos.orders.findPayment(o.id))!.amountCents, 3900);
  // 平台换一个通知 id 重发同一笔交易：订单已结算，也不重复生效
  const again = await s.send(o, s.notifyOf(o, { notifyId: 'other-notify-id', tradeNo: body.trade_no }));
  assert.equal(again.outcome, 'already_settled');
  assert.equal(again.ack.status, 200);
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('并发回调：12 路同时到达只生效一次（同 id 与不同 id 两种）', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  const body = s.wechat.simulatePay(o.outTradeNo);
  const rs = await Promise.all(Array.from({ length: 12 }, () => s.send(o, body)));
  assert.equal(rs.filter((r) => r.outcome === 'applied').length, 1);
  assert.ok(rs.every((r) => r.ack.status === 200));
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');

  const b = await s.user();
  const o2 = await s.buy(b.id);
  const rs2 = await Promise.all(Array.from({ length: 12 }, (_, i) => s.send(o2, s.notifyOf(o2, { notifyId: `nid-${i}` }))));
  assert.equal(rs2.filter((r) => r.outcome === 'applied').length, 1);
  assert.equal(rs2.filter((r) => r.outcome === 'already_settled').length, 11);
  assert.equal((await s.repos.subscriptions.findByAccount(b.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('回调校验：验签、金额、渠道、未知订单、非成功状态', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  const good = s.notifyOf(o);
  const status = async () => (await s.repos.orders.findById(o.id))!.status;

  const tampered = { ...good, amount_cents: 1 };
  const r1 = await s.send(o, tampered);
  assert.deepEqual([r1.outcome, r1.ack.status], ['rejected', 400]);
  assert.equal(await status(), 'PENDING');
  assert.equal((await s.send(o, { ...good, sign: '0'.repeat(64) })).outcome, 'rejected');
  assert.equal((await s.send(o, { ...good, sign: undefined })).outcome, 'rejected');
  assert.equal((await s.send(o, 'garbage')).outcome, 'rejected');
  // 用支付宝沙箱的合法签名投给微信渠道：签名里带渠道名，不能互相冒充
  const crossed = s.alipay.buildNotify({ outTradeNo: o.outTradeNo, amountCents: o.amountCents });
  assert.equal((await s.send(o, crossed, 'wechat')).outcome, 'rejected');
  // 签名正确但金额与订单不符
  const wrongAmount = s.wechat.buildNotify({ outTradeNo: o.outTradeNo, amountCents: 100 });
  assert.equal((await s.send(o, wrongAmount)).outcome, 'rejected');
  // 渠道对不上：订单是微信下的，却由支付宝渠道（合法签名）通知
  assert.equal((await s.send(o, crossed, 'alipay')).outcome, 'rejected');
  // 未知订单
  assert.equal((await s.send(o, s.wechat.buildNotify({ outTradeNo: 'TK-UNKNOWN', amountCents: 3900 }))).outcome, 'rejected');
  // 非成功状态：应答成功但不开通
  const failed = await s.send(o, s.notifyOf(o, { status: 'FAILED' }));
  assert.deepEqual([failed.outcome, failed.ack.status], ['ignored', 200]);
  assert.equal(await status(), 'PENDING');
  assert.equal(await s.repos.subscriptions.findByAccount(a.id), null);
  await rejects(Promise.resolve().then(() => s.billing.handleNotify('unionpay', { headers: {}, rawBody: '', body: {} })), 'provider_unavailable');
  // 真正的回调仍然可以生效
  assert.equal((await s.send(o, good)).outcome, 'applied');
});

test('续期顺延、过期降级为免费版', async () => {
  const s = await setup();
  const a = await s.user();
  await s.pay(await s.buy(a.id)); // 10-01 付款，到 11-01
  s.clock.advance(10 * DAY_MS);
  const renew = await s.buy(a.id);
  await s.pay(renew);
  const sub = (await s.repos.subscriptions.findByAccount(a.id))!;
  assert.equal(sub.currentPeriodStart.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(sub.currentPeriodEnd.toISOString(), '2026-12-01T00:00:00.000Z', '续期顺延，不吃掉剩余天数');
  assert.equal((await s.repos.orders.findById(renew.id))!.periodStart!.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro');

  // 到期瞬间即失效
  s.clock.set('2026-12-01T00:00:00Z');
  const eff = await s.ent.resolve(a.id);
  assert.deepEqual([eff.planCode, eff.source, eff.entitlements.maxDevices, eff.entitlements.watermark], ['free', 'free', 1, true]);
  const view = await s.billing.subscription(a.id);
  assert.equal(view.subscription!.active, false);
  s.clock.set('2026-11-30T23:59:59Z');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro');

  // 过期后重新购买：从付款时刻起算
  s.clock.set('2027-02-10T12:00:00Z');
  await s.pay(await s.buy(a.id));
  const sub2 = (await s.repos.subscriptions.findByAccount(a.id))!;
  assert.equal(sub2.currentPeriodStart.toISOString(), '2027-02-10T12:00:00.000Z');
  assert.equal(sub2.currentPeriodEnd.toISOString(), '2027-03-10T12:00:00.000Z');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro');
});

test('超时未付的订单：查询时关闭；迟到的付款仍然生效', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  s.clock.advance(31 * 60_000);
  assert.equal((await s.billing.getOrder(a.id, o.id)).status, 'CLOSED');
  const r = await s.send(o, s.wechat.simulatePay(o.outTradeNo));
  assert.equal(r.outcome, 'applied');
  assert.equal((await s.billing.getOrder(a.id, o.id)).status, 'PAID');
  await rejects(s.billing.getOrder((await s.user()).id, o.id), 'not_found');
});

test('主动查单兜底：回调丢失时轮询订单也能开通，随后到达的回调不重复生效', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  assert.equal((await s.billing.getOrder(a.id, o.id)).status, 'PENDING');
  const body = s.wechat.simulatePay(o.outTradeNo); // 用户付了款，但回调还没到
  const polled = await s.billing.getOrder(a.id, o.id);
  assert.equal(polled.status, 'PAID');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro');
  const late = await s.send(o, body);
  assert.equal(late.outcome, 'already_settled');
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal((await s.billing.listOrders(a.id)).length, 1);
});

test('退款折算：按剩余天数，整数分，订阅同步缩短', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  await s.pay(o);
  s.clock.advance(10 * DAY_MS); // 用了 10 天，剩 21 天：floor(3900*21/31) = 2641
  const detail = await s.billing.orderDetail(o.id);
  assert.equal(detail.refundQuote!.refundCents, 2641);
  const r = await s.billing.refundOrder('admin-1', o.id, '用户申请');
  assert.equal(r.refund.amountCents, 2641);
  assert.equal(r.refund.status, 'SUCCESS');
  assert.equal(r.refund.createdBy, 'admin-1');
  assert.equal(r.quote.remainingDays, 21);
  assert.equal(s.wechat.refundedCents(o.outTradeNo), 2641);
  assert.equal((await s.repos.orders.findById(o.id))!.status, 'REFUNDED');
  assert.equal(r.subscription!.currentPeriodEnd.toISOString(), '2026-10-11T00:00:00.000Z');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'free');
  await rejects(s.billing.refundOrder('admin-1', o.id), 'conflict');
  assert.equal((await s.billing.listRefunds()).length, 1);
  await rejects(s.billing.refundOrder('admin-1', 'no-such-order'), 'not_found');
});

test('退款边界：付款当天全额、最后一天、到期后不可退、未支付不可退', async () => {
  const s = await setup();
  const a = await s.user();
  const o1 = await s.buy(a.id);
  await rejects(s.billing.refundOrder('adm', o1.id), 'conflict'); // 未支付
  await s.pay(o1);
  s.clock.advance(60 * 60_000); // 付款 1 小时后：全额
  assert.equal((await s.billing.refundOrder('adm', o1.id)).refund.amountCents, 3900);

  const o2 = await s.buy(a.id);
  await s.pay(o2);
  s.clock.advance(31 * DAY_MS - 1000); // 剩 1 秒：按 1 天算 floor(3900/31)=125
  assert.equal((await s.billing.refundOrder('adm', o2.id)).refund.amountCents, 125);

  const o3 = await s.buy(a.id);
  await s.pay(o3);
  s.clock.advance(30 * DAY_MS); // 本单区间 11-01 ~ 12-01 共 30 天，恰好到期：0
  await rejects(s.billing.refundOrder('adm', o3.id), 'conflict');
  assert.equal((await s.repos.orders.findById(o3.id))!.status, 'PAID', '拒绝后状态不变');
});

test('退款：未开始的续期单整单可退，且只回退该单的时长', async () => {
  const s = await setup();
  const a = await s.user();
  const o1 = await s.buy(a.id);
  await s.pay(o1); // 10-01 ~ 11-01
  s.clock.advance(5 * DAY_MS);
  const o2 = await s.buy(a.id, { period: 'year', provider: 'alipay' });
  await s.pay(o2); // 11-01 ~ 2027-11-01
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2027-11-01T00:00:00.000Z');
  const r = await s.billing.refundOrder('adm', o2.id);
  assert.equal(r.refund.amountCents, 29900);
  assert.equal(s.alipay.refundedCents(o2.outTradeNo), 29900);
  assert.equal((await s.repos.subscriptions.findByAccount(a.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro', '第一单仍在有效期内');
});

test('退款失败回滚、可重试；并发退款只成功一次', async () => {
  const s = await setup();
  const a = await s.user();
  const o = await s.buy(a.id);
  await s.pay(o);
  s.clock.advance(DAY_MS);
  s.wechat.failNextRefund('channel error');
  await rejects(s.billing.refundOrder('adm', o.id), 'provider_unavailable');
  s.clock.advance(1000); // 两次退款单的创建时间可区分，列表顺序确定
  assert.equal((await s.repos.orders.findById(o.id))!.status, 'PAID');
  const [failed] = await s.repos.refunds.listByOrder(o.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureReason, 'channel error');
  assert.equal((await s.ent.resolve(a.id)).planCode, 'pro', '失败不影响权益');

  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => s.billing.refundOrder('adm', o.id)));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.wechat.refundedCents(o.outTradeNo), 3774, '渠道侧只退了一次');
  const all = await s.repos.refunds.listByOrder(o.id);
  assert.deepEqual(all.map((r) => r.status), ['FAILED', 'SUCCESS']);
  assert.notEqual(all[0].outRefundNo, all[1].outRefundNo);
});

test('发票：申请 -> 开具；每单一张；未付款/他人订单不可开；已开具须先作废才能退款', async () => {
  const s = await setup();
  const a = await s.user();
  const b = await s.user();
  const o = await s.buy(a.id);
  const info = { title: '某某科技有限公司', taxNo: '91310000XXXXXXXXXX', email: 'fin@x.com' };
  await rejects(s.billing.requestInvoice(a.id, o.id, info), 'conflict'); // 未付款
  await s.pay(o);
  await rejects(s.billing.requestInvoice(b.id, o.id, info), 'not_found');
  await assert.rejects(s.billing.requestInvoice(a.id, o.id, { title: '', email: 'bad' }));
  const inv = await s.billing.requestInvoice(a.id, o.id, info);
  assert.equal(inv.status, 'REQUESTED');
  assert.equal(inv.amountCents, 3900);
  await rejects(s.billing.requestInvoice(a.id, o.id, info), 'conflict');
  await rejects(s.billing.registerInvoice(o.id, { ...info }), 'conflict');
  assert.equal((await s.billing.listInvoices('REQUESTED')).length, 1);

  const issued = await s.billing.issueInvoice(inv.id, 'FP-2026-0001');
  assert.deepEqual([issued.status, issued.invoiceNo], ['ISSUED', 'FP-2026-0001']);
  await rejects(s.billing.issueInvoice(inv.id, 'FP-2'), 'conflict');
  await rejects(s.billing.issueInvoice('00000000-0000-0000-0000-000000000000', 'X'), 'not_found');
  await assert.rejects(s.billing.issueInvoice(inv.id, ''));

  s.clock.advance(DAY_MS);
  await rejects(s.billing.refundOrder('adm', o.id), 'conflict'); // 已开发票，先作废（人工红冲）
  assert.equal((await s.billing.voidInvoice(inv.id)).status, 'VOID');
  await rejects(s.billing.voidInvoice(inv.id), 'conflict');
  assert.equal((await s.billing.refundOrder('adm', o.id)).refund.status, 'SUCCESS');
  assert.equal((await s.billing.orderDetail(o.id)).invoice!.status, 'VOID');

  // 管理员直接登记（带发票号即已开具）；已退款订单不可开票
  const o2 = await s.buy(b.id);
  await s.pay(o2);
  const direct = await s.billing.registerInvoice(o2.id, { ...info, invoiceNo: 'FP-2026-0002' });
  assert.deepEqual([direct.status, direct.invoiceNo], ['ISSUED', 'FP-2026-0002']);
  const o3 = await s.buy(b.id);
  await s.pay(o3);
  await s.billing.refundOrder('adm', o3.id);
  await rejects(s.billing.registerInvoice(o3.id, info), 'conflict');
});

test('设备数上限：免费 1 台 / 专业 3 台；重复登录不占名额；吊销释放；并发不超限', async () => {
  const s = await setup();
  const a = await s.user();
  const dev = (i: number) => ({ fingerprint: `fp-device-${i}`, name: `PC ${i}` });
  const d1 = await s.devices.register(a.id, dev(1));
  await s.devices.register(a.id, dev(1)); // 同一台再次登录
  await rejects(s.devices.register(a.id, dev(2)), 'device_limit');
  // 登录路径同样受限（密码哈希在测试里是占位，直接走服务的设备注册）
  await rejects(s.devices.register(a.id, dev(3)), 'device_limit');

  await s.pay(await s.buy(a.id));
  await s.devices.register(a.id, dev(2));
  await s.devices.register(a.id, dev(3));
  await rejects(s.devices.register(a.id, dev(4)), 'device_limit');
  await s.devices.revoke(a.id, d1.id);
  await s.devices.register(a.id, dev(4));
  await rejects(s.devices.register(a.id, dev(1)), 'device_revoked');

  const b = await s.user();
  const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => s.devices.register(b.id, dev(i))));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(rs.filter((r) => r.status === 'rejected' && (r.reason as ServiceError).code === 'device_limit').length, 5);
  assert.equal((await s.repos.devices.listByAccount(b.id)).length, 1);
});

test('设备数上限：登录与激活走同一上限', async () => {
  const s = await setup();
  const hash = await s.auth.hash('password1');
  const acct = await s.repos.accounts.create({ email: 'lim@x.com', passwordHash: hash, role: 'USER', plan: 'free' });
  const r1 = await s.auth.login({ email: 'lim@x.com', password: 'password1', device: { fingerprint: 'fp-aaaaaaaa', name: 'A' } });
  assert.ok(r1.device);
  await s.auth.login({ email: 'lim@x.com', password: 'password1', device: { fingerprint: 'fp-aaaaaaaa', name: 'A' } });
  await rejects(s.auth.login({ email: 'lim@x.com', password: 'password1', device: { fingerprint: 'fp-bbbbbbbb', name: 'B' } }), 'device_limit');
  assert.equal((await s.repos.devices.listByAccount(acct.id)).length, 1);
  // 不带设备信息的登录不受影响
  assert.ok((await s.auth.login({ email: 'lim@x.com', password: 'password1' })).accessToken);
});

test('许可证令牌带当前权益：免费 / 专业 / 内测账号；记录用量', async () => {
  const s = await setup();
  const a = await s.user();
  const d = await s.devices.register(a.id, { fingerprint: 'fp-12345678', name: 'PC' });

  const free = await s.licences.verify((await s.licences.renew(a.id, d.id)).licence);
  s.clock.advance(1000); // 三条用量记录的签发时间可区分
  assert.equal(free.plan, 'free');
  assert.deepEqual(free.limits, { maxDevices: 1, exportMaxHeight: 720, watermark: true });
  assert.deepEqual(free.entitlements, ['generate', 'export']);
  assert.equal(free.subEnd, null);

  await s.pay(await s.buy(a.id));
  const pro = await s.licences.verify((await s.licences.renew(a.id, d.id)).licence);
  assert.equal(pro.plan, 'pro');
  assert.deepEqual(pro.limits, { maxDevices: 3, exportMaxHeight: 2160, watermark: false });
  assert.ok(pro.entitlements.includes('pro-models'));
  assert.equal(pro.subEnd, Date.parse('2026-11-01T00:00:01Z') / 1000);

  // 到期后回到免费版权益
  s.clock.set('2026-11-02T00:00:00Z');
  const after = await s.licences.verify((await s.licences.renew(a.id, d.id)).licence);
  assert.equal(after.plan, 'free');
  assert.equal(after.limits.watermark, true);

  assert.equal(await s.repos.licenceUsage.countByAccount(a.id), 3);
  assert.deepEqual((await s.repos.licenceUsage.listByAccount(a.id, 5)).map((u) => u.planCode), ['free', 'pro', 'free']);

  // 邀请码内测账号（plan = test）保持旧行为：全部功能
  const t = await s.user('test');
  const td = await s.devices.register(t.id, { fingerprint: 'fp-87654321', name: 'PC' });
  const legacy = await s.licences.verify((await s.licences.renew(t.id, td.id)).licence);
  assert.equal(legacy.plan, 'test');
  assert.deepEqual(legacy.entitlements, ['generate', 'export', 'cloud-sync', 'batch', 'pro-models']);
  assert.equal(legacy.limits.watermark, false);
});

test('降级后设备超限：只有最早注册的设备能续期许可证', async () => {
  const s = await setup();
  const a = await s.user();
  await s.pay(await s.buy(a.id));
  const ds = [];
  for (let i = 1; i <= 3; i++) {
    ds.push(await s.devices.register(a.id, { fingerprint: `fp-device-${i}`, name: `PC${i}` }));
    s.clock.advance(1000);
    // 内存/PG 的 createdAt 取真实时钟；这里保证先后顺序可区分
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok((await s.licences.renew(a.id, ds[2].id)).licence);
  s.clock.set('2026-12-01T00:00:00Z'); // 订阅过期 -> 免费 1 台
  assert.ok((await s.licences.renew(a.id, ds[0].id)).licence);
  await rejects(s.licences.renew(a.id, ds[1].id), 'device_limit');
  await rejects(s.licences.renew(a.id, ds[2].id), 'device_limit');
  await s.devices.revoke(a.id, ds[0].id);
  assert.ok((await s.licences.renew(a.id, ds[1].id)).licence, '吊销最早的设备后，次早的设备顶上');
});
