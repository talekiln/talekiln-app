/** 分镜工作台（P1-08）纯逻辑：候选 V1–V4、A/B 对比、快捷键动作映射。 */

export const MAX_CANDIDATES = 4

/** 把后端 candidates 返回规整为固定 4 个槽位（空槽为 null）。 */
export function toSlots(items) {
  const slots = Array.from({ length: MAX_CANDIDATES }, () => null)
  for (const it of Array.isArray(items) ? items : []) {
    const i = Number(it?.slot) - 1
    if (i >= 0 && i < MAX_CANDIDATES) slots[i] = it
  }
  return slots
}

export function isPlayable(c) {
  return !!(c && c.status === 'completed' && (c.video_url || c.local_path))
}

export function candidateVideoSrc(c) {
  if (!c) return ''
  const lp = c.local_path && String(c.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return c.video_url || ''
}

/** 第 n 个槽位（1 起）可选用的候选；未完成/不存在返回 null。 */
export function pickableAt(slots, n) {
  const c = slots?.[n - 1]
  return isPlayable(c) ? c : null
}

/**
 * A/B 对比状态：a/b 为槽位号（1 起），showing 为当前显示侧。
 * toggle 在 'a' / 'b' 之间切换；没有可对比的第二个候选时保持 'a'。
 */
export function createCompare() {
  return { a: null, b: null, showing: 'a' }
}

export function setCompareSide(state, side, slotNo) {
  const next = { ...state, [side]: slotNo }
  const other = side === 'a' ? 'b' : 'a'
  if (next[other] === slotNo) next[other] = null
  return next
}

export function toggleCompare(state) {
  if (state.a == null || state.b == null) return { ...state, showing: 'a' }
  return { ...state, showing: state.showing === 'a' ? 'b' : 'a' }
}

/** 默认对比：A=已采用候选(否则首个可播放)，B=另一个可播放候选。 */
export function defaultCompare(slots, adoptedId) {
  const playable = slots.map((c, i) => (isPlayable(c) ? { c, n: i + 1 } : null)).filter(Boolean)
  const adopted = playable.find((p) => p.c.id === adoptedId) || playable[0]
  const other = playable.find((p) => p !== adopted)
  return { a: adopted ? adopted.n : null, b: other ? other.n : null, showing: 'a' }
}

/** 当前应显示的槽位号。 */
export function shownSlot(state) {
  return state.showing === 'b' ? state.b : state.a
}

/** 动作 -> 处理函数。ctx: { regenerate, pick(n), toggleCompare, markIn, markOut }；供 createKeyHandler 使用。 */
export function buildWorkbenchHandlers(ctx) {
  return {
    'shot.regenerate': () => ctx.regenerate(),
    'shot.pick1': () => ctx.pick(1),
    'shot.pick2': () => ctx.pick(2),
    'shot.pick3': () => ctx.pick(3),
    'shot.pick4': () => ctx.pick(4),
    'shot.compareToggle': () => ctx.toggleCompare(),
    // P3-R 选镜改片：I / O 设入点 / 出点
    'shot.markIn': () => ctx.markIn && ctx.markIn(),
    'shot.markOut': () => ctx.markOut && ctx.markOut(),
  }
}
