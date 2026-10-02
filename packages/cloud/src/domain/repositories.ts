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
  /** 手机号（P2-C 短信登录），11 位大陆号码，唯一；邮箱密码账号为空。 */
  phone: string | null;
  /** 微信 openid（P2-C 扫码登录），唯一。 */
  wechatOpenId: string | null;
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
  create(a: Omit<Account, 'id' | 'createdAt' | 'disabledAt' | 'phone' | 'wechatOpenId'> & { disabledAt?: Date | null; phone?: string | null; wechatOpenId?: string | null }): Promise<Account>;
  findByPhone(phone: string): Promise<Account | null>;
  findByWechatOpenId(openId: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  setDisabled(id: string, at: Date | null): Promise<void>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  delete(id: string): Promise<void>;
  /** 仅用于撤销/授予旧式 ADMIN 标记（后台角色以 AdminRole 表为准）。 */
  setRole(id: string, role: Role): Promise<void>;
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
  /** createdAt 落在 [from, to) 的点击（漏斗统计用）。 */
  between(from: Date, to: Date): Promise<ReferralClick[]>;
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

// ---------------------------------------------------------------------------
// 后台扩展（P2-H）：公告、版本灰度、管理员角色、审计。
// ---------------------------------------------------------------------------
export type ReleaseChannel = 'beta' | 'stable';
export type AnnouncementChannel = 'all' | ReleaseChannel;
export type AnnouncementLevel = 'info' | 'warn' | 'critical';
export type AdminRoleName = 'ADMIN' | 'OPERATOR' | 'READONLY';

export interface AnnouncementRecord {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  channel: AnnouncementChannel;
  startsAt: Date;
  endsAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type AnnouncementInput = Omit<AnnouncementRecord, 'id' | 'createdAt' | 'updatedAt'>;

export interface AnnouncementRepository {
  create(a: AnnouncementInput, now: Date): Promise<AnnouncementRecord>;
  update(id: string, patch: Partial<AnnouncementInput>, now: Date): Promise<AnnouncementRecord | null>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<AnnouncementRecord | null>;
  /** 全部公告，开始时间新的在前。 */
  list(): Promise<AnnouncementRecord[]>;
  /** 生效中：enabled、startsAt <= now、endsAt 为空或 > now、渠道为 all 或等于 channel。 */
  listEffective(now: Date, channel: ReleaseChannel): Promise<AnnouncementRecord[]>;
}

export interface ReleaseRecord {
  id: string;
  version: string;
  channel: ReleaseChannel;
  /** 灰度百分比 0..100。 */
  rolloutPercent: number;
  /** 低于该版本的客户端必须更新。 */
  minVersion: string | null;
  forced: boolean;
  notes: string;
  /** false = 暂停下发（回滚开关）。 */
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type ReleaseInput = Omit<ReleaseRecord, 'id' | 'createdAt' | 'updatedAt'>;

export interface ReleaseRepository {
  /** (version, channel) 重复抛唯一键错误。 */
  create(r: ReleaseInput, now: Date): Promise<ReleaseRecord>;
  update(id: string, patch: Partial<Omit<ReleaseInput, 'version' | 'channel'>>, now: Date): Promise<ReleaseRecord | null>;
  findById(id: string): Promise<ReleaseRecord | null>;
  list(): Promise<ReleaseRecord[]>;
  /** 指定通道里 enabled 的发布（顺序不保证）。 */
  listEnabled(channels: ReleaseChannel[]): Promise<ReleaseRecord[]>;
}

export interface AdminRoleRecord {
  accountId: string;
  role: AdminRoleName;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminRoleRepository {
  /** 授予或更新（每账号一条）。 */
  set(accountId: string, role: AdminRoleName, grantedBy: string | null, now: Date): Promise<AdminRoleRecord>;
  find(accountId: string): Promise<AdminRoleRecord | null>;
  remove(accountId: string): Promise<boolean>;
  list(): Promise<AdminRoleRecord[]>;
}

export interface AdminAuditRecord {
  id: string;
  at: Date;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: AdminRoleName | null;
  /** 如 "POST /admin/orders/:id/refund"。 */
  action: string;
  targetType: string | null;
  targetId: string | null;
  ok: boolean;
  status: number;
  /** 脱敏后的请求摘要。 */
  detail: unknown;
  ip: string | null;
}

export interface AdminAuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** 只取 at < before 的记录（翻页）。 */
  before?: Date;
  limit: number;
}

export interface AdminAuditRepository {
  add(r: Omit<AdminAuditRecord, 'id'>): Promise<AdminAuditRecord>;
  /** 按时间倒序。 */
  list(f: AdminAuditFilter): Promise<AdminAuditRecord[]>;
}

// ---------------------------------------------------------------------------
// 模板市场（P3-T）：模板 + 版本（清单 JSON、内容摘要、官方签名）。
// ---------------------------------------------------------------------------
export type TemplateTier = 'free' | 'pro';

export interface TemplateRecord {
  /** 即清单里的 id（slug）。 */
  id: string;
  name: string;
  genre: string;
  tier: TemplateTier;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}
export type TemplateInput = Omit<TemplateRecord, 'createdAt' | 'updatedAt'>;

export interface TemplateVersionRecord {
  id: string;
  templateId: string;
  version: string;
  /** 已校验的清单（不含 signature）。 */
  manifest: unknown;
  packageUrl: string | null;
  /** 清单摘要（canonicalJson 的 sha256，十六进制）。 */
  sha256: string;
  /** 对 'tpl-' + sha256 的 ES256 紧凑 JWS。 */
  signature: string;
  kid: string;
  tier: TemplateTier;
  published: boolean;
  publishedAt: Date | null;
  createdAt: Date;
}
export type TemplateVersionInput = Omit<TemplateVersionRecord, 'id' | 'published' | 'publishedAt' | 'createdAt'>;

export interface TemplateRepository {
  /** id 重复抛唯一键错误。 */
  create(t: TemplateInput, now: Date): Promise<TemplateRecord>;
  update(id: string, patch: Partial<Omit<TemplateInput, 'id'>>, now: Date): Promise<TemplateRecord | null>;
  findById(id: string): Promise<TemplateRecord | null>;
  /** 按 id 升序。 */
  list(): Promise<TemplateRecord[]>;
  /** 级联删除版本。 */
  delete(id: string): Promise<boolean>;
  /** (templateId, version) 重复抛唯一键错误；模板不存在抛错。 */
  addVersion(v: TemplateVersionInput, now: Date): Promise<TemplateVersionRecord>;
  findVersion(id: string): Promise<TemplateVersionRecord | null>;
  /** 某模板的全部版本，新建的在前。 */
  listVersions(templateId: string): Promise<TemplateVersionRecord[]>;
  /** 发布 / 下架；发布时写 publishedAt。 */
  setPublished(id: string, published: boolean, now: Date): Promise<TemplateVersionRecord | null>;
  /** 全部已发布版本，publishedAt 新的在前。 */
  listPublished(): Promise<TemplateVersionRecord[]>;
}
// 插件注册表（P3-P）：登记、版本、审核、官方签名。云端不存插件包，只存 manifest 与哈希。
// ---------------------------------------------------------------------------
export type PluginReviewStatus = 'pending' | 'approved' | 'rejected';
export type PluginReviewAction = 'submit' | 'approve' | 'reject' | 'sign';

export interface PluginSignature { alg: 'ES256'; kid: string; value: string }

export interface PluginRecord {
  id: string;
  name: string;
  label: string;
  homepage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginVersionRecord {
  id: string;
  pluginId: string;
  pluginName: string;
  version: string;
  /** 提交时的 manifest（含 files，不含 signature）。 */
  manifest: Record<string, unknown>;
  /** { "<相对路径>": "<sha256 hex>" } */
  fileHashes: Record<string, string>;
  /** sha256(签名载荷)：本地插件页展示的指纹，用于把已安装插件对到审核记录。 */
  hash: string;
  packageUrl: string;
  sha256: string;
  signature: PluginSignature | null;
  signedAt: Date | null;
  signedBy: string | null;
  reviewStatus: PluginReviewStatus;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  submittedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginReviewRecord {
  id: string;
  versionId: string;
  action: PluginReviewAction;
  notes: string;
  actorId: string | null;
  actorEmail: string | null;
  createdAt: Date;
}

export interface PluginVersionInput {
  pluginId: string;
  version: string;
  manifest: Record<string, unknown>;
  fileHashes: Record<string, string>;
  hash: string;
  packageUrl: string;
  sha256: string;
  submittedBy: string | null;
}

export interface PluginRepository {
  /** 按 name 新建或更新 label/homepage（每个插件名一条）。 */
  upsertPlugin(p: { name: string; label: string; homepage: string | null }, now: Date): Promise<PluginRecord>;
  findPluginByName(name: string): Promise<PluginRecord | null>;
  listPlugins(): Promise<PluginRecord[]>;
  /** (pluginId, version) 重复抛唯一键错误。 */
  createVersion(v: PluginVersionInput, now: Date): Promise<PluginVersionRecord>;
  findVersion(id: string): Promise<PluginVersionRecord | null>;
  /** 新的在前。 */
  listVersions(f: { pluginId?: string; reviewStatus?: PluginReviewStatus; limit: number }): Promise<PluginVersionRecord[]>;
  setReview(id: string, r: { reviewStatus: PluginReviewStatus; reviewedAt: Date | null; reviewedBy: string | null }, now: Date): Promise<PluginVersionRecord | null>;
  setSignature(id: string, s: { signature: PluginSignature | null; signedAt: Date | null; signedBy: string | null }, now: Date): Promise<PluginVersionRecord | null>;
  addReview(r: Omit<PluginReviewRecord, 'id'>): Promise<PluginReviewRecord>;
  /** 按时间升序。 */
  listReviews(versionId: string): Promise<PluginReviewRecord[]>;
}

// ---------------------------------------------------------------------------
// 登录（P2-C）：短信验证码与微信扫码票据。验证码只存 HMAC，票据带过期。
// ---------------------------------------------------------------------------
export type SmsScene = 'login';

export interface SmsCodeRecord {
  id: string;
  phone: string;
  scene: SmsScene;
  /** HMAC(accessSecret, phone:code)，不存明文。 */
  codeHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  /** 用掉（登录成功）或作废（错 5 次 / 被新码顶掉）的时间。 */
  consumedAt: Date | null;
}

export interface SmsCodeRepository {
  create(c: { phone: string; scene: SmsScene; codeHash: string; createdAt: Date; expiresAt: Date }): Promise<SmsCodeRecord>;
  /** 该手机号 + 场景下最新一条未消费、未过期的验证码。 */
  findActive(phone: string, scene: SmsScene, now: Date): Promise<SmsCodeRecord | null>;
  /** 作废该手机号 + 场景下所有未消费的验证码（发新码时调用）。 */
  voidActive(phone: string, scene: SmsScene, now: Date): Promise<void>;
  /** 错误次数 +1，返回新的次数。 */
  incrementAttempts(id: string): Promise<number>;
  /** 原子地标记消费：仅当 consumedAt 为空时成功。 */
  consume(id: string, now: Date): Promise<boolean>;
}

export type WechatQrStatus = 'pending' | 'scanned' | 'confirmed' | 'expired';

export interface WechatQrTicketRecord {
  /** 票据即主键（随机、不可猜测）。 */
  ticket: string;
  status: WechatQrStatus;
  /** 确认后由适配器给出的 openid。 */
  openId: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** 用票据换到令牌的时间（一票一用）。 */
  consumedAt: Date | null;
}

export interface WechatQrRepository {
  create(t: { ticket: string; createdAt: Date; expiresAt: Date }): Promise<WechatQrTicketRecord>;
  findByTicket(ticket: string): Promise<WechatQrTicketRecord | null>;
  /** 状态机推进：仅当当前状态在 from 之内时改为 to，返回是否成功。 */
  transition(ticket: string, from: WechatQrStatus[], to: WechatQrStatus, openId: string | null): Promise<boolean>;
  /** 原子地标记消费：仅当 status=confirmed 且 consumedAt 为空时成功。 */
  consume(ticket: string, now: Date): Promise<boolean>;
// 工作室版（P3-S）：工作室、成员、席位、邀请。云端只记「谁在哪个工作室」，共享素材在对象存储里。
// ---------------------------------------------------------------------------
export type StudioStatus = 'active' | 'suspended';
export type StudioRole = 'owner' | 'admin' | 'member';
export type StudioMemberStatus = 'invited' | 'active' | 'removed';
export type StudioInviteRole = 'admin' | 'member';

export interface StudioRecord {
  id: string;
  name: string;
  ownerId: string;
  /** 席位上限（由后台设置，将来由订阅驱动；定价待定）。 */
  seatLimit: number;
  status: StudioStatus;
  createdAt: Date;
  updatedAt: Date;
}
export type StudioInput = Omit<StudioRecord, 'id' | 'createdAt' | 'updatedAt'>;

export interface StudioMemberRecord {
  id: string;
  studioId: string;
  accountId: string;
  role: StudioRole;
  status: StudioMemberStatus;
  joinedAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type StudioMemberInput = Omit<StudioMemberRecord, 'id' | 'createdAt' | 'updatedAt'>;

export interface StudioInviteRecord {
  id: string;
  studioId: string;
  code: string;
  /** 指定邮箱时只有该邮箱的账号能接受；为空则凭邀请码任何人可接受。 */
  email: string | null;
  role: StudioInviteRole;
  createdBy: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  usedById: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}
export type StudioInviteInput = Omit<StudioInviteRecord, 'id' | 'usedAt' | 'usedById' | 'revokedAt' | 'createdAt'>;

export interface StudioRepository {
  create(s: StudioInput, now: Date): Promise<StudioRecord>;
  update(id: string, patch: Partial<Omit<StudioInput, 'ownerId'>>, now: Date): Promise<StudioRecord | null>;
  findById(id: string): Promise<StudioRecord | null>;
  /** 全部工作室，按创建时间升序。 */
  list(): Promise<StudioRecord[]>;
  /** 某账号为 active 成员的工作室。 */
  listByMember(accountId: string): Promise<StudioRecord[]>;
  /** (studioId, accountId) 重复抛唯一键错误。 */
  addMember(m: StudioMemberInput, now: Date): Promise<StudioMemberRecord>;
  updateMember(id: string, patch: Partial<Pick<StudioMemberRecord, 'role' | 'status' | 'joinedAt' | 'removedAt'>>, now: Date): Promise<StudioMemberRecord | null>;
  findMember(studioId: string, accountId: string): Promise<StudioMemberRecord | null>;
  /** 某工作室全部成员（含 removed），按创建时间升序。 */
  listMembers(studioId: string): Promise<StudioMemberRecord[]>;
  /** code 重复抛唯一键错误。 */
  createInvite(i: StudioInviteInput, now: Date): Promise<StudioInviteRecord>;
  findInviteByCode(code: string): Promise<StudioInviteRecord | null>;
  findInvite(id: string): Promise<StudioInviteRecord | null>;
  /** 某工作室全部邀请，新的在前。 */
  listInvites(studioId: string): Promise<StudioInviteRecord[]>;
  updateInvite(id: string, patch: Partial<Pick<StudioInviteRecord, 'usedAt' | 'usedById' | 'revokedAt'>>): Promise<StudioInviteRecord | null>;
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
  announcements: AnnouncementRepository;
  releases: ReleaseRepository;
  adminRoles: AdminRoleRepository;
  adminAudit: AdminAuditRepository;
  templates: TemplateRepository;
  plugins: PluginRepository;
  smsCodes: SmsCodeRepository;
  wechatQr: WechatQrRepository;
  studios: StudioRepository;
}
