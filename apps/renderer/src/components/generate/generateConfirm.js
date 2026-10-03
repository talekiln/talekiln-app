// 生成菜单的确认弹窗文案（纯函数，全部走 i18n）：出图/出视频预览、配音估价、草稿重跑。
// 与 utils/generationView.js 的 confirmSummary 同一套规则，只是文案可切换语言。
import { t } from '../../i18n/index.js'
import { formatMoney } from '../../utils/spendView.js'

/** 菜单 action -> generate 的 kind。只补齐过期和未生成的（regenerate=false），不会重做已最新的 */
const KINDS = {
  'generate.missing': { kind: 'both', regenerate: false },
  'generate.allFirstFrames': { kind: 'image', regenerate: false },
  'generate.allVideos': { kind: 'video', regenerate: false },
}

export function kindOf(actionId) {
  return KINDS[actionId] ? { ...KINDS[actionId] } : null
}

/**
 * POST .../generate (confirm=false) 的预览 -> 弹窗内容
 * { title, lines, warnings, blocked, blockedText, canConfirm, free }
 */
export function previewSummary(preview) {
  if (!preview) return { title: t('generate.confirm.title.free'), lines: [], warnings: [], blocked: false, blockedText: '', canConfirm: false, free: true }
  const items = preview.items || []
  const count = (kind, action) => items.filter((i) => i.kind === kind && i.action === action).length
  const images = count('image', 'create')
  const videos = count('video', 'create') + count('video', 'chain')
  const hits = items.filter((i) => i.action === 'cache_hit').length
  const fresh = items.filter((i) => i.action === 'fresh').length
  const blockedItems = items.filter((i) => i.action === 'blocked').length
  const est = preview.estimate || {}
  const cap = preview.cap || {}
  const cur = est.currency || cap.currency || 'CNY'
  const free = !(preview.billable > 0)

  const lines = []
  if (images) lines.push(t('generate.confirm.firstFrames', { n: images }))
  if (videos) lines.push(t('generate.confirm.videos', { n: videos }) + (items.some((i) => i.action === 'chain') ? t('generate.confirm.chainSuffix') : ''))
  if (hits) lines.push(t('generate.confirm.cacheHits', { n: hits }))
  if (fresh) lines.push(t('generate.confirm.fresh', { n: fresh }))
  if (blockedItems) lines.push(t('generate.confirm.blockedItems', { n: blockedItems }))
  if (!free) {
    lines.push(t('generate.confirm.estimate', { total: formatMoney(est.total, cur), max: formatMoney(est.max, cur) }))
    lines.push(cap.monthly_cap == null
      ? t('generate.confirm.quotaUnlimited')
      : t('generate.confirm.quotaRemaining', { remaining: formatMoney(cap.monthly_remaining, cur), cap: formatMoney(cap.monthly_cap, cur) }))
    if (cap.per_run_cap != null) lines.push(t('generate.confirm.perRunCap', { cap: formatMoney(cap.per_run_cap, cur) }))
  }

  const warnings = []
  if (!free && est.sample_prices) warnings.push(t('generate.warn.samplePrices'))
  if (!free && est.known === false) warnings.push(t('generate.warn.unknownPrice'))
  if (preview.provider_ready === false) warnings.push(t('generate.warn.noProvider'))
  if (items.some((i) => (i.warnings || []).includes('first_frame_stale'))) warnings.push(t('generate.warn.staleFirstFrame'))

  const blocked = preview.allowed === false
  return {
    title: t(free ? 'generate.confirm.title.free' : 'generate.confirm.title.paid'),
    lines,
    warnings,
    blocked,
    blockedText: blocked ? (preview.refusal && preview.refusal.message) || t('generate.blocked.default') : '',
    canConfirm: !blocked && preview.provider_ready !== false && (preview.billable > 0 || hits > 0),
    free,
  }
}

const taskCounts = (result) => {
  const tasks = (result && result.tasks) || []
  const made = tasks.filter((x) => x.outcome === 'created' || x.outcome === 'retried').length
  return { total: tasks.length, made, reused: tasks.length - made }
}

/** 提交后的提示语 */
export function submittedText(result) {
  const { total, made, reused } = taskCounts(result)
  if (!total) return t('generate.submitted.none')
  return t('generate.submitted.some', { n: made }) + (reused ? t('generate.submitted.reused', { n: reused }) : '')
}

/** 配音估价（POST voiceover 不带 confirm 的返回） */
export function voiceSummary(e) {
  const est = e || {}
  const cur = est.currency || 'CNY'
  const lines = []
  if (est.shots > 0) {
    lines.push(t('generate.voice.scope', { shots: est.shots, chars: est.chars ?? 0 }))
    lines.push(t('generate.voice.estimate', { total: formatMoney(est.estimate, cur), max: formatMoney(est.max, cur) }))
  }
  const warnings = []
  if (est.shots > 0 && est.sample_prices) warnings.push(t('generate.warn.samplePrices'))
  if (est.shots > 0 && est.price_known === false) warnings.push(t('generate.voice.priceUnknown'))
  const blocked = est.allowed === false
  return {
    lines,
    warnings,
    blocked,
    blockedText: blocked ? (est.refusal && est.refusal.message) || t('generate.blocked.default') : '',
    canConfirm: !blocked && !!est.confirm_required && est.shots > 0,
  }
}

/** 配音提交结果 */
export function voiceResultText(r) {
  if (!r) return ''
  const skipped = (r.skipped || []).length
  const { total, made, reused } = taskCounts(r)
  const bits = []
  if (made) bits.push(t('generate.voice.submitted', { n: made }))
  if (reused) bits.push(t('generate.voice.reused', { n: reused }))
  if (!total) bits.push(t('generate.voice.none'))
  if (skipped) bits.push(t('generate.voice.skipped', { n: skipped }))
  return bits.join(t('generate.voice.sep'))
}

/** GET quality/draft-nodes -> “按成片质量重跑”弹窗内容 */
export function rerunSummary(info) {
  const count = Number(info && info.count) || 0
  const est = (info && info.estimate) || {}
  const cur = est.currency || 'CNY'
  const lines = []
  if (count) {
    lines.push(t('generate.rerun.count', { n: count }))
    lines.push(t('generate.confirm.estimate', { total: formatMoney(est.amount, cur), max: formatMoney(est.max, cur) }))
  }
  const blocked = !!info && info.allowed === false
  return {
    lines,
    blocked,
    blockedText: blocked ? (info.refusal && info.refusal.message) || t('generate.blocked.default') : '',
    canConfirm: count > 0 && !blocked,
  }
}
