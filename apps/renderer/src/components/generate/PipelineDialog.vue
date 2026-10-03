<template>
  <el-dialog
    v-model="visible"
    :title="t('generate.pipeline.title')"
    width="640px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    append-to-body
    data-test="generate-pipeline"
    @closed="emit('close', result)"
  >
    <p class="gp-intro">{{ t('generate.pipeline.intro') }}</p>

    <div v-if="stage === 'planning'" v-loading="true" class="gp-loading" element-loading-background="transparent">
      {{ t('generate.dialog.loading') }}
    </div>
    <el-alert v-else-if="planError" type="error" show-icon :closable="false" :title="t('generate.dialog.loadFailed', { message: planError })" />
    <el-alert v-else-if="blockedText" type="error" show-icon :closable="false" :title="blockedText" data-test="pipeline-blocked" />

    <template v-else>
      <div v-if="stage === 'review'" class="gp-options" data-test="pipeline-options">
        <el-checkbox v-model="opts.includeExtract" @change="replan">{{ t('generate.pipeline.opt.extract') }}</el-checkbox>
        <el-checkbox v-model="opts.includeAssetImages" @change="replan">{{ t('generate.pipeline.opt.assetImages') }}</el-checkbox>
        <el-checkbox v-model="opts.includeVoice" @change="replan">{{ t('generate.pipeline.opt.voice') }}</el-checkbox>
        <el-checkbox v-model="opts.pauseBetweenPhases" @change="replan">{{ t('generate.pipeline.opt.pause') }}</el-checkbox>
      </div>

      <ol class="gp-steps" data-test="pipeline-steps">
        <li v-for="row in rows" :key="row.id" class="gp-step" :class="`is-${row.status}`" :data-step="row.id">
          <span class="gp-step-name">{{ row.name }}</span>
          <span v-if="row.billable" class="gp-tag">{{ t('generate.pipeline.billable') }}</span>
          <span class="gp-step-info">{{ row.info }}</span>
        </li>
      </ol>

      <div v-if="estimateInfo.line" class="gp-estimate" data-test="pipeline-estimate">
        <div>{{ estimateInfo.line }}</div>
        <div v-for="(w, i) in estimateInfo.warnings" :key="i" class="gp-warn">{{ w }}</div>
      </div>

      <el-alert v-if="status.text" class="gp-alert" :type="status.type" show-icon :closable="false" :title="status.text" data-test="pipeline-status" />
      <el-alert v-if="state === 'cancelled'" class="gp-alert" type="info" show-icon :closable="false" :title="t('generate.pipeline.cancelNote')" />

      <ul v-if="errorLines.length" class="gp-errors" data-test="pipeline-errors">
        <li v-for="(l, i) in errorLines" :key="i">{{ l }}</li>
      </ul>
    </template>

    <template #footer>
      <template v-if="stage === 'running'">
        <el-button v-if="state === 'running'" :disabled="pauseRequested" data-test="pipeline-pause" @click="pause">
          {{ pauseRequested ? t('generate.pipeline.pausing') : t('generate.pipeline.pause') }}
        </el-button>
        <el-button v-if="state === 'paused'" type="primary" data-test="pipeline-resume" @click="resume">{{ t('generate.pipeline.resume') }}</el-button>
        <el-button type="danger" plain data-test="pipeline-cancel" @click="cancel">{{ t('generate.pipeline.cancel') }}</el-button>
      </template>
      <template v-else>
        <el-button data-test="pipeline-close" @click="visible = false">{{ stage === 'finished' ? t('common.close') : t('common.cancel') }}</el-button>
        <el-button v-if="stage === 'finished' && state !== 'done'" data-test="pipeline-again" @click="replan">{{ t('generate.pipeline.again') }}</el-button>
        <el-button v-if="stage === 'review'" type="primary" :disabled="!canStart" data-test="pipeline-start" @click="start">
          {{ hasBillable ? t('generate.pipeline.startPaid') : t('generate.pipeline.start') }}
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { useI18n } from '@/i18n'
import { createPipelineRunner, createDefaultDeps } from '@/composables/usePipeline'
import { formatMoney } from '@/utils/spendView'
import { pipelineRows, pipelineEstimate, pipelineErrorLines, pipelineStatus } from './pipelineView.js'

const props = defineProps({
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], required: true },
  artStyle: { type: String, default: '' }, // 不能叫 style：会和 class/style 透传冲突
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const visible = ref(true)
const stage = ref('planning') // planning | review | running | finished
const planError = ref('')
const pauseRequested = ref(false)
const opts = reactive({ includeExtract: true, includeAssetImages: true, includeVoice: false, pauseBetweenPhases: false })
const snap = shallowRef(null)
const plan = shallowRef(null)
const estimate = shallowRef(null)
let result
let runner = null
let off = null
let seq = 0
const deps = createDefaultDeps({ episodeId: props.episodeId, dramaId: props.dramaId, style: props.artStyle })

const state = computed(() => (snap.value ? snap.value.state : 'idle'))
const busy = computed(() => stage.value === 'running')

function makeRunner() {
  if (off) off()
  runner = createPipelineRunner(deps, { ...opts })
  off = runner.subscribe((s) => {
    snap.value = s
    if (stage.value === 'running' && ['done', 'failed', 'cancelled'].includes(s.state)) {
      stage.value = 'finished'
      result = { state: s.state }
    }
    if (s.state !== 'running') pauseRequested.value = false
  })
}

async function replan() {
  const mine = ++seq
  stage.value = 'planning'
  planError.value = ''
  makeRunner()
  try {
    const p = await runner.plan()
    if (mine !== seq) return
    plan.value = p.plan
    estimate.value = p.estimate
    snap.value = runner.getSnapshot()
    stage.value = 'review'
  } catch (e) {
    if (mine !== seq) return
    planError.value = e?.message || String(e)
  }
}
replan()

onBeforeUnmount(() => {
  seq += 1
  if (off) off()
  if (runner && (state.value === 'running' || state.value === 'paused')) runner.cancel()
})

const rows = computed(() => pipelineRows(snap.value, plan.value, t))
const hasBillable = computed(() => !!(plan.value && plan.value.runnable.some((s) => s.billable)))
const blockedText = computed(() => {
  if (stage.value === 'running' || stage.value === 'finished') return ''
  if (plan.value && plan.value.blocked) return t(`generate.pipeline.blocked.${plan.value.blocked}`)
  return ''
})
const canStart = computed(() => {
  const p = plan.value
  if (!p || p.blocked || !p.runnable.length) return false
  const e = estimate.value
  return !(e && (e.allowed === false || e.providerReady === false))
})
const estimateInfo = computed(() => pipelineEstimate(estimate.value, plan.value, t, formatMoney))
const errorLines = computed(() => pipelineErrorLines(snap.value, t))
const status = computed(() => pipelineStatus(snap.value, stage.value, t))

async function start() {
  if (!canStart.value) return
  stage.value = 'running'
  try {
    await runner.run({ confirmed: true })
  } catch (e) {
    planError.value = e?.message || String(e)
    stage.value = 'review'
  }
}
function pause() {
  pauseRequested.value = true
  runner.pause()
}
function resume() {
  pauseRequested.value = false
  runner.resume()
}
function cancel() {
  runner.cancel()
}
</script>

<style scoped>
.gp-intro { margin: 0 0 12px; font-size: 13px; color: var(--text-subtle); }
.gp-loading { min-height: 80px; padding-top: 48px; text-align: center; color: var(--text-subtle); font-size: 13px; }
.gp-options { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 8px; }
.gp-steps { margin: 0; padding: 0; list-style: none; border: 1px solid var(--el-border-color-lighter, #ebeef5); border-radius: 6px; }
.gp-step { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 13px; border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5); }
.gp-step:last-child { border-bottom: 0; }
.gp-step-name { flex: 0 0 auto; min-width: 120px; }
.gp-step-info { margin-left: auto; color: var(--text-subtle); text-align: right; }
.gp-step.is-skipped { color: var(--text-subtle); }
.gp-step.is-running .gp-step-info { color: var(--el-color-primary, #409eff); }
.gp-step.is-done .gp-step-info { color: var(--el-color-success, #67c23a); }
.gp-step.is-failed .gp-step-info { color: var(--el-color-danger, #f56c6c); }
.gp-tag { padding: 0 6px; border-radius: 8px; font-size: 11px; line-height: 18px; color: var(--el-color-warning, #e6a23c); border: 1px solid currentColor; }
.gp-estimate { margin-top: 10px; font-size: 13px; line-height: 1.7; }
.gp-warn { color: var(--el-color-warning, #e6a23c); font-size: 12px; }
.gp-alert { margin-top: 10px; }
.gp-errors { margin: 8px 0 0; padding-left: 20px; font-size: 12px; line-height: 1.7; color: var(--el-color-danger, #f56c6c); max-height: 140px; overflow: auto; }
</style>
