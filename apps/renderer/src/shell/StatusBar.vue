<template>
  <footer class="status" data-test="statusbar">
    <span class="save" :class="saveState" data-test="save-state">
      <i class="dot" />{{ t(`shell.status.${saveState}`) }}
    </span>
    <span v-if="summary" class="item sum" data-test="status-summary">{{ summary }}</span>
    <span v-if="shell.aspectRatio" class="item">{{ t('shell.status.ratio', { v: shell.aspectRatio }) }}</span>
    <span v-if="shell.style" class="item">{{ t('shell.status.style', { v: shell.style }) }}</span>
    <span v-if="modelText" class="item">{{ t('shell.status.model', { v: modelText }) }}</span>
    <span class="spacer" />
    <span class="core" :class="{ off: !shell.renderCoreOk }" data-test="core-state">
      <i class="dot" />{{ shell.renderCoreOk ? t('shell.status.coreOk') : t('shell.status.coreOff') }}
    </span>
    <span class="item pal">{{ t('shell.status.palette') }}</span>
  </footer>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'

defineProps({ summary: { type: String, default: '' } })

const { t } = useI18n()
const shell = useShellStore()
const views = useProjectViewsStore()

const saveState = computed(() => (views.error ? 'error' : views.busy ? 'saving' : 'saved'))
// 项目详情里带了图像 / 视频模型才显示，没有就不占位
const modelText = computed(() => {
  const d = shell.drama || {}
  return [d.image_model, d.video_model].filter(Boolean).join(' / ')
})
</script>

<style scoped>
.status {
  display: flex; align-items: center; gap: 16px; height: 26px; padding: 0 12px; flex: none;
  background: var(--bg-card); border-top: 1px solid var(--border-color); color: var(--text-subtle); font-size: 12px; white-space: nowrap; overflow: hidden;
}
.spacer { flex: 1; }
.dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #22c55e; }
.save.saving .dot { background: #f59e0b; }
.save.error .dot, .core.off .dot { background: #ef4444; }
.core.off { color: #d97706; }
.sum { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 900px) { .pal, .item:not(.sum) { display: none; } }
</style>
