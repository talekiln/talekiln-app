// Pure view-model for the storyboard page: kernel shot groups + legacy storyboard rows + unsaved table edits.
import { rowFromApi } from '../../utils/storyboardTable.js'

const str = (v) => (v == null ? '' : String(v))

/**
 * @param {Array} groups kernel shots view groups: [{id, title, shots:[{id, legacy_id, params, planned_ms, dialogue, image, video}]}]
 * @param {{ numbers?: Object<string, number>, rows?: Object<number, object>, drafts?: Object<string, object>, staleIds?: Set<string>|string[], staleOnly?: boolean }} ctx
 *   rows: legacy storyboard rows by legacy id (GET /episodes/:id/storyboards), drafts: unsaved edits by shot id.
 * @returns {Array<{id, title, seconds, count, items: Array}>} groups with at least one visible item (empty groups are kept unless staleOnly)
 */
export function buildPageGroups(groups, { numbers = {}, rows = {}, drafts = {}, staleIds = [], staleOnly = false } = {}) {
  const stale = staleIds instanceof Set ? staleIds : new Set(staleIds)
  const out = []
  for (const g of groups || []) {
    const items = []
    for (const s of g.shots || []) {
      const p = s.params || {}
      const draft = drafts[s.id] || {}
      const row = s.legacy_id != null ? rows[s.legacy_id] : null
      const thumb = row ? rowFromApi(row).thumb : ''
      const isStale = stale.has(s.id)
      if (staleOnly && !isStale) continue
      const seconds = draft.duration != null ? Number(draft.duration) || 0 : (s.planned_ms ?? p.duration_ms ?? 0) / 1000
      items.push({
        id: s.id,
        legacyId: s.legacy_id ?? null,
        no: numbers[s.id] || 0,
        title: str(p.title),
        description: draft.description != null ? str(draft.description) : str(p.description),
        dialogue: draft.dialogue != null ? str(draft.dialogue) : str(s.dialogue),
        duration: seconds,
        thumb,
        stale: isStale,
        imageState: s.image || 'none',
        videoState: s.video || 'none',
        status: row ? row.status || 'pending' : 'pending',
      })
    }
    if (staleOnly && !items.length) continue
    out.push({ id: g.id, title: str(g.title), count: items.length, seconds: items.reduce((a, i) => a + i.duration, 0), items })
  }
  return out
}

/** Flat visible shot ids in display order. */
export function visibleIds(pageGroups) {
  return pageGroups.flatMap((g) => g.items.map((i) => i.id))
}

/** Status-bar numbers: shot count and total seconds (unfiltered). */
export function pageSummary(pageGroups) {
  let shots = 0
  let seconds = 0
  for (const g of pageGroups) {
    shots += g.items.length
    seconds += g.seconds
  }
  return { shots, seconds: Math.round(seconds * 10) / 10 }
}

/** Neighbour check for the up / down buttons over the whole (unfiltered) order. */
export function moveFlags(allIds, id) {
  const i = allIds.indexOf(id)
  return { canUp: i > 0, canDown: i >= 0 && i < allIds.length - 1 }
}

/** Legacy ids of a selection (ids without a legacy row are dropped). */
export function legacyIdsOf(ids, items) {
  const by = new Map(items.map((i) => [i.id, i]))
  return ids.map((id) => by.get(id)).filter((i) => i && i.legacyId != null).map((i) => i.legacyId)
}
