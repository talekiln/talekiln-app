// Pure model behind ShotInspector / StoryboardPage: field routing, form diffing, capability checks.

// Kernel shot params (written with the setShotField intent). Everything else goes through PUT /storyboards/:id,
// which the backend already routes through the kernel for line-backed fields and writes directly for plain columns.
const TEXT_PARAMS = ['title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'image_prompt', 'video_prompt', 'atmosphere']
export const GRAPH_FIELDS = Object.freeze([...TEXT_PARAMS, 'duration_ms'])

/**
 * Split a UI patch (seconds for `duration`) into { graph, legacy }.
 * graph -> kernelAPI.intent('setShotField'); legacy -> storyboardsAPI.update(legacyId, ...).
 */
export function splitPatch(patch = {}) {
  const graph = {}
  const legacy = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'duration') {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) throw new Error('duration must be a positive number of seconds')
      graph.duration_ms = Math.max(1, Math.round(n * 1000))
    } else if (TEXT_PARAMS.includes(k)) {
      graph[k] = v
    } else {
      legacy[k] = v
    }
  }
  return { graph, legacy }
}

const str = (v) => (v == null ? '' : String(v))

const LEGACY_COLUMNS = [
  'scene_id', 'action', 'result', 'lighting_style', 'depth_of_field', 'angle_h', 'angle_v', 'angle_s', 'layout_description',
  'creation_mode', 'universal_segment_text', 'polished_prompt', 'first_frame_image_id', 'last_frame_image_id',
  'segment_title', 'segment_index', 'storyboard_number',
]

/** Join a kernel shot view (shots view item) with the legacy storyboard row (media / extra columns). */
export function mergeShot(view, legacy) {
  const p = view.params || {}
  const row = legacy || {}
  const m = {
    id: view.id,
    legacyId: view.legacy_id ?? row.id ?? null,
    title: str(p.title),
    description: str(p.description),
    location: str(p.location),
    time: str(p.time),
    shot_type: str(p.shot_type),
    angle: str(p.angle),
    movement: str(p.movement),
    atmosphere: str(p.atmosphere),
    image_prompt: str(p.image_prompt),
    video_prompt: str(p.video_prompt),
    characters: Array.isArray(p.characters) ? p.characters : [],
    duration: (view.planned_ms ?? p.duration_ms ?? 0) / 1000,
    dialogue: str(view.dialogue),
    narration: str(row.narration),
    plannedMs: view.planned_ms ?? 0,
    realMs: view.real_ms ?? null,
    imageState: view.image || 'none',
    videoState: view.video || 'none',
    narrationState: view.narration || 'none',
    row,
  }
  for (const c of LEGACY_COLUMNS) m[c] = row[c] ?? (c === 'action' || c === 'result' || c === 'layout_description' ? '' : null)
  return m
}

const FORM_FIELDS = [
  'title', 'description', 'location', 'time', 'shot_type', 'angle', 'movement', 'atmosphere', 'image_prompt', 'video_prompt',
  'duration', 'dialogue', 'narration', 'action', 'result', 'lighting_style', 'depth_of_field', 'angle_h', 'angle_v', 'angle_s',
  'layout_description',
]

/** Editable form values for a merged shot (strings, seconds). */
export function formFromShot(m) {
  const f = {}
  for (const k of FORM_FIELDS) f[k] = k === 'duration' ? m.duration : str(m[k])
  return f
}

/** Minimal patch: only the fields whose value differs from the shot. */
export function diffForm(form, m) {
  const base = formFromShot(m)
  const out = {}
  for (const k of FORM_FIELDS) {
    if (form[k] === undefined) continue
    const a = k === 'duration' ? Number(form[k]) : str(form[k])
    if (a !== base[k]) out[k] = k === 'duration' ? Number(form[k]) : str(form[k])
  }
  return out
}

/**
 * Does the active video model take several reference images (universal-segment mode)?
 * Same rule the legacy page used on the active video AI config (api_protocol kling_omni / volcengine_omni, or agnes).
 */
export function supportsMultiRef(cfg) {
  if (!cfg) return false
  const proto = str(cfg.api_protocol).toLowerCase()
  const provider = str(cfg.provider).toLowerCase()
  const model = str(cfg.default_model || (Array.isArray(cfg.model) ? cfg.model[0] : cfg.model)).toLowerCase()
  if (proto === 'kling_omni' || proto === 'volcengine_omni') return true
  return proto === 'agnes' || provider === 'agnes' || /agnes-video/.test(model)
}

/** A shot is in universal mode only when its column says so AND the model supports multiple references. */
export function shotMode(row, multiRefSupported) {
  return row && row.creation_mode === 'universal' && multiRefSupported ? 'universal' : 'classic'
}

const CHIP_STATES = ['none', 'queued', 'running', 'stale', 'fresh', 'failed']

/** i18n key for a queue / graph state chip. */
export function chipKey(state) {
  return `storyboard.state.${CHIP_STATES.includes(state) ? state : 'none'}`
}

export function summaryOf(shots) {
  const list = Array.isArray(shots) ? shots : []
  const ms = list.reduce((a, s) => a + (Number(s.planned_ms) || 0), 0)
  return { shots: list.length, seconds: Math.round(ms / 1000) }
}

/**
 * Plan for "regenerate storyboard from script". Backend Task 3 makes it one undoable kernel transaction,
 * so with `undoable` the confirm only says the old version can be restored; otherwise it warns that history is cleared.
 */
export function buildRegeneratePlan({ shotCount = 0, undoable = false } = {}) {
  if (!shotCount) return { confirm: false, mode: 'first' }
  return { confirm: true, mode: undoable ? 'undoable' : 'clearsHistory' }
}

/** What to tell the user after a regenerate, from the response / task result: undo | cleared | plain. */
export function undoNoticeKind(res) {
  const v = res && (res.can_undo ?? (res.data && res.data.can_undo) ?? (res.result && res.result.can_undo))
  if (v === true) return 'undo'
  if (v === false) return 'cleared'
  return 'plain'
}

const ACTIVE = ['queued', 'running', 'failed']

/**
 * Image / video chip states for one shot. A queue state (queued / running / failed) from the generation status wins;
 * otherwise the graph state (none / stale / fresh) is shown.
 */
export function shotChips(shot, genShot) {
  const pick = (kind, graph) => {
    const g = genShot && genShot[kind] && genShot[kind].state
    return ACTIVE.includes(g) ? g : graph || 'none'
  }
  return { image: pick('image', shot && shot.imageState), video: pick('video', shot && shot.videoState) }
}

/** True while either artifact of the shot is queued or running. */
export function isShotBusy(genShot) {
  return !!genShot && (genShot.state === 'queued' || genShot.state === 'running')
}

/** The video AI config that generation will use: the default active one, else the first active one. */
export function pickVideoConfig(list) {
  const rows = Array.isArray(list) ? list : (list && (list.items || list.configs)) || []
  const active = rows.filter((c) => c && c.is_active !== false && c.is_active !== 0)
  return active.find((c) => c.is_default) || active[0] || null
}

function idsOf(v) {
  let arr = v
  if (typeof v === 'string') {
    try { arr = JSON.parse(v) } catch (_) { return [] }
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const x of arr) {
    const n = Number(x && typeof x === 'object' ? x.id : x)
    if (Number.isFinite(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * Assets a shot row binds, in the row's own id order (that order is the reference-image order).
 * row: { characters, prop_ids, scene_id }; byKind: { characters, scenes, props } asset lists. Missing assets are skipped.
 */
export function orderedRefs(row, byKind) {
  const r = row || {}
  const pick = (list, ids) => ids.map((id) => (list || []).find((a) => Number(a.id) === id)).filter(Boolean)
  const sceneIds = r.scene_id != null && r.scene_id !== '' && Number(r.scene_id) > 0 ? [Number(r.scene_id)] : []
  return {
    scenes: pick(byKind && byKind.scenes, sceneIds),
    characters: pick(byKind && byKind.characters, idsOf(r.characters)),
    props: pick(byKind && byKind.props, idsOf(r.prop_ids)),
  }
}

/** Ids of a row column as numbers (characters / prop_ids). */
export const rowIds = idsOf

/** Move one id one step earlier (-1) or later (+1); returns a new array (unchanged at the ends). */
export function moveId(ids, id, dir) {
  const list = [...ids]
  const i = list.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return list
  list[i] = list[j]
  list[j] = id
  return list
}
