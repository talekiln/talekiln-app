import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepos } from './helpers/repos';
import { computePeriod } from '../src/services/billing-math';
import type { BillingPeriod, Entitlements, Repositories, SettleInput } from '../src/domain/repositories';

// 收费仓储契约：内存与 Prisma(PostgreSQL) 必须表现一致。设置 TEST_DATABASE_URL/DATABASE_URL 时跑真实库。
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
const ENT: Entitlements = { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['generate', 'export'] };

async function base(r: Repositories) {
  const account = await r.accounts.create({ email: 'a@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  const plan = await r.plans.create({ code: 'pro', name: '专业版' });
  const version = await r.plans.addVersion(plan.id, { priceMonthCents: 3900, priceYearCents: 29900, entitlements: ENT });
  let n = 0;
  const order = async (period: BillingPeriod = 'MONTH', amountCents = 3900, accountId = account.id) =>
    r.orders.create({
      outTradeNo: `TKTEST${++n}`, accountId, planVersionId: version.id, period, amountCents,
      provider: 'wechat', createdAt: at(0), expiresAt: at(30 * 60_000),
    });
  const settle = (o: { outTradeNo: string; amountCents: number }, extra: Partial<SettleInput> = {}) =>
    r.billing.settlePaid({
      provider: 'wechat', notifyId: `n-${o.outTradeNo}`, outTradeNo: o.outTradeNo, tradeNo: `t-${o.outTradeNo}`,
      amountCents: o.amountCents, paidAt: at(1000),
      periodFor: (cur, ord) => computePeriod(cur, extra.paidAt ?? at(1000), ord.period), ...extra,
    });
  return { account, plan, version, order, settle };
}

test('仓储契约：套餐版本号递增、代码唯一、权益 JSON 往返', async () => {
  const r = await makeRepos();
  const { plan, version } = await base(r);
  assert.equal(version.version, 1);
  assert.equal(version.planCode, 'pro');
  assert.deepEqual(version.entitlements, ENT);
  await assert.rejects(r.plans.create({ code: 'pro', name: 'dup' }));
  const v2 = await r.plans.addVersion(plan.id, { priceMonthCents: 4900, priceYearCents: null, entitlements: { ...ENT, maxDevices: 5 } });
  assert.equal(v2.version, 2);
  assert.equal((await r.plans.latestVersion(plan.id))!.id, v2.id);
  assert.equal((await r.plans.findVersion(version.id))!.priceMonthCents, 3900, '老版本价格不变');
  assert.equal((await r.plans.findVersion(v2.id))!.priceYearCents, null);
  const all = await r.plans.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].versions.map((v) => v.version), [1, 2]);
  assert.equal(await r.plans.setEnabled('pro', false), true);
  assert.equal((await r.plans.findByCode('pro'))!.enabled, false);
  assert.equal(await r.plans.setEnabled('nope', true), false);
});

test('仓储契约：订单唯一、关闭只对 PENDING、过滤', async () => {
  const r = await makeRepos();
  const { order, account } = await base(r);
  const o1 = await order();
  await assert.rejects(r.orders.create({ ...o1, outTradeNo: o1.outTradeNo }));
  assert.equal(o1.status, 'PENDING');
  await r.orders.setCodeUrl(o1.id, 'sandbox://x');
  assert.equal((await r.orders.findByOutTradeNo(o1.outTradeNo))!.codeUrl, 'sandbox://x');
  assert.equal(await r.orders.close(o1.id, at(1)), true);
  assert.equal(await r.orders.close(o1.id, at(2)), false);
  const o2 = await order('YEAR', 29900);
  assert.equal((await r.orders.list({ status: 'PENDING', limit: 10 })).length, 1);
  assert.equal((await r.orders.list({ accountId: account.id, limit: 10 })).length, 2);
  assert.equal((await r.orders.listByAccount(account.id)).length, 2);
  assert.equal((await r.orders.findById(o2.id))!.amountCents, 29900);
});

test('仓储契约：settlePaid 生效一次；同回调重放与换 id 重放都不重复生效', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o = await order();
  const first = await settle(o);
  assert.equal(first.outcome, 'applied');
  if (first.outcome !== 'applied') return;
  assert.equal(first.order.status, 'PAID');
  assert.equal(first.order.periodStart!.getTime(), at(1000).getTime());
  assert.equal(first.order.periodEnd!.toISOString(), '2026-11-01T00:00:01.000Z');
  assert.equal(first.subscription.currentPeriodEnd.getTime(), first.order.periodEnd!.getTime());
  assert.equal((await r.orders.findPayment(o.id))!.tradeNo, `t-${o.outTradeNo}`);

  assert.equal((await settle(o)).outcome, 'duplicate_notify');
  const other = await settle(o, { notifyId: 'another-id' });
  assert.equal(other.outcome, 'already_settled');
  assert.equal((await r.subscriptions.findByAccount(account.id))!.currentPeriodEnd.getTime(), first.order.periodEnd!.getTime());
  assert.equal((await settle({ outTradeNo: 'NOPE', amountCents: 1 })).outcome, 'not_found');
});

test('仓储契约：12 路并发同一回调 -> 恰好 1 次生效', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o = await order();
  const rs = await Promise.all(Array.from({ length: 12 }, () => settle(o)));
  assert.equal(rs.filter((x) => x.outcome === 'applied').length, 1);
  assert.equal(rs.filter((x) => x.outcome === 'duplicate_notify').length, 11);
  const sub = (await r.subscriptions.findByAccount(account.id))!;
  assert.equal(sub.currentPeriodEnd.toISOString(), '2026-11-01T00:00:01.000Z', '只续了一个月');
  assert.equal((await r.orders.findById(o.id))!.status, 'PAID');
});

test('仓储契约：12 路并发不同回调 id 同一订单 -> 恰好 1 次生效', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o = await order();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => settle(o, { notifyId: `n${i}` })));
  assert.equal(rs.filter((x) => x.outcome === 'applied').length, 1);
  assert.equal(rs.filter((x) => x.outcome === 'already_settled').length, 11);
  assert.equal((await r.subscriptions.findByAccount(account.id))!.currentPeriodEnd.toISOString(), '2026-11-01T00:00:01.000Z');
});

test('仓储契约：同账号两张订单并发付款 -> 订阅串行顺延两个月，区间首尾相接', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const [o1, o2, o3] = [await order(), await order(), await order()];
  const rs = await Promise.all([settle(o1), settle(o2), settle(o3)]);
  assert.ok(rs.every((x) => x.outcome === 'applied'));
  const sub = (await r.subscriptions.findByAccount(account.id))!;
  assert.equal(sub.currentPeriodEnd.toISOString(), '2027-01-01T00:00:01.000Z');
  assert.equal(sub.currentPeriodStart.getTime(), at(1000).getTime());
  const periods = (await Promise.all([o1, o2, o3].map((o) => r.orders.findById(o.id))))
    .map((o) => [o!.periodStart!.getTime(), o!.periodEnd!.getTime()]).sort((a, b) => a[0] - b[0]);
  assert.equal(periods[0][1], periods[1][0]);
  assert.equal(periods[1][1], periods[2][0]);
});

test('仓储契约：已关闭（超时）的订单迟到付款仍生效；已过期订阅重新付款从付款时刻起', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o1 = await order();
  await r.orders.close(o1.id, at(1));
  assert.equal((await settle(o1)).outcome, 'applied');
  const sub = (await r.subscriptions.findByAccount(account.id))!;
  const late = at(60 * DAY);
  const o2 = await order();
  const r2 = await settle(o2, { paidAt: late });
  assert.equal(r2.outcome, 'applied');
  const sub2 = (await r.subscriptions.findByAccount(account.id))!;
  assert.equal(sub2.currentPeriodStart.getTime(), late.getTime());
  assert.ok(sub2.currentPeriodEnd.getTime() > sub.currentPeriodEnd.getTime());
  assert.equal(sub2.id, sub.id, '同一账号始终只有一条订阅');
});

test('仓储契约：结算整体原子 —— 支付流水号冲突时回调登记也回滚', async () => {
  const r = await makeRepos();
  const { order, settle } = await base(r);
  const o1 = await order();
  const o2 = await order();
  assert.equal((await settle(o1, { tradeNo: 'SAME-TRADE' })).outcome, 'applied');
  await assert.rejects(settle(o2, { tradeNo: 'SAME-TRADE', notifyId: 'n-late' }));
  assert.equal((await r.orders.findById(o2.id))!.status, 'PENDING', '订单没有被半途改掉');
  // 回调登记已回滚：同一个 notifyId 带着正确数据再来，可以正常生效
  assert.equal((await settle(o2, { tradeNo: 'OK-TRADE', notifyId: 'n-late' })).outcome, 'applied');
});

test('仓储契约：退款占位只有一个赢家；失败回滚；成功后订阅前移', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o = await order();
  await settle(o);
  const ref = (n: string) => ({ orderId: o.id, outRefundNo: n, amountCents: 3000, reason: 'r', createdBy: null, now: at(2000) });

  const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => r.billing.beginRefund(ref(`RF-${i}`))));
  const winners = rs.filter((x) => x.status === 'fulfilled' && x.value);
  assert.equal(winners.length, 1);
  assert.equal((await r.orders.findById(o.id))!.status, 'REFUNDING');
  const refund = (winners[0] as PromiseFulfilledResult<{ id: string }>).value;

  assert.equal(await r.billing.failRefund(refund.id, { now: at(3000), reason: 'channel down' }), true);
  assert.equal(await r.billing.failRefund(refund.id, { now: at(3000), reason: 'again' }), false);
  assert.equal((await r.orders.findById(o.id))!.status, 'PAID', '失败后订单回到已付款');
  assert.equal((await r.refunds.findById(refund.id))!.status, 'FAILED');

  const again = (await r.billing.beginRefund(ref('RF-retry')))!;
  assert.ok(again);
  const before = (await r.subscriptions.findByAccount(account.id))!.currentPeriodEnd.getTime();
  const done = (await r.billing.finishRefund(again.id, { providerRefundNo: 'P1', now: at(4000), cutMs: 10 * DAY }))!;
  assert.equal(done.refund.status, 'SUCCESS');
  assert.equal(done.refund.providerRefundNo, 'P1');
  assert.equal(done.subscription!.currentPeriodEnd.getTime(), before - 10 * DAY);
  assert.equal((await r.orders.findById(o.id))!.status, 'REFUNDED');
  assert.equal(await r.billing.finishRefund(again.id, { providerRefundNo: 'P2', now: at(5000), cutMs: 10 * DAY }), null, '不能重复完成');
  assert.equal((await r.subscriptions.findByAccount(account.id))!.currentPeriodEnd.getTime(), before - 10 * DAY);
  assert.equal(await r.billing.beginRefund(ref('RF-after')), null, '已退款订单不能再退');
  assert.equal((await r.refunds.listByOrder(o.id)).length, 2);
  assert.equal((await r.refunds.list(10)).length, 2);
});

test('仓储契约：退款前移不会把到期时间推到当前时刻之前', async () => {
  const r = await makeRepos();
  const { order, settle, account } = await base(r);
  const o = await order();
  await settle(o);
  const b = (await r.billing.beginRefund({ orderId: o.id, outRefundNo: 'R', amountCents: 1, reason: null, createdBy: null, now: at(DAY) }))!;
  const done = (await r.billing.finishRefund(b.id, { providerRefundNo: 'P', now: at(DAY), cutMs: 400 * DAY }))!;
  assert.equal(done.subscription!.currentPeriodEnd.getTime(), at(DAY).getTime());
  assert.equal((await r.subscriptions.findByAccount(account.id))!.currentPeriodEnd.getTime(), at(DAY).getTime());
});

test('仓储契约：设备注册上限（已存在不占名额、吊销释放名额、并发不超限）', async () => {
  const r = await makeRepos();
  const a = await r.accounts.create({ email: 'd@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  const reg = (fp: string, max: number) => r.devices.registerLimited(a.id, fp, `n-${fp}`, max);
  const d1 = await reg('fp1', 2);
  assert.ok(d1.ok && d1.created);
  const d1b = await reg('fp1', 2);
  assert.ok(d1b.ok && !d1b.created && d1b.device.id === (d1.ok ? d1.device.id : ''));
  assert.ok((await reg('fp2', 2)).ok);
  assert.deepEqual(await reg('fp3', 2), { ok: false, reason: 'limit' });
  assert.ok((await reg('fp1', 2)).ok, '已注册设备在满额时仍可再次登录');
  if (d1.ok) await r.devices.revoke(d1.device.id, at(1));
  assert.ok((await reg('fp3', 2)).ok, '吊销释放名额');
  const revokedAgain = await reg('fp1', 2); // 已吊销设备返回原记录，由服务层拒绝
  assert.ok(!revokedAgain.ok || revokedAgain.device.revokedAt !== null);

  const b = await r.accounts.create({ email: 'e@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => r.devices.registerLimited(b.id, `c${i}`, 'n', 3)));
  assert.equal(rs.filter((x) => x.ok).length, 3, '并发 10 台设备、上限 3 -> 恰好 3 台成功');
  assert.equal((await r.devices.listByAccount(b.id)).length, 3);
});

test('仓储契约：发票每单一张、状态流转、过滤', async () => {
  const r = await makeRepos();
  const { order } = await base(r);
  const o = await order();
  const mk = (status: 'REQUESTED' | 'ISSUED', invoiceNo: string | null) =>
    r.invoices.create({ orderId: o.id, title: '某某公司', taxNo: null, email: 'f@x.com', amountCents: 3900, status, invoiceNo, now: at(5) });
  const inv = await mk('REQUESTED', null);
  await assert.rejects(mk('REQUESTED', null));
  assert.equal(inv.issuedAt, null);
  assert.equal(await r.invoices.issue(inv.id, 'FP-001', at(6)), true);
  assert.equal(await r.invoices.issue(inv.id, 'FP-002', at(7)), false, '已开具不能重复开具');
  const got = (await r.invoices.findByOrder(o.id))!;
  assert.equal(got.status, 'ISSUED');
  assert.equal(got.invoiceNo, 'FP-001');
  assert.equal((await r.invoices.list({ status: 'ISSUED', limit: 10 })).length, 1);
  assert.equal((await r.invoices.list({ status: 'REQUESTED', limit: 10 })).length, 0);
  assert.equal(await r.invoices.void(inv.id, at(8)), true);
  assert.equal(await r.invoices.void(inv.id, at(9)), false);
  assert.equal((await r.invoices.findById(inv.id))!.status, 'VOID');
});

test('仓储契约：许可证用量记录', async () => {
  const r = await makeRepos();
  const a = await r.accounts.create({ email: 'g@x.com', passwordHash: 'h', role: 'USER', plan: 'free' });
  await r.licenceUsage.record({ accountId: a.id, deviceId: 'd1', planCode: 'free', issuedAt: at(1), expiresAt: at(DAY) });
  await r.licenceUsage.record({ accountId: a.id, deviceId: 'd1', planCode: 'pro', issuedAt: at(2), expiresAt: at(DAY) });
  assert.equal(await r.licenceUsage.countByAccount(a.id), 2);
  const list = await r.licenceUsage.listByAccount(a.id, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].planCode, 'pro', '新到旧');
});
