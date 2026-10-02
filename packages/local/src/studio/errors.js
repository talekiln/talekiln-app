'use strict';
/** P3-S 工作室：业务错误。code 对应 errors/error-codes.json（STUDIO_* / CLOUD_* / BACKUP_* / NOT_FOUND / BAD_REQUEST），status 为 HTTP 状态。 */
class StudioError extends Error {
  constructor(code, message, status = 400, details) {
    super(message || code);
    this.name = 'StudioError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

module.exports = { StudioError };
