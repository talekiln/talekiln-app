<template>
  <div
    class="shot-card"
    :class="{ selected, focused, stale: item.stale }"
    :data-test="`shot-card-${item.no}`"
    :aria-selected="selected"
    tabindex="0"
    @click="(e) => $emit('select', e)"
    @dblclick="$emit('open')"
    @keydown.enter.self="$emit('open')"
  >
    <div class="pic">
      <img v-if="item.thumb" :src="item.thumb" alt="" loading="lazy">
      <div v-else class="empty">{{ t('storyboard.card.noImage') }}</div>
      <span class="no">{{ item.no }}</span>
      <el-checkbox class="check" :model-value="selected" :aria-label="t('storyboard.card.select')" data-test="card-check" @click.stop @change="$emit('toggle')" />
      <span class="dur">{{ item.duration.toFixed(1) }}{{ t('storyboard.unit.sec') }}</span>
    </div>
    <div class="body">
      <div v-if="item.title" class="title" :title="item.title">{{ item.title }}</div>
      <div class="desc" :class="{ muted: !item.description }">{{ item.description || t('storyboard.card.noDescription') }}</div>
      <div class="chips">
        <el-tooltip :disabled="!item.failure" :content="item.failure" placement="top">
          <el-tag size="small" :type="chipType(item.chips.image)" data-test="card-chip-image">{{ t('storyboard.insp.image') }} {{ t(chipKey(item.chips.image)) }}</el-tag>
        </el-tooltip>
        <el-tag size="small" :type="chipType(item.chips.video)" data-test="card-chip-video">{{ t('storyboard.insp.video') }} {{ t(chipKey(item.chips.video)) }}</el-tag>
        <el-tooltip v-if="item.cons" :content="item.cons.hint" placement="top">
          <el-tag size="small" :type="item.cons.type" data-test="consistency-chip">{{ item.cons.label }}</el-tag>
        </el-tooltip>
      </div>
    </div>
    <div class="ops" @click.stop>
      <el-button link type="success" size="small" :disabled="item.busy" :title="t('storyboard.card.generate')" data-test="card-generate" @click="$emit('generate')">{{ t('storyboard.card.generate') }}</el-button>
      <el-button link size="small" :disabled="!canUp" :title="t('storyboard.card.up')" @click="$emit('move', -1)"><el-icon><ArrowLeft /></el-icon></el-button>
      <el-button link size="small" :disabled="!canDown" :title="t('storyboard.card.down')" @click="$emit('move', 1)"><el-icon><ArrowRight /></el-icon></el-button>
      <el-button link type="danger" size="small" :title="t('storyboard.card.delete')" data-test="card-delete" @click="$emit('remove')"><el-icon><Delete /></el-icon></el-button>
    </div>
  </div>
</template>

<script setup>
import { ArrowLeft, ArrowRight, Delete } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { chipKey } from './shotInspectorModel.js'

defineProps({
  /** page row: { id, no, title, description, duration, thumb, chips, busy, stale, failure, cons } */
  item: { type: Object, required: true },
  selected: Boolean,
  focused: Boolean,
  canUp: Boolean,
  canDown: Boolean,
})
defineEmits(['select', 'toggle', 'open', 'generate', 'move', 'remove'])
const { t } = useI18n()
const chipType = (s) => ({ none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }[s] || 'info')
</script>

<style scoped>
.shot-card { position: relative; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-fill-color-blank); overflow: hidden; cursor: pointer; display: flex; flex-direction: column; outline: none; }
.shot-card:hover { border-color: var(--el-color-primary-light-5); }
.shot-card:focus-visible { box-shadow: 0 0 0 2px var(--el-color-primary-light-5); }
.shot-card.focused { border-color: var(--el-color-primary); }
.shot-card.selected { background: var(--el-color-primary-light-9); box-shadow: 0 0 0 2px var(--el-color-primary); }
.shot-card.stale .pic::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 0 2px var(--el-color-warning-light-5); pointer-events: none; }
.pic { position: relative; aspect-ratio: 16 / 9; background: var(--el-fill-color-light); }
.pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--el-text-color-placeholder); font-size: 12px; }
.no { position: absolute; left: 6px; top: 6px; min-width: 22px; padding: 0 6px; line-height: 22px; text-align: center; border-radius: 11px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 12px; }
.check { position: absolute; right: 6px; top: 4px; }
.dur { position: absolute; right: 6px; bottom: 6px; padding: 0 6px; line-height: 18px; border-radius: 9px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 11px; }
.body { padding: 8px 10px 4px; display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.title { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desc { font-size: 12px; color: var(--el-text-color-regular); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.8em; }
.desc.muted { color: var(--el-text-color-placeholder); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.ops { display: flex; align-items: center; padding: 0 6px 6px; gap: 0; }
.ops .el-button { margin: 0; padding: 0 4px; }
</style>
