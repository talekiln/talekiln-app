<template>
  <div class="at-editor" data-test="at-editor">
    <el-input
      v-if="!hideText"
      ref="inputRef"
      :model-value="display"
      type="textarea"
      :rows="rows"
      :autosize="autosize"
      :disabled="disabled"
      :placeholder="placeholder"
      @update:model-value="onInput"
      @blur="$emit('blur')"
    />
    <div v-if="slots.length" class="refs">
      <span class="refs-label">{{ t('storyboard.at.refs') }}</span>
      <div v-for="s in slots" :key="`${s.kind}:${s.id}`" class="ref" :class="{ used: used.has(s.index) }" data-test="at-slot">
        <button type="button" class="thumb" :title="t('storyboard.at.insert')" :disabled="disabled" @click="insert(s)">
          <img :src="s.thumbUrl" alt="">
          <span class="idx">{{ s.index }}</span>
        </button>
        <div class="meta">
          <span class="name" :title="s.name">{{ shown(s) }}</span>
          <span class="ops">
            <el-button link size="small" :disabled="disabled || !canMove(s, -1)" :title="t('storyboard.at.moveUp')" @click="$emit('move', { slot: s, dir: -1 })"><el-icon><ArrowLeft /></el-icon></el-button>
            <el-button link size="small" :disabled="disabled || !canMove(s, 1)" :title="t('storyboard.at.moveDown')" @click="$emit('move', { slot: s, dir: 1 })"><el-icon><ArrowRight /></el-icon></el-button>
            <el-button link size="small" type="danger" :disabled="disabled" :title="t('storyboard.at.remove')" @click="$emit('remove', s)"><el-icon><Close /></el-icon></el-button>
          </span>
        </div>
      </div>
    </div>
    <p v-else class="hint">{{ t('storyboard.at.noRefs') }}</p>
    <p v-if="over" class="warn">{{ t('storyboard.at.tooMany', { n: MAX_REFS }) }}</p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ArrowLeft, ArrowRight, Close } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { MAX_REFS, displayName, referencedIndexes, toCanonical, toDisplay } from './atImageOrder.js'

const props = defineProps({
  /** canonical text (image tokens as stored / submitted) */
  modelValue: { type: String, default: '' },
  /** reference slots in submission order, from buildRefSlots() */
  slots: { type: Array, default: () => [] },
  /** number of references beyond the model limit, shown as a warning */
  overflow: { type: Number, default: 0 },
  rows: { type: Number, default: 4 },
  autosize: { type: [Boolean, Object], default: false },
  placeholder: { type: String, default: '' },
  disabled: Boolean,
  /** show only the reference strip (no text box) */
  hideText: Boolean,
})
const emit = defineEmits(['update:modelValue', 'move', 'remove', 'blur'])
const { t } = useI18n()
const inputRef = ref(null)

const prefixes = computed(() => ({ scene: t('storyboard.kind.scene'), character: t('storyboard.kind.character'), prop: t('storyboard.kind.prop') }))
const display = computed(() => toDisplay(props.modelValue, props.slots, prefixes.value))
const used = computed(() => new Set(referencedIndexes(props.modelValue)))
const over = computed(() => props.overflow > 0)
const shown = (s) => displayName(s, props.slots, prefixes.value)

// Slots are ordered scene -> characters -> props; an asset can only move inside its own kind.
function canMove(s, dir) {
  const peers = props.slots.filter((x) => x.kind === s.kind)
  const i = peers.findIndex((x) => x.id === s.id)
  return dir < 0 ? i > 0 : i >= 0 && i < peers.length - 1
}

function onInput(v) {
  emit('update:modelValue', toCanonical(v, props.slots, prefixes.value))
}

function insert(s) {
  const el = inputRef.value && inputRef.value.textarea
  const text = `@${shown(s)}`
  const cur = display.value
  const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : cur.length
  const next = cur.slice(0, pos) + text + cur.slice(pos)
  emit('update:modelValue', toCanonical(next, props.slots, prefixes.value))
}
</script>

<style scoped>
.at-editor { width: 100%; }
.refs { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; margin-top: 8px; }
.refs-label { font-size: 12px; color: var(--el-text-color-secondary); align-self: center; }
.ref { display: flex; gap: 6px; align-items: center; border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 4px 6px; background: var(--el-fill-color-blank); }
.ref.used { border-color: var(--el-color-primary-light-5); background: var(--el-color-primary-light-9); }
.thumb { position: relative; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 4px; overflow: hidden; cursor: pointer; background: none; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.idx { position: absolute; left: 0; top: 0; background: var(--el-color-primary); color: #fff; font-size: 10px; line-height: 14px; min-width: 14px; text-align: center; border-bottom-right-radius: 4px; }
.meta { display: flex; flex-direction: column; min-width: 0; }
.name { font-size: 12px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 0; }
.ops .el-button { padding: 0 2px; margin: 0; }
.hint { margin: 6px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.warn { margin: 6px 0 0; font-size: 12px; color: var(--el-color-warning); }
</style>
