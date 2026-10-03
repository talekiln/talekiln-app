<template>
  <div
    class="asset-card"
    :class="[`v-${variant}`, { selected, 'no-image': !image }]"
    role="button"
    tabindex="0"
    :aria-pressed="selected"
    :data-test="`asset-card-${kind}`"
    @click="$emit('click', item)"
    @keydown.enter.prevent="$emit('click', item)"
    @keydown.space.prevent="$emit('click', item)"
  >
    <div class="thumb">
      <img v-if="image" :src="image" :alt="name" loading="lazy" />
      <span v-else class="ph">{{ t(`assets.kind.${kind}.short`) }}</span>
      <span v-if="locked" class="badge lock" :title="t('assets.lock.badgeTip')">{{ t('assets.lock.badge') }}</span>
    </div>
    <div class="meta">
      <div class="name" :title="name">{{ name || t('assets.unnamed') }}</div>
      <div v-if="sub" class="sub" :title="sub">{{ sub }}</div>
    </div>
    <slot name="extra" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import { assetDescription, assetImageUrl, assetName } from '@/utils/assets'

const props = defineProps({
  kind: { type: String, required: true },
  item: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  locked: { type: Boolean, default: false },
  // list: 面板里的一行；grid: 资产库页的卡片
  variant: { type: String, default: 'list' },
})
defineEmits(['click'])
const { t } = useI18n()

const name = computed(() => assetName(props.kind, props.item))
const image = computed(() => assetImageUrl(props.item))
const sub = computed(() => {
  const s = assetDescription(props.kind, props.item).replace(/\s+/g, ' ').trim()
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
})
</script>

<style scoped>
.asset-card { display: flex; gap: 10px; padding: 8px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); cursor: pointer; outline: none; transition: border-color 0.15s, background 0.15s; }
.asset-card:hover { background: var(--bg-hover); }
.asset-card:focus-visible { box-shadow: 0 0 0 2px var(--el-color-primary); }
.asset-card.selected { border-color: var(--el-color-primary); }
.thumb { position: relative; flex: 0 0 auto; width: 48px; height: 48px; border-radius: 6px; overflow: hidden; background: var(--bg-inner, var(--bg-hover)); display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph { font-size: 12px; color: var(--text-muted); }
.badge { position: absolute; left: 2px; bottom: 2px; padding: 0 4px; border-radius: 4px; font-size: 10px; line-height: 16px; background: var(--el-color-success); color: #fff; }
.meta { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
.name { font-size: 13px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.v-grid { flex-direction: column; padding: 0; overflow: hidden; }
.v-grid .thumb { width: 100%; height: auto; aspect-ratio: 4 / 3; border-radius: 0; }
.v-grid .meta { padding: 8px 10px 10px; }
.v-grid .badge { left: 6px; bottom: 6px; top: auto; font-size: 11px; }
</style>
