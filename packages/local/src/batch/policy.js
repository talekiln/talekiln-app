'use strict';
/**
 * P3-B 批量生成的纯函数：参数校验与归一化、夜间时段、并发上限、金额换算。无数据库、无时钟依赖（时钟由调用方注入）。
 */

const KINDS = ['image', 'video'];
const ON_FAIL = ['skip', 'pause'];
const MAX_RETRY = 10;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

class BatchError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 元（价格表里的小数）-> 分（整数）。 */
const toCents = (yuan) => Math.round((Number(yuan) || 0) * 100);
/** 分 -> 带两位小数的元字符串（错误文案用）。 */
const yuanText = (cents) => (Number(cents || 0) / 100).toFixed(2);

/** kinds 输入（'both' | 'image' | 'video' | 数组）-> ['image', 'video'] 的子集（保持 image 在前）。 */
function normalizeKinds(input) {
  if (input == null || input === 'both') return [...KINDS];
  const list = Array.isArray(input) ? input : [input];
  const out = KINDS.filter((k) => list.includes(k));
  if (!out.length || list.some((k) => !KINDS.includes(k))) throw new BatchError('BAD_REQUEST', "kinds 必须是 'both' / 'image' / 'video' 或它们的数组");
  return out;
}

/** 生成服务的 kind 参数。 */
function kindArg(kinds) {
  const has = (k) => kinds.includes(k);
  return has('image') && has('video') ? 'both' : has('image') ? 'image' : 'video';
}

function parseHHMM(s) {
  const m = HHMM.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 夜间时段 { start: 'HH:MM', end: 'HH:MM' } | null；非法抛 BAD_REQUEST。 */
function normalizeNight(night) {
  if (night == null || night === false || night === '') return null;
  if (typeof night !== 'object') throw new BatchError('BAD_REQUEST', 'night 必须是 { start, end } 或 null');
  const start = parseHHMM(night.start);
  const end = parseHHMM(night.end);
  if (start == null || end == null) throw new BatchError('BAD_REQUEST', '夜间时段的 start / end 必须是 HH:MM');
  if (start === end) throw new BatchError('BAD_REQUEST', '夜间时段的开始与结束不能相同');
  return { start: String(night.start).trim(), end: String(night.end).trim() };
}

/** 某一分钟（0-1439）是否落在时段内；跨午夜（start > end）按 [start, 24:00) ∪ [00:00, end) 算。没有时段 = 永远允许。 */
function inNightWindow(minutes, night) {
  if (!night) return true;
  const s = parseHHMM(night.start);
  const e = parseHHMM(night.end);
  if (s == null || e == null) return true;
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** 本地时间的“当天第几分钟”。 */
function localMinutesOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** 失败策略 -> { retry, on_fail, night }。 */
function normalizePolicy(p) {
  const src = p && typeof p === 'object' ? p : {};
  let retry = src.retry == null ? 1 : Number(src.retry);
  if (!Number.isInteger(retry) || retry < 0 || retry > MAX_RETRY) throw new BatchError('BAD_REQUEST', `retry 必须是 0-${MAX_RETRY} 的整数`);
  const onFail = src.on_fail == null ? 'skip' : String(src.on_fail);
  if (!ON_FAIL.includes(onFail)) throw new BatchError('BAD_REQUEST', "on_fail 必须是 'skip' 或 'pause'");
  return { retry, on_fail: onFail, night: normalizeNight(src.night) };
}

/** 服务商的队列并发上限（config ai_queue.limits）。 */
function providerLimit(limits, provider) {
  const l = limits || {};
  if (Number.isFinite(Number(l[provider])) && Number(l[provider]) > 0) return Math.floor(Number(l[provider]));
  if (Number.isFinite(Number(l.default)) && Number(l.default) > 0) return Math.floor(Number(l.default));
  return 2;
}

/**
 * 批次并发：每个服务商一个上限，缺省 = 该服务商的队列上限，且永远不超过它（超过没有意义：队列自己会卡住）。
 * input: { [provider]: n, default?: n }。非法值抛 BAD_REQUEST。
 */
function normalizeConcurrency(input, limits, providers) {
  const src = input && typeof input === 'object' ? input : {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new BatchError('BAD_REQUEST', `并发上限 ${k} 必须是 ≥ 1 的整数`);
  }
  const out = {};
  for (const p of providers) {
    const limit = providerLimit(limits, p);
    const raw = src[p] != null && src[p] !== '' ? Number(src[p]) : src.default != null && src.default !== '' ? Number(src.default) : limit;
    out[p] = Math.max(1, Math.min(limit, Math.floor(raw)));
  }
  return out;
}

/** 预算：null = 不限制；否则非负整数（分）。 */
function normalizeBudget(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new BatchError('BAD_REQUEST', 'budget_cap_cents 必须是非负整数（分）或 null');
  return n;
}

module.exports = {
  BatchError, KINDS, ON_FAIL, MAX_RETRY,
  toCents, yuanText, normalizeKinds, kindArg, parseHHMM, normalizeNight, inNightWindow, localMinutesOfDay,
  normalizePolicy, providerLimit, normalizeConcurrency, normalizeBudget,
};
