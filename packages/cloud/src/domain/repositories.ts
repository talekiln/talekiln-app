// 领域类型与仓储接口：业务逻辑只依赖这些接口，测试用内存实现，生产用 Prisma 实现。
export type Role = 'USER' | 'ADMIN';

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  plan: string;
  disabledAt: Date | null;
  createdAt: Date;
}

export interface InviteCode {
  id: string;
  code: string;
  plan: string;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  usedById: string | null;
  revokedAt: Date | null;
}

export interface Device {
  id: string;
  accountId: string;
  fingerprint: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface RefreshTokenRecord {
  id: string;
  familyId: string;
  accountId: string;
  deviceId: string | null;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface AccountRepository {
  create(a: Omit<Account, 'id' | 'createdAt' | 'disabledAt'> & { disabledAt?: Date | null }): Promise<Account>;
  list(): Promise<Account[]>;
  setDisabled(id: string, at: Date | null): Promise<void>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  delete(id: string): Promise<void>;
}

export interface InviteRepository {
  create(i: { code: string; plan: string; createdBy: string | null; expiresAt: Date | null }): Promise<InviteCode>;
  findByCode(code: string): Promise<InviteCode | null>;
  list(): Promise<InviteCode[]>;
  findById(id: string): Promise<InviteCode | null>;
  /** 仅当邀请码未使用且未吊销时吊销，返回是否成功。 */
  revoke(id: string, now: Date): Promise<boolean>;
  /** 原子地标记使用：仅当 usedAt 为空且未过期时成功，返回是否抢到。 */
  consume(code: string, accountId: string, now: Date): Promise<boolean>;
}

export type RegisterDeviceResult = { ok: true; device: Device; created: boolean } | { ok: false; reason: 'limit' };

export interface DeviceRepository {
  upsert(accountId: string, fingerprint: string, name: string): Promise<Device>;
  /**
   * 带上限的注册（并发安全：同一账号的注册串行化）。已存在的设备（含已吊销）直接返回；
   * 新设备仅当该账号未吊销设备数 < maxDevices 时创建，否则 reason: 'limit'。
   */
  registerLimited(accountId: string, fingerprint: string, name: string, maxDevices: number): Promise<RegisterDeviceResult>;
  findById(id: string): Promise<Device | null>;
  listByAccount(accountId: string): Promise<Device[]>;
  touch(id: string, now: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<void>;
}

export interface RefreshTokenRepository {
  create(t: Omit<RefreshTokenRecord, 'id' | 'createdAt' | 'usedAt' | 'revokedAt'>): Promise<RefreshTokenRecord>;
  findByHash(hash: string): Promise<RefreshTokenRecord | null>;
  /** 原子地标记已使用：仅当 usedAt 与 revokedAt 均为空时成功。 */
  markUsed(id: string, now: Date): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeAllForAccount(accountId: string, now: Date): Promise<void>;
}

export interface SettingRepository {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface TelemetryRow {
  at: Date;
  day: string;
  installId: string;
  name: string;
  code: string | null;
  step: string | null;
}

export interface TelemetryRepository {
  addMany(rows: TelemetryRow[]): Promise<void>;
  /** 返回 day >= fromDay（含）的事件，day 为 YYYY-MM-DD（UTC）。 */
  since(fromDay: string): Promise<TelemetryRow[]>;
}

export interface FeedbackRecord {
  id: string;
  createdAt: Date;
  accountId: string | null;
  installId: string | null;
  contact: string | null;
  message: string;
  taskId: string | null;
  appVersion: string | null;
  diagnostic: Buffer | null;
  diagnosticSize: number;
}

export interface FeedbackRepository {
  create(f: Omit<FeedbackRecord, 'id' | 'createdAt'>): Promise<FeedbackRecord>;
  /** 列表不带诊断包内容。 */
  list(limit: number): Promise<Omit<FeedbackRecord, 'diagnostic'>[]>;
  findById(id: string): Promise<FeedbackRecord | null>;
}

export interface ReferralClick { id: string; code: string; src: string | null; createdAt: Date }

export interface ReferralClickRepository {
  create(c: { code: string; src: string | null; createdAt: Date }): Promise<ReferralClick>;
  countByCode(code: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// 收费与授权（P2-B）。金额一律为整数分。
// ---------------------------------------------------------------------------
export type BillingPeriod = 'MONTH' | 'YEAR';
export type OrderStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDING' | 'REFUNDED';
export type RefundStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type InvoiceStatus = 'REQUESTED' | 'ISSUED' | 'VOID';

export interface Entitlements {
  maxDevices: number;
  /** 导出最大高度（像素），如 720 / 2160。 */
  exportMaxHeight: number;
  watermark: boolean;
  features: string[];
}

export interface Plan { id: string; code: string; name: string; enabled: boolean; createdAt: Date }

export interface PlanVersion {
  id: string;
  planId: string;
  planCode: string;
  version: number;
  priceMonthCents: number | null;
  priceYearCents: number | null;
  entitlements: Entitlements;
  createdAt: Date;
}

export interface Subscription {
  id: string;
  accountId: string;
  planVersionId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  createdAt: Date;
}

export interface OrderRecord {
  id: string;
  outTradeNo: string;
  accountId: string;
  planVersionId: string;
  period: BillingPeriod;
  amountCents: number;
  provider: string;
  status: OrderStatus;
  codeUrl: string | null;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  provider: string;
  tradeNo: string;
  amountCents: number;
  paidAt: Date;
  createdAt: Date;
}

export interface RefundRecord {
  id: string;
  orderId: string;
  outRefundNo: string;
  amountCents: number;
  status: RefundStatus;
  reason: string | null;
  providerRefundNo: string | null;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface InvoiceRecord {
  id: string;
  orderId: string;
  title: string;
  taxNo: string | null;
  email: string;
  amountCents: number;
  status: InvoiceStatus;
  invoiceNo: string | null;
  createdAt: Date;
  issuedAt: Date | null;
  voidedAt: Date | null;
}

export interface LicenceUsageRecord {
  id: string;
  accountId: string;
  deviceId: string;
  planCode: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface PlanRepository {
  /** code 重复抛唯一键错误。 */
  create(p: { code: string; name: string }): Promise<Plan>;
  setEnabled(code: string, enabled: boolean): Promise<boolean>;
  findByCode(code: string): Promise<Plan | null>;
  /** 新增版本，版本号 = 现有最大值 + 1。 */
  addVersion(planId: string, v: { priceMonthCents: number | null; priceYearCents: number | null; entitlements: Entitlements }): Promise<PlanVersion>;
  findVersion(id: string): Promise<PlanVersion | null>;
  latestVersion(planId: string): Promise<PlanVersion | null>;
  /** 全部套餐及其版本（版本按号升序）。 */
  list(): Promise<{ plan: Plan; versions: PlanVersion[] }[]>;
}

export interface OrderRepository {
  create(o: {
    outTradeNo: string; accountId: string; planVersionId: string; period: BillingPeriod;
    amountCents: number; provider: string; createdAt: Date; expiresAt: Date;
  }): Promise<OrderRecord>;
  findById(id: string): Promise<OrderRecord | null>;
  findByOutTradeNo(outTradeNo: string): Promise<OrderRecord | null>;
  listByAccount(accountId: string): Promise<OrderRecord[]>;
  list(filter: { status?: OrderStatus; accountId?: string; limit: number }): Promise<OrderRecord[]>;
  setCodeUrl(id: string, codeUrl: string): Promise<void>;
  /** 仅当 PENDING 时关闭，返回是否成功。 */
  close(id: string, now: Date): Promise<boolean>;
  findPayment(orderId: string): Promise<PaymentRecord | null>;
}

export interface SubscriptionRepository {
  findByAccount(accountId: string): Promise<Subscription | null>;
}

export interface RefundRepository {
  findById(id: string): Promise<RefundRecord | null>;
  listByOrder(orderId: string): Promise<RefundRecord[]>;
  list(limit: number): Promise<RefundRecord[]>;
}

export interface InvoiceRepository {
  /** 每单一张发票；重复抛唯一键错误。 */
  create(i: { orderId: string; title: string; taxNo: string | null; email: string; amountCents: number; status: InvoiceStatus; invoiceNo: string | null; now: Date }): Promise<InvoiceRecord>;
  findById(id: string): Promise<InvoiceRecord | null>;
  findByOrder(orderId: string): Promise<InvoiceRecord | null>;
  list(filter: { status?: InvoiceStatus; limit: number }): Promise<InvoiceRecord[]>;
  /** REQUESTED -> ISSUED。 */
  issue(id: string, invoiceNo: string, now: Date): Promise<boolean>;
  /** REQUESTED/ISSUED -> VOID。 */
  void(id: string, now: Date): Promise<boolean>;
}

export interface LicenceUsageRepository {
  record(u: Omit<LicenceUsageRecord, 'id'>): Promise<void>;
  listByAccount(accountId: string, limit: number): Promise<LicenceUsageRecord[]>;
  countByAccount(accountId: string): Promise<number>;
}

export interface SettleInput {
  provider: string;
  /** 回调去重键（微信 id / 支付宝 notify_id；主动查单用 query:<tradeNo>）。 */
  notifyId: string;
  outTradeNo: string;
  tradeNo: string;
  amountCents: number;
  paidAt: Date;
  /** 由服务层给出的授权区间算法：current 为事务内读到的当前订阅。 */
  periodFor: (current: Subscription | null, order: OrderRecord) => { start: Date; end: Date };
}

export type SettleResult =
  | { outcome: 'applied'; order: OrderRecord; subscription: Subscription }
  /** 同一 (provider, notifyId) 已处理过。 */
  | { outcome: 'duplicate_notify' }
  /** 订单已不是 PENDING/CLOSED（别的回调或主动查单已生效，或已退款）。 */
  | { outcome: 'already_settled'; order: OrderRecord }
  | { outcome: 'not_found' };

/** 跨表原子操作。实现必须保证：并发调用下每个动作至多生效一次，且同账号的订阅改写串行。 */
export interface BillingRepository {
  /**
   * 原子地：登记回调 -> 订单 PENDING/CLOSED => PAID -> 写 Payment -> 开通/续期订阅。
   * 任一步失败整体回滚，因此“回调已登记但未生效”的中间态不存在。
   */
  settlePaid(i: SettleInput): Promise<SettleResult>;
  /** 订单 PAID => REFUNDING 并建 PENDING 退款单；订单不是 PAID（含已有退款进行中）返回 null。 */
  beginRefund(i: { orderId: string; outRefundNo: string; amountCents: number; reason: string | null; createdBy: string | null; now: Date }): Promise<RefundRecord | null>;
  /** 退款成功：退款单 SUCCESS、订单 REFUNDED、订阅到期时间前移 cutMs（不早于 now）。 */
  finishRefund(refundId: string, i: { providerRefundNo: string; now: Date; cutMs: number }): Promise<{ refund: RefundRecord; subscription: Subscription | null } | null>;
  /** 退款失败：退款单 FAILED、订单回到 PAID。 */
  failRefund(refundId: string, i: { now: Date; reason: string }): Promise<boolean>;
}

export const REPOS = Symbol('REPOS');
export interface Repositories {
  accounts: AccountRepository;
  invites: InviteRepository;
  devices: DeviceRepository;
  refreshTokens: RefreshTokenRepository;
  settings: SettingRepository;
  telemetry: TelemetryRepository;
  feedback: FeedbackRepository;
  referralClicks: ReferralClickRepository;
  plans: PlanRepository;
  orders: OrderRepository;
  subscriptions: SubscriptionRepository;
  refunds: RefundRepository;
  invoices: InvoiceRepository;
  licenceUsage: LicenceUsageRepository;
  billing: BillingRepository;
}
