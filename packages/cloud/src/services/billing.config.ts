import type { Entitlements } from '../domain/repositories';

// 套餐的初始数据（仅用于首次播种）。价格与权益真正生效的地方是数据库里的 PlanVersion：
// 改价请通过管理接口新增版本，或在首次启动前用环境变量覆盖。已下的订单永远指向下单时的版本。

export interface PlanSeed {
  code: string;
  name: string;
  priceMonthCents: number | null;
  priceYearCents: number | null;
  entitlements: Entitlements;
}

export const FREE_PLAN_CODE = 'free';
export const PRO_PLAN_CODE = 'pro';

const readCents = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100_000_00) throw new Error(`价格需为 1..10000000 的整数分，收到：${v}`);
  return n;
};

export function defaultPlanSeeds(env: NodeJS.ProcessEnv = process.env): PlanSeed[] {
  return [
    {
      code: FREE_PLAN_CODE, name: '免费版', priceMonthCents: null, priceYearCents: null,
      entitlements: { maxDevices: 1, exportMaxHeight: 720, watermark: true, features: ['generate', 'export'] },
    },
    {
      code: PRO_PLAN_CODE, name: '专业版',
      priceMonthCents: readCents(env.PLAN_PRO_PRICE_MONTH_CENTS, 3900),
      priceYearCents: readCents(env.PLAN_PRO_PRICE_YEAR_CENTS, 29900),
      entitlements: {
        maxDevices: 3, exportMaxHeight: 2160, watermark: false,
        features: ['generate', 'export', 'cloud-sync', 'batch', 'pro-models'],
      },
    },
  ];
}

/** 套餐尚未播种时的兜底（免费版权益）。 */
export const FALLBACK_FREE_ENTITLEMENTS: Entitlements = defaultPlanSeeds({} as NodeJS.ProcessEnv)[0].entitlements;

/** 邀请码内测账号（account.plan = 'test'）沿用旧行为：全部功能，设备数按专业版。 */
export const LEGACY_TEST_ENTITLEMENTS: Entitlements = {
  maxDevices: 3, exportMaxHeight: 2160, watermark: false,
  features: ['generate', 'export', 'cloud-sync', 'batch', 'pro-models'],
};

export interface BillingOptions {
  /** 支付结果回调的公网基地址（拼出 notify_url）；沙箱下仅作展示。 */
  notifyBaseUrl: string;
  /** 订单待支付有效期（分钟）。 */
  orderTtlMinutes: number;
}

export function loadBillingOptions(env: NodeJS.ProcessEnv = process.env): BillingOptions {
  return {
    notifyBaseUrl: (env.PAYMENT_NOTIFY_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    orderTtlMinutes: Number(env.ORDER_TTL_MINUTES ?? 30),
  };
}
