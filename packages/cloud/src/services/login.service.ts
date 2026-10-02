// P2-C 登录：短信验证码登录与微信扫码登录。适配器（短信 / 微信）可换，这里只管状态机、限频、邀请码与账号。
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ServiceError } from './errors';
import { errorStatus } from '../http/filter';
import type { AppConfig } from './config';
import type { AuthResult, AuthService, DeviceInfo } from './auth.service';
import type { AuditService } from './audit.service';
import type { RateLimiter } from './rate-limiter';
import type { LoginProviders } from '../login/registry';
import type { Account, Repositories, SmsScene, WechatQrStatus, WechatQrTicketRecord } from '../domain/repositories';

const MIN = 60_000;
export const SMS_CODE_TTL_MS = 5 * MIN;
export const SMS_RESEND_SECONDS = 60;
export const SMS_MAX_ATTEMPTS = 5;
/** 二维码默认有效期；适配器给的更短就用适配器的。 */
export const QR_TTL_SECONDS = 300;
/** 已确认的票据再给客户端一点时间填邀请码 / 换令牌。 */
export const QR_CONFIRMED_GRACE_MS = 15 * MIN;
export const QR_POLL_SECONDS = 2;
/**
 * 无邮箱账号（短信 / 微信首登）的占位登录名：.invalid 是保留顶级域，谁也注册不了，不会与真实邮箱撞车；
 * 口令哈希是随机值，所以这类账号不能用邮箱密码登录。是否把 Account.email 改为可空见 docs/phase2-login.md。
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'placeholder.talekiln.invalid';

const PHONE_RE = /^1[3-9]\d{9}$/;

/** 大陆手机号规范化：去空格 / 连字符，去 +86 / 86 / 0086 前缀；不合法抛 bad_request。 */
export function normalizePhone(raw: string): string {
  let s = String(raw ?? '').replace(/[\s-]/g, '');
  if (s.startsWith('+86')) s = s.slice(3);
  else if (s.startsWith('0086')) s = s.slice(4);
  else if (s.length === 13 && s.startsWith('86')) s = s.slice(2);
  if (!PHONE_RE.test(s)) throw new ServiceError('bad_request', 'invalid phone number');
  return s;
}

export const maskPhone = (p: string) => `${p.slice(0, 3)}****${p.slice(-4)}`;

export interface SmsSendResult {
  sent: true;
  phone: string;
  expires_in: number;
  resend_after: number;
  provider: string;
  /** 仅非生产环境 + 模拟适配器。 */
  debug_code?: string;
}

export interface WechatQrCreated {
  ticket: string;
  qr_url: string;
  expires_in: number;
  poll_interval: number;
  provider: string;
  /** 为 true 时客户端可展示“模拟确认”按钮。 */
  simulated: boolean;
}

export interface WechatQrView {
  status: WechatQrStatus;
  /** 仅 confirmed：该 openid 还没有账号，客户端需要收集邀请码。 */
  new_account?: boolean;
  expires_in: number;
}

export class LoginService {
  constructor(
    private readonly repos: Repositories,
    private readonly auth: AuthService,
    private readonly providers: LoginProviders,
    private readonly cfg: Pick<AppConfig, 'accessSecret' | 'loginDebug'>,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- 短信

  private requireSms() {
    const p = this.providers.sms;
    if (!p) throw new ServiceError('sms_unavailable', '短信登录尚未接入');
    return p;
  }

  private codeHash(phone: string, code: string) {
    return createHmac('sha256', this.cfg.accessSecret).update(`${phone}:${code}`).digest('hex');
  }

  /** 发验证码：每 IP 每小时 30 次；每手机号 1 分钟 1 次、每小时 5 次。新码作废旧码。 */
  async sendSmsCode(input: { phone: string; scene?: SmsScene; ip: string | null }): Promise<SmsSendResult> {
    const provider = this.requireSms();
    const phone = normalizePhone(input.phone);
    const scene: SmsScene = input.scene ?? 'login';
    this.limiter.hit(`sms:ip:${input.ip ?? 'unknown'}`, 30, 60 * MIN);
    this.limiter.hit(`sms:phone:min:${phone}`, 1, SMS_RESEND_SECONDS * 1000);
    this.limiter.hit(`sms:phone:hour:${phone}`, 5, 60 * MIN);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.now();
    await this.repos.smsCodes.voidActive(phone, scene, now);
    await this.repos.smsCodes.create({
      phone, scene, codeHash: this.codeHash(phone, code), createdAt: now, expiresAt: new Date(now.getTime() + SMS_CODE_TTL_MS),
    });
    try {
      await provider.sendCode(phone, code, scene);
    } catch (e) {
      throw new ServiceError('sms_unavailable', `短信发送失败：${(e as Error).message}`);
    }
    const out: SmsSendResult = {
      sent: true, phone: maskPhone(phone), expires_in: SMS_CODE_TTL_MS / 1000, resend_after: SMS_RESEND_SECONDS, provider: provider.name,
    };
    if (this.cfg.loginDebug && provider.name === 'mock') out.debug_code = code;
    return out;
  }

  /**
   * 验证码登录：5 分钟有效、错 5 次作废。新手机号首次登录必须带邀请码（沿用邮箱激活的邀请码规则）。
   * 邀请码缺失 / 无效时不消耗验证码，用户补上邀请码即可重试。
   */
  async smsLogin(input: { phone: string; code: string; inviteCode?: string; device?: DeviceInfo; ip: string | null }): Promise<AuthResult> {
    this.requireSms();
    const phone = normalizePhone(input.phone);
    return this.audited('sms', '/auth/sms/login', { phone: maskPhone(phone) }, input.ip, async () => {
      const now = this.now();
      const rec = await this.repos.smsCodes.findActive(phone, 'login', now);
      if (!rec) throw new ServiceError('code_expired', '验证码已过期或尚未发送');
      const given = Buffer.from(this.codeHash(phone, String(input.code ?? '').trim()));
      const want = Buffer.from(rec.codeHash);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        const attempts = await this.repos.smsCodes.incrementAttempts(rec.id);
        if (attempts >= SMS_MAX_ATTEMPTS) {
          await this.repos.smsCodes.consume(rec.id, now);
          throw new ServiceError('invalid_code', '验证码错误次数过多，请重新获取');
        }
        throw new ServiceError('invalid_code', '验证码错误');
      }

      let account = await this.repos.accounts.findByPhone(phone);
      const invite = account ? null : await this.requireInvite(input.inviteCode);
      if (!(await this.repos.smsCodes.consume(rec.id, now))) throw new ServiceError('code_expired', '验证码已被使用');
      if (!account) {
        account = await this.createSocialAccount(invite!, { phone, email: `sms-${phone}@${PLACEHOLDER_EMAIL_DOMAIN}` }, () => this.repos.accounts.findByPhone(phone));
      }
      if (account.disabledAt) throw new ServiceError('account_disabled');
      return this.auth.start(account, input.device);
    });
  }

  // ---------------------------------------------------------------- 微信扫码

  private requireWechat() {
    const p = this.providers.wechat;
    if (!p) throw new ServiceError('wechat_unavailable', '微信登录尚未接入');
    return p;
  }

  /** 生成一次登录的二维码票据（每 IP 每 10 分钟 30 个）。 */
  async createWechatQr(input: { ip: string | null }): Promise<WechatQrCreated> {
    const provider = this.requireWechat();
    this.limiter.hit(`wechat-qr:ip:${input.ip ?? 'unknown'}`, 30, 10 * MIN);
    const ticket = randomBytes(18).toString('base64url');
    const qr = await provider.createQr(ticket);
    const ttl = Math.min(Math.max(30, qr.expiresInSeconds || QR_TTL_SECONDS), QR_TTL_SECONDS);
    const now = this.now();
    await this.repos.wechatQr.create({ ticket, createdAt: now, expiresAt: new Date(now.getTime() + ttl * 1000) });
    return { ticket, qr_url: qr.qrUrl, expires_in: ttl, poll_interval: QR_POLL_SECONDS, provider: provider.name, simulated: provider.simulated };
  }

  /** 读出时计算的有效状态：过期 / 已消费都视为 expired；confirmed 多给一段宽限换令牌。 */
  effectiveStatus(rec: WechatQrTicketRecord, now = this.now()): WechatQrStatus {
    if (rec.consumedAt) return 'expired';
    const t = now.getTime();
    if (rec.status === 'confirmed') return t < rec.expiresAt.getTime() + QR_CONFIRMED_GRACE_MS ? 'confirmed' : 'expired';
    return t < rec.expiresAt.getTime() ? rec.status : 'expired';
  }

  private async findTicket(ticket: string): Promise<WechatQrTicketRecord> {
    const rec = await this.repos.wechatQr.findByTicket(ticket);
    if (!rec) throw new ServiceError('not_found', 'unknown ticket');
    return rec;
  }

  private async view(rec: WechatQrTicketRecord): Promise<WechatQrView> {
    const now = this.now();
    const status = this.effectiveStatus(rec, now);
    const out: WechatQrView = { status, expires_in: Math.max(0, Math.ceil((rec.expiresAt.getTime() - now.getTime()) / 1000)) };
    if (status === 'confirmed') out.new_account = !(await this.repos.accounts.findByWechatOpenId(rec.openId ?? ''));
    return out;
  }

  /** 轮询：pending / scanned / confirmed / expired。 */
  async wechatQrStatus(ticket: string): Promise<WechatQrView> {
    return this.view(await this.findTicket(ticket));
  }

  /** 把某张票据推进到 confirmed（真实回调与模拟确认共用）。 */
  private async confirmTicket(ticket: string, openId: string): Promise<WechatQrView> {
    const rec = await this.findTicket(ticket);
    if (this.effectiveStatus(rec) === 'expired') throw new ServiceError('qr_expired', '二维码已过期，请刷新');
    if (rec.status !== 'confirmed') {
      const ok = await this.repos.wechatQr.transition(ticket, ['pending', 'scanned'], 'confirmed', openId);
      if (!ok) throw new ServiceError('conflict', 'ticket state changed');
    }
    return this.view(await this.findTicket(ticket));
  }

  /**
   * 模拟器专用：只有 simulated 的适配器才开放；其它情况 404（生产环境里这个接口“不存在”）。
   * scanOnly 只推进到 scanned（给客户端看“已扫码，请在手机上确认”）；否则直接 confirmed。
   */
  async simulateConfirm(ticket: string, input: { openId?: string; scanOnly?: boolean } = {}): Promise<WechatQrView> {
    const provider = this.providers.wechat;
    if (!provider || !provider.simulated) throw new ServiceError('not_found');
    const rec = await this.findTicket(ticket);
    if (this.effectiveStatus(rec) === 'expired') throw new ServiceError('qr_expired', '二维码已过期，请刷新');
    if (input.scanOnly) {
      await this.repos.wechatQr.transition(ticket, ['pending'], 'scanned', null);
      return this.view(await this.findTicket(ticket));
    }
    // 没给 openid 就按票据派生一个稳定值：同一张票据多次确认得到同一个“微信用户”
    const openId = input.openId?.trim() || (await provider.exchangeCode(createHash('sha256').update(ticket).digest('hex').slice(0, 16))).openId;
    return this.confirmTicket(ticket, openId);
  }

  /** 真实适配器的回调入口：微信带着 code 与 state（= 票据）跳回来，用 code 换 openid 并确认票据。 */
  async wechatCallback(input: { code: string; state: string }): Promise<WechatQrView> {
    const provider = this.requireWechat();
    const identity = await provider.exchangeCode(input.code);
    return this.confirmTicket(input.state, identity.openId);
  }

  /** 用已确认的票据换令牌（一票一用）。首次见到的 openid 需要邀请码建账号。 */
  async wechatLogin(input: { ticket: string; inviteCode?: string; device?: DeviceInfo; ip: string | null }): Promise<AuthResult> {
    this.requireWechat();
    return this.audited('wechat', '/auth/wechat/login', { ticket: input.ticket.slice(0, 8) }, input.ip, async () => {
      const rec = await this.findTicket(input.ticket);
      const status = this.effectiveStatus(rec);
      if (status === 'expired') throw new ServiceError('qr_expired', '二维码已过期，请刷新');
      if (status !== 'confirmed' || !rec.openId) throw new ServiceError('bad_request', '尚未在微信上确认登录');
      const openId = rec.openId;
      let account = await this.repos.accounts.findByWechatOpenId(openId);
      const invite = account ? null : await this.requireInvite(input.inviteCode);
      if (!(await this.repos.wechatQr.consume(input.ticket, this.now()))) throw new ServiceError('qr_expired', '票据已被使用');
      if (!account) {
        const tag = createHash('sha256').update(openId).digest('hex').slice(0, 16);
        account = await this.createSocialAccount(invite!, { wechatOpenId: openId, email: `wx-${tag}@${PLACEHOLDER_EMAIL_DOMAIN}` }, () => this.repos.accounts.findByWechatOpenId(openId));
      }
      if (account.disabledAt) throw new ServiceError('account_disabled');
      return this.auth.start(account, input.device);
    });
  }

  // ---------------------------------------------------------------- 共用

  private async requireInvite(inviteCode: string | undefined) {
    if (!inviteCode || !inviteCode.trim()) throw new ServiceError('invite_required', '首次登录需要邀请码');
    return this.auth.checkInvite(inviteCode);
  }

  /** 建无口令账号；并发下同一手机号 / openid 被别的请求先建了，就直接用那一个。 */
  private async createSocialAccount(
    invite: NonNullable<Awaited<ReturnType<AuthService['checkInvite']>>>,
    fields: { email: string; phone?: string; wechatOpenId?: string },
    refetch: () => Promise<Account | null>,
  ): Promise<Account> {
    try {
      return await this.auth.createWithInvite(invite, { ...fields, passwordHash: await this.auth.unusablePasswordHash() }, 'conflict');
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'conflict') {
        const existing = await refetch();
        if (existing) return existing;
      }
      throw e;
    }
  }

  /** 登录审计：成功记账号与方式，失败记错误状态；审计失败不影响登录。 */
  private async audited(method: 'sms' | 'wechat', routePath: string, summary: Record<string, string>, ip: string | null, fn: () => Promise<AuthResult>): Promise<AuthResult> {
    const ctx = { method: 'POST', routePath, params: {}, body: { method, ...summary }, query: {}, ip };
    try {
      const r = await fn();
      await this.audit?.record({ id: r.account.id, email: r.account.email, role: null }, ctx, true, 200, r.account.id);
      return r;
    } catch (e) {
      if (e instanceof ServiceError) await this.audit?.record({ id: null, email: null, role: null }, ctx, false, errorStatus(e.code));
      throw e;
    }
  }
}
