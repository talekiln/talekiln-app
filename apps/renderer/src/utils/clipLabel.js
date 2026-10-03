// 时间线片段的显示名：字幕显示文字；属于某个镜头的片段显示“镜 5 · 标题”；其余（音乐）显示素材文件名。
// 不再把素材哈希当标签。镜号与分镜页一致（场景组内顺序、全局从 1 开始）。
import { t } from '../i18n/index.js'
import { shotNumbers } from './projectViews.js'

/** shots 视图 -> { [storyboard_id(legacy_id)]: '镜 5 · 标题' }。 */
export function shotLabelsByLegacy(shotsView) {
  const nums = shotNumbers(shotsView)
  const out = {}
  for (const g of shotsView?.groups || []) {
    for (const s of g.shots) {
      if (s.legacy_id == null || !nums[s.id]) continue
      const title = String(s.params?.title ?? '').trim()
      out[s.legacy_id] = title ? t('common.shot.numberTitled', { n: nums[s.id], title }) : t('common.shot.number', { n: nums[s.id] })
    }
  }
  return out
}

/** @param {object} clip  时间线片段  @param {object} labels  shotLabelsByLegacy 的结果  @param {string} fallback 没有任何可用名字时的文字 */
export function clipDisplayLabel(clip, labels = {}, fallback = '') {
  if (clip.text) return clip.text
  if (clip.storyboard_id != null && labels[clip.storyboard_id]) return labels[clip.storyboard_id]
  const file = clip.asset_ref ? String(clip.asset_ref).split(/[\\/]/).pop() : ''
  return file || fallback
}
