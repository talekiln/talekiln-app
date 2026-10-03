<template>
  <div class="card" :class="['t-' + node.type, 's-' + node.state, { sel: selected }]" :data-node-id="node.id" :data-state="node.state" :data-test="'node-' + node.type">
    <Handle
      v-for="(p, i) in ports"
      :id="p"
      :key="p"
      type="target"
      :position="Position.Left"
      class="h-in"
      :style="{ top: ports.length > 1 ? `${28 + i * 44}%` : '50%' }"
      :title="t('canvas.card.inPort', { port: p })"
    />
    <header>
      <span class="type">{{ nodeTypeLabel(node.type) }}</span>
      <span v-if="stateLabel(node.state)" class="state" :class="'s-' + node.state">{{ stateLabel(node.state) }}</span>
    </header>
    <div v-for="(line, i) in summary" :key="i" class="row" :class="{ strong: i === 0 }">{{ line }}</div>
    <Handle v-if="node.type !== 'compose'" id="out" type="source" :position="Position.Right" class="h-out" :title="t('canvas.card.outPort')" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { t } from '@/i18n'
import { nodeSummaryT, nodeTypeLabel, stateLabel } from './canvasModel.js'

// Vue Flow 自定义节点：卡片显示类型、关键参数、最新 / 已过期 / 未生成状态（文案全部走 i18n，摘要在这里按当前语言算）
const props = defineProps({ id: String, data: Object, selected: Boolean })
const node = computed(() => props.data.node)
const ports = computed(() => props.data.ports)
const summary = computed(() => nodeSummaryT(node.value))
</script>

<style scoped>
.card {
  width: 220px; min-height: 96px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  background: var(--el-bg-color); border: 1.5px solid var(--el-border-color); color: var(--el-text-color-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .08);
}
.card.sel { box-shadow: 0 0 0 3px var(--el-color-primary-light-5); border-color: var(--el-color-primary); }
.card.s-stale { border-left: 5px solid var(--el-color-warning); }
.card.s-fresh { border-left: 5px solid var(--el-color-success); }
.card.s-none.t-image, .card.s-none.t-video, .card.s-none.t-narration, .card.s-none.t-compose { border-left: 5px dashed var(--el-border-color-darker); }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.type { font-weight: 700; font-size: 13px; }
.state { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.state.s-stale { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.state.s-fresh { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.row { color: var(--el-text-color-regular); line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.strong { color: var(--el-text-color-primary); }
:deep(.vue-flow__handle) { width: 10px; height: 10px; background: var(--el-color-primary); border: 2px solid var(--el-bg-color); }
</style>
