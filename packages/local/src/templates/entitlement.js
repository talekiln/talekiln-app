'use strict';
/**
 * 付费（pro）模板的权益判断。输入是 account.status() 的返回（见 cloud/account.js），纯函数、不联网。
 *
 * 规则（任一满足即可用 pro 模板）：
 *   - 许可证权益里含 'templates:pro'；
 *   - 已登录 + 许可证 valid/grace + 套餐不是 free + 订阅未到期（sub_end 为空视为不限期）。
 * 离线宽限期（grace）内仍可用，许可证过期即不可用。
 */
const PRO_ENTITLEMENT = 'templates:pro';
const FREE_PLANS = new Set(['', 'free', 'trial_free']);

function isPro(status, now = Date.now()) {
  if (!status || !status.logged_in) return false;
  const lic = status.licence || {};
  if (lic.state !== 'valid' && lic.state !== 'grace') return false;
  const ents = Array.isArray(lic.entitlements) ? lic.entitlements : [];
  if (ents.includes(PRO_ENTITLEMENT)) return true;
  const plan = String(lic.plan || (status.account && status.account.plan) || '').trim().toLowerCase();
  if (FREE_PLANS.has(plan)) return false;
  if (lic.sub_end) {
    const t = Date.parse(lic.sub_end);
    if (Number.isFinite(t) && t <= now) return false;
  }
  return true;
}

/** 给界面的说明：为什么不能用 pro 模板。 */
function proReason(status, now = Date.now()) {
  if (isPro(status, now)) return null;
  if (!status || !status.logged_in) return '付费模板需要登录账号';
  const lic = status.licence || {};
  if (lic.state === 'expired') return '许可证已过期，请联网续期';
  if (lic.state !== 'valid' && lic.state !== 'grace') return '尚未取得许可证，请联网同步';
  if (lic.sub_end && Date.parse(lic.sub_end) <= now) return '订阅已到期，续费后可用';
  return '当前套餐不含付费模板';
}

module.exports = { isPro, proReason, PRO_ENTITLEMENT };
