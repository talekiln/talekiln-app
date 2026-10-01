import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ServiceError, type ErrorCode } from '../services/errors';

const STATUS: Record<ErrorCode, number> = {
  invalid_invite: 400, email_taken: 409, invalid_credentials: 401, invalid_token: 401,
  token_reuse: 401, forbidden: 403, device_required: 400, device_revoked: 403, not_found: 404,
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof ServiceError) return res.status(STATUS[e.code]).json({ error: e.code, message: e.message });
    if (e instanceof ZodError) return res.status(400).json({ error: 'bad_request', issues: e.issues });
    if (e instanceof HttpException) return res.status(e.getStatus()).json({ error: 'http_error', message: e.message });
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
}
