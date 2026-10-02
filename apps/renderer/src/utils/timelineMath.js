/** 时间线纯逻辑：时间/像素换算、吸附、重叠检查、片段操作（无 DOM / Vue 依赖） */

export const TRACK_KINDS = ['video', 'subtitle', 'narration', 'music']
/** 允许片段重叠的轨道（与后端一致） */
export const OVERLAP_ALLOWED = new Set(['music'])
export const MIN_CLIP_MS = 100
export const ZOOM_MIN = 5
export const ZOOM_MAX = 400
export const DEFAULT_ZOOM = 60

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

/** pxPerSec: 每秒对应的像素数 */
export function msToPx(ms, pxPerSec) {
  return (ms * pxPerSec) / 1000
}

export function pxToMs(px, pxPerSec) {
  return Math.round((px * 1000) / pxPerSec)
}

export function clampZoom(pxPerSec) {
  return clamp(pxPerSec, ZOOM_MIN, ZOOM_MAX)
}

export function zoomBy(pxPerSec, factor) {
  return clampZoom(Math.round(pxPerSec * factor * 100) / 100)
}

export function formatTime(ms) {
  const total = Math.max(0, Math.round(ms))
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const t = Math.floor((total % 1000) / 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t}`
}

/** 刻度步长（ms）：保证相邻主刻度间距 >= minPx */
export function rulerStepMs(pxPerSec, minPx = 70) {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
  for (const s of steps) if (msToPx(s, pxPerSec) >= minPx) return s
  return steps[steps.length - 1]
}

export function rulerTicks(durationMs, pxPerSec) {
  const step = rulerStepMs(pxPerSec)
  const out = []
  for (let t = 0; t <= durationMs; t += step) out.push({ ms: t, x: msToPx(t, pxPerSec), label: formatTime(t) })
  return out
}

export function clipEnd(c) {
  return c.start_ms + c.duration_ms
}

export function timelineDuration(tracks) {
  let end = 0
  for (const t of tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

export function findClip(tracks, clipId) {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

export function clipAt(track, ms) {
  return track.clips.find((c) => ms >= c.start_ms && ms < clipEnd(c)) || null
}

/** 吸附目标：0、播放头、其它片段的起止点 */
export function snapPoints(tracks, excludeId, playheadMs) {
  const pts = [0]
  if (playheadMs != null) pts.push(playheadMs)
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.id === excludeId) continue
      pts.push(c.start_ms, clipEnd(c))
    }
  }
  return pts
}

/** 将 ms 吸附到最近的点（阈值内），返回 { ms, snapped } */
export function snapValue(ms, points, thresholdMs) {
  let best = null
  let bestD = thresholdMs + 1
  for (const p of points) {
    const d = Math.abs(p - ms)
    if (d <= thresholdMs && d < bestD) {
      best = p
      bestD = d
    }
  }
  return best == null ? { ms, snapped: false } : { ms: best, snapped: true }
}

/** 拖动整块：起点或终点任一边吸附（取更近者），返回新的起点 */
export function snapMove(startMs, durationMs, points, thresholdMs) {
  const a = snapValue(startMs, points, thresholdMs)
  const b = snapValue(startMs + durationMs, points, thresholdMs)
  const da = a.snapped ? Math.abs(a.ms - startMs) : Infinity
  const db = b.snapped ? Math.abs(b.ms - (startMs + durationMs)) : Infinity
  if (da === Infinity && db === Infinity) return startMs
  return da <= db ? a.ms : b.ms - durationMs
}

export function overlapsInTrack(clips, startMs, durationMs, excludeId) {
  const end = startMs + durationMs
  return clips.some((c) => c.id !== excludeId && startMs < clipEnd(c) && c.start_ms < end)
}

/** 邻居范围：以片段当前位置为准，找到不跨越的左/右边界 */
export function neighbourBounds(clips, clip) {
  let left = 0
  let right = Infinity
  for (const c of clips) {
    if (c.id === clip.id) continue
    if (clipEnd(c) <= clip.start_ms) left = Math.max(left, clipEnd(c))
    else if (c.start_ms >= clipEnd(clip)) right = Math.min(right, c.start_ms)
  }
  return { left, right }
}

/** 移动后的合法起点：非叠加轨道被邻居夹住，不会越过邻居 */
export function resolveMove(track, clip, wantStartMs) {
  const start = Math.max(0, Math.round(wantStartMs))
  if (OVERLAP_ALLOWED.has(track.kind)) return start
  const { left, right } = neighbourBounds(track.clips, clip)
  const max = right === Infinity ? Infinity : right - clip.duration_ms
  return clamp(start, left, Math.max(left, max))
}

/**
 * 拖动边缘缩放。edge: 'start' | 'end'；toMs 为边缘新位置。
 * 返回 { start_ms, duration_ms, src_in_ms?, src_out_ms? } 补丁。
 */
export function resolveResize(track, clip, edge, toMs, minMs = MIN_CLIP_MS) {
  const { left, right } = OVERLAP_ALLOWED.has(track.kind) ? { left: 0, right: Infinity } : neighbourBounds(track.clips, clip)
  const end = clipEnd(clip)
  let start = clip.start_ms
  let dur = clip.duration_ms
  if (edge === 'start') {
    let s = clamp(Math.round(toMs), left, end - minMs)
    if (clip.src_in_ms != null) s = Math.max(s, clip.start_ms - clip.src_in_ms)
    start = s
    dur = end - s
  } else {
    const e = clamp(Math.round(toMs), clip.start_ms + minMs, right)
    dur = e - clip.start_ms
  }
  const patch = { start_ms: start, duration_ms: dur }
  if (clip.src_in_ms != null) {
    patch.src_in_ms = clip.src_in_ms + (start - clip.start_ms)
    patch.src_out_ms = patch.src_in_ms + dur
  }
  return patch
}

/** 在 atMs 处切分，返回 [前, 后]（后者 id 由调用方提供），无法切分返回 null */
export function splitClipAt(clip, atMs, newId, minMs = MIN_CLIP_MS) {
  if (!Number.isFinite(atMs)) return null
  const at = Math.round(atMs)
  if (at - clip.start_ms < minMs || clipEnd(clip) - at < minMs) return null
  const firstDur = at - clip.start_ms
  const first = { ...clip, duration_ms: firstDur }
  const second = { ...clip, id: newId, start_ms: at, duration_ms: clip.duration_ms - firstDur }
  if (clip.src_in_ms != null) {
    first.src_out_ms = clip.src_in_ms + firstDur
    second.src_in_ms = clip.src_in_ms + firstDur
    second.src_out_ms = clip.src_out_ms
  }
  return [first, second]
}

/** 播放头所在片段内的素材时间（ms）；不在片段内返回 null */
export function sourceTimeAt(clip, playheadMs) {
  if (!clip || playheadMs < clip.start_ms || playheadMs >= clipEnd(clip)) return null
  return (clip.src_in_ms ?? 0) + (playheadMs - clip.start_ms)
}

/** 素材引用转 URL：绝对地址 / 以 /static/ 开头原样，其余视为本地存储相对路径 */
export function resolveAssetUrl(ref) {
  if (!ref) return ''
  const p = String(ref).trim()
  if (/^(https?:|blob:|data:)/.test(p) || p.startsWith('/static/')) return p
  return '/static/' + p.replace(/^\//, '')
}
