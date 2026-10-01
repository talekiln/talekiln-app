import type { Prisma, PrismaClient } from '@prisma/client';
import type { Entitlements, PlanVersion, Repositories } from './repositories';

// Prisma 实现（需要真实 PostgreSQL 才能验证）。
export function createPrismaRepositories(db: PrismaClient): Repositories {
  return {
    accounts: {
      create: (a) => db.account.create({ data: a }),
      list: () => db.account.findMany({ orderBy: { createdAt: 'desc' } }),
      setDisabled: async (id, at) => { await db.account.update({ where: { id }, data: { disabledAt: at } }); },
      findById: (id) => db.account.findUnique({ where: { id } }),
      findByEmail: (email) => db.account.findUnique({ where: { email } }),
      delete: async (id) => { await db.account.delete({ where: { id } }); },
    },
    invites: {
      create: (i) => db.inviteCode.create({ data: i }),
      findByCode: (code) => db.inviteCode.findUnique({ where: { code } }),
      list: () => db.inviteCode.findMany({ orderBy: { createdAt: 'desc' } }),
      findById: (id) => db.inviteCode.findUnique({ where: { id } }),
      async revoke(id, now) {
        const r = await db.inviteCode.updateMany({ where: { id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        return r.count === 1;
      },
      async consume(code, accountId, now) {
        // 条件更新：并发下只有一个请求能把 usedAt 从 NULL 改掉
        const r = await db.inviteCode.updateMany({
          where: { code, usedAt: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          data: { usedAt: now, usedById: accountId },
        });
        return r.count === 1;
      },
    },
    devices: {
      upsert: (accountId, fingerprint, name) =>
        db.device.upsert({
          where: { accountId_fingerprint: { accountId, fingerprint } },
          create: { accountId, fingerprint, name },
          update: { name },
        }),
      async registerLimited(accountId, fingerprint, name, maxDevices) {
        return db.$transaction(async (tx) => {
          await lockAccount(tx, accountId);
          const existing = await tx.device.findUnique({ where: { accountId_fingerprint: { accountId, fingerprint } } });
          if (existing) {
            const device = await tx.device.update({ where: { id: existing.id }, data: { name } });
            return { ok: true as const, device, created: false };
          }
          const active = await tx.device.count({ where: { accountId, revokedAt: null } });
          if (active >= maxDevices) return { ok: false as const, reason: 'limit' as const };
          const device = await tx.device.create({ data: { accountId, fingerprint, name } });
          return { ok: true as const, device, created: true };
        });
      },
      findById: (id) => db.device.findUnique({ where: { id } }),
      listByAccount: (accountId) => db.device.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
      touch: async (id, now) => { await db.device.update({ where: { id }, data: { lastSeenAt: now } }); },
      revoke: async (id, now) => { await db.device.update({ where: { id }, data: { revokedAt: now } }); },
    },
    refreshTokens: {
      create: (t) => db.refreshToken.create({ data: t }),
      findByHash: (tokenHash) => db.refreshToken.findUnique({ where: { tokenHash } }),
      async markUsed(id, now) {
        const r = await db.refreshToken.updateMany({
          where: { id, usedAt: null, revokedAt: null },
          data: { usedAt: now },
        });
        return r.count === 1;
      },
      async revokeFamily(familyId, now) {
        await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
      },
      async revokeAllForAccount(accountId, now) {
        await db.refreshToken.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } });
      },
    },
    settings: {
      async get<T>(key: string) {
        const r = await db.setting.findUnique({ where: { key } });
        return r ? (r.value as T) : null;
      },
      async set(key, value) {
        const v = value as Prisma.InputJsonValue;
        await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
      },
    },
    telemetry: {
      async addMany(rows) { await db.telemetryEvent.createMany({ data: rows }); },
      since: (fromDay) => db.telemetryEvent.findMany({
        where: { day: { gte: fromDay } },
        select: { at: true, day: true, installId: true, name: true, code: true, step: true },
      }),
    },
    feedback: {
      create: async (f) => {
        const r = await db.feedback.create({ data: { ...f, diagnostic: f.diagnostic ? new Uint8Array(f.diagnostic) : null } });
        return { ...r, diagnostic: r.diagnostic ? Buffer.from(r.diagnostic) : null };
      },
      list: (limit) => db.feedback.findMany({
        orderBy: { createdAt: 'desc' }, take: limit,
        select: { id: true, createdAt: true, accountId: true, installId: true, contact: true, message: true, taskId: true, appVersion: true, diagnosticSize: true },
      }),
      async findById(id) {
        const r = await db.feedback.findUnique({ where: { id } });
        return r ? { ...r, diagnostic: r.diagnostic ? Buffer.from(r.diagnostic) : null } : null;
      },
    },
    referralClicks: {
      create: (c) => db.referralClick.create({ data: c }),
      countByCode: (code) => db.referralClick.count({ where: { code } }),
    },
    plans: {
      create: (p) => db.plan.create({ data: p }),
      async setEnabled(code, enabled) {
        const r = await db.plan.updateMany({ where: { code }, data: { enabled } });
        return r.count === 1;
      },
      findByCode: (code) => db.plan.findUnique({ where: { code } }),
      async addVersion(planId, v) {
        // 版本号 = max + 1；同一计划并发新增靠 (planId, version) 唯一键兜底（后到者报错重试即可）
        const row = await db.$transaction(async (tx) => {
          const max = await tx.planVersion.aggregate({ where: { planId }, _max: { version: true } });
          return tx.planVersion.create({
            data: {
              planId, version: (max._max.version ?? 0) + 1,
              priceMonthCents: v.priceMonthCents, priceYearCents: v.priceYearCents,
              entitlements: v.entitlements as unknown as Prisma.InputJsonValue,
            },
            include: { plan: { select: { code: true } } },
          });
        });
        return toPlanVersion(row);
      },
      async findVersion(id) {
        const r = await db.planVersion.findUnique({ where: { id }, include: { plan: { select: { code: true } } } });
        return r ? toPlanVersion(r) : null;
      },
      async latestVersion(planId) {
        const r = await db.planVersion.findFirst({
          where: { planId }, orderBy: { version: 'desc' }, include: { plan: { select: { code: true } } },
        });
        return r ? toPlanVersion(r) : null;
      },
      async list() {
        const rows = await db.plan.findMany({
          orderBy: { createdAt: 'asc' },
          include: { versions: { orderBy: { version: 'asc' } } },
        });
        return rows.map(({ versions, ...plan }) => ({
          plan,
          versions: versions.map((v) => toPlanVersion({ ...v, plan: { code: plan.code } })),
        }));
      },
    },
    orders: {
      create: (o) => db.order.create({ data: o }),
      findById: (id) => db.order.findUnique({ where: { id } }),
      findByOutTradeNo: (outTradeNo) => db.order.findUnique({ where: { outTradeNo } }),
      listByAccount: (accountId) => db.order.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' } }),
      list: (f) => db.order.findMany({
        where: { status: f.status, accountId: f.accountId }, orderBy: { createdAt: 'desc' }, take: f.limit,
      }),
      setCodeUrl: async (id, codeUrl) => { await db.order.update({ where: { id }, data: { codeUrl } }); },
      async close(id) {
        const r = await db.order.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CLOSED' } });
        return r.count === 1;
      },
      findPayment: (orderId) => db.payment.findUnique({ where: { orderId } }),
    },
    subscriptions: {
      findByAccount: (accountId) => db.subscription.findUnique({ where: { accountId } }),
    },
    refunds: {
      findById: (id) => db.refund.findUnique({ where: { id } }),
      listByOrder: (orderId) => db.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
      list: (limit) => db.refund.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
    },
    invoices: {
      create: ({ now, ...i }) => db.invoice.create({
        data: { ...i, createdAt: now, issuedAt: i.status === 'ISSUED' ? now : null },
      }),
      findById: (id) => db.invoice.findUnique({ where: { id } }),
      findByOrder: (orderId) => db.invoice.findUnique({ where: { orderId } }),
      list: (f) => db.invoice.findMany({ where: { status: f.status }, orderBy: { createdAt: 'desc' }, take: f.limit }),
      async issue(id, invoiceNo, now) {
        const r = await db.invoice.updateMany({
          where: { id, status: 'REQUESTED' }, data: { status: 'ISSUED', invoiceNo, issuedAt: now },
        });
        return r.count === 1;
      },
      async void(id, now) {
        const r = await db.invoice.updateMany({
          where: { id, status: { in: ['REQUESTED', 'ISSUED'] } }, data: { status: 'VOID', voidedAt: now },
        });
        return r.count === 1;
      },
    },
    licenceUsage: {
      record: async (u) => { await db.licenceUsage.create({ data: u }); },
      listByAccount: (accountId, limit) => db.licenceUsage.findMany({
        where: { accountId }, orderBy: { issuedAt: 'desc' }, take: limit,
      }),
      countByAccount: (accountId) => db.licenceUsage.count({ where: { accountId } }),
    },
    billing: {
      async settlePaid(i) {
        const pre = await db.order.findUnique({ where: { outTradeNo: i.outTradeNo } });
        if (!pre) return { outcome: 'not_found' as const };
        try {
          return await db.$transaction(async (tx) => {
            // 先锁账号行：同一账号的所有结算/退款在此串行；之后读到的订阅、订单状态都是最新的
            await lockAccount(tx, pre.accountId);
            // 回调登记与生效同事务：重复回调在这里撞唯一键，整体回滚，不会重复生效
            await tx.paymentNotification.create({
              data: { provider: i.provider, notifyId: i.notifyId, outTradeNo: i.outTradeNo },
            });
            const claimed = await tx.order.updateMany({
              where: { id: pre.id, status: { in: ['PENDING', 'CLOSED'] } },
              data: { status: 'PAID', paidAt: i.paidAt },
            });
            if (claimed.count !== 1) {
              const order = await tx.order.findUniqueOrThrow({ where: { id: pre.id } });
              return { outcome: 'already_settled' as const, order };
            }
            const cur = await tx.subscription.findUnique({ where: { accountId: pre.accountId } });
            const orderNow = await tx.order.findUniqueOrThrow({ where: { id: pre.id } });
            const period = i.periodFor(cur, orderNow);
            const order = await tx.order.update({
              where: { id: pre.id }, data: { periodStart: period.start, periodEnd: period.end },
            });
            await tx.payment.create({
              data: {
                orderId: pre.id, provider: i.provider, tradeNo: i.tradeNo,
                amountCents: i.amountCents, paidAt: i.paidAt,
              },
            });
            const renewing = cur ? cur.currentPeriodEnd.getTime() > i.paidAt.getTime() : false;
            const subscription = cur
              ? await tx.subscription.update({
                where: { accountId: pre.accountId },
                data: {
                  planVersionId: order.planVersionId,
                  currentPeriodEnd: period.end,
                  ...(renewing ? {} : { currentPeriodStart: period.start }),
                },
              })
              : await tx.subscription.create({
                data: {
                  accountId: pre.accountId, planVersionId: order.planVersionId,
                  currentPeriodStart: period.start, currentPeriodEnd: period.end,
                },
              });
            return { outcome: 'applied' as const, order, subscription };
          });
        } catch (e) {
          if (isUniqueViolation(e, ['provider', 'notifyId'])) return { outcome: 'duplicate_notify' as const };
          throw e;
        }
      },
      async beginRefund(i) {
        const pre = await db.order.findUnique({ where: { id: i.orderId } });
        if (!pre) return null;
        return db.$transaction(async (tx) => {
          await lockAccount(tx, pre.accountId);
          const gate = await tx.order.updateMany({ where: { id: i.orderId, status: 'PAID' }, data: { status: 'REFUNDING' } });
          if (gate.count !== 1) return null;
          return tx.refund.create({
            data: {
              orderId: i.orderId, outRefundNo: i.outRefundNo, amountCents: i.amountCents,
              reason: i.reason, createdBy: i.createdBy, createdAt: i.now,
            },
          });
        });
      },
      async finishRefund(refundId, i) {
        const pre = await db.refund.findUnique({ where: { id: refundId }, include: { order: true } });
        if (!pre) return null;
        return db.$transaction(async (tx) => {
          await lockAccount(tx, pre.order.accountId);
          const done = await tx.refund.updateMany({
            where: { id: refundId, status: 'PENDING' },
            data: { status: 'SUCCESS', providerRefundNo: i.providerRefundNo, finishedAt: i.now },
          });
          if (done.count !== 1) return null;
          await tx.order.update({ where: { id: pre.orderId }, data: { status: 'REFUNDED' } });
          const sub = await tx.subscription.findUnique({ where: { accountId: pre.order.accountId } });
          let subscription = sub;
          if (sub) {
            let end = sub.currentPeriodEnd.getTime() - i.cutMs;
            if (end < i.now.getTime()) end = Math.min(sub.currentPeriodEnd.getTime(), i.now.getTime());
            subscription = await tx.subscription.update({
              where: { accountId: sub.accountId }, data: { currentPeriodEnd: new Date(end) },
            });
          }
          const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
          return { refund, subscription };
        });
      },
      async failRefund(refundId, i) {
        const pre = await db.refund.findUnique({ where: { id: refundId }, include: { order: true } });
        if (!pre) return false;
        return db.$transaction(async (tx) => {
          await lockAccount(tx, pre.order.accountId);
          const done = await tx.refund.updateMany({
            where: { id: refundId, status: 'PENDING' },
            data: { status: 'FAILED', failureReason: i.reason, finishedAt: i.now },
          });
          if (done.count !== 1) return false;
          await tx.order.updateMany({ where: { id: pre.orderId, status: 'REFUNDING' }, data: { status: 'PAID' } });
          return true;
        });
      },
    },
  };
}

type Tx = Prisma.TransactionClient;

/** 行级锁（SELECT ... FOR UPDATE）：同账号的并发结算/退款/设备注册在此排队。 */
async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
}

function isUniqueViolation(e: unknown, fields: string[]): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? fields.every((f) => target.includes(f)) : true;
}

function toPlanVersion(r: {
  id: string; planId: string; version: number; priceMonthCents: number | null; priceYearCents: number | null;
  entitlements: Prisma.JsonValue; createdAt: Date; plan: { code: string };
}): PlanVersion {
  return {
    id: r.id, planId: r.planId, planCode: r.plan.code, version: r.version,
    priceMonthCents: r.priceMonthCents, priceYearCents: r.priceYearCents,
    entitlements: r.entitlements as unknown as Entitlements, createdAt: r.createdAt,
  };
}
