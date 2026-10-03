<template>
  <el-dialog :model-value="true" :title="t('assets.extract.title')" width="min(480px, 92vw)" append-to-body @closed="emit('close', result)">
    <p class="hint">{{ t('assets.extract.hint') }}</p>
    <p v-if="!episodeId" class="hint warn" data-test="extract-no-episode">{{ t('assets.extract.noEpisode') }}</p>

    <el-checkbox-group v-model="picked" class="kinds" :disabled="running">
      <el-checkbox v-for="k in KINDS" :key="k" :value="k" :data-test="`extract-${k}`">{{ t(`assets.kind.${k}.label`) }}</el-checkbox>
    </el-checkbox-group>

    <ul v-if="Object.keys(state).length" class="states" data-test="extract-states">
      <li v-for="k in KINDS" v-show="state[k]" :key="k" :class="state[k]">
        {{ t('assets.extract.stateLine', { kind: t(`assets.kind.${k}.label`), state: t(`assets.extract.state.${state[k]}`) }) }}
      </li>
    </ul>

    <template #footer>
      <el-button @click="emit('close', result)">{{ t('common.close') }}</el-button>
      <el-button type="primary" :loading="running" :disabled="!episodeId || !picked.length" data-test="extract-run" @click="run">{{ t('assets.extract.run') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onBeforeUnmount, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { propAPI } from '@/api/props'
import { taskAPI } from '@/api/task'
import { KINDS } from '@/utils/assets'
import { taskIdOf, waitForTask } from '@/utils/assetGeneration'
import { useAssetContext } from './assetContext'

// 从剧本提取角色 / 场景 / 道具。这三个都是文本 AI 任务，不走出图开关。
// props.outline 可选：传入当前剧本文本时按它提取（和旧页面一致），不传则由内核读取分集剧本。
const props = defineProps({
  outline: { type: String, default: '' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const { dramaId, episodeId, assets } = useAssetContext()

const picked = ref([...KINDS])
const running = ref(false)
const state = reactive({}) // kind -> running | done | failed
const result = ref(undefined)
let cancelled = false
onBeforeUnmount(() => { cancelled = true })

const CALLS = {
  characters: () => generationAPI.generateCharacters(dramaId.value, { episode_id: episodeId.value, outline: props.outline || undefined }),
  scenes: () => dramaAPI.extractBackgrounds(episodeId.value, {}),
  props: () => propAPI.extractFromScript(episodeId.value),
}

async function extractOne(kind) {
  state[kind] = 'running'
  try {
    const res = await CALLS[kind]()
    const id = taskIdOf(res)
    if (id) {
      const r = await waitForTask(() => taskAPI.get(id), { intervalMs: 2000, maxAttempts: 300, isCancelled: () => cancelled })
      if (r.status !== 'completed') throw new Error(r.error || r.status)
    }
    state[kind] = 'done'
    return true
  } catch (e) {
    state[kind] = 'failed'
    return false
  }
}

async function run() {
  if (!episodeId.value || !picked.value.length || running.value) return
  running.value = true
  for (const k of KINDS) delete state[k]
  const done = []
  try {
    // 逐类提取：三类同时跑会同时占用文本模型
    for (const k of KINDS.filter((x) => picked.value.includes(x))) {
      if (cancelled) break
      if (await extractOne(k)) done.push(k)
    }
    if (done.length) await assets.reload()
    result.value = { extracted: done }
    if (done.length === picked.value.length) ElMessage.success(t('assets.extract.allDone'))
    else if (done.length) ElMessage.warning(t('assets.extract.partial'))
    else ElMessage.error(t('assets.extract.failed'))
  } finally {
    running.value = false
  }
}
</script>

<style scoped>
.hint { margin: 0 0 10px; font-size: 13px; line-height: 1.6; color: var(--text-muted); }
.hint.warn { color: var(--el-color-warning); }
.kinds { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.states { margin: 12px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-primary); }
.states .done { color: var(--el-color-success); }
.states .failed { color: var(--el-color-danger); }
</style>
