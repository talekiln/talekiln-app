// P3-C 角色一致性的纯逻辑：评分芯片、建议文案、重做估价、自动挑参考图的结果展示。无 Vue / 网络依赖。
import { formatMoney } from './spendView.js'

export const SUGGESTION_LABELS = { ok: '一致', check: '需检查', retry: '建议重做' }
const SUGGESTION_TAG = { ok: 'success', check: 'warning', retry: 'danger' }
const KIND_LABELS = { image: '首帧图', video: '视频', both: '首帧图 + 视频' }
export const PICK_SOURCE_LABELS = { main: '主图', extra: '额外图', generated: '生成图' }

const fmtScore = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? String(Math.round(Number(v))) : '-')

/** 报告 -> Map<storyboard_id, 镜头项>。 */
export function consistencyShotMap(report) {
  const m = new Map()
  for (const s of (report && report.shots) || []) if (s.storyboard_id != null) m.set(Number(s.storyboard_id), s)
  return m
}

/** 评分芯片：{ label, type, suggestion, score }；没评过分（没有锁定参考图 / 没有内核）返回 null，界面不显示。 */
export function consistencyBadge(shot) {
  if (!shot || !shot.scored || !shot.suggestion) return null
  const s = SUGGESTION_LABELS[shot.suggestion] ? shot.suggestion : 'check'
  return { suggestion: s, label: `一致性 ${fmtScore(shot.worst)}`, type: SUGGESTION_TAG[s], score: shot.worst }
}

export const badgeForShot = (map, storyboardId) => consistencyBadge(map && map.get(Number(storyboardId)))

/** 最差分来自首帧图还是视频。 */
function worstNodeLabel(shot) {
  const img = shot.image && shot.image.scored ? shot.image.worst : null
  const vid = shot.video && shot.video.scored ? shot.video.worst : null
  if (img != null && (vid == null || img <= vid)) return '首帧图'
  if (vid != null) return '视频'
  return ''
}

/** 最差分那一行（最差节点 × 最差实体），人脸部分从这里取。 */
function worstRow(shot) {
  const node = worstNodeLabel(shot) === '视频' ? shot.video : shot.image
  const rows = (node && Array.isArray(node.scores) && node.scores) || []
  const e = shot.entity || {}
  return rows.find((r) => r.entity_type === e.type && Number(r.entity_id) === Number(e.id)) || null
}

/**
 * 人脸部分的文案（只对角色参考图）：行 parts.face 有相似度 → 「人脸 NN」；参考图有脸但目标里没有 → 「未检测到人脸」；
 * 参考图本身没脸 → 「参考图未检测到人脸」；没算过且报告 face_available=false（模型 / onnxruntime 缺失）→ 「人脸模型未安装」；其余空串。
 */
export function faceText(row, report = null) {
  if (!row || row.entity_type !== 'character') return ''
  const face = row.parts && row.parts.face
  if (face && typeof face === 'object' && !face.error) {
    if (!face.ref_faces) return '参考图未检测到人脸'
    if (!face.matched_frames || face.score == null) return '未检测到人脸'
    return `人脸 ${fmtScore(face.score)}`
  }
  if (report && report.face_available === false && report.face_reason !== 'disabled') return '人脸模型未安装'
  return ''
}

/** 按建议重做的估价文案；没有估价（都合格 / 估算失败）返回空串。 */
export function regenerateCostText(regen) {
  if (!regen || !regen.kind) return ''
  const cur = regen.currency || 'CNY'
  let t = `重做${KIND_LABELS[regen.kind] || regen.kind}预计 ${formatMoney(regen.estimate, cur)}（最高 ${formatMoney(regen.max, cur)}）`
  if (regen.known === false) t += '，部分模型没有价格'
  if (regen.allowed === false) t += '，已超出花费上限'
  return t
}

/** 芯片的提示 / 工作台的建议行；传入报告时括号里带人脸部分（「人脸 NN」/「未检测到人脸」/「人脸模型未安装」）。 */
export function consistencyHint(shot, minScore, report = null) {
  const b = consistencyBadge(shot)
  if (!b) return ''
  const who = shot.entity && shot.entity.name ? `「${shot.entity.name}」的` : ''
  const base = `${worstNodeLabel(shot)}与${who}锁定参考图`
  const face = faceText(worstRow(shot), report)
  const low = `最低 ${fmtScore(shot.worst)} 分${face ? `，${face}` : ''}`
  if (b.suggestion === 'ok') return `${base}一致（${low}）`
  const th = minScore != null && Number.isFinite(Number(minScore)) ? `，阈值 ${fmtScore(minScore)}` : ''
  const cost = regenerateCostText(shot.regenerate)
  if (b.suggestion === 'retry') return `${base}相差较大（${low}${th}）：${cost || '建议重新生成'}`
  return `${base}有差异（${low}${th}）：请检查画面${cost ? `；${cost}` : ''}`
}

/** 评分不可用时的说明（报告 available=false）；可用返回空串。 */
export function unavailableText(report) {
  if (!report || report.available !== false) return ''
  return report.enabled === false ? '一致性评分已在配置里关闭' : '渲染核心未启动，暂时无法评分'
}

/** 状态接口里排队 + 生成中的镜头数；由 >0 变 0 时该重新拉一次评分报告。 */
export function busyCount(status) {
  const c = (status && status.counts) || {}
  return (c.queued || 0) + (c.running || 0)
}

/** 单个镜头：从排队 / 生成中变成别的状态 = 有新结果落地，该重新拉评分。 */
export function shouldRefreshConsistency(prevState, nextState) {
  return (prevState === 'queued' || prevState === 'running') && nextState !== prevState
}

/** 自动挑选的结果提示语。 */
export function autoPickSummary(r) {
  if (!r) return ''
  const ranked = Array.isArray(r.ranked) ? r.ranked : []
  if (!ranked.length) return '没有可排序的候选图'
  const top = r.picked || ranked[0]
  const src = PICK_SOURCE_LABELS[top.source] || '候选'
  let t = `已按清晰度、分辨率${r.anchor ? '与四视图相似度' : ''}排序 ${ranked.length} 张候选，第一名：${src}（${fmtScore(top.score)} 分）`
  if (r.locked) t += '，已锁定为参考图'
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0
  if (skipped) t += `；${skipped} 张远程或缺失的图未参与`
  return t
}

/** 排好序的候选 -> 角色库候选卡片用的记录（可用既有的“锁定为参考图”按钮）。 */
export function rankedToCandidates(r) {
  return ((r && r.ranked) || []).map((x) => ({
    id: x.source_image_id ?? null,
    status: 'completed',
    image_url: x.image_url || null,
    local_path: x.local_path || null,
    score: x.score,
    source: x.source || null,
    sourceLabel: PICK_SOURCE_LABELS[x.source] || '候选',
  }))
}
