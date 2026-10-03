<template>
  <el-dialog
    v-model="visible"
    :title="t('home.rename.title')"
    width="480px"
    :close-on-click-modal="false"
    append-to-body
    @closed="emit('close', result)"
  >
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item :label="t('home.field.title')" required>
        <el-input v-model="form.title" maxlength="100" show-word-limit :placeholder="t('home.field.titlePh')" data-test="rename-title" @keyup.enter="submit" />
      </el-form-item>
      <el-form-item :label="t('home.field.story')">
        <el-input v-model="form.description" type="textarea" :rows="3" :placeholder="t('home.field.storyPh')" />
      </el-form-item>
    </el-form>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" />
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.title.trim()" data-test="rename-submit" @click="submit">{{ t('common.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useI18n } from '@/i18n'
import { renameProject } from './homeApi'

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const visible = ref(true)
const saving = ref(false)
const errorText = ref('')
const form = reactive({ title: props.title, description: props.description })
let result

async function submit() {
  const title = form.title.trim()
  if (!title || saving.value) return
  saving.value = true
  errorText.value = ''
  try {
    const description = form.description.trim()
    await renameProject(props.dramaId, { title, description: description || undefined })
    result = { dramaId: props.dramaId, title, description }
    visible.value = false
  } catch (e) {
    errorText.value = e?.message || t('home.rename.failed')
  } finally {
    saving.value = false
  }
}
</script>
