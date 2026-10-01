import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AccessGuard, AdminGuard, type AdminRequest, type AuthedRequest } from './guard';
import { errorStatus } from './filter';
import { BillingService } from '../services/billing.service';
import { PlanService } from '../services/plan.service';
import { RateLimiter } from '../services/rate-limiter';
import { ServiceError } from '../services/errors';

const MIN = 60_000;
const orderStatus = z.enum(['PENDING', 'PAID', 'CLOSED', 'REFUNDING', 'REFUNDED']);
const invoiceStatus = z.enum(['REQUESTED', 'ISSUED', 'VOID']);
const limit = z.coerce.number().int().min(1).max(500).catch(100);

/** 公开：套餐与价格（价格来自数据库里的套餐版本）。 */
@Controller('plans')
export class PlanController {
  constructor(@Inject(PlanService) private readonly plans: PlanService) {}
  @Get() list() { return this.plans.listPublic(); }
}

@Controller('orders')
@UseGuards(AccessGuard)
export class OrderController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Post() create(@Req() req: AuthedRequest, @Body() b: unknown) {
    this.limiter.hit(`order:acct:${req.auth!.accountId}`, 10, 10 * MIN);
    return this.billing.createOrder(req.auth!.accountId, b);
  }
  @Get() list(@Req() req: AuthedRequest) { return this.billing.listOrders(req.auth!.accountId); }
  @Get(':id') get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.billing.getOrder(req.auth!.accountId, id);
  }
  @Post(':id/invoice') requestInvoice(@Req() req: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.billing.requestInvoice(req.auth!.accountId, id, b);
  }
}

@Controller('subscription')
@UseGuards(AccessGuard)
export class SubscriptionController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}
  @Get() get(@Req() req: AuthedRequest) { return this.billing.subscription(req.auth!.accountId); }
}

type NotifyRequest = AuthedRequest & { rawBody?: Buffer; body?: unknown };

/** 支付平台回调（公开，靠验签保证真实性）。应答格式由各适配器决定。 */
@Controller('payments')
export class PaymentNotifyController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Post('notify/:provider') @HttpCode(200)
  async notify(@Req() req: NotifyRequest, @Param('provider') provider: string, @Res() res: Response) {
    this.limiter.hit(`notify:ip:${req.ip}`, 600, MIN);
    let r;
    try {
      r = await this.billing.handleNotify(provider, {
        headers: req.headers, rawBody: req.rawBody ? req.rawBody.toString('utf8') : '', body: req.body,
      });
    } catch (e) {
      // 未启用的渠道等：没有适配器就没有应答格式，回普通错误
      if (e instanceof ServiceError) return res.status(errorStatus(e.code)).json({ error: e.code });
      throw e;
    }
    res.status(r.ack.status).type(r.ack.contentType).send(r.ack.body);
  }
}

const refundBody = z.object({ reason: z.string().max(200).optional() }).default({});

/** 管理侧：订单、退款、发票、套餐。接口风格与 AdminController 一致（AdminGuard + JSON）。 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminBillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(PlanService) private readonly plans: PlanService,
  ) {}

  @Get('orders') orders(@Query('status') status?: string, @Query('accountId') accountId?: string, @Query('limit') l?: string) {
    return this.billing.listOrdersAdmin({
      status: orderStatus.optional().parse(status),
      accountId: z.string().uuid().optional().parse(accountId),
      limit: limit.parse(l),
    });
  }
  @Get('orders/:id') order(@Param('id') id: string) { return this.billing.orderDetail(id); }
  @Post('orders/:id/refund') @HttpCode(200)
  refund(@Req() req: AdminRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.billing.refundOrder(req.admin!.accountId, id, refundBody.parse(b ?? {}).reason);
  }
  @Get('refunds') refunds(@Query('limit') l?: string) { return this.billing.listRefunds(limit.parse(l)); }

  @Post('orders/:id/invoice') registerInvoice(@Param('id') id: string, @Body() b: unknown) {
    return this.billing.registerInvoice(id, b);
  }
  @Get('invoices') invoices(@Query('status') status?: string, @Query('limit') l?: string) {
    return this.billing.listInvoices(invoiceStatus.optional().parse(status), limit.parse(l));
  }
  @Post('invoices/:id/issue') @HttpCode(200)
  issueInvoice(@Param('id') id: string, @Body() b: unknown) {
    return this.billing.issueInvoice(id, (b as { invoiceNo?: unknown } | undefined)?.invoiceNo);
  }
  @Post('invoices/:id/void') @HttpCode(200) voidInvoice(@Param('id') id: string) { return this.billing.voidInvoice(id); }

  @Get('plans') listPlans() { return this.plans.listAdmin(); }
  @Post('plans') createPlan(@Body() b: unknown) { return this.plans.create(b); }
  @Post('plans/:code/versions') addVersion(@Param('code') code: string, @Body() b: unknown) {
    return this.plans.addVersion(code, b);
  }
  @Put('plans/:code/enabled') @HttpCode(204)
  async setEnabled(@Param('code') code: string, @Body() b: unknown) {
    await this.plans.setEnabled(code, z.object({ enabled: z.boolean() }).parse(b).enabled);
  }
}
