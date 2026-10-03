<template>
  <div class="full-text" data-test="full-text">
    <div class="hint">{{ t('script.full.hint') }}</div>
    <textarea
      v-model="draft"
      class="area"
      spellcheck="false"
      :placeholder="t('script.full.placeholder')"
      :disabled="busy"
      data-test="full-text-area"
    />
    <div class="bar">
      <span class="count">{{ t('script.full.count', { lines: lineCount, chars: draft.length }) }}</span>
      <span class="grow" />
      <el-button :disabled="busy" data-test="full-text-cancel" @click="emit('cancel')">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="!changed" data-test="full-text-apply" @click="emit('apply', draft)">{{ t('script.full.apply') }}</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from '@/i18n'

const props = defineProps({
  text: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['apply', 'cancel'])
const { t } = useI18n()

const draft = ref(props.text)
watch(() => props.text, (v) => { if (!changed.value) draft.value = v })
const changed = computed(() => draft.value !== props.text)
const lineCount = computed(() => draft.value.split(/\r?\n/).filter((l) => l.trim()).length)
</script>

<style scoped>
.full-text { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 360px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.area {
  flex: 1; min-height: 320px; width: 100%; resize: vertical; font: inherit; line-height: 1.7; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--el-border-color); background: var(--el-fill-color-blank); color: var(--el-text-color-primary);
}
.area:focus { outline: none; border-color: var(--el-color-primary); }
.bar { display: flex; align-items: center; gap: 8px; }
.count { color: var(--el-text-color-secondary); font-size: 12px; }
.grow { flex: 1; }
</style>
