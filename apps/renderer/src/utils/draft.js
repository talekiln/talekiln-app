/** 本地草稿（write-ahead）与崩溃恢复：纯逻辑，存储/定时器均可注入以便测试。 */

export const DRAFT_PREFIX = 'talekiln.timelineDraft.v1:'
export const DRAFT_DELAY_MS = 300

export function draftKey(episodeId) {
  return `${DRAFT_PREFIX}${episodeId}`
}

export function makeDraft(timeline, now = Date.now()) {
  return {
    timelineId: timeline.id,
    episodeId: timeline.episode_id,
    baseVersion: timeline.version,
    tracks: timeline.tracks,
    savedAt: now,
  }
}

export function sameTracks(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

export function parseDraft(raw) {
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!d || typeof d !== 'object' || !Array.isArray(d.tracks) || d.timelineId == null) return null
    return d
  } catch (_) {
    return null
  }
}

/**
 * 判断打开编辑器时是否需要提示恢复。
 * 草稿仅在“有编辑尚未保存成功”时存在（保存成功即清除），因此：
 * - 无草稿 / 属于别的时间线 / 内容与服务端一致 -> none，discard（应丢弃草稿）
 * - baseVersion >= 服务端版本 -> prompt
 * - baseVersion < 服务端版本 -> prompt 且 conflict（服务端在草稿之后又被保存过，恢复会覆盖那些改动）
 */
export function assessRecovery(draft, server) {
  if (!draft || !server) return { action: 'none', discard: false, conflict: false }
  if (draft.timelineId !== server.id) return { action: 'none', discard: true, conflict: false }
  if (sameTracks(draft.tracks, server.tracks)) return { action: 'none', discard: true, conflict: false }
  return { action: 'prompt', discard: false, conflict: (draft.baseVersion ?? 0) < (server.version ?? 0) }
}

/** 把草稿合并到服务端时间线：保留服务端 id/version（乐观锁以最新版本为准），轨道取草稿。 */
export function mergeDraft(server, draft) {
  return { ...server, tracks: JSON.parse(JSON.stringify(draft.tracks)) }
}

/**
 * 批量写入器：schedule 在 delayMs 内合并同一 key 的多次写入，只写最后一份。
 * flush 立即落盘（页面卸载时调用）。存储异常（配额/隐私模式）被吞掉。
 */
export function createDraftWriter({ storage, delayMs = DRAFT_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map() // key -> () => draft
  let timer = null

  function writeAll() {
    timer = null
    let ok = true
    for (const [key, get] of pending) {
      try {
        const d = get()
        if (d) storage.setItem(key, JSON.stringify(d))
      } catch (_) {
        ok = false
      }
    }
    pending.clear()
    return ok
  }

  return {
    /** getDraft 在落盘时才求值，保证写入的是最新状态 */
    schedule(key, getDraft) {
      pending.set(key, getDraft)
      if (!timer) timer = setTimer(writeAll, delayMs)
    },
    flush() {
      if (timer) {
        clearTimer(timer)
        timer = null
      }
      return writeAll()
    },
    clear(key) {
      pending.delete(key)
      if (!pending.size && timer) {
        clearTimer(timer)
        timer = null
      }
      try { storage.removeItem(key) } catch (_) { /* ignore */ }
    },
    read(key) {
      try { return parseDraft(storage.getItem(key)) } catch (_) { return null }
    },
    get hasPending() { return pending.size > 0 },
  }
}
