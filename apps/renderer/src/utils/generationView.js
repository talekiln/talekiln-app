// 出图 / 出视频走持久队列（I1）的纯逻辑：状态标签、请求体、确认弹窗内容、轮询节奏。无 Vue / 网络依赖。
import { t } from '../i18n/index.js'
import { previewSummary, submittedText as submittedMessage } from '../components/generate/generateConfirm.js'

const GEN_STATES = ['none', 'queued', 'running', 'stale', 'fresh', 'failed']

const GEN_STATE_TAG = { none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }

/** 产物名：首帧图 / 视频 / 首帧图 + 视频（未知值原样返回）。 */
export const kindLabel = (kind) => (['image', 'video', 'both'].includes(kind) ? t(`generation.kind.${kind}`) : kind)

/** 状态芯片：{ label, type }。未知状态按“未生成”。 */
export function chipFor(state) {
  const s = GEN_STATES.includes(state) ? state : 'none'
  return { state: s, label: t(`generation.state.${s}`), type: GEN_STATE_TAG[s] }
}

/** 状态接口 -> Map<storyboard_id, 镜头状态>。 */
export function shotStatusMap(status) {
  const m = new Map()
  for (const s of (status && status.shots) || []) if (s.storyboard_id != null) m.set(Number(s.storyboard_id), s)
  return m
}

/** 该镜头当前的芯片；状态还没拉到时返回 null（界面不显示芯片而不是误报“未生成”）。 */
export function chipForShot(map, storyboardId) {
  const s = map && map.get(Number(storyboardId))
  return s ? chipFor(s.state) : null
}

/** 失败原因（来自镜头的首帧或视频任务）。 */
export function failureText(shotStatus) {
  if (!shotStatus || shotStatus.state !== 'failed') return ''
  const n = [shotStatus.image, shotStatus.video].find((x) => x && x.state === 'failed')
  return (n && (n.error_message || n.error_code)) || t('generation.failedSeeTasks')
}

/** 请求体。shots 为 storyboard id 数组或 'all'。 */
export function buildGenerateBody({ shots = 'all', kind = 'both', confirm = false, regenerate = false } = {}) {
  const body = { shots, kind, confirm }
  if (regenerate) body.regenerate = true
  return body
}

/** 有进行中的任务就快速轮询，否则放慢。 */
export function pollInterval(status) {
  const c = (status && status.counts) || {}
  return (c.queued || 0) + (c.running || 0) > 0 ? 3000 : 15000
}

export const isBusy = (shotStatus) => !!shotStatus && (shotStatus.state === 'queued' || shotStatus.state === 'running')

/**
 * 确认弹窗内容。preview 是 POST .../generate (confirm=false) 的返回。
 * 返回 { title, lines, warnings, blocked, blockedText, canConfirm, free }。
 *  - free：没有任何要花钱的项（全是已最新 / 命中缓存），仍可“确认”以采用缓存命中，但不显示金额。
 *  - blocked：额度检查没过（单次或月度上限），不能确认。
 */
export function confirmSummary(preview) {
  return previewSummary(preview)
}

/** 提交后的提示语。 */
export function submittedText(result) {
  return submittedMessage(result)
}

/** 任务中心里“对象”列：这个任务属于哪个镜头的什么产物。 */
export function taskTarget(task) {
  const p = task && task.params
  if (!p) return ''
  if (p._vo) return t('generation.target.shot', { n: p._vo.legacy_id ?? '?', what: t('generation.target.voiceover') })
  const g = p._gen
  if (!g) return ''
  return t('generation.target.shot', { n: g.storyboard_id ?? '?', what: kindLabel(g.kind === 'video' ? 'video' : 'image') })
}
