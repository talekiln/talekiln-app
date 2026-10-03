// Shot parameter option tables and validation (pure). Labels live in i18n under storyboard.opt.<kind>.<value>.

const opt = (kind, value) => ({ value, key: `storyboard.opt.${kind}.${value}` })
const list = (kind, values) => values.map((v) => opt(kind, v))

export const LIGHTING = list('lighting', [
  'natural', 'front', 'side', 'backlit', 'top', 'under', 'soft', 'dramatic', 'golden_hour', 'blue_hour', 'night', 'neon',
])
export const DEPTH_OF_FIELD = list('dof', ['extreme_shallow', 'shallow', 'medium', 'deep'])
// Shot sizes are stored as these Chinese words in existing projects (kernel param `shot_type`), so values stay as-is.
const SHOT_SIZE_VALUES = [
  ['extreme_wide', '大远景'], ['wide', '远景'], ['medium', '中景'],  // i18n-ignore
  ['close', '近景'], ['extreme_close', '特写'],  // i18n-ignore
]
export const SHOT_TYPES = SHOT_SIZE_VALUES.map(([slug, value]) => ({ value, key: `storyboard.opt.shotType.${slug}` }))
export const ANGLE_SIZE = list('angle_s', ['close_up', 'medium', 'wide'])
export const ANGLE_PITCH = list('angle_v', ['eye_level', 'low', 'high', 'worm'])
export const ANGLE_YAW = list('angle_h', ['front', 'front_left', 'left', 'back_left', 'back', 'back_right', 'right', 'front_right'])

export const MOVEMENT_GROUPS = Object.freeze([
  { key: 'storyboard.opt.movementGroup.basic', options: list('movement', ['static', 'push', 'pull', 'pan', 'tilt', 'tracking', 'crane_up', 'crane_dn', 'orbit', 'handheld']) },
  { key: 'storyboard.opt.movementGroup.advanced', options: list('movement', ['zoom', 'roll', 'whip_pan', 'spiral']) },
  { key: 'storyboard.opt.movementGroup.cinematic', options: list('movement', ['hitchcock_zoom', 'bullet_time', 'dutch_angle_move', 'dolly_track', 'slowmo_orbit']) },
])

const TABLES = {
  lighting: LIGHTING,
  dof: DEPTH_OF_FIELD,
  shotType: SHOT_TYPES,
  angle_s: ANGLE_SIZE,
  angle_v: ANGLE_PITCH,
  angle_h: ANGLE_YAW,
  movement: MOVEMENT_GROUPS.flatMap((g) => g.options),
}

export function optionKey(kind, value) {
  return `storyboard.opt.${kind}.${value}`
}

export function isKnownOption(kind, value) {
  if (value === '' || value == null) return Object.prototype.hasOwnProperty.call(TABLES, kind)
  const t = TABLES[kind]
  return !!t && t.some((o) => o.value === value)
}

export const DURATION_RANGE = Object.freeze({ min: 0.5, max: 60 })
const MAX_TEXT = 2000

// field -> option table (the shot row column names)
const OPTION_FIELDS = {
  lighting_style: 'lighting',
  depth_of_field: 'dof',
  angle_s: 'angle_s',
  angle_v: 'angle_v',
  angle_h: 'angle_h',
}
const TEXT_FIELDS = ['layout_description', 'atmosphere', 'action', 'dialogue', 'narration', 'result', 'title', 'location', 'time']

/** Validate a (partial) param patch coming from the params dialog. Returns { ok, errors: {field: i18nKey} }. */
export function validateShotParams(p = {}) {
  const errors = {}
  for (const [field, kind] of Object.entries(OPTION_FIELDS)) {
    if (p[field] !== undefined && !isKnownOption(kind, p[field])) errors[field] = 'storyboard.err.badOption'
  }
  if (p.shot_type !== undefined && p.shot_type !== '' && !isKnownOption('shotType', p.shot_type)) errors.shot_type = 'storyboard.err.badOption'
  if (p.movement !== undefined && p.movement !== '' && !isKnownOption('movement', p.movement)) errors.movement = 'storyboard.err.badOption'
  if (p.duration !== undefined) {
    const n = Number(p.duration)
    if (!Number.isFinite(n) || n < DURATION_RANGE.min || n > DURATION_RANGE.max) errors.duration = 'storyboard.err.duration'
  }
  for (const f of TEXT_FIELDS) {
    if (typeof p[f] === 'string' && p[f].length > MAX_TEXT) errors[f] = 'storyboard.err.tooLong'
  }
  return { ok: Object.keys(errors).length === 0, errors }
}

/** Number of spoken dialogue lines: "Speaker: text" prefixes, or 1 when there is text without a speaker prefix. */
export function countDialogueLines(raw) {
  const s = (raw == null ? '' : String(raw)).trim()
  if (!s) return 0
  const m = s.match(/[一-龥A-Za-z0-9·]{1,16}[：:]/g)
  return m && m.length ? m.length : 1
}

/** A shot with two or more spoken parts (dialogue lines + narration) can be split by audio. */
export function canSplitByAudio({ dialogue, narration } = {}) {
  const hasNarration = !!(narration == null ? '' : String(narration)).trim()
  return countDialogueLines(dialogue) + (hasNarration ? 1 : 0) >= 2
}

/** Keys for the angle summary chip; null until size, pitch and yaw are all chosen. */
export function anglePromptKey({ s, v, h } = {}) {
  if (!s || !v || !h) return null
  return { size: optionKey('angle_s', s), pitch: optionKey('angle_v', v), yaw: optionKey('angle_h', h) }
}

// Video prompt snippets. `text` is the English prompt fragment sent to the video model; only the name is localized.
export const VIDEO_PROMPT_TEMPLATES = Object.freeze([
  { key: 'storyboard.tpl.slowPush', text: 'Slow dolly push-in, subtle handheld breathing, shallow depth of field.' },
  { key: 'storyboard.tpl.tracking', text: 'Smooth tracking shot following the subject, steady pace, natural motion blur.' },
  { key: 'storyboard.tpl.orbit', text: 'Gentle orbit around the subject, cinematic parallax, soft rim light.' },
  { key: 'storyboard.tpl.staticDialogue', text: 'Locked-off static frame, restrained performance, natural lip-sync with the dialogue.' },
  { key: 'storyboard.tpl.action', text: 'Dynamic action, quick whip pan, high-contrast lighting, crisp motion.' },
  { key: 'storyboard.tpl.atmosphere', text: 'Atmospheric slow drift, drifting particles, moody color grade.' },
])

/** Append a template to a prompt unless it is already there. */
export function applyTemplate(prompt, tpl) {
  const cur = (prompt == null ? '' : String(prompt)).trim()
  if (!cur) return tpl.text
  if (cur.includes(tpl.text)) return cur
  return `${cur} ${tpl.text}`
}
