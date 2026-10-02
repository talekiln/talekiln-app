// 批量生成页（P3-B）的纯函数：金额（分）格式、估价文案、并发钳制、失败策略校验、状态标签、进度与耗时。无 Vue / 网络依赖。
import { formatMoney } from './spendView.js'

export const BATCH_STATUS_LABELS = { queued: '排队中', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' }
export const ITEM_STATUS_LABELS = { pending: '等待中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
export const WAITING_LABELS = {
  night: '不在夜间时段内，等待时段开始后再提交',
  concurrency: '已达并发上限，等待在途任务完成',
  budget: '预算接近上限，等待在途任务结束后再决定',
  turn: '等待前面的批次完成',
}
export const KINDS_OPTIONS = [
  { value: 'both', label: '首帧图 + 视频' },
  { value: 'image', label: '只生成首帧图' },
  { value: 'video', label: '只生成视频' },
]
export const ON_FAIL_OPTIONS = [
  { value: 'skip', label: '跳过该集，继续后面的' },
  { value: 'pause', label: '暂停整个批次' },
]
export const MAX_RETRY = 10
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const ACTIVE = ['queued', 'running']

/** 分 -> 金额文本（¥12.34）。 */
export function formatCents(cents, currency = 'CNY') {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '-'
  return formatMoney(n / 100, currency)
}

/** 「全部完成预计 ¥x–y（最多 ¥z）」：x–y 是预计区间，z 是预算上限（没设预算就不带括号）。 */
export function estimateText(totals, budgetCapCents = null, currency = 'CNY') {
  if (!totals) return ''
  const min = Number(totals.estimate_min_cents) || 0
  const max = Number(totals.estimate_max_cents) || 0
  const range = min === max ? formatCents(min, currency) : `${formatCents(min, currency)}–${formatCents(max, currency).replace(/^¥/, '')}`
  const cap = budgetCapCents != null ? `（最多 ${formatCents(budgetCapCents, currency)}）` : ''
  return `全部完成预计 ${range}${cap}`
}

/** 剩余预计（还没排进去的镜头 + 没开始的集）。 */
export function remainingText(totals, currency = 'CNY') {
  if (!totals) return ''
  const min = Number(totals.remaining_min_cents) || 0
  const max = Number(totals.remaining_max_cents) || 0
  if (!min && !max) return '剩余预计 ¥0.00'
  return `剩余预计 ${formatCents(min, currency)}–${formatCents(max, currency).replace(/^¥/, '')}`
}

/** 并发输入钳到 [1, limit]；非法取 fallback（缺省 = limit）。 */
export function clampConcurrency(value, limit, fallback) {
  const lim = Math.max(1, Math.floor(Number(limit) || 1))
  const dflt = fallback == null ? lim : fallback
  const n = Number(value)
  if (value === '' || value == null || !Number.isFinite(n)) return Math.max(1, Math.min(lim, Math.floor(Number(dflt) || lim)))
  return Math.max(1, Math.min(lim, Math.floor(n)))
}

/** 服务商列表 + 用户输入 -> 请求体里的并发（全部钳到上限）。 */
export function concurrencyBody(providers, input = {}) {
  const out = {}
  for (const p of providers || []) out[p.id] = clampConcurrency(input[p.id], p.limit, p.limit)
  return out
}

/**
 * 失败策略表单 -> { ok, errors, value }。表单：{ retry, on_fail, night_enabled, night_start, night_end }。
 * value 是请求体里的 failure_policy（night 关闭时为 null）。
 */
export function validatePolicy(form = {}) {
  const errors = []
  const retry = Number(form.retry)
  if (!Number.isInteger(retry) || retry < 0 || retry > MAX_RETRY) errors.push(`自动重试次数应为 0–${MAX_RETRY} 的整数`)
  const onFail = form.on_fail || 'skip'
  if (!['skip', 'pause'].includes(onFail)) errors.push('失败处理方式不合法')
  let night = null
  if (form.night_enabled) {
    const s = String(form.night_start || '').trim()
    const e = String(form.night_end || '').trim()
    if (!HHMM.test(s) || !HHMM.test(e)) errors.push('夜间时段的开始与结束应为 HH:MM')
    else if (s === e) errors.push('夜间时段的开始与结束不能相同')
    else night = { start: s, end: e }
  }
  return { ok: !errors.length, errors, value: { retry: Number.isInteger(retry) ? retry : 1, on_fail: onFail, night } }
}

/** 预算输入（元）-> 分；空 = 不限制；非法返回 { error }。 */
export function parseBudgetYuan(text) {
  const t = String(text ?? '').trim()
  if (t === '') return { value: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return { error: '请输入大于等于 0 的金额，留空表示不限制' }
  return { value: Math.round(n * 100) }
}

/** 创建请求体。 */
export function buildCreateBody({ dramaId, episodeIds, kinds = 'both', concurrency = {}, budgetCents = null, policy = null }) {
  const body = { drama_id: Number(dramaId), episode_ids: (episodeIds || []).map(Number), kinds, concurrency, budget_cap_cents: budgetCents }
  if (policy) body.failure_policy = policy
  return body
}

export const batchStatusLabel = (s) => BATCH_STATUS_LABELS[s] || s || '未知'
export const itemStatusLabel = (s) => ITEM_STATUS_LABELS[s] || s || '未知'
export const waitingText = (w) => WAITING_LABELS[w] || ''

export function batchStatusTag(status) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'cancelled') return 'info'
  if (status === 'paused' || status === 'queued') return 'warning'
  return 'primary'
}

export function itemStatusTag(status) {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'cancelled') return 'info'
  if (status === 'pending') return 'warning'
  return 'primary'
}

export const isActive = (batch) => !!batch && ACTIVE.includes(batch.status)
export const canPause = (batch) => isActive(batch)
export const canResume = (batch) => !!batch && batch.status === 'paused'
export const canCancel = (batch) => !!batch && ['queued', 'running', 'paused'].includes(batch.status)
export const canRetryFailed = (batch) => !!batch && batch.status !== 'cancelled' && !!batch.progress && batch.progress.items_failed > 0

/** 进度百分比：按镜头数；没有镜头数时按集数；完成的批次 100。 */
export function progressPercent(batch) {
  if (!batch || !batch.progress) return 0
  if (batch.status === 'completed') return 100
  const p = batch.progress
  if (p.shots_total > 0) return Math.min(100, Math.round((p.shots_done / p.shots_total) * 100))
  if (p.items_total > 0) return Math.min(100, Math.round((p.items_done / p.items_total) * 100))
  return 0
}

export function kindsLabel(kinds) {
  const k = Array.isArray(kinds) ? kinds : []
  if (k.includes('image') && k.includes('video')) return '首帧图 + 视频'
  if (k.includes('image')) return '首帧图'
  if (k.includes('video')) return '视频'
  return '-'
}

export function nightText(night) {
  if (!night) return '不限时段'
  const cross = night.start > night.end
  return `${night.start}–${night.end}${cross ? '（跨午夜）' : ''}`
}

/** 耗时文本。 */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${String(m % 60).padStart(2, '0')} 分`
}

/** 有活动批次时快速刷新。 */
export function pollInterval(batches) {
  return (batches || []).some(isActive) ? 3000 : 15000
}

/** 汇总卡片：进度 / 已花费 / 预计 / 耗时。 */
export function summaryCards(batch) {
  if (!batch) return []
  const cur = batch.currency || 'CNY'
  const p = batch.progress || {}
  const t = batch.totals || {}
  return [
    { key: 'progress', label: '进度', value: `${progressPercent(batch)}%`, sub: `${p.items_done || 0} / ${p.items_total || 0} 集 · ${p.shots_done || 0} / ${p.shots_total || 0} 镜` },
    { key: 'spent', label: '已花费', value: formatCents(t.spent_cents || 0, cur), sub: t.in_flight_max_cents ? `在途最高 ${formatCents(t.in_flight_max_cents, cur)}` : '按估算入账，实际以账单为准' },
    { key: 'estimate', label: '预计', value: `${formatCents(t.estimate_min_cents || 0, cur)}–${formatCents(t.estimate_max_cents || 0, cur).replace(/^¥/, '')}`, sub: remainingText(t, cur) },
    { key: 'elapsed', label: '耗时', value: elapsedText(batch.elapsed_ms), sub: batch.finished_at ? '已结束' : batch.started_at ? '进行中' : '未开始' },
  ]
}

/** 分集一行的任务概况文字。 */
export function itemTasksText(item) {
  const t = (item && item.tasks) || {}
  const parts = []
  if (t.running) parts.push(`${t.running} 在跑`)
  if (t.queued) parts.push(`${t.queued} 排队`)
  if (t.succeeded) parts.push(`${t.succeeded} 完成`)
  if (t.failed) parts.push(`${t.failed} 失败`)
  return parts.join(' · ') || '-'
}

/** 分集一行的镜头进度：done / total（total 未知时只给 done）。 */
export function itemShotsText(item) {
  if (!item) return '-'
  if (item.shots_total == null) return String(item.shots_done || 0)
  return `${item.shots_done || 0} / ${item.shots_total}`
}
