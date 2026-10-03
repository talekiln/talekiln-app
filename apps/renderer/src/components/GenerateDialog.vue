<template>
  <el-dialog
    :model-value="state.visible"
    :title="summary.title"
    width="460px"
    :close-on-click-modal="false"
    data-test="generate-dialog"
    @update:model-value="(v) => !v && $emit('cancel')"
  >
    <div v-loading="state.loading" class="body">
      <template v-if="state.preview">
        <ul class="lines">
          <li v-for="l in summary.lines" :key="l">{{ l }}</li>
        </ul>
        <el-alert v-if="summary.blocked" type="error" :closable="false" show-icon :title="summary.blockedText" data-test="cap-blocked" />
        <el-alert v-for="w in summary.warnings" :key="w" type="warning" :closable="false" show-icon :title="w" class="warn" />
        <p class="hint">
          {{ t('generate.dialog.queueHintBefore') }}
          <router-link :to="{ name: 'task-center' }" target="_blank">{{ t('generate.dialog.taskCenter') }}</router-link>{{ t('generate.dialog.queueHintAfter') }}
        </p>
      </template>
      <div v-else-if="!state.loading" class="empty">{{ t('generate.dialog.cannotEstimate') }}</div>
    </div>
    <template #footer>
      <el-button @click="$emit('cancel')">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="state.submitting" :disabled="!summary.canConfirm" data-test="generate-confirm" @click="$emit('confirm')">
        {{ summary.free ? t('common.ok') : t('generate.dialog.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import { previewSummary } from '@/components/generate/generateConfirm'

const props = defineProps({ state: { type: Object, required: true } })
defineEmits(['confirm', 'cancel'])
const { t } = useI18n()
// 文案走 generate lane 的 previewSummary（和生成菜单的确认框同一套规则，可切换语言）
const summary = computed(() => previewSummary(props.state.preview))
</script>

<style scoped>
.body { min-height: 80px; }
.lines { margin: 0 0 12px; padding-left: 20px; line-height: 1.8; }
.warn { margin-top: 8px; }
.hint { margin: 12px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.empty { color: var(--el-text-color-secondary); }
</style>
