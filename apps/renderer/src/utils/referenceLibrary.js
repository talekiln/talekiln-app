/** 角色/场景库（P1-07）纯逻辑：候选参考图、锁定状态。 */

export const CANDIDATE_COUNT = 4

/** 候选参考图生成请求体：不带 character_id/scene_id，避免覆盖主图；锁定由单独接口完成。 */
export function buildCandidateRequest({ kind, entity, dramaId, model, style }) {
  const base = kind === 'scene'
    ? [entity.location, entity.time, entity.prompt].filter(Boolean).join('，')
    : [entity.name, entity.appearance, entity.description].filter(Boolean).join('，')
  const hint = kind === 'scene' ? '场景参考图，无人物，环境设定' : '角色设定参考图，全身，纯色背景，正面站姿'
  return {
    drama_id: Number(dramaId) || 0,
    prompt: `${base}。${hint}`,
    model: model || undefined,
    style: style || undefined,
    frame_type: 'reference_candidate',
  }
}

export function candidateImageSrc(c) {
  if (!c) return ''
  const lp = c.local_path && String(c.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return c.image_url || ''
}

/** 仅已完成且有图的候选可锁定。 */
export function isLockable(c) {
  return !!(c && c.status === 'completed' && (c.image_url || c.local_path))
}

export function lockBody(c) {
  return { image_url: c.image_url || null, local_path: c.local_path || null, source_image_id: c.id ?? null }
}

/** 候选是否正是当前锁定图。 */
export function isLockedCandidate(c, lock) {
  if (!c || !lock) return false
  if (lock.source_image_id != null && c.id != null) return Number(lock.source_image_id) === Number(c.id)
  return (!!c.local_path && c.local_path === lock.local_path) || (!!c.image_url && c.image_url === lock.image_url)
}

/** 把 locks 数组转成 { `${type}:${id}`: lock } 便于查找。 */
export function indexLocks(type, locks) {
  const m = {}
  for (const l of Array.isArray(locks) ? locks : []) m[`${type}:${l.entity_id}`] = l
  return m
}
