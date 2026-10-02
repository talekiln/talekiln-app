export type ErrorCode =
  | 'invalid_invite' | 'email_taken' | 'invalid_credentials' | 'invalid_token'
  | 'token_reuse' | 'forbidden' | 'device_required' | 'device_revoked' | 'not_found'
  | 'account_disabled' | 'rate_limited' | 'payload_too_large' | 'bad_request'
  | 'device_limit' | 'conflict' | 'provider_unavailable' | 'invalid_signature'
  // P2-C 登录：短信验证码 / 微信扫码
  | 'invalid_code' | 'code_expired' | 'invite_required' | 'qr_expired' | 'sms_unavailable' | 'wechat_unavailable';

export class ServiceError extends Error {
  constructor(public readonly code: ErrorCode, message?: string) {
    super(message ?? code);
  }
}
