<template>
  <el-dialog
    v-model="visible"
    :title="t('export.dialog.title.video')"
    width="720px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    append-to-body
    data-test="export-video"
    @closed="emit('close', result)"
  >
    <div v-loading="loading" class="ed-body">
      <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />
      <el-alert v-if="draftText" class="ed-gap" type="warning" :closable="false" show-icon :title="draftText" data-test="draft-hint" />

      <h3 class="ed-h">{{ t('export.dialog.settings') }}</h3>
      <el-form label-width="96px" :disabled="busy" @submit.prevent>
        <el-form-item :label="t('export.dialog.resolution')">
          <el-select v-model="form.resolution" style="width: 320px" data-test="resolution" @change="onSizeChange">
            <el-option-group :label="t('export.dialog.groupGeneral')">
              <el-option v-for="r in resolutions" :key="r.key" :label="sizeLabel(r)" :value="r.key" />
            </el-option-group>
            <el-option-group :label="t('export.dialog.groupPlatform')">
              <el-option v-for="r in presets" :key="r.key" :label="sizeLabel(r)" :value="r.key" />
            </el-option-group>
          </el-select>
          <div v-if="currentPreset" class="ed-hint" data-test="preset-hint">{{ presetHint(currentPreset) }}</div>
        </el-form-item>
        <el-form-item :label="t('export.dialog.fps')">
          <el-radio-group v-model="form.fps" data-test="fps">
            <el-radio-button v-for="f in fpsOptions" :key="f" :value="f">{{ f }} fps</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('export.dialog.encoder')">
          <el-select v-model="form.encoder" style="width: 360px" data-test="encoder">
            <el-option v-for="o in encoders" :key="o.value" :label="o.label" :value="o.value" :disabled="o.disabled">
              <span>{{ o.label }}</span>
              <span v-if="o.disabled && o.reason" class="ed-reason">{{ o.reason }}</span>
            </el-option>
          </el-select>
          <el-button text size="small" :loading="detecting" @click="loadOptions(true)">{{ t('export.dialog.redetect') }}</el-button>
          <div class="ed-hint">{{ t('export.dialog.encoderHint') }}</div>
        </el-form-item>
        <el-form-item :label="t('export.dialog.outputPath')">
          <el-input v-model="form.output_path" :placeholder="t('export.dialog.outputPathPlaceholder')" data-test="output-path" />
          <div class="ed-hint">{{ t('export.dialog.outputPathHint') }}</div>
        </el-form-item>
      </el-form>

      <h3 class="ed-h">{{ t('export.dialog.aigc.title') }}</h3>
      <div class="ed-aigc">
        <el-switch v-model="aigc.watermark" :disabled="busy" data-test="aigc-watermark" @change="saveAigc" />
        <span>{{ t('export.dialog.aigc.watermark') }}</span>
      </div>
      <div class="ed-aigc">
        <el-switch v-model="aigc.metadata" :disabled="busy" data-test="aigc-metadata" @change="saveAigc" />
        <span>{{ t('export.dialog.aigc.metadata') }}</span>
      </div>
      <div class="ed-aigc">
        <span class="ed-producer">{{ t('export.dialog.aigc.producer') }}</span>
        <el-input v-model="aigc.producer" :disabled="busy || !aigc.metadata" style="width: 240px" maxlength="100" @change="saveAigc" />
      </div>
      <el-alert v-if="!aigc.watermark || !aigc.metadata" class="ed-gap" type="warning" :closable="false" show-icon :title="t('export.dialog.aigc.warn')" />
      <div class="ed-hint">{{ t('export.dialog.aigc.hint') }}</div>

      <div v-if="job" class="ed-job" data-test="job">
        <el-progress :percentage="percent" :status="progressStatus(job.status)" :stroke-width="14" />
        <div class="ed-job-line">
          <span class="ed-stage" data-test="stage">{{ stageLabel(job.status, job.stage) }}</span>
          <span v-if="job.encoder" class="ed-meta">{{ t('export.dialog.encoderUsed', { name: job.encoder }) }}</span>
          <span v-if="elapsedMs" class="ed-meta">{{ t('export.dialog.elapsedLabel', { time: formatElapsed(elapsedMs) }) }}</span>
        </div>
        <el-alert v-if="job.warning" type="warning" :closable="false" show-icon :title="job.warning" data-test="placeholder-warning" />
        <el-alert v-if="job.status === 'failed'" type="error" :closable="false" show-icon :title="errorText(job.error)" data-test="job-error" />
        <el-alert v-if="job.status === 'cancelled'" type="warning" :closable="false" show-icon :title="t('export.dialog.cancelled')" />
        <div v-if="job.status === 'done'" class="ed-done">
          <el-alert type="success" :closable="false" show-icon :title="t('export.dialog.done')" />
          <div class="ed-path" data-test="done-path">{{ job.output_path }}</div>
          <div v-if="job.result" class="ed-meta">
            {{ t('export.dialog.doneMeta', { duration: formatDuration(job.result.durationMs), rendered: job.result.scenesRendered, cached: job.result.scenesCached }) }}
          </div>
          <el-button type="primary" data-test="open-folder" @click="onOpenFolder">{{ t('export.dialog.openFolder') }}</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button v-if="!busy" data-test="close" @click="visible = false">{{ t('common.close') }}</el-button>
      <el-button v-if="!busy" type="primary" :disabled="!!loadError" :loading="starting" data-test="start" @click="onStart">{{ t('export.dialog.start') }}</el-button>
      <el-button v-else :loading="cancelling" data-test="cancel" @click="onCancel">{{ t('export.dialog.cancelExport') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { exportAPI } from '@/api/export'
import { useShellStore } from '@/stores/shell'
import {
  FALLBACK_RESOLUTIONS, FALLBACK_PLATFORM_PRESETS, sizeLabel, sizeTable, presetOf, presetHint, encoderOptions, validateForm,
  buildStartRequest, stageLabel, progressStatus, errorText, formatElapsed, formatPercent, isFinal, createJobPoller,
} from '@/utils/exportJob'
import { formatDuration } from '@/utils/mixView'
import { applyOptions, draftHint } from './exportDialogModel.js'

const props = defineProps({
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], required: true },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const shell = useShellStore()

const visible = ref(true)
const loading = ref(false)
const detecting = ref(false)
const loadError = ref('')
const starting = ref(false)
const cancelling = ref(false)
const resolutions = ref(FALLBACK_RESOLUTIONS)
const presets = ref(FALLBACK_PLATFORM_PRESETS)
const fpsOptions = ref([24, 25, 30, 60])
const encoders = ref(encoderOptions([], null))
const form = reactive({ resolution: '1080p', fps: 30, encoder: 'auto', output_path: '' })
const aigc = reactive({ watermark: true, metadata: true, producer: 'Talekiln' })
const job = ref(null)
const startedAt = ref(0)
const elapsedMs = ref(0)
let clock = null
let result

const sizes = computed(() => sizeTable(resolutions.value, presets.value))
const currentPreset = computed(() => presetOf(presets.value, form.resolution))
const busy = computed(() => starting.value || (!!job.value && !isFinal(job.value.status)))
const percent = computed(() => formatPercent(job.value && job.value.percent))
const draftText = computed(() => draftHint(shell.draftCount))

const poller = createJobPoller({
  getStatus: (id) => exportAPI.status(id),
  onUpdate: (s) => {
    job.value = s
    if (isFinal(s.status)) {
      stopClock()
      result = { jobId: s.job_id, status: s.status, outputPath: s.output_path }
    }
  },
  onError: (e) => {
    stopClock()
    ElMessage.error((e && e.message) || t('export.dialog.progressFailed'))
  },
})

function startClock() {
  stopClock()
  startedAt.value = Date.now()
  elapsedMs.value = 0
  clock = setInterval(() => { elapsedMs.value = Date.now() - startedAt.value }, 500)
}
function stopClock() {
  if (clock) { clearInterval(clock); clock = null }
  if (startedAt.value) elapsedMs.value = Date.now() - startedAt.value
}

async function loadOptions(refresh = false) {
  if (refresh) detecting.value = true
  else loading.value = true
  loadError.value = ''
  try {
    const o = await exportAPI.options(props.episodeId, refresh)
    const r = applyOptions(o, { fpsOptions: fpsOptions.value, encoder: form.encoder, resolution: form.resolution, fps: form.fps }, { refresh })
    resolutions.value = r.resolutions
    presets.value = r.presets
    fpsOptions.value = r.fpsOptions
    encoders.value = r.encoders
    if (!refresh) {
      form.resolution = r.resolution
      form.fps = r.fps
      form.output_path = r.outputPath
      if (r.aigc) Object.assign(aigc, r.aigc)
    } else if (r.encoder) {
      form.encoder = r.encoder
    }
  } catch (e) {
    loadError.value = (e && e.message) || t('export.dialog.loadFailed')
  } finally {
    loading.value = false
    detecting.value = false
  }
}

async function saveAigc() {
  try {
    const saved = await exportAPI.putAigc({ watermark: aigc.watermark, metadata: aigc.metadata, producer: aigc.producer })
    Object.assign(aigc, saved)
  } catch (_) {
    // request.js 已提示；重新读取以恢复界面
    try { Object.assign(aigc, await exportAPI.getAigc()) } catch (_e) { /* 忽略 */ }
  }
}

function onSizeChange() {
  const p = currentPreset.value
  if (p) form.fps = p.fps
}

async function onStart() {
  const bad = validateForm(form)
  if (bad) return ElMessage.warning(bad)
  starting.value = true
  job.value = null
  try {
    const r = await exportAPI.start(buildStartRequest(form, sizes.value, props.episodeId))
    // warning：空镜头黑场占位提示（start / status 都带，轮询覆盖 job 后仍在）
    job.value = { job_id: r.job_id, status: 'queued', percent: 0, stage: 'queued', output_path: r.output_path, encoder: r.encoder, warning: r.warning || null }
    startClock()
    poller.start(r.job_id)
  } catch (_) {
    // 错误文案由后端给出，request.js 已提示
  } finally {
    starting.value = false
  }
}

async function onCancel() {
  if (!job.value) return
  cancelling.value = true
  try {
    await exportAPI.cancel(job.value.job_id)
    ElMessage.info(t('export.dialog.cancelRequested'))
  } catch (_) {
    // 同上
  } finally {
    cancelling.value = false
  }
}

async function onOpenFolder() {
  try { await exportAPI.openFolder(job.value.job_id) } catch (_) { /* 同上 */ }
}

onMounted(() => loadOptions())
onBeforeUnmount(() => { poller.stop(); stopClock() })
</script>

<style scoped>
.ed-body { min-height: 120px; }
.ed-h { margin: 16px 0 10px; font-size: 14px; color: var(--text-bright); }
.ed-h:first-of-type { margin-top: 0; }
.ed-gap { margin: 8px 0; }
.ed-hint { margin-top: 4px; font-size: 12px; color: var(--text-subtle); line-height: 1.5; width: 100%; }
.ed-reason { margin-left: 12px; font-size: 12px; color: var(--text-subtle); }
.ed-aigc { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; }
.ed-producer { color: var(--text-muted); }
.ed-job { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.ed-job-line { display: flex; gap: 16px; align-items: baseline; font-size: 13px; }
.ed-stage { color: var(--text-bright); font-weight: 600; }
.ed-meta { color: var(--text-subtle); font-size: 12px; }
.ed-done { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.ed-path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; color: var(--text-muted); }
</style>
