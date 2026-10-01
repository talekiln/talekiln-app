import { randomUUID } from 'node:crypto';
import type {
  Account, Device, FeedbackRecord, InvoiceRecord, InviteCode, LicenceUsageRecord, OrderRecord, PaymentRecord,
  Plan, PlanVersion, RefreshTokenRecord, RefundRecord, Repositories, Subscription, TelemetryRow,
} from './repositories';

// 内存实现：仅用于测试（单线程 JS 下每个方法体天然原子）。
export function createMemoryRepositories(): Repositories {
  const accounts = new Map<string, Account>();
  const invites = new Map<string, InviteCode>();
  const devices = new Map<string, Device>();
  const tokens = new Map<string, RefreshTokenRecord>();
  const settings = new Map<string, unknown>();
  const telemetry: TelemetryRow[] = [];
  const feedback = new Map<string, FeedbackRecord>();
  const clicks: { id: string; code: string; src: string | null; createdAt: Date }[] = [];
  const plans = new Map<string, Plan>();
  const versions = new Map<string, PlanVersion>();
  const subs = new Map<string, Subscription>(); // key: accountId
  const orders = new Map<string, OrderRecord>();
  const payments = new Map<string, PaymentRecord>(); // key: orderId
  const refunds = new Map<string, RefundRecord>();
  const invoices = new Map<string, InvoiceRecord>();
  const usages: LicenceUsageRecord[] = [];
  const notifications = new Set<string>();
  const clone = <T extends object>(x: T): T => structuredClone(x);
  const cloneOrNull = <T extends object>(x: T | undefined | null): T | null => (x ? structuredClone(x) : null);

  return {
    accounts: {
      async create(a) {
        for (const x of accounts.values()) if (x.email === a.email) throw new Error('unique:email');
        const rec: Account = { ...a, disabledAt: a.disabledAt ?? null, id: randomUUID(), createdAt: new Date() };
        accounts.set(rec.id, rec);
        return { ...rec };
      },
      async findById(id) { const r = accounts.get(id); return r ? { ...r } : null; },
      async findByEmail(email) {
        for (const x of accounts.values()) if (x.email === email) return { ...x };
        return null;
      },
      async list() { return [...accounts.values()].map((x) => ({ ...x })); },
      async setDisabled(id, at) { const a = accounts.get(id); if (a) a.disabledAt = at; },
      async delete(id) {
        // 与数据库外键语义一致：设备/刷新令牌级联删除，邀请码的使用者置空
        accounts.delete(id);
        for (const [k, d] of devices) if (d.accountId === id) devices.delete(k);
        for (const [k, t] of tokens) if (t.accountId === id) tokens.delete(k);
        for (const i of invites.values()) if (i.usedById === id) i.usedById = null;
        subs.delete(id);
        for (let n = usages.length - 1; n >= 0; n--) if (usages[n].accountId === id) usages.splice(n, 1);
      },
    },
    invites: {
      async create(i) {
        for (const x of invites.values()) if (x.code === i.code) throw new Error('unique:code');
        const rec: InviteCode = { ...i, id: randomUUID(), createdAt: new Date(), usedAt: null, usedById: null, revokedAt: null };
        invites.set(rec.id, rec);
        return { ...rec };
      },
      async findByCode(code) {
        for (const x of invites.values()) if (x.code === code) return { ...x };
        return null;
      },
      async list() { return [...invites.values()].map((x) => ({ ...x })); },
      async findById(id) { const r = invites.get(id); return r ? { ...r } : null; },
      async revoke(id, now) {
        const x = invites.get(id);
        if (!x || x.usedAt || x.revokedAt) return false;
        x.revokedAt = now;
        return true;
      },
      async consume(code, accountId, now) {
        for (const x of invites.values()) {
          if (x.code !== code) continue;
          if (x.usedAt || x.revokedAt || (x.expiresAt && x.expiresAt <= now)) return false;
          x.usedAt = now;
          x.usedById = accountId;
          return true;
        }
        return false;
      },
    },
    devices: {
      async upsert(accountId, fingerprint, name) {
        for (const x of devices.values()) {
          if (x.accountId === accountId && x.fingerprint === fingerprint) {
            x.name = name;
            return { ...x };
          }
        }
        const rec: Device = {
          id: randomUUID(), accountId, fingerprint, name,
          createdAt: new Date(), lastSeenAt: null, revokedAt: null,
        };
        devices.set(rec.id, rec);
        return { ...rec };
      },
      async registerLimited(accountId, fingerprint, name, maxDevices) {
        // 方法体内无 await，天然原子（对应 PG 实现里的账号行锁）
        for (const x of devices.values()) {
          if (x.accountId === accountId && x.fingerprint === fingerprint) {
            x.name = name;
            return { ok: true as const, device: { ...x }, created: false };
          }
        }
        const active = [...devices.values()].filter((d) => d.accountId === accountId && !d.revokedAt).length;
        if (active >= maxDevices) return { ok: false as const, reason: 'limit' as const };
        const rec: Device = {
          id: randomUUID(), accountId, fingerprint, name,
          createdAt: new Date(), lastSeenAt: null, revokedAt: null,
        };
        devices.set(rec.id, rec);
        return { ok: true as const, device: { ...rec }, created: true };
      },
      async findById(id) { const r = devices.get(id); return r ? { ...r } : null; },
      async listByAccount(accountId) {
        return [...devices.values()].filter((d) => d.accountId === accountId).map((d) => ({ ...d }));
      },
      async touch(id, now) { const d = devices.get(id); if (d) d.lastSeenAt = now; },
      async revoke(id, now) { const d = devices.get(id); if (d) d.revokedAt = now; },
    },
    refreshTokens: {
      async create(t) {
        for (const x of tokens.values()) if (x.tokenHash === t.tokenHash) throw new Error('unique:tokenHash');
        const rec: RefreshTokenRecord = { ...t, id: randomUUID(), createdAt: new Date(), usedAt: null, revokedAt: null };
        tokens.set(rec.id, rec);
        return { ...rec };
      },
      async findByHash(hash) {
        for (const x of tokens.values()) if (x.tokenHash === hash) return { ...x };
        return null;
      },
      async markUsed(id, now) {
        const t = tokens.get(id);
        if (!t || t.usedAt || t.revokedAt) return false;
        t.usedAt = now;
        return true;
      },
      async revokeFamily(familyId, now) {
        for (const t of tokens.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = now;
      },
      async revokeAllForAccount(accountId, now) {
        for (const t of tokens.values()) if (t.accountId === accountId && !t.revokedAt) t.revokedAt = now;
      },
    },
    settings: {
      async get<T>(key: string) { return settings.has(key) ? (structuredClone(settings.get(key)) as T) : null; },
      async set(key, value) { settings.set(key, structuredClone(value)); },
    },
    telemetry: {
      async addMany(rows) { telemetry.push(...rows.map((r) => ({ ...r }))); },
      async since(fromDay) { return telemetry.filter((r) => r.day >= fromDay).map((r) => ({ ...r })); },
    },
    feedback: {
      async create(f) {
        const rec: FeedbackRecord = { ...f, id: randomUUID(), createdAt: new Date() };
        feedback.set(rec.id, rec);
        return { ...rec };
      },
      async list(limit) {
        return [...feedback.values()].reverse().slice(0, limit).map(({ diagnostic: _d, ...rest }) => ({ ...rest }));
      },
      async findById(id) { const r = feedback.get(id); return r ? { ...r } : null; },
    },
    referralClicks: {
      async create(c) { const rec = { ...c, id: randomUUID() }; clicks.push(rec); return { ...rec }; },
      async countByCode(code) { return clicks.filter((x) => x.code === code).length; },
    },
    plans: {
      async create(p) {
        for (const x of plans.values()) if (x.code === p.code) throw new Error('unique:code');
        const rec: Plan = { id: randomUUID(), code: p.code, name: p.name, enabled: true, createdAt: new Date() };
        plans.set(rec.id, rec);
        return { ...rec };
      },
      async setEnabled(code, enabled) {
        for (const x of plans.values()) if (x.code === code) { x.enabled = enabled; return true; }
        return false;
      },
      async findByCode(code) {
        for (const x of plans.values()) if (x.code === code) return { ...x };
        return null;
      },
      async addVersion(planId, v) {
        const plan = plans.get(planId);
        if (!plan) throw new Error('fk:planId');
        const max = Math.max(0, ...[...versions.values()].filter((x) => x.planId === planId).map((x) => x.version));
        const rec: PlanVersion = { id: randomUUID(), planId, planCode: plan.code, version: max + 1, ...clone(v), createdAt: new Date() };
        versions.set(rec.id, rec);
        return clone(rec);
      },
      async findVersion(id) { return cloneOrNull(versions.get(id)); },
      async latestVersion(planId) {
        const vs = [...versions.values()].filter((x) => x.planId === planId).sort((a, b) => b.version - a.version);
        return cloneOrNull(vs[0]);
      },
      async list() {
        return [...plans.values()].map((plan) => ({
          plan: { ...plan },
          versions: [...versions.values()].filter((v) => v.planId === plan.id).sort((a, b) => a.version - b.version).map(clone),
        }));
      },
    },
    orders: {
      async create(o) {
        for (const x of orders.values()) if (x.outTradeNo === o.outTradeNo) throw new Error('unique:outTradeNo');
        const rec: OrderRecord = {
          ...o, id: randomUUID(), status: 'PENDING', codeUrl: null, paidAt: null, periodStart: null, periodEnd: null,
        };
        orders.set(rec.id, rec);
        return clone(rec);
      },
      async findById(id) { return cloneOrNull(orders.get(id)); },
      async findByOutTradeNo(n) {
        for (const x of orders.values()) if (x.outTradeNo === n) return clone(x);
        return null;
      },
      async listByAccount(accountId) {
        return [...orders.values()].filter((o) => o.accountId === accountId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(clone);
      },
      async list(f) {
        return [...orders.values()]
          .filter((o) => (!f.status || o.status === f.status) && (!f.accountId || o.accountId === f.accountId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, f.limit).map(clone);
      },
      async setCodeUrl(id, codeUrl) { const o = orders.get(id); if (o) o.codeUrl = codeUrl; },
      async close(id, _now) {
        const o = orders.get(id);
        if (!o || o.status !== 'PENDING') return false;
        o.status = 'CLOSED';
        return true;
      },
      async findPayment(orderId) { return cloneOrNull(payments.get(orderId)); },
    },
    subscriptions: {
      async findByAccount(accountId) { return cloneOrNull(subs.get(accountId)); },
    },
    refunds: {
      async findById(id) { return cloneOrNull(refunds.get(id)); },
      async listByOrder(orderId) {
        return [...refunds.values()].filter((r) => r.orderId === orderId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
      },
      async list(limit) {
        return [...refunds.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(clone);
      },
    },
    invoices: {
      async create(i) {
        for (const x of invoices.values()) if (x.orderId === i.orderId) throw new Error('unique:orderId');
        const { now, ...rest } = i;
        const rec: InvoiceRecord = {
          ...rest, id: randomUUID(), createdAt: now,
          issuedAt: i.status === 'ISSUED' ? now : null, voidedAt: null,
        };
        invoices.set(rec.id, rec);
        return clone(rec);
      },
      async findById(id) { return cloneOrNull(invoices.get(id)); },
      async findByOrder(orderId) {
        for (const x of invoices.values()) if (x.orderId === orderId) return clone(x);
        return null;
      },
      async list(f) {
        return [...invoices.values()].filter((x) => !f.status || x.status === f.status)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, f.limit).map(clone);
      },
      async issue(id, invoiceNo, now) {
        const x = invoices.get(id);
        if (!x || x.status !== 'REQUESTED') return false;
        x.status = 'ISSUED'; x.invoiceNo = invoiceNo; x.issuedAt = now;
        return true;
      },
      async void(id, now) {
        const x = invoices.get(id);
        if (!x || x.status === 'VOID') return false;
        x.status = 'VOID'; x.voidedAt = now;
        return true;
      },
    },
    licenceUsage: {
      async record(u) { usages.push({ ...u, id: randomUUID() }); },
      async listByAccount(accountId, limit) {
        return usages.filter((u) => u.accountId === accountId)
          .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()).slice(0, limit).map(clone);
      },
      async countByAccount(accountId) { return usages.filter((u) => u.accountId === accountId).length; },
    },
    billing: {
      // 以下方法体内没有 await：单线程下每个方法天然原子，语义与 Prisma 实现（账号行锁 + 事务）一致。
      async settlePaid(i) {
        let order: OrderRecord | undefined;
        for (const x of orders.values()) if (x.outTradeNo === i.outTradeNo) order = x;
        if (!order) return { outcome: 'not_found' as const };
        const key = `${i.provider}|${i.notifyId}`;
        if (notifications.has(key)) return { outcome: 'duplicate_notify' as const };
        for (const p of payments.values()) {
          if (p.provider === i.provider && p.tradeNo === i.tradeNo && p.orderId !== order.id) throw new Error('unique:payment');
        }
        notifications.add(key);
        if (order.status !== 'PENDING' && order.status !== 'CLOSED') {
          return { outcome: 'already_settled' as const, order: clone(order) };
        }
        const cur = subs.get(order.accountId) ?? null;
        const period = i.periodFor(cur ? clone(cur) : null, clone(order));
        order.status = 'PAID';
        order.paidAt = i.paidAt;
        order.periodStart = period.start;
        order.periodEnd = period.end;
        payments.set(order.id, {
          id: randomUUID(), orderId: order.id, provider: i.provider, tradeNo: i.tradeNo,
          amountCents: i.amountCents, paidAt: i.paidAt, createdAt: new Date(),
        });
        let sub = cur;
        if (sub) {
          const renewing = sub.currentPeriodEnd.getTime() > i.paidAt.getTime();
          sub.planVersionId = order.planVersionId;
          sub.currentPeriodEnd = period.end;
          if (!renewing) sub.currentPeriodStart = period.start;
        } else {
          sub = {
            id: randomUUID(), accountId: order.accountId, planVersionId: order.planVersionId,
            currentPeriodStart: period.start, currentPeriodEnd: period.end, createdAt: new Date(),
          };
          subs.set(order.accountId, sub);
        }
        return { outcome: 'applied' as const, order: clone(order), subscription: clone(sub) };
      },
      async beginRefund(i) {
        const order = orders.get(i.orderId);
        if (!order || order.status !== 'PAID') return null;
        for (const r of refunds.values()) if (r.outRefundNo === i.outRefundNo) throw new Error('unique:outRefundNo');
        order.status = 'REFUNDING';
        const rec: RefundRecord = {
          id: randomUUID(), orderId: i.orderId, outRefundNo: i.outRefundNo, amountCents: i.amountCents,
          status: 'PENDING', reason: i.reason, providerRefundNo: null, failureReason: null,
          createdBy: i.createdBy, createdAt: i.now, finishedAt: null,
        };
        refunds.set(rec.id, rec);
        return clone(rec);
      },
      async finishRefund(refundId, i) {
        const refund = refunds.get(refundId);
        if (!refund || refund.status !== 'PENDING') return null;
        const order = orders.get(refund.orderId)!;
        refund.status = 'SUCCESS';
        refund.providerRefundNo = i.providerRefundNo;
        refund.finishedAt = i.now;
        order.status = 'REFUNDED';
        const sub = subs.get(order.accountId) ?? null;
        if (sub) {
          let end = sub.currentPeriodEnd.getTime() - i.cutMs;
          if (end < i.now.getTime()) end = Math.min(sub.currentPeriodEnd.getTime(), i.now.getTime());
          sub.currentPeriodEnd = new Date(end);
        }
        return { refund: clone(refund), subscription: sub ? clone(sub) : null };
      },
      async failRefund(refundId, i) {
        const refund = refunds.get(refundId);
        if (!refund || refund.status !== 'PENDING') return false;
        refund.status = 'FAILED';
        refund.failureReason = i.reason;
        refund.finishedAt = i.now;
        const order = orders.get(refund.orderId);
        if (order && order.status === 'REFUNDING') order.status = 'PAID';
        return true;
      },
    },
  };
}
