// P3-C 角色一致性的纯逻辑：评分芯片、建议文案、重做估价、自动挑参考图的结果展示。无 Vue / 网络依赖。
import { formatMoney } from './spendView.js'
import { t } from '../i18n/index.js'

export const SUGGESTION_LABELS = {
  get ok() { return t('consistency.suggestion.ok') },
  get check() { return t('consistency.suggestion.check') },
  get retry() { return t('consistency.suggestion.retry') },
}
const SUGGESTION_TAG = { ok: 'success', check: 'warning', retry: 'danger' }
const KIND_KEYS = { image: 'consistency.kind.image', video: 'consistency.kind.video', both: 'consistency.kind.both' }
const kindLabel = (kind) => (Object.hasOwn(KIND_KEYS, kind) ? t(KIND_KEYS[kind]) : kind)
export const PICK_SOURCE_LABELS = {
  get main() { return t('consistency.source.main') },
  get extra() { return t('consistency.source.extra') },
  get generated() { return t('consistency.source.generated') },
}
const pickSourceLabel = (source) => (Object.hasOwn(PICK_SOURCE_LABELS, source) ? PICK_SOURCE_LABELS[source] : t('consistency.source.candidate'))

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
  return { suggestion: s, label: t('consistency.badge', { score: fmtScore(shot.worst) }), type: SUGGESTION_TAG[s], score: shot.worst }
}

export const badgeForShot = (map, storyboardId) => consistencyBadge(map && map.get(Number(storyboardId)))

/** 最差分来自首帧图还是视频：'image' | 'video' | ''。 */
function worstNodeKind(shot) {
  const img = shot.image && shot.image.scored ? shot.image.worst : null
  const vid = shot.video && shot.video.scored ? shot.video.worst : null
  if (img != null && (vid == null || img <= vid)) return 'image'
  if (vid != null) return 'video'
  return ''
}
const worstNodeLabel = (shot) => kindLabel(worstNodeKind(shot))

/** 最差分那一行（最差节点 × 最差实体），人脸部分从这里取。 */
function worstRow(shot) {
  const node = worstNodeKind(shot) === 'video' ? shot.video : shot.image
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
    if (!face.ref_faces) return t('consistency.face.noRef')
    if (!face.matched_frames || face.score == null) return t('consistency.face.noMatch')
    return t('consistency.face.score', { score: fmtScore(face.score) })
  }
  if (report && report.face_available === false && report.face_reason !== 'disabled') return t('consistency.face.noModel')
  return ''
}

/** 按建议重做的估价文案；没有估价（都合格 / 估算失败）返回空串。 */
export function regenerateCostText(regen) {
  if (!regen || !regen.kind) return ''
  const cur = regen.currency || 'CNY'
  let text = t('consistency.regen', { kind: kindLabel(regen.kind), est: formatMoney(regen.estimate, cur), max: formatMoney(regen.max, cur) })
  if (regen.known === false) text += t('consistency.regen.noPrice')
  if (regen.allowed === false) text += t('consistency.regen.overCap')
  return text
}

/** 芯片的提示 / 工作台的建议行；传入报告时括号里带人脸部分（「人脸 NN」/「未检测到人脸」/「人脸模型未安装」）。 */
export function consistencyHint(shot, minScore, report = null) {
  const b = consistencyBadge(shot)
  if (!b) return ''
  const who = shot.entity && shot.entity.name ? t('consistency.hint.who', { name: shot.entity.name }) : ''
  const base = t('consistency.hint.subject', { node: worstNodeLabel(shot), who })
  const face = faceText(worstRow(shot), report)
  const low = t('consistency.hint.low', { score: fmtScore(shot.worst), face: face ? t('consistency.hint.face', { face }) : '' })
  if (b.suggestion === 'ok') return t('consistency.hint.ok', { base, low })
  const th = minScore != null && Number.isFinite(Number(minScore)) ? t('consistency.hint.threshold', { min: fmtScore(minScore) }) : ''
  const cost = regenerateCostText(shot.regenerate)
  if (b.suggestion === 'retry') return t('consistency.hint.retry', { base, low, th, tail: cost || t('consistency.hint.retryDefault') })
  return t('consistency.hint.check', { base, low, th, cost: cost ? t('consistency.hint.costTail', { cost }) : '' })
}

/** 评分不可用时的说明（报告 available=false）；可用返回空串。 */
export function unavailableText(report) {
  if (!report || report.available !== false) return ''
  return t(report.enabled === false ? 'consistency.unavailable.disabled' : 'consistency.unavailable.noCore')
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
  if (!ranked.length) return t('consistency.auto.none')
  const top = r.picked || ranked[0]
  const src = pickSourceLabel(top.source)
  let text = t('consistency.auto.summary', { anchor: r.anchor ? t('consistency.auto.anchor') : '', n: ranked.length, src, score: fmtScore(top.score) })
  if (r.locked) text += t('consistency.auto.locked')
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0
  if (skipped) text += t('consistency.auto.skipped', { n: skipped })
  return text
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
    sourceLabel: pickSourceLabel(x.source),
  }))
}
