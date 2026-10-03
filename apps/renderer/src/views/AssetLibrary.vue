<template>
  <div class="asset-library" data-test="asset-library">
    <header class="top">
      <div class="titles">
        <h2 class="title">{{ t('assets.library.pageTitle') }}</h2>
        <p class="sub">{{ t('assets.library.pageSub') }}</p>
      </div>
      <div class="acts">
        <el-button data-test="lib-extract" @click="openDialog('assets.extract', {})">{{ t('assets.panel.extract') }}</el-button>
        <el-button data-test="lib-import" @click="openDialog('assets.globalLibrary', { kind })">{{ t('assets.panel.import') }}</el-button>
        <el-button type="primary" data-test="lib-new" @click="openDialog('assets.edit', { kind })">{{ t('assets.panel.new') }}</el-button>
      </div>
    </header>

    <div class="bar">
      <div class="tabs" role="tablist">
        <button
          v-for="k in KINDS"
          :key="k"
          type="button"
          role="tab"
          class="tab"
          :class="{ on: kind === k }"
          :aria-selected="kind === k"
          :data-test="`tab-${k}`"
          @click="kind = k"
        >{{ t(`assets.kind.${k}.label`) }} <span class="n">{{ assets.counts[k] }}</span></button>
      </div>
      <el-input v-model="keyword" clearable class="search" :placeholder="t('assets.panel.search')" :aria-label="t('assets.panel.search')">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <el-alert v-if="assets.loadError" type="error" :closable="false" show-icon :title="t('assets.panel.loadFailed')">
      <el-button link type="primary" size="small" @click="ensureLoaded">{{ t('common.retry') }}</el-button>
    </el-alert>

    <div v-loading="assets.loading && !items.length" class="grid">
      <AssetCard
        v-for="row in items"
        :key="`${row.kind}:${row.asset.id}`"
        :kind="row.kind"
        :item="row.asset"
        variant="grid"
        :selected="isSelected(row)"
        :locked="assets.isLocked(row.kind, row.asset.id)"
        @click="open(row)"
      />
    </div>
    <el-empty v-if="!assets.loading && !assets.loadError && !items.length" :description="keyword ? t('assets.panel.noMatch') : t(`assets.empty.${kind}`)">
      <el-button v-if="!keyword" type="primary" @click="openDialog('assets.edit', { kind })">{{ t('assets.panel.new') }}</el-button>
    </el-empty>

    <el-drawer v-model="detailOpen" size="min(520px, 100vw)" append-to-body :title="t('assets.detail.title')" @closed="selected = null">
      <AssetDetail v-if="selected" :kind="selected.kind" :id="selected.id" @removed="detailOpen = false" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { openDialog } from '@/shell/dialogs'
import { KINDS, searchAssets } from '@/utils/assets'
import AssetCard from '@/components/assets/AssetCard.vue'
import AssetDetail from '@/components/assets/AssetDetail.vue'
import { useAssetContext } from '@/components/assets/assetContext'

// /p/:dramaId/assets：项目资产库。角色 / 场景 / 道具三个标签，卡片网格，点开侧栏详情。
const { t } = useI18n()
const { assets, ensureLoaded } = useAssetContext()

const kind = ref('characters')
const keyword = ref('')
const selected = ref(null)
const detailOpen = ref(false)

const items = computed(() => searchAssets(assets.byKind, keyword.value, kind.value))
const isSelected = (row) => !!selected.value && selected.value.kind === row.kind && Number(selected.value.id) === Number(row.asset.id)

function open(row) {
  selected.value = { kind: row.kind, id: row.asset.id }
  detailOpen.value = true
}
</script>

<style scoped>
.asset-library { display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; min-height: 0; overflow: auto; height: 100%; box-sizing: border-box; }
.top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.title { margin: 0; font-size: 20px; color: var(--text-primary); }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--text-muted); }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
.bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; }
.tab { padding: 6px 14px; border: 1px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-muted); font-size: 14px; cursor: pointer; }
.tab:hover { background: var(--bg-hover); }
.tab.on { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.tab:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.n { margin-left: 2px; opacity: 0.8; }
.search { max-width: 280px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; align-content: start; min-height: 60px; }
@media (max-width: 640px) { .asset-library { padding: 14px 16px; } }
</style>
