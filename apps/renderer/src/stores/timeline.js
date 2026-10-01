import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { timelinesAPI } from '@/api/timelines'
import { findClip, timelineDuration, splitClipAt, clipAt } from '@/utils/timelineMath'
import { createHistory } from '@/utils/editHistory'
import { createDraftWriter, draftKey, makeDraft, assessRecovery, mergeDraft } from '@/utils/draft'

/** 编辑合并为一次保存的等待时间（毫秒） */
export const AUTOSAVE_DELAY_MS = 300

function newClipId() {
  return globalThis.crypto?.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const useTimelineStore = defineStore('timeline', () => {
  const timeline = ref(null)
  const episodeId = ref(null)
  const loading = ref(false)
  const missing = ref(false)
  const selectedClipId = ref(null)
  /** idle | dirty | saving | error */
  const saveState = ref('idle')

  /** 待用户决定的本地草稿恢复：{ draft, conflict } | null */
  const recovery = ref(null)
  const historyTick = ref(0)

  let saveTimer = null
  let saving = false
  const history = createHistory({ limit: 100, coalesceMs: 400 })
  let draftWriter = null

  function getDraftWriter() {
    if (!draftWriter) {
      let storage = null
      try { storage = globalThis.localStorage } catch (_) { /* 隐私模式 */ }
      draftWriter = createDraftWriter({ storage: storage || { getItem() { return null }, setItem() {}, removeItem() {} } })
    }
    return draftWriter
  }

  function scheduleDraft() {
    const tl = timeline.value
    if (!tl) return
    getDraftWriter().schedule(draftKey(tl.episode_id), () => (timeline.value === tl ? makeDraft(tl) : null))
  }

  function clearDraft(epId) {
    if (epId != null) getDraftWriter().clear(draftKey(epId))
  }

  /** 页面卸载/隐藏时同步落盘 */
  function flushDraft() {
    return getDraftWriter().flush()
  }

  function checkRecovery(server) {
    recovery.value = null
    if (!server) return
    const w = getDraftWriter()
    const key = draftKey(server.episode_id)
    const draft = w.read(key)
    const r = assessRecovery(draft, server)
    if (r.discard) w.clear(key)
    if (r.action === 'prompt') recovery.value = { draft, conflict: r.conflict }
  }

  function applyRecovery() {
    const r = recovery.value
    if (!r || !timeline.value) return
    recordBefore('恢复本地草稿')
    timeline.value = mergeDraft(timeline.value, r.draft)
    recovery.value = null
    scheduleSave()
  }

  function discardRecovery() {
    if (recovery.value) clearDraft(timeline.value?.episode_id ?? recovery.value.draft.episodeId)
    recovery.value = null
  }

  // ---------- 撤销 / 重做 ----------

  function snapshot() {
    return JSON.stringify(timeline.value?.tracks ?? [])
  }

  function recordBefore(label, coalesceKey = null) {
    history.record(snapshot(), label, coalesceKey)
    historyTick.value++
  }

  /** 编辑封装：fn 返回 false 表示未发生修改（不入栈） */
  function mutate(label, fn, coalesceKey = null) {
    if (!timeline.value) return false
    const before = snapshot()
    const result = fn()
    if (result === false || snapshot() === before) return result
    history.record(before, label, coalesceKey)
    historyTick.value++
    scheduleSave()
    return result
  }

  function restore(snap) {
    if (snap == null || !timeline.value) return false
    timeline.value.tracks = JSON.parse(snap)
    if (selectedClipId.value && !findClip(timeline.value.tracks, selectedClipId.value)) selectedClipId.value = null
    historyTick.value++
    scheduleSave()
    return true
  }

  function undo() {
    if (!timeline.value) return false
    return restore(history.undo(snapshot()))
  }

  function redo() {
    if (!timeline.value) return false
    return restore(history.redo(snapshot()))
  }

  const canUndo = computed(() => (historyTick.value, history.canUndo))
  const canRedo = computed(() => (historyTick.value, history.canRedo))

  const tracks = computed(() => timeline.value?.tracks ?? [])
  const durationMs = computed(() => timelineDuration(tracks.value))
  const selected = computed(() => (selectedClipId.value ? findClip(tracks.value, selectedClipId.value) : null))

  function setTimeline(tl) {
    timeline.value = tl
    if (selectedClipId.value && !findClip(tl?.tracks ?? [], selectedClipId.value)) selectedClipId.value = null
  }

  async function load(epId) {
    flushPending()
    episodeId.value = epId
    loading.value = true
    missing.value = false
    selectedClipId.value = null
    history.clear()
    historyTick.value++
    recovery.value = null
    try {
      setTimeline(await timelinesAPI.getByEpisode(epId))
      checkRecovery(timeline.value)
    } catch (e) {
      timeline.value = null
      missing.value = e?.response?.status === 404
      if (!missing.value) throw e
    } finally {
      loading.value = false
    }
  }

  async function assemble(epId, replace = false) {
    loading.value = true
    try {
      setTimeline(await timelinesAPI.assemble(epId, replace ? { replace: true } : {}))
      clearDraft(epId)
      recovery.value = null
      history.clear()
      historyTick.value++
      episodeId.value = epId
      missing.value = false
      saveState.value = 'idle'
    } finally {
      loading.value = false
    }
  }

  function flushPending() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      return save()
    }
    return Promise.resolve()
  }

  function scheduleSave() {
    if (!timeline.value) return
    saveState.value = 'dirty'
    scheduleDraft()
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, AUTOSAVE_DELAY_MS)
  }

  async function save() {
    if (saving) {
      // 保存进行中又有新编辑：结束后再存一次
      scheduleSave()
      return
    }
    const tl = timeline.value
    if (!tl) return
    saving = true
    saveState.value = 'saving'
    const snapshot = JSON.stringify(tl.tracks)
    try {
      const saved = await timelinesAPI.save(tl.id, { episode_id: tl.episode_id, version: tl.version, tracks: tl.tracks })
      if (timeline.value === tl) {
        // 仅同步版本号，避免覆盖保存期间产生的新编辑
        tl.version = saved.version
        tl.duration_ms = saved.duration_ms
        if (JSON.stringify(tl.tracks) !== snapshot) scheduleSave()
        else {
          saveState.value = saveTimer ? 'dirty' : 'idle'
          // 已完整落库：本地草稿不再需要
          if (!saveTimer) clearDraft(tl.episode_id)
        }
      }
    } catch (e) {
      saveState.value = 'error'
      // 冲突/校验失败：以服务端为准重新加载
      try {
        flushDraft()
        setTimeline(await timelinesAPI.getByEpisode(tl.episode_id))
        history.clear()
        historyTick.value++
        // 被服务端状态覆盖的本地编辑仍在草稿里，让用户决定是否恢复
        checkRecovery(timeline.value)
      } catch (_) { /* ignore */ }
    } finally {
      saving = false
    }
  }

  function select(clipId) {
    selectedClipId.value = clipId
  }

  /** 修改片段字段（补丁），由 timelineMath 计算出的合法值 */
  function patchClip(clipId, patch) {
    mutate('修改片段', () => {
      const hit = findClip(tracks.value, clipId)
      if (!hit) return false
      Object.assign(hit.clip, patch)
      hit.track.clips.sort((a, b) => a.start_ms - b.start_ms)
    })
  }

  function deleteClip(clipId) {
    mutate('删除片段', () => {
      const hit = findClip(tracks.value, clipId)
      if (!hit) return false
      hit.track.clips = hit.track.clips.filter((c) => c.id !== clipId)
      if (selectedClipId.value === clipId) selectedClipId.value = null
    })
  }

  /** 切换轨道静音（trackId 缺省时取选中片段所在轨道） */
  function toggleMute(trackId) {
    const id = trackId ?? selected.value?.track?.id
    return mutate('轨道静音', () => {
      const track = tracks.value.find((t) => t.id === id)
      if (!track) return false
      track.muted = !track.muted
    })
  }

  /** 在 atMs 切分：有选中片段且包含播放头则切选中，否则切各轨道上穿过播放头的片段中第一个 */
  function splitAt(atMs) {
    return mutate('切分片段', () => doSplit(atMs)) === true
  }

  function doSplit(atMs) {
    let target = null
    const sel = selected.value
    if (sel && atMs > sel.clip.start_ms && atMs < sel.clip.start_ms + sel.clip.duration_ms) target = sel
    if (!target) {
      for (const track of tracks.value) {
        const clip = clipAt(track, atMs)
        if (clip) {
          target = { track, clip }
          break
        }
      }
    }
    if (!target) return false
    const parts = splitClipAt(target.clip, atMs, newClipId())
    if (!parts) return false
    const idx = target.track.clips.findIndex((c) => c.id === target.clip.id)
    target.track.clips.splice(idx, 1, ...parts)
    selectedClipId.value = parts[1].id
    return true
  }

  return {
    timeline, episodeId, loading, missing, selectedClipId, saveState,
    tracks, durationMs, selected, recovery, canUndo, canRedo,
    load, assemble, flushPending, flushDraft, save, select, patchClip, deleteClip, splitAt, toggleMute,
    undo, redo, applyRecovery, discardRecovery,
  }
})
