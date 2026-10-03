// Multi-select model for the storyboard cards / table (pure).
// A selection is { ids, anchor }; ids are always kept in display order.

export function emptySelection() {
  return { ids: [], anchor: null }
}

const inOrder = (order, set) => order.filter((id) => set.has(id))

/**
 * Apply a click. Modifiers: shift (range from anchor), ctrl/meta (toggle). ctrl+shift adds the range.
 * @param {{ids: string[], anchor: string|null}} sel
 * @param {string[]} order ids in display order
 */
export function clickSelect(sel, order, id, { shift = false, ctrl = false, meta = false } = {}) {
  const toggle = ctrl || meta
  const cur = new Set(sel.ids)
  if (shift && sel.anchor != null && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor)
    const b = order.indexOf(id)
    if (b < 0) return sel
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
    const next = toggle ? new Set([...cur, ...range]) : new Set(range)
    return { ids: inOrder(order, next), anchor: sel.anchor }
  }
  if (toggle) {
    if (cur.has(id)) cur.delete(id)
    else cur.add(id)
    return { ids: inOrder(order, cur), anchor: id }
  }
  return { ids: [id], anchor: id }
}

export function selectAll(order) {
  return { ids: [...order], anchor: order.length ? order[0] : null }
}

export function isSelected(sel, id) {
  return sel.ids.includes(id)
}

/** Drop ids that no longer exist (after a delete / regenerate / reload). */
export function pruneSelection(sel, order) {
  const live = new Set(order)
  const ids = sel.ids.filter((id) => live.has(id))
  return { ids, anchor: sel.anchor != null && live.has(sel.anchor) ? sel.anchor : null }
}

const hasOutput = (s) => !!s && ((s.image && s.image !== 'none') || (s.video && s.video !== 'none'))

/** Selected ids that can start a generation (not already running). */
export function generateTargets(sel, busy = {}) {
  return sel.ids.filter((id) => !busy[id])
}

/**
 * What batch actions are available for the selection.
 * @param {Object<string, {id, image?, video?}>} shotsById
 * @param {Object<string, boolean>} busy shots with a task running
 * @param {{locked?: boolean}} flags locked = a destructive operation (e.g. regenerate) is in progress
 */
export function batchAvailability(sel, shotsById, busy = {}, { locked = false } = {}) {
  const count = sel.ids.length
  const off = (reason) => ({ enabled: false, reason })
  const on = { enabled: true, reason: null }
  if (!count) return { count, generate: off('empty'), regenerate: off('empty'), delete: off('empty') }
  if (locked) return { count, generate: off('locked'), regenerate: off('locked'), delete: off('locked') }
  const free = generateTargets(sel, busy)
  const allBusy = free.length === 0
  return {
    count,
    generate: allBusy ? off('allBusy') : on,
    regenerate: allBusy ? off('allBusy') : free.some((id) => hasOutput(shotsById[id])) ? on : off('nothingToRedo'),
    delete: allBusy ? off('allBusy') : on,
  }
}
