// Frame-prompt helpers (pure): background task polling and result extraction.

/** Prompt text out of a finished frame-prompt task (legacy shape: result.response.single_frame.prompt). */
export function promptFromTask(task) {
  const p = task && task.result && task.result.response && task.result.response.single_frame && task.result.response.single_frame.prompt
  return p && String(p).trim() ? String(p).trim() : ''
}

/** Prompt text from the GET /frame-prompts list for one frame type. */
export function promptFromList(res, frameType) {
  const row = ((res && res.frame_prompts) || []).find((r) => r.frame_type === frameType)
  return row && row.prompt ? String(row.prompt).trim() : ''
}

/**
 * Poll a background task until it completes or fails.
 * deps: { get(taskId) -> task, sleep(ms) }. Resolves { ok, task, error? }.
 */
export async function pollTaskResult(deps, taskId, { intervalMs = 1500, maxTries = 80 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    let task = null
    try {
      task = await deps.get(taskId)
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'poll' }
    }
    const status = task && task.status
    if (status === 'completed') return { ok: true, task }
    if (status === 'failed' || status === 'cancelled') return { ok: false, task, error: (task && task.error) || status }
    await deps.sleep(intervalMs)
  }
  return { ok: false, error: 'timeout' }
}

/** Which frame prompt type a slot uses. */
export const frameTypeOf = (slot) => (slot === 'last' ? 'last' : 'first')
/** Image frame_type recorded for an uploaded / adopted image. */
export const imageFrameTypeOf = (slot) => (slot === 'last' ? 'storyboard_last' : 'storyboard_first')
/** Row column that binds the slot's image. */
export const boundColumnOf = (slot) => (slot === 'last' ? 'last_frame_image_id' : 'first_frame_image_id')
