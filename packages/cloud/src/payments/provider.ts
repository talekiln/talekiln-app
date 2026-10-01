// 支付适配器接口。业务代码只依赖这里；沙箱实现与（待接入的）真实实现可互换。
export type ProviderName = 'wechat' | 'alipay';
export const PROVIDER_NAMES: readonly ProviderName[] = ['wechat', 'alipay'];

export interface CreateNativeOrderRequest {
  outTradeNo: string;
  amountCents: number;
  subject: string;
  expiresAt: Date;
  notifyUrl: string;
}

export interface NotifyInput {
  headers: Record<string, string | string[] | undefined>;
  /** 原始请求体（验签用；真实微信/支付宝必须用原始字节而不是重新序列化的 JSON）。 */
  rawBody: string;
  /** 已解析的请求体。 */
  body: unknown;
}

export interface VerifiedNotify {
  /** 回调去重键：微信通知 id / 支付宝 notify_id。 */
  notifyId: string;
  outTradeNo: string;
  tradeNo: string;
  amountCents: number;
  paidAt: Date;
  status: 'SUCCESS' | 'FAILED' | 'CLOSED';
}

export interface RefundRequest {
  outTradeNo: string;
  outRefundNo: string;
  totalCents: number;
  refundCents: number;
  reason?: string;
}

export interface RefundResult {
  providerRefundNo: string;
}

export interface QueryResult {
  status: 'PENDING' | 'PAID' | 'CLOSED' | 'NOT_FOUND';
  tradeNo?: string;
  amountCents?: number;
  paidAt?: Date;
}

/** 回包：HTTP 状态码与响应体（微信要 JSON，支付宝要纯文本 success）。 */
export interface NotifyAck {
  status: number;
  contentType: string;
  body: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  /** 创建扫码支付单，返回二维码内容（code_url / qr_code）。 */
  createNativeOrder(req: CreateNativeOrderRequest): Promise<{ codeUrl: string }>;
  /** 验签并解析回调；验签失败抛 ServiceError('invalid_signature')。 */
  verifyNotify(input: NotifyInput): Promise<VerifiedNotify>;
  refund(req: RefundRequest): Promise<RefundResult>;
  query(outTradeNo: string): Promise<QueryResult>;
  /** 生成给支付平台的应答（成功后平台才会停止重试）。 */
  ack(ok: boolean, message?: string): NotifyAck;
}

/** 按名称取适配器；未启用的名称抛 ServiceError('provider_unavailable')。 */
export interface PaymentProviders {
  get(name: string): PaymentProvider;
  names(): ProviderName[];
}
