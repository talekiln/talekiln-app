<template>
  <el-dialog
    v-model="visible"
    :title="t('script.settings.title')"
    width="600px"
    :close-on-click-modal="false"
    append-to-body
    class="project-settings-dialog"
    @closed="emit('close', result)"
  >
    <el-form v-loading="loading" label-position="top" @submit.prevent="save">
      <el-form-item :label="t('script.settings.name')" required>
        <el-input v-model="form.title" maxlength="100" show-word-limit :placeholder="t('script.settings.namePh')" data-test="settings-title" />
      </el-form-item>
      <el-form-item :label="t('script.settings.outline')">
        <el-input v-model="form.description" type="textarea" :rows="4" :placeholder="t('script.settings.outlinePh')" data-test="settings-outline" />
      </el-form-item>

      <div class="grid">
        <el-form-item :label="t('script.settings.aspect')">
          <el-select v-model="form.aspectRatio" data-test="settings-aspect">
            <el-option v-for="a in ASPECTS" :key="a" :label="aspectLabel(a)" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.clip')">
          <el-select v-model="form.clipDuration" data-test="settings-clip">
            <el-option v-for="s in CLIPS" :key="s" :label="t('script.settings.clipSec', { n: s })" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.language')">
          <el-select v-model="form.language" data-test="settings-language">
            <el-option :label="t('script.lang.zh')" value="zh" />
            <el-option :label="t('script.lang.en')" value="en" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.storyStyle')">
          <el-select v-model="form.storyStyle" clearable :placeholder="t('script.settings.none')">
            <el-option v-for="s in STORY_STYLES" :key="s" :label="t(`script.storyStyle.${s}`)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.genre')">
          <el-select v-model="form.genre" clearable :placeholder="t('script.settings.none')">
            <el-option v-for="g in STORY_TYPES" :key="g" :label="t(`script.storyType.${g}`)" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('script.settings.style')">
          <StylePickerButton
            v-model="form.style"
            v-model:custom-prompt="form.customStylePrompt"
            :options="generationStyleOptions"
            :placeholder="t('script.settings.stylePh')"
          />
        </el-form-item>
      </div>
      <div class="hint">{{ t('script.settings.styleHint') }}</div>
    </el-form>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" />
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !form.title.trim()" data-test="settings-save" @click="save">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { dramaAPI } from '@/api/drama'
import StylePickerButton from '@/components/StylePickerButton.vue'
import { ASPECTS, aspectLabel } from '@/utils/aspectRatio'
import { CUSTOM_STYLE_VALUE, generationStyleOptions } from '@/constants/styleOptions'
import { CLIP_DURATION_DEFAULT, buildProjectSettingsRequests } from '@/utils/scriptTools'

const props = defineProps({ dramaId: { type: [Number, String], required: true } })
const emit = defineEmits(['close'])
const { t } = useI18n()
const shell = useShellStore()

const CLIPS = [4, 5, 8, 10, 12, 15]
const STORY_STYLES = ['modern', 'ancient', 'fantasy', 'daily']
const STORY_TYPES = ['drama', 'comedy', 'adventure']

const visible = ref(true)
const loading = ref(true)
const saving = ref(false)
const errorText = ref('')
let result
let tags

const form = reactive({
  title: '',
  description: '',
  genre: '',
  storyStyle: '',
  style: '',
  customStylePrompt: '',
  aspectRatio: '16:9',
  clipDuration: CLIP_DURATION_DEFAULT,
  language: 'zh',
})

function parseTags(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw) {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : undefined } catch (_) { return undefined }
  }
  return undefined
}

onMounted(async () => {
  try {
    const d = await dramaAPI.get(props.dramaId)
    const m = (typeof d.metadata === 'string' ? safeJson(d.metadata) : d.metadata) || {}
    form.title = d.title || ''
    form.description = d.description || ''
    form.genre = d.genre || ''
    form.storyStyle = m.story_style || ''
    form.style = d.style || ''
    form.customStylePrompt = d.style === CUSTOM_STYLE_VALUE ? m.style_prompt_zh || m.style_prompt_en || '' : ''
    form.aspectRatio = m.aspect_ratio || '16:9'
    form.clipDuration = Number(m.video_clip_duration) || CLIP_DURATION_DEFAULT
    form.language = m.script_language === 'en' ? 'en' : 'zh'
    tags = parseTags(d.tags)
  } catch (e) {
    errorText.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
})

function safeJson(s) {
  try { return JSON.parse(s) } catch (_) { return null }
}

async function save() {
  if (saving.value || loading.value) return
  const r = buildProjectSettingsRequests(form)
  if (!r.ok) {
    errorText.value = t(r.error === 'custom_style_prompt' ? 'script.settings.err.customStyle' : 'script.settings.err.title')
    return
  }
  saving.value = true
  errorText.value = ''
  try {
    await dramaAPI.update(props.dramaId, r.update)
    // saveOutline 会把没带的 tags 清空，所以把原有 tags 带回去
    await dramaAPI.saveOutline(props.dramaId, { ...r.outline, ...(tags ? { tags } : {}) })
    await shell.loadProject(props.dramaId)
    ElMessage.success(t('script.settings.saved'))
    result = { dramaId: props.dramaId, saved: true }
    visible.value = false
  } catch (e) {
    errorText.value = e?.message || t('script.settings.err.failed')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.err { margin-top: 10px; }
</style>
