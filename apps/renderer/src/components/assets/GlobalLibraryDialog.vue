<template>
  <el-dialog :model-value="true" :title="t('assets.global.title')" width="min(760px, 94vw)" append-to-body @closed="emit('close', result)">
    <div class="bar">
      <el-radio-group v-if="!browseOnly" v-model="scope" size="small" data-test="lib-scope" @change="reset">
        <el-radio-button value="global">{{ t('assets.global.scopeGlobal') }}</el-radio-button>
        <el-radio-button value="project" :disabled="!dramaId">{{ t('assets.global.scopeProject') }}</el-radio-button>
      </el-radio-group>
      <el-input v-model="keyword" size="small" clearable class="search" :placeholder="t('assets.panel.search')" :aria-label="t('assets.panel.search')" @keyup.enter="reset" @clear="reset">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <div class="tabs" role="tablist">
      <button v-for="k in KINDS" :key="k" type="button" role="tab" class="tab" :class="{ on: kind === k }" :aria-selected="kind === k" :data-test="`lib-tab-${k}`" @click="switchKind(k)">
        {{ t(`assets.kind.${k}.label`) }}
      </button>
    </div>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="t('assets.global.loadFailed')">
      <el-button link type="primary" size="small" @click="load">{{ t('common.retry') }}</el-button>
    </el-alert>

    <div v-loading="loading" class="grid">
      <div
        v-for="it in items"
        :key="it.id"
        class="lib-card"
        :class="{ on: isPicked(it) }"
        role="checkbox"
        tabindex="0"
        :aria-checked="isPicked(it)"
        data-test="lib-item"
        @click="toggle(it)"
        @keydown.enter.prevent="toggle(it)"
        @keydown.space.prevent="toggle(it)"
      >
        <div class="thumb">
          <img v-if="imageOf(it)" :src="imageOf(it)" :alt="nameOf(it)" loading="lazy" />
          <span v-else class="ph">{{ t(`assets.kind.${kind}.short`) }}</span>
        </div>
        <div class="name" :title="nameOf(it)">{{ nameOf(it) || t('assets.unnamed') }}</div>
      </div>
    </div>
    <el-empty v-if="!loading && !loadError && !items.length" :image-size="56" :description="t('assets.global.empty')" />
    <el-pagination v-if="total > pageSize" v-model:current-page="page" class="pager" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="load" />

    <template #footer>
      <span class="count">{{ t('assets.global.selected', { n: picked.length }) }}</span>
      <el-button link type="primary" data-test="lib-manage" @click="manage">{{ t('assets.global.manage') }}</el-button>
      <el-button @click="emit('close', result)">{{ t('common.close') }}</el-button>
      <el-button v-if="!browseOnly" type="primary" :loading="importing" :disabled="!picked.length || !dramaId" data-test="lib-import" @click="doImport">{{ t('assets.global.import') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'
import { KINDS, assetImageUrl, assetName, libraryItemToAsset } from '@/utils/assets'
import { useAssetContext, useAssetScope } from './assetContext'

// 从素材库导入资产到当前项目。两个来源：全局素材库（global=1）和本项目的资料库（drama_id）。
// 这里只做浏览 + 导入；素材库本身的增删改在 /media-library 页的 GlobalLibraryPanel（“管理素材库”进入）。
// props: kind 初始类别；scope 初始来源（global | project）；browseOnly 只浏览（首页顶栏用：那里没有当前项目，
// 也不能把素材导入到“上次打开的项目”里）。close 结果 { imported: n }。
const props = defineProps({
  browseOnly: { type: Boolean, default: false },
  kind: { type: String, default: 'characters' },
  scope: { type: String, default: 'global' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
// browseOnly 不需要项目上下文，也不触发资产加载
const ctx = props.browseOnly ? useAssetScope() : useAssetContext()
const { episodeId, assets } = ctx
const router = useRouter()
// browseOnly 时不认当前项目（外壳 store 里可能还留着上一个项目的 id）
const dramaId = computed(() => (props.browseOnly ? null : ctx.dramaId.value))

const API = { characters: characterLibraryAPI, scenes: sceneLibraryAPI, props: propLibraryAPI }
const pageSize = 12

const kind = ref(KINDS.includes(props.kind) ? props.kind : 'characters')
const scope = ref(props.scope === 'project' && dramaId.value ? 'project' : 'global')
const keyword = ref('')
const page = ref(1)
const items = ref([])
const total = ref(0)
const loading = ref(false)
const loadError = ref(false)
const importing = ref(false)
const picked = ref([]) // 已选条目（跨页保留）
const result = ref(undefined)

// 条目显示名：场景用“地点 时间”，其余用 name
const nameOf = (it) => assetName(kind.value, it)
const imageOf = (it) => assetImageUrl(it)
const isPicked = (it) => picked.value.some((x) => x.id === it.id)

let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  loadError.value = false
  try {
    const params = { page: page.value, page_size: pageSize, keyword: keyword.value || undefined }
    if (scope.value === 'global') params.global = 1
    else params.drama_id = dramaId.value
    const res = await API[kind.value].list(params)
    if (mine !== seq) return
    items.value = res?.items ?? []
    total.value = res?.pagination?.total ?? items.value.length
  } catch (_) {
    if (mine !== seq) return
    items.value = []
    total.value = 0
    loadError.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}

// 素材库本身的编辑 / 删除在 /media-library 页（GlobalLibraryPanel）：跳过去并带上当前类别标签
const TAB_OF = { characters: 'character', scenes: 'scene', props: 'prop' }
function manage() {
  router.push({ name: 'media-library', query: { tab: TAB_OF[kind.value] || 'character' } })
  emit('close', result.value)
}

function reset() {
  page.value = 1
  picked.value = []
  load()
}

function switchKind(k) {
  if (k === kind.value) return
  kind.value = k
  reset()
}

function toggle(it) {
  picked.value = isPicked(it) ? picked.value.filter((x) => x.id !== it.id) : [...picked.value, it]
}

async function doImport() {
  if (!picked.value.length || !dramaId.value || importing.value) return
  importing.value = true
  let ok = 0
  let failed = 0
  try {
    for (const it of picked.value) {
      try {
        await assets.create(kind.value, libraryItemToAsset(kind.value, it, { episodeId: episodeId.value }), { episodeId: episodeId.value })
        ok += 1
      } catch (_) {
        failed += 1
      }
    }
    if (ok) {
      await assets.reload()
      result.value = { imported: (result.value?.imported || 0) + ok, kind: kind.value }
    }
    if (failed) ElMessage.warning(t('assets.global.importPartial', { ok, failed }))
    else ElMessage.success(t('assets.global.imported', { n: ok }))
    picked.value = []
  } finally {
    importing.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.search { flex: 1; min-width: 160px; }
.tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.tab { padding: 4px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 13px; cursor: pointer; }
.tab:hover { background: var(--bg-hover); }
.tab.on { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.tab:focus-visible, .lib-card:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; min-height: 80px; max-height: 46vh; overflow: auto; }
.lib-card { border: 2px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-card); cursor: pointer; }
.lib-card.on { border-color: var(--el-color-primary); }
.thumb { aspect-ratio: 1 / 1; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 13px; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.name { padding: 4px 6px; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pager { margin-top: 10px; justify-content: center; }
.count { margin-right: 10px; font-size: 12px; color: var(--text-muted); }
</style>
