// 按配置装配登录适配器。none 表示未接入：服务层对相关接口回 503（sms_unavailable / wechat_unavailable）。
import type { AppConfig } from '../services/config';
import { MockSmsProvider, MockWechatQrProvider, type SmsProvider, type WechatQrProvider } from './providers';

export interface LoginProviders {
  sms: SmsProvider | null;
  wechat: WechatQrProvider | null;
}

export function createLoginProviders(cfg: Pick<AppConfig, 'smsProvider' | 'wechatProvider'>): LoginProviders {
  return {
    sms: cfg.smsProvider === 'mock' ? new MockSmsProvider() : null,
    wechat: cfg.wechatProvider === 'mock' ? new MockWechatQrProvider() : null,
  };
}
