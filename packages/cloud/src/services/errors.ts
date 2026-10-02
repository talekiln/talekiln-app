export type ErrorCode =
  | 'invalid_invite' | 'email_taken' | 'invalid_credentials' | 'invalid_token'
  | 'token_reuse' | 'forbidden' | 'device_required' | 'device_revoked' | 'not_found'
  | 'account_disabled' | 'rate_limited' | 'payload_too_large' | 'bad_request';

export class ServiceError extends Error {
  constructor(public readonly code: ErrorCode, message?: string) {
    super(message ?? code);
  }
}
