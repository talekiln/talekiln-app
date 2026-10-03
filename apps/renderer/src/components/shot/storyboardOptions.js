// Project-level storyboard settings (pure): parse drama metadata, build the generate options, patch the toggles.

export function parseMeta(metadata) {
  if (metadata == null) return {}
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata
  if (typeof metadata === 'string') {
    try {
      const v = JSON.parse(metadata)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch (_) {
      return {}
    }
  }
  return {}
}

/** The three project toggles the storyboard page shows. */
export function storyboardToggles(drama) {
  const m = parseMeta(drama && drama.metadata)
  return {
    useFirstLast: !!m.storyboard_use_first_last_frame,
    universal: !!m.storyboard_universal_omni,
    narration: !!m.storyboard_include_narration,
  }
}

const TOGGLE_KEYS = { useFirstLast: 'storyboard_use_first_last_frame', universal: 'storyboard_universal_omni', narration: 'storyboard_include_narration' }

/** Body for PUT /dramas/:id/outline that flips one toggle (the server merges metadata). */
export function togglePatch(name, value) {
  const key = TOGGLE_KEYS[name]
  if (!key) throw new Error(`unknown toggle: ${name}`)
  return { metadata: { [key]: !!value } }
}

/**
 * Body for POST /episodes/:id/storyboards, from the drama settings (same rules the legacy pages used).
 * @param {object} drama
 * @param {number} scriptLength characters of the episode script (0 when unknown)
 */
export function buildStoryboardOptions(drama, scriptLength = 0) {
  const m = parseMeta(drama && drama.metadata)
  let videoDuration
  if (m.video_clip_duration) videoDuration = Number(m.video_clip_duration)
  else if (scriptLength > 0) videoDuration = Math.max(10, Math.round(10 + (scriptLength / 600) * 60))
  return {
    style: m.style_prompt_en || m.style_prompt_zh || (drama && drama.style) || undefined,
    aspect_ratio: m.aspect_ratio || '16:9',
    video_duration: videoDuration,
    include_narration: !!m.storyboard_include_narration,
    universal_omni_storyboard: !!m.storyboard_universal_omni,
  }
}
