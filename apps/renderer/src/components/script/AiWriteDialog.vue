<template>
  <el-dialog
    v-model="visible"
    :title="t('script.ai.title')"
    width="620px"
    :close-on-click-modal="false"
    :close-on-press-escape="!running"
    append-to-body
    class="ai-write-dialog"
    @closed="onClosed"
  >
    <el-form label-position="top" @submit.prevent="run">
      <el-form-item :label="t('script.ai.premise')" required>
        <el-input
          v-model="form.premise"
          type="textarea"
          :rows="5"
          :disabled="running"
          :placeholder="t('script.ai.premisePh')"
          data-test="ai-premise"
        />
      </el-form-item>
      <div class="grid">
        <el-form-item :label="t('script.settings.storyStyle')">
          <el-select v-model="form.storyStyle" clearable :disabled="running" :placeholder="t('script.settings.none')" data-test="ai-story-style">
            <el-option v-for="s in STORY_STYLES" :key="s" :label="t(`script.storyStyle.${s}`)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.genre')">
          <el-select v-model="form.storyType" clearable :disabled="running" :placeholder="t('script.settings.none')" data-test="ai-story-type">
            <el-option v-for="g in STORY_TYPES" :key="g" :label="t(`script.storyType.${g}`)" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.ai.episodeCount')">
          <el-input-number v-model="form.episodeCount" :min="1" :max="STORY_EPISODE_MAX" :step="1" :precision="0" :disabled="running" data-test="ai-count" />
        </el-form-item>
        <el-form-item :label="t('script.settings.language')">
          <el-select v-model="form.language" :disabled="running" data-test="ai-language">
            <el-option :label="t('script.lang.zh')" value="zh" />
            <el-option :label="t('script.lang.en')" value="en" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item :label="t('script.ai.target')">
        <el-radio-group v-model="target" :disabled="running" data-test="ai-target">
          <el-radio value="append">{{ t('script.ai.target.append') }}</el-radio>
          <el-radio value="current" :disabled="!canReplace">{{ t('script.ai.target.current') }}</el-radio>
        </el-radio-group>
        <div v-if="currentHasShots" class="hint warn">{{ t('script.ai.currentBlocked') }}</div>
        <div v-else-if="!episodeId" class="hint">{{ t('script.ai.noCurrent') }}</div>
        <div v-else class="hint">{{ t('script.ai.targetHint') }}</div>
      </el-form-item>
    </el-form>
    <el-alert v-if="running" :title="t('script.ai.running')" type="info" show-icon :closable="false" data-test="ai-running" />
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" data-test="ai-error" />
    <template #footer>
      <el-button v-if="running" @click="cancelRun">{{ t('script.ai.stop') }}</el-button>
      <el-button v-else @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="running" :disabled="!form.premise.trim()" data-test="ai-run" @click="run">{{ t('script.ai.run') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { episodesAPI, kernelShotCount, scriptAPI, scriptSync } from '@/api/episodes'
import { STORY_EPISODE_MAX, buildStoryRequest, storyResultToEpisodes } from '@/utils/scriptTools'
import { errorText as opError, gotoEpisode } from './episodeOps'

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], default: null },
  premise: { type: String, default: '' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()

const STORY_STYLES = ['modern', 'ancient', 'fantasy', 'daily']
const STORY_TYPES = ['drama', 'comedy', 'adventure']

const visible = ref(true)
const running = ref(false)
const errorText = ref('')
const currentHasShots = ref(false)
const target = ref('append')
let result
let controller = null

const meta = computed(() => shell.drama?.metadata || {})
const form = reactive({
  premise: props.premise || '',
  storyStyle: '',
  storyType: '',
  episodeCount: 1,
  language: 'zh',
})

onMounted(async () => {
  form.storyStyle = meta.value.story_style || ''
  form.storyType = shell.drama?.genre || ''
  form.language = meta.value.script_language === 'en' ? 'en' : 'zh'
  // 当前集还是空白时，默认写进当前集（新建项目后的第一次写剧本）
  const cur = (shell.episodes || []).find((e) => Number(e.id) === Number(props.episodeId))
  if (props.episodeId) currentHasShots.value = (await kernelShotCount(props.episodeId)) > 0
  if (cur && !String(cur.script_content || '').trim() && !currentHasShots.value) target.value = 'current'
})

const canReplace = computed(() => !!props.episodeId && !currentHasShots.value)
watch(canReplace, (v) => { if (!v && target.value === 'current') target.value = 'append' })

function cancelRun() {
  if (controller) controller.abort()
}
onBeforeUnmount(cancelRun)

function onClosed() {
  emit('close', result)
}

function isAbort(e) {
  return e?.name === 'CanceledError' || e?.name === 'AbortError' || e?.code === 'ERR_CANCELED'
}

async function run() {
  if (running.value || !form.premise.trim()) return
  const style = shell.drama?.style || ''
  const req = buildStoryRequest({
    premise: form.premise,
    storyStyle: form.storyStyle,
    storyType: form.storyType,
    episodeCount: form.episodeCount,
    title: shell.drama?.title || '',
    generationStyle: style,
    customStylePrompt: style === 'custom' ? meta.value.style_prompt_zh || meta.value.style_prompt_en || '' : '',
    aspectRatio: meta.value.aspect_ratio || '16:9',
    language: form.language,
  })
  if (!req.ok) {
    errorText.value = t(`script.ai.err.${req.error}`)
    return
  }
  running.value = true
  errorText.value = ''
  controller = new AbortController()
  try {
    const res = await scriptAPI.generateStory(req.body, { signal: controller.signal })
    const eps = storyResultToEpisodes(res)
    if (!eps.length) {
      errorText.value = t('script.ai.err.empty')
      return
    }
    let first = null
    let rest = eps
    if (target.value === 'current' && canReplace.value) {
      const head = eps[0]
      rest = eps.slice(1)
      const cur = (shell.episodes || []).find((e) => Number(e.id) === Number(props.episodeId))
      const patch = { script_content: head.script_content }
      if (head.title && !(cur && cur.title)) patch.title = head.title
      await episodesAPI.setContent(props.dramaId, props.episodeId, patch)
      const sync = await scriptSync.replaceGraphLines(props.episodeId, head.script_content, 'AI write script')
      if (sync === 'replaced' && Number(views.episodeId) === Number(props.episodeId)) await views.refresh()
      first = { id: Number(props.episodeId) }
    }
    let added = []
    if (rest.length) {
      const r = await episodesAPI.append(props.dramaId, rest)
      added = r.added
    }
    await shell.loadProject(props.dramaId)
    ElMessage.success(t('script.ai.done', { n: eps.length }))
    result = { episodes: eps.length, added: added.map((e) => e.id), replaced: first ? first.id : null }
    visible.value = false
    if (!first && added[0]) gotoEpisode(router, props.dramaId, added[0].id)
  } catch (e) {
    if (isAbort(e)) errorText.value = t('script.ai.stopped')
    else errorText.value = opError(e)
  } finally {
    running.value = false
    controller = null
  }
}
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; width: 100%; }
.hint.warn { color: var(--el-color-warning); }
.err { margin-top: 10px; }
</style>
