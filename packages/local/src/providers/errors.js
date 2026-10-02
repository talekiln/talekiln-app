'use strict';
/** Unified, vendor-neutral error codes surfaced to business code / UI. */
const ERROR_CODES = Object.freeze({
  INVALID_API_KEY: 'INVALID_API_KEY',
  MODEL_NOT_ENABLED: 'MODEL_NOT_ENABLED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TASK_FAILED: 'TASK_FAILED',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  PROVIDER_NOT_AVAILABLE: 'PROVIDER_NOT_AVAILABLE',
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
  SPEND_LIMIT: 'SPEND_LIMIT',
  UNKNOWN: 'UNKNOWN',
});

const READABLE = {
  INVALID_API_KEY: 'API Key 无效或已过期，请检查设置中的 Key',
  MODEL_NOT_ENABLED: '该模型未开通或无权限，请在服务商控制台开通后重试',
  INSUFFICIENT_BALANCE: '账户余额不足或已欠费，请充值后重试',
  RATE_LIMITED: '请求过于频繁或额度受限，请稍后重试',
  INVALID_PARAMS: '请求参数不合法',
  TASK_FAILED: '生成任务失败',
  NETWORK: '网络请求失败',
  BAD_RESPONSE: '服务商返回格式异常',
  PROVIDER_NOT_AVAILABLE: '该服务商暂未开放',
  CAPABILITY_NOT_SUPPORTED: '该服务商不支持此能力',
  SPEND_LIMIT: '已达到费用上限，任务未提交。请在设置中调整单次/月度上限后重试',
  UNKNOWN: '未知错误',
};

class ProviderError extends Error {
  constructor(code, detail, extra = {}) {
    const base = READABLE[code] || READABLE.UNKNOWN;
    super(detail ? `${base}（${detail}）` : base);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = extra.provider || null;
    this.status = extra.status || null;
    this.vendorCode = extra.vendorCode || null;
  }
}

module.exports = { ERROR_CODES, ProviderError, READABLE };
