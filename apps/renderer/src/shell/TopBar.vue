<template>
  <header class="topbar" data-test="topbar">
    <router-link to="/" class="brand" :title="t('shell.project.list')">
      <span class="logo" aria-hidden="true"><el-icon><Orange /></el-icon></span>
      <span class="brand-name">{{ t('shell.brand') }}</span>
    </router-link>

    <el-dropdown trigger="click" class="ep-switch" @command="goEpisode">
      <button type="button" class="ep-btn" :aria-label="t('shell.episode.switch')" data-test="episode-switch">
        <span class="proj">{{ shell.drama?.title || shell.drama?.name || t('shell.project.untitled') }}</span>
        <span class="sep">/</span>
        <span class="ep">{{ episodeLabel }}</span>
        <el-icon><ArrowDown /></el-icon>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="e in shell.episodes" :key="e.id" :command="e.id" :class="{ active: e.id === episodeId }">
            {{ labelOf(e) }}
          </el-dropdown-item>
          <el-dropdown-item v-if="!shell.episodes.length" disabled>{{ t('shell.episode.none') }}</el-dropdown-item>
          <el-dropdown-item divided command="__list">{{ t('shell.project.list') }}</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <nav class="tabs" role="tablist" :aria-label="t('shell.tabs.aria')">
      <router-link v-for="v in VIEWS" :key="v" v-slot="{ href, navigate }" custom :to="tabTarget(v)">
        <a
          :href="episodeId ? href : undefined"
          role="tab"
          class="tab"
          :class="{ on: currentView === v, off: !episodeId }"
          :aria-selected="currentView === v"
          :aria-disabled="!episodeId"
          :data-test="`tab-${v}`"
          @click="episodeId ? navigate($event) : $event.preventDefault()"
        >{{ t(`shell.tab.${v}`) }}</a>
      </router-link>
    </nav>

    <span class="spacer" />

    <button
      v-if="episodeId"
      type="button"
      class="stale"
      :class="{ clean: !views.staleTotal, active: shell.staleOnly }"
      :title="t('shell.stale.tip')"
      data-test="stale-badge"
      @click="shell.setStaleOnly(!shell.staleOnly)"
    >{{ views.staleTotal ? t('shell.stale.badge', { n: views.staleTotal }) : t('shell.stale.none') }}</button>

    <el-badge :value="shell.tasksRunning" :hidden="!shell.tasksRunning" :max="99" class="tasks-badge">
      <el-button size="small" :aria-label="t('shell.tasks.aria', { n: shell.tasksRunning })" data-test="tasks-btn" @click="$emit('open-tasks')">
        <el-icon><List /></el-icon><span class="lbl">{{ t('shell.tasks') }}</span>
      </el-button>
    </el-badge>

    <el-tooltip v-if="spendText" :content="t('shell.spend.tip')" placement="bottom">
      <button type="button" class="spend" data-test="spend" @click="router.push({ name: 'spend' })">
        {{ t('shell.spend') }} {{ spendText }}
      </button>
    </el-tooltip>

    <el-tooltip :content="t('shell.quality.tip')" placement="bottom">
      <el-radio-group :model-value="shell.quality" size="small" :aria-label="t('shell.quality.label')" data-test="quality" @change="onQuality">
        <el-radio-button value="draft">{{ t('shell.quality.draft') }}</el-radio-button>
        <el-radio-button value="final">{{ t('shell.quality.final') }}</el-radio-button>
      </el-radio-group>
    </el-tooltip>

    <el-tooltip :content="t('shell.history.tip')" placement="bottom">
      <el-button size="small" :disabled="!episodeId" data-test="history-btn" @click="openHistory">
        <el-icon><Clock /></el-icon><span class="lbl">{{ t('shell.history') }}</span>
      </el-button>
    </el-tooltip>

    <el-button-group>
      <el-tooltip :content="t('shell.undo.tip')" placement="bottom">
        <el-button size="small" :disabled="!canStep || !views.canUndo" :aria-label="t('shell.undo')" data-test="undo-btn" @click="step('undo')">
          <el-icon><RefreshLeft /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip :content="t('shell.redo.tip')" placement="bottom">
        <el-button size="small" :disabled="!canStep || !views.canRedo" :aria-label="t('shell.redo')" data-test="redo-btn" @click="step('redo')">
          <el-icon><RefreshRight /></el-icon>
        </el-button>
      </el-tooltip>
    </el-button-group>

    <LocaleSwitch />

    <el-dropdown v-for="m in menus" :key="m.id" trigger="click" placement="bottom-end" :max-height="480">
      <el-button size="small" :type="m.primary ? 'primary' : 'default'" :data-test="`menu-${m.id}`">
        {{ t(`shell.menu.${m.id}`) }}<el-icon class="caret"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu class="shell-menu">
          <template v-for="(g, gi) in m.groups" :key="g.key">
            <li class="grp" :class="{ first: gi === 0 }" role="presentation">{{ t(g.labelKey) }}</li>
            <el-dropdown-item
              v-for="it in g.items"
              :key="it.id"
              :class="{ 'is-soft-disabled': !it.state.enabled }"
              :aria-disabled="!it.state.enabled"
              :data-test="`item-${it.id}`"
              @click="pick(it)"
            >
              <div class="mi">
                <span class="mi-t">{{ t(it.labelKey) }}</span>
                <span class="mi-d">{{ it.state.enabled ? t(it.descKey) : t(it.state.reasonKey) }}</span>
              </div>
            </el-dropdown-item>
          </template>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </header>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore, VIEWS } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { openHistory } from '@/composables/useHistoryDrawer'
import { EXPORT_MENU, GENERATE_MENU, MENU_GROUP_KEY, menuState } from './menus.js'
import { runAction } from './actions/registry.js'
import { useActionContext } from './context.js'
import { undoRedoIntent } from './shortcuts.js'
import LocaleSwitch from './LocaleSwitch.vue'

defineProps({ spendText: { type: String, default: '' } })
defineEmits(['open-tasks'])

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()
const actionCtx = useActionContext()

const dramaId = computed(() => Number(route.params.dramaId) || null)
// 只认路由里的集：资产页 / 批量页没有“当前集”，依赖当前集的菜单项会置灰并给出原因
const episodeId = computed(() => Number(route.params.episodeId) || null)
const currentView = computed(() => route.meta?.view || null)
const canStep = computed(() => !!episodeId.value && !!currentView.value && !views.busy)

const labelOf = (e) => (e.title
  ? t('shell.episode.labelTitled', { n: e.episode_number, title: e.title })
  : t('shell.episode.label', { n: e.episode_number }))
const episodeLabel = computed(() => {
  const e = shell.episodes.find((x) => x.id === episodeId.value)
  return e ? t('shell.episode.label', { n: e.episode_number }) : t('shell.episode.none')
})

function tabTarget(v) {
  if (!episodeId.value) return { name: 'project-home', params: { dramaId: dramaId.value } }
  return { name: `episode-${v}`, params: { dramaId: dramaId.value, episodeId: episodeId.value } }
}

function goEpisode(cmd) {
  if (cmd === '__list') return router.push('/')
  const view = currentView.value || 'script'
  return router.push({ name: `episode-${view}`, params: { dramaId: dramaId.value, episodeId: cmd } })
}

async function onQuality(q) {
  const ok = await shell.setQuality(q)
  if (!ok) ElMessage.error(t('shell.status.error'))
}

// ---- 撤销 / 重做（原 ViewSwitcher 的职责）----
async function step(kind) {
  if (!canStep.value) return
  await (kind === 'undo' ? views.undo() : views.redo())
}
function onKey(e) {
  const kind = undoRedoIntent(e, currentView.value)
  if (!kind || !canStep.value) return
  if (kind === 'undo' ? !views.canUndo : !views.canRedo) return
  e.preventDefault()
  step(kind)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// ---- 生成 / 导出菜单 ----
const menuCtx = computed(() => {
  const groups = views.views.shots?.groups || []
  const tracks = views.views.timeline?.tracks || []
  const here = !!episodeId.value && views.episodeId === episodeId.value
  return {
    episodeId: episodeId.value,
    shotCount: here ? groups.reduce((n, g) => n + (g.shots?.length || 0), 0) : 0,
    hasTimeline: here && tracks.some((x) => (x.clips || []).length > 0),
    renderCoreOk: shell.renderCoreOk,
    draftCount: shell.draftCount ?? 0,
  }
})

function build(id, entries, primary) {
  const order = []
  const byGroup = new Map()
  for (const it of entries) {
    if (!byGroup.has(it.group)) { byGroup.set(it.group, []); order.push(it.group) }
    byGroup.get(it.group).push({ ...it, state: menuState(it, menuCtx.value) })
  }
  return { id, primary, groups: order.map((g) => ({ key: g, labelKey: MENU_GROUP_KEY(id, g), items: byGroup.get(g) })) }
}
const menus = computed(() => [build('generate', GENERATE_MENU, false), build('export', EXPORT_MENU, true)])

function pick(it) {
  if (!it.state.enabled) {
    ElMessage.info(t(it.state.reasonKey))
    return
  }
  runAction(it.action, actionCtx())
}
</script>

<style scoped>
.topbar {
  position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 8px;
  height: 48px; padding: 0 12px; background: var(--bg-card); border-bottom: 1px solid var(--border-color);
}
.brand { display: inline-flex; align-items: center; gap: 6px; color: var(--text-bright); text-decoration: none; font-weight: 700; }
.logo { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 6px; background: var(--el-color-primary); color: #fff; }
.ep-btn {
  display: inline-flex; align-items: center; gap: 6px; max-width: 260px; height: 30px; padding: 0 10px;
  border: 1px solid var(--border-muted); border-radius: 6px; background: transparent; color: var(--text-primary); cursor: pointer;
}
.ep-btn:hover { background: var(--bg-hover); }
.ep-btn .proj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-btn .sep { color: var(--text-faint); }
.tabs { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--bg-inner); border: 1px solid var(--border-color); }
.tab { padding: 4px 14px; border-radius: 6px; color: var(--text-muted); font-size: 13px; text-decoration: none; cursor: pointer; }
.tab:hover { color: var(--text-primary); }
.tab.on { background: var(--bg-card); color: var(--el-color-primary); font-weight: 700; box-shadow: var(--shadow); }
.tab.off { opacity: .45; cursor: default; }
.spacer { flex: 1; }
.stale {
  height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid #f59e0b; background: rgba(245, 158, 11, .14);
  color: #d97706; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.stale.clean { border-color: var(--border-muted); background: transparent; color: var(--text-subtle); }
.stale.active { background: #f59e0b; color: #fff; }
.spend { border: 0; background: transparent; color: var(--text-muted); font-size: 12px; cursor: pointer; white-space: nowrap; }
.spend:hover { color: var(--text-primary); }
.tasks-badge { line-height: 1; }
.lbl { margin-left: 4px; }
.caret { margin-left: 4px; }
.active { color: var(--el-color-primary); font-weight: 600; }
@media (max-width: 1100px) { .lbl { display: none; } }
@media (max-width: 900px) { .brand-name, .spend { display: none; } }
</style>

<style>
.shell-menu { min-width: 280px; max-width: 360px; }
.shell-menu .grp { padding: 8px 16px 2px; font-size: 11px; letter-spacing: .04em; color: var(--text-subtle); list-style: none; }
.shell-menu .grp:not(.first) { margin-top: 4px; border-top: 1px solid var(--border-color); }
.shell-menu .mi { display: flex; flex-direction: column; gap: 2px; line-height: 1.3; }
.shell-menu .mi-t { font-size: 13px; }
.shell-menu .mi-d { font-size: 11px; color: var(--text-subtle); white-space: normal; }
.shell-menu .is-soft-disabled { opacity: .5; cursor: not-allowed; }
.shell-menu .is-soft-disabled .mi-d { color: #d97706; }
</style>
