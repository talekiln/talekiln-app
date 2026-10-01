<template>
  <div class="timeline-editor">
    <ViewSwitcher />
    <header class="te-header">
      <el-button size="small" @click="goBack">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1 class="te-title">时间线编辑</h1>
      <span class="te-save" :class="'is-' + store.saveState">{{ saveText }}</span>
      <div class="te-spacer" />
      <template v-if="store.timeline">
        <el-button size="small" :disabled="!store.canUndo" @click="store.undo()">撤销</el-button>
        <el-button size="small" :disabled="!store.canRedo" @click="store.redo()">重做</el-button>
        <el-button size="small" :disabled="!selectedClip" @click="onSplit">切分 (S)</el-button>
        <el-button size="small" :disabled="!selectedClip" @click="onDelete">删除 (Del)</el-button>
        <el-button size="small" :loading="store.loading" @click="onReassemble">重新组装</el-button>
        <el-button size="small" data-test="open-voiceover" @click="voiceoverOpen = true">旁白配音</el-button>
        <el-button size="small" data-test="open-music" @click="musicOpen = true">音乐与混音</el-button>
        <el-button size="small" type="primary" data-test="open-export" @click="goExport">导出</el-button>
        <el-button size="small" @click="router.push('/settings/shortcuts')">快捷键</el-button>
        <el-button-group>
          <el-button size="small" @click="zoom(1 / 1.25)">-</el-button>
          <el-button size="small" disabled>{{ Math.round(pxPerSec) }} px/s</el-button>
          <el-button size="small" @click="zoom(1.25)">+</el-button>
        </el-button-group>
      </template>
    </header>

    <el-drawer v-model="musicOpen" title="音乐与混音" size="400px" append-to-body>
      <MusicPanel v-if="store.timeline" />
    </el-drawer>

    <el-drawer v-model="voiceoverOpen" title="旁白配音" size="400px" append-to-body>
      <VoiceoverPanel v-if="store.timeline" :episode-id="episodeId" @done="onVoiceoverDone" />
    </el-drawer>

    <div v-if="store.loading && !store.timeline" class="te-empty">加载中…</div>
    <div v-else-if="!store.timeline" class="te-empty">
      <p>该剧集尚未组装时间线</p>
      <el-button type="primary" :loading="store.loading" @click="onAssemble">从分镜组装时间线</el-button>
    </div>

    <template v-else>
      <section class="te-preview">
        <div class="te-screen">
          <video
            v-show="previewKind === 'video'"
            ref="videoEl"
            class="te-media"
            playsinline
            preload="auto"
          />
          <img v-if="previewKind === 'image'" class="te-media" :src="previewUrl" alt="" />
          <div v-if="previewKind === 'none'" class="te-screen-empty">无画面</div>
          <div v-if="subtitleText" class="te-subtitle">{{ subtitleText }}</div>
        </div>
        <div class="te-transport">
          <el-button circle size="small" @click="togglePlay">
            <el-icon><VideoPause v-if="playing" /><VideoPlay v-else /></el-icon>
          </el-button>
          <span class="te-time">{{ formatTime(playhead) }} / {{ formatTime(store.durationMs) }}</span>
          <span class="te-hint">空格 播放/暂停 · S 切分 · Del 删除 · Ctrl+Z 撤销 · ←/→ 逐帧 · M 静音</span>
        </div>
      </section>

      <section class="te-timeline">
        <div ref="scrollEl" class="te-scroll" @wheel="onWheel">
          <div class="te-canvas" :style="{ width: LABEL_W + contentWidth + 'px' }">
            <div class="te-row te-ruler-row">
              <div class="te-label" />
              <div class="te-ruler" :style="{ width: contentWidth + 'px' }" @pointerdown="onRulerDown">
                <div v-for="t in ticks" :key="t.ms" class="te-tick" :style="{ left: t.x + 'px' }">
                  <span>{{ t.label }}</span>
                </div>
              </div>
            </div>

            <div v-for="track in store.tracks" :key="track.id" class="te-row">
              <div class="te-label">{{ TRACK_NAMES[track.kind] || track.kind }}</div>
              <div class="te-track" :class="'kind-' + track.kind" :style="{ width: contentWidth + 'px' }" @pointerdown.self="onTrackDown($event)">
                <div
                  v-for="clip in track.clips"
                  :key="clip.id"
                  class="te-clip"
                  :class="{ selected: clip.id === store.selectedClipId, dragging: drag && drag.id === clip.id }"
                  :style="clipStyle(clip)"
                  :title="clipTitle(clip)"
                  @pointerdown.stop="onClipDown($event, track, clip, 'move')"
                >
                  <span class="te-handle left" @pointerdown.stop="onClipDown($event, track, clip, 'start')" />
                  <span class="te-clip-text">{{ clipLabel(clip) }}</span>
                  <span class="te-handle right" @pointerdown.stop="onClipDown($event, track, clip, 'end')" />
                </div>
              </div>
            </div>

            <div class="te-playhead" :style="{ left: LABEL_W + msToPx(playhead, pxPerSec) + 'px' }">
              <span class="te-playhead-cap" />
            </div>
            <div v-if="snapLine != null" class="te-snapline" :style="{ left: LABEL_W + msToPx(snapLine, pxPerSec) + 'px' }" />
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, VideoPlay, VideoPause } from '@element-plus/icons-vue'
import { useTimelineStore } from '@/stores/timeline'
import MusicPanel from '@/components/MusicPanel.vue'
import ViewSwitcher from '@/components/ViewSwitcher.vue'
import { useProjectViewsStore } from '@/stores/projectViews'
import { fromKernelClipId, toKernelClipId } from '@/utils/projectViews'
import VoiceoverPanel from '@/components/VoiceoverPanel.vue'
import { useKeymap } from '@/composables/useKeymap'
import { SCOPE_TIMELINE, SCOPE_WORKBENCH } from '@/utils/keymap'
import {
  DEFAULT_ZOOM, msToPx, pxToMs, zoomBy, formatTime, rulerTicks, clipAt, clipEnd, findClip,
  snapPoints, snapValue, snapMove, resolveMove, resolveResize, sourceTimeAt, resolveAssetUrl
} from '@/utils/timelineMath'

const LABEL_W = 72
const SNAP_PX = 8
const TRACK_NAMES = { video: '视频', subtitle: '字幕', narration: '旁白', music: '音乐' }

const route = useRoute()
const router = useRouter()
const store = useTimelineStore()
// 四视图共享状态（选择 / 播放头 / 历史）。时间线编辑器自己的编辑走旧接口（已改道经内核），保存后刷新共享 store
const views = useProjectViewsStore()

const episodeId = computed(() => Number(route.params.id))
const pxPerSec = ref(DEFAULT_ZOOM)
const playhead = ref(0)
const playing = ref(false)
const drag = ref(null)
const snapLine = ref(null)
const musicOpen = ref(false)
const voiceoverOpen = ref(false)
const videoEl = ref(null)
const scrollEl = ref(null)

const selectedClip = computed(() => store.selected?.clip ?? null)
const contentWidth = computed(() => Math.max(msToPx(store.durationMs + 10000, pxPerSec.value), 600))
const ticks = computed(() => rulerTicks(store.durationMs + 10000, pxPerSec.value))
const saveText = computed(() => ({ idle: '', dirty: '未保存…', saving: '保存中…', error: '保存失败，已重新加载' }[store.saveState] || ''))

const videoTrack = computed(() => store.tracks.find((t) => t.kind === 'video'))
const subtitleTrack = computed(() => store.tracks.find((t) => t.kind === 'subtitle'))
const videoClip = computed(() => (videoTrack.value ? clipAt(videoTrack.value, playhead.value) : null))
const subtitleText = computed(() => (subtitleTrack.value ? clipAt(subtitleTrack.value, playhead.value)?.text || '' : ''))
const previewUrl = computed(() => resolveAssetUrl(videoClip.value?.asset_ref))
const previewKind = computed(() => {
  const c = videoClip.value
  if (!c || !c.asset_ref) return 'none'
  return c.asset_kind === 'image' ? 'image' : 'video'
})

function goBack() {
  const dramaId = route.query.drama
  router.push(dramaId ? { path: `/film/${dramaId}`, query: { episode: String(episodeId.value) } } : '/')
}

async function goExport() {
  await store.flushPending()
  router.push({ path: `/episodes/${episodeId.value}/export`, query: route.query })
}

function zoom(factor) {
  const el = scrollEl.value
  const anchorMs = playhead.value
  pxPerSec.value = zoomBy(pxPerSec.value, factor)
  // 缩放后让播放头保持在视野中
  if (el) el.scrollLeft = Math.max(0, msToPx(anchorMs, pxPerSec.value) - el.clientWidth / 2)
}

// ---------- 加载 / 组装 ----------

async function loadAll() {
  playing.value = false
  playhead.value = 0
  try {
    await store.load(episodeId.value)
  } catch (e) {
    ElMessage.error(e.message || '加载时间线失败')
  }
  await maybeRecover()
  await views.load(episodeId.value, { drama: route.query.drama })
  applySharedFocus()
}

// 别的视图里选中的对象 -> 选中对应片段、播放头跟随
function applySharedFocus() {
  const f = views.focusFor('timeline')
  if (f) {
    const id = fromKernelClipId(f.id, episodeId.value, (cid) => !!store.tracks.some((t) => t.clips.some((c) => c.id === cid)))
    if (id) store.select(id)
  }
  if (store.timeline) playhead.value = Math.min(views.playhead, store.durationMs)
}
watch(() => store.selectedClipId, (id) => {
  if (id) views.select({ kind: 'segment', id: toKernelClipId(id, episodeId.value) }, { playhead: false })
})
watch(playhead, (ms) => { if (!playing.value) views.setPlayhead(ms) })
watch(() => store.saveState, (st, old) => { if (st === 'idle' && old && old !== 'idle') views.refresh() })
// 在别的地方（顶栏）撤销 / 重做后，重新读取时间线
watch(() => views.revision, () => { store.load(episodeId.value).then(applySharedFocus).catch(() => {}) })

// 配音写进了项目图（旁白音频 + 词级字幕）；重新读取时间线即可看到新的旁白轨和字幕轨
async function onVoiceoverDone() {
  try { await store.load(episodeId.value) } catch (e) { ElMessage.error(e.message || '重新加载时间线失败') }
}

async function onAssemble() {
  try {
    await store.assemble(episodeId.value)
  } catch (_) { /* 错误提示由 request 拦截器给出 */ }
}

async function onReassemble() {
  try {
    await ElMessageBox.confirm('重新组装会丢弃当前所有时间线编辑，是否继续？', '重新组装', { type: 'warning' })
  } catch (_) {
    return
  }
  try {
    await store.assemble(episodeId.value, true)
    playhead.value = 0
  } catch (_) { /* 同上 */ }
}

// ---------- 片段渲染 ----------

function displayClip(clip) {
  return drag.value && drag.value.id === clip.id ? { ...clip, ...drag.value.patch } : clip
}

function clipStyle(clip) {
  const c = displayClip(clip)
  return { left: msToPx(c.start_ms, pxPerSec.value) + 'px', width: Math.max(msToPx(c.duration_ms, pxPerSec.value), 4) + 'px' }
}

function clipLabel(clip) {
  if (clip.text) return clip.text
  const ref = clip.asset_ref ? String(clip.asset_ref).split('/').pop() : ''
  return ref || (clip.storyboard_id ? `分镜 ${clip.storyboard_id}` : '片段')
}

function clipTitle(clip) {
  const c = displayClip(clip)
  return `${clipLabel(clip)}\n${formatTime(c.start_ms)} - ${formatTime(clipEnd(c))}`
}

// ---------- 拖动 / 缩放 ----------

function onClipDown(e, track, clip, mode) {
  if (e.button !== 0) return
  store.select(clip.id)
  drag.value = { id: clip.id, mode, trackId: track.id, startX: e.clientX, orig: { ...clip }, patch: {} }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}

function onDragMove(e) {
  const d = drag.value
  if (!d) return
  const hit = findClip(store.tracks, d.id)
  if (!hit) return
  const deltaMs = pxToMs(e.clientX - d.startX, pxPerSec.value)
  const thr = pxToMs(SNAP_PX, pxPerSec.value)
  const points = snapPoints(store.tracks, d.id, playhead.value)
  const o = d.orig
  let line = null
  if (d.mode === 'move') {
    const want = snapMove(o.start_ms + deltaMs, o.duration_ms, points, thr)
    const start = resolveMove(hit.track, o, want)
    d.patch = { start_ms: start }
    if (snapValue(start, points, 1).snapped) line = start
    else if (snapValue(start + o.duration_ms, points, 1).snapped) line = start + o.duration_ms
  } else {
    const raw = d.mode === 'start' ? o.start_ms + deltaMs : clipEnd(o) + deltaMs
    const s = snapValue(raw, points, thr)
    if (s.snapped) line = s.ms
    d.patch = resolveResize(hit.track, o, d.mode, s.ms)
    if (line != null && line !== (d.mode === 'start' ? d.patch.start_ms : clipEnd({ ...o, ...d.patch }))) line = null
  }
  snapLine.value = line
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  const d = drag.value
  drag.value = null
  snapLine.value = null
  if (!d || !Object.keys(d.patch).length) return
  const changed = Object.keys(d.patch).some((k) => d.patch[k] !== d.orig[k])
  if (changed) store.patchClip(d.id, d.patch)
}

// ---------- 播放头 / 标尺 ----------

function msFromPointer(e, originEl) {
  const rect = originEl.getBoundingClientRect()
  return Math.max(0, pxToMs(e.clientX - rect.left, pxPerSec.value))
}

function onRulerDown(e) {
  const el = e.currentTarget
  playing.value = false
  playhead.value = msFromPointer(e, el)
  const move = (ev) => { playhead.value = msFromPointer(ev, el) }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onTrackDown(e) {
  store.select(null)
  playhead.value = msFromPointer(e, e.currentTarget)
}

// ---------- 编辑操作 ----------

function onSplit() {
  if (!store.splitAt(playhead.value)) ElMessage.warning('播放头不在可切分的片段内')
}

function onDelete() {
  if (store.selectedClipId) store.deleteClip(store.selectedClipId)
}

const FRAME_MS = 1000 / 30
const { createKeyHandler } = useKeymap()

function seek(ms) {
  playing.value = false
  playhead.value = Math.max(0, Math.min(store.durationMs, Math.round(ms)))
}

function onToggleMute() {
  if (!store.toggleMute()) ElMessage.warning('请先选中一个片段以指定轨道')
}

const stub = (name) => () => { ElMessage.info(`${name}：请在分镜工作台页面使用`) }

const onKeydown = createKeyHandler({
  'play.toggle': () => togglePlay(),
  'clip.split': () => onSplit(),
  'clip.delete': () => onDelete(),
  'edit.undo': () => store.undo(),
  'edit.redo': () => store.redo(),
  'playhead.prevFrame': () => seek(playhead.value - FRAME_MS),
  'playhead.nextFrame': () => seek(playhead.value + FRAME_MS),
  'playhead.prevSecond': () => seek(playhead.value - 1000),
  'playhead.nextSecond': () => seek(playhead.value + 1000),
  'playhead.home': () => seek(0),
  'playhead.end': () => seek(store.durationMs),
  'zoom.in': () => zoom(1.25),
  'zoom.out': () => zoom(1 / 1.25),
  'track.mute': () => onToggleMute(),
  // 工作台 AI 快捷键：仅注册动作，处理逻辑为占位
  'shot.regenerate': stub('重新生成'),
  'shot.pick1': stub('选用候选 V1'),
  'shot.pick2': stub('选用候选 V2'),
  'shot.pick3': stub('选用候选 V3'),
  'shot.pick4': stub('选用候选 V4'),
  'shot.compareToggle': stub('A/B 对比'),
}, [SCOPE_TIMELINE, SCOPE_WORKBENCH])

function onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
}

function onPageHide() {
  store.flushDraft()
}

async function maybeRecover() {
  const r = store.recovery
  if (!r) return
  const when = new Date(r.draft.savedAt).toLocaleString()
  const msg = r.conflict
    ? `发现 ${when} 的本地未保存草稿，但服务端之后已有更新，恢复将覆盖服务端的较新改动。是否恢复？`
    : `发现 ${when} 的本地未保存草稿（可能因意外关闭而丢失）。是否恢复？`
  try {
    await ElMessageBox.confirm(msg, '恢复未保存的编辑', { confirmButtonText: '恢复草稿', cancelButtonText: '丢弃草稿', type: 'warning', distinguishCancelAndClose: true, closeOnClickModal: false })
    store.applyRecovery()
  } catch (action) {
    if (action === 'cancel') store.discardRecovery()
  }
}

// ---------- 预览播放 ----------

let rafId = 0
let lastTs = 0

function tick(ts) {
  if (!playing.value) return
  const dt = lastTs ? ts - lastTs : 0
  lastTs = ts
  const next = playhead.value + dt
  if (next >= store.durationMs) {
    playhead.value = store.durationMs
    playing.value = false
    return
  }
  playhead.value = next
  rafId = requestAnimationFrame(tick)
}

function togglePlay() {
  if (!store.timeline) return
  if (playing.value) {
    playing.value = false
    return
  }
  if (playhead.value >= store.durationMs) playhead.value = 0
  playing.value = true
}

watch(playing, (on) => {
  cancelAnimationFrame(rafId)
  lastTs = 0
  if (on) rafId = requestAnimationFrame(tick)
  syncVideo(true)
})

/** 让 <video> 跟随播放头：切换片段/拖动时 seek，播放中仅在偏差过大时纠正 */
function syncVideo(force = false) {
  const v = videoEl.value
  if (!v) return
  const clip = videoClip.value
  if (!clip || previewKind.value !== 'video') {
    v.pause()
    return
  }
  const url = previewUrl.value
  if (v.getAttribute('src') !== url) {
    v.setAttribute('src', url)
    force = true
  }
  const want = (sourceTimeAt(clip, playhead.value) ?? 0) / 1000
  if (force || !playing.value || Math.abs(v.currentTime - want) > 0.3) {
    try { v.currentTime = want } catch (_) { /* metadata 尚未加载 */ }
  }
  if (playing.value && v.paused) v.play().catch(() => {})
  else if (!playing.value && !v.paused) v.pause()
}

watch([playhead, () => videoClip.value?.id, () => videoClip.value?.src_in_ms, previewKind], () => syncVideo())

// ---------- 生命周期 ----------

watch(episodeId, loadAll)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onPageHide)
  loadAll()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('beforeunload', onPageHide)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  cancelAnimationFrame(rafId)
  store.flushPending()
  store.flushDraft()
})
</script>

<style scoped>
.timeline-editor {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
}
.te-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
}
.te-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-bright); }
.te-save { font-size: 12px; color: var(--text-subtle); }
.te-save.is-error { color: #f56c6c; }
.te-spacer { flex: 1; }
.te-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
}
.te-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--bg-inner);
  border-bottom: 1px solid var(--border-color);
}
.te-screen {
  position: relative;
  width: min(480px, 90vw);
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}
.te-media { width: 100%; height: 100%; object-fit: contain; background: #000; }
.te-screen-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #71717a; font-size: 13px;
}
.te-subtitle {
  position: absolute; left: 8%; right: 8%; bottom: 8%;
  text-align: center; color: #fff; font-size: 14px; text-shadow: 0 1px 3px #000;
}
.te-transport { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.te-time { font-variant-numeric: tabular-nums; color: var(--text-bright); }
.te-hint { color: var(--text-subtle); font-size: 12px; }

.te-timeline { flex: 1; min-height: 0; display: flex; }
.te-scroll { flex: 1; overflow: auto; }
.te-canvas { position: relative; min-height: 100%; }
.te-row { display: flex; height: 44px; border-bottom: 1px solid var(--border-color); }
.te-ruler-row { height: 28px; position: sticky; top: 0; z-index: 3; background: var(--bg-card); }
.te-label {
  position: sticky; left: 0; z-index: 2;
  flex: 0 0 72px; width: 72px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--text-muted);
  background: var(--bg-card); border-right: 1px solid var(--border-color);
}
.te-ruler { position: relative; cursor: col-resize; }
.te-tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--border-muted); }
.te-tick span { position: absolute; left: 4px; top: 6px; font-size: 10px; color: var(--text-subtle); white-space: nowrap; }
.te-track { position: relative; background: var(--bg-inner); }
.te-clip {
  position: absolute; top: 4px; bottom: 4px;
  display: flex; align-items: center;
  border-radius: 4px; overflow: hidden;
  background: #7c3aed; color: #fff; font-size: 11px;
  border: 1px solid rgba(255, 255, 255, .25);
  cursor: grab; user-select: none; touch-action: none;
}
.kind-video .te-clip { background: #6d28d9; }
.kind-subtitle .te-clip { background: #0e7490; }
.kind-narration .te-clip { background: #15803d; }
.kind-music .te-clip { background: #b45309; }
.te-clip.selected { outline: 2px solid #fbbf24; outline-offset: -1px; z-index: 1; }
.te-clip.dragging { cursor: grabbing; opacity: .85; }
.te-clip-text { flex: 1; padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.te-handle { position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize; background: rgba(255, 255, 255, .18); }
.te-handle.left { left: 0; }
.te-handle.right { right: 0; }
.te-playhead {
  position: absolute; top: 0; bottom: 0; width: 0; z-index: 4; pointer-events: none;
  border-left: 1px solid #ef4444;
}
.te-playhead-cap { position: absolute; top: 0; left: -5px; width: 9px; height: 9px; background: #ef4444; border-radius: 0 0 4px 4px; }
.te-snapline { position: absolute; top: 0; bottom: 0; width: 0; z-index: 4; pointer-events: none; border-left: 1px dashed #fbbf24; }
</style>
