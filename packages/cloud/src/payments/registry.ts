import { createHmac } from 'node:crypto';
import { ServiceError } from '../services/errors';
import { PROVIDER_NAMES, type PaymentProvider, type PaymentProviders, type ProviderName } from './provider';
import { AlipayNativeProvider, WechatNativeProvider } from './real.providers';
import { SandboxProvider } from './sandbox.provider';

export class StaticProviders implements PaymentProviders {
  private readonly map = new Map<string, PaymentProvider>();
  constructor(list: PaymentProvider[]) { for (const p of list) this.map.set(p.name, p); }

  get(name: string): PaymentProvider {
    const p = this.map.get(name);
    if (!p) throw new ServiceError('provider_unavailable', `payment provider "${name}" is not enabled`);
    return p;
  }
  names(): ProviderName[] { return PROVIDER_NAMES.filter((n) => this.map.has(n)); }
}

/**
 * PAYMENT_MODE：
 *  - sandbox：沙箱适配器（非生产默认）。生产环境禁止，避免用模拟回调免费开通。
 *  - live：真实适配器（目前是未实现的占位，下单会明确失败）。
 *  - 未设置：非生产 = sandbox；生产 = 不启用任何支付方式。
 * 沙箱密钥：PAYMENT_SANDBOX_SECRET；未设置时由 JWT_ACCESS_SECRET 派生（不写死任何密钥）。
 */
export function createProviders(
  env: NodeJS.ProcessEnv = process.env,
  /** 派生沙箱密钥用的备选材料（通常是已加载配置里的访问令牌密钥）。 */
  fallbackSecret: Uint8Array | string = '',
  now: () => Date = () => new Date(),
): StaticProviders {
  const prod = env.NODE_ENV === 'production';
  const mode = env.PAYMENT_MODE ?? (prod ? '' : 'sandbox');
  if (mode === 'sandbox') {
    if (prod) throw new Error('生产环境不允许 PAYMENT_MODE=sandbox');
    const base = env.PAYMENT_SANDBOX_SECRET || Buffer.from(fallbackSecret).toString('utf8');
    if (base.length < 16) throw new Error('沙箱支付需要 PAYMENT_SANDBOX_SECRET 或 JWT_ACCESS_SECRET');
    const secret = new Uint8Array(createHmac('sha256', base).update('talekiln-payment-sandbox-v1').digest());
    return new StaticProviders([new SandboxProvider('wechat', secret, now), new SandboxProvider('alipay', secret, now)]);
  }
  if (mode === 'live') return new StaticProviders([new WechatNativeProvider(), new AlipayNativeProvider()]);
  return new StaticProviders([]);
}
