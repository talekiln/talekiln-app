'use strict';

/** 模板相关错误：code 对应 errors/error-codes.json，status 为 HTTP 状态。 */
class TemplateError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

module.exports = { TemplateError };
