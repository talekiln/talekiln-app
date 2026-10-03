// 批量生成页（P3-B）的纯函数：金额（分）格式、估价文案、并发钳制、失败策略校验、状态标签、进度与耗时。无 Vue / 网络依赖。
// 文案全部走 i18n（generate.batch.*）；需要给用户看的函数在调用时取当前语言。
import { formatMoney } from './spendView.js'
import { t } from '../i18n/index.js'

const STATUS_KEYS = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']
const ITEM_KEYS = ['pending', 'running', 'succeeded', 'failed', 'cancelled']
const WAITING_KEYS = ['night', 'concurrency', 'budget', 'turn']

export const KINDS_OPTIONS = ['both', 'image', 'video'].map((value) => ({ value, get label() { return t(`generate.batch.kinds.${value}`) } }))
export const ON_FAIL_OPTIONS = ['skip', 'pause'].map((value) => ({ value, get label() { return t(`generate.batch.onFail.${value}`) } }))
export const MAX_RETRY = 10
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const ACTIVE = ['queued', 'running']

/** 分 -> 金额文本（¥12.34）。 */
export function formatCents(cents, currency = 'CNY') {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '-'
  return formatMoney(n / 100, currency)
}

const centsRange = (min, max, currency) => (min === max ? formatCents(min, currency) : `${formatCents(min, currency)}–${formatCents(max, currency).replace(/^¥/, '')}`)

/** 「全部完成预计 ¥x–y（最多 ¥z）」：x–y 是预计区间，z 是预算上限（没设预算就不带括号）。 */
export function estimateText(totals, budgetCapCents = null, currency = 'CNY') {
  if (!totals) return ''
  const min = Number(totals.estimate_min_cents) || 0
  const max = Number(totals.estimate_max_cents) || 0
  const cap = budgetCapCents != null ? t('generate.batch.estimateCap', { cap: formatCents(budgetCapCents, currency) }) : ''
  return t('generate.batch.estimateAll', { range: centsRange(min, max, currency), cap })
}

/** 剩余预计（还没排进去的镜头 + 没开始的集）。 */
export function remainingText(totals, currency = 'CNY') {
  if (!totals) return ''
  const min = Number(totals.remaining_min_cents) || 0
  const max = Number(totals.remaining_max_cents) || 0
  if (!min && !max) return t('generate.batch.remaining', { range: formatCents(0, currency) })
  return t('generate.batch.remaining', { range: `${formatCents(min, currency)}–${formatCents(max, currency).replace(/^¥/, '')}` })
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
  if (!Number.isInteger(retry) || retry < 0 || retry > MAX_RETRY) errors.push(t('generate.batch.err.retry', { max: MAX_RETRY }))
  const onFail = form.on_fail || 'skip'
  if (!['skip', 'pause'].includes(onFail)) errors.push(t('generate.batch.err.onFail'))
  let night = null
  if (form.night_enabled) {
    const s = String(form.night_start || '').trim()
    const e = String(form.night_end || '').trim()
    if (!HHMM.test(s) || !HHMM.test(e)) errors.push(t('generate.batch.err.nightFormat'))
    else if (s === e) errors.push(t('generate.batch.err.nightSame'))
    else night = { start: s, end: e }
  }
  return { ok: !errors.length, errors, value: { retry: Number.isInteger(retry) ? retry : 1, on_fail: onFail, night } }
}

/** 预算输入（元）-> 分；空 = 不限制；非法返回 { error }。 */
export function parseBudgetYuan(text) {
  const s = String(text ?? '').trim()
  if (s === '') return { value: null }
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return { error: t('generate.batch.err.budget') }
  return { value: Math.round(n * 100) }
}

/** 创建请求体。 */
export function buildCreateBody({ dramaId, episodeIds, kinds = 'both', concurrency = {}, budgetCents = null, policy = null }) {
  const body = { drama_id: Number(dramaId), episode_ids: (episodeIds || []).map(Number), kinds, concurrency, budget_cap_cents: budgetCents }
  if (policy) body.failure_policy = policy
  return body
}

export const batchStatusLabel = (s) => (STATUS_KEYS.includes(s) ? t(`generate.batch.status.${s}`) : s || t('generate.batch.status.unknown'))
export const itemStatusLabel = (s) => (ITEM_KEYS.includes(s) ? t(`generate.batch.item.${s}`) : s || t('generate.batch.status.unknown'))
export const waitingText = (w) => (WAITING_KEYS.includes(w) ? t(`generate.batch.waiting.${w}`) : '')

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
  if (k.includes('image') && k.includes('video')) return t('generate.batch.kindsLabel.both')
  if (k.includes('image')) return t('generate.batch.kindsLabel.image')
  if (k.includes('video')) return t('generate.batch.kindsLabel.video')
  return '-'
}

export function nightText(night) {
  if (!night) return t('generate.batch.night.none')
  const cross = night.start > night.end
  return `${night.start}–${night.end}${cross ? t('generate.batch.night.cross') : ''}`
}

/** 耗时文本。 */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return t('generate.batch.elapsed.s', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('generate.batch.elapsed.ms', { m, s: String(s % 60).padStart(2, '0') })
  const h = Math.floor(m / 60)
  return t('generate.batch.elapsed.hm', { h, m: String(m % 60).padStart(2, '0') })
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
  const tot = batch.totals || {}
  return [
    {
      key: 'progress',
      label: t('generate.batch.card.progress'),
      value: `${progressPercent(batch)}%`,
      sub: t('generate.batch.card.progressSub', { items_done: p.items_done || 0, items_total: p.items_total || 0, shots_done: p.shots_done || 0, shots_total: p.shots_total || 0 }),
    },
    {
      key: 'spent',
      label: t('generate.batch.card.spent'),
      value: formatCents(tot.spent_cents || 0, cur),
      sub: tot.in_flight_max_cents ? t('generate.batch.card.inFlight', { v: formatCents(tot.in_flight_max_cents, cur) }) : t('generate.batch.card.estimated'),
    },
    {
      key: 'estimate',
      label: t('generate.batch.card.estimate'),
      value: `${formatCents(tot.estimate_min_cents || 0, cur)}–${formatCents(tot.estimate_max_cents || 0, cur).replace(/^¥/, '')}`,
      sub: remainingText(tot, cur),
    },
    {
      key: 'elapsed',
      label: t('generate.batch.card.elapsed'),
      value: elapsedText(batch.elapsed_ms),
      sub: batch.finished_at ? t('generate.batch.card.finished') : batch.started_at ? t('generate.batch.card.active') : t('generate.batch.card.notStarted'),
    },
  ]
}

/** 分集一行的任务概况文字。 */
export function itemTasksText(item) {
  const tk = (item && item.tasks) || {}
  const parts = []
  if (tk.running) parts.push(t('generate.batch.tasks.running', { n: tk.running }))
  if (tk.queued) parts.push(t('generate.batch.tasks.queued', { n: tk.queued }))
  if (tk.succeeded) parts.push(t('generate.batch.tasks.succeeded', { n: tk.succeeded }))
  if (tk.failed) parts.push(t('generate.batch.tasks.failed', { n: tk.failed }))
  return parts.join(' · ') || '-'
}

/** 分集一行的镜头进度：done / total（total 未知时只给 done）。 */
export function itemShotsText(item) {
  if (!item) return '-'
  if (item.shots_total == null) return String(item.shots_done || 0)
  return `${item.shots_done || 0} / ${item.shots_total}`
}
