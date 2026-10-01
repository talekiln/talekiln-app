<template>
  <div class="music-panel">
    <section class="block">
      <h3>混音设置</h3>
      <div class="field">
        <label>音乐音量</label>
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
        <label>旁白时压低音乐</label>
        <el-switch :model-value="store.mix.ducking.enabled" data-test="duck-enabled" @update:model-value="(v) => store.updateMix({ ducking: { enabled: v } })" />
      </div>
      <div class="field" :class="{ off: !store.mix.ducking.enabled }">
        <label>压低后音乐音量</label>
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
        <label>渐变时长</label>
        <el-input-number
          :model-value="store.mix.ducking.rampMs"
          :min="0"
          :max="5000"
          :step="50"
          size="small"
          :disabled="!store.mix.ducking.enabled"
          @update:model-value="(v) => v != null && store.updateMix({ ducking: { rampMs: v } })"
        />
        <span class="val">毫秒</span>
      </div>
      <div class="field">
        <label>响度归一化</label>
        <el-switch :model-value="store.mix.loudnorm" @update:model-value="(v) => store.updateMix({ loudnorm: v })" />
      </div>
      <p class="hint">压低只跟随旁白轨；导出时按以上设置混音。这些设置随时间线一起保存。</p>
    </section>

    <section class="block">
      <div class="block-head">
        <h3>音乐库</h3>
        <el-button size="small" :loading="uploading" data-test="import-btn" @click="pickFile">导入音乐</el-button>
        <input ref="fileInput" type="file" :accept="accept" hidden @change="onFile" />
      </div>
      <p class="hint warn">请确认你拥有所导入音乐的使用授权；示例配乐由程序合成，仅作占位。</p>
      <div v-loading="loading" class="lib">
        <div v-if="!items.length && !loading" class="empty">音乐库为空</div>
        <div v-for="m in items" :key="m.id" class="item" data-test="music-item">
          <div class="meta">
            <div class="name" :title="m.name">{{ m.name }}</div>
            <div class="sub">
              <el-tag size="small" :type="m.source === 'builtin' ? 'info' : 'success'">{{ m.source === 'builtin' ? '示例' : '我的' }}</el-tag>
              {{ formatDuration(m.duration_ms) }} · {{ formatSize(m.size_bytes) }}
            </div>
          </div>
          <div class="ops">
            <el-button size="small" text @click="toggleAudition(m)">{{ playingId === m.id ? '停止' : '试听' }}</el-button>
            <el-button size="small" type="primary" :loading="attachingId === m.id" @click="attach(m)">添加到音乐轨</el-button>
            <el-button v-if="m.source === 'user'" size="small" text type="danger" @click="remove(m)">删除</el-button>
          </div>
        </div>
      </div>
      <el-checkbox v-model="loop" class="loop">循环铺满视频长度</el-checkbox>
      <p v-if="hint" class="hint">{{ hint }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { musicAPI } from '@/api/music'
import { useTimelineStore } from '@/stores/timeline'
import { resolveAssetUrl } from '@/utils/timelineMath'
import {
  MUSIC_VOLUME_MAX_PERCENT, MUSIC_EXTENSIONS, toPercent, fromPercent, formatDuration, formatSize, shortTrackHint, checkMusicFile
} from '@/utils/mixView'

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
    ElMessage.success('已导入')
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
  audio.play().catch(() => { ElMessage.warning('无法播放该文件'); playingId.value = '' })
  playingId.value = m.id
}

async function attach(m) {
  selectedTrack.value = m
  attachingId.value = m.id
  try {
    await store.attachMusic(m.id, { loop: loop.value })
    ElMessage.success('已添加到音乐轨')
  } catch (_) {
    /* 同上 */
  } finally {
    attachingId.value = ''
  }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm(`删除「${m.name}」？文件会从本机音乐库移除。`, '删除音乐', { type: 'warning' })
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
