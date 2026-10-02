<template>
  <div class="new-project-page">
    <div class="page-header">
      <el-button text @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon>
        返回
      </el-button>
      <h2 class="page-title">新建项目</h2>
    </div>

    <el-form class="form" label-position="top" :disabled="generating" @submit.prevent="submit">
      <el-form-item label="故事内容" required>
        <el-input
          v-model="form.story"
          type="textarea"
          :rows="8"
          maxlength="8000"
          show-word-limit
          placeholder="粘贴或输入你的故事、产品卖点或知识要点，AI 会据此生成分镜表"
        />
      </el-form-item>

      <el-form-item label="题材模板" required>
        <el-radio-group v-model="form.templateId" class="template-group" @change="onTemplateChange">
          <el-radio-button v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</el-radio-button>
        </el-radio-group>
        <div v-if="currentTemplate" class="hint">{{ currentTemplate.description }}</div>
      </el-form-item>

      <div class="row">
        <el-form-item label="画风">
          <el-select v-model="form.style" filterable placeholder="选择画风" style="width: 220px">
            <el-option-group v-for="g in generationStyleOptions" :key="g.label" :label="g.label">
              <el-option v-for="o in g.options" :key="o.value" :label="o.label" :value="o.value" />
            </el-option-group>
          </el-select>
        </el-form-item>

        <el-form-item label="画幅">
          <el-radio-group v-model="form.aspectRatio">
            <el-radio-button v-for="r in ASPECT_RATIOS" :key="r" :value="r">{{ r }}</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="目标时长（秒）">
          <el-input-number v-model="form.durationSec" :min="DURATION_RANGE.min" :max="DURATION_RANGE.max" :step="5" />
        </el-form-item>
      </div>

      <el-form-item label="项目名称（可选，默认使用 AI 生成的标题）">
        <el-input v-model="form.title" maxlength="60" placeholder="留空则自动命名" style="max-width: 360px" />
      </el-form-item>

      <el-alert v-if="errorMsg" :title="errorMsg" type="error" show-icon :closable="false" class="error" />

      <el-button type="primary" size="large" :loading="generating" native-type="submit">
        {{ generating ? '正在生成分镜…（约需数十秒）' : '创建并生成分镜' }}
      </el-button>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { scriptgenAPI } from '@/api/scriptgen'
import { generationStyleOptions } from '@/constants/styleOptions'
import { ASPECT_RATIOS, DURATION_RANGE, buildProjectRequest } from '@/utils/storyboardTable'

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

const currentTemplate = computed(() => templates.value.find((t) => t.id === form.templateId))

function onTemplateChange() {
  const t = currentTemplate.value
  if (t && t.defaultStyle && !form.style) form.style = t.defaultStyle
}

onMounted(async () => {
  try {
    const data = await scriptgenAPI.templates()
    templates.value = data.templates || []
    if (templates.value.length && !form.templateId) form.templateId = templates.value[0].id
  } catch (_) {
    errorMsg.value = '加载模板失败，请确认本地服务已启动'
  }
})

async function submit() {
  errorMsg.value = ''
  const { ok, errors, body } = buildProjectRequest(form)
  if (!ok) {
    errorMsg.value = errors.join('；')
    return
  }
  generating.value = true
  try {
    const res = await scriptgenAPI.createProject(body)
    ElMessage.success('分镜已生成')
    router.push({ name: 'storyboard', params: { dramaId: res.drama_id }, query: { episode: res.episode_id } })
  } catch (e) {
    errorMsg.value = e.message || '生成失败，请重试'
  } finally {
    generating.value = false
  }
}
</script>

<style scoped>
.new-project-page { max-width: 860px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.page-title { margin: 0; font-size: 20px; }
.row { display: flex; flex-wrap: wrap; gap: 24px; }
.hint { margin-top: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.error { margin-bottom: 16px; }
</style>
