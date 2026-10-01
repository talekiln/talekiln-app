import { ServiceError } from '../services/errors';
import type {
  CreateNativeOrderRequest, NotifyAck, NotifyInput, PaymentProvider, ProviderName, QueryResult,
  RefundRequest, RefundResult, VerifiedNotify,
} from './provider';

// 真实支付适配器的占位。没有商户号与证书，这里没有任何已验证的实现：
// 全部方法都抛 provider_unavailable，PAYMENT_MODE=live 时只会让下单明确失败，而不会假装成功。
// 接入时需要的环境变量名见 docs/phase2-payments.md（只列变量名，值由部署环境提供）。

class NotImplementedProvider implements PaymentProvider {
  constructor(readonly name: ProviderName) {}

  private nope(): never {
    throw new ServiceError('provider_unavailable', `${this.name} live adapter is not implemented yet`);
  }

  createNativeOrder(_req: CreateNativeOrderRequest): Promise<{ codeUrl: string }> { return this.nope(); }
  verifyNotify(_input: NotifyInput): Promise<VerifiedNotify> { return this.nope(); }
  refund(_req: RefundRequest): Promise<RefundResult> { return this.nope(); }
  query(_outTradeNo: string): Promise<QueryResult> { return this.nope(); }

  ack(ok: boolean, message = 'FAIL'): NotifyAck {
    return this.name === 'wechat'
      ? { status: ok ? 200 : 500, contentType: 'application/json', body: JSON.stringify(ok ? { code: 'SUCCESS' } : { code: 'FAIL', message }) }
      : { status: ok ? 200 : 500, contentType: 'text/plain', body: ok ? 'success' : 'fail' };
  }
}

/**
 * TODO(微信支付 APIv3 Native)：
 *  - createNativeOrder：POST /v3/pay/transactions/native，请求头 Authorization 用商户私钥签名；
 *  - verifyNotify：用微信支付平台证书（或公钥）验 Wechatpay-Signature，再用 APIv3 密钥 AES-256-GCM 解密 resource；
 *  - refund：POST /v3/refund/domestic/refunds；query：GET /v3/pay/transactions/out-trade-no/{out_trade_no}。
 */
export class WechatNativeProvider extends NotImplementedProvider {
  constructor() { super('wechat'); }
}

/**
 * TODO(支付宝 当面付/扫码 alipay.trade.precreate)：
 *  - createNativeOrder：alipay.trade.precreate，RSA2 签名；
 *  - verifyNotify：用支付宝公钥验 sign（对 form 参数按字典序拼接），并核对 app_id、seller_id；
 *  - refund：alipay.trade.refund（out_request_no 幂等）；query：alipay.trade.query。
 */
export class AlipayNativeProvider extends NotImplementedProvider {
  constructor() { super('alipay'); }
}
