import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { timelinesAPI } from '@/api/timelines'
import { findClip, timelineDuration, splitClipAt, clipAt } from '@/utils/timelineMath'

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

  let saveTimer = null
  let saving = false

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
    try {
      setTimeline(await timelinesAPI.getByEpisode(epId))
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
        else saveState.value = saveTimer ? 'dirty' : 'idle'
      }
    } catch (e) {
      saveState.value = 'error'
      // 冲突/校验失败：以服务端为准重新加载
      try {
        setTimeline(await timelinesAPI.getByEpisode(tl.episode_id))
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
    const hit = findClip(tracks.value, clipId)
    if (!hit) return
    Object.assign(hit.clip, patch)
    hit.track.clips.sort((a, b) => a.start_ms - b.start_ms)
    scheduleSave()
  }

  function deleteClip(clipId) {
    const hit = findClip(tracks.value, clipId)
    if (!hit) return
    hit.track.clips = hit.track.clips.filter((c) => c.id !== clipId)
    if (selectedClipId.value === clipId) selectedClipId.value = null
    scheduleSave()
  }

  /** 在 atMs 切分：有选中片段且包含播放头则切选中，否则切各轨道上穿过播放头的片段中第一个 */
  function splitAt(atMs) {
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
    scheduleSave()
    return true
  }

  return {
    timeline, episodeId, loading, missing, selectedClipId, saveState,
    tracks, durationMs, selected,
    load, assemble, flushPending, save, select, patchClip, deleteClip, splitAt,
  }
})
