import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMonthsUtc, computePeriod, DAY_MS, quoteRefund } from '../src/services/billing-math';
import type { Subscription } from '../src/domain/repositories';

const d = (s: string) => new Date(s);

test('addMonthsUtc：月末取目标月最后一天，跨年，闰年', () => {
  assert.equal(addMonthsUtc(d('2026-01-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonthsUtc(d('2028-01-31T10:00:00Z'), 1).toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(addMonthsUtc(d('2026-12-15T00:00:00Z'), 1).toISOString(), '2027-01-15T00:00:00.000Z');
  assert.equal(addMonthsUtc(d('2028-02-29T00:00:00Z'), 12).toISOString(), '2029-02-28T00:00:00.000Z');
  assert.equal(addMonthsUtc(d('2026-10-01T08:30:15.123Z'), 12).toISOString(), '2027-10-01T08:30:15.123Z');
});

test('computePeriod：有效订阅顺延，过期/无订阅从付款时刻起算', () => {
  const sub = (end: string): Subscription => ({
    id: 's', accountId: 'a', planVersionId: 'v', currentPeriodStart: d('2026-09-01T00:00:00Z'),
    currentPeriodEnd: d(end), createdAt: d('2026-09-01T00:00:00Z'),
  });
  const paid = d('2026-10-01T00:00:00Z');
  assert.deepEqual(computePeriod(null, paid, 'MONTH'), { start: paid, end: d('2026-11-01T00:00:00Z') });
  // 剩余 10 天：从到期时刻顺延，不吃掉剩余天数
  const r = computePeriod(sub('2026-10-11T00:00:00Z'), paid, 'MONTH');
  assert.equal(r.start.toISOString(), '2026-10-11T00:00:00.000Z');
  assert.equal(r.end.toISOString(), '2026-11-11T00:00:00.000Z');
  // 恰好到期的瞬间视为已过期
  assert.equal(computePeriod(sub('2026-10-01T00:00:00Z'), paid, 'YEAR').start.getTime(), paid.getTime());
  assert.equal(computePeriod(sub('2026-09-20T00:00:00Z'), paid, 'YEAR').end.toISOString(), '2027-10-01T00:00:00.000Z');
});

// 月付 39 元：2026-10-01 -> 2026-11-01，共 31 天
const MONTH = { amountCents: 3900, periodStart: d('2026-10-01T00:00:00Z'), periodEnd: d('2026-11-01T00:00:00Z') };
const T = MONTH.periodStart.getTime();

test('退款折算（月付）：整天向上取整、分向下取整、边界', () => {
  const q = (ms: number) => quoteRefund(MONTH, new Date(T + ms));
  // 刚付款 / 付款后不足一天：全额
  assert.deepEqual(q(0), { totalDays: 31, remainingDays: 31, refundCents: 3900, cutMs: 31 * DAY_MS });
  assert.equal(q(1).refundCents, 3900);
  assert.equal(q(DAY_MS - 1).refundCents, 3900);
  // 恰好满 1 天：剩 30 天，3900*30/31 = 3774.19 -> 3774
  assert.equal(q(DAY_MS).remainingDays, 30);
  assert.equal(q(DAY_MS).refundCents, 3774);
  // 满 1 天又 1 毫秒：剩余 30 天减 1 毫秒，仍向上取整为 30 天
  assert.equal(q(DAY_MS + 1).remainingDays, 30);
  assert.equal(q(DAY_MS + 1).refundCents, 3774);
  // 只剩最后一天：3900/31 = 125.8 -> 125
  assert.equal(q(30 * DAY_MS).refundCents, 125);
  const lastMs = q(31 * DAY_MS - 1);
  assert.equal(lastMs.remainingDays, 1);
  assert.equal(lastMs.refundCents, 125);
  assert.equal(lastMs.cutMs, 1);
  // 到期及之后：0
  assert.equal(q(31 * DAY_MS).refundCents, 0);
  assert.equal(q(31 * DAY_MS).remainingDays, 0);
  assert.equal(q(40 * DAY_MS).refundCents, 0);
  assert.equal(q(40 * DAY_MS).cutMs, 0);
});

test('退款折算：尚未开始的续期单整单可退；年付与平台舍入方向', () => {
  const early = quoteRefund(MONTH, new Date(T - 5 * DAY_MS));
  assert.equal(early.refundCents, 3900);
  assert.equal(early.cutMs, 31 * DAY_MS);
  const YEAR = { amountCents: 29900, periodStart: d('2026-10-01T00:00:00Z'), periodEnd: d('2027-10-01T00:00:00Z') };
  const y = (days: number) => quoteRefund(YEAR, new Date(YEAR.periodStart.getTime() + days * DAY_MS));
  assert.equal(y(0).totalDays, 365);
  assert.equal(y(0).refundCents, 29900);
  assert.equal(y(1).refundCents, Math.floor((29900 * 364) / 365)); // 29818
  assert.equal(y(1).refundCents, 29818);
  assert.equal(y(364).refundCents, 81); // 29900/365 = 81.9 -> 81
  assert.equal(y(365).refundCents, 0);
  // 单调不增，且永不超过实付
  let prev = Infinity;
  for (let h = 0; h <= 365 * 24; h += 7) {
    const r = quoteRefund(YEAR, new Date(YEAR.periodStart.getTime() + h * 3_600_000)).refundCents;
    assert.ok(Number.isInteger(r) && r >= 0 && r <= YEAR.amountCents && r <= prev);
    prev = r;
  }
});
