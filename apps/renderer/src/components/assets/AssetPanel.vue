<template>
  <aside v-if="shell.assetsPanelOpen" class="asset-panel" :aria-label="t('assets.panel.title')" data-test="asset-panel">
    <header class="head">
      <h3 class="title">{{ t('assets.panel.title') }}</h3>
      <div class="head-acts">
        <el-button link size="small" data-test="panel-manage" @click="goLibrary">{{ t('assets.panel.manage') }}</el-button>
        <el-button link size="small" :aria-label="t('common.close')" data-test="panel-close" @click="shell.closeAssetsPanel()">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </header>

    <div class="tabs" role="tablist">
      <button
        v-for="k in KINDS"
        :key="k"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: kind === k }"
        :aria-selected="kind === k"
        :data-test="`panel-tab-${k}`"
        @click="kind = k"
      >{{ t(`assets.kind.${k}.label`) }} <span class="n">{{ assets.counts[k] }}</span></button>
    </div>

    <el-input v-model="keyword" size="small" clearable class="search" :placeholder="t('assets.panel.search')" :aria-label="t('assets.panel.search')">
      <template #prefix><el-icon><Search /></el-icon></template>
    </el-input>

    <div class="acts">
      <el-button size="small" data-test="panel-extract" @click="openDialog('assets.extract', {})">{{ t('assets.panel.extract') }}</el-button>
      <el-button size="small" data-test="panel-import" @click="openDialog('assets.globalLibrary', { mode: 'import' })">{{ t('assets.panel.import') }}</el-button>
      <el-button size="small" type="primary" data-test="panel-new" @click="openDialog('assets.edit', { kind })">{{ t('assets.panel.new') }}</el-button>
    </div>

    <div v-loading="assets.loading && !items.length" class="list">
      <el-alert v-if="assets.loadError" type="error" :closable="false" show-icon :title="t('assets.panel.loadFailed')">
        <el-button link type="primary" size="small" @click="ensureLoaded">{{ t('common.retry') }}</el-button>
      </el-alert>
      <div v-for="row in items" :key="`${row.kind}:${row.asset.id}`" class="row">
        <AssetCard
          :kind="row.kind"
          :item="row.asset"
          :selected="isSelected(row)"
          :locked="assets.isLocked(row.kind, row.asset.id)"
          @click="onSelect(row)"
        />
        <el-button class="pick" link size="small" :title="t('assets.panel.insert')" :aria-label="t('assets.panel.insert')" data-test="panel-pick" @click="onPick(row)">
          <el-icon><Plus /></el-icon>
        </el-button>
      </div>
      <el-empty v-if="!assets.loading && !assets.loadError && !items.length" :image-size="56" :description="keyword ? t('assets.panel.noMatch') : t(`assets.empty.${kind}`)" />
    </div>

    <el-drawer v-model="detailOpen" :size="drawerSize" append-to-body :title="t('assets.detail.title')" @closed="selected = null">
      <AssetDetail v-if="selected" :kind="selected.kind" :id="selected.id" @removed="detailOpen = false" />
    </el-drawer>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Close, Plus, Search } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { openDialog } from '@/shell/dialogs'
import { KINDS, mentionToken, searchAssets } from '@/utils/assets'
import AssetCard from './AssetCard.vue'
import AssetDetail from './AssetDetail.vue'
import { useAssetContext } from './assetContext'

// 左侧可折叠的资产面板。四个视图各自挂载 <AssetPanel />，是否显示由外壳状态 assetsPanelOpen 决定。
// 事件：select({kind, asset}) 选中一项；pick({kind, asset, token}) 点“+”，token 为 @名字 / #名字，可直接插入提示词。
const emit = defineEmits(['select', 'pick'])
const { t } = useI18n()
const router = useRouter()
const { dramaId, assets, shell, ensureLoaded } = useAssetContext()

const kind = ref('characters')
const keyword = ref('')
const selected = ref(null)
const detailOpen = ref(false)
const drawerSize = 'min(480px, 100vw)'

const items = computed(() => searchAssets(assets.byKind, keyword.value, kind.value))
const isSelected = (row) => !!selected.value && selected.value.kind === row.kind && Number(selected.value.id) === Number(row.asset.id)

function onSelect(row) {
  selected.value = { kind: row.kind, id: row.asset.id }
  detailOpen.value = true
  emit('select', { kind: row.kind, asset: row.asset })
}

function onPick(row) {
  emit('pick', { kind: row.kind, asset: row.asset, token: mentionToken(row.kind, row.asset) })
}

function goLibrary() {
  if (dramaId.value) router.push({ name: 'assets', params: { dramaId: dramaId.value } })
}
</script>

<style scoped>
.asset-panel { flex: 0 0 300px; width: 300px; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-right: 1px solid var(--border-color); background: var(--bg-card); overflow: hidden; }
.head { display: flex; align-items: center; justify-content: space-between; }
.title { margin: 0; font-size: 14px; color: var(--text-primary); }
.head-acts { display: flex; align-items: center; gap: 2px; }
.tabs { display: flex; gap: 4px; }
.tab { flex: 1; padding: 4px 6px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 12px; cursor: pointer; }
.tab:hover { background: var(--bg-hover); }
.tab.on { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.tab:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.n { margin-left: 2px; opacity: 0.8; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; }
.list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 2px; }
.row > :first-child { flex: 1; min-width: 0; }
.pick { flex: 0 0 auto; }
@media (max-width: 900px) { .asset-panel { flex-basis: 240px; width: 240px; } }
</style>
