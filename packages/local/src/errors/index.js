'use strict';
/**
 * 统一错误码查询。数据源：./error-codes.json（local 服务与渲染进程共用）。
 * 未知码回退到 UNKNOWN，保证永远有可展示的中文文案。
 */
const table = require('./error-codes.json');

const ENTRIES = table.entries;

function lookup(code) {
  if (code == null) return null;
  return Object.prototype.hasOwnProperty.call(ENTRIES, String(code)) ? ENTRIES[String(code)] : null;
}

/** 总是返回 { code, message, action, scope }；未知码回退 UNKNOWN。 */
function describe(code) {
  const hit = lookup(code);
  const e = hit || ENTRIES.UNKNOWN;
  return { code: hit ? String(code) : 'UNKNOWN', message: e.message, action: e.action, scope: e.scope };
}

module.exports = { ENTRIES, lookup, describe };
