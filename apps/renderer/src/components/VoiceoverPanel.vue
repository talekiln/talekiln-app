<template>
  <div class="voiceover-panel">
    <p class="hint">用 CosyVoice 给有台词的镜头生成旁白。台词来自剧本行；改了台词，旁白会变成“过期”，需要重新生成。</p>
    <div class="field">
      <label>音色</label>
      <el-select v-model="voice" size="small" data-test="voice-select" style="width: 220px">
        <el-option v-for="o in options" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </div>
    <div class="field">
      <label>范围</label>
      <el-radio-group v-model="scope" size="small">
        <el-radio-button value="missing">仅缺少或过期的</el-radio-button>
        <el-radio-button value="redo">全部重做</el-radio-button>
      </el-radio-group>
    </div>
    <div class="actions">
      <el-button size="small" :loading="busy === 'estimate'" data-test="voiceover-estimate" @click="estimate">估价</el-button>
    </div>

    <div v-if="est" class="estimate" data-test="voiceover-estimate-text">
      <template v-if="needsConfirm(est)">
        <p>{{ estimateText(est) }}</p>
        <p v-if="!est.allowed" class="warn">{{ est.message }}</p>
        <el-button type="primary" size="small" :disabled="!est.allowed" :loading="busy === 'run'" data-test="voiceover-confirm" @click="confirm">
          确认并生成
        </el-button>
      </template>
      <p v-else>没有需要生成的镜头（都已有最新旁白，或没有台词）。</p>
    </div>
    <p v-if="result" class="result" data-test="voiceover-result">{{ resultText(result) }}</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { voiceoverAPI } from '@/api/voiceover'
import { estimateText, needsConfirm, resultText, voiceOptions } from '@/utils/voiceover'

const props = defineProps({ episodeId: { type: Number, required: true } })
const emit = defineEmits(['done'])

const voices = ref([])
const voice = ref('')
const scope = ref('missing')
const est = ref(null)
const result = ref(null)
const busy = ref('')
const options = computed(() => voiceOptions(voices.value))

const body = () => ({ voice: voice.value || undefined, ...(scope.value === 'redo' ? { all: true, force: true } : { all: true }) })

onMounted(async () => {
  try {
    const r = await voiceoverAPI.voices()
    voices.value = r.voices || []
    voice.value = r.default || voices.value[0]?.id || ''
  } catch (_) { /* 提示由 request 拦截器给出 */ }
})

async function estimate() {
  busy.value = 'estimate'
  result.value = null
  try { est.value = await voiceoverAPI.run(props.episodeId, body()) } catch (_) { est.value = null } finally { busy.value = '' }
}

async function confirm() {
  busy.value = 'run'
  try {
    result.value = await voiceoverAPI.run(props.episodeId, { ...body(), confirm: true })
    est.value = null
    if ((result.value.done || []).length) emit('done')
  } catch (e) {
    ElMessage.error(e.message || '配音失败')
  } finally { busy.value = '' }
}
</script>

<style scoped>
.field { display: flex; align-items: center; gap: 12px; margin: 12px 0; }
.field label { width: 48px; color: var(--el-text-color-secondary); }
.hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.estimate, .result { margin-top: 12px; font-size: 13px; }
.warn { color: var(--el-color-danger); }
</style>
