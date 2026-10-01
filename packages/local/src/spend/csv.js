'use strict';
/** CSV export for spend_log rows. Excel-friendly: UTF-8 BOM, CRLF, formula-injection guard. */

const COLUMNS = [
  ['day', '日期'],
  ['task_id', '任务ID'],
  ['provider', '服务商'],
  ['kind', '类型'],
  ['model', '模型'],
  ['project_id', '项目'],
  ['currency', '币种'],
  ['estimated', '预估费用'],
  ['actual', '实际费用'],
  ['cost', '计入费用'],
];

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Text starting with = + - @ TAB CR can run as a formula in spreadsheet apps; real numbers are exempt.
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [COLUMNS.map(([, h]) => h).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(([k]) => cell(r[k])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, COLUMNS };
