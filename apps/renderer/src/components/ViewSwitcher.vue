<template>
  <div class="view-bar" data-test="view-bar">
    <el-button text size="small" class="back" @click="goBack">
      <el-icon><ArrowLeft /></el-icon>项目
    </el-button>
    <div class="tabs" role="tablist">
      <button
        v-for="v in VIEWS"
        :key="v.key"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: v.key === current }"
        :data-test="`view-tab-${v.key}`"
        :aria-selected="v.key === current"
        @click="go(v.key)"
      >{{ v.label }}</button>
    </div>
    <span class="spacer" />
    <slot />
    <el-tooltip :content="staleTip" placement="bottom">
      <el-tag :type="views.staleTotal ? 'warning' : 'success'" size="small" effect="light" data-test="stale-badge">
        {{ views.staleTotal ? `待生成 / 已过期 ${views.staleTotal}` : '全部最新' }}
      </el-tag>
    </el-tooltip>
    <el-button-group>
      <el-button size="small" :disabled="!views.canUndo || views.busy" title="撤销（Ctrl+Z）：所有视图共用同一份历史" data-test="undo" @click="views.undo()">撤销</el-button>
      <el-button size="small" :disabled="!views.canRedo || views.busy" title="重做（Ctrl+Shift+Z）" data-test="redo" @click="views.redo()">重做</el-button>
    </el-button-group>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useProjectViewsStore } from '@/stores/projectViews'
import { VIEWS, viewLocation, viewOfRoute } from '@/utils/projectViews'

const route = useRoute()
const router = useRouter()
const views = useProjectViewsStore()

const current = computed(() => viewOfRoute(route.name))
const staleTip = computed(() => '内核判定需要重新生成的节点数（图 / 视频 / 配音 / 合成；还没生成过的也算）')

async function go(view) {
  if (view === current.value) return
  const ep = views.episodeId
  if (!ep) return
  const drama = view === 'storyboard' ? await views.resolveDrama(ep) : views.dramaId
  router.push(viewLocation(view, ep, drama, drama ? { drama: String(drama) } : {}))
}

function goBack() {
  const d = views.dramaId || route.query.drama
  router.push(d ? `/drama/${d}` : '/')
}

// Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）= 内核历史。输入框里保留浏览器自己的文字撤销；
// 时间线页由它自己的 useKeymap（edit.undo / edit.redo）先冲掉未保存的编辑再调同一份内核历史，这里不重复处理。
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const k = e.key.toLowerCase()
  if (k !== 'z' && k !== 'y') return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (current.value === 'timeline') return
  e.preventDefault()
  if (k === 'y' || e.shiftKey) views.redo()
  else views.undo()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.view-bar {
  display: flex; align-items: center; gap: 12px; padding: 8px 16px; flex-wrap: wrap;
  border-bottom: 1px solid var(--el-border-color-light); background: var(--el-bg-color);
  position: sticky; top: 0; z-index: 20;
}
.tabs { display: inline-flex; background: var(--el-fill-color); border-radius: 8px; padding: 3px; gap: 2px; }
.tab {
  border: 0; background: transparent; color: var(--el-text-color-regular); padding: 5px 18px; border-radius: 6px;
  cursor: pointer; font-size: 14px;
}
.tab:hover { color: var(--el-color-primary); }
.tab.active { background: var(--el-bg-color); color: var(--el-color-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }
.spacer { flex: 1; }
</style>
