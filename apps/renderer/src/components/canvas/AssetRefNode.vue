<template>
  <div class="asset" :class="['k-' + data.kind, { missing: data.missing, sel: selected }]" :data-asset-ref="id" :data-kind="data.kind" :data-missing="data.missing ? '1' : '0'" data-test="asset-ref-node">
    <div class="kind">{{ t('canvas.assetKind.' + data.kind) }}</div>
    <div class="name" :title="label">{{ label }}</div>
    <div v-if="data.missing" class="warn">{{ t('canvas.asset.deleted') }}</div>
    <Handle id="out" type="source" :position="Position.Right" class="h-out" :connectable="false" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { t } from '@/i18n'

// 只读的资产引用节点（覆盖层）：不可拖动、不可连线、不会写进项目；点选后在侧栏看它被哪些镜头引用
const props = defineProps({ id: String, data: Object, selected: Boolean })
const label = computed(() => {
  const d = props.data
  if (d.name) return d.name
  return d.assetId != null ? t('canvas.asset.deletedId', { id: d.assetId }) : t('canvas.asset.deleted')
})
</script>

<style scoped>
.asset {
  width: 180px; height: 56px; padding: 6px 10px; border-radius: 28px; font-size: 12px; box-sizing: border-box;
  background: var(--el-fill-color-light); border: 1.5px dashed var(--el-border-color-darker); color: var(--el-text-color-primary);
  display: flex; flex-direction: column; justify-content: center; cursor: pointer;
}
.asset.k-character { border-color: var(--el-color-primary-light-3); }
.asset.k-scene { border-color: var(--el-color-success-light-3); }
.asset.k-prop { border-color: var(--el-color-warning-light-3); }
.asset.missing { border-color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.asset.sel { box-shadow: 0 0 0 3px var(--el-color-primary-light-5); }
.kind { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.2; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn { font-size: 10px; color: var(--el-color-danger); line-height: 1.2; }
:deep(.vue-flow__handle) { width: 8px; height: 8px; background: var(--el-border-color-darker); border: 2px solid var(--el-bg-color); }
</style>
