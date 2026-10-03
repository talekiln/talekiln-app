<template>
  <el-dialog
    v-model="visible"
    :title="t('generate.dialog.title.rerunDraft')"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    data-test="generate-rerun"
    @closed="emit('close', result)"
  >
    <div v-if="loading" v-loading="true" class="gr-loading" element-loading-background="transparent">{{ t('generate.dialog.loading') }}</div>
    <el-alert v-else-if="loadError" type="error" show-icon :closable="false" :title="t('generate.dialog.loadFailed', { message: loadError })" />
    <template v-else>
      <div v-if="!summary.canConfirm && !summary.blocked" class="gr-empty" data-test="rerun-nothing">{{ t('generate.rerun.nothing') }}</div>
      <ul v-else class="gr-lines" data-test="rerun-lines">
        <li v-for="(l, i) in summary.lines" :key="i">{{ l }}</li>
      </ul>
      <el-alert v-if="summary.canConfirm" class="gr-alert" type="info" show-icon :closable="false" :title="t('generate.rerun.keepNote')" />
      <el-alert v-if="summary.blocked" class="gr-alert" type="error" show-icon :closable="false" :title="summary.blockedText" />
      <el-alert v-if="submitError" class="gr-alert" type="error" show-icon :closable="false" :title="submitError" />
    </template>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" :disabled="loading || !!loadError || !summary.canConfirm" data-test="rerun-submit" @click="submit">
        {{ t('generate.dialog.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { qualityAPI } from './generateApi.js'
import { rerunSummary } from './generateConfirm.js'

const props = defineProps({
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], required: true },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const visible = ref(true)
const loading = ref(true)
const loadError = ref('')
const submitError = ref('')
const submitting = ref(false)
const info = ref(null)
let result

const summary = computed(() => rerunSummary(info.value))

onMounted(async () => {
  try {
    info.value = await qualityAPI.draftNodes(props.episodeId)
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
    const res = await qualityAPI.rerun(props.episodeId)
    ElMessage.success(t('generate.rerun.submitted', { n: (res && res.count) ?? summary.value.lines.length }))
    result = { submitted: true }
    visible.value = false
  } catch (e) {
    submitError.value = e?.message || t('generate.dialog.submitFailed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.gr-loading { min-height: 64px; padding-top: 40px; text-align: center; color: var(--text-subtle); font-size: 13px; }
.gr-empty { color: var(--text-subtle); font-size: 13px; }
.gr-lines { margin: 0 0 8px; padding-left: 20px; line-height: 1.8; font-size: 13px; }
.gr-alert { margin-top: 8px; }
</style>
