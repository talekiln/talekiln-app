import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ServiceError, type ErrorCode } from '../services/errors';

const STATUS: Record<ErrorCode, number> = {
  invalid_invite: 400, email_taken: 409, invalid_credentials: 401, invalid_token: 401,
  token_reuse: 401, forbidden: 403, device_required: 400, device_revoked: 403, not_found: 404,
  account_disabled: 403, rate_limited: 429, payload_too_large: 413, bad_request: 400,
  device_limit: 403, conflict: 409, provider_unavailable: 503, invalid_signature: 401,
  // P2-C 登录
  invalid_code: 401, code_expired: 400, invite_required: 400, qr_expired: 410, sms_unavailable: 503, wechat_unavailable: 503,
  seat_limit: 403, studio_suspended: 403,
};
export const errorStatus = (code: ErrorCode) => STATUS[code];

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof ServiceError) return res.status(STATUS[e.code]).json({ error: e.code, message: e.message });
    if (e instanceof ZodError) return res.status(400).json({ error: 'bad_request', issues: e.issues });
    if (e instanceof HttpException) {
      return res.status(e.getStatus()).json({ error: e.getStatus() === 413 ? 'payload_too_large' : 'http_error', message: e.message });
    }
    // body-parser 的体积/解析错误（带 status 字段）
    const st = (e as { status?: number }).status;
    if (typeof st === 'number' && st >= 400 && st < 500) {
      return res.status(st).json({ error: st === 413 ? 'payload_too_large' : 'bad_request' });
    }
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
}
