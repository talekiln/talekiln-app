// Localized labels for the shot workbench. utils/regionEdit.js (not part of this lane) returns Chinese strings,
// so the workbench maps the same data to storyboard.* i18n keys here. `t(key, params)` is injected (pure, testable).
import { formatCents, formatMs, normalizeRect, savingPercent, segmentSeconds } from '../../utils/regionEdit.js'

/** Position of a normalized rect in the frame, as a localized phrase. */
export function rectLabelText(rect, t) {
  const r = normalizeRect(rect)
  if (!r || (r.w >= 0.95 && r.h >= 0.95)) return t('storyboard.wb.rect.full')
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const hor = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'mid'
  const ver = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'mid'
  if (hor === 'mid' && ver === 'mid') return t('storyboard.wb.rect.center')
  if (ver === 'mid') return t(`storyboard.wb.rect.${hor}`)
  if (hor === 'mid') return t(`storyboard.wb.rect.${ver}`)
  return t(`storyboard.wb.rect.${ver}_${hor}`)
}

/** One-line cost text for a region-edit estimate. */
export function costLineText(est, t) {
  if (!est || !est.estimate) return ''
  const e = est.estimate
  const cur = e.currency || 'CNY'
  const seconds = est.segment?.seconds ?? segmentSeconds(est.edit?.t0_ms, est.edit?.t1_ms)
  const parts = []
  if (e.full && e.full.cents > 0) {
    const s = savingPercent(e.cents, e.full.cents)
    parts.push(t(s > 0 ? 'storyboard.wb.cost.fullSave' : 'storyboard.wb.cost.full', { price: formatCents(e.full.cents, cur), pct: s }))
  }
  if (e.sample_prices || e.known === false) parts.push(t('storyboard.wb.cost.sample'))
  const base = t('storyboard.wb.cost.segment', { sec: seconds, price: formatCents(e.cents, cur) })
  return parts.length ? t('storyboard.wb.cost.withNotes', { base, notes: parts.join(t('storyboard.wb.cost.sep')) }) : base
}

export function strategyLabel(strategy, t) {
  if (strategy === 'provider_mask') return t('storyboard.wb.strategy.mask')
  if (strategy === 'segment_splice') return t('storyboard.wb.strategy.splice')
  return ''
}

/** Reason an estimate cannot be submitted ('' = fine). The server's own refusal message is shown as-is. */
export function refusalLabel(est, t) {
  if (!est) return ''
  if (est.allowed === false) return est.refusal?.message || t('storyboard.wb.refusal.cap')
  if (est.provider_ready === false) return t('storyboard.wb.refusal.provider', { provider: est.provider || '' })
  return ''
}

const STATUSES = ['queued', 'running', 'done', 'failed']
export function regionStatusLabel(status, t) {
  return STATUSES.includes(status) ? t(`storyboard.wb.regionStatus.${status}`) : String(status || '')
}

/** Summary of one region-edit record: "1.00s - 2.50s | where | prompt". */
export function regionLineText(item, t) {
  if (!item) return ''
  const where = item.mode === 'segment' ? t('storyboard.wb.mode.segmentShort') : rectLabelText(item.rect, t)
  return `${formatMs(item.t0_ms)} - ${formatMs(item.t1_ms)} | ${where} | ${item.prompt || ''}`
}

const KNOWN_SOURCES = { 'legacy-import': 'import', 'legacy-sync': 'sync', rebase: 'rebase' }
export function versionSourceLabel(source, t) {
  if (!source) return ''
  const s = String(source)
  if (KNOWN_SOURCES[s]) return t(`storyboard.wb.source.${KNOWN_SOURCES[s]}`)
  if (s.startsWith('ai-task:')) return t('storyboard.wb.source.ai')
  if (s.startsWith('region-edit:')) return t('storyboard.wb.source.regionEdit')
  return s
}

export function versionMetaLabel(metadata, t) {
  const meta = metadata || {}
  const bits = []
  if (meta.model) bits.push(t('storyboard.wb.meta.model', { model: meta.model }))
  if (meta.duration_ms) bits.push(t('storyboard.wb.meta.seconds', { sec: (meta.duration_ms / 1000).toFixed(1) }))
  return bits.join(' | ')
}

export function adoptLabel(item, t) {
  if (!item) return ''
  if (item.adopted) return t('storyboard.wb.adopt.current')
  return t(item.isEdit ? 'storyboard.wb.adopt.edit' : 'storyboard.wb.adopt.plain')
}
