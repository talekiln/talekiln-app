<template>
  <div class="group" data-test="scene-group">
    <div class="title">
      <strong>{{ data.title || t('canvas.group.untitled') }}</strong>
      <span>{{ t('canvas.group.counts', { lines: data.lines, shots: data.shots }) }}</span>
      <span v-if="data.stale" class="warn">{{ t('canvas.group.stale', { n: data.stale }) }}</span>
    </div>
  </div>
</template>

<script setup>
import { t } from '@/i18n'

// 场景分组框：只画一个背景框，位置与大小由成员节点的包围盒算出（见 groupBoxes）
defineProps({ id: String, data: Object })
</script>

<style scoped>
.group {
  width: 100%; height: 100%; border: 2px dashed var(--el-border-color-darker); border-radius: 12px;
  background: color-mix(in srgb, var(--el-color-primary) 4%, transparent); pointer-events: none;
}
.title { padding: 4px 12px; font-size: 13px; display: flex; gap: 10px; align-items: baseline; color: var(--el-text-color-regular); }
.warn { color: var(--el-color-warning); font-size: 12px; }
</style>
