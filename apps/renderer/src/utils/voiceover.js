// 配音面板的纯逻辑：估价文案、提交结果摘要、队列状态文案。
import { t } from '../i18n/index.js'

const SKIP_REASONS = ['fresh', 'no_text', 'no_narration_node']
const sep = () => t('timeline.sep.comma')

/** 估价一行字：例如“3 个镜头 / 86 字，预计 0.02 元（最高 0.02 元，示例价）”。 */
export function estimateText(e) {
  if (!e) return ''
  const unit = e.currency === 'CNY' || !e.currency ? t('timeline.vo.unitCny') : e.currency
  const parts = [t('timeline.vo.est', { shots: e.shots, chars: e.chars, estimate: e.estimate, max: e.max, unit, sample: e.sample_prices ? t('timeline.vo.estSample') : '' })]
  if (e.price_known === false) parts.push(t('timeline.vo.noPrice'))
  return parts.join(t('timeline.sep.semi'))
}

/** 有事可做才需要确认；全部跳过时直接提示。 */
export function needsConfirm(e) {
  return !!(e && e.confirm_required && e.shots > 0)
}

/** 跳过原因的显示名。 */
export function skipText(reason) {
  return SKIP_REASONS.includes(reason) ? t(`timeline.vo.skip.${reason}`) : reason
}

/**
 * 提交结果摘要（配音走任务队列，确认后只建任务）：
 * “已提交 2 个配音任务到任务中心，1 个已在队列中，跳过 3 个”。兼容旧的 { done, failed } 形状。
 */
export function resultText(r) {
  if (!r) return ''
  const skipped = (r.skipped || []).length
  if (Array.isArray(r.tasks)) {
    const made = r.tasks.filter((t) => t.outcome === 'created' || t.outcome === 'retried').length
    const reused = r.tasks.length - made
    const bits = []
    if (made) bits.push(t('timeline.vo.result.submitted', { n: made }))
    if (reused) bits.push(t('timeline.vo.result.reused', { n: reused }))
    if (!r.tasks.length) bits.push(t('timeline.vo.result.none'))
    if (skipped) bits.push(t('timeline.vo.result.skipped', { n: skipped }))
    return bits.join(sep())
  }
  const done = (r.done || []).length
  const failed = r.failed || []
  const bits = [t('timeline.vo.result.done', { n: done })]
  if (failed.length) bits.push(t('timeline.vo.result.failedN', { n: failed.length, message: failed[0].message }))
  if (skipped) bits.push(t('timeline.vo.result.skipped', { n: skipped }))
  return bits.join(sep())
}

/** 状态接口里还有没有在跑的配音任务（排队或执行中）。 */
export function voStatusBusy(st) {
  const c = (st && st.counts) || {}
  return (c.queued || 0) + (c.running || 0) > 0
}

/** 状态一行字：“配音中：2 个排队，1 个生成中”“配音完成：5 个最新，1 个失败（原因）”。 */
export function voStatusText(st) {
  if (!st || !st.counts) return ''
  const c = st.counts
  const parts = []
  if (voStatusBusy(st)) {
    if (c.queued) parts.push(t('timeline.vo.status.queued', { n: c.queued }))
    if (c.running) parts.push(t('timeline.vo.status.running', { n: c.running }))
    return t('timeline.vo.status.busy', { parts: parts.join(sep()) })
  }
  if (c.fresh) parts.push(t('timeline.vo.status.fresh', { n: c.fresh }))
  if (c.stale) parts.push(t('timeline.vo.status.stale', { n: c.stale }))
  if (c.failed) {
    const bad = (st.shots || []).find((s) => s.state === 'failed' && s.error_message)
    parts.push(bad ? t('timeline.vo.status.failedWhy', { n: c.failed, why: bad.error_message }) : t('timeline.vo.status.failed', { n: c.failed }))
  }
  return parts.length ? t('timeline.vo.status.done', { parts: parts.join(sep()) }) : ''
}

/** 下拉选项：未实测的音色照常可选，label 已带说明。 */
export function voiceOptions(voices) {
  return (voices || []).map((v) => ({ value: v.id, label: v.label }))
}
