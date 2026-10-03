<template>
  <el-dialog
    v-model="visible"
    :title="t('generate.dialog.title.allVoice')"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    data-test="generate-voice"
    @closed="emit('close', result)"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('generate.voice.voice')">
        <el-select v-model="voice" style="width: 100%" :disabled="submitting" data-test="voice-select" @change="loadEstimate">
          <el-option v-for="v in voices" :key="v.id" :label="v.label" :value="v.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <div v-if="loading" v-loading="true" class="gv-loading" element-loading-background="transparent">{{ t('generate.dialog.loading') }}</div>
    <el-alert v-else-if="loadError" type="error" show-icon :closable="false" :title="t('generate.dialog.loadFailed', { message: loadError })" />
    <template v-else>
      <div v-if="!summary.canConfirm && !summary.blocked" class="gv-empty" data-test="voice-nothing">{{ t('generate.voice.nothing') }}</div>
      <ul v-else class="gv-lines" data-test="voice-lines">
        <li v-for="(l, i) in summary.lines" :key="i">{{ l }}</li>
      </ul>
      <el-alert v-for="(w, i) in summary.warnings" :key="`w${i}`" class="gv-alert" type="warning" show-icon :closable="false" :title="w" />
      <el-alert v-if="summary.blocked" class="gv-alert" type="error" show-icon :closable="false" :title="summary.blockedText" />
      <el-alert v-if="submitError" class="gv-alert" type="error" show-icon :closable="false" :title="submitError" />
    </template>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" :disabled="loading || !!loadError || !summary.canConfirm" data-test="voice-submit" @click="submit">
        {{ t('generate.dialog.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { voiceoverAPI } from '@/api/voiceover'
import { voiceSummary, voiceResultText } from './generateConfirm.js'

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
const voices = ref([])
const voice = ref('')
const estimate = ref(null)
let result
let seq = 0

const summary = computed(() => voiceSummary(estimate.value))

async function loadEstimate() {
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const e = await voiceoverAPI.run(props.episodeId, { all: true, voice: voice.value || undefined, confirm: false })
    if (mine === seq) estimate.value = e
  } catch (err) {
    if (mine === seq) loadError.value = err?.message || String(err)
  } finally {
    if (mine === seq) loading.value = false
  }
}

onMounted(async () => {
  try {
    const r = await voiceoverAPI.voices()
    voices.value = r.voices || []
    voice.value = r.default || voices.value[0]?.id || ''
  } catch (_) {
    voices.value = []
  }
  await loadEstimate()
})

async function submit() {
  if (submitting.value || !summary.value.canConfirm) return
  submitting.value = true
  submitError.value = ''
  try {
    const res = await voiceoverAPI.run(props.episodeId, { all: true, voice: voice.value || undefined, confirm: true })
    ElMessage.success(voiceResultText(res))
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
.gv-loading { min-height: 64px; padding-top: 40px; text-align: center; color: var(--text-subtle); font-size: 13px; }
.gv-empty { color: var(--text-subtle); font-size: 13px; }
.gv-lines { margin: 0 0 8px; padding-left: 20px; line-height: 1.8; font-size: 13px; }
.gv-alert { margin-top: 8px; }
</style>
