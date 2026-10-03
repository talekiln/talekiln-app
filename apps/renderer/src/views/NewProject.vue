<template>
  <div class="new-project-page">
    <div class="page-header">
      <el-button text data-test="np-back" @click="router.push({ name: 'list' })">
        <el-icon><ArrowLeft /></el-icon>
        {{ t('home.back') }}
      </el-button>
      <h1 class="page-title">{{ t('home.newProject.title') }}</h1>
    </div>

    <el-form class="form" label-position="top" :disabled="generating" @submit.prevent="submit">
      <el-form-item :label="t('home.newProject.story')" required>
        <el-input
          v-model="form.story"
          type="textarea"
          :rows="8"
          :maxlength="STORY_MAX_CHARS"
          show-word-limit
          :placeholder="t('home.newProject.storyPh')"
          data-test="np-story"
        />
      </el-form-item>

      <el-form-item :label="t('home.newProject.template')" required>
        <el-radio-group v-model="form.templateId" class="template-group" @change="onTemplateChange">
          <el-radio-button v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</el-radio-button>
        </el-radio-group>
        <div v-if="currentTemplate" class="hint">{{ currentTemplate.description }}</div>
      </el-form-item>

      <div class="row">
        <el-form-item :label="t('home.newProject.style')">
          <el-select v-model="form.style" filterable :placeholder="t('home.newProject.stylePh')" style="width: 220px">
            <el-option-group v-for="g in generationStyleOptions" :key="g.label" :label="g.label">
              <el-option v-for="o in g.options" :key="o.value" :label="o.label" :value="o.value" />
            </el-option-group>
          </el-select>
        </el-form-item>

        <el-form-item :label="t('home.newProject.aspect')">
          <el-radio-group v-model="form.aspectRatio">
            <el-radio-button v-for="r in ASPECT_RATIOS" :key="r" :value="r">{{ r }}</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item :label="t('home.newProject.duration')">
          <el-input-number v-model="form.durationSec" :min="DURATION_RANGE.min" :max="DURATION_RANGE.max" :step="5" />
        </el-form-item>
      </div>

      <el-form-item :label="t('home.newProject.name')">
        <el-input v-model="form.title" maxlength="60" :placeholder="t('home.newProject.namePh')" style="max-width: 360px" />
      </el-form-item>

      <el-alert v-if="errorMsg" :title="errorMsg" type="error" show-icon :closable="false" class="error" data-test="np-error" />

      <el-button type="primary" size="large" :loading="generating" native-type="submit" data-test="np-submit">
        {{ generating ? t('home.newProject.generating') : t('home.newProject.submit') }}
      </el-button>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { scriptgenAPI } from '@/api/scriptgen'
import { generationStyleOptions } from '@/constants/styleOptions'
import { ASPECT_RATIOS, DURATION_RANGE, STORY_MAX_CHARS, buildProjectRequest } from '@/utils/storyboardTable'
import { validateOneLine } from '@/utils/homeModel'

const { t } = useI18n()
const router = useRouter()
const templates = ref([])
const generating = ref(false)
const errorMsg = ref('')
const form = reactive({
  story: '',
  templateId: '',
  style: '',
  aspectRatio: '9:16',
  durationSec: 45,
  title: '',
})

const currentTemplate = computed(() => templates.value.find((x) => x.id === form.templateId))

function onTemplateChange() {
  const tpl = currentTemplate.value
  if (tpl && tpl.defaultStyle && !form.style) form.style = tpl.defaultStyle
}

// validateOneLine 返回错误码，这里按当前语言翻译。
function errorText(code) {
  const params = { max: STORY_MAX_CHARS, min: DURATION_RANGE.min, maxSec: DURATION_RANGE.max }
  return t(`home.newProject.err.${code}`, params)
}

onMounted(async () => {
  try {
    const data = await scriptgenAPI.templates()
    templates.value = data.templates || []
    if (templates.value.length && !form.templateId) form.templateId = templates.value[0].id
  } catch (_) {
    errorMsg.value = t('home.newProject.err.TEMPLATES')
  }
})

async function submit() {
  errorMsg.value = ''
  const codes = validateOneLine(form)
  if (codes.length) {
    errorMsg.value = codes.map(errorText).join(t('home.newProject.errSep'))
    return
  }
  generating.value = true
  try {
    const res = await scriptgenAPI.createProject(buildProjectRequest(form).body)
    ElMessage.success(t('home.newProject.done'))
    router.push({ name: 'episode-script', params: { dramaId: res.drama_id, episodeId: res.episode_id } })
  } catch (e) {
    errorMsg.value = e.message || t('home.newProject.err.GENERATE')
  } finally {
    generating.value = false
  }
}
</script>

<style scoped>
.new-project-page { max-width: 860px; margin: 0 auto; padding: 24px; color: var(--text-primary); }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.page-title { margin: 0; font-size: 20px; color: var(--text-bright); }
.row { display: flex; flex-wrap: wrap; gap: 24px; }
.hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
.error { margin-bottom: 16px; }
</style>
