<template>
  <div class="project-shell" data-test="project-shell">
    <TopBar :spend-text="spendText" @open-tasks="tasksOpen = true" />
    <el-alert
      v-if="shell.loadError"
      type="error"
      show-icon
      :closable="false"
      :title="t('shell.project.loadFailed', { message: shell.loadError })"
      class="load-error"
    />
    <div class="body">
      <LeftRail v-if="!narrow" />
      <el-drawer v-else v-model="railOpen" direction="ltr" size="260px" :with-header="false" class="rail-drawer">
        <LeftRail @navigate="railOpen = false" />
      </el-drawer>
      <AssetPanel v-if="showAssetPanel" @pick="onPickAsset" />
      <main class="main">
        <el-button v-if="narrow" class="rail-toggle" size="small" :aria-label="t('shell.rail.open')" data-test="rail-toggle" @click="railOpen = true">
          <el-icon><Menu /></el-icon>
        </el-button>
        <router-view :key="viewKey" />
      </main>
    </div>
    <StatusBar :summary="summary" />
    <TaskDrawer v-model="tasksOpen" />
    <DialogHost />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { installActions } from './actions/index.js'
import { shellApi } from './api.js'
import { formatSpend } from './spend.js'
import DialogHost from './DialogHost.vue'
import TopBar from './TopBar.vue'
import LeftRail from './LeftRail.vue'
import AssetPanel from '@/components/assets/AssetPanel.vue'
import StatusBar from './StatusBar.vue'
import TaskDrawer from './TaskDrawer.vue'

installActions()

const { t } = useI18n()
const route = useRoute()
const shell = useShellStore()
const views = useProjectViewsStore()

const dramaId = computed(() => Number(route.params.dramaId) || null)
const episodeId = computed(() => Number(route.params.episodeId) || null)
// 切集 / 切镜头时重建子页面，避免各视图自己监听路由参数
const viewKey = computed(() => `${String(route.name)}:${route.params.episodeId || ''}:${route.params.shotId || ''}`)

// 视图通过 inject('shellSummary') 拿到这个 ref，往里写状态栏摘要；离开视图时由外壳清空
const summary = ref('')
provide('shellSummary', summary)
watch(() => route.name, () => { summary.value = '' })

watch(dramaId, (id) => { if (id) shell.loadProject(id) }, { immediate: true })

// 记住每个项目最后停留的集和视图（/p/:id 的落点）
watch(
  () => [dramaId.value, episodeId.value, route.meta?.view],
  ([d, e, v]) => { if (d && e && v) shell.rememberView(d, e, v) },
  { immediate: true }
)

// 四个视图自己加载内核数据；其它有集的页面（镜头工作台、导出页）由外壳加载，顶栏的撤销 / 过期徽标才有数据
watch(
  () => [dramaId.value, episodeId.value, route.meta?.view],
  ([d, e, v]) => { if (d && e && !v) views.load(e, { drama: d }) },
  { immediate: true }
)

// 资产面板：四视图和镜头工作台旁边显示（资产页本身就是资产库，不再叠一层）。
// 点“引用到提示词”目前只把 @名称 记号复制到剪贴板（各视图还没有接收记号的输入焦点，见 notes/cleanup.md）。
const showAssetPanel = computed(() => !!route.meta?.view || route.name === 'shot-workbench')
async function onPickAsset({ token }) {
  try {
    await globalThis.navigator.clipboard.writeText(token)
    ElMessage.success(t('assets.panel.tokenCopied', { token }))
  } catch (_) {
    ElMessage.warning(t('assets.panel.copyFailed', { token }))
  }
}

// ---- 窄屏：左栏变抽屉 ----
const narrow = ref(false)
const railOpen = ref(false)
let mql = null
const onMql = () => { narrow.value = !!mql?.matches; if (!narrow.value) railOpen.value = false }

// ---- 任务数 / 花费 / 草稿数的轻量轮询 ----
const tasksOpen = ref(false)
const spendText = ref('')
async function refreshSpend() {
  if (!dramaId.value) return
  try {
    const s = await shellApi.projectSpend(dramaId.value)
    spendText.value = s.cost === null ? '' : formatSpend(s.cost, s.currency)
  } catch (_) { /* 花费接口不可用时不显示 */ }
}
async function tick() {
  if (globalThis.document?.hidden) return
  await shell.refreshTasks()
  refreshSpend()
  shell.refreshDraftCount(episodeId.value)
}
let timer = null
onMounted(() => {
  if (globalThis.matchMedia) {
    mql = globalThis.matchMedia('(max-width: 900px)')
    onMql()
    mql.addEventListener('change', onMql)
  }
  tick()
  timer = setInterval(tick, 8000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  mql?.removeEventListener('change', onMql)
})
watch(dramaId, () => { spendText.value = '' })
watch([dramaId, episodeId, () => shell.quality], () => tick())
</script>

<style scoped>
.project-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg-page); }
.body { display: flex; flex: 1; min-height: 0; }
.main { position: relative; flex: 1; min-width: 0; overflow: auto; }
.rail-toggle { position: absolute; top: 8px; left: 8px; z-index: 5; }
.load-error { flex: none; }
</style>
