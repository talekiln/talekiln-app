<template>
  <el-dialog
    :model-value="gen.dialog.value.visible"
    :title="gen.summary.value.title"
    width="460px"
    :close-on-click-modal="false"
    data-test="generate-dialog"
    @update:model-value="(v) => !v && gen.cancel()"
  >
    <div v-loading="gen.dialog.value.loading" class="body">
      <template v-if="gen.dialog.value.preview">
        <ul class="lines">
          <li v-for="l in gen.summary.value.lines" :key="l">{{ l }}</li>
        </ul>
        <el-alert v-if="gen.summary.value.blocked" type="error" :closable="false" show-icon :title="gen.summary.value.blockedText" data-test="cap-blocked" />
        <el-alert v-for="w in gen.summary.value.warnings" :key="w" type="warning" :closable="false" show-icon :title="w" class="warn" />
        <p class="hint">{{ t('storyboard.gen.queueHint') }}</p>
      </template>
      <div v-else-if="!gen.dialog.value.loading" class="empty">{{ t('storyboard.gen.noEstimate') }}</div>
    </div>
    <template #footer>
      <el-button @click="gen.cancel()">{{ t('storyboard.common.cancel') }}</el-button>
      <el-button type="primary" :loading="gen.dialog.value.submitting" :disabled="!gen.summary.value.canConfirm" data-test="generate-confirm" @click="gen.confirm()">
        {{ gen.summary.value.free ? t('storyboard.gen.ok') : t('storyboard.gen.confirmPaid') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { useI18n } from '@/i18n'

// The generation flow (see useShotGeneration) is owned by the host page and passed in.
defineProps({ gen: { type: Object, required: true } })
const { t } = useI18n()
</script>

<style scoped>
.body { min-height: 80px; }
.lines { margin: 0 0 12px; padding-left: 20px; line-height: 1.8; }
.warn { margin-top: 8px; }
.hint { margin: 12px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.empty { color: var(--el-text-color-secondary); }
</style>
