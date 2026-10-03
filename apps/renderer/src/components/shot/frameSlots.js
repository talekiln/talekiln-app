// First / last frame slot model for a shot (pure; no Vue, no network).
// States: none -> generating -> has -> stale (stale = the adopted image no longer matches its inputs).

export const SLOT_STATES = Object.freeze(['none', 'generating', 'has', 'stale'])

/** Derive a slot's state from facts. Generating wins; stale only applies when there is an image. */
export function slotState({ hasImage = false, generating = false, stale = false } = {}) {
  if (generating) return 'generating'
  if (!hasImage) return 'none'
  return stale ? 'stale' : 'has'
}

/**
 * Event-driven transitions, for optimistic UI between polls.
 * events: start | done | fail | invalidate | adopt | clear
 */
export function nextSlotState(state, event, { hadImage = false } = {}) {
  switch (event) {
    case 'start': return 'generating'
    case 'done': return 'has'
    case 'fail': return hadImage ? 'has' : 'none'
    case 'invalidate': return state === 'has' ? 'stale' : state
    case 'adopt': return 'has'
    case 'clear': return 'none'
    default: return state
  }
}

function firstSlot(first, ctx) {
  const state = slotState(first)
  const busy = state === 'generating'
  let prevTailReason = null
  if (!ctx.useFirstLast) prevTailReason = 'singleMode'
  else if (!ctx.prev || !ctx.prev.exists) prevTailReason = 'noPrev'
  else if (!ctx.prev.lastHasImage) prevTailReason = 'prevNoTail'
  const hasPic = state === 'has' || state === 'stale'
  return {
    slot: 'first',
    state,
    canGenerate: !busy,
    canUpload: !busy,
    canEditPrompt: true,
    canUpscale: hasPic,
    canPickHistory: !busy,
    canUsePrevTail: !busy && prevTailReason === null,
    prevTailReason,
  }
}

function lastSlot(last, first, ctx) {
  const state = slotState(last)
  const busy = state === 'generating'
  const firstHas = !!first.hasImage
  let generateReason = null
  if (!ctx.capabilities.lastFrameGenerate) generateReason = 'queueUnsupported'
  else if (!firstHas) generateReason = 'needFirst'
  return {
    slot: 'last',
    state,
    canGenerate: !busy && generateReason === null,
    generateReason,
    canUpload: !busy,
    canEditPrompt: true,
    canUpscale: false,
    canPickHistory: !busy,
  }
}

/**
 * @param {{
 *   useFirstLast: boolean,
 *   first: {hasImage?, generating?, stale?}, last?: {hasImage?, generating?, stale?},
 *   prev?: {exists: boolean, lastHasImage?: boolean}, next?: {exists: boolean},
 *   hasVideo?: boolean, linking?: boolean,
 *   capabilities?: {lastFrameGenerate?: boolean},
 * }} input
 */
export function buildFrameSlots(input) {
  const ctx = {
    useFirstLast: !!input.useFirstLast,
    prev: input.prev || { exists: false },
    capabilities: { lastFrameGenerate: false, ...(input.capabilities || {}) },
  }
  const first = input.first || {}
  const last = input.last || {}
  let linkReason = null
  if (!input.next || !input.next.exists) linkReason = 'noNext'
  else if (!input.hasVideo) linkReason = 'noVideo'
  else if (input.linking) linkReason = 'busy'
  return {
    mode: ctx.useFirstLast ? 'firstLast' : 'single',
    first: firstSlot(first, ctx),
    last: ctx.useFirstLast ? lastSlot(last, first, ctx) : null,
    linkTail: { enabled: linkReason === null, reason: linkReason },
  }
}

/** Resolve the bound first / last image records from a list of image rows and the shot row (ids win). */
export function pickSlotImages(images, row) {
  const list = Array.isArray(images) ? images : []
  const byId = (id) => (id == null ? null : list.find((i) => i.id === id) || null)
  const typed = (type) => list.find((i) => i.frame_type === type) || null
  return {
    first: byId(row?.first_frame_image_id) || typed('storyboard_first') || null,
    last: byId(row?.last_frame_image_id) || typed('storyboard_last') || null,
  }
}

/** Images not bound to either slot, shown as the history strip. */
export function historyItems(images, bound) {
  const skip = new Set([bound?.first?.id, bound?.last?.id].filter((x) => x != null))
  return (Array.isArray(images) ? images : []).filter((i) => !skip.has(i.id))
}
