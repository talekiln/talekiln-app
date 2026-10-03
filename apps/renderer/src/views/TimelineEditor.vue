<template>
  <div class="timeline-editor">
    <header class="te-header">
      <el-button size="small" @click="goBack">
        <el-icon><ArrowLeft /></el-icon> {{ t('common.back') }}
      </el-button>
      <h1 class="te-title">{{ t('timeline.title') }}</h1>
      <span class="te-save" :class="'is-' + store.saveState">{{ saveText }}</span>
      <div class="te-spacer" />
      <template v-if="store.timeline">
        <el-button size="small" :disabled="!selectedClip" @click="onSplit">{{ t('timeline.split') }}</el-button>
        <el-button size="small" :disabled="!selectedClip" @click="onDelete">{{ t('timeline.delete') }}</el-button>
        <el-button size="small" :loading="store.loading" @click="onReassemble">{{ t('timeline.reassemble') }}</el-button>
        <el-button size="small" data-test="open-voiceover" @click="voiceoverOpen = true">{{ t('timeline.voiceover') }}</el-button>
        <el-button size="small" data-test="open-music" @click="musicOpen = true">{{ t('timeline.music') }}</el-button>
        <el-button size="small" type="primary" data-test="open-export" @click="goExport">{{ t('timeline.export') }}</el-button>
        <el-button size="small" @click="router.push('/settings/shortcuts')">{{ t('timeline.shortcuts') }}</el-button>
        <el-button-group>
          <el-button size="small" @click="zoom(1 / 1.25)">-</el-button>
          <el-button size="small" disabled>{{ Math.round(pxPerSec) }} px/s</el-button>
          <el-button size="small" @click="zoom(1.25)">+</el-button>
        </el-button-group>
      </template>
    </header>

    <el-drawer v-model="musicOpen" :title="t('timeline.music')" size="400px" append-to-body>
      <MusicPanel v-if="store.timeline" />
    </el-drawer>

    <el-drawer v-model="voiceoverOpen" :title="t('timeline.voiceover')" size="400px" append-to-body>
      <VoiceoverPanel v-if="store.timeline" :episode-id="episodeId" @done="onVoiceoverDone" />
    </el-drawer>

    <div v-if="store.loading && !store.timeline" class="te-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!store.timeline" class="te-empty">
      <p>{{ t('timeline.notAssembled') }}</p>
      <el-button type="primary" :loading="store.loading" @click="onAssemble">{{ t('timeline.assemble') }}</el-button>
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
          <div v-if="previewKind === 'none'" class="te-screen-empty">{{ t('timeline.noPicture') }}</div>
          <div v-if="subtitleText" class="te-subtitle">{{ subtitleText }}</div>
        </div>
        <div class="te-transport">
          <el-button circle size="small" @click="togglePlay">
            <el-icon><VideoPause v-if="playing" /><VideoPlay v-else /></el-icon>
          </el-button>
          <span class="te-time">{{ formatTime(playhead) }} / {{ formatTime(store.durationMs) }}</span>
          <span class="te-hint">{{ t('timeline.hint') }}</span>
        </div>
      </section>

      <section class="te-timeline">
        <div ref="scrollEl" class="te-scroll" @wheel="onWheel">
          <div class="te-canvas" :style="{ width: LABEL_W + contentWidth + 'px' }">
            <div class="te-row te-ruler-row">
              <div class="te-label" />
              <div class="te-ruler" :style="{ width: contentWidth + 'px' }" @pointerdown="onRulerDown">
                <div v-for="tk in ticks" :key="tk.ms" class="te-tick" :style="{ left: tk.x + 'px' }">
                  <span>{{ tk.label }}</span>
                </div>
              </div>
            </div>

            <div v-for="track in store.tracks" :key="track.id" class="te-row">
              <div class="te-label">{{ trackName(track.kind) }}</div>
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
import { useI18n } from '@/i18n'
import { ArrowLeft, VideoPlay, VideoPause } from '@element-plus/icons-vue'
import { useTimelineStore } from '@/stores/timeline'
import MusicPanel from '@/components/MusicPanel.vue'
import { useProjectViewsStore } from '@/stores/projectViews'
import { fromKernelClipId, toKernelClipId } from '@/utils/projectViews'
import { shotLabelsByLegacy, clipDisplayLabel } from '@/utils/clipLabel'
import VoiceoverPanel from '@/components/VoiceoverPanel.vue'
import { useKeymap } from '@/composables/useKeymap'
import { SCOPE_TIMELINE, SCOPE_WORKBENCH } from '@/utils/keymap'
import {
  DEFAULT_ZOOM, msToPx, pxToMs, zoomBy, formatTime, rulerTicks, clipAt, clipEnd, findClip,
  snapPoints, snapValue, snapMove, resolveMove, resolveResize, sourceTimeAt, resolveAssetUrl
} from '@/utils/timelineMath'

const LABEL_W = 72
const SNAP_PX = 8
const TRACK_KINDS = ['video', 'subtitle', 'narration', 'music']

const { t } = useI18n()
const trackName = (kind) => (TRACK_KINDS.includes(kind) ? t(`timeline.track.${kind}`) : kind)
const route = useRoute()
const router = useRouter()
const store = useTimelineStore()
// 四视图共享状态（选择 / 播放头 / 历史）。时间线编辑器自己的编辑走旧接口（已改道经内核），保存后刷新共享 store
const views = useProjectViewsStore()

const episodeId = computed(() => Number(route.params.episodeId))
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
const saveText = computed(() => (['dirty', 'saving', 'error'].includes(store.saveState) ? t(`timeline.save.${store.saveState}`) : ''))

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
  router.push({ name: 'episode-storyboard', params: { dramaId: route.params.dramaId, episodeId: episodeId.value } })
}

async function goExport() {
  await store.flushPending()
  // 导出已改为对话框（export.video）；先落盘再开，避免导出读到旧时间线
  const { openDialog } = await import('@/shell/dialogs')
  openDialog('export.video', { dramaId: Number(route.params.dramaId), episodeId: Number(episodeId.value) })
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
    ElMessage.error(e.message || t('timeline.loadFailed'))
  }
  await maybeRecover()
  await views.load(episodeId.value, { drama: route.params.dramaId })
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
// 撤销 / 重做只有一份：内核历史（顶栏按钮 + 这里的 Ctrl+Z）。时间线编辑先经 PUT /timelines 进内核，
// 所以先把还没保存的编辑冲出去，再让内核回退；轨道音量 / 静音 / 混音不在图里，内核撤销不会动它们。
async function kernelUndo(which) {
  try { await store.flushPending() } catch (_) { /* 保存失败已提示并回读 */ }
  return which === 'redo' ? views.redo() : views.undo()
}

async function onVoiceoverDone() {
  try { await store.load(episodeId.value) } catch (e) { ElMessage.error(e.message || t('timeline.reloadFailed')) }
}

async function onAssemble() {
  try {
    await store.assemble(episodeId.value)
  } catch (_) { /* 错误提示由 request 拦截器给出 */ }
}

async function onReassemble() {
  try {
    await ElMessageBox.confirm(t('timeline.reassemble.confirm'), t('timeline.reassemble.title'), { type: 'warning' })
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

// 片段属于某个镜头时显示“镜 5 · 标题”，不是素材哈希（见 utils/clipLabel.js）
const shotLabels = computed(() => shotLabelsByLegacy(views.views.shots))
function clipLabel(clip) {
  return clipDisplayLabel(clip, shotLabels.value, t('timeline.clip.default'))
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
  if (!store.splitAt(playhead.value)) ElMessage.warning(t('timeline.splitFail'))
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
  if (!store.toggleMute()) ElMessage.warning(t('timeline.muteNeedClip'))
}

const stub = (name) => () => { ElMessage.info(t('timeline.stub', { name: typeof name === 'function' ? name() : name })) }

const onKeydown = createKeyHandler({
  'play.toggle': () => togglePlay(),
  'clip.split': () => onSplit(),
  'clip.delete': () => onDelete(),
  'edit.undo': () => kernelUndo('undo'),
  'edit.redo': () => kernelUndo('redo'),
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
  'shot.regenerate': stub(() => t('timeline.stub.regenerate')),
  'shot.pick1': stub(() => t('timeline.stub.pick', { n: 1 })),
  'shot.pick2': stub(() => t('timeline.stub.pick', { n: 2 })),
  'shot.pick3': stub(() => t('timeline.stub.pick', { n: 3 })),
  'shot.pick4': stub(() => t('timeline.stub.pick', { n: 4 })),
  'shot.compareToggle': stub(() => t('timeline.stub.compare')),
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
  const msg = t(r.conflict ? 'timeline.recover.conflict' : 'timeline.recover.msg', { when })
  try {
    await ElMessageBox.confirm(msg, t('timeline.recover.title'), { confirmButtonText: t('timeline.recover.restore'), cancelButtonText: t('timeline.recover.discard'), type: 'warning', distinguishCancelAndClose: true, closeOnClickModal: false })
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
