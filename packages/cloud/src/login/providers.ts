// P2-C 登录适配器接口：短信验证码与微信扫码。业务逻辑只依赖这两个接口；
// 真实厂商（阿里云短信、微信开放平台）接入时各写一个实现并在 registry.ts 里按环境变量选择，不改业务代码。
import type { SmsScene } from '../domain/repositories';

export interface SmsProvider {
  /** 'mock' | 'aliyun' | ...；为 mock 时接口会在非生产环境回传 debug_code。 */
  readonly name: string;
  /**
   * 发送验证码。实现负责厂商调用（签名、模板、重试）；失败抛错即可，服务层映射为 503。
   * 阿里云短信：SendSms(PhoneNumbers, SignName, TemplateCode, TemplateParam={"code":code})。
   */
  sendCode(phone: string, code: string, scene: SmsScene): Promise<void>;
}

export interface WechatQr {
  /** 要渲染成二维码的内容。真实实现为开放平台授权页 URL（含 appid、redirect_uri、state）。 */
  qrUrl: string;
  /** 二维码有效期（秒）。 */
  expiresInSeconds: number;
}

export interface WechatIdentity {
  openId: string;
  unionId?: string | null;
}

export interface WechatQrProvider {
  readonly name: string;
  /** 为 true 时开放 POST /auth/wechat/qr/:ticket/confirm（模拟器专用）；真实实现必须为 false。 */
  readonly simulated: boolean;
  /** 为一次登录创建二维码。state 即服务端票据，微信回调时原样带回，用来对上是哪次登录。 */
  createQr(state: string): Promise<WechatQr>;
  /**
   * 回调换身份：用微信回调里的 code 换 openid（真实实现：sns/oauth2/access_token）。
   * 模拟实现：任何 code 都对应 openid `mock-openid-<code>`。
   */
  exchangeCode(code: string): Promise<WechatIdentity>;
}

/** 模拟短信：验证码只写日志（也留在内存里供测试读取），不发任何网络请求。 */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  readonly sent: { phone: string; code: string; scene: SmsScene }[] = [];
  constructor(private readonly log: (msg: string) => void = (m) => console.log(m)) {}

  async sendCode(phone: string, code: string, scene: SmsScene): Promise<void> {
    this.sent.push({ phone, code, scene });
    if (this.sent.length > 100) this.sent.shift();
    this.log(`[cloud][sms-mock] ${scene} 验证码 ${code} -> ${phone.slice(0, 3)}****${phone.slice(-4)}`);
  }
}

/** 模拟微信扫码：二维码内容是一个占位 URL，确认靠 /auth/wechat/qr/:ticket/confirm 接口手动触发。 */
export class MockWechatQrProvider implements WechatQrProvider {
  readonly name = 'mock';
  readonly simulated = true;
  constructor(private readonly expiresInSeconds = 300) {}

  async createQr(state: string): Promise<WechatQr> {
    return { qrUrl: `talekiln://wechat-mock/confirm?state=${encodeURIComponent(state)}`, expiresInSeconds: this.expiresInSeconds };
  }

  async exchangeCode(code: string): Promise<WechatIdentity> {
    return { openId: `mock-openid-${code}`, unionId: null };
  }
}
