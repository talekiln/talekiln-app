'use strict';
const { READABLE } = require('../providers/errors');
const { SUBMIT_UNCERTAIN } = require('./aiTaskQueue');

/** Vendor consoles (https only; the desktop shell opens https links in the system browser). */
const { KNOWN_PROVIDERS, isEnabled } = require('../providers/enablement');

/** Console link of an enabled provider (disabled providers show no link), or null. */
function vendorConsole(provider) {
  const m = KNOWN_PROVIDERS[provider];
  return m && isEnabled(provider) ? { name: m.label, url: m.consoleUrl } : null;
}

const UNCERTAIN_TEXT = '提交结果不确定：请求可能已到达服务商。为避免重复扣费未自动重试，请先到服务商控制台确认后再手动重试';

/** Readable Chinese reason for a task's failure, or null when it has none. */
function readableError(code, message) {
  if (!code) return null;
  if (message && String(message).startsWith(SUBMIT_UNCERTAIN)) return UNCERTAIN_TEXT;
  return READABLE[code] || READABLE.UNKNOWN;
}

function isUncertain(row) {
  return !!(row && row.error_message && String(row.error_message).startsWith(SUBMIT_UNCERTAIN));
}

function parseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

/** DB row -> API shape. */
function toView(row) {
  const vendor = vendorConsole(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    state: row.state,
    params: parseJson(row.params),
    result: parseJson(row.result),
    vendor_task_id: row.vendor_task_id,
    attempts: row.attempts,
    error_code: row.error_code,
    error_message: row.error_message,
    error_readable: readableError(row.error_code, row.error_message),
    uncertain: isUncertain(row),
    next_attempt_at: row.next_attempt_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    console_url: vendor ? vendor.url : null,
    provider_name: vendor ? vendor.name : row.provider,
  };
}

module.exports = { vendorConsole, readableError, isUncertain, toView };
