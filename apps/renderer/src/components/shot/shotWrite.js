// Write paths for the storyboard (no Vue). Shot fields go through kernel intents; columns the kernel does not own
// (asset binding, angle, frame ids ...) go through PUT /storyboards/:id, which the backend already routes via the kernel.
import { splitPatch } from './shotInspectorModel.js'

/**
 * Save a UI patch for one merged shot.
 * deps: { intent(view, name, args) -> summary|null, updateLegacy(legacyId, data) -> Promise }
 * Graph fields first (the intent re-materializes the legacy row), plain columns second.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveShotPatch(deps, shot, patch) {
  let parts
  try {
    parts = splitPatch(patch)
  } catch (e) {
    return { ok: false, error: e.message }
  }
  const { graph, legacy } = parts
  if (Object.keys(graph).length) {
    const res = await deps.intent('shot', 'setShotField', { shot_id: shot.id, patch: graph })
    if (!res) return { ok: false, error: 'intent' }
  }
  if (Object.keys(legacy).length) {
    if (shot.legacyId == null) return { ok: false, error: 'noLegacyRow' }
    try {
      await deps.updateLegacy(shot.legacyId, legacy)
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'legacy' }
    }
  }
  return { ok: true }
}

/** Flat list of shot ids in display order for a shots view. */
export function flatShots(groups) {
  return (groups || []).flatMap((g) => (g.shots || []).map((s) => s.id))
}

/**
 * Plan moving a shot one step up (-1) or down (+1) in the flattened order.
 * Inside a group: reorderShots; across a group boundary: moveShotToGroup. Returns null at the ends.
 */
export function planMove(groups, shotId, dir) {
  const list = groups || []
  const gi = list.findIndex((g) => (g.shots || []).some((s) => s.id === shotId))
  if (gi < 0) return null
  const ids = list[gi].shots.map((s) => s.id)
  const i = ids.indexOf(shotId)
  const j = i + dir
  if (j >= 0 && j < ids.length) {
    const next = [...ids]
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    return { name: 'reorderShots', args: { group_id: list[gi].id, ids: next } }
  }
  const k = gi + (dir < 0 ? -1 : 1)
  if (k < 0 || k >= list.length) return null
  const target = list[k]
  const index = dir < 0 ? (target.shots || []).length : 0
  return { name: 'moveShotToGroup', args: { shot_id: shotId, group_id: target.id, index } }
}

/** Where a new shot goes: after the given shot in its group, else the end of the last group. */
export function planAdd(groups, afterShotId) {
  const list = groups || []
  if (!list.length) return null
  const gi = afterShotId ? list.findIndex((g) => (g.shots || []).some((s) => s.id === afterShotId)) : -1
  if (gi >= 0) {
    const idx = list[gi].shots.findIndex((s) => s.id === afterShotId)
    return { group: list[gi].id, index: idx + 1 }
  }
  const last = list[list.length - 1]
  return { group: last.id, index: (last.shots || []).length }
}

/** Delete several shots one intent at a time (each is its own undo step); stops at the first failure. */
export async function deleteShots(deps, ids) {
  const done = []
  for (const id of ids) {
    const res = await deps.intent('shot', 'deleteShot', { shot_id: id })
    if (!res) return { ok: false, done }
    done.push(id)
  }
  return { ok: true, done }
}
