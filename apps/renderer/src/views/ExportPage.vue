<template>
  <div class="export-page">
    <header class="header">
      <div class="header-inner">
        <h1 class="logo">导出视频</h1>
        <span class="sub">剧集 {{ episodeId }}</span>
        <el-button class="btn-back" @click="goBack">返回时间线</el-button>
      </div>
    </header>

    <main v-loading="loading" class="main">
      <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

      <section class="panel">
        <h2>导出设置</h2>
        <el-form label-width="96px" :disabled="busy">
          <el-form-item label="分辨率">
            <el-select v-model="form.resolution" style="width: 280px" data-test="resolution">
              <el-option v-for="r in resolutions" :key="r.key" :label="r.label" :value="r.key" />
            </el-select>
          </el-form-item>
          <el-form-item label="帧率">
            <el-radio-group v-model="form.fps" data-test="fps">
              <el-radio-button v-for="f in fpsOptions" :key="f" :value="f">{{ f }} fps</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="编码器">
            <el-select v-model="form.encoder" style="width: 360px" data-test="encoder">
              <el-option v-for="o in encoders" :key="o.value" :label="o.label" :value="o.value" :disabled="o.disabled">
                <span>{{ o.label }}</span>
                <span v-if="o.disabled && o.reason" class="opt-reason">{{ o.reason }}</span>
              </el-option>
            </el-select>
            <el-button text size="small" :loading="detecting" @click="loadOptions(true)">重新检测</el-button>
            <div class="hint">硬件编码失败时会自动回退到其他可用编码器，最后是软件编码。</div>
          </el-form-item>
          <el-form-item label="导出位置">
            <el-input v-model="form.output_path" placeholder="D:\导出\第1集.mp4" data-test="output-path" />
            <div class="hint">请填写本机的完整路径（以 .mp4 结尾），文件夹不存在时会自动创建；同名文件会被覆盖。</div>
          </el-form-item>
        </el-form>
      </section>

      <section class="panel">
        <h2>AI 生成内容标识</h2>
        <div class="aigc-row">
          <el-switch v-model="aigc.watermark" :disabled="busy" data-test="aigc-watermark" @change="saveAigc" />
          <span>在画面上显示“AI生成”文字（片头较大，之后持续显示）</span>
        </div>
        <div class="aigc-row">
          <el-switch v-model="aigc.metadata" :disabled="busy" data-test="aigc-metadata" @change="saveAigc" />
          <span>在文件元数据中写入 AI 生成标识（AIGC）</span>
        </div>
        <div class="aigc-row">
          <span class="producer-label">制作方名称</span>
          <el-input v-model="aigc.producer" :disabled="busy || !aigc.metadata" style="width: 240px" maxlength="100" @change="saveAigc" />
        </div>
        <el-alert
          v-if="!aigc.watermark || !aigc.metadata"
          class="aigc-warn"
          type="warning"
          :closable="false"
          show-icon
          title="已关闭部分标识。发布 AI 生成内容时，标识义务由发布者承担，请确认符合平台及相关法规要求。"
        />
        <div class="hint">此功能的实现范围与需法务确认的事项见 docs/aigc-marking.md，未经确认请勿据此声称合规。</div>
      </section>

      <section class="panel">
        <div class="actions">
          <el-button v-if="!busy" type="primary" :disabled="!!loadError" :loading="starting" data-test="start" @click="onStart">开始导出</el-button>
          <el-button v-else :loading="cancelling" data-test="cancel" @click="onCancel">取消导出</el-button>
        </div>

        <div v-if="job" class="job" data-test="job">
          <el-progress :percentage="percent" :status="progressStatus(job.status)" :stroke-width="14" />
          <div class="job-line">
            <span class="job-stage" data-test="stage">{{ stageLabel(job.status, job.stage) }}</span>
            <span v-if="job.encoder" class="job-meta">编码器 {{ job.encoder }}</span>
            <span v-if="elapsedMs" class="job-meta">已用时 {{ formatElapsed(elapsedMs) }}</span>
          </div>
          <el-alert v-if="job.status === 'failed'" type="error" :closable="false" show-icon :title="errorText(job.error)" data-test="job-error" />
          <el-alert v-if="job.status === 'cancelled'" type="warning" :closable="false" show-icon title="导出已取消" />
          <div v-if="job.status === 'done'" class="done">
            <el-alert type="success" :closable="false" show-icon title="导出完成" />
            <div class="done-path" data-test="done-path">{{ job.output_path }}</div>
            <div v-if="job.result" class="job-meta">
              时长 {{ formatDuration(job.result.durationMs) }} · 渲染 {{ job.result.scenesRendered }} 个分镜，缓存命中 {{ job.result.scenesCached }} 个
            </div>
            <el-button type="primary" data-test="open-folder" @click="onOpenFolder">打开所在文件夹</el-button>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { exportAPI } from '@/api/export'
import {
  FALLBACK_RESOLUTIONS, encoderOptions, validateForm, buildStartRequest, stageLabel, progressStatus, errorText,
  formatElapsed, formatPercent, isFinal, createJobPoller
} from '@/utils/exportJob'
import { formatDuration } from '@/utils/mixView'

const route = useRoute()
const router = useRouter()
const episodeId = computed(() => Number(route.params.id))

const loading = ref(false)
const detecting = ref(false)
const loadError = ref('')
const starting = ref(false)
const cancelling = ref(false)
const resolutions = ref(FALLBACK_RESOLUTIONS)
const fpsOptions = ref([24, 25, 30, 60])
const encoders = ref(encoderOptions([], null))
const form = reactive({ resolution: '1080p', fps: 30, encoder: 'auto', output_path: '' })
const aigc = reactive({ watermark: true, metadata: true, producer: 'Talekiln' })
const job = ref(null)
const startedAt = ref(0)
const elapsedMs = ref(0)
let clock = null

const busy = computed(() => starting.value || (!!job.value && !isFinal(job.value.status)))
const percent = computed(() => formatPercent(job.value?.percent))

const poller = createJobPoller({
  getStatus: (id) => exportAPI.status(id),
  onUpdate: (s) => { job.value = s; if (isFinal(s.status)) stopClock() },
  onError: (e) => {
    stopClock()
    ElMessage.error(e?.message || '无法获取导出进度')
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
    const o = await exportAPI.options(episodeId.value, refresh)
    resolutions.value = o.resolutions?.length ? o.resolutions : FALLBACK_RESOLUTIONS
    fpsOptions.value = o.fps_options?.length ? o.fps_options : fpsOptions.value
    encoders.value = encoderOptions(o.encoders, o.best_encoder)
    if (!refresh) {
      form.resolution = o.default_resolution || form.resolution
      form.fps = o.default_fps || form.fps
      form.output_path = o.output_path || ''
      Object.assign(aigc, o.aigc || {})
    } else if (!encoders.value.some((x) => x.value === form.encoder && !x.disabled)) {
      form.encoder = 'auto'
    }
  } catch (e) {
    loadError.value = e?.message || '无法读取导出选项'
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
    /* request.js 已提示；重新读取以恢复界面 */
    try { Object.assign(aigc, await exportAPI.getAigc()) } catch (_e) { /* 忽略 */ }
  }
}

async function onStart() {
  const bad = validateForm(form)
  if (bad) return ElMessage.warning(bad)
  starting.value = true
  job.value = null
  try {
    const r = await exportAPI.start(buildStartRequest(form, resolutions.value, episodeId.value))
    job.value = { job_id: r.job_id, status: 'queued', percent: 0, stage: 'queued', output_path: r.output_path, encoder: r.encoder }
    startClock()
    poller.start(r.job_id)
  } catch (_) {
    /* 错误文案由后端给出，request.js 已提示 */
  } finally {
    starting.value = false
  }
}

async function onCancel() {
  if (!job.value) return
  cancelling.value = true
  try {
    await exportAPI.cancel(job.value.job_id)
    ElMessage.info('已请求取消，正在停止渲染')
  } catch (_) {
    /* 同上 */
  } finally {
    cancelling.value = false
  }
}

async function onOpenFolder() {
  try { await exportAPI.openFolder(job.value.job_id) } catch (_) { /* 同上 */ }
}

function goBack() {
  const { drama } = route.query
  router.push({ path: `/episodes/${episodeId.value}/timeline`, query: drama ? { drama } : {} })
}

onMounted(() => loadOptions())
onBeforeUnmount(() => { poller.stop(); stopClock() })
</script>

<style scoped>
.export-page { min-height: 100vh; background: var(--bg-page); color: var(--text-primary); }
.header-inner { display: flex; align-items: center; gap: 16px; padding: 12px 24px; }
.logo { margin: 0; font-size: 18px; }
.sub { color: var(--text-subtle); font-size: 13px; }
.btn-back { margin-left: auto; }
.main { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
.panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; }
.panel h2 { margin: 0 0 14px; font-size: 15px; color: var(--text-bright); }
.hint { margin-top: 4px; font-size: 12px; color: var(--text-subtle); line-height: 1.5; width: 100%; }
.opt-reason { margin-left: 12px; font-size: 12px; color: var(--text-subtle); }
.aigc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; }
.producer-label { color: var(--text-muted); }
.aigc-warn { margin: 8px 0; }
.actions { display: flex; gap: 12px; }
.job { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.job-line { display: flex; gap: 16px; align-items: baseline; font-size: 13px; }
.job-stage { color: var(--text-bright); font-weight: 600; }
.job-meta { color: var(--text-subtle); font-size: 12px; }
.done { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.done-path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; color: var(--text-muted); }
</style>
