<template>
  <div class="music-panel">
    <section class="block">
      <h3>{{ t('timeline.mix.title') }}</h3>
      <div class="field">
        <label>{{ t('timeline.mix.musicVolume') }}</label>
        <el-slider
          :model-value="musicPercent"
          :min="0"
          :max="MUSIC_VOLUME_MAX_PERCENT"
          :format-tooltip="(v) => v + '%'"
          :disabled="!store.musicTrack"
          data-test="music-volume"
          @update:model-value="onMusicVolume"
        />
        <span class="val">{{ musicPercent }}%</span>
      </div>
      <div class="field">
        <label>{{ t('timeline.mix.ducking') }}</label>
        <el-switch :model-value="store.mix.ducking.enabled" data-test="duck-enabled" @update:model-value="(v) => store.updateMix({ ducking: { enabled: v } })" />
      </div>
      <div class="field" :class="{ off: !store.mix.ducking.enabled }">
        <label>{{ t('timeline.mix.duckGain') }}</label>
        <el-slider
          :model-value="toPercent(store.mix.ducking.gain)"
          :min="0"
          :max="100"
          :disabled="!store.mix.ducking.enabled"
          :format-tooltip="(v) => v + '%'"
          data-test="duck-gain"
          @update:model-value="(v) => store.updateMix({ ducking: { gain: fromPercent(v) } })"
        />
        <span class="val">{{ toPercent(store.mix.ducking.gain) }}%</span>
      </div>
      <div class="field" :class="{ off: !store.mix.ducking.enabled }">
        <label>{{ t('timeline.mix.ramp') }}</label>
        <el-input-number
          :model-value="store.mix.ducking.rampMs"
          :min="0"
          :max="5000"
          :step="50"
          size="small"
          :disabled="!store.mix.ducking.enabled"
          @update:model-value="(v) => v != null && store.updateMix({ ducking: { rampMs: v } })"
        />
        <span class="val">{{ t('timeline.mix.ms') }}</span>
      </div>
      <div class="field">
        <label>{{ t('timeline.mix.loudnorm') }}</label>
        <el-switch :model-value="store.mix.loudnorm" @update:model-value="(v) => store.updateMix({ loudnorm: v })" />
      </div>
      <p class="hint">{{ t('timeline.mix.hint') }}</p>
    </section>

    <section class="block">
      <div class="block-head">
        <h3>{{ t('timeline.music.library') }}</h3>
        <el-button size="small" :loading="uploading" data-test="import-btn" @click="pickFile">{{ t('timeline.music.import') }}</el-button>
        <input ref="fileInput" type="file" :accept="accept" hidden @change="onFile" />
      </div>
      <p class="hint warn">{{ t('timeline.music.licence') }}</p>
      <div v-loading="loading" class="lib">
        <div v-if="!items.length && !loading" class="empty">{{ t('timeline.music.empty') }}</div>
        <div v-for="m in items" :key="m.id" class="item" data-test="music-item">
          <div class="meta">
            <div class="name" :title="m.name">{{ m.name }}</div>
            <div class="sub">
              <el-tag size="small" :type="m.source === 'builtin' ? 'info' : 'success'">{{ m.source === 'builtin' ? t('timeline.music.sourceBuiltin') : t('timeline.music.sourceUser') }}</el-tag>
              {{ formatDuration(m.duration_ms) }} · {{ formatSize(m.size_bytes) }}
            </div>
          </div>
          <div class="ops">
            <el-button size="small" text @click="toggleAudition(m)">{{ playingId === m.id ? t('timeline.music.stop') : t('timeline.music.audition') }}</el-button>
            <el-button size="small" type="primary" :loading="attachingId === m.id" @click="attach(m)">{{ t('timeline.music.attach') }}</el-button>
            <el-button v-if="m.source === 'user'" size="small" text type="danger" @click="remove(m)">{{ t('common.delete') }}</el-button>
          </div>
        </div>
      </div>
      <el-checkbox v-model="loop" class="loop">{{ t('timeline.music.loop') }}</el-checkbox>
      <p v-if="hint" class="hint">{{ hint }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { musicAPI } from '@/api/music'
import { useI18n } from '@/i18n'
import { useTimelineStore } from '@/stores/timeline'
import { resolveAssetUrl } from '@/utils/timelineMath'
import {
  MUSIC_VOLUME_MAX_PERCENT, MUSIC_EXTENSIONS, toPercent, fromPercent, formatDuration, formatSize, shortTrackHint, checkMusicFile
} from '@/utils/mixView'

const { t } = useI18n()
const store = useTimelineStore()
const items = ref([])
const loading = ref(false)
const uploading = ref(false)
const attachingId = ref('')
const playingId = ref('')
const loop = ref(true)
const fileInput = ref(null)
const accept = MUSIC_EXTENSIONS.map((e) => '.' + e).join(',')
let audio = null

const musicPercent = computed(() => toPercent(store.musicTrack?.volume ?? 1))
const selectedTrack = ref(null)
const hint = computed(() => (selectedTrack.value ? shortTrackHint(selectedTrack.value.duration_ms, store.durationMs, loop.value) : ''))

function onMusicVolume(p) {
  store.setTrackVolume('music', fromPercent(p))
}

async function load() {
  loading.value = true
  try {
    items.value = (await musicAPI.list()).items || []
  } catch (_) {
    /* request.js 已提示 */
  } finally {
    loading.value = false
  }
}

function pickFile() {
  fileInput.value?.click()
}

/** 浏览器端读取时长，仅作后端无法探测时的兜底 */
function browserDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const a = new Audio()
    const done = (v) => { URL.revokeObjectURL(url); resolve(v) }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0)
    a.onerror = () => done(0)
    a.src = url
  })
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  const bad = checkMusicFile(file)
  if (bad) return ElMessage.warning(bad)
  uploading.value = true
  try {
    await musicAPI.upload(file, await browserDuration(file))
    ElMessage.success(t('timeline.music.imported'))
    await load()
  } catch (_) {
    /* 同上 */
  } finally {
    uploading.value = false
  }
}

function stopAudition() {
  if (audio) { audio.pause(); audio = null }
  playingId.value = ''
}

function toggleAudition(m) {
  const was = playingId.value
  stopAudition()
  if (was === m.id) return
  audio = new Audio(resolveAssetUrl(m.file_path))
  audio.onended = () => { playingId.value = '' }
  audio.play().catch(() => { ElMessage.warning(t('timeline.music.playFail')); playingId.value = '' })
  playingId.value = m.id
}

async function attach(m) {
  selectedTrack.value = m
  attachingId.value = m.id
  try {
    await store.attachMusic(m.id, { loop: loop.value })
    ElMessage.success(t('timeline.music.attached'))
  } catch (_) {
    /* 同上 */
  } finally {
    attachingId.value = ''
  }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm(t('timeline.music.removeConfirm', { name: m.name }), t('timeline.music.removeTitle'), { type: 'warning' })
  } catch (_) { return }
  try {
    if (playingId.value === m.id) stopAudition()
    await musicAPI.remove(m.id)
    await load()
  } catch (_) {
    /* 被时间线使用时后端会给出原因 */
  }
}

onMounted(load)
onBeforeUnmount(stopAudition)
</script>

<style scoped>
.music-panel { display: flex; flex-direction: column; gap: 20px; color: var(--text-primary); }
.block h3 { margin: 0 0 12px; font-size: 14px; color: var(--text-bright); }
.block-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.block-head h3 { margin: 0; }
.field { display: grid; grid-template-columns: 110px 1fr 56px; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13px; }
.field.off { opacity: .5; }
.field label { color: var(--text-muted); }
.field .val { color: var(--text-subtle); font-size: 12px; text-align: right; }
.hint { margin: 6px 0 0; font-size: 12px; color: var(--text-subtle); }
.hint.warn { color: var(--el-color-warning); }
.lib { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; min-height: 40px; }
.empty { color: var(--text-subtle); font-size: 13px; }
.item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: var(--bg-inner); border: 1px solid var(--border-color); border-radius: 6px; }
.meta { min-width: 0; }
.name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 11px; color: var(--text-subtle); margin-top: 2px; }
.ops { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.loop { margin-top: 10px; }
</style>
