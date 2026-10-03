<template>
  <el-dialog
    v-model="visible"
    :title="t('script.import.title')"
    width="780px"
    :close-on-click-modal="false"
    append-to-body
    class="import-script-dialog"
    @closed="emit('close', result)"
  >
    <el-tabs v-model="tab" data-test="import-tabs">
      <el-tab-pane :label="t('script.import.tabText')" name="text">
        <div class="source-bar">
          <input ref="fileInput" type="file" accept=".txt,.md,.text,text/plain" class="hidden" data-test="import-file" @change="onFile" />
          <el-button size="small" @click="fileInput && fileInput.click()">{{ t('script.import.upload') }}</el-button>
          <span v-if="fileName" class="file-name">{{ t('script.import.fileLoaded', { name: fileName, n: text.length }) }}</span>
          <el-button v-if="text" size="small" text type="danger" @click="clearText">{{ t('script.import.clear') }}</el-button>
        </div>
        <el-input
          v-model="text"
          type="textarea"
          :rows="8"
          :placeholder="t('script.import.pastePh')"
          data-test="import-text"
        />

        <el-form label-position="top" class="opts">
          <el-form-item :label="t('script.import.mode')">
            <el-radio-group v-model="mode" data-test="import-mode">
              <el-radio-button value="single">{{ t('script.import.mode.single') }}</el-radio-button>
              <el-radio-button value="marker">{{ t('script.import.mode.marker') }}</el-radio-button>
              <el-radio-button value="chapter">{{ t('script.import.mode.chapter') }}</el-radio-button>
              <el-radio-button value="size">{{ t('script.import.mode.size') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <div v-if="mode === 'chapter'" class="row">
            <el-form-item :label="t('script.import.perEpisode')" class="narrow">
              <el-input-number v-model="perEpisode" :min="1" :max="100" size="small" data-test="import-per-episode" />
            </el-form-item>
            <el-form-item :label="t('script.import.pattern')" class="grow">
              <el-input v-model="pattern" size="small" spellcheck="false" data-test="import-pattern" />
              <el-button size="small" text @click="pattern = DEFAULT_CHAPTER_PATTERN">{{ t('script.import.patternReset') }}</el-button>
            </el-form-item>
          </div>
          <div v-if="mode === 'size'" class="row">
            <el-form-item :label="t('script.import.sizePer')" class="narrow">
              <el-input-number v-model="sizePer" :min="200" :max="50000" :step="500" size="small" data-test="import-size" />
            </el-form-item>
          </div>
          <el-form-item v-if="mode === 'chapter'">
            <el-checkbox v-model="aiSummarize" data-test="import-ai-summarize">{{ t('script.import.aiSummarize') }}</el-checkbox>
            <el-input-number v-if="aiSummarize" v-model="maxChapters" :min="1" :max="20" size="small" class="max-ch" />
            <div v-if="aiSummarize" class="hint">{{ t('script.import.aiSummarizeHint', { n: maxChapters }) }}</div>
          </el-form-item>

          <el-form-item :label="t('script.import.target')">
            <el-radio-group v-model="targetChoice" data-test="import-target">
              <el-radio value="append">{{ t('script.import.target.append') }}</el-radio>
              <el-radio value="current" :disabled="!canReplace">{{ t('script.import.target.current') }}</el-radio>
            </el-radio-group>
            <div v-if="mode !== 'single'" class="hint">{{ t('script.import.currentOnlySingle') }}</div>
            <div v-else-if="currentHasShots" class="hint warn">{{ t('script.import.currentBlocked') }}</div>
          </el-form-item>
        </el-form>

        <div class="preview" data-test="import-preview">
          <div class="preview-head">
            <strong>{{ t('script.import.preview') }}</strong>
            <span v-if="previewRows.length" class="muted">{{ t('script.import.previewCount', { n: previewRows.length }) }}</span>
          </div>
          <el-alert v-if="errorKey" :title="t(errorKey)" type="warning" :closable="false" show-icon />
          <div v-else-if="aiSummarize && mode === 'chapter'" class="muted">{{ t('script.import.previewAi') }}</div>
          <div v-else-if="!previewRows.length" class="muted">{{ t('script.import.previewEmpty') }}</div>
          <ul v-else class="rows">
            <li v-for="r in shownRows" :key="r.episode_number">
              <span class="no">{{ r.episode_number }}</span>
              <span class="ttl">{{ r.title || t('script.episode.untitled') }}</span>
              <span class="cnt">{{ t('script.import.chars', { n: r.script_content.length }) }}</span>
            </li>
            <li v-if="previewRows.length > shownRows.length" class="more">{{ t('script.import.more', { n: previewRows.length - shownRows.length }) }}</li>
          </ul>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="t('script.import.tabLibrary')" name="library">
        <div v-loading="libLoading" class="library">
          <div v-if="!libLoading && !templates.length" class="muted">{{ t('script.import.libraryEmpty') }}</div>
          <ul v-else class="lib-list">
            <li v-for="d in templates" :key="d.id" data-test="import-template">
              <div class="lib-main">
                <strong>{{ d.title || t('shell.project.untitled') }}</strong>
                <span class="muted">{{ t('script.import.libraryEpisodes', { n: (d.episodes || []).length || d.episode_count || 0 }) }}</span>
              </div>
              <el-button size="small" :loading="busyId === d.id" :disabled="!!busyId" @click="importTemplate(d)">{{ t('script.import.libraryImport') }}</el-button>
            </li>
          </ul>
          <div class="hint">{{ t('script.import.libraryNote') }}</div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" />

    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button
        v-if="tab === 'text'"
        type="primary"
        :loading="running"
        :disabled="!canRun"
        data-test="import-run"
        @click="run"
      >{{ runLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { dramaAPI } from '@/api/drama'
import { episodesAPI, kernelShotCount, scriptAPI, scriptSync } from '@/api/episodes'
import { DEFAULT_CHAPTER_PATTERN, nextEpisodeNumber, splitNovelIntoEpisodes } from '@/utils/scriptTools'
import { errorText as opError, gotoEpisode } from './episodeOps'

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], default: null },
  tab: { type: String, default: 'text' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()

const visible = ref(true)
let result

const tab = ref(props.tab === 'library' ? 'library' : 'text')
const text = ref('')
const fileName = ref('')
const fileBlob = ref(null)
const fileInput = ref(null)
const mode = ref('chapter')
const perEpisode = ref(1)
const pattern = ref(DEFAULT_CHAPTER_PATTERN)
const sizePer = ref(3000)
const aiSummarize = ref(false)
const maxChapters = ref(10)
const targetChoice = ref('append')
const running = ref(false)
const errorText = ref('')
const currentHasShots = ref(false)
const existing = ref([])

onMounted(async () => {
  try { existing.value = await episodesAPI.list(props.dramaId) } catch (_) { /* 预览编号退化为从 1 起 */ }
  if (props.episodeId) currentHasShots.value = (await kernelShotCount(props.episodeId)) > 0
  if (tab.value === 'library') loadTemplates()
})

const canReplace = computed(() => !!props.episodeId && mode.value === 'single' && !currentHasShots.value)
watch([mode, currentHasShots], () => { if (!canReplace.value && targetChoice.value === 'current') targetChoice.value = 'append' })

const startNumber = computed(() => nextEpisodeNumber(existing.value))

const split = computed(() => {
  const t0 = text.value
  if (!String(t0).trim()) return { episodes: [], error: null, empty: true }
  if (mode.value === 'single') {
    return { episodes: [{ episode_number: startNumber.value, title: '', script_content: String(t0).replace(/\r\n?/g, '\n').trim() }], error: null }
  }
  return splitNovelIntoEpisodes(t0, {
    by: mode.value,
    pattern: pattern.value,
    chaptersPerEpisode: perEpisode.value,
    size: sizePer.value,
    startNumber: startNumber.value,
  })
})
const previewRows = computed(() => split.value.episodes)
const shownRows = computed(() => previewRows.value.slice(0, 60))
const errorKey = computed(() => {
  const e = split.value.error
  if (!e || e === 'empty') return ''
  return `script.import.err.${e}`
})

const useServer = computed(() => aiSummarize.value && mode.value === 'chapter')
const canRun = computed(() => !!String(text.value).trim() && !running.value && (useServer.value || (previewRows.value.length > 0 && !errorKey.value)))
const runLabel = computed(() => {
  if (targetChoice.value === 'current') return t('script.import.runCurrent')
  return useServer.value ? t('script.import.runAi') : t('script.import.run', { n: previewRows.value.length })
})

function onFile(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    text.value = String(reader.result || '')
    fileName.value = f.name
    fileBlob.value = f
  }
  reader.onerror = () => { errorText.value = t('script.import.readFailed') }
  reader.readAsText(f, 'utf-8')
  e.target.value = ''
}
function clearText() {
  text.value = ''
  fileName.value = ''
  fileBlob.value = null
}

async function finish(added, message) {
  await shell.loadProject(props.dramaId)
  ElMessage.success(message)
  result = { added: added.map((e) => e.id) }
  const first = added[0]
  visible.value = false
  if (first) gotoEpisode(router, props.dramaId, first.id)
}

async function run() {
  if (!canRun.value) return
  running.value = true
  errorText.value = ''
  try {
    if (targetChoice.value === 'current') {
      const body = previewRows.value[0].script_content
      await episodesAPI.setContent(props.dramaId, props.episodeId, { script_content: body })
      const sync = await scriptSync.replaceGraphLines(props.episodeId, body, 'import script')
      if (views.episodeId === Number(props.episodeId) && sync === 'replaced') await views.refresh()
      await shell.loadProject(props.dramaId)
      ElMessage.success(t('script.import.doneCurrent'))
      result = { replaced: props.episodeId }
      visible.value = false
      return
    }
    let rows = previewRows.value
    if (useServer.value) {
      const chapters = await scriptAPI.importNovel({
        text: text.value, fileBlob: fileBlob.value, fileName: fileName.value, title: shell.drama?.title || '', maxChapters: maxChapters.value, aiSummarize: true,
      })
      if (!chapters.length) { errorText.value = t('script.import.err.no_match'); return }
      rows = chapters.map((ch, i) => ({
        title: String(ch.title || '').trim() || t('script.episode.defaultTitle', { n: startNumber.value + i }),
        script_content: String(ch.script ?? ch.content ?? '').trimEnd(),
      }))
    }
    const r = await episodesAPI.append(props.dramaId, rows.map((x) => ({ title: x.title, script_content: x.script_content })))
    await finish(r.added, t('script.import.done', { n: r.added.length }))
  } catch (e) {
    errorText.value = opError(e)
  } finally {
    running.value = false
  }
}

// ---- 剧本库 ----
const templates = ref([])
const libLoading = ref(false)
const busyId = ref(null)
let libLoaded = false
async function loadTemplates() {
  if (libLoaded) return
  libLoaded = true
  libLoading.value = true
  try { templates.value = await scriptAPI.listTemplates() } catch (_) { templates.value = [] } finally { libLoading.value = false }
}
watch(tab, (v) => { if (v === 'library') loadTemplates() })

async function importTemplate(d) {
  if (busyId.value) return
  if (Number(d.id) === Number(props.dramaId)) { ElMessage.info(t('script.import.librarySame')); return }
  try {
    await ElMessageBox.confirm(t('script.import.libraryConfirm', { name: d.title || '' }), t('script.import.libraryImport'), {
      type: 'warning', confirmButtonText: t('script.import.libraryImport'), cancelButtonText: t('common.cancel'),
    })
  } catch (_) { return }
  busyId.value = d.id
  errorText.value = ''
  try {
    const src = await dramaAPI.get(d.id)
    const eps = [...(src.episodes || [])].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    const rows = eps.filter((e) => String(e.script_content || '').trim() || e.title).map((e) => ({ title: e.title || '', script_content: e.script_content || '' }))
    const summary = String(src.description || '').trim()
    if (!rows.length && !summary) { ElMessage.warning(t('script.import.libraryNothing')); return }
    // 梗概：项目还没有梗概时才写入，不覆盖已有的
    if (summary && !String(shell.drama?.description || '').trim()) await dramaAPI.saveOutline(props.dramaId, { summary }).catch(() => {})
    const r = await episodesAPI.append(props.dramaId, rows)
    await finish(r.added, t('script.import.done', { n: r.added.length }))
  } catch (e) {
    errorText.value = opError(e)
  } finally {
    busyId.value = null
  }
}
</script>

<style scoped>
.hidden { display: none; }
.source-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.file-name, .muted, .hint { color: var(--el-text-color-secondary); font-size: 12px; }
.hint.warn { color: var(--el-color-warning); }
.opts { margin-top: 12px; }
.row { display: flex; gap: 16px; align-items: flex-start; }
.row .narrow { flex: none; }
.row .grow { flex: 1; min-width: 0; }
.max-ch { margin-left: 12px; }
.preview { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 10px 12px; }
.preview-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 6px; }
.rows { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; }
.rows li { display: flex; gap: 10px; padding: 3px 0; font-size: 13px; }
.rows .no { width: 32px; color: var(--el-text-color-secondary); }
.rows .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows .cnt, .rows .more { color: var(--el-text-color-secondary); font-size: 12px; }
.lib-list { list-style: none; margin: 0 0 8px; padding: 0; max-height: 320px; overflow: auto; }
.lib-list li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid var(--el-border-color-extra-light); }
.lib-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.library { min-height: 120px; }
.err { margin-top: 10px; }
</style>
