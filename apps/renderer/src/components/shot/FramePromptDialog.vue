<template>
  <el-dialog
    v-model="visible"
    :title="t(`storyboard.fp.title.${frame}`)"
    width="560px"
    append-to-body
    :close-on-click-modal="false"
    data-test="frame-prompt-dialog"
    @closed="emit('close', saved)"
  >
    <div v-loading="loading || generating">
      <p class="tip">{{ t('storyboard.fp.tip') }}</p>
      <el-input v-model="text" type="textarea" :rows="8" :placeholder="t('storyboard.fp.placeholder')" data-test="frame-prompt-text" />
    </div>
    <template #footer>
      <el-button :loading="generating" :disabled="saving" @click="regenerate">{{ t('storyboard.fp.regenerate') }}</el-button>
      <span class="spacer" />
      <el-button @click="visible = false">{{ t('storyboard.common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="generating" @click="save">{{ t('storyboard.common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { storyboardsAPI } from '@/api/storyboards'
import { taskAPI } from '@/api/task'
import { frameTypeOf, pollTaskResult, promptFromList, promptFromTask } from './framePrompt.js'

const props = defineProps({
  legacyId: { type: Number, required: true },
  frame: { type: String, default: 'first' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const visible = ref(true)
let saved = false
const text = ref('')
const loading = ref(false)
const generating = ref(false)
const saving = ref(false)
const frameType = frameTypeOf(props.frame)

async function loadCached() {
  loading.value = true
  try {
    text.value = promptFromList(await storyboardsAPI.getFramePrompts(props.legacyId), frameType)
  } catch (_) {
    /* request.js already reports */
  } finally {
    loading.value = false
  }
}

// The professional frame prompt is written by a text model in a background task: start it, then poll for the result.
async function regenerate() {
  generating.value = true
  try {
    const res = await storyboardsAPI.generateFramePrompt(props.legacyId, { frame_type: frameType })
    if (!res || !res.task_id) throw new Error(t('storyboard.fp.noTask'))
    const out = await pollTaskResult({ get: (id) => taskAPI.get(id), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, res.task_id)
    if (!out.ok) throw new Error(out.error || t('storyboard.fp.failed'))
    const prompt = promptFromTask(out.task) || promptFromList(await storyboardsAPI.getFramePrompts(props.legacyId), frameType)
    if (prompt) text.value = prompt
    else ElMessage.warning(t('storyboard.fp.empty'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.fp.failed'))
  } finally {
    generating.value = false
  }
}

async function save() {
  const prompt = text.value.trim()
  if (!prompt) {
    ElMessage.warning(t('storyboard.fp.required'))
    return
  }
  saving.value = true
  try {
    await storyboardsAPI.saveFramePrompt(props.legacyId, frameType, { prompt })
    ElMessage.success(t('storyboard.fp.saved'))
    saved = true
    visible.value = false
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.fp.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(loadCached)
</script>

<style scoped>
.tip { margin: 0 0 8px; font-size: 12px; color: var(--el-text-color-secondary); }
.spacer { display: inline-block; width: 16px; }
</style>
