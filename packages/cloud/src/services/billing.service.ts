import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { computePeriod, quoteRefund } from './billing-math';
import { type BillingOptions } from './billing.config';
import { EntitlementService } from './entitlement.service';
import { ServiceError } from './errors';
import type { NotifyAck, NotifyInput, PaymentProviders } from '../payments/provider';
import type {
  BillingPeriod, InvoiceRecord, OrderRecord, OrderStatus, Repositories, Subscription,
} from '../domain/repositories';

export const createOrderSchema = z.object({
  planCode: z.string().min(1).max(40),
  period: z.enum(['month', 'year']),
  provider: z.enum(['wechat', 'alipay']),
});

export const invoiceInfoSchema = z.object({
  title: z.string().trim().min(1).max(120),
  taxNo: z.string().trim().min(1).max(40).optional(),
  email: z.string().email().max(200),
});

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002' || (e as Error).message?.startsWith('unique:');

export type NotifyOutcome = 'applied' | 'duplicate_notify' | 'already_settled' | 'ignored';

export class BillingService {
  constructor(
    private readonly repos: Repositories,
    private readonly providers: PaymentProviders,
    private readonly opts: BillingOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly entitlements: EntitlementService = new EntitlementService(repos, now),
  ) {}

  // ------------------------------------------------------------------ 用户侧

  /** 下单：价格取下单时的套餐最新版本，写进订单后不再变化。 */
  async createOrder(accountId: string, input: unknown): Promise<OrderRecord> {
    const body = createOrderSchema.parse(input);
    const provider = this.providers.get(body.provider);
    const plan = await this.repos.plans.findByCode(body.planCode);
    if (!plan || !plan.enabled) throw new ServiceError('not_found', 'plan not found');
    const version = await this.repos.plans.latestVersion(plan.id);
    if (!version) throw new ServiceError('not_found', 'plan has no version');
    const period: BillingPeriod = body.period === 'month' ? 'MONTH' : 'YEAR';
    const amountCents = period === 'MONTH' ? version.priceMonthCents : version.priceYearCents;
    if (amountCents === null) throw new ServiceError('bad_request', 'plan is not purchasable for this period');
    const account = await this.repos.accounts.findById(accountId);
    if (!account) throw new ServiceError('not_found');
    if (account.disabledAt) throw new ServiceError('account_disabled');

    const now = this.now();
    let order: OrderRecord | null = null;
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
      try {
        order = await this.repos.orders.create({
          outTradeNo: this.newOutTradeNo(now), accountId, planVersionId: version.id, period, amountCents,
          provider: provider.name, createdAt: now, expiresAt: new Date(now.getTime() + this.opts.orderTtlMinutes * 60_000),
        });
      } catch (e) {
        if (!isUnique(e) || attempt === 2) throw e;
      }
    }
    if (!order) throw new Error('unreachable');
    try {
      const { codeUrl } = await provider.createNativeOrder({
        outTradeNo: order.outTradeNo, amountCents, subject: `${plan.name}（${period === 'MONTH' ? '月付' : '年付'}）`,
        expiresAt: order.expiresAt, notifyUrl: `${this.opts.notifyBaseUrl}/payments/notify/${provider.name}`,
      });
      await this.repos.orders.setCodeUrl(order.id, codeUrl);
      return { ...order, codeUrl };
    } catch (e) {
      await this.repos.orders.close(order.id, now); // 下游失败：关单，不留待支付垃圾单
      throw e;
    }
  }

  private newOutTradeNo(now: Date): string {
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `TK${ts}${randomBytes(5).toString('hex')}`; // 26 位，满足微信 6-32、支付宝 ≤64
  }

  /** 查看自己的订单。待支付的订单会向支付平台主动查单（回调丢失时的兜底），并关闭已超时的未支付单。 */
  async getOrder(accountId: string, orderId: string): Promise<OrderRecord> {
    const o = await this.repos.orders.findById(orderId);
    if (!o || o.accountId !== accountId) throw new ServiceError('not_found');
    return this.syncPending(o);
  }

  async listOrders(accountId: string): Promise<OrderRecord[]> {
    return this.repos.orders.listByAccount(accountId);
  }

  private async syncPending(o: OrderRecord): Promise<OrderRecord> {
    if (o.status !== 'PENDING') return o;
    try {
      const q = await this.providers.get(o.provider).query(o.outTradeNo);
      if (q.status === 'PAID' && q.tradeNo && q.paidAt && q.amountCents === o.amountCents) {
        await this.repos.billing.settlePaid({
          provider: o.provider, notifyId: `query:${q.tradeNo}`, outTradeNo: o.outTradeNo, tradeNo: q.tradeNo,
          amountCents: q.amountCents, paidAt: q.paidAt, periodFor: this.periodFor(q.paidAt),
        });
      } else if (o.expiresAt.getTime() <= this.now().getTime() && q.status !== 'PAID') {
        await this.repos.orders.close(o.id, this.now());
      }
    } catch (e) {
      if (!(e instanceof ServiceError)) console.error('[billing] query failed', o.outTradeNo, (e as Error).message);
    }
    return (await this.repos.orders.findById(o.id)) ?? o;
  }

  private periodFor(paidAt: Date) {
    return (cur: Subscription | null, order: OrderRecord) => computePeriod(cur, paidAt, order.period);
  }

  /** 当前订阅与生效权益。 */
  async subscription(accountId: string) {
    const eff = await this.entitlements.resolve(accountId);
    const sub = await this.repos.subscriptions.findByAccount(accountId);
    const now = this.now().getTime();
    return {
      plan: eff.planCode,
      source: eff.source,
      entitlements: eff.entitlements,
      subscription: sub
        ? {
          planVersionId: sub.planVersionId,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          active: sub.currentPeriodEnd.getTime() > now,
        }
        : null,
    };
  }

  /** 用户提交开票申请（REQUESTED），由管理员线下开具后登记发票号。 */
  async requestInvoice(accountId: string, orderId: string, input: unknown): Promise<InvoiceRecord> {
    const info = invoiceInfoSchema.parse(input);
    const o = await this.repos.orders.findById(orderId);
    if (!o || o.accountId !== accountId) throw new ServiceError('not_found');
    return this.createInvoice(o, info, null);
  }

  private async createInvoice(
    o: OrderRecord, info: z.infer<typeof invoiceInfoSchema>, invoiceNo: string | null,
  ): Promise<InvoiceRecord> {
    if (o.status !== 'PAID') throw new ServiceError('conflict', 'only paid, non-refunded orders can be invoiced');
    try {
      return await this.repos.invoices.create({
        orderId: o.id, title: info.title, taxNo: info.taxNo ?? null, email: info.email,
        amountCents: o.amountCents, status: invoiceNo ? 'ISSUED' : 'REQUESTED', invoiceNo, now: this.now(),
      });
    } catch (e) {
      if (isUnique(e)) throw new ServiceError('conflict', 'invoice already exists for this order');
      throw e;
    }
  }

  // ------------------------------------------------------------------ 支付回调

  /**
   * 处理支付平台回调。验签 -> 金额/渠道核对 -> 原子结算（回调去重 + 订单 + 订阅同一事务）。
   * 返回给平台的应答；只有验签失败、数据对不上等“确定性错误”才回失败，
   * 数据库故障等意外直接抛出（平台会按自己的节奏重试）。
   */
  async handleNotify(providerName: string, input: NotifyInput): Promise<{ ack: NotifyAck; outcome: NotifyOutcome | 'rejected' }> {
    const provider = this.providers.get(providerName);
    try {
      const n = await provider.verifyNotify(input);
      if (n.status !== 'SUCCESS') return { ack: provider.ack(true), outcome: 'ignored' };
      const order = await this.repos.orders.findByOutTradeNo(n.outTradeNo);
      if (!order) throw new ServiceError('not_found', 'unknown out_trade_no');
      if (order.provider !== provider.name) throw new ServiceError('bad_request', 'provider mismatch');
      if (n.amountCents !== order.amountCents) throw new ServiceError('bad_request', 'amount mismatch');
      const r = await this.repos.billing.settlePaid({
        provider: provider.name, notifyId: n.notifyId, outTradeNo: n.outTradeNo, tradeNo: n.tradeNo,
        amountCents: n.amountCents, paidAt: n.paidAt, periodFor: this.periodFor(n.paidAt),
      });
      if (r.outcome === 'not_found') throw new ServiceError('not_found', 'unknown out_trade_no');
      return { ack: provider.ack(true), outcome: r.outcome };
    } catch (e) {
      if (e instanceof ServiceError) return { ack: provider.ack(false, e.message), outcome: 'rejected' };
      throw e;
    }
  }

  // ------------------------------------------------------------------ 管理侧

  listOrdersAdmin(filter: { status?: OrderStatus; accountId?: string; limit?: number }) {
    return this.repos.orders.list({ status: filter.status, accountId: filter.accountId, limit: filter.limit ?? 100 });
  }

  async orderDetail(orderId: string) {
    const order = await this.repos.orders.findById(orderId);
    if (!order) throw new ServiceError('not_found');
    const [payment, refunds, invoice, version] = await Promise.all([
      this.repos.orders.findPayment(orderId), this.repos.refunds.listByOrder(orderId),
      this.repos.invoices.findByOrder(orderId), this.repos.plans.findVersion(order.planVersionId),
    ]);
    const quote = order.status === 'PAID' && order.periodStart && order.periodEnd
      ? quoteRefund({ amountCents: order.amountCents, periodStart: order.periodStart, periodEnd: order.periodEnd }, this.now())
      : null;
    return { order, planCode: version?.planCode ?? null, payment, refunds, invoice, refundQuote: quote };
  }

  listRefunds(limit = 100) { return this.repos.refunds.list(limit); }

  /**
   * 管理员退款：按剩余天数折算（规则见 billing-math.quoteRefund），整单一次，
   * 退款成功后订单 REFUNDED、订阅到期时间前移。已开具的发票须先作废（人工红冲）。
   * 状态流转：PAID -> REFUNDING（原子占位，并发的第二个退款请求拿不到）-> REFUNDED；
   * 渠道退款失败则回到 PAID、退款单 FAILED，可重试。
   */
  async refundOrder(adminId: string, orderId: string, reason?: string) {
    const order = await this.repos.orders.findById(orderId);
    if (!order) throw new ServiceError('not_found');
    if (order.status !== 'PAID' || !order.periodStart || !order.periodEnd) {
      throw new ServiceError('conflict', `order is ${order.status}, only PAID orders can be refunded`);
    }
    const invoice = await this.repos.invoices.findByOrder(orderId);
    if (invoice && invoice.status === 'ISSUED') throw new ServiceError('conflict', 'invoice issued: void it first');
    const now = this.now();
    const quote = quoteRefund({ amountCents: order.amountCents, periodStart: order.periodStart, periodEnd: order.periodEnd }, now);
    if (quote.refundCents < 1) throw new ServiceError('conflict', 'nothing refundable (period already used up)');

    const attempts = (await this.repos.refunds.listByOrder(orderId)).length;
    const refund = await this.repos.billing.beginRefund({
      orderId, outRefundNo: `RF${order.outTradeNo.slice(2)}${attempts + 1}`, amountCents: quote.refundCents,
      reason: reason ?? null, createdBy: adminId, now,
    });
    if (!refund) throw new ServiceError('conflict', 'order is not refundable right now');

    let providerRefundNo: string;
    try {
      ({ providerRefundNo } = await this.providers.get(order.provider).refund({
        outTradeNo: order.outTradeNo, outRefundNo: refund.outRefundNo, totalCents: order.amountCents,
        refundCents: quote.refundCents, reason,
      }));
    } catch (e) {
      await this.repos.billing.failRefund(refund.id, { now: this.now(), reason: (e as Error).message.slice(0, 300) });
      throw e instanceof ServiceError ? e : new ServiceError('provider_unavailable', 'provider refund failed');
    }
    const done = await this.repos.billing.finishRefund(refund.id, { providerRefundNo, now: this.now(), cutMs: quote.cutMs });
    if (!done) throw new Error('refund state changed concurrently');
    return { refund: done.refund, quote, subscription: done.subscription };
  }

  /** 人工开票登记：管理员直接为已付款订单登记（可带发票号，带则直接 ISSUED）。 */
  async registerInvoice(orderId: string, input: unknown) {
    const body = invoiceInfoSchema.extend({ invoiceNo: z.string().trim().min(1).max(60).optional() }).parse(input);
    const o = await this.repos.orders.findById(orderId);
    if (!o) throw new ServiceError('not_found');
    return this.createInvoice(o, body, body.invoiceNo ?? null);
  }

  listInvoices(status?: InvoiceRecord['status'], limit = 100) { return this.repos.invoices.list({ status, limit }); }

  async issueInvoice(id: string, invoiceNo: unknown) {
    const no = z.string().trim().min(1).max(60).parse(invoiceNo);
    if (!(await this.repos.invoices.issue(id, no, this.now()))) {
      throw new ServiceError((await this.repos.invoices.findById(id)) ? 'conflict' : 'not_found');
    }
    return (await this.repos.invoices.findById(id))!;
  }

  async voidInvoice(id: string) {
    if (!(await this.repos.invoices.void(id, this.now()))) {
      throw new ServiceError((await this.repos.invoices.findById(id)) ? 'conflict' : 'not_found');
    }
    return (await this.repos.invoices.findById(id))!;
  }
}
