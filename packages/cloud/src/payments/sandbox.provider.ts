import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from '../services/errors';
import type {
  CreateNativeOrderRequest, NotifyAck, NotifyInput, PaymentProvider, ProviderName, QueryResult,
  RefundRequest, RefundResult, VerifiedNotify,
} from './provider';

/** 沙箱回调体：字段全是字符串/数字，sign 为 HMAC-SHA256(十六进制)。 */
export interface SandboxNotifyBody {
  notify_id: string;
  out_trade_no: string;
  trade_no: string;
  amount_cents: number;
  status: 'SUCCESS' | 'FAILED' | 'CLOSED';
  paid_at: string;
  sign: string;
}

const bodySchema = z.object({
  notify_id: z.string().min(1).max(100),
  out_trade_no: z.string().min(1).max(64),
  trade_no: z.string().min(1).max(100),
  amount_cents: z.number().int().min(0),
  status: z.enum(['SUCCESS', 'FAILED', 'CLOSED']),
  paid_at: z.string().datetime(),
  sign: z.string().regex(/^[0-9a-f]{64}$/),
});

interface SandboxTrade {
  amountCents: number;
  paid?: { tradeNo: string; paidAt: Date };
  closed?: boolean;
  refundedCents: number;
}

/**
 * 沙箱适配器：完全不发网络请求，签名是确定性的 HMAC，用来在没有商户号时跑通整条链路。
 * 密钥由调用方注入（来自环境变量 PAYMENT_SANDBOX_SECRET，或由 JWT_ACCESS_SECRET 派生），本文件不含任何密钥。
 * 订单状态保存在进程内存里：只用于开发与测试，不能用于多实例或生产。
 */
export class SandboxProvider implements PaymentProvider {
  private readonly trades = new Map<string, SandboxTrade>();
  private failNextRefundMessage: string | null = null;
  private seq = 0;

  constructor(
    readonly name: ProviderName,
    private readonly secret: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private canonical(fields: Record<string, unknown>): string {
    return Object.keys(fields).filter((k) => k !== 'sign').sort().map((k) => `${k}=${String(fields[k])}`).join('&');
  }

  /** 把 provider 名一并签进去：微信沙箱的签名不能拿去冒充支付宝沙箱。 */
  sign(fields: Record<string, unknown>): string {
    return createHmac('sha256', this.secret).update(`${this.name}\n${this.canonical(fields)}`).digest('hex');
  }

  /** 构造一条已签名的“支付成功”回调体（测试与本地联调用；真实环境由支付平台发出）。 */
  buildNotify(o: {
    outTradeNo: string; amountCents: number; notifyId?: string; tradeNo?: string;
    paidAt?: Date; status?: SandboxNotifyBody['status'];
  }): SandboxNotifyBody {
    const unsigned = {
      notify_id: o.notifyId ?? `sbx-n-${this.name}-${o.outTradeNo}`,
      out_trade_no: o.outTradeNo,
      trade_no: o.tradeNo ?? `sbx-t-${this.name}-${o.outTradeNo}`,
      amount_cents: o.amountCents,
      status: o.status ?? 'SUCCESS',
      paid_at: (o.paidAt ?? this.now()).toISOString(),
    };
    return { ...unsigned, sign: this.sign(unsigned) };
  }

  /** 模拟用户扫码付款：把沙箱单置为已付，并返回对应的回调体。 */
  simulatePay(outTradeNo: string, opts: { notifyId?: string; tradeNo?: string } = {}): SandboxNotifyBody {
    const t = this.trades.get(outTradeNo);
    if (!t) throw new Error(`sandbox: unknown trade ${outTradeNo}`);
    const n = this.buildNotify({ outTradeNo, amountCents: t.amountCents, ...opts });
    t.paid = { tradeNo: n.trade_no, paidAt: new Date(n.paid_at) };
    return n;
  }

  /** 让下一次 refund 调用失败（测试退款失败回滚）。 */
  failNextRefund(message = 'sandbox refund rejected') { this.failNextRefundMessage = message; }

  async createNativeOrder(req: CreateNativeOrderRequest): Promise<{ codeUrl: string }> {
    this.trades.set(req.outTradeNo, { amountCents: req.amountCents, refundedCents: 0 });
    const q = new URLSearchParams({ out_trade_no: req.outTradeNo, amount_cents: String(req.amountCents) });
    return { codeUrl: `sandbox://${this.name}/pay?${q.toString()}` };
  }

  async verifyNotify(input: NotifyInput): Promise<VerifiedNotify> {
    const parsed = bodySchema.safeParse(input.body);
    if (!parsed.success) throw new ServiceError('invalid_signature', 'malformed notify');
    const b = parsed.data;
    const expect = Buffer.from(this.sign(b), 'hex');
    const got = Buffer.from(b.sign, 'hex');
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw new ServiceError('invalid_signature');
    // 验签通过的“支付成功”回调即视为已付（回调可能由另一个进程/测试工具签发）
    const t = this.trades.get(b.out_trade_no);
    if (t && b.status === 'SUCCESS' && !t.paid && b.amount_cents === t.amountCents) {
      t.paid = { tradeNo: b.trade_no, paidAt: new Date(b.paid_at) };
    }
    return {
      notifyId: b.notify_id, outTradeNo: b.out_trade_no, tradeNo: b.trade_no,
      amountCents: b.amount_cents, paidAt: new Date(b.paid_at), status: b.status,
    };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    if (this.failNextRefundMessage) {
      const m = this.failNextRefundMessage;
      this.failNextRefundMessage = null;
      throw new Error(m);
    }
    // 进程重启后沙箱内存里没有这笔交易：按请求里的总额重建（沙箱不追求跨重启一致）
    let t = this.trades.get(req.outTradeNo);
    if (!t) {
      t = { amountCents: req.totalCents, refundedCents: 0, paid: { tradeNo: 'sbx-restored', paidAt: this.now() } };
      this.trades.set(req.outTradeNo, t);
    }
    if (!t.paid) throw new Error('sandbox: trade not paid');
    if (req.refundCents < 1 || t.refundedCents + req.refundCents > t.amountCents || req.totalCents !== t.amountCents) {
      throw new Error('sandbox: invalid refund amount');
    }
    t.refundedCents += req.refundCents;
    return { providerRefundNo: `sbx-r-${this.name}-${req.outRefundNo}-${++this.seq}` };
  }

  async query(outTradeNo: string): Promise<QueryResult> {
    const t = this.trades.get(outTradeNo);
    if (!t) return { status: 'NOT_FOUND' };
    if (t.paid) return { status: 'PAID', tradeNo: t.paid.tradeNo, amountCents: t.amountCents, paidAt: t.paid.paidAt };
    return { status: t.closed ? 'CLOSED' : 'PENDING' };
  }

  /** 沙箱里的已退金额（测试断言用）。 */
  refundedCents(outTradeNo: string): number { return this.trades.get(outTradeNo)?.refundedCents ?? 0; }

  ack(ok: boolean, message = 'FAIL'): NotifyAck {
    return this.name === 'wechat'
      ? { status: ok ? 200 : 400, contentType: 'application/json', body: JSON.stringify(ok ? { code: 'SUCCESS', message: 'OK' } : { code: 'FAIL', message }) }
      : { status: ok ? 200 : 400, contentType: 'text/plain', body: ok ? 'success' : 'fail' };
  }
}
