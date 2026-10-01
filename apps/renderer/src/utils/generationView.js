// 出图 / 出视频走持久队列（I1）的纯逻辑：状态标签、请求体、确认弹窗内容、轮询节奏。无 Vue / 网络依赖。
import { formatMoney } from './spendView.js'

export const GEN_STATE_LABELS = {
  none: '未生成',
  queued: '排队中',
  running: '生成中',
  stale: '需更新',
  fresh: '最新',
  failed: '失败',
}

const GEN_STATE_TAG = { none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }

export const KIND_LABELS = { image: '首帧图', video: '视频', both: '首帧图 + 视频' }

/** 状态芯片：{ label, type }。未知状态按“未生成”。 */
export function chipFor(state) {
  const s = Object.prototype.hasOwnProperty.call(GEN_STATE_LABELS, state) ? state : 'none'
  return { state: s, label: GEN_STATE_LABELS[s], type: GEN_STATE_TAG[s] }
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
  return (n && (n.error_message || n.error_code)) || '生成失败，详见任务中心'
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

const plural = (n, unit) => `${n} ${unit}`

/**
 * 确认弹窗内容。preview 是 POST .../generate (confirm=false) 的返回。
 * 返回 { title, lines, warnings, blocked, blockedText, canConfirm, free }。
 *  - free：没有任何要花钱的项（全是已最新 / 命中缓存），仍可“确认”以采用缓存命中，但不显示金额。
 *  - blocked：额度检查没过（单次或月度上限），不能确认。
 */
export function confirmSummary(preview) {
  if (!preview) return { title: '确认生成', lines: [], warnings: [], blocked: false, blockedText: '', canConfirm: false, free: true }
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
  if (images) lines.push(`首帧图 ${plural(images, '张')}`)
  if (videos) lines.push(`视频 ${plural(videos, '段')}${items.some((i) => i.action === 'chain') ? '（首帧完成后自动接着生成）' : ''}`)
  if (hits) lines.push(`${plural(hits, '项')}已有相同内容的旧结果，直接采用，不收费`)
  if (fresh) lines.push(`${plural(fresh, '项')}已是最新，跳过`)
  if (blockedItems) lines.push(`${plural(blockedItems, '项')}缺少提示词或节点，无法生成`)
  if (!free) {
    lines.push(`预计费用 ${formatMoney(est.total, cur)}（最高 ${formatMoney(est.max, cur)}）`)
    lines.push(cap.monthly_cap == null
      ? '本月额度：未设置上限'
      : `本月剩余额度 ${formatMoney(cap.monthly_remaining, cur)}（上限 ${formatMoney(cap.monthly_cap, cur)}，已含在途任务）`)
    if (cap.per_run_cap != null) lines.push(`单次上限 ${formatMoney(cap.per_run_cap, cur)}`)
  }

  const warnings = []
  if (!free && est.sample_prices) warnings.push('价格表为示例价，实际以服务商账单为准')
  if (!free && est.known === false) warnings.push('部分模型没有价格，未计入预计费用')
  if (preview.provider_ready === false) warnings.push('还没有可用的服务商 Key，请先到设置里添加')
  if (items.some((i) => (i.warnings || []).includes('first_frame_stale'))) warnings.push('有镜头的首帧已过期，视频将沿用旧首帧；可选“首帧图 + 视频”一起更新')

  const blocked = preview.allowed === false
  return {
    title: `确认生成：${free ? '无需付费' : '将产生费用'}`,
    lines,
    warnings,
    blocked,
    blockedText: blocked ? (preview.refusal && preview.refusal.message) || '超过花费上限' : '',
    canConfirm: !blocked && preview.provider_ready !== false && (preview.billable > 0 || hits > 0),
    free,
  }
}

/** 提交后的提示语。 */
export function submittedText(result) {
  const tasks = (result && result.tasks) || []
  const made = tasks.filter((t) => t.outcome === 'created' || t.outcome === 'retried').length
  const reused = tasks.length - made
  if (!tasks.length) return '没有需要生成的内容（已最新或已命中旧结果）'
  return `已加入队列 ${made} 个任务${reused ? `，${reused} 个已在队列中` : ''}，可在任务中心查看进度`
}

/** 任务中心里“对象”列：这个任务属于哪个镜头的什么产物。 */
export function taskTarget(task) {
  const g = task && task.params && task.params._gen
  if (!g) return ''
  return `镜头 #${g.storyboard_id ?? '?'} · ${g.kind === 'video' ? '视频' : '首帧图'}`
}
