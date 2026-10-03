<template>
  <el-dialog
    v-model="visible"
    :title="t('home.newBlank.title')"
    width="480px"
    :close-on-click-modal="false"
    append-to-body
    @closed="emit('close', result)"
  >
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item :label="t('home.field.title')" required>
        <el-input v-model="form.title" maxlength="100" show-word-limit :placeholder="t('home.field.titlePh')" data-test="blank-title" @keyup.enter="submit" />
      </el-form-item>
      <el-form-item :label="t('home.field.description')">
        <el-input v-model="form.description" type="textarea" :rows="3" :placeholder="t('home.field.descriptionPh')" />
      </el-form-item>
      <el-form-item :label="t('home.field.aspect')">
        <el-select v-model="form.aspect_ratio" style="width: 100%" data-test="blank-aspect">
          <el-option v-for="a in ASPECTS" :key="a" :label="t(`home.aspect.${a}`)" :value="a" />
        </el-select>
        <p class="hint">{{ t('home.field.aspectHint') }}</p>
      </el-form-item>
    </el-form>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" />
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.title.trim()" data-test="blank-submit" @click="submit">{{ t('home.newBlank.create') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useI18n } from '@/i18n'
import { createWithEpisodes } from './homeApi'

const emit = defineEmits(['close'])
const { t } = useI18n()

const ASPECTS = ['16:9', '9:16', '3:4', '1:1', '4:3', '21:9']
const visible = ref(true)
const saving = ref(false)
const errorText = ref('')
const form = reactive({ title: '', description: '', aspect_ratio: '16:9' })
let result

async function submit() {
  const title = form.title.trim()
  if (!title || saving.value) return
  saving.value = true
  errorText.value = ''
  try {
    // 建项目时带上空白第 1 集：剧本视图要有一个集才能打开
    const r = await createWithEpisodes({ title, description: form.description, aspect_ratio: form.aspect_ratio }, [
      { episode_number: 1, title: '', script_content: '' },
    ])
    result = { dramaId: r.dramaId, episodeId: r.episodeId }
    visible.value = false
  } catch (e) {
    errorText.value = e?.message || t('home.newBlank.failed')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.hint { margin: 4px 0 0; font-size: 12px; color: var(--text-subtle); }
</style>
