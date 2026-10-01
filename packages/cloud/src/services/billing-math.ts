// 计费用的纯函数：周期推算与退款折算。全部用整数（毫秒/整数分），不使用浮点金额。
import type { BillingPeriod, Subscription } from '../domain/repositories';

export const DAY_MS = 86_400_000;

/**
 * UTC 日历月加法。保持时分秒不变；目标月没有该日时取该月最后一天（1 月 31 日 + 1 月 = 2 月 28/29 日）。
 */
export function addMonthsUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const out = new Date(d.getTime());
  out.setUTCDate(1);
  out.setUTCFullYear(y, m, Math.min(d.getUTCDate(), lastDay));
  return out;
}

export function addPeriod(start: Date, period: BillingPeriod): Date {
  return addMonthsUtc(start, period === 'MONTH' ? 1 : 12);
}

/**
 * 授权区间：仍在有效期内的订阅从当前到期时刻顺延（续期不吃掉剩余天数）；
 * 没有订阅或已过期则从付款时刻开始。
 */
export function computePeriod(
  current: Subscription | null,
  paidAt: Date,
  period: BillingPeriod,
): { start: Date; end: Date } {
  const start = current && current.currentPeriodEnd.getTime() > paidAt.getTime() ? current.currentPeriodEnd : paidAt;
  return { start, end: addPeriod(start, period) };
}

export interface RefundQuote {
  /** 本单授权区间总天数（整数）。 */
  totalDays: number;
  /** 未使用的天数，向上取整到整天，不超过 totalDays。 */
  remainingDays: number;
  /** 应退金额（整数分）。 */
  refundCents: number;
  /** 退款后订阅到期时间需要前移的毫秒数（精确剩余时长，不取整）。 */
  cutMs: number;
}

/**
 * 退款折算规则（金额全部是整数分）：
 *
 *   剩余时长   = periodEnd - max(now, periodStart)           （尚未开始的续期单：整段都算剩余）
 *   剩余天数   = min(totalDays, ceil(剩余时长 / 1 天))        （不足一天按一天算，对用户有利）
 *   应退金额   = floor(实付分 * 剩余天数 / 总天数)            （分以下舍去，对平台有利，最多差 1 分）
 *
 * 到期时刻及之后：剩余 0 天，应退 0。刚付款（含付款后不足 24 小时）：剩余天数等于总天数，全额退。
 * 用 BigInt 做乘除，避免浮点误差；结果不会超过实付金额。
 */
export function quoteRefund(
  o: { amountCents: number; periodStart: Date; periodEnd: Date },
  now: Date,
): RefundQuote {
  const totalMs = o.periodEnd.getTime() - o.periodStart.getTime();
  const totalDays = Math.max(1, Math.round(totalMs / DAY_MS));
  const from = Math.max(now.getTime(), o.periodStart.getTime());
  const remainingMs = Math.max(0, o.periodEnd.getTime() - from);
  const remainingDays = Math.min(totalDays, Math.ceil(remainingMs / DAY_MS));
  const refundCents = Number((BigInt(o.amountCents) * BigInt(remainingDays)) / BigInt(totalDays));
  return { totalDays, remainingDays, refundCents, cutMs: remainingMs };
}
