<template>
  <aside class="rail" :aria-label="t('shell.rail.aria')" data-test="left-rail">
    <section>
      <header class="sec">
        <span>{{ t('shell.rail.episodes') }}</span>
        <el-button text size="small" :aria-label="t('shell.rail.addEpisode')" data-test="rail-add-episode" @click="run('script.addEpisode')">
          <el-icon><Plus /></el-icon>
        </el-button>
      </header>
      <ul class="eps">
        <li v-for="e in shell.episodes" :key="e.id">
          <router-link :to="epTarget(e)" class="ep" :class="{ on: e.id === episodeId }" :data-test="`rail-ep-${e.id}`" @click="$emit('navigate')">
            <span class="no">{{ pad(e.episode_number) }}</span>
            <span class="name">{{ e.title || t('shell.episode.label', { n: e.episode_number }) }}</span>
            <span v-if="shotsOf(e) !== null" class="cnt">{{ t('shell.rail.shots', { n: shotsOf(e) }) }}</span>
          </router-link>
        </li>
      </ul>
      <el-button text size="small" class="wide" data-test="rail-import" @click="run('script.importEpisodes')">
        <el-icon><Upload /></el-icon>{{ t('shell.rail.importEpisodes') }}
      </el-button>
    </section>

    <section>
      <header class="sec"><span>{{ t('shell.rail.assets') }}</span></header>
      <button v-for="a in assetRows" :key="a.key" type="button" class="row" :data-test="`rail-asset-${a.key}`" @click="openAssets">
        <span>{{ t(`shell.rail.${a.key}`) }}</span>
        <span class="cnt">{{ a.count }}</span>
      </button>
      <el-button text size="small" class="wide" data-test="rail-import-global" @click="run('assets.importFromGlobal')">
        <el-icon><Download /></el-icon>{{ t('shell.rail.importGlobal') }}
      </el-button>
    </section>

    <section>
      <header class="sec"><span>{{ t('shell.rail.project') }}</span></header>
      <router-link :to="{ name: 'batch', params: { dramaId } }" class="row" data-test="rail-batch" @click="$emit('navigate')">
        {{ t('shell.rail.batch') }}
      </router-link>
      <button type="button" class="row" data-test="rail-settings" @click="settings">{{ t('shell.rail.settings') }}</button>
    </section>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { runAction } from './actions/registry.js'
import { openDialog } from './dialogs/index.js'
import { useActionContext } from './context.js'

defineEmits(['navigate'])

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()
const actionCtx = useActionContext()

const dramaId = computed(() => Number(route.params.dramaId) || null)
const episodeId = computed(() => Number(route.params.episodeId) || null)
const pad = (n) => String(n ?? '').padStart(2, '0')

const assetRows = computed(() => [
  { key: 'characters', count: shell.assetCounts.characters },
  { key: 'scenes', count: shell.assetCounts.scenes },
  { key: 'props', count: shell.assetCounts.props },
])

// 切集时保持在同一个视图（资产页 / 批量页上点集 -> 剧本）
function epTarget(e) {
  const view = route.meta?.view || 'script'
  return { name: `episode-${view}`, params: { dramaId: dramaId.value, episodeId: e.id } }
}

// 当前集优先用内核视图里的镜头数（实时），其它集用项目详情里带的数；都没有就不显示
function shotsOf(e) {
  if (e.id === episodeId.value && views.episodeId === e.id && views.views.shots) {
    return (views.views.shots.groups || []).reduce((n, g) => n + (g.shots?.length || 0), 0)
  }
  const n = e.shot_count ?? e.storyboards?.length
  return Number.isFinite(Number(n)) && n !== null && n !== undefined ? Number(n) : null
}

function run(id) { return runAction(id, actionCtx()) }

// 四个视图里：打开资产面板；资产页 / 批量页：先回到资产页
function openAssets() {
  if (route.meta?.view) shell.openAssetsPanel()
  else router.push({ name: 'assets', params: { dramaId: dramaId.value } })
}

function settings() { return openDialog('home.projectSettings', { dramaId: dramaId.value }) }
</script>

<style scoped>
.rail { width: 240px; flex: none; overflow-y: auto; padding: 8px 8px 16px; background: var(--bg-card); border-right: 1px solid var(--border-color); }
.sec { display: flex; align-items: center; justify-content: space-between; padding: 10px 8px 4px; font-size: 11px; letter-spacing: .04em; color: var(--text-subtle); }
.eps { margin: 0; padding: 0; list-style: none; }
.ep, .row {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text-primary); font-size: 13px; text-align: left; text-decoration: none; cursor: pointer;
}
.row { justify-content: space-between; }
.ep:hover, .row:hover { background: var(--bg-hover); }
.ep.on { background: var(--bg-hover); color: var(--el-color-primary); font-weight: 600; }
.no { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { color: var(--text-subtle); font-size: 12px; }
.wide { width: 100%; justify-content: flex-start; margin: 2px 0 0; }
.wide :deep(.el-icon) { margin-right: 6px; }
</style>
