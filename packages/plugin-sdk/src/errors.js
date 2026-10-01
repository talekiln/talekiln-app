'use strict';
/**
 * Vendor-neutral error codes. The string values are identical to packages/local/src/providers/errors.js,
 * so a PluginError maps 1:1 onto the host's ProviderError. Do not invent codes in a plugin.
 * (The host adds PROVIDER_NOT_AVAILABLE / CAPABILITY_NOT_SUPPORTED / SPEND_LIMIT itself.)
 */
const ERROR_CODES = Object.freeze({
  INVALID_API_KEY: 'INVALID_API_KEY',
  MODEL_NOT_ENABLED: 'MODEL_NOT_ENABLED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TASK_FAILED: 'TASK_FAILED',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UNKNOWN: 'UNKNOWN',
});

class PluginError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} [detail] short, key-free detail
   * @param {{status?: number, vendorCode?: string|null}} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(detail || String(code));
    this.name = 'PluginError';
    this.code = Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? code : ERROR_CODES.UNKNOWN;
    this.detail = detail || '';
    this.status = extra.status || null;
    this.vendorCode = extra.vendorCode || null;
  }
}

module.exports = { ERROR_CODES, PluginError };
