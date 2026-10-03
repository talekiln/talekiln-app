<template>
  <el-dialog :model-value="true" :title="t('assets.pick.title')" width="min(640px, 94vw)" append-to-body @closed="emit('close', chosen)">
    <el-input v-model="keyword" clearable :placeholder="t('assets.panel.search')" :aria-label="t('assets.panel.search')" data-test="pick-search" class="search">
      <template #prefix><el-icon><Search /></el-icon></template>
    </el-input>
    <div class="tabs" role="tablist">
      <button
        v-for="k in kindList"
        :key="k"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: kind === k }"
        :aria-selected="kind === k"
        @click="kind = k"
      >{{ t(`assets.kind.${k}.label`) }} <span class="n">{{ assets.counts[k] }}</span></button>
    </div>

    <div v-loading="assets.loading && !items.length" class="grid">
      <AssetCard
        v-for="row in items"
        :key="`${row.kind}:${row.asset.id}`"
        :kind="row.kind"
        :item="row.asset"
        variant="grid"
        :locked="assets.isLocked(row.kind, row.asset.id)"
        @click="pick(row)"
      />
    </div>
    <el-empty v-if="!assets.loading && !items.length" :image-size="56" :description="keyword ? t('assets.panel.noMatch') : t(`assets.empty.${kind}`)" />
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { KINDS, mentionToken, searchAssets } from '@/utils/assets'
import AssetCard from './AssetCard.vue'
import { useAssetContext } from './assetContext'

// 通用的资产选择器：给“@ 引用资产”之类的场景用。
// props.kinds 限定可选类别（默认三类），props.kind 为初始类别。
// 点选后关闭并返回 { kind, asset, token }，取消返回 undefined。
const props = defineProps({
  kinds: { type: Array, default: () => KINDS },
  kind: { type: String, default: '' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const { assets } = useAssetContext()

const kindList = computed(() => KINDS.filter((k) => props.kinds.includes(k)))
const kind = ref(props.kind && kindList.value.includes(props.kind) ? props.kind : kindList.value[0] || 'characters')
const keyword = ref('')
const chosen = ref(undefined)

const items = computed(() => searchAssets(assets.byKind, keyword.value, kind.value))

function pick(row) {
  chosen.value = { kind: row.kind, asset: row.asset, token: mentionToken(row.kind, row.asset) }
  emit('close', chosen.value)
}
</script>

<style scoped>
.search { margin-bottom: 10px; }
.tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.tab { padding: 4px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 13px; cursor: pointer; }
.tab:hover { background: var(--bg-hover); }
.tab.on { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.tab:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; max-height: 50vh; overflow: auto; min-height: 60px; }
</style>
