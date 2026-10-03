<template>
  <el-dialog
    v-model="visible"
    :title="t('storyboard.params.title', { n: number })"
    width="680px"
    append-to-body
    :close-on-click-modal="false"
    data-test="shot-params-dialog"
    @closed="emit('close', result)"
  >
    <div v-loading="rec.loading.value && !loaded">
      <el-form v-if="shot" label-position="top" class="form" @submit.prevent>
        <div class="grid">
          <el-form-item :label="t('storyboard.params.lighting')">
            <el-select v-model="form.lighting_style" clearable :placeholder="t('storyboard.insp.placeholder.pick')" data-test="param-lighting">
              <el-option v-for="o in LIGHTING" :key="o.value" :label="t(o.key)" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.params.dof')">
            <el-select v-model="form.depth_of_field" clearable :placeholder="t('storyboard.insp.placeholder.pick')" data-test="param-dof">
              <el-option v-for="o in DEPTH_OF_FIELD" :key="o.value" :label="t(o.key)" :value="o.value" />
            </el-select>
          </el-form-item>
        </div>
        <p class="hint">{{ t('storyboard.params.lightingHint') }}</p>

        <div class="grid3">
          <el-form-item :label="t('storyboard.params.angleSize')">
            <el-select v-model="form.angle_s" clearable :placeholder="t('storyboard.insp.placeholder.pick')" data-test="param-angle-s">
              <el-option v-for="o in ANGLE_SIZE" :key="o.value" :label="t(o.key)" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.params.anglePitch')">
            <el-select v-model="form.angle_v" clearable :placeholder="t('storyboard.insp.placeholder.pick')" data-test="param-angle-v">
              <el-option v-for="o in ANGLE_PITCH" :key="o.value" :label="t(o.key)" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.params.angleYaw')">
            <el-select v-model="form.angle_h" clearable :placeholder="t('storyboard.insp.placeholder.pick')" data-test="param-angle-h">
              <el-option v-for="o in ANGLE_YAW" :key="o.value" :label="t(o.key)" :value="o.value" />
            </el-select>
          </el-form-item>
        </div>
        <p v-if="angleText" class="hint" data-test="angle-summary">{{ angleText }}</p>

        <el-form-item :label="t('storyboard.params.layout')">
          <div class="with-btn">
            <el-input v-model="form.layout_description" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :placeholder="t('storyboard.params.layoutPlaceholder')" data-test="param-layout" />
            <el-button size="small" :loading="layoutBusy" data-test="layout-ai" @click="regenLayout">{{ t('storyboard.params.layoutAi') }}</el-button>
          </div>
        </el-form-item>

        <el-form-item :label="t('storyboard.params.atmosphere')">
          <el-input v-model="form.atmosphere" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" data-test="param-atmosphere" />
        </el-form-item>
        <el-form-item :label="t('storyboard.params.action')">
          <el-input v-model="form.action" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" data-test="param-action" />
        </el-form-item>
        <el-form-item :label="t('storyboard.params.result')">
          <el-input v-model="form.result" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" data-test="param-result" />
        </el-form-item>
        <el-form-item :label="t('storyboard.params.dialogue')">
          <el-input v-model="form.dialogue" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('storyboard.params.dialoguePlaceholder')" data-test="param-dialogue" />
        </el-form-item>
        <el-form-item :label="t('storyboard.params.narration')">
          <el-input v-model="form.narration" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" data-test="param-narration" />
        </el-form-item>

        <el-alert v-for="(key, field) in errors" :key="field" type="error" :closable="false" show-icon :title="`${fieldLabel(field)}: ${t(key, { min: DURATION_RANGE.min, max: DURATION_RANGE.max })}`" class="mb" />

        <div class="extras">
          <div class="extra">
            <el-tooltip :disabled="splittable" :content="t('storyboard.params.splitNeed')" placement="top">
              <span>
                <el-button size="small" :disabled="!splittable" :loading="splitting" data-test="split-by-audio" @click="splitAudio">{{ t('storyboard.params.split') }}</el-button>
              </span>
            </el-tooltip>
            <span class="hint">{{ t('storyboard.params.splitHint') }}</span>
          </div>
          <div class="extra">
            <el-button size="small" :disabled="!hasSpeech" :loading="voiceBusy === 'estimate'" data-test="voice-estimate" @click="estimateVoice">{{ t('storyboard.params.voice') }}</el-button>
            <span class="hint">{{ t('storyboard.params.voiceHint') }}</span>
          </div>
          <div v-if="voice" class="voice" data-test="voice-box">
            <template v-if="voice.canConfirm">
              <span>{{ voice.text }}</span>
              <el-button size="small" type="primary" :loading="voiceBusy === 'run'" data-test="voice-confirm" @click="runVoice">{{ t('storyboard.params.voiceConfirm') }}</el-button>
            </template>
            <span v-else :class="{ warn: voice.blocked }">{{ voice.text }}</span>
          </div>
        </div>
      </el-form>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ t('storyboard.common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!shot || !changed" data-test="params-save" @click="save">{{ t('storyboard.common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { useProjectViewsStore } from '@/stores/projectViews'
import { storyboardsAPI } from '@/api/storyboards'
import { voiceoverAPI } from '@/api/voiceover'
import { shotNumbers } from '@/utils/projectViews'
import { useShotRecord } from './useShotRecord.js'
import { diffForm } from './shotInspectorModel.js'
import {
  ANGLE_PITCH, ANGLE_SIZE, ANGLE_YAW, DEPTH_OF_FIELD, DURATION_RANGE, LIGHTING,
  anglePromptKey, canSplitByAudio, validateShotParams,
} from './shotParams.js'

const props = defineProps({
  /** kernel shot node id */
  shotId: { type: String, required: true },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const views = useProjectViewsStore()
const rec = useShotRecord(() => props.shotId)
const { shot } = rec

const visible = ref(true)
let result
const number = computed(() => shotNumbers(views.views.shots)[props.shotId] || '')

const FIELDS = ['lighting_style', 'depth_of_field', 'angle_s', 'angle_v', 'angle_h', 'layout_description', 'atmosphere', 'action', 'result', 'dialogue', 'narration']
const form = reactive(Object.fromEntries(FIELDS.map((f) => [f, ''])))
const loaded = ref(false)

// Fill the form once the legacy row has arrived (it carries the extra columns); later reloads keep the user's edits.
watch(
  () => (rec.row.value ? shot.value : null),
  (s) => {
    if (!s || loaded.value) return
    for (const f of FIELDS) form[f] = s[f] == null ? '' : String(s[f])
    loaded.value = true
  },
  { immediate: true },
)

const patch = computed(() => {
  const s = shot.value
  if (!s || !loaded.value) return {}
  const p = diffForm(form, s)
  const out = {}
  for (const f of FIELDS) if (f in p) out[f] = p[f]
  return out
})
const changed = computed(() => Object.keys(patch.value).length > 0)
const errors = computed(() => validateShotParams(patch.value).errors)
const fieldLabel = (f) => ({
  lighting_style: t('storyboard.params.lighting'), depth_of_field: t('storyboard.params.dof'),
  angle_s: t('storyboard.params.angleSize'), angle_v: t('storyboard.params.anglePitch'), angle_h: t('storyboard.params.angleYaw'),
  layout_description: t('storyboard.params.layout'), atmosphere: t('storyboard.params.atmosphere'), action: t('storyboard.params.action'),
  result: t('storyboard.params.result'), dialogue: t('storyboard.params.dialogue'), narration: t('storyboard.params.narration'),
}[f] || f)
const angleText = computed(() => {
  const k = anglePromptKey({ s: form.angle_s, v: form.angle_v, h: form.angle_h })
  return k ? t('storyboard.params.angleSummary', { size: t(k.size), pitch: t(k.pitch), yaw: t(k.yaw) }) : ''
})

const saving = ref(false)
async function save() {
  if (!changed.value) return true
  const v = validateShotParams(patch.value)
  if (!v.ok) return false
  saving.value = true
  try {
    const r = await rec.save(patch.value)
    if (!r.ok) return false
    result = { saved: true }
    ElMessage.success(t('storyboard.params.saved'))
    visible.value = false
    return true
  } finally {
    saving.value = false
  }
}

const layoutBusy = ref(false)
async function regenLayout() {
  if (rec.legacyId.value == null) return
  layoutBusy.value = true
  try {
    const res = await storyboardsAPI.regenerateLayoutDescription(rec.legacyId.value)
    const text = (res && (res.layout_description || (res.data && res.data.layout_description))) || ''
    if (text) {
      form.layout_description = text
      ElMessage.success(t('storyboard.params.layoutDone'))
    } else {
      ElMessage.warning(t('storyboard.params.layoutEmpty'))
    }
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.params.layoutFailed'))
  } finally {
    layoutBusy.value = false
  }
}

// ---------- split by audio ----------
const splittable = computed(() => canSplitByAudio({ dialogue: form.dialogue, narration: form.narration }))
const splitting = ref(false)
async function splitAudio() {
  if (rec.legacyId.value == null) return
  try {
    await ElMessageBox.confirm(t('storyboard.params.splitConfirm'), t('storyboard.params.split'), {
      type: 'warning', confirmButtonText: t('storyboard.params.splitOk'), cancelButtonText: t('storyboard.common.cancel'),
    })
  } catch (_) { return }
  splitting.value = true
  try {
    if (changed.value) {
      const r = await rec.save(patch.value)
      if (!r.ok) return
    }
    const res = await storyboardsAPI.splitByAudio(rec.legacyId.value)
    const n = (res && res.storyboard_ids && res.storyboard_ids.length) || 0
    await views.refresh()
    result = { split: true, count: n }
    ElMessage.success(res && res.plans_summary ? t('storyboard.params.splitDoneSummary', { n, summary: res.plans_summary }) : t('storyboard.params.splitDone', { n }))
    visible.value = false
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.params.splitFailed'))
  } finally {
    splitting.value = false
  }
}

// ---------- voiceover for this shot (estimate first, then confirm) ----------
const hasSpeech = computed(() => !!(form.dialogue.trim() || form.narration.trim()))
const voice = ref(null)
const voiceBusy = ref('')
function voiceView(e) {
  const est = e || {}
  if (!(est.shots > 0)) return { text: t('storyboard.params.voiceNone'), canConfirm: false, blocked: false }
  if (est.allowed === false) return { text: (est.refusal && est.refusal.message) || t('storyboard.params.voiceBlocked'), canConfirm: false, blocked: true }
  const cur = est.currency || 'CNY'
  return {
    text: t('storyboard.params.voiceEstimate', { chars: est.chars ?? 0, total: `${est.estimate ?? 0} ${cur}`, max: `${est.max ?? 0} ${cur}` }),
    canConfirm: !!est.confirm_required,
    blocked: false,
  }
}
async function estimateVoice() {
  voiceBusy.value = 'estimate'
  voice.value = null
  try {
    await commitBeforeVoice()
    voice.value = voiceView(await voiceoverAPI.run(views.episodeId, { shots: [props.shotId], confirm: false }))
  } catch (_) { /* request.js already reports */ } finally { voiceBusy.value = '' }
}
async function commitBeforeVoice() {
  if (changed.value && validateShotParams(patch.value).ok) await rec.save(patch.value)
}
async function runVoice() {
  voiceBusy.value = 'run'
  try {
    const res = await voiceoverAPI.run(views.episodeId, { shots: [props.shotId], confirm: true })
    const n = ((res && res.tasks) || []).length
    voice.value = null
    ElMessage.success(n ? t('storyboard.params.voiceQueued', { n }) : t('storyboard.params.voiceNone'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.params.voiceFailed'))
  } finally {
    voiceBusy.value = ''
  }
}
</script>

<style scoped>
.form :deep(.el-form-item) { margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.grid :deep(.el-select), .grid3 :deep(.el-select) { width: 100%; }
.with-btn { display: flex; gap: 8px; width: 100%; align-items: flex-start; }
.hint { margin: 0 0 8px; font-size: 12px; color: var(--el-text-color-secondary); }
.warn { color: var(--el-color-danger); }
.mb { margin-bottom: 8px; }
.extras { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.extra { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.extra .hint { margin: 0; }
.voice { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
</style>
