// Toast text from the unified error table (packages/local/src/errors/error-codes.json).
// Pure (no Vue / DOM) so it can be unit tested; request.js feeds the result to ElMessage.
import table from '../../../../packages/local/src/errors/error-codes.json' with { type: 'json' }

const ENTRIES = table.entries

export function lookupError(code) {
  if (code == null) return null
  const k = String(code)
  return Object.prototype.hasOwnProperty.call(ENTRIES, k) ? ENTRIES[k] : null
}

/**
 * Normalise an axios error / API error body into { code, message, action }.
 * Accepts the local shape { error: { code, message, action } } and the cloud shape { error: 'code', message }.
 */
export function parseApiError(err) {
  const body = err && err.response && err.response.data
  let code = null
  let message = null
  let action = null
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') {
      code = body.error.code || null
      message = body.error.message || null
      action = body.error.action || null
    } else if (typeof body.error === 'string') {
      code = body.error
      message = body.message || null
    }
  }
  const info = lookupError(code)
  if (info) {
    // 服务端给的具体文案优先（如花费上限里带金额）；缺省用表内文案
    message = message || info.message
    action = action || info.action
  }
  if (!message) message = (err && err.message) || '网络错误'
  return { code, message, action }
}

/** Text for the toast: message plus a suggested action when the table has one. */
export function toastText(err) {
  const { message, action } = parseApiError(err)
  return action ? `${message}。建议：${action}` : message
}
