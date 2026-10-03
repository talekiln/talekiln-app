<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    data-test="generate-confirm"
    @closed="emit('close', result)"
  >
    <div v-if="loading" v-loading="true" class="gc-loading" element-loading-background="transparent">{{ t('generate.dialog.loading') }}</div>
    <el-alert v-else-if="loadError" type="error" show-icon :closable="false" :title="t('generate.dialog.loadFailed', { message: loadError })" />
    <template v-else>
      <div class="gc-head" data-test="confirm-head">{{ summary.title }}</div>
      <ul class="gc-lines" data-test="confirm-lines">
        <li v-for="(l, i) in summary.lines" :key="i">{{ l }}</li>
      </ul>
      <el-alert v-for="(w, i) in summary.warnings" :key="`w${i}`" class="gc-alert" type="warning" show-icon :closable="false" :title="w" />
      <el-alert v-if="summary.blocked" class="gc-alert" type="error" show-icon :closable="false" :title="summary.blockedText" data-test="confirm-blocked" />
      <el-alert v-if="summary.nothingToDo" class="gc-alert" type="info" show-icon :closable="false" :title="t('generate.dialog.nothingToAdopt')" data-test="confirm-nothing" />
      <el-alert v-if="submitError" class="gc-alert" type="error" show-icon :closable="false" :title="submitError" />
    </template>
    <template #footer>
      <el-button @click="visible = false">{{ !loading && summary.nothingToDo ? t('common.close') : t('common.cancel') }}</el-button>
      <el-button v-if="showConfirm" type="primary" :loading="submitting" :disabled="!summary.canConfirm" data-test="confirm-submit" @click="submit">
        {{ summary.free ? t('generate.dialog.useExisting') : t('generate.dialog.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { episodeGenerationAPI } from '@/api/episodeGeneration'
import { buildGenerateBody } from '@/utils/generationView'
import { kindOf, previewSummary, submittedText } from './generateConfirm.js'

const props = defineProps({
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], required: true },
  action: { type: String, required: true },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const visible = ref(true)
const loading = ref(true)
const loadError = ref('')
const submitError = ref('')
const submitting = ref(false)
const preview = ref(null)
let result

const spec = kindOf(props.action) || { kind: 'both', regenerate: false }
const summary = computed(() => previewSummary(preview.value))
// Nothing to generate and nothing to adopt: the confirm button would be a dead end, so it is not shown at all.
const showConfirm = computed(() => !loading.value && !loadError.value && !summary.value.nothingToDo)
const title = computed(() => t(`generate.dialog.title.${props.action.replace('generate.', '')}`))

onMounted(async () => {
  try {
    preview.value = await episodeGenerationAPI.generate(props.episodeId, buildGenerateBody({ shots: 'all', kind: spec.kind, confirm: false, regenerate: spec.regenerate }))
  } catch (e) {
    loadError.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
})

async function submit() {
  if (submitting.value || !summary.value.canConfirm) return
  submitting.value = true
  submitError.value = ''
  try {
    const res = await episodeGenerationAPI.generate(props.episodeId, buildGenerateBody({ shots: 'all', kind: spec.kind, confirm: true, regenerate: spec.regenerate }))
    ElMessage.success(submittedText(res))
    result = { submitted: true, tasks: (res && res.tasks) || [] }
    visible.value = false
  } catch (e) {
    submitError.value = e?.message || t('generate.dialog.submitFailed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.gc-loading { min-height: 64px; padding-top: 40px; text-align: center; color: var(--text-subtle); font-size: 13px; }
.gc-head { font-weight: 600; margin-bottom: 8px; color: var(--text-bright); }
.gc-lines { margin: 0 0 8px; padding-left: 20px; line-height: 1.8; font-size: 13px; }
.gc-alert { margin-top: 8px; }
</style>
