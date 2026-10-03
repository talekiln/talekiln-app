<template>
  <el-dialog
    v-model="visible"
    :title="t('home.importScript.title')"
    width="640px"
    :close-on-click-modal="false"
    append-to-body
    @closed="emit('close', result)"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('home.field.title')" required>
        <el-input v-model="form.title" maxlength="100" show-word-limit :placeholder="t('home.field.titlePh')" data-test="script-title" />
      </el-form-item>

      <el-form-item :label="t('home.importScript.text')" required>
        <div class="file-row">
          <el-button size="small" @click="fileInput?.click()">{{ t('home.importScript.chooseFile') }}</el-button>
          <span class="hint">{{ fileName || t('home.importScript.fileHint') }}</span>
          <input ref="fileInput" type="file" accept=".txt,.md,.markdown,text/plain" class="hidden" data-test="script-file" @change="onFile" />
        </div>
        <el-input v-model="form.text" type="textarea" :rows="8" :placeholder="t('home.importScript.textPh')" data-test="script-text" />
      </el-form-item>

      <div class="row">
        <el-form-item :label="t('home.importScript.split')">
          <el-select v-model="form.preset" style="width: 220px" data-test="script-preset">
            <el-option v-for="k in PRESETS" :key="k" :label="t(`home.importScript.preset.${k}`)" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('home.importScript.perEpisode')">
          <el-input-number v-model="form.perEpisode" :min="1" :max="50" data-test="script-per" />
        </el-form-item>
        <el-form-item :label="t('home.field.aspect')">
          <el-select v-model="form.aspect_ratio" style="width: 160px">
            <el-option v-for="a in ASPECTS" :key="a" :label="t(`home.aspect.${a}`)" :value="a" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item v-if="form.preset === 'custom'" :label="t('home.importScript.pattern')">
        <el-input v-model="form.pattern" class="mono" :placeholder="t('home.importScript.patternPh')" data-test="script-pattern" />
        <p class="hint">{{ t('home.importScript.patternHint') }}</p>
      </el-form-item>
    </el-form>

    <div class="preview" aria-live="polite" data-test="script-preview">
      <template v-if="plan.error">
        <el-alert v-if="form.text.trim()" :title="t(`home.importScript.err.${plan.error}`)" type="warning" show-icon :closable="false" />
      </template>
      <template v-else>
        <p class="sum">{{ t('home.importScript.summary', { chapters: plan.chapters, episodes: plan.episodes.length }) }}</p>
        <ul class="list">
          <li v-for="e in plan.episodes.slice(0, 5)" :key="e.episode_number">
            <b>{{ t('home.importScript.epNo', { n: e.episode_number }) }}</b> {{ e.title }}
          </li>
          <li v-if="plan.episodes.length > 5" class="more">{{ t('home.importScript.more', { n: plan.episodes.length - 5 }) }}</li>
        </ul>
      </template>
    </div>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" />

    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canSubmit" data-test="script-submit" @click="submit">{{ t('home.importScript.create') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from '@/i18n'
import { CHAPTER_PATTERNS, buildEpisodesFromChapters, splitNovelChapters } from '@/utils/homeModel'
import { createWithEpisodes } from './homeApi'

const emit = defineEmits(['close'])
const { t, locale } = useI18n()

const PRESETS = ['zh', 'en', 'none', 'custom']
const ASPECTS = ['16:9', '9:16', '3:4', '1:1', '4:3', '21:9']
const MAX_FILE_BYTES = 20 * 1024 * 1024

const visible = ref(true)
const saving = ref(false)
const errorText = ref('')
const fileName = ref('')
const fileInput = ref(null)
const form = reactive({
  title: '',
  text: '',
  preset: locale.value === 'en' ? 'en' : 'zh',
  pattern: '',
  perEpisode: 1,
  aspect_ratio: '16:9',
})
let result

const pattern = computed(() => (form.preset === 'custom' ? form.pattern : CHAPTER_PATTERNS[form.preset] ?? ''))

// 预览：切章 -> 合成分集；失败给出错误码（界面翻译）
const plan = computed(() => {
  try {
    const chapters = splitNovelChapters(form.text, pattern.value)
    const episodes = buildEpisodesFromChapters(chapters, form.perEpisode, 1)
    return { error: '', chapters: chapters.length, episodes }
  } catch (e) {
    return { error: e?.code || 'NO_MATCH', chapters: 0, episodes: [] }
  }
})

const canSubmit = computed(() => !!form.title.trim() && !plan.value.error && plan.value.episodes.length > 0)

async function onFile(ev) {
  const file = ev.target?.files?.[0]
  if (ev.target) ev.target.value = ''
  if (!file) return
  errorText.value = ''
  if (file.size > MAX_FILE_BYTES) {
    errorText.value = t('home.importScript.err.TOO_BIG')
    return
  }
  try {
    form.text = await file.text()
    fileName.value = file.name
    if (!form.title.trim()) form.title = file.name.replace(/\.[^.]+$/, '').slice(0, 100)
  } catch (_) {
    errorText.value = t('home.importScript.err.READ')
  }
}

async function submit() {
  if (!canSubmit.value || saving.value) return
  saving.value = true
  errorText.value = ''
  try {
    const r = await createWithEpisodes({ title: form.title, aspect_ratio: form.aspect_ratio }, plan.value.episodes)
    result = { dramaId: r.dramaId, episodeId: r.episodeId }
    visible.value = false
  } catch (e) {
    errorText.value = e?.message || t('home.importScript.failed')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.row { display: flex; flex-wrap: wrap; gap: 16px; }
.hidden { display: none; }
.file-row { display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 6px; }
.hint { font-size: 12px; color: var(--text-subtle); margin: 0; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.preview { margin-top: 4px; min-height: 24px; }
.sum { margin: 0 0 4px; font-size: 13px; color: var(--text-primary); }
.list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
.list .more { list-style: none; margin-left: -18px; }
.err { margin-top: 8px; }
</style>
